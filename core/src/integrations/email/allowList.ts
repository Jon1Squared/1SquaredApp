/**
 * Non-Live Outbound Email Recipient Allow-List Evaluator
 * (`core/src/integrations/email/allowList.ts`).
 *
 * Enforces ADR 0027 §6.2:
 * - In `ctx.environment === 'live'`, allow-listing is not enforced (`enforced: false`).
 * - In non-live environments (`'dev' | 'test' | 'training' | 'demo'`), ALL recipients
 *   across `to`, `cc`, and `bcc` must match `integrations.email.recipientAllowList`
 *   (exact `@domain` suffixes or exact lowercase addresses) or entries resolved from
 *   `integrations.email.recipientAllowListVaultRef` (checked via `assertTenantOwnsKeyVaultSecretRef`).
 * - Empty allow-list or unreadable Key Vault secret fails closed.
 */

import type {
  EmailAllowListEvaluation,
  EmailRecipientList,
  TenantContext,
  TenantEmailIntegrationConfig,
} from '../../api/index';
import { assertTenantOwnsKeyVaultSecretRef } from '../../tenancy/keyVaultSecrets';
import {
  DefaultAzureKeyVaultSecretReader,
  type KeyVaultSecretReader,
} from './keyVaultSecretReader';

export const EMAIL_ADDRESS_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function isValidEmailAddress(address: string): boolean {
  const trimmed = address.trim();
  return trimmed.length > 0 && !/[\r\n]/.test(address) && EMAIL_ADDRESS_PATTERN.test(trimmed);
}

export function collectNormalizedRecipients(
  recipients: EmailRecipientList,
): string[] {
  const combined = [
    ...(recipients.to ?? []),
    ...(recipients.cc ?? []),
    ...(recipients.bcc ?? []),
  ];
  const out: string[] = [];
  for (const raw of combined) {
    const normalized = raw.trim().toLowerCase();
    if (normalized) {
      out.push(normalized);
    }
  }
  return out;
}

export function parseVaultAllowListEntries(secretValue: string): string[] {
  const trimmed = secretValue.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean);
      }
    } catch {
      return [];
    }
  }
  return trimmed
    .split(/[\r\n,;]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function matchesAllowListRule(
  recipientAddress: string,
  rules: readonly string[],
): boolean {
  if (!EMAIL_ADDRESS_PATTERN.test(recipientAddress)) {
    return false;
  }
  const atIdx = recipientAddress.lastIndexOf('@');
  const recipientDomain = recipientAddress.slice(atIdx + 1);

  for (const rawRule of rules) {
    const rule = rawRule.trim().toLowerCase();
    if (!rule || rule === '*' || rule === '@*') {
      continue;
    }
    if (rule.startsWith('@')) {
      const ruleDomain = rule.slice(1);
      if (ruleDomain && recipientDomain === ruleDomain) {
        return true;
      }
      continue;
    }
    if (EMAIL_ADDRESS_PATTERN.test(rule) && recipientAddress === rule) {
      return true;
    }
  }
  return false;
}

export async function collectCombinedAllowListRules(
  ctx: TenantContext,
  config: {
    readonly recipientAllowList?: readonly string[];
    readonly recipientAllowListVaultRef?: string;
  },
  options?: { readonly secretReader?: KeyVaultSecretReader },
): Promise<
  | { readonly ok: true; readonly rules: readonly string[] }
  | { readonly ok: false; readonly reason: 'ALLOWLIST_VAULT_UNREADABLE' }
> {
  const staticEntries = (config.recipientAllowList ?? [])
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  const vaultEntries: string[] = [];
  if (config.recipientAllowListVaultRef) {
    assertTenantOwnsKeyVaultSecretRef(ctx, config.recipientAllowListVaultRef);
    const reader =
      options?.secretReader ?? new DefaultAzureKeyVaultSecretReader();
    try {
      const rawSecret = await reader.readSecret(
        ctx,
        config.recipientAllowListVaultRef,
      );
      vaultEntries.push(...parseVaultAllowListEntries(rawSecret));
    } catch {
      return {
        ok: false,
        reason: 'ALLOWLIST_VAULT_UNREADABLE',
      };
    }
  }

  return {
    ok: true,
    rules: [...staticEntries, ...vaultEntries],
  };
}

export async function evaluateEmailAllowList(
  ctx: TenantContext,
  email: TenantEmailIntegrationConfig,
  recipients: EmailRecipientList,
  options?: { readonly secretReader?: KeyVaultSecretReader },
): Promise<EmailAllowListEvaluation> {
  const allRecipients = collectNormalizedRecipients(recipients);
  if (allRecipients.length === 0) {
    return {
      enforced: ctx.environment !== 'live',
      allowed: false,
      allowedRecipients: [],
      blockedRecipients: [],
      reason: 'EMAIL_RECIPIENTS_EMPTY',
    };
  }

  for (const addr of allRecipients) {
    if (!EMAIL_ADDRESS_PATTERN.test(addr)) {
      return {
        enforced: true,
        allowed: false,
        allowedRecipients: allRecipients.filter((a) =>
          EMAIL_ADDRESS_PATTERN.test(a),
        ),
        blockedRecipients: allRecipients.filter(
          (a) => !EMAIL_ADDRESS_PATTERN.test(a),
        ),
        reason: 'EMAIL_ADDRESS_INVALID',
      };
    }
  }

  if (ctx.environment === 'live') {
    return {
      enforced: false,
      allowed: true,
      allowedRecipients: allRecipients,
      blockedRecipients: [],
    };
  }

  const rulesResult = await collectCombinedAllowListRules(ctx, email, options);
  if (!rulesResult.ok) {
    return {
      enforced: true,
      allowed: false,
      allowedRecipients: [],
      blockedRecipients: allRecipients,
      reason: 'EMAIL_ALLOWLIST_VAULT_UNREADABLE',
    };
  }

  const combinedRules = rulesResult.rules;
  if (combinedRules.length === 0) {
    return {
      enforced: true,
      allowed: false,
      allowedRecipients: [],
      blockedRecipients: allRecipients,
      reason: 'EMAIL_ALLOWLIST_EMPTY',
    };
  }

  const allowedRecipients: string[] = [];
  const blockedRecipients: string[] = [];
  for (const addr of allRecipients) {
    if (matchesAllowListRule(addr, combinedRules)) {
      allowedRecipients.push(addr);
    } else {
      blockedRecipients.push(addr);
    }
  }

  if (blockedRecipients.length > 0) {
    return {
      enforced: true,
      allowed: false,
      allowedRecipients,
      blockedRecipients,
      reason: 'EMAIL_ALLOWLIST_BLOCKED',
    };
  }

  return {
    enforced: true,
    allowed: true,
    allowedRecipients,
    blockedRecipients: [],
  };
}
