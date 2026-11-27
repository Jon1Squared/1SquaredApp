'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createSendIdempotencyController } from './sendIdempotency';
import {
  AlertCircle,
  Calendar,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Download,
  Edit3,
  FileText,
  Mail,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  Phone,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import {
  minorUnitsToPounds,
  poundsToMinorUnits,
  subtractMinorUnits,
  sumMinorUnits,
  type CommunicationChaseEventRecord,
  type CommunicationChaseRecord,
  type EngagementDispatchRecord,
  type MoneyOnAccountConfiguration,
  type MoneyOnAccountReceiptRecord,
  type MoneyOnAccountRequestRecord,
} from '@platform/core-api';
import {
  addNoteAction,
  cancelMoneyOnAccountRequestAction,
  createAndSendMoneyOnAccountRequestAction,
  liftMatterRestrictionAction,
  matchPmsClientLedgerReceiptAction,
  openProspectiveMatterAction,
  overrideMatterOpeningPreconditionAction,
  recordEngagementLetterSignedAction,
  recordMoneyOnAccountReceiptAction,
  retryCommunicationChaseAction,
  reverseMoneyOnAccountReceiptAction,
  revokeMatterOpeningOverrideAction,
  saveMatterAction,
  saveTaskAction,
  sendEngagementLetterAction,
  stopCommunicationChaseAction,
  transitionRegisterRecordAction,
  updateMatterConflictRecordAction,
  updateMatterLifecycleStatusAction,
} from '@/app/actions';
import { isActionDenied } from '@/domain/actionResult';
import { formatDate, formatDateTime } from '@/domain/dates';
import {
  formatOpeningGateActionError,
  isMatterEngagementSignedForGate,
  OPENING_GATE_PRECONDITION_LABELS,
  type MatterOpeningGateView,
  type OpeningGatePreconditionKey,
} from '@/domain/openingGate';
import { isClosedMatterStatus, isProspectiveMatterStatus } from '@/domain/workTypeConfig';
import { resolveLabel, resolveLabels } from '@/domain/lists';
import { resolveMatterStatusPill } from '@/domain/matterStatusDisplay';
import {
  extractCriticalDates,
  fieldGroupsForSubcategory,
  findSubcategoryRule,
  formatStageStatusLabel,
  type MatterModelField,
  resolveOverviewPartyPresentation,
  specificFieldsForSubcategory,
  stageStatus,
} from '@/domain/matters';
import {
  downloadConflictCheckPdf,
  downloadMatterOpeningPdf,
  downloadRiskAssessmentPdf,
  formatRiskQuestionPill,
  formatRiskSectionPill,
  isPmsImportedWithoutLocalConflictCheck,
  PMS_IMPORTED_CONFLICT_STATUS_LABEL,
  resolveMatterConflictCheckRecord,
  resolveMatterOpeningSnapshot,
  resolveMatterRiskAssessment,
} from '@/domain/matterOpeningRecord';
import { hrefForId, personDisplayName, primaryEmail } from '@/domain/names';
import { formatGbp, resolvePmsPence } from '@/domain/pms';
import type { PmsClientAccountEntry } from '@/pms/types';
import type {
  AppRole,
  AuditEntry,
  ChoiceValue,
  ConflictCheckRecord,
  Enquiry,
  HomeRoleKey,
  Matter,
  Note,
  Organisation,
  Person,
  Quote,
  Task,
  Team,
} from '@/domain/types';
import type { MatterPmsViewBundle } from '@/server/services';
import { DocumentGenerationModal } from './DocumentGenerationModal';
import { DocumentListSection } from './DocumentListSection';
import { KeyDatesPanel } from './KeyDatesPanel';
import { MatterDocumentStoreSection } from './MatterDocumentStoreSection';
import { MatterFinanceTab } from './MatterFinanceTab';
import { RecordTasksSection } from './RecordTasksSection';
import { RegistersWorkspaceClient } from './RegistersWorkspaceClient';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';
import type {
  KeyDate,
  KeyDateCalendarSync,
  KeyDateNotApplicable,
  KeyDatePermission,
  KeyDateReminderState,
  KeyDatesConfig,
} from '@/domain/keyDates.types';

interface MatterProfileClientProps {
  matter: Matter;
  initialTab?: string;
  people: Person[];
  organisations: Organisation[];
  values: ChoiceValue[];
  tasks?: Task[];
  teams?: Team[];
  enquiries?: Enquiry[];
  quotes?: Quote[];
  currentUserId?: string;
  currentUserRole?: AppRole;
  currentUser?: Person;
  employees?: Person[];
  keyDatesConfig?: KeyDatesConfig;
  keyDates?: KeyDate[];
  keyDateNotApplicable?: KeyDateNotApplicable[];
  keyDateReminderStates?: KeyDateReminderState[];
  keyDateCalendarSyncs?: KeyDateCalendarSync[];
  userKeyDatePermissions?: KeyDatePermission[];
  userPermissions?: import('@/domain/types').PermissionKey[];
  userRoles?: HomeRoleKey[];
  registersConfig?: import('@platform/core-api').RegistersConfiguration;
  registerTypes?: import('@platform/core-api').RegisterTypeDefinition[];
  matterRegisterRecords?: import('@platform/core-api').RegisterRecord[];
  matterRegisterTransitions?: Record<string, import('@platform/core-api').RegisterTransition[]>;
  openingGateState?: MatterOpeningGateView;
  canViewClientCdd?: boolean;
  canVerifyByKeyDateId?: Record<string, { allowed: boolean; reason?: string }>;
  canTakeByTaskId?: Record<string, boolean>;
  canViewFinance?: boolean;
  canLiftRestriction?: boolean;
  canEditMatter?: boolean;
  pmsView?: MatterPmsViewBundle;
  engagementDispatches?: EngagementDispatchRecord[];
  engagementChases?: Array<{
    chase: CommunicationChaseRecord;
    events: readonly CommunicationChaseEventRecord[];
  }>;
  signedEngagementDownloadUrl?: string | null;
  effectiveMoneyOnAccountConfig?: MoneyOnAccountConfiguration;
  moneyOnAccountRequests?: MoneyOnAccountRequestRecord[];
  moneyOnAccountReceipts?: MoneyOnAccountReceiptRecord[];
  moneyOnAccountChases?: Array<{
    chase: CommunicationChaseRecord;
    events: readonly CommunicationChaseEventRecord[];
  }>;
  unmatchedPmsClientReceipts?: PmsClientAccountEntry[];
  moaReceiptDownloadUrls?: Record<string, string>;
  moneyOnAccountAgreedPence?: number | null;
  moneyOnAccountBankConfigured?: boolean;
  canViewMoneyOnAccount?: boolean;
  canRequestMoneyOnAccount?: boolean;
  canRecordMoneyOnAccountReceipt?: boolean;
  canMatchPmsClientLedgerReceipt?: boolean;
  emailProviderDisabled?: boolean;
  firmName?: string;
  notes: Note[];
  audit: AuditEntry[];
}

type MatterTab =
  | 'overview'
  | 'parties'
  | 'documents'
  | 'tasks'
  | 'finance'
  | 'compliance'
  | 'activity'
  | 'record';

interface StageStepItem {
  name: string;
  completedDetail?: string;
  upcomingDetail?: string;
}

function initialsOfName(name: string): string {
  const cleaned = name
    .replace(/^(Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Rev|Sir|Dame)\s+/i, '')
    .trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function formatShortDayMonth(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr.length === 10 ? `${dateStr}T00:00:00` : dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function formatDayMonthYear(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr.length === 10 ? `${dateStr}T00:00:00` : dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function parseMonthAndDay(dateStr: string): { month: string; day: string } {
  const d = new Date(dateStr.length === 10 ? `${dateStr}T00:00:00` : dateStr);
  if (Number.isNaN(d.getTime())) {
    return { month: '—', day: '—' };
  }
  return {
    month: d.toLocaleDateString('en-GB', { month: 'short' }).toUpperCase(),
    day: String(d.getDate()),
  };
}

export interface MatterIntakeComplianceRows {
  conflictCheck: {
    cleared: boolean;
    label: string;
    detail: string;
  };
  clientDueDiligence: {
    verified: boolean;
    neutral?: boolean;
    label: string;
    detail: string;
  };
  engagementLetter: {
    signed: boolean;
    label: string;
    detail: string;
  };
  riskAssessment: {
    completed: boolean;
    label: string;
    detail: string;
  };
}

export function resolveMatterIntakeComplianceRows(
  matter: Pick<
    Matter,
    | 'conflictDecision'
    | 'conflictCheckDate'
    | 'amlCompletedAt'
    | 'amlStatus'
    | 'engagementLetterSignedAt'
    | 'engagementLetterStatus'
  > &
    Partial<Pick<Matter, 'conflictCheckRecord' | 'conflictCheckStatus' | 'isPmsImport'>>,
  resolvedRiskAssessment: {
    overallRisk: string | null;
    completedQuestions: number;
    totalQuestions: number;
  },
  options?: {
    canViewClientCdd?: boolean;
  },
): MatterIntakeComplianceRows {
  const pmsImportedNoLocal = isPmsImportedWithoutLocalConflictCheck(matter);
  const conflictCleared = matter.conflictDecision?.outcome === 'Cleared';
  const conflictLabel = conflictCleared
    ? 'Conflict check cleared'
    : matter.conflictDecision?.outcome
      ? `Conflict check: ${matter.conflictDecision.outcome}`
      : pmsImportedNoLocal
        ? PMS_IMPORTED_CONFLICT_STATUS_LABEL
        : 'Conflict check not recorded';
  const conflictDetail = formatShortDayMonth(
    matter.conflictDecision?.decidedAt ?? matter.conflictCheckDate,
  );

  const cddMasked =
    options?.canViewClientCdd === false ||
    matter.amlStatus === 'Not available to you';
  const cddVerified =
    !cddMasked &&
    (matter.amlStatus === 'Not required' ||
      matter.amlStatus === 'Verified' ||
      matter.amlStatus === 'Completed' ||
      matter.amlStatus === 'Cleared' ||
      (Boolean(matter.amlCompletedAt) &&
        matter.amlStatus !== 'Overridden' &&
        matter.amlStatus !== 'Pending' &&
        matter.amlStatus !== 'CMI incomplete'));
  const cddDetail = cddMasked
    ? 'Not available to you'
    : matter.amlStatus === 'Not required'
      ? 'Not required'
      : matter.amlStatus === 'Overridden'
        ? 'Overridden'
        : matter.amlCompletedAt
          ? `Verified ${formatShortDayMonth(matter.amlCompletedAt)}`
          : matter.amlStatus || 'Not recorded';

  const engagementSigned = isMatterEngagementSignedForGate(matter);
  const engagementLabel = engagementSigned ? 'Engagement letter signed' : 'Engagement letter';
  const engagementDetail = matter.engagementLetterSignedAt
    ? formatShortDayMonth(matter.engagementLetterSignedAt)
    : matter.engagementLetterStatus || 'Not recorded';

  const riskCompleted = Boolean(resolvedRiskAssessment.overallRisk);
  const riskLabel = `Matter risk assessment (${
    resolvedRiskAssessment.overallRisk ? `${resolvedRiskAssessment.overallRisk} risk` : 'Not started'
  })`;
  const riskDetail = `${resolvedRiskAssessment.completedQuestions}/${resolvedRiskAssessment.totalQuestions} answered`;

  return {
    conflictCheck: {
      cleared: conflictCleared,
      label: conflictLabel,
      detail: conflictDetail,
    },
    clientDueDiligence: {
      verified: cddVerified,
      ...(cddMasked ? { neutral: true } : {}),
      label: 'Client due diligence',
      detail: cddDetail,
    },
    engagementLetter: {
      signed: engagementSigned,
      label: engagementLabel,
      detail: engagementDetail,
    },
    riskAssessment: {
      completed: riskCompleted,
      label: riskLabel,
      detail: riskDetail,
    },
  };
}

function taskTypeIconForLabel(typeLabel: string): React.ReactNode {
  const lower = typeLabel.toLowerCase();
  if (lower.includes('call') || lower.includes('phone'))
    return <Phone size={12} className="tw-task-type-icon" />;
  if (lower.includes('letter') || lower.includes('email'))
    return <Mail size={12} className="tw-task-type-icon" />;
  if (lower.includes('conflict') || lower.includes('aml'))
    return <ShieldAlert size={12} className="tw-task-type-icon" />;
  if (lower.includes('review')) return <Search size={12} className="tw-task-type-icon" />;
  if (lower.includes('meeting') || lower.includes('hearing'))
    return <Calendar size={12} className="tw-task-type-icon" />;
  return <FileText size={12} className="tw-task-type-icon" />;
}

export function MatterProfileClient({
  matter,
  initialTab,
  people,
  organisations,
  values,
  tasks = [],
  teams = [],
  enquiries = [],
  quotes = [],
  currentUserId = '',
  currentUserRole = 'admin',
  currentUser,
  employees,
  keyDatesConfig,
  keyDates = [],
  keyDateNotApplicable = [],
  keyDateReminderStates = [],
  keyDateCalendarSyncs = [],
  userKeyDatePermissions = [],
  userPermissions = [],
  userRoles = [],
  registersConfig,
  registerTypes = [],
  matterRegisterRecords = [],
  matterRegisterTransitions = {},
  openingGateState,
  canViewClientCdd = true,
  canVerifyByKeyDateId,
  canTakeByTaskId,
  canViewFinance = false,
  canLiftRestriction = false,
  canEditMatter = false,
  pmsView,
  engagementDispatches = [],
  engagementChases = [],
  signedEngagementDownloadUrl = null,
  effectiveMoneyOnAccountConfig,
  moneyOnAccountRequests = [],
  moneyOnAccountReceipts = [],
  moneyOnAccountChases = [],
  unmatchedPmsClientReceipts = [],
  moaReceiptDownloadUrls = {},
  moneyOnAccountAgreedPence = null,
  moneyOnAccountBankConfigured = false,
  canViewMoneyOnAccount = false,
  canRequestMoneyOnAccount = false,
  canRecordMoneyOnAccountReceipt = false,
  canMatchPmsClientLedgerReceipt = false,
  emailProviderDisabled = false,
  firmName,
  notes,
  audit,
}: MatterProfileClientProps) {
  const router = useRouter();
  const { showToast } = useToast();
  const [tab, setTab] = useState<MatterTab>(() => {
    const valid: MatterTab[] = [
      'overview',
      'parties',
      'documents',
      'tasks',
      ...(canViewFinance ? (['finance'] as const) : []),
      'compliance',
      'activity',
      'record',
    ];
    return valid.includes(initialTab as MatterTab) ? (initialTab as MatterTab) : 'overview';
  });
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [liftOpen, setLiftOpen] = useState(false);
  const [liftType, setLiftType] = useState<'ethical_wall' | 'staff_matter'>(
    matter.hasEthicalWall ? 'ethical_wall' : 'staff_matter',
  );
  const [liftReason, setLiftReason] = useState('');
  const [liftingRestriction, setLiftingRestriction] = useState(false);
  const [liftError, setLiftError] = useState<string | null>(null);
  const [conflictRecordMinimised, setConflictRecordMinimised] = useState(false);
  const [riskRecordMinimised, setRiskRecordMinimised] = useState(false);
  const [activityConflictExpanded, setActivityConflictExpanded] = useState(false);
  const [activityRiskExpanded, setActivityRiskExpanded] = useState(false);
  const [openingSnapshotPreviewOpen, setOpeningSnapshotPreviewOpen] = useState(false);
  const [extraConflictRuns, setExtraConflictRuns] = useState<
    ConflictCheckRecord['runs']
  >([]);
  const [docAssemblyOpen, setDocAssemblyOpen] = useState(false);
  const [matterRowVersion, setMatterRowVersion] = useState<number>(
    matter.rowVersion ?? 1,
  );
  const [lifecycleDrawerOpen, setLifecycleDrawerOpen] = useState(false);
  const [lifecycleClosedOn, setLifecycleClosedOn] = useState(() =>
    (matter.closedAt ?? new Date().toISOString()).slice(0, 10),
  );
  const [lifecycleReason, setLifecycleReason] = useState('');
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [savingLifecycle, setSavingLifecycle] = useState(false);
  const [pendingRegisterCreateTypeKey, setPendingRegisterCreateTypeKey] = useState<
    string | undefined
  >(undefined);
  const registersSectionRef = useRef<HTMLElement | null>(null);
  const registersWorkspaceRef = useRef<{
    openCreatePanel: (preferredTypeKey?: string) => void;
  } | null>(null);
  const [openingBusy, setOpeningBusy] = useState(false);
  const [overrideModalKey, setOverrideModalKey] = useState<OpeningGatePreconditionKey | null>(
    null,
  );
  const [overrideReason, setOverrideReason] = useState('');
  const [revokeModalOverride, setRevokeModalOverride] = useState<{
    preconditionKey: OpeningGatePreconditionKey;
    overrideId: string;
  } | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [hroRejectOpen, setHroRejectOpen] = useState(false);
  const [hroRejectComment, setHroRejectComment] = useState('');
  const engagementPanelRef = useRef<HTMLElement | null>(null);
  const engagementFileInputRef = useRef<HTMLInputElement | null>(null);
  const defaultEngagementContact = useMemo(() => {
    const instPerson = matter.instructingContactId
      ? people.find((p) => p.id === matter.instructingContactId)
      : undefined;
    const clientPerson = people.find((p) => p.id === matter.clientId);
    const clientOrg = organisations.find((o) => o.id === matter.clientId);
    const sourceEnq = matter.sourceEnquiryId
      ? enquiries.find((e) => e.id === matter.sourceEnquiryId)
      : enquiries.find((e) => e.convertedMatterId === matter.id);
    const email =
      (instPerson ? primaryEmail(instPerson) : '') ||
      (clientPerson ? primaryEmail(clientPerson) : '') ||
      clientOrg?.generalEmail ||
      sourceEnq?.email ||
      '';
    const name =
      (instPerson ? personDisplayName(instPerson) : '') ||
      (clientPerson ? personDisplayName(clientPerson) : '') ||
      clientOrg?.legalName ||
      (sourceEnq ? `${sourceEnq.firstName} ${sourceEnq.lastName}`.trim() : '') ||
      '';
    return { email, name };
  }, [matter.instructingContactId, matter.clientId, matter.sourceEnquiryId, matter.id, people, organisations, enquiries]);
  const [engagementRecipientEmail, setEngagementRecipientEmail] = useState(
    defaultEngagementContact.email,
  );
  const [engagementRecipientName, setEngagementRecipientName] = useState(
    defaultEngagementContact.name,
  );
  const [engagementIntroNote, setEngagementIntroNote] = useState('');
  const [engagementSignedNote, setEngagementSignedNote] = useState('');
  const [engagementSelectedFile, setEngagementSelectedFile] = useState<File | null>(null);
  const [engagementBusy, setEngagementBusy] = useState(false);
  const engagementSendControllerRef = useRef<ReturnType<
    typeof createSendIdempotencyController
  > | null>(null);
  const getEngagementSendController = () => {
    if (!engagementSendControllerRef.current) {
      engagementSendControllerRef.current = createSendIdempotencyController();
    }
    return engagementSendControllerRef.current;
  };
  useEffect(() => {
    engagementSendControllerRef.current?.reset();
  }, [matter.id]);
  const activeEngagementChase = useMemo(
    () =>
      engagementChases.find(
        (c) => c.chase.status === 'active' || c.chase.status === 'needs_owner',
      ) ??
      (engagementChases[0]?.chase.status === 'failed'
        ? engagementChases[0]
        : null),
    [engagementChases],
  );
  const moaPanelRef = useRef<HTMLElement | null>(null);
  const moaReceiptFileInputRef = useRef<HTMLInputElement | null>(null);
  const moaSendControllerRef = useRef<ReturnType<
    typeof createSendIdempotencyController
  > | null>(null);
  const getMoaSendController = () => {
    if (!moaSendControllerRef.current) {
      moaSendControllerRef.current = createSendIdempotencyController();
    }
    return moaSendControllerRef.current;
  };
  useEffect(() => {
    moaSendControllerRef.current?.reset();
  }, [matter.id]);
  const [moaRequestAmountGbp, setMoaRequestAmountGbp] = useState<string>(() =>
    typeof moneyOnAccountAgreedPence === 'number' && moneyOnAccountAgreedPence > 0
      ? minorUnitsToPounds(moneyOnAccountAgreedPence).toFixed(2)
      : '',
  );
  const [moaRecipientEmail, setMoaRecipientEmail] = useState(
    () => defaultEngagementContact.email,
  );
  const [moaRecipientName, setMoaRecipientName] = useState(
    () => defaultEngagementContact.name,
  );
  const [moaRequestNotes, setMoaRequestNotes] = useState('');
  const [moaBusy, setMoaBusy] = useState(false);
  const [cancelTargetRequestId, setCancelTargetRequestId] = useState<string | null>(null);
  const [cancelRequestReason, setCancelRequestReason] = useState('');
  const [reverseTargetReceiptId, setReverseTargetReceiptId] = useState<string | null>(null);
  const [reverseReceiptReason, setReverseReceiptReason] = useState('');

  const moaSummaryMetrics = useMemo(() => {
    const unreversedByRequestId = new Map<string, number>();
    const receiptsByRequestId = new Map<string, MoneyOnAccountReceiptRecord[]>();
    for (const rcpt of moneyOnAccountReceipts) {
      const list = receiptsByRequestId.get(rcpt.requestId) ?? [];
      list.push(rcpt);
      receiptsByRequestId.set(rcpt.requestId, list);
      if (!rcpt.reversedAt) {
        unreversedByRequestId.set(
          rcpt.requestId,
          (unreversedByRequestId.get(rcpt.requestId) ?? 0) + rcpt.amountPence,
        );
      }
    }
    const nonCancelledRequests = moneyOnAccountRequests.filter(
      (r) => r.status !== 'cancelled',
    );
    const activeOpenRequests = moneyOnAccountRequests.filter(
      (r) => r.status === 'requested' || r.status === 'part_received',
    );
    const requestedPence = nonCancelledRequests.reduce(
      (sum, r) => sum + r.requestedAmountPence,
      0,
    );
    const receivedPence = nonCancelledRequests.reduce(
      (sum, r) => sum + (unreversedByRequestId.get(r.id) ?? 0),
      0,
    );
    const fundsPre = openingGateState?.evaluation.preconditions.find(
      (p) => p.key === 'funds_on_account',
    );
    return {
      unreversedByRequestId,
      receiptsByRequestId,
      nonCancelledRequests,
      activeOpenRequests,
      requestedPence,
      receivedPence,
      fundsPre: fundsPre ?? null,
    };
  }, [moneyOnAccountRequests, moneyOnAccountReceipts, openingGateState]);

  const [moaReceiptRequestId, setMoaReceiptRequestId] = useState<string>('');
  const selectedReceiptRequestId = moaSummaryMetrics.activeOpenRequests.some(
    (r) => r.id === moaReceiptRequestId,
  )
    ? moaReceiptRequestId
    : (moaSummaryMetrics.activeOpenRequests[0]?.id ?? '');
  const [moaReceiptAmountGbp, setMoaReceiptAmountGbp] = useState<string>(() => {
    const firstOpen = moneyOnAccountRequests.find(
      (r) => r.status === 'requested' || r.status === 'part_received',
    );
    if (!firstOpen) return '';
    const rec = moneyOnAccountReceipts
      .filter((x) => x.requestId === firstOpen.id && !x.reversedAt)
      .reduce((s, x) => s + x.amountPence, 0);
    const remaining = Math.max(0, firstOpen.requestedAmountPence - rec);
    return remaining > 0 ? minorUnitsToPounds(remaining).toFixed(2) : '';
  });
  const [moaReceiptDate, setMoaReceiptDate] = useState<string>(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [moaReceiptBankRef, setMoaReceiptBankRef] = useState('');
  const [moaReceiptNotes, setMoaReceiptNotes] = useState('');
  const [moaReceiptFile, setMoaReceiptFile] = useState<File | null>(null);
  const [selectedPmsMoaTxId, setSelectedPmsMoaTxId] = useState<string>('');
  const effectiveSelectedPmsMoaTxId = unmatchedPmsClientReceipts.some(
    (tx) => tx.transaction_id === selectedPmsMoaTxId,
  )
    ? selectedPmsMoaTxId
    : (unmatchedPmsClientReceipts[0]?.transaction_id ?? '');
  const [pmsMatchRequestId, setPmsMatchRequestId] = useState<string>('');
  const effectivePmsMatchRequestId = moaSummaryMetrics.activeOpenRequests.some(
    (r) => r.id === pmsMatchRequestId,
  )
    ? pmsMatchRequestId
    : (moaSummaryMetrics.activeOpenRequests[0]?.id ?? '');
  const canApproveReg = userPermissions.includes('register:approve');
  const isPartnerOrMpRole =
    canApproveReg &&
    (userRoles.includes('partner') || userRoles.includes('managing_partner'));
  const isRiskComplianceRole =
    canApproveReg && userRoles.includes('risk_compliance');
  const isMatterLeadOrResponsible = Boolean(
    currentUserId &&
      (currentUserId === matter.leadFeeEarnerId ||
        currentUserId === matter.responsiblePartnerId),
  );
  const canViewRegisters = userPermissions.includes('register:view');
  const isMatterCurrentlyClosed = isClosedMatterStatus(matter.matterStatusId, values);

  const canViewMatterRegisters = Boolean(
    registersConfig &&
      (userPermissions.includes('register:view') ||
        userPermissions.includes('undertaking:manage')),
  );
  const canCreateMatterUndertaking = Boolean(
    registersConfig &&
      userPermissions.includes('undertaking:manage') &&
      registerTypes.some((t) => t.key === 'undertaking' && t.enabled),
  );
  const matterUndertakingRecords = useMemo(
    () => matterRegisterRecords.filter((r) => r.registerTypeKey === 'undertaking'),
    [matterRegisterRecords],
  );
  const openMatterUndertakingsCount = useMemo(
    () =>
      matterUndertakingRecords.filter(
        (r) => r.status === 'open' || r.status === 'varied' || r.status === 'overdue',
      ).length,
    [matterUndertakingRecords],
  );

  function handleOpenNewUndertaking(): void {
    if (tab === 'compliance' && registersWorkspaceRef.current) {
      registersWorkspaceRef.current.openCreatePanel('undertaking');
      registersSectionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      return;
    }
    setPendingRegisterCreateTypeKey('undertaking');
    setTab('compliance');
    setTimeout(() => {
      registersSectionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    }, 50);
  }

  const nameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of organisations) map.set(o.id, o.legalName);
    for (const p of people) {
      const cleanName = [p.firstName, p.surname].filter(Boolean).join(' ').trim();
      map.set(p.id, cleanName || personDisplayName(p));
    }
    return map;
  }, [organisations, people]);

  const resolvedConflictRecord = useMemo(
    () => resolveMatterConflictCheckRecord(matter, people, organisations),
    [matter, people, organisations],
  );

  const resolvedRiskAssessment = useMemo(
    () => resolveMatterRiskAssessment(matter, people, values),
    [matter, people, values],
  );

  const intakeComplianceRows = useMemo(
    () =>
      resolveMatterIntakeComplianceRows(matter, resolvedRiskAssessment, {
        canViewClientCdd,
      }),
    [matter, resolvedRiskAssessment, canViewClientCdd],
  );

  const sourceEnquiry = useMemo(
    () =>
      matter.sourceEnquiryId
        ? enquiries.find((e) => e.id === matter.sourceEnquiryId) ?? null
        : enquiries.find((e) => e.convertedMatterId === matter.id) ?? null,
    [matter.sourceEnquiryId, matter.id, enquiries],
  );

  const openingSnapshot = useMemo(
    () =>
      resolveMatterOpeningSnapshot(
        matter,
        people,
        organisations,
        values,
        enquiries,
        quotes,
        {
          riskAssessment: resolvedRiskAssessment,
          conflictCheckRecord: resolvedConflictRecord,
          nameMap,
          sourceEnquiry,
          firmName,
        },
      ),
    [
      matter,
      people,
      organisations,
      values,
      enquiries,
      quotes,
      resolvedRiskAssessment,
      resolvedConflictRecord,
      nameMap,
      sourceEnquiry,
      firmName,
    ],
  );

  const activityItemsCount = notes.length + (sourceEnquiry ? 1 : 0) + 3; // +3 for Conflict check record, Matter risk assessment, and Matter opening snapshot PDF

  const clientLabel = nameMap.get(matter.clientId) ?? matter.clientId;
  const practiceLabel = resolveLabel(values, matter.practiceAreaId);
  const subcatLabel = resolveLabel(values, matter.workTypeSubcategoryId);
  const { label: statusPillLabel, tone: statusPillTone } = resolveMatterStatusPill(
    matter,
    values,
  );
  const stageLabel = resolveLabel(values, matter.stageId);
  const milestoneLabel = resolveLabel(values, matter.milestoneId);
  const matterTypeLabel = resolveLabel(values, matter.matterTypeId);
  const billingBasisLabel = resolveLabel(values, matter.billingBasisId);
  const riskLabel = resolveLabel(values, matter.riskRatingId) || 'Medium';
  const shortRiskLabel = riskLabel.replace(/\s*\(.*\)/, '').trim() || 'Medium';
  const sizeLabel = resolveLabel(values, matter.matterSizeId);
  const tierLabel = resolveLabel(values, matter.clientTierId);
  const sectorLabel = resolveLabel(values, matter.clientSectorId);
  const jurGroupLabel = resolveLabel(values, matter.jurisdictionGroupId);
  const jurSystemLabels = resolveLabels(values, matter.jurisdictionIds);
  const govLawLabel = resolveLabel(values, matter.governingLawId);
  const originLabel = resolveLabel(values, matter.referrerTypeId);

  const responsiblePartnerName = matter.responsiblePartnerId
    ? nameMap.get(matter.responsiblePartnerId) ?? 'Unassigned'
    : 'Unassigned';

  const openedDisplay = formatDayMonthYear(matter.openedAt);

  // Determine 6-stage progress track
  const initialStageIdx = useMemo(() => {
    const m = stageLabel.match(/Stage\s+(\d+)/i);
    if (m) return Math.min(6, Math.max(1, Number(m[1]))) - 1;
    return 3; // Stage 4 of 6 (0-indexed = 3)
  }, [stageLabel]);

  const [stageIdxState, setStageIdxState] = useState<{
    baseIdx: number;
    value: number;
  }>({ baseIdx: initialStageIdx, value: initialStageIdx });
  const currentStageIdx =
    stageIdxState.baseIdx === initialStageIdx
      ? stageIdxState.value
      : initialStageIdx;
  const setCurrentStageIdx = (next: number) =>
    setStageIdxState({ baseIdx: initialStageIdx, value: next });

  const stageSteps = useMemo<StageStepItem[]>(() => {
    return [
      {
        name: 'Intake',
        completedDetail:
          formatShortDayMonth(matter.openedAt) !== '—'
            ? `Done ${formatShortDayMonth(matter.openedAt)}`
            : 'Done',
      },
      { name: 'Matter opening' },
      { name: 'Due diligence' },
      { name: 'Drafting & negotiation' },
      {
        name: 'Execution / completion',
        upcomingDetail: matter.targetCompletionAt
          ? `Target ${formatShortDayMonth(matter.targetCompletionAt)}`
          : undefined,
      },
      { name: 'Close', upcomingDetail: '—' },
    ];
  }, [matter.openedAt, matter.targetCompletionAt]);

  async function persistStageIdx(nextIdx: number) {
    const prevIdx = currentStageIdx;
    const bounded = Math.max(0, Math.min(stageSteps.length - 1, nextIdx));
    setCurrentStageIdx(bounded);
    const matchingStage = values.find(
      (v) =>
        v.listKey === 'matter_stage' &&
        !v.parentId &&
        v.label.toLowerCase().startsWith(`stage ${bounded + 1}`),
    );
    if (matchingStage) {
      const res = await saveMatterAction(
        {
          title: matter.title,
          clientId: matter.clientId,
          practiceAreaId: matter.practiceAreaId,
          workTypeSubcategoryId: matter.workTypeSubcategoryId,
          stageId: matchingStage.id,
          rowVersion: matterRowVersion,
        },
        { id: matter.id, expectedRowVersion: matterRowVersion },
      );
      if (res.errors && Object.keys(res.errors).length > 0) {
        setCurrentStageIdx(prevIdx);
        showToast(Object.values(res.errors)[0] ?? 'Could not update matter stage');
        return;
      }
      if (res.matter?.rowVersion != null) {
        setMatterRowVersion(res.matter.rowVersion);
      }
      router.refresh();
    }
    showToast(`Moved matter to Stage ${bounded + 1}: ${stageSteps[bounded].name}`);
  }

  function handleMovePrevStage() {
    if (currentStageIdx > 0) {
      void persistStageIdx(currentStageIdx - 1);
    } else {
      showToast('Matter is already at Stage 1');
    }
  }

  function handleMoveNextStage() {
    if (currentStageIdx < stageSteps.length - 1) {
      void persistStageIdx(currentStageIdx + 1);
    } else {
      showToast('Matter is already at the final stage');
    }
  }

  // Financials data
  const pmsFin = canViewFinance ? (pmsView?.matterBundle?.summary ?? null) : null;
  const financials = useMemo(() => {
    if (!canViewFinance) {
      return {
        budget: 0,
        billedPaid: 0,
        billedUnpaid: 0,
        overdueSub: '',
        unbilledWip: 0,
        remainingBudget: 0,
        budgetUsedPct: 0,
        matterProgressPct: 0,
        footerText: '',
      };
    }

    if (!pmsFin) {
      const budget = matter.agreedFeeCapGbp ?? matter.feeEstimateGbp ?? 0;
      const clientAcct = matter.retainerMoniesOnAccountGbp ?? 0;
      const matterProgressPct = Math.min(
        100,
        Math.round(((currentStageIdx + 0.48) / stageSteps.length) * 100),
      );
      return {
        budget,
        billedPaid: 0,
        billedUnpaid: 0,
        overdueSub: '',
        unbilledWip: 0,
        remainingBudget: budget,
        budgetUsedPct: 0,
        matterProgressPct,
        footerText: `${billingBasisLabel || 'Billing basis not set'} · Not linked to PMS · Client account £${clientAcct.toLocaleString('en-GB')}`,
      };
    }

    const budgetPence =
      pmsFin.fee_estimate && pmsFin.fee_estimate > 0
        ? resolvePmsPence(pmsFin.fee_estimate_pence, pmsFin.fee_estimate)
        : matter.agreedFeeCapGbp !== null && matter.agreedFeeCapGbp !== undefined
          ? poundsToMinorUnits(matter.agreedFeeCapGbp)
          : matter.feeEstimateGbp !== null && matter.feeEstimateGbp !== undefined
            ? poundsToMinorUnits(matter.feeEstimateGbp)
            : 0;
    const budget = minorUnitsToPounds(budgetPence);
    const totalBilledPence = resolvePmsPence(pmsFin.fees_billed_pence, pmsFin.fees_billed);
    const billedUnpaidPence = resolvePmsPence(
      pmsFin.outstanding_debt_pence,
      pmsFin.outstanding_debt,
    );
    const billedUnpaid = pmsFin.outstanding_debt;
    const billedPaidPence = Math.max(
      0,
      subtractMinorUnits(totalBilledPence, billedUnpaidPence),
    );
    const billedPaid = minorUnitsToPounds(billedPaidPence);
    const unbilledWipPence = resolvePmsPence(
      pmsFin.unbilled_wip_pence,
      pmsFin.unbilled_wip,
    );
    const unbilledWip = pmsFin.unbilled_wip;
    const usedTotalPence = sumMinorUnits([
      billedPaidPence,
      billedUnpaidPence,
      unbilledWipPence,
    ]);
    const usedTotal = minorUnitsToPounds(usedTotalPence);
    const remainingBudget = Math.max(
      0,
      minorUnitsToPounds(subtractMinorUnits(budgetPence, usedTotalPence)),
    );
    const budgetUsedPct = budget > 0 ? Math.min(100, Math.round((usedTotal / budget) * 100)) : 0;
    const matterProgressPct = Math.min(
      100,
      Math.round(((currentStageIdx + 0.48) / stageSteps.length) * 100),
    );
    const clientAcct = pmsFin.client_account_balance ?? matter.retainerMoniesOnAccountGbp ?? 0;
    const footerParts = [
      billingBasisLabel || pmsFin.billing_basis || null,
      `Client account £${clientAcct.toLocaleString('en-GB')}`,
    ].filter(Boolean);

    return {
      budget,
      billedPaid,
      billedUnpaid,
      overdueSub:
        billedUnpaid > 0 && (pmsFin.max_invoice_days_past_due ?? 0) > 0
          ? 'Invoice overdue'
          : '',
      unbilledWip,
      remainingBudget,
      budgetUsedPct,
      matterProgressPct,
      footerText: footerParts.join(' · '),
    };
  }, [
    canViewFinance,
    pmsFin,
    matter.agreedFeeCapGbp,
    matter.feeEstimateGbp,
    matter.retainerMoniesOnAccountGbp,
    currentStageIdx,
    stageSteps.length,
    billingBasisLabel,
  ]);

  // SVG Donut geometry
  const donutSegments = useMemo(() => {
    const r = 44;
    const c = 2 * Math.PI * r;
    const total =
      financials.billedPaid +
        financials.billedUnpaid +
        financials.unbilledWip +
        financials.remainingBudget || 1;
    const valuesList = [
      { val: financials.billedPaid, color: 'var(--color-primary)' },
      { val: financials.billedUnpaid, color: '#9e6730' },
      { val: financials.unbilledWip, color: '#84b59f' },
      { val: financials.remainingBudget, color: 'var(--tw-track)' },
    ];
    let cumulative = 0;
    return valuesList.map((seg) => {
      const len = (seg.val / total) * c;
      const offset = -cumulative;
      cumulative += len;
      return {
        color: seg.color,
        dasharray: `${Math.max(0, len)} ${c}`,
        dashoffset: offset,
      };
    });
  }, [financials]);

  // Matter tasks for the Home-style task widget
  const realMatterTasks = useMemo(
    () =>
      tasks.filter(
        (t) =>
          t.status !== 'Done' &&
          t.status !== 'Cancelled' &&
          t.linkedRecords.some((lr) => lr.recordType === 'matter' && lr.recordId === matter.id),
      ),
    [tasks, matter.id],
  );

  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const widgetTasks = useMemo(() => {
    return realMatterTasks.map((t) => {
      const typeLabel = resolveLabel(values, t.taskTypeId) || 'Review';
      const assigneeName = t.assignedPersonId
        ? nameMap.get(t.assignedPersonId) ?? 'Unassigned'
        : 'Unassigned';
      const isOverdue = Boolean(t.dueAt && t.dueAt.slice(0, 10) < todayIso);
      return {
        id: t.id,
        realTask: t,
        title: t.title,
        typeLabel,
        assigneeName,
        dueLabel: `Due ${formatShortDayMonth(t.dueAt)}`,
        overdue: isOverdue,
      };
    });
  }, [realMatterTasks, values, nameMap, todayIso]);

  const overdueWidgetTasks = useMemo(
    () => widgetTasks.filter((t) => t.overdue),
    [widgetTasks],
  );
  const upcomingWidgetTasks = useMemo(
    () => widgetTasks.filter((t) => !t.overdue),
    [widgetTasks],
  );

  async function handleCompleteWidgetTask(item: (typeof widgetTasks)[number]) {
    if (item.realTask) {
      const t = item.realTask;
      await saveTaskAction({
        id: t.id,
        title: t.title,
        description: t.description,
        taskTypeId: t.taskTypeId,
        priorityId: t.priorityId,
        dueAt: t.dueAt,
        assignedTeamId: t.assignedTeamId,
        assignedPersonId: t.assignedPersonId ?? currentUserId,
        status: 'Done',
        linkedRecords: t.linkedRecords,
      });
      showToast(`Completed ${t.reference} — ${t.title}`);
      router.refresh();
    }
  }

  // Parties list for Overview and Parties tab
  const overviewParties = useMemo(() => {
    const partiesEdited = Boolean(matter.fieldValues['partiesEdited']);

    const list: {
      id: string;
      name: string;
      href?: string;
      sub: string;
      badge: string;
      tone: 'positive' | 'neutral' | 'warning';
    }[] = [
      {
        id: `client-${matter.clientId}`,
        name: clientLabel,
        href: hrefForId(matter.clientId),
        sub: `Our client${matter.fieldValues['FG02-001'] ? ` · ${String(matter.fieldValues['FG02-001'])}` : ''}`,
        badge: 'Client',
        tone: 'positive',
      },
    ];

    const extraClientIds = Array.from(
      new Set([
        ...(matter.additionalClientIds ?? []),
        ...((matter.fieldValues['additionalClientIds'] as string[] | undefined) ?? []),
      ]),
    );
    for (const extraCid of extraClientIds) {
      if (!extraCid || extraCid === matter.clientId) continue;
      list.push({
        id: `client-${extraCid}`,
        name: nameMap.get(extraCid) ?? extraCid,
        href: hrefForId(extraCid),
        sub: 'Our client',
        badge: 'Client',
        tone: 'positive',
      });
    }

    if (
      matter.instructingContactId &&
      matter.instructingContactId !== matter.clientId &&
      !extraClientIds.includes(matter.instructingContactId)
    ) {
      const contactPerson = people.find((p) => p.id === matter.instructingContactId);
      list.push({
        id: `inst-${matter.instructingContactId}`,
        name: nameMap.get(matter.instructingContactId) ?? matter.instructingContactId,
        href: hrefForId(matter.instructingContactId),
        sub: ['Instructing contact', contactPerson?.jobTitle].filter(Boolean).join(' · '),
        badge: 'Client contact',
        tone: 'neutral',
      });
    }

    for (const p of matter.parties) {
      const presentation = resolveOverviewPartyPresentation(p);
      list.push({
        id: p.id,
        name: p.name,
        href: p.linkedRecordId ? hrefForId(p.linkedRecordId) : undefined,
        sub: presentation.sub,
        badge: presentation.badge,
        tone: presentation.tone,
      });
    }

    if (
      !partiesEdited &&
      matter.forumCourt &&
      !matter.parties.some((p) =>
        p.name.toLowerCase().includes(matter.forumCourt.toLowerCase()),
      )
    ) {
      list.push({
        id: 'forum-court',
        name: matter.forumCourt,
        href: undefined,
        sub: matter.fieldValues['FG02-002']
          ? `Court / tribunal · Case no. ${String(matter.fieldValues['FG02-002'])}`
          : 'Forum / court / registry',
        badge: 'Court / tribunal',
        tone: 'neutral',
      });
    }

    return list;
  }, [clientLabel, matter, nameMap, people]);

  const rule = useMemo(() => findSubcategoryRule(subcatLabel), [subcatLabel]);
  const activeGroups = useMemo(() => fieldGroupsForSubcategory(subcatLabel), [subcatLabel]);
  const specificFields = useMemo(() => specificFieldsForSubcategory(subcatLabel), [subcatLabel]);
  const criticalDates = useMemo(
    () => extractCriticalDates(matter, subcatLabel),
    [matter, subcatLabel],
  );

  // Key dates for right sidebar
  const keyDatesList = useMemo(() => {
    const items = criticalDates.slice(0, 4).map((cd) => {
      const { month, day } = parseMonthAndDay(cd.date);
      const isOverdue = Boolean(cd.date && cd.date.slice(0, 10) < todayIso);
      return {
        id: cd.fieldId,
        month,
        day,
        title: cd.label,
        sub: `Critical date · ${cd.fieldId}`,
        pill: isOverdue ? 'Overdue' : '',
        pillTone: isOverdue ? ('warning' as const) : ('neutral' as const),
        overdue: isOverdue,
      };
    });

    if (items.length === 0 && matter.targetCompletionAt) {
      const { month, day } = parseMonthAndDay(matter.targetCompletionAt);
      items.push({
        id: 'target-completion',
        month,
        day,
        title: 'Target completion date',
        sub: formatDayMonthYear(matter.targetCompletionAt),
        pill: 'Target',
        pillTone: 'neutral',
        overdue: false,
      });
    }

    return items;
  }, [criticalDates, matter.targetCompletionAt, todayIso]);

  // Team members for right sidebar
  const teamMembersList = useMemo(() => {
    const customRoles =
      (matter.fieldValues['teamMemberRoles'] as Record<string, string> | undefined) ?? {};

    const list: {
      id: string;
      initials: string;
      name: string;
      role: string;
      hours: string;
      avatarBg: string;
      avatarColor: string;
    }[] = [];
    const seen = new Set<string>();

    const hoursForMember = (memberName: string): string => {
      if (!canViewFinance || !pmsView?.matterBundle?.timeEntries) return '';
      const target = memberName.trim().toLowerCase();
      if (!target) return '';
      const total = pmsView.matterBundle.timeEntries
        .filter((te) => (te.fee_earner_name ?? '').trim().toLowerCase() === target)
        .reduce((sum, te) => sum + te.hours, 0);
      return total > 0 ? `${total.toFixed(1)} h` : '';
    };

    if (matter.responsiblePartnerId) {
      const nm = nameMap.get(matter.responsiblePartnerId) ?? matter.responsiblePartnerId;
      seen.add(matter.responsiblePartnerId);
      const isAlsoFeeEarner = matter.leadFeeEarnerId === matter.responsiblePartnerId;
      list.push({
        id: matter.responsiblePartnerId,
        initials: initialsOfName(nm),
        name: nm,
        role: isAlsoFeeEarner ? 'Responsible partner & Fee earner' : 'Responsible partner',
        hours: hoursForMember(nm),
        avatarBg: 'var(--pill-positive-bg)',
        avatarColor: 'var(--pill-positive-fg)',
      });
    }

    if (matter.leadFeeEarnerId && !seen.has(matter.leadFeeEarnerId)) {
      const nm = nameMap.get(matter.leadFeeEarnerId) ?? matter.leadFeeEarnerId;
      seen.add(matter.leadFeeEarnerId);
      const emp = people.find((p) => p.id === matter.leadFeeEarnerId);
      const roleLabel = emp?.jobTitle
        ? `Fee earner · ${emp.jobTitle.split(',')[0]}`
        : 'Lead fee earner';
      list.push({
        id: matter.leadFeeEarnerId,
        initials: initialsOfName(nm),
        name: nm,
        role: roleLabel,
        hours: hoursForMember(nm),
        avatarBg: 'var(--blue-bg)',
        avatarColor: 'var(--blue-text)',
      });
    }

    if (matter.supervisingPartnerId && !seen.has(matter.supervisingPartnerId)) {
      const nm = nameMap.get(matter.supervisingPartnerId) ?? matter.supervisingPartnerId;
      seen.add(matter.supervisingPartnerId);
      list.push({
        id: matter.supervisingPartnerId,
        initials: initialsOfName(nm),
        name: nm,
        role: customRoles[matter.supervisingPartnerId] || 'Supervising partner',
        hours: hoursForMember(nm),
        avatarBg: 'var(--pill-positive-bg)',
        avatarColor: 'var(--pill-positive-fg)',
      });
    }

    if (matter.relationshipPartnerId && !seen.has(matter.relationshipPartnerId)) {
      const nm = nameMap.get(matter.relationshipPartnerId) ?? matter.relationshipPartnerId;
      seen.add(matter.relationshipPartnerId);
      list.push({
        id: matter.relationshipPartnerId,
        initials: initialsOfName(nm),
        name: nm,
        role: customRoles[matter.relationshipPartnerId] || 'Relationship partner',
        hours: hoursForMember(nm),
        avatarBg: 'var(--pill-positive-bg)',
        avatarColor: 'var(--pill-positive-fg)',
      });
    }

    for (const tid of matter.teamMemberIds) {
      if (seen.has(tid)) continue;
      seen.add(tid);
      const nm = nameMap.get(tid) ?? tid;
      const emp = people.find((p) => p.id === tid);
      const roleLabel = customRoles[tid] || emp?.jobTitle || 'Team member';
      list.push({
        id: tid,
        initials: initialsOfName(nm),
        name: nm,
        role: roleLabel,
        hours: hoursForMember(nm),
        avatarBg: 'var(--purple-bg)',
        avatarColor: 'var(--purple-text)',
      });
    }

    return list;
  }, [canViewFinance, pmsView, matter, nameMap, people]);

  function formatFieldValue(field: MatterModelField, val: unknown): React.ReactNode {
    if (val === undefined || val === null || val === '') {
      return <span className="muted">Not recorded</span>;
    }
    if (Array.isArray(val)) {
      if (val.length === 0) return <span className="muted">Not recorded</span>;
      return val.join(', ');
    }
    if (typeof val === 'object') {
      const obj = val as { primary?: unknown; secondary?: unknown };
      const parts = [obj.primary, obj.secondary]
        .filter((x) => x !== undefined && x !== null && x !== '')
        .map((x) => {
          const s = String(x);
          if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return formatDate(s);
          if (typeof x === 'number' && field.dataType.includes('Currency'))
            return `£${x.toLocaleString('en-GB')}`;
          return s;
        });
      return parts.length ? parts.join(' · ') : <span className="muted">Not recorded</span>;
    }
    if (typeof val === 'number') {
      if (field.dataType.includes('Currency')) return `£${val.toLocaleString('en-GB')}`;
      if (field.dataType.includes('Percentage')) return `${val}%`;
      return val.toLocaleString('en-GB');
    }
    const str = String(val);
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      return formatDate(str);
    }
    return str;
  }

  async function handleAddNote(e: React.FormEvent) {
    e.preventDefault();
    if (!noteText.trim()) return;
    setSavingNote(true);
    const res = await addNoteAction('matter', matter.id, noteText.trim());
    setSavingNote(false);
    if (isActionDenied(res)) {
      showToast(res.message);
      return;
    }
    setNoteText('');
    setNoteOpen(false);
    showToast('Note added');
    router.refresh();
  }

  async function handleLifecycleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSavingLifecycle(true);
    setLifecycleError(null);
    const action = isMatterCurrentlyClosed ? 'reopen' : 'close';
    const res = await updateMatterLifecycleStatusAction(matter.id, action, {
      closedAt: action === 'close' ? lifecycleClosedOn || null : null,
      reason: lifecycleReason.trim() || undefined,
      expectedRowVersion: matterRowVersion,
    });
    setSavingLifecycle(false);
    if (res.code || (res.errors && Object.keys(res.errors).length > 0)) {
      const msg =
        res.message ??
        (res.errors ? Object.values(res.errors)[0] : undefined) ??
        'Could not update matter status.';
      setLifecycleError(msg);
      return;
    }
    if (res.matter?.rowVersion != null) {
      setMatterRowVersion(res.matter.rowVersion);
    }
    setLifecycleDrawerOpen(false);
    setLifecycleReason('');
    showToast(
      action === 'close'
        ? `Matter closed — destruction due ${res.matter?.destructionDueAt ? formatDate(res.matter.destructionDueAt) : 'scheduled'}`
        : 'Matter reopened — closure and destruction dates cleared',
    );
    router.refresh();
  }

  return (
    <div className="page-list matter-profile-page">
      {/* Page Header matching Matters list & standard page header typography */}
      <div className="page-header" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1>{matter.title}</h1>
            <StatusPill label={statusPillLabel} tone={statusPillTone} />
          </div>

          <div className="summary-line" style={{ marginTop: 8 }}>
            <span>
              Client <Link href={hrefForId(matter.clientId)}>{clientLabel}</Link>
            </span>
            <span className="muted">·</span>
            <span>
              {practiceLabel} → <strong>{subcatLabel}</strong>
            </span>
            <span className="muted">·</span>
            <span>
              Responsible partner{' '}
              {matter.responsiblePartnerId ? (
                <Link href={`/people/${matter.responsiblePartnerId}`}>{responsiblePartnerName}</Link>
              ) : (
                <strong>{responsiblePartnerName}</strong>
              )}
            </span>
            <span className="muted">·</span>
            <span>Opened {openedDisplay}</span>
          </div>
        </div>

        <div
          className="page-header__actions"
          style={{ flexShrink: 0, display: 'flex', gap: 10, flexWrap: 'wrap' }}
        >
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => {
              setDocAssemblyOpen(true);
            }}
          >
            <FileText size={16} />
            <span>Generate document</span>
          </button>
          {canLiftRestriction && (matter.isStaffMatter || matter.hasEthicalWall) ? (
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => {
                setLiftType(matter.hasEthicalWall ? 'ethical_wall' : 'staff_matter');
                setLiftError(null);
                setLiftOpen((o) => !o);
              }}
            >
              <ShieldCheck size={16} />
              <span>Lift restriction</span>
            </button>
          ) : null}
          {canCreateMatterUndertaking ? (
            <button
              type="button"
              className="btn btn--secondary"
              data-testid="matter-header-new-undertaking"
              onClick={handleOpenNewUndertaking}
            >
              <ClipboardCheck size={16} />
              <span>New undertaking</span>
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => setNoteOpen((o) => !o)}
          >
            <MessageSquarePlus size={16} />
            <span>Add note</span>
          </button>
          {canEditMatter &&
          (isMatterCurrentlyClosed ||
            (!isProspectiveMatterStatus(matter.matterStatusId, values) &&
              Boolean(matter.openedAt?.trim()) &&
              !matter.matterNumber.startsWith('DRAFT'))) ? (
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => {
                setLifecycleError(null);
                setLifecycleDrawerOpen((o) => !o);
              }}
            >
              <CalendarClock size={16} />
              <span>{isMatterCurrentlyClosed ? 'Reopen matter' : 'Close matter'}</span>
            </button>
          ) : null}
          <Link href={`/matters/${matter.id}/edit`} className="btn btn--primary">
            <Edit3 size={16} />
            <span>Edit</span>
          </Link>
        </div>
      </div>

      {/* Close / Reopen Matter Lifecycle Drawer */}
      {lifecycleDrawerOpen && canEditMatter ? (
        <div
          className="home-panel"
          style={{ padding: '18px 22px', marginBottom: 22 }}
        >
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>
            {isMatterCurrentlyClosed ? 'Reopen closed matter' : 'Close matter & calculate file retention'}
          </div>
          <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
            {isMatterCurrentlyClosed
              ? 'Reopening restores active status and clears the closure date and scheduled destruction date. This action is audited.'
              : 'Closing records the closure date, checks any matter-closure key-date gates, and computes destruction_date from the work-type retention policy. Matters are never deleted automatically.'}
          </p>
          {lifecycleError ? (
            <div
              style={{
                marginBottom: 10,
                padding: '8px 12px',
                borderRadius: 6,
                background: '#fef2f2',
                border: '1px solid #ef4444',
                color: '#991b1b',
                fontSize: 13,
              }}
            >
              {lifecycleError}
            </div>
          ) : null}
          <form
            onSubmit={handleLifecycleSubmit}
            style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}
          >
            {!isMatterCurrentlyClosed ? (
              <div className="field-group" style={{ marginBottom: 0 }}>
                <label className="field-label" htmlFor="mp-close-date">
                  Closed date
                </label>
                <input
                  id="mp-close-date"
                  type="date"
                  className="field-input"
                  value={lifecycleClosedOn}
                  onChange={(e) => setLifecycleClosedOn(e.target.value)}
                />
              </div>
            ) : null}
            <div className="field-group" style={{ marginBottom: 0, flex: 1, minWidth: 220 }}>
              <label className="field-label" htmlFor="mp-lifecycle-reason">
                Reason / note
              </label>
              <input
                id="mp-lifecycle-reason"
                type="text"
                className="field-input"
                placeholder={
                  isMatterCurrentlyClosed
                    ? 'Reason for reopening this matter…'
                    : 'Completion / closure note…'
                }
                value={lifecycleReason}
                onChange={(e) => setLifecycleReason(e.target.value)}
              />
            </div>
            <button type="submit" className="btn btn--primary" disabled={savingLifecycle}>
              {savingLifecycle
                ? 'Saving…'
                : isMatterCurrentlyClosed
                  ? 'Confirm reopen'
                  : 'Confirm close'}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setLifecycleDrawerOpen(false)}
            >
              Cancel
            </button>
          </form>
        </div>
      ) : null}

      {/* Lift Restriction Drawer */}
      {liftOpen && canLiftRestriction && (matter.isStaffMatter || matter.hasEthicalWall) ? (
        <div
          className="home-panel"
          style={{ padding: '18px 22px', marginBottom: 22 }}
        >
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>
            Lift matter restriction
          </div>
          {matter.isStaffMatter && matter.hasEthicalWall ? (
            <div style={{ marginBottom: 10 }}>
              <label className="field-label" htmlFor="lift-restriction-type">
                Restriction to lift
              </label>
              <select
                id="lift-restriction-type"
                className="field-select"
                value={liftType}
                onChange={(e) =>
                  setLiftType(e.target.value as 'ethical_wall' | 'staff_matter')
                }
                style={{ marginTop: 4 }}
              >
                <option value="ethical_wall">Information barrier (ethical wall)</option>
                <option value="staff_matter">Staff matter restriction</option>
              </select>
            </div>
          ) : null}
          <label className="field-label" htmlFor="lift-restriction-reason">
            Written reason (recorded in the audit trail)
          </label>
          <textarea
            id="lift-restriction-reason"
            rows={2}
            className="field-textarea"
            placeholder="Record the compliance approval and reason for lifting this restriction…"
            value={liftReason}
            onChange={(e) => setLiftReason(e.target.value)}
            style={{ marginTop: 6, marginBottom: 10 }}
          />
          {liftError ? (
            <div
              role="alert"
              style={{
                padding: '8px 10px',
                borderRadius: 6,
                background: 'rgba(220, 38, 38, 0.08)',
                border: '1px solid var(--status-alert)',
                color: 'var(--status-alert)',
                fontSize: 12,
                marginBottom: 10,
              }}
            >
              {liftError}
            </div>
          ) : null}
          <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setLiftOpen(false);
                setLiftError(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={liftingRestriction}
              onClick={async () => {
                setLiftingRestriction(true);
                setLiftError(null);
                try {
                  const res = await liftMatterRestrictionAction(
                    matter.id,
                    liftType,
                    liftReason,
                  );
                  setLiftingRestriction(false);
                  if (res.errors && Object.keys(res.errors).length > 0) {
                    const msg =
                      res.errors.mfa ||
                      res.errors.permission ||
                      res.errors.reason ||
                      res.errors.access ||
                      Object.values(res.errors)[0] ||
                      'Could not lift matter restriction.';
                    setLiftError(msg);
                    showToast(msg);
                    return;
                  }
                  setLiftOpen(false);
                  setLiftReason('');
                  showToast('Matter restriction lifted');
                  router.refresh();
                } catch (err) {
                  setLiftingRestriction(false);
                  const msg =
                    err instanceof Error
                      ? err.message
                      : 'Could not lift matter restriction.';
                  setLiftError(msg);
                  showToast(msg);
                }
              }}
            >
              {liftingRestriction ? 'Lifting…' : 'Confirm lift restriction'}
            </button>
          </div>
        </div>
      ) : null}

      {/* Add Note Drawer */}
      {noteOpen ? (
        <form
          onSubmit={handleAddNote}
          className="home-panel"
          style={{ padding: '18px 22px', marginBottom: 22 }}
        >
          <label className="field-label" htmlFor="new-matter-note">
            New matter note / attendance note
          </label>
          <textarea
            id="new-matter-note"
            rows={3}
            className="field-textarea"
            placeholder="Record advice given, telephone attendance, milestone progress or key action…"
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            style={{ marginTop: 6, marginBottom: 12 }}
          />
          <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setNoteOpen(false)}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn--primary btn--sm" disabled={savingNote}>
              {savingNote ? 'Saving…' : 'Save note'}
            </button>
          </div>
        </form>
      ) : null}

      {/* Tabs Bar */}
      <div
        className="tabs-bar"
        role="tablist"
        aria-label="Matter sections"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'overview'}
          className={`tab-btn ${tab === 'overview' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('overview')}
        >
          Overview
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'parties'}
          className={`tab-btn ${tab === 'parties' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('parties')}
        >
          Parties ({overviewParties.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'documents'}
          className={`tab-btn ${tab === 'documents' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('documents')}
        >
          Documents
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'tasks'}
          className={`tab-btn ${tab === 'tasks' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('tasks')}
        >
          Tasks &amp; dates
        </button>
        {canViewFinance ? (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'finance'}
            className={`tab-btn ${tab === 'finance' ? 'tab-btn--active' : ''}`}
            onClick={() => setTab('finance')}
          >
            Time &amp; billing
          </button>
        ) : null}
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'compliance'}
          className={`tab-btn ${tab === 'compliance' ? 'tab-btn--active' : ''}`}
          onClick={() => {
            setPendingRegisterCreateTypeKey(undefined);
            setTab('compliance');
          }}
        >
          Compliance
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'activity'}
          className={`tab-btn ${tab === 'activity' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('activity')}
        >
          Activity ({activityItemsCount})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'record'}
          className={`tab-btn ${tab === 'record' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('record')}
        >
          Record ({audit.length})
        </button>
      </div>

      {/* ===================== TAB: OVERVIEW (Home-style 2-column grid) ===================== */}
      {tab === 'overview' ? (
        <>
          {openingGateState &&
          (openingGateState.isProspective || openingGateState.highRiskRecord) ? (
            <section
              className="home-panel"
              style={{ marginBottom: 16 }}
              data-testid="matter-opening-gate-panel"
              aria-label="Matter opening checklist and gate"
            >
              <div className="panel-header">
                <div className="panel-title-group">
                  <h2 className="panel-title">Matter opening checklist &amp; gate</h2>
                  <StatusPill
                    label={
                      !openingGateState.isProspective
                        ? 'Opened'
                        : openingGateState.evaluation.canOpen
                          ? 'Ready to open'
                          : openingGateState.highRiskRecord?.status === 'pending_partner'
                            ? 'Pending Partner approval'
                            : openingGateState.highRiskRecord?.status === 'pending_compliance'
                              ? 'Pending Risk & Compliance approval'
                              : 'Blocked'
                    }
                    tone={
                      !openingGateState.isProspective || openingGateState.evaluation.canOpen
                        ? 'positive'
                        : 'warning'
                    }
                  />
                </div>
                <div className="panel-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {openingGateState.isProspective &&
                  openingGateState.canEditMatter &&
                  !isMatterEngagementSignedForGate(matter) ? (
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      data-testid="scroll-engagement-upload-btn"
                      disabled={openingBusy || engagementBusy}
                      onClick={() => {
                        engagementPanelRef.current?.scrollIntoView?.({
                          behavior: 'smooth',
                          block: 'start',
                        });
                      }}
                    >
                      Upload signed copy
                    </button>
                  ) : null}
                  {openingGateState.isProspective &&
                  canViewMoneyOnAccount &&
                  moaSummaryMetrics.fundsPre?.required &&
                  !moaSummaryMetrics.fundsPre.satisfied ? (
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      data-testid="scroll-moa-panel-btn"
                      disabled={openingBusy || moaBusy}
                      onClick={() => {
                        moaPanelRef.current?.scrollIntoView?.({
                          behavior: 'smooth',
                          block: 'start',
                        });
                      }}
                    >
                      Manage Money on Account
                    </button>
                  ) : null}
                  {openingGateState.isProspective && openingGateState.canEditMatter ? (
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      data-testid="open-prospective-matter-btn"
                      disabled={openingBusy}
                      onClick={async () => {
                        setOpeningBusy(true);
                        try {
                          const res = await openProspectiveMatterAction(matter.id);
                          if (isActionDenied(res) || !res.ok) {
                            showToast(
                              formatOpeningGateActionError(
                                res,
                                'Matter cannot open yet.',
                              ),
                            );
                            return;
                          }
                          showToast(
                            res.alreadyOpened
                              ? 'Matter is already open.'
                              : `Matter ${res.matter.matterNumber} opened.`,
                          );
                          router.refresh();
                        } finally {
                          setOpeningBusy(false);
                        }
                      }}
                    >
                      Open matter
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="panel-body">
                <ul className="worklist">
                  {openingGateState.evaluation.preconditions
                    .filter((p) => p.required || !p.satisfied || p.overridden)
                    .map((pre) => {
                      const label = pre.label || OPENING_GATE_PRECONDITION_LABELS[pre.key];
                      const pillLabel = pre.overridden
                        ? 'Overridden'
                        : pre.rawSatisfied === null
                          ? 'Not available'
                          : pre.rawSatisfied
                            ? 'Met'
                            : 'Blocked';
                      const pillTone = pre.overridden
                        ? 'warning'
                        : pre.rawSatisfied === null
                          ? 'neutral'
                          : pre.rawSatisfied
                            ? 'positive'
                            : 'alert';
                      return (
                        <li
                          key={pre.key}
                          className="worklist-row"
                          data-testid={`opening-precondition-${pre.key}`}
                        >
                          <div className="worklist-main">
                            <div className="worklist-title">
                              <StatusPill label={pillLabel} tone={pillTone} /> <span>{label}</span>
                            </div>
                            <div className="worklist-meta">
                              {pre.statusSummary}
                              {pre.nonOverridableReason ? (
                                <span> · {pre.nonOverridableReason}</span>
                              ) : null}
                              {pre.activeOverride ? (
                                <span>
                                  {' '}
                                  · Override by{' '}
                                  {pre.activeOverride.overriddenByName || 'Unknown'}
                                  : &ldquo;{pre.activeOverride.reason}&rdquo;
                                </span>
                              ) : null}
                            </div>
                          </div>
                          <div className="worklist-right" style={{ display: 'flex', gap: 8 }}>
                            {openingGateState.isProspective &&
                            openingGateState.canOverridePermission &&
                            !pre.satisfied &&
                            pre.canOverride ? (
                              <button
                                type="button"
                                className="btn btn--secondary btn--sm"
                                data-testid={`override-precondition-${pre.key}-btn`}
                                disabled={openingBusy}
                                onClick={() => {
                                  setOverrideModalKey(pre.key);
                                  setOverrideReason('');
                                  setRevokeModalOverride(null);
                                }}
                              >
                                Override
                              </button>
                            ) : null}
                            {openingGateState.isProspective &&
                            openingGateState.canOverridePermission &&
                            pre.overridden &&
                            pre.activeOverride ? (
                              <button
                                type="button"
                                className="btn btn--secondary btn--sm"
                                data-testid={`revoke-override-${pre.key}-btn`}
                                disabled={openingBusy}
                                onClick={() => {
                                  setRevokeModalOverride({
                                    preconditionKey: pre.key,
                                    overrideId: pre.activeOverride!.id,
                                  });
                                  setRevokeReason('');
                                  setOverrideModalKey(null);
                                }}
                              >
                                Revoke override
                              </button>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}

                  {openingGateState.evaluation.requiresHighRiskApproval ||
                  openingGateState.highRiskRecord ? (
                    <li className="worklist-row" data-testid="opening-high-risk-row">
                      <div className="worklist-main">
                        <div className="worklist-title">
                          <StatusPill
                            label={openingGateState.evaluation.highRisk.statusLabel}
                            tone={
                              openingGateState.evaluation.highRisk.status === 'approved'
                                ? 'positive'
                                : openingGateState.evaluation.highRisk.status === 'rejected'
                                  ? 'alert'
                                  : openingGateState.evaluation.highRisk.status === 'withdrawn'
                                    ? 'neutral'
                                    : 'warning'
                            }
                          />{' '}
                          <span>High-risk opening sign-off</span>
                        </div>
                        <div className="worklist-meta">
                          {openingGateState.evaluation.highRisk.partnerApproverId ? (
                            <span>
                              Stage 1 Partner approved by{' '}
                              {openingGateState.evaluation.highRisk.partnerApproverName ||
                                'Unknown'}
                              {' · '}
                            </span>
                          ) : null}
                          {openingGateState.highRiskRecord ? (
                            canViewRegisters ? (
                              <Link
                                href={`/registers?record=${encodeURIComponent(
                                  openingGateState.highRiskRecord.id,
                                )}`}
                              >
                                {openingGateState.highRiskRecord.reference} (Registers)
                              </Link>
                            ) : (
                              <span>{openingGateState.highRiskRecord.reference}</span>
                            )
                          ) : (
                            <span>Pending first non-draft submission.</span>
                          )}
                        </div>
                      </div>
                      <div className="worklist-right" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {openingGateState.highRiskRecord &&
                        isPartnerOrMpRole &&
                        !isMatterLeadOrResponsible &&
                        openingGateState.highRiskRecord.status === 'pending_partner' ? (
                          <button
                            type="button"
                            className="btn btn--primary btn--sm"
                            data-testid="hro-partner-approve-btn"
                            disabled={openingBusy}
                            onClick={async () => {
                              setOpeningBusy(true);
                              try {
                                const res = await transitionRegisterRecordAction({
                                  recordId: openingGateState.highRiskRecord!.id,
                                  transitionKey: 'partner_approve',
                                  expectedRowVersion: openingGateState.highRiskRecord!.rowVersion,
                                });
                                if (isActionDenied(res) || !res.ok) {
                                  showToast(
                                    formatOpeningGateActionError(
                                      res,
                                      'Could not complete Stage 1 Partner approval.',
                                    ),
                                  );
                                  return;
                                }
                                showToast('Stage 1 Partner approval recorded. Sent to Risk & Compliance.');
                                router.refresh();
                              } finally {
                                setOpeningBusy(false);
                              }
                            }}
                          >
                            Approve Stage 1 (Partner)
                          </button>
                        ) : null}
                        {openingGateState.highRiskRecord &&
                        isRiskComplianceRole &&
                        !isMatterLeadOrResponsible &&
                        openingGateState.highRiskRecord.status === 'pending_compliance' ? (
                          <button
                            type="button"
                            className="btn btn--primary btn--sm"
                            data-testid="hro-compliance-approve-btn"
                            disabled={
                              openingBusy ||
                              openingGateState.evaluation.highRisk.partnerApproverId ===
                                currentUserId
                            }
                            title={
                              openingGateState.evaluation.highRisk.partnerApproverId ===
                              currentUserId
                                ? 'Requires a different Risk & Compliance approver from Stage 1'
                                : undefined
                            }
                            onClick={async () => {
                              setOpeningBusy(true);
                              try {
                                const res = await transitionRegisterRecordAction({
                                  recordId: openingGateState.highRiskRecord!.id,
                                  transitionKey: 'compliance_approve',
                                  expectedRowVersion: openingGateState.highRiskRecord!.rowVersion,
                                });
                                if (isActionDenied(res) || !res.ok) {
                                  showToast(
                                    formatOpeningGateActionError(
                                      res,
                                      'Could not complete Stage 2 Risk & Compliance approval.',
                                    ),
                                  );
                                  return;
                                }
                                showToast('Stage 2 Risk & Compliance approval recorded.');
                                router.refresh();
                              } finally {
                                setOpeningBusy(false);
                              }
                            }}
                          >
                            Approve Stage 2 (Risk &amp; Compliance)
                          </button>
                        ) : null}
                        {openingGateState.highRiskRecord &&
                        ((openingGateState.highRiskRecord.status === 'pending_partner' &&
                          isPartnerOrMpRole) ||
                          (openingGateState.highRiskRecord.status === 'pending_compliance' &&
                            isRiskComplianceRole)) ? (
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            data-testid="hro-reject-btn"
                            disabled={openingBusy}
                            onClick={() => {
                              setHroRejectOpen((o) => !o);
                              setHroRejectComment('');
                            }}
                          >
                            Reject
                          </button>
                        ) : null}
                      </div>
                    </li>
                  ) : null}
                </ul>

                {overrideModalKey ? (
                  <div
                    style={{
                      padding: 12,
                      borderTop: '1px solid var(--color-divider)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                    data-testid="opening-override-form"
                  >
                    <label
                      className="field-label"
                      htmlFor="opening-override-reason-input"
                      style={{ margin: 0 }}
                    >
                      Override rationale for{' '}
                      {OPENING_GATE_PRECONDITION_LABELS[overrideModalKey]} (minimum 10 characters)
                    </label>
                    <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                      Recording an override logs an audit entry and does not automatically open the
                      matter; click &ldquo;Open matter&rdquo; afterwards to re-evaluate the gate.
                    </p>
                    <textarea
                      id="opening-override-reason-input"
                      className="field-input"
                      rows={2}
                      data-testid="opening-override-reason-input"
                      value={overrideReason}
                      onChange={(e) => setOverrideReason(e.target.value)}
                      placeholder="Enter documented business or urgency reason (at least 10 characters)..."
                    />
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={() => setOverrideModalKey(null)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        data-testid="confirm-opening-override-btn"
                        disabled={openingBusy || overrideReason.trim().length < 10}
                        onClick={async () => {
                          setOpeningBusy(true);
                          try {
                            const res = await overrideMatterOpeningPreconditionAction({
                              matterId: matter.id,
                              preconditionKey: overrideModalKey,
                              reason: overrideReason.trim(),
                            });
                            if (isActionDenied(res) || !res.ok) {
                              showToast(
                                formatOpeningGateActionError(
                                  res,
                                  'Could not record opening override.',
                                ),
                              );
                              return;
                            }
                            setOverrideModalKey(null);
                            setOverrideReason('');
                            showToast(
                              "Override recorded. Matter remains Prospective until you click 'Open matter'.",
                            );
                            router.refresh();
                          } finally {
                            setOpeningBusy(false);
                          }
                        }}
                      >
                        Confirm override
                      </button>
                    </div>
                  </div>
                ) : null}

                {revokeModalOverride && openingGateState.isProspective ? (
                  <div
                    style={{
                      padding: 12,
                      borderTop: '1px solid var(--color-divider)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                    data-testid="opening-revoke-form"
                  >
                    <label
                      className="field-label"
                      htmlFor="opening-revoke-reason-input"
                      style={{ margin: 0 }}
                    >
                      Revocation rationale for{' '}
                      {OPENING_GATE_PRECONDITION_LABELS[revokeModalOverride.preconditionKey]}{' '}
                      (minimum 10 characters)
                    </label>
                    <textarea
                      id="opening-revoke-reason-input"
                      className="field-input"
                      rows={2}
                      data-testid="opening-revoke-reason-input"
                      value={revokeReason}
                      onChange={(e) => setRevokeReason(e.target.value)}
                      placeholder="Enter reason for revoking this override (at least 10 characters)..."
                    />
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={() => setRevokeModalOverride(null)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        data-testid="confirm-opening-revoke-btn"
                        disabled={openingBusy || revokeReason.trim().length < 10}
                        onClick={async () => {
                          setOpeningBusy(true);
                          try {
                            const res = await revokeMatterOpeningOverrideAction({
                              matterId: matter.id,
                              overrideId: revokeModalOverride.overrideId,
                              reason: revokeReason.trim(),
                            });
                            if (isActionDenied(res) || !res.ok) {
                              showToast(
                                formatOpeningGateActionError(
                                  res,
                                  'Could not revoke override.',
                                ),
                              );
                              return;
                            }
                            setRevokeModalOverride(null);
                            setRevokeReason('');
                            showToast('Opening override revoked.');
                            router.refresh();
                          } finally {
                            setOpeningBusy(false);
                          }
                        }}
                      >
                        Confirm revocation
                      </button>
                    </div>
                  </div>
                ) : null}

                {hroRejectOpen && openingGateState.highRiskRecord ? (
                  <div
                    style={{
                      padding: 12,
                      borderTop: '1px solid var(--color-divider)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                  >
                    <label
                      className="field-label"
                      htmlFor="hro-reject-comment-input"
                      style={{ margin: 0 }}
                    >
                      Reason for rejecting High-risk opening *
                    </label>
                    <textarea
                      id="hro-reject-comment-input"
                      className="field-input"
                      rows={2}
                      value={hroRejectComment}
                      onChange={(e) => setHroRejectComment(e.target.value)}
                      placeholder="Enter reason for rejection..."
                    />
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={() => setHroRejectOpen(false)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        data-testid="hro-confirm-reject-btn"
                        disabled={openingBusy || !hroRejectComment.trim()}
                        onClick={async () => {
                          setOpeningBusy(true);
                          try {
                            const res = await transitionRegisterRecordAction({
                              recordId: openingGateState.highRiskRecord!.id,
                              transitionKey: 'reject_opening',
                              comment: hroRejectComment.trim(),
                              expectedRowVersion: openingGateState.highRiskRecord!.rowVersion,
                            });
                            if (isActionDenied(res) || !res.ok) {
                              showToast(
                                formatOpeningGateActionError(
                                  res,
                                  'Could not reject High-risk opening.',
                                ),
                              );
                              return;
                            }
                            setHroRejectOpen(false);
                            setHroRejectComment('');
                            showToast('High-risk opening rejected.');
                            router.refresh();
                          } finally {
                            setOpeningBusy(false);
                          }
                        }}
                      >
                        Confirm rejection
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          <section
            ref={engagementPanelRef}
            className="home-panel"
            style={{ marginBottom: 16 }}
            data-testid="matter-engagement-panel"
            aria-label="Client Care and engagement letter"
          >
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Client Care &amp; engagement letter</h2>
                <StatusPill
                  label={matter.engagementLetterStatus || 'Not sent'}
                  tone={
                    isMatterEngagementSignedForGate(matter)
                      ? 'positive'
                      : matter.engagementLetterStatus === 'Sent' ||
                          matter.engagementLetterStatus === 'Sent to client'
                        ? 'warning'
                        : 'neutral'
                  }
                />
              </div>
              <div className="panel-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {matter.engagementLetterSentAt ? (
                  <span className="muted" style={{ fontSize: 12 }}>
                    Sent {formatDateTime(matter.engagementLetterSentAt)}
                  </span>
                ) : null}
                {matter.engagementLetterSignedAt ? (
                  <span className="muted" style={{ fontSize: 12 }}>
                    · Signed {formatDateTime(matter.engagementLetterSignedAt)}
                  </span>
                ) : null}
                {signedEngagementDownloadUrl ? (
                  <a
                    href={signedEngagementDownloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn--secondary btn--sm"
                    data-testid="signed-engagement-download-link"
                  >
                    Download signed copy
                  </a>
                ) : null}
              </div>
            </div>
            <div className="panel-body padded" style={{ display: 'grid', gap: 14 }}>
              {emailProviderDisabled ? (
                <div className="subcard" style={{ background: 'var(--bg-subtle)' }}>
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    Outbound email delivery is currently paused on this environment. Sent Client Care letters are queued in{' '}
                    <strong>Administration &rarr; Email Outbox</strong> with their PDF attached for review.
                  </span>
                </div>
              ) : null}

              {canEditMatter && !isMatterCurrentlyClosed ? (
                <div
                  style={{
                    display: 'grid',
                    gap: 14,
                    gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
                  }}
                >
                  <div className="subcard" style={{ display: 'grid', gap: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 13.5 }}>
                      Send Client Care letter (PDF)
                    </div>
                    <div className="form-grid" style={{ gap: 8 }}>
                      <div className="field-group">
                        <label className="field-label" htmlFor="engagement-recipient-email">
                          Recipient email *
                        </label>
                        <input
                          id="engagement-recipient-email"
                          type="email"
                          className="field-input"
                          data-testid="engagement-recipient-email-input"
                          placeholder="client@example.test"
                          value={engagementRecipientEmail}
                          onChange={(e) => setEngagementRecipientEmail(e.target.value)}
                          disabled={engagementBusy}
                        />
                      </div>
                      <div className="field-group">
                        <label className="field-label" htmlFor="engagement-recipient-name">
                          Recipient name
                        </label>
                        <input
                          id="engagement-recipient-name"
                          type="text"
                          className="field-input"
                          data-testid="engagement-recipient-name-input"
                          value={engagementRecipientName}
                          onChange={(e) => setEngagementRecipientName(e.target.value)}
                          disabled={engagementBusy}
                        />
                      </div>
                    </div>
                    <div className="field-group">
                      <label className="field-label" htmlFor="engagement-intro-note">
                        Covering note (optional)
                      </label>
                      <input
                        id="engagement-intro-note"
                        type="text"
                        className="field-input"
                        data-testid="engagement-intro-note-input"
                        placeholder="Optional message included in the letter and email"
                        value={engagementIntroNote}
                        onChange={(e) => setEngagementIntroNote(e.target.value)}
                        disabled={engagementBusy}
                      />
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        data-testid="send-client-care-btn"
                        disabled={engagementBusy || !engagementRecipientEmail.trim()}
                        onClick={async () => {
                          const sendCtrl = getEngagementSendController();
                          await sendCtrl.runGuarded(async (idempotencyKey) => {
                            setEngagementBusy(true);
                            try {
                              const res = await sendEngagementLetterAction({
                                matterId: matter.id,
                                recipientEmail: engagementRecipientEmail.trim(),
                                recipientName: engagementRecipientName.trim() || undefined,
                                customIntroNote: engagementIntroNote.trim() || undefined,
                                idempotencyKey,
                              });
                              if (isActionDenied(res) || !res.ok) {
                                showToast(
                                  formatOpeningGateActionError(
                                    res,
                                    'Could not send Client Care letter.',
                                  ),
                                );
                                return;
                              }
                              sendCtrl.reset();
                              showToast(
                                res.emailProviderDisabled
                                  ? 'Client Care letter generated and queued in Email Outbox.'
                                  : 'Client Care letter sent.',
                              );
                              setEngagementIntroNote('');
                              router.refresh();
                            } finally {
                              setEngagementBusy(false);
                            }
                          });
                        }}
                      >
                        Send Client Care letter
                      </button>
                    </div>
                  </div>

                  {!isMatterEngagementSignedForGate(matter) ? (
                    <div className="subcard" style={{ display: 'grid', gap: 8 }}>
                      <div style={{ fontWeight: 700, fontSize: 13.5 }}>
                        Record signed Client Care letter
                      </div>
                      <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
                        Upload the client&rsquo;s signed copy (PDF, JPEG or PNG) to mark the engagement letter signed and unlock the opening gate.
                      </p>
                      <div className="field-group">
                        <label className="field-label" htmlFor="engagement-signed-file">
                          Signed copy (PDF, JPEG or PNG) *
                        </label>
                        <input
                          ref={engagementFileInputRef}
                          id="engagement-signed-file"
                          type="file"
                          accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                          className="field-input"
                          data-testid="engagement-signed-file-input"
                          disabled={engagementBusy}
                          onChange={(e) =>
                            setEngagementSelectedFile(e.target.files?.[0] ?? null)
                          }
                        />
                      </div>
                      <div className="field-group">
                        <label className="field-label" htmlFor="engagement-signed-note">
                          Verification note (optional)
                        </label>
                        <input
                          id="engagement-signed-note"
                          type="text"
                          className="field-input"
                          data-testid="engagement-signed-note-input"
                          placeholder="e.g. Returned signed by instructing contact"
                          value={engagementSignedNote}
                          onChange={(e) => setEngagementSignedNote(e.target.value)}
                          disabled={engagementBusy}
                        />
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          data-testid="upload-engagement-signed-btn"
                          disabled={engagementBusy || !engagementSelectedFile}
                          onClick={async () => {
                            if (!engagementSelectedFile) return;
                            setEngagementBusy(true);
                            try {
                              const formData = new FormData();
                              formData.set('subjectType', 'matter');
                              formData.set('subjectId', matter.id);
                              formData.set('purpose', 'engagement_signed');
                              formData.set('file', engagementSelectedFile);

                              const uploadRes = await fetch('/api/evidence/upload', {
                                method: 'POST',
                                body: formData,
                              });
                              const uploadPayload = (await uploadRes.json()) as {
                                ok?: boolean;
                                error?: string;
                                artifact?: { id: string };
                              };
                              if (
                                !uploadRes.ok ||
                                !uploadPayload.ok ||
                                !uploadPayload.artifact?.id
                              ) {
                                showToast(
                                  uploadPayload.error ||
                                    'Signed engagement copy upload failed.',
                                );
                                return;
                              }

                              const res = await recordEngagementLetterSignedAction({
                                matterId: matter.id,
                                evidenceArtifactId: uploadPayload.artifact.id,
                                status: 'Signed & returned',
                                note: engagementSignedNote.trim() || undefined,
                              });
                              if (isActionDenied(res) || !res.ok) {
                                showToast(
                                  formatOpeningGateActionError(
                                    res,
                                    'Could not mark engagement letter signed.',
                                  ),
                                );
                                return;
                              }
                              setEngagementSelectedFile(null);
                              setEngagementSignedNote('');
                              if (engagementFileInputRef.current) {
                                engagementFileInputRef.current.value = '';
                              }
                              showToast('Signed engagement copy recorded.');
                              router.refresh();
                            } finally {
                              setEngagementBusy(false);
                            }
                          }}
                        >
                          Upload signed copy &amp; mark signed
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {activeEngagementChase ? (
                <div
                  className="subcard"
                  data-testid="matter-engagement-chase-summary"
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 12,
                    flexWrap: 'wrap',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>
                      {activeEngagementChase.chase.status === 'needs_owner'
                        ? 'Follow-up needs an owner'
                        : activeEngagementChase.chase.status === 'failed'
                          ? 'Follow-up stopped after repeated errors'
                          : 'Automated follow-up active'}
                    </div>
                    <div className="muted" style={{ fontSize: 12.5 }}>
                      {activeEngagementChase.chase.status === 'needs_owner'
                        ? 'Nobody who can see this matter can take the follow-up. Add a fee earner or partner to the matter, then choose Retry follow-up, or stop chasing.'
                        : activeEngagementChase.chase.status === 'failed'
                          ? 'Automated reminders stopped after repeated errors. Choose Retry follow-up to reset the error count and resume chasing, or send a fresh Client Care letter.'
                          : (
                            <>
                              Chasing {activeEngagementChase.chase.recipientEmail || 'client'} &middot;{' '}
                              {activeEngagementChase.events.length} reminder step(s) completed &middot;{' '}
                              {activeEngagementChase.chase.nextActionAt
                                ? `Next action due ${formatDateTime(activeEngagementChase.chase.nextActionAt)}`
                                : 'Final escalation stage'}
                            </>
                          )}
                    </div>
                  </div>
                  {canEditMatter && !isMatterCurrentlyClosed ? (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      {activeEngagementChase.chase.status === 'needs_owner' ||
                      activeEngagementChase.chase.status === 'failed' ? (
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          data-testid="retry-engagement-chase-btn"
                          disabled={engagementBusy}
                          onClick={async () => {
                            setEngagementBusy(true);
                            try {
                              const res = await retryCommunicationChaseAction({
                                chaseId: activeEngagementChase.chase.id,
                              });
                              if (isActionDenied(res) || !res.ok) {
                                showToast(
                                  formatOpeningGateActionError(
                                    res,
                                    'Could not retry engagement follow-up.',
                                  ),
                                );
                                return;
                              }
                              if (res.outcome === 'escalated') {
                                showToast('Follow-up escalation task created.');
                              } else if (res.outcome === 'still_needs_owner') {
                                showToast(
                                  'Nobody who can access this matter can take the follow-up yet.',
                                );
                              } else if (res.outcome === 'reset_to_active') {
                                showToast('Error count cleared. Automated follow-up resumed.');
                              } else {
                                showToast(
                                  'Follow-up stopped because the matter no longer requires chasing.',
                                );
                              }
                              router.refresh();
                            } finally {
                              setEngagementBusy(false);
                            }
                          }}
                        >
                          Retry follow-up
                        </button>
                      ) : null}
                      {activeEngagementChase.chase.status === 'active' ||
                      activeEngagementChase.chase.status === 'needs_owner' ? (
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          data-testid="stop-engagement-chase-btn"
                          disabled={engagementBusy}
                          onClick={async () => {
                            setEngagementBusy(true);
                            try {
                              const res = await stopCommunicationChaseAction({
                                chaseId: activeEngagementChase.chase.id,
                              });
                              if (isActionDenied(res) || !res.ok) {
                                showToast(
                                  formatOpeningGateActionError(
                                    res,
                                    'Could not stop engagement chasing.',
                                  ),
                                );
                                return;
                              }
                              showToast('Automated engagement chasing stopped.');
                              router.refresh();
                            } finally {
                              setEngagementBusy(false);
                            }
                          }}
                        >
                          Stop chasing
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {engagementDispatches.length > 0 ? (
                <div style={{ display: 'grid', gap: 6 }}>
                  <div style={{ fontWeight: 600, fontSize: 12.5 }}>
                    Client Care dispatch history
                  </div>
                  <ul className="worklist">
                    {engagementDispatches.map((disp) => (
                      <li key={disp.id} className="worklist-row" data-testid={`engagement-dispatch-${disp.id}`}>
                        <div className="worklist-main">
                          <div className="worklist-title">
                            <span>{disp.recipientEmail}</span>
                            {disp.recipientName ? (
                              <span className="muted"> ({disp.recipientName})</span>
                            ) : null}
                          </div>
                          <div className="worklist-meta">
                            Sent {formatDateTime(disp.sentAt)}
                            {disp.signedAt ? ` · Signed ${formatDateTime(disp.signedAt)}` : ''}
                          </div>
                        </div>
                        <div className="worklist-right">
                          <StatusPill
                            label={disp.status === 'signed' ? 'Signed' : disp.status === 'withdrawn' ? 'Withdrawn' : 'Sent'}
                            tone={disp.status === 'signed' ? 'positive' : 'neutral'}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </section>

          {canViewMoneyOnAccount ? (
            <section
              ref={moaPanelRef}
              className="home-panel"
              style={{ marginBottom: 16 }}
              data-testid="matter-moa-panel"
              aria-label="Money on Account"
            >
              <div className="panel-header">
                <div className="panel-title-group">
                  <h2 className="panel-title">Money on Account</h2>
                  <StatusPill
                    label={
                      moaSummaryMetrics.fundsPre?.satisfied ||
                      ((moneyOnAccountAgreedPence ?? 0) > 0 &&
                        moaSummaryMetrics.receivedPence >= (moneyOnAccountAgreedPence ?? 0))
                        ? 'Funds cleared'
                        : moaSummaryMetrics.receivedPence > 0
                          ? 'Part received'
                          : moaSummaryMetrics.nonCancelledRequests.length > 0
                            ? 'Requested'
                            : 'Not requested'
                    }
                    tone={
                      moaSummaryMetrics.fundsPre?.satisfied ||
                      ((moneyOnAccountAgreedPence ?? 0) > 0 &&
                        moaSummaryMetrics.receivedPence >= (moneyOnAccountAgreedPence ?? 0))
                        ? 'positive'
                        : moaSummaryMetrics.nonCancelledRequests.length > 0
                          ? 'warning'
                          : 'neutral'
                    }
                  />
                </div>
                <div
                  className="panel-actions"
                  style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}
                >
                  {typeof moneyOnAccountAgreedPence === 'number' &&
                  moneyOnAccountAgreedPence > 0 ? (
                    <span className="muted" style={{ fontSize: 12 }}>
                      Agreed payment on account:{' '}
                      <strong>
                        {formatGbp(minorUnitsToPounds(moneyOnAccountAgreedPence))}
                      </strong>
                    </span>
                  ) : null}
                  <span className="muted" style={{ fontSize: 12 }}>
                    Cleared receipts:{' '}
                    <strong>
                      {formatGbp(minorUnitsToPounds(moaSummaryMetrics.receivedPence))}
                    </strong>
                  </span>
                </div>
              </div>
              <div className="panel-body padded" style={{ display: 'grid', gap: 14 }}>
                {!effectiveMoneyOnAccountConfig?.enabled || !moneyOnAccountBankConfigured ? (
                  <div className="subcard" style={{ background: 'var(--bg-subtle)' }}>
                    <span className="muted" style={{ fontSize: 12.5 }}>
                      If your firm has turned on Money on Account and configured client account bank details in Administration, payment requests and client transfer details appear here.
                    </span>
                  </div>
                ) : null}

                {emailProviderDisabled && effectiveMoneyOnAccountConfig?.enabled ? (
                  <div
                    className="subcard"
                    data-testid="moa-outbox-queued-banner"
                    style={{ background: 'var(--bg-subtle)' }}
                  >
                    <span className="muted" style={{ fontSize: 12.5 }}>
                      Outbound email delivery is currently paused on this environment. Sent payment requests are queued in{' '}
                      <strong>Administration &rarr; Email Outbox</strong> with their PDF attached for review.
                    </span>
                  </div>
                ) : null}

                {(canRequestMoneyOnAccount || canRecordMoneyOnAccountReceipt) &&
                !isMatterCurrentlyClosed ? (
                  <div
                    style={{
                      display: 'grid',
                      gap: 14,
                      gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
                    }}
                  >
                    {canRequestMoneyOnAccount ? (
                      <div className="subcard" style={{ display: 'grid', gap: 8 }}>
                        <div style={{ fontWeight: 700, fontSize: 13.5 }}>
                          Send Money on Account request (PDF)
                        </div>
                        <div className="form-grid" style={{ gap: 8 }}>
                          <div className="field-group">
                            <label className="field-label" htmlFor="moa-request-amount">
                              Requested amount (£) *
                            </label>
                            <input
                              id="moa-request-amount"
                              type="number"
                              min="0.01"
                              step="0.01"
                              className="field-input"
                              data-testid="moa-amount-input"
                              placeholder="500.00"
                              value={moaRequestAmountGbp}
                              onChange={(e) => setMoaRequestAmountGbp(e.target.value)}
                              disabled={
                                moaBusy ||
                                !effectiveMoneyOnAccountConfig?.enabled ||
                                !moneyOnAccountBankConfigured
                              }
                            />
                          </div>
                          <div className="field-group">
                            <label className="field-label" htmlFor="moa-recipient-email">
                              Recipient email *
                            </label>
                            <input
                              id="moa-recipient-email"
                              type="email"
                              className="field-input"
                              data-testid="moa-recipient-email-input"
                              placeholder="client@example.test"
                              value={moaRecipientEmail}
                              onChange={(e) => setMoaRecipientEmail(e.target.value)}
                              disabled={
                                moaBusy ||
                                !effectiveMoneyOnAccountConfig?.enabled ||
                                !moneyOnAccountBankConfigured
                              }
                            />
                          </div>
                        </div>
                        <div className="form-grid" style={{ gap: 8 }}>
                          <div className="field-group">
                            <label className="field-label" htmlFor="moa-recipient-name">
                              Recipient name
                            </label>
                            <input
                              id="moa-recipient-name"
                              type="text"
                              className="field-input"
                              data-testid="moa-recipient-name-input"
                              value={moaRecipientName}
                              onChange={(e) => setMoaRecipientName(e.target.value)}
                              disabled={
                                moaBusy ||
                                !effectiveMoneyOnAccountConfig?.enabled ||
                                !moneyOnAccountBankConfigured
                              }
                            />
                          </div>
                          <div className="field-group">
                            <label className="field-label" htmlFor="moa-request-notes">
                              Internal note (optional)
                            </label>
                            <input
                              id="moa-request-notes"
                              type="text"
                              className="field-input"
                              data-testid="moa-request-notes-input"
                              placeholder="e.g. Initial search fees on account"
                              value={moaRequestNotes}
                              onChange={(e) => setMoaRequestNotes(e.target.value)}
                              disabled={
                                moaBusy ||
                                !effectiveMoneyOnAccountConfig?.enabled ||
                                !moneyOnAccountBankConfigured
                              }
                            />
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <button
                            type="button"
                            className="btn btn--primary btn--sm"
                            data-testid="moa-send-request-btn"
                            disabled={
                              moaBusy ||
                              !effectiveMoneyOnAccountConfig?.enabled ||
                              !moneyOnAccountBankConfigured ||
                              !moaRecipientEmail.trim() ||
                              !moaRequestAmountGbp.trim()
                            }
                            onClick={async () => {
                              const parsedGbp = Number(moaRequestAmountGbp);
                              if (!Number.isFinite(parsedGbp) || parsedGbp <= 0) {
                                showToast('Please enter a valid positive amount in pounds.');
                                return;
                              }
                              const amountPence = poundsToMinorUnits(parsedGbp);
                              const sendCtrl = getMoaSendController();
                              await sendCtrl.runGuarded(async (idempotencyKey) => {
                                setMoaBusy(true);
                                try {
                                  const res = await createAndSendMoneyOnAccountRequestAction({
                                    matterId: matter.id,
                                    requestedAmountPence: amountPence,
                                    recipientEmail: moaRecipientEmail.trim(),
                                    recipientName: moaRecipientName.trim() || undefined,
                                    notes: moaRequestNotes.trim() || undefined,
                                    idempotencyKey,
                                  });
                                  if (isActionDenied(res) || !res.ok) {
                                    showToast(
                                      formatOpeningGateActionError(
                                        res,
                                        'Could not send Money on Account request.',
                                      ),
                                    );
                                    return;
                                  }
                                  sendCtrl.reset();
                                  showToast(
                                    res.emailProviderDisabled
                                      ? `Payment request ${res.request.paymentReference} generated and queued in Email Outbox.`
                                      : `Payment request ${res.request.paymentReference} sent.`,
                                  );
                                  setMoaRequestNotes('');
                                  router.refresh();
                                } finally {
                                  setMoaBusy(false);
                                }
                              });
                            }}
                          >
                            Send payment request
                          </button>
                        </div>
                      </div>
                    ) : null}

                    {canRecordMoneyOnAccountReceipt ? (
                      <div
                        className="subcard"
                        data-testid="moa-record-receipt-panel"
                        style={{ display: 'grid', gap: 10 }}
                      >
                        <div style={{ fontWeight: 700, fontSize: 13.5 }}>
                          Record Money on Account receipt
                        </div>
                        {moaSummaryMetrics.activeOpenRequests.length === 0 ? (
                          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
                            Send a Money on Account request first before recording a receipt or matching a client ledger entry.
                          </p>
                        ) : (
                          <>
                            <div className="form-grid" style={{ gap: 8 }}>
                              <div className="field-group">
                                <label className="field-label" htmlFor="moa-receipt-req">
                                  Request reference *
                                </label>
                                <select
                                  id="moa-receipt-req"
                                  className="field-select"
                                  data-testid="moa-receipt-request-select"
                                  value={selectedReceiptRequestId}
                                  disabled={moaBusy}
                                  onChange={(e) => {
                                    const nextId = e.target.value;
                                    setMoaReceiptRequestId(nextId);
                                    const picked = moaSummaryMetrics.activeOpenRequests.find(
                                      (r) => r.id === nextId,
                                    );
                                    if (picked) {
                                      const rec =
                                        moaSummaryMetrics.unreversedByRequestId.get(picked.id) ?? 0;
                                      const rem = Math.max(0, picked.requestedAmountPence - rec);
                                      setMoaReceiptAmountGbp(
                                        rem > 0 ? minorUnitsToPounds(rem).toFixed(2) : '',
                                      );
                                    }
                                  }}
                                >
                                  {moaSummaryMetrics.activeOpenRequests.map((req) => (
                                    <option key={req.id} value={req.id}>
                                      {req.paymentReference} —{' '}
                                      {formatGbp(minorUnitsToPounds(req.requestedAmountPence))}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div className="field-group">
                                <label className="field-label" htmlFor="moa-receipt-amount">
                                  Amount received (£) *
                                </label>
                                <input
                                  id="moa-receipt-amount"
                                  type="number"
                                  min="0.01"
                                  step="0.01"
                                  className="field-input"
                                  data-testid="moa-receipt-amount-input"
                                  placeholder="500.00"
                                  value={moaReceiptAmountGbp}
                                  onChange={(e) => setMoaReceiptAmountGbp(e.target.value)}
                                  disabled={moaBusy}
                                />
                              </div>
                            </div>
                            <div className="form-grid" style={{ gap: 8 }}>
                              <div className="field-group">
                                <label className="field-label" htmlFor="moa-receipt-date">
                                  Date received *
                                </label>
                                <input
                                  id="moa-receipt-date"
                                  type="date"
                                  className="field-input"
                                  data-testid="moa-receipt-date-input"
                                  value={moaReceiptDate}
                                  onChange={(e) => setMoaReceiptDate(e.target.value)}
                                  disabled={moaBusy}
                                />
                              </div>
                              <div className="field-group">
                                <label className="field-label" htmlFor="moa-receipt-bank-ref">
                                  Bank transfer reference (optional)
                                </label>
                                <input
                                  id="moa-receipt-bank-ref"
                                  type="text"
                                  className="field-input"
                                  data-testid="moa-receipt-bank-ref-input"
                                  placeholder="e.g. FPS credit reference"
                                  value={moaReceiptBankRef}
                                  onChange={(e) => setMoaReceiptBankRef(e.target.value)}
                                  disabled={moaBusy}
                                />
                              </div>
                            </div>
                            <div className="form-grid" style={{ gap: 8 }}>
                              <div className="field-group">
                                <label className="field-label" htmlFor="moa-receipt-file">
                                  Remittance advice / bank proof (PDF, JPEG or PNG, optional)
                                </label>
                                <input
                                  ref={moaReceiptFileInputRef}
                                  id="moa-receipt-file"
                                  type="file"
                                  accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                                  className="field-input"
                                  data-testid="moa-receipt-file-input"
                                  disabled={moaBusy}
                                  onChange={(e) =>
                                    setMoaReceiptFile(e.target.files?.[0] ?? null)
                                  }
                                />
                              </div>
                              <div className="field-group">
                                <label className="field-label" htmlFor="moa-receipt-notes">
                                  Finance note (optional)
                                </label>
                                <input
                                  id="moa-receipt-notes"
                                  type="text"
                                  className="field-input"
                                  data-testid="moa-receipt-notes-input"
                                  placeholder="e.g. Verified on client account statement"
                                  value={moaReceiptNotes}
                                  onChange={(e) => setMoaReceiptNotes(e.target.value)}
                                  disabled={moaBusy}
                                />
                              </div>
                            </div>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <button
                                type="button"
                                className="btn btn--secondary btn--sm"
                                data-testid="moa-record-receipt-btn"
                                disabled={
                                  moaBusy ||
                                  !selectedReceiptRequestId ||
                                  !moaReceiptAmountGbp.trim() ||
                                  !moaReceiptDate
                                }
                                onClick={async () => {
                                  const parsedGbp = Number(moaReceiptAmountGbp);
                                  if (!Number.isFinite(parsedGbp) || parsedGbp <= 0) {
                                    showToast('Please enter a valid positive receipt amount.');
                                    return;
                                  }
                                  setMoaBusy(true);
                                  try {
                                    let evidenceArtifactId: string | undefined;
                                    if (moaReceiptFile) {
                                      const formData = new FormData();
                                      formData.set('subjectType', 'matter');
                                      formData.set('subjectId', matter.id);
                                      formData.set('purpose', 'moa_receipt');
                                      formData.set('file', moaReceiptFile);

                                      const uploadRes = await fetch('/api/evidence/upload', {
                                        method: 'POST',
                                        body: formData,
                                      });
                                      const uploadPayload = (await uploadRes.json()) as {
                                        ok?: boolean;
                                        error?: string;
                                        artifact?: { id: string };
                                      };
                                      if (
                                        !uploadRes.ok ||
                                        !uploadPayload.ok ||
                                        !uploadPayload.artifact?.id
                                      ) {
                                        showToast(
                                          uploadPayload.error ||
                                            'Receipt proof upload failed.',
                                        );
                                        return;
                                      }
                                      evidenceArtifactId = uploadPayload.artifact.id;
                                    }

                                    const res = await recordMoneyOnAccountReceiptAction({
                                      requestId: selectedReceiptRequestId,
                                      amountPence: poundsToMinorUnits(parsedGbp),
                                      receivedDate: moaReceiptDate,
                                      bankReference: moaReceiptBankRef.trim() || undefined,
                                      notes: moaReceiptNotes.trim() || undefined,
                                      evidenceArtifactId,
                                    });
                                    if (isActionDenied(res) || !res.ok) {
                                      showToast(
                                        formatOpeningGateActionError(
                                          res,
                                          'Could not record receipt.',
                                        ),
                                      );
                                      return;
                                    }
                                    setMoaReceiptFile(null);
                                    setMoaReceiptBankRef('');
                                    setMoaReceiptNotes('');
                                    if (moaReceiptFileInputRef.current) {
                                      moaReceiptFileInputRef.current.value = '';
                                    }
                                    showToast('Money on Account receipt recorded.');
                                    router.refresh();
                                  } finally {
                                    setMoaBusy(false);
                                  }
                                }}
                              >
                                Record receipt
                              </button>
                            </div>

                            {canMatchPmsClientLedgerReceipt &&
                            unmatchedPmsClientReceipts.length > 0 ? (
                              <div
                                data-testid="moa-pms-match-panel"
                                style={{
                                  borderTop: '1px solid var(--color-divider)',
                                  paddingTop: 10,
                                  display: 'grid',
                                  gap: 8,
                                }}
                              >
                                <div style={{ fontWeight: 700, fontSize: 13 }}>
                                  Match unmatched PMS client account receipt
                                </div>
                                <div className="form-grid" style={{ gap: 8 }}>
                                  <div className="field-group">
                                    <label className="field-label" htmlFor="moa-pms-tx">
                                      PMS client account receipt
                                    </label>
                                    <select
                                      id="moa-pms-tx"
                                      className="field-select"
                                      data-testid="moa-pms-tx-select"
                                      value={effectiveSelectedPmsMoaTxId}
                                      disabled={moaBusy}
                                      onChange={(e) => setSelectedPmsMoaTxId(e.target.value)}
                                    >
                                      {unmatchedPmsClientReceipts.map((tx) => {
                                        const txPence = resolvePmsPence(tx.amount_pence, tx.amount);
                                        return (
                                          <option key={tx.transaction_id} value={tx.transaction_id}>
                                            {tx.date} · {tx.transaction_id} ·{' '}
                                            {formatGbp(minorUnitsToPounds(txPence))} —{' '}
                                            {tx.description}
                                          </option>
                                        );
                                      })}
                                    </select>
                                  </div>
                                  <div className="field-group">
                                    <label className="field-label" htmlFor="moa-pms-req">
                                      Apply to request
                                    </label>
                                    <select
                                      id="moa-pms-req"
                                      className="field-select"
                                      data-testid="moa-pms-request-select"
                                      value={effectivePmsMatchRequestId}
                                      disabled={moaBusy}
                                      onChange={(e) => setPmsMatchRequestId(e.target.value)}
                                    >
                                      {moaSummaryMetrics.activeOpenRequests.map((req) => (
                                        <option key={req.id} value={req.id}>
                                          {req.paymentReference} (
                                          {formatGbp(minorUnitsToPounds(req.requestedAmountPence))})
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                </div>
                                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                  <button
                                    type="button"
                                    className="btn btn--secondary btn--sm"
                                    data-testid="moa-pms-match-btn"
                                    disabled={
                                      moaBusy ||
                                      !effectiveSelectedPmsMoaTxId ||
                                      !effectivePmsMatchRequestId
                                    }
                                    onClick={async () => {
                                      setMoaBusy(true);
                                      try {
                                        const res = await matchPmsClientLedgerReceiptAction({
                                          requestId: effectivePmsMatchRequestId,
                                          pmsTransactionId: effectiveSelectedPmsMoaTxId,
                                        });
                                        if (isActionDenied(res) || !res.ok) {
                                          showToast(
                                            formatOpeningGateActionError(
                                              res,
                                              'Could not match PMS client account receipt.',
                                            ),
                                          );
                                          return;
                                        }
                                        showToast('PMS client account receipt matched.');
                                        router.refresh();
                                      } finally {
                                        setMoaBusy(false);
                                      }
                                    }}
                                  >
                                    Match PMS receipt
                                  </button>
                                </div>
                              </div>
                            ) : null}
                          </>
                        )}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {moneyOnAccountRequests.length > 0 ? (
                  <div style={{ display: 'grid', gap: 8 }} data-testid="moa-requests-list">
                    <div style={{ fontWeight: 600, fontSize: 12.5 }}>
                      Payment requests &amp; receipts
                    </div>
                    <ul className="worklist">
                      {moneyOnAccountRequests.map((req) => {
                        const reqCleared =
                          moaSummaryMetrics.unreversedByRequestId.get(req.id) ?? 0;
                        const reqReceipts =
                          moaSummaryMetrics.receiptsByRequestId.get(req.id) ?? [];
                        const reqChase = moneyOnAccountChases.find(
                          (c) => c.chase.entityId === req.id,
                        );
                        const canCancelThisRequest =
                          canRequestMoneyOnAccount &&
                          !isMatterCurrentlyClosed &&
                          (req.status === 'requested' || req.status === 'part_received') &&
                          reqCleared === 0;
                        const reqTone =
                          req.status === 'received'
                            ? 'positive'
                            : req.status === 'cancelled'
                              ? 'neutral'
                              : 'warning';
                        const reqStatusLabel =
                          req.status === 'received'
                            ? 'Received'
                            : req.status === 'part_received'
                              ? 'Part received'
                              : req.status === 'cancelled'
                                ? 'Cancelled'
                                : 'Requested';
                        return (
                          <li
                            key={req.id}
                            className="worklist-row"
                            data-testid={`moa-request-${req.id}`}
                            style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'flex-start',
                                gap: 12,
                                flexWrap: 'wrap',
                              }}
                            >
                              <div className="worklist-main">
                                <div className="worklist-title">
                                  <strong>{req.paymentReference}</strong> &middot;{' '}
                                  <span>
                                    {formatGbp(minorUnitsToPounds(req.requestedAmountPence))}
                                  </span>{' '}
                                  <span className="muted">
                                    (Cleared: {formatGbp(minorUnitsToPounds(reqCleared))})
                                  </span>
                                </div>
                                <div className="worklist-meta">
                                  Sent to {req.recipientEmail}
                                  {req.requestedAt ? ` · ${formatDateTime(req.requestedAt)}` : ''}
                                  {req.requestedByPersonId
                                    ? ` · Requested by ${nameMap.get(req.requestedByPersonId) ?? req.requestedByPersonId}`
                                    : ''}
                                </div>
                                <div className="muted" style={{ fontSize: 12 }}>
                                  Client account snapshot: {req.bankDetailsSnapshot.accountName} (
                                  {req.bankDetailsSnapshot.bankName}, sort code{' '}
                                  {req.bankDetailsSnapshot.sortCode}, account{' '}
                                  {req.bankDetailsSnapshot.accountNumber})
                                </div>
                              </div>
                              <div
                                className="worklist-right"
                                style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
                              >
                                <StatusPill label={reqStatusLabel} tone={reqTone} />
                                {canCancelThisRequest ? (
                                  <button
                                    type="button"
                                    className="btn btn--secondary btn--sm"
                                    data-testid={`moa-cancel-request-btn-${req.id}`}
                                    disabled={moaBusy}
                                    onClick={() => {
                                      setCancelTargetRequestId(
                                        cancelTargetRequestId === req.id ? null : req.id,
                                      );
                                      setCancelRequestReason('');
                                    }}
                                  >
                                    Cancel request
                                  </button>
                                ) : null}
                              </div>
                            </div>

                            {cancelTargetRequestId === req.id ? (
                              <div
                                className="subcard"
                                style={{ background: 'var(--bg-subtle)', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}
                              >
                                <input
                                  type="text"
                                  className="field-input"
                                  data-testid={`moa-cancel-reason-input-${req.id}`}
                                  placeholder="Reason for cancelling this payment request"
                                  value={cancelRequestReason}
                                  onChange={(e) => setCancelRequestReason(e.target.value)}
                                  disabled={moaBusy}
                                  style={{ flex: '1 1 240px' }}
                                />
                                <button
                                  type="button"
                                  className="btn btn--primary btn--sm"
                                  data-testid={`moa-confirm-cancel-btn-${req.id}`}
                                  disabled={moaBusy || cancelRequestReason.trim().length < 3}
                                  onClick={async () => {
                                    setMoaBusy(true);
                                    try {
                                      const res = await cancelMoneyOnAccountRequestAction({
                                        requestId: req.id,
                                        reason: cancelRequestReason.trim(),
                                      });
                                      if (isActionDenied(res) || !res.ok) {
                                        showToast(
                                          formatOpeningGateActionError(
                                            res,
                                            'Could not cancel request.',
                                          ),
                                        );
                                        return;
                                      }
                                      setCancelTargetRequestId(null);
                                      setCancelRequestReason('');
                                      showToast('Money on Account request cancelled.');
                                      router.refresh();
                                    } finally {
                                      setMoaBusy(false);
                                    }
                                  }}
                                >
                                  Confirm cancel
                                </button>
                              </div>
                            ) : null}

                            {reqChase &&
                            (reqChase.chase.status === 'active' ||
                              reqChase.chase.status === 'needs_owner' ||
                              reqChase.chase.status === 'failed') ? (
                              <div
                                className="subcard"
                                data-testid={`moa-chase-summary-${req.id}`}
                                style={{
                                  background: 'var(--bg-subtle)',
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  alignItems: 'center',
                                  gap: 8,
                                  flexWrap: 'wrap',
                                }}
                              >
                                <div className="muted" style={{ fontSize: 12.5 }}>
                                  {reqChase.chase.status === 'needs_owner'
                                    ? 'Payment reminder needs an owner.'
                                    : reqChase.chase.status === 'failed'
                                      ? 'Automated payment reminders stopped after repeated errors.'
                                      : `Automated reminder active (${reqChase.events.length} step(s) completed${
                                          reqChase.chase.nextActionAt
                                            ? `, next due ${formatDateTime(reqChase.chase.nextActionAt)}`
                                            : ''
                                        })`}
                                </div>
                                {canRequestMoneyOnAccount && !isMatterCurrentlyClosed ? (
                                  <div style={{ display: 'flex', gap: 8 }}>
                                    {reqChase.chase.status === 'needs_owner' ||
                                    reqChase.chase.status === 'failed' ? (
                                      <button
                                        type="button"
                                        className="btn btn--secondary btn--sm"
                                        data-testid={`retry-moa-chase-btn-${req.id}`}
                                        disabled={moaBusy}
                                        onClick={async () => {
                                          setMoaBusy(true);
                                          try {
                                            const res = await retryCommunicationChaseAction({
                                              chaseId: reqChase.chase.id,
                                            });
                                            if (isActionDenied(res) || !res.ok) {
                                              showToast(
                                                formatOpeningGateActionError(
                                                  res,
                                                  'Could not retry follow-up.',
                                                ),
                                              );
                                              return;
                                            }
                                            showToast('Follow-up updated.');
                                            router.refresh();
                                          } finally {
                                            setMoaBusy(false);
                                          }
                                        }}
                                      >
                                        Retry follow-up
                                      </button>
                                    ) : null}
                                    {reqChase.chase.status === 'active' ||
                                    reqChase.chase.status === 'needs_owner' ? (
                                      <button
                                        type="button"
                                        className="btn btn--secondary btn--sm"
                                        data-testid={`stop-moa-chase-btn-${req.id}`}
                                        disabled={moaBusy}
                                        onClick={async () => {
                                          setMoaBusy(true);
                                          try {
                                            const res = await stopCommunicationChaseAction({
                                              chaseId: reqChase.chase.id,
                                            });
                                            if (isActionDenied(res) || !res.ok) {
                                              showToast(
                                                formatOpeningGateActionError(
                                                  res,
                                                  'Could not stop follow-up.',
                                                ),
                                              );
                                              return;
                                            }
                                            showToast('Automated payment chasing stopped.');
                                            router.refresh();
                                          } finally {
                                            setMoaBusy(false);
                                          }
                                        }}
                                      >
                                        Stop chasing
                                      </button>
                                    ) : null}
                                  </div>
                                ) : null}
                              </div>
                            ) : null}

                            {reqReceipts.length > 0 ? (
                              <div style={{ display: 'grid', gap: 6, paddingLeft: 10 }}>
                                {reqReceipts.map((rcpt) => {
                                  const evidenceUrl = moaReceiptDownloadUrls[rcpt.id];
                                  return (
                                    <div
                                      key={rcpt.id}
                                      className="subcard"
                                      data-testid={`moa-receipt-${rcpt.id}`}
                                      style={{
                                        background: 'var(--bg-subtle)',
                                        display: 'grid',
                                        gap: 6,
                                      }}
                                    >
                                      <div
                                        style={{
                                          display: 'flex',
                                          justifyContent: 'space-between',
                                          alignItems: 'center',
                                          gap: 8,
                                          flexWrap: 'wrap',
                                        }}
                                      >
                                        <div style={{ fontSize: 12.5 }}>
                                          <strong>
                                            {formatGbp(minorUnitsToPounds(rcpt.amountPence))}
                                          </strong>{' '}
                                          received {formatDate(rcpt.receivedDate)} &middot;{' '}
                                          {rcpt.source === 'pms_ledger'
                                            ? `Matched from PMS (${rcpt.pmsTransactionId ?? ''})`
                                            : 'Recorded manually'}
                                          {rcpt.bankReference
                                            ? ` · Ref: ${rcpt.bankReference}`
                                            : ''}
                                          {rcpt.recordedByPersonId
                                            ? ` · By ${nameMap.get(rcpt.recordedByPersonId) ?? rcpt.recordedByPersonId}`
                                            : ''}
                                          {rcpt.reversedAt ? (
                                            <span className="muted">
                                              {' '}
                                              · Reversed {formatDateTime(rcpt.reversedAt)} (
                                              {rcpt.reversalReason})
                                            </span>
                                          ) : null}
                                        </div>
                                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                          {rcpt.reversedAt ? (
                                            <StatusPill label="Reversed" tone="neutral" />
                                          ) : (
                                            <StatusPill label="Cleared" tone="positive" />
                                          )}
                                          {evidenceUrl ? (
                                            <a
                                              href={evidenceUrl}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="btn btn--secondary btn--sm"
                                              data-testid={`moa-receipt-download-link-${rcpt.id}`}
                                            >
                                              Download proof
                                            </a>
                                          ) : null}
                                          {!rcpt.reversedAt &&
                                          canRecordMoneyOnAccountReceipt &&
                                          !isMatterCurrentlyClosed ? (
                                            <button
                                              type="button"
                                              className="btn btn--secondary btn--sm"
                                              data-testid={`moa-reverse-receipt-btn-${rcpt.id}`}
                                              disabled={moaBusy}
                                              onClick={() => {
                                                setReverseTargetReceiptId(
                                                  reverseTargetReceiptId === rcpt.id
                                                    ? null
                                                    : rcpt.id,
                                                );
                                                setReverseReceiptReason('');
                                              }}
                                            >
                                              Reverse
                                            </button>
                                          ) : null}
                                        </div>
                                      </div>

                                      {reverseTargetReceiptId === rcpt.id ? (
                                        <div
                                          style={{
                                            display: 'flex',
                                            gap: 8,
                                            flexWrap: 'wrap',
                                            alignItems: 'center',
                                          }}
                                        >
                                          <input
                                            type="text"
                                            className="field-input"
                                            data-testid={`moa-reverse-reason-input-${rcpt.id}`}
                                            placeholder="Reason for reversal (minimum 5 characters)"
                                            value={reverseReceiptReason}
                                            onChange={(e) =>
                                              setReverseReceiptReason(e.target.value)
                                            }
                                            disabled={moaBusy}
                                            style={{ flex: '1 1 240px' }}
                                          />
                                          <button
                                            type="button"
                                            className="btn btn--primary btn--sm"
                                            data-testid={`moa-confirm-reverse-btn-${rcpt.id}`}
                                            disabled={
                                              moaBusy || reverseReceiptReason.trim().length < 5
                                            }
                                            onClick={async () => {
                                              setMoaBusy(true);
                                              try {
                                                const res =
                                                  await reverseMoneyOnAccountReceiptAction({
                                                    receiptId: rcpt.id,
                                                    reason: reverseReceiptReason.trim(),
                                                  });
                                                if (isActionDenied(res) || !res.ok) {
                                                  showToast(
                                                    formatOpeningGateActionError(
                                                      res,
                                                      'Could not reverse receipt.',
                                                    ),
                                                  );
                                                  return;
                                                }
                                                setReverseTargetReceiptId(null);
                                                setReverseReceiptReason('');
                                                showToast('Receipt reversed.');
                                                router.refresh();
                                              } finally {
                                                setMoaBusy(false);
                                              }
                                            }}
                                          >
                                            Confirm reversal
                                          </button>
                                        </div>
                                      ) : null}
                                    </div>
                                  );
                                })}
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}
          <div className="home-grid">
          {/* LEFT MAIN COLUMN */}
          <div className="home-col">
            {/* PROGRESS PANEL */}
            <section className="home-panel">
              <div className="panel-header">
                <div className="panel-title-group">
                  <h2 className="panel-title">
                    Progress · Stage {currentStageIdx + 1} of {stageSteps.length}
                  </h2>
                </div>
                <div className="panel-actions" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <button
                    type="button"
                    className="panel-link"
                    disabled={currentStageIdx <= 0}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      cursor: currentStageIdx > 0 ? 'pointer' : 'default',
                      opacity: currentStageIdx > 0 ? 1 : 0.45,
                    }}
                    onClick={handleMovePrevStage}
                  >
                    ← Move back a stage
                  </button>
                  <button
                    type="button"
                    className="panel-link"
                    disabled={currentStageIdx >= stageSteps.length - 1}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      cursor: currentStageIdx < stageSteps.length - 1 ? 'pointer' : 'default',
                      opacity: currentStageIdx < stageSteps.length - 1 ? 1 : 0.45,
                    }}
                    onClick={handleMoveNextStage}
                  >
                    Move to next stage →
                  </button>
                </div>
              </div>
              <div className="panel-body padded">
                <div className="matter-stage-grid">
                  {stageSteps.map((st, idx) => {
                    const status = stageStatus(idx, currentStageIdx);
                    const isFilled = status === 'completed' || status === 'current';
                    const isCurrent = status === 'current';
                    const isUpcoming = status === 'upcoming';
                    const metaText = formatStageStatusLabel(idx, currentStageIdx, st);
                    return (
                      <div
                        key={st.name}
                        className="matter-stage-col"
                        style={{ cursor: 'pointer' }}
                        title={`Move to Stage ${idx + 1}: ${st.name}`}
                        onClick={() => void persistStageIdx(idx)}
                      >
                        <div
                          className={`matter-stage-col__bar ${
                            isFilled ? 'matter-stage-col__bar--active' : ''
                          }`}
                        />
                        <div
                          className={`matter-stage-col__name ${
                            isCurrent
                              ? 'matter-stage-col__name--current'
                              : isUpcoming
                                ? 'matter-stage-col__name--upcoming'
                                : ''
                          }`}
                        >
                          {st.name}
                        </div>
                        <div
                          className={`matter-stage-col__meta ${
                            isCurrent ? 'matter-stage-col__meta--current' : ''
                          }`}
                        >
                          {metaText}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>

            {/* FINANCIALS PANEL */}
            {canViewFinance ? (
              <section className="home-panel">
                <div className="panel-header">
                  <div className="panel-title-group">
                    <h2 className="panel-title">Financials</h2>
                    {!pmsFin ? (
                      <StatusPill label="Not linked to PMS" tone="neutral" />
                    ) : null}
                  </div>
                  <div className="panel-actions">
                    <button
                      type="button"
                      className="panel-link"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                      }}
                      onClick={() => setTab('finance')}
                    >
                      Time &amp; billing →
                    </button>
                  </div>
                </div>

                <div className="panel-body padded">
                  <div className="matter-fin-grid">
                    {/* Donut Chart */}
                    <div
                      style={{
                        position: 'relative',
                        width: 124,
                        height: 124,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        margin: '0 auto',
                      }}
                    >
                      <svg width="124" height="124" viewBox="0 0 118 118">
                        <circle
                          cx="59"
                          cy="59"
                          r="44"
                          fill="none"
                          stroke="var(--tw-track)"
                          strokeWidth="15"
                        />
                        <g transform="rotate(-90 59 59)">
                          {donutSegments.map((seg, i) => (
                            <circle
                              key={i}
                              cx="59"
                              cy="59"
                              r="44"
                              fill="none"
                              stroke={seg.color}
                              strokeWidth="15"
                              strokeDasharray={seg.dasharray}
                              strokeDashoffset={seg.dashoffset}
                            />
                          ))}
                        </g>
                      </svg>
                      <div
                        style={{
                          position: 'absolute',
                          inset: 0,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          textAlign: 'center',
                          pointerEvents: 'none',
                        }}
                      >
                        <span
                          style={{
                            fontFamily: 'var(--font-heading)',
                            fontSize: 22,
                            fontWeight: 800,
                            color: 'var(--text-primary)',
                            lineHeight: 1.05,
                          }}
                        >
                          {financials.budgetUsedPct}%
                        </span>
                        <span
                          style={{
                            fontSize: 12,
                            color: 'var(--text-muted)',
                            marginTop: 2,
                          }}
                        >
                          of £{financials.budget.toLocaleString('en-GB')}
                        </span>
                      </div>
                    </div>

                    {/* Legend Breakdown */}
                    <div>
                      <div className="matter-fin-legend-row">
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                          <span
                            className="matter-fin-dot"
                            style={{ background: 'var(--color-primary)' }}
                          />
                          <span style={{ color: 'var(--text-secondary)' }}>Billed &amp; paid</span>
                        </div>
                        <strong
                          style={{
                            fontFamily: 'var(--font-heading)',
                            color: 'var(--text-primary)',
                          }}
                        >
                          £{financials.billedPaid.toLocaleString('en-GB')}
                        </strong>
                      </div>

                      <div className="matter-fin-legend-row">
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                          <span className="matter-fin-dot" style={{ background: '#9e6730' }} />
                          <div>
                            <div style={{ color: 'var(--text-secondary)' }}>Billed, unpaid</div>
                            {financials.overdueSub ? (
                              <div
                                style={{
                                  fontSize: 12.5,
                                  fontWeight: 700,
                                  color: 'var(--pill-warning-fg)',
                                  marginTop: 2,
                                }}
                              >
                                {financials.overdueSub}
                              </div>
                            ) : null}
                          </div>
                        </div>
                        <strong
                          style={{
                            fontFamily: 'var(--font-heading)',
                            color: 'var(--text-primary)',
                          }}
                        >
                          £{financials.billedUnpaid.toLocaleString('en-GB')}
                        </strong>
                      </div>

                      <div className="matter-fin-legend-row">
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                          <span className="matter-fin-dot" style={{ background: '#84b59f' }} />
                          <span style={{ color: 'var(--text-secondary)' }}>Unbilled WIP</span>
                        </div>
                        <strong
                          style={{
                            fontFamily: 'var(--font-heading)',
                            color: 'var(--text-primary)',
                          }}
                        >
                          £{financials.unbilledWip.toLocaleString('en-GB')}
                        </strong>
                      </div>

                      <div className="matter-fin-legend-row">
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                          <span
                            className="matter-fin-dot"
                            style={{ background: 'var(--tw-track)' }}
                          />
                          <span style={{ color: 'var(--text-secondary)' }}>Remaining budget</span>
                        </div>
                        <strong
                          style={{
                            fontFamily: 'var(--font-heading)',
                            color: 'var(--text-primary)',
                          }}
                        >
                          £{financials.remainingBudget.toLocaleString('en-GB')}
                        </strong>
                      </div>
                    </div>

                    {/* Spend vs progress */}
                    <div>
                      <div
                        style={{
                          fontSize: 13,
                          color: 'var(--text-muted)',
                          marginBottom: 8,
                          fontWeight: 600,
                        }}
                      >
                        Spend vs progress
                      </div>

                      <div style={{ marginBottom: 14 }}>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            fontSize: 14,
                            color: 'var(--text-secondary)',
                          }}
                        >
                          <span>Budget used</span>
                          <strong
                            style={{
                              fontFamily: 'var(--font-heading)',
                              color: 'var(--text-primary)',
                            }}
                          >
                            {financials.budgetUsedPct}%
                          </strong>
                        </div>
                        <div className="tw-bar-track" style={{ margin: '6px 0 0' }}>
                          <div
                            className="tw-bar-fill"
                            style={{
                              width: `${financials.budgetUsedPct}%`,
                              background: '#9e6730',
                            }}
                          />
                        </div>
                      </div>

                      <div>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            fontSize: 14,
                            color: 'var(--text-secondary)',
                          }}
                        >
                          <span>Matter progress</span>
                          <strong
                            style={{
                              fontFamily: 'var(--font-heading)',
                              color: 'var(--text-primary)',
                            }}
                          >
                            {financials.matterProgressPct}%
                          </strong>
                        </div>
                        <div className="tw-bar-track" style={{ margin: '6px 0 0' }}>
                          <div
                            className="tw-bar-fill"
                            style={{
                              width: `${financials.matterProgressPct}%`,
                              background: 'var(--color-primary)',
                            }}
                          />
                        </div>
                      </div>

                      {financials.budgetUsedPct > financials.matterProgressPct + 10 ? (
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            color: 'var(--pill-warning-fg)',
                            marginTop: 10,
                            lineHeight: 1.35,
                          }}
                        >
                          Spend is running ahead of progress — consider revising the estimate
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="panel-footer">
                  <span>{financials.footerText}</span>
                </div>
              </section>
            ) : null}

            {/* TASKS PANEL (Exact Home page Task Card A structure & classes) */}
            <section className="home-panel task-card">
              <div className="task-card__header">
                <div className="task-card__title-group">
                  <h2 className="tw-heading">Tasks</h2>
                  <span className="task-card__count-pill">{widgetTasks.length}</span>
                </div>
                <div className="task-card__actions">
                  <button
                    type="button"
                    className="task-card__view-all"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                    }}
                    onClick={() => setTab('tasks')}
                  >
                    View all
                  </button>
                  <button
                    type="button"
                    className="task-card__add-btn"
                    title="New task"
                    aria-label="New task"
                    style={{ cursor: 'pointer' }}
                    onClick={() => setTab('tasks')}
                  >
                    <Plus size={16} />
                  </button>
                </div>
              </div>

              {widgetTasks.length === 0 ? (
                <div className="muted" style={{ padding: '14px 0 4px', fontSize: 13 }}>
                  No open tasks on this matter.
                </div>
              ) : (
                <div className="task-groups">
                  {overdueWidgetTasks.length > 0 ? (
                    <div>
                      <div className="task-group__heading task-group__heading--overdue">
                        OVERDUE
                      </div>
                      <ul className="task-compact-list">
                        {overdueWidgetTasks.map((t) => (
                          <li
                            key={t.id}
                            className="task-compact-row"
                            style={{ gridTemplateColumns: 'minmax(0, 1fr) 40px' }}
                          >
                            <div className="task-compact-row__main">
                              {t.realTask ? (
                                <Link
                                  href={`/tasks?task=${t.realTask.id}`}
                                  className="task-compact-row__title"
                                >
                                  {t.title}
                                </Link>
                              ) : (
                                <span className="task-compact-row__title">{t.title}</span>
                              )}
                              <div className="task-compact-row__meta">
                                {taskTypeIconForLabel(t.typeLabel)}
                                <span>{t.typeLabel}</span>
                                <span>·</span>
                                <span>{t.assigneeName}</span>
                                <span>·</span>
                                <span className="todo-keydate-tag">{t.dueLabel}</span>
                              </div>
                            </div>
                            <button
                              type="button"
                              className="task-compact-row__check-btn"
                              title="Mark complete"
                              aria-label={`Mark ${t.title} complete`}
                              onClick={() => handleCompleteWidgetTask(t)}
                            >
                              <Check size={17} strokeWidth={2.5} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {upcomingWidgetTasks.length > 0 ? (
                    <div>
                      <div className="task-group__heading">UPCOMING</div>
                      <ul className="task-compact-list">
                        {upcomingWidgetTasks.map((t) => (
                          <li
                            key={t.id}
                            className="task-compact-row"
                            style={{ gridTemplateColumns: 'minmax(0, 1fr) 40px' }}
                          >
                            <div className="task-compact-row__main">
                              {t.realTask ? (
                                <Link
                                  href={`/tasks?task=${t.realTask.id}`}
                                  className="task-compact-row__title"
                                >
                                  {t.title}
                                </Link>
                              ) : (
                                <span className="task-compact-row__title">{t.title}</span>
                              )}
                              <div className="task-compact-row__meta">
                                {taskTypeIconForLabel(t.typeLabel)}
                                <span>{t.typeLabel}</span>
                                <span>·</span>
                                <span>{t.assigneeName}</span>
                                <span>·</span>
                                <span>{t.dueLabel}</span>
                              </div>
                            </div>
                            <button
                              type="button"
                              className="task-compact-row__check-btn"
                              title="Mark complete"
                              aria-label={`Mark ${t.title} complete`}
                              onClick={() => handleCompleteWidgetTask(t)}
                            >
                              <Check size={17} strokeWidth={2.5} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              )}
            </section>

            {/* PARTIES PANEL */}
            <section className="home-panel">
              <div className="panel-header">
                <div className="panel-title-group">
                  <h2 className="panel-title">Parties ({overviewParties.length})</h2>
                </div>
                <div className="panel-actions">
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => setTab('parties')}
                  >
                    + Add party
                  </button>
                </div>
              </div>

              <div className="panel-body">
                <ul className="worklist">
                  {overviewParties.map((pt) => (
                    <li key={pt.id} className="worklist-row">
                      <div className="worklist-main">
                        <div className="worklist-title">
                          {pt.href ? <Link href={pt.href}>{pt.name}</Link> : <span>{pt.name}</span>}
                        </div>
                        <div className="worklist-meta">{pt.sub}</div>
                      </div>
                      <div className="worklist-right">
                        <StatusPill label={pt.badge} tone={pt.tone} />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          </div>

          {/* RIGHT SIDEBAR COLUMN */}
          <div className="home-col">
            {/* KEY DATES PANEL */}
            <section className="home-panel">
              <div className="panel-header">
                <div className="panel-title-group">
                  <h2 className="panel-title">Key dates</h2>
                </div>
                <div className="panel-actions">
                  <button
                    type="button"
                    className="panel-link"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                    }}
                    onClick={() => setTab('tasks')}
                  >
                    {userKeyDatePermissions.includes('keydate:edit')
                      ? '+ Add'
                      : 'View all →'}
                  </button>
                </div>
              </div>

              <div className="panel-body">
                <ul className="worklist">
                  {keyDatesList.map((kd) => (
                    <li
                      key={kd.id}
                      className="worklist-row"
                      style={{ alignItems: 'flex-start' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                        <div
                          className={`matter-cal-badge ${
                            kd.overdue ? 'matter-cal-badge--overdue' : ''
                          }`}
                        >
                          <span className="matter-cal-badge__month">{kd.month}</span>
                          <span className="matter-cal-badge__day">{kd.day}</span>
                        </div>
                        <div className="worklist-main">
                          <div className="worklist-title">{kd.title}</div>
                          <div className="worklist-meta">{kd.sub}</div>
                          {kd.pill ? (
                            <div style={{ marginTop: 6 }}>
                              <StatusPill label={kd.pill} tone={kd.pillTone} />
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            {/* INTAKE & COMPLIANCE PANEL */}
            <section className="home-panel">
              <div className="panel-header">
                <div className="panel-title-group">
                  <h2 className="panel-title">Intake &amp; compliance</h2>
                </div>
                <div className="panel-actions">
                  <button
                    type="button"
                    className="panel-link"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                    }}
                    onClick={() => setTab('compliance')}
                  >
                    Details →
                  </button>
                </div>
              </div>

              <div className="panel-body">
                <ul className="worklist">
                  <li
                    className="worklist-row"
                    style={{ cursor: 'pointer' }}
                    onClick={() => setTab('compliance')}
                  >
                    <div
                      className="worklist-main"
                      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                      {intakeComplianceRows.conflictCheck.cleared ? (
                        <Check size={16} color="var(--pill-positive-fg)" strokeWidth={2.5} />
                      ) : (
                        <AlertCircle size={16} color="var(--pill-warning-fg)" />
                      )}
                      <span
                        style={{
                          fontSize: 14.5,
                          color: intakeComplianceRows.conflictCheck.cleared
                            ? 'var(--teal)'
                            : undefined,
                          fontWeight: intakeComplianceRows.conflictCheck.cleared ? 600 : 400,
                        }}
                      >
                        {intakeComplianceRows.conflictCheck.label}
                      </span>
                    </div>
                    <div className="worklist-right">
                      <span className="worklist-meta">
                        {intakeComplianceRows.conflictCheck.detail} →
                      </span>
                    </div>
                  </li>

                  <li className="worklist-row">
                    <div
                      className="worklist-main"
                      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                      {intakeComplianceRows.clientDueDiligence.verified ? (
                        <Check size={16} color="var(--pill-positive-fg)" strokeWidth={2.5} />
                      ) : intakeComplianceRows.clientDueDiligence.neutral ? (
                        <AlertCircle size={16} color="var(--muted)" />
                      ) : (
                        <AlertCircle size={16} color="var(--pill-warning-fg)" />
                      )}
                      <span style={{ fontSize: 14.5 }}>
                        {intakeComplianceRows.clientDueDiligence.label}
                      </span>
                    </div>
                    <div className="worklist-right">
                      <span
                        className="worklist-meta"
                        style={
                          intakeComplianceRows.clientDueDiligence.neutral
                            ? { color: 'var(--muted)' }
                            : !intakeComplianceRows.clientDueDiligence.verified
                              ? { color: 'var(--pill-warning-fg)', fontWeight: 700 }
                              : undefined
                        }
                      >
                        {intakeComplianceRows.clientDueDiligence.detail}
                      </span>
                    </div>
                  </li>

                  <li className="worklist-row">
                    <div
                      className="worklist-main"
                      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                      {intakeComplianceRows.engagementLetter.signed ? (
                        <Check size={16} color="var(--pill-positive-fg)" strokeWidth={2.5} />
                      ) : (
                        <AlertCircle size={16} color="var(--pill-warning-fg)" />
                      )}
                      <span style={{ fontSize: 14.5 }}>
                        {intakeComplianceRows.engagementLetter.label}
                      </span>
                    </div>
                    <div className="worklist-right">
                      <span className="worklist-meta">
                        {intakeComplianceRows.engagementLetter.detail}
                      </span>
                    </div>
                  </li>

                  <li
                    className="worklist-row"
                    style={{ cursor: 'pointer' }}
                    onClick={() => {
                      setPendingRegisterCreateTypeKey(undefined);
                      setTab('compliance');
                    }}
                  >
                    <div
                      className="worklist-main"
                      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                      {intakeComplianceRows.riskAssessment.completed ? (
                        <Check size={16} color="var(--pill-positive-fg)" strokeWidth={2.5} />
                      ) : (
                        <AlertCircle size={16} color="var(--pill-warning-fg)" />
                      )}
                      <span
                        style={{
                          fontSize: 14.5,
                          color: intakeComplianceRows.riskAssessment.completed
                            ? 'var(--teal)'
                            : undefined,
                          fontWeight: intakeComplianceRows.riskAssessment.completed ? 600 : 400,
                        }}
                      >
                        {intakeComplianceRows.riskAssessment.label}
                      </span>
                    </div>
                    <div className="worklist-right">
                      <span className="worklist-meta">
                        {intakeComplianceRows.riskAssessment.detail} →
                      </span>
                    </div>
                  </li>
                </ul>
              </div>
            </section>

            {/* UNDERTAKINGS & REGISTERS PANEL */}
            {canViewMatterRegisters ? (
              <section className="home-panel" aria-label="Undertakings and registers">
                <div className="panel-header">
                  <div className="panel-title-group">
                    <h2 className="panel-title">Undertakings &amp; registers</h2>
                  </div>
                  <div className="panel-actions">
                    {canCreateMatterUndertaking ? (
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        data-testid="matter-overview-new-undertaking"
                        onClick={handleOpenNewUndertaking}
                      >
                        + New undertaking
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="panel-link"
                        style={{
                          background: 'transparent',
                          border: 'none',
                          padding: 0,
                          cursor: 'pointer',
                        }}
                        onClick={() => {
                          setPendingRegisterCreateTypeKey(undefined);
                          setTab('compliance');
                        }}
                      >
                        View registers →
                      </button>
                    )}
                  </div>
                </div>

                <div className="panel-body">
                  <ul className="worklist">
                    <li
                      className="worklist-row"
                      style={{ cursor: 'pointer' }}
                      onClick={() => {
                        setPendingRegisterCreateTypeKey(undefined);
                        setTab('compliance');
                      }}
                    >
                      <div className="worklist-main">
                        <div className="worklist-title">
                          {openMatterUndertakingsCount} open{' '}
                          {openMatterUndertakingsCount === 1 ? 'undertaking' : 'undertakings'}
                        </div>
                        <div className="worklist-meta">
                          {matterRegisterRecords.length} total register{' '}
                          {matterRegisterRecords.length === 1 ? 'entry' : 'entries'} linked to this
                          matter
                        </div>
                      </div>
                      <div className="worklist-right">
                        <span className="worklist-meta">Compliance tab →</span>
                      </div>
                    </li>
                  </ul>
                </div>
              </section>
            ) : null}

            {/* TEAM PANEL */}
            <section className="home-panel">
              <div className="panel-header">
                <div className="panel-title-group">
                  <h2 className="panel-title">Team</h2>
                </div>
                <div className="panel-actions">
                  <Link href={`/matters/${matter.id}/edit`} className="panel-link">
                    Manage →
                  </Link>
                </div>
              </div>

              <div className="panel-body">
                <ul className="worklist">
                  {teamMembersList.map((tm) => (
                    <li key={tm.id} className="worklist-row">
                      <div
                        className="worklist-main"
                        style={{ display: 'flex', alignItems: 'center', gap: 10 }}
                      >
                        <div
                          className="client-avatar client-avatar--sm"
                          style={{
                            background: tm.avatarBg,
                            color: tm.avatarColor,
                          }}
                        >
                          {tm.initials}
                        </div>
                        <div>
                          <div className="worklist-title" style={{ marginBottom: 0 }}>
                            <Link href={`/people/${tm.id}`}>{tm.name}</Link>
                          </div>
                          <div className="worklist-meta">{tm.role}</div>
                        </div>
                      </div>
                      <div className="worklist-right">
                        <span className="worklist-meta" style={{ fontWeight: 600 }}>
                          {tm.hours}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            {/* MATTER FACTS PANEL */}
            <section className="home-panel">
              <div className="panel-header">
                <div className="panel-title-group">
                  <h2 className="panel-title">Matter facts</h2>
                </div>
                <div className="panel-actions">
                  <Link href={`/matters/${matter.id}/edit`} className="panel-link">
                    Edit →
                  </Link>
                </div>
              </div>

              <div className="panel-body">
                <ul className="worklist">
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-meta">Client reference</div>
                      <div className="worklist-title" style={{ marginTop: 2, marginBottom: 0 }}>
                        {((matter.fieldValues['CORE-005'] as string) || '').trim() || (
                          <span className="muted">Not recorded</span>
                        )}
                      </div>
                    </div>
                  </li>

                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-meta">Claim value (estimated)</div>
                      <div className="worklist-title" style={{ marginTop: 2, marginBottom: 0 }}>
                        {(() => {
                          const rawClaimValue = (
                            (matter.fieldValues['claimValue'] as string) || ''
                          ).trim();
                          if (rawClaimValue) return rawClaimValue;
                          if (sizeLabel && sizeLabel.toLowerCase() !== 'unknown value') {
                            return sizeLabel;
                          }
                          return <span className="muted">Not recorded</span>;
                        })()}
                      </div>
                    </div>
                  </li>

                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-meta">Office · Department</div>
                      <div className="worklist-title" style={{ marginTop: 2, marginBottom: 0 }}>
                        {(() => {
                          const office = (
                            (matter.fieldValues['responsibleOffice'] as string) || ''
                          ).trim();
                          const dept = (practiceLabel || '').trim();
                          const parts = [office, dept].filter(Boolean);
                          if (parts.length === 0) {
                            return <span className="muted">Not recorded</span>;
                          }
                          return parts.join(' · ');
                        })()}
                      </div>
                    </div>
                  </li>

                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-meta">Source of work</div>
                      <div className="worklist-title" style={{ marginTop: 2, marginBottom: 0 }}>
                        {((matter.fieldValues['sourceOfWork'] as string) || '').trim() ||
                          originLabel || <span className="muted">Not recorded</span>}
                      </div>
                    </div>
                  </li>

                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-meta">Closed &amp; file retention</div>
                      <div className="worklist-title" style={{ marginTop: 2, marginBottom: 0 }}>
                        {matter.closedAt ? (
                          <span>
                            Closed {formatDate(matter.closedAt)}
                            {matter.retentionPeriod ? ` · Retention: ${matter.retentionPeriod}` : ''}
                            {matter.destructionDueAt
                              ? ` · Destruction due: ${formatDate(matter.destructionDueAt)}`
                              : ''}
                          </span>
                        ) : (
                          <span className="muted">
                            {matter.retentionPeriod
                              ? `Policy: ${matter.retentionPeriod} (destruction date set on closure)`
                              : 'Destruction due date calculated upon closure'}
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                </ul>
              </div>
            </section>
          </div>
        </div>
        </>
      ) : null}

      {/* ===================== TAB: PARTIES ===================== */}
      {tab === 'parties' ? (
        <section className="home-panel">
          <div className="panel-header">
            <div className="panel-title-group">
              <h2 className="panel-title">Parties ({overviewParties.length})</h2>
            </div>
            <div className="panel-actions">
              <Link href={`/matters/${matter.id}/edit`} className="btn btn--secondary btn--sm">
                + Add / edit parties
              </Link>
            </div>
          </div>
          <div className="panel-body">
            <ul className="worklist">
              {overviewParties.map((pt) => (
                <li key={pt.id} className="worklist-row">
                  <div className="worklist-main">
                    <div className="worklist-title">
                      {pt.href ? <Link href={pt.href}>{pt.name}</Link> : <span>{pt.name}</span>}
                    </div>
                    <div className="worklist-meta">{pt.sub}</div>
                  </div>
                  <div className="worklist-right">
                    <StatusPill label={pt.badge} tone={pt.tone} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {/* ===================== TAB: DOCUMENTS ===================== */}
      {tab === 'documents' ? (
        <div className="home-col">
          <MatterDocumentStoreSection
            matterId={matter.id}
            matterNumber={matter.matterNumber}
          />
          <DocumentListSection
            entityType="matter"
            entityId={matter.id}
            matter={matter}
            people={people}
            organisations={organisations}
            values={values}
            currentUserId={currentUserId}
          />
          <section className="home-panel">
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Archived &amp; DMS Matter Records</h2>
              </div>
              <div className="panel-actions" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <StatusPill
                  label="Matter opening record archived"
                  tone="neutral"
                />
              </div>
            </div>
            <div className="panel-body">
              <ul className="worklist">
                <li className="worklist-row">
                <div className="worklist-main">
                  <div className="worklist-title">
                    <FileText
                      size={14}
                      style={{
                        display: 'inline',
                        verticalAlign: 'text-bottom',
                        marginRight: 6,
                        color: 'var(--color-primary)',
                      }}
                    />
                    <strong>
                      {matter.matterNumber} — Complete Matter Opening Record (Immutable Snapshot).pdf
                    </strong>
                  </div>
                  <div className="worklist-meta">
                    Matter Opening Archive (Schema {openingSnapshot.version}) · Captured{' '}
                    {openingSnapshot.capturedAtDisplay} by {openingSnapshot.capturedByName} · Frozen
                    against future process changes
                  </div>
                </div>
                <div className="worklist-right" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <StatusPill label="Immutable PDF" tone="positive" />
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    style={{ borderRadius: 999 }}
                    onClick={() => {
                      downloadMatterOpeningPdf(openingSnapshot);
                      showToast(
                        `Downloaded immutable PDF: Matter-Opening-Record-${matter.matterNumber}.pdf`,
                      );
                    }}
                  >
                    <Download size={13} />
                    <span>Download PDF</span>
                  </button>
                </div>
              </li>
            </ul>
          </div>
          </section>
        </div>
      ) : null}

      {/* ===================== TAB: TASKS & DATES ===================== */}
      {tab === 'tasks' ? (
        <div className="home-col">
          {keyDatesConfig && currentUser ? (
            <KeyDatesPanel
              matter={matter}
              config={keyDatesConfig}
              keyDates={keyDates}
              notApplicableRecords={keyDateNotApplicable}
              reminderStates={keyDateReminderStates}
              calendarSyncs={keyDateCalendarSyncs}
              currentUser={currentUser}
              userPermissions={userKeyDatePermissions}
              canVerifyByKeyDateId={canVerifyByKeyDateId}
              teams={teams}
              employees={employees ?? people.filter((p) => p.isEmployee)}
            />
          ) : null}

          <section className="home-panel">
            <div className="panel-header">
              <div className="panel-title-group">
                <CalendarClock size={15} />
                <h2 className="panel-title">
                  Critical dates &amp; key deadlines ({keyDatesList.length})
                </h2>
              </div>
            </div>
            <div className="panel-body">
              <ul className="worklist">
                {keyDatesList.map((kd) => (
                  <li key={kd.id} className="worklist-row">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div
                        className={`matter-cal-badge ${
                          kd.overdue ? 'matter-cal-badge--overdue' : ''
                        }`}
                      >
                        <span className="matter-cal-badge__month">{kd.month}</span>
                        <span className="matter-cal-badge__day">{kd.day}</span>
                      </div>
                      <div className="worklist-main">
                        <div className="worklist-title">{kd.title}</div>
                        <div className="worklist-meta">{kd.sub}</div>
                      </div>
                    </div>
                    {kd.pill ? (
                      <div className="worklist-right">
                        <StatusPill label={kd.pill} tone={kd.pillTone} />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <RecordTasksSection
            recordType="matter"
            recordId={matter.id}
            recordLabel={`${matter.matterNumber} — ${matter.title}`}
            defaultPersonId={matter.leadFeeEarnerId || currentUserId}
            tasks={tasks}
            teams={teams}
            people={people}
            values={values}
            currentUserId={currentUserId}
            canTakeByTaskId={canTakeByTaskId}
          />
        </div>
      ) : null}

      {/* ===================== TAB: TIME & BILLING ===================== */}
      {tab === 'finance' && canViewFinance ? (
        <div>
          {pmsView ? (
            <MatterFinanceTab
              matterId={matter.id}
              matterNumber={matter.matterNumber}
              pmsView={pmsView}
              currentUserRole={currentUserRole}
              moaSummary={{
                agreedPence: moneyOnAccountAgreedPence ?? null,
                requestedPence: moaSummaryMetrics.requestedPence,
                receivedPence: moaSummaryMetrics.receivedPence,
                requestCount: moaSummaryMetrics.nonCancelledRequests.length,
                gateRequired: Boolean(moaSummaryMetrics.fundsPre?.required),
              }}
            />
          ) : (
            <section className="home-panel">
              <div className="panel-header">
                <h2 className="panel-title">Financial summary</h2>
              </div>
              <div className="panel-body padded">
                <div className="kv-grid">
                  <div className="kv-item">
                    <span className="kv-label">Fee estimate / agreed fee</span>
                    <span className="kv-value">£{financials.budget.toLocaleString('en-GB')}</span>
                  </div>
                  <div className="kv-item">
                    <span className="kv-label">Billed &amp; paid</span>
                    <span className="kv-value">
                      £{financials.billedPaid.toLocaleString('en-GB')}
                    </span>
                  </div>
                  <div className="kv-item">
                    <span className="kv-label">Billed, unpaid</span>
                    <span className="kv-value">
                      £{financials.billedUnpaid.toLocaleString('en-GB')}
                    </span>
                  </div>
                  <div className="kv-item">
                    <span className="kv-label">Unbilled WIP</span>
                    <span className="kv-value">
                      £{financials.unbilledWip.toLocaleString('en-GB')}
                    </span>
                  </div>
                </div>
              </div>
            </section>
          )}
        </div>
      ) : null}

      {/* ===================== TAB: COMPLIANCE ===================== */}
      {tab === 'compliance' ? (
        <div className="home-col">
          {/* SAVED CONFLICT CHECK RECORD CARD (READ-ONLY) */}
          {(() => {
            const rec = resolvedConflictRecord;
            const allRuns = [...extraConflictRuns, ...(rec.runs ?? [])];

            return (
              <section
                className="home-panel"
                aria-label="Conflict check record"
              >
                <div className="panel-header">
                  <div
                    className="panel-title-group"
                    style={{ cursor: 'pointer', userSelect: 'none' }}
                    onClick={() => setConflictRecordMinimised((m) => !m)}
                  >
                    {conflictRecordMinimised ? (
                      <ChevronRight size={16} color="var(--text-secondary)" />
                    ) : (
                      <ChevronDown size={16} color="var(--text-secondary)" />
                    )}
                    <ShieldCheck size={16} color="var(--pill-positive-fg)" />
                    <h2 className="panel-title">Conflict check record</h2>
                    <StatusPill
                      label={
                        isPmsImportedWithoutLocalConflictCheck(matter)
                          ? 'Imported from PMS'
                          : rec.status
                      }
                      tone={
                        rec.status === 'Cleared' || rec.status === 'Approved'
                          ? 'positive'
                          : rec.status === 'Referred'
                            ? 'warning'
                            : rec.status === 'Declined'
                              ? 'alert'
                              : 'neutral'
                      }
                    />
                    {conflictRecordMinimised || isPmsImportedWithoutLocalConflictCheck(matter) ? (
                      <span
                        className="muted"
                        style={{ fontSize: 12.5, fontWeight: 500, marginLeft: 4 }}
                      >
                        {isPmsImportedWithoutLocalConflictCheck(matter)
                          ? PMS_IMPORTED_CONFLICT_STATUS_LABEL
                          : `${rec.outcomeLabel} · ${rec.parties.length} parties checked · ${rec.matches.length} ${rec.matches.length === 1 ? 'match' : 'matches'}`}
                      </span>
                    ) : null}
                  </div>
                  <div className="panel-actions" style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      style={{ borderRadius: 999 }}
                      onClick={() => setConflictRecordMinimised((m) => !m)}
                    >
                      {conflictRecordMinimised ? (
                        <>
                          <Maximize2 size={13} />
                          <span>Maximise</span>
                        </>
                      ) : (
                        <>
                          <Minimize2 size={13} />
                          <span>Minimise</span>
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      style={{ borderRadius: 999 }}
                      onClick={async () => {
                        const actorName = currentUser
                          ? personDisplayName(currentUser)
                          : (nameMap.get(currentUserId) ?? currentUserId);
                        const newRun = {
                          id: `run-${Date.now()}`,
                          runAtDisplay: formatDateTime(new Date().toISOString()),
                          runById: currentUserId,
                          runByName: actorName,
                          searchTerms: rec.parties.map((p) => p.name),
                          partiesCount: rec.parties.length,
                          matchesCount: rec.matches.length,
                          potentialConflictsCount: rec.matches.filter(
                            (m) => m.disposition === 'potential_conflict',
                          ).length,
                        };
                        setExtraConflictRuns((prev) => [newRun, ...prev]);
                        await updateMatterConflictRecordAction(matter.id, {
                          ...rec,
                          lastRunAtDisplay: newRun.runAtDisplay,
                          runs: [newRun, ...(rec.runs ?? [])],
                        });
                        showToast(
                          `Conflict check re-run completed (${rec.parties.length} parties checked) · Snapshot updated`,
                        );
                      }}
                    >
                      <RefreshCw size={13} />
                      <span>Re-run check</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      style={{ borderRadius: 999 }}
                      onClick={() => {
                        downloadConflictCheckPdf(
                          matter.matterNumber,
                          matter.title,
                          rec,
                          firmName,
                        );
                        showToast(
                          `Exported PDF: Conflict-Check-Record-${matter.matterNumber}.pdf`,
                        );
                      }}
                    >
                      <Download size={13} />
                      <span>Export PDF</span>
                    </button>
                  </div>
                </div>

                {!conflictRecordMinimised ? (
                  <div className="panel-body padded">
                    {/* SUMMARY METADATA GRID */}
                    <div
                      className="kv-grid"
                      style={{
                        paddingBottom: 16,
                        marginBottom: 16,
                        borderBottom: '1px solid var(--border-subtle)',
                      }}
                    >
                      <div className="kv-item">
                        <span className="kv-label">Outcome</span>
                        <span className="kv-value">
                          <StatusPill
                            label={rec.outcomeLabel}
                            tone={
                              rec.outcomeLabel.includes('Cleared') ||
                              rec.outcomeLabel.includes('Approved')
                                ? 'positive'
                                : rec.outcomeLabel.includes('Referred')
                                  ? 'warning'
                                  : 'alert'
                            }
                          />
                        </span>
                      </div>
                      <div className="kv-item">
                        <span className="kv-label">Submitted by &amp; when</span>
                        <span className="kv-value">
                          {rec.submittedByName || 'Not recorded'} ·{' '}
                          {rec.submittedAtDisplay || '—'}
                        </span>
                      </div>
                      <div className="kv-item">
                        <span className="kv-label">Approved / cleared by &amp; when</span>
                        <span className="kv-value">
                          {rec.approvedByName || 'Not recorded'} ·{' '}
                          {rec.approvedAtDisplay || '—'}
                        </span>
                      </div>
                      <div className="kv-item">
                        <span className="kv-label">Declaration</span>
                        <span className="kv-value">
                          ✓ Confirmed complete to best of fee earner&apos;s knowledge
                        </span>
                      </div>
                    </div>

                    {/* PARTIES CHECKED */}
                    <div style={{ marginBottom: 18 }}>
                      <div
                        style={{
                          fontSize: 11.5,
                          fontWeight: 800,
                          letterSpacing: '0.07em',
                          textTransform: 'uppercase',
                          color: 'var(--text-secondary)',
                          marginBottom: 8,
                        }}
                      >
                        Parties checked ({rec.parties.length})
                      </div>
                      <ul
                        className="worklist"
                        style={{
                          border: '1px solid var(--border-subtle)',
                          borderRadius: 10,
                          padding: '0 14px',
                        }}
                      >
                        {rec.parties.map((pt) => (
                          <li key={pt.id} className="worklist-row">
                            <div className="worklist-main">
                              <div className="worklist-title">{pt.name}</div>
                              {pt.subtitle ? (
                                <div className="worklist-meta">{pt.subtitle}</div>
                              ) : null}
                            </div>
                            <div className="worklist-right">
                              <StatusPill
                                label={pt.role}
                                tone={
                                  pt.role === 'Client'
                                    ? 'positive'
                                    : pt.role === 'Opponent'
                                      ? 'warning'
                                      : 'neutral'
                                }
                              />
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>

                    {/* MATCHES & DISPOSITIONS */}
                    <div style={{ marginBottom: 18 }}>
                      <div
                        style={{
                          fontSize: 11.5,
                          fontWeight: 800,
                          letterSpacing: '0.07em',
                          textTransform: 'uppercase',
                          color: 'var(--text-secondary)',
                          marginBottom: 8,
                        }}
                      >
                        Matches &amp; dispositions ({rec.matches.length})
                      </div>
                      {rec.matches.length === 0 ? (
                        <div
                          style={{
                            padding: '12px 14px',
                            borderRadius: 10,
                            background: 'var(--pill-positive-bg)',
                            color: 'var(--pill-positive-fg)',
                            fontSize: 13,
                            fontWeight: 600,
                          }}
                        >
                          No matches found across open or closed matters.
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                          {rec.matches.map((m) => (
                            <div key={m.id} className="conflict-match-row">
                              <div className="conflict-match-row__top">
                                <div>
                                  <div
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: 8,
                                      flexWrap: 'wrap',
                                    }}
                                  >
                                    <strong style={{ fontSize: 13.5 }}>
                                      {m.matchedRecordName}
                                    </strong>
                                    <StatusPill
                                      label={`${m.strength} match`}
                                      tone={
                                        m.strength === 'Exact'
                                          ? 'alert'
                                          : m.strength === 'Close'
                                            ? 'warning'
                                            : 'neutral'
                                      }
                                    />
                                    <span
                                      style={{
                                        fontSize: 13,
                                        fontWeight: 600,
                                        color: 'var(--text-primary)',
                                      }}
                                    >
                                      {m.whereFound}
                                    </span>
                                  </div>
                                  <div
                                    style={{
                                      fontSize: 12,
                                      color: 'var(--text-secondary)',
                                      marginTop: 2,
                                    }}
                                  >
                                    Responsible partner: {m.responsiblePartnerName} · Date:{' '}
                                    {m.dateLabel}
                                  </div>
                                </div>
                                <StatusPill
                                  label={
                                    m.disposition === 'not_the_same'
                                      ? 'Not the same'
                                      : m.disposition === 'potential_conflict'
                                        ? 'Potential conflict'
                                        : 'Same – no conflict'
                                  }
                                  tone={
                                    m.disposition === 'potential_conflict'
                                      ? 'warning'
                                      : 'positive'
                                  }
                                />
                              </div>
                              {m.note ? (
                                <div
                                  style={{
                                    marginTop: 8,
                                    paddingTop: 8,
                                    borderTop: '1px solid var(--border-subtle)',
                                    fontSize: 12.5,
                                    color: 'var(--text-primary)',
                                  }}
                                >
                                  <span
                                    style={{
                                      color: 'var(--text-secondary)',
                                      fontWeight: 600,
                                    }}
                                  >
                                    Disposition note:{' '}
                                  </span>
                                  {m.note}
                                </div>
                              ) : null}
                              {m.reviewerDecision ? (
                                <div
                                  style={{
                                    marginTop: 6,
                                    fontSize: 12.5,
                                    color: 'var(--text-primary)',
                                  }}
                                >
                                  <span
                                    style={{
                                      color: 'var(--text-secondary)',
                                      fontWeight: 600,
                                    }}
                                  >
                                    Risk / Compliance decision ({m.reviewedByName || 'Reviewer'}
                                    ):{' '}
                                  </span>
                                  <strong>
                                    {m.reviewerDecision === 'approve_with_conditions'
                                      ? `Approved with conditions (${
                                          m.reviewerConditionType === 'information_barrier'
                                            ? 'Information barrier'
                                            : 'Consent obtained'
                                        })`
                                      : m.reviewerDecision === 'approve'
                                        ? 'Approved'
                                        : 'Declined'}
                                  </strong>
                                  {m.reviewerNote ? ` — ${m.reviewerNote}` : ''}
                                </div>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* AUDIT TRAIL OF EACH SEARCH RUN */}
                    <div>
                      <div
                        style={{
                          fontSize: 11.5,
                          fontWeight: 800,
                          letterSpacing: '0.07em',
                          textTransform: 'uppercase',
                          color: 'var(--text-secondary)',
                          marginBottom: 8,
                        }}
                      >
                        Search run audit trail ({allRuns.length})
                      </div>
                      <ul
                        className="worklist"
                        style={{
                          border: '1px solid var(--border-subtle)',
                          borderRadius: 10,
                          padding: '0 14px',
                        }}
                      >
                        {allRuns.map((run) => (
                          <li key={run.id} className="worklist-row">
                            <div className="worklist-main">
                              <div className="worklist-title">
                                Run {run.runAtDisplay} by {run.runByName}
                              </div>
                              <div className="worklist-meta">
                                Terms searched: {run.searchTerms.join(', ')}
                              </div>
                            </div>
                            <div className="worklist-right">
                              <span className="worklist-meta" style={{ fontWeight: 600 }}>
                                {run.partiesCount} parties · {run.matchesCount}{' '}
                                {run.matchesCount === 1 ? 'match' : 'matches'} ·{' '}
                                {run.potentialConflictsCount} potential conflicts
                              </span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ) : null}
              </section>
            );
          })()}

          {/* SAVED MATTER RISK ASSESSMENT CARD (READ-ONLY) */}
          {(() => {
            const riskSnap = resolvedRiskAssessment;
            const riskTonePill: 'alert' | 'warning' | 'positive' =
              riskSnap.overallRisk === 'High'
                ? 'alert'
                : riskSnap.overallRisk === 'Medium'
                  ? 'warning'
                  : 'positive';

            return (
              <section
                className="home-panel"
                aria-label="Matter risk assessment"
              >
                <div className="panel-header">
                  <div
                    className="panel-title-group"
                    style={{ cursor: 'pointer', userSelect: 'none' }}
                    onClick={() => setRiskRecordMinimised((m) => !m)}
                  >
                    {riskRecordMinimised ? (
                      <ChevronRight size={16} color="var(--text-secondary)" />
                    ) : (
                      <ChevronDown size={16} color="var(--text-secondary)" />
                    )}
                    <ShieldAlert
                      size={16}
                      color={
                        riskSnap.overallRisk === 'High'
                          ? 'var(--pill-alert-fg)'
                          : riskSnap.overallRisk === 'Medium'
                            ? 'var(--pill-warning-fg)'
                            : 'var(--pill-positive-fg)'
                      }
                    />
                    <h2 className="panel-title">Matter risk assessment</h2>
                    <StatusPill
                      label={
                        riskSnap.overallRisk
                          ? `${riskSnap.overallRisk} risk`
                          : 'Not assessed'
                      }
                      tone={riskTonePill}
                    />
                    {riskRecordMinimised ? (
                      <span
                        className="muted"
                        style={{ fontSize: 12.5, fontWeight: 500, marginLeft: 4 }}
                      >
                        {riskSnap.completedQuestions} of {riskSnap.totalQuestions}{' '}
                        questions completed
                        {riskSnap.completedByName
                          ? ` · Assessed by ${riskSnap.completedByName}`
                          : ' · Not yet assessed'}
                      </span>
                    ) : null}
                  </div>
                  <div className="panel-actions" style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      style={{ borderRadius: 999 }}
                      onClick={() => setRiskRecordMinimised((m) => !m)}
                    >
                      {riskRecordMinimised ? (
                        <>
                          <Maximize2 size={13} />
                          <span>Maximise</span>
                        </>
                      ) : (
                        <>
                          <Minimize2 size={13} />
                          <span>Minimise</span>
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      style={{ borderRadius: 999 }}
                      onClick={() => {
                        downloadRiskAssessmentPdf(
                          matter.matterNumber,
                          matter.title,
                          riskSnap,
                          firmName,
                        );
                        showToast(
                          `Exported PDF: Matter-Risk-Assessment-${matter.matterNumber}.pdf`,
                        );
                      }}
                    >
                      <Download size={13} />
                      <span>Export PDF</span>
                    </button>
                  </div>
                </div>

                {!riskRecordMinimised ? (
                  <div className="panel-body padded">
                    <div
                      className="kv-grid"
                      style={{
                        paddingBottom: 16,
                        marginBottom: 16,
                        borderBottom: '1px solid var(--border-subtle)',
                      }}
                    >
                      <div className="kv-item">
                        <span className="kv-label">Overall risk rating</span>
                        <span className="kv-value">
                          <StatusPill
                            label={
                              riskSnap.overallRisk
                                ? `${riskSnap.overallRisk} risk`
                                : 'Not assessed'
                            }
                            tone={riskTonePill}
                          />
                        </span>
                      </div>
                      <div className="kv-item">
                        <span className="kv-label">Questions completed</span>
                        <span className="kv-value">
                          {riskSnap.completedQuestions} of {riskSnap.totalQuestions}
                        </span>
                      </div>
                      <div className="kv-item">
                        <span className="kv-label">Assessed by &amp; when</span>
                        <span className="kv-value">
                          {riskSnap.completedByName && riskSnap.completedAt
                            ? `${riskSnap.completedByName} · ${formatDateTime(riskSnap.completedAt)}`
                            : 'Not yet assessed'}
                        </span>
                      </div>
                      <div className="kv-item">
                        <span className="kv-label">MLR 2017 regulated scope</span>
                        <span className="kv-value">
                          {riskSnap.isMlrInScope
                            ? 'In scope (Regulated sector)'
                            : 'Out of scope (General risk & sanctions only)'}
                        </span>
                      </div>
                    </div>

                    {riskSnap.customKeyDates && riskSnap.customKeyDates.length > 0 ? (
                      <div style={{ marginBottom: 16 }}>
                        <div
                          style={{
                            fontSize: 11.5,
                            fontWeight: 800,
                            letterSpacing: '0.07em',
                            textTransform: 'uppercase',
                            color: 'var(--text-secondary)',
                            marginBottom: 8,
                          }}
                        >
                          Key dates recorded during risk assessment ({riskSnap.customKeyDates.length})
                        </div>
                        <ul
                          className="worklist"
                          style={{
                            border: '1px solid var(--border-subtle)',
                            borderRadius: 10,
                            padding: '0 14px',
                          }}
                        >
                          {riskSnap.customKeyDates.map((kd) => (
                            <li key={kd.id} className="worklist-row">
                              <div className="worklist-main">
                                <div className="worklist-title">{kd.label || 'Key date'}</div>
                              </div>
                              <div className="worklist-right">
                                <span className="worklist-meta" style={{ fontWeight: 600 }}>
                                  {formatDate(kd.date)}
                                </span>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                      {riskSnap.sections.map((sec) => {
                        const secPill = formatRiskSectionPill(sec.sectionRisk);
                        return (
                          <div
                            key={sec.number}
                            style={{
                              border: '1px solid var(--border-subtle)',
                              borderRadius: 10,
                              overflow: 'hidden',
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 10,
                                padding: '10px 14px',
                                background: 'var(--bg-subtle, rgba(15, 23, 42, 0.02))',
                                borderBottom: '1px solid var(--border-subtle)',
                              }}
                            >
                              <div>
                                <strong style={{ fontSize: 13.5 }}>
                                  {sec.number}. {sec.title}
                                </strong>
                                <div className="muted" style={{ fontSize: 12 }}>
                                  {sec.completedCount} of {sec.totalCount} questions completed
                                </div>
                              </div>
                              <StatusPill
                                label={secPill.label}
                                tone={secPill.tone}
                              />
                            </div>
                            <ul className="worklist" style={{ padding: '0 14px' }}>
                              {sec.questions.map((q) => {
                                const qPill = formatRiskQuestionPill(q.risk);
                                return (
                                  <li key={q.id} className="worklist-row">
                                    <div className="worklist-main">
                                      <div className="worklist-title" style={{ fontSize: 13.5 }}>
                                        {q.question}
                                      </div>
                                      <div className="worklist-meta">
                                        Answer: <strong>{q.answer}</strong>
                                        {q.followUp ? (
                                          <span> · Note: {q.followUp}</span>
                                        ) : null}
                                      </div>
                                    </div>
                                    <div className="worklist-right">
                                      <StatusPill label={qPill.label} tone={qPill.tone} />
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </section>
            );
          })()}

          {/* COMPLETE MATTER OPENING RECORD (IMMUTABLE PDF SNAPSHOT) */}
          <section className="home-panel" aria-label="Complete matter opening record">
            <div className="panel-header">
              <div className="panel-title-group">
                <FileText size={16} color="var(--color-primary)" />
                <h2 className="panel-title">
                  Matter opening record (Immutable PDF snapshot)
                </h2>
                <StatusPill
                  label={
                    openingSnapshot.saveMode === 'backfilled'
                      ? 'Recorded after opening'
                      : 'Frozen history copy'
                  }
                  tone="positive"
                />
              </div>
              <div className="panel-actions" style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  style={{ borderRadius: 999 }}
                  onClick={() => {
                    setTab('record');
                    setOpeningSnapshotPreviewOpen(true);
                  }}
                >
                  <span>View in Record / History</span>
                </button>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  style={{ borderRadius: 999 }}
                  onClick={() => {
                    downloadMatterOpeningPdf(openingSnapshot);
                    showToast(
                      `Downloaded immutable PDF: Matter-Opening-Record-${matter.matterNumber}.pdf`,
                    );
                  }}
                >
                  <Download size={13} />
                  <span>Download PDF</span>
                </button>
              </div>
            </div>
            <div className="panel-body padded">
              <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
                Complete frozen copy of all details entered when opening{' '}
                <strong>{matter.matterNumber}</strong> (captured {openingSnapshot.capturedAtDisplay}{' '}
                by {openingSnapshot.capturedByName}, schema {openingSnapshot.version}). Stored
                independently so future changes to the matter opening workflow never alter the
                historical opening record.
              </p>
            </div>
          </section>

          <section className="home-panel">
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">
                  Conflicts &amp; compliance onboarding (CORE-033 to CORE-044)
                </h2>
              </div>
              <div className="panel-actions">
                <StatusPill label="Able to act: Yes" tone="positive" />
              </div>
            </div>
            <div className="panel-body padded">
              <div className="kv-grid">
                <div className="kv-item">
                  <span className="kv-label">Conflict check status (CORE-033)</span>
                  <span className="kv-value">
                    {isPmsImportedWithoutLocalConflictCheck(matter)
                      ? PMS_IMPORTED_CONFLICT_STATUS_LABEL
                      : matter.conflictCheckStatus}
                  </span>
                </div>
                <div className="kv-item">
                  <span className="kv-label">Conflict check date (CORE-034)</span>
                  <span className="kv-value">{formatDate(matter.conflictCheckDate)}</span>
                </div>
                <div className="kv-item">
                  <span className="kv-label">Conflict cleared by (CORE-035)</span>
                  <span className="kv-value">
                    {matter.conflictClearedById
                      ? (nameMap.get(matter.conflictClearedById) ?? matter.conflictClearedById)
                      : '—'}
                  </span>
                </div>
                <div className="kv-item">
                  <span className="kv-label">Conflict notes (CORE-036)</span>
                  <span className="kv-value">{matter.conflictNotes || '—'}</span>
                </div>
                <div className="kv-item">
                  <span className="kv-label">AML / CDD status (CORE-037)</span>
                  <span className="kv-value">
                    {canViewClientCdd ? matter.amlStatus : 'Not available to you'}
                  </span>
                </div>
                <div className="kv-item">
                  <span className="kv-label">AML completed date (CORE-038)</span>
                  <span className="kv-value">
                    {canViewClientCdd ? formatDate(matter.amlCompletedAt) : '—'}
                  </span>
                </div>
                <div className="kv-item">
                  <span className="kv-label">Source of funds verified (CORE-039)</span>
                  <span className="kv-value">{matter.sourceOfFundsVerified}</span>
                </div>
                <div className="kv-item">
                  <span className="kv-label">Source of wealth verified (CORE-040)</span>
                  <span className="kv-value">{matter.sourceOfWealthVerified}</span>
                </div>
                <div className="kv-item">
                  <span className="kv-label">Engagement letter status (CORE-041)</span>
                  <span className="kv-value">{matter.engagementLetterStatus}</span>
                </div>
                <div className="kv-item">
                  <span className="kv-label">Engagement letter sent (CORE-042)</span>
                  <span className="kv-value">{formatDateTime(matter.engagementLetterSentAt)}</span>
                </div>
                <div className="kv-item">
                  <span className="kv-label">Engagement letter signed (CORE-043)</span>
                  <span className="kv-value">{formatDate(matter.engagementLetterSignedAt)}</span>
                </div>
              </div>
            </div>
          </section>

          {registersConfig &&
          (userPermissions.includes('register:view') ||
            userPermissions.includes('undertaking:manage')) ? (
            <section
              ref={registersSectionRef}
              className="home-panel"
              aria-label="Matter registers and undertakings"
            >
              <div className="panel-header">
                <div className="panel-title-group">
                  <h2 className="panel-title">
                    Matter registers &amp; undertakings ({matterRegisterRecords.length})
                  </h2>
                </div>
              </div>
              <div className="panel-body padded">
                <RegistersWorkspaceClient
                  embedded
                  lockedMatterId={matter.id}
                  currentUserId={currentUserId}
                  userPermissions={userPermissions}
                  registerTypes={registerTypes}
                  registersConfig={registersConfig}
                  initialRecords={matterRegisterRecords}
                  initialTransitionsByRecordId={matterRegisterTransitions}
                  matters={[matter]}
                  people={people}
                  initialOpenCreateTypeKey={pendingRegisterCreateTypeKey}
                  workspaceRef={registersWorkspaceRef}
                />
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

      {/* ===================== TAB: ACTIVITY ===================== */}
      {tab === 'activity' ? (
        <section className="home-panel">
          <div className="panel-header">
            <div className="panel-title-group">
              <h2 className="panel-title">
                Matter notes &amp; activity ({activityItemsCount})
              </h2>
            </div>
            <div className="panel-actions">
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => setNoteOpen(true)}
              >
                <MessageSquarePlus size={14} />
                <span>Add note</span>
              </button>
            </div>
          </div>
          <div className="panel-body padded">
            {/* 1. INITIAL ENQUIRY ACTIVITY CARD (First activity on the matter when converted from an enquiry) */}
            {sourceEnquiry ? (
              <div
                className="note-item"
                style={{
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 10,
                  padding: '14px 16px',
                  background: 'var(--bg-subtle, rgba(15, 118, 110, 0.03))',
                  marginBottom: 14,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    flexWrap: 'wrap',
                    marginBottom: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <StatusPill label="Initial Enquiry" tone="positive" />
                    <strong style={{ fontSize: 14 }}>
                      <Link href={`/enquiries/${sourceEnquiry.id}`}>
                        {sourceEnquiry.reference} —{' '}
                        {[sourceEnquiry.firstName, sourceEnquiry.lastName]
                          .filter(Boolean)
                          .join(' ') || 'Enquirer'}
                        {sourceEnquiry.callingOnBehalfOf
                          ? ` (${sourceEnquiry.callingOnBehalfOf})`
                          : ''}
                      </Link>
                    </strong>
                    <span className="muted" style={{ fontSize: 12.5 }}>
                      · Received {formatDateTime(sourceEnquiry.receivedAt)} · Taken by{' '}
                      {nameMap.get(sourceEnquiry.takenById) ?? sourceEnquiry.takenById}
                    </span>
                  </div>
                  <Link
                    href={`/enquiries/${sourceEnquiry.id}`}
                    className="btn btn--secondary btn--sm"
                    style={{ borderRadius: 999 }}
                  >
                    Open enquiry screen →
                  </Link>
                </div>

                {sourceEnquiry.summary ? (
                  <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 4 }}>
                    {sourceEnquiry.summary}
                  </div>
                ) : null}
                {sourceEnquiry.notes ? (
                  <div
                    style={{
                      fontSize: 13.5,
                      color: 'var(--text-secondary)',
                      whiteSpace: 'pre-wrap',
                      marginBottom: 10,
                    }}
                  >
                    {sourceEnquiry.notes}
                  </div>
                ) : null}

                {/* Additional enquiry-specific details retained from the enquiry screen */}
                <div
                  className="kv-grid"
                  style={{
                    marginTop: 8,
                    paddingTop: 10,
                    borderTop: '1px solid var(--border-subtle)',
                  }}
                >
                  <div className="kv-item">
                    <span className="kv-label">Channel &amp; urgency</span>
                    <span className="kv-value">
                      {resolveLabel(values, sourceEnquiry.channelId) || '—'} ·{' '}
                      {resolveLabel(values, sourceEnquiry.urgencyId) || 'Standard'}
                    </span>
                  </div>
                  <div className="kv-item">
                    <span className="kv-label">Contact details</span>
                    <span className="kv-value">
                      {[sourceEnquiry.phone, sourceEnquiry.email].filter(Boolean).join(' · ') ||
                        '—'}
                    </span>
                  </div>
                  <div className="kv-item">
                    <span className="kv-label">Preferred contact &amp; best time</span>
                    <span className="kv-value">
                      {[
                        sourceEnquiry.preferredContactMethodId
                          ? resolveLabel(values, sourceEnquiry.preferredContactMethodId)
                          : '',
                        sourceEnquiry.bestTimeToCall
                          ? `Best time: ${sourceEnquiry.bestTimeToCall}`
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </span>
                  </div>
                  <div className="kv-item">
                    <span className="kv-label">Key date &amp; privacy notice</span>
                    <span className="kv-value">
                      {sourceEnquiry.keyDate
                        ? `${formatDate(sourceEnquiry.keyDate)}${
                            sourceEnquiry.keyDateLabel ? ` (${sourceEnquiry.keyDateLabel})` : ''
                          }`
                        : 'No key date'}{' '}
                      · Privacy notice: {sourceEnquiry.privacyNoticeGiven ? 'Given' : 'Not given'}
                    </span>
                  </div>
                </div>

                {sourceEnquiry.contactLog && sourceEnquiry.contactLog.length > 0 ? (
                  <div
                    style={{
                      marginTop: 10,
                      paddingTop: 10,
                      borderTop: '1px solid var(--border-subtle)',
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11.5,
                        fontWeight: 800,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        color: 'var(--text-secondary)',
                        marginBottom: 6,
                      }}
                    >
                      Enquiry contact log ({sourceEnquiry.contactLog.length})
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {sourceEnquiry.contactLog.map((cl) => (
                        <div key={cl.id} style={{ fontSize: 12.5 }}>
                          <strong>
                            {cl.method} ({cl.outcome})
                          </strong>{' '}
                          <span className="muted">
                            · {formatDateTime(cl.at)} by {nameMap.get(cl.byId) ?? cl.byId}
                          </span>
                          {cl.note ? <div>{cl.note}</div> : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* 2. CONFLICT CHECK RECORD ACTIVITY CARD */}
            {(() => {
              const rec = resolvedConflictRecord;
              const allRuns = [...extraConflictRuns, ...(rec.runs ?? [])];
              return (
                <div
                  className="note-item"
                  style={{
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 10,
                    padding: '14px 16px',
                    background: 'var(--bg-subtle, rgba(15, 118, 110, 0.03))',
                    marginBottom: 14,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      flexWrap: 'wrap',
                      marginBottom: 8,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <StatusPill
                        label={
                          isPmsImportedWithoutLocalConflictCheck(matter)
                            ? 'Conflict Check · Imported from PMS'
                            : `Conflict Check · ${rec.status}`
                        }
                        tone={
                          isPmsImportedWithoutLocalConflictCheck(matter)
                            ? 'neutral'
                            : rec.status === 'Cleared' || rec.status === 'Approved'
                              ? 'positive'
                              : rec.status === 'Referred'
                                ? 'warning'
                                : 'alert'
                        }
                      />
                      <strong style={{ fontSize: 14 }}>
                        {isPmsImportedWithoutLocalConflictCheck(matter)
                          ? PMS_IMPORTED_CONFLICT_STATUS_LABEL
                          : `Conflict check record — ${rec.outcomeLabel}`}
                      </strong>
                      {isPmsImportedWithoutLocalConflictCheck(matter) ? null : (
                        <span className="muted" style={{ fontSize: 12.5 }}>
                          · Submitted {rec.submittedAtDisplay} by {rec.submittedByName}
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        style={{ borderRadius: 999 }}
                        onClick={() => setActivityConflictExpanded((v) => !v)}
                      >
                        {activityConflictExpanded ? 'Hide full details' : 'Show full details'}
                      </button>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        style={{ borderRadius: 999 }}
                        onClick={() => {
                          downloadConflictCheckPdf(
                            matter.matterNumber,
                            matter.title,
                            rec,
                            firmName,
                          );
                          showToast(
                            `Exported PDF: Conflict-Check-Record-${matter.matterNumber}.pdf`,
                          );
                        }}
                      >
                        <Download size={13} />
                        <span>Export PDF</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        style={{ borderRadius: 999 }}
                        onClick={() => {
                          setConflictRecordMinimised(false);
                          setTab('compliance');
                        }}
                      >
                        <span>View in Compliance tab →</span>
                      </button>
                    </div>
                  </div>

                  <div
                    className="kv-grid"
                    style={{
                      marginTop: 8,
                      paddingTop: 10,
                      borderTop: '1px solid var(--border-subtle)',
                    }}
                  >
                    <div className="kv-item">
                      <span className="kv-label">Outcome &amp; approval</span>
                      <span className="kv-value">
                        {rec.outcomeLabel} · {rec.approvedByName || rec.submittedByName} (
                        {rec.approvedAtDisplay || rec.submittedAtDisplay})
                      </span>
                    </div>
                    <div className="kv-item">
                      <span className="kv-label">Parties checked ({rec.parties.length})</span>
                      <span className="kv-value">
                        {rec.parties.map((p) => `${p.name} (${p.role})`).join(' · ')}
                      </span>
                    </div>
                    <div className="kv-item">
                      <span className="kv-label">Matches &amp; dispositions</span>
                      <span className="kv-value">
                        {rec.matches.length === 0
                          ? '0 matches found across open or closed matters'
                          : `${rec.matches.length} ${
                              rec.matches.length === 1 ? 'match' : 'matches'
                            } reviewed`}
                      </span>
                    </div>
                    <div className="kv-item">
                      <span className="kv-label">Declaration</span>
                      <span className="kv-value">
                        ✓ Confirmed complete to best of fee earner&apos;s knowledge
                      </span>
                    </div>
                  </div>

                  {activityConflictExpanded ? (
                    <div
                      style={{
                        marginTop: 12,
                        paddingTop: 12,
                        borderTop: '1px solid var(--border-subtle)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                      }}
                    >
                      {rec.matches.length > 0 ? (
                        <div>
                          <div
                            style={{
                              fontSize: 11.5,
                              fontWeight: 800,
                              letterSpacing: '0.06em',
                              textTransform: 'uppercase',
                              color: 'var(--text-secondary)',
                              marginBottom: 6,
                            }}
                          >
                            Match dispositions ({rec.matches.length})
                          </div>
                          {rec.matches.map((m) => (
                            <div
                              key={m.id}
                              style={{
                                fontSize: 12.5,
                                padding: '6px 0',
                                borderBottom: '1px solid var(--border-subtle)',
                              }}
                            >
                              <strong>{m.matchedRecordName}</strong> ({m.strength} match ·{' '}
                              {m.whereFound}) —{' '}
                              <strong>
                                {m.disposition === 'not_the_same'
                                  ? 'Not the same'
                                  : m.disposition === 'potential_conflict'
                                    ? 'Potential conflict'
                                    : 'Same – no conflict'}
                              </strong>
                              {m.note ? ` · Note: ${m.note}` : ''}
                            </div>
                          ))}
                        </div>
                      ) : null}

                      {allRuns.length > 0 ? (
                        <div>
                          <div
                            style={{
                              fontSize: 11.5,
                              fontWeight: 800,
                              letterSpacing: '0.06em',
                              textTransform: 'uppercase',
                              color: 'var(--text-secondary)',
                              marginBottom: 6,
                            }}
                          >
                            Search run audit trail ({allRuns.length})
                          </div>
                          {allRuns.map((run) => (
                            <div key={run.id} style={{ fontSize: 12.5 }}>
                              Run {run.runAtDisplay} by <strong>{run.runByName}</strong> · Terms:{' '}
                              {run.searchTerms.join(', ')} ({run.partiesCount} parties,{' '}
                              {run.matchesCount} matches)
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })()}

            {/* 3. MATTER RISK ASSESSMENT ACTIVITY CARD */}
            {(() => {
              const riskSnap = resolvedRiskAssessment;
              const riskTonePill: 'alert' | 'warning' | 'positive' =
                riskSnap.overallRisk === 'High'
                  ? 'alert'
                  : riskSnap.overallRisk === 'Medium'
                    ? 'warning'
                    : 'positive';

              return (
                <div
                  className="note-item"
                  style={{
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 10,
                    padding: '14px 16px',
                    background: 'var(--bg-subtle, rgba(15, 118, 110, 0.03))',
                    marginBottom: 14,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      flexWrap: 'wrap',
                      marginBottom: 8,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <StatusPill
                        label={
                          riskSnap.overallRisk
                            ? `Risk Assessment · ${riskSnap.overallRisk} risk`
                            : 'Risk Assessment · Not started'
                        }
                        tone={riskTonePill}
                      />
                      <strong style={{ fontSize: 14 }}>
                        Matter risk assessment ({riskSnap.completedQuestions}/
                        {riskSnap.totalQuestions} questions answered)
                      </strong>
                      <span className="muted" style={{ fontSize: 12.5 }}>
                        {riskSnap.completedByName && riskSnap.completedAt
                          ? `· Assessed ${formatDateTime(riskSnap.completedAt)} by ${riskSnap.completedByName}`
                          : '· Not yet assessed'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        style={{ borderRadius: 999 }}
                        onClick={() => setActivityRiskExpanded((v) => !v)}
                      >
                        {activityRiskExpanded ? 'Hide Q&A breakdown' : 'Show Q&A breakdown'}
                      </button>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        style={{ borderRadius: 999 }}
                        onClick={() => {
                          downloadRiskAssessmentPdf(
                            matter.matterNumber,
                            matter.title,
                            riskSnap,
                            firmName,
                          );
                          showToast(
                            `Exported PDF: Matter-Risk-Assessment-${matter.matterNumber}.pdf`,
                          );
                        }}
                      >
                        <Download size={13} />
                        <span>Export PDF</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        style={{ borderRadius: 999 }}
                        onClick={() => {
                          setRiskRecordMinimised(false);
                          setTab('compliance');
                        }}
                      >
                        <span>View in Compliance tab →</span>
                      </button>
                    </div>
                  </div>

                  <div
                    className="kv-grid"
                    style={{
                      marginTop: 8,
                      paddingTop: 10,
                      borderTop: '1px solid var(--border-subtle)',
                    }}
                  >
                    <div className="kv-item">
                      <span className="kv-label">Overall risk rating</span>
                      <span className="kv-value">
                        {riskSnap.overallRisk
                          ? `${riskSnap.overallRisk} risk`
                          : 'Not assessed'}
                      </span>
                    </div>
                    <div className="kv-item">
                      <span className="kv-label">MLR 2017 regulated scope</span>
                      <span className="kv-value">
                        {riskSnap.isMlrInScope
                          ? 'In scope (Regulated sector)'
                          : 'Out of scope'}
                      </span>
                    </div>
                    <div className="kv-item">
                      <span className="kv-label">Section summary</span>
                      <span className="kv-value">
                        {riskSnap.sections
                          .map((s) => `${s.number}. ${s.title}: ${s.sectionRisk || 'Not assessed'}`)
                          .join(' · ')}
                      </span>
                    </div>
                    <div className="kv-item">
                      <span className="kv-label">Assessed by</span>
                      <span className="kv-value">
                        {riskSnap.completedByName && riskSnap.completedAt
                          ? `${riskSnap.completedByName} (${formatDateTime(riskSnap.completedAt)})`
                          : riskSnap.completedByName || 'Not yet assessed'}
                      </span>
                    </div>
                  </div>

                  {activityRiskExpanded ? (
                    <div
                      style={{
                        marginTop: 12,
                        paddingTop: 12,
                        borderTop: '1px solid var(--border-subtle)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                      }}
                    >
                      {riskSnap.sections.map((sec) => (
                        <div key={sec.number}>
                          <div
                            style={{
                              fontSize: 11.5,
                              fontWeight: 800,
                              letterSpacing: '0.06em',
                              textTransform: 'uppercase',
                              color: 'var(--text-secondary)',
                              marginBottom: 4,
                            }}
                          >
                            {sec.number}. {sec.title} (
                            {sec.sectionRisk ? `${sec.sectionRisk} risk` : 'Not assessed'})
                          </div>
                          {sec.questions.map((q) => (
                            <div key={q.id} style={{ fontSize: 12.5, padding: '3px 0' }}>
                              • {q.question}: <strong>{q.answer}</strong> (
                              {q.risk ? `${q.risk} risk` : 'Unanswered'})
                              {q.followUp ? ` — Note: ${q.followUp}` : ''}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })()}

            {/* 4. MATTER OPENING RECORD (IMMUTABLE PDF SNAPSHOT) ACTIVITY CARD */}
            <div
              className="note-item"
              style={{
                border: '1px solid var(--border-subtle)',
                borderRadius: 10,
                padding: '14px 16px',
                background: 'var(--bg-subtle, rgba(15, 118, 110, 0.03))',
                marginBottom: notes.length > 0 ? 14 : 0,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  flexWrap: 'wrap',
                  marginBottom: 6,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <StatusPill label="Opening Record (PDF)" tone="positive" />
                  <strong style={{ fontSize: 14 }}>
                    Complete Matter Opening Record — {matter.matterNumber}.pdf
                  </strong>
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    · Captured {openingSnapshot.capturedAtDisplay} by {openingSnapshot.capturedByName}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    style={{ borderRadius: 999 }}
                    onClick={() => {
                      setTab('record');
                      setOpeningSnapshotPreviewOpen(true);
                    }}
                  >
                    <span>View frozen snapshot →</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    style={{ borderRadius: 999 }}
                    onClick={() => {
                      downloadMatterOpeningPdf(openingSnapshot);
                      showToast(
                        `Downloaded immutable PDF: Matter-Opening-Record-${matter.matterNumber}.pdf`,
                      );
                    }}
                  >
                    <Download size={13} />
                    <span>Download PDF</span>
                  </button>
                </div>
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                Immutable snapshot of all details entered at matter opening (client, parties, scope,
                commercials, team, conflict check, and full risk assessment). Preserved as a
                standalone PDF and frozen record so future changes to the matter opening process do
                not impact historical records.
              </div>
            </div>

            {/* 5. MATTER NOTES */}
            {notes.map((n) => (
              <div key={n.id} className="note-item">
                <div className="note-meta">
                  <strong>{nameMap.get(n.authorId) ?? n.authorId}</strong> · {formatDateTime(n.at)}
                </div>
                <div>{n.text}</div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* ===================== TAB: RECORD ===================== */}
      {tab === 'record' ? (
        <div className="home-col">
          {/* IMMUTABLE MATTER OPENING RECORD (PDF SNAPSHOT) IN HISTORY */}
          <section className="home-panel" aria-label="Matter opening history snapshot">
            <div className="panel-header">
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <FileText size={16} color="var(--color-primary)" />
                  <h2 className="panel-title">
                    Complete Matter Opening Record (Immutable PDF Snapshot)
                  </h2>
                  <StatusPill
                    label={
                      openingSnapshot.saveMode === 'backfilled'
                        ? `Schema ${openingSnapshot.version} · Recorded after opening`
                        : `Schema ${openingSnapshot.version} · Frozen`
                    }
                    tone="positive"
                  />
                </div>
                <div className="panel-subtitle" style={{ marginTop: 2 }}>
                  Captured {openingSnapshot.capturedAtDisplay} by{' '}
                  <strong>{openingSnapshot.capturedByName}</strong> · Isolated from future changes to
                  the matter opening process
                </div>
              </div>
              <div className="panel-actions" style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  style={{ borderRadius: 999 }}
                  onClick={() => setOpeningSnapshotPreviewOpen((v) => !v)}
                >
                  {openingSnapshotPreviewOpen ? (
                    <>
                      <Minimize2 size={13} />
                      <span>Hide snapshot preview</span>
                    </>
                  ) : (
                    <>
                      <Maximize2 size={13} />
                      <span>Preview frozen snapshot</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  style={{ borderRadius: 999 }}
                  onClick={() => {
                    downloadMatterOpeningPdf(openingSnapshot);
                    showToast(
                      `Downloaded immutable PDF: Matter-Opening-Record-${matter.matterNumber}.pdf`,
                    );
                  }}
                >
                  <Download size={13} />
                  <span>Download PDF ({matter.matterNumber})</span>
                </button>
              </div>
            </div>

            {openingSnapshotPreviewOpen ? (
              <div className="panel-body padded">
                <div
                  className="kv-grid"
                  style={{
                    paddingBottom: 14,
                    marginBottom: 14,
                    borderBottom: '1px solid var(--border-subtle)',
                  }}
                >
                  <div className="kv-item">
                    <span className="kv-label">Matter number &amp; title</span>
                    <span className="kv-value">
                      {openingSnapshot.matterNumber} — {openingSnapshot.title}
                    </span>
                  </div>
                  <div className="kv-item">
                    <span className="kv-label">Client &amp; instructing contact</span>
                    <span className="kv-value">
                      {openingSnapshot.clients.map((c) => c.name).join(', ')}
                      {openingSnapshot.instructingContact?.name
                        ? ` · ${openingSnapshot.instructingContact.name}`
                        : ''}
                    </span>
                  </div>
                  <div className="kv-item">
                    <span className="kv-label">Practice area &amp; work type</span>
                    <span className="kv-value">
                      {openingSnapshot.departmentLabel} → {openingSnapshot.workTypeLabel}
                    </span>
                  </div>
                  <div className="kv-item">
                    <span className="kv-label">Fee earner &amp; responsible partner</span>
                    <span className="kv-value">
                      {openingSnapshot.leadFeeEarnerName} · {openingSnapshot.responsiblePartnerName}
                    </span>
                  </div>
                  <div className="kv-item">
                    <span className="kv-label">Billing basis &amp; financials</span>
                    <span className="kv-value">
                      {openingSnapshot.billingAndFinancials.billingBasis}
                      {openingSnapshot.billingAndFinancials.feeEstimateGbp !== '—'
                        ? ` · Est. ${openingSnapshot.billingAndFinancials.feeEstimateGbp}`
                        : ''}
                      {openingSnapshot.billingAndFinancials.agreedFeeCapGbp !== '—'
                        ? ` · Cap ${openingSnapshot.billingAndFinancials.agreedFeeCapGbp}`
                        : ''}
                    </span>
                  </div>
                  <div className="kv-item">
                    <span className="kv-label">Conflict check &amp; risk rating at opening</span>
                    <span className="kv-value">
                      Conflict: {openingSnapshot.conflictCheckRecord.status} (
                      {openingSnapshot.conflictCheckRecord.outcomeLabel}) · Risk:{' '}
                      {openingSnapshot.riskAssessment.overallRisk ?? 'Not assessed'} (
                      {openingSnapshot.riskAssessment.completedQuestions}/
                      {openingSnapshot.riskAssessment.totalQuestions} Qs)
                    </span>
                  </div>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  <strong>Scope / description at opening:</strong>{' '}
                  {openingSnapshot.shortDescription || '—'}
                </div>
              </div>
            ) : null}
          </section>

          {rule ? (
            <section className="home-panel">
              <div className="panel-header">
                <div>
                  <h2 className="panel-title">
                    Subcategory Matrix Configuration · {rule.code} — {rule.subcategory}
                  </h2>
                  <div className="panel-subtitle" style={{ marginTop: 2 }}>
                    Active Field Groups:{' '}
                    <strong>
                      {rule.fieldGroupCodes.length ? rule.fieldGroupCodes.join(', ') : 'None'}
                    </strong>{' '}
                    · Subcategory-specific fields: <strong>{specificFields.length}</strong>
                  </div>
                </div>
                <div className="panel-actions">
                  <Link href={`/matters/${matter.id}/edit`} className="btn btn--secondary btn--sm">
                    <Edit3 size={14} />
                    <span>Update work type fields</span>
                  </Link>
                </div>
              </div>
            </section>
          ) : null}

          <section className="home-panel">
            <div className="panel-header">
              <h2 className="panel-title">Classification — 7 taxonomy axes &amp; core fields</h2>
            </div>
            <div className="panel-body padded">
              <div className="kv-grid">
                <div className="kv-item">
                  <span className="kv-label">Practice area</span>
                  <span className="kv-value">{practiceLabel}</span>
                </div>
                <div className="kv-item">
                  <span className="kv-label">Work type subcategory</span>
                  <span className="kv-value">{subcatLabel}</span>
                </div>
                <div className="kv-item">
                  <span className="kv-label">Matter type</span>
                  <span className="kv-value">{matterTypeLabel || '—'}</span>
                </div>
                <div className="kv-item">
                  <span className="kv-label">Client tier</span>
                  <span className="kv-value">{tierLabel || '—'}</span>
                </div>
                <div className="kv-item">
                  <span className="kv-label">Client sector</span>
                  <span className="kv-value">{sectorLabel || '—'}</span>
                </div>
                <div className="kv-item">
                  <span className="kv-label">Billing basis</span>
                  <span className="kv-value">{billingBasisLabel || '—'}</span>
                </div>
                <div className="kv-item">
                  <span className="kv-label">Risk rating</span>
                  <span className="kv-value">{riskLabel || '—'}</span>
                </div>
                <div className="kv-item">
                  <span className="kv-label">Matter size / value band</span>
                  <span className="kv-value">{sizeLabel || '—'}</span>
                </div>
                <div className="kv-item">
                  <span className="kv-label">Jurisdiction</span>
                  <span className="kv-value">
                    {[jurGroupLabel, ...jurSystemLabels].filter(Boolean).join(' · ') || '—'}
                  </span>
                </div>
                <div className="kv-item">
                  <span className="kv-label">Governing law</span>
                  <span className="kv-value">{govLawLabel || '—'}</span>
                </div>
                <div className="kv-item">
                  <span className="kv-label">Current stage</span>
                  <span className="kv-value">{stageLabel || '—'}</span>
                </div>
                <div className="kv-item">
                  <span className="kv-label">Current milestone</span>
                  <span className="kv-value">{milestoneLabel || '—'}</span>
                </div>
              </div>
            </div>
          </section>

          {specificFields.length > 0 ? (
            <section className="home-panel">
              <div className="panel-header">
                <h2 className="panel-title">
                  Subcategory-specific fields: {subcatLabel} ({specificFields.length} fields)
                </h2>
              </div>
              <div className="panel-body padded">
                <div className="kv-grid">
                  {specificFields.map((field) => (
                    <div key={field.id} className="kv-item">
                      <span className="kv-label">
                        {field.id} · {field.name}
                      </span>
                      <span className="kv-value">
                        {formatFieldValue(field, matter.fieldValues[field.id])}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          ) : null}

          {activeGroups.map((group) => (
            <section key={group.code} className="home-panel">
              <div className="panel-header">
                <h2 className="panel-title">
                  Field Group {group.code}: {group.name.replace(`${group.code} — `, '')} (
                  {group.fields.length} fields)
                </h2>
              </div>
              <div className="panel-body padded">
                <div className="kv-grid">
                  {group.fields.map((field) => (
                    <div key={field.id} className="kv-item">
                      <span className="kv-label">
                        {field.id} · {field.name}
                      </span>
                      <span className="kv-value">
                        {formatFieldValue(field, matter.fieldValues[field.id])}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          ))}

          <section className="home-panel">
            <div className="panel-header">
              <h2 className="panel-title">Record metadata &amp; audit ({audit.length})</h2>
            </div>
            <div className="panel-body padded">
              <div className="kv-grid" style={{ marginBottom: 16 }}>
                <div className="kv-item">
                  <span className="kv-label">Permanent ID</span>
                  <span className="kv-value">{matter.id}</span>
                </div>
                <div className="kv-item">
                  <span className="kv-label">Matter number</span>
                  <span className="kv-value">{matter.matterNumber}</span>
                </div>
                <div className="kv-item">
                  <span className="kv-label">Created</span>
                  <span className="kv-value">
                    {formatDateTime(matter.createdAt)} by{' '}
                    {nameMap.get(matter.createdById) ?? matter.createdById}
                  </span>
                </div>
                <div className="kv-item">
                  <span className="kv-label">Last updated</span>
                  <span className="kv-value">
                    {formatDateTime(matter.updatedAt)} by{' '}
                    {nameMap.get(matter.updatedById) ?? matter.updatedById}
                  </span>
                </div>
              </div>
              {audit.map((a) => (
                <div key={a.id} className="audit-row">
                  <div>
                    <strong>{a.field ?? a.action}</strong>:{' '}
                    {a.oldValue ? <span className="muted">{a.oldValue} → </span> : null}
                    <span>{a.newValue ?? '—'}</span>
                  </div>
                  <div className="muted">
                    {nameMap.get(a.byId) ?? a.byId} · {formatDateTime(a.at)}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      <DocumentGenerationModal
        open={docAssemblyOpen}
        onClose={() => {
          setDocAssemblyOpen(false);
        }}
        sourceEntityType="matter"
        matter={matter}
        people={people}
        organisations={organisations}
        values={values}
        currentUserId={currentUserId}
        onDocumentGenerated={(doc) => {
          showToast(`Generated ${doc.fileName}`);
          router.refresh();
        }}
      />
    </div>
  );
}
