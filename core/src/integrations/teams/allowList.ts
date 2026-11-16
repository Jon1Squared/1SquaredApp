/**
 * Teams Activity Recipient Resolution & Non-Live Allow-List Gate
 * (`core/src/integrations/teams/allowList.ts`).
 *
 * Enforces ADR 0035 §3.1:
 * - Resolves recipient `entraObjectId` from `TenantPartyRepository` (`Person`).
 *   Recipients without a bound `entraObjectId` (or non-employee/merged records)
 *   drop safely with `{ outcome: 'dropped_unbound' }`.
 * - In all non-live environments (`dev`, `test`, `training`, `demo`), delivery
 *   is gated fail-closed against `integrations.teams.recipientAllowList` +
 *   `integrations.teams.recipientAllowListVaultRef`: empty allow-list blocks
 *   all Teams sends, and rules may match recipient person IDs (`P-xxxxxx`) or
 *   active verified emails / `@domain` suffixes from DB `person_emails`/`Person`.
 */

import type { TenantContext, TenantTeamsIntegrationConfig } from '../../api/index';
import {
  TenantPartyRepository,
  type TenantPersonRecord,
} from '../../tenancy/partyRepository';
import {
  collectCombinedAllowListRules,
  matchesAllowListRule,
} from '../email/allowList';
import type { KeyVaultSecretReader } from '../email/keyVaultSecretReader';

export type TeamsRecipientAllowListEvaluation =
  | {
      readonly allowed: true;
      readonly enforced: boolean;
      readonly entraObjectId: string;
      readonly person: TenantPersonRecord;
    }
  | {
      readonly allowed: false;
      readonly outcome: 'dropped_unbound';
      readonly reason: string;
    }
  | {
      readonly allowed: false;
      readonly outcome: 'dropped_not_allow_listed';
      readonly reason: string;
      readonly entraObjectId: string;
    };

export async function evaluateTeamsRecipientAllowList(
  ctx: TenantContext,
  teams: TenantTeamsIntegrationConfig,
  recipientPersonId: string,
  options?: {
    readonly partyRepository?: TenantPartyRepository;
    readonly secretReader?: KeyVaultSecretReader;
  },
): Promise<TeamsRecipientAllowListEvaluation> {
  const partyRepo = options?.partyRepository ?? new TenantPartyRepository();
  const cleanPersonId = recipientPersonId.trim();
  if (!cleanPersonId) {
    return {
      allowed: false,
      outcome: 'dropped_unbound',
      reason: 'TEAMS_RECIPIENT_ID_MISSING',
    };
  }

  const person = await partyRepo.getPersonById<TenantPersonRecord>(
    ctx,
    cleanPersonId,
  );
  const entraObjectId = person?.entraObjectId?.trim() ?? '';
  const employmentStatus =
    person?.employment && typeof person.employment === 'object'
      ? (person.employment as { readonly status?: unknown }).status
      : undefined;
  if (
    !person ||
    person.mergedIntoId ||
    !person.isEmployee ||
    employmentStatus === 'Leaver' ||
    !entraObjectId
  ) {
    return {
      allowed: false,
      outcome: 'dropped_unbound',
      reason: 'TEAMS_RECIPIENT_UNBOUND',
    };
  }

  if (ctx.environment === 'live') {
    return {
      allowed: true,
      enforced: false,
      entraObjectId,
      person,
    };
  }

  const rulesResult = await collectCombinedAllowListRules(ctx, teams, {
    secretReader: options?.secretReader,
  });
  if (!rulesResult.ok) {
    return {
      allowed: false,
      outcome: 'dropped_not_allow_listed',
      reason: 'TEAMS_ALLOWLIST_VAULT_UNREADABLE',
      entraObjectId,
    };
  }

  const combinedRules = rulesResult.rules;
  if (combinedRules.length === 0) {
    return {
      allowed: false,
      outcome: 'dropped_not_allow_listed',
      reason: 'TEAMS_ALLOWLIST_EMPTY',
      entraObjectId,
    };
  }

  const normalizedPersonId = cleanPersonId.toLowerCase();
  for (const rawRule of combinedRules) {
    const rule = rawRule.trim().toLowerCase();
    if (rule && rule !== '*' && rule !== '@*' && rule === normalizedPersonId) {
      return {
        allowed: true,
        enforced: true,
        entraObjectId,
        person,
      };
    }
  }

  const verifiedEmailSet = new Set<string>();
  const dbEmails = await partyRepo.listPersonEmails(ctx, cleanPersonId);
  for (const row of dbEmails) {
    if (row.active && row.emailLower.trim()) {
      verifiedEmailSet.add(row.emailLower.trim().toLowerCase());
    }
  }
  for (const entry of person.emails ?? []) {
    if (entry.active !== false && entry.address?.trim()) {
      verifiedEmailSet.add(entry.address.trim().toLowerCase());
    }
  }

  for (const addr of verifiedEmailSet) {
    if (matchesAllowListRule(addr, combinedRules)) {
      return {
        allowed: true,
        enforced: true,
        entraObjectId,
        person,
      };
    }
  }

  return {
    allowed: false,
    outcome: 'dropped_not_allow_listed',
    reason: 'TEAMS_ALLOWLIST_BLOCKED',
    entraObjectId,
  };
}
