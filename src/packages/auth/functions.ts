import jwt, { Algorithm } from 'jsonwebtoken';
import type { Response } from 'node-fetch';
import fetch from 'node-fetch';
import { getEnv } from '../../env.js';
import getLogger from '../../logger.js';
import { DbMerlin } from '../db/db.js';
import type {
  AuthResponse,
  JsonWebToken,
  JwtDecode,
  JwtPayload,
  JwtSecret,
  SessionResponse,
  UserRoles,
} from '../../types/auth.js';
import { loginSSO } from './adapters/CAMAuthAdapter.js';

const logger = getLogger('packages/auth/functions');

export function authorizationHeaderToToken(authorizationHeader: string | undefined | null): JsonWebToken | never {
  if (authorizationHeader !== null && authorizationHeader !== undefined) {
    if (authorizationHeader.startsWith('Bearer ')) {
      const [, token] = authorizationHeader.split(' '); // Split out 'Bearer' prefix.
      return token;
    } else {
      throw new Error(`Authorization header does not include 'Bearer' prefix`);
    }
  } else {
    throw new Error(`Authorization header not found`);
  }
}

/**
 * Returns default role, and allowed roles for a user.
 * If the user does not exist, this function creates the user and gives them a default role.
 */
export async function getUserRoles(
  username: string,
  default_role: string,
  allowed_roles: string[],
): Promise<{ allowed_roles: string[]; default_role: string }> {
  const db = DbMerlin.getDb();

  const { rows, rowCount } = await db.query(
    `
      select hasura_default_role, hasura_allowed_roles
      from permissions.users_and_roles
      where username = $1;
    `,
    [username],
  );

  if (rowCount && rowCount > 0) {
    const [row] = rows;
    const { hasura_allowed_roles, hasura_default_role } = row;
    return { allowed_roles: hasura_allowed_roles, default_role: hasura_default_role };
  } else {
    // since user does not exist, this upsert is just an insert
    await upsertUserRoles(username, default_role, allowed_roles);
    return { allowed_roles, default_role };
  }
}

export async function deleteUserAllowedRoles(username: string) {
  const db = DbMerlin.getDb();

  await db.query(
    `
      delete from permissions.users_allowed_roles
      where username = $1;
    `,
    [username],
  );
}

export async function upsertUserRoles(username: string, default_role: string, allowed_roles: string[]) {
  const db = DbMerlin.getDb();

  await db.query(
    `
      insert into permissions.users (username, default_role)
      values ($1, $2)
      on conflict (username) do update
      set default_role = excluded.default_role;
    `,
    [username, default_role],
  );

  for (const allowed_role of allowed_roles) {
    await db.query(
      `
        insert into permissions.users_allowed_roles (username, allowed_role)
        values ($1, $2)
        on conflict (username, allowed_role) do nothing;
      `,
      [username, allowed_role],
    );
  }
}

export async function syncRolesToDB(username: string, default_role: string, allowed_roles: string[]) {
  const db = DbMerlin.getDb();

  await db.query('begin;');
  await deleteUserAllowedRoles(username);
  await upsertUserRoles(username, default_role, allowed_roles);
  await db.query('commit;');
}

export function decodeJwt(authorizationHeader: string | undefined): JwtDecode {
  try {
    const token = authorizationHeaderToToken(authorizationHeader);
    const { HASURA_GRAPHQL_JWT_SECRET, JWT_ALGORITHMS } = getEnv();
    const { key }: JwtSecret = JSON.parse(HASURA_GRAPHQL_JWT_SECRET);
    const options: jwt.VerifyOptions = { algorithms: JWT_ALGORITHMS };
    const jwtPayload = jwt.verify(token, key, options) as JwtPayload;
    return { jwtErrorMessage: '', jwtPayload };
  } catch (e) {
    console.error(e);

    if (e instanceof jwt.TokenExpiredError) {
      const tokenExpiredError = e as jwt.TokenExpiredError;
      const jwtErrorMessage = `Token expired on ${tokenExpiredError.expiredAt}`;
      return { jwtErrorMessage, jwtPayload: null };
    } else {
      const error = e as Error;
      const jwtErrorMessage = error?.message ?? 'Token could not be verified';
      return { jwtErrorMessage, jwtPayload: null };
    }
  }
}

/**
 * The Hasura session variables for a request, taken from its verified JWT the way Hasura would: the user from the
 * token, and the requested role (or the token's default) only if the token allows it. For calls that bypass Hasura,
 * where the request's own `x-hasura-*` headers cannot be trusted.
 */
export function getSessionVariables(
  authorizationHeader: string | undefined,
  requestedRole: string | undefined,
): { 'x-hasura-role': string; 'x-hasura-user-id': string } {
  const { jwtErrorMessage, jwtPayload } = decodeJwt(authorizationHeader);
  if (jwtPayload == null) {
    throw new Error(`Unauthorized: ${jwtErrorMessage}`);
  }

  const claims = jwtPayload['https://hasura.io/jwt/claims'];
  const allowedRoles = claims['x-hasura-allowed-roles'] as string[];
  const role = requestedRole || (claims['x-hasura-default-role'] as string);

  if (!allowedRoles.includes(role)) {
    throw new Error(`Role "${role}" is not in the allowed roles.`);
  }

  return { 'x-hasura-role': role, 'x-hasura-user-id': claims['x-hasura-user-id'] as string };
}

export function generateJwt(
  username: string,
  defaultRole: string,
  allowedRoles: string[],
  expiry: string = getEnv().JWT_EXPIRATION,
): string | null {
  try {
    const { HASURA_GRAPHQL_JWT_SECRET } = getEnv();
    const { key, type }: JwtSecret = JSON.parse(HASURA_GRAPHQL_JWT_SECRET);
    const options: jwt.SignOptions = { algorithm: type as Algorithm, expiresIn: expiry };
    const payload: JwtPayload = {
      'https://hasura.io/jwt/claims': {
        'x-hasura-allowed-roles': allowedRoles,
        'x-hasura-default-role': defaultRole,
        'x-hasura-user-id': username,
      },
      username,
    };

    return jwt.sign(payload, key, options);
  } catch (e) {
    console.error(e);
    return null;
  }
}

export async function login(username: string, password: string): Promise<AuthResponse> {
  const { AUTH_TYPE, AUTH_URL, ALLOWED_ROLES_NO_AUTH, DEFAULT_ROLE_NO_AUTH } = getEnv();

  if (AUTH_TYPE === 'cam') {
    let response: Response | undefined;
    let json: any;

    try {
      const body = JSON.stringify({ password, username });
      const url = `${AUTH_URL}/ssoToken?loginMethod=ldap`;
      response = await fetch(url, { body, method: 'POST' });
      json = await response.json();
      const { errorCode = false } = json;

      if (errorCode) {
        const { errorMessage } = json;
        return {
          message: errorMessage,
          success: false,
          token: null,
        };
      } else {
        const { ssoCookieValue } = json;
        return loginSSO(ssoCookieValue);
      }
    } catch (error) {
      logger.error(error);
      logger.error(response);
      logger.error(json);
      return {
        message: 'An unexpected error occurred',
        success: false,
        token: null,
      };
    }
  } else if (AUTH_TYPE === 'none') {
    const { allowed_roles, default_role } = await getUserRoles(username, DEFAULT_ROLE_NO_AUTH, ALLOWED_ROLES_NO_AUTH);
    return {
      message: 'Authentication is disabled',
      success: true,
      token: generateJwt(username, default_role, allowed_roles),
    };
  } else {
    const message = 'user + pass login is not supported by current Gateway AUTH_TYPE';
    logger.error(message);
    return {
      message,
      success: false,
      token: '',
    };
  }
}

export async function session(authorizationHeader: string | undefined): Promise<SessionResponse> {
  const { jwtErrorMessage, jwtPayload } = decodeJwt(authorizationHeader);

  if (jwtPayload) {
    return { message: 'Token is valid', success: true };
  } else {
    return { message: jwtErrorMessage, success: false };
  }
}

export function validateGroupRoleMappings() {
  const { DEFAULT_ROLE, AUTH_GROUP_ROLE_MAPPINGS } = getEnv();

  for (const group in AUTH_GROUP_ROLE_MAPPINGS) {
    // compute intersection of this mapping's roles and DEFAULT_ROLE list
    // the mapping is invalid if we don't have any overlap, since we can't compute
    // a default role for this group -> role mapping
    const roles = new Set(AUTH_GROUP_ROLE_MAPPINGS[group]);
    const intersection = DEFAULT_ROLE.filter(e => roles.has(e));

    if (intersection.length == 0) {
      throw new Error(`
        No roles within DEFAULT_ROLE list were found in the group to role mapping.
            DEFAULT_ROLE: ${DEFAULT_ROLE}
            Group: ${group}
            Roles: ${[...roles]}
        Roles must share at least one role with DEFAULT_ROLE, which becomes
        the default role for any user logging in under this group
      `);
    }
  }
}

export function getDefaultRoleForAllowedRoles(allowedRoles: string[]): string {
  const { DEFAULT_ROLE } = getEnv();
  const roles = new Set(allowedRoles);

  for (const defaultRole of DEFAULT_ROLE) {
    if (roles.has(defaultRole)) {
      return defaultRole;
    }
  }

  throw new Error(
    `Fatal error, not able to find a matching default role within the following auth roles: ${allowedRoles}`,
  );
}

export function mapGroupsToRoles(groupList: string[]): UserRoles {
  const { DEFAULT_ROLE, ALLOWED_ROLES } = getEnv();

  // use auth group -> plandev role mappings if set
  if (authGroupMappingsExist()) {
    const mappedGroupMembership = getGroupsWithMappings(groupList);
    const allowed_roles = getAllAllowedRolesForAuthGroups(mappedGroupMembership);

    return {
      allowed_roles,
      default_role: getDefaultRoleForAllowedRoles(allowed_roles),
    };
  }

  return {
    allowed_roles: ALLOWED_ROLES,
    default_role: DEFAULT_ROLE[0],
  };
}

/**
 * Filters auth group mappings to only those with a group -> role mapping.
 * I.e. intersection between `AUTH_GROUP_ROLE_MAPPINGS` and param `authGroups` list
 **/
export function getGroupsWithMappings(authGroups: string[]): string[] {
  const { AUTH_GROUP_ROLE_MAPPINGS } = getEnv();
  const authGroupsSet = new Set(authGroups);

  return Object.keys(AUTH_GROUP_ROLE_MAPPINGS).filter(mappedGroup => authGroupsSet.has(mappedGroup));
}

export function getAllAllowedRolesForAuthGroups(groups: string[]): string[] {
  const { AUTH_GROUP_ROLE_MAPPINGS } = getEnv();
  const allAllowedRoles = groups
    .map(g => AUTH_GROUP_ROLE_MAPPINGS[g]) // map auth group to plandev roles
    .reduce((acc, elem) => acc.concat(elem), []); // concat all allowed roles for all member groups
  return [...new Set(allAllowedRoles)]; // deduplicate
}

export function authGroupMappingsExist(): boolean {
  const { AUTH_GROUP_ROLE_MAPPINGS } = getEnv();
  return JSON.stringify(AUTH_GROUP_ROLE_MAPPINGS) !== '{}';
}

export function parseTokenFromCookie(userCookie: string | undefined): JsonWebToken | undefined {
  if (!userCookie) return;

  const userBuffer = Buffer.from(userCookie ?? '', 'base64');
  const userStr = userBuffer.toString('utf-8');

  try {
    const { token } = JSON.parse(userStr);
    return token;
  } catch {
    return;
  }
}

export async function cookieIsValid(userCookie: string | undefined): Promise<boolean> {
  const userToken = parseTokenFromCookie(userCookie);
  const tokenHeader = `Bearer ${userToken}`;
  const { success } = await session(tokenHeader);
  return success;
}
