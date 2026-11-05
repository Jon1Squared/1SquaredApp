/**
 * Pure, browser-safe Microsoft Entra ID v2.0 OIDC claim normalisation & MFA detection
 * (`core/src/domain/rbac/entra.ts`).
 *
 * Re-exported by both `@platform/core` (`core/src/domain/rbac/index.ts`) and
 * `core/src/tenancy/index.ts`.
 */

import type { RbacConfiguration } from '../../api/index';

/**
 * Raw Microsoft Entra ID (v2.0 OIDC / JWT) claims emitted by the 1Squared Entra environment.
 */
export interface EntraIdRawTokenClaims {
  /** Subject identifier (`sub`) or fallback user identifier. */
  readonly sub?: string;
  /** Immutable Entra ID User Object GUID (`oid`). */
  readonly oid?: string;
  /** Entra ID Directory / Tenant GUID (`tid`). */
  readonly tid?: string;
  /** User Principal Name (`upn`) or `preferred_username`. */
  readonly preferred_username?: string;
  readonly upn?: string;
  readonly email?: string;
  readonly name?: string;
  /** Entra Enterprise Application App Roles (`roles` claim, e.g. `["1Squared.Partner"]`). */
  readonly roles?: readonly string[];
  /** Entra Security Group Object IDs (`groups` claim). */
  readonly groups?: readonly string[];
  /** Authentication Methods References (`amr` claim, e.g. `["pwd", "mfa"]`, `["ngcmfa"]`, `["fido"]`). */
  readonly amr?: readonly string[];
  /** Authentication Context Class Reference (`acr` / `acrs`). */
  readonly acrs?: readonly string[];
  /** Explicit MFA flag if already evaluated by upstream gateway. */
  readonly mfaVerified?: boolean;
}

const ENTRA_MFA_AMR_VALUES = new Set([
  'mfa',
  'ngcmfa',
  'fido',
  'hwk',
  'otp',
  'sms',
  'tel',
  'swk',
]);

/**
 * Evaluates whether a Microsoft Entra ID token satisfied Multi-Factor Authentication (MFA).
 * Ignores any raw `mfaVerified` property on the token claims (Entra ID never emits it).
 * Accepts `acrs: 'c1'` only when explicitly enabled in tenant configuration (`allowAcrsC1`).
 */
export function isEntraMfaVerified(
  claims: EntraIdRawTokenClaims,
  options?: { allowAcrsC1?: boolean },
): boolean {
  if (Array.isArray(claims.amr)) {
    for (const method of claims.amr) {
      if (ENTRA_MFA_AMR_VALUES.has(String(method).toLowerCase().trim())) {
        return true;
      }
    }
  }
  if (Array.isArray(claims.acrs)) {
    for (const acr of claims.acrs) {
      const norm = String(acr).toLowerCase().trim();
      if (norm.includes('mfa')) {
        return true;
      }
      if (norm === 'c1' && options?.allowAcrsC1 === true) {
        return true;
      }
    }
  }
  return false;
}

export interface VerifiedOidcTokenClaims {
  /** Marker confirming the token was verified by the OIDC authentication middleware. */
  readonly __verifiedByOidcMiddleware: true;
  readonly sub: string;
  readonly tenantId: string;
  readonly email: string;
  readonly upn?: string;
  readonly name: string;
  readonly roles: readonly string[];
  readonly groups?: readonly string[];
  readonly entraObjectId?: string;
  readonly entraTenantId?: string;
  readonly amr?: readonly string[];
  readonly mfaVerified: boolean;
}

/**
 * Normalises verified Microsoft Entra ID v2.0 JWT claims into `VerifiedOidcTokenClaims`,
 * mapping Entra `roles` (App Roles) and `groups` (Security Group Object IDs) through
 * the tenant's `rbac.identityMapping` configuration.
 */
export function mapEntraTokenClaimsToVerifiedOidcToken(params: {
  claims: EntraIdRawTokenClaims;
  tenantId: string;
  rbacConfig?: Pick<RbacConfiguration, 'identityMapping' | 'roles'>;
  fallbackActorId?: string;
}): VerifiedOidcTokenClaims {
  const { claims, tenantId, rbacConfig, fallbackActorId } = params;
  const entraObjectId = claims.oid?.trim() || undefined;
  const sub = claims.sub?.trim() || entraObjectId || fallbackActorId || '';
  if (!sub) {
    throw new Error(
      'TENANCY_AUTH_ERROR: Entra ID token is missing both "oid" and "sub" user identifiers.',
    );
  }
  const email = (
    claims.email ||
    claims.preferred_username ||
    claims.upn ||
    ''
  )
    .trim()
    .toLowerCase();
  const name = (claims.name || email || sub).trim();
  const rawRoles = Array.isArray(claims.roles) ? claims.roles : [];
  const rawGroups = Array.isArray(claims.groups) ? claims.groups : [];

  const mappedRoles = new Set<string>();
  const appRoleMap = rbacConfig?.identityMapping?.entraAppRoleToRoleKey ?? {};
  const groupMap = rbacConfig?.identityMapping?.entraGroupToRoleKey ?? {};
  const knownRoles = rbacConfig?.roles
    ? new Set(Object.keys(rbacConfig.roles))
    : null;

  for (const rawRole of rawRoles) {
    const r = String(rawRole).trim();
    if (!r) continue;
    const mapped = appRoleMap[r];
    if (mapped?.length) {
      for (const rk of mapped) {
        if (!knownRoles || knownRoles.has(rk)) {
          mappedRoles.add(rk);
        }
      }
    } else if (!knownRoles || knownRoles.has(r)) {
      mappedRoles.add(r);
    }
  }

  for (const rawGroup of rawGroups) {
    const g = String(rawGroup).trim();
    if (!g) continue;
    const mapped = groupMap[g];
    if (mapped?.length) {
      for (const rk of mapped) {
        if (!knownRoles || knownRoles.has(rk)) {
          mappedRoles.add(rk);
        }
      }
    }
  }

  const upn = (claims.upn || claims.preferred_username || email).trim().toLowerCase() || undefined;

  return Object.freeze({
    __verifiedByOidcMiddleware: true as const,
    sub,
    tenantId: tenantId.trim(),
    email,
    ...(upn ? { upn } : {}),
    name,
    roles: Object.freeze(Array.from(mappedRoles)),
    groups: Object.freeze([...rawGroups]),
    ...(entraObjectId ? { entraObjectId } : {}),
    ...(claims.tid?.trim() ? { entraTenantId: claims.tid.trim() } : {}),
    ...(Array.isArray(claims.amr) ? { amr: Object.freeze([...claims.amr]) } : {}),
    mfaVerified: isEntraMfaVerified(claims, {
      allowAcrsC1: Boolean(rbacConfig?.identityMapping?.allowAcrsC1AsMfa),
    }),
  });
}
