import { Request } from 'express';

export type JsonWebToken = string;

export type JwtDecode = {
  jwtErrorMessage: string;
  jwtPayload: JwtPayload | null;
};

// JWT payload with configurable claims namespace
// The namespace key is dynamic (configured via JWT_CLAIMS_NAMESPACE)
export type JwtPayload = {
  [namespace: string]: Record<string, string | string[]> | string;
  username: string;
};

export type JwtSecret = {
  type: string;

  // either key or jwk_url
  key?: string;
  jwk_url?: string;

  // optional validation fields (used with JWKS/OIDC)
  issuer?: string;
  audience?: string | string[];
};

export type AuthResponse = {
  message: string;
  success: boolean;
  token: JsonWebToken | null;
};

export type SessionResponse = {
  message: string;
  success: boolean;
};

export type UserResponse = {
  message: string;
  success: boolean;
  user: User | null;
};

export type UserId = string;

export type User = {
  id: UserId;
};

export type ValidateResponse = {
  success: boolean;
  message: string;
  userId?: string;
  token?: string;
  redirectURL?: string;
};

export interface AuthAdapter {
  validate(req: Request): Promise<ValidateResponse>;
  logout(req: Request): Promise<boolean>;
}

export type GroupRoleMapping = { [key: string]: string[] };

export type UserRoles = {
  default_role: string;
  allowed_roles: string[];
};
