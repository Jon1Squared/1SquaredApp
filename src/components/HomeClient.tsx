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
  octoberTotal: 0,
  octoberReceiptCount: 0,
  septemberTotal: 0,
  septemberReceiptCount: 0,
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
    octoberHours: 0,
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
  pmsAsAtDate = '2026-10-16',
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

  const hasDemoSeedData = useMemo(
    () =>
      matters.some(
        (m) =>
          m.matterNumber === 'PEN001-0001' ||
          m.matterNumber === 'PRI001-0001' ||
          m.matterNumber === 'TGL001-0002',
      ) || allMatterFins.length > 0,
    [matters, allMatterFins.length],
  );

  // Quick enquiry capture state (Panel 13 - Enquiries Coordinator)
  const [qFirstName, setQFirstName] = useState(hasDemoSeedData ? 'Gareth' : '');
  const [qLastName, setQLastName] = useState(hasDemoSeedData ? 'Hughes' : '');
  const [qOnBehalf, setQOnBehalf] = useState(
    hasDemoSeedData ? 'Hughes Lloyd Accountants LLP' : '',
  );
  const [qPhone, setQPhone] = useState(hasDemoSeedData ? '029 2018 0740' : '');
  const [qEmail, setQEmail] = useState(
    hasDemoSeedData ? 'gareth.hughes@hugheslloyd.co.uk' : '',
  );
  const [qChannelId, setQChannelId] = useState('enquiry_channel.phone');
  const [qPracticeAreaId, setQPracticeAreaId] = useState('work_type.real_estate_and_property');
  const [qUrgencyId, setQUrgencyId] = useState('enquiry_urgency.urgent');
  const [qBestTime, setQBestTime] = useState(hasDemoSeedData ? 'Before 16:30 today' : '');
  const [qSummary, setQSummary] = useState(
    hasDemoSeedData
      ? 'Referral: commercial freehold acquisition on Cowbridge Road for mutual client (~£950k)'
      : '',
  );
  const [qOtherParties, setQOtherParties] = useState(
    hasDemoSeedData ? 'Vendor: Vale Retail Estates Ltd; Lender: Principality Commercial' : '',
  );
  const [qPrivacyGiven, setQPrivacyGiven] = useState(true);
  const [qLinkExistingId, setQLinkExistingId] = useState<string | null>(
    hasDemoSeedData ? 'P-000011' : null,
  );

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
  const formattedAsAt = useMemo(() => formatDate(pmsAsAtDate) || '16 Oct 2026', [pmsAsAtDate]);

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
    const explicit =
      effectiveWorkPerson.supportsIds && effectiveWorkPerson.supportsIds.length > 0
        ? effectiveWorkPerson.supportsIds
        : currentUser.supportsIds && currentUser.supportsIds.length > 0
          ? currentUser.supportsIds
          : hasDemoSeedData
            ? ['P-000001', 'P-000002']
            : [];
    return explicit;
  }, [effectiveWorkPerson.supportsIds, currentUser.supportsIds, hasDemoSeedData]);

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
    const partnerId =
      activeRoleKey === 'partner' || activeRoleKey === 'managing_partner'
        ? effectiveWorkPerson.id
        : 'P-000001';
    const list = matters.filter(
      (m) =>
        m.matterStatusId !== 'matter_status.closed' &&
        (m.supervisingPartnerId === partnerId || m.responsiblePartnerId === partnerId),
    );
    return list.length > 0
      ? list
      : matters.filter((m) => m.matterStatusId !== 'matter_status.closed');
  }, [matters, effectiveWorkPerson.id, activeRoleKey]);

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
            <div className="kpi-sub">
              {hasDemoSeedData
                ? '1 urgent callback · 1 follow-up'
                : `${myOpenEnquiries.length} open assigned`}
            </div>
          </div>
        );
      }
      case 'fe_active_matters': {
        const count = hasDemoSeedData ? myActiveMatters.length || 5 : myActiveMatters.length;
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>My active matters</span>
              {hasDemoSeedData ? <StatusPill label="1 at 90% est." tone="warning" /> : null}
            </div>
            <div className="kpi-value">{count}</div>
            <div className="kpi-sub">
              {hasDemoSeedData ? '4 lead · 1 team member' : `${count} active matters`}
            </div>
          </div>
        );
      }
      case 'fe_hours_month': {
        const mtd =
          myWeeklyTime?.monthToDateHours ??
          myFeeEarnerFigures?.chargeable_hours_this_month ??
          (hasDemoSeedData ? 12.6 : 0);
        const ytd = myFeeEarnerFigures?.chargeable_hours ?? (hasDemoSeedData ? 38.4 : 0);
        const target = myFeeEarnerFigures?.annual_target_hours ?? 1200;
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Chargeable hrs (Oct)</span>
              <span className="mono-code">PMS</span>
            </div>
            <div className="kpi-value">{mtd.toFixed(1)} h</div>
            <div className="kpi-sub">
              {ytd.toFixed(1)} h YTD of {target.toLocaleString('en-GB')} h annual target
            </div>
          </div>
        );
      }
      case 'fe_unbilled_wip': {
        const wip =
          myWeeklyTime?.myUnbilledWip ??
          myFeeEarnerFigures?.unbilled_wip ??
          (hasDemoSeedData ? 9042.9 : 0);
        const count = myWeeklyTime?.myUnbilledMatterCount ?? (hasDemoSeedData ? 5 : 0);
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>My unbilled WIP</span>
              <span className="mono-code">PMS</span>
            </div>
            <div className="kpi-value">{formatGbp(wip)}</div>
            <div className="kpi-sub">
              {hasDemoSeedData
                ? `Across ${count} matters · oldest 7 Sep`
                : `Across ${count} matters`}
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
              {hasDemoSeedData ? <StatusPill label="3 need attention" tone="warning" /> : null}
            </div>
            <div className="kpi-value">{supervisedMatters.length} open</div>
            <div className="kpi-sub">
              {hasDemoSeedData
                ? '2 closed in 2026 · 1 pending opening'
                : `${matters.filter((m) => m.matterStatusId === 'matter_status.closed').length} closed`}
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
            <div className="kpi-value">
              {hasDemoSeedData ? '£20,308.00' : formatGbp(firmWipTotal)}
            </div>
            <div className="kpi-sub">
              {hasDemoSeedData ? '£6,390.00 over 30 days old' : `${allMatterFins.length} matters`}
            </div>
          </div>
        );
      case 'pt_overdue_debt':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Overdue client debt</span>
              {hasDemoSeedData ? <StatusPill label="1 at 90+ days" tone="alert" /> : null}
            </div>
            <div className="kpi-value">
              {hasDemoSeedData ? '£5,644.20' : formatGbp(firmOverdueDebt)}
            </div>
            <div className="kpi-sub">
              {hasDemoSeedData
                ? 'Across 4 bills · £18,454.02 total debt'
                : `Across ${overdueBillsCount} bills · ${formatGbp(firmTotalDebt)} total debt`}
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
              {hasDemoSeedData
                ? '1 write-off · 1 high-risk opening · 1 undertaking'
                : pendingSignOffs.length === 0
                  ? 'All sign-offs up to date'
                  : `${pendingSignOffs.length} pending partner review`}
            </div>
          </div>
        );
      case 'pt_enquiries_month':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Dept enquiries (Oct)</span>
              {hasDemoSeedData ? <StatusPill label="57% conv." tone="positive" /> : null}
            </div>
            <div className="kpi-value">{hasDemoSeedData ? 7 : enquiries.length}</div>
            <div className="kpi-sub">
              {hasDemoSeedData
                ? '4 converted · 2 in contact · 1 unassigned'
                : `${convertedEnqsCount} converted · ${unassignedEnqsCount} unassigned`}
            </div>
          </div>
        );

      // 03 Legal Secretary
      case 'ls_tasks_queue':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Tasks in my queue</span>
              {hasDemoSeedData ? <StatusPill label="1 overdue" tone="alert" /> : null}
            </div>
            <div className="kpi-value">
              {hasDemoSeedData ? 6 : tasks.filter((t) => isTaskOpen(t)).length}
            </div>
            <div className="kpi-sub">
              {hasDemoSeedData
                ? '3 assigned to me · 3 in Real Estate queue'
                : `${myOpenTasks.length} assigned to me`}
            </div>
          </div>
        );
      case 'ls_letters_docs':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Letters & docs to prepare</span>
              {hasDemoSeedData ? <StatusPill label="2 due today" tone="warning" /> : null}
            </div>
            <div className="kpi-value">{hasDemoSeedData ? 4 : 0}</div>
            <div className="kpi-sub">
              {hasDemoSeedData
                ? '1 engagement letter · 1 non-engagement · 2 packs'
                : 'No pending correspondence'}
            </div>
          </div>
        );
      case 'ls_matter_openings':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Matter openings in progress</span>
              {hasDemoSeedData ? <StatusPill label="2 awaiting client" tone="warning" /> : null}
            </div>
            <div className="kpi-value">
              {hasDemoSeedData
                ? 3
                : matters.filter((m) => m.matterStatusId === 'matter_status.opening').length}
            </div>
            <div className="kpi-sub">AML, engagement letter & retainer checks</div>
          </div>
        );
      case 'ls_completions_7d':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Completions next 7 days</span>
              {hasDemoSeedData ? <StatusPill label="Fri 23 Oct" tone="neutral" /> : null}
            </div>
            <div className="kpi-value">{hasDemoSeedData ? 1 : 0}</div>
            <div className="kpi-sub">
              {hasDemoSeedData
                ? 'PRI001-0001 · £84,943.60 in client a/c'
                : 'No completions scheduled'}
            </div>
          </div>
        );
      case 'ls_unbilled_disb':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Unbilled disbursements</span>
              <span className="mono-code">PMS</span>
            </div>
            <div className="kpi-value">
              {hasDemoSeedData ? '£682.00' : formatGbp(firmUnbilledDisbNet)}
            </div>
            <div className="kpi-sub">
              {hasDemoSeedData
                ? '3 items on supported matters'
                : `${unbilledDisbsList.length} items`}
            </div>
          </div>
        );

      // 04 Enquiries Coordinator
      case 'ec_callbacks_due':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Callbacks due today</span>
              {hasDemoSeedData ? <StatusPill label="1 overdue" tone="alert" /> : null}
            </div>
            <div className="kpi-value">{hasDemoSeedData ? 5 : openEnqsCount}</div>
            <div className="kpi-sub">
              {hasDemoSeedData
                ? '1 emergency · 2 urgent · 2 standard'
                : `${openEnqsCount} open enquiries`}
            </div>
          </div>
        );
      case 'ec_unassigned':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Unassigned enquiries</span>
              {unassignedEnqsCount > 0 ? <StatusPill label="Needs owner" tone="warning" /> : null}
            </div>
            <div className="kpi-value">{hasDemoSeedData ? 3 : unassignedEnqsCount}</div>
            <div className="kpi-sub">
              {hasDemoSeedData
                ? '1 Real Estate · 1 Employment · 1 Family'
                : `${unassignedEnqsCount} awaiting assignment`}
            </div>
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
            <div className="kpi-value">{hasDemoSeedData ? 3 : awaitingCount}</div>
            <div className="kpi-sub">Assigned but first contact not yet logged</div>
          </div>
        );
      }
      case 'ec_converted_month':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Converted in October</span>
              {hasDemoSeedData ? <StatusPill label="53% conv." tone="positive" /> : null}
            </div>
            <div className="kpi-value">
              {hasDemoSeedData ? '9 of 17' : `${convertedEnqsCount} of ${enquiries.length}`}
            </div>
            <div className="kpi-sub">
              {hasDemoSeedData
                ? '3 in contact · 3 declined/referred · 2 no resp.'
                : `${openEnqsCount} open`}
            </div>
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
            <div className="kpi-value">{hasDemoSeedData ? 1 : noRespCount}</div>
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
              {hasDemoSeedData ? (
                <StatusPill label="£3,300 at 90+d" tone="alert" />
              ) : overdueBillsCount > 0 ? (
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
              {hasDemoSeedData
                ? 'Across 8 open matters · oldest entry 2 Sep'
                : `Across ${wipMattersCount} open matter${wipMattersCount === 1 ? '' : 's'}`}
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
              {hasDemoSeedData
                ? '4 items (£1,416.00 inc VAT)'
                : `${unbilledDisbsList.length} item${unbilledDisbsList.length === 1 ? '' : 's'}`}
            </div>
          </div>
        );
      case 'fin_client_account':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Client account held</span>
              <StatusPill label="Reconciled" tone="positive" />
            </div>
            <div className="kpi-value">{formatGbp(firmClientAccountHeld)}</div>
            <div className="kpi-sub">
              {hasDemoSeedData
                ? 'PRI001-0001 (£84.9k) · PUG001-0001 (£33.5k)'
                : firmClientAccountHeld > 0
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
              {hasDemoSeedData ? <StatusPill label="1 overdue >5d" tone="alert" /> : null}
            </div>
            <div className="kpi-value">{hasDemoSeedData ? 4 : 0}</div>
            <div className="kpi-sub">
              {hasDemoSeedData
                ? '2 matters · 1 organisation · 1 individual'
                : 'No pending AML or ID checks'}
            </div>
          </div>
        );
      case 'rc_conflicts_pending':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Conflict checks awaiting sign-off</span>
              {hasDemoSeedData ? <StatusPill label="1 potential hit" tone="warning" /> : null}
            </div>
            <div className="kpi-value">{hasDemoSeedData ? 2 : 0}</div>
            <div className="kpi-sub">
              {hasDemoSeedData
                ? '1 matter opening · 1 new enquiry'
                : 'No conflict checks awaiting sign-off'}
            </div>
          </div>
        );
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
              {hasDemoSeedData ? <StatusPill label="EDD active" tone="neutral" /> : null}
            </div>
            <div className="kpi-value">{hasDemoSeedData ? 3 : highRiskCount}</div>
            <div className="kpi-sub">
              {hasDemoSeedData
                ? '1 offshore SPV · 1 PEP · 1 high-value lit.'
                : `${highRiskCount} high-risk open matter${highRiskCount === 1 ? '' : 's'}`}
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
              {hasDemoSeedData ? <StatusPill label="Across 3 teams" tone="warning" /> : null}
            </div>
            <div className="kpi-value">{hasDemoSeedData ? 5 : overdueComplianceCount}</div>
            <div className="kpi-sub">
              {hasDemoSeedData
                ? '2 Real Estate · 2 Employment · 1 Corporate'
                : `${overdueComplianceCount} overdue`}
            </div>
          </div>
        );
      }
      case 'rc_sra_breaches':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Open SRA breaches / complaints</span>
              <StatusPill label="No material breach" tone="positive" />
            </div>
            <div className="kpi-value">{hasDemoSeedData ? '1 / 1' : '0 / 0'}</div>
            <div className="kpi-sub">
              {hasDemoSeedData
                ? '1 stage-1 complaint · 1 minor residual review'
                : 'No open complaints or breaches'}
            </div>
          </div>
        );

      // 07 Managing Partner / Admin
      case 'mp_fees_ytd': {
        const octFeesVal =
          pmsMonthlyFeesBilled.months.find((m) => m.monthKey === '2026-10')?.feesNet ?? 0;
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Fees billed YTD (2026)</span>
              <span className="mono-code">PMS</span>
            </div>
            <div className="kpi-value">{formatGbp(pmsMonthlyFeesBilled.yearToDateTotal)}</div>
            <div className="kpi-sub">
              {formatGbp(octFeesVal)} billed in Oct · net of credit notes
            </div>
          </div>
        );
      }
      case 'mp_cash_month':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Cash received (Oct)</span>
              {hasDemoSeedData ? <StatusPill label="77% of £40k target" tone="positive" /> : null}
            </div>
            <div className="kpi-value">{formatGbp(pmsCashReceived.octoberTotal)}</div>
            <div className="kpi-sub">
              {pmsCashReceived.octoberReceiptCount} receipts · Sep was{' '}
              {formatGbp(pmsCashReceived.septemberTotal)}
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
              {hasDemoSeedData
                ? '£3,300.00 at 90+ days (1 bill)'
                : `${overdueBillsCount} overdue bill${overdueBillsCount === 1 ? '' : 's'}`}
            </div>
          </div>
        );
      case 'mp_open_matters':
        return (
          <div key={cardId} className="kpi-card">
            <div className="kpi-label">
              <span>Open matters & conversion</span>
              {hasDemoSeedData ? <StatusPill label="53% Oct conv." tone="positive" /> : null}
            </div>
            <div className="kpi-value">{hasDemoSeedData ? 11 : openMattersCount} open</div>
            <div className="kpi-sub">
              {hasDemoSeedData
                ? '9 of 17 Oct enquiries converted'
                : `${convertedEnqsCount} of ${enquiries.length} enquiries converted`}
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
                t.assignedTeamId === 'TM-000001'),
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
        // Show the fee earner's active PMS-backed matters
        const feCode = myWeeklyTime?.feeEarnerId ?? 'FE005';
        const pmsMattersForFe = allMatterFins.filter(
          (m) =>
            m.status === 'Open' &&
            (m.fee_earner_id === feCode ||
              m.matter_code === 'HAR001-0003' ||
              m.matter_code === 'PEN001-0002'),
        );
        const rows = pmsMattersForFe.length > 0 ? pmsMattersForFe : allMatterFins.slice(0, 5);
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
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '20px 12px' }}>
                        No active matters currently recorded.
                      </td>
                    </tr>
                  ) : rows.map((m) => {
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
                  })}
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
        const weekTotal = wt?.weekTotalHours ?? (hasDemoSeedData ? 7.6 : 0);
        const ytdHours = fePerf?.chargeable_hours ?? (hasDemoSeedData ? 38.4 : 0);
        const targetHours = fePerf?.annual_target_hours ?? 1200;
        const billedValue = fePerf?.billed_value ?? (hasDemoSeedData ? 1860 : 0);
        const myWip = wt?.myUnbilledWip ?? fePerf?.unbilled_wip ?? (hasDemoSeedData ? 9042.9 : 0);
        const readyToBill = hasDemoSeedData ? 2325 : 0;
        const weekdays =
          wt?.weekdays ??
          (hasDemoSeedData
            ? [
                { dayLabel: 'Mon', date: '2026-10-12', hours: 0.8 },
                { dayLabel: 'Tue', date: '2026-10-13', hours: 1.5 },
                { dayLabel: 'Wed', date: '2026-10-14', hours: 4.4 },
                { dayLabel: 'Thu', date: '2026-10-15', hours: 0.3 },
                { dayLabel: 'Fri', date: '2026-10-16', hours: 0.6 },
              ]
            : [
                { dayLabel: 'Mon', date: '2026-10-12', hours: 0 },
                { dayLabel: 'Tue', date: '2026-10-13', hours: 0 },
                { dayLabel: 'Wed', date: '2026-10-14', hours: 0 },
                { dayLabel: 'Thu', date: '2026-10-15', hours: 0 },
                { dayLabel: 'Fri', date: '2026-10-16', hours: 0 },
              ]);

        const weekPct = Math.min(Math.max((weekTotal / weeklyPace) * 100, 0), 100);
        const wipK = `£${(myWip / 1000).toFixed(1)}k`;
        const readyK = `£${(readyToBill / 1000).toFixed(1)}k`;
        const billedK = `£${(billedValue / 1000).toFixed(1)}k`;
        const billedFormatted = `£${Math.round(billedValue).toLocaleString('en-GB')}`;
        const readyWipPct = myWip > 0 ? Math.min(Math.max((readyToBill / myWip) * 100, 6), 100) : 0;
        const ytdTargetRatio =
          targetHours > 0 && ytdHours > 0 ? Math.min(Math.max(ytdHours / targetHours, 0.06), 1) : 0;

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
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Key dates &amp; deadlines (next 14 days)</h2>
              </div>
            </div>
            <div className="panel-body">
              {!hasDemoSeedData ? (
                <div className="panel-body padded muted">
                  No key dates or deadlines in the next 14 days.
                </div>
              ) : (
                <ul className="worklist">
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="Fri 23 Oct · 4 days" tone="warning" />
                        <Link href={matterHrefForCode('PRI001-0001')}>
                          Completion — Purchase of 14 Cathedral Road
                        </Link>
                      </div>
                      <div className="worklist-meta">
                        <span className="mono-code">PRI001-0001</span>
                        <span>· Owen &amp; Carys Price · £84,943.60 held on client account</span>
                      </div>
                    </div>
                  </li>
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="Tue 27 Oct · 8 days" tone="neutral" />
                        <Link href={matterHrefForCode('PEN001-0001')}>
                          Target exchange of lease — Unit 4, Cardiff Bay Retail Park
                        </Link>
                      </div>
                      <div className="worklist-meta">
                        <span className="mono-code">PEN001-0001</span>
                        <span>· Penarth Estates Ltd</span>
                      </div>
                    </div>
                  </li>
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="Fri 30 Oct · 11 days" tone="neutral" />
                        <Link href={matterHrefForCode('HAR001-0003')}>
                          s.106 unilateral undertaking sign-off with Cardiff Council
                        </Link>
                      </div>
                      <div className="worklist-meta">
                        <span className="mono-code">HAR001-0003</span>
                        <span>· Harbourline Housing Association</span>
                      </div>
                    </div>
                  </li>
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
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Waiting on client / third party</h2>
                <StatusPill label={hasDemoSeedData ? '3 items' : '0 items'} tone="neutral" />
              </div>
            </div>
            <div className="panel-body">
              {!hasDemoSeedData ? (
                <div className="panel-body padded muted">
                  No items currently waiting on clients or third parties.
                </div>
              ) : (
                <ul className="worklist">
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <Link href={matterHrefForCode('TGL001-0002')}>
                          Certified source-of-funds bank statements &amp; signed engagement letter
                        </Link>
                      </div>
                      <div className="worklist-meta">
                        <span className="mono-code">TGL001-0002</span>
                        <span>· Tŷ Glas Developments Ltd · Waiting 4 days</span>
                      </div>
                    </div>
                    <div className="worklist-right">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() =>
                          showToast('Sent chase reminder to Llinos Jenkins (Tŷ Glas Developments Ltd).')
                        }
                      >
                        Chase
                      </button>
                    </div>
                  </li>
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <Link href={matterHrefForCode('PEN001-0001')}>
                          Landlord instructions on rent deposit deed wording
                        </Link>
                      </div>
                      <div className="worklist-meta">
                        <span className="mono-code">PEN001-0001</span>
                        <span>· Alun Davies (Penarth Estates Ltd) · Waiting 5 days</span>
                      </div>
                    </div>
                    <div className="worklist-right">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() =>
                          showToast('Sent chase reminder to Alun Davies (Penarth Estates Ltd).')
                        }
                      >
                        Chase
                      </button>
                    </div>
                  </li>
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <Link href={matterHrefForCode('PEN001-0002')}>
                          Joint surveyor report from Cadwyn Surveying
                        </Link>
                      </div>
                      <div className="worklist-meta">
                        <span className="mono-code">PEN001-0002</span>
                        <span>· Dr Sarah Holt · Due next week</span>
                      </div>
                    </div>
                    <div className="worklist-right">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => showToast('Sent chase note to Dr Sarah Holt (Cadwyn Surveying).')}
                      >
                        Chase
                      </button>
                    </div>
                  </li>
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
              t.assignedTeamId === 'TM-000001'),
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
              {!hasDemoSeedData ? (
                <div className="panel-body padded muted">
                  No documents or correspondence currently queued.
                </div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Document / letter</th>
                      <th>Matter / Enquiry</th>
                      <th>Fee earner</th>
                      <th>Status</th>
                      <th className="num">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>
                        <div style={{ fontWeight: 600 }}>Non-engagement letter — Marcus Finch</div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                          Auto-generated when enquiry declined (conflict)
                        </div>
                      </td>
                      <td>
                        <span className="mono-code">ENQ-000006</span>
                      </td>
                      <td>Owain Jenkins</td>
                      <td>
                        <StatusPill label="Overdue 1d" tone="alert" />
                      </td>
                      <td className="num">
                        <Link href="/enquiries/ENQ-000006" className="btn btn--primary btn--sm">
                          Mark sent
                        </Link>
                      </td>
                    </tr>
                    <tr>
                      <td>
                        <div style={{ fontWeight: 600 }}>
                          Client care &amp; engagement letter (fixed fee)
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                          Plot 9, Parc Tŷ Glas acquisition
                        </div>
                      </td>
                      <td>
                        <Link href={matterHrefForCode('TGL001-0002')} className="mono-code">
                          TGL001-0002
                        </Link>
                      </td>
                      <td>Dafydd Evans</td>
                      <td>
                        <StatusPill label="Draft ready" tone="warning" />
                      </td>
                      <td className="num">
                        <Link
                          href={matterHrefForCode('TGL001-0002')}
                          className="btn btn--secondary btn--sm"
                        >
                          Send for sign
                        </Link>
                      </td>
                    </tr>
                    <tr>
                      <td>
                        <div style={{ fontWeight: 600 }}>
                          Completion statement &amp; engrossed TR1 transfer
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                          14 Cathedral Road — completion 23 Oct
                        </div>
                      </td>
                      <td>
                        <Link href={matterHrefForCode('PRI001-0001')} className="mono-code">
                          PRI001-0001
                        </Link>
                      </td>
                      <td>Dafydd Evans</td>
                      <td>
                        <StatusPill label="In progress" tone="neutral" />
                      </td>
                      <td className="num">
                        <Link
                          href={matterHrefForCode('PRI001-0001')}
                          className="btn btn--secondary btn--sm"
                        >
                          Open
                        </Link>
                      </td>
                    </tr>
                    <tr>
                      <td>
                        <div style={{ fontWeight: 600 }}>
                          Clean s.106 unilateral undertaking bundle
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                          To Cardiff Council legal department
                        </div>
                      </td>
                      <td>
                        <Link href={matterHrefForCode('HAR001-0003')} className="mono-code">
                          HAR001-0003
                        </Link>
                      </td>
                      <td>Rhian Morgan</td>
                      <td>
                        <StatusPill label="Awaiting partner" tone="neutral" />
                      </td>
                      <td className="num">
                        <Link
                          href={matterHrefForCode('HAR001-0003')}
                          className="btn btn--secondary btn--sm"
                        >
                          Prepare PDF
                        </Link>
                      </td>
                    </tr>
                  </tbody>
                </table>
              )}
            </div>
          </section>
        );
      }

      // ================================================================
      // 10. matter_openings_in_progress
      // ================================================================
      case 'matter_openings_in_progress': {
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
              {!hasDemoSeedData ? (
                <div className="panel-body padded muted">
                  No matter openings currently in progress.
                </div>
              ) : (
                <ul className="worklist">
                  <li className="worklist-row" style={{ gridTemplateColumns: '1fr' }}>
                    <div className="worklist-main">
                      <div
                        className="worklist-title"
                        style={{ justifyContent: 'space-between' }}
                      >
                        <span>
                          <span className="mono-code">TGL001-0002</span>{' '}
                          <Link href={matterHrefForCode('TGL001-0002')}>
                            <strong>Purchase of Plot 9, Parc Tŷ Glas</strong>
                          </Link>{' '}
                          — Tŷ Glas Developments Ltd
                        </span>
                        <StatusPill label="2 of 4 complete · High risk" tone="alert" />
                      </div>
                      <div className="onboarding-steps">
                        <div className="onb-step done">
                          <span>1. Conflict check</span>
                          <span>✓ Cleared</span>
                        </div>
                        <div className="onb-step alert">
                          <span>2. AML / EDD</span>
                          <span>Pending SoF</span>
                        </div>
                        <div className="onb-step warn">
                          <span>3. Engagement letter</span>
                          <span>Drafting</span>
                        </div>
                        <div className="onb-step warn">
                          <span>4. Retainer on a/c</span>
                          <span>Requested £5k</span>
                        </div>
                      </div>
                    </div>
                  </li>
                  <li className="worklist-row" style={{ gridTemplateColumns: '1fr' }}>
                    <div className="worklist-main">
                      <div
                        className="worklist-title"
                        style={{ justifyContent: 'space-between' }}
                      >
                        <span>
                          <span className="mono-code">HUG002-0001</span>{' '}
                          <Link href={matterHrefForCode('HUG002-0001')}>
                            <strong>Purchase of 18 Cathedral View, Pontcanna</strong>
                          </Link>{' '}
                          — Mared Hughes
                        </span>
                        <StatusPill label="3 of 4 complete" tone="warning" />
                      </div>
                      <div className="onboarding-steps">
                        <div className="onb-step done">
                          <span>1. Conflict check</span>
                          <span>✓ Cleared</span>
                        </div>
                        <div className="onb-step warn">
                          <span>2. AML / ID&amp;V</span>
                          <span>PoA awaited</span>
                        </div>
                        <div className="onb-step done">
                          <span>3. Engagement letter</span>
                          <span>✓ Signed</span>
                        </div>
                        <div className="onb-step done">
                          <span>4. Retainer on a/c</span>
                          <span>✓ £450 rec&apos;d</span>
                        </div>
                      </div>
                    </div>
                  </li>
                  <li className="worklist-row" style={{ gridTemplateColumns: '1fr' }}>
                    <div className="worklist-main">
                      <div
                        className="worklist-title"
                        style={{ justifyContent: 'space-between' }}
                      >
                        <span>
                          <span className="mono-code">JON002-0001</span>{' '}
                          <Link href={matterHrefForCode('JON002-0001')}>
                            <strong>Employment Tribunal claim — Sam Jones</strong>
                          </Link>{' '}
                          — Converted from ENQ-000003
                        </span>
                        <StatusPill label="2 of 4 complete" tone="warning" />
                      </div>
                      <div className="onboarding-steps">
                        <div className="onb-step done">
                          <span>1. Conflict check</span>
                          <span>✓ Cleared</span>
                        </div>
                        <div className="onb-step warn">
                          <span>2. AML / ID&amp;V</span>
                          <span>Pending</span>
                        </div>
                        <div className="onb-step warn">
                          <span>3. Engagement letter</span>
                          <span>Sent 16 Oct</span>
                        </div>
                        <div className="onb-step done">
                          <span>4. Retainer on a/c</span>
                          <span>N/A</span>
                        </div>
                      </div>
                    </div>
                  </li>
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
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Upcoming completions, filings &amp; key dates</h2>
                <span className="panel-subtitle">Supported fee earners</span>
              </div>
            </div>
            <div className="panel-body">
              {!hasDemoSeedData ? (
                <div className="panel-body padded muted">
                  No upcoming completions or filings in the next 7 days.
                </div>
              ) : (
                <ul className="worklist">
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="Fri 23 Oct" tone="warning" />
                        <Link href={matterHrefForCode('PRI001-0001')}>
                          Completion — 14 Cathedral Road (Owen &amp; Carys Price)
                        </Link>
                      </div>
                      <div className="worklist-meta">
                        <span className="mono-code">PRI001-0001</span>
                        <span>
                          · Dafydd Evans · £84,943.60 completion funds held · CHAPS requisition needed Thu
                        </span>
                      </div>
                    </div>
                  </li>
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="Tue 27 Oct" tone="neutral" />
                        <Link href={matterHrefForCode('PEN001-0001')}>
                          Agreement for lease exchange — Unit 4, Cardiff Bay Retail Park
                        </Link>
                      </div>
                      <div className="worklist-meta">
                        <span className="mono-code">PEN001-0001</span>
                        <span>· Dafydd Evans / Rhian Morgan · Engrossments to prepare</span>
                      </div>
                    </div>
                  </li>
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="Fri 30 Oct" tone="neutral" />
                        <Link href={matterHrefForCode('HAR001-0003')}>
                          s.106 unilateral undertaking execution — Butetown regeneration
                        </Link>
                      </div>
                      <div className="worklist-meta">
                        <span className="mono-code">HAR001-0003</span>
                        <span>· Rhian Morgan · Seal &amp; witness requirements</span>
                      </div>
                    </div>
                  </li>
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
        const teamDisbs = pmsAllDisbursements.filter(
          (d) =>
            d.billed_status === 'Unbilled' &&
            (d.matter_code === 'PEN001-0002' || d.matter_code === 'PRI001-0001'),
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
                                : `${urgLabel} · Due ${e.bestTimeToCall || '17:30 today'}`
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
                            onClick={() => handleTakeEnquiry(e, 'P-000002')}
                          >
                            Assign
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
                          <button
                            type="button"
                            className="btn btn--primary btn--sm"
                            onClick={() => handleTakeEnquiry(e, 'P-000002')}
                          >
                            Assign to Dafydd Evans
                          </button>
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
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
        const totalEnqs = hasDemoSeedData ? 17 : enquiries.length;
        const convCount = hasDemoSeedData
          ? 9
          : enquiries.filter((e) => e.status === 'Converted').length;
        const convPct = totalEnqs > 0 ? Math.round((convCount / totalEnqs) * 100) : 0;
        const openCount = hasDemoSeedData
          ? 3
          : enquiries.filter((e) => isEnquiryOpen(e)).length;
        const declinedCount = hasDemoSeedData
          ? 2
          : enquiries.filter((e) => e.status === 'Declined').length;
        const referredCount = hasDemoSeedData
          ? 1
          : enquiries.filter((e) => e.status === 'Referred out').length;
        const noRespCount = hasDemoSeedData
          ? 2
          : enquiries.filter((e) => e.status === 'No response').length;
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">This month&apos;s outcomes &amp; conversion</h2>
              </div>
              <span className="panel-subtitle">October 2026</span>
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
              {hasDemoSeedData ? (
                <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-secondary)' }}>
                  Declined &amp; referred-out enquiries automatically generated{' '}
                  <strong>3 non-engagement letter tasks</strong> (2 working-day rule).
                </div>
              ) : null}
            </div>
          </section>
        );
      }

      // ================================================================
      // 18. referral_sources_this_month (04 Enquiries Coordinator)
      // ================================================================
      case 'referral_sources_this_month': {
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Enquiry channels &amp; referral sources</h2>
              </div>
              <span className="panel-subtitle">October 2026</span>
            </div>
            <div className="panel-body">
              {!hasDemoSeedData ? (
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
                    <tr>
                      <td>Phone — direct &amp; existing clients</td>
                      <td className="num">6</td>
                      <td className="num">
                        <strong>4</strong>
                      </td>
                    </tr>
                    <tr>
                      <td>
                        Professional referrals (Gareth Hughes ·{' '}
                        <Link href="/organisations/O-000009">Hughes Lloyd</Link>)
                      </td>
                      <td className="num">4</td>
                      <td className="num">
                        <strong>3</strong>
                      </td>
                    </tr>
                    <tr>
                      <td>Website / Digital enquiry form</td>
                      <td className="num">5</td>
                      <td className="num">2</td>
                    </tr>
                    <tr>
                      <td>Walk-in / Cardiff reception</td>
                      <td className="num">2</td>
                      <td className="num">0</td>
                    </tr>
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
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Matters needing partner attention</h2>
                <StatusPill
                  label={hasDemoSeedData ? '4 matters' : '0 matters'}
                  tone={hasDemoSeedData ? 'warning' : 'neutral'}
                />
              </div>
              <span className="panel-subtitle">
                Estimate alerts · aged debt &gt;60d · high-risk / pending AML
              </span>
            </div>
            <div className="panel-body">
              {!hasDemoSeedData ? (
                <div className="panel-body padded muted">
                  No matters currently flagged for partner attention.
                </div>
              ) : (
                <ul className="worklist">
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="90+ days overdue (£3,300)" tone="alert" />
                        <Link href={matterHrefForCode('BAY001-0001')}>
                          New café lease — Mermaid Quay (Bay Side Cafés Ltd)
                        </Link>
                      </div>
                      <div className="worklist-meta">
                        <span className="mono-code">BAY001-0001</span>
                        <span>
                          · Lead: Dafydd Evans · Invoice PV-2026-009 (£3,300.00 inc VAT) due 14 Jul
                          2026 (94 days overdue)
                        </span>
                      </div>
                    </div>
                    <div className="worklist-right">
                      {finance.canCreditControl ? (
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          onClick={async () => {
                            const res = await recordInvoiceCreditControlActionAction({
                              invoiceNumber: 'PV-2026-009',
                              matterCode: 'BAY001-0001',
                              clientCode: 'BAY001',
                              actionType: 'escalate',
                            });
                            if (isActionDenied(res)) {
                              showToast(res.message);
                              return;
                            }
                            showToast('Assigned formal credit-control escalation on BAY001-0001.');
                            router.refresh();
                          }}
                        >
                          Assign chase
                        </button>
                      ) : null}
                      <Link
                        href={matterHrefForCode('BAY001-0001')}
                        className="btn btn--primary btn--sm"
                      >
                        Review matter
                      </Link>
                    </div>
                  </li>
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="At 90% of £18k estimate" tone="warning" />
                        <Link href={matterHrefForCode('PEN001-0002')}>
                          Rent review &amp; dilapidations — Units 1–3 Marina Parade (Penarth Estates
                          Ltd)
                        </Link>
                      </div>
                      <div className="worklist-meta">
                        <span className="mono-code">PEN001-0002</span>
                        <span>
                          · Lead: Aled Thomas · Time recorded £16,149.00 of £18,000.00 · Unbilled WIP
                          £4,569.00 + £726.00 overdue (32d)
                        </span>
                      </div>
                    </div>
                    <div className="worklist-right">
                      <Link
                        href={matterHrefForCode('PEN001-0002')}
                        className="btn btn--secondary btn--sm"
                      >
                        Revise estimate
                      </Link>
                      {finance.canCreditControl ? (
                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          onClick={async () => {
                            const res = await requestMatterBillAction('PEN001-0002');
                            if (isActionDenied(res)) {
                              showToast(res.message);
                              return;
                            }
                            showToast('Requested interim bill on PEN001-0002 (£4,569.00 WIP).');
                            router.refresh();
                          }}
                        >
                          Approve billing
                        </button>
                      ) : null}
                    </div>
                  </li>
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="High risk · AML &amp; SoF pending" tone="alert" />
                        <Link href={matterHrefForCode('TGL001-0002')}>
                          Purchase of Plot 9, Parc Tŷ Glas (Tŷ Glas Developments Ltd)
                        </Link>
                      </div>
                      <div className="worklist-meta">
                        <span className="mono-code">TGL001-0002</span>
                        <span>
                          · Lead: Dafydd Evans · Offshore SPV structure requires enhanced due
                          diligence before exchange
                        </span>
                      </div>
                    </div>
                    <div className="worklist-right">
                      <Link
                        href={matterHrefForCode('TGL001-0002')}
                        className="btn btn--primary btn--sm"
                      >
                        Open compliance
                      </Link>
                    </div>
                  </li>
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="WIP 44 days old (£6,390)" tone="warning" />
                        <Link href={matterHrefForCode('HAR001-0003')}>
                          Butetown regeneration — development agreement (Harbourline Housing Assoc.)
                        </Link>
                      </div>
                      <div className="worklist-meta">
                        <span className="mono-code">HAR001-0003</span>
                        <span>
                          · Lead: Rhian Morgan · £6,390.00 unbilled WIP from Sep/Oct · £1,620.00
                          invoice 18 days overdue
                        </span>
                      </div>
                    </div>
                    <div className="worklist-right">
                      {finance.canCreditControl ? (
                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          onClick={async () => {
                            const res = await requestMatterBillAction('HAR001-0003');
                            if (isActionDenied(res)) {
                              showToast(res.message);
                              return;
                            }
                            showToast('Raised billing task for HAR001-0003 (£6,390.00 WIP).');
                            router.refresh();
                          }}
                        >
                          Approve interim bill
                        </button>
                      ) : null}
                    </div>
                  </li>
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
        const teamFeCodes = ['FE001', 'FE003', 'FE004', 'FE005', 'FE006', 'FE008'];
        const rows = allFeeEarnerPerformance.filter((fe) =>
          teamFeCodes.includes(fe.fee_earner_id),
        );
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
                      <th className="num">Oct hrs</th>
                      <th>YTD hrs vs 1,200h target</th>
                      <th className="num">Unbilled WIP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((fe) => {
                      const pct = Math.round(fe.pct_of_annual_target * 1000) / 10;
                      const barWidth = Math.min(Math.round(pct * 5), 100);
                      return (
                        <tr key={fe.fee_earner_id}>
                          <td>
                            <strong>{fe.name}</strong>
                          </td>
                          <td>
                            {fe.grade} · £{fe.standard_hourly_rate}/hr
                          </td>
                          <td className="num">{fe.fee_earner_id === 'FE005' ? 4 : 2}</td>
                          <td className="num">
                            {fe.fee_earner_id === 'FE005' ? '6 (2 overdue)' : '2'}
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
              {!hasDemoSeedData ? (
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
                    <tr>
                      <td>
                        <Link href={matterHrefForCode('HAR001-0003')}>
                          <strong>HAR001-0003</strong>
                        </Link>{' '}
                        · Butetown regeneration
                      </td>
                      <td>Harbourline Housing Assoc.</td>
                      <td className="num">
                        <strong>£6,390.00</strong>
                      </td>
                      <td className="num">£0.00</td>
                      <td className="num">
                        <StatusPill label="£1,620.00 (18d)" tone="warning" />
                      </td>
                      <td className="num">
                        {finance.canCreditControl ? (
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            onClick={async () => {
                              const res = await requestMatterBillAction('HAR001-0003');
                              if (isActionDenied(res)) {
                                showToast(res.message);
                                return;
                              }
                              showToast('Requested bill on HAR001-0003.');
                              router.refresh();
                            }}
                          >
                            Request bill
                          </button>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                    <tr>
                      <td>
                        <Link href={matterHrefForCode('PEN001-0002')}>
                          <strong>PEN001-0002</strong>
                        </Link>{' '}
                        · Rent review &amp; dilapidations
                      </td>
                      <td>Penarth Estates Ltd</td>
                      <td className="num">
                        <strong>£4,569.00</strong>
                      </td>
                      <td className="num">£640.00</td>
                      <td className="num">
                        <StatusPill label="£726.00 (32d)" tone="warning" />
                      </td>
                      <td className="num">
                        {finance.canCreditControl ? (
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            onClick={async () => {
                              const res = await requestMatterBillAction('PEN001-0002');
                              if (isActionDenied(res)) {
                                showToast(res.message);
                                return;
                              }
                              showToast('Requested bill on PEN001-0002.');
                              router.refresh();
                            }}
                          >
                            Request bill
                          </button>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                    <tr>
                      <td>
                        <Link href={matterHrefForCode('PEN001-0001')}>
                          <strong>PEN001-0001</strong>
                        </Link>{' '}
                        · Lease of Unit 4
                      </td>
                      <td>Penarth Estates Ltd</td>
                      <td className="num">
                        <strong>£4,733.90</strong>
                      </td>
                      <td className="num">£0.00</td>
                      <td className="num">£0.00 (not due)</td>
                      <td className="num">
                        {finance.canCreditControl ? (
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            onClick={async () => {
                              const res = await requestMatterBillAction('PEN001-0001');
                              if (isActionDenied(res)) {
                                showToast(res.message);
                                return;
                              }
                              showToast('Requested bill on PEN001-0001.');
                              router.refresh();
                            }}
                          >
                            Request bill
                          </button>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                    <tr>
                      <td>
                        <Link href={matterHrefForCode('PRI001-0001')}>
                          <strong>PRI001-0001</strong>
                        </Link>{' '}
                        · 14 Cathedral Road
                      </td>
                      <td>Owen &amp; Carys Price</td>
                      <td className="num">
                        <strong>£1,985.00</strong>
                      </td>
                      <td className="num">£42.00</td>
                      <td className="num">£0.00</td>
                      <td className="num">
                        <span className="muted" style={{ fontSize: 11.5 }}>
                          Fixed fee £1,500 on completion
                        </span>
                      </td>
                    </tr>
                    <tr>
                      <td>
                        <Link href={matterHrefForCode('BAY001-0001')}>
                          <strong>BAY001-0001</strong>
                        </Link>{' '}
                        · Mermaid Quay café lease
                      </td>
                      <td>Bay Side Cafés Ltd</td>
                      <td className="num">£0.00</td>
                      <td className="num">£0.00</td>
                      <td className="num">
                        <StatusPill label="£3,300.00 (94d)" tone="alert" />
                      </td>
                      <td className="num">
                        {finance.canCreditControl ? (
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            onClick={async () => {
                              const res = await recordInvoiceCreditControlActionAction({
                                invoiceNumber: 'PV-2026-009',
                                matterCode: 'BAY001-0001',
                                clientCode: 'BAY001',
                                actionType: 'escalate',
                              });
                              if (isActionDenied(res)) {
                                showToast(res.message);
                                return;
                              }
                              showToast('Escalated PV-2026-009 (£3,300.00) on BAY001-0001.');
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
                <h2 className="panel-title">Enquiries &amp; conversion — Real Estate</h2>
              </div>
              <span className="panel-subtitle">October 2026</span>
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
                  <div className="val">{hasDemoSeedData ? 7 : enquiries.length}</div>
                </div>
                <div className="legend-item">
                  <div className="lbl">Converted</div>
                  <div className="val" style={{ color: 'var(--green-text)' }}>
                    {hasDemoSeedData
                      ? 4
                      : enquiries.filter((e) => e.status === 'Converted').length}
                  </div>
                </div>
                <div className="legend-item">
                  <div className="lbl">In contact</div>
                  <div className="val">
                    {hasDemoSeedData
                      ? 2
                      : enquiries.filter((e) => e.status === 'In contact').length}
                  </div>
                </div>
                <div className="legend-item">
                  <div className="lbl">Unassigned</div>
                  <div className="val" style={{ color: 'var(--amber-text)' }}>
                    {hasDemoSeedData
                      ? 1
                      : enquiries.filter((e) => isEnquiryOpen(e) && !e.assignedToId).length}
                  </div>
                </div>
              </div>
              {hasDemoSeedData ? (
                <div
                  style={{
                    marginTop: 12,
                    fontSize: 12.5,
                    color: 'var(--text-secondary)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <span>
                    Unassigned: <strong>Tranter Haulage Ltd</strong> ( Newport depot refinancing)
                  </span>
                  <Link href="/enquiries" className="btn btn--secondary btn--sm">
                    Assign
                  </Link>
                </div>
              ) : null}
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
              {!hasDemoSeedData ? (
                <div className="panel-body padded muted">
                  No client or referrer touchpoints currently due.
                </div>
              ) : (
                <ul className="worklist">
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="Platinum · Review due" tone="warning" />
                        <Link href="/organisations/O-000001">Penarth Estates Ltd</Link>
                      </div>
                      <div className="worklist-meta">
                        <span>Alun Davies (MD) · £26,568 billed YTD · £9,303 WIP</span>
                      </div>
                    </div>
                    <div className="worklist-right">
                      <Link
                        href="/organisations/O-000001"
                        className="btn btn--secondary btn--sm"
                      >
                        Log touchpoint
                      </Link>
                    </div>
                  </li>
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="Key referrer" tone="positive" />
                        <Link href="/organisations/O-000009">
                          Hughes Lloyd Accountants LLP (Gareth Hughes)
                        </Link>
                      </div>
                      <div className="worklist-meta">
                        <span>3 enquiries referred in Q3/Q4 · Last lunch 42 days ago</span>
                      </div>
                    </div>
                    <div className="worklist-right">
                      <Link href="/people/P-000011" className="btn btn--secondary btn--sm">
                        Book catch-up
                      </Link>
                    </div>
                  </li>
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="Gold · Panel" tone="neutral" />
                        <Link href="/organisations/O-000002">Harbourline Housing Association</Link>
                      </div>
                      <div className="worklist-meta">
                        <span>Ffion Roberts (Head of Legal) · £39,615 billed YTD · £6,390 WIP</span>
                      </div>
                    </div>
                    <div className="worklist-right">
                      <Link
                        href="/organisations/O-000002"
                        className="btn btn--secondary btn--sm"
                      >
                        Open
                      </Link>
                    </div>
                  </li>
                </ul>
              )}
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
        const priEntries = pmsClientAccountByMatterCode['PRI001-0001'] ?? [];
        const pugEntries = pmsClientAccountByMatterCode['PUG001-0001'] ?? [];
        const lastPriDate = priEntries[priEntries.length - 1]?.date ?? '2026-10-08';
        const lastPugDate = pugEntries[pugEntries.length - 1]?.date ?? '2026-09-22';
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
              {!hasDemoSeedData ? (
                <div className="panel-body padded muted">
                  No client account balances currently held.
                </div>
              ) : (
                <ul className="worklist">
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="Active · Completion 23 Oct" tone="positive" />
                        <Link href={matterHrefForCode('PRI001-0001')}>
                          PRI001-0001 — Purchase of 14 Cathedral Road (Owen &amp; Carys Price)
                        </Link>
                      </div>
                      <div className="worklist-meta">
                        <span>
                          Last movement: {formatDate(lastPriDate)} (Receipt of completion monies from
                          client £84,500.00)
                        </span>
                      </div>
                    </div>
                    <div className="worklist-right">
                      <strong>£84,943.60</strong>
                    </div>
                  </li>
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="24 days since last movement" tone="warning" />
                        <Link href={matterHrefForCode('PUG001-0001')}>
                          PUG001-0001 — Estate of the late Margaret Pugh (Alun Pugh)
                        </Link>
                      </div>
                      <div className="worklist-meta">
                        <span>
                          Last movement: {formatDate(lastPugDate)} (Transfer to office a/c for
                          PV-2026-016 £4,956.00) · Estate distribution pending IHT clearance
                        </span>
                      </div>
                    </div>
                    <div className="worklist-right">
                      <strong>£33,510.60</strong>
                    </div>
                  </li>
                </ul>
              )}
            </div>
            <div className="panel-footer">
              <span>Zero closed matters holding residual client funds (SRA Rule 2.5 check)</span>
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
        const octCash = pmsCashReceived.octoberTotal;
        const target = 40000;
        const pct = Math.min(Math.round((octCash / target) * 100), 100);
        const octFees =
          pmsMonthlyFeesBilled.months.find((m) => m.monthKey === '2026-10')?.feesNet ??
          (hasDemoSeedData ? 41477.35 : 0);
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Cash collection &amp; billing — October 2026</h2>
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
                    Cash receipts in October ({pmsCashReceived.octoberReceiptCount} payment
                    {pmsCashReceived.octoberReceiptCount === 1 ? '' : 's'})
                  </span>
                  <strong>
                    {formatGbp(octCash)} / £40,000 target ({pct}%)
                  </strong>
                </div>
                <div className="progress-track">
                  <div className="progress-fill green" style={{ width: `${pct}%` }} />
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
                  <div className="lbl">Fees billed in Oct (ex VAT)</div>
                  <div className="val">{formatGbp(octFees)}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {hasDemoSeedData
                      ? '5 invoices issued (6–13 Oct)'
                      : '0 invoices issued'}
                  </div>
                </div>
                <div className="legend-item">
                  <div className="lbl">Credit notes in 2026</div>
                  <div className="val">{hasDemoSeedData ? '-£900.00' : '£0.00'}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {hasDemoSeedData ? 'CN-2026-001 on PEN001-0003' : '0 credit notes'}
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
                <StatusPill
                  label={hasDemoSeedData ? '4 pending' : '0 pending'}
                  tone={hasDemoSeedData ? 'alert' : 'positive'}
                />
              </div>
              <span className="panel-subtitle">MLR 2017 · ID&amp;V, SoF &amp; SoW checks</span>
            </div>
            <div className="panel-body">
              {!hasDemoSeedData ? (
                <div className="panel-body padded muted">
                  No pending AML or Customer Due Diligence checks.
                </div>
              ) : (
                <ul className="worklist">
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="High risk · EDD required" tone="alert" />
                        <Link href={matterHrefForCode('TGL001-0002')}>
                          Tŷ Glas Developments Ltd — Purchase of Plot 9, Parc Tŷ Glas
                        </Link>
                      </div>
                      <div className="worklist-meta">
                        <span className="mono-code">TGL001-0002</span>
                        <span>
                          · Lead: Dafydd Evans · Offshore Jersey holding company (UBO declaration
                          &amp; certified bank statements pending)
                        </span>
                      </div>
                    </div>
                    <div className="worklist-right">
                      <Link
                        href={matterHrefForCode('TGL001-0002')}
                        className="btn btn--primary btn--sm"
                      >
                        Review EDD
                      </Link>
                    </div>
                  </li>
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="ID partial match · Overdue 1d" tone="alert" />
                        <Link href="/people/P-000013">
                          Mared Hughes — Purchase of 18 Cathedral View, Pontcanna
                        </Link>
                      </div>
                      <div className="worklist-meta">
                        <span className="mono-code">HUG002-0001</span>
                        <span>
                          · Electronic ID check flagged address discrepancy; certified Welsh Water
                          utility bill uploaded for MLRO sign-off
                        </span>
                      </div>
                    </div>
                    <div className="worklist-right">
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        onClick={() => {
                          showToast('Verified proof of address for Mared Hughes (HUG002-0001).');
                        }}
                      >
                        Verify ID
                      </button>
                    </div>
                  </li>
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="Pending · Converted 14 Oct" tone="warning" />
                        <Link href={matterHrefForCode('JON002-0001')}>
                          Sam Jones — Employment Tribunal claim
                        </Link>
                      </div>
                      <div className="worklist-meta">
                        <span className="mono-code">JON002-0001</span>
                        <span>
                          · Lead: Owain Jenkins · Passport &amp; driving licence link sent via portal
                        </span>
                      </div>
                    </div>
                    <div className="worklist-right">
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={() =>
                          showToast('Sent AML reminder to Owain Jenkins for JON002-0001.')
                        }
                      >
                        Chase FE
                      </button>
                    </div>
                  </li>
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="Periodic refresh due" tone="neutral" />
                        <Link href="/organisations/O-000005">
                          Severn Holdings plc — 3-year CDD refresh
                        </Link>
                      </div>
                      <div className="worklist-meta">
                        <span className="mono-code">SEV001</span>
                        <span>
                          · Relationship partner: Gethin Lloyd · PSC register check due 31 Oct 2026
                        </span>
                      </div>
                    </div>
                    <div className="worklist-right">
                      <Link
                        href="/organisations/O-000005"
                        className="btn btn--secondary btn--sm"
                      >
                        Open org
                      </Link>
                    </div>
                  </li>
                </ul>
              )}
            </div>
          </section>
        );
      }

      // ================================================================
      // 32. conflict_checks_awaiting_decision (06 Risk & Compliance)
      // ================================================================
      case 'conflict_checks_awaiting_decision': {
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Conflict checks — awaiting MLRO / COLP decision</h2>
                <StatusPill
                  label={hasDemoSeedData ? '2 awaiting decision' : '0 awaiting decision'}
                  tone={hasDemoSeedData ? 'warning' : 'positive'}
                />
              </div>
            </div>
            <div className="panel-body">
              {!hasDemoSeedData ? (
                <div className="panel-body padded muted">
                  No conflict checks currently awaiting MLRO or COLP decision.
                </div>
              ) : (
                <ul className="worklist">
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="Potential party match" tone="warning" />
                        <Link href={matterHrefForCode('TYG001-0001')}>
                          Tŷ Glas Developments Ltd — Former Docklands Timber Yard
                        </Link>
                      </div>
                      <div className="worklist-meta">
                        <span className="mono-code">TYG001-0001</span>
                        <span>
                          · Counterparty <strong>Coastline Outdoor Ltd</strong> is also tenant
                          counterparty on active matter <strong>PEN001-0004</strong> (Penarth Estates
                          Ltd). Unrelated site; information barrier under review.
                        </span>
                      </div>
                    </div>
                    <div className="worklist-right">
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={() =>
                          showToast('Recorded COLP conflict refusal on TYG001-0001.')
                        }
                      >
                        Decline (conflict)
                      </button>
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        onClick={() =>
                          showToast(
                            'Cleared TYG001-0001 subject to information barrier between Real Estate teams.',
                          )
                        }
                      >
                        Clear with barrier
                      </button>
                    </div>
                  </li>
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="Ready to clear" tone="positive" />
                        <Link href="/enquiries/ENQ-000010">
                          Coastal Storage Ltd — Assignment of lease at Unit 7, Atlantic Wharf
                        </Link>
                      </div>
                      <div className="worklist-meta">
                        <span className="mono-code">ENQ-000010</span>
                        <span>
                          · Other party named: <strong>Atlantic Wharf Estates Ltd</strong> — 0 matches
                          across clients, people or opposing parties.
                        </span>
                      </div>
                    </div>
                    <div className="worklist-right">
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        onClick={() =>
                          showToast('Marked conflict search Clear on ENQ-000010 (Coastal Storage Ltd).')
                        }
                      >
                        Mark Clear
                      </button>
                    </div>
                  </li>
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
                <StatusPill
                  label={hasDemoSeedData ? '3 matters' : '0 matters'}
                  tone="neutral"
                />
              </div>
            </div>
            <div className="panel-body" style={{ overflowX: 'auto' }}>
              {!hasDemoSeedData ? (
                <div className="panel-body padded muted">
                  No high-risk matters, PEPs or sanctions alerts recorded.
                </div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Matter</th>
                      <th>Client</th>
                      <th>Risk driver</th>
                      <th>AML / EDD status</th>
                      <th className="num">Client a/c held</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>
                        <Link href={matterHrefForCode('TGL001-0002')}>
                          <strong>TGL001-0002</strong>
                        </Link>{' '}
                        · Plot 9, Parc Tŷ Glas
                      </td>
                      <td>Tŷ Glas Developments Ltd</td>
                      <td>Offshore SPV buyer (Jersey)</td>
                      <td>
                        <StatusPill label="EDD in progress" tone="warning" />
                      </td>
                      <td className="num">£0.00</td>
                    </tr>
                    <tr>
                      <td>
                        <Link href={matterHrefForCode('HAR001-0003')}>
                          <strong>HAR001-0003</strong>
                        </Link>{' '}
                        · Butetown regeneration
                      </td>
                      <td>Harbourline Housing Assoc.</td>
                      <td>Public body grant funding / domestic PEP board member</td>
                      <td>
                        <StatusPill label="EDD verified 12 Mar" tone="positive" />
                      </td>
                      <td className="num">£0.00</td>
                    </tr>
                    <tr>
                      <td>
                        <Link href={matterHrefForCode('HAR001-0012')}>
                          <strong>HAR001-0012</strong>
                        </Link>{' '}
                        · Waterfront Quays TCC claim
                      </td>
                      <td>Harbourline Housing Assoc.</td>
                      <td>High-value litigation (£2.85m claim)</td>
                      <td>
                        <StatusPill label="Verified" tone="positive" />
                      </td>
                      <td className="num">£0.00</td>
                    </tr>
                  </tbody>
                </table>
              )}
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
              {!hasDemoSeedData ? (
                <div className="panel-body padded muted">
                  No open undertakings or scheduled periodic file reviews.
                </div>
              ) : (
                <ul className="worklist">
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="Undertaking · Due 23 Oct" tone="warning" />
                        <Link href={matterHrefForCode('PRI001-0001')}>
                          Discharge of seller&apos;s legal charge on 14 Cathedral Road
                        </Link>
                      </div>
                      <div className="worklist-meta">
                        <span className="mono-code">PRI001-0001</span>
                        <span>
                          · Dafydd Evans · Awaiting partner counter-signature (Rhian Morgan)
                        </span>
                      </div>
                    </div>
                  </li>
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="File review · Due 30 Oct" tone="neutral" />
                        <Link href={matterHrefForCode('BRI001-0003')}>
                          Q4 Lexcel file review — Acquisition of Afon Care Homes Ltd
                        </Link>
                      </div>
                      <div className="worklist-meta">
                        <span className="mono-code">BRI001-0003</span>
                        <span>· Reviewer: Bethan Rees · Lead: Gethin Lloyd</span>
                      </div>
                    </div>
                  </li>
                </ul>
              )}
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
              {!hasDemoSeedData ? (
                <div className="panel-body padded muted">
                  No open complaints, SRA breaches or residual balance alerts.
                </div>
              ) : (
                <ul className="worklist">
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="Stage 1 complaint · Resp. due 28 Oct" tone="warning" />
                        <span>CMP-2026-02 — Delay query on estate interim distribution</span>
                      </div>
                      <div className="worklist-meta">
                        <span className="mono-code">PUG001-0001</span>
                        <span>· Investigating partner: Rhian Morgan · Non-reportable to SRA</span>
                      </div>
                    </div>
                  </li>
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="SRA Rule 2.5 watch" tone="neutral" />
                        <Link href={matterHrefForCode('PUG001-0001')}>
                          Client balance £33,510.60 held 24 days without movement (PUG001-0001)
                        </Link>
                      </div>
                      <div className="worklist-meta">
                        <span>
                          Valid reason recorded: awaiting HMRC IHT421 clearance before distribution
                        </span>
                      </div>
                    </div>
                  </li>
                </ul>
              )}
            </div>
          </section>
        );
      }

      // ================================================================
      // 36. overdue_compliance_tasks_by_team (06 Risk & Compliance)
      // ================================================================
      case 'overdue_compliance_tasks_by_team': {
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Overdue compliance &amp; onboarding tasks by team</h2>
              </div>
            </div>
            <div className="panel-body">
              {!hasDemoSeedData ? (
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
                    <tr>
                      <td>Real Estate &amp; Property</td>
                      <td className="num">
                        <StatusPill label="2" tone="alert" />
                      </td>
                      <td className="num">3</td>
                      <td className="num">
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={async () => {
                            const res = await remindTeamLeadOverdueComplianceAction('TM-000001');
                            if (isActionDenied(res)) {
                              showToast(res.message);
                              return;
                            }
                            showToast('Sent compliance reminder to Rhian Morgan (Real Estate).');
                          }}
                        >
                          Remind team lead
                        </button>
                      </td>
                    </tr>
                    <tr>
                      <td>Employment &amp; HR</td>
                      <td className="num">
                        <StatusPill label="2" tone="alert" />
                      </td>
                      <td className="num">1</td>
                      <td className="num">
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={async () => {
                            const res = await remindTeamLeadOverdueComplianceAction('TM-000005');
                            if (isActionDenied(res)) {
                              showToast(res.message);
                              return;
                            }
                            showToast('Sent compliance reminder to Siân Llewellyn (Employment).');
                          }}
                        >
                          Remind team lead
                        </button>
                      </td>
                    </tr>
                    <tr>
                      <td>Corporate &amp; Commercial</td>
                      <td className="num">
                        <StatusPill label="1" tone="warning" />
                      </td>
                      <td className="num">2</td>
                      <td className="num">
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={async () => {
                            const res = await remindTeamLeadOverdueComplianceAction('TM-000002');
                            if (isActionDenied(res)) {
                              showToast(res.message);
                              return;
                            }
                            showToast('Sent compliance reminder to Catrin Hopkins (Corporate).');
                          }}
                        >
                          Remind team lead
                        </button>
                      </td>
                    </tr>
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
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">Firm financial pulse — 2026 year to date</h2>
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
                Monthly fees billed (Jan – Oct 2026) · Total YTD:{' '}
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
                  const isCurrent = m.monthKey === '2026-10';
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
                      m.monthKey === '2026-10'
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
                  <div className="lbl">Cash collected YTD</div>
                  <div className="val">
                    {hasDemoSeedData ? '£166,184.42' : formatGbp(pmsCashReceived.octoberTotal)}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {hasDemoSeedData ? '77% collection rate on gross billed' : 'Year to date'}
                  </div>
                </div>
                <div className="legend-item">
                  <div className="lbl">Client account held</div>
                  <div className="val">{formatGbp(firmClientAccountHeld)}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {hasDemoSeedData ? 'Across 2 active matters' : 'Active matters'}
                  </div>
                </div>
                <div className="legend-item">
                  <div className="lbl">Write-offs / credit notes</div>
                  <div className="val">{hasDemoSeedData ? '£900.00' : '£0.00'}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {hasDemoSeedData ? '0.5% of fees billed YTD' : '0.0% of fees billed YTD'}
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
              <span className="panel-subtitle">2026 YTD · as at {formattedAsAt}</span>
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
                    <th className="num">Oct hrs</th>
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
                      <td className="num">{d.octoberHours.toFixed(1)} h</td>
                    </tr>
                  ))}
                  <tr style={{ background: 'var(--bg-subtle)', fontWeight: 700 }}>
                    <td>{firmTotal.practiceArea}</td>
                    <td className="num">{firmTotal.openMatters}</td>
                    <td className="num">{formatGbp(firmTotal.billedThisYear)}</td>
                    <td className="num">{formatGbp(firmTotal.unbilledWip)}</td>
                    <td className="num">{formatGbp(firmTotal.outstandingDebt)}</td>
                    <td className="num">{formatGbp(firmTotal.overdueDebt)}</td>
                    <td className="num">{firmTotal.octoberHours.toFixed(1)} h</td>
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
              <span className="panel-subtitle">Annual target: 1,200 chargeable hrs per fee earner</span>
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
                      <th className="num">Oct hrs</th>
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
        const totalEnqs = hasDemoSeedData ? 17 : enquiries.length;
        const convCount = hasDemoSeedData
          ? 9
          : enquiries.filter((e) => e.status === 'Converted').length;
        const convPct = totalEnqs > 0 ? Math.round((convCount / totalEnqs) * 100) : 0;
        return (
          <section key={panelId} className="home-panel" data-panel-id={panelId}>
            <div className="panel-header">
              <div className="panel-title-group">
                <h2 className="panel-title">
                  New business — enquiries, conversion &amp; SLA health
                </h2>
              </div>
              <span className="panel-subtitle">October 2026</span>
            </div>
            <div className="panel-body padded">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                <div className="legend-item">
                  <div className="lbl">Enquiries (Oct)</div>
                  <div className="val">{totalEnqs}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {hasDemoSeedData ? '+13% vs Sep' : 'Current month'}
                  </div>
                </div>
                <div className="legend-item">
                  <div className="lbl">Converted to matters</div>
                  <div className="val" style={{ color: 'var(--green-text)' }}>
                    {convCount} ({convPct}%)
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Target ≥ 45%</div>
                </div>
                <div className="legend-item">
                  <div className="lbl">First-contact SLA met</div>
                  <div className="val">{hasDemoSeedData ? '88%' : '—'}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {hasDemoSeedData ? '1 currently overdue' : '0 overdue'}
                  </div>
                </div>
              </div>
              {hasDemoSeedData ? (
                <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-secondary)' }}>
                  Top referrer:{' '}
                  <strong>
                    <Link href="/organisations/O-000009">Hughes Lloyd Accountants LLP</Link>
                  </strong>{' '}
                  (4 enquiries · 3 converted).
                </div>
              ) : null}
            </div>
          </section>
        );
      }

      // ================================================================
      // 41. top_clients_and_concentration (07 Managing Partner)
      // ================================================================
      case 'top_clients_and_concentration': {
        const topClients = [...allClientFins]
          .filter((c) => c.fees_billed > 0 || c.unbilled_wip > 0)
          .sort((a, b) => b.fees_billed - a.fees_billed)
          .slice(0, 6);
        const totalBilled = pmsMonthlyFeesBilled.yearToDateTotal || 181673.48;
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
                      const sharePct = Math.round((c.fees_billed / totalBilled) * 1000) / 10;
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
                            <strong>{formatGbp(c.fees_billed)}</strong>
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
                <StatusPill
                  label={hasDemoSeedData ? '4 items' : '0 items'}
                  tone={hasDemoSeedData ? 'alert' : 'positive'}
                />
              </div>
            </div>
            <div className="panel-body">
              {!hasDemoSeedData ? (
                <div className="panel-body padded muted">
                  No financial, compliance or operational exceptions flagged.
                </div>
              ) : (
                <ul className="worklist">
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="90+d debt" tone="alert" />
                        <Link href={matterHrefForCode('BAY001-0001')}>
                          Bay Side Cafés Ltd — £3,300.00 invoice 94 days overdue (BAY001-0001)
                        </Link>
                      </div>
                    </div>
                  </li>
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="112% of cap" tone="alert" />
                        <Link href={matterHrefForCode('SEV001-0001')}>
                          Severn Holdings plc — £27,984 recorded vs £25,000 capped fee (SEV001-0001)
                        </Link>
                      </div>
                    </div>
                  </li>
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="High risk · EDD" tone="warning" />
                        <Link href={matterHrefForCode('TGL001-0002')}>
                          Tŷ Glas Developments Ltd — Offshore SPV source of funds pending
                          (TGL001-0002)
                        </Link>
                      </div>
                    </div>
                  </li>
                  <li className="worklist-row">
                    <div className="worklist-main">
                      <div className="worklist-title">
                        <StatusPill label="Revised est. pending" tone="warning" />
                        <Link href={matterHrefForCode('BRI001-0003')}>
                          Brightwater Care Group — £72,000 revised estimate awaiting client sign-off
                          (BRI001-0003)
                        </Link>
                      </div>
                    </div>
                  </li>
                </ul>
              )}
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
