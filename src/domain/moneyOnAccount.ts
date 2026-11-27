import {
  assertMoneyOnAccountSafeForEnvironment,
  formatMinorUnitsGbp,
  isPlaceholderClientBankDetails,
  MAX_EMAIL_TOTAL_ATTACHMENT_BYTES,
  poundsToMinorUnits,
  resolveMoneyOnAccountConfiguration,
  sumMinorUnits,
  type BankAccountDetailsConfig,
  type DocumentPdfConverter,
  type MinorUnits,
  type MoneyOnAccountConfiguration,
  type MoneyOnAccountReceiptRecord,
  type MoneyOnAccountRequestRecord,
  type MoneyOnAccountRequestWordingsConfig,
  type PlatformEnvironment,
  type TenantConfiguration,
} from '@platform/core';
import { buildValidDocxArchive } from './documentGeneration';
import type { Matter, MatterCostsSnapshot, Quote } from './types';

function toSafePositiveMinorUnits(value: unknown): MinorUnits | null {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0 || num < 1e-6) return null;
  const raw = String(num);
  return poundsToMinorUnits(/[eE]/.test(raw) ? num.toFixed(4) : raw);
}

/**
 * Validates that a date string is an exact `YYYY-MM-DD` calendar date (rejecting
 * impossible dates such as `2026-02-30` or non-date strings).
 */
export function isValidCalendarYmd(value: string | null | undefined): boolean {
  const raw = (value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const [y, m, d] = raw.split('-').map(Number);
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/**
 * Resolves the effective firm Money on Account configuration by layering any
 * per-tenant `tenant_module_configs['money_on_account']` override onto validated
 * `TenantConfiguration.moneyOnAccount` defaults.
 */
export function resolveEffectiveMoneyOnAccountConfig(
  tenantConfig: Pick<TenantConfiguration, 'moneyOnAccount'> | null | undefined,
  override?: Partial<MoneyOnAccountConfiguration> | null,
): MoneyOnAccountConfiguration {
  const moneyOnAccount = tenantConfig?.moneyOnAccount;
  const clientAccount = moneyOnAccount?.clientAccount;
  const requestWordings = moneyOnAccount?.requestWordings;
  const normalizedBase: Partial<MoneyOnAccountConfiguration> | undefined =
    moneyOnAccount
      ? {
          enabled: moneyOnAccount.enabled,
          clientAccount: clientAccount
            ? ({
                accountName: clientAccount.accountName,
                bankName: clientAccount.bankName,
                sortCode: clientAccount.sortCode,
                accountNumber: clientAccount.accountNumber,
                iban: clientAccount.iban,
                bic: clientAccount.bic,
                allowDemoPlaceholderDetails:
                  clientAccount.allowDemoPlaceholderDetails,
              } satisfies BankAccountDetailsConfig)
            : undefined,
          requestEmailSubjectTemplate:
            moneyOnAccount.requestEmailSubjectTemplate,
          requestWordings: requestWordings
            ? ({
                introductoryParagraph: requestWordings.introductoryParagraph,
                bankTransferInstruction:
                  requestWordings.bankTransferInstruction,
                clientMoneyComplianceNote:
                  requestWordings.clientMoneyComplianceNote,
              } satisfies MoneyOnAccountRequestWordingsConfig)
            : undefined,
          paymentReferencePrefix: moneyOnAccount.paymentReferencePrefix,
        }
      : undefined;

  return resolveMoneyOnAccountConfiguration(
    normalizedBase
      ? { moneyOnAccount: normalizedBase as MoneyOnAccountConfiguration }
      : undefined,
    override,
  );
}

export function areClientBankDetailsConfigured(
  config: Pick<MoneyOnAccountConfiguration, 'enabled' | 'clientAccount'>,
): boolean {
  if (!config.enabled) return false;
  const ca = config.clientAccount;
  return Boolean(
    ca.accountName?.trim() &&
      ca.bankName?.trim() &&
      ca.sortCode?.trim() &&
      ca.accountNumber?.trim(),
  );
}

export function assertBankDetailsSafeForEnvironment(
  config: MoneyOnAccountConfiguration,
  environment: PlatformEnvironment,
): void {
  if (!areClientBankDetailsConfigured(config)) {
    throw new Error(
      'MOA_NOT_CONFIGURED: Client account bank details must be configured and enabled before sending Money on Account requests.',
    );
  }
  assertMoneyOnAccountSafeForEnvironment(config, environment);
}

function fnv1aHash32(input: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function buildCompactMatterToken(
  matterId: string,
  cleanMatterNo: string,
  maxTokenLen: number,
): string {
  const mSeq = /^M-0*(\d+)$/i.exec(matterId.trim());
  if (mSeq) {
    const encoded = `M${BigInt(mSeq[1]!).toString(36).toUpperCase()}`;
    if (encoded.length <= maxTokenLen) {
      return encoded;
    }
  }
  const h1 = fnv1aHash32(`${matterId}|${cleanMatterNo}`, 0x811c9dc5).toString(36).toUpperCase();
  const h2 = fnv1aHash32(`${cleanMatterNo}|${matterId}`, 0x9e3779b1).toString(36).toUpperCase();
  const combined = `${h1}${h2}`.replace(/[^A-Z0-9]/g, '');
  if (combined.length >= maxTokenLen) {
    return combined.slice(0, maxTokenLen);
  }
  return combined.padStart(maxTokenLen, '0');
}

/**
 * Generates a UK Faster Payments / CHAPS-compatible payment reference:
 * `<PREFIX>-<MATTER_TOKEN_MAX10>-<NN>` strictly <= 18 uppercase ASCII chars with zero PII.
 *
 * When a formatted matter number fits cleanly inside `maxTokenLen`, it is preserved verbatim.
 * Otherwise (`R866`), or when `useMatterIdToken` is requested to resolve a collision, a full-entropy
 * base-36 matter identifier / dual-hash token is used rather than truncating `matterNumber`.
 */
export function buildMoneyOnAccountPaymentReference(params: {
  readonly prefix?: string | null;
  readonly matterNumber?: string | null;
  readonly matterId: string;
  readonly sequenceNumber: number;
  readonly useMatterIdToken?: boolean;
}): string {
  const cleanedPrefix = (params.prefix ?? 'MOA')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const prefix =
    cleanedPrefix.length >= 2 && cleanedPrefix.length <= 6
      ? cleanedPrefix
      : 'MOA';
  const seq =
    Number.isInteger(params.sequenceNumber) && params.sequenceNumber >= 1
      ? params.sequenceNumber
      : 1;
  const seqStr = String(seq).padStart(2, '0');
  const maxTokenLen = Math.max(1, Math.min(10, 18 - (prefix.length + 2 + seqStr.length)));

  const trimmedMatterNo = (params.matterNumber ?? '').trim();
  const useMatterNo =
    Boolean(trimmedMatterNo) && !/^DRAFT/i.test(trimmedMatterNo);
  const cleanMatterNo = useMatterNo
    ? trimmedMatterNo.toUpperCase().replace(/[^A-Z0-9]/g, '')
    : '';
  const cleanMatterIdToken = params.matterId
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const preferredToken = cleanMatterNo || cleanMatterIdToken || 'MATTER';

  let matterToken: string;
  if (
    !params.useMatterIdToken &&
    preferredToken.length >= 1 &&
    preferredToken.length <= maxTokenLen
  ) {
    matterToken = preferredToken;
  } else {
    matterToken = buildCompactMatterToken(
      params.matterId,
      preferredToken,
      maxTokenLen,
    );
  }

  return `${prefix}-${matterToken}-${seqStr}`;
}

export interface MoneyOnAccountDisplaySummary {
  readonly enabled: boolean;
  readonly bankConfigured: boolean;
  readonly paymentReferencePrefix: string;
  readonly accountName: string;
  readonly bankName: string;
  readonly maskedSortCode: string;
  readonly maskedAccountNumber: string;
  readonly maskedIban: string | null;
  readonly bic: string | null;
  readonly allowDemoPlaceholderDetails: boolean;
}

/**
 * Builds a browser-safe summary of the tenant's Money on Account configuration (`R864`).
 * Sort code, account number, and IBAN are always masked to their last 2 characters on the server.
 */
export function buildMoneyOnAccountDisplaySummary(
  config: MoneyOnAccountConfiguration,
): MoneyOnAccountDisplaySummary {
  const ca = config.clientAccount;
  return {
    enabled: config.enabled,
    bankConfigured: areClientBankDetailsConfigured(config),
    paymentReferencePrefix: config.paymentReferencePrefix,
    accountName: ca.accountName,
    bankName: ca.bankName,
    maskedSortCode: maskBankDetailForAudit(ca.sortCode, 'sortCode'),
    maskedAccountNumber: maskBankDetailForAudit(ca.accountNumber, 'accountNumber'),
    maskedIban: ca.iban?.trim() ? maskBankDetailForAudit(ca.iban, 'iban') : null,
    bic: ca.bic?.trim() || null,
    allowDemoPlaceholderDetails: ca.allowDemoPlaceholderDetails,
  };
}

/**
 * Masks sensitive bank snapshot fields on a request DTO before passing it to client components (`R864`).
 */
export function maskMoneyOnAccountRequestForDisplay(
  req: MoneyOnAccountRequestRecord,
): MoneyOnAccountRequestRecord {
  const snap = req.bankDetailsSnapshot;
  return {
    ...req,
    bankDetailsSnapshot: {
      ...snap,
      sortCode: maskBankDetailForAudit(snap.sortCode, 'sortCode'),
      accountNumber: maskBankDetailForAudit(snap.accountNumber, 'accountNumber'),
      iban: snap.iban?.trim() ? maskBankDetailForAudit(snap.iban, 'iban') : '',
    },
  };
}

/**
 * Masks sensitive bank details so only the last 2 characters are visible (`R824`).
 * Never leaves the full sort code, account number, or IBAN in audit entries.
 */
export function maskBankDetailForAudit(
  value: string | null | undefined,
  kind: 'sortCode' | 'accountNumber' | 'iban',
): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return '(empty)';
  if (kind === 'sortCode') {
    const alnumCount = trimmed.replace(/[^A-Za-z0-9]/g, '').length;
    if (alnumCount <= 2) {
      return trimmed.replace(/[A-Za-z0-9]/g, '*');
    }
    let seen = 0;
    const chars = Array.from(trimmed);
    for (let i = chars.length - 1; i >= 0; i -= 1) {
      if (/[A-Za-z0-9]/.test(chars[i]!)) {
        seen += 1;
        if (seen > 2) {
          chars[i] = '*';
        }
      }
    }
    return chars.join('');
  }
  const compact = trimmed.replace(/\s+/g, '');
  if (compact.length <= 2) {
    return '*'.repeat(compact.length);
  }
  return `${'*'.repeat(compact.length - 2)}${compact.slice(-2)}`;
}

export function formatMaskedMoaConfigAuditSummary(
  config: MoneyOnAccountConfiguration,
): string {
  const ca = config.clientAccount;
  const sortMasked = maskBankDetailForAudit(ca.sortCode, 'sortCode');
  const acctMasked = maskBankDetailForAudit(ca.accountNumber, 'accountNumber');
  const ibanMasked = ca.iban?.trim()
    ? maskBankDetailForAudit(ca.iban, 'iban')
    : '(none)';
  const placeholderFlag = isPlaceholderClientBankDetails(ca)
    ? 'placeholder=true'
    : 'placeholder=false';
  return `enabled=${config.enabled}; prefix=${config.paymentReferencePrefix}; sortCode=${sortMasked}; accountNumber=${acctMasked}; iban=${ibanMasked}; ${placeholderFlag}`;
}

/**
 * Resolves the agreed Payment on Account amount (integer pence) for a matter:
 * matterCosts snapshot -> matter retainer (pence/GBP) -> converted source quote POA.
 */
export function resolveMatterAgreedPaymentOnAccountPence(params: {
  readonly matter: Pick<
    Matter,
    'fieldValues' | 'retainerMoniesOnAccountGbp' | 'retainerMoniesOnAccountPence'
  >;
  readonly sourceQuote?: Pick<
    Quote,
    'paymentOnAccountRequired' | 'paymentOnAccountPence' | 'paymentOnAccountGbp'
  > | null;
}): MinorUnits | null {
  const { matter, sourceQuote } = params;
  const costsSnapshot = (matter.fieldValues?.['matterCosts'] ??
    matter.fieldValues?.['matterCostsSnapshot']) as
    | Partial<MatterCostsSnapshot>
    | undefined;

  if (costsSnapshot?.paymentOnAccountRequired === 'Yes') {
    const fromSnapshot = toSafePositiveMinorUnits(
      costsSnapshot.paymentOnAccountAmountGbp,
    );
    if (fromSnapshot !== null) return fromSnapshot;
  }

  if (
    typeof matter.retainerMoniesOnAccountPence === 'number' &&
    Number.isSafeInteger(matter.retainerMoniesOnAccountPence) &&
    matter.retainerMoniesOnAccountPence > 0
  ) {
    return matter.retainerMoniesOnAccountPence;
  }

  const fromRetainerGbp = toSafePositiveMinorUnits(
    matter.retainerMoniesOnAccountGbp,
  );
  if (fromRetainerGbp !== null) return fromRetainerGbp;

  if (
    costsSnapshot?.paymentOnAccountRequired !== 'No' &&
    sourceQuote &&
    sourceQuote.paymentOnAccountRequired !== false
  ) {
    if (
      typeof sourceQuote.paymentOnAccountPence === 'number' &&
      Number.isSafeInteger(sourceQuote.paymentOnAccountPence) &&
      sourceQuote.paymentOnAccountPence > 0
    ) {
      return sourceQuote.paymentOnAccountPence;
    }
    const fromQuoteGbp = toSafePositiveMinorUnits(
      sourceQuote.paymentOnAccountGbp,
    );
    if (fromQuoteGbp !== null) return fromQuoteGbp;
  }

  return null;
}

export interface MatterFundsOnAccountGateEvaluation {
  readonly fundsOnAccountSatisfied: boolean;
  readonly requestedPence: MinorUnits;
  readonly receivedPence: MinorUnits;
  readonly agreedAmountPence: MinorUnits | null;
  readonly outstandingPence: MinorUnits;
  readonly activeRequestCount: number;
  readonly openRequestCount: number;
  readonly statusSummary: string;
}

/**
 * Canonical `funds_on_account` opening gate evaluator (`ADR 0043 §5`, `R822` / Q8):
 * 1. At least one request in `('requested', 'part_received', 'received')`.
 * 2. Every non-cancelled, non-draft request has `status === 'received'` AND
 *    unreversed receipts summing at least its `requestedAmountPence > 0`.
 * 3. Where `agreedAmountPence > 0`, total unreversed receipts across all
 *    non-cancelled, non-draft requests >= `agreedAmountPence`.
 */
export function evaluateMatterFundsOnAccountGate(params: {
  readonly requests: readonly Pick<
    MoneyOnAccountRequestRecord,
    'id' | 'status' | 'requestedAmountPence'
  >[];
  readonly receipts: readonly Pick<
    MoneyOnAccountReceiptRecord,
    'requestId' | 'amountPence' | 'reversedAt'
  >[];
  readonly agreedAmountPence: MinorUnits | null;
}): MatterFundsOnAccountGateEvaluation {
  const activeRequests = params.requests.filter(
    (r) => r.status !== 'cancelled' && r.status !== 'draft',
  );
  const activeIds = new Set(activeRequests.map((r) => r.id));

  const receivedByRequestId = new Map<string, MinorUnits>();
  const activeReceipts: MinorUnits[] = [];
  for (const rcpt of params.receipts) {
    if (rcpt.reversedAt && rcpt.reversedAt.trim()) continue;
    if (!activeIds.has(rcpt.requestId)) continue;
    if (!Number.isSafeInteger(rcpt.amountPence) || rcpt.amountPence <= 0) {
      continue;
    }
    activeReceipts.push(rcpt.amountPence);
    receivedByRequestId.set(
      rcpt.requestId,
      sumMinorUnits([
        receivedByRequestId.get(rcpt.requestId) ?? 0,
        rcpt.amountPence,
      ]),
    );
  }

  const requestedPence = sumMinorUnits(
    activeRequests.map((r) =>
      Number.isSafeInteger(r.requestedAmountPence) && r.requestedAmountPence > 0
        ? r.requestedAmountPence
        : 0,
    ),
  );
  const receivedPence = sumMinorUnits(activeReceipts);
  const agreedAmountPence =
    typeof params.agreedAmountPence === 'number' &&
    Number.isSafeInteger(params.agreedAmountPence) &&
    params.agreedAmountPence > 0
      ? params.agreedAmountPence
      : null;

  let openRequestCount = 0;
  for (const req of activeRequests) {
    const reqReceived = receivedByRequestId.get(req.id) ?? 0;
    const settled =
      req.status === 'received' &&
      req.requestedAmountPence > 0 &&
      reqReceived >= req.requestedAmountPence;
    if (!settled) {
      openRequestCount += 1;
    }
  }

  const hasActiveRequest = activeRequests.length > 0;
  const allActiveReceived = hasActiveRequest && openRequestCount === 0;
  const meetsAgreedAmount =
    agreedAmountPence === null || receivedPence >= agreedAmountPence;
  const fundsOnAccountSatisfied =
    hasActiveRequest && allActiveReceived && meetsAgreedAmount;

  const targetPence = Math.max(agreedAmountPence ?? 0, requestedPence);
  const outstandingPence = Math.max(0, targetPence - receivedPence);

  let statusSummary: string;
  if (!hasActiveRequest) {
    statusSummary =
      agreedAmountPence !== null
        ? `No request sent yet (${formatMinorUnitsGbp(agreedAmountPence)} agreed)`
        : 'No payment on account request sent yet';
  } else if (fundsOnAccountSatisfied) {
    statusSummary = `Cleared funds received (${formatMinorUnitsGbp(receivedPence)})`;
  } else if (
    allActiveReceived &&
    agreedAmountPence !== null &&
    receivedPence < agreedAmountPence
  ) {
    statusSummary = `Requested ${formatMinorUnitsGbp(requestedPence)} / Received ${formatMinorUnitsGbp(receivedPence)} (${formatMinorUnitsGbp(agreedAmountPence)} agreed)`;
  } else {
    statusSummary = `Requested ${formatMinorUnitsGbp(requestedPence)} / Received ${formatMinorUnitsGbp(receivedPence)}`;
  }

  return {
    fundsOnAccountSatisfied,
    requestedPence,
    receivedPence,
    agreedAmountPence,
    outstandingPence,
    activeRequestCount: activeRequests.length,
    openRequestCount,
    statusSummary,
  };
}

function applyMoaTemplateTokens(
  template: string,
  tokens: {
    readonly paymentReference: string;
    readonly matterTitle: string;
    readonly matterReference: string;
    readonly requestedAmountFormatted: string;
    readonly recipientName: string;
    readonly firmName: string;
  },
): string {
  return template
    .replace(/\{\{\s*paymentReference\s*\}\}/g, tokens.paymentReference)
    .replace(/\{\{\s*matterTitle\s*\}\}/g, tokens.matterTitle)
    .replace(/\{\{\s*matterReference\s*\}\}/g, tokens.matterReference)
    .replace(
      /\{\{\s*requestedAmountFormatted\s*\}\}/g,
      tokens.requestedAmountFormatted,
    )
    .replace(/\{\{\s*recipientName\s*\}\}/g, tokens.recipientName)
    .replace(/\{\{\s*firmName\s*\}\}/g, tokens.firmName);
}

export interface RenderedMoneyOnAccountRequestContent {
  readonly subject: string;
  readonly introParagraph: string;
  readonly bankTransferInstruction: string;
  readonly clientMoneyComplianceNote: string;
  readonly requestedAmountFormatted: string;
}

export function renderMoneyOnAccountRequestContent(params: {
  readonly config: MoneyOnAccountConfiguration;
  readonly paymentReference: string;
  readonly matterTitle: string;
  readonly matterReference: string;
  readonly requestedAmountPence: MinorUnits;
  readonly recipientName: string;
  readonly firmName: string;
}): RenderedMoneyOnAccountRequestContent {
  const requestedAmountFormatted = formatMinorUnitsGbp(
    params.requestedAmountPence,
  );
  const tokens = {
    paymentReference: params.paymentReference,
    matterTitle: params.matterTitle.trim() || params.matterReference,
    matterReference: params.matterReference,
    requestedAmountFormatted,
    recipientName: params.recipientName.trim() || 'Client',
    firmName: params.firmName.trim() || 'Law Firm',
  };

  const wordings = params.config.requestWordings;
  const rawSubject =
    params.config.requestEmailSubjectTemplate.trim() ||
    'Payment on account request ({{paymentReference}}) — {{matterTitle}}';
  const rawIntro =
    wordings.introductoryParagraph.trim() ||
    'To enable us to begin work and cover initial anticipated fees or disbursements on your matter, we require a payment on account of {{requestedAmountFormatted}} to be held in our client account.';
  const rawTransfer =
    wordings.bankTransferInstruction.trim() ||
    'Please transfer {{requestedAmountFormatted}} by Faster Payments or CHAPS quoting the exact payment reference {{paymentReference}}.';
  const rawCompliance =
    wordings.clientMoneyComplianceNote.trim() ||
    'Funds must come from a bank account in your own name. For security, please telephone your fee earner using our verified published number if you wish to verify bank details before transferring funds.';

  return {
    subject: applyMoaTemplateTokens(rawSubject, tokens)
      .replace(/[\r\n]+/g, ' ')
      .trim(),
    introParagraph: applyMoaTemplateTokens(rawIntro, tokens),
    bankTransferInstruction: applyMoaTemplateTokens(rawTransfer, tokens),
    clientMoneyComplianceNote: applyMoaTemplateTokens(rawCompliance, tokens),
    requestedAmountFormatted,
  };
}

export interface BuildMoneyOnAccountPdfInput {
  readonly firmName: string;
  readonly regulatorName?: string | null;
  readonly regulatorNumber?: string | null;
  readonly contactEmail?: string | null;
  readonly matterReference: string;
  readonly matterTitle: string;
  readonly clientName: string;
  readonly recipientName: string;
  readonly feeEarnerName: string;
  readonly paymentReference: string;
  readonly requestedAmountPence: MinorUnits;
  readonly config: MoneyOnAccountConfiguration;
  readonly notes?: string | null;
}

/**
 * Generates an OpenXML `.docx` Payment on Account Request statement ready for
 * pre-TX PDF conversion. Never reads or includes CDD/AML outcomes (`R812`).
 */
export function buildMoneyOnAccountRequestDocxBytes(
  input: BuildMoneyOnAccountPdfInput,
): Uint8Array {
  const firmName = input.firmName.trim() || 'Law Firm';
  const rendered = renderMoneyOnAccountRequestContent({
    config: input.config,
    paymentReference: input.paymentReference,
    matterTitle: input.matterTitle,
    matterReference: input.matterReference,
    requestedAmountPence: input.requestedAmountPence,
    recipientName: input.recipientName,
    firmName,
  });
  const ca = input.config.clientAccount;

  const regulatorFooter =
    input.regulatorName && input.regulatorNumber
      ? `${firmName} | Authorised and regulated by ${input.regulatorName} (${input.regulatorNumber})`
      : input.contactEmail
        ? `${firmName} | ${input.contactEmail}`
        : firmName;

  const paragraphs: Array<{
    text: string;
    heading?: 'Heading1' | 'Heading2';
    bold?: boolean;
  }> = [
    { text: firmName, heading: 'Heading1', bold: true },
    {
      text: `Payment on Account Request — ${input.paymentReference}`,
      heading: 'Heading2',
      bold: true,
    },
    { text: `Dear ${input.recipientName.trim() || 'Client'},` },
    { text: rendered.introParagraph },
    { text: `Matter: ${input.matterTitle} (${input.matterReference})` },
    { text: `Client: ${input.clientName}` },
    { text: `Amount requested: ${rendered.requestedAmountFormatted}`, bold: true },
    {
      text: `Required payment reference: ${input.paymentReference}`,
      bold: true,
    },
    { text: rendered.bankTransferInstruction },
  ];

  if (input.notes?.trim()) {
    paragraphs.push({ text: `Additional note: ${input.notes.trim()}` });
  }

  paragraphs.push(
    { text: 'Important client money notice', heading: 'Heading2', bold: true },
    { text: rendered.clientMoneyComplianceNote },
    { text: `Issued by: ${input.feeEarnerName} on behalf of ${firmName}` },
  );

  const bankRows: string[][] = [
    ['Account name', ca.accountName],
    ['Bank name', ca.bankName],
    ['Sort code', ca.sortCode],
    ['Account number', ca.accountNumber],
    ...(ca.iban?.trim() ? [['IBAN', ca.iban.trim()]] : []),
    ...(ca.bic?.trim() ? [['BIC / SWIFT', ca.bic.trim()]] : []),
    ['Payment reference (required)', input.paymentReference],
    ['Amount due (GBP)', rendered.requestedAmountFormatted],
  ];

  return buildValidDocxArchive({
    headerText: `${firmName} | Payment on Account ${input.paymentReference}`,
    footerText: regulatorFooter,
    paragraphs,
    tables: [
      {
        headers: ['Client account detail', 'Value'],
        rows: bankRows,
      },
    ],
  });
}

export async function renderMoneyOnAccountRequestPdfBytes(params: {
  readonly docxInput: BuildMoneyOnAccountPdfInput;
  readonly converter: DocumentPdfConverter;
  readonly tenantId: string;
  readonly correlationId: string;
}): Promise<
  | { readonly ok: true; readonly pdfBytes: Uint8Array; readonly fileName: string }
  | {
      readonly ok: false;
      readonly code: 'EMAIL_ATTACHMENT_SIZE_LIMIT_EXCEEDED';
      readonly error: string;
    }
> {
  const docxBytes = buildMoneyOnAccountRequestDocxBytes(params.docxInput);
  const safeRef = params.docxInput.paymentReference.replace(
    /[^A-Za-z0-9._-]+/g,
    '-',
  );
  const fileName = `Payment-on-Account-${safeRef}.pdf`;
  const pdfBytes = await params.converter.convertDocxToPdf({
    docxBytes,
    title: `Payment on Account Request — ${params.docxInput.paymentReference}`,
    authorName: params.docxInput.feeEarnerName || params.docxInput.firmName,
    tenantId: params.tenantId,
    correlationId: params.correlationId,
  });

  if (pdfBytes.byteLength > MAX_EMAIL_TOTAL_ATTACHMENT_BYTES) {
    return {
      ok: false,
      code: 'EMAIL_ATTACHMENT_SIZE_LIMIT_EXCEEDED',
      error:
        'The generated payment request PDF exceeds the 3 MB email attachment limit.',
    };
  }

  return { ok: true, pdfBytes, fileName };
}
