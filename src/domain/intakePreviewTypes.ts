/**
 * Shared request and response contracts for S1-02b server-side duplicate/conflict
 * previews and scoped entity pickers (`previewIntakeDuplicatesAndConflictsAction`
 * and `searchEntityPickerAction`).
 */
import type { DuplicateMatch, DuplicateReason } from './duplicates';
import type { ConflictHit } from './enquiries';
import type { AddressLike } from './normalise';
import type {
  Address,
  Email,
  Enquiry,
  Matter,
  Organisation,
  Person,
  Phone,
} from './types';

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

export type EntityPickerCorporateRelation =
  | 'parent'
  | 'subsidiary'
  | 'group'
  | 'director'
  | 'contact';

export interface EntityPickerMatterSummary {
  readonly id: string;
  readonly matterNumber: string;
  readonly title: string;
  readonly clientId: string;
  readonly matterStatusId: Matter['matterStatusId'];
  readonly leadFeeEarnerId: Matter['leadFeeEarnerId'];
  readonly supervisingPartnerId: Matter['supervisingPartnerId'];
  readonly responsiblePartnerId: Matter['responsiblePartnerId'];
  readonly teamMemberIds: readonly string[];
}

export interface EntityPickerEnquirySummary {
  readonly id: string;
  readonly reference: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly callingOnBehalfOf: string;
  readonly summary: string;
  readonly notes: string;
  readonly email: string;
  readonly phone: string;
  readonly linkedPersonId?: string | null;
  readonly linkedOrganisationId?: string | null;
  readonly practiceAreaId?: string;
  readonly workTypeSubcategoryId?: string | null;
  readonly assignedToId?: string | null;
  readonly status: Enquiry['status'];
}

export interface EntityPickerPersonSummary {
  readonly id: string;
  readonly firstName: string;
  readonly surname: string;
  readonly preferredName?: string | null;
  readonly jobTitle?: string;
  readonly dateOfBirth?: string | null;
  readonly verificationStatusId?: string | null;
  readonly relationshipStatusId?: string | null;
  readonly verifiedAt?: string | null;
  readonly isEmployee?: boolean;
  readonly mergedIntoId?: string | null;
  readonly emails: readonly Email[];
  readonly phones: readonly Phone[];
  readonly addresses?: readonly Pick<Address, 'town'>[];
}

export interface EntityPickerOrganisationSummary {
  readonly id: string;
  readonly legalName: string;
  readonly organisationTypeId?: string | null;
  readonly companyNumber?: string;
  readonly generalEmail?: string;
  readonly mainPhone?: string;
  readonly parentOrganisationId?: string | null;
  readonly verificationStatusId?: string | null;
  readonly relationshipStatusId?: string | null;
  readonly reviewDate?: string | null;
  readonly mergedIntoId?: string | null;
  readonly registeredAddress?: Pick<Address, 'line1' | 'town' | 'postcode'> | null;
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
  readonly corporateRelation?: EntityPickerCorporateRelation;
  readonly person?: EntityPickerPersonSummary;
  readonly organisation?: EntityPickerOrganisationSummary;
  readonly matterSummary?: EntityPickerMatterSummary;
  readonly enquiry?: EntityPickerEnquirySummary;
  readonly linkedOrgs?: EntityPickerOrganisationSummary[];
}

export interface EntityPickerSearchResult {
  readonly items: EntityPickerOption[];
}
