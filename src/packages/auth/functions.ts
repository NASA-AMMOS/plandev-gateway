import jwt, { Algorithm, JwtHeader, VerifyOptions } from 'jsonwebtoken';
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
import { JwksClient } from 'jwks-rsa';
import { StringValue } from 'ms';

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

function enforcePEMFormatting(publicKey: string): string {
  if (publicKey.includes('-----BEGIN PUBLIC KEY-----') && publicKey.includes('-----END PUBLIC KEY-----')) {
    return publicKey;
  }
  else {
    return '-----BEGIN PUBLIC KEY-----\n' + publicKey + '\n-----END PUBLIC KEY-----'
  }
}

export async function decodeJwt(authorizationHeader: string | undefined): Promise<JwtDecode> {
  try {
    const token = authorizationHeaderToToken(authorizationHeader);
    const { HASURA_GRAPHQL_JWT_SECRET } = getEnv();
    const { type, key, jwk_url, issuer, audience }: JwtSecret = JSON.parse(HASURA_GRAPHQL_JWT_SECRET);

    // Bind the accepted algorithm to the secret's declared `type` (the same value generateJwt signs
    // with), rather than a global JWT_ALGORITHMS default. This keeps HS256 and RS256/JWKS
    // deployments self-configuring from their own secret — no reliance on a process-wide default
    // that can only be correct for one mode — and, critically, prevents an RS256->HS256
    // algorithm-confusion forgery: a JWKS/RS256 verifier never accepts an HS256 token signed with
    // the (public) RSA key. `alg: none` is excluded for the same reason.
    const options: jwt.VerifyOptions = { algorithms: [type as Algorithm] };

    // Add issuer/audience validation if configured (used with JWKS/OIDC)
    if (issuer) {
      options.issuer = issuer;
    }
    if (audience) {
      // jwt.verify expects string or non-empty array
      options.audience = Array.isArray(audience) ? audience as [string, ...string[]] : audience;
    }

    type getKeyType = (header: JwtHeader, callback: any) => void;
    let realKey: string | getKeyType;

    // if they are using a jwk_url instead, pull the key!
    if (!key && jwk_url) {
      // https://www.npmjs.com/package/jsonwebtoken
      const client = new JwksClient({
        jwksUri: jwk_url
      });

      realKey = function(header, callback) {
        client.getSigningKey(header.kid, function(err, key) {
          if (err) {
            callback(err, null);
          } else if (key) {
            const signingKey = key.getPublicKey();
            callback(null, signingKey);
          } else {
            callback(new Error('No signing key found'), null);
          }
        });
      }

      const verifyJwt = async function(token: string, options: VerifyOptions = {}): Promise<any> {
        return new Promise((resolve, reject) => {
          jwt.verify(token, realKey, options, (err, decoded) => {
            if (err) return reject(err);
            resolve(decoded);
          });
        });
      }

      try {
        const jwtPayload = await verifyJwt(token, options);
        return {jwtErrorMessage: '', jwtPayload: jwtPayload}
      } catch (err) {
        return {jwtErrorMessage: 'JWT verification failed: ' + err, jwtPayload: null}
      }
    }
    else if (key) {
      if (type === "RS256") {
        realKey = enforcePEMFormatting(key);
      }
      else {
        realKey = key;
      }

      const jwtPayload = jwt.verify(token, realKey, options) as JwtPayload;
      return { jwtErrorMessage: '', jwtPayload };
    }
    else {
      const jwtErrorMessage = 'Neither a valid JWT Key or JWK URL were provided. A type (algorithm) and either of those two must be provided.'
      return { jwtErrorMessage, jwtPayload: null };
    }
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

export function generateJwt(
  username: string,
  defaultRole: string,
  allowedRoles: string[],
  expiry: StringValue = getEnv().JWT_EXPIRATION,
): string | null {
  try {
    const { HASURA_GRAPHQL_JWT_SECRET, JWT_CLAIMS } = getEnv();
    const { key, type }: JwtSecret = JSON.parse(HASURA_GRAPHQL_JWT_SECRET);
    if (key) {
      const options: jwt.SignOptions = { algorithm: type as Algorithm, expiresIn: expiry };
      const payload: JwtPayload = {
        [JWT_CLAIMS.namespace]: {
          [JWT_CLAIMS.allowedRoles]: allowedRoles,
          [JWT_CLAIMS.defaultRole]: defaultRole,
          [JWT_CLAIMS.userId]: username,
        },
        username,
      };

      return jwt.sign(payload, key, options);
    }
    console.error('using JWKS URL, so this JWT generation will not work. You also shouldn\'t be using this method if using JWKS')
    return null;
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
  const { jwtErrorMessage, jwtPayload } = await decodeJwt(authorizationHeader);

  if (jwtPayload) {
    // Lazy-upsert the user's permissions row on first sight.
    //
    // For gateway-issued JWTs (JWT/SSO modes), login() already provisioned the row,
    // so the SELECT inside getUserRoles is a no-op for existing users. For
    // Keycloak-issued OIDC tokens this is the *only* place provisioning happens —
    // the UI's user-scoped JWT lacks Hasura insert permission on permissions.users.
    //
    // Failure here must not block session validation (token is still valid even if
    // the DB write hiccups); log and continue.
    try {
      const { JWT_CLAIMS } = getEnv();
      const namespace = (jwtPayload as Record<string, unknown>)[JWT_CLAIMS.namespace] as
        | Record<string, unknown>
        | undefined;
      const username = namespace?.[JWT_CLAIMS.userId];
      const default_role = namespace?.[JWT_CLAIMS.defaultRole];
      const allowed_roles = namespace?.[JWT_CLAIMS.allowedRoles];
      if (typeof username === 'string' && typeof default_role === 'string' && Array.isArray(allowed_roles)) {
        await getUserRoles(username, default_role, allowed_roles as string[]);
      }
    } catch (err) {
      console.error('User provisioning during session validation failed:', err);
    }
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
