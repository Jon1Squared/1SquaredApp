/**
 * Phase 1 Document Assembly Engine for 1Squared.
 *
 * Supports:
 * 1. Automatic data dictionary / merge context extraction from Matter, Client (Person/Organisation),
 *    Instructing Contact, Quote, Enquiry, and Employee records.
 * 2. Conditional paragraph & clause inclusion/removal based on questionnaire answers
 *    (e.g. Fixed Fee vs Hourly Rate, Payment on Account section, ID Verification status & Enclosures,
 *    Exclusions clause, Partner Supervision structure, Organisation acceptance row).
 * 3. Pure-TypeScript Microsoft Word (.docx) OpenXML generator (zero external dependencies)
 *    and PDF (.pdf) generator.
 */

import { resolveLabel } from './lists';
import { generatePdfBytesFromLines } from './matterOpeningRecord';
import { personDisplayName } from './names';
import type {
  ChoiceValue,
  Enquiry,
  Matter,
  MatterCostsSnapshot,
  Organisation,
  Person,
  Quote,
} from './types';

export type FeeBasisAssemblyMode = 'fixed' | 'hourly';
export type IdVerificationAssemblyMode = 'required' | 'already_verified' | 'omit';

export interface ClientCareLetterAnswers {
  templateId: 'client_care_letter_v1';
  firmName: string;
  // References & Date
  ourRef: string;
  includeYourRef: boolean;
  yourRef: string;
  letterDate: string; // e.g. "28 October 2026"
  // Recipient & Delivery
  recipientName: string;
  includeOrganisation: boolean;
  organisationName: string;
  addressLine1: string;
  townOrCity: string;
  postcode: string;
  sendByEmail: boolean;
  recipientEmail: string;
  salutationName: string;
  // Matter & Instructions
  matterDescription: string;
  summaryOfInstructions: string;
  listOfTasks: string;
  includeExclusions: boolean;
  exclusions: string;
  // Conduct & Supervision
  feeEarnerName: string;
  feeEarnerPosition: string;
  isSupervisedByPartner: boolean;
  supervisingPartnerName: string;
  // Fees & Conditional Clauses
  feeBasisMode: FeeBasisAssemblyMode;
  fixedFeeAmount: string;
  partnerRate: string;
  associateRate: string;
  traineeRate: string;
  estimateAmount: string;
  includeDisbursements: boolean;
  disbursementsAmount: string;
  // Payment on account (Conditional Section)
  requirePaymentOnAccount: boolean;
  paymentOnAccountAmount: string;
  // Identification (Conditional Section & Enclosures sync)
  idVerificationMode: IdVerificationAssemblyMode;
  // Complaints
  complaintsPartnerName: string;
  // Sign-off
  authorName: string;
  authorPosition: string;
  authorDirectLine: string;
  authorEmail: string;
  // Client Acceptance Table
  clientName: string;
  includeForAndOnBehalfOf: boolean;
}

export interface SavedAssembledDocument {
  id: string;
  templateId: 'client_care_letter_v1';
  templateName: string;
  fileName: string;
  version: number;
  createdAt: string;
  createdById: string;
  createdByName: string;
  answers: ClientCareLetterAnswers;
}

export interface AssembledSection {
  id: string;
  heading?: string;
  paragraphs: string[];
  /** Indicates this section or paragraph was dynamically controlled by a questionnaire condition. */
  conditionTag?: string;
}

export interface AssembledClientCareDocument {
  ourRef: string;
  yourRef: string | null;
  letterDate: string;
  recipientLines: string[];
  byEmailLine: string | null;
  salutation: string;
  subjectLine: string;
  openingParagraph: string;
  sections: AssembledSection[];
  signOff: {
    yoursSincerely: string;
    authorName: string;
    authorPositionAndFirm: string;
    contactLine: string;
    enclosuresLine: string;
  };
  acceptance: {
    heading: string;
    statement: string;
    rows: { label: string; value: string }[];
  };
}

function formatLongUkDate(dateInput?: string | Date | null): string {
  const d =
    dateInput instanceof Date
      ? dateInput
      : dateInput
        ? new Date(dateInput.length === 10 ? `${dateInput}T00:00:00` : dateInput)
        : new Date();
  if (Number.isNaN(d.getTime())) {
    return new Date().toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    });
  }
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

function formatMoneyClean(amount: number | string | null | undefined, fallback = ''): string {
  if (amount === null || amount === undefined || amount === '') return fallback;
  const num =
    typeof amount === 'number'
      ? amount
      : Number(String(amount).replace(/[^0-9.-]/g, ''));
  if (Number.isNaN(num) || num <= 0) return String(amount).trim() || fallback;
  return num % 1 === 0
    ? num.toLocaleString('en-GB')
    : num.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Extracts default questionnaire answers and placeholder values from a Matter and its linked records.
 */
export function buildDefaultClientCareAnswers(params: {
  matter: Matter;
  people: Person[];
  organisations: Organisation[];
  values: ChoiceValue[];
  quotes?: Quote[];
  enquiries?: Enquiry[];
  currentUserId?: string;
}): ClientCareLetterAnswers {
  const {
    matter,
    people,
    organisations,
    values,
    quotes = [],
    enquiries = [],
    currentUserId,
  } = params;

  const clientOrg = organisations.find((o) => o.id === matter.clientId) ?? null;
  const clientPerson = people.find((p) => p.id === matter.clientId) ?? null;
  const instructingPerson = matter.instructingContactId
    ? people.find((p) => p.id === matter.instructingContactId) ?? null
    : null;

  const sourceQuote = matter.sourceQuoteId
    ? quotes.find((q) => q.id === matter.sourceQuoteId) ?? null
    : quotes.find((q) => q.convertedMatterId === matter.id) ?? null;

  const sourceEnquiry = matter.sourceEnquiryId
    ? enquiries.find((e) => e.id === matter.sourceEnquiryId) ?? null
    : enquiries.find((e) => e.convertedMatterId === matter.id) ?? null;

  // Recipient resolution
  const primaryContactPerson = instructingPerson ?? clientPerson;
  const recipientName = primaryContactPerson
    ? personDisplayName(primaryContactPerson)
    : clientOrg?.legalName || '[Recipient name]';

  const isOrgClient = Boolean(clientOrg);
  const organisationName = clientOrg?.legalName ?? '';

  // Address resolution (prefer correspondence -> registered for Org, or primary address for Person)
  const primaryAddr =
    clientOrg?.correspondenceAddress ??
    clientOrg?.registeredAddress ??
    primaryContactPerson?.addresses?.[0] ??
    sourceEnquiry?.address ??
    null;

  const addressLine1 =
    [primaryAddr?.line1, primaryAddr?.line2].filter(Boolean).join(', ') || '[Address line 1]';
  const townOrCity = primaryAddr?.town || '[Town or city]';
  const postcode = primaryAddr?.postcode || '[Postcode]';

  // Email resolution
  const recipientEmail =
    primaryContactPerson?.emails?.find((e) => e.isPrimary)?.address ||
    primaryContactPerson?.emails?.[0]?.address ||
    clientOrg?.generalEmail ||
    sourceQuote?.prospectEmail ||
    sourceEnquiry?.email ||
    '';

  const salutationName = primaryContactPerson
    ? primaryContactPerson.preferredName?.trim() ||
      primaryContactPerson.firstName?.trim() ||
      personDisplayName(primaryContactPerson)
    : clientOrg
      ? 'Sirs'
      : '[Name]';

  // Client reference ("Your ref")
  const rawYourRef =
    String(matter.fieldValues?.['CORE-005'] ?? '').trim() ||
    clientOrg?.clientReference?.trim() ||
    '';

  // Fee earner & supervising partner
  const feeEarner =
    people.find((p) => p.id === matter.leadFeeEarnerId) ??
    people.find((p) => p.id === matter.responsiblePartnerId) ??
    people.find((p) => p.id === currentUserId) ??
    null;

  const supervisingPartner =
    people.find((p) => p.id === matter.supervisingPartnerId) ??
    people.find((p) => p.id === matter.responsiblePartnerId) ??
    null;

  const feeEarnerName = feeEarner ? personDisplayName(feeEarner) : '[Fee earner name]';
  const feeEarnerPosition =
    feeEarner?.employment?.jobTitle?.trim() ||
    feeEarner?.jobTitle?.split(',')[0]?.trim() ||
    'Solicitor';

  const supervisingPartnerName = supervisingPartner
    ? personDisplayName(supervisingPartner)
    : '[supervising partner]';

  const isSupervisedByPartner = Boolean(
    supervisingPartner && (!feeEarner || supervisingPartner.id !== feeEarner.id),
  );

  // Complaints partner (default to Risk & Compliance Partner Bethan Rees if in people list, else supervisingPartner)
  const bethan = people.find(
    (p) =>
      p.isEmployee &&
      `${p.firstName} ${p.surname}`.toLowerCase().includes('bethan rees'),
  );
  const complaintsPartnerName = bethan
    ? personDisplayName(bethan)
    : supervisingPartnerName !== '[supervising partner]'
      ? supervisingPartnerName
      : 'Bethan Rees';

  // Instructions, tasks & exclusions
  const subcatLabel = resolveLabel(values, matter.workTypeSubcategoryId);
  const practiceLabel = resolveLabel(values, matter.practiceAreaId);

  const summaryOfInstructions =
    matter.shortDescription?.trim() ||
    sourceQuote?.scope?.trim() ||
    sourceEnquiry?.summary?.trim() ||
    (subcatLabel
      ? `act for you in relation to ${matter.title} (${subcatLabel.toLowerCase()})`
      : `act for you in relation to ${matter.title}`);

  const listOfTasks =
    sourceQuote?.scope?.trim() ||
    `reviewing the background documentation, advising you on your legal position and options, drafting and negotiating the necessary documents, and managing the matter through to completion`;

  const exclusions =
    sourceQuote?.assumptions?.trim() ||
    `tax advice, financial or valuation advice, or advice on the laws of any jurisdiction outside England and Wales`;

  // Billing basis & rates (prefer Step 2 Matter Costs snapshot when saved on matter)
  const storedMatterCosts = matter.fieldValues?.['matterCosts'] as MatterCostsSnapshot | undefined;
  const billingBasisLabel = resolveLabel(values, matter.billingBasisId).toLowerCase();
  const quoteIsFixed = sourceQuote?.feeBasis === 'Fixed fee';
  const feeBasisMode: FeeBasisAssemblyMode =
    storedMatterCosts?.workBasis === 'fixed_fee'
      ? 'fixed'
      : storedMatterCosts?.workBasis === 'hourly_rates' || storedMatterCosts?.workBasis === 'capped'
        ? 'hourly'
        : quoteIsFixed || billingBasisLabel.includes('fixed')
          ? 'fixed'
          : 'hourly';

  const rawEstimateOrFee =
    storedMatterCosts?.totalEstimateGbp ||
    sourceQuote?.feeAmountExVat ||
    matter.agreedFeeCapGbp ||
    matter.feeEstimateGbp ||
    2500;

  const fixedFeeAmount = formatMoneyClean(rawEstimateOrFee, '2,500');
  const estimateAmount = formatMoneyClean(
    storedMatterCosts?.totalEstimateGbp || matter.feeEstimateGbp || sourceQuote?.feeAmountExVat || 3500,
    '3,500',
  );

  // Derive hourly rates from Step 2 Matter Costs snapshot, staff records, or sensible defaults
  const partnerRateNum =
    storedMatterCosts?.partnerRateGbp ||
    supervisingPartner?.employment?.feeEarner?.chargeOutRateGbp ||
    375;
  const associateRateNum =
    storedMatterCosts?.associateRateGbp ||
    (feeEarner?.employment?.feeEarner?.chargeOutRateGbp &&
    feeEarner.employment.feeEarner.chargeOutRateGbp < partnerRateNum
      ? feeEarner.employment.feeEarner.chargeOutRateGbp
      : 265);
  const traineeRateNum = storedMatterCosts?.traineeRateGbp || 150;

  const quoteDisbursementsTotal = sourceQuote?.disbursements?.reduce(
    (sum, d) => sum + (Number(d.amountExVat) || 0),
    0,
  );
  const effectiveDisbursementsTotal =
    storedMatterCosts?.disbursementsTotalGbp != null && storedMatterCosts.disbursementsTotalGbp > 0
      ? storedMatterCosts.disbursementsTotalGbp
      : quoteDisbursementsTotal && quoteDisbursementsTotal > 0
        ? quoteDisbursementsTotal
        : 250;
  const includeDisbursements =
    storedMatterCosts?.disbursements != null
      ? storedMatterCosts.disbursements.length > 0
      : true;
  const disbursementsAmount = formatMoneyClean(effectiveDisbursementsTotal, '250');

  // Payment on account
  const hasRetainer =
    (storedMatterCosts?.paymentOnAccountAmountGbp != null &&
      storedMatterCosts.paymentOnAccountAmountGbp > 0) ||
    (matter.retainerMoniesOnAccountGbp != null && matter.retainerMoniesOnAccountGbp > 0);
  const requirePaymentOnAccount =
    storedMatterCosts?.paymentOnAccountRequired === 'No'
      ? false
      : storedMatterCosts?.paymentOnAccountRequired === 'Yes'
        ? true
        : true;
  const paymentOnAccountAmount = formatMoneyClean(
    storedMatterCosts?.paymentOnAccountAmountGbp ||
      (hasRetainer ? matter.retainerMoniesOnAccountGbp : 1000),
    '1,000',
  );

  // Identification
  const amlComplete =
    matter.amlStatus?.toLowerCase() === 'complete' ||
    matter.amlStatus?.toLowerCase() === 'verified';
  const idVerificationMode: IdVerificationAssemblyMode = amlComplete
    ? 'already_verified'
    : 'required';

  // Author sign-off
  const authorName = feeEarnerName;
  const authorPosition = feeEarnerPosition;
  const authorDirectLine =
    feeEarner?.phones?.find((ph) => ph.active !== false)?.number ||
    feeEarner?.phones?.[0]?.number ||
    '029 2000 1000';
  const authorEmail =
    feeEarner?.employment?.systems?.firmWorkEmail ||
    feeEarner?.emails?.find((em) => em.isPrimary)?.address ||
    feeEarner?.emails?.[0]?.address ||
    'enquiries@notalawfirm.co.uk';

  const clientName =
    clientOrg?.legalName ||
    (clientPerson ? personDisplayName(clientPerson) : recipientName) ||
    '[Client name]';

  void practiceLabel;

  return {
    templateId: 'client_care_letter_v1',
    firmName: 'NotALawFirm LLP',
    ourRef:
      matter.matterNumber && matter.matterNumber !== 'DRAFT'
        ? matter.matterNumber
        : '[OUR REF]',
    includeYourRef: Boolean(rawYourRef),
    yourRef: rawYourRef || '[YOUR REF]',
    letterDate: formatLongUkDate(),
    recipientName,
    includeOrganisation: isOrgClient,
    organisationName: organisationName || '[Organisation]',
    addressLine1,
    townOrCity,
    postcode,
    sendByEmail: Boolean(recipientEmail),
    recipientEmail: recipientEmail || 'recipient@example.com',
    salutationName,
    matterDescription: matter.title || '[Matter description]',
    summaryOfInstructions,
    listOfTasks,
    includeExclusions: true,
    exclusions,
    feeEarnerName,
    feeEarnerPosition,
    isSupervisedByPartner,
    supervisingPartnerName,
    feeBasisMode,
    fixedFeeAmount,
    partnerRate: formatMoneyClean(partnerRateNum, '375'),
    associateRate: formatMoneyClean(associateRateNum, '265'),
    traineeRate: formatMoneyClean(traineeRateNum, '150'),
    estimateAmount,
    includeDisbursements,
    disbursementsAmount,
    requirePaymentOnAccount,
    paymentOnAccountAmount,
    idVerificationMode,
    complaintsPartnerName,
    authorName,
    authorPosition,
    authorDirectLine,
    authorEmail,
    clientName,
    includeForAndOnBehalfOf: isOrgClient,
  };
}

/**
 * Evaluates placeholders and conditional clauses to produce the assembled Client Care Letter.
 */
export function assembleClientCareLetter(
  answers: ClientCareLetterAnswers,
): AssembledClientCareDocument {
  const firm = answers.firmName.trim() || 'NotALawFirm LLP';

  const recipientLines: string[] = [];
  if (answers.recipientName.trim()) {
    recipientLines.push(answers.recipientName.trim());
  }
  if (answers.includeOrganisation && answers.organisationName.trim()) {
    recipientLines.push(answers.organisationName.trim());
  }
  if (answers.addressLine1.trim()) {
    recipientLines.push(answers.addressLine1.trim());
  }
  if (answers.townOrCity.trim()) {
    recipientLines.push(answers.townOrCity.trim());
  }
  if (answers.postcode.trim()) {
    recipientLines.push(answers.postcode.trim());
  }

  const byEmailLine =
    answers.sendByEmail && answers.recipientEmail.trim()
      ? `By email: ${answers.recipientEmail.trim()}`
      : null;

  const salutation = `Dear ${answers.salutationName.trim() || '[Name]'},`;
  const subjectLine = `Your matter: ${answers.matterDescription.trim() || '[Matter description]'}`;

  const openingParagraph = `Thank you for instructing ${firm}. This letter confirms the work we will do for you, who will be responsible for it and how our fees are calculated. It should be read together with our enclosed Terms of Business.`;

  const sections: AssembledSection[] = [];

  // 1. Your instructions (with conditional exclusions sentence)
  const instructionsBase = `You have asked us to ${answers.summaryOfInstructions.trim() || '[summary of instructions]'}. Our work will include ${answers.listOfTasks.trim() || '[list of tasks]'}.`;
  const instructionsParagraph =
    answers.includeExclusions && answers.exclusions.trim()
      ? `${instructionsBase} It will not include ${answers.exclusions.trim()}, unless we agree otherwise in writing.`
      : instructionsBase;

  sections.push({
    id: 'your_instructions',
    heading: 'Your instructions',
    paragraphs: [instructionsParagraph],
    conditionTag: answers.includeExclusions ? 'Includes exclusions clause' : 'Exclusions omitted',
  });

  // 2. Who will deal with your matter (conditional on whether supervised by another partner)
  const feeEarner = answers.feeEarnerName.trim() || '[Fee earner name]';
  const position = answers.feeEarnerPosition.trim() || '[position]';
  const supPartner = answers.supervisingPartnerName.trim() || '[supervising partner]';

  const conductParagraph = answers.isSupervisedByPartner
    ? `${feeEarner}, ${position}, will have day-to-day conduct of your matter, supervised by ${supPartner}, Partner. If you have any concerns, please contact ${supPartner} directly.`
    : `${feeEarner}, ${position}, will have overall and day-to-day conduct of your matter. If you have any concerns, please contact ${supPartner} directly.`;

  sections.push({
    id: 'who_will_deal',
    heading: 'Who will deal with your matter',
    paragraphs: [conductParagraph],
    conditionTag: answers.isSupervisedByPartner
      ? 'Supervised by Partner'
      : 'Direct Partner conduct',
  });

  // 3. Our fees (conditional branching: Fixed Fee vs Hourly Rate, plus Disbursements)
  let feesParagraph = '';
  if (answers.feeBasisMode === 'fixed') {
    const fixedAmt = answers.fixedFeeAmount.trim() || '[amount]';
    feesParagraph = `Our fixed fee for the work described above is £${fixedAmt} plus VAT.`;
    if (answers.includeDisbursements && answers.disbursementsAmount.trim()) {
      feesParagraph += ` We estimate disbursements of approximately £${answers.disbursementsAmount.trim()}. We will tell you promptly if this estimate is likely to be exceeded.`;
    }
  } else {
    const pRate = answers.partnerRate.trim() || '[rate]';
    const aRate = answers.associateRate.trim() || '[rate]';
    const tRate = answers.traineeRate.trim() || '[rate]';
    const estAmt = answers.estimateAmount.trim() || '[amount]';
    feesParagraph = `We charge by the hour. Current rates are: Partner £${pRate}, Associate £${aRate}, Trainee £${tRate}, plus VAT.`;
    if (answers.includeDisbursements && answers.disbursementsAmount.trim()) {
      feesParagraph += ` We estimate the total cost to be £${estAmt} plus VAT and disbursements of approximately £${answers.disbursementsAmount.trim()}. We will tell you promptly if this estimate is likely to be exceeded.`;
    } else {
      feesParagraph += ` We estimate the total cost to be £${estAmt} plus VAT. We will tell you promptly if this estimate is likely to be exceeded.`;
    }
  }

  sections.push({
    id: 'our_fees',
    heading: 'Our fees',
    paragraphs: [feesParagraph],
    conditionTag:
      answers.feeBasisMode === 'fixed' ? 'Fixed fee clause' : 'Hourly rates & estimate clause',
  });

  // 4. Payment on account (Conditional Section — added or removed based on requirePaymentOnAccount)
  if (answers.requirePaymentOnAccount) {
    const poaAmt = answers.paymentOnAccountAmount.trim() || '[amount]';
    sections.push({
      id: 'payment_on_account',
      heading: 'Payment on account',
      paragraphs: [
        `Please pay £${poaAmt} on account before we begin work. Our bank details are set out in our Terms of Business. We will never notify you of a change to our bank details by email; please call us to confirm before sending any money.`,
      ],
      conditionTag: 'Included (Payment on account required)',
    });
  }

  // 5. Identification (Conditional Section — changes or removes based on idVerificationMode)
  if (answers.idVerificationMode === 'required') {
    sections.push({
      id: 'identification',
      heading: 'Identification',
      paragraphs: [
        'We are required by law to verify your identity. Please provide the documents listed in the enclosed Client Identification Form.',
      ],
      conditionTag: 'ID verification required (Form enclosed)',
    });
  } else if (answers.idVerificationMode === 'already_verified') {
    sections.push({
      id: 'identification',
      heading: 'Identification',
      paragraphs: [
        'We are required by law to verify your identity. Thank you for already providing your identification documents, which we now hold on file.',
      ],
      conditionTag: 'ID already verified on file',
    });
  }

  // 6. Complaints
  const complaintsPartner = answers.complaintsPartnerName.trim() || '[complaints partner]';
  sections.push({
    id: 'complaints',
    heading: 'Complaints',
    paragraphs: [
      `We aim to provide an excellent service. If you are unhappy, please contact ${complaintsPartner} in the first instance. Our complaints procedure is set out in our Terms of Business. You may also be entitled to complain to the Legal Ombudsman.`,
    ],
  });

  // 7. Next steps
  sections.push({
    id: 'next_steps',
    heading: 'Next steps',
    paragraphs: [
      'Please sign and return the enclosed copy of this letter to confirm your instructions. If you have any questions, please do not hesitate to contact me.',
    ],
  });

  // Enclosures automatically adjust based on whether Client Identification Form is needed
  const enclosures = ['Terms of Business'];
  if (answers.idVerificationMode === 'required') {
    enclosures.push('Client Identification Form');
  }
  enclosures.push('Privacy Notice');

  // Client acceptance table rows
  const acceptanceRows: { label: string; value: string }[] = [
    { label: 'Signed by', value: '' },
    { label: 'Name', value: '' },
  ];
  if (answers.includeForAndOnBehalfOf) {
    acceptanceRows.push({
      label: 'For and on behalf of',
      value: answers.clientName.trim() || '[Client name]',
    });
  }
  acceptanceRows.push({ label: 'Date', value: '' });

  return {
    ourRef: answers.ourRef.trim() || '[OUR REF]',
    yourRef:
      answers.includeYourRef && answers.yourRef.trim() ? answers.yourRef.trim() : null,
    letterDate: answers.letterDate.trim() || '[DD Month YYYY]',
    recipientLines,
    byEmailLine,
    salutation,
    subjectLine,
    openingParagraph,
    sections,
    signOff: {
      yoursSincerely: 'Yours sincerely,',
      authorName: answers.authorName.trim() || '[Author name]',
      authorPositionAndFirm: `${answers.authorPosition.trim() || '[Position]'}, ${firm}`,
      contactLine: [answers.authorDirectLine.trim(), answers.authorEmail.trim()]
        .filter(Boolean)
        .join('  |  '),
      enclosuresLine: `Enc: ${enclosures.join('; ')}`,
    },
    acceptance: {
      heading: 'Client acceptance',
      statement:
        'I/We confirm that I/we have read and accept this letter and the Terms of Business.',
      rows: acceptanceRows,
    },
  };
}

// ============================================================================
// Pure-TypeScript OpenXML (.docx) Generator (ZIP + WordprocessingML)
// ============================================================================

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildWordParagraph(
  text: string,
  opts?: {
    bold?: boolean;
    sizeHalfPt?: number;
    spaceBeforeTwips?: number;
    spaceAfterTwips?: number;
    colorHex?: string;
    italic?: boolean;
  },
): string {
  const size = opts?.sizeHalfPt ?? 22; // 11pt default
  const before = opts?.spaceBeforeTwips ?? 0;
  const after = opts?.spaceAfterTwips ?? 120;
  const rPrParts: string[] = [
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>',
    `<w:sz w:val="${size}"/>`,
    `<w:szCs w:val="${size}"/>`,
  ];
  if (opts?.bold) rPrParts.push('<w:b/>');
  if (opts?.italic) rPrParts.push('<w:i/>');
  if (opts?.colorHex) rPrParts.push(`<w:color w:val="${opts.colorHex}"/>`);

  return `<w:p><w:pPr><w:spacing w:before="${before}" w:after="${after}" w:line="276" w:lineRule="auto"/></w:pPr><w:r><w:rPr>${rPrParts.join('')}</w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function buildRefRowParagraph(label: string, value: string, spaceAfterTwips = 40): string {
  return `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="1800"/></w:tabs><w:spacing w:before="0" w:after="${spaceAfterTwips}"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:b/><w:sz w:val="21"/></w:rPr><w:t xml:space="preserve">${escapeXml(label)}</w:t></w:r><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="21"/></w:rPr><w:tab/><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r></w:p>`;
}

function buildAcceptanceTableXml(rows: { label: string; value: string }[]): string {
  const rowXml = rows
    .map(
      (r) => `<w:tr>
      <w:trPr><w:trHeight w:val="460" w:hRule="atLeast"/></w:trPr>
      <w:tc>
        <w:tcPr><w:tcW w:w="3200" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F8FAFC"/><w:tcMar><w:top w:w="100" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:left w:w="140" w:type="dxa"/><w:right w:w="140" w:type="dxa"/></w:tcMar></w:tcPr>
        <w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:b/><w:sz w:val="21"/></w:rPr><w:t xml:space="preserve">${escapeXml(r.label)}</w:t></w:r></w:p>
      </w:tc>
      <w:tc>
        <w:tcPr><w:tcW w:w="6160" w:type="dxa"/><w:tcMar><w:top w:w="100" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:left w:w="140" w:type="dxa"/><w:right w:w="140" w:type="dxa"/></w:tcMar></w:tcPr>
        <w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="21"/></w:rPr><w:t xml:space="preserve">${escapeXml(r.value)}</w:t></w:r></w:p>
      </w:tc>
    </w:tr>`,
    )
    .join('');

  return `<w:tbl>
    <w:tblPr>
      <w:tblW w:w="9360" w:type="dxa"/>
      <w:tblBorders>
        <w:top w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
        <w:left w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
        <w:bottom w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
        <w:right w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
        <w:insideH w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
        <w:insideV w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
      </w:tblBorders>
    </w:tblPr>
    <w:tblGrid><w:gridCol w:w="3200"/><w:gridCol w:w="6160"/></w:tblGrid>
    ${rowXml}
  </w:tbl>`;
}

function buildDocumentXml(doc: AssembledClientCareDocument): string {
  const parts: string[] = [];

  // References & Date block
  parts.push(buildRefRowParagraph('Our ref', doc.ourRef, doc.yourRef ? 40 : 40));
  if (doc.yourRef) {
    parts.push(buildRefRowParagraph('Your ref', doc.yourRef, 40));
  }
  parts.push(buildRefRowParagraph('Date', doc.letterDate, 200));

  // Recipient Address block
  doc.recipientLines.forEach((line, idx) => {
    const isLast = idx === doc.recipientLines.length - 1;
    parts.push(
      buildWordParagraph(line, {
        spaceBeforeTwips: 0,
        spaceAfterTwips: isLast ? 160 : 20,
      }),
    );
  });

  // By email line
  if (doc.byEmailLine) {
    parts.push(
      buildWordParagraph(doc.byEmailLine, {
        bold: true,
        spaceBeforeTwips: 40,
        spaceAfterTwips: 180,
      }),
    );
  }

  // Salutation
  parts.push(
    buildWordParagraph(doc.salutation, {
      spaceBeforeTwips: 40,
      spaceAfterTwips: 160,
    }),
  );

  // Subject line
  parts.push(
    buildWordParagraph(doc.subjectLine, {
      bold: true,
      sizeHalfPt: 24,
      spaceBeforeTwips: 40,
      spaceAfterTwips: 160,
    }),
  );

  // Opening paragraph
  parts.push(
    buildWordParagraph(doc.openingParagraph, {
      spaceBeforeTwips: 0,
      spaceAfterTwips: 180,
    }),
  );

  // Sections
  for (const sec of doc.sections) {
    if (sec.heading) {
      parts.push(
        buildWordParagraph(sec.heading, {
          bold: true,
          sizeHalfPt: 23,
          colorHex: '0D5C54',
          spaceBeforeTwips: 180,
          spaceAfterTwips: 80,
        }),
      );
    }
    for (const para of sec.paragraphs) {
      parts.push(
        buildWordParagraph(para, {
          spaceBeforeTwips: 0,
          spaceAfterTwips: 140,
        }),
      );
    }
  }

  // Sign-off
  parts.push(
    buildWordParagraph(doc.signOff.yoursSincerely, {
      spaceBeforeTwips: 180,
      spaceAfterTwips: 360,
    }),
  );
  parts.push(
    buildWordParagraph(doc.signOff.authorName, {
      bold: true,
      spaceBeforeTwips: 0,
      spaceAfterTwips: 40,
    }),
  );
  parts.push(
    buildWordParagraph(doc.signOff.authorPositionAndFirm, {
      spaceBeforeTwips: 0,
      spaceAfterTwips: 40,
    }),
  );
  if (doc.signOff.contactLine) {
    parts.push(
      buildWordParagraph(doc.signOff.contactLine, {
        colorHex: '475569',
        sizeHalfPt: 20,
        spaceBeforeTwips: 0,
        spaceAfterTwips: 180,
      }),
    );
  }
  parts.push(
    buildWordParagraph(doc.signOff.enclosuresLine, {
      italic: true,
      sizeHalfPt: 20,
      spaceBeforeTwips: 60,
      spaceAfterTwips: 260,
    }),
  );

  // Client acceptance
  parts.push(
    buildWordParagraph(doc.acceptance.heading, {
      bold: true,
      sizeHalfPt: 23,
      colorHex: '0D5C54',
      spaceBeforeTwips: 160,
      spaceAfterTwips: 80,
    }),
  );
  parts.push(
    buildWordParagraph(doc.acceptance.statement, {
      spaceBeforeTwips: 0,
      spaceAfterTwips: 140,
    }),
  );
  parts.push(buildAcceptanceTableXml(doc.acceptance.rows));

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${parts.join('\n    ')}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1270" w:bottom="1440" w:left="1270" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

// Minimal CRC-32 & Store ZIP builder for .docx packages
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZipArchive(files: { name: string; content: string }[]): Uint8Array {
  const encoder = new TextEncoder();
  const entries = files.map((f) => {
    const nameBytes = encoder.encode(f.name);
    const dataBytes = encoder.encode(f.content);
    const crc = crc32(dataBytes);
    return { nameBytes, dataBytes, crc };
  });

  let localSize = 0;
  let centralSize = 0;
  for (const e of entries) {
    localSize += 30 + e.nameBytes.length + e.dataBytes.length;
    centralSize += 46 + e.nameBytes.length;
  }

  const totalSize = localSize + centralSize + 22;
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);

  let offset = 0;
  const localOffsets: number[] = [];

  for (const e of entries) {
    localOffsets.push(offset);
    view.setUint32(offset, 0x04034b50, true); // Local file header signature
    view.setUint16(offset + 4, 20, true); // Version needed
    view.setUint16(offset + 6, 0, true); // Flags
    view.setUint16(offset + 8, 0, true); // Compression method: 0 (Stored)
    view.setUint16(offset + 10, 0, true); // Mod time
    view.setUint16(offset + 12, 0, true); // Mod date
    view.setUint32(offset + 14, e.crc, true);
    view.setUint32(offset + 18, e.dataBytes.length, true);
    view.setUint32(offset + 22, e.dataBytes.length, true);
    view.setUint16(offset + 26, e.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true);
    out.set(e.nameBytes, offset + 30);
    out.set(e.dataBytes, offset + 30 + e.nameBytes.length);
    offset += 30 + e.nameBytes.length + e.dataBytes.length;
  }

  const centralDirOffset = offset;
  entries.forEach((e, idx) => {
    view.setUint32(offset, 0x02014b50, true); // Central directory signature
    view.setUint16(offset + 4, 20, true); // Version made by
    view.setUint16(offset + 6, 20, true); // Version needed
    view.setUint16(offset + 8, 0, true); // Flags
    view.setUint16(offset + 10, 0, true); // Compression: Stored
    view.setUint16(offset + 12, 0, true); // Mod time
    view.setUint16(offset + 14, 0, true); // Mod date
    view.setUint32(offset + 16, e.crc, true);
    view.setUint32(offset + 20, e.dataBytes.length, true);
    view.setUint32(offset + 24, e.dataBytes.length, true);
    view.setUint16(offset + 28, e.nameBytes.length, true);
    view.setUint16(offset + 30, 0, true); // Extra field length
    view.setUint16(offset + 32, 0, true); // File comment length
    view.setUint16(offset + 34, 0, true); // Disk number
    view.setUint16(offset + 36, 0, true); // Internal attrs
    view.setUint32(offset + 38, 0, true); // External attrs
    view.setUint32(offset + 42, localOffsets[idx], true);
    out.set(e.nameBytes, offset + 46);
    offset += 46 + e.nameBytes.length;
  });

  // End of central directory record
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, entries.length, true);
  view.setUint16(offset + 10, entries.length, true);
  view.setUint32(offset + 12, centralSize, true);
  view.setUint32(offset + 16, centralDirOffset, true);
  view.setUint16(offset + 20, 0, true);

  return out;
}

export function generateClientCareDocxBytes(doc: AssembledClientCareDocument): Uint8Array {
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const documentXml = buildDocumentXml(doc);

  return buildZipArchive([
    { name: '[Content_Types].xml', content: contentTypesXml },
    { name: '_rels/.rels', content: relsXml },
    { name: 'word/document.xml', content: documentXml },
  ]);
}

export function downloadClientCareDocx(
  doc: AssembledClientCareDocument,
  fileName?: string,
): void {
  if (typeof window === 'undefined') return;
  const bytes = generateClientCareDocxBytes(doc);
  const blob = new Blob([bytes.buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeRef = doc.ourRef.replace(/[^a-zA-Z0-9_-]/g, '-');
  a.href = url;
  a.download = fileName || `Client-Care-Letter-${safeRef}.docx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2500);
}

export function downloadClientCarePdf(
  doc: AssembledClientCareDocument,
  fileName?: string,
): void {
  if (typeof window === 'undefined') return;
  const lines: {
    text: string;
    bold?: boolean;
    size?: number;
    spacingBefore?: number;
    spacingAfter?: number;
    ruleBelow?: boolean;
  }[] = [];

  lines.push({ text: `Our ref:   ${doc.ourRef}`, bold: true, size: 10 });
  if (doc.yourRef) {
    lines.push({ text: `Your ref:  ${doc.yourRef}`, bold: true, size: 10 });
  }
  lines.push({ text: `Date:      ${doc.letterDate}`, bold: true, size: 10, spacingAfter: 8 });

  doc.recipientLines.forEach((line, idx) => {
    lines.push({
      text: line,
      size: 10,
      spacingAfter: idx === doc.recipientLines.length - 1 ? 6 : 1,
    });
  });

  if (doc.byEmailLine) {
    lines.push({ text: doc.byEmailLine, bold: true, size: 10, spacingAfter: 8 });
  }

  lines.push({ text: doc.salutation, size: 10, spacingAfter: 6 });
  lines.push({ text: doc.subjectLine, bold: true, size: 11, spacingAfter: 6 });
  lines.push({ text: doc.openingParagraph, size: 10, spacingAfter: 8 });

  for (const sec of doc.sections) {
    if (sec.heading) {
      lines.push({
        text: sec.heading,
        bold: true,
        size: 10.5,
        spacingBefore: 6,
        spacingAfter: 3,
      });
    }
    for (const para of sec.paragraphs) {
      lines.push({ text: para, size: 10, spacingAfter: 6 });
    }
  }

  lines.push({ text: doc.signOff.yoursSincerely, size: 10, spacingBefore: 8, spacingAfter: 16 });
  lines.push({ text: doc.signOff.authorName, bold: true, size: 10 });
  lines.push({ text: doc.signOff.authorPositionAndFirm, size: 10 });
  if (doc.signOff.contactLine) {
    lines.push({ text: doc.signOff.contactLine, size: 9.5, spacingAfter: 8 });
  }
  lines.push({ text: doc.signOff.enclosuresLine, size: 9.5, spacingAfter: 12, ruleBelow: true });

  lines.push({
    text: doc.acceptance.heading,
    bold: true,
    size: 10.5,
    spacingBefore: 6,
    spacingAfter: 3,
  });
  lines.push({ text: doc.acceptance.statement, size: 10, spacingAfter: 6 });
  for (const r of doc.acceptance.rows) {
    lines.push({
      text: `${r.label.padEnd(24, ' ')}: ${r.value || '____________________________________'}`,
      size: 10,
      spacingAfter: 4,
    });
  }

  const safeRef = doc.ourRef.replace(/[^a-zA-Z0-9_-]/g, '-');
  const bytes = generatePdfBytesFromLines(`Client Care Letter - ${doc.ourRef}`, lines);
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || `Client-Care-Letter-${safeRef}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2500);
}
