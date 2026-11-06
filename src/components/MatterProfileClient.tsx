'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  Calendar,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
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
  addNoteAction,
  liftMatterRestrictionAction,
  markEngagementLetterDraftedAction,
  saveMatterAction,
  saveTaskAction,
  updateMatterConflictRecordAction,
} from '@/app/actions';
import { formatDate, formatDateTime } from '@/domain/dates';
import { resolveLabel, resolveLabels } from '@/domain/lists';
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
  resolveMatterConflictCheckRecord,
  resolveMatterOpeningSnapshot,
  resolveMatterRiskAssessment,
} from '@/domain/matterOpeningRecord';
import { hrefForId, personDisplayName } from '@/domain/names';
import type {
  AppRole,
  AuditEntry,
  ChoiceValue,
  ConflictCheckRecord,
  Enquiry,
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
  canVerifyByKeyDateId?: Record<string, { allowed: boolean; reason?: string }>;
  canTakeByTaskId?: Record<string, boolean>;
  canViewFinance?: boolean;
  canLiftRestriction?: boolean;
  pmsView?: MatterPmsViewBundle;
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
  if (parts.length === 0) return 'PV';
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
    return { month: 'OCT', day: '21' };
  }
  return {
    month: d.toLocaleDateString('en-GB', { month: 'short' }).toUpperCase(),
    day: String(d.getDate()),
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
  currentUserId = 'P-0001',
  currentUserRole = 'admin',
  currentUser,
  employees,
  keyDatesConfig,
  keyDates = [],
  keyDateNotApplicable = [],
  keyDateReminderStates = [],
  keyDateCalendarSyncs = [],
  userKeyDatePermissions = [],
  canVerifyByKeyDateId,
  canTakeByTaskId,
  canViewFinance = true,
  canLiftRestriction = false,
  pmsView,
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
      'finance',
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
  const [completedDemoTaskIds, setCompletedDemoTaskIds] = useState<Set<string>>(() => new Set());

  const isBrightwaterTribunal = matter.matterNumber === 'BRI001-0003';
  const isSeededDemoMatter = /^M-0000(0[1-9]|1[0-8])$/.test(matter.id);
  const [conflictRecordMinimised, setConflictRecordMinimised] = useState(false);
  const [riskRecordMinimised, setRiskRecordMinimised] = useState(false);
  const [activityConflictExpanded, setActivityConflictExpanded] = useState(false);
  const [activityRiskExpanded, setActivityRiskExpanded] = useState(false);
  const [openingSnapshotPreviewOpen, setOpeningSnapshotPreviewOpen] = useState(false);
  const [extraConflictRuns, setExtraConflictRuns] = useState<
    ConflictCheckRecord['runs']
  >([]);
  const [docAssemblyOpen, setDocAssemblyOpen] = useState(false);

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

  const openingSnapshot = useMemo(
    () => resolveMatterOpeningSnapshot(matter, people, organisations, values, enquiries, quotes),
    [matter, people, organisations, values, enquiries, quotes],
  );

  const sourceEnquiry = useMemo(
    () =>
      matter.sourceEnquiryId
        ? enquiries.find((e) => e.id === matter.sourceEnquiryId) ?? null
        : enquiries.find((e) => e.convertedMatterId === matter.id) ?? null,
    [matter.sourceEnquiryId, matter.id, enquiries],
  );

  const activityItemsCount = notes.length + (sourceEnquiry ? 1 : 0) + 3; // +3 for Conflict check record, Matter risk assessment, and Matter opening snapshot PDF

  const clientLabel = nameMap.get(matter.clientId) ?? matter.clientId;
  const practiceLabel = resolveLabel(values, matter.practiceAreaId);
  const subcatLabel = resolveLabel(values, matter.workTypeSubcategoryId);
  const rawStatusLabel = resolveLabel(values, matter.matterStatusId) || 'Active';
  const isCmiIncomplete =
    rawStatusLabel === 'CMI incomplete' ||
    matter.amlStatus === 'CMI incomplete' ||
    matter.amlStatus === 'Pending';
  const statusPillLabel = matter.conflictCheckStatus.toLowerCase().includes('conflict')
    ? 'Conflict flagged'
    : isCmiIncomplete
      ? 'CMI incomplete'
      : rawStatusLabel === 'Active'
        ? 'Open'
        : rawStatusLabel;
  const statusPillTone: 'alert' | 'warning' | 'positive' | 'neutral' = matter.conflictCheckStatus
    .toLowerCase()
    .includes('conflict')
    ? 'alert'
    : isCmiIncomplete ||
        rawStatusLabel.toLowerCase().includes('hold') ||
        rawStatusLabel.toLowerCase().includes('prospective')
      ? 'warning'
      : rawStatusLabel === 'Active'
        ? 'positive'
        : 'neutral';
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
    ? nameMap.get(matter.responsiblePartnerId) ?? 'Siân Llewellyn'
    : 'Siân Llewellyn';

  const openedDisplay = isBrightwaterTribunal
    ? '12 Aug 2026'
    : formatDayMonthYear(matter.openedAt);

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
    if (isBrightwaterTribunal || subcatLabel.toLowerCase().includes('tribunal')) {
      return [
        { name: 'Intake', completedDetail: 'Done 14 Aug' },
        { name: 'ET3 response', completedDetail: 'Filed 2 Sep' },
        { name: 'Case management', completedDetail: 'Done 30 Sep' },
        { name: 'Drafting & negotiation' },
        { name: 'Final hearing', upcomingDetail: 'Listed Mar 2027' },
        { name: 'Close', upcomingDetail: '—' },
      ];
    }
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
  }, [isBrightwaterTribunal, subcatLabel, matter.openedAt, matter.targetCompletionAt]);

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
        },
        { id: matter.id },
      );
      if (res.errors && Object.keys(res.errors).length > 0) {
        setCurrentStageIdx(prevIdx);
        showToast(Object.values(res.errors)[0] ?? 'Could not update matter stage');
        return;
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
  const pmsFin = pmsView?.matterBundle?.summary ?? null;
  const financials = useMemo(() => {
    if (isBrightwaterTribunal) {
      return {
        budget: 25000,
        billedPaid: 9013,
        billedUnpaid: 3137,
        overdueSub: 'PV-2026-014 overdue',
        unbilledWip: 6250,
        remainingBudget: 6600,
        budgetUsedPct: 74,
        matterProgressPct:
          Math.round(((currentStageIdx + 0.5) / stageSteps.length) * 100) === 58
            ? 58
            : Math.min(100, Math.round(((currentStageIdx + 0.48) / stageSteps.length) * 100)),
        footerText:
          'Hourly, capped estimate · Billed monthly · Billing party: client · Client account £0',
      };
    }

    if (!pmsFin && !isSeededDemoMatter) {
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

    const budget =
      (pmsFin?.fee_estimate && pmsFin.fee_estimate > 0 ? pmsFin.fee_estimate : null) ??
      matter.agreedFeeCapGbp ??
      matter.feeEstimateGbp ??
      25000;
    const totalBilled = pmsFin ? pmsFin.fees_billed : Math.round(budget * 0.48);
    const billedUnpaid = pmsFin ? pmsFin.outstanding_debt : Math.round(budget * 0.12);
    const billedPaid = Math.max(0, totalBilled - billedUnpaid);
    const unbilledWip = pmsFin ? pmsFin.unbilled_wip : Math.round(budget * 0.25);
    const usedTotal = billedPaid + billedUnpaid + unbilledWip;
    const remainingBudget = Math.max(0, budget - usedTotal);
    const budgetUsedPct = budget > 0 ? Math.min(100, Math.round((usedTotal / budget) * 100)) : 0;
    const matterProgressPct = Math.min(
      100,
      Math.round(((currentStageIdx + 0.48) / stageSteps.length) * 100),
    );
    const clientAcct = matter.retainerMoniesOnAccountGbp ?? 0;

    return {
      budget,
      billedPaid,
      billedUnpaid,
      overdueSub:
        billedUnpaid > 0 && pmsFin && (pmsFin.max_invoice_days_past_due ?? 0) > 0
          ? 'Invoice overdue'
          : '',
      unbilledWip,
      remainingBudget,
      budgetUsedPct,
      matterProgressPct,
      footerText: `${billingBasisLabel || 'Hourly, capped estimate'} · Billed monthly · Billing party: client · Client account £${clientAcct.toLocaleString('en-GB')}`,
    };
  }, [
    isBrightwaterTribunal,
    isSeededDemoMatter,
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

  const widgetTasks = useMemo(() => {
    const mapped = realMatterTasks.map((t) => {
      const typeLabel = resolveLabel(values, t.taskTypeId) || 'Review';
      const assigneeName = t.assignedPersonId
        ? nameMap.get(t.assignedPersonId) ?? 'Siân Llewellyn'
        : 'Siân Llewellyn';
      const isOverdue = new Date(t.dueAt).getTime() < new Date('2026-10-22T23:59:59').getTime();
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

    if (isBrightwaterTribunal && mapped.length === 0) {
      const demoItems = [
        {
          id: 'BRI-DEMO-TSK-1',
          realTask: null as Task | null,
          title: 'Prepare Respondent agenda for Bristol ET preliminary hearing',
          typeLabel: 'Review',
          assigneeName: 'Siân Llewellyn',
          dueLabel: 'Due 21 Oct',
          overdue: true,
        },
        {
          id: 'BRI-DEMO-TSK-2',
          realTask: null as Task | null,
          title: 'Brief Tom Griffiths ahead of the preliminary hearing',
          typeLabel: 'Meeting',
          assigneeName: 'Ffion Hughes',
          dueLabel: 'Due 31 Oct',
          overdue: false,
        },
        {
          id: 'BRI-DEMO-TSK-3',
          realTask: null as Task | null,
          title: 'Take witness statement from Tom Griffiths',
          typeLabel: 'Drafting',
          assigneeName: 'Ffion Hughes',
          dueLabel: 'Due 13 Nov',
          overdue: false,
        },
      ];
      return demoItems.filter((d) => !completedDemoTaskIds.has(d.id));
    }

    return mapped.filter((d) => !completedDemoTaskIds.has(d.id));
  }, [realMatterTasks, values, nameMap, isBrightwaterTribunal, completedDemoTaskIds]);

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
    } else {
      setCompletedDemoTaskIds((prev) => new Set(prev).add(item.id));
      showToast(`Completed task — ${item.title}`);
    }
  }

  // Parties list for Overview and Parties tab
  const overviewParties = useMemo(() => {
    const partiesEdited = Boolean(matter.fieldValues['partiesEdited']);
    if (isBrightwaterTribunal && !partiesEdited && matter.parties.length === 0) {
      return [
        {
          id: 'pt-client',
          name: clientLabel,
          href: hrefForId(matter.clientId),
          sub: 'Our client · Respondent',
          badge: 'Client',
          tone: 'positive' as const,
        },
        {
          id: 'pt-instructing',
          name: matter.instructingContactId
            ? nameMap.get(matter.instructingContactId) ?? 'Tom Griffiths'
            : 'Tom Griffiths',
          href: matter.instructingContactId ? hrefForId(matter.instructingContactId) : undefined,
          sub: 'Instructing contact · Operations Director · Witness',
          badge: 'Client contact',
          tone: 'neutral' as const,
        },
        {
          id: 'pt-claimant',
          name: '[Claimant name]',
          href: undefined,
          sub: 'Claimant · Former employee',
          badge: 'Opponent',
          tone: 'warning' as const,
        },
        {
          id: 'pt-claimant-sol',
          name: "[Claimant's solicitors]",
          href: undefined,
          sub: "Claimant's representative",
          badge: 'Opponent',
          tone: 'warning' as const,
        },
        {
          id: 'pt-tribunal',
          name: 'Employment Tribunal — Bristol',
          href: undefined,
          sub: 'Tribunal · Case no. [Case number]',
          badge: 'Court / tribunal',
          tone: 'neutral' as const,
        },
      ];
    }

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
      ) &&
      !isBrightwaterTribunal
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
  }, [isBrightwaterTribunal, clientLabel, matter, nameMap, people]);

  const rule = useMemo(() => findSubcategoryRule(subcatLabel), [subcatLabel]);
  const activeGroups = useMemo(() => fieldGroupsForSubcategory(subcatLabel), [subcatLabel]);
  const specificFields = useMemo(() => specificFieldsForSubcategory(subcatLabel), [subcatLabel]);
  const criticalDates = useMemo(
    () => extractCriticalDates(matter, subcatLabel),
    [matter, subcatLabel],
  );

  // Key dates for right sidebar
  const keyDatesList = useMemo(() => {
    if (isBrightwaterTribunal) {
      return [
        {
          id: 'kd-1',
          month: 'OCT',
          day: '21',
          title: 'Agenda for preliminary hearing',
          sub: 'Court deadline · TSK-000014',
          pill: 'Overdue by 1 day',
          pillTone: 'warning' as const,
          overdue: true,
        },
        {
          id: 'kd-2',
          month: 'NOV',
          day: '4',
          title: 'Preliminary hearing — Bristol ET',
          sub: '10:00 · By video · In 13 days',
          pill: '',
          pillTone: 'neutral' as const,
          overdue: false,
        },
        {
          id: 'kd-3',
          month: 'DEC',
          day: '9',
          title: 'Disclosure of documents',
          sub: 'Expected — confirm after hearing',
          pill: 'Provisional',
          pillTone: 'neutral' as const,
          overdue: false,
        },
      ];
    }

    const items = criticalDates.slice(0, 4).map((cd) => {
      const { month, day } = parseMonthAndDay(cd.date);
      const isOverdue = new Date(cd.date).getTime() < new Date('2026-10-22T00:00:00').getTime();
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
  }, [isBrightwaterTribunal, criticalDates, matter.targetCompletionAt]);

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

    const hasHours = Boolean(pmsFin) || isSeededDemoMatter;

    if (matter.responsiblePartnerId) {
      const nm = nameMap.get(matter.responsiblePartnerId) ?? matter.responsiblePartnerId;
      seen.add(matter.responsiblePartnerId);
      const isAlsoFeeEarner = matter.leadFeeEarnerId === matter.responsiblePartnerId;
      list.push({
        id: matter.responsiblePartnerId,
        initials: initialsOfName(nm),
        name: nm,
        role: isAlsoFeeEarner ? 'Responsible partner & Fee earner' : 'Responsible partner',
        hours: hasHours ? (isBrightwaterTribunal ? '22.5 h' : '18.0 h') : '',
        avatarBg: 'var(--pill-positive-bg)',
        avatarColor: 'var(--pill-positive-fg)',
      });
    }

    if (matter.leadFeeEarnerId && !seen.has(matter.leadFeeEarnerId)) {
      const nm = nameMap.get(matter.leadFeeEarnerId) ?? matter.leadFeeEarnerId;
      seen.add(matter.leadFeeEarnerId);
      const emp = people.find((p) => p.id === matter.leadFeeEarnerId);
      const roleLabel =
        isBrightwaterTribunal && matter.leadFeeEarnerId === 'P-000006'
          ? 'Fee earner · Associate'
          : emp?.jobTitle
            ? `Fee earner · ${emp.jobTitle.split(',')[0]}`
            : 'Lead fee earner';
      list.push({
        id: matter.leadFeeEarnerId,
        initials: initialsOfName(nm),
        name: nm,
        role: roleLabel,
        hours: hasHours ? (isBrightwaterTribunal ? '41.0 h' : '34.5 h') : '',
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
        hours: hasHours ? '6.0 h' : '',
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
        hours: hasHours ? '4.5 h' : '',
        avatarBg: 'var(--pill-positive-bg)',
        avatarColor: 'var(--pill-positive-fg)',
      });
    }

    for (const tid of matter.teamMemberIds) {
      if (seen.has(tid)) continue;
      seen.add(tid);
      const nm = nameMap.get(tid) ?? tid;
      const emp = people.find((p) => p.id === tid);
      const roleLabel =
        customRoles[tid] ||
        (tid === 'P-000010' ? 'Trainee' : emp?.jobTitle || 'Team member');
      list.push({
        id: tid,
        initials: initialsOfName(nm),
        name: nm,
        role: roleLabel,
        hours: hasHours ? '9.5 h' : '',
        avatarBg: 'var(--purple-bg)',
        avatarColor: 'var(--purple-text)',
      });
    }

    return list;
  }, [isBrightwaterTribunal, isSeededDemoMatter, pmsFin, matter, nameMap, people]);

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
    await addNoteAction('matter', matter.id, noteText.trim());
    setNoteText('');
    setNoteOpen(false);
    setSavingNote(false);
    router.refresh();
  }

  const riskTone: 'alert' | 'positive' | 'warning' =
    shortRiskLabel.toLowerCase().includes('high') ||
    shortRiskLabel.toLowerCase().includes('conflict')
      ? 'alert'
      : shortRiskLabel.toLowerCase().includes('low')
        ? 'positive'
        : 'warning';

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

        <div className="page-header__actions" style={{ flexShrink: 0, display: 'flex', gap: 10 }}>
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
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => setNoteOpen((o) => !o)}
          >
            <MessageSquarePlus size={16} />
            <span>Add note</span>
          </button>
          <Link href={`/matters/${matter.id}/edit`} className="btn btn--primary">
            <Edit3 size={16} />
            <span>Edit</span>
          </Link>
        </div>
      </div>

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
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'finance'}
          className={`tab-btn ${tab === 'finance' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('finance')}
        >
          Time &amp; billing
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'compliance'}
          className={`tab-btn ${tab === 'compliance' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('compliance')}
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
            <section className="home-panel">
              <div className="panel-header">
                <div className="panel-title-group">
                  <h2 className="panel-title">Financials</h2>
                  {!pmsFin && !isSeededDemoMatter ? (
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
                      <Check size={16} color="var(--pill-positive-fg)" strokeWidth={2.5} />
                      <span
                        style={{
                          fontSize: 14.5,
                          color: 'var(--teal)',
                          fontWeight: 600,
                        }}
                      >
                        Conflict check cleared
                      </span>
                    </div>
                    <div className="worklist-right">
                      <span className="worklist-meta">
                        {isBrightwaterTribunal
                          ? '12 Aug'
                          : matter.conflictCheckRecord?.submittedAtDisplay
                            ? '22 Oct'
                            : formatShortDayMonth(matter.conflictCheckDate) === '—'
                              ? '22 Oct'
                              : formatShortDayMonth(matter.conflictCheckDate)}{' '}
                        →
                      </span>
                    </div>
                  </li>

                  <li className="worklist-row">
                    <div
                      className="worklist-main"
                      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                      {isSeededDemoMatter || matter.amlCompletedAt ? (
                        <Check size={16} color="var(--pill-positive-fg)" strokeWidth={2.5} />
                      ) : (
                        <AlertCircle size={16} color="var(--pill-warning-fg)" />
                      )}
                      <span style={{ fontSize: 14.5 }}>Client due diligence</span>
                    </div>
                    <div className="worklist-right">
                      <span
                        className="worklist-meta"
                        style={
                          !isSeededDemoMatter && !matter.amlCompletedAt
                            ? { color: 'var(--pill-warning-fg)', fontWeight: 700 }
                            : undefined
                        }
                      >
                        {isBrightwaterTribunal
                          ? 'Verified 19 Jul'
                          : matter.amlCompletedAt
                            ? `Verified ${formatShortDayMonth(matter.amlCompletedAt)}`
                            : matter.amlStatus || 'CMI incomplete'}
                      </span>
                    </div>
                  </li>

                  <li className="worklist-row">
                    <div
                      className="worklist-main"
                      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                      {isSeededDemoMatter || matter.engagementLetterSignedAt ? (
                        <Check size={16} color="var(--pill-positive-fg)" strokeWidth={2.5} />
                      ) : (
                        <AlertCircle size={16} color="var(--pill-warning-fg)" />
                      )}
                      <span style={{ fontSize: 14.5 }}>
                        {isSeededDemoMatter || matter.engagementLetterSignedAt
                          ? 'Engagement letter signed'
                          : 'Engagement letter'}
                      </span>
                    </div>
                    <div className="worklist-right">
                      <span className="worklist-meta">
                        {isBrightwaterTribunal
                          ? '15 Aug'
                          : matter.engagementLetterSignedAt
                            ? formatShortDayMonth(matter.engagementLetterSignedAt)
                            : matter.engagementLetterStatus || 'Pending'}
                      </span>
                    </div>
                  </li>

                  <li
                    className="worklist-row"
                    style={{ cursor: 'pointer' }}
                    onClick={() => setTab('compliance')}
                  >
                    <div
                      className="worklist-main"
                      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                      <Check size={16} color="var(--pill-positive-fg)" strokeWidth={2.5} />
                      <span
                        style={{
                          fontSize: 14.5,
                          color: 'var(--teal)',
                          fontWeight: 600,
                        }}
                      >
                        Matter risk assessment (
                        {resolvedRiskAssessment.overallRisk
                          ? `${resolvedRiskAssessment.overallRisk} risk`
                          : 'Not started'}
                        )
                      </span>
                    </div>
                    <div className="worklist-right">
                      <span className="worklist-meta">
                        {resolvedRiskAssessment.completedQuestions}/
                        {resolvedRiskAssessment.totalQuestions} answered →
                      </span>
                    </div>
                  </li>
                </ul>
              </div>
            </section>

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
                          if (
                            !isBrightwaterTribunal &&
                            sizeLabel &&
                            sizeLabel.toLowerCase() !== 'unknown value'
                          ) {
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
                        {`${
                          ((matter.fieldValues['responsibleOffice'] as string) || '').trim() ||
                          (isBrightwaterTribunal ? 'Bristol' : 'Cardiff')
                        } · ${practiceLabel || (isBrightwaterTribunal ? 'Employment & HR' : 'Legal')}`}
                      </div>
                    </div>
                  </li>

                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-meta">Source of work</div>
                      <div className="worklist-title" style={{ marginTop: 2, marginBottom: 0 }}>
                        {((matter.fieldValues['sourceOfWork'] as string) || '').trim() ||
                          (isBrightwaterTribunal
                            ? 'Existing client — cross-referral from Corporate'
                            : originLabel || 'Existing client')}
                      </div>
                    </div>
                  </li>
                </ul>
              </div>
            </section>
          </div>
        </div>
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
                  label={isSeededDemoMatter ? 'SharePoint / DMS linked' : 'Matter opening record archived'}
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
              {isSeededDemoMatter ? (
                <>
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">Engagement Letter &amp; Terms of Business</div>
                      <div className="worklist-meta">
                        Client Care &amp; Engagement · Signed {openedDisplay}
                      </div>
                    </div>
                    <div className="worklist-right">
                      <StatusPill label="Executed" tone="positive" />
                    </div>
                  </li>
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        {isBrightwaterTribunal
                          ? 'ET3 Grounds of Resistance — Draft v2.docx'
                          : `${matter.matterNumber} — Principal Draft Documentation`}
                      </div>
                      <div className="worklist-meta">
                        Pleadings &amp; Statements of Case · Author: {responsiblePartnerName}
                      </div>
                    </div>
                    <div className="worklist-right">
                      <StatusPill label="Working draft" tone="neutral" />
                    </div>
                  </li>
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        {isBrightwaterTribunal
                          ? 'Bristol ET Preliminary Hearing Case Management Agenda.pdf'
                          : 'Case Management & Correspondence Bundle'}
                      </div>
                      <div className="worklist-meta">Court &amp; Tribunal Bundle · Current stage</div>
                    </div>
                    <div className="worklist-right">
                      <StatusPill label="In review" tone="warning" />
                    </div>
                  </li>
                </>
              ) : null}
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
      {tab === 'finance' ? (
        <div>
          {canViewFinance && pmsView ? (
            <MatterFinanceTab
              matterId={matter.id}
              matterNumber={matter.matterNumber}
              pmsView={pmsView}
              currentUserRole={currentUserRole}
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
                      label={rec.status}
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
                    {conflictRecordMinimised ? (
                      <span
                        className="muted"
                        style={{ fontSize: 12.5, fontWeight: 500, marginLeft: 4 }}
                      >
                        {rec.outcomeLabel} · {rec.parties.length} parties checked ·{' '}
                        {rec.matches.length} {rec.matches.length === 1 ? 'match' : 'matches'}
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
                        const newRun = {
                          id: `run-${Date.now()}`,
                          runAtDisplay: '22 Oct 2026, 17:52',
                          runById: currentUserId,
                          runByName: 'Bethan R.',
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
                          {rec.submittedByName || 'Bethan Rees'} ·{' '}
                          {rec.submittedAtDisplay || '22 Oct 2026, 17:46'}
                        </span>
                      </div>
                      <div className="kv-item">
                        <span className="kv-label">Approved / cleared by &amp; when</span>
                        <span className="kv-value">
                          {rec.approvedByName || 'Bethan Rees (Cleared by fee earner)'} ·{' '}
                          {rec.approvedAtDisplay || '22 Oct 2026, 17:46'}
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
                                    Risk / Compliance decision ({m.reviewedByName || 'Bethan Rees'}
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
                        const secTone: 'alert' | 'warning' | 'positive' =
                          sec.sectionRisk === 'High'
                            ? 'alert'
                            : sec.sectionRisk === 'Medium'
                              ? 'warning'
                              : 'positive';
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
                                label={`${sec.sectionRisk || 'Low'} risk`}
                                tone={secTone}
                              />
                            </div>
                            <ul className="worklist" style={{ padding: '0 14px' }}>
                              {sec.questions.map((q) => {
                                const qTone: 'alert' | 'warning' | 'positive' =
                                  q.risk === 'High'
                                    ? 'alert'
                                    : q.risk === 'Medium'
                                      ? 'warning'
                                      : 'positive';
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
                                      <StatusPill label={q.risk || 'Low'} tone={qTone} />
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
                  <span className="kv-value">{matter.conflictCheckStatus}</span>
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
                  <span className="kv-value">{matter.amlStatus}</span>
                </div>
                <div className="kv-item">
                  <span className="kv-label">AML completed date (CORE-038)</span>
                  <span className="kv-value">{formatDate(matter.amlCompletedAt)}</span>
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
                  <span className="kv-label">Engagement letter signed (CORE-043)</span>
                  <span className="kv-value">{formatDate(matter.engagementLetterSignedAt)}</span>
                </div>
              </div>
            </div>
          </section>
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
                        label={`Conflict Check · ${rec.status}`}
                        tone={
                          rec.status === 'Cleared' || rec.status === 'Approved'
                            ? 'positive'
                            : rec.status === 'Referred'
                              ? 'warning'
                              : 'alert'
                        }
                      />
                      <strong style={{ fontSize: 14 }}>
                        Conflict check record — {rec.outcomeLabel}
                      </strong>
                      <span className="muted" style={{ fontSize: 12.5 }}>
                        · Submitted {rec.submittedAtDisplay} by {rec.submittedByName}
                      </span>
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
                      <span className="kv-value">{riskSnap.overallRisk} risk</span>
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
                          .map((s) => `${s.number}. ${s.title}: ${s.sectionRisk || 'Low'}`)
                          .join(' · ')}
                      </span>
                    </div>
                    <div className="kv-item">
                      <span className="kv-label">Assessed by</span>
                      <span className="kv-value">
                        {riskSnap.completedByName} ({formatDateTime(riskSnap.completedAt)})
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
                            {sec.number}. {sec.title} ({sec.sectionRisk || 'Low'} risk)
                          </div>
                          {sec.questions.map((q) => (
                            <div key={q.id} style={{ fontSize: 12.5, padding: '3px 0' }}>
                              • {q.question}: <strong>{q.answer}</strong> ({q.risk || 'Low'} risk)
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
          if (
            doc.documentType === 'Client Care Letter' &&
            matter.engagementLetterStatus !== 'Signed'
          ) {
            void markEngagementLetterDraftedAction(matter.id);
          }
          showToast(`Generated ${doc.fileName}`);
          router.refresh();
        }}
      />
    </div>
  );
}
