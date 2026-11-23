/**
 * Shared request and response contracts for S1-02b server-side duplicate/conflict
 * previews and scoped entity pickers (`previewIntakeDuplicatesAndConflictsAction`
 * and `searchEntityPickerAction`).
 */
import type { DuplicateMatch, DuplicateReason } from './duplicates';
import type { ConflictHit } from './enquiries';
import type { AddressLike } from './normalise';
import type { Enquiry, Matter, Organisation, Person, Quote } from './types';

export type IntakePreviewKind =
  | 'person'
  | 'organisation'
  | 'enquiry'
  | 'quote'
  | 'quick_enquiry';

export interface IntakePreviewInput {
  readonly kind: IntakePreviewKind;
  readonly excludeId?: string | null;
  readonly excludeEnquiryId?: string | null;
  readonly dismissedDuplicateIds?: readonly string[];
  readonly firstName?: string;
  readonly lastName?: string;
  readonly surname?: string;
  readonly preferredName?: string;
  readonly otherNames?: readonly string[];
  readonly legalName?: string;
  readonly companyNumber?: string;
  readonly callingOnBehalfOf?: string;
  readonly otherPartiesNamed?: string;
  readonly emails?: readonly string[];
  readonly phones?: readonly string[];
  readonly addresses?: readonly AddressLike[];
  readonly linkedPersonId?: string | null;
  readonly linkedOrganisationId?: string | null;
  readonly includeConflicts?: boolean;
}

export interface IntakeConflictSearchPreview {
  readonly otherPartyClientMatches: ConflictHit[];
  readonly clientAgainstPartyMatches: ConflictHit[];
  readonly allConflicts: ConflictHit[];
  readonly hasBlockingConflict: boolean;
}

export interface IntakeEntityMatchPeopleEntry {
  readonly person: Person;
  readonly reasons: DuplicateReason[];
  readonly strength: 'high' | 'medium' | 'low';
  readonly formattedReasons: string;
}

export interface IntakeEntityMatchOrganisationEntry {
  readonly organisation: Organisation;
  readonly reasons: DuplicateReason[];
  readonly strength: 'high' | 'medium' | 'low';
  readonly formattedReasons: string;
}

export interface IntakePreviewResult {
  readonly duplicatePeople: DuplicateMatch<Person>[];
  readonly duplicateOrganisations: DuplicateMatch<Organisation>[];
  readonly entityMatches: {
    readonly people: IntakeEntityMatchPeopleEntry[];
    readonly organisations: IntakeEntityMatchOrganisationEntry[];
  };
  readonly activeLinkedEnquiries: Enquiry[];
  readonly possibleConflicts: ConflictHit[];
  readonly conflictSearch: IntakeConflictSearchPreview | null;
}

export type EntityPickerType =
  | 'person'
  | 'organisation'
  | 'matter'
  | 'enquiry'
  | 'quote';

export interface EntityPickerSearchInput {
  readonly entityTypes: readonly EntityPickerType[];
  readonly query: string;
  readonly limit?: number;
  readonly excludeIds?: readonly string[];
  readonly employeesOnly?: boolean;
  readonly nonEmployeesOnly?: boolean;
  readonly excludeDemo?: boolean;
  readonly includeLinkedOrgs?: boolean;
  readonly includeEnquiryProspects?: boolean;
  readonly corporateGroupOfOrgId?: string | null;
  readonly personQuery?: {
    readonly firstName?: string;
    readonly surname?: string;
    readonly organisationName?: string;
  };
}

export interface EntityPickerOption {
  readonly id: string;
  readonly recordType: EntityPickerType;
  readonly label: string;
  readonly subtitle: string;
  readonly reference?: string;
  readonly href: string;
  readonly matchNote?: 'similar spelling' | 'sounds like' | null;
  readonly rank?: number;
  readonly person?: Person;
  readonly organisation?: Organisation;
  readonly matter?: Matter;
  readonly enquiry?: Enquiry;
  readonly quote?: Quote;
  readonly linkedOrgs?: Organisation[];
}

export interface EntityPickerSearchResult {
  readonly items: EntityPickerOption[];
}
