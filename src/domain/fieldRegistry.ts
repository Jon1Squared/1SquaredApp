/**
 * Field registry: one description of every core field.
 * Drives audit labels, value formatting, profile rendering and admin "where used".
 */
import { formatDate } from './dates';
import { resolveLabel } from './lists';
import type { Address, ChoiceValue, Email, OtherName, Phone, RecordType } from './types';

export type FieldKind =
  | 'text'
  | 'longText'
  | 'date'
  | 'choice'
  | 'choiceMulti'
  | 'employee'
  | 'bool'
  | 'emails'
  | 'phones'
  | 'addresses'
  | 'address'
  | 'otherNames'
  | 'record'
  | 'tags'
  | 'url';

export type FieldSection = 'A' | 'B' | 'C' | 'D' | 'E' | 'record';

export interface FieldDef {
  key: string;
  label: string;
  recordType: RecordType | 'link';
  section: FieldSection;
  kind: FieldKind;
  listKey?: string;
}

const p = (key: string, label: string, section: FieldSection, kind: FieldKind, listKey?: string): FieldDef => ({
  key,
  label,
  recordType: 'person',
  section,
  kind,
  listKey,
});
const o = (key: string, label: string, section: FieldSection, kind: FieldKind, listKey?: string): FieldDef => ({
  key,
  label,
  recordType: 'organisation',
  section,
  kind,
  listKey,
});
const l = (key: string, label: string, kind: FieldKind, listKey?: string): FieldDef => ({
  key,
  label,
  recordType: 'link',
  section: 'B',
  kind,
  listKey,
});

export const PERSON_FIELDS: FieldDef[] = [
  p('titleId', 'Title', 'A', 'choice', 'title'),
  p('firstName', 'First name', 'A', 'text'),
  p('middleNames', 'Middle name(s)', 'A', 'text'),
  p('surname', 'Surname', 'A', 'text'),
  p('preferredName', 'Preferred name', 'A', 'text'),
  p('dateOfBirth', 'Date of birth', 'A', 'date'),
  p('otherNames', 'Previous or alternative names', 'A', 'otherNames', 'other_name_type'),
  p('jobTitle', 'Job title', 'A', 'text'),
  p('emails', 'Email addresses', 'A', 'emails', 'email_type'),
  p('phones', 'Phone numbers', 'A', 'phones', 'phone_type'),
  p('preferredContactMethodId', 'Preferred contact method', 'A', 'choice', 'contact_method'),
  p('preferredLanguageId', 'Preferred language', 'A', 'choice', 'language'),
  p('addresses', 'Postal addresses', 'A', 'addresses', 'address_type'),
  p('website', 'LinkedIn or website', 'A', 'url'),

  p('relationshipOwnerId', 'Relationship owner', 'C', 'employee'),
  p('relationshipStatusId', 'Relationship status', 'C', 'choice', 'relationship_status'),
  p('relationshipStandingId', 'Relationship standing', 'C', 'choice', 'relationship_standing'),
  p('relationshipRoleIds', 'Relationship roles', 'C', 'choiceMulti', 'person_role'),
  p('originId', 'How the relationship originated', 'C', 'choice', 'origin'),
  p('firstKnownAt', 'Date first known', 'C', 'date'),
  p('lastInteractionAt', 'Last meaningful interaction', 'C', 'date'),
  p('engagementLevelId', 'Engagement level', 'C', 'choice', 'engagement_level'),
  p('interests', 'Interests and preferences', 'C', 'longText'),
  p('relationshipNotes', 'Relationship notes', 'C', 'longText'),
  p('marketingConsentId', 'Marketing consent', 'C', 'choice', 'marketing_consent'),
  p('consentRecord', 'Consent or objection record', 'C', 'longText'),

  p('recordStatusId', 'Contact record status', 'D', 'choice', 'person_record_status'),
  p('verificationStatusId', 'ID verification status', 'D', 'choice', 'verification_status'),
  p('verifiedAt', 'Verification date', 'D', 'date'),
  p('verificationMethodId', 'Verification method', 'D', 'choice', 'verification_method'),
  p('verificationReviewerId', 'Verification reviewer', 'D', 'employee'),
  p('riskReferences', 'Risk assessment / due diligence references', 'D', 'text'),
  p('sourceId', 'Data source', 'D', 'choice', 'data_source'),
  p('lastVerifiedAt', 'Last verified', 'D', 'date'),
  p('duplicateStatusId', 'Duplicate status', 'D', 'choice', 'duplicate_status'),

  p('isEmployee', 'Employee of the firm', 'E', 'bool'),
  p('employeeRoleId', 'Employee role', 'E', 'choice', 'employee_role'),
  p('departmentId', 'Department or team', 'E', 'choice', 'department'),

  p('recordOwnerId', 'Record owner', 'record', 'employee'),
  p('tags', 'Tags', 'record', 'tags'),
];

export const ORGANISATION_FIELDS: FieldDef[] = [
  o('legalName', 'Legal name', 'A', 'text'),
  o('otherNames', 'Trading and former names', 'A', 'otherNames', 'org_name_type'),
  o('organisationTypeId', 'Organisation type', 'A', 'choice', 'organisation_type'),
  o('companyNumber', 'Company registration number', 'A', 'text'),
  o('vatNumber', 'VAT number', 'A', 'text'),
  o('countryOfRegistrationId', 'Country of registration', 'A', 'choice', 'country'),
  o('registeredAddress', 'Registered address', 'A', 'address'),
  o('correspondenceAddress', 'Main or correspondence address', 'A', 'address'),
  o('peopleWithSignificantControl', 'People with significant control', 'A', 'tags'),
  o('directors', 'Directors', 'A', 'tags'),
  o('website', 'Website', 'A', 'url'),
  o('mainPhone', 'Main phone', 'A', 'text'),
  o('generalEmail', 'General email', 'A', 'text'),
  o('parentOrganisationId', 'Parent organisation', 'A', 'record'),

  o('relationshipPartnerId', 'Relationship partner', 'C', 'employee'),
  o('relationshipTypeIds', 'Relationship types', 'C', 'choiceMulti', 'organisation_relationship_type'),
  o('relationshipStatusId', 'Relationship status', 'C', 'choice', 'relationship_status'),
  o('relationshipStandingId', 'Relationship standing', 'C', 'choice', 'relationship_standing'),
  o('sectorId', 'Sector', 'C', 'choice', 'sector'),
  o('clientTierId', 'Client tier', 'C', 'choice', 'client_tier'),
  o('originId', 'Source of relationship', 'C', 'choice', 'origin'),
  o('relationshipStartedAt', 'Date relationship started', 'C', 'date'),
  o('lastInteractionAt', 'Last meaningful interaction', 'C', 'date'),
  o('engagementLevelId', 'Engagement level', 'C', 'choice', 'engagement_level'),
  o('pipelineStageId', 'Pipeline stage', 'C', 'choice', 'pipeline_stage'),
  o('bdNotes', 'Business development notes', 'C', 'longText'),

  o('clientReference', 'Client or supplier reference', 'D', 'text'),
  o('onboardingStatusId', 'Onboarding status', 'D', 'choice', 'onboarding_status'),
  o('conflictStatusId', 'Conflict check status', 'D', 'choice', 'conflict_status'),
  o('conflictReference', 'Conflict check reference', 'D', 'text'),
  o('riskRatingId', 'Risk rating', 'D', 'choice', 'risk_rating'),
  o('riskAssessmentStatusId', 'Risk assessment status', 'D', 'choice', 'risk_assessment_status'),
  o('verificationStatusId', 'Due diligence / verification status', 'D', 'choice', 'verification_status'),
  o('billingAddress', 'Billing address', 'D', 'address'),
  o('invoicePreferenceId', 'Invoice preference', 'D', 'choice', 'invoice_preference'),
  o('paymentTermsId', 'Payment terms', 'D', 'choice', 'payment_terms'),
  o('creditControlNotes', 'Credit control notes', 'D', 'longText'),
  o('engagementTermsRef', 'Engagement terms / document reference', 'D', 'text'),
  o('reviewDate', 'Review date', 'D', 'date'),
  o('reviewerId', 'Reviewer', 'D', 'employee'),
  o('recordStatusId', 'Record status', 'D', 'choice', 'organisation_record_status'),
  o('sourceId', 'Data source', 'D', 'choice', 'data_source'),
  o('lastVerifiedAt', 'Last verified', 'D', 'date'),
  o('duplicateStatusId', 'Duplicate status', 'D', 'choice', 'duplicate_status'),

  o('recordOwnerId', 'Record owner', 'record', 'employee'),
  o('tags', 'Tags', 'record', 'tags'),
];

export const LINK_FIELDS: FieldDef[] = [
  l('jobTitle', 'Job title', 'text'),
  l('department', 'Department or team', 'text'),
  l('roleWithinOrganisation', 'Role within the organisation', 'text'),
  l('contactRoleIds', 'Contact roles', 'choiceMulti', 'contact_role'),
  l('isPrimaryContact', 'Primary contact', 'bool'),
  l('isCurrent', 'Current', 'bool'),
  l('startDate', 'Start date', 'date'),
  l('endDate', 'End date', 'date'),
  l('contactStatusId', 'Contact status', 'choice', 'contact_status'),
];

export const ALL_FIELDS = [...PERSON_FIELDS, ...ORGANISATION_FIELDS, ...LINK_FIELDS];

export function fieldsFor(recordType: RecordType | 'link'): FieldDef[] {
  return recordType === 'person' ? PERSON_FIELDS : recordType === 'organisation' ? ORGANISATION_FIELDS : LINK_FIELDS;
}

export function fieldDef(recordType: RecordType | 'link', key: string): FieldDef | undefined {
  return fieldsFor(recordType).find((f) => f.key === key);
}

const OTHER_USAGE: Record<string, string[]> = {
  employee_role: ['Employees (exactly one role each)'],
  matter_party_role: ['Matters · Parties & third-party advisers'],
  matter_employee_role: ['Matters · Matter team'],
  work_type: ['Matters · Practice area & work type · Enquiries · Practice area routing'],
  document_type: ['Document templates'],
  matter_type: ['Matters · Matter classification'],
  billing_basis: ['Matters · Billing & commercial'],
  matter_size: ['Matters · Matter classification'],
  jurisdiction: ['Matters · Jurisdiction & governing law'],
  matter_stage: ['Matters · Stage & milestone'],
  audience: ['Document templates'],
  contact_type: ['Not yet assigned to a field'],
  enquiry_channel: ['Enquiries · Capture channel'],
  enquiry_urgency: ['Enquiries · Urgency & first-contact SLA'],
  enquiry_close_reason: ['Enquiries · Close / decline reason'],
  task_type: ['Tasks · Task type'],
  task_priority: ['Tasks · Priority'],
  task_status: ['Tasks · Status'],
};

const TYPE_LABEL: Record<string, string> = { person: 'Person', organisation: 'Organisation', link: 'Person–organisation link' };

/** Human-readable list of places a list is used. */
export function whereUsed(listKey: string, customFieldUsage: string[] = []): string[] {
  const fromFields = ALL_FIELDS.filter((f) => f.listKey === listKey).map(
    (f) => `${TYPE_LABEL[f.recordType]} · ${f.label}`,
  );
  return [...fromFields, ...customFieldUsage, ...(OTHER_USAGE[listKey] ?? [])].filter(
    (v, i, arr) => arr.indexOf(v) === i,
  );
}

export interface FormatContext {
  values: ChoiceValue[];
  /** Resolve a person/organisation id to a display name. */
  nameOf: (id: string) => string;
}

export function formatAddress(a: Address | null | undefined, values?: ChoiceValue[]): string {
  if (!a) return '';
  const country = values && a.countryId ? resolveLabel(values, a.countryId) : '';
  return [a.line1, a.line2, a.town, a.county, a.postcode, country === 'United Kingdom' ? '' : country]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join(', ');
}

/** Format any registry field value as a plain string (used by audit and summaries). */
export function formatFieldValue(def: FieldDef, value: unknown, ctx: FormatContext): string {
  if (value === null || value === undefined || value === '') return '';
  switch (def.kind) {
    case 'choice':
      return resolveLabel(ctx.values, value as string);
    case 'choiceMulti':
      return (value as string[]).map((id) => resolveLabel(ctx.values, id)).join(', ');
    case 'employee':
    case 'record':
      return ctx.nameOf(value as string);
    case 'date':
      return formatDate(value as string);
    case 'bool':
      return value ? 'Yes' : 'No';
    case 'emails':
      return (value as Email[]).map((e) => e.address + (e.isPrimary ? ' (primary)' : '')).join(', ');
    case 'phones':
      return (value as Phone[]).map((ph) => ph.number).join(', ');
    case 'addresses':
      return (value as Address[]).map((a) => formatAddress(a, ctx.values)).join(' | ');
    case 'address':
      return formatAddress(value as Address, ctx.values);
    case 'otherNames':
      return (value as OtherName[]).map((n) => n.name).join(', ');
    case 'tags':
      return (value as string[]).join(', ');
    default:
      return String(value);
  }
}
