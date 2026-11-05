import { canPersonAccessMatter } from './rbacRuntime';
import type { Enquiry, Matter, Person } from '@/domain/types';
import type { FirmStore } from './store';

export interface RecordVisibility {
  canViewMatter: (matter: Matter) => boolean;
  canViewEnquiry: (enquiry: Enquiry) => boolean;
  hiddenMatterIds: ReadonlySet<string>;
  hiddenMatterSourceEnquiryIds: ReadonlySet<string>;
  hiddenMatterSourceQuoteIds: ReadonlySet<string>;
}

export function buildRecordVisibility(
  store: FirmStore,
  user: Person | null | undefined,
  opts: { tokenRoles?: readonly string[] } = {},
): RecordVisibility {
  const userId = user?.id ?? '';
  const canViewMatter = (m: Matter): boolean =>
    Boolean(userId) &&
    canPersonAccessMatter(m, userId, user ?? null, {
      allPeople: store.people,
      teams: store.teams,
      tokenRoles: opts.tokenRoles,
    });

  const hiddenMatterIds = new Set<string>();
  const hiddenMatterSourceEnquiryIds = new Set<string>();
  const hiddenMatterSourceQuoteIds = new Set<string>();

  for (const m of store.matters) {
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

  return {
    canViewMatter,
    canViewEnquiry,
    hiddenMatterIds,
    hiddenMatterSourceEnquiryIds,
    hiddenMatterSourceQuoteIds,
  };
}
