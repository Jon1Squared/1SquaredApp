'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Calendar, Check, FileText, Flag, Phone, Plus, Search } from 'lucide-react';
import {
  approveSignOffAction,
  assignEnquiryAction,
  discussSignOffAction,
  flagMatterWriteOffAction,
  getDocumentGenerationSnapshotAction,
  logEnquiryContactAction,
  prepareEnquiryConversionAction,
  recordInvoiceCreditControlActionAction,
  remindTeamLeadOverdueComplianceAction,
  requestMatterBillAction,
  saveEnquiryAction,
  saveTaskAction,
  takeTaskAction,
} from '@/app/actions';
import { isActionDenied } from '@/domain/actionResult';
import { formatDate } from '@/domain/dates';
import { findOrganisationDuplicates, findPersonDuplicates } from '@/domain/duplicates';
import { enquiryDisplayName, isEnquiryOpen } from '@/domain/enquiries';
import { selectHomeCandidateTasks } from '@/domain/homeTasks';
import { resolveLabel } from '@/domain/lists';
import { formatConversionConflictWarningsNotice } from '@/domain/matterConflicts';
import { extractCriticalDates } from '@/domain/matters';
import { personDisplayName } from '@/domain/names';
import { findOneSquaredIdForPmsCode, formatGbp } from '@/domain/pms';
import type { SearchDoc } from '@/domain/search';
import { isTaskOpen } from '@/domain/tasks';
import type {
  AppFinanceCapabilities,
  AppSnapshot,
  ChoiceValue,
  ContactLogMethod,
  ContactLogOutcome,
  Enquiry,
  HomePagesConfig,
  Matter,
  Organisation,
  PanelId,
  Person,
  PmsLink,
  RoleHomeConfig,
  SignOffItem,
  Task,
  Team,
} from '@/domain/types';
import type {
  PmsCashReceivedSummary,
  PmsClientAccountEntry,
  PmsClientFinancials,
  PmsDepartmentFinancials,
  PmsDisbursement,
  PmsFeeEarnerPerformance,
  PmsFeeEarnerWeeklyTime,
  PmsInvoiceBalance,
  PmsInvoiceDetail,
  PmsMatterFinancials,
  PmsMonthlyFeesBilled,
} from '@/pms/types';
import { HeroHomeSearch, StatusPill } from './SearchBox';
import { useToast } from './Toast';

export type HomeSnapshotBaseProps = Pick<
  AppSnapshot,
  | 'currentUser'
  | 'effectiveWorkPerson'
  | 'homePagesConfig'
  | 'searchIndex'
  | 'signOffs'
  | 'people'
  | 'organisations'
  | 'matters'
  | 'enquiries'
  | 'tasks'
  | 'teams'
  | 'values'
>;

export interface HomeClientProps extends HomeSnapshotBaseProps {
  activeRoleKey: string;
  finance?: AppFinanceCapabilities;
  pmsLinks?: PmsLink[];
  pmsAsAtDate?: string;
  pmsSummaryByMatterId?: Record<string, PmsMatterFinancials>;
  pmsSummaryByClientId?: Record<string, PmsClientFinancials>;
  allMatterFins?: PmsMatterFinancials[];
  allClientFins?: PmsClientFinancials[];
  allFeeEarnerPerformance?: PmsFeeEarnerPerformance[];
  myFeeEarnerFigures?: PmsFeeEarnerPerformance | null;
  myWeeklyTime?: PmsFeeEarnerWeeklyTime | null;
  pmsAgedDebt?: PmsInvoiceBalance[];
  pmsInvoices?: PmsInvoiceDetail[];
  pmsMonthlyFeesBilled?: { months: PmsMonthlyFeesBilled[]; yearToDateTotal: number };
  pmsCashReceived?: PmsCashReceivedSummary;
  pmsDepartmentFinancials?: {
    departments: PmsDepartmentFinancials[];
    firmTotal: PmsDepartmentFinancials;
  };
  pmsAllDisbursements?: PmsDisbursement[];
  pmsClientAccountByMatterCode?: Record<string, PmsClientAccountEntry[]>;
}

const DEFAULT_FINANCE_CAPABILITIES: AppFinanceCapabilities = {
  canViewFirm: false,
  canViewMatter: false,
  canCreditControl: false,
};

const EMPTY_MONTHLY_FEES_BILLED: {
  months: PmsMonthlyFeesBilled[];
  yearToDateTotal: number;
} = {
  months: [],
  yearToDateTotal: 0,
};

const EMPTY_CASH_RECEIVED: PmsCashReceivedSummary = {
  currentMonthTotal: 0,
  currentMonthReceiptCount: 0,
  previousMonthTotal: 0,
  previousMonthReceiptCount: 0,
};

const EMPTY_DEPARTMENT_FINANCIALS: {
  departments: PmsDepartmentFinancials[];
  firmTotal: PmsDepartmentFinancials;
} = {
  departments: [],
  firmTotal: {
    practiceArea: 'Firm total',
    openMatters: 0,
    billedThisYear: 0,
    unbilledWip: 0,
    outstandingDebt: 0,
    overdueDebt: 0,
    currentMonthHours: 0,
  },
};

export function HomeClient({
  currentUser,
  effectiveWorkPerson,
  activeRoleKey,
  homePagesConfig,
  searchIndex,
  signOffs,
  people,
  organisations,
  matters,
  enquiries,
  tasks,
  teams,
  values,
  finance = DEFAULT_FINANCE_CAPABILITIES,
  pmsLinks = [],
  pmsAsAtDate,
  pmsSummaryByMatterId = {},
  allMatterFins = [],
  allClientFins = [],
  allFeeEarnerPerformance = [],
  myFeeEarnerFigures = null,
  myWeeklyTime = null,
  pmsAgedDebt = [],
  pmsInvoices = [],
  pmsMonthlyFeesBilled = EMPTY_MONTHLY_FEES_BILLED,
  pmsCashReceived = EMPTY_CASH_RECEIVED,
  pmsDepartmentFinancials = EMPTY_DEPARTMENT_FINANCIALS,
  pmsAllDisbursements = [],
  pmsClientAccountByMatterCode = {},
}: HomeClientProps) {
  const router = useRouter();
  const { showToast } = useToast();

  // Modal state for inline Log contact
  const [logModalEnq, setLogModalEnq] = useState<Enquiry | null>(null);
  const [logMethod, setLogMethod] = useState<ContactLogMethod>('Call');
  const [logOutcome, setLogOutcome] = useState<ContactLogOutcome>('Spoke');
  const [logNote, setLogNote] = useState('');

  // Modal state for Partner sign-off discussion
  const [discussSignOffItem, setDiscussSignOffItem] = useState<SignOffItem | null>(null);
  const [discussNote, setDiscussNote] = useState('');
  const [pendingTemplateApprovalsCount, setPendingTemplateApprovalsCount] = useState(0);
  const [canApproveTemplates, setCanApproveTemplates] = useState(false);

  useEffect(() => {
    let active = true;
    void getDocumentGenerationSnapshotAction()
      .then((snap) => {
        if (!active) return;
        setPendingTemplateApprovalsCount(snap.pendingApprovalsCount);
        setCanApproveTemplates(
          snap.userPermissions.includes('document_template:approve'),
        );
      })
      .catch(() => {
        // Ignore if not applicable
      });
    return () => {
      active = false;
    };
  }, [currentUser.id]);

  // Quick enquiry capture state (Panel 13 - Enquiries Coordinator)
  const [qFirstName, setQFirstName] = useState('');
  const [qLastName, setQLastName] = useState('');
  const [qOnBehalf, setQOnBehalf] = useState('');
  const [qPhone, setQPhone] = useState('');
  const [qEmail, setQEmail] = useState('');
  const [qChannelId, setQChannelId] = useState('enquiry_channel.phone');
  const [qPracticeAreaId, setQPracticeAreaId] = useState('work_type.real_estate_and_property');
  const [qUrgencyId, setQUrgencyId] = useState('enquiry_urgency.urgent');
  const [qBestTime, setQBestTime] = useState('');
  const [qSummary, setQSummary] = useState('');
  const [qOtherParties, setQOtherParties] = useState('');
  const [qPrivacyGiven, setQPrivacyGiven] = useState(true);
  const [qLinkExistingId, setQLinkExistingId] = useState<string | null>(null);

  const roleConfig: RoleHomeConfig = useMemo(() => {
    return (
      homePagesConfig.roles.find((r) => r.key === activeRoleKey) ??
      homePagesConfig.roles.find((r) => r.key === 'fee_earner') ??
      homePagesConfig.roles[0]
    );
  }, [homePagesConfig.roles, activeRoleKey]);

  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const tomorrowIso = useMemo(() => {
    const d = new Date(`${todayIso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }, [todayIso]);
  const next7DaysIso = useMemo(() => {
    const d = new Date(`${todayIso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  }, [todayIso]);
  const next14DaysIso = useMemo(() => {
    const d = new Date(`${todayIso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 14);
    return d.toISOString().slice(0, 10);
  }, [todayIso]);
  const effectiveAsAtIso = pmsAsAtDate || todayIso;
  const formattedAsAt = useMemo(
    () => formatDate(effectiveAsAtIso) || todayIso,
    [effectiveAsAtIso, todayIso],
  );
  const currentMonthKey = useMemo(() => todayIso.slice(0, 7), [todayIso]);
  const currentYearLabel = useMemo(() => todayIso.slice(0, 4), [todayIso]);
  const currentMonthShort = useMemo(() => {
    const d = new Date(`${todayIso}T12:00:00Z`);
    return Number.isNaN(d.getTime())
      ? 'Month'
      : d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
  }, [todayIso]);
  const currentMonthYearLabel = useMemo(() => {
    const d = new Date(`${todayIso}T12:00:00Z`);
    return Number.isNaN(d.getTime())
      ? todayIso.slice(0, 7)
      : d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }, [todayIso]);

  const personById = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const orgById = useMemo(() => new Map(organisations.map((o) => [o.id, o])), [organisations]);
  const matterById = useMemo(() => new Map(matters.map((m) => [m.id, m])), [matters]);
  const enquiryById = useMemo(() => new Map(enquiries.map((e) => [e.id, e])), [enquiries]);
  const teamById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);

  const matterHrefForCode = (matterCode: string): string => {
    const linkedId = findOneSquaredIdForPmsCode(pmsLinks, 'matter', matterCode);
    if (linkedId && matterById.has(linkedId)) return `/matters/${linkedId}`;
    const direct = matters.find((m) => m.matterNumber === matterCode);
    if (direct) return `/matters/${direct.id}`;
    return '/matters';
  };

  const clientHrefForCode = (clientCode: string): string => {
    const orgId = findOneSquaredIdForPmsCode(pmsLinks, 'organisation', clientCode);
    if (orgId && orgById.has(orgId)) return `/organisations/${orgId}`;
    const perId = findOneSquaredIdForPmsCode(pmsLinks, 'person', clientCode);
    if (perId && personById.has(perId)) return `/people/${perId}`;
    return '/organisations';
  };

  // Supported fee earners for Legal Secretary
  const supportedFeeEarnerIds = useMemo(() => {
    if (effectiveWorkPerson.supportsIds && effectiveWorkPerson.supportsIds.length > 0) {
      return effectiveWorkPerson.supportsIds;
    }
    if (currentUser.supportsIds && currentUser.supportsIds.length > 0) {
      return currentUser.supportsIds;
    }
    return [];
  }, [effectiveWorkPerson.supportsIds, currentUser.supportsIds]);

  const supportedNamesLabel = useMemo(() => {
    return supportedFeeEarnerIds
      .map((id) => {
        const p = personById.get(id);
        return p ? `${personDisplayName(p)} (${p.jobTitle.split(',')[0]})` : id;
      })
      .join(' & ');
  }, [supportedFeeEarnerIds, personById]);

  // User's teams
  const myTeams = useMemo(
    () =>
      teams.filter(
        (t) =>
          t.active &&
          (t.memberIds.includes(effectiveWorkPerson.id) || t.memberIds.includes(currentUser.id)),
      ),
    [teams, effectiveWorkPerson.id, currentUser.id],
  );
  const myTeamIds = useMemo(() => new Set(myTeams.map((t) => t.id)), [myTeams]);

  // Tasks for the effective work person
  const myOpenTasks = useMemo(() => {
    return tasks
      .filter(
        (t) =>
          isTaskOpen(t) &&
          (t.assignedPersonId === effectiveWorkPerson.id || t.assignedPersonId === currentUser.id),
      )
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  }, [tasks, effectiveWorkPerson.id, currentUser.id]);

  // Enquiries assigned to the effective work person
  const myOpenEnquiries = useMemo(() => {
    return enquiries
      .filter(
        (e) =>
          isEnquiryOpen(e) &&
          (e.assignedToId === effectiveWorkPerson.id || e.assignedToId === currentUser.id),
      )
      .sort((a, b) => (a.firstContactDueAt ?? a.receivedAt).localeCompare(b.firstContactDueAt ?? b.receivedAt));
  }, [enquiries, effectiveWorkPerson.id, currentUser.id]);

  // Active matters for the effective work person
  const myActiveMatters = useMemo(() => {
    return matters.filter(
      (m) =>
        m.matterStatusId !== 'matter_status.closed' &&
        (m.leadFeeEarnerId === effectiveWorkPerson.id ||
          m.responsiblePartnerId === effectiveWorkPerson.id ||
          m.teamMemberIds.includes(effectiveWorkPerson.id)),
    );
  }, [matters, effectiveWorkPerson.id]);

  // Supervised matters for Partner
  const supervisedMatters = useMemo(() => {
    const partnerId = effectiveWorkPerson.id;
    return matters.filter(
      (m) =>
        m.matterStatusId !== 'matter_status.closed' &&
        (m.supervisingPartnerId === partnerId || m.responsiblePartnerId === partnerId),
    );
  }, [matters, effectiveWorkPerson.id]);

  // Pending sign-offs
  const pendingSignOffs = useMemo(
    () => signOffs.filter((s) => s.status === 'Pending'),
    [signOffs],
  );

  // Firm financial totals from PMS
  const firmWipTotal = useMemo(
    () => Math.round(allMatterFins.reduce((s, m) => s + m.unbilled_wip, 0) * 100) / 100,
    [allMatterFins],
  );
  const firmTotalDebt = useMemo(
    () => Math.round(allMatterFins.reduce((s, m) => s + m.outstanding_debt, 0) * 100) / 100,
    [allMatterFins],
  );
  const firmOverdueDebt = useMemo(
    () =>
      Math.round(
        pmsAgedDebt
          .filter((inv) => (inv.days_past_due ?? 0) > 0)
          .reduce((s, inv) => s + inv.outstanding, 0) * 100,
      ) / 100,
    [pmsAgedDebt],
  );
  const firmClientAccountHeld = useMemo(
    () => Math.round(allMatterFins.reduce((s, m) => s + m.client_account_balance, 0) * 100) / 100,
    [allMatterFins],
  );
  const firmUnbilledDisbNet = useMemo(
    () => Math.round(allMatterFins.reduce((s, m) => s + m.unbilled_disbursements, 0) * 100) / 100,
    [allMatterFins],
  );

  // Live duplicate check for Quick Enquiry Capture (Panel 13)
  const quickDuplicateHits = useMemo(() => {
    const personHits = findPersonDuplicates(
      {
        firstName: qFirstName,
        surname: qLastName,
        emails: qEmail ? [qEmail] : [],
        phones: qPhone ? [qPhone] : [],
      },
      people,
    );
    const orgHits = qOnBehalf
      ? findOrganisationDuplicates({ legalName: qOnBehalf }, organisations)
      : [];
    return { personHits, orgHits };
  }, [qFirstName, qLastName, qEmail, qPhone, qOnBehalf, people, organisations]);

  // ------------------------------------------------------------------ Actions
  async function handleCompleteTask(task: Task) {
    await saveTaskAction({
      id: task.id,
      title: task.title,
      description: task.description,
      taskTypeId: task.taskTypeId,
      priorityId: task.priorityId,
      dueAt: task.dueAt,
      assignedTeamId: task.assignedTeamId,
      assignedPersonId: task.assignedPersonId ?? currentUser.id,
      status: 'Done',
      linkedRecords: task.linkedRecords,
    });
    showToast(`Completed ${task.reference} — ${task.title}`);
    router.refresh();
  }

  async function handleStartTask(task: Task) {
    await saveTaskAction({
      id: task.id,
      title: task.title,
      description: task.description,
      taskTypeId: task.taskTypeId,
      priorityId: task.priorityId,
      dueAt: task.dueAt,
      assignedTeamId: task.assignedTeamId,
      assignedPersonId: task.assignedPersonId ?? currentUser.id,
      status: 'In progress',
      linkedRecords: task.linkedRecords,
    });
    showToast(`Started ${task.reference} — ${task.title}`);
    router.refresh();
  }

  async function handleTakeTask(task: Task) {
    await takeTaskAction(task.id);
    showToast(`Claimed ${task.reference} into your tasks`);
    router.refresh();
  }

  async function handleTakeEnquiry(enq: Enquiry, targetAssigneeId?: string) {
    const assigneeId = targetAssigneeId ?? effectiveWorkPerson.id;
    await assignEnquiryAction(enq.id, assigneeId, enq.assignedTeamId);
    const assignee = personById.get(assigneeId);
    showToast(
      `Assigned ${enq.reference} (${enquiryDisplayName(enq)}) to ${assignee ? personDisplayName(assignee) : 'you'}`,
    );
    router.refresh();
  }

  async function handleConvertEnquiry(enq: Enquiry) {
    const res = await prepareEnquiryConversionAction(enq.id, {
      usePersonId: enq.linkedPersonId,
      useOrganisationId: enq.linkedOrganisationId,
      createForBusiness: Boolean(enq.callingOnBehalfOf),
    });
    if (isActionDenied(res)) {
      showToast(res.message);
      return;
    }
    if (!res.ok) {
      showToast(res.conflictReasons?.[0] ?? 'Cannot convert enquiry until conflict check is cleared.');
      return;
    }
    const warningNotice = formatConversionConflictWarningsNotice(
      res.conflictWarnings,
    );
    if (warningNotice) {
      showToast(warningNotice);
    }
    const qs = new URLSearchParams();
    qs.set('enquiryId', enq.id);
    if (res.clientId) qs.set('clientId', res.clientId);
    if (res.instructingContactId) qs.set('instructingContactId', res.instructingContactId);
    router.push(`/matters/new?${qs.toString()}`);
  }

  async function handleSubmitContactLog(e: React.FormEvent) {
    e.preventDefault();
    if (!logModalEnq) return;
    await logEnquiryContactAction(logModalEnq.id, {
      method: logMethod,
      outcome: logOutcome,
      note: logNote.trim() || `Contact logged (${logMethod} · ${logOutcome}).`,
    });
    showToast(`Logged contact on ${logModalEnq.reference}`);
    setLogModalEnq(null);
    setLogNote('');
    router.refresh();
  }

  async function handleQuickCaptureSubmit(e: React.FormEvent, claimAndCallNow = false) {
    e.preventDefault();
    if (!qFirstName.trim() || !qLastName.trim() || !qSummary.trim()) {
      showToast('Please enter caller name and brief summary.');
      return;
    }
    const res = await saveEnquiryAction({
      firstName: qFirstName.trim(),
      lastName: qLastName.trim(),
      callingOnBehalfOf: qOnBehalf.trim(),
      phone: qPhone.trim(),
      email: qEmail.trim(),
      channelId: qChannelId,
      practiceAreaId: qPracticeAreaId,
      urgencyId: qUrgencyId,
      bestTimeToCall: qBestTime.trim(),
      summary: qSummary.trim(),
      notes: qSummary.trim(),
      otherPartiesNamed: qOtherParties.trim(),
      privacyNoticeGiven: qPrivacyGiven,
      linkedPersonId: qLinkExistingId,
      assignedToId: claimAndCallNow ? effectiveWorkPerson.id : null,
    });
    if (res.errors) {
      showToast(Object.values(res.errors)[0] || 'Validation failed.');
      return;
    }
    showToast(
      `Saved ${res.enquiry?.reference ?? 'enquiry'} and routed to ${res.routedTeamName ?? 'practice area team'}.`,
    );
    setQFirstName('');
    setQLastName('');
    setQOnBehalf('');
    setQPhone('');
    setQEmail('');
    setQBestTime('');
    setQSummary('');
    setQOtherParties('');
    setQLinkExistingId(null);
    router.refresh();
  }

  // ------------------------------------------------------------------ Headline KPI Cards
  function renderHeadlineCard(cardId: string) {
    const openMattersCount = matters.filter(
      (m) => m.matterStatusId !== 'matter_status.closed',
    ).length;
    const openEnqsCount = enquiries.filter((e) => isEnquiryOpen(e)).length;
    const unassignedEnqsCount = enquiries.filter(
      (e) => isEnquiryOpen(e) && !e.assignedToId,
    ).length;
    const convertedEnqsCount = enquiries.filter((e) => e.status === 'Converted').length;
    const overdueBillsCount = pmsAgedDebt.filter((inv) => (inv.days_past_due ?? 0) > 0).length;
    const unbilledDisbsList = pmsAllDisbursements.filter((d) => d.billed_status === 'Unbilled');

    switch (cardId) {
      // 01 Fee Earner
      case 'fe_tasks_due': {
        const effectiveOpenTasks = selectHomeCandidateTasks({
          tasks,
          currentUserId: currentUser.id,
          effectiveWorkPersonId: effectiveWorkPerson.id,
          myTeamIds,
        });
        const effectiveOverdueTasks = effectiveOpenTasks.filter(
          (t) => t.dueAt.slice(0, 10) < todayIso,
        );
        const effectiveDueTodayTasks = effectiveOpenTasks.filter(
          (t) => t.dueAt.slice(0, 10) === todayIso,
        );
        const total = effectiveDueTodayTasks.length + effectiveOverdueTasks.length;
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Tasks due / overdue</span>
              {effectiveOverdueTasks.length > 0 ? (
                <StatusPill label={`${effectiveOverdueTasks.length} overdue`} tone="alert" />
              ) : null}
            </div>
            <div className="kpi-value">{total}</div>
            <div className="kpi-sub">
              {effectiveDueTodayTasks.length} due today · {effectiveOpenTasks.length} open total
            </div>
          </div>
        );
      }
      case 'fe_enquiries_contact': {
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Enquiries to contact</span>
              {myOpenEnquiries.length > 0 ? (
                <StatusPill label="SLA today" tone="warning" />
              ) : null}
            </div>
            <div className="kpi-value">{myOpenEnquiries.length}</div>
            <div className="kpi-sub">{myOpenEnquiries.length} open assigned</div>
          </div>
        );
      }
      case 'fe_active_matters': {
        const count = myActiveMatters.length;
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>My active matters</span>
            </div>
            <div className="kpi-value">{count}</div>
            <div className="kpi-sub">
              {count} active matter{count === 1 ? '' : 's'}
            </div>
          </div>
        );
      }
      case 'fe_hours_month': {
        const hasFigures = myWeeklyTime !== null || myFeeEarnerFigures !== null;
        const mtd =
          myWeeklyTime?.monthToDateHours ??
          myFeeEarnerFigures?.chargeable_hours_this_month ??
          0;
        const ytd = myFeeEarnerFigures?.chargeable_hours ?? 0;
        const target = myFeeEarnerFigures?.annual_target_hours ?? null;
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Chargeable hrs ({currentMonthShort})</span>
              <span className="mono-code">PMS</span>
            </div>
            <div className="kpi-value">{hasFigures ? `${mtd.toFixed(1)} h` : '–'}</div>
            <div className="kpi-sub">
              {!hasFigures
                ? 'No time data available'
                : target && target > 0
                  ? `${ytd.toFixed(1)} h YTD of ${target.toLocaleString('en-GB')} h annual target`
                  : `${ytd.toFixed(1)} h YTD`}
            </div>
          </div>
        );
      }
      case 'fe_unbilled_wip': {
        const wip = myWeeklyTime?.myUnbilledWip ?? myFeeEarnerFigures?.unbilled_wip ?? null;
        const count = myWeeklyTime?.myUnbilledMatterCount ?? 0;
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>My unbilled WIP</span>
              <span className="mono-code">PMS</span>
            </div>
            <div className="kpi-value">{wip !== null ? formatGbp(wip) : '–'}</div>
            <div className="kpi-sub">
              {wip !== null
                ? `Across ${count} matter${count === 1 ? '' : 's'}`
                : 'No WIP data available'}
            </div>
          </div>
        );
      }

      // 02 Partner / HoD
      case 'pt_supervised_matters':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Supervised matters</span>
            </div>
            <div className="kpi-value">{supervisedMatters.length} open</div>
            <div className="kpi-sub">
              {matters.filter((m) => m.matterStatusId === 'matter_status.closed').length} closed
            </div>
          </div>
        );
      case 'pt_team_wip':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Team unbilled WIP</span>
              <span className="mono-code">PMS</span>
            </div>
            <div className="kpi-value">{formatGbp(firmWipTotal)}</div>
            <div className="kpi-sub">
              {allMatterFins.length} matter{allMatterFins.length === 1 ? '' : 's'}
            </div>
          </div>
        );
      case 'pt_overdue_debt':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Overdue client debt</span>
              {overdueBillsCount > 0 ? (
                <StatusPill label={`${overdueBillsCount} overdue`} tone="alert" />
              ) : null}
            </div>
            <div className="kpi-value">{formatGbp(firmOverdueDebt)}</div>
            <div className="kpi-sub">
              Across {overdueBillsCount} bill{overdueBillsCount === 1 ? '' : 's'} ·{' '}
              {formatGbp(firmTotalDebt)} total debt
            </div>
          </div>
        );
      case 'pt_sign_offs':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Sign-offs waiting</span>
              {pendingSignOffs.length > 0 ? <StatusPill label="Action" tone="neutral" /> : null}
            </div>
            <div className="kpi-value">{pendingSignOffs.length}</div>
            <div className="kpi-sub">
              {pendingSignOffs.length === 0
                ? 'All sign-offs up to date'
                : `${pendingSignOffs.length} pending partner review`}
            </div>
          </div>
        );
      case 'pt_enquiries_month':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Dept enquiries ({currentMonthShort})</span>
            </div>
            <div className="kpi-value">{enquiries.length}</div>
            <div className="kpi-sub">
              {convertedEnqsCount} converted · {unassignedEnqsCount} unassigned
            </div>
          </div>
        );

      // 03 Legal Secretary
      case 'ls_tasks_queue': {
        const secOpenTasks = tasks.filter(
          (t) =>
            isTaskOpen(t) &&
            (t.assignedPersonId === effectiveWorkPerson.id ||
              (t.assignedPersonId && supportedFeeEarnerIds.includes(t.assignedPersonId)) ||
              (t.assignedTeamId !== null && myTeamIds.has(t.assignedTeamId))),
        );
        const secOverdueCount = secOpenTasks.filter((t) => t.dueAt.slice(0, 10) < todayIso).length;
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Tasks in my queue</span>
              {secOverdueCount > 0 ? (
                <StatusPill label={`${secOverdueCount} overdue`} tone="alert" />
              ) : null}
            </div>
            <div className="kpi-value">{secOpenTasks.length}</div>
            <div className="kpi-sub">{myOpenTasks.length} assigned to me</div>
          </div>
        );
      }
      case 'ls_letters_docs':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Letters &amp; docs to prepare</span>
            </div>
            <div className="kpi-value">–</div>
            <div className="kpi-sub">Not yet available</div>
          </div>
        );
      case 'ls_matter_openings':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Matter openings in progress</span>
            </div>
            <div className="kpi-value">
              {matters.filter((m) => m.matterStatusId === 'matter_status.opening').length}
            </div>
            <div className="kpi-sub">AML, engagement letter &amp; retainer checks</div>
          </div>
        );
      case 'ls_completions_7d': {
        const completionsCount = matters
          .filter((m) => m.matterStatusId !== 'matter_status.closed')
          .reduce((acc, m) => {
            const subcatLabel = resolveLabel(values, m.workTypeSubcategoryId);
            const critDates = extractCriticalDates(m, subcatLabel).filter(
              (cd) => cd.date.slice(0, 10) >= todayIso && cd.date.slice(0, 10) <= next7DaysIso,
            );
            return acc + critDates.length;
          }, 0);
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Completions next 7 days</span>
            </div>
            <div className="kpi-value">{completionsCount}</div>
            <div className="kpi-sub">
              {completionsCount === 0
                ? 'No completions scheduled'
                : `${completionsCount} key date${completionsCount === 1 ? '' : 's'} due`}
            </div>
          </div>
        );
      }
      case 'ls_unbilled_disb':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Unbilled disbursements</span>
              <span className="mono-code">PMS</span>
            </div>
            <div className="kpi-value">{formatGbp(firmUnbilledDisbNet)}</div>
            <div className="kpi-sub">
              {unbilledDisbsList.length} item{unbilledDisbsList.length === 1 ? '' : 's'}
            </div>
          </div>
        );

      // 04 Enquiries Coordinator
      case 'ec_callbacks_due': {
        const overdueCallbacks = enquiries.filter(
          (e) =>
            isEnquiryOpen(e) &&
            e.firstContactDueAt &&
            e.firstContactDueAt.slice(0, 10) < todayIso,
        ).length;
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Callbacks due today</span>
              {overdueCallbacks > 0 ? (
                <StatusPill label={`${overdueCallbacks} overdue`} tone="alert" />
              ) : null}
            </div>
            <div className="kpi-value">{openEnqsCount}</div>
            <div className="kpi-sub">
              {openEnqsCount} open enquir{openEnqsCount === 1 ? 'y' : 'ies'}
            </div>
          </div>
        );
      }
      case 'ec_unassigned':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Unassigned enquiries</span>
              {unassignedEnqsCount > 0 ? <StatusPill label="Needs owner" tone="warning" /> : null}
            </div>
            <div className="kpi-value">{unassignedEnqsCount}</div>
            <div className="kpi-sub">{unassignedEnqsCount} awaiting assignment</div>
          </div>
        );
      case 'ec_awaiting_fe': {
        const awaitingCount = enquiries.filter(
          (e) => isEnquiryOpen(e) && e.assignedToId && e.status === 'Assigned',
        ).length;
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Awaiting fee earner contact</span>
              {awaitingCount > 0 ? <StatusPill label="Chase" tone="neutral" /> : null}
            </div>
            <div className="kpi-value">{awaitingCount}</div>
            <div className="kpi-sub">Assigned but first contact not yet logged</div>
          </div>
        );
      }
      case 'ec_converted_month':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Converted ({currentMonthShort})</span>
            </div>
            <div className="kpi-value">
              {convertedEnqsCount} of {enquiries.length}
            </div>
            <div className="kpi-sub">{openEnqsCount} open</div>
          </div>
        );
      case 'ec_no_response': {
        const noRespCount = enquiries.filter((e) => e.contactLog.length >= 3).length;
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>3+ attempts — no response</span>
              {noRespCount > 0 ? <StatusPill label="Review" tone="warning" /> : null}
            </div>
            <div className="kpi-value">{noRespCount}</div>
            <div className="kpi-sub">Threshold from Admin › Enquiries (3 tries)</div>
          </div>
        );
      }

      // 05 Finance / Credit Control
      case 'fin_total_debt':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Total outstanding debt</span>
              <span className="mono-code">PMS</span>
            </div>
            <div className="kpi-value">{formatGbp(firmTotalDebt)}</div>
            <div className="kpi-sub">
              Across {pmsAgedDebt.length} unpaid / part-paid invoice
              {pmsAgedDebt.length === 1 ? '' : 's'}
            </div>
          </div>
        );
      case 'fin_overdue_debt': {
        const notYetDueTotal =
          Math.round(
            pmsAgedDebt
              .filter((inv) => (inv.days_past_due ?? 0) <= 0)
              .reduce((s, inv) => s + inv.outstanding, 0) * 100,
          ) / 100;
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Overdue debt</span>
              {overdueBillsCount > 0 ? (
                <StatusPill label={`${overdueBillsCount} overdue`} tone="alert" />
              ) : null}
            </div>
            <div className="kpi-value">{formatGbp(firmOverdueDebt)}</div>
            <div className="kpi-sub">
              {overdueBillsCount} overdue bill{overdueBillsCount === 1 ? '' : 's'} ·{' '}
              {formatGbp(notYetDueTotal)} not yet due
            </div>
          </div>
        );
      }
      case 'fin_unbilled_wip': {
        const wipMattersCount = allMatterFins.filter((m) => m.unbilled_wip > 0).length;
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Unbilled WIP (firm)</span>
              {firmWipTotal > 0 ? <StatusPill label="Ready to bill" tone="warning" /> : null}
            </div>
            <div className="kpi-value">{formatGbp(firmWipTotal)}</div>
            <div className="kpi-sub">
              Across {wipMattersCount} open matter{wipMattersCount === 1 ? '' : 's'}
            </div>
          </div>
        );
      }
      case 'fin_unbilled_disb':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Unbilled disbursements</span>
              <span className="mono-code">PMS</span>
            </div>
            <div className="kpi-value">{formatGbp(firmUnbilledDisbNet)}</div>
            <div className="kpi-sub">
              {unbilledDisbsList.length} item{unbilledDisbsList.length === 1 ? '' : 's'}
            </div>
          </div>
        );
      case 'fin_client_account':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Client account held</span>
            </div>
            <div className="kpi-value">{formatGbp(firmClientAccountHeld)}</div>
            <div className="kpi-sub">
              {firmClientAccountHeld > 0
                ? 'Held across active matters'
                : 'No client funds currently held'}
            </div>
          </div>
        );

      // 06 Risk & Compliance
      case 'rc_aml_pending':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>AML / ID checks pending</span>
            </div>
            <div className="kpi-value">–</div>
            <div className="kpi-sub">No pending AML or ID checks</div>
          </div>
        );
      case 'rc_conflicts_pending': {
        const referredCount = matters.filter(
          (m) => m.conflictCheckRecord?.status === 'Referred',
        ).length;
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Conflict checks awaiting sign-off</span>
              {referredCount > 0 ? (
                <StatusPill label={`${referredCount} referred`} tone="warning" />
              ) : null}
            </div>
            <div className="kpi-value">{referredCount}</div>
            <div className="kpi-sub">
              {referredCount === 0
                ? 'No conflict checks awaiting sign-off'
                : `${referredCount} referred for review`}
            </div>
          </div>
        );
      }
      case 'rc_high_risk_matters': {
        const highRiskCount = matters.filter(
          (m) =>
            m.matterStatusId !== 'matter_status.closed' &&
            m.riskRatingId?.toLowerCase().includes('high'),
        ).length;
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>High-risk open matters</span>
            </div>
            <div className="kpi-value">{highRiskCount}</div>
            <div className="kpi-sub">
              {highRiskCount} high-risk open matter{highRiskCount === 1 ? '' : 's'}
            </div>
          </div>
        );
      }
      case 'rc_overdue_tasks': {
        const overdueComplianceCount = tasks.filter(
          (t) => isTaskOpen(t) && t.dueAt.slice(0, 10) < todayIso,
        ).length;
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Overdue compliance tasks</span>
            </div>
            <div className="kpi-value">{overdueComplianceCount}</div>
            <div className="kpi-sub">{overdueComplianceCount} overdue</div>
          </div>
        );
      }
      case 'rc_sra_breaches':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Open SRA breaches / complaints</span>
            </div>
            <div className="kpi-value">–</div>
            <div className="kpi-sub">Not yet available</div>
          </div>
        );

      // 07 Managing Partner / Admin
      case 'mp_fees_ytd': {
        const currentMonthFeesVal =
          pmsMonthlyFeesBilled.months.find((m) => m.monthKey === currentMonthKey)?.feesNet ?? 0;
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Fees billed YTD ({currentYearLabel})</span>
              <span className="mono-code">PMS</span>
            </div>
            <div className="kpi-value">{formatGbp(pmsMonthlyFeesBilled.yearToDateTotal)}</div>
            <div className="kpi-sub">
              {formatGbp(currentMonthFeesVal)} billed in {currentMonthShort} · net of credit notes
            </div>
          </div>
        );
      }
      case 'mp_cash_month':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Cash received ({currentMonthShort})</span>
            </div>
            <div className="kpi-value">{formatGbp(pmsCashReceived.currentMonthTotal)}</div>
            <div className="kpi-sub">
              {pmsCashReceived.currentMonthReceiptCount} receipt
              {pmsCashReceived.currentMonthReceiptCount === 1 ? '' : 's'} · Prev month{' '}
              {formatGbp(pmsCashReceived.previousMonthTotal)}
            </div>
          </div>
        );
      case 'mp_firm_wip':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Firm unbilled WIP</span>
              <span className="mono-code">PMS</span>
            </div>
            <div className="kpi-value">{formatGbp(firmWipTotal)}</div>
            <div className="kpi-sub">+ {formatGbp(firmUnbilledDisbNet)} unbilled disbursements</div>
          </div>
        );
      case 'mp_total_debt':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Total client debt</span>
              {firmOverdueDebt > 0 ? (
                <StatusPill label={`${formatGbp(firmOverdueDebt)} overdue`} tone="warning" />
              ) : null}
            </div>
            <div className="kpi-value">{formatGbp(firmTotalDebt)}</div>
            <div className="kpi-sub">
              {overdueBillsCount} overdue bill{overdueBillsCount === 1 ? '' : 's'}
            </div>
          </div>
        );
      case 'mp_open_matters':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Open matters &amp; conversion</span>
            </div>
            <div className="kpi-value">{openMattersCount} open</div>
            <div className="kpi-sub">
              {convertedEnqsCount} of {enquiries.length} enquiries converted
            </div>
          </div>
        );
      default:
        return null;
    }
  }

  // Helper to render Task widgets in Card A (primary column) or Card B (summary column)
  function renderTaskWidgetCard(
    panelId: PanelId,
    heading: string,
    taskItems: Task[],
    column: 'primary' | 'summary',
  ) {
    const displayTasks = taskItems.slice(0, 6);
    const overdueTasks = displayTasks.filter((t) => t.dueAt.slice(0, 10) < todayIso);
    const dueTodayTasks = displayTasks.filter((t) => t.dueAt.slice(0, 10) === todayIso);
    const upcomingTasks = displayTasks.filter((t) => t.dueAt.slice(0, 10) > todayIso);
    const totalOverdueCount = taskItems.filter((t) => t.dueAt.slice(0, 10) < todayIso).length;

    const getTaskTypeIcon = (taskTypeId: string, size = 13) => {
      const key = (taskTypeId || '').toLowerCase();
      if (key.includes('call') || key.includes('follow')) {
        return <Phone size={size} className="tw-task-type-icon" aria-hidden="true" />;
      }
      if (
        key.includes('conflict') ||
        key.includes('aml') ||
        key.includes('review') ||
        key.includes('opening')
      ) {
        return <Search size={size} className="tw-task-type-icon" aria-hidden="true" />;
      }
      return <FileText size={size} className="tw-task-type-icon" aria-hidden="true" />;
    };

    const isHighOrUrgent = (t: Task) => {
      const p = (t.priorityId || '').toLowerCase();
      return p.includes('high') || p.includes('urgent');
    };

    const getTaskRecordRef = (t: Task): { label: string; href: string | null } => {
      const linkedMatter = t.linkedRecords.find((r) => r.recordType === 'matter');
      if (linkedMatter) {
        const mRec = matterById.get(linkedMatter.recordId);
        return {
          label: mRec ? mRec.matterNumber : linkedMatter.recordId,
          href: `/matters/${mRec ? mRec.id : linkedMatter.recordId}`,
        };
      }
      const linkedEnq = t.linkedRecords.find((r) => r.recordType === 'enquiry');
      if (linkedEnq) {
        const eRec = enquiryById.get(linkedEnq.recordId);
        return {
          label: eRec ? eRec.reference : linkedEnq.recordId,
          href: `/enquiries/${linkedEnq.recordId}`,
        };
      }
      const linkedOrg = t.linkedRecords.find((r) => r.recordType === 'organisation');
      if (linkedOrg) {
        const oRec = orgById.get(linkedOrg.recordId);
        return {
          label: oRec ? oRec.legalName : linkedOrg.recordId,
          href: `/organisations/${linkedOrg.recordId}`,
        };
      }
      const linkedPerson = t.linkedRecords.find((r) => r.recordType === 'person');
      if (linkedPerson) {
        const pRec = personById.get(linkedPerson.recordId);
        return {
          label: pRec ? personDisplayName(pRec) : linkedPerson.recordId,
          href: `/people/${linkedPerson.recordId}`,
        };
      }
      return { label: t.reference, href: null };
    };

    if (column === 'summary') {
      // Card B: One-line checklist (Secondary / Summary column)
      return (
        <section
          key={panelId}
          className="home-panel task-card task-card--b"
          data-panel-id={panelId}
          data-panel-variant="one-line-checklist"
        >
          <div className="task-card__header task-card__header--bordered">
            <div className="task-card__title-group">
              <h2 className="tw-heading">{heading}</h2>
              {totalOverdueCount > 0 ? (
                <span className="task-card__overdue-pill">{totalOverdueCount} overdue</span>
              ) : (
                <span className="task-card__count-pill">{taskItems.length}</span>
              )}
            </div>
            <div className="task-card__actions">
              <Link href="/tasks" className="task-card__view-all">
                View all
              </Link>
              <Link
                href="/tasks/new"
                className="task-card__add-btn"
                aria-label="Add task"
                title="Add task"
              >
                <Plus size={16} strokeWidth={2} aria-hidden="true" />
              </Link>
            </div>
          </div>

          {displayTasks.length === 0 ? (
            <div className="muted" style={{ padding: '14px 0 4px', fontSize: 13 }}>
              No open tasks assigned to you today.
            </div>
          ) : (
            <ul className="task-checklist">
              {displayTasks.map((t) => (
                <li key={t.id} className="task-checklist__row">
                  <button
                    type="button"
                    className="task-checklist__circle"
                    aria-label={`Complete task: ${t.title}`}
                    title="Complete task"
                    onClick={() => handleCompleteTask(t)}
                  />
                  <Link href={`/tasks/${t.id}`} className="task-checklist__title">
                    {t.title}
                  </Link>
                  <div className="task-checklist__icons">
                    {isHighOrUrgent(t) ? (
                      <Flag size={14} className="task-flag-icon" aria-label="High priority" />
                    ) : null}
                    {getTaskTypeIcon(t.taskTypeId, 14)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      );
    }

    // Card A: Compact list (Primary column)
    const groups: { key: string; label: string; tone: 'overdue' | 'today' | 'upcoming'; items: Task[] }[] = (
      [
        { key: 'overdue', label: 'OVERDUE', tone: 'overdue' as const, items: overdueTasks },
        { key: 'today', label: 'DUE TODAY', tone: 'today' as const, items: dueTodayTasks },
        { key: 'upcoming', label: 'UPCOMING', tone: 'upcoming' as const, items: upcomingTasks },
      ]
    ).filter((g) => g.items.length > 0);

    return (
      <section
        key={panelId}
        className="home-panel task-card task-card--a"
        data-panel-id={panelId}
        data-panel-variant="compact-list"
      >
        <div className="task-card__header">
          <div className="task-card__title-group">
            <h2 className="tw-heading">{heading}</h2>
            <span className="task-card__count-pill">{taskItems.length}</span>
          </div>
          <div className="task-card__actions">
            <Link href="/tasks" className="task-card__view-all">
              View all
            </Link>
            <Link
              href="/tasks/new"
              className="task-card__add-btn"
              aria-label="Add task"
              title="Add task"
            >
              <Plus size={16} strokeWidth={2} aria-hidden="true" />
            </Link>
          </div>
        </div>

        {groups.length === 0 ? (
          <div className="muted" style={{ padding: '14px 0 4px', fontSize: 13 }}>
            No open tasks assigned to you today.
          </div>
        ) : (
          <div className="task-groups">
            {groups.map((group) => (
              <div key={group.key} className="task-group">
                <div className={`task-group__heading task-group__heading--${group.tone}`}>
                  {group.label}
                </div>
                <ul className="task-compact-list">
                  {group.items.map((t) => {
                    const typeLabel = resolveLabel(values, t.taskTypeId) || 'Task';
                    const recRef = getTaskRecordRef(t);
                    return (
                      <li key={t.id} className="task-compact-row">
                        <div className="task-compact-row__flag">
                          {isHighOrUrgent(t) ? (
                            <Flag size={14} className="task-flag-icon" aria-label="High priority" />
                          ) : null}
                        </div>
                        <div className="task-compact-row__main">
                          <Link href={`/tasks/${t.id}`} className="task-compact-row__title">
                            {t.title}
                          </Link>
                          <div className="task-compact-row__meta">
                            {getTaskTypeIcon(t.taskTypeId, 13)}
                            <span>{typeLabel}</span>
                            {recRef.label ? (
                              <>
                                <span>·</span>
                                {recRef.href ? (
                                  <Link href={recRef.href} className="task-compact-row__ref">
                                    {recRef.label}
                                  </Link>
                                ) : (
                                  <span>{recRef.label}</span>
                                )}
                              </>
                            ) : null}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="task-compact-row__check-btn"
                          aria-label={`Complete task: ${t.title}`}
                          title="Complete task"
                          onClick={() => handleCompleteTask(t)}
                        >
                          <Check size={18} strokeWidth={2.5} aria-hidden="true" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  }

  // Helper to render the combined "To Do" widget (Tasks + Key dates organised by Overdue, Due today, Due tomorrow)
  function renderToDoWidgetCard(panelId: PanelId, column: 'primary' | 'summary') {
    interface ToDoUnifiedItem {
      id: string;
      kind: 'task' | 'key_date';
      title: string;
      dueDateIso: string;
      isHighOrUrgent: boolean;
      typeLabel: string;
      taskTypeId?: string;
      recordLabel: string | null;
      recordHref: string | null;
      href: string;
      task?: Task;
    }

    const getTaskTypeIcon = (taskTypeId: string, size = 13) => {
      const key = (taskTypeId || '').toLowerCase();
      if (key.includes('call') || key.includes('follow')) {
        return <Phone size={size} className="tw-task-type-icon" aria-hidden="true" />;
      }
      if (
        key.includes('conflict') ||
        key.includes('aml') ||
        key.includes('review') ||
        key.includes('opening')
      ) {
        return <Search size={size} className="tw-task-type-icon" aria-hidden="true" />;
      }
      return <FileText size={size} className="tw-task-type-icon" aria-hidden="true" />;
    };

    const isHighOrUrgentTask = (t: Task) => {
      const p = (t.priorityId || '').toLowerCase();
      return p.includes('high') || p.includes('urgent');
    };

    const getTaskRecordRef = (t: Task): { label: string; href: string | null } => {
      const linkedMatter = t.linkedRecords.find((r) => r.recordType === 'matter');
      if (linkedMatter) {
        const mRec = matterById.get(linkedMatter.recordId);
        return {
          label: mRec ? mRec.matterNumber : linkedMatter.recordId,
          href: `/matters/${mRec ? mRec.id : linkedMatter.recordId}`,
        };
      }
      const linkedEnq = t.linkedRecords.find((r) => r.recordType === 'enquiry');
      if (linkedEnq) {
        const eRec = enquiryById.get(linkedEnq.recordId);
        return {
          label: eRec ? eRec.reference : linkedEnq.recordId,
          href: `/enquiries/${linkedEnq.recordId}`,
        };
      }
      const linkedOrg = t.linkedRecords.find((r) => r.recordType === 'organisation');
      if (linkedOrg) {
        const oRec = orgById.get(linkedOrg.recordId);
        return {
          label: oRec ? oRec.legalName : linkedOrg.recordId,
          href: `/organisations/${linkedOrg.recordId}`,
        };
      }
      const linkedPerson = t.linkedRecords.find((r) => r.recordType === 'person');
      if (linkedPerson) {
        const pRec = personById.get(linkedPerson.recordId);
        return {
          label: pRec ? personDisplayName(pRec) : linkedPerson.recordId,
          href: `/people/${linkedPerson.recordId}`,
        };
      }
      return { label: t.reference, href: null };
    };

    // 1. Collect relevant open tasks due <= tomorrow
    const candidateTasks =
      activeRoleKey === 'legal_secretary'
        ? tasks.filter(
            (t) =>
              isTaskOpen(t) &&
              (t.assignedPersonId === effectiveWorkPerson.id ||
                t.assignedPersonId === currentUser.id ||
                (t.assignedPersonId && supportedFeeEarnerIds.includes(t.assignedPersonId)) ||
                (t.assignedTeamId !== null && myTeamIds.has(t.assignedTeamId))),
          )
        : selectHomeCandidateTasks({
            tasks,
            currentUserId: currentUser.id,
            effectiveWorkPersonId: effectiveWorkPerson.id,
            myTeamIds,
          });

    const unifiedItems: ToDoUnifiedItem[] = [];

    for (const t of candidateTasks) {
      const dueDateIso = t.dueAt.slice(0, 10);
      if (dueDateIso > tomorrowIso) continue;
      const recRef = getTaskRecordRef(t);
      unifiedItems.push({
        id: `task-${t.id}`,
        kind: 'task',
        title: t.title,
        dueDateIso,
        isHighOrUrgent: isHighOrUrgentTask(t),
        typeLabel: resolveLabel(values, t.taskTypeId) || 'Task',
        taskTypeId: t.taskTypeId,
        recordLabel: recRef.label,
        recordHref: recRef.href,
        href: `/tasks/${t.id}`,
        task: t,
      });
    }

    // 2. Collect relevant key dates from Matters (critical dates & target completions) due <= tomorrow
    const relevantPersonIds = new Set<string>([
      effectiveWorkPerson.id,
      currentUser.id,
      ...(activeRoleKey === 'legal_secretary' ? supportedFeeEarnerIds : []),
    ]);

    const openMatters = matters.filter((m) => m.matterStatusId !== 'matter_status.closed');
    const personalMatters = openMatters.filter(
      (m) =>
        (m.leadFeeEarnerId && relevantPersonIds.has(m.leadFeeEarnerId)) ||
        (m.responsiblePartnerId && relevantPersonIds.has(m.responsiblePartnerId)) ||
        (m.supervisingPartnerId && relevantPersonIds.has(m.supervisingPartnerId)) ||
        (m.relationshipPartnerId && relevantPersonIds.has(m.relationshipPartnerId)) ||
        m.teamMemberIds.some((id) => relevantPersonIds.has(id)),
    );
    const scopedMatters = personalMatters.length > 0 ? personalMatters : openMatters;

    for (const m of scopedMatters) {
      const subcatLabel = resolveLabel(values, m.workTypeSubcategoryId);
      const critDates = extractCriticalDates(m, subcatLabel);
      for (const cd of critDates) {
        const dueDateIso = cd.date.slice(0, 10);
        if (dueDateIso > tomorrowIso) continue;
        unifiedItems.push({
          id: `kd-matter-${m.id}-${cd.fieldId}`,
          kind: 'key_date',
          title: `${cd.label} — ${m.title}`,
          dueDateIso,
          isHighOrUrgent: dueDateIso <= todayIso,
          typeLabel: 'Key date',
          recordLabel: m.matterNumber,
          recordHref: `/matters/${m.id}`,
          href: `/matters/${m.id}`,
        });
      }
    }

    // 3. Collect relevant key dates from open Enquiries due <= tomorrow
    const openEnqsWithKeyDate = enquiries.filter((e) => isEnquiryOpen(e) && Boolean(e.keyDate));
    const personalEnqs = openEnqsWithKeyDate.filter(
      (e) =>
        (e.assignedToId && relevantPersonIds.has(e.assignedToId)) ||
        (e.assignedTeamId && myTeamIds.has(e.assignedTeamId)),
    );
    const scopedEnqs = personalEnqs.length > 0 ? personalEnqs : openEnqsWithKeyDate;

    for (const e of scopedEnqs) {
      if (!e.keyDate) continue;
      const dueDateIso = e.keyDate.slice(0, 10);
      if (dueDateIso > tomorrowIso) continue;
      const urg = (e.urgencyId || '').toLowerCase();
      unifiedItems.push({
        id: `kd-enq-${e.id}`,
        kind: 'key_date',
        title: `${e.keyDateLabel || 'Key date'} — ${enquiryDisplayName(e)}`,
        dueDateIso,
        isHighOrUrgent: dueDateIso <= todayIso || urg.includes('emergency') || urg.includes('urgent'),
        typeLabel: 'Key date',
        recordLabel: e.reference,
        recordHref: `/enquiries/${e.id}`,
        href: `/enquiries/${e.id}`,
      });
    }

    // Sort items within each bucket: high/urgent first, then key dates and tasks by due date & title
    const sortItems = (list: ToDoUnifiedItem[]) =>
      [...list].sort((a, b) => {
        if (a.dueDateIso !== b.dueDateIso) return a.dueDateIso.localeCompare(b.dueDateIso);
        if (a.isHighOrUrgent !== b.isHighOrUrgent) return a.isHighOrUrgent ? -1 : 1;
        return a.title.localeCompare(b.title);
      });

    const overdueItems = sortItems(unifiedItems.filter((item) => item.dueDateIso < todayIso));
    const dueTodayItems = sortItems(unifiedItems.filter((item) => item.dueDateIso === todayIso));
    const dueTomorrowItems = sortItems(
      unifiedItems.filter((item) => item.dueDateIso === tomorrowIso),
    );

    const groups: {
      key: string;
      label: string;
      tone: 'overdue' | 'today' | 'tomorrow';
      items: ToDoUnifiedItem[];
    }[] = (
      [
        { key: 'overdue', label: 'OVERDUE', tone: 'overdue' as const, items: overdueItems },
        { key: 'today', label: 'DUE TODAY', tone: 'today' as const, items: dueTodayItems },
        { key: 'tomorrow', label: 'DUE TOMORROW', tone: 'tomorrow' as const, items: dueTomorrowItems },
      ]
    ).filter((g) => g.items.length > 0);

    return (
      <section
        key={panelId}
        className={`home-panel task-card ${column === 'summary' ? 'task-card--b' : 'task-card--a'}`}
        data-panel-id={panelId}
        data-panel-variant="compact-list"
      >
        <div className="task-card__header">
          <div className="task-card__title-group">
            <h2 className="tw-heading">To Do</h2>
            <span className="task-card__count-pill">{unifiedItems.length}</span>
            {overdueItems.length > 0 ? (
              <span className="task-card__overdue-pill">{overdueItems.length} overdue</span>
            ) : null}
          </div>
          <div className="task-card__actions">
            <Link href="/tasks" className="task-card__view-all">
              View all
            </Link>
            <Link
              href="/tasks/new"
              className="task-card__add-btn"
              aria-label="Add task"
              title="Add task"
            >
              <Plus size={16} strokeWidth={2} aria-hidden="true" />
            </Link>
          </div>
        </div>

        {groups.length === 0 ? (
          <div className="muted" style={{ padding: '14px 0 4px', fontSize: 13 }}>
            No tasks or key dates overdue, due today, or due tomorrow.
          </div>
        ) : (
          <div className="task-groups">
            {groups.map((group) => (
              <div key={group.key} className="task-group">
                <div className={`task-group__heading task-group__heading--${group.tone}`}>
                  {group.label}
                </div>
                <ul className="task-compact-list">
                  {group.items.map((item) => (
                    <li
                      key={item.id}
                      className={`task-compact-row ${item.kind === 'key_date' ? 'task-compact-row--keydate' : ''}`}
                    >
                      <div className="task-compact-row__flag">
                        {item.isHighOrUrgent ? (
                          <Flag size={14} className="task-flag-icon" aria-label="High priority" />
                        ) : null}
                      </div>
                      <div className="task-compact-row__main">
                        <Link href={item.href} className="task-compact-row__title">
                          {item.title}
                        </Link>
                        <div className="task-compact-row__meta">
                          {item.kind === 'key_date' ? (
                            <>
                              <Calendar
                                size={13}
                                className="tw-task-type-icon tw-task-type-icon--keydate"
                                aria-hidden="true"
                              />
                              <span className="todo-keydate-tag">{item.typeLabel}</span>
                            </>
                          ) : (
                            <>
                              {getTaskTypeIcon(item.taskTypeId || '', 13)}
                              <span>{item.typeLabel}</span>
                            </>
                          )}
                          {item.recordLabel ? (
                            <>
                              <span>·</span>
                              {item.recordHref ? (
                                <Link href={item.recordHref} className="task-compact-row__ref">
                                  {item.recordLabel}
                                </Link>
                              ) : (
                                <span>{item.recordLabel}</span>
                              )}
                            </>
                          ) : null}
                        </div>
                      </div>
                      {item.kind === 'task' && item.task ? (
                        <button
                          type="button"
                          className="task-compact-row__check-btn"
                          aria-label={`Complete task: ${item.title}`}
                          title="Complete task"
                          onClick={() => handleCompleteTask(item.task!)}
                        >
                          <Check size={18} strokeWidth={2.5} aria-hidden="true" />
                        </button>
                      ) : (
                        <Link
                          href={item.href}
                          className="task-compact-row__keydate-badge"
                          aria-label={`Key date: ${item.title}`}
                          title="Key date — view record"
                        >
                          <Calendar size={17} strokeWidth={2.1} aria-hidden="true" />
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  }

  // ------------------------------------------------------------------ Panel Renderers
  function renderPanel(panelId: PanelId, column: 'primary' | 'summary' = 'primary') {
    switch (panelId) {
      // ================================================================
      // 0. to_do (Combined Tasks & Key Dates: Overdue, Due today, Due tomorrow)
      // ================================================================
      case 'to_do': {
        return renderToDoWidgetCard(panelId, column);
      }

      // ================================================================
      // 1. my_tasks_today
      // ================================================================
      case 'my_tasks_today': {
        return renderTaskWidgetCard(panelId, 'My tasks', myOpenTasks, column);
      }

      // ================================================================
      // 2. my_enquiries_awaiting_contact
      // ================================================================
      case 'my_enquiries_awaiting_contact': {
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">My enquiries awaiting first contact</h2>
                <span className="panel-subtitle">1Squared Enquiries · SLA countdown</span>
              </div>
              <div className="panel-actions">
                <Link href="/enquiries" className="panel-link">
                  Open Enquiries →
                </Link>
              </div>
            </div>
            <div className="panel-body">
              {myOpenEnquiries.length === 0 ? (
                <div className="panel-body padded muted">
                  No open enquiries currently awaiting your contact.
                </div>
              ) : (
                <ul className="worklist">
                  {myOpenEnquiries.map((e) => {
                    const urgLabel = resolveLabel(values, e.urgencyId) || 'Standard';
                    const paLabel = resolveLabel(values, e.practiceAreaId) || 'General';
                    return (
                      <li key={e.id} className="worklist-row">
                        <div className="worklist-main">
                          <div className="worklist-title">
                            <StatusPill
                              label={
                                e.status === 'In contact'
                                  ? 'In contact · Ready to convert'
                                  : `${urgLabel} · Due ${e.bestTimeToCall || '17:30 today'}`
                              }
                              tone={
                                e.status === 'In contact'
                                  ? 'positive'
                                  : urgLabel === 'Emergency'
                                    ? 'alert'
                                    : 'warning'
                              }
                            />
                            <Link href={`/enquiries/${e.id}`}>
                              {enquiryDisplayName(e)} — {e.summary}
                            </Link>
                          </div>
                          <div className="worklist-meta">
                            <span className="mono-code">{e.reference}</span>
                            <span>· {paLabel}</span>
                            {e.phone ? <span>· {e.phone}</span> : null}
                            {e.bestTimeToCall ? <span>· Best time: {e.bestTimeToCall}</span> : null}
                          </div>
                        </div>
                        <div className="worklist-right">
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            onClick={() => {
                              setLogModalEnq(e);
                              setLogNote('');
                            }}
                          >
                            Log contact
                          </button>
                          <button
                            type="button"
                            className="btn btn--primary btn--sm"
                            onClick={() => handleConvertEnquiry(e)}
                          >
                            Convert to matter
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        );
      }

      // ================================================================
      // 3. my_active_matters
      // ================================================================
      case 'my_active_matters': {
        // Show the fee earner's active PMS-backed matters (or 1Squared active matters)
        const feCode =
          myWeeklyTime?.feeEarnerId ??
          effectiveWorkPerson.employment?.feeEarner?.timekeeperCode ??
          null;
        const myActiveMatterCodes = new Set(myActiveMatters.map((m) => m.matterNumber));
        const myActiveMatterIds = new Set(myActiveMatters.map((m) => m.id));
        const rows = allMatterFins.filter((m) => {
          if (m.status !== 'Open') return false;
          if (feCode && m.fee_earner_id === feCode) return true;
          if (myActiveMatterCodes.has(m.matter_code)) return true;
          const linkedId = findOneSquaredIdForPmsCode(pmsLinks, 'matter', m.matter_code);
          return linkedId !== null && myActiveMatterIds.has(linkedId);
        });
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">My active matters — at a glance</h2>
                <span className="panel-subtitle">
                  1Squared Matters + PMS financials · as at {formattedAsAt}
                </span>
              </div>
              <div className="panel-actions">
                <Link href="/matters" className="panel-link">
                  All matters →
                </Link>
              </div>
            </div>
            <div className="panel-body" style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Matter</th>
                    <th>Client &amp; stage</th>
                    <th>Basis / Estimate</th>
                    <th className="num">Unbilled WIP</th>
                    <th className="num">Client debt</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && myActiveMatters.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '20px 12px' }}>
                        No active matters currently recorded.
                      </td>
                    </tr>
                  ) : rows.length > 0 ? (
                    rows.map((m) => {
                      const href = matterHrefForCode(m.matter_code);
                      const pct = m.estimate_used_pct ? Math.round(m.estimate_used_pct * 100) : null;
                      const barClass =
                        pct && pct >= 100 ? 'coral' : pct && pct >= 75 ? 'amber' : '';
                      return (
                        <tr key={m.matter_code}>
                          <td>
                            <div style={{ fontWeight: 600 }}>
                              <Link href={href}>{m.matter_code}</Link>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                              {m.matter_description}
                            </div>
                          </td>
                          <td>
                            <div>{m.client_name}</div>
                            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                              {m.practice_area} · {m.work_type}
                            </div>
                          </td>
                          <td style={{ minWidth: 165 }}>
                            {m.billing_basis === 'Fixed Fee' ? (
                              <>
                                <div style={{ fontSize: 12 }}>
                                  Fixed fee <strong>{formatGbp(m.fixed_fee_amount)}</strong>
                                </div>
                                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                  Time recorded {formatGbp(m.time_value_recorded)}
                                </div>
                              </>
                            ) : (
                              <>
                                <div
                                  style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    fontSize: 11.5,
                                    marginBottom: 4,
                                  }}
                                >
                                  <span>
                                    {formatGbp(m.time_value_recorded)} of {formatGbp(m.fee_estimate)}
                                  </span>
                                  {pct !== null ? <strong>{pct}%</strong> : null}
                                </div>
                                <div className="progress-track">
                                  <div
                                    className={`progress-fill ${barClass}`}
                                    style={{ width: `${Math.min(pct ?? 0, 100)}%` }}
                                  />
                                </div>
                              </>
                            )}
                          </td>
                          <td className="num">
                            <strong>{formatGbp(m.unbilled_wip)}</strong>
                          </td>
                          <td className="num">
                            {m.outstanding_debt > 0 ? (
                              <span
                                style={{
                                  fontWeight: 600,
                                  color:
                                    (m.max_invoice_days_past_due ?? 0) > 0
                                      ? 'var(--coral-text)'
                                      : 'var(--text-primary)',
                                }}
                              >
                                {formatGbp(m.outstanding_debt)}
                              </span>
                            ) : (
                              <span className="muted">£0.00</span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    myActiveMatters.map((m) => {
                      const clientOrg = orgById.get(m.clientId);
                      const clientPer = personById.get(m.clientId);
                      const clientName = clientOrg
                        ? clientOrg.legalName
                        : clientPer
                          ? personDisplayName(clientPer)
                          : m.clientId;
                      return (
                        <tr key={m.id}>
                          <td>
                            <div style={{ fontWeight: 600 }}>
                              <Link href={`/matters/${m.id}`}>{m.matterNumber}</Link>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                              {m.title}
                            </div>
                          </td>
                          <td>
                            <div>{clientName}</div>
                            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                              {resolveLabel(values, m.practiceAreaId)}
                            </div>
                          </td>
                          <td>
                            {m.feeEstimateGbp !== null
                              ? formatGbp(m.feeEstimateGbp)
                              : '–'}
                          </td>
                          <td className="num muted">–</td>
                          <td className="num muted">–</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>
        );
      }

      // ================================================================
      // 4. my_time_and_wip (READ-ONLY — strictly no timers)
      // ================================================================
      case 'my_time_and_wip': {
        const wt = myWeeklyTime;
        const fePerf = myFeeEarnerFigures;
        const dailyPace = wt?.dailyPaceHours ?? 5.2;
        const weeklyPace = wt?.weeklyPaceHours ?? 26;
        const weekTotal = wt?.weekTotalHours ?? 0;
        const ytdHours = fePerf?.chargeable_hours ?? 0;
        const targetHours = fePerf?.annual_target_hours ?? null;
        const billedValue = fePerf?.billed_value ?? 0;
        const myWip = wt?.myUnbilledWip ?? fePerf?.unbilled_wip ?? 0;
        const readyToBill = 0;
        const weekdays =
          wt?.weekdays ?? [
            { dayLabel: 'Mon', date: 'mon', hours: 0 },
            { dayLabel: 'Tue', date: 'tue', hours: 0 },
            { dayLabel: 'Wed', date: 'wed', hours: 0 },
            { dayLabel: 'Thu', date: 'thu', hours: 0 },
            { dayLabel: 'Fri', date: 'fri', hours: 0 },
          ];

        const weekPct = Math.min(Math.max((weekTotal / weeklyPace) * 100, 0), 100);
        const wipK = `£${(myWip / 1000).toFixed(1)}k`;
        const readyK = `£${(readyToBill / 1000).toFixed(1)}k`;
        const billedK = `£${(billedValue / 1000).toFixed(1)}k`;
        const billedFormatted = `£${Math.round(billedValue).toLocaleString('en-GB')}`;
        const readyWipPct = myWip > 0 ? Math.min(Math.max((readyToBill / myWip) * 100, 6), 100) : 0;
        const ytdTargetRatio =
          targetHours !== null && targetHours > 0 && ytdHours > 0
            ? Math.min(Math.max(ytdHours / targetHours, 0.06), 1)
            : 0;

        const renderRing = (size: number, stroke: number, ratio: number, color: string) => {
          const r = (size - stroke) / 2;
          const c = 2 * Math.PI * r;
          const clamped = Math.min(Math.max(ratio, 0), 1);
          const offset = c * (1 - clamped);
          return (
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
              <circle
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke="var(--tw-track, #e8ecef)"
                strokeWidth={stroke}
              />
              {clamped > 0 ? (
                <circle
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  fill="none"
                  stroke={color}
                  strokeWidth={stroke}
                  strokeLinecap="round"
                  strokeDasharray={c}
                  strokeDashoffset={offset}
                  transform={`rotate(-90 ${size / 2} ${size / 2})`}
                />
              ) : null}
            </svg>
          );
        };

        if (column === 'summary') {
          // Card B — Compact strip with heading (Secondary / Summary column)
          return (
            <section
              key={panelId}
              className="home-panel tw-card-b"
              data-panel-id={panelId}
              data-panel-variant="compact-strip"
            >
              <h2 className="tw-heading">My time &amp; WIP</h2>
              <div className="tw-card-b__strip">
                <div className="tw-card-b__left">
                  <div className="tw-ring-large">
                    {renderRing(64, 5.5, weekTotal / weeklyPace, '#45645a')}
                    <div className="tw-ring-large__label">
                      <span className="tw-ring-large__hrs">{weekTotal.toFixed(1)}h</span>
                      <span className="tw-ring-large__sub">of {weeklyPace}h</span>
                    </div>
                  </div>

                  <div className="tw-week-chart tw-week-chart--compact">
                    <div className="tw-week-chart__plot">
                      {weekdays.map((d) => {
                        const barPct = Math.min(Math.max((d.hours / dailyPace) * 100, 6), 100);
                        return (
                          <div
                            key={d.date}
                            className="tw-week-chart__bar"
                            style={{ height: `${barPct}%` }}
                            title={`${d.dayLabel}: ${d.hours.toFixed(1)}h`}
                          />
                        );
                      })}
                    </div>
                    <div className="tw-week-chart__days">
                      {weekdays.map((d) => (
                        <span key={d.date}>{d.dayLabel.slice(0, 1)}</span>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="tw-card-b__divider" aria-hidden="true" />

                <div className="tw-card-b__right">
                  <div className="tw-card-b__wip-head">
                    <div>
                      <span className="tw-card-b__wip-val">{wipK}</span>
                      <span className="tw-card-b__wip-lbl">WIP</span>
                    </div>
                    <span className="tw-card-b__billed">{billedK} billed</span>
                  </div>
                  <div className="tw-bar-track" style={{ margin: '8px 0' }}>
                    <div
                      className="tw-bar-fill"
                      style={{ width: `${readyWipPct}%`, background: '#9e6730' }}
                    />
                  </div>
                  <div className="tw-card-b__legend">
                    <span className="tw-card-b__dot" aria-hidden="true" />
                    <span>{readyK} ready to bill</span>
                  </div>
                </div>
              </div>
            </section>
          );
        }

        // Card A — Full card (Primary column)
        return (
          <section
            key={panelId}
            className="home-panel tw-card-a"
            data-panel-id={panelId}
            data-panel-variant="card"
          >
            <h2 className="tw-heading">My time &amp; WIP</h2>

            <div className="tw-card-a__top">
              <div>
                <div>
                  <span className="tw-card-a__hours-num">{weekTotal.toFixed(1)}h</span>
                  <span className="tw-card-a__hours-pace">/ {weeklyPace}h</span>
                </div>
                <div className="tw-bar-track">
                  <div
                    className="tw-bar-fill"
                    style={{ width: `${weekPct}%`, background: '#45645a' }}
                  />
                </div>
                <div className="tw-card-a__caption">This week</div>
              </div>

              <div className="tw-week-chart">
                <div className="tw-week-chart__plot">
                  {weekdays.map((d) => {
                    const barPct = Math.min(Math.max((d.hours / dailyPace) * 100, 6), 100);
                    return (
                      <div
                        key={d.date}
                        className="tw-week-chart__bar"
                        style={{ height: `${barPct}%` }}
                        title={`${d.dayLabel}: ${d.hours.toFixed(1)}h`}
                      />
                    );
                  })}
                </div>
                <div className="tw-week-chart__days">
                  {weekdays.map((d) => (
                    <span key={d.date}>{d.dayLabel.slice(0, 1)}</span>
                  ))}
                </div>
              </div>
            </div>

            <div className="tw-card-a__bottom">
              <div className="tw-metric">
                {renderRing(44, 5, ytdTargetRatio, '#45645a')}
                <div>
                  <div className="tw-metric__value">{billedFormatted}</div>
                  <div className="tw-metric__sub">Billed YTD</div>
                </div>
              </div>

              <div className="tw-metric">
                {renderRing(44, 5, readyToBill / Math.max(myWip, 1), '#9e6730')}
                <div>
                  <div className="tw-metric__value">{wipK}</div>
                  <div className="tw-metric__sub">WIP · {readyK} ready</div>
                </div>
              </div>
            </div>
          </section>
        );
      }

      // ================================================================
      // 5. key_dates_and_deadlines
      // ================================================================
      case 'key_dates_and_deadlines': {
        const upcomingKeyDates: {
          id: string;
          dateIso: string;
          label: string;
          matterId: string;
          matterNumber: string;
          matterTitle: string;
        }[] = [];
        for (const m of myActiveMatters) {
          const subcatLabel = resolveLabel(values, m.workTypeSubcategoryId);
          const critDates = extractCriticalDates(m, subcatLabel);
          for (const cd of critDates) {
            const dateIso = cd.date.slice(0, 10);
            if (dateIso >= todayIso && dateIso <= next14DaysIso) {
              upcomingKeyDates.push({
                id: `${m.id}-${cd.fieldId}`,
                dateIso,
                label: cd.label,
                matterId: m.id,
                matterNumber: m.matterNumber,
                matterTitle: m.title,
              });
            }
          }
        }
        upcomingKeyDates.sort((a, b) => a.dateIso.localeCompare(b.dateIso));
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Key dates &amp; deadlines (next 14 days)</h2>
              </div>
            </div>
            <div className="panel-body">
              {upcomingKeyDates.length === 0 ? (
                <div className="panel-body padded muted">
                  No key dates or deadlines in the next 14 days.
                </div>
              ) : (
                <ul className="worklist">
                  {upcomingKeyDates.map((kd) => (
                    <li key={kd.id} className="worklist-row">
                      <div className="worklist-main">
                        <div className="worklist-title">
                          <StatusPill label={formatDate(kd.dateIso)} tone="warning" />
                          <Link href={`/matters/${kd.matterId}`}>
                            {kd.label} — {kd.matterTitle}
                          </Link>
                        </div>
                        <div className="worklist-meta">
                          <span className="mono-code">{kd.matterNumber}</span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        );
      }

      // ================================================================
      // 6. waiting_on_client
      // ================================================================
      case 'waiting_on_client': {
        const waitingTasks = tasks.filter(
          (t) =>
            t.status === 'Waiting' &&
            (t.assignedPersonId === effectiveWorkPerson.id || t.assignedPersonId === currentUser.id),
        );
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Waiting on client / third party</h2>
                <StatusPill
                  label={`${waitingTasks.length} item${waitingTasks.length === 1 ? '' : 's'}`}
                  tone="neutral"
                />
              </div>
            </div>
            <div className="panel-body">
              {waitingTasks.length === 0 ? (
                <div className="panel-body padded muted">
                  No items currently waiting on clients or third parties.
                </div>
              ) : (
                <ul className="worklist">
                  {waitingTasks.map((t) => (
                    <li key={t.id} className="worklist-row">
                      <div className="worklist-main">
                        <div className="worklist-title">
                          <Link href={`/tasks/${t.id}`}>{t.title}</Link>
                        </div>
                        <div className="worklist-meta">
                          <span className="mono-code">{t.reference}</span>
                          <span>· Due {formatDate(t.dueAt)}</span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        );
      }

      // ================================================================
      // 7. team_enquiries_and_unassigned_tasks
      // ================================================================
      case 'team_enquiries_and_unassigned_tasks': {
        const unassignedEnqs = enquiries.filter(
          (e) =>
            isEnquiryOpen(e) &&
            !e.assignedToId &&
            (myTeamIds.size === 0 || (e.assignedTeamId && myTeamIds.has(e.assignedTeamId))),
        );
        const unassignedTasks = tasks.filter(
          (t) =>
            isTaskOpen(t) &&
            !t.assignedPersonId &&
            (myTeamIds.size === 0 || (t.assignedTeamId && myTeamIds.has(t.assignedTeamId))),
        );
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Team queue — unassigned enquiries &amp; tasks</h2>
                <StatusPill
                  label={`${unassignedEnqs.length + unassignedTasks.length} unclaimed`}
                  tone="neutral"
                />
              </div>
              <div className="panel-actions">
                <Link href="/tasks" className="panel-link">
                  Team queues →
                </Link>
              </div>
            </div>
            <div className="panel-body">
              {unassignedEnqs.length === 0 && unassignedTasks.length === 0 ? (
                <div className="panel-body padded muted">
                  No unclaimed enquiries or tasks in your team queue.
                </div>
              ) : (
                <ul className="worklist">
                  {unassignedEnqs.map((e) => (
                    <li key={e.id} className="worklist-row">
                      <div className="worklist-main">
                        <div className="worklist-title">
                          <StatusPill label="Unassigned enquiry" tone="warning" />
                          <Link href={`/enquiries/${e.id}`}>
                            {enquiryDisplayName(e)} — {e.summary}
                          </Link>
                        </div>
                        <div className="worklist-meta">
                          <span className="mono-code">{e.reference}</span>
                          <span>
                            · {e.assignedTeamId ? teamById.get(e.assignedTeamId)?.name : 'Intake'}
                          </span>
                        </div>
                      </div>
                      <div className="worklist-right">
                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          onClick={() => handleTakeEnquiry(e)}
                        >
                          Take enquiry
                        </button>
                      </div>
                    </li>
                  ))}
                  {unassignedTasks.map((t) => (
                    <li key={t.id} className="worklist-row">
                      <div className="worklist-main">
                        <div className="worklist-title">
                          <StatusPill label="Unassigned task" tone="neutral" />
                          <Link href={`/tasks/${t.id}`}>{t.title}</Link>
                        </div>
                        <div className="worklist-meta">
                          <span className="mono-code">{t.reference}</span>
                          <span>· Due {formatDate(t.dueAt)}</span>
                        </div>
                      </div>
                      <div className="worklist-right">
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          onClick={() => handleTakeTask(t)}
                        >
                          Take task
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        );
      }

      // ================================================================
      // 8. team_tasks_for_supported_fee_earners (03 Legal Secretary)
      // ================================================================
      case 'team_tasks_for_supported_fee_earners': {
        const secTasks = tasks.filter(
          (t) =>
            isTaskOpen(t) &&
            (t.assignedPersonId === effectiveWorkPerson.id ||
              (t.assignedPersonId && supportedFeeEarnerIds.includes(t.assignedPersonId)) ||
              (t.assignedTeamId !== null && myTeamIds.has(t.assignedTeamId))),
        );
        return renderTaskWidgetCard(panelId, 'Team tasks', secTasks, column);
      }

      // ================================================================
      // 9. documents_and_correspondence_queue (03 Legal Secretary)
      // ================================================================
      case 'documents_and_correspondence_queue': {
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Documents &amp; correspondence queue</h2>
                <span className="panel-subtitle">
                  1Squared Tasks (`Document` / `Admin`) + auto-generated letters
                </span>
              </div>
            </div>
            <div className="panel-body" style={{ overflowX: 'auto' }}>
              <div className="panel-body padded muted">
                No documents or correspondence currently queued.
              </div>
            </div>
          </section>
        );
      }

      // ================================================================
      // 10. matter_openings_in_progress
      // ================================================================
      case 'matter_openings_in_progress': {
        const openingMatters = matters.filter((m) => m.matterStatusId === 'matter_status.opening');
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Matter openings — onboarding checklist</h2>
                <span className="panel-subtitle">
                  Conflict check · AML/CDD · Engagement letter · Retainer
                </span>
              </div>
            </div>
            <div className="panel-body">
              {openingMatters.length === 0 ? (
                <div className="panel-body padded muted">
                  No matter openings currently in progress.
                </div>
              ) : (
                <ul className="worklist">
                  {openingMatters.map((m) => {
                    const conflictDone =
                      m.conflictDecision?.outcome === 'Cleared' ||
                      m.conflictCheckRecord?.status === 'Cleared' ||
                      m.conflictCheckRecord?.status === 'Approved' ||
                      m.conflictCheckStatus === 'Cleared';
                    const amlDone =
                      m.amlStatus === 'Completed' ||
                      m.amlStatus === 'Verified' ||
                      m.amlStatus === 'Cleared';
                    const engDone = m.engagementLetterStatus === 'Signed';
                    const retainerDone =
                      m.retainerMoniesOnAccountGbp !== null && m.retainerMoniesOnAccountGbp > 0;
                    const completedSteps = [conflictDone, amlDone, engDone, retainerDone].filter(
                      Boolean,
                    ).length;
                    const clientOrg = orgById.get(m.clientId);
                    const clientPer = personById.get(m.clientId);
                    const clientLabel = clientOrg
                      ? clientOrg.legalName
                      : clientPer
                        ? personDisplayName(clientPer)
                        : m.clientId;
                    return (
                      <li
                        key={m.id}
                        className="worklist-row"
                        style={{ gridTemplateColumns: '1fr' }}
                      >
                        <div className="worklist-main">
                          <div
                            className="worklist-title"
                            style={{ justifyContent: 'space-between' }}
                          >
                            <span>
                              <span className="mono-code">{m.matterNumber}</span>{' '}
                              <Link href={`/matters/${m.id}`}>
                                <strong>{m.title}</strong>
                              </Link>{' '}
                              — {clientLabel}
                            </span>
                            <StatusPill
                              label={`${completedSteps} of 4 complete`}
                              tone={completedSteps === 4 ? 'positive' : 'warning'}
                            />
                          </div>
                          <div className="onboarding-steps">
                            <div className={`onb-step ${conflictDone ? 'done' : 'warn'}`}>
                              <span>1. Conflict check</span>
                              <span>{conflictDone ? '✓ Cleared' : m.conflictCheckStatus || 'Not recorded'}</span>
                            </div>
                            <div className={`onb-step ${amlDone ? 'done' : 'warn'}`}>
                              <span>2. AML / CDD</span>
                              <span>{amlDone ? '✓ Complete' : m.amlStatus || 'Not recorded'}</span>
                            </div>
                            <div className={`onb-step ${engDone ? 'done' : 'warn'}`}>
                              <span>3. Engagement letter</span>
                              <span>{engDone ? '✓ Signed' : m.engagementLetterStatus || 'Not recorded'}</span>
                            </div>
                            <div className={`onb-step ${retainerDone ? 'done' : 'warn'}`}>
                              <span>4. Retainer on a/c</span>
                              <span>
                                {retainerDone
                                  ? `✓ ${formatGbp(m.retainerMoniesOnAccountGbp!)}`
                                  : 'Not recorded'}
                              </span>
                            </div>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        );
      }

      // ================================================================
      // 11. upcoming_completions_and_filings (03 Legal Secretary)
      // ================================================================
      case 'upcoming_completions_and_filings': {
        const upcomingFilings: {
          id: string;
          dateIso: string;
          label: string;
          matterId: string;
          matterNumber: string;
          matterTitle: string;
        }[] = [];
        const supportedSet = new Set(supportedFeeEarnerIds);
        const targetMatters = matters.filter(
          (m) =>
            m.matterStatusId !== 'matter_status.closed' &&
            (supportedSet.size === 0 ||
              (m.leadFeeEarnerId !== null && supportedSet.has(m.leadFeeEarnerId)) ||
              m.teamMemberIds.some((id) => supportedSet.has(id))),
        );
        for (const m of targetMatters) {
          const subcatLabel = resolveLabel(values, m.workTypeSubcategoryId);
          for (const cd of extractCriticalDates(m, subcatLabel)) {
            const dateIso = cd.date.slice(0, 10);
            if (dateIso >= todayIso && dateIso <= next7DaysIso) {
              upcomingFilings.push({
                id: `${m.id}-${cd.fieldId}`,
                dateIso,
                label: cd.label,
                matterId: m.id,
                matterNumber: m.matterNumber,
                matterTitle: m.title,
              });
            }
          }
        }
        upcomingFilings.sort((a, b) => a.dateIso.localeCompare(b.dateIso));
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Upcoming completions, filings &amp; key dates</h2>
                <span className="panel-subtitle">Supported fee earners</span>
              </div>
            </div>
            <div className="panel-body">
              {upcomingFilings.length === 0 ? (
                <div className="panel-body padded muted">
                  No upcoming completions or filings in the next 7 days.
                </div>
              ) : (
                <ul className="worklist">
                  {upcomingFilings.map((item) => (
                    <li key={item.id} className="worklist-row">
                      <div className="worklist-main">
                        <div className="worklist-title">
                          <StatusPill label={formatDate(item.dateIso)} tone="warning" />
                          <Link href={`/matters/${item.matterId}`}>
                            {item.label} — {item.matterTitle}
                          </Link>
                        </div>
                        <div className="worklist-meta">
                          <span className="mono-code">{item.matterNumber}</span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        );
      }

      // ================================================================
      // 12. disbursements_and_invoices_to_log (03 Legal Secretary)
      // ================================================================
      case 'disbursements_and_invoices_to_log': {
        const supportedSet = new Set(supportedFeeEarnerIds);
        const supportedMatterCodes = new Set(
          matters
            .filter(
              (m) =>
                supportedSet.size === 0 ||
                (m.leadFeeEarnerId !== null && supportedSet.has(m.leadFeeEarnerId)) ||
                m.teamMemberIds.some((id) => supportedSet.has(id)),
            )
            .map((m) => m.matterNumber),
        );
        const teamDisbs = pmsAllDisbursements.filter(
          (d) =>
            d.billed_status === 'Unbilled' &&
            (supportedSet.size === 0 || supportedMatterCodes.has(d.matter_code)),
        );
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Unbilled disbursements on team matters</h2>
                <span className="mono-code">PMS · read-only</span>
              </div>
              <span className="panel-subtitle">As at {formattedAsAt}</span>
            </div>
            <div className="panel-body">
              {teamDisbs.length === 0 ? (
                <div className="empty-state">No unbilled disbursements recorded on team matters.</div>
              ) : (
                <ul className="worklist">
                  {teamDisbs.map((d) => (
                    <li key={d.disbursement_id} className="worklist-row">
                      <div className="worklist-main">
                        <div className="worklist-title">
                          <span>{d.description}</span>
                        </div>
                        <div className="worklist-meta">
                          <Link href={matterHrefForCode(d.matter_code)} className="mono-code">
                            {d.matter_code}
                          </Link>
                          <span>
                            · {d.supplier} · {formatDate(d.date)} · Unbilled
                          </span>
                        </div>
                      </div>
                      <div className="worklist-right">
                        <strong>
                          {formatGbp(d.net_amount)}{' '}
                          {d.vat_amount > 0 ? `+ £${d.vat_amount.toFixed(2)} VAT` : '(no VAT)'}
                        </strong>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        );
      }

      // ================================================================
      // 13. quick_enquiry_capture (04 Enquiries Coordinator)
      // ================================================================
      case 'quick_enquiry_capture': {
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Quick enquiry capture</h2>
                <StatusPill label="Phone / Email / Walk-in" tone="positive" />
              </div>
              <span className="panel-subtitle">
                Take high-level facts only until conflict check clears · auto-routes to practice area team
              </span>
            </div>
            <div className="panel-body padded">
              <form onSubmit={(e) => handleQuickCaptureSubmit(e, false)}>
                <div className="quick-form-grid">
                  <div>
                    <label className="field-label" style={{ fontSize: 11.5 }}>
                      First name *
                    </label>
                    <input
                      className="input"
                      type="text"
                      value={qFirstName}
                      onChange={(e) => setQFirstName(e.target.value)}
                      required
                    />
                  </div>
                  <div>
                    <label className="field-label" style={{ fontSize: 11.5 }}>
                      Last name *
                    </label>
                    <input
                      className="input"
                      type="text"
                      value={qLastName}
                      onChange={(e) => setQLastName(e.target.value)}
                      required
                    />
                  </div>
                  <div>
                    <label className="field-label" style={{ fontSize: 11.5 }}>
                      Calling on behalf of (business / organisation)
                    </label>
                    <input
                      className="input"
                      type="text"
                      value={qOnBehalf}
                      onChange={(e) => setQOnBehalf(e.target.value)}
                      placeholder="Leave blank if individual"
                    />
                  </div>
                  <div>
                    <label className="field-label" style={{ fontSize: 11.5 }}>
                      Phone &amp; email *
                    </label>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                      <input
                        className="input"
                        type="text"
                        value={qPhone}
                        onChange={(e) => setQPhone(e.target.value)}
                        placeholder="Phone"
                      />
                      <input
                        className="input"
                        type="email"
                        value={qEmail}
                        onChange={(e) => setQEmail(e.target.value)}
                        placeholder="Email"
                      />
                    </div>
                  </div>

                  {quickDuplicateHits.personHits.length > 0 ||
                  quickDuplicateHits.orgHits.length > 0 ? (
                    <div
                      className="full"
                      style={{
                        padding: '9px 12px',
                        borderRadius: 6,
                        background: 'var(--amber-bg)',
                        border: '1px solid var(--amber-border)',
                        fontSize: 12,
                        color: 'var(--amber-text)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 10,
                        flexWrap: 'wrap',
                      }}
                    >
                      <span>
                        <strong>Existing contact match found:</strong>{' '}
                        {quickDuplicateHits.personHits[0]
                          ? `${personDisplayName(quickDuplicateHits.personHits[0].record)} (${quickDuplicateHits.personHits[0].record.id})`
                          : quickDuplicateHits.orgHits[0]?.record.legalName}{' '}
                        — link this enquiry to the existing record instead of creating a duplicate.
                      </span>
                      {quickDuplicateHits.personHits[0] ? (
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          onClick={() => {
                            setQLinkExistingId(quickDuplicateHits.personHits[0].record.id);
                            showToast(
                              `Linked to ${personDisplayName(quickDuplicateHits.personHits[0].record)}`,
                            );
                          }}
                        >
                          {qLinkExistingId === quickDuplicateHits.personHits[0].record.id
                            ? '✓ Linked'
                            : `Link to ${quickDuplicateHits.personHits[0].record.id}`}
                        </button>
                      ) : null}
                    </div>
                  ) : null}

                  <div>
                    <label className="field-label" style={{ fontSize: 11.5 }}>
                      Channel *
                    </label>
                    <select
                      className="select"
                      value={qChannelId}
                      onChange={(e) => setQChannelId(e.target.value)}
                    >
                      <option value="enquiry_channel.phone">Phone</option>
                      <option value="enquiry_channel.email">Email</option>
                      <option value="enquiry_channel.web_form">Web form</option>
                      <option value="enquiry_channel.referral">Referral</option>
                      <option value="enquiry_channel.walk_in">Walk-in</option>
                    </select>
                  </div>
                  <div>
                    <label className="field-label" style={{ fontSize: 11.5 }}>
                      Practice area * (routes to team)
                    </label>
                    <select
                      className="select"
                      value={qPracticeAreaId}
                      onChange={(e) => setQPracticeAreaId(e.target.value)}
                    >
                      <option value="work_type.real_estate_and_property">
                        Real Estate &amp; Property → Real Estate team
                      </option>
                      <option value="work_type.corporate_and_commercial">
                        Corporate &amp; Commercial → Corporate team
                      </option>
                      <option value="work_type.dispute_resolution_and_litigation">
                        Dispute Resolution &amp; Litigation → Disputes team
                      </option>
                      <option value="work_type.employment_and_hr">
                        Employment &amp; HR → Employment team
                      </option>
                      <option value="work_type.private_client_trusts_and_family">
                        Private Client, Trusts &amp; Family → Private Client team
                      </option>
                    </select>
                  </div>
                  <div>
                    <label className="field-label" style={{ fontSize: 11.5 }}>
                      Urgency &amp; callback SLA *
                    </label>
                    <select
                      className="select"
                      value={qUrgencyId}
                      onChange={(e) => setQUrgencyId(e.target.value)}
                    >
                      <option value="enquiry_urgency.urgent">
                        Urgent — end of same working day (17:30 today)
                      </option>
                      <option value="enquiry_urgency.emergency">
                        Emergency — within 2 working hours
                      </option>
                      <option value="enquiry_urgency.standard">
                        Standard — end of next working day
                      </option>
                    </select>
                  </div>
                  <div>
                    <label className="field-label" style={{ fontSize: 11.5 }}>
                      Best time to call
                    </label>
                    <input
                      className="input"
                      type="text"
                      value={qBestTime}
                      onChange={(e) => setQBestTime(e.target.value)}
                    />
                  </div>
                  <div className="full">
                    <label className="field-label" style={{ fontSize: 11.5 }}>
                      Summary (max 120 chars) *
                    </label>
                    <input
                      className="input"
                      type="text"
                      maxLength={120}
                      value={qSummary}
                      onChange={(e) => setQSummary(e.target.value)}
                      required
                    />
                  </div>
                  <div className="full">
                    <label className="field-label" style={{ fontSize: 11.5 }}>
                      Other parties named (for conflict check on conversion)
                    </label>
                    <input
                      className="input"
                      type="text"
                      value={qOtherParties}
                      onChange={(e) => setQOtherParties(e.target.value)}
                    />
                  </div>
                  <div
                    className="full"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginTop: 4,
                      flexWrap: 'wrap',
                      gap: 10,
                    }}
                  >
                    <label
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 12.5,
                        color: 'var(--text-secondary)',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={qPrivacyGiven}
                        onChange={(e) => setQPrivacyGiven(e.target.checked)}
                      />
                      Privacy notice given to caller
                    </label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={(e) => handleQuickCaptureSubmit(e, true)}
                      >
                        Save, claim &amp; call now
                      </button>
                      <button type="submit" className="btn btn--primary btn--sm">
                        Save &amp; route to team
                      </button>
                    </div>
                  </div>
                </div>
              </form>
            </div>
          </section>
        );
      }

      // ================================================================
      // 14. callback_sla_queue (04 Enquiries Coordinator)
      // ================================================================
      case 'callback_sla_queue': {
        const openEnqs = enquiries
          .filter((e) => isEnquiryOpen(e))
          .sort((a, b) =>
            (a.firstContactDueAt ?? a.receivedAt).localeCompare(b.firstContactDueAt ?? b.receivedAt),
          );
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Callback SLA queue — all open enquiries</h2>
                <StatusPill label={`${openEnqs.length} open`} tone="neutral" />
              </div>
              <div className="panel-actions">
                <Link href="/enquiries" className="panel-link">
                  Full Enquiries list →
                </Link>
              </div>
            </div>
            <div className="panel-body">
              {openEnqs.length === 0 ? (
                <div className="panel-body padded muted">No open enquiries in the callback queue.</div>
              ) : (
                <ul className="worklist">
                  {openEnqs.slice(0, 6).map((e) => {
                    const urgLabel = resolveLabel(values, e.urgencyId) || 'Standard';
                    const paLabel = resolveLabel(values, e.practiceAreaId) || 'General';
                    const assignee = e.assignedToId ? personById.get(e.assignedToId) : null;
                    const isOverdue =
                      e.firstContactDueAt && e.firstContactDueAt.slice(0, 10) < todayIso;
                    return (
                      <li key={e.id} className="worklist-row">
                        <div className="worklist-main">
                          <div className="worklist-title">
                            <StatusPill
                              label={
                                isOverdue
                                  ? `SLA overdue · ${urgLabel}`
                                  : `${urgLabel} · Due ${e.bestTimeToCall || 'today'}`
                              }
                              tone={isOverdue || urgLabel === 'Emergency' ? 'alert' : 'warning'}
                            />
                            <Link href={`/enquiries/${e.id}`}>
                              {enquiryDisplayName(e)} — {e.summary}
                            </Link>
                          </div>
                          <div className="worklist-meta">
                            <span className="mono-code">{e.reference}</span>
                            <span>· {paLabel}</span>
                            <span>
                              ·{' '}
                              {assignee
                                ? `Assigned to ${personDisplayName(assignee)}`
                                : 'Unassigned'}
                            </span>
                            {e.contactLog.length > 0 ? (
                              <span>· {e.contactLog.length} contact attempt(s)</span>
                            ) : null}
                          </div>
                        </div>
                        <div className="worklist-right">
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            onClick={() => {
                              setLogModalEnq(e);
                              setLogNote('');
                            }}
                          >
                            Log contact
                          </button>
                          {!e.assignedToId ? (
                            <button
                              type="button"
                              className="btn btn--primary btn--sm"
                              onClick={() => handleTakeEnquiry(e)}
                            >
                              Take
                            </button>
                          ) : (
                            <Link
                              href={`/enquiries/${e.id}`}
                              className="btn btn--secondary btn--sm"
                            >
                              Open
                            </Link>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        );
      }

      // ================================================================
      // 15. unassigned_enquiries (04 Enquiries Coordinator)
      // ================================================================
      case 'unassigned_enquiries': {
        const unassigned = enquiries.filter((e) => isEnquiryOpen(e) && !e.assignedToId);
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Unassigned enquiries — needs routing or owner</h2>
                <StatusPill label={`${unassigned.length} unassigned`} tone="warning" />
              </div>
            </div>
            <div className="panel-body">
              {unassigned.length === 0 ? (
                <div className="panel-body padded muted">
                  All open enquiries have an assigned fee earner.
                </div>
              ) : (
                <ul className="worklist">
                  {unassigned.map((e) => {
                    const team = e.assignedTeamId ? teamById.get(e.assignedTeamId) : null;
                    return (
                      <li key={e.id} className="worklist-row">
                        <div className="worklist-main">
                          <div className="worklist-title">
                            <StatusPill label={team?.name ?? 'Intake'} tone="neutral" />
                            <Link href={`/enquiries/${e.id}`}>
                              {enquiryDisplayName(e)} — {e.summary}
                            </Link>
                          </div>
                          <div className="worklist-meta">
                            <span className="mono-code">{e.reference}</span>
                            <span>
                              · {resolveLabel(values, e.channelId) || 'Phone'} ·{' '}
                              {resolveLabel(values, e.urgencyId) || 'Standard'}
                            </span>
                          </div>
                        </div>
                        <div className="worklist-right">
                          <Link
                            href={`/enquiries/${e.id}`}
                            className="btn btn--secondary btn--sm"
                          >
                            Route / assign
                          </Link>
                          <button
                            type="button"
                            className="btn btn--primary btn--sm"
                            onClick={() => handleTakeEnquiry(e)}
                          >
                            Take
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        );
      }

      // ================================================================
      // 16. awaiting_fee_earner_response (04 Enquiries Coordinator)
      // ================================================================
      case 'awaiting_fee_earner_response': {
        const awaitingFe = enquiries.filter(
          (e) => isEnquiryOpen(e) && e.assignedToId && e.status === 'Assigned',
        );
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Assigned — awaiting fee earner first contact</h2>
                <span className="panel-subtitle">Chase or reassign before SLA breach</span>
              </div>
            </div>
            <div className="panel-body">
              {awaitingFe.length === 0 ? (
                <div className="panel-body padded muted">
                  No assigned enquiries awaiting first contact.
                </div>
              ) : (
                <ul className="worklist">
                  {awaitingFe.map((e) => {
                    const fe = e.assignedToId ? personById.get(e.assignedToId) : null;
                    return (
                      <li key={e.id} className="worklist-row">
                        <div className="worklist-main">
                          <div className="worklist-title">
                            <Link href={`/enquiries/${e.id}`}>
                              {enquiryDisplayName(e)} — {e.summary}
                            </Link>
                          </div>
                          <div className="worklist-meta">
                            <span className="mono-code">{e.reference}</span>
                            <span>
                              · Assigned to{' '}
                              <strong>{fe ? personDisplayName(fe) : e.assignedToId}</strong>
                            </span>
                            {e.bestTimeToCall ? <span>· Best time: {e.bestTimeToCall}</span> : null}
                          </div>
                        </div>
                        <div className="worklist-right">
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() =>
                              showToast(
                                `Sent callback nudge to ${fe ? personDisplayName(fe) : 'fee earner'} for ${e.reference}.`,
                              )
                            }
                          >
                            Nudge fee earner
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        );
      }

      // ================================================================
      // 17. todays_outcomes_and_conversion (04 Enquiries Coordinator)
      // ================================================================
      case 'todays_outcomes_and_conversion': {
        const totalEnqs = enquiries.length;
        const convCount = enquiries.filter((e) => e.status === 'Converted').length;
        const convPct = totalEnqs > 0 ? Math.round((convCount / totalEnqs) * 100) : 0;
        const openCount = enquiries.filter((e) => isEnquiryOpen(e)).length;
        const declinedCount = enquiries.filter((e) => e.status === 'Declined').length;
        const referredCount = enquiries.filter((e) => e.status === 'Referred out').length;
        const noRespCount = enquiries.filter((e) => e.status === 'No response').length;
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">This month&apos;s outcomes &amp; conversion</h2>
              </div>
              <span className="panel-subtitle">{currentMonthYearLabel}</span>
            </div>
            <div className="panel-body padded">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                <div className="legend-item">
                  <div className="lbl">Received</div>
                  <div className="val">{totalEnqs}</div>
                </div>
                <div className="legend-item">
                  <div className="lbl">Converted</div>
                  <div className="val" style={{ color: 'var(--green-text)' }}>
                    {convCount} ({convPct}%)
                  </div>
                </div>
                <div className="legend-item">
                  <div className="lbl">Open / In contact</div>
                  <div className="val">{openCount}</div>
                </div>
                <div className="legend-item">
                  <div className="lbl">Declined</div>
                  <div className="val">{declinedCount}</div>
                </div>
                <div className="legend-item">
                  <div className="lbl">Referred out</div>
                  <div className="val">{referredCount}</div>
                </div>
                <div className="legend-item">
                  <div className="lbl">No response</div>
                  <div className="val">{noRespCount}</div>
                </div>
              </div>
            </div>
          </section>
        );
      }

      // ================================================================
      // 18. referral_sources_this_month (04 Enquiries Coordinator)
      // ================================================================
      case 'referral_sources_this_month': {
        const channelRowsMap = new Map<string, { label: string; count: number; converted: number }>();
        for (const e of enquiries) {
          const chLabel = resolveLabel(values, e.channelId) || 'Unspecified';
          const entry = channelRowsMap.get(chLabel) ?? { label: chLabel, count: 0, converted: 0 };
          entry.count += 1;
          if (e.status === 'Converted') entry.converted += 1;
          channelRowsMap.set(chLabel, entry);
        }
        const channelRows = Array.from(channelRowsMap.values()).sort((a, b) => b.count - a.count);
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Enquiry channels &amp; referral sources</h2>
              </div>
              <span className="panel-subtitle">{currentMonthYearLabel}</span>
            </div>
            <div className="panel-body">
              {channelRows.length === 0 ? (
                <div className="panel-body padded muted">
                  No enquiry channel or referral source activity recorded yet.
                </div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Channel / Source</th>
                      <th className="num">Enquiries</th>
                      <th className="num">Converted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {channelRows.map((ch) => (
                      <tr key={ch.label}>
                        <td>{ch.label}</td>
                        <td className="num">{ch.count}</td>
                        <td className="num">
                          <strong>{ch.converted}</strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        );
      }

      // ================================================================
      // 19. matters_needing_partner_attention (02 Partner)
      // ================================================================
      case 'matters_needing_partner_attention': {
        const attentionRows: Array<{
          code: string;
          title: string;
          pillLabel: string;
          pillTone: 'alert' | 'warning';
          meta: string;
          wip: number;
          invoiceNumber: string | null;
          clientCode: string;
        }> = [];
        const seenCodes = new Set<string>();
        for (const mf of allMatterFins) {
          const overdueDays = mf.max_invoice_days_past_due ?? 0;
          const estPct = mf.estimate_used_pct ? Math.round(mf.estimate_used_pct * 100) : 0;
          if (overdueDays > 60 && mf.outstanding_debt > 0) {
            const matchingInv = pmsAgedDebt.find(
              (inv) => inv.matter_code === mf.matter_code && (inv.days_past_due ?? 0) > 60,
            );
            const overdueAmount = matchingInv ? matchingInv.outstanding : mf.outstanding_debt;
            attentionRows.push({
              code: mf.matter_code,
              title: `${mf.matter_description} (${mf.client_name})`,
              pillLabel: `${overdueDays}d overdue (${formatGbp(overdueAmount)})`,
              pillTone: overdueDays >= 90 ? 'alert' : 'warning',
              meta: `Lead: ${mf.fee_earner_name} · Overdue debt ${formatGbp(overdueAmount)}`,
              wip: mf.unbilled_wip,
              invoiceNumber: matchingInv?.invoice_number ?? null,
              clientCode: mf.client_code,
            });
            seenCodes.add(mf.matter_code);
          } else if (estPct >= 85) {
            attentionRows.push({
              code: mf.matter_code,
              title: `${mf.matter_description} (${mf.client_name})`,
              pillLabel: `At ${estPct}% of estimate`,
              pillTone: estPct >= 100 ? 'alert' : 'warning',
              meta: `Lead: ${mf.fee_earner_name} · Time recorded ${formatGbp(mf.time_value_recorded)} of ${formatGbp(mf.fee_estimate)} · Unbilled WIP ${formatGbp(mf.unbilled_wip)}`,
              wip: mf.unbilled_wip,
              invoiceNumber: null,
              clientCode: mf.client_code,
            });
            seenCodes.add(mf.matter_code);
          }
        }
        for (const m of supervisedMatters) {
          if (seenCodes.has(m.matterNumber)) continue;
          const riskLabel = resolveLabel(values, m.riskRatingId);
          const amlLabel = m.amlStatus;
          if (riskLabel === 'High' && amlLabel !== 'Verified') {
            const clientObj = orgById.get(m.clientId) ?? personById.get(m.clientId);
            const clientName = clientObj
              ? 'legalName' in clientObj
                ? clientObj.legalName
                : personDisplayName(clientObj)
              : m.clientId;
            const lead = m.leadFeeEarnerId ? personById.get(m.leadFeeEarnerId) : null;
            attentionRows.push({
              code: m.matterNumber,
              title: `${m.title} (${clientName})`,
              pillLabel: `High risk · AML ${amlLabel || 'Pending'}`,
              pillTone: 'alert',
              meta: `Lead: ${lead ? personDisplayName(lead) : 'Unassigned'}`,
              wip: 0,
              invoiceNumber: null,
              clientCode: m.clientId,
            });
            seenCodes.add(m.matterNumber);
          }
        }
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Matters needing partner attention</h2>
                <StatusPill
                  label={`${attentionRows.length} ${attentionRows.length === 1 ? 'matter' : 'matters'}`}
                  tone={attentionRows.length > 0 ? 'warning' : 'neutral'}
                />
              </div>
              <span className="panel-subtitle">
                Estimate alerts · aged debt &gt;60d · high-risk / pending AML
              </span>
            </div>
            <div className="panel-body">
              {attentionRows.length === 0 ? (
                <div className="panel-body padded muted">
                  No matters currently flagged for partner attention.
                </div>
              ) : (
                <ul className="worklist">
                  {attentionRows.slice(0, 6).map((item) => (
                    <li key={item.code} className="worklist-row">
                      <div className="worklist-main">
                        <div className="worklist-title">
                          <StatusPill label={item.pillLabel} tone={item.pillTone} />
                          <Link href={matterHrefForCode(item.code)}>{item.title}</Link>
                        </div>
                        <div className="worklist-meta">
                          <span className="mono-code">{item.code}</span>
                          <span>· {item.meta}</span>
                        </div>
                      </div>
                      <div className="worklist-right">
                        {finance.canCreditControl && item.invoiceNumber ? (
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            onClick={async () => {
                              const res = await recordInvoiceCreditControlActionAction({
                                invoiceNumber: item.invoiceNumber!,
                                matterCode: item.code,
                                clientCode: item.clientCode,
                                actionType: 'escalate',
                              });
                              if (isActionDenied(res)) {
                                showToast(res.message);
                                return;
                              }
                              showToast(
                                `Assigned formal credit-control escalation on ${item.code}.`,
                              );
                              router.refresh();
                            }}
                          >
                            Assign chase
                          </button>
                        ) : finance.canCreditControl && item.wip > 0 ? (
                          <button
                            type="button"
                            className="btn btn--primary btn--sm"
                            onClick={async () => {
                              const res = await requestMatterBillAction(item.code);
                              if (isActionDenied(res)) {
                                showToast(res.message);
                                return;
                              }
                              showToast(`Requested interim bill on ${item.code}.`);
                              router.refresh();
                            }}
                          >
                            Approve billing
                          </button>
                        ) : null}
                        <Link
                          href={matterHrefForCode(item.code)}
                          className="btn btn--primary btn--sm"
                        >
                          Review matter
                        </Link>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        );
      }

      // ================================================================
      // 20. sign_offs_and_approvals (02 Partner & 07 Managing Partner)
      // ================================================================
      case 'sign_offs_and_approvals': {
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Sign-offs &amp; approvals waiting on you</h2>
                <StatusPill label={`${pendingSignOffs.length} pending`} tone="neutral" />
              </div>
            </div>
            <div className="panel-body">
              {pendingSignOffs.length === 0 ? (
                <div className="panel-body padded muted">
                  All partner sign-offs and approvals are up to date.
                </div>
              ) : (
                <ul className="worklist">
                  {pendingSignOffs.map((so) => (
                    <li key={so.id} className="worklist-row">
                      <div className="worklist-main">
                        <div className="worklist-title">
                          <Link href={matterHrefForCode(so.matterNumber)}>{so.title}</Link>
                        </div>
                        <div className="worklist-meta">{so.subtitle}</div>
                      </div>
                      <div className="worklist-right">
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          onClick={() => {
                            setDiscussSignOffItem(so);
                            setDiscussNote('');
                          }}
                        >
                          Discuss
                        </button>
                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          onClick={async () => {
                            const res = await approveSignOffAction(so.id);
                            if (isActionDenied(res)) {
                              showToast(res.message);
                              return;
                            }
                            showToast(`Approved: ${so.title}`);
                            router.refresh();
                          }}
                        >
                          Approve
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        );
      }

      // ================================================================
      // 21. team_workload_and_utilisation (02 Partner)
      // ================================================================
      case 'team_workload_and_utilisation': {
        const rows = allFeeEarnerPerformance;
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Team workload &amp; utilisation</h2>
                <span className="panel-subtitle">
                  1Squared open matters/tasks + PMS `v_fee_earner_performance` · as at{' '}
                  {formattedAsAt}
                </span>
              </div>
            </div>
            <div className="panel-body" style={{ overflowX: 'auto' }}>
              {rows.length === 0 ? (
                <div className="panel-body padded muted">
                  No fee earner workload or utilisation records.
                </div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Fee earner</th>
                      <th>Grade · Rate</th>
                      <th className="num">Open matters</th>
                      <th className="num">Open tasks</th>
                      <th className="num">{currentMonthShort} hrs</th>
                      <th>YTD hrs vs target</th>
                      <th className="num">Unbilled WIP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((fe) => {
                      const pct = Math.round(fe.pct_of_annual_target * 1000) / 10;
                      const barWidth = Math.min(Math.round(pct * 5), 100);
                      const person = people.find(
                        (p) => personDisplayName(p).toLowerCase() === fe.name.toLowerCase(),
                      );
                      const feOpenMatters = person
                        ? matters.filter(
                            (m) =>
                              m.matterStatusId !== 'matter_status.closed' &&
                              (m.leadFeeEarnerId === person.id ||
                                m.teamMemberIds.includes(person.id)),
                          ).length
                        : 0;
                      const feOpenTasks = person
                        ? tasks.filter((t) => isTaskOpen(t) && t.assignedPersonId === person.id)
                        : [];
                      const feOverdueTasks = feOpenTasks.filter((t) => t.dueAt < todayIso).length;
                      return (
                        <tr key={fe.fee_earner_id}>
                          <td>
                            <strong>{fe.name}</strong>
                          </td>
                          <td>
                            {fe.grade} · £{fe.standard_hourly_rate}/hr
                          </td>
                          <td className="num">{feOpenMatters}</td>
                          <td className="num">
                            {feOverdueTasks > 0
                              ? `${feOpenTasks.length} (${feOverdueTasks} overdue)`
                              : `${feOpenTasks.length}`}
                          </td>
                          <td className="num">{fe.chargeable_hours_this_month.toFixed(1)} h</td>
                          <td style={{ minWidth: 150 }}>
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                fontSize: 11.5,
                                marginBottom: 3,
                              }}
                            >
                              <span>{fe.chargeable_hours.toFixed(1)} h</span>
                              <span>{pct.toFixed(1)}%</span>
                            </div>
                            <div className="progress-track">
                              <div
                                className="progress-fill"
                                style={{ width: `${barWidth}%` }}
                              />
                            </div>
                          </td>
                          <td className="num">
                            <strong>{formatGbp(fe.unbilled_wip)}</strong>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        );
      }

      // ================================================================
      // 22. wip_ready_to_bill_and_aged_debt (02 Partner)
      // ================================================================
      case 'wip_ready_to_bill_and_aged_debt': {
        const supervisedCodes = new Set(supervisedMatters.map((m) => m.matterNumber));
        const portfolioFinRows = allMatterFins.filter(
          (mf) =>
            (supervisedCodes.size === 0 || supervisedCodes.has(mf.matter_code)) &&
            (mf.unbilled_wip > 0 || mf.outstanding_debt > 0),
        );
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Unbilled WIP &amp; overdue debt on my matters</h2>
                <span className="mono-code">PMS · read-only</span>
              </div>
              <span className="panel-subtitle">Supervised portfolio · as at {formattedAsAt}</span>
            </div>
            <div className="panel-body" style={{ overflowX: 'auto' }}>
              {portfolioFinRows.length === 0 ? (
                <div className="panel-body padded muted">
                  No unbilled WIP or overdue debt on supervised matters.
                </div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Matter</th>
                      <th>Client</th>
                      <th className="num">Unbilled WIP</th>
                      <th className="num">Unbilled disb.</th>
                      <th className="num">Overdue debt</th>
                      <th className="num">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {portfolioFinRows.slice(0, 8).map((mf) => {
                      const daysLate = mf.max_invoice_days_past_due ?? 0;
                      const overdueInv = pmsAgedDebt.find(
                        (inv) => inv.matter_code === mf.matter_code && (inv.days_past_due ?? 0) > 0,
                      );
                      const overdueAmount = overdueInv ? overdueInv.outstanding : daysLate > 0 ? mf.outstanding_debt : 0;
                      return (
                        <tr key={mf.matter_code}>
                          <td>
                            <Link href={matterHrefForCode(mf.matter_code)}>
                              <strong>{mf.matter_code}</strong>
                            </Link>{' '}
                            · {mf.matter_description}
                          </td>
                          <td>{mf.client_name}</td>
                          <td className="num">
                            <strong>{formatGbp(mf.unbilled_wip)}</strong>
                          </td>
                          <td className="num">{formatGbp(mf.unbilled_disbursements)}</td>
                          <td className="num">
                            {overdueAmount > 0 ? (
                              <StatusPill
                                label={`${formatGbp(overdueAmount)} (${daysLate}d)`}
                                tone={daysLate >= 90 ? 'alert' : 'warning'}
                              />
                            ) : (
                              '£0.00'
                            )}
                          </td>
                          <td className="num">
                            {!finance.canCreditControl ? (
                              <span className="muted">—</span>
                            ) : mf.unbilled_wip > 0 ? (
                              <button
                                type="button"
                                className="btn btn--secondary btn--sm"
                                onClick={async () => {
                                  const res = await requestMatterBillAction(mf.matter_code);
                                  if (isActionDenied(res)) {
                                    showToast(res.message);
                                    return;
                                  }
                                  showToast(`Requested bill on ${mf.matter_code}.`);
                                  router.refresh();
                                }}
                              >
                                Request bill
                              </button>
                            ) : overdueInv ? (
                              <button
                                type="button"
                                className="btn btn--secondary btn--sm"
                                onClick={async () => {
                                  const res = await recordInvoiceCreditControlActionAction({
                                    invoiceNumber: overdueInv.invoice_number,
                                    matterCode: mf.matter_code,
                                    clientCode: mf.client_code,
                                    actionType: 'escalate',
                                  });
                                  if (isActionDenied(res)) {
                                    showToast(res.message);
                                    return;
                                  }
                                  showToast(
                                    `Escalated ${overdueInv.invoice_number} on ${mf.matter_code}.`,
                                  );
                                  router.refresh();
                                }}
                              >
                                Escalate
                              </button>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        );
      }

      // ================================================================
      // 23. enquiries_and_conversion_by_practice_area (02 Partner)
      // ================================================================
      case 'enquiries_and_conversion_by_practice_area': {
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Enquiries &amp; conversion</h2>
              </div>
              <span className="panel-subtitle">{currentMonthYearLabel}</span>
            </div>
            <div className="panel-body padded">
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, 1fr)',
                  gap: 8,
                  textAlign: 'center',
                }}
              >
                <div className="legend-item">
                  <div className="lbl">Received</div>
                  <div className="val">{enquiries.length}</div>
                </div>
                <div className="legend-item">
                  <div className="lbl">Converted</div>
                  <div className="val" style={{ color: 'var(--green-text)' }}>
                    {enquiries.filter((e) => e.status === 'Converted').length}
                  </div>
                </div>
                <div className="legend-item">
                  <div className="lbl">In contact</div>
                  <div className="val">
                    {enquiries.filter((e) => e.status === 'In contact').length}
                  </div>
                </div>
                <div className="legend-item">
                  <div className="lbl">Unassigned</div>
                  <div className="val" style={{ color: 'var(--amber-text)' }}>
                    {enquiries.filter((e) => isEnquiryOpen(e) && !e.assignedToId).length}
                  </div>
                </div>
              </div>
            </div>
          </section>
        );
      }

      // ================================================================
      // 24. key_client_and_referrer_touchpoints (02 Partner)
      // ================================================================
      case 'key_client_and_referrer_touchpoints': {
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Key clients &amp; referrers — touchpoints due</h2>
              </div>
              <Link href="/organisations" className="panel-link">
                Organisations →
              </Link>
            </div>
            <div className="panel-body">
              <div className="panel-body padded muted">
                No client or referrer touchpoints currently due.
              </div>
            </div>
          </section>
        );
      }

      // ================================================================
      // 25. aged_debt_by_age_band (05 Finance & 07 Managing Partner)
      // ================================================================
      case 'aged_debt_by_age_band': {
        const bandNotDue = pmsAgedDebt.filter((i) => (i.days_past_due ?? 0) <= 0);
        const band1To30 = pmsAgedDebt.filter(
          (i) => (i.days_past_due ?? 0) >= 1 && (i.days_past_due ?? 0) <= 30,
        );
        const band31To60 = pmsAgedDebt.filter(
          (i) => (i.days_past_due ?? 0) >= 31 && (i.days_past_due ?? 0) <= 60,
        );
        const band61To90 = pmsAgedDebt.filter(
          (i) => (i.days_past_due ?? 0) >= 61 && (i.days_past_due ?? 0) <= 90,
        );
        const band90Plus = pmsAgedDebt.filter((i) => (i.days_past_due ?? 0) > 90);
        const sumBand = (list: PmsInvoiceBalance[]) =>
          Math.round(list.reduce((s, x) => s + x.outstanding, 0) * 100) / 100;
        const valNotDue = sumBand(bandNotDue);
        const val1To30 = sumBand(band1To30);
        const val31To60 = sumBand(band31To60);
        const val61To90 = sumBand(band61To90);
        const val90Plus = sumBand(band90Plus);
        const totalBandDebt =
          Math.round((valNotDue + val1To30 + val31To60 + val61To90 + val90Plus) * 100) / 100;
        const pctOf = (v: number) =>
          totalBandDebt > 0 ? `${((v / totalBandDebt) * 100).toFixed(1)}%` : '0%';
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Aged debt by band — firm-wide</h2>
                <span className="mono-code">PMS `v_invoice_balances`</span>
              </div>
              <span className="panel-subtitle">
                {formatGbp(totalBandDebt)} across {pmsAgedDebt.length} unpaid / part-paid bill
                {pmsAgedDebt.length === 1 ? '' : 's'} · as at {formattedAsAt}
              </span>
            </div>
            <div className="panel-body padded">
              <div className="stacked-bar" aria-label="Aged debt distribution">
                <div
                  className="stacked-seg"
                  style={{ width: pctOf(valNotDue), background: '#0D5C63' }}
                  title={`Not yet due: ${formatGbp(valNotDue)} (${pctOf(valNotDue)})`}
                />
                <div
                  className="stacked-seg"
                  style={{ width: pctOf(val1To30), background: '#D97706' }}
                  title={`1–30 days overdue: ${formatGbp(val1To30)} (${pctOf(val1To30)})`}
                />
                <div
                  className="stacked-seg"
                  style={{ width: pctOf(val31To60), background: '#EA580C' }}
                  title={`31–60 days overdue: ${formatGbp(val31To60)} (${pctOf(val31To60)})`}
                />
                <div
                  className="stacked-seg"
                  style={{ width: pctOf(val61To90), background: '#DC2626' }}
                  title={`61–90 days overdue: ${formatGbp(val61To90)} (${pctOf(val61To90)})`}
                />
                <div
                  className="stacked-seg"
                  style={{ width: pctOf(val90Plus), background: '#991B1B' }}
                  title={`90+ days overdue: ${formatGbp(val90Plus)} (${pctOf(val90Plus)})`}
                />
              </div>
              <div className="stacked-legend">
                <div className="legend-item">
                  <div className="lbl">
                    <span className="swatch" style={{ background: '#0D5C63' }} /> Not yet due
                  </div>
                  <div className="val">{formatGbp(valNotDue)}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {bandNotDue.length} invoice{bandNotDue.length === 1 ? '' : 's'}
                  </div>
                </div>
                <div className="legend-item">
                  <div className="lbl">
                    <span className="swatch" style={{ background: '#D97706' }} /> 1–30 days
                  </div>
                  <div className="val">{formatGbp(val1To30)}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {band1To30.length} invoice{band1To30.length === 1 ? '' : 's'}
                  </div>
                </div>
                <div className="legend-item">
                  <div className="lbl">
                    <span className="swatch" style={{ background: '#EA580C' }} /> 31–60 days
                  </div>
                  <div className="val">{formatGbp(val31To60)}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {band31To60.length} invoice{band31To60.length === 1 ? '' : 's'}
                  </div>
                </div>
                <div className="legend-item">
                  <div className="lbl">
                    <span className="swatch" style={{ background: '#DC2626' }} /> 61–90 days
                  </div>
                  <div className="val">{formatGbp(val61To90)}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {band61To90.length} invoice{band61To90.length === 1 ? '' : 's'}
                  </div>
                </div>
                <div className="legend-item">
                  <div className="lbl">
                    <span className="swatch" style={{ background: '#991B1B' }} /> 90+ days
                  </div>
                  <div className="val" style={{ color: 'var(--coral-text)' }}>
                    {formatGbp(val90Plus)}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {band90Plus.length} invoice{band90Plus.length === 1 ? '' : 's'}
                  </div>
                </div>
              </div>
            </div>
          </section>
        );
      }

      // ================================================================
      // 26. overdue_invoices_worklist (05 Finance)
      // ================================================================
      case 'overdue_invoices_worklist': {
        const overdueBills = pmsAgedDebt
          .filter((inv) => (inv.days_past_due ?? 0) > 0)
          .sort((a, b) => (b.days_past_due ?? 0) - (a.days_past_due ?? 0));
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Overdue invoices — credit control worklist</h2>
                <StatusPill
                  label={`${overdueBills.length} overdue · ${formatGbp(firmOverdueDebt)}`}
                  tone={overdueBills.length > 0 ? 'alert' : 'neutral'}
                />
              </div>
              <span className="panel-subtitle">Ordered by days past due</span>
            </div>
            <div className="panel-body" style={{ overflowX: 'auto' }}>
              {overdueBills.length === 0 ? (
                <div className="panel-body padded muted">
                  No overdue invoices requiring credit control action.
                </div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Invoice &amp; Matter</th>
                      <th>Client &amp; Billing contact</th>
                      <th>Due date</th>
                      <th>Age band</th>
                      <th className="num">Balance</th>
                      <th className="num">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overdueBills.map((inv) => {
                      const clientFin = allClientFins.find((c) => c.client_code === inv.client_code);
                      const daysLate = inv.days_past_due ?? 0;
                      const tone =
                        daysLate >= 90
                          ? 'alert'
                          : daysLate >= 15
                            ? 'warning'
                            : 'neutral';
                      return (
                        <tr key={inv.invoice_number}>
                          <td>
                            <div style={{ fontWeight: 600 }}>{inv.invoice_number}</div>
                            <div>
                              <Link
                                href={matterHrefForCode(inv.matter_code)}
                                className="mono-code"
                              >
                                {inv.matter_code}
                              </Link>
                            </div>
                          </td>
                          <td>
                            <div style={{ fontWeight: 600 }}>
                              <Link href={clientHrefForCode(inv.client_code)}>
                                {clientFin?.client_name ?? inv.client_code}
                              </Link>
                            </div>
                            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                              {clientFin?.email ?? 'Accounts Payable'} · Terms{' '}
                              {clientFin?.credit_terms_days ?? 30}d
                            </div>
                          </td>
                          <td>{formatDate(inv.due_date)}</td>
                          <td>
                            <StatusPill
                              label={`${daysLate}d (${inv.age_bucket})`}
                              tone={tone}
                            />
                          </td>
                          <td className="num">
                            <strong>{formatGbp(inv.outstanding)}</strong>
                          </td>
                          <td className="num">
                            {finance.canCreditControl ? (
                              <div
                                style={{
                                  display: 'inline-flex',
                                  gap: 4,
                                  justifyContent: 'flex-end',
                                }}
                              >
                                <button
                                  type="button"
                                  className="btn btn--secondary btn--sm"
                                  onClick={async () => {
                                    const res = await recordInvoiceCreditControlActionAction({
                                      invoiceNumber: inv.invoice_number,
                                      matterCode: inv.matter_code,
                                      clientCode: inv.client_code,
                                      actionType: 'log_call',
                                    });
                                    if (isActionDenied(res)) {
                                      showToast(res.message);
                                      return;
                                    }
                                    showToast(`Logged chase call on ${inv.invoice_number}.`);
                                    router.refresh();
                                  }}
                                >
                                  Log call
                                </button>
                                <button
                                  type="button"
                                  className="btn btn--primary btn--sm"
                                  onClick={async () => {
                                    const res = await recordInvoiceCreditControlActionAction({
                                      invoiceNumber: inv.invoice_number,
                                      matterCode: inv.matter_code,
                                      clientCode: inv.client_code,
                                      actionType:
                                        daysLate >= 90 ? 'escalate' : 'send_reminder',
                                    });
                                    if (isActionDenied(res)) {
                                      showToast(res.message);
                                      return;
                                    }
                                    showToast(
                                      daysLate >= 90
                                        ? `Escalated ${inv.invoice_number} to responsible partner.`
                                        : `Sent reminder statement for ${inv.invoice_number}.`,
                                    );
                                    router.refresh();
                                  }}
                                >
                                  {daysLate >= 90 ? 'Escalate' : 'Send reminder'}
                                </button>
                              </div>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        );
      }

      // ================================================================
      // 27. wip_ready_to_bill (05 Finance)
      // ================================================================
      case 'wip_ready_to_bill': {
        const wipMatters = allMatterFins
          .filter((m) => m.unbilled_wip > 0)
          .sort((a, b) => b.unbilled_wip - a.unbilled_wip);
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Unbilled WIP — ready to bill by matter</h2>
                <span className="mono-code">PMS `v_matter_financials`</span>
              </div>
              <span className="panel-subtitle">Prompt fee earners in one click</span>
            </div>
            <div className="panel-body" style={{ overflowX: 'auto' }}>
              {wipMatters.length === 0 ? (
                <div className="panel-body padded muted">
                  No unbilled WIP currently recorded across matters.
                </div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Matter</th>
                      <th>Client &amp; Lead</th>
                      <th>Billing basis / frequency</th>
                      <th className="num">Unbilled WIP</th>
                      <th className="num">Unbilled disb.</th>
                      <th>Estimate health</th>
                      <th className="num">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wipMatters.map((m) => {
                      const pct = m.estimate_used_pct ? Math.round(m.estimate_used_pct * 100) : null;
                      const isOverCap = m.billing_basis === 'Capped Fee' && (pct ?? 0) > 100;
                      const isOverFixed =
                        m.billing_basis === 'Fixed Fee' &&
                        m.fixed_fee_amount > 0 &&
                        m.time_value_recorded > m.fixed_fee_amount;
                      return (
                        <tr key={m.matter_code}>
                          <td>
                            <Link href={matterHrefForCode(m.matter_code)}>
                              <strong>{m.matter_code}</strong>
                            </Link>
                            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                              {m.matter_description}
                            </div>
                          </td>
                          <td>
                            <div>{m.client_name}</div>
                            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                              {m.fee_earner_name}
                            </div>
                          </td>
                          <td>
                            {m.billing_basis} · {m.billing_frequency}
                          </td>
                          <td className="num">
                            <strong>{formatGbp(m.unbilled_wip)}</strong>
                          </td>
                          <td className="num">{formatGbp(m.unbilled_disbursements)}</td>
                          <td>
                            {isOverCap ? (
                              <StatusPill
                                label={`${pct}% of £${(m.fee_estimate / 1000).toFixed(0)}k cap`}
                                tone="alert"
                              />
                            ) : isOverFixed ? (
                              <StatusPill
                                label={`+£${(m.time_value_recorded - m.fixed_fee_amount).toFixed(0)} over fixed fee`}
                                tone="warning"
                              />
                            ) : pct !== null ? (
                              <StatusPill
                                label={`${pct}% of estimate`}
                                tone={pct >= 75 ? 'warning' : 'positive'}
                              />
                            ) : (
                              <StatusPill label="On track" tone="positive" />
                            )}
                          </td>
                          <td className="num">
                            {!finance.canCreditControl ? (
                              <span className="muted">—</span>
                            ) : isOverCap ? (
                              <button
                                type="button"
                                className="btn btn--secondary btn--sm"
                                onClick={async () => {
                                  const res = await flagMatterWriteOffAction(
                                    m.matter_code,
                                    Math.max(m.time_value_recorded - m.fee_estimate, m.unbilled_wip),
                                  );
                                  if (isActionDenied(res)) {
                                    showToast(res.message);
                                    return;
                                  }
                                  showToast(
                                    `Flagged ${m.matter_code} for partner write-off decision.`,
                                  );
                                  router.refresh();
                                }}
                              >
                                Flag write-off
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="btn btn--secondary btn--sm"
                                onClick={async () => {
                                  const res = await requestMatterBillAction(m.matter_code);
                                  if (isActionDenied(res)) {
                                    showToast(res.message);
                                    return;
                                  }
                                  showToast(
                                    `Created billing request task for ${m.fee_earner_name} on ${m.matter_code}.`,
                                  );
                                  router.refresh();
                                }}
                              >
                                Request bill
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        );
      }

      // ================================================================
      // 28. client_account_reconciliation_and_exceptions (05 Finance)
      // ================================================================
      case 'client_account_reconciliation_and_exceptions': {
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">
                  Client account balances — SRA Accounts Rules monitor
                </h2>
                <span className="mono-code">PMS `client_account`</span>
              </div>
            </div>
            <div className="panel-body">
              <div className="panel-body padded muted">
                No client account reconciliations or residual balance exceptions recorded.
              </div>
            </div>
            <div className="panel-footer">
              <span>Client account reconciliation monitoring</span>
              <span>Total held: {formatGbp(firmClientAccountHeld)}</span>
            </div>
          </section>
        );
      }

      // ================================================================
      // 29. disbursements_awaiting_billing (05 Finance)
      // ================================================================
      case 'disbursements_awaiting_billing': {
        const unbilledDisbs = pmsAllDisbursements.filter((d) => d.billed_status === 'Unbilled');
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Unbilled disbursements — awaiting billing</h2>
                <span className="mono-code">PMS `disbursements`</span>
              </div>
              <span className="panel-subtitle">{formatGbp(firmUnbilledDisbNet)} net</span>
            </div>
            <div className="panel-body">
              {unbilledDisbs.length === 0 ? (
                <div className="panel-body padded muted">
                  No unbilled disbursements awaiting billing.
                </div>
              ) : (
                <ul className="worklist">
                  {unbilledDisbs.map((d) => (
                    <li key={d.disbursement_id} className="worklist-row">
                      <div className="worklist-main">
                        <div className="worklist-title">
                          <span>{d.description}</span>
                        </div>
                        <div className="worklist-meta">
                          <Link href={matterHrefForCode(d.matter_code)} className="mono-code">
                            {d.matter_code}
                          </Link>
                          <span>
                            · {d.supplier} · {formatDate(d.date)}
                          </span>
                        </div>
                      </div>
                      <div className="worklist-right">
                        <strong>
                          {formatGbp(d.net_amount)}{' '}
                          {d.vat_amount > 0 ? `+ £${d.vat_amount.toFixed(2)} VAT` : '(no VAT)'}
                        </strong>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        );
      }

      // ================================================================
      // 30. cash_collection_vs_target (05 Finance)
      // ================================================================
      case 'cash_collection_vs_target': {
        const octCash = pmsCashReceived.currentMonthTotal;
        const currentMonthFees =
          pmsMonthlyFeesBilled.months.find((m) => m.monthKey === currentMonthKey)?.feesNet ?? 0;
        const currentMonthInvoicesCount = pmsInvoices.filter((inv) =>
          inv.invoice_date.startsWith(currentMonthKey),
        ).length;
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Cash collection &amp; billing — {currentMonthYearLabel}</h2>
                <span className="mono-code">PMS `payments` + `invoices`</span>
              </div>
            </div>
            <div className="panel-body padded">
              <div style={{ marginBottom: 12 }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 12.5,
                    marginBottom: 4,
                  }}
                >
                  <span>
                    Cash receipts ({pmsCashReceived.currentMonthReceiptCount} payment
                    {pmsCashReceived.currentMonthReceiptCount === 1 ? '' : 's'})
                  </span>
                  <strong>{formatGbp(octCash)} · No target configured</strong>
                </div>
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 10,
                  fontSize: 12.5,
                }}
              >
                <div className="legend-item">
                  <div className="lbl">Fees billed in {currentMonthShort} (ex VAT)</div>
                  <div className="val">{formatGbp(currentMonthFees)}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {currentMonthInvoicesCount} invoice{currentMonthInvoicesCount === 1 ? '' : 's'} issued
                  </div>
                </div>
                <div className="legend-item">
                  <div className="lbl">Fees billed YTD (ex VAT)</div>
                  <div className="val">{formatGbp(pmsMonthlyFeesBilled.yearToDateTotal)}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {currentYearLabel} year to date
                  </div>
                </div>
              </div>
            </div>
          </section>
        );
      }

      // ================================================================
      // 31. aml_and_cdd_queue (06 Risk & Compliance)
      // ================================================================
      case 'aml_and_cdd_queue': {
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">AML &amp; Customer Due Diligence queue</h2>
                <StatusPill label="0 pending" tone="positive" />
              </div>
              <span className="panel-subtitle">MLR 2017 · ID&amp;V, SoF &amp; SoW checks</span>
            </div>
            <div className="panel-body">
              <div className="panel-body padded muted">
                No pending AML or Customer Due Diligence checks.
              </div>
            </div>
          </section>
        );
      }

      // ================================================================
      // 32. conflict_checks_awaiting_decision (06 Risk & Compliance)
      // ================================================================
      case 'conflict_checks_awaiting_decision': {
        const referredMatters = matters.filter(
          (m) =>
            m.conflictCheckRecord?.status === 'Referred' ||
            m.conflictDecision?.outcome === 'Potential conflict',
        );
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Conflict checks — awaiting MLRO / COLP decision</h2>
                <StatusPill
                  label={`${referredMatters.length} awaiting decision`}
                  tone={referredMatters.length > 0 ? 'warning' : 'positive'}
                />
              </div>
            </div>
            <div className="panel-body">
              {referredMatters.length === 0 ? (
                <div className="panel-body padded muted">
                  No conflict checks currently awaiting MLRO or COLP decision.
                </div>
              ) : (
                <ul className="worklist">
                  {referredMatters.map((m) => (
                    <li key={m.id} className="worklist-row">
                      <div className="worklist-main">
                        <div className="worklist-title">
                          <StatusPill label="Referred" tone="warning" />
                          <Link href={`/matters/${m.id}`}>
                            {m.matterNumber} — {m.title}
                          </Link>
                        </div>
                        <div className="worklist-meta">
                          <span>
                            {m.conflictCheckRecord?.reviewerMessage || 'Awaiting compliance review'}
                          </span>
                        </div>
                      </div>
                      <div className="worklist-right">
                        <Link href={`/matters/${m.id}`} className="btn btn--secondary btn--sm">
                          Open matter
                        </Link>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        );
      }

      // ================================================================
      // 33. high_risk_matters_and_pep_register (06 Risk & Compliance)
      // ================================================================
      case 'high_risk_matters_and_pep_register': {
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">High-risk matters, PEPs &amp; sanctions watch</h2>
                <StatusPill label="0 matters" tone="neutral" />
              </div>
            </div>
            <div className="panel-body" style={{ overflowX: 'auto' }}>
              <div className="panel-body padded muted">
                No high-risk matters, PEPs or sanctions alerts recorded.
              </div>
            </div>
          </section>
        );
      }

      // ================================================================
      // 34. undertakings_and_file_reviews (06 Risk & Compliance)
      // ================================================================
      case 'undertakings_and_file_reviews': {
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Undertakings &amp; periodic file reviews</h2>
              </div>
            </div>
            <div className="panel-body">
              <div className="panel-body padded muted">
                No open undertakings or scheduled periodic file reviews.
              </div>
            </div>
          </section>
        );
      }

      // ================================================================
      // 35. complaints_incidents_and_breaches (06 Risk & Compliance)
      // ================================================================
      case 'complaints_incidents_and_breaches': {
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">
                  Complaints, SRA breaches &amp; residual balances
                </h2>
              </div>
            </div>
            <div className="panel-body">
              <div className="panel-body padded muted">
                No open complaints, SRA breaches or residual balance alerts.
              </div>
            </div>
          </section>
        );
      }

      // ================================================================
      // 36. overdue_compliance_tasks_by_team (06 Risk & Compliance)
      // ================================================================
      case 'overdue_compliance_tasks_by_team': {
        const teamComplianceRows = teams
          .filter((tm) => tm.active)
          .map((tm) => {
            const teamTasks = tasks.filter(
              (t) =>
                isTaskOpen(t) &&
                t.assignedTeamId === tm.id &&
                (t.taskTypeId === 'task_type.compliance' ||
                  t.title.toLowerCase().includes('aml') ||
                  t.title.toLowerCase().includes('cdd') ||
                  t.title.toLowerCase().includes('conflict')),
            );
            const overdue = teamTasks.filter((t) => t.dueAt < todayIso).length;
            const dueThisWeek = teamTasks.filter(
              (t) => t.dueAt >= todayIso && t.dueAt <= next7DaysIso,
            ).length;
            return { team: tm, overdue, dueThisWeek };
          })
          .filter((r) => r.overdue > 0 || r.dueThisWeek > 0);
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Overdue compliance &amp; onboarding tasks by team</h2>
              </div>
            </div>
            <div className="panel-body">
              {teamComplianceRows.length === 0 ? (
                <div className="panel-body padded muted">
                  No overdue compliance or onboarding tasks across teams.
                </div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Team</th>
                      <th className="num">Overdue</th>
                      <th className="num">Due this week</th>
                      <th className="num">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {teamComplianceRows.map(({ team, overdue, dueThisWeek }) => (
                      <tr key={team.id}>
                        <td>{team.name}</td>
                        <td className="num">
                          <StatusPill
                            label={`${overdue}`}
                            tone={overdue > 0 ? 'alert' : 'neutral'}
                          />
                        </td>
                        <td className="num">{dueThisWeek}</td>
                        <td className="num">
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={async () => {
                              const res = await remindTeamLeadOverdueComplianceAction(team.id);
                              if (isActionDenied(res)) {
                                showToast(res.message);
                                return;
                              }
                              showToast(`Sent compliance reminder for ${team.name}.`);
                            }}
                          >
                            Remind team lead
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        );
      }

      // ================================================================
      // 37. firm_financial_pulse (07 Managing Partner)
      // ================================================================
      case 'firm_financial_pulse': {
        const months = pmsMonthlyFeesBilled.months;
        const maxMonth = Math.max(...months.map((m) => m.feesNet), 45000);
        const clientAccountMatterCount = allMatterFins.filter(
          (m) => m.client_account_balance > 0,
        ).length;
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Firm financial pulse — {currentYearLabel} year to date</h2>
                <span className="mono-code">
                  PMS `invoices`, `payments`, `v_matter_financials`
                </span>
              </div>
              <span className="panel-subtitle">
                Net of credit notes · ex VAT · as at {formattedAsAt}
              </span>
            </div>
            <div className="panel-body padded">
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
                Monthly fees billed ({currentYearLabel}) · Total YTD:{' '}
                <strong>{formatGbp(pmsMonthlyFeesBilled.yearToDateTotal)}</strong>
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(10, 1fr)',
                  gap: 6,
                  alignItems: 'end',
                  height: 110,
                  paddingTop: 12,
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                {months.map((m) => {
                  const h =
                    m.feesNet > 0 ? Math.max(Math.round((m.feesNet / maxMonth) * 74), 8) : 3;
                  const shortVal =
                    m.feesNet > 0 ? `£${(m.feesNet / 1000).toFixed(1)}k` : '—';
                  const isCurrent = m.monthKey === currentMonthKey;
                  return (
                    <div key={m.monthKey} style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{shortVal}</div>
                      <div
                        style={{
                          height: h,
                          background: isCurrent
                            ? '#16A34A'
                            : m.feesNet > 0
                              ? 'var(--color-primary)'
                              : 'var(--border-subtle)',
                          borderRadius: '4px 4px 0 0',
                          margin: '4px auto 0',
                          width: '72%',
                        }}
                      />
                    </div>
                  );
                })}
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(10, 1fr)',
                  gap: 6,
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  textAlign: 'center',
                  marginTop: 4,
                }}
              >
                {months.map((m) => (
                  <div
                    key={m.monthKey}
                    style={
                      m.monthKey === currentMonthKey
                        ? { fontWeight: 700, color: 'var(--text-primary)' }
                        : undefined
                    }
                  >
                    {m.monthShort}
                  </div>
                ))}
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, 1fr)',
                  gap: 10,
                  marginTop: 14,
                }}
              >
                <div className="legend-item">
                  <div className="lbl">Total lockup (WIP + debt)</div>
                  <div className="val">{formatGbp(firmWipTotal + firmTotalDebt)}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {formatGbp(firmWipTotal)} WIP + {formatGbp(firmTotalDebt)} debt
                  </div>
                </div>
                <div className="legend-item">
                  <div className="lbl">Cash collected</div>
                  <div className="val">{formatGbp(pmsCashReceived.currentMonthTotal)}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {pmsCashReceived.currentMonthReceiptCount} receipt
                    {pmsCashReceived.currentMonthReceiptCount === 1 ? '' : 's'}
                  </div>
                </div>
                <div className="legend-item">
                  <div className="lbl">Client account held</div>
                  <div className="val">{formatGbp(firmClientAccountHeld)}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Across {clientAccountMatterCount} active matter
                    {clientAccountMatterCount === 1 ? '' : 's'}
                  </div>
                </div>
                <div className="legend-item">
                  <div className="lbl">Overdue debt</div>
                  <div className="val">{formatGbp(firmOverdueDebt)}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Past due date
                  </div>
                </div>
              </div>
            </div>
          </section>
        );
      }

      // ================================================================
      // 38. performance_by_department (07 Managing Partner)
      // ================================================================
      case 'performance_by_department': {
        const { departments, firmTotal } = pmsDepartmentFinancials;
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Performance by practice area</h2>
                <span className="mono-code">
                  PMS `v_matter_financials` + `v_fee_earner_performance`
                </span>
              </div>
              <span className="panel-subtitle">{currentYearLabel} YTD · as at {formattedAsAt}</span>
            </div>
            <div className="panel-body" style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Practice area</th>
                    <th className="num">Open matters</th>
                    <th className="num">Fees billed YTD</th>
                    <th className="num">Unbilled WIP</th>
                    <th className="num">Outstanding debt</th>
                    <th className="num">Overdue debt</th>
                    <th className="num">{currentMonthShort} hrs</th>
                  </tr>
                </thead>
                <tbody>
                  {departments.map((d) => (
                    <tr key={d.practiceArea}>
                      <td>
                        <strong>{d.practiceArea}</strong>
                      </td>
                      <td className="num">{d.openMatters}</td>
                      <td className="num">
                        <strong>{formatGbp(d.billedThisYear)}</strong>
                      </td>
                      <td className="num">{formatGbp(d.unbilledWip)}</td>
                      <td className="num">{formatGbp(d.outstandingDebt)}</td>
                      <td className="num">
                        {d.overdueDebt > 0 ? (
                          <StatusPill
                            label={formatGbp(d.overdueDebt)}
                            tone={d.overdueDebt >= 4000 ? 'alert' : 'warning'}
                          />
                        ) : (
                          '£0.00'
                        )}
                      </td>
                      <td className="num">{d.currentMonthHours.toFixed(1)} h</td>
                    </tr>
                  ))}
                  <tr style={{ background: 'var(--bg-subtle)', fontWeight: 700 }}>
                    <td>{firmTotal.practiceArea}</td>
                    <td className="num">{firmTotal.openMatters}</td>
                    <td className="num">{formatGbp(firmTotal.billedThisYear)}</td>
                    <td className="num">{formatGbp(firmTotal.unbilledWip)}</td>
                    <td className="num">{formatGbp(firmTotal.outstandingDebt)}</td>
                    <td className="num">{formatGbp(firmTotal.overdueDebt)}</td>
                    <td className="num">{firmTotal.currentMonthHours.toFixed(1)} h</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        );
      }

      // ================================================================
      // 39. utilisation_and_realisation_by_grade (07 Managing Partner)
      // ================================================================
      case 'utilisation_and_realisation_by_grade': {
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Fee earner utilisation &amp; billing</h2>
                <span className="mono-code">PMS `v_fee_earner_performance`</span>
              </div>
              <span className="panel-subtitle">As at {formattedAsAt}</span>
            </div>
            <div className="panel-body" style={{ overflowX: 'auto' }}>
              {allFeeEarnerPerformance.length === 0 ? (
                <div className="panel-body padded muted">
                  No fee earner performance data recorded.
                </div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Fee earner</th>
                      <th>Department · Grade</th>
                      <th className="num">{currentMonthShort} hrs</th>
                      <th className="num">YTD hrs</th>
                      <th className="num">% target</th>
                      <th className="num">Billed value</th>
                      <th className="num">Unbilled WIP</th>
                      <th className="num">Written off</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allFeeEarnerPerformance.map((fe) => (
                      <tr key={fe.fee_earner_id}>
                        <td>
                          <strong>{fe.name}</strong>
                        </td>
                        <td>
                          {fe.department} · {fe.grade} (£{fe.standard_hourly_rate}/h)
                        </td>
                        <td className="num">{fe.chargeable_hours_this_month.toFixed(1)}</td>
                        <td className="num">{fe.chargeable_hours.toFixed(1)}</td>
                        <td className="num">{(fe.pct_of_annual_target * 100).toFixed(1)}%</td>
                        <td className="num">{formatGbp(fe.billed_value)}</td>
                        <td className="num">
                          <strong>{formatGbp(fe.unbilled_wip)}</strong>
                        </td>
                        <td className="num">{formatGbp(fe.written_off)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        );
      }

      // ================================================================
      // 40. enquiries_conversion_and_pipeline (07 Managing Partner)
      // ================================================================
      case 'enquiries_conversion_and_pipeline': {
        const totalEnqs = enquiries.length;
        const convCount = enquiries.filter((e) => e.status === 'Converted').length;
        const convPct = totalEnqs > 0 ? Math.round((convCount / totalEnqs) * 100) : 0;
        const enquiriesWithDue = enquiries.filter((e) => Boolean(e.firstContactDueAt));
        const slaMetCount = enquiriesWithDue.filter((e) => {
          const firstContactAt = e.contactLog[0]?.at;
          if (firstContactAt && e.firstContactDueAt) {
            return firstContactAt <= e.firstContactDueAt;
          }
          return e.firstContactDueAt ? e.firstContactDueAt.slice(0, 10) >= todayIso : false;
        }).length;
        const slaMetPct =
          enquiriesWithDue.length > 0
            ? `${Math.round((slaMetCount / enquiriesWithDue.length) * 100)}%`
            : '—';
        const overdueSlaCount = enquiries.filter(
          (e) =>
            isEnquiryOpen(e) &&
            e.firstContactDueAt &&
            e.firstContactDueAt.slice(0, 10) < todayIso &&
            e.contactLog.length === 0,
        ).length;
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">
                  New business — enquiries, conversion &amp; SLA health
                </h2>
              </div>
              <span className="panel-subtitle">{currentMonthYearLabel}</span>
            </div>
            <div className="panel-body padded">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                <div className="legend-item">
                  <div className="lbl">Enquiries ({currentMonthShort})</div>
                  <div className="val">{totalEnqs}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Current month</div>
                </div>
                <div className="legend-item">
                  <div className="lbl">Converted to matters</div>
                  <div className="val" style={{ color: 'var(--green-text)' }}>
                    {convCount} ({convPct}%)
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Conversion rate</div>
                </div>
                <div className="legend-item">
                  <div className="lbl">First-contact SLA met</div>
                  <div className="val">{slaMetPct}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {overdueSlaCount} overdue
                  </div>
                </div>
              </div>
            </div>
          </section>
        );
      }

      // ================================================================
      // 41. top_clients_and_concentration (07 Managing Partner)
      // ================================================================
      case 'top_clients_and_concentration': {
        const topClients = [...allClientFins]
          .filter((c) => c.fees_billed_ytd > 0 || c.unbilled_wip > 0)
          .sort((a, b) => b.fees_billed_ytd - a.fees_billed_ytd)
          .slice(0, 6);
        const totalBilled = pmsMonthlyFeesBilled.yearToDateTotal;
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">
                  Top clients by fees billed &amp; total exposure
                </h2>
                <span className="mono-code">PMS `v_client_financials`</span>
              </div>
            </div>
            <div className="panel-body" style={{ overflowX: 'auto' }}>
              {topClients.length === 0 ? (
                <div className="panel-body padded muted">
                  No client billing or exposure data recorded.
                </div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Client</th>
                      <th className="num">Fees billed YTD</th>
                      <th className="num">Share</th>
                      <th className="num">WIP + Debt</th>
                      <th>Credit limit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topClients.map((c) => {
                      const sharePct =
                        totalBilled > 0
                          ? Math.round((c.fees_billed_ytd / totalBilled) * 1000) / 10
                          : 0;
                      const usedPct =
                        c.credit_limit_used_pct !== null
                          ? Math.round(c.credit_limit_used_pct * 1000) / 10
                          : null;
                      return (
                        <tr key={c.client_code}>
                          <td>
                            <Link href={clientHrefForCode(c.client_code)}>
                              <strong>{c.client_name}</strong>
                            </Link>
                          </td>
                          <td className="num">
                            <strong>{formatGbp(c.fees_billed_ytd)}</strong>
                          </td>
                          <td className="num">{sharePct.toFixed(1)}%</td>
                          <td className="num">
                            {formatGbp(c.unbilled_wip + c.outstanding_debt)}
                          </td>
                          <td>
                            {usedPct !== null ? (
                              <StatusPill
                                label={`${usedPct.toFixed(1)}% of £${(c.credit_limit / 1000).toFixed(0)}k`}
                                tone={usedPct >= 65 ? 'warning' : 'positive'}
                              />
                            ) : (
                              <StatusPill label="No limit" tone="neutral" />
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        );
      }

      // ================================================================
      // 42. firm_risk_and_exceptions_register (07 Managing Partner)
      // ================================================================
      case 'firm_risk_and_exceptions_register': {
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">
                  Exceptions — financial, compliance &amp; operational
                </h2>
                <StatusPill label="0 items" tone="positive" />
              </div>
            </div>
            <div className="panel-body">
              <div className="panel-body padded muted">
                No financial, compliance or operational exceptions flagged.
              </div>
            </div>
          </section>
        );
      }

      default:
        return null;
    }
  }

  const displayPerson = effectiveWorkPerson;
  const greetingName = displayPerson.preferredName || displayPerson.firstName;
  const currentHour = new Date().getHours();
  const greetingPrefix =
    currentHour < 12 ? 'Good morning' : currentHour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="role-home-page">
      {/* Centered Greeting & Prominent Search Bar */}
      <div className="hero-home">
        <h1 className="hero-greeting" suppressHydrationWarning>
          {greetingPrefix}, {greetingName}
        </h1>
        <HeroHomeSearch searchIndex={searchIndex} />
        {canApproveTemplates && pendingTemplateApprovalsCount > 0 ? (
          <div style={{ marginTop: 10, display: 'flex', justifyContent: 'center' }}>
            <Link
              href="/admin/document-templates"
              className="btn btn--secondary btn--sm"
              style={{
                borderRadius: 999,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12.5,
              }}
            >
              <FileText size={13} />
              <span>
                {pendingTemplateApprovalsCount} document template{' '}
                {pendingTemplateApprovalsCount === 1 ? 'version' : 'versions'} awaiting approval
              </span>
            </Link>
          </div>
        ) : null}
      </div>

      {/* Two-column configurable Panel Grid (Main ~65–72%, Summary ~25–28% matching Enquiries layout) */}
      <div className="home-grid">
        <div className="home-col" data-testid="home-primary-column">
          {/* Headline KPI Strip (placed at the top of the main ~65% column) */}
          {roleConfig.headlineCardIds.length > 0 ? (
            <div className="kpi-strip">
              {roleConfig.headlineCardIds.slice(0, 5).map((cid) => renderHeadlineCard(cid))}
            </div>
          ) : null}
          {roleConfig.primaryPanels.map((pid) => renderPanel(pid, 'primary'))}
        </div>
        <div className="home-col" data-testid="home-summary-column">
          {roleConfig.summaryPanels.map((pid) => renderPanel(pid, 'summary'))}
        </div>
      </div>

      {/* Inline Log Contact Modal */}
      {logModalEnq ? (
        <div className="modal-backdrop" onClick={() => setLogModalEnq(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>
                Log contact — {logModalEnq.reference} ({enquiryDisplayName(logModalEnq)})
              </h2>
            </div>
            <form onSubmit={handleSubmitContactLog}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label className="field-label">Method</label>
                  <select
                    className="select"
                    value={logMethod}
                    onChange={(e) => setLogMethod(e.target.value as ContactLogMethod)}
                  >
                    <option value="Call">Call</option>
                    <option value="Email">Email</option>
                    <option value="Voicemail">Voicemail</option>
                    <option value="Meeting">Meeting</option>
                  </select>
                </div>
                <div>
                  <label className="field-label">Outcome</label>
                  <select
                    className="select"
                    value={logOutcome}
                    onChange={(e) => setLogOutcome(e.target.value as ContactLogOutcome)}
                  >
                    <option value="Spoke">Spoke</option>
                    <option value="Left message">Left message</option>
                    <option value="No answer">No answer</option>
                    <option value="Email sent">Email sent</option>
                  </select>
                </div>
              </div>
              <div style={{ marginTop: 12 }}>
                <label className="field-label">Call / contact note</label>
                <textarea
                  className="textarea"
                  rows={3}
                  value={logNote}
                  onChange={(e) => setLogNote(e.target.value)}
                  placeholder="Summary of call or message left..."
                />
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => setLogModalEnq(null)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn--primary">
                  Save contact log
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* Partner Sign-Off Discussion Modal */}
      {discussSignOffItem ? (
        <div className="modal-backdrop" onClick={() => setDiscussSignOffItem(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Discuss sign-off — {discussSignOffItem.title}</h2>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const res = await discussSignOffAction(discussSignOffItem.id, discussNote);
                if (isActionDenied(res)) {
                  showToast(res.message);
                  return;
                }
                showToast(`Sent discussion task to requester on ${discussSignOffItem.matterNumber}`);
                setDiscussSignOffItem(null);
                router.refresh();
              }}
            >
              <div>
                <label className="field-label">Note / question for fee earner</label>
                <textarea
                  className="textarea"
                  rows={3}
                  value={discussNote}
                  onChange={(e) => setDiscussNote(e.target.value)}
                  placeholder="Add a note for the fee earner before approving..."
                  required
                />
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => setDiscussSignOffItem(null)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn--primary">
                  Send &amp; create review task
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
