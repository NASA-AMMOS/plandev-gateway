import { generateKeyPairSync } from 'crypto';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { authorizationHeaderToToken, decodeJwt } from '../src/packages/auth/functions';

// Generate RSA key pair for testing
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Helper to create a valid JWT payload with Hasura claims
function createPayload(overrides = {}) {
  return {
    'https://hasura.io/jwt/claims': {
      'x-hasura-allowed-roles': ['user', 'viewer'],
      'x-hasura-default-role': 'user',
      'x-hasura-user-id': 'test-user',
    },
    username: 'test-user',
    iss: 'https://test-issuer.example.com',
    aud: 'test-audience',
    ...overrides,
  };
}

// Helper to sign a JWT with RS256
function signToken(payload: object, options: jwt.SignOptions = {}) {
  return jwt.sign(payload, privateKey, { algorithm: 'RS256', expiresIn: '1h', ...options });
}

describe('authorizationHeaderToToken', () => {
  test('extracts token from valid Bearer header', () => {
    const token = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.test';
    const result = authorizationHeaderToToken(`Bearer ${token}`);
    expect(result).toBe(token);
  });

  test('throws error when Bearer prefix is missing', () => {
    expect(() => authorizationHeaderToToken('token-without-bearer')).toThrow(
      "Authorization header does not include 'Bearer' prefix",
    );
  });

  test('throws error when header is undefined', () => {
    expect(() => authorizationHeaderToToken(undefined)).toThrow('Authorization header not found');
  });

  test('throws error when header is null', () => {
    expect(() => authorizationHeaderToToken(null)).toThrow('Authorization header not found');
  });
});

describe('decodeJwt with RS256 static key', () => {
  beforeEach(() => {
    vi.stubEnv('JWT_ALGORITHMS', JSON.stringify(['RS256']));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('successfully verifies valid token with RS256 static key', async () => {
    const jwtSecret = JSON.stringify({
      type: 'RS256',
      key: publicKey,
    });
    vi.stubEnv('HASURA_GRAPHQL_JWT_SECRET', jwtSecret);

    const payload = createPayload();
    const token = signToken(payload);

    const result = await decodeJwt(`Bearer ${token}`);

    expect(result.jwtErrorMessage).toBe('');
    expect(result.jwtPayload).not.toBeNull();
    expect(result.jwtPayload?.username).toBe('test-user');
  });

  test('rejects token with wrong issuer when issuer validation is configured', async () => {
    const jwtSecret = JSON.stringify({
      type: 'RS256',
      key: publicKey,
      issuer: 'https://expected-issuer.example.com',
    });
    vi.stubEnv('HASURA_GRAPHQL_JWT_SECRET', jwtSecret);

    const payload = createPayload({ iss: 'https://wrong-issuer.example.com' });
    const token = signToken(payload);

    const result = await decodeJwt(`Bearer ${token}`);

    expect(result.jwtPayload).toBeNull();
    expect(result.jwtErrorMessage).toContain('jwt issuer invalid');
  });

  test('rejects token with wrong audience when audience validation is configured', async () => {
    const jwtSecret = JSON.stringify({
      type: 'RS256',
      key: publicKey,
      audience: 'expected-audience',
    });
    vi.stubEnv('HASURA_GRAPHQL_JWT_SECRET', jwtSecret);

    const payload = createPayload({ aud: 'wrong-audience' });
    const token = signToken(payload);

    const result = await decodeJwt(`Bearer ${token}`);

    expect(result.jwtPayload).toBeNull();
    expect(result.jwtErrorMessage).toContain('jwt audience invalid');
  });

  test('accepts token when issuer matches configured issuer', async () => {
    const expectedIssuer = 'https://keycloak.example.com/realms/test';
    const jwtSecret = JSON.stringify({
      type: 'RS256',
      key: publicKey,
      issuer: expectedIssuer,
    });
    vi.stubEnv('HASURA_GRAPHQL_JWT_SECRET', jwtSecret);

    const payload = createPayload({ iss: expectedIssuer });
    const token = signToken(payload);

    const result = await decodeJwt(`Bearer ${token}`);

    expect(result.jwtErrorMessage).toBe('');
    expect(result.jwtPayload).not.toBeNull();
  });

  test('accepts token when audience matches configured audience', async () => {
    const expectedAudience = 'aerie';
    const jwtSecret = JSON.stringify({
      type: 'RS256',
      key: publicKey,
      audience: expectedAudience,
    });
    vi.stubEnv('HASURA_GRAPHQL_JWT_SECRET', jwtSecret);

    const payload = createPayload({ aud: expectedAudience });
    const token = signToken(payload);

    const result = await decodeJwt(`Bearer ${token}`);

    expect(result.jwtErrorMessage).toBe('');
    expect(result.jwtPayload).not.toBeNull();
  });

  test('accepts token when audience is in array of allowed audiences', async () => {
    const jwtSecret = JSON.stringify({
      type: 'RS256',
      key: publicKey,
      audience: ['aerie', 'other-service'],
    });
    vi.stubEnv('HASURA_GRAPHQL_JWT_SECRET', jwtSecret);

    const payload = createPayload({ aud: 'aerie' });
    const token = signToken(payload);

    const result = await decodeJwt(`Bearer ${token}`);

    expect(result.jwtErrorMessage).toBe('');
    expect(result.jwtPayload).not.toBeNull();
  });

  test('validates both issuer and audience when both are configured', async () => {
    const jwtSecret = JSON.stringify({
      type: 'RS256',
      key: publicKey,
      issuer: 'https://keycloak.example.com',
      audience: 'aerie',
    });
    vi.stubEnv('HASURA_GRAPHQL_JWT_SECRET', jwtSecret);

    // Token with correct issuer but wrong audience
    const payload = createPayload({
      iss: 'https://keycloak.example.com',
      aud: 'wrong-audience',
    });
    const token = signToken(payload);

    const result = await decodeJwt(`Bearer ${token}`);

    expect(result.jwtPayload).toBeNull();
    expect(result.jwtErrorMessage).toContain('jwt audience invalid');
  });

  test('skips issuer validation when not configured', async () => {
    const jwtSecret = JSON.stringify({
      type: 'RS256',
      key: publicKey,
      // no issuer configured
    });
    vi.stubEnv('HASURA_GRAPHQL_JWT_SECRET', jwtSecret);

    const payload = createPayload({ iss: 'any-issuer' });
    const token = signToken(payload);

    const result = await decodeJwt(`Bearer ${token}`);

    expect(result.jwtErrorMessage).toBe('');
    expect(result.jwtPayload).not.toBeNull();
  });

  test('skips audience validation when not configured', async () => {
    const jwtSecret = JSON.stringify({
      type: 'RS256',
      key: publicKey,
      // no audience configured
    });
    vi.stubEnv('HASURA_GRAPHQL_JWT_SECRET', jwtSecret);

    const payload = createPayload({ aud: 'any-audience' });
    const token = signToken(payload);

    const result = await decodeJwt(`Bearer ${token}`);

    expect(result.jwtErrorMessage).toBe('');
    expect(result.jwtPayload).not.toBeNull();
  });

  test('rejects expired token', async () => {
    const jwtSecret = JSON.stringify({
      type: 'RS256',
      key: publicKey,
    });
    vi.stubEnv('HASURA_GRAPHQL_JWT_SECRET', jwtSecret);

    const payload = createPayload();
    const token = signToken(payload, { expiresIn: '-1h' }); // Already expired

    const result = await decodeJwt(`Bearer ${token}`);

    expect(result.jwtPayload).toBeNull();
    expect(result.jwtErrorMessage).toContain('Token expired');
  });

  test('returns error when no key or jwk_url provided', async () => {
    const jwtSecret = JSON.stringify({
      type: 'RS256',
      // no key or jwk_url
    });
    vi.stubEnv('HASURA_GRAPHQL_JWT_SECRET', jwtSecret);

    const payload = createPayload();
    const token = signToken(payload);

    const result = await decodeJwt(`Bearer ${token}`);

    expect(result.jwtPayload).toBeNull();
    expect(result.jwtErrorMessage).toContain('Neither a valid JWT Key or JWK URL were provided');
  });
});

describe('decodeJwt with HS256 static key', () => {
  const hmacSecret = 'super-secret-key-that-is-long-enough-for-hs256';

  beforeEach(() => {
    vi.stubEnv('JWT_ALGORITHMS', JSON.stringify(['HS256']));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('successfully verifies valid token with HS256 static key', async () => {
    const jwtSecret = JSON.stringify({
      type: 'HS256',
      key: hmacSecret,
    });
    vi.stubEnv('HASURA_GRAPHQL_JWT_SECRET', jwtSecret);

    const payload = createPayload();
    const token = jwt.sign(payload, hmacSecret, { algorithm: 'HS256', expiresIn: '1h' });

    const result = await decodeJwt(`Bearer ${token}`);

    expect(result.jwtErrorMessage).toBe('');
    expect(result.jwtPayload).not.toBeNull();
    expect(result.jwtPayload?.username).toBe('test-user');
  });

  test('rejects token signed with wrong key', async () => {
    const jwtSecret = JSON.stringify({
      type: 'HS256',
      key: hmacSecret,
    });
    vi.stubEnv('HASURA_GRAPHQL_JWT_SECRET', jwtSecret);

    const payload = createPayload();
    const token = jwt.sign(payload, 'different-secret-key-for-signing', {
      algorithm: 'HS256',
      expiresIn: '1h',
    });

    const result = await decodeJwt(`Bearer ${token}`);

    expect(result.jwtPayload).toBeNull();
    expect(result.jwtErrorMessage).toContain('invalid signature');
  });
});

describe('configurable JWT claim paths', () => {
  beforeEach(() => {
    vi.stubEnv('JWT_ALGORITHMS', JSON.stringify(['RS256']));
    vi.stubEnv(
      'HASURA_GRAPHQL_JWT_SECRET',
      JSON.stringify({
        type: 'RS256',
        key: publicKey,
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('reads claims from default Hasura namespace', async () => {
    // Default namespace: https://hasura.io/jwt/claims
    const payload = {
      'https://hasura.io/jwt/claims': {
        'x-hasura-allowed-roles': ['admin', 'user'],
        'x-hasura-default-role': 'admin',
        'x-hasura-user-id': 'user-123',
      },
      username: 'user-123',
    };
    const token = signToken(payload);

    const result = await decodeJwt(`Bearer ${token}`);

    expect(result.jwtErrorMessage).toBe('');
    expect(result.jwtPayload).not.toBeNull();
    const namespace = result.jwtPayload?.['https://hasura.io/jwt/claims'] as Record<string, unknown>;
    expect(namespace['x-hasura-user-id']).toBe('user-123');
    expect(namespace['x-hasura-allowed-roles']).toEqual(['admin', 'user']);
    expect(namespace['x-hasura-default-role']).toBe('admin');
  });

  test('reads claims from custom namespace when configured', async () => {
    // Custom namespace
    vi.stubEnv('JWT_CLAIMS_NAMESPACE', 'custom/claims');
    vi.stubEnv('JWT_CLAIMS_USER_ID', 'sub');
    vi.stubEnv('JWT_CLAIMS_ALLOWED_ROLES', 'roles');
    vi.stubEnv('JWT_CLAIMS_DEFAULT_ROLE', 'primary_role');

    const payload = {
      'custom/claims': {
        sub: 'custom-user-456',
        roles: ['editor', 'viewer'],
        primary_role: 'editor',
      },
      username: 'custom-user-456',
    };
    const token = signToken(payload);

    const result = await decodeJwt(`Bearer ${token}`);

    expect(result.jwtErrorMessage).toBe('');
    expect(result.jwtPayload).not.toBeNull();
    const namespace = result.jwtPayload?.['custom/claims'] as Record<string, unknown>;
    expect(namespace['sub']).toBe('custom-user-456');
    expect(namespace['roles']).toEqual(['editor', 'viewer']);
    expect(namespace['primary_role']).toBe('editor');
  });

  test('supports Keycloak-style claim paths', async () => {
    // Keycloak typically uses realm_access.roles or resource_access
    vi.stubEnv('JWT_CLAIMS_NAMESPACE', 'realm_access');
    vi.stubEnv('JWT_CLAIMS_ALLOWED_ROLES', 'roles');

    const payload = {
      realm_access: {
        roles: ['aerie_admin', 'aerie_user'],
      },
      preferred_username: 'keycloak-user',
      username: 'keycloak-user',
    };
    const token = signToken(payload);

    const result = await decodeJwt(`Bearer ${token}`);

    expect(result.jwtErrorMessage).toBe('');
    expect(result.jwtPayload).not.toBeNull();
    const namespace = result.jwtPayload?.['realm_access'] as Record<string, unknown>;
    expect(namespace['roles']).toEqual(['aerie_admin', 'aerie_user']);
  });
});

describe('decodeJwt binds the accepted algorithm to the secret type', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('verifies an HS256 token for an HS256 secret with no JWT_ALGORITHMS set (regression guard)', async () => {
    // The regular (non-OIDC) test/CI phase sets no JWT_ALGORITHMS. The accepted algorithm must
    // come from the secret's `type`, not the process-wide default (RS256) — otherwise the HS256
    // tokens generateJwt mints get rejected (the failure that broke the HS256 e2e phase).
    const hmacSecret = 'super-secret-key-that-is-long-enough-for-hs256';
    vi.stubEnv('HASURA_GRAPHQL_JWT_SECRET', JSON.stringify({ type: 'HS256', key: hmacSecret }));

    const token = jwt.sign(createPayload(), hmacSecret, { algorithm: 'HS256', expiresIn: '1h' });
    const result = await decodeJwt(`Bearer ${token}`);

    expect(result.jwtErrorMessage).toBe('');
    expect(result.jwtPayload?.username).toBe('test-user');
  });

  test('verifies an RS256 token for an RS256 secret with no JWT_ALGORITHMS set', async () => {
    vi.stubEnv('HASURA_GRAPHQL_JWT_SECRET', JSON.stringify({ type: 'RS256', key: publicKey }));

    const result = await decodeJwt(`Bearer ${signToken(createPayload())}`);

    expect(result.jwtErrorMessage).toBe('');
    expect(result.jwtPayload).not.toBeNull();
  });

  test('rejects an HS256 token forged with the RSA public key on an RS256 secret, even if JWT_ALGORITHMS lists HS256', async () => {
    // Classic RS256->HS256 confusion: the RSA public key is public, so an attacker can sign an
    // HS256 token using it as the HMAC secret. Binding the accepted algorithm to the secret's
    // declared type (RS256) rejects it regardless of a permissive/misconfigured JWT_ALGORITHMS.
    vi.stubEnv('JWT_ALGORITHMS', JSON.stringify(['RS256', 'HS256'])); // deliberately permissive — must be ignored
    vi.stubEnv('HASURA_GRAPHQL_JWT_SECRET', JSON.stringify({ type: 'RS256', key: publicKey }));

    const forged = jwt.sign(createPayload(), publicKey, { algorithm: 'HS256', expiresIn: '1h' });
    const result = await decodeJwt(`Bearer ${forged}`);

    expect(result.jwtPayload).toBeNull();
    expect(result.jwtErrorMessage).not.toBe('');
  });
});
