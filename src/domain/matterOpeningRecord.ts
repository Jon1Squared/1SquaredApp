import { formatDate, formatDateTime } from './dates';
import { resolveLabel } from './lists';
import { personDisplayName } from './names';
import type {
  ChoiceValue,
  ConflictCheckRecord,
  Enquiry,
  Matter,
  Organisation,
  Person,
  Quote,
} from './types';

export type RiskLevel = 'Low' | 'Medium' | 'High';

export interface RiskQuestionOption {
  label: string;
  risk: RiskLevel;
  triggersFollowUp?: boolean;
}

export interface RiskQuestionDef {
  id: string;
  question: string;
  amlOnly?: boolean;
  options: RiskQuestionOption[];
  followUpLabel?: string;
  followUpType?: 'text' | 'key_dates';
}

export interface RiskSectionDef {
  id: string;
  number: number;
  title: string;
  amlOnly?: boolean;
  questions: RiskQuestionDef[];
}

export interface CustomKeyDateEntry {
  id: string;
  label: string;
  date: string;
}

export const MATTER_RISK_SECTIONS: RiskSectionDef[] = [
  {
    id: 'about_instruction',
    number: 1,
    title: 'About this instruction',
    questions: [
      {
        id: 'inScopeMlr',
        question: 'Is this work in scope of the Money Laundering Regulations?',
        options: [
          { label: 'Yes, in scope', risk: 'Low' },
          { label: 'No, out of scope', risk: 'Low' },
        ],
      },
      {
        id: 'instructionMakesSense',
        question:
          'Does the instruction make sense for this client? Consider whether it fits what you know of their business and history.',
        options: [
          { label: 'Yes', risk: 'Low' },
          { label: 'Not sure', risk: 'Medium', triggersFollowUp: true },
          { label: 'No', risk: 'High', triggersFollowUp: true },
        ],
        followUpLabel: 'What doesn’t fit?',
      },
      {
        id: 'moveMoneyWithoutTransaction',
        question: 'Are we being asked to move money without an underlying legal transaction?',
        amlOnly: true,
        options: [
          { label: 'No', risk: 'Low' },
          { label: 'Yes', risk: 'High', triggersFollowUp: true },
        ],
        followUpLabel: 'Describe the request.',
      },
    ],
  },
  {
    id: 'client_relationship',
    number: 2,
    title: 'Client and relationship',
    questions: [
      {
        id: 'clientRelationshipStatus',
        question: 'Is this a new or existing client?',
        options: [
          { label: 'New client', risk: 'Medium' },
          { label: 'Existing, CDD current', risk: 'Low' },
          { label: 'Existing, CDD needs refresh', risk: 'Medium' },
        ],
      },
      {
        id: 'clientDealingMethod',
        question: 'How have you dealt with the client so far?',
        options: [
          { label: 'Met in person', risk: 'Low' },
          { label: 'Video call with ID check', risk: 'Low' },
          { label: 'Remote only or via introducer', risk: 'Medium' },
        ],
      },
      {
        id: 'complexOwnershipStructure',
        question: 'Is the ownership structure complex or opaque?',
        options: [
          { label: 'No', risk: 'Low' },
          { label: 'Yes, with a clear reason', risk: 'Medium', triggersFollowUp: true },
          { label: 'Yes, reason unclear', risk: 'High', triggersFollowUp: true },
        ],
        followUpLabel: 'Explain the structure and its purpose.',
      },
      {
        id: 'thirdPartyInstructions',
        question: 'Is anyone other than the client giving instructions?',
        options: [
          { label: 'No', risk: 'Low' },
          { label: 'Yes', risk: 'Medium', triggersFollowUp: true },
        ],
        followUpLabel: 'Who, and how have you confirmed their authority?',
      },
    ],
  },
  {
    id: 'geography',
    number: 3,
    title: 'Geography',
    questions: [
      {
        id: 'highRiskJurisdictionLink',
        question:
          'Any link to a high-risk third country or sanctioned jurisdiction? Covers the client, other parties, assets or funds.',
        options: [
          { label: 'No', risk: 'Low' },
          { label: 'Yes', risk: 'High', triggersFollowUp: true },
        ],
        followUpLabel: 'Which country, and what is the link?',
      },
      {
        id: 'crossBorderFundsOrAssets',
        question: 'Will funds or assets move across borders?',
        amlOnly: true,
        options: [
          { label: 'No', risk: 'Low' },
          { label: 'Yes', risk: 'Medium', triggersFollowUp: true },
        ],
        followUpLabel: 'From where to where?',
      },
    ],
  },
  {
    id: 'funds_payments',
    number: 4,
    title: 'Funds and payments',
    amlOnly: true,
    questions: [
      {
        id: 'holdClientMoney',
        question: 'Will we hold client money?',
        options: [
          { label: 'No', risk: 'Low' },
          { label: 'Yes, below firm threshold', risk: 'Low' },
          { label: 'Yes, above firm threshold', risk: 'Medium' },
        ],
      },
      {
        id: 'matterFundingSource',
        question: 'Who is funding the matter?',
        options: [
          { label: 'The client', risk: 'Low' },
          { label: 'A third party', risk: 'Medium', triggersFollowUp: true },
        ],
        followUpLabel: 'Who, their relationship to the client, and why?',
      },
      {
        id: 'sourceOfFundsUnderstood',
        question:
          'Is the source of funds understood and consistent with what you know of the client?',
        options: [
          { label: 'Yes', risk: 'Low' },
          { label: 'Not yet', risk: 'Medium', triggersFollowUp: true },
          { label: 'No', risk: 'High', triggersFollowUp: true },
        ],
        followUpLabel: 'What is outstanding or inconsistent?',
      },
      {
        id: 'unusualPaymentRequests',
        question:
          'Any unusual payment requests? For example cash, unexplained urgency, or payments to or from unconnected accounts.',
        options: [
          { label: 'No', risk: 'Low' },
          { label: 'Yes', risk: 'High', triggersFollowUp: true },
        ],
        followUpLabel: 'Describe the request.',
      },
    ],
  },
  {
    id: 'delivery_resourcing',
    number: 5,
    title: 'Delivery and resourcing',
    questions: [
      {
        id: 'regularTeamWork',
        question: 'Is this work the team regularly does?',
        options: [
          { label: 'Yes', risk: 'Low' },
          { label: 'Occasionally', risk: 'Medium', triggersFollowUp: true },
          { label: 'No', risk: 'High', triggersFollowUp: true },
        ],
        followUpLabel: 'How will you cover the gap?',
      },
      {
        id: 'capacityAndSupervision',
        question: 'Is there capacity and supervision in place?',
        options: [
          { label: 'Yes', risk: 'Low' },
          { label: 'No', risk: 'Medium', triggersFollowUp: true },
        ],
        followUpLabel: 'What is missing?',
      },
      {
        id: 'imminentDeadlines',
        question: 'Any imminent deadlines, limitation or court dates?',
        options: [
          { label: 'No', risk: 'Low' },
          { label: 'Yes', risk: 'Medium', triggersFollowUp: true },
        ],
        followUpLabel: 'Add dates',
        followUpType: 'key_dates',
      },
    ],
  },
  {
    id: 'fees_liability',
    number: 6,
    title: 'Fees and liability',
    questions: [
      {
        id: 'feeBasis',
        question: 'Fee basis',
        options: [
          { label: 'Fixed fee', risk: 'Low' },
          { label: 'Hourly', risk: 'Low' },
          { label: 'CFA or DBA', risk: 'Medium' },
          { label: 'Other', risk: 'Low' },
        ],
      },
      {
        id: 'moneyOnAccountRequested',
        question: 'Has money on account been requested?',
        options: [
          { label: 'Yes', risk: 'Low' },
          { label: 'No', risk: 'Medium', triggersFollowUp: true },
        ],
        followUpLabel: 'Why not?',
      },
      {
        id: 'valueOrExposure',
        question: 'Value or potential exposure at stake',
        options: [
          { label: 'Within normal range', risk: 'Low' },
          { label: 'Unusually high', risk: 'High', triggersFollowUp: true },
        ],
        followUpLabel: 'Approximate value and why it is high.',
      },
      {
        id: 'limitationOfLiabilityProposed',
        question: 'Is a limitation of liability proposed?',
        options: [
          { label: 'No', risk: 'Low' },
          { label: 'Yes', risk: 'Medium', triggersFollowUp: true },
        ],
        followUpLabel: 'Proposed cap and who agreed it.',
      },
    ],
  },
  {
    id: 'reputation_regulation_data',
    number: 7,
    title: 'Reputation, regulation and data',
    questions: [
      {
        id: 'reputationOrEthicalConcerns',
        question: 'Could acting harm the firm’s reputation or raise ethical concerns?',
        options: [
          { label: 'No', risk: 'Low' },
          { label: 'Yes', risk: 'High', triggersFollowUp: true },
        ],
        followUpLabel: 'Describe the concern.',
      },
      {
        id: 'sensitiveSectorOrMedia',
        question:
          'Is the client or matter in a sensitive sector, or attracting media attention?',
        options: [
          { label: 'No', risk: 'Low' },
          { label: 'Yes', risk: 'Medium', triggersFollowUp: true },
        ],
        followUpLabel: 'Which sector or coverage?',
      },
      {
        id: 'specialCategoryDataOrConfidentiality',
        question: 'Special category data or unusual confidentiality requirements?',
        options: [
          { label: 'No', risk: 'Low' },
          { label: 'Yes', risk: 'Medium', triggersFollowUp: true },
        ],
        followUpLabel: 'What data or requirements?',
      },
    ],
  },
];

export interface MatterRiskQuestionSnapshotItem {
  id: string;
  question: string;
  answer: string;
  risk: RiskLevel | null;
  followUpLabel?: string;
  followUp?: string;
}

export interface MatterRiskSectionSnapshotItem {
  id: string;
  number: number;
  title: string;
  sectionRisk: RiskLevel | null;
  completedCount: number;
  totalCount: number;
  questions: MatterRiskQuestionSnapshotItem[];
}

export interface MatterRiskAssessmentSnapshot {
  completedAt: string;
  completedById: string;
  completedByName: string;
  overallRisk: RiskLevel;
  completedQuestions: number;
  totalQuestions: number;
  isMlrInScope: boolean;
  answers: Record<string, string>;
  followUps: Record<string, string>;
  customKeyDates: CustomKeyDateEntry[];
  sections: MatterRiskSectionSnapshotItem[];
}

export interface MatterOpeningSnapshot {
  version: '1.0';
  capturedAt: string;
  capturedAtDisplay: string;
  capturedById: string;
  capturedByName: string;
  saveMode: 'draft' | 'submit_cleared' | 'submit_referred' | 'opened';
  matterId: string;
  matterNumber: string;
  title: string;
  shortDescription: string;
  sourceEnquiryReference?: string | null;
  sourceQuoteReference?: string | null;
  clients: {
    id: string;
    name: string;
    entityType: string;
    capacities: string[];
    details: string;
  }[];
  instructingContact?: {
    id: string;
    name: string;
    capacities: string[];
  } | null;
  billingContact?: {
    id: string;
    name: string;
  } | null;
  departmentLabel: string;
  workTypeLabel: string;
  responsiblePartnerName: string;
  supervisingPartnerName: string;
  leadFeeEarnerName: string;
  relationshipPartnerName: string;
  additionalTeamMembers: { name: string; role: string }[];
  billingAndFinancials: {
    billingBasis: string;
    feeEstimateGbp: string;
    agreedFeeCapGbp: string;
    retainerMoniesOnAccountGbp: string;
    clientReference: string;
    claimValue: string;
    responsibleOffice: string;
    sourceOfWork: string;
    targetCompletionAt: string;
    forumCourt: string;
  };
  complianceOnboarding: {
    amlStatus: string;
    sourceOfFundsVerified: string;
    engagementLetterStatus: string;
  };
  riskAssessment: MatterRiskAssessmentSnapshot;
  conflictCheckRecord: ConflictCheckRecord;
  declarationConfirmed: boolean;
  optionalFields: { id: string; label: string; value: string }[];
}

export function buildMatterRiskAssessmentSnapshot(params: {
  answers: Record<string, string>;
  followUps: Record<string, string>;
  customKeyDates?: CustomKeyDateEntry[];
  completedById: string;
  completedByName: string;
  completedAt?: string;
  fallbackOverallRisk?: RiskLevel;
}): MatterRiskAssessmentSnapshot {
  const {
    answers,
    followUps,
    customKeyDates = [],
    completedById,
    completedByName,
    completedAt = new Date().toISOString(),
    fallbackOverallRisk = 'Low',
  } = params;

  const isMlrInScope = answers.inScopeMlr !== 'No, out of scope';
  const visibleSections = MATTER_RISK_SECTIONS.filter(
    (sec) => !sec.amlOnly || isMlrInScope,
  );

  let totalQuestions = 0;
  let completedQuestions = 0;
  let highestRisk: RiskLevel | null = null;

  const elevateRisk = (current: RiskLevel | null, candidate: RiskLevel): RiskLevel => {
    if (current === 'High' || candidate === 'High') return 'High';
    if (current === 'Medium' || candidate === 'Medium') return 'Medium';
    return 'Low';
  };

  const sections: MatterRiskSectionSnapshotItem[] = visibleSections.map((sec) => {
    const visibleQs = sec.questions.filter((q) => !q.amlOnly || isMlrInScope);
    let secCompleted = 0;
    let secRisk: RiskLevel | null = null;

    const qSnapshots: MatterRiskQuestionSnapshotItem[] = visibleQs.map((q) => {
      totalQuestions++;
      const selectedLabel = answers[q.id] ?? '';
      const matchedOpt = q.options.find((o) => o.label === selectedLabel) ?? null;
      const followUpVal = (followUps[q.id] ?? '').trim();

      if (matchedOpt) {
        secRisk = elevateRisk(secRisk, matchedOpt.risk);
        highestRisk = elevateRisk(highestRisk, matchedOpt.risk);
        const followUpDone =
          !matchedOpt.triggersFollowUp ||
          (q.followUpType === 'key_dates'
            ? customKeyDates.length > 0
            : followUpVal.length > 0);
        if (followUpDone) {
          secCompleted++;
          completedQuestions++;
        }
      }

      return {
        id: q.id,
        question: q.question,
        answer: selectedLabel || 'Not recorded',
        risk: matchedOpt?.risk ?? null,
        followUpLabel: q.followUpLabel,
        followUp:
          q.followUpType === 'key_dates' && customKeyDates.length > 0
            ? customKeyDates.map((d) => `${d.label}: ${d.date}`).join('; ')
            : followUpVal || undefined,
      };
    });

    return {
      id: sec.id,
      number: sec.number,
      title: sec.title,
      sectionRisk: secRisk,
      completedCount: secCompleted,
      totalCount: visibleQs.length,
      questions: qSnapshots,
    };
  });

  return {
    completedAt,
    completedById,
    completedByName,
    overallRisk: highestRisk ?? fallbackOverallRisk,
    completedQuestions,
    totalQuestions,
    isMlrInScope,
    answers: { ...answers },
    followUps: { ...followUps },
    customKeyDates: [...customKeyDates],
    sections,
  };
}

/**
 * Resolves the Matter Risk Assessment snapshot for a Matter.
 * Uses the immutable saved snapshot on `matter.fieldValues.riskAssessment` if present,
 * or constructs a complete fallback snapshot for seeded/existing matters.
 */
export function resolveMatterRiskAssessment(
  matter: Matter,
  people: Person[],
  values: ChoiceValue[],
): MatterRiskAssessmentSnapshot {
  const nameOf = (id: string | null | undefined) => {
    if (!id) return 'Bethan Rees';
    const p = people.find((x) => x.id === id);
    return p ? personDisplayName(p) : id;
  };

  const saved = matter.fieldValues?.['riskAssessment'] as
    | (Partial<MatterRiskAssessmentSnapshot> & {
        answers?: Record<string, string>;
        followUps?: Record<string, string>;
        overallRisk?: RiskLevel | null;
      })
    | undefined;

  const savedKeyDates = Array.isArray(matter.fieldValues?.['customKeyDates'])
    ? (matter.fieldValues['customKeyDates'] as CustomKeyDateEntry[])
    : [];

  const riskLabel = resolveLabel(values, matter.riskRatingId);
  const fallbackRisk: RiskLevel = riskLabel.toLowerCase().includes('high')
    ? 'High'
    : riskLabel.toLowerCase().includes('low')
      ? 'Low'
      : 'Medium';

  if (saved && Array.isArray(saved.sections) && saved.sections.length > 0) {
    return {
      completedAt: saved.completedAt || matter.openedAt || matter.createdAt,
      completedById: saved.completedById || matter.leadFeeEarnerId || matter.createdById,
      completedByName:
        saved.completedByName ||
        nameOf(matter.leadFeeEarnerId || matter.createdById),
      overallRisk: saved.overallRisk || fallbackRisk,
      completedQuestions: saved.completedQuestions ?? 0,
      totalQuestions: saved.totalQuestions ?? 0,
      isMlrInScope: saved.isMlrInScope ?? true,
      answers: saved.answers ?? {},
      followUps: saved.followUps ?? {},
      customKeyDates: saved.customKeyDates ?? savedKeyDates,
      sections: saved.sections,
    };
  }

  const hasSavedAnswers =
    saved?.answers && Object.keys(saved.answers).length > 0;

  const defaultSeedAnswers: Record<string, string> = {
    inScopeMlr: 'Yes, in scope',
    instructionMakesSense: 'Yes',
    moveMoneyWithoutTransaction: 'No',
    clientRelationshipStatus: 'Existing, CDD current',
    clientDealingMethod: 'Met in person',
    complexOwnershipStructure: 'No',
    thirdPartyInstructions: 'No',
    highRiskJurisdictionLink: 'No',
    crossBorderFundsOrAssets: 'No',
    holdClientMoney: 'Yes, below firm threshold',
    matterFundingSource: 'The client',
    sourceOfFundsUnderstood: 'Yes',
    unusualPaymentRequests: 'No',
    regularTeamWork: 'Yes',
    capacityAndSupervision: 'Yes',
    imminentDeadlines: matter.targetCompletionAt ? 'Yes' : 'No',
    feeBasis: resolveLabel(values, matter.billingBasisId).toLowerCase().includes('fixed')
      ? 'Fixed fee'
      : 'Hourly',
    moneyOnAccountRequested: 'Yes',
    valueOrExposure: fallbackRisk === 'High' ? 'Unusually high' : 'Within normal range',
    limitationOfLiabilityProposed: 'No',
    reputationOrEthicalConcerns: 'No',
    sensitiveSectorOrMedia: 'No',
    specialCategoryDataOrConfidentiality: 'No',
  };

  const defaultSeedFollowUps: Record<string, string> =
    fallbackRisk === 'High'
      ? {
          valueOrExposure:
            'High-value commercial instruction reviewed and approved by supervising partner.',
        }
      : {};

  const effectiveKeyDates =
    savedKeyDates.length > 0
      ? savedKeyDates
      : matter.targetCompletionAt
        ? [
            {
              id: 'kd-target',
              label: 'Target completion / key date',
              date: matter.targetCompletionAt,
            },
          ]
        : [];

  return buildMatterRiskAssessmentSnapshot({
    answers: hasSavedAnswers ? saved!.answers! : defaultSeedAnswers,
    followUps: saved?.followUps ?? defaultSeedFollowUps,
    customKeyDates: effectiveKeyDates,
    completedById:
      saved?.completedById || matter.leadFeeEarnerId || matter.createdById,
    completedByName:
      saved?.completedByName ||
      nameOf(matter.leadFeeEarnerId || matter.createdById),
    completedAt: saved?.completedAt || matter.openedAt || matter.createdAt,
    fallbackOverallRisk: saved?.overallRisk || fallbackRisk,
  });
}

/**
 * Resolves the ConflictCheckRecord for a Matter (using the saved record or constructing a consistent default for seeded matters).
 */
export function resolveMatterConflictCheckRecord(
  matter: Matter,
  people: Person[],
  organisations: Organisation[],
): ConflictCheckRecord {
  if (matter.conflictCheckRecord) {
    return matter.conflictCheckRecord;
  }

  const nameMap = new Map<string, string>();
  for (const o of organisations) nameMap.set(o.id, o.legalName);
  for (const p of people) nameMap.set(p.id, personDisplayName(p));

  const clientLabel = nameMap.get(matter.clientId) ?? matter.clientId;
  const instructingName = matter.instructingContactId
    ? nameMap.get(matter.instructingContactId)
    : undefined;
  const clearedByName = matter.conflictClearedById
    ? nameMap.get(matter.conflictClearedById) ?? 'Bethan Rees'
    : 'Bethan Rees';

  return {
    status:
      matter.conflictCheckStatus === 'Pending conflict review'
        ? 'Referred'
        : 'Cleared',
    outcomeLabel:
      matter.conflictCheckStatus === 'Pending conflict review'
        ? 'Referred to risk for review'
        : 'Cleared by fee earner',
    declarationConfirmed: true,
    reviewerMessage: matter.conflictNotes || '',
    lastRunAtDisplay: formatDate(matter.conflictCheckDate) || '22 Oct 2026, 17:42',
    lastRunById: matter.conflictClearedById || matter.leadFeeEarnerId || 'P-000003',
    lastRunByName: clearedByName,
    submittedAtDisplay: formatDate(matter.conflictCheckDate) || '22 Oct 2026, 17:46',
    submittedById: matter.leadFeeEarnerId || 'P-000003',
    submittedByName: clearedByName,
    approvedAtDisplay: formatDate(matter.conflictCheckDate) || '22 Oct 2026, 17:46',
    approvedById: matter.conflictClearedById || 'P-000003',
    approvedByName: `${clearedByName} (Cleared by fee earner)`,
    parties: [
      ...(matter.clientId
        ? [
            {
              id: 'cp-1',
              name: clientLabel || matter.clientId,
              entityType: matter.clientId.startsWith('P-')
                ? ('person' as const)
                : ('organisation' as const),
              role: 'Client' as const,
              linkedRecordId: matter.clientId,
              subtitle: 'Client on matter',
              isClientFixed: true,
            },
          ]
        : []),
      ...(instructingName
        ? [
            {
              id: 'cp-2',
              name: instructingName,
              entityType: 'person' as const,
              role: 'Client contact' as const,
              linkedRecordId: matter.instructingContactId,
              subtitle: `Instructing contact · ${clientLabel}`,
              isClientFixed: true,
            },
          ]
        : []),
      ...matter.parties.map((pt, i) => ({
        id: pt.id || `cp-pt-${i}`,
        name: pt.name,
        entityType:
          pt.entityType ??
          (pt.linkedRecordId?.startsWith('P-') ? ('person' as const) : ('organisation' as const)),
        role: (pt.role as 'Opponent') || 'Opponent',
        linkedRecordId: pt.linkedRecordId,
        subtitle: pt.role,
      })),
    ],
    matches: [],
    runs: [
      {
        id: 'run-init-1',
        runAtDisplay: formatDate(matter.conflictCheckDate) || '22 Oct 2026, 17:42',
        runById: matter.conflictClearedById || matter.leadFeeEarnerId || 'P-000003',
        runByName: clearedByName,
        searchTerms: [
          clientLabel,
          ...(instructingName ? [instructingName] : []),
          ...matter.parties.map((p) => p.name),
        ].filter(Boolean),
        partiesCount: 1 + (instructingName ? 1 : 0) + matter.parties.length,
        matchesCount: 0,
        potentialConflictsCount: 0,
      },
    ],
    comments: [],
  };
}

/**
 * Resolves or constructs the immutable MatterOpeningSnapshot for a Matter.
 */
export function resolveMatterOpeningSnapshot(
  matter: Matter,
  people: Person[],
  organisations: Organisation[],
  values: ChoiceValue[],
  enquiries: Enquiry[] = [],
  quotes: Quote[] = [],
): MatterOpeningSnapshot {
  const existingSnap = matter.fieldValues?.['matterOpeningSnapshot'] as
    | MatterOpeningSnapshot
    | undefined;
  if (existingSnap && existingSnap.version === '1.0') {
    return {
      ...existingSnap,
      matterId: matter.id,
      matterNumber:
        matter.matterNumber && matter.matterNumber !== 'DRAFT'
          ? matter.matterNumber
          : existingSnap.matterNumber,
    };
  }

  const nameMap = new Map<string, string>();
  for (const o of organisations) nameMap.set(o.id, o.legalName);
  for (const p of people) nameMap.set(p.id, personDisplayName(p));

  const allClientIds = Array.from(
    new Set([matter.clientId, ...(matter.additionalClientIds ?? [])].filter(Boolean)),
  );
  const clientCapCodes =
    (matter.fieldValues?.['clientCapacityCodes'] as string[] | undefined) ?? [];

  const clients = allClientIds.map((cid) => {
    const org = organisations.find((o) => o.id === cid);
    const person = people.find((p) => p.id === cid);
    return {
      id: cid,
      name: org?.legalName || (person ? personDisplayName(person) : cid),
      entityType: cid.startsWith('O-') ? 'Organisation' : 'Person',
      capacities: clientCapCodes,
      details: org
        ? [org.companyNumber ? `Co. no. ${org.companyNumber}` : '', org.generalEmail]
            .filter(Boolean)
            .join(' · ')
        : person
          ? [person.emails[0]?.address, person.phones[0]?.number]
              .filter(Boolean)
              .join(' · ')
          : '',
    };
  });

  const sourceEnq = matter.sourceEnquiryId
    ? enquiries.find((e) => e.id === matter.sourceEnquiryId)
    : enquiries.find((e) => e.convertedMatterId === matter.id);
  const sourceQte = matter.sourceQuoteId
    ? quotes.find((q) => q.id === matter.sourceQuoteId)
    : quotes.find((q) => q.convertedMatterId === matter.id);

  const customRoles =
    (matter.fieldValues?.['teamMemberRoles'] as Record<string, string> | undefined) ?? {};

  const riskAssessment = resolveMatterRiskAssessment(matter, people, values);
  const conflictCheckRecord = resolveMatterConflictCheckRecord(
    matter,
    people,
    organisations,
  );

  const reservedKeys = new Set([
    'riskAssessment',
    'matterOpeningSnapshot',
    'additionalClientIds',
    'clientCapacityCodes',
    'jointClientCapacityCodes',
    'instructingContactCapacityCodes',
    'customKeyDates',
    'teamMemberRoles',
    'partiesEdited',
    'CORE-005',
    'claimValue',
    'responsibleOffice',
    'sourceOfWork',
  ]);

  const optionalFields: { id: string; label: string; value: string }[] = [];
  for (const [k, v] of Object.entries(matter.fieldValues ?? {})) {
    if (reservedKeys.has(k) || v === undefined || v === null || v === '') continue;
    optionalFields.push({
      id: k,
      label: k,
      value: typeof v === 'object' ? JSON.stringify(v) : String(v),
    });
  }

  return {
    version: '1.0',
    capturedAt: matter.openedAt || matter.createdAt,
    capturedAtDisplay: formatDateTime(matter.openedAt || matter.createdAt),
    capturedById: matter.createdById,
    capturedByName: nameMap.get(matter.createdById) ?? matter.createdById,
    saveMode: 'opened',
    matterId: matter.id,
    matterNumber: matter.matterNumber,
    title: matter.title,
    shortDescription: matter.shortDescription || '',
    sourceEnquiryReference: sourceEnq?.reference ?? null,
    sourceQuoteReference: sourceQte?.reference ?? null,
    clients,
    instructingContact: matter.instructingContactId
      ? {
          id: matter.instructingContactId,
          name: nameMap.get(matter.instructingContactId) ?? matter.instructingContactId,
          capacities:
            (matter.fieldValues?.['instructingContactCapacityCodes'] as
              | string[]
              | undefined) ?? ['Representative', 'Decision maker'],
        }
      : null,
    billingContact: matter.billingContactId
      ? {
          id: matter.billingContactId,
          name: nameMap.get(matter.billingContactId) ?? matter.billingContactId,
        }
      : null,
    departmentLabel: resolveLabel(values, matter.practiceAreaId) || '—',
    workTypeLabel: resolveLabel(values, matter.workTypeSubcategoryId) || '—',
    responsiblePartnerName: matter.responsiblePartnerId
      ? nameMap.get(matter.responsiblePartnerId) ?? matter.responsiblePartnerId
      : '—',
    supervisingPartnerName: matter.supervisingPartnerId
      ? nameMap.get(matter.supervisingPartnerId) ?? matter.supervisingPartnerId
      : '—',
    leadFeeEarnerName: matter.leadFeeEarnerId
      ? nameMap.get(matter.leadFeeEarnerId) ?? matter.leadFeeEarnerId
      : '—',
    relationshipPartnerName: matter.relationshipPartnerId
      ? nameMap.get(matter.relationshipPartnerId) ?? matter.relationshipPartnerId
      : '—',
    additionalTeamMembers: (matter.teamMemberIds ?? []).map((tid) => ({
      name: nameMap.get(tid) ?? tid,
      role: customRoles[tid] || 'Team member',
    })),
    billingAndFinancials: {
      billingBasis: resolveLabel(values, matter.billingBasisId) || '—',
      feeEstimateGbp:
        matter.feeEstimateGbp != null
          ? `£${matter.feeEstimateGbp.toLocaleString('en-GB')}`
          : '—',
      agreedFeeCapGbp:
        matter.agreedFeeCapGbp != null
          ? `£${matter.agreedFeeCapGbp.toLocaleString('en-GB')}`
          : '—',
      retainerMoniesOnAccountGbp:
        matter.retainerMoniesOnAccountGbp != null
          ? `£${matter.retainerMoniesOnAccountGbp.toLocaleString('en-GB')}`
          : '—',
      clientReference: String(matter.fieldValues?.['CORE-005'] || '—'),
      claimValue:
        String(matter.fieldValues?.['claimValue'] || '') ||
        resolveLabel(values, matter.matterSizeId) ||
        '—',
      responsibleOffice: String(matter.fieldValues?.['responsibleOffice'] || 'Cardiff'),
      sourceOfWork:
        String(matter.fieldValues?.['sourceOfWork'] || '') ||
        resolveLabel(values, matter.referrerTypeId) ||
        '—',
      targetCompletionAt: matter.targetCompletionAt
        ? formatDate(matter.targetCompletionAt)
        : '—',
      forumCourt: matter.forumCourt || '—',
    },
    complianceOnboarding: {
      amlStatus: matter.amlStatus || 'CMI incomplete',
      sourceOfFundsVerified: matter.sourceOfFundsVerified || 'In progress',
      engagementLetterStatus: matter.engagementLetterStatus || 'Drafting',
    },
    riskAssessment,
    conflictCheckRecord,
    declarationConfirmed: conflictCheckRecord.declarationConfirmed,
    optionalFields,
  };
}

// ============================================================================
// Pure-TypeScript PDF Generator (%PDF-1.4) for Immutable Matter Opening Record
// ============================================================================

interface PdfLine {
  text: string;
  bold?: boolean;
  size?: number;
  indent?: number;
  spacingBefore?: number;
  spacingAfter?: number;
  ruleBelow?: boolean;
}

function sanitizePdfText(input: string): string {
  return input
    .replace(/£/g, 'GBP ')
    .replace(/[—–]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/✓/g, '[Yes]')
    .replace(/•/g, '-')
    .replace(/·/g, '|')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function wrapText(text: string, maxChars: number): string[] {
  const clean = text.replace(/\r?\n/g, ' ').trim();
  if (!clean) return [''];
  const words = clean.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    if (!current) {
      current = w;
    } else if (current.length + 1 + w.length <= maxChars) {
      current += ` ${w}`;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function generatePdfBytesFromLines(title: string, rawLines: PdfLine[]): Uint8Array {
  const PAGE_WIDTH = 595.28; // A4 width in pt
  const PAGE_HEIGHT = 841.89; // A4 height in pt
  const MARGIN_LEFT = 46;
  const MARGIN_TOP = 52;
  const MARGIN_BOTTOM = 52;

  // Expand wrapped lines first
  const expandedLines: PdfLine[] = [];
  for (const item of rawLines) {
    const size = item.size ?? 9.5;
    const indent = item.indent ?? 0;
    const maxChars = Math.max(35, Math.floor((PAGE_WIDTH - MARGIN_LEFT * 2 - indent) / (size * 0.52)));
    const wrapped = wrapText(item.text, maxChars);
    wrapped.forEach((lineText, idx) => {
      expandedLines.push({
        text: lineText,
        bold: item.bold,
        size,
        indent,
        spacingBefore: idx === 0 ? item.spacingBefore : 0,
        spacingAfter: idx === wrapped.length - 1 ? item.spacingAfter : 0,
        ruleBelow: idx === wrapped.length - 1 ? item.ruleBelow : false,
      });
    });
  }

  // Paginate
  const pages: PdfLine[][] = [];
  let currentPage: PdfLine[] = [];
  let cursorY = PAGE_HEIGHT - MARGIN_TOP;

  for (const ln of expandedLines) {
    const lineHeight = (ln.size ?? 9.5) * 1.38;
    const needed = (ln.spacingBefore ?? 0) + lineHeight + (ln.spacingAfter ?? 0) + (ln.ruleBelow ? 6 : 0);
    if (cursorY - needed < MARGIN_BOTTOM && currentPage.length > 0) {
      pages.push(currentPage);
      currentPage = [];
      cursorY = PAGE_HEIGHT - MARGIN_TOP;
    }
    currentPage.push(ln);
    cursorY -= needed;
  }
  if (currentPage.length > 0 || pages.length === 0) {
    pages.push(currentPage);
  }

  // Build PDF objects
  // 1: Catalog, 2: Pages, 3: Font Regular (F1), 4: Font Bold (F2)
  // For each page i: Page obj = 5 + i*2, Content stream obj = 6 + i*2
  const objects: string[] = [];
  const addObj = (body: string) => {
    objects.push(body);
    return objects.length;
  };

  addObj('<< /Type /Catalog /Pages 2 0 R >>'); // 1
  addObj(''); // 2 placeholder for Pages
  addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); // 3
  addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'); // 4

  const pageObjNums: number[] = [];

  pages.forEach((pLines, pageIdx) => {
    const ops: string[] = [];
    let y = PAGE_HEIGHT - MARGIN_TOP;

    for (const ln of pLines) {
      y -= ln.spacingBefore ?? 0;
      const fontSize = ln.size ?? 9.5;
      const x = MARGIN_LEFT + (ln.indent ?? 0);
      const fontRef = ln.bold ? '/F2' : '/F1';
      ops.push('BT');
      ops.push(`${fontRef} ${fontSize.toFixed(1)} Tf`);
      ops.push(`${x.toFixed(1)} ${y.toFixed(1)} Td`);
      ops.push(`(${sanitizePdfText(ln.text)}) Tj`);
      ops.push('ET');
      y -= fontSize * 1.38;

      if (ln.ruleBelow) {
        ops.push('0.82 G 0.6 w');
        ops.push(`${MARGIN_LEFT} ${(y + 2).toFixed(1)} m ${(PAGE_WIDTH - MARGIN_LEFT).toFixed(1)} ${(y + 2).toFixed(1)} l S`);
        y -= 6;
      }
      y -= ln.spacingAfter ?? 0;
    }

    // Footer with page number and immutable record stamp
    const footerText = `${title}  |  Immutable Matter Opening Record  |  Page ${pageIdx + 1} of ${pages.length}`;
    ops.push('BT');
    ops.push('/F1 8.0 Tf');
    ops.push(`${MARGIN_LEFT} 28.0 Td`);
    ops.push(`(${sanitizePdfText(footerText)}) Tj`);
    ops.push('ET');

    const streamContent = ops.join('\n');
    const pageObjNum = addObj('');
    const contentObjNum = addObj(
      `<< /Length ${streamContent.length} >>\nstream\n${streamContent}\nendstream`,
    );
    objects[pageObjNum - 1] = `<< /Type /Pages /Parent 2 0 R >>`.replace(
      '/Type /Pages',
      `/Type /Page /MediaBox [0 0 ${PAGE_WIDTH.toFixed(2)} ${PAGE_HEIGHT.toFixed(2)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjNum} 0 R`,
    );
    pageObjNums.push(pageObjNum);
  });

  objects[1] = `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageObjNums.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  objects.forEach((objBody, idx) => {
    offsets.push(pdf.length);
    pdf += `${idx + 1} 0 obj\n${objBody}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) {
    bytes[i] = pdf.charCodeAt(i) & 0xff;
  }
  return bytes;
}

export function buildMatterOpeningPdfLines(snap: MatterOpeningSnapshot): PdfLine[] {
  const lines: PdfLine[] = [
    {
      text: 'NOT A LAW FIRM LLP — COMPLETE MATTER OPENING RECORD (IMMUTABLE SNAPSHOT)',
      bold: true,
      size: 13,
      spacingAfter: 3,
    },
    {
      text: `Matter Reference: ${snap.matterNumber}   |   Title: ${snap.title}`,
      bold: true,
      size: 10.5,
      spacingAfter: 2,
    },
    {
      text: `Captured: ${snap.capturedAtDisplay} by ${snap.capturedByName}   |   Snapshot Version: ${snap.version} (Frozen historical copy)`,
      size: 8.5,
      spacingAfter: 4,
      ruleBelow: true,
    },
  ];

  // Section 1: Matter Details & Team
  lines.push({
    text: '1. MATTER DETAILS & TEAM',
    bold: true,
    size: 10.5,
    spacingBefore: 6,
    spacingAfter: 3,
    ruleBelow: true,
  });
  lines.push({ text: `Matter Number: ${snap.matterNumber} (${snap.matterId})`, bold: true });
  lines.push({ text: `Matter Description / Title: ${snap.title}` });
  if (snap.shortDescription) {
    lines.push({ text: `Scope / Summary Notes: ${snap.shortDescription}` });
  }
  if (snap.sourceEnquiryReference) {
    lines.push({ text: `Converted from Enquiry: ${snap.sourceEnquiryReference}` });
  }
  if (snap.sourceQuoteReference) {
    lines.push({ text: `Converted from Quote: ${snap.sourceQuoteReference}` });
  }
  lines.push({
    text: `Department & Work Type: ${snap.departmentLabel} -> ${snap.workTypeLabel}`,
  });
  for (const cl of snap.clients) {
    lines.push({
      text: `Client: ${cl.name} (${cl.entityType}, ID: ${cl.id})${cl.capacities.length ? ` | Capacity: ${cl.capacities.join(', ')}` : ''}${cl.details ? ` | ${cl.details}` : ''}`,
    });
  }
  if (snap.instructingContact) {
    lines.push({
      text: `Instructing Contact: ${snap.instructingContact.name} (${snap.instructingContact.id})`,
    });
  }
  if (snap.billingContact) {
    lines.push({
      text: `Billing Contact: ${snap.billingContact.name} (${snap.billingContact.id})`,
    });
  }
  lines.push({
    text: `Responsible Partner: ${snap.responsiblePartnerName}   |   Lead Fee Earner: ${snap.leadFeeEarnerName}`,
  });
  lines.push({
    text: `Supervising Partner: ${snap.supervisingPartnerName}   |   Relationship Partner: ${snap.relationshipPartnerName}`,
  });
  if (snap.additionalTeamMembers.length > 0) {
    lines.push({
      text: `Additional Team Members: ${snap.additionalTeamMembers.map((m) => `${m.name} (${m.role})`).join(', ')}`,
    });
  }

  // Section 2: Matter Risk Assessment
  lines.push({
    text: `2. MATTER RISK ASSESSMENT (Overall Risk: ${snap.riskAssessment.overallRisk} | ${snap.riskAssessment.completedQuestions}/${snap.riskAssessment.totalQuestions} Completed)`,
    bold: true,
    size: 10.5,
    spacingBefore: 8,
    spacingAfter: 3,
    ruleBelow: true,
  });
  lines.push({
    text: `Assessed by: ${snap.riskAssessment.completedByName}   |   MLR In Scope: ${snap.riskAssessment.isMlrInScope ? 'Yes, in scope' : 'No, out of scope'}`,
    size: 9,
    spacingAfter: 2,
  });

  for (const sec of snap.riskAssessment.sections) {
    lines.push({
      text: `Section ${sec.number}: ${sec.title} [Section Risk: ${sec.sectionRisk || 'Low'}]`,
      bold: true,
      size: 9.5,
      spacingBefore: 4,
      spacingAfter: 1,
    });
    for (const q of sec.questions) {
      lines.push({
        text: `- ${q.question}`,
        indent: 8,
        size: 9,
      });
      lines.push({
        text: `Answer: ${q.answer}${q.risk ? ` (${q.risk} risk)` : ''}${q.followUp ? ` | Follow-up: ${q.followUp}` : ''}`,
        bold: true,
        indent: 16,
        size: 9,
        spacingAfter: 1,
      });
    }
  }

  // Section 3: Parties & Conflict Check Record
  const cc = snap.conflictCheckRecord;
  lines.push({
    text: `3. CONFLICT CHECK RECORD (Status: ${cc.status} | Outcome: ${cc.outcomeLabel})`,
    bold: true,
    size: 10.5,
    spacingBefore: 8,
    spacingAfter: 3,
    ruleBelow: true,
  });
  lines.push({
    text: `Submitted by: ${cc.submittedByName || snap.capturedByName} (${cc.submittedAtDisplay || snap.capturedAtDisplay})   |   Cleared/Approved by: ${cc.approvedByName || snap.capturedByName}`,
    size: 9,
  });
  lines.push({
    text: `Declaration Confirmed: ${snap.declarationConfirmed ? 'Yes - Confirmed complete to best of fee earner knowledge' : 'No'}`,
    bold: true,
    size: 9,
    spacingAfter: 3,
  });

  lines.push({
    text: `Parties Checked (${cc.parties.length}):`,
    bold: true,
    size: 9.5,
    spacingBefore: 2,
  });
  for (const pt of cc.parties) {
    lines.push({
      text: `- ${pt.name} [${pt.role}]${pt.subtitle ? ` - ${pt.subtitle}` : ''}`,
      indent: 8,
      size: 9,
    });
  }

  lines.push({
    text: `Conflict Search Matches & Dispositions (${cc.matches.length}):`,
    bold: true,
    size: 9.5,
    spacingBefore: 4,
  });
  if (cc.matches.length === 0) {
    lines.push({
      text: '- No matches found across open or closed matters.',
      indent: 8,
      size: 9,
    });
  } else {
    for (const m of cc.matches) {
      const dispLabel =
        m.disposition === 'not_the_same'
          ? 'Not the same'
          : m.disposition === 'potential_conflict'
            ? 'Potential conflict'
            : 'Same - no conflict';
      lines.push({
        text: `- ${m.matchedRecordName} (${m.strength} match | ${m.whereFound}) -> Disposition: ${dispLabel}`,
        bold: true,
        indent: 8,
        size: 9,
      });
      if (m.note) {
        lines.push({
          text: `Note: ${m.note}`,
          indent: 16,
          size: 8.5,
        });
      }
      if (m.reviewerDecision) {
        lines.push({
          text: `Risk/Compliance Decision (${m.reviewedByName || 'COLP'}): ${m.reviewerDecision}${m.reviewerNote ? ` - ${m.reviewerNote}` : ''}`,
          indent: 16,
          size: 8.5,
        });
      }
    }
  }

  lines.push({
    text: `Search Run Audit Trail (${cc.runs.length}):`,
    bold: true,
    size: 9.5,
    spacingBefore: 4,
  });
  for (const r of cc.runs) {
    lines.push({
      text: `- Run ${r.runAtDisplay} by ${r.runByName}: ${r.partiesCount} parties, ${r.matchesCount} matches (${r.potentialConflictsCount} potential conflicts) | Terms: ${r.searchTerms.join(', ')}`,
      indent: 8,
      size: 8.5,
    });
  }

  // Section 4: Billing, Financials & Additional Matter Opening Details
  const bf = snap.billingAndFinancials;
  lines.push({
    text: '4. BILLING, FINANCIALS & COMPLIANCE ONBOARDING',
    bold: true,
    size: 10.5,
    spacingBefore: 8,
    spacingAfter: 3,
    ruleBelow: true,
  });
  lines.push({
    text: `Billing Basis: ${bf.billingBasis}   |   Fee Estimate: ${bf.feeEstimateGbp}   |   Agreed Fee Cap: ${bf.agreedFeeCapGbp}   |   Monies on Account: ${bf.retainerMoniesOnAccountGbp}`,
  });
  lines.push({
    text: `Client Reference: ${bf.clientReference}   |   Claim/Matter Value: ${bf.claimValue}   |   Office: ${bf.responsibleOffice}`,
  });
  lines.push({
    text: `Source of Work: ${bf.sourceOfWork}   |   Target Completion: ${bf.targetCompletionAt}   |   Forum/Court: ${bf.forumCourt}`,
  });
  lines.push({
    text: `AML / CDD Status: ${snap.complianceOnboarding.amlStatus}   |   Source of Funds: ${snap.complianceOnboarding.sourceOfFundsVerified}   |   Engagement Letter: ${snap.complianceOnboarding.engagementLetterStatus}`,
  });

  if (snap.optionalFields.length > 0) {
    lines.push({
      text: '5. WORK-TYPE SPECIFIC & CUSTOM FIELDS RECORDED AT OPENING',
      bold: true,
      size: 10.5,
      spacingBefore: 8,
      spacingAfter: 3,
      ruleBelow: true,
    });
    for (const f of snap.optionalFields) {
      lines.push({
        text: `${f.label}: ${f.value}`,
        size: 9,
      });
    }
  }

  return lines;
}

export function triggerPdfDownload(filename: string, bytes: Uint8Array): void {
  if (typeof window === 'undefined') return;
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2500);
}

export function downloadMatterOpeningPdf(snap: MatterOpeningSnapshot): void {
  const lines = buildMatterOpeningPdfLines(snap);
  const bytes = generatePdfBytesFromLines(
    `Matter ${snap.matterNumber} — Opening Record`,
    lines,
  );
  const safeRef = (snap.matterNumber || snap.matterId || 'DRAFT').replace(
    /[^A-Za-z0-9_-]/g,
    '_',
  );
  triggerPdfDownload(`Matter-Opening-Record-${safeRef}.pdf`, bytes);
}

export function downloadConflictCheckPdf(
  matterNumber: string,
  matterTitle: string,
  cc: ConflictCheckRecord,
): void {
  const lines: PdfLine[] = [
    {
      text: 'NOT A LAW FIRM LLP — CONFLICT CHECK RECORD',
      bold: true,
      size: 13,
      spacingAfter: 3,
    },
    {
      text: `Matter: ${matterNumber} — ${matterTitle}`,
      bold: true,
      size: 10.5,
      spacingAfter: 2,
    },
    {
      text: `Status: ${cc.status}   |   Outcome: ${cc.outcomeLabel}   |   Submitted: ${cc.submittedByName || 'Fee earner'} (${cc.submittedAtDisplay || '—'})`,
      size: 9,
      spacingAfter: 4,
      ruleBelow: true,
    },
    {
      text: `Parties Checked (${cc.parties.length}):`,
      bold: true,
      size: 10,
      spacingBefore: 4,
      spacingAfter: 2,
    },
    ...cc.parties.map((p) => ({
      text: `- ${p.name} [${p.role}]${p.subtitle ? ` - ${p.subtitle}` : ''}`,
      indent: 8,
      size: 9,
    })),
    {
      text: `Matches & Dispositions (${cc.matches.length}):`,
      bold: true,
      size: 10,
      spacingBefore: 6,
      spacingAfter: 2,
    },
    ...(cc.matches.length === 0
      ? [{ text: '- No matches found across open or closed matters.', indent: 8, size: 9 }]
      : cc.matches.flatMap((m) => [
          {
            text: `- ${m.matchedRecordName} (${m.strength} match | ${m.whereFound}) -> ${m.disposition || 'Reviewed'}`,
            bold: true,
            indent: 8,
            size: 9,
          },
          ...(m.note ? [{ text: `Note: ${m.note}`, indent: 16, size: 8.5 }] : []),
        ])),
    {
      text: `Search Run Audit Trail (${cc.runs.length}):`,
      bold: true,
      size: 10,
      spacingBefore: 6,
      spacingAfter: 2,
    },
    ...cc.runs.map((r) => ({
      text: `- Run ${r.runAtDisplay} by ${r.runByName}: ${r.partiesCount} parties, ${r.matchesCount} matches | Terms: ${r.searchTerms.join(', ')}`,
      indent: 8,
      size: 8.5,
    })),
  ];

  const bytes = generatePdfBytesFromLines(`Conflict Check — ${matterNumber}`, lines);
  const safeRef = (matterNumber || 'Matter').replace(/[^A-Za-z0-9_-]/g, '_');
  triggerPdfDownload(`Conflict-Check-Record-${safeRef}.pdf`, bytes);
}

export function downloadRiskAssessmentPdf(
  matterNumber: string,
  matterTitle: string,
  ra: MatterRiskAssessmentSnapshot,
): void {
  const lines: PdfLine[] = [
    {
      text: 'NOT A LAW FIRM LLP — MATTER RISK ASSESSMENT RECORD',
      bold: true,
      size: 13,
      spacingAfter: 3,
    },
    {
      text: `Matter: ${matterNumber} — ${matterTitle}`,
      bold: true,
      size: 10.5,
      spacingAfter: 2,
    },
    {
      text: `Overall Risk: ${ra.overallRisk}   |   Completed: ${ra.completedQuestions}/${ra.totalQuestions} questions   |   Assessed by: ${ra.completedByName}`,
      size: 9,
      spacingAfter: 4,
      ruleBelow: true,
    },
    ...ra.sections.flatMap((sec) => [
      {
        text: `Section ${sec.number}: ${sec.title} [Section Risk: ${sec.sectionRisk || 'Low'}]`,
        bold: true,
        size: 10,
        spacingBefore: 5,
        spacingAfter: 2,
      },
      ...sec.questions.flatMap((q) => [
        {
          text: `- ${q.question}`,
          indent: 8,
          size: 9,
        },
        {
          text: `Answer: ${q.answer}${q.risk ? ` (${q.risk} risk)` : ''}${q.followUp ? ` | Follow-up: ${q.followUp}` : ''}`,
          bold: true,
          indent: 16,
          size: 9,
          spacingAfter: 1,
        },
      ]),
    ]),
  ];

  const bytes = generatePdfBytesFromLines(`Risk Assessment — ${matterNumber}`, lines);
  const safeRef = (matterNumber || 'Matter').replace(/[^A-Za-z0-9_-]/g, '_');
  triggerPdfDownload(`Matter-Risk-Assessment-${safeRef}.pdf`, bytes);
}
