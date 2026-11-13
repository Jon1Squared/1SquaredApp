import type { RbacConfiguration } from '@platform/core';
import { canPersonAccessMatter } from './rbacRuntime';
import type { Enquiry, Matter, Person, Quote, Task, Team } from '@/domain/types';

export interface RecordVisibility {
  canViewMatter: (matter: Matter) => boolean;
  canViewEnquiry: (enquiry: Enquiry) => boolean;
  canViewQuote: (quote: Quote) => boolean;
  canViewTask: (task: Task) => boolean;
  hiddenMatterIds: ReadonlySet<string>;
  hiddenMatterSourceEnquiryIds: ReadonlySet<string>;
  hiddenMatterSourceQuoteIds: ReadonlySet<string>;
  hiddenEnquiryIds: ReadonlySet<string>;
  hiddenQuoteIds: ReadonlySet<string>;
}

export const EMPTY_HIDDEN_KEY_DATE_IDS: ReadonlySet<string> = new Set<string>();

export function buildRecordVisibility(
  store: { teams?: readonly Team[] } | null | undefined,
  user: Person | null | undefined,
  opts: {
    tokenRoles?: readonly string[];
    hiddenMatterKeyDateIds: ReadonlySet<string>;
    teams?: readonly Team[];
    people?: readonly Person[];
    matters?: readonly Matter[];
    enquiries?: readonly Enquiry[];
    quotes?: readonly Quote[];
    rbacConfig?: RbacConfiguration;
  },
): RecordVisibility {
  const userId = user?.id ?? '';
  const allTeams = opts.teams ?? store?.teams ?? [];
  const allPeople = opts.people ?? [];
  const allMatters = opts.matters ?? [];
  const allEnquiries = opts.enquiries ?? [];
  const allQuotes = opts.quotes ?? [];
  const canViewMatter = (m: Matter): boolean =>
    Boolean(userId) &&
    canPersonAccessMatter(m, userId, user ?? null, {
      allPeople,
      teams: [...allTeams],
      tokenRoles: opts.tokenRoles,
      ...(opts.rbacConfig ? { config: { rbac: opts.rbacConfig } } : {}),
    });

  const hiddenMatterIds = new Set<string>();
  const hiddenMatterSourceEnquiryIds = new Set<string>();
  const hiddenMatterSourceQuoteIds = new Set<string>();

  for (const m of allMatters) {
    if (!canViewMatter(m)) {
      hiddenMatterIds.add(m.id);
      if (m.sourceEnquiryId) hiddenMatterSourceEnquiryIds.add(m.sourceEnquiryId);
      if (m.sourceQuoteId) hiddenMatterSourceQuoteIds.add(m.sourceQuoteId);
    }
  }

  const canViewEnquiry = (e: Enquiry): boolean => {
    if (!userId) return false;
    if (
      e.status === 'Draft' &&
      e.createdById !== userId &&
      e.takenById !== userId
    ) {
      return false;
    }
    if (e.convertedMatterId && hiddenMatterIds.has(e.convertedMatterId)) {
      return false;
    }
    if (hiddenMatterSourceEnquiryIds.has(e.id)) {
      return false;
    }
    return true;
  };

  const hiddenEnquiryIds = new Set<string>();
  for (const e of allEnquiries) {
    if (!canViewEnquiry(e)) {
      hiddenEnquiryIds.add(e.id);
    }
  }

  const canViewQuote = (q: Quote): boolean => {
    if (!userId) return false;
    if (q.convertedMatterId && hiddenMatterIds.has(q.convertedMatterId)) {
      return false;
    }
    if (q.linkedEnquiryId && hiddenEnquiryIds.has(q.linkedEnquiryId)) {
      return false;
    }
    if (hiddenMatterSourceQuoteIds.has(q.id)) {
      return false;
    }
    return true;
  };

  const hiddenQuoteIds = new Set<string>();
  for (const q of allQuotes) {
    if (!canViewQuote(q)) {
      hiddenQuoteIds.add(q.id);
    }
  }

  const { hiddenMatterKeyDateIds } = opts;

  const canViewTask = (t: Task): boolean => {
    if (!userId) return false;
    if (t.linkedKeyDateId && hiddenMatterKeyDateIds.has(t.linkedKeyDateId)) {
      return false;
    }
    const linksToHidden = t.linkedRecords.some(
      (lr) =>
        (lr.recordType === 'matter' && hiddenMatterIds.has(lr.recordId)) ||
        (lr.recordType === 'enquiry' && hiddenEnquiryIds.has(lr.recordId)) ||
        (lr.recordType === 'quote' && hiddenQuoteIds.has(lr.recordId)),
    );
    return !linksToHidden;
  };

  return {
    canViewMatter,
    canViewEnquiry,
    canViewQuote,
    canViewTask,
    hiddenMatterIds,
    hiddenMatterSourceEnquiryIds,
    hiddenMatterSourceQuoteIds,
    hiddenEnquiryIds,
    hiddenQuoteIds,
  };
}
