import { getEnv } from '../../../env.js';
import { authGroupMappingsExist, generateJwt, getUserRoles, mapGroupsToRoles, syncRolesToDB } from '../functions.js';
import type { AuthAdapter, AuthResponse, ValidateResponse } from '../../../types/auth.js';
import { Request } from 'express';

/**
 * SSO2Adapter: Reads identity headers set by mod_auth_openidc (via sso2csso-proxy or similar).
 *
 * Expected headers:
 * - X-Sub: Username (lowercase, without domain)
 * - X-Groups: Base64-encoded JSON object of groups {"group1": true, "group2": true, ...}
 * - OIDC_CLAIM_*: Individual OIDC claims (optional, for additional user info)
 *
 * The reverse proxy (Apache + mod_auth_openidc) handles:
 * - OIDC authentication flow with SSO2
 * - Session management
 * - Setting these headers on authenticated requests
 * - Stripping client-supplied headers to prevent spoofing
 */

export const SSO2AuthAdapter: AuthAdapter = {
  logout: async (_req: Request): Promise<boolean> => {
    // Logout is handled by the reverse proxy via /login?logout=... or /ssologoutredirect
    // The proxy redirects to mod_auth_openidc logout endpoint
    return true;
  },

  validate: async (req: Request): Promise<ValidateResponse> => {
    const { AUTH_UI_URL } = getEnv();
    const redirectTo = req.url || '/';
    const redirectURL = `${AUTH_UI_URL}/?redirect=${encodeURIComponent(redirectTo)}`;

    // Read identity from headers set by mod_auth_openidc
    const username = req.headers['x-sub'] as string | undefined;

    if (!username) {
      // No X-Sub header means user is not authenticated by the proxy
      const redirectTo = req.url || '/';
      const redirectURL = `${AUTH_UI_URL}/?redirect=${encodeURIComponent(redirectTo)}`;

      return {
        message: 'Not authenticated - no X-Sub header present',
        redirectURL,
        success: false,
      };
    }

    try {
      // Extract groups from X-Groups header (base64-encoded JSON)
      const groupsHeader = req.headers['x-groups'] as string | undefined;
      let groupList: string[] = [];

      if (groupsHeader) {
        try {
          const decoded = Buffer.from(groupsHeader, 'base64').toString('utf-8');
          const groupMap = JSON.parse(decoded) as Record<string, boolean>;
          // Only include groups where value is true
          groupList = Object.keys(groupMap).filter(g => groupMap[g]);
        } catch (err) {
          console.warn('Failed to decode X-Groups header:', err);
          // Continue with empty group list
        }
      }

      // Alternatively, try to get groups from OIDC_CLAIM_group header
      if (groupList.length === 0) {
        const groupClaim = req.headers['oidc_claim_group'] as string | undefined;
        if (groupClaim) {
          groupList = groupClaim.split(',').map(g => g.trim()).filter(g => g);
        }
      }

      const loginResp = await loginSSO2(username, groupList);

      if (loginResp.success) {
        return {
          message: 'Valid SSO2 session',
          redirectURL: '',
          success: true,
          token: loginResp.token ?? undefined,
          userId: loginResp.message,
        };
      } else {
        return {
          message: loginResp.message,
          redirectURL,
          success: false
        }
      }
    } catch (error) {
      console.error('SSO2 validation error:', error);

      return {
        message: 'Error processing SSO2 headers',
        redirectURL,
        success: false,
      };
    }
  },
};

export async function loginSSO2(userId: string, groupList: string[]): Promise<AuthResponse> {
  try {
    const { default_role, allowed_roles } = mapGroupsToRoles(groupList);

    // If mappings exist, we treat them as the source of truth
    if (authGroupMappingsExist()) {
      // Get existing allowed_roles from DB
      const existing_roles = await getUserRoles(userId, default_role, allowed_roles);

      // Calculate if allowed_roles in DB match our freshly calculated mapping
      const existing_set = new Set(existing_roles.allowed_roles);
      const mapped_roles_match_db =
        allowed_roles.length === existing_roles.allowed_roles.length &&
        allowed_roles.every(e => existing_set.has(e));
      const default_role_match_db = existing_roles.default_role === default_role;

      // If they are different, upsert roles from mapping (source of truth)
      if (!mapped_roles_match_db || !default_role_match_db) {
        await syncRolesToDB(userId, default_role, allowed_roles);
      }
    }

    const user_roles = await getUserRoles(userId, default_role, allowed_roles);

    if (user_roles.allowed_roles.length === 0) {
      return {
        message: `User ${userId} has no allowed roles`,
        success: false,
        token: null,
      };
    }

    return {
      message: userId,
      success: true,
      token: generateJwt(userId, user_roles.default_role, user_roles.allowed_roles),
    };
  } catch (error) {
    console.error('SSO2 login error:', error);
    return {
      message: 'An unexpected error occurred during SSO2 login',
      success: false,
      token: null,
    };
  }
}
