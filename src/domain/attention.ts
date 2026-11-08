/** "Needs attention" rules for the home page and notifications. */
import { addMonths, formatDate, isBefore } from './dates';
import { enquiryDisplayName, isEnquiryOpen } from './enquiries';
import { resolveLabel, systemKeyOf } from './lists';
import { recordDisplayName } from './names';
import { formatGbp, formatWholePct } from './pms';
import type { StatusTone } from './search';
import { isTaskOpen, isTaskOverdue, userTeams } from './tasks';
import type { AnyRecord, ChoiceValue, Enquiry, Matter, Task, Team } from './types';
import type { PmsMatterFinancials } from '@/pms/types';

export type AttentionKind =
  | 'overdue_task'
  | 'unclaimed_urgent_enquiry'
  | 'late_first_contact'
  | 'pms_over_estimate'
  | 'pms_capped_fee_exceeded'
  | 'pms_overdue_bill_60'
  | 'pms_old_wip_30'
  | 'pms_pending_estimate_revision'
  | 'potential_conflict'
  | 'verification_expired'
  | 'possible_duplicate'
  | 'review_overdue'
  | 'stale';

export interface AttentionItem {
  recordId: string;
  recordType: AnyRecord['recordType'] | 'matter' | 'enquiry' | 'task';
  title: string;
  kind: AttentionKind;
  label: string;
  detail: string;
  tone: StatusTone;
  isPms?: boolean;
}

export const ATTENTION_ORDER: AttentionKind[] = [
  'unclaimed_urgent_enquiry',
  'late_first_contact',
  'overdue_task',
  'pms_over_estimate',
  'pms_capped_fee_exceeded',
  'pms_overdue_bill_60',
  'pms_old_wip_30',
  'pms_pending_estimate_revision',
  'potential_conflict',
  'verification_expired',
  'possible_duplicate',
  'review_overdue',
  'stale',
];

const INACTIVE_STATUSES = new Set(['archived', 'deceased', 'merged', 'dissolved']);

export function isInactiveStatus(values: ChoiceValue[], recordStatusId: string): boolean {
  return INACTIVE_STATUSES.has(systemKeyOf(values, recordStatusId) ?? '');
}

export function attentionFor(record: AnyRecord, values: ChoiceValue[], today: Date): AttentionItem[] {
  if (record.mergedIntoId || isInactiveStatus(values, record.recordStatusId)) return [];
  const items: AttentionItem[] = [];
  const base = { recordId: record.id, recordType: record.recordType, title: recordDisplayName(record) };

  if (systemKeyOf(values, record.duplicateStatusId) === 'possible_match') {
    items.push({ ...base, kind: 'possible_duplicate', label: 'Possible duplicate', detail: 'Check and merge or dismiss', tone: 'warning' });
  }
  if (systemKeyOf(values, record.verificationStatusId) === 'expired') {
    items.push({ ...base, kind: 'verification_expired', label: 'Verification expired', detail: 'ID or due diligence needs renewing', tone: 'alert' });
  }
  if (record.recordType === 'organisation') {
    if (systemKeyOf(values, record.conflictStatusId) === 'potential_conflict') {
      items.push({ ...base, kind: 'potential_conflict', label: 'Potential conflict', detail: 'Conflict check needs clearing', tone: 'alert' });
    }
    if (record.reviewDate && isBefore(record.reviewDate, today)) {
      items.push({ ...base, kind: 'review_overdue', label: 'Review overdue', detail: 'Periodic review date has passed', tone: 'warning' });
    }
  }
  const isEmployee = record.recordType === 'person' && record.isEmployee;
  if (!isEmployee && record.lastVerifiedAt && isBefore(record.lastVerifiedAt, addMonths(today, -12))) {
    items.push({ ...base, kind: 'stale', label: 'Not verified in 12 months', detail: 'Check details are still correct', tone: 'neutral' });
  }
  return items;
}

export function attentionList(
  records: AnyRecord[],
  values: ChoiceValue[],
  today: Date,
  extras?: {
    userId?: string;
    tasks?: Task[];
    enquiries?: Enquiry[];
    teams?: Team[];
    matters?: Matter[];
    pmsSummaryByMatterId?: Record<string, PmsMatterFinancials>;
    canViewFinance?: boolean;
  },
): AttentionItem[] {
  const items = records.flatMap((r) => attentionFor(r, values, today));

  if (extras) {
    const {
      userId,
      tasks = [],
      enquiries = [],
      teams = [],
      matters = [],
      pmsSummaryByMatterId = {},
      canViewFinance = false,
    } = extras;
    const myTeams = userId ? userTeams(userId, teams) : [];
    const myTeamIds = new Set(myTeams.map((t) => t.id));

    // 1. My overdue tasks (or all overdue tasks if userId is not specified)
    for (const t of tasks) {
      if ((!userId || t.assignedPersonId === userId) && isTaskOpen(t) && isTaskOverdue(t, today)) {
        items.push({
          recordId: t.id,
          recordType: 'task',
          title: `${t.reference} — ${t.title}`,
          kind: 'overdue_task',
          label: 'Overdue task',
          detail: `Due ${formatDate(t.dueAt)}`,
          tone: 'alert',
        });
      }
    }

    // 2. Unclaimed urgent or emergency enquiries in my teams, plus enquiries past first-contact time
    for (const enq of enquiries) {
      if (!isEnquiryOpen(enq)) continue;
      const inMyTeams = !userId || (enq.assignedTeamId ? myTeamIds.has(enq.assignedTeamId) : false);
      const isMine = userId && enq.assignedToId === userId;
      const urgencyLabel = resolveLabel(values, enq.urgencyId);
      const isUrgentOrEmergency =
        urgencyLabel.toLowerCase().includes('emergency') ||
        urgencyLabel.toLowerCase().includes('urgent');

      if (!enq.assignedToId && isUrgentOrEmergency && inMyTeams) {
        items.push({
          recordId: enq.id,
          recordType: 'enquiry',
          title: `${enq.reference} — ${enquiryDisplayName(enq)}`,
          kind: 'unclaimed_urgent_enquiry',
          label: `${urgencyLabel} unclaimed`,
          detail: enq.summary,
          tone: 'alert',
        });
      }

      // Past first-contact due time and no 'Spoke' contact yet
      const hasSpoken = enq.contactLog.some((c) => c.outcome === 'Spoke');
      if (
        !hasSpoken &&
        enq.firstContactDueAt &&
        new Date(enq.firstContactDueAt).getTime() < today.getTime() &&
        (isMine || inMyTeams)
      ) {
        items.push({
          recordId: enq.id,
          recordType: 'enquiry',
          title: `${enq.reference} — ${enquiryDisplayName(enq)}`,
          kind: 'late_first_contact',
          label: 'Past first-contact SLA',
          detail: `${resolveLabel(values, enq.practiceAreaId)} · ${enq.summary}`,
          tone: 'warning',
        });
      }
    }

    // 3. PMS Financial alerts for matters where the signed-in user is responsible partner or lead fee earner
    if (canViewFinance) {
      for (const m of matters) {
        if (m.mergedIntoId || isInactiveStatus(values, m.recordStatusId)) continue;
        const isMyMatter =
          !userId || m.responsiblePartnerId === userId || m.leadFeeEarnerId === userId;
        if (!isMyMatter) continue;

        const fin = pmsSummaryByMatterId[m.id];
        if (!fin) continue;

        const base = {
          recordId: m.id,
          recordType: 'matter' as const,
          title: `${m.matterNumber} — ${m.title}`,
          isPms: true,
        };

        // 3a. Matters over estimate_alert_pct or over 100% of estimate
        if (fin.estimate_used_pct > 0 && fin.fee_estimate > 0) {
          const alertPct = fin.estimate_alert_pct > 0 ? fin.estimate_alert_pct : 0.8;
          if (fin.estimate_used_pct > 1) {
            items.push({
              ...base,
              kind: 'pms_over_estimate',
              label: `${formatWholePct(fin.estimate_used_pct)} of estimate`,
              detail: `Billed + WIP exceeds estimate of ${formatGbp(fin.fee_estimate)} (PMS)`,
              tone: 'alert',
            });
          } else if (fin.estimate_used_pct >= alertPct) {
            items.push({
              ...base,
              kind: 'pms_over_estimate',
              label: `${formatWholePct(fin.estimate_used_pct)} of estimate`,
              detail: `Past ${formatWholePct(alertPct)} alert threshold on ${formatGbp(fin.fee_estimate)} estimate (PMS)`,
              tone: 'warning',
            });
          }
        }

        // 3b. Capped-fee matters where time recorded exceeds the cap
        if (
          fin.billing_basis === 'Capped Fee' &&
          fin.fixed_fee_amount > 0 &&
          fin.time_value_recorded > fin.fixed_fee_amount + 0.005
        ) {
          items.push({
            ...base,
            kind: 'pms_capped_fee_exceeded',
            label: 'Cap exceeded',
            detail: `${formatGbp(fin.time_value_recorded)} time recorded against ${formatGbp(fin.fixed_fee_amount)} cap (PMS)`,
            tone: 'alert',
          });
        }

        // 3c. Bills over 60 days past due
        if (
          fin.max_invoice_days_past_due !== null &&
          fin.max_invoice_days_past_due > 60 &&
          fin.outstanding_debt > 0.005
        ) {
          items.push({
            ...base,
            kind: 'pms_overdue_bill_60',
            label: `Bill ${fin.max_invoice_days_past_due}d overdue`,
            detail: `${formatGbp(fin.outstanding_debt)} outstanding debt over 60 days past due (PMS)`,
            tone: 'alert',
          });
        }

        // 3d. Unbilled WIP older than 30 days
        if (
          fin.oldest_unbilled_wip_days !== null &&
          fin.oldest_unbilled_wip_days > 30 &&
          fin.unbilled_wip > 0.005
        ) {
          items.push({
            ...base,
            kind: 'pms_old_wip_30',
            label: `Unbilled WIP (${fin.oldest_unbilled_wip_days}d)`,
            detail: `${formatGbp(fin.unbilled_wip)} unbilled WIP older than 30 days (PMS)`,
            tone: 'warning',
          });
        }

        // 3e. Revised estimates awaiting client acceptance
        if (fin.has_pending_estimate_revision) {
          items.push({
            ...base,
            kind: 'pms_pending_estimate_revision',
            label: 'Estimate awaiting client acceptance',
            detail: 'Revised fee estimate is Pending client acceptance (PMS)',
            tone: 'warning',
          });
        }
      }
    }
  }

  return items.sort(
    (a, b) => ATTENTION_ORDER.indexOf(a.kind) - ATTENTION_ORDER.indexOf(b.kind) || a.title.localeCompare(b.title),
  );
}
