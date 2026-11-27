/**
 * Core communication domain helpers (`core/src/domain/communication/index.ts`, S1-06 / ADR 0042).
 *
 * Provides:
 * - Monotonic B2 engagement letter status ranking and regression detection.
 * - Safe core defaults & validation for `TenantConfiguration.chasing` and
 *   `TenantConfiguration.engagement`.
 * - Non-Engagement letter template rendering (ensuring `conflict` never exposes
 *   conflicting party or matter details).
 */

import {
  getEngagementStatusRank,
  type BankAccountDetailsConfig,
  type ChasingConfiguration,
  type ChasingRuleConfig,
  type CommunicationChaseEntityKind,
  type EngagementConfiguration,
  type MoneyOnAccountConfiguration,
  type MoneyOnAccountRequestWordingsConfig,
  type NonEngagementReasonKey,
  type NonEngagementReasonWordingConfig,
  type NonEngagementWordingMap,
  type PlatformEnvironment,
  type TenantConfiguration,
} from '../../api/index';
export { getEngagementStatusRank };

export const DEFAULT_CHASING_RULE_CONFIG: Readonly<ChasingRuleConfig> = Object.freeze({
  enabled: false,
  sendEmails: false,
  firstChaseDays: 7,
  secondChaseDays: 14,
  escalateTaskDays: 21,
});

export const DEFAULT_CHASING_CONFIGURATION: Readonly<ChasingConfiguration> = Object.freeze({
  engagementLetter: DEFAULT_CHASING_RULE_CONFIG,
  quote: DEFAULT_CHASING_RULE_CONFIG,
  moneyOnAccount: DEFAULT_CHASING_RULE_CONFIG,
});

export const DEFAULT_EMPTY_NON_ENGAGEMENT_REASON_WORDING: Readonly<NonEngagementReasonWordingConfig> =
  Object.freeze({
    subjectTemplate: '',
    bodyParagraphs: Object.freeze([]),
  });

export const DEFAULT_ENGAGEMENT_CONFIGURATION: Readonly<EngagementConfiguration> = Object.freeze({
  clientCareIntroductoryParagraph: '',
  clientCareTermsSummary: '',
  clientCareSignatureInstruction: '',
  nonEngagementWording: Object.freeze({
    conflict: DEFAULT_EMPTY_NON_ENGAGEMENT_REASON_WORDING,
    outside_expertise: DEFAULT_EMPTY_NON_ENGAGEMENT_REASON_WORDING,
    not_viable: DEFAULT_EMPTY_NON_ENGAGEMENT_REASON_WORDING,
    referred_out: DEFAULT_EMPTY_NON_ENGAGEMENT_REASON_WORDING,
    defaultFallback: DEFAULT_EMPTY_NON_ENGAGEMENT_REASON_WORDING,
  }),
});

export const DEFAULT_BANK_ACCOUNT_DETAILS_CONFIG: Readonly<BankAccountDetailsConfig> = Object.freeze({
  accountName: '',
  bankName: '',
  sortCode: '',
  accountNumber: '',
  iban: '',
  bic: '',
  allowDemoPlaceholderDetails: false,
});

export const DEFAULT_MONEY_ON_ACCOUNT_WORDINGS: Readonly<MoneyOnAccountRequestWordingsConfig> =
  Object.freeze({
    introductoryParagraph: '',
    bankTransferInstruction: '',
    clientMoneyComplianceNote: '',
  });

export const DEFAULT_MONEY_ON_ACCOUNT_CONFIGURATION: Readonly<MoneyOnAccountConfiguration> =
  Object.freeze({
    enabled: false,
    clientAccount: DEFAULT_BANK_ACCOUNT_DETAILS_CONFIG,
    requestEmailSubjectTemplate: '',
    requestWordings: DEFAULT_MONEY_ON_ACCOUNT_WORDINGS,
    paymentReferencePrefix: 'MOA',
  });

export function isPlaceholderClientBankDetails(
  clientAccount: Partial<BankAccountDetailsConfig> | null | undefined,
): boolean {
  if (!clientAccount) return false;
  const sortDigits = (clientAccount.sortCode ?? '').replace(/[^0-9]/g, '');
  const accountDigits = (clientAccount.accountNumber ?? '').replace(/[^0-9]/g, '');
  const ibanUpper = (clientAccount.iban ?? '').replace(/\s+/g, '').toUpperCase();
  const accountNameUpper = (clientAccount.accountName ?? '').toUpperCase();
  const bankNameUpper = (clientAccount.bankName ?? '').toUpperCase();
  return (
    Boolean(clientAccount.allowDemoPlaceholderDetails) ||
    sortDigits === '000000' ||
    accountDigits === '00000000' ||
    ibanUpper.startsWith('GB00DEMO') ||
    accountNameUpper.includes('DEMO ONLY') ||
    bankNameUpper.includes('FICTIONAL DEMO')
  );
}

export function assertMoneyOnAccountSafeForEnvironment(
  config: MoneyOnAccountConfiguration,
  environment: PlatformEnvironment,
): void {
  if (environment === 'live' && isPlaceholderClientBankDetails(config.clientAccount)) {
    throw new Error(
      'MOA_LIVE_PLACEHOLDER_BANK_DETAILS_FORBIDDEN: Demo placeholder client account bank details cannot be used in a live environment.',
    );
  }
}

export function resolveMoneyOnAccountConfiguration(
  config?: Pick<TenantConfiguration, 'moneyOnAccount'> | null,
  override?: Partial<MoneyOnAccountConfiguration> | null,
): MoneyOnAccountConfiguration {
  const moneyOnAccount = config?.moneyOnAccount;
  const clientAccountOverride = override?.clientAccount;
  const clientAccountSource = moneyOnAccount?.clientAccount;
  const wordingsOverride = override?.requestWordings;
  const wordingsSource = moneyOnAccount?.requestWordings;

  const clientAccount: BankAccountDetailsConfig = {
    accountName:
      clientAccountOverride?.accountName ?? clientAccountSource?.accountName ?? '',
    bankName:
      clientAccountOverride?.bankName ?? clientAccountSource?.bankName ?? '',
    sortCode:
      clientAccountOverride?.sortCode ?? clientAccountSource?.sortCode ?? '',
    accountNumber:
      clientAccountOverride?.accountNumber ?? clientAccountSource?.accountNumber ?? '',
    iban: clientAccountOverride?.iban ?? clientAccountSource?.iban ?? '',
    bic: clientAccountOverride?.bic ?? clientAccountSource?.bic ?? '',
    allowDemoPlaceholderDetails:
      typeof clientAccountOverride?.allowDemoPlaceholderDetails === 'boolean'
        ? clientAccountOverride.allowDemoPlaceholderDetails
        : typeof clientAccountSource?.allowDemoPlaceholderDetails === 'boolean'
          ? clientAccountSource.allowDemoPlaceholderDetails
          : false,
  };

  const requestWordings: MoneyOnAccountRequestWordingsConfig = {
    introductoryParagraph:
      wordingsOverride?.introductoryParagraph ??
      wordingsSource?.introductoryParagraph ??
      '',
    bankTransferInstruction:
      wordingsOverride?.bankTransferInstruction ??
      wordingsSource?.bankTransferInstruction ??
      '',
    clientMoneyComplianceNote:
      wordingsOverride?.clientMoneyComplianceNote ??
      wordingsSource?.clientMoneyComplianceNote ??
      '',
  };

  const rawPrefix =
    override?.paymentReferencePrefix ??
    moneyOnAccount?.paymentReferencePrefix ??
    'MOA';
  const cleanedPrefix = rawPrefix.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

  return {
    enabled:
      typeof override?.enabled === 'boolean'
        ? override.enabled
        : typeof moneyOnAccount?.enabled === 'boolean'
          ? moneyOnAccount.enabled
          : false,
    clientAccount,
    requestEmailSubjectTemplate:
      override?.requestEmailSubjectTemplate ??
      moneyOnAccount?.requestEmailSubjectTemplate ??
      '',
    requestWordings,
    paymentReferencePrefix:
      cleanedPrefix.length >= 2 && cleanedPrefix.length <= 6
        ? cleanedPrefix
        : 'MOA',
  };
}

export function isEngagementStatusRegression(
  previousStatus: string | null | undefined,
  nextStatus: string | null | undefined,
): boolean {
  return getEngagementStatusRank(nextStatus) < getEngagementStatusRank(previousStatus);
}

export function isEngagementLetterSentStatus(status: string | null | undefined): boolean {
  return getEngagementStatusRank(status) >= 2;
}

export function isEngagementLetterSignedStatus(status: string | null | undefined): boolean {
  return getEngagementStatusRank(status) >= 3;
}

function normalizeChasingRule(
  raw: {
    enabled?: boolean;
    sendEmails?: boolean;
    firstChaseDays?: number;
    secondChaseDays?: number;
    escalateTaskDays?: number;
  } | null | undefined,
): ChasingRuleConfig {
  const firstChaseDays =
    typeof raw?.firstChaseDays === 'number' && Number.isInteger(raw.firstChaseDays)
      ? raw.firstChaseDays
      : DEFAULT_CHASING_RULE_CONFIG.firstChaseDays;
  const secondChaseDays =
    typeof raw?.secondChaseDays === 'number' && Number.isInteger(raw.secondChaseDays)
      ? raw.secondChaseDays
      : DEFAULT_CHASING_RULE_CONFIG.secondChaseDays;
  const escalateTaskDays =
    typeof raw?.escalateTaskDays === 'number' && Number.isInteger(raw.escalateTaskDays)
      ? raw.escalateTaskDays
      : DEFAULT_CHASING_RULE_CONFIG.escalateTaskDays;

  return {
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : DEFAULT_CHASING_RULE_CONFIG.enabled,
    sendEmails:
      typeof raw?.sendEmails === 'boolean'
        ? raw.sendEmails
        : DEFAULT_CHASING_RULE_CONFIG.sendEmails,
    firstChaseDays,
    secondChaseDays,
    escalateTaskDays,
  };
}

/**
 * Resolves the tenant's full chasing configuration with safe core defaults
 * (`enabled: false`, `sendEmails: false`, `7 / 14 / 21` days) via `normalizeChasingRule`.
 */
export function resolveChasingConfiguration(
  config?: Pick<TenantConfiguration, 'chasing'> | null,
): ChasingConfiguration {
  return {
    engagementLetter: normalizeChasingRule(config?.chasing?.engagementLetter),
    quote: normalizeChasingRule(config?.chasing?.quote),
    moneyOnAccount: normalizeChasingRule(config?.chasing?.moneyOnAccount),
  };
}

export function resolveChasingScheduleForKind(
  config: Pick<TenantConfiguration, 'chasing'> | null | undefined,
  entityKind: CommunicationChaseEntityKind,
): ChasingRuleConfig {
  const resolved = resolveChasingConfiguration(config);
  if (entityKind === 'engagement_letter') {
    return resolved.engagementLetter;
  }
  if (entityKind === 'quote') {
    return resolved.quote;
  }
  return resolved.moneyOnAccount;
}

export function resolveEngagementConfiguration(
  config?: Pick<TenantConfiguration, 'engagement'> | null,
): EngagementConfiguration {
  const engagement = config?.engagement;
  const wording = engagement?.nonEngagementWording;
  const conflict = wording?.conflict;
  const outside_expertise = wording?.outside_expertise;
  const not_viable = wording?.not_viable;
  const referred_out = wording?.referred_out;
  const defaultFallback = wording?.defaultFallback;

  const sanitizeParagraphs = (raw: readonly string[] | undefined): string[] =>
    Array.isArray(raw) ? raw.map((p) => String(p ?? '')) : [];

  const nonEngagementWording: NonEngagementWordingMap = {
    conflict: {
      subjectTemplate:
        typeof conflict?.subjectTemplate === 'string' ? conflict.subjectTemplate : '',
      bodyParagraphs: sanitizeParagraphs(conflict?.bodyParagraphs),
    },
    outside_expertise: {
      subjectTemplate:
        typeof outside_expertise?.subjectTemplate === 'string'
          ? outside_expertise.subjectTemplate
          : '',
      bodyParagraphs: sanitizeParagraphs(outside_expertise?.bodyParagraphs),
    },
    not_viable: {
      subjectTemplate:
        typeof not_viable?.subjectTemplate === 'string'
          ? not_viable.subjectTemplate
          : '',
      bodyParagraphs: sanitizeParagraphs(not_viable?.bodyParagraphs),
    },
    referred_out: {
      subjectTemplate:
        typeof referred_out?.subjectTemplate === 'string'
          ? referred_out.subjectTemplate
          : '',
      bodyParagraphs: sanitizeParagraphs(referred_out?.bodyParagraphs),
    },
    defaultFallback: {
      subjectTemplate:
        typeof defaultFallback?.subjectTemplate === 'string'
          ? defaultFallback.subjectTemplate
          : '',
      bodyParagraphs: sanitizeParagraphs(defaultFallback?.bodyParagraphs),
    },
  };

  return {
    clientCareIntroductoryParagraph:
      typeof engagement?.clientCareIntroductoryParagraph === 'string'
        ? engagement.clientCareIntroductoryParagraph
        : '',
    clientCareTermsSummary:
      typeof engagement?.clientCareTermsSummary === 'string'
        ? engagement.clientCareTermsSummary
        : '',
    clientCareSignatureInstruction:
      typeof engagement?.clientCareSignatureInstruction === 'string'
        ? engagement.clientCareSignatureInstruction
        : '',
    nonEngagementWording,
  };
}

export function validateChasingRuleSchedule(
  rule: Partial<ChasingRuleConfig>,
  label = 'chasing',
): { ok: true; value: ChasingRuleConfig } | { ok: false; error: string } {
  const normalized = normalizeChasingRule(rule);
  if (!Number.isInteger(normalized.firstChaseDays) || normalized.firstChaseDays < 1 || normalized.firstChaseDays > 90) {
    return { ok: false, error: `${label}.firstChaseDays must be an integer between 1 and 90.` };
  }
  if (!Number.isInteger(normalized.secondChaseDays) || normalized.secondChaseDays < 2 || normalized.secondChaseDays > 180) {
    return { ok: false, error: `${label}.secondChaseDays must be an integer between 2 and 180.` };
  }
  if (!Number.isInteger(normalized.escalateTaskDays) || normalized.escalateTaskDays < 3 || normalized.escalateTaskDays > 365) {
    return { ok: false, error: `${label}.escalateTaskDays must be an integer between 3 and 365.` };
  }
  if (normalized.firstChaseDays >= normalized.secondChaseDays) {
    return {
      ok: false,
      error: `${label}.secondChaseDays (${normalized.secondChaseDays}) must be strictly greater than firstChaseDays (${normalized.firstChaseDays}).`,
    };
  }
  if (normalized.secondChaseDays >= normalized.escalateTaskDays) {
    return {
      ok: false,
      error: `${label}.escalateTaskDays (${normalized.escalateTaskDays}) must be strictly greater than secondChaseDays (${normalized.secondChaseDays}).`,
    };
  }
  return { ok: true, value: normalized };
}

export function mapCloseReasonSystemKeyToNonEngagementKey(
  closeReasonSystemKey: string | null | undefined,
): NonEngagementReasonKey {
  const normalized = (closeReasonSystemKey ?? '').trim().toLowerCase();
  if (normalized === 'conflict') return 'conflict';
  if (normalized === 'outside_expertise') return 'outside_expertise';
  if (normalized === 'not_viable') return 'not_viable';
  if (normalized === 'referred_out') return 'referred_out';
  return 'defaultFallback';
}

function applyTemplateTokens(
  template: string,
  tokens: {
    readonly recipientName: string;
    readonly enquiryReference: string;
    readonly matterAreaLabel: string;
    readonly feeEarnerOrSenderName: string;
    readonly firmName: string;
  },
): string {
  return template
    .replace(/\{\{\s*recipientName\s*\}\}/g, tokens.recipientName)
    .replace(/\{\{\s*enquiryReference\s*\}\}/g, tokens.enquiryReference)
    .replace(/\{\{\s*matterAreaLabel\s*\}\}/g, tokens.matterAreaLabel)
    .replace(/\{\{\s*feeEarnerOrSenderName\s*\}\}/g, tokens.feeEarnerOrSenderName)
    .replace(/\{\{\s*firmName\s*\}\}/g, tokens.firmName);
}

/**
 * Renders the Non-Engagement letter subject & body paragraphs from tenant configuration.
 * Notice `conflict` wording intentionally ignores matter/conflicting party notes so
 * confidential third-party details can never be disclosed in a conflict decline letter.
 */
export function renderNonEngagementLetterContent(params: {
  readonly config?: Pick<TenantConfiguration, 'engagement' | 'displayName'> | null;
  readonly closeReasonSystemKey?: string | null;
  readonly recipientName?: string | null;
  readonly enquiryReference: string;
  readonly matterAreaLabel?: string | null;
  readonly feeEarnerOrSenderName?: string | null;
}): {
  readonly reasonKey: NonEngagementReasonKey;
  readonly subject: string;
  readonly paragraphs: readonly string[];
} {
  const resolved = resolveEngagementConfiguration(params.config);
  const firmName = params.config?.displayName?.trim() || 'the firm';
  const reasonKey = mapCloseReasonSystemKeyToNonEngagementKey(params.closeReasonSystemKey);
  const variant = resolved.nonEngagementWording[reasonKey];
  const fallbackVariant = resolved.nonEngagementWording.defaultFallback;

  const recipientName = params.recipientName?.trim() || 'Client';
  const enquiryReference = params.enquiryReference.trim() || 'Enquiry';
  const matterAreaLabel =
    reasonKey === 'conflict'
      ? 'your enquiry'
      : params.matterAreaLabel?.trim() || 'your enquiry';
  const feeEarnerOrSenderName = params.feeEarnerOrSenderName?.trim() || firmName;

  const tokenValues = {
    recipientName,
    enquiryReference,
    matterAreaLabel,
    feeEarnerOrSenderName,
    firmName,
  };

  const chosenSubjectTemplate =
    variant.subjectTemplate.trim() ||
    fallbackVariant.subjectTemplate.trim() ||
    `Your enquiry (${enquiryReference}) — Confirmation of non-engagement`;

  const chosenParagraphTemplates =
    variant.bodyParagraphs.length > 0
      ? variant.bodyParagraphs
      : fallbackVariant.bodyParagraphs.length > 0
        ? fallbackVariant.bodyParagraphs
        : reasonKey === 'conflict'
          ? [
              `Dear ${recipientName},`,
              `Thank you for contacting ${firmName} regarding your enquiry (Ref: ${enquiryReference}).`,
              `Having carried out our regulatory conflict and compliance checks, we regret that professional obligations prevent ${firmName} from accepting your instructions on this matter. For reasons of client confidentiality, we are unable to provide further details regarding the nature of the restriction.`,
              `Because we have not accepted instructions, no solicitor-client relationship exists between you and ${firmName}, and we have not reviewed the merits or any limitation deadlines affecting your matter. You should seek alternative independent legal advice without delay, particularly if your matter may be subject to statutory time limits.`,
              'Yours sincerely,',
              `${feeEarnerOrSenderName} — ${firmName}`,
            ]
          : [
              `Dear ${recipientName},`,
              `Thank you for contacting ${firmName} (Ref: ${enquiryReference}). We write to confirm that ${firmName} is unable to accept instructions or act for you in connection with this enquiry, and our file has been closed.`,
              `No solicitor-client relationship exists between us and we have not advised on or recorded any limitation periods or deadlines. If you still require legal advice, please seek alternative independent legal representation without delay.`,
              'Yours sincerely,',
              `${feeEarnerOrSenderName} — ${firmName}`,
            ];

  return {
    reasonKey,
    subject: applyTemplateTokens(chosenSubjectTemplate, tokenValues),
    paragraphs: chosenParagraphTemplates.map((p) => applyTemplateTokens(p, tokenValues)),
  };
}
