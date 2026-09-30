import { GroupRoleMapping } from './types/auth';
import { StringValue } from 'ms';

/**
 * JWT claim path configuration.
 * Allows customization of where user ID, roles, and other claims are read from in the JWT.
 * Defaults follow Hasura's JWT claims namespace convention.
 */
export type JwtClaimsConfig = {
  namespace: string;
  userId: string;
  allowedRoles: string;
  defaultRole: string;
};

export type Env = {
  ALLOWED_ROLES: string[];
  ALLOWED_ROLES_NO_AUTH: string[];
  AUTH_GROUP_ROLE_MAPPINGS: GroupRoleMapping;
  AUTH_SSO_TOKEN_NAME: string[];
  AUTH_TYPE: string;
  AUTH_UI_URL: string;
  AUTH_URL: string;
  DEFAULT_ROLE: string[];
  DEFAULT_ROLE_NO_AUTH: string;
  GQL_API_URL: string;
  GQL_API_WS_URL: string;
  HASURA_API_URL: string;
  HASURA_GRAPHQL_JWT_SECRET: string;
  JWT_CLAIMS: JwtClaimsConfig;
  JWT_EXPIRATION: StringValue;
  LOG_FILE: string;
  LOG_LEVEL: string;
  PORT: string;
  PLANDEV_DB: string;
  PLANDEV_DB_HOST: string;
  PLANDEV_DB_PORT: string;
  GATEWAY_DB_USER: string;
  GATEWAY_DB_PASSWORD: string;
  RATE_LIMITER_FILES_MAX: number;
  RATE_LIMITER_LOGIN_MAX: number;
  VERSION: string;
};

export const defaultJwtClaims: JwtClaimsConfig = {
  namespace: 'https://hasura.io/jwt/claims',
  userId: 'x-hasura-user-id',
  allowedRoles: 'x-hasura-allowed-roles',
  defaultRole: 'x-hasura-default-role',
};

export const defaultEnv: Env = {
  ALLOWED_ROLES: ['user', 'viewer'],
  ALLOWED_ROLES_NO_AUTH: ['aerie_admin', 'user', 'viewer'],
  AUTH_GROUP_ROLE_MAPPINGS: {},
  AUTH_SSO_TOKEN_NAME: ['iPlanetDirectoryPro'], // default CAM token name
  AUTH_TYPE: 'cam',
  AUTH_UI_URL: 'https://atb-ocio-12b.jpl.nasa.gov:8443/cam-ui/',
  AUTH_URL: 'https://atb-ocio-12b.jpl.nasa.gov:8443/cam-api',
  DEFAULT_ROLE: ['user'],
  DEFAULT_ROLE_NO_AUTH: 'aerie_admin',
  GATEWAY_DB_PASSWORD: '',
  GATEWAY_DB_USER: '',
  GQL_API_URL: 'http://localhost:8080/v1/graphql',
  GQL_API_WS_URL: 'ws://localhost:8080/v1/graphql',
  HASURA_API_URL: 'http://hasura:8080',
  HASURA_GRAPHQL_JWT_SECRET: '',
  JWT_CLAIMS: defaultJwtClaims,
  JWT_EXPIRATION: '36h' as StringValue,
  LOG_FILE: 'console',
  LOG_LEVEL: 'info',
  PLANDEV_DB: 'plandev',
  PLANDEV_DB_HOST: 'localhost',
  PLANDEV_DB_PORT: '5432',
  PORT: '9000',
  RATE_LIMITER_FILES_MAX: 1000,
  RATE_LIMITER_LOGIN_MAX: 1000,
  VERSION: '4.4.0',
};

/**
 * Parse generically typed environment variable into an array.
 * Returns the default value if parse fails.
 */
function parseArray<T = string>(value: string | undefined, defaultValue: T[]): T[] {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (e) {
      console.error(e);
      return defaultValue;
    }
  }
  return defaultValue;
}

/**
 * Parses a JSON env var string into a GroupRoleMapping object, which has dynamically named keys
 */
function parseGroupRoleMappings(value: string | undefined): GroupRoleMapping {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (e) {
      console.error(e);
      throw new Error('Fatal error parsing AUTH_GROUP_ROLE_MAPPINGS JSON, exiting...');
    }
  }
  // if env var isn't set, return empty object
  return defaultEnv.AUTH_GROUP_ROLE_MAPPINGS;
}

/**
 * Parse string typed environment variable into a number.
 * Returns the default value if parse fails.
 */
function parseNumber(value: string | undefined, defaultValue: number): number {
  if (typeof value === 'string') {
    const parsedValue = parseFloat(value);
    if (!Number.isNaN(parsedValue)) {
      return parsedValue;
    }
  }
  return defaultValue;
}

export function getEnv(): Env {
  const { env } = process;

  const ALLOWED_ROLES = parseArray(env['ALLOWED_ROLES'], defaultEnv.ALLOWED_ROLES);
  const ALLOWED_ROLES_NO_AUTH = parseArray(env['ALLOWED_ROLES_NO_AUTH'], defaultEnv.ALLOWED_ROLES_NO_AUTH);
  const AUTH_TYPE = env['AUTH_TYPE'] ?? defaultEnv.AUTH_TYPE;
  const AUTH_URL = env['AUTH_URL'] ?? defaultEnv.AUTH_URL;
  const AUTH_UI_URL = env['AUTH_UI_URL'] ?? defaultEnv.AUTH_UI_URL;
  const AUTH_GROUP_ROLE_MAPPINGS = parseGroupRoleMappings(env['AUTH_GROUP_ROLE_MAPPINGS']);
  const AUTH_SSO_TOKEN_NAME = parseArray(env['AUTH_SSO_TOKEN_NAME'], defaultEnv.AUTH_SSO_TOKEN_NAME);
  const DEFAULT_ROLE = parseArray(env['DEFAULT_ROLE'], defaultEnv.DEFAULT_ROLE);
  const DEFAULT_ROLE_NO_AUTH = env['DEFAULT_ROLE_NO_AUTH'] ?? defaultEnv.DEFAULT_ROLE_NO_AUTH;
  const GQL_API_URL = env['GQL_API_URL'] ?? defaultEnv.GQL_API_URL;
  const GQL_API_WS_URL = env['GQL_API_WS_URL'] ?? defaultEnv.GQL_API_WS_URL;
  const HASURA_GRAPHQL_JWT_SECRET = env['HASURA_GRAPHQL_JWT_SECRET'] ?? defaultEnv.HASURA_GRAPHQL_JWT_SECRET;
  const HASURA_API_URL = env['HASURA_API_URL'] ?? defaultEnv.HASURA_API_URL;
  const JWT_CLAIMS: JwtClaimsConfig = {
    namespace: env['JWT_CLAIMS_NAMESPACE'] ?? defaultJwtClaims.namespace,
    userId: env['JWT_CLAIMS_USER_ID'] ?? defaultJwtClaims.userId,
    allowedRoles: env['JWT_CLAIMS_ALLOWED_ROLES'] ?? defaultJwtClaims.allowedRoles,
    defaultRole: env['JWT_CLAIMS_DEFAULT_ROLE'] ?? defaultJwtClaims.defaultRole,
  };
  const JWT_EXPIRATION = (env['JWT_EXPIRATION'] as StringValue) ?? defaultEnv.JWT_EXPIRATION;
  const LOG_FILE = env['LOG_FILE'] ?? defaultEnv.LOG_FILE;
  const LOG_LEVEL = env['LOG_LEVEL'] ?? defaultEnv.LOG_LEVEL;
  const PORT = env['PORT'] ?? defaultEnv.PORT;
  const PLANDEV_DB = env['PLANDEV_DB'] ?? defaultEnv.PLANDEV_DB;
  const PLANDEV_DB_HOST = env['PLANDEV_DB_HOST'] ?? env['AERIE_DB_HOST'] ?? defaultEnv.PLANDEV_DB_HOST;
  const PLANDEV_DB_PORT = env['PLANDEV_DB_PORT'] ?? env['AERIE_DB_PORT'] ?? defaultEnv.PLANDEV_DB_PORT;
  const GATEWAY_DB_USER = env['GATEWAY_DB_USER'] ?? defaultEnv.GATEWAY_DB_USER;
  const GATEWAY_DB_PASSWORD = env['GATEWAY_DB_PASSWORD'] ?? defaultEnv.GATEWAY_DB_PASSWORD;
  const RATE_LIMITER_FILES_MAX = parseNumber(env['RATE_LIMITER_FILES_MAX'], defaultEnv.RATE_LIMITER_FILES_MAX);
  const RATE_LIMITER_LOGIN_MAX = parseNumber(env['RATE_LIMITER_LOGIN_MAX'], defaultEnv.RATE_LIMITER_LOGIN_MAX);
  const VERSION = env['npm_package_version'] ?? defaultEnv.VERSION;

  return {
    ALLOWED_ROLES,
    ALLOWED_ROLES_NO_AUTH,
    AUTH_GROUP_ROLE_MAPPINGS,
    AUTH_SSO_TOKEN_NAME,
    AUTH_TYPE,
    AUTH_UI_URL,
    AUTH_URL,
    DEFAULT_ROLE,
    DEFAULT_ROLE_NO_AUTH,
    GATEWAY_DB_PASSWORD,
    GATEWAY_DB_USER,
    GQL_API_URL,
    GQL_API_WS_URL,
    HASURA_API_URL,
    HASURA_GRAPHQL_JWT_SECRET,
    JWT_CLAIMS,
    JWT_EXPIRATION,
    LOG_FILE,
    LOG_LEVEL,
    PLANDEV_DB,
    PLANDEV_DB_HOST,
    PLANDEV_DB_PORT,
    PORT,
    RATE_LIMITER_FILES_MAX,
    RATE_LIMITER_LOGIN_MAX,
    VERSION,
  };
}
