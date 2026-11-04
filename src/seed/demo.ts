/**
 * Demo data: Not A Law Firm LLP (Cardiff, Bristol, London).
 * All names, companies and numbers are fictional. Phone numbers use Ofcom drama ranges.
 * Every date is relative to `today`.
 */
import { addDays, calculateFirstContactDue, toIsoDate } from '@/domain/dates';
import { createDefaultHomePagesConfig } from '@/domain/homeConfig';
import { getActiveTenantConfiguration } from '@/platform/tenantRuntime';
import type {
  Address,
  AuditEntry,
  ChoiceList,
  ChoiceValue,
  CustomFieldDefinition,
  Email,
  Enquiry,
  EnquirySettings,
  HomePagesConfig,
  Matter,
  Note,
  NotificationItem,
  Organisation,
  OtherName,
  Person,
  PersonOrganisationLink,
  Phone,
  PmsLink,
  Quote,
  SignOffItem,
  Task,
  TaskSettings,
  Team,
} from '@/domain/types';
import { buildSeedLists, vid } from './lists';

export const FIRM = { name: 'Not A Law Firm LLP', shortName: 'Not A Law Firm', offices: ['Cardiff', 'Bristol', 'London'] };
export const DEFAULT_USER_ID = 'P-000001';

export const DEFAULT_ENQUIRY_SETTINGS: EnquirySettings = {
  emergencyHours: 2,
  urgentSameDayEnd: true,
  standardNextDayEnd: true,
  workDayStart: '09:00',
  workDayEnd: '17:30',
  workingDays: [1, 2, 3, 4, 5],
  failedAttemptsBeforeSuggestNoResponse: 3,
  retentionMonths: 12,
};

export const DEFAULT_TASK_SETTINGS: TaskSettings = {
  templates: [
    {
      trigger: 'enquiry_contact',
      label: 'New enquiry saved',
      titleTemplate: 'Contact new enquiry: {name}',
      taskTypeId: 'task_type.call_back',
      priorityId: 'task_priority.normal',
      dueWorkingDaysOffset: 1,
    },
    {
      trigger: 'non_engagement_letter',
      label: 'Enquiry declined or referred out',
      titleTemplate: 'Send non-engagement letter: {name}',
      taskTypeId: 'task_type.send_letter',
      priorityId: 'task_priority.normal',
      dueWorkingDaysOffset: 2,
    },
    {
      trigger: 'complete_matter_opening',
      label: 'Enquiry converted to matter',
      titleTemplate: 'Complete matter opening: {matterNumber}',
      taskTypeId: 'task_type.complete_matter_opening',
      priorityId: 'task_priority.high',
      dueWorkingDaysOffset: 5,
    },
  ],
};

export interface DemoData {
  people: Person[];
  organisations: Organisation[];
  links: PersonOrganisationLink[];
  matters: Matter[];
  teams: Team[];
  tasks: Task[];
  enquiries: Enquiry[];
  quotes: Quote[];
  notifications: NotificationItem[];
  enquirySettings: EnquirySettings;
  taskSettings: TaskSettings;
  signOffs: SignOffItem[];
  homePagesConfig: HomePagesConfig;
  notes: Note[];
  audit: AuditEntry[];
  customFields: CustomFieldDefinition[];
  customLists: ChoiceList[];
  customValues: ChoiceValue[];
  recentlyViewed: Record<string, string[]>;
  counters: Record<string, number>;
}

export function buildDemoData(today: Date = new Date()): DemoData {
  const day = (offset: number) => toIsoDate(addDays(today, offset));
  const ts = (offset: number, hour = 10) => {
    const d = addDays(today, offset);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  const v = vid;
  let seq = 0;
  const sid = (prefix: string) => `${prefix}${++seq}`;

  const email = (address: string, type = 'Work', isPrimary = true): Email => ({
    id: sid('e'),
    address,
    typeId: v('email_type', type),
    isPrimary,
  });
  const phone = (number: string, type = 'Direct'): Phone => ({ id: sid('t'), number, typeId: v('phone_type', type) });
  const addr = (line1: string, town: string, postcode: string, type = 'Work', line2 = '', county = ''): Address => ({
    id: sid('a'),
    typeId: v('address_type', type),
    line1,
    line2,
    town,
    county,
    postcode,
    countryId: v('country', 'United Kingdom'),
  });
  const otherName = (name: string, type: string, list = 'other_name_type'): OtherName => ({
    id: sid('n'),
    name,
    typeId: v(list, type),
  });

  // ------------------------------------------------------------------ people
  const personDefaults = (id: string, createdOffset: number, createdBy = 'P-000004'): Person => ({
    id,
    recordType: 'person',
    recordOwnerId: 'P-000001',
    recordStatusId: v('person_record_status', 'Active'),
    createdById: createdBy,
    createdAt: ts(createdOffset),
    updatedById: createdBy,
    updatedAt: ts(createdOffset),
    sourceId: v('data_source', 'Manual entry'),
    lastVerifiedAt: day(-60),
    tags: [],
    duplicateStatusId: v('duplicate_status', 'None'),
    notDuplicateOf: [],
    possibleMatchIds: [],
    mergedIntoId: null,
    lastInteractionAt: null,
    customFields: {},
    titleId: null,
    firstName: '',
    middleNames: '',
    surname: '',
    preferredName: '',
    dateOfBirth: null,
    otherNames: [],
    jobTitle: '',
    emails: [],
    phones: [],
    preferredContactMethodId: v('contact_method', 'Email'),
    preferredLanguageId: v('language', 'English'),
    addresses: [],
    website: '',
    relationshipOwnerId: null,
    relationshipStatusId: v('relationship_status', 'Active'),
    relationshipStandingId: null,
    relationshipRoleIds: [],
    originId: null,
    firstKnownAt: null,
    engagementLevelId: null,
    interests: '',
    relationshipNotes: '',
    marketingConsentId: v('marketing_consent', 'Not asked'),
    consentRecord: '',
    verificationStatusId: v('verification_status', 'Not required'),
    verifiedAt: null,
    verificationMethodId: null,
    verificationReviewerId: null,
    riskReferences: '',
    isEmployee: false,
    employeeRoleId: null,
    departmentId: null,
  });

  const includeSyntheticEntraOids = (() => {
    if (process.env.NODE_ENV === 'production') {
      return false;
    }
    try {
      const cfg = getActiveTenantConfiguration();
      if (cfg.environment === 'live') {
        return false;
      }
      if (cfg.featureFlags?.enableDemoMode === true) {
        return true;
      }
      if (cfg.featureFlags?.enableDemoMode === false) {
        return false;
      }
      return process.env.NODE_ENV === 'test';
    } catch {
      return process.env.NODE_ENV === 'test';
    }
  })();

  const people: Person[] = [];
  const addPerson = (id: string, createdOffset: number, fields: Partial<Person>) => {
    const defaultEntraOid =
      includeSyntheticEntraOids && fields.isEmployee && fields.entraObjectId === undefined
        ? `00000000-0000-4000-8000-${id.replace(/[^0-9]/g, '').padStart(12, '0')}`
        : undefined;
    const p = {
      ...personDefaults(id, createdOffset),
      ...(defaultEntraOid ? { entraObjectId: defaultEntraOid } : {}),
      ...fields,
    };
    people.push(p);
    return p;
  };

  // Employees (10, covering all 8 roles)
  const employee = (
    n: number,
    title: string,
    first: string,
    surname: string,
    role: string,
    dept: string,
    jobTitle: string,
    office: 'Cardiff' | 'Bristol' | 'London',
    extra: Partial<Person> = {},
  ) => {
    const id = `P-${String(n).padStart(6, '0')}`;
    const phoneByOffice = { Cardiff: `029 2018 0${String(100 + n)}`, Bristol: `0117 496 0${String(100 + n)}`, London: `020 7946 0${String(100 + n)}` };
    const officeAddr = {
      Cardiff: addr('3 Bute Dock Chambers, Mount Stuart Square', 'Cardiff', 'CF10 5FQ', 'Work'),
      Bristol: addr('21 Redcliffe Quay', 'Bristol', 'BS1 6HU', 'Work'),
      London: addr('9 Temple Row Chambers, Fleet Street', 'London', 'EC4Y 1AA', 'Work'),
    };
    const slugFirst = first.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const slugSurname = surname.toLowerCase();
    return addPerson(id, -900 + n, {
      titleId: v('title', title),
      firstName: first,
      surname,
      jobTitle,
      emails: [
        email(`${slugFirst}.${slugSurname}@notalawfirm.example`),
      ],
      phones: [phone(phoneByOffice[office], 'Direct')],
      addresses: [officeAddr[office]],
      relationshipStatusId: v('relationship_status', 'Active'),
      relationshipRoleIds: [v('person_role', 'Internal colleague')],
      isEmployee: true,
      employeeRoleId: v('employee_role', role),
      departmentId: v('department', dept),
      recordOwnerId: 'P-000004',
      lastVerifiedAt: day(-30),
      ...extra,
    });
  };

  employee(1, 'Ms', 'Rhian', 'Morgan', 'Partner', 'Real Estate', 'Partner, Head of Real Estate', 'Cardiff', {
    roles: ['partner', 'fee_earner'],
  });
  employee(2, 'Mr', 'Dafydd', 'Evans', 'Fee earner', 'Real Estate', 'Senior Associate', 'Cardiff', {
    roles: ['fee_earner'],
  });
  employee(3, 'Mrs', 'Bethan', 'Rees', 'Risk and compliance', 'Risk & Compliance', 'Head of Risk and Compliance (COLP)', 'Cardiff', {
    roles: ['risk_compliance', 'fee_earner', 'partner'],
  });
  employee(4, 'Mr', 'Huw', 'Pritchard', 'System administrator', 'IT & Systems', 'Systems Administrator', 'Cardiff', {
    roles: [
      'admin',
      'fee_earner',
      'partner',
      'legal_secretary',
      'enquiries_coordinator',
      'finance',
      'risk_compliance',
      'managing_partner',
    ],
  });
  employee(5, 'Ms', 'Siân', 'Llewellyn', 'Partner', 'Private Client', 'Partner, Private Client', 'Bristol', {
    roles: ['partner', 'fee_earner'],
  });
  employee(6, 'Mr', 'Owain', 'Jenkins', 'Fee earner', 'Dispute Resolution', 'Associate Solicitor', 'London', {
    roles: ['fee_earner'],
  });
  employee(7, 'Ms', 'Catrin', 'Hopkins', 'Practice manager', 'Corporate & Commercial', 'Practice Manager, Corporate', 'Bristol', {
    roles: ['partner', 'fee_earner'],
  });
  employee(8, 'Ms', 'Lowri', 'Thomas', 'Business development', 'Business Development', 'Business Development Manager', 'Cardiff', {
    roles: ['enquiries_coordinator', 'fee_earner'],
  });
  employee(9, 'Mr', 'Gethin', 'Powell', 'Finance', 'Finance', 'Finance Manager', 'Cardiff', {
    roles: ['finance'],
  });
  employee(10, 'Ms', 'Nia', 'Edwards', 'Support staff', 'Real Estate', 'Legal Secretary', 'Cardiff', {
    roles: ['legal_secretary', 'enquiries_coordinator'],
    supportsIds: ['P-000001', 'P-000002'],
  });

  // ------------------------------------------------------------------ organisations
  const orgDefaults = (id: string, createdOffset: number, createdBy = 'P-000008'): Organisation => ({
    id,
    recordType: 'organisation',
    recordOwnerId: 'P-000001',
    recordStatusId: v('organisation_record_status', 'Active'),
    createdById: createdBy,
    createdAt: ts(createdOffset),
    updatedById: createdBy,
    updatedAt: ts(createdOffset),
    sourceId: v('data_source', 'Manual entry'),
    lastVerifiedAt: day(-90),
    tags: [],
    duplicateStatusId: v('duplicate_status', 'None'),
    notDuplicateOf: [],
    possibleMatchIds: [],
    mergedIntoId: null,
    lastInteractionAt: null,
    customFields: {},
    legalName: '',
    otherNames: [],
    organisationTypeId: v('organisation_type', 'Company'),
    companyNumber: '',
    vatNumber: '',
    countryOfRegistrationId: v('country', 'United Kingdom'),
    registeredAddress: null,
    correspondenceAddress: null,
    peopleWithSignificantControl: [],
    directors: [],
    website: '',
    mainPhone: '',
    generalEmail: '',
    parentOrganisationId: null,
    relationshipPartnerId: 'P-000001',
    relationshipTypeIds: [],
    relationshipStatusId: v('relationship_status', 'Active'),
    relationshipStandingId: null,
    sectorId: null,
    clientTierId: null,
    originId: null,
    relationshipStartedAt: null,
    engagementLevelId: null,
    pipelineStageId: null,
    bdNotes: '',
    clientReference: '',
    onboardingStatusId: null,
    conflictStatusId: null,
    conflictReference: '',
    riskRatingId: null,
    riskAssessmentStatusId: null,
    verificationStatusId: null,
    billingAddress: null,
    invoicePreferenceId: null,
    paymentTermsId: null,
    creditControlNotes: '',
    engagementTermsRef: '',
    reviewDate: null,
    reviewerId: null,
  });

  const organisations: Organisation[] = [];
  const addOrg = (n: number, createdOffset: number, fields: Partial<Organisation>) => {
    const id = `O-${String(n).padStart(6, '0')}`;
    const o = { ...orgDefaults(id, createdOffset), ...fields };
    organisations.push(o);
    return o;
  };

  const client = (tier: string, sector: string, extra: Partial<Organisation> = {}): Partial<Organisation> => ({
    relationshipTypeIds: [v('organisation_relationship_type', 'Client')],
    relationshipStandingId: v('relationship_standing', 'Instructing'),
    sectorId: v('sector', sector),
    clientTierId: v('client_tier', tier),
    onboardingStatusId: v('onboarding_status', 'Complete'),
    conflictStatusId: v('conflict_status', 'Cleared'),
    riskRatingId: v('risk_rating', 'Low'),
    riskAssessmentStatusId: v('risk_assessment_status', 'Complete'),
    verificationStatusId: v('verification_status', 'Verified'),
    invoicePreferenceId: v('invoice_preference', 'Email (PDF)'),
    paymentTermsId: v('payment_terms', '30 days'),
    engagementLevelId: v('engagement_level', 'Engaged'),
    pipelineStageId: v('pipeline_stage', 'Repeat Instructions'),
    reviewerId: 'P-000003',
    reviewDate: day(120),
    ...extra,
  });

  const penarth = addOrg(1, -700, {
    legalName: 'Penarth Estates Ltd',
    companyNumber: 'DEMO-000001',
    vatNumber: 'GB 000 0001 01',
    registeredAddress: addr('Marina House, 14 Ferry Road', 'Penarth', 'CF64 1TQ', 'Registered office', '', 'Vale of Glamorgan'),
    correspondenceAddress: addr('Marina House, 14 Ferry Road', 'Penarth', 'CF64 1TQ', 'Correspondence', '', 'Vale of Glamorgan'),
    website: 'https://penarthestates.example',
    mainPhone: '029 2018 0410',
    generalEmail: 'info@penarthestates.example',
    relationshipStartedAt: day(-1800),
    originId: v('origin', 'Professional Referral — Accountant'),
    clientReference: 'PEN001',
    lastInteractionAt: day(-2),
    tags: ['commercial property', 'key account'],
    ...client('Gold', 'Real Estate & Construction'),
  });

  const harbourline = addOrg(2, -680, {
    legalName: 'Harbourline Housing Association',
    otherNames: [otherName('Harbourline Homes', 'Trading name', 'org_name_type')],
    organisationTypeId: v('organisation_type', 'Non-profit'),
    companyNumber: 'DEMO-RS0002',
    registeredAddress: addr('Harbour Court, 2 Stuart Street', 'Cardiff', 'CF10 5BW', 'Registered office'),
    website: 'https://harbourline.example',
    mainPhone: '029 2018 0520',
    generalEmail: 'legal@harbourline.example',
    relationshipStartedAt: day(-2500),
    originId: v('origin', 'Panel Appointment'),
    clientReference: 'HAR001',
    lastInteractionAt: day(-6),
    customFields: { cf_panel_appointment: v('cf_panel_appointment', 'Panel member') },
    ...client('Platinum', 'Public Sector & Charity', {
      relationshipStandingId: v('relationship_standing', 'Key Account'),
      engagementLevelId: v('engagement_level', 'Advocate'),
      pipelineStageId: v('pipeline_stage', 'Panel / Preferred Status'),
      riskRatingId: v('risk_rating', 'Medium'),
    }),
  });

  const brightwater = addOrg(3, -400, {
    legalName: 'Brightwater Care Group Ltd',
    companyNumber: 'DEMO-000003',
    vatNumber: 'GB 000 0003 03',
    registeredAddress: addr('Brightwater House, 40 Whiteladies Road', 'Bristol', 'BS8 2LG', 'Registered office'),
    website: 'https://brightwatercare.example',
    mainPhone: '0117 496 0730',
    generalEmail: 'enquiries@brightwatercare.example',
    relationshipStartedAt: day(-380),
    originId: v('origin', 'Professional Referral — Accountant'),
    clientReference: 'BRI001',
    lastInteractionAt: day(-2),
    relationshipPartnerId: 'P-000005',
    ...client('Silver', 'Healthcare & Life Sciences', {
      reviewDate: day(-21),
      riskRatingId: v('risk_rating', 'Medium'),
    }),
  });

  const bayCafes = addOrg(4, -520, {
    legalName: 'Bay Cafés Ltd',
    otherNames: [otherName('Bay Cafés', 'Trading name', 'org_name_type')],
    companyNumber: 'DEMO-000004',
    registeredAddress: addr('Unit 6, Mermaid Quay', 'Cardiff', 'CF10 5BZ', 'Registered office'),
    mainPhone: '029 2018 0633',
    generalEmail: 'hello@baycafes.example',
    relationshipStartedAt: day(-530),
    originId: v('origin', 'Existing Client Referral'),
    clientReference: 'BAY001',
    lastInteractionAt: day(-12),
    ...client('Bronze', 'Retail & Consumer', {
      verificationStatusId: v('verification_status', 'Expired'),
      lastVerifiedAt: day(-400),
      engagementLevelId: v('engagement_level', 'Receptive'),
    }),
  });

  const severn = addOrg(5, -650, {
    legalName: 'Severn Holdings plc',
    organisationTypeId: v('organisation_type', 'plc'),
    companyNumber: 'DEMO-000005',
    vatNumber: 'GB 000 0005 05',
    registeredAddress: addr('Severn House, 1 Temple Quay', 'Bristol', 'BS1 6DZ', 'Registered office'),
    website: 'https://severnholdings.example',
    mainPhone: '0117 496 0810',
    generalEmail: 'cosec@severnholdings.example',
    relationshipStartedAt: day(-2100),
    originId: v('origin', 'Directory / Chambers / Legal 500'),
    clientReference: 'SEV001',
    relationshipPartnerId: 'P-000007',
    customFields: { cf_panel_appointment: v('cf_panel_appointment', 'Preferred supplier') },
    ...client('Platinum', 'Manufacturing & Industrial', { relationshipStandingId: v('relationship_standing', 'Key Account') }),
  });

  const severnLogistics = addOrg(6, -640, {
    legalName: 'Severn Logistics Ltd',
    companyNumber: 'DEMO-000006',
    parentOrganisationId: severn.id,
    registeredAddress: addr('Severn House, 1 Temple Quay', 'Bristol', 'BS1 6DZ', 'Registered office'),
    correspondenceAddress: addr('Avonmouth Distribution Park, Kings Weston Lane', 'Bristol', 'BS11 8AZ', 'Correspondence'),
    mainPhone: '0117 496 0822',
    clientReference: 'SEV002',
    originId: v('origin', 'Professional Referral — Accountant'),
    relationshipPartnerId: 'P-000007',
    ...client('Gold', 'Manufacturing & Industrial'),
  });

  const severnProperty = addOrg(7, -630, {
    legalName: 'Severn Freight Services Ltd',
    otherNames: [otherName('Severn Property Investments Ltd', 'Former name', 'org_name_type')],
    companyNumber: 'DEMO-000007',
    parentOrganisationId: severn.id,
    registeredAddress: addr('Unit 12, Avonmouth Way', 'Bristol', 'BS11 9HX', 'Registered office'),
    clientReference: 'SEV003',
    ...client('Silver', 'Manufacturing & Industrial', { lastVerifiedAt: day(-490) }),
  });

  const hughesLloyd = addOrg(8, -800, {
    legalName: 'Hughes Lloyd Accountants LLP',
    otherNames: [otherName('Hughes Lloyd', 'Trading name', 'org_name_type')],
    organisationTypeId: v('organisation_type', 'LLP'),
    companyNumber: 'DEMO-OC0008',
    registeredAddress: addr('7 Windsor Place', 'Cardiff', 'CF10 3BX', 'Registered office'),
    website: 'https://hugheslloyd.example',
    mainPhone: '029 2018 0745',
    generalEmail: 'office@hugheslloyd.example',
    relationshipTypeIds: [v('organisation_relationship_type', 'Referrer'), v('organisation_relationship_type', 'Professional adviser')],
    relationshipStandingId: v('relationship_standing', 'Active'),
    sectorId: v('sector', 'Professional Services'),
    engagementLevelId: v('engagement_level', 'Advocate'),
    originId: v('origin', 'Event / Conference'),
    relationshipStartedAt: day(-3000),
    lastInteractionAt: day(-120),
    bdNotes: 'Our third most valuable referrer. Referral arrangement: none, no fee payable. Look for opportunities to refer back.',
    tags: ['referrer'],
  });

  const morganPrice = addOrg(9, -300, {
    legalName: 'Morgan Price Solicitors',
    organisationTypeId: v('organisation_type', 'Law firm'),
    registeredAddress: addr('18 Park Place', 'Cardiff', 'CF10 3DQ', 'Registered office'),
    mainPhone: '029 2018 0861',
    generalEmail: 'reception@morganprice.example',
    relationshipTypeIds: [v('organisation_relationship_type', 'Opposing solicitors')],
    relationshipStatusId: v('relationship_status', 'Active'),
    sectorId: v('sector', 'Professional Services'),
    relationshipPartnerId: null,
  });

  const chambers = addOrg(10, -900, {
    legalName: 'Taff Street Chambers',
    organisationTypeId: v('organisation_type', "Barristers' chambers"),
    registeredAddress: addr('2 Taff Street', 'Cardiff', 'CF10 1PE', 'Correspondence'),
    mainPhone: '029 2018 0905',
    generalEmail: 'clerks@taffstreetchambers.example',
    relationshipTypeIds: [v('organisation_relationship_type', 'Barristers')],
    sectorId: v('sector', 'Professional Services'),
    relationshipPartnerId: 'P-000006',
  });

  const cadwyn = addOrg(11, -850, {
    legalName: 'Cadwyn Surveying & Valuation Ltd',
    companyNumber: 'DEMO-000011',
    registeredAddress: addr('Cadwyn House, 55 Cowbridge Road East', 'Cardiff', 'CF11 9AU', 'Registered office'),
    mainPhone: '029 2018 0950',
    relationshipTypeIds: [v('organisation_relationship_type', 'Experts and consultants')],
    sectorId: v('sector', 'Professional Services'),
    lastVerifiedAt: day(-470),
    relationshipPartnerId: 'P-000002',
  });

  const castell = addOrg(12, -880, {
    legalName: 'Castell Legal Search Ltd',
    organisationTypeId: v('organisation_type', 'Supplier'),
    companyNumber: 'DEMO-000012',
    registeredAddress: addr('Unit 4, Castell Business Park', 'Caerphilly', 'CF83 3ED', 'Registered office'),
    mainPhone: '029 2018 0977',
    generalEmail: 'orders@castellsearch.example',
    relationshipTypeIds: [v('organisation_relationship_type', 'Supplier')],
    sectorId: v('sector', 'Professional Services'),
    paymentTermsId: v('payment_terms', '30 days'),
    lastVerifiedAt: day(-430),
    relationshipPartnerId: 'P-000009',
  });

  const tyGlas = addOrg(13, -20, {
    legalName: 'Tŷ Glas Developments Ltd',
    companyNumber: 'DEMO-000013',
    registeredAddress: addr('Tŷ Glas, 9 Heol y Deri', 'Cardiff', 'CF14 6HF', 'Registered office'),
    website: 'https://tyglas.example',
    mainPhone: '029 2018 0988',
    generalEmail: 'info@tyglas.example',
    relationshipTypeIds: [v('organisation_relationship_type', 'Prospect')],
    relationshipStatusId: v('relationship_status', 'Prospective'),
    relationshipStandingId: v('relationship_standing', 'Warm'),
    sectorId: v('sector', 'Real Estate & Construction'),
    pipelineStageId: v('pipeline_stage', 'Qualified'),
    originId: v('origin', 'Website / Digital Enquiry'),
    sourceId: v('data_source', 'Website enquiry'),
    onboardingStatusId: v('onboarding_status', 'In progress'),
    conflictStatusId: v('conflict_status', 'Potential conflict'),
    conflictReference: 'CC-2026-0418',
    riskRatingId: v('risk_rating', 'Conflict Flagged'),
    bdNotes: 'Site acquisition enquiry, est. £40k fees. Possible conflict: Coastline Outdoor Ltd is a counterparty on a related site.',
    duplicateStatusId: v('duplicate_status', 'Possible match'),
    possibleMatchIds: ['O-000016'],
    lastVerifiedAt: day(-20),
    lastInteractionAt: day(-1),
  });

  const westernVale = addOrg(14, -45, {
    legalName: 'Western Vale Homes Ltd',
    companyNumber: 'DEMO-000014',
    registeredAddress: addr('Vale Court, 3 Station Road', 'Llantrisant', 'CF72 8EG', 'Registered office'),
    website: 'https://westernvalehomes.example',
    relationshipTypeIds: [v('organisation_relationship_type', 'Prospect')],
    relationshipStatusId: v('relationship_status', 'Prospective'),
    relationshipStandingId: v('relationship_standing', 'Target'),
    sectorId: v('sector', 'Real Estate & Construction'),
    pipelineStageId: v('pipeline_stage', 'Initial Contact'),
    originId: v('origin', 'Event / Conference'),
    bdNotes: 'Met at RICS dinner. Plot sales programme, est. £60k.',
    lastVerifiedAt: day(-45),
    relationshipPartnerId: 'P-000008',
  });

  const coastline = addOrg(15, -200, {
    legalName: 'Coastline Outdoor Ltd',
    companyNumber: 'DEMO-000015',
    registeredAddress: addr('Coastline House, 12 Ocean Way', 'Cardiff', 'CF24 5PE', 'Registered office'),
    relationshipTypeIds: [v('organisation_relationship_type', 'Counterparty')],
    relationshipStatusId: v('relationship_status', 'Active'),
    sectorId: v('sector', 'Retail & Consumer'),
    relationshipPartnerId: null,
    bdNotes: 'Tenant on the Unit 4, Cardiff Bay Retail Park lease (Penarth Estates).',
  });

  addOrg(16, -3, {
    legalName: 'Ty Glas Development Limited',
    registeredAddress: addr('9 Heol y Deri', 'Cardiff', 'CF14 6HF', 'Registered office'),
    relationshipTypeIds: [v('organisation_relationship_type', 'Prospect')],
    relationshipStatusId: v('relationship_status', 'Prospective'),
    sourceId: v('data_source', 'Website enquiry'),
    duplicateStatusId: v('duplicate_status', 'Possible match'),
    possibleMatchIds: [tyGlas.id],
    relationshipPartnerId: null,
    lastVerifiedAt: null,
    createdById: 'P-000010',
    updatedById: 'P-000010',
  });

  // ------------------------------------------------------------------ external people
  const role = (label: string) => v('person_role', label);
  let pn = 10;
  const ext = (createdOffset: number, fields: Partial<Person>) =>
    addPerson(`P-${String(++pn).padStart(6, '0')}`, createdOffset, {
      relationshipOwnerId: 'P-000001',
      ...fields,
    });

  const gareth = ext(-790, {
    titleId: v('title', 'Mr'),
    firstName: 'Gareth',
    surname: 'Hughes',
    jobTitle: 'Partner',
    emails: [email('gareth.hughes@hugheslloyd.example')],
    phones: [phone('029 2018 0746', 'Direct'), phone('07700 900461', 'Mobile')],
    addresses: [addr('7 Windsor Place', 'Cardiff', 'CF10 3BX', 'Work')],
    relationshipRoleIds: [role('Referrer'), role('Professional adviser')],
    relationshipStandingId: v('relationship_standing', 'Active'),
    engagementLevelId: v('engagement_level', 'Advocate'),
    originId: v('origin', 'Event / Conference'),
    firstKnownAt: day(-3000),
    lastInteractionAt: day(-120),
    interests: 'Rugby (Cardiff RFC season ticket), sailing.',
    marketingConsentId: v('marketing_consent', 'Consented'),
    lastVerifiedAt: day(-100),
  });

  const garethDup = ext(-5, {
    firstName: 'Gareth',
    surname: 'Hughes',
    emails: [email('gareth.hughes@hugheslloyd.example'), email('garethhughes@pmail.example', 'Personal', false)],
    phones: [phone('07700 900583', 'Mobile')],
    addresses: [addr('22 Plymouth Road', 'Penarth', 'CF64 3DH', 'Home')],
    relationshipRoleIds: [role('Referrer')],
    sourceId: v('data_source', 'Website enquiry'),
    duplicateStatusId: v('duplicate_status', 'Possible match'),
    possibleMatchIds: [gareth.id],
    relationshipOwnerId: null,
    lastVerifiedAt: null,
    createdById: 'P-000010',
    updatedById: 'P-000010',
    tags: ['newsletter'],
  });
  gareth.duplicateStatusId = v('duplicate_status', 'Possible match');
  gareth.possibleMatchIds = [garethDup.id];

  const mared = ext(-14, {
    titleId: v('title', 'Ms'),
    firstName: 'Mared',
    surname: 'Hughes',
    emails: [email('mared.hughes@pmail.example', 'Personal')],
    phones: [phone('07700 900218', 'Mobile')],
    addresses: [addr('41 Kings Road', 'Cardiff', 'CF11 9DA', 'Home', 'Pontcanna')],
    preferredLanguageId: v('language', 'Welsh'),
    preferredContactMethodId: v('contact_method', 'Mobile call'),
    relationshipRoleIds: [role('Private client')],
    relationshipStatusId: v('relationship_status', 'Prospective'),
    relationshipStandingId: v('relationship_standing', 'Warm'),
    originId: v('origin', 'Professional Referral — Accountant'),
    sourceId: v('data_source', 'Referral'),
    verificationStatusId: v('verification_status', 'In progress'),
    verificationMethodId: v('verification_method', 'Electronic ID check'),
    verificationReviewerId: 'P-000003',
    riskReferences: 'MLRO referral MR-2026-031',
    firstKnownAt: day(-14),
    lastInteractionAt: day(-4),
    relationshipOwnerId: 'P-000002',
    lastVerifiedAt: day(-14),
    tags: ['residential purchase'],
  });

  ext(-1, {
    titleId: v('title', 'Mrs'),
    firstName: 'Elin',
    surname: 'Parry',
    emails: [email('elin.parry@pmail.example', 'Personal')],
    phones: [phone('07700 900377', 'Mobile')],
    addresses: [addr('8 Romilly Crescent', 'Cardiff', 'CF11 9NP', 'Home')],
    relationshipRoleIds: [role('Private client')],
    relationshipStatusId: v('relationship_status', 'Prospective'),
    originId: v('origin', 'Professional Referral — Accountant'),
    sourceId: v('data_source', 'Referral'),
    verificationStatusId: v('verification_status', 'Not started'),
    lastVerifiedAt: day(-1),
    relationshipOwnerId: 'P-000002',
  });

  const owen = ext(-60, {
    titleId: v('title', 'Mr'),
    firstName: 'Owen',
    surname: 'Price',
    emails: [
      email('owen.price@pmail.example', 'Personal'),
      email('owen.price@example.com', 'Personal', false),
    ],
    phones: [phone('07700 900642', 'Mobile')],
    addresses: [addr('12 Heol y Plas', 'Cardiff', 'CF5 2LH', 'Home', 'Llandaff')],
    relationshipRoleIds: [role('Private client')],
    originId: v('origin', 'Website / Digital Enquiry'),
    sourceId: v('data_source', 'Website enquiry'),
    verificationStatusId: v('verification_status', 'Verified'),
    verifiedAt: day(-55),
    verificationMethodId: v('verification_method', 'Electronic ID check'),
    verificationReviewerId: 'P-000003',
    relationshipOwnerId: 'P-000002',
    customFields: { cf_will_held: true, cf_will_reference: 'W-2026-0217' },
  });

  ext(-60, {
    titleId: v('title', 'Mrs'),
    firstName: 'Carys',
    surname: 'Price',
    otherNames: [otherName('Carys Bowen', 'Maiden name')],
    emails: [email('carys.price@pmail.example', 'Personal')],
    phones: [phone('07700 900643', 'Mobile')],
    addresses: [owen.addresses[0] && { ...owen.addresses[0], id: sid('a') }],
    relationshipRoleIds: [role('Private client')],
    originId: v('origin', 'Website / Digital Enquiry'),
    sourceId: v('data_source', 'Website enquiry'),
    verificationStatusId: v('verification_status', 'Verified'),
    verifiedAt: day(-55),
    verificationMethodId: v('verification_method', 'Electronic ID check'),
    verificationReviewerId: 'P-000003',
    relationshipOwnerId: 'P-000002',
    customFields: { cf_will_held: true, cf_will_reference: 'W-2026-0218' },
  });

  const alun = ext(-690, {
    titleId: v('title', 'Mr'),
    firstName: 'Alun',
    surname: 'Davies',
    jobTitle: 'Managing Director',
    emails: [email('alun.davies@penarthestates.example'), email('alun@westernvalehomes.example', 'Work', false)],
    phones: [phone('029 2018 0411', 'Direct'), phone('07700 900115', 'Mobile')],
    addresses: [addr('Marina House, 14 Ferry Road', 'Penarth', 'CF64 1TQ', 'Work')],
    relationshipRoleIds: [role('Client contact')],
    relationshipStandingId: v('relationship_standing', 'Key Account'),
    engagementLevelId: v('engagement_level', 'Engaged'),
    lastInteractionAt: day(-2),
    marketingConsentId: v('marketing_consent', 'Consented'),
    interests: 'Golf; prefers early-morning calls.',
  });

  const seren = ext(-600, {
    titleId: v('title', 'Ms'),
    firstName: 'Seren',
    surname: 'Walters',
    jobTitle: 'Finance Manager',
    emails: [email('seren.walters@penarthestates.example')],
    phones: [phone('029 2018 0412', 'Direct')],
    relationshipRoleIds: [role('Client contact')],
    relationshipOwnerId: 'P-000009',
  });

  const mark = ext(-670, {
    titleId: v('title', 'Mr'),
    firstName: 'Mark',
    surname: 'Bevan',
    jobTitle: 'Chief Executive',
    emails: [email('mark.bevan@harbourline.example')],
    phones: [phone('029 2018 0521', 'Direct')],
    relationshipRoleIds: [role('Client contact')],
    engagementLevelId: v('engagement_level', 'Advocate'),
    lastInteractionAt: day(-6),
  });

  const ffion = ext(-660, {
    titleId: v('title', 'Ms'),
    firstName: 'Ffion',
    surname: 'Roberts',
    jobTitle: 'Head of Legal Services',
    emails: [email('ffion.roberts@harbourline.example')],
    phones: [phone('029 2018 0522', 'Direct'), phone('07700 900724', 'Mobile')],
    relationshipRoleIds: [role('Client contact')],
    preferredLanguageId: v('language', 'Welsh'),
    lastInteractionAt: day(-6),
  });

  const tom = ext(-380, {
    titleId: v('title', 'Mr'),
    firstName: 'Tom',
    surname: 'Griffiths',
    jobTitle: 'Operations Director',
    emails: [email('tom.griffiths@brightwatercare.example')],
    phones: [phone('0117 496 0731', 'Direct')],
    relationshipRoleIds: [role('Client contact')],
    relationshipOwnerId: 'P-000005',
    lastInteractionAt: day(-2),
  });

  const hannah = ext(-520, {
    titleId: v('title', 'Ms'),
    firstName: 'Hannah',
    surname: 'Lewis',
    jobTitle: 'Director',
    emails: [email('hannah@baycafes.example')],
    phones: [phone('07700 900389', 'Mobile')],
    relationshipRoleIds: [role('Client contact')],
  });

  const richard = ext(-640, {
    titleId: v('title', 'Mr'),
    firstName: 'Richard',
    surname: 'Ashworth',
    jobTitle: 'Chief Financial Officer',
    emails: [email('richard.ashworth@severnholdings.example')],
    phones: [phone('0117 496 0811', 'Direct')],
    relationshipRoleIds: [role('Client contact')],
    relationshipOwnerId: 'P-000007',
  });

  const emma = ext(-620, {
    titleId: v('title', 'Ms'),
    firstName: 'Emma',
    surname: 'Clarke',
    jobTitle: 'Property Director',
    emails: [email('emma.clarke@severnholdings.example')],
    phones: [phone('0117 496 0815', 'Direct')],
    relationshipRoleIds: [role('Client contact')],
    relationshipOwnerId: 'P-000007',
  });

  const iwan = ext(-290, {
    titleId: v('title', 'Mr'),
    firstName: 'Iwan',
    surname: 'Phillips',
    jobTitle: 'Partner',
    emails: [email('iwan.phillips@morganprice.example')],
    phones: [phone('029 2018 0862', 'Direct')],
    relationshipRoleIds: [role('Opposing party')],
    relationshipOwnerId: null,
    relationshipStatusId: v('relationship_status', 'Active'),
  });

  const lisa = ext(-200, {
    titleId: v('title', 'Ms'),
    firstName: 'Lisa',
    surname: 'Kendall',
    jobTitle: 'Associate',
    emails: [email('lisa.kendall@morganprice.example')],
    phones: [phone('029 2018 0863', 'Direct')],
    relationshipRoleIds: [role('Opposing party')],
    relationshipOwnerId: null,
  });

  const geraint = ext(-890, {
    titleId: v('title', 'Mr'),
    firstName: 'Geraint',
    surname: 'Williams',
    jobTitle: 'Barrister (KC)',
    emails: [email('gwilliams@taffstreetchambers.example')],
    phones: [phone('029 2018 0906', 'Work')],
    relationshipRoleIds: [role('Counsel')],
    relationshipOwnerId: 'P-000006',
    lastVerifiedAt: day(-450),
  });

  const sarah = ext(-840, {
    titleId: v('title', 'Dr'),
    firstName: 'Sarah',
    surname: 'Holt',
    jobTitle: 'Director, Valuation',
    emails: [email('sarah.holt@cadwynsurveying.example')],
    phones: [phone('029 2018 0951', 'Direct')],
    relationshipRoleIds: [role('Expert')],
    relationshipOwnerId: 'P-000002',
  });

  const paul = ext(-870, {
    titleId: v('title', 'Mr'),
    firstName: 'Paul',
    surname: 'Jones',
    jobTitle: 'Account Manager',
    emails: [email('paul.jones@castellsearch.example')],
    phones: [phone('029 2018 0978', 'Direct')],
    relationshipRoleIds: [role('Supplier contact')],
    relationshipOwnerId: 'P-000009',
    lastVerifiedAt: day(-400),
  });

  const llinos = ext(-20, {
    titleId: v('title', 'Ms'),
    firstName: 'Llinos',
    surname: 'Jenkins',
    jobTitle: 'Development Director',
    emails: [email('llinos.jenkins@tyglas.example')],
    phones: [phone('029 2018 0989', 'Direct')],
    relationshipRoleIds: [role('Client contact')],
    relationshipStatusId: v('relationship_status', 'Prospective'),
    sourceId: v('data_source', 'Website enquiry'),
    lastVerifiedAt: day(-20),
    lastInteractionAt: day(-1),
  });

  const james = ext(-45, {
    titleId: v('title', 'Mr'),
    firstName: 'James',
    surname: 'Whitfield',
    jobTitle: 'Managing Director',
    emails: [email('james.whitfield@westernvalehomes.example')],
    phones: [phone('07700 900855', 'Mobile')],
    relationshipRoleIds: [role('Client contact')],
    relationshipStatusId: v('relationship_status', 'Prospective'),
    relationshipOwnerId: 'P-000008',
    lastVerifiedAt: day(-45),
  });

  const dylan = ext(-200, {
    titleId: v('title', 'Mr'),
    firstName: 'Dylan',
    surname: 'Morris',
    jobTitle: 'Director',
    emails: [email('dylan.morris@coastlineoutdoor.example')],
    phones: [phone('029 2018 0995', 'Direct')],
    relationshipRoleIds: [role('Opposing party')],
    relationshipOwnerId: null,
    lastVerifiedAt: day(-550),
  });

  ext(-1500, {
    titleId: v('title', 'Mrs'),
    firstName: 'Margaret',
    middleNames: 'Ann',
    surname: 'Pryce',
    emails: [],
    phones: [phone('029 2018 0199', 'Home')],
    addresses: [addr('3 Cathedral Close', 'Cardiff', 'CF5 2EB', 'Home', 'Llandaff')],
    relationshipRoleIds: [role('Private client')],
    relationshipStatusId: v('relationship_status', 'Former'),
    recordStatusId: v('person_record_status', 'Deceased'),
    relationshipOwnerId: 'P-000005',
    preferredContactMethodId: v('contact_method', 'Post'),
    customFields: { cf_will_held: true, cf_will_reference: 'W-2019-0143' },
    relationshipNotes: 'Deceased. Executors: see estate administration file.',
    lastVerifiedAt: day(-200),
  });

  const anwen = ext(-760, {
    titleId: v('title', 'Mrs'),
    firstName: 'Anwen',
    surname: 'Lloyd',
    jobTitle: 'Tax Partner',
    emails: [email('anwen.lloyd@hugheslloyd.example')],
    phones: [phone('029 2018 0747', 'Direct')],
    relationshipRoleIds: [role('Referrer'), role('Professional adviser')],
    relationshipOwnerId: 'P-000005',
  });

  const robert = ext(-1200, {
    titleId: v('title', 'Mr'),
    firstName: 'Robert',
    surname: 'Hale',
    jobTitle: 'Former Operations Manager',
    emails: [email('rob.hale@pmail.example', 'Personal')],
    relationshipRoleIds: [role('Client contact')],
    relationshipStatusId: v('relationship_status', 'Former'),
    recordStatusId: v('person_record_status', 'Archived'),
    lastVerifiedAt: day(-700),
  });

  const nerys = ext(-150, {
    titleId: v('title', 'Ms'),
    firstName: 'Nerys',
    surname: 'Watkins',
    jobTitle: 'Company Secretary',
    emails: [email('nerys.watkins@severnholdings.example')],
    phones: [phone('0117 496 0812', 'Direct')],
    relationshipRoleIds: [role('Client contact')],
    relationshipOwnerId: 'P-000007',
  });

  // ------------------------------------------------------------------ links
  const links: PersonOrganisationLink[] = [];
  let ln = 0;
  const link = (
    person: Person,
    org: Organisation,
    fields: Partial<PersonOrganisationLink> & { roles?: string[] } = {},
  ) => {
    const { roles = [], ...rest } = fields;
    const created = person.createdAt > org.createdAt ? person.createdAt : org.createdAt;
    links.push({
      id: `L-${String(++ln).padStart(6, '0')}`,
      personId: person.id,
      organisationId: org.id,
      jobTitle: person.jobTitle,
      department: '',
      roleWithinOrganisation: '',
      contactRoleIds: roles.map((r) => v('contact_role', r)),
      isPrimaryContact: false,
      isCurrent: true,
      startDate: null,
      endDate: null,
      contactStatusId: v('contact_status', 'Active'),
      createdById: person.createdById,
      createdAt: created,
      updatedById: person.createdById,
      updatedAt: created,
      ...rest,
    });
  };

  link(alun, penarth, { roles: ['Key relationship contact', 'Decision-maker or sponsor'], isPrimaryContact: true, department: 'Board', roleWithinOrganisation: 'Director', startDate: day(-4000) });
  link(alun, westernVale, { jobTitle: 'Non-executive Director', roles: ['Decision-maker or sponsor'], roleWithinOrganisation: 'Non-executive director', startDate: day(-400) });
  link(seren, penarth, { roles: ['Billing'], department: 'Finance', startDate: day(-1500) });
  link(mark, harbourline, { roles: ['Key relationship contact', 'Decision-maker or sponsor'], isPrimaryContact: true, department: 'Executive', startDate: day(-2200) });
  link(ffion, harbourline, { roles: ['Legal or compliance', 'Operational'], department: 'Legal Services', startDate: day(-1800) });
  link(tom, brightwater, { roles: ['Key relationship contact', 'Operational'], isPrimaryContact: true, department: 'Operations', startDate: day(-500) });
  link(tom, severnLogistics, { jobTitle: 'Head of Operations', roles: ['Operational'], isCurrent: false, startDate: day(-2400), endDate: day(-520), contactStatusId: v('contact_status', 'Left organisation') });
  link(hannah, bayCafes, { roles: ['Key relationship contact', 'Billing', 'Decision-maker or sponsor'], isPrimaryContact: true, roleWithinOrganisation: 'Owner', startDate: day(-2000) });
  link(robert, bayCafes, { roles: ['Operational'], isCurrent: false, startDate: day(-1900), endDate: day(-800), contactStatusId: v('contact_status', 'Left organisation') });
  link(richard, severn, { roles: ['Key relationship contact', 'Decision-maker or sponsor'], isPrimaryContact: true, department: 'Finance', startDate: day(-1600) });
  link(nerys, severn, { roles: ['Legal or compliance'], department: 'Company Secretariat', startDate: day(-150) });
  link(emma, severnProperty, { roles: ['Key relationship contact', 'Operational'], isPrimaryContact: true, department: 'Property', startDate: day(-1100) });
  link(gareth, hughesLloyd, { roles: ['Key relationship contact'], isPrimaryContact: true, roleWithinOrganisation: 'Partner', department: 'Business Advisory', startDate: day(-5000) });
  link(anwen, hughesLloyd, { roles: ['Other'], roleWithinOrganisation: 'Partner', department: 'Tax', startDate: day(-4200) });
  link(iwan, morganPrice, { roles: ['Key relationship contact'], isPrimaryContact: true, department: 'Commercial Property', startDate: day(-3000) });
  link(lisa, morganPrice, { roles: ['Operational'], department: 'Commercial Property', startDate: day(-700) });
  link(geraint, chambers, { roles: ['Key relationship contact'], isPrimaryContact: true, roleWithinOrganisation: 'Member of chambers' });
  link(sarah, cadwyn, { roles: ['Key relationship contact'], isPrimaryContact: true, department: 'Valuation' });
  link(paul, castell, { roles: ['Key relationship contact', 'Billing'], isPrimaryContact: true });
  link(llinos, tyGlas, { roles: ['Key relationship contact', 'Decision-maker or sponsor'], isPrimaryContact: true, startDate: day(-900) });
  link(james, westernVale, { roles: ['Key relationship contact', 'Decision-maker or sponsor'], isPrimaryContact: true, startDate: day(-1300) });
  link(dylan, coastline, { roles: ['Key relationship contact'], isPrimaryContact: true, startDate: day(-2600) });

  // ------------------------------------------------------------------ matters
  const matters: Matter[] = [];
  let mn = 0;
  const subId = (practiceArea: string, subcat: string) =>
    v('work_type', `${practiceArea.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '_')} ${subcat}`);
  const jurSysId = (group: string, sys: string) =>
    v('jurisdiction', `${group.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '_')} ${sys}`);
  const msId = (stage: string, milestone: string) =>
    v('matter_stage', `${stage.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '_')} ${milestone}`);

  const seedPracticeAreaOrgAssignment: Record<
    string,
    { owningDepartmentId: string; owningTeamId: string }
  > = {
    [v('work_type', 'Real Estate & Property')]: {
      owningDepartmentId: 'DEPT-RE',
      owningTeamId: 'TPG-RE-COMM',
    },
    [v('work_type', 'Corporate & Commercial')]: {
      owningDepartmentId: 'DEPT-CORP',
      owningTeamId: 'TPG-CORP-MA',
    },
    [v('work_type', 'Banking, Finance & Restructuring')]: {
      owningDepartmentId: 'DEPT-CORP',
      owningTeamId: 'TPG-CORP-MA',
    },
    [v('work_type', 'Dispute Resolution & Litigation')]: {
      owningDepartmentId: 'DEPT-DR',
      owningTeamId: 'TPG-DR-COM',
    },
    [v('work_type', 'Private Client, Trusts & Family')]: {
      owningDepartmentId: 'DEPT-PC',
      owningTeamId: 'TPG-PC-WILLS',
    },
    [v('work_type', 'Employment & HR')]: {
      owningDepartmentId: 'DEPT-EMP',
      owningTeamId: 'TPG-EMP-ADV',
    },
    [v('work_type', 'Regulatory, Public & Specialist')]: {
      owningDepartmentId: 'DEPT-RISK',
      owningTeamId: 'TPG-RISK-AML',
    },
  };

  const addMatter = (
    createdOffset: number,
    fields: Partial<Matter> & Pick<Matter, 'matterNumber' | 'title' | 'clientId' | 'practiceAreaId' | 'workTypeSubcategoryId'>,
  ): Matter => {
    const id = `M-${String(++mn).padStart(6, '0')}`;
    const createdBy = fields.leadFeeEarnerId || 'P-000001';
    const seedOrg = seedPracticeAreaOrgAssignment[fields.practiceAreaId];
    const m: Matter = {
      id,
      recordType: 'matter',
      recordOwnerId: createdBy,
      recordStatusId: v('matter_status', 'Active'),
      createdById: createdBy,
      createdAt: ts(createdOffset),
      updatedById: createdBy,
      updatedAt: ts(Math.min(createdOffset + 15, -1)),
      sourceId: v('data_source', 'Manual entry'),
      lastVerifiedAt: day(-14),
      tags: [],
      duplicateStatusId: v('duplicate_status', 'None'),
      notDuplicateOf: [],
      possibleMatchIds: [],
      mergedIntoId: null,
      lastInteractionAt: day(-2),
      customFields: {},
      matterNumber: fields.matterNumber,
      title: fields.title,
      shortDescription: fields.shortDescription ?? '',
      clientId: fields.clientId,
      additionalClientIds: fields.additionalClientIds ?? [],
      parentMatterId: fields.parentMatterId ?? null,
      relatedMatterIds: fields.relatedMatterIds ?? [],
      matterStatusId: fields.matterStatusId ?? v('matter_status', 'Active'),
      practiceAreaId: fields.practiceAreaId,
      workTypeSubcategoryId: fields.workTypeSubcategoryId,
      owningDepartmentId:
        fields.owningDepartmentId !== undefined
          ? fields.owningDepartmentId
          : seedOrg?.owningDepartmentId,
      owningTeamId:
        fields.owningTeamId !== undefined
          ? fields.owningTeamId
          : seedOrg?.owningTeamId,
      typeBadge: fields.typeBadge ?? 'Transactional',
      matterTypeId: fields.matterTypeId ?? v('matter_type', 'Transactional'),
      clientTierId: fields.clientTierId ?? null,
      clientSectorId: fields.clientSectorId ?? null,
      billingBasisId: fields.billingBasisId ?? v('billing_basis', 'Hourly Rate'),
      riskRatingId: fields.riskRatingId ?? v('risk_rating', 'Low'),
      matterSizeId: fields.matterSizeId ?? v('matter_size', 'Medium (£5k–£25k)'),
      jurisdictionGroupId: fields.jurisdictionGroupId ?? v('jurisdiction', 'UK Jurisdictions'),
      jurisdictionIds: fields.jurisdictionIds ?? [jurSysId('UK Jurisdictions', 'England & Wales')],
      governingLawId: fields.governingLawId ?? jurSysId('UK Jurisdictions', 'England & Wales'),
      forumCourt: fields.forumCourt ?? '',
      responsiblePartnerId: fields.responsiblePartnerId ?? 'P-000001',
      supervisingPartnerId: fields.supervisingPartnerId ?? 'P-000001',
      leadFeeEarnerId: fields.leadFeeEarnerId ?? 'P-000002',
      teamMemberIds: fields.teamMemberIds ?? ['P-000010'],
      relationshipPartnerId: fields.relationshipPartnerId ?? 'P-000001',
      instructingContactId: fields.instructingContactId ?? null,
      billingContactId: fields.billingContactId ?? null,
      referrerTypeId: fields.referrerTypeId ?? null,
      referrerContactId: fields.referrerContactId ?? null,
      parties: fields.parties ?? [],
      conflictCheckStatus: fields.conflictCheckStatus ?? 'Clear',
      conflictCheckDate: fields.conflictCheckDate ?? day(createdOffset),
      conflictClearedById:
        fields.conflictClearedById !== undefined
          ? fields.conflictClearedById
          : 'P-000003',
      conflictNotes: fields.conflictNotes ?? '',
      amlStatus: fields.amlStatus ?? 'Verified',
      amlCompletedAt: fields.amlCompletedAt ?? day(createdOffset + 1),
      sourceOfFundsVerified: fields.sourceOfFundsVerified ?? 'Yes',
      sourceOfWealthVerified: fields.sourceOfWealthVerified ?? 'N/A',
      engagementLetterStatus: fields.engagementLetterStatus ?? 'Signed & returned',
      engagementLetterSentAt: fields.engagementLetterSentAt ?? day(createdOffset + 1),
      engagementLetterSignedAt: fields.engagementLetterSignedAt ?? day(createdOffset + 3),
      feeEstimateGbp: fields.feeEstimateGbp ?? 12500,
      agreedFeeCapGbp: fields.agreedFeeCapGbp ?? null,
      retainerMoniesOnAccountGbp: fields.retainerMoniesOnAccountGbp ?? 2500,
      stageId: fields.stageId ?? v('matter_stage', 'Stage 4 — Drafting & Negotiation'),
      milestoneId: fields.milestoneId ?? msId('Stage 4 — Drafting & Negotiation', 'First draft'),
      enquiryReceivedAt: fields.enquiryReceivedAt ?? day(createdOffset - 3),
      openedAt: fields.openedAt ?? day(createdOffset),
      targetCompletionAt: fields.targetCompletionAt ?? day(30),
      completedAt: fields.completedAt ?? null,
      closedAt: fields.closedAt ?? null,
      retentionPeriod: fields.retentionPeriod ?? '6 years',
      destructionDueAt: fields.destructionDueAt ?? null,
      fieldValues: fields.fieldValues ?? {},
      conflictCheckRecord: fields.conflictCheckRecord ?? null,
    };
    matters.push(m);
    return m;
  };

  // M-000001: Commercial property lease (RE03 Landlord & tenant) for Penarth Estates Ltd
  const mPenarthLease = addMatter(-35, {
    matterNumber: 'PEN001-0004',
    title: 'Grant of commercial lease — Unit 4, Cardiff Bay Retail Park',
    shortDescription: 'Grant of a new 10-year FRI commercial lease of Unit 4, Cardiff Bay Retail Park to Coastline Outdoor Ltd with 5-year upward-only rent review and tenant break at year 5.',
    clientId: penarth.id,
    practiceAreaId: v('work_type', 'Real Estate & Property'),
    workTypeSubcategoryId: subId('Real Estate & Property', 'Landlord & tenant'),
    typeBadge: 'Leases',
    matterTypeId: v('matter_type', 'Transactional'),
    clientTierId: penarth.clientTierId,
    clientSectorId: penarth.sectorId,
    billingBasisId: v('billing_basis', 'Fixed Fee'),
    riskRatingId: v('risk_rating', 'Low'),
    matterSizeId: v('matter_size', 'Medium (£5k–£25k)'),
    jurisdictionGroupId: v('jurisdiction', 'UK Jurisdictions'),
    jurisdictionIds: [jurSysId('UK Jurisdictions', 'Wales (devolved matters)')],
    governingLawId: jurSysId('UK Jurisdictions', 'England & Wales'),
    responsiblePartnerId: 'P-000001',
    supervisingPartnerId: 'P-000001',
    leadFeeEarnerId: 'P-000002',
    teamMemberIds: ['P-000010'],
    relationshipPartnerId: 'P-000001',
    instructingContactId: alun.id,
    billingContactId: seren.id,
    referrerTypeId: v('origin', 'Repeat / Existing Client'),
    feeEstimateGbp: 8500,
    agreedFeeCapGbp: 9000,
    retainerMoniesOnAccountGbp: 2000,
    stageId: v('matter_stage', 'Stage 4 — Drafting & Negotiation'),
    milestoneId: msId('Stage 4 — Drafting & Negotiation', 'Counterparty negotiation'),
    targetCompletionAt: day(18),
    tags: ['commercial lease', 'cardiff bay', 'retail'],
    parties: [
      { id: 'MP-1', name: 'Coastline Outdoor Ltd', role: 'Tenant / Counterparty', linkedRecordId: coastline.id },
      { id: 'MP-2', name: 'Morgan Price Solicitors', role: 'Opposing solicitor', linkedRecordId: morganPrice.id },
      { id: 'MP-3', name: 'Iwan Phillips', role: 'Lead opposing solicitor', linkedRecordId: iwan.id },
    ],
    fieldValues: {
      'FG03-001': 'Unit 4, Cardiff Bay Retail Park, Ferry Road, Cardiff CF11 0JR',
      'FG03-002': 'CYM482910',
      'FG03-003': 'Leasehold',
      'FG03-004': 'England & Wales (LTT — Wales)',
      'FG03-005': 'Commercial — Retail / Leisure',
      'FG03-006': 'No',
      'FG03-007': 'No',
      'FG04-001': 'Commercial Lease (FRI)',
      'FG04-002': day(18),
      'FG04-003': day(3670),
      'FG04-004': 'Tenant break at Year 5 on 6 months prior written notice',
      'FG04-005': day(1660),
      'RE03-01': 'New lease',
      'RE03-02': 'Landlord',
      'RE03-03': { primary: 10, secondary: day(18) },
      'RE03-04': day(3670),
      'RE03-05': day(1843),
      'RE03-06': 115000,
      'RE03-07': { primary: day(1843), secondary: 'Open market' },
      'RE03-08': 'Contracted out',
      'RE03-11': { primary: 57500, secondary: 'Coastline Outdoor Ltd' },
    },
  });

  // M-000002: Residential conveyancing purchase (RE01) for Mared Hughes
  const mMaredPurchase = addMatter(-14, {
    matterNumber: 'HUG002-0001',
    title: 'Purchase of 18 Cathedral View, Pontcanna, Cardiff CF11 9HS',
    shortDescription: 'Freehold residential purchase of a 4-bedroom Victorian terrace in Pontcanna with Principality Building Society mortgage finance. Welsh LTT review.',
    clientId: mared.id,
    practiceAreaId: v('work_type', 'Real Estate & Property'),
    workTypeSubcategoryId: subId('Real Estate & Property', 'Residential conveyancing'),
    typeBadge: 'Residential',
    matterTypeId: v('matter_type', 'Transactional'),
    clientTierId: v('client_tier', 'Private Client'),
    clientSectorId: v('sector', 'Private Individuals & Families'),
    billingBasisId: v('billing_basis', 'Fixed Fee'),
    riskRatingId: v('risk_rating', 'Medium'),
    matterSizeId: v('matter_size', 'Small (£1k–£5k)'),
    jurisdictionGroupId: v('jurisdiction', 'UK Jurisdictions'),
    jurisdictionIds: [jurSysId('UK Jurisdictions', 'Wales (devolved matters)')],
    governingLawId: jurSysId('UK Jurisdictions', 'England & Wales'),
    responsiblePartnerId: 'P-000001',
    supervisingPartnerId: 'P-000001',
    leadFeeEarnerId: 'P-000002',
    teamMemberIds: ['P-000010'],
    relationshipPartnerId: 'P-000002',
    instructingContactId: mared.id,
    billingContactId: mared.id,
    referrerTypeId: v('origin', 'Professional Referral — Accountant'),
    referrerContactId: gareth.id,
    amlStatus: 'Pending',
    amlCompletedAt: null,
    sourceOfFundsVerified: 'In progress',
    feeEstimateGbp: 2450,
    agreedFeeCapGbp: 2450,
    retainerMoniesOnAccountGbp: 450,
    stageId: v('matter_stage', 'Stage 2 — Investigation & Due Diligence'),
    milestoneId: msId('Stage 2 — Investigation & Due Diligence', 'Third-party enquiries'),
    targetCompletionAt: day(28),
    tags: ['residential purchase', 'welsh language', 'ltt'],
    parties: [
      { id: 'MP-4', name: 'Castell Legal Search Ltd', role: 'Search provider', linkedRecordId: castell.id },
    ],
    fieldValues: {
      'FG03-001': '18 Cathedral View, Pontcanna, Cardiff CF11 9HS',
      'FG03-002': 'WA739104',
      'FG03-003': 'Freehold',
      'FG03-004': 'Wales (LTT)',
      'FG03-005': 'Residential',
      'FG08-001': '1988-09-12',
      'FG08-002': 'UK resident & domiciled',
      'FG08-003': 'Single',
      'RE01-01': 'Purchase',
      'RE01-02': 'Buyer & lender',
      'RE01-03': 585000,
      'RE01-05': 2,
      'RE01-07': { primary: 'Principality Building Society', secondary: 410000 },
      'RE01-08': day(140),
      'RE01-09': { primary: 58500, secondary: 'No' },
      'RE01-10': 'No',
      'RE01-11': 'No',
      'RE01-12': 23625,
      'RE01-14': { primary: day(-10), secondary: day(-2) },
      'RE01-16': day(14),
      'RE01-17': day(28),
      'RE01-18': day(58),
    },
  });

  // M-000003: Mergers & acquisitions (CC03) for Severn Holdings plc
  const mSevernAcquisition = addMatter(-60, {
    matterNumber: 'SEV001-0009',
    title: 'Project Severn — Acquisition of Avonmouth Precision Engineering Ltd',
    shortDescription: 'Acquisition of 100% of the issued share capital of Avonmouth Precision Engineering Ltd (£14.5m enterprise value), including cash-free debt-free completion accounts and W&I insurance.',
    clientId: severn.id,
    practiceAreaId: v('work_type', 'Corporate & Commercial'),
    workTypeSubcategoryId: subId('Corporate & Commercial', 'Mergers & acquisitions'),
    typeBadge: 'M&A',
    matterTypeId: v('matter_type', 'Transactional'),
    clientTierId: severn.clientTierId,
    clientSectorId: severn.sectorId,
    billingBasisId: v('billing_basis', 'Capped Fee'),
    riskRatingId: v('risk_rating', 'Medium'),
    matterSizeId: v('matter_size', 'Major (£100k–£500k)'),
    jurisdictionGroupId: v('jurisdiction', 'UK Jurisdictions'),
    jurisdictionIds: [jurSysId('UK Jurisdictions', 'England & Wales')],
    governingLawId: jurSysId('UK Jurisdictions', 'England & Wales'),
    responsiblePartnerId: 'P-000001',
    supervisingPartnerId: 'P-000007',
    leadFeeEarnerId: 'P-000007',
    teamMemberIds: ['P-000002', 'P-000006'],
    relationshipPartnerId: 'P-000007',
    instructingContactId: richard.id,
    billingContactId: nerys.id,
    referrerTypeId: v('origin', 'Repeat / Existing Client'),
    feeEstimateGbp: 145000,
    agreedFeeCapGbp: 160000,
    retainerMoniesOnAccountGbp: 35000,
    stageId: v('matter_stage', 'Stage 4 — Drafting & Negotiation'),
    milestoneId: msId('Stage 4 — Drafting & Negotiation', 'Counterparty negotiation'),
    targetCompletionAt: day(21),
    tags: ['m&a', 'share purchase', 'project severn'],
    parties: [
      { id: 'MP-5', name: 'Hughes Lloyd Accountants LLP', role: 'Financial & Tax Due Diligence Adviser', linkedRecordId: hughesLloyd.id },
      { id: 'MP-6', name: 'Anwen Lloyd', role: 'Tax Partner', linkedRecordId: anwen.id },
    ],
    fieldValues: {
      'FG01-001': 14500000,
      'FG01-002': 'GBP',
      'FG01-003': 'Cash + Deferred + Earn-out',
      'FG01-004': 'Completion accounts',
      'FG01-005': 'Yes — EA permit transfer & key customer change-of-control consent',
      'FG01-006': day(35),
      'FG01-009': day(14),
      'FG01-010': day(21),
      'FG09-001': 'Avonmouth Precision Engineering Ltd',
      'FG09-002': '06891402',
      'FG09-003': 'Private Ltd',
      'FG09-004': 'England & Wales',
      'CC03-01': 'Share purchase (SPA)',
      'CC03-02': 'Buyer',
      'CC03-03': 'Private treaty',
      'CC03-04': { primary: 'Yes', secondary: day(7) },
      'CC03-05': { primary: 'Yes — £1,500,000 over 24 months', secondary: day(750) },
      'CC03-06': { primary: 750000, secondary: day(385) },
      'CC03-07': { primary: 145000, secondary: 14500000 },
      'CC03-08': { primary: day(560), secondary: day(2575) },
      'CC03-09': 'Yes',
      'CC03-10': 'None',
    },
  });

  // M-000004: Wills & codicils (PC01) for Owen Price
  const mOwenWill = addMatter(-55, {
    matterNumber: 'PRI001-0001',
    title: 'Mirror wills & lasting powers of attorney — Owen & Carys Price',
    shortDescription: 'Preparation of mirror wills incorporating discretionary nil-rate band trust provisions and Property & Financial Affairs / Health & Welfare LPAs for Mr Owen Price and Mrs Carys Price.',
    clientId: owen.id,
    practiceAreaId: v('work_type', 'Private Client'),
    workTypeSubcategoryId: subId('Private Client', 'Wills & codicils'),
    typeBadge: 'Wills',
    matterTypeId: v('matter_type', 'Drafting / Documentation'),
    clientTierId: v('client_tier', 'Private Client'),
    clientSectorId: v('sector', 'Private Individuals & Families'),
    billingBasisId: v('billing_basis', 'Fixed Fee'),
    riskRatingId: v('risk_rating', 'Low'),
    matterSizeId: v('matter_size', 'Small (£1k–£5k)'),
    jurisdictionGroupId: v('jurisdiction', 'UK Jurisdictions'),
    jurisdictionIds: [jurSysId('UK Jurisdictions', 'England & Wales')],
    governingLawId: jurSysId('UK Jurisdictions', 'England & Wales'),
    responsiblePartnerId: 'P-000005',
    supervisingPartnerId: 'P-000005',
    leadFeeEarnerId: 'P-000005',
    teamMemberIds: ['P-000010'],
    relationshipPartnerId: 'P-000005',
    instructingContactId: owen.id,
    billingContactId: owen.id,
    referrerTypeId: v('origin', 'Website / Digital Enquiry'),
    feeEstimateGbp: 1350,
    agreedFeeCapGbp: 1350,
    retainerMoniesOnAccountGbp: 675,
    stageId: v('matter_stage', 'Stage 4 — Drafting & Negotiation'),
    milestoneId: msId('Stage 4 — Drafting & Negotiation', 'Execution'),
    targetCompletionAt: day(7),
    tags: ['wills', 'mirror wills', 'lpa'],
    fieldValues: {
      'FG08-001': '1968-04-19',
      'FG08-002': 'UK domiciled and resident',
      'FG08-003': 'Married (Carys Price)',
      'FG08-004': 'Yes — assessed at face-to-face meeting; full testamentary capacity confirmed',
      'FG08-005': 'No',
      'PC01-01': 'Mirror wills',
      'PC01-02': 'Spouse (Carys Price) first; fallback to adult children (Eleri Price & Rhys Price) jointly',
      'PC01-03': 'N/A — children over 18',
      'PC01-04': 'Spouse absolutely, failing whom to children in equal shares at age 25',
      'PC01-05': 'Collection of Welsh landscape paintings to National Museum Wales',
      'PC01-06': 'Yes — flexible life interest trust',
      'PC01-07': 1450000,
      'PC01-08': 'Not A Law Firm LLP Strongroom — Safe Custody Ref W-2026-0217',
      'PC01-09': day(-10),
      'PC01-10': 'Yes — Registered with The National Will Register (Certainty)',
    },
  });

  // M-000005: Court pleadings / High Court TCC claim (DR02) for Harbourline Housing Association
  const mHarbourlineDispute = addMatter(-90, {
    matterNumber: 'HAR001-0012',
    title: 'Dilapidations & defective cladding claim — Waterfront Quays Block B',
    shortDescription: 'High Court Technology and Construction Court (TCC) claim concerning external wall system remediation and leaseholder service charge recovery at Waterfront Quays Block B, Cardiff.',
    clientId: harbourline.id,
    practiceAreaId: v('work_type', 'Dispute Resolution'),
    workTypeSubcategoryId: subId('Dispute Resolution', 'Court pleadings'),
    typeBadge: 'Litigation',
    matterTypeId: v('matter_type', 'Contentious'),
    clientTierId: harbourline.clientTierId,
    clientSectorId: harbourline.sectorId,
    billingBasisId: v('billing_basis', 'Hourly Rate'),
    riskRatingId: v('risk_rating', 'High'),
    matterSizeId: v('matter_size', 'Major (£100k–£500k)'),
    jurisdictionGroupId: v('jurisdiction', 'UK Jurisdictions'),
    jurisdictionIds: [jurSysId('UK Jurisdictions', 'England & Wales')],
    governingLawId: jurSysId('UK Jurisdictions', 'England & Wales'),
    forumCourt: 'High Court — Business & Property Courts in Wales (TCC, Cardiff)',
    responsiblePartnerId: 'P-000001',
    supervisingPartnerId: 'P-000001',
    leadFeeEarnerId: 'P-000006',
    teamMemberIds: ['P-000002', 'P-000010'],
    relationshipPartnerId: 'P-000001',
    instructingContactId: ffion.id,
    billingContactId: mark.id,
    referrerTypeId: v('origin', 'Panel Appointment'),
    feeEstimateGbp: 185000,
    agreedFeeCapGbp: 210000,
    retainerMoniesOnAccountGbp: 25000,
    stageId: v('matter_stage', 'Stage 4 — Drafting & Negotiation'),
    milestoneId: msId('Stage 4 — Drafting & Negotiation', 'First draft'),
    targetCompletionAt: day(95),
    tags: ['tcc', 'building safety', 'cladding', 'high court'],
    parties: [
      { id: 'MP-7', name: 'Geraint Williams KC', role: 'Leading Counsel', linkedRecordId: geraint.id },
      { id: 'MP-8', name: 'Taff Street Chambers', role: "Barristers' chambers", linkedRecordId: chambers.id },
      { id: 'MP-9', name: 'Dr Sarah Holt', role: 'Quantum & Valuation Expert', linkedRecordId: sarah.id },
      { id: 'MP-10', name: 'Cadwyn Surveying & Valuation Ltd', role: 'Expert firm', linkedRecordId: cadwyn.id },
    ],
    fieldValues: {
      'FG02-001': 'Claimant',
      'FG02-002': 'HT-2026-CDF-000142',
      'FG02-003': 'High Court — Technology & Construction Court (Cardiff District Registry)',
      'FG02-004': 'Multi-track',
      'FG02-005': 'HHJ Keyser KC',
      'FG02-006': 'Geraint Williams KC (Taff Street Chambers)',
      'FG02-007': 2850000,
      'FG02-008': day(45),
      'FG02-009': 'Yes',
      'FG02-010': day(-75),
      'FG02-011': day(-50),
      'FG02-012': day(-20),
      'FG02-013': day(12),
      'FG02-014': day(32),
      'FG02-015': day(55),
      'FG02-016': { primary: day(110), secondary: 10 },
      'FG02-017': 'Part 36 Claimant Offer served (£2.35m plus costs); mediation scheduled next month',
      'FG02-018': { primary: 225000, secondary: 198000 },
    },
  });

  // M-000006: Development & planning (RE04) for Tŷ Glas Developments Ltd (Prospective — Conflict Flagged)
  const mTyGlasDev = addMatter(-5, {
    matterNumber: 'TYG001-0001',
    title: 'Site acquisition & s.106 agreement — Former Docklands Timber Yard, Cardiff',
    shortDescription: 'Conditional development acquisition of a 3.4-acre brownfield waterfront site subject to planning permission for 85 residential units and s.106 affordable housing obligations.',
    clientId: tyGlas.id,
    matterStatusId: v('matter_status', 'Prospective / Enquiry'),
    practiceAreaId: v('work_type', 'Real Estate & Property'),
    workTypeSubcategoryId: subId('Real Estate & Property', 'Development & planning'),
    typeBadge: 'Development',
    matterTypeId: v('matter_type', 'Transactional'),
    clientTierId: v('client_tier', 'Gold'),
    clientSectorId: tyGlas.sectorId,
    billingBasisId: v('billing_basis', 'Capped Fee'),
    riskRatingId: v('risk_rating', 'Conflict Flagged'),
    matterSizeId: v('matter_size', 'Large (£25k–£100k)'),
    jurisdictionGroupId: v('jurisdiction', 'UK Jurisdictions'),
    jurisdictionIds: [jurSysId('UK Jurisdictions', 'Wales (devolved matters)')],
    governingLawId: jurSysId('UK Jurisdictions', 'England & Wales'),
    responsiblePartnerId: 'P-000001',
    supervisingPartnerId: 'P-000001',
    leadFeeEarnerId: 'P-000002',
    teamMemberIds: ['P-000010'],
    relationshipPartnerId: 'P-000001',
    instructingContactId: llinos.id,
    billingContactId: llinos.id,
    referrerTypeId: v('origin', 'Website / Digital Enquiry'),
    conflictCheckStatus: 'Potential conflict — escalated',
    conflictCheckDate: day(-2),
    conflictClearedById: null,
    conflictNotes: 'Coastline Outdoor Ltd occupies an adjacent strip on the boundary and is a counterparty on PEN001-0004. COLP (Bethan Rees) reviewing information barrier / consent requirements.',
    amlStatus: 'Pending',
    amlCompletedAt: null,
    engagementLetterStatus: 'Drafting',
    engagementLetterSentAt: null,
    engagementLetterSignedAt: null,
    feeEstimateGbp: 42000,
    agreedFeeCapGbp: 45000,
    retainerMoniesOnAccountGbp: 0,
    stageId: v('matter_stage', 'Stage 1 — Inception & Onboarding'),
    milestoneId: msId('Stage 1 — Inception & Onboarding', 'Conflict check'),
    targetCompletionAt: day(120),
    tags: ['development', 's106', 'planning', 'conflict review'],
    parties: [
      { id: 'MP-11', name: 'Coastline Outdoor Ltd', role: 'Adjoining occupier / Counterparty', linkedRecordId: coastline.id },
    ],
    fieldValues: {
      'FG01-001': 4250000,
      'FG01-005': 'Satisfactory detailed planning permission free from judicial review challenge',
      'FG01-006': day(180),
      'FG03-001': 'Former Docklands Timber Yard, Ocean Way, Cardiff CF24 5PE',
      'FG03-003': 'Freehold',
      'FG03-005': 'Mixed-use residential development site (3.4 acres)',
      'RE04-01': 'Mixed use',
      'RE04-02': { primary: 85, secondary: 24500000 },
      'RE04-03': 'Conditional contract',
      'RE04-04': 'Cardiff Council — Ref 26/01842/MJR',
      'RE04-05': 'Submitted',
      'RE04-06': day(90),
      'RE04-07': day(132),
    },
  });

  // M-000007: Tribunal claims (EM07) for Brightwater Care Group Ltd
  const mBrightwaterTribunal = addMatter(-42, {
    matterNumber: 'BRI001-0003',
    title: 'Employment Tribunal — Defence of unfair dismissal & whistleblowing claim',
    shortDescription: 'Defence of Employment Tribunal proceedings (Bristol ET) brought by former deputy home manager alleging unfair dismissal and protected disclosure detriment.',
    clientId: brightwater.id,
    practiceAreaId: v('work_type', 'Employment & HR'),
    workTypeSubcategoryId: subId('Employment & HR', 'Tribunal claims'),
    typeBadge: 'Litigation',
    matterTypeId: v('matter_type', 'Contentious'),
    clientTierId: brightwater.clientTierId,
    clientSectorId: brightwater.sectorId,
    billingBasisId: v('billing_basis', 'Hourly Rate'),
    riskRatingId: v('risk_rating', 'Medium'),
    matterSizeId: v('matter_size', 'Medium (£5k–£25k)'),
    jurisdictionGroupId: v('jurisdiction', 'UK Jurisdictions'),
    jurisdictionIds: [jurSysId('UK Jurisdictions', 'England & Wales')],
    governingLawId: jurSysId('UK Jurisdictions', 'England & Wales'),
    forumCourt: 'Bristol Employment Tribunal',
    responsiblePartnerId: 'P-000005',
    supervisingPartnerId: 'P-000005',
    leadFeeEarnerId: 'P-000006',
    teamMemberIds: ['P-000010'],
    relationshipPartnerId: 'P-000005',
    instructingContactId: tom.id,
    billingContactId: tom.id,
    referrerTypeId: v('origin', 'Professional Referral — Accountant'),
    referrerContactId: gareth.id,
    feeEstimateGbp: 18500,
    agreedFeeCapGbp: 22000,
    retainerMoniesOnAccountGbp: 5000,
    stageId: v('matter_stage', 'Stage 4 — Drafting & Negotiation'),
    milestoneId: msId('Stage 4 — Drafting & Negotiation', 'First draft'),
    targetCompletionAt: day(65),
    tags: ['employment tribunal', 'healthcare', 'bristol'],
    parties: [
      { id: 'MP-BRI-1', name: '[Claimant name]', role: 'Opponent', linkedRecordId: null },
      { id: 'MP-BRI-2', name: "[Claimant's solicitors]", role: 'Opposing solicitor', linkedRecordId: null },
      { id: 'MP-BRI-3', name: 'Employment Tribunal — Bristol', role: 'Other party', linkedRecordId: null },
    ],
    fieldValues: {
      'FG02-001': 'Respondent',
      'FG02-002': '1402891/2026',
      'FG02-003': 'Employment Tribunal — Bristol',
      'FG02-007': 68000,
      'FG02-012': day(-14),
      'FG02-013': day(16),
      'FG02-014': day(35),
      'FG02-016': { primary: day(78), secondary: 4 },
      'FG07-001': 'Deputy Care Home Manager',
      'FG07-002': '2021-06-01',
      'FG07-003': day(-95),
      'FG07-004': 5,
      'FG07-005': 46500,
      'FG07-007': '3 months contractual notice',
    },
  });

  // ------------------------------------------------------------------ teams, enquiries, tasks & notifications
  const teams: Team[] = [];
  let tmn = 0;
  const addTeam = (
    name: string,
    description: string,
    memberIds: string[],
    leadIds: string[],
    practiceAreas: string[],
  ): Team => {
    const id = `TM-${String(++tmn).padStart(6, '0')}`;
    const tm: Team = {
      id,
      name,
      description,
      memberIds: Array.from(new Set([...memberIds, ...leadIds])),
      leadIds,
      practiceAreaIds: practiceAreas.map((pa) => v('work_type', pa)),
      active: true,
      createdById: 'P-000004',
      createdAt: ts(-400),
      updatedById: 'P-000004',
      updatedAt: ts(-30),
    };
    teams.push(tm);
    return tm;
  };

  const tmRealEstate = addTeam(
    'Real Estate & Property',
    'Commercial property, residential conveyancing, landlord & tenant, development and property finance.',
    ['P-000001', 'P-000002', 'P-000010'],
    ['P-000001'],
    ['Real Estate & Property'],
  );
  const tmCorporate = addTeam(
    'Corporate & Commercial',
    'M&A, shareholder arrangements, commercial contracts, governance and IP/IT.',
    ['P-000001', 'P-000002', 'P-000007'],
    ['P-000007'],
    ['Corporate & Commercial'],
  );
  const tmDisputes = addTeam(
    'Dispute Resolution & Litigation',
    'Commercial litigation, property disputes, construction & engineering, debt recovery and regulatory investigations.',
    ['P-000001', 'P-000006', 'P-000003'],
    ['P-000001'],
    ['Dispute Resolution & Litigation'],
  );
  const tmPrivateClient = addTeam(
    'Private Client, Trusts & Family',
    'Wills, trusts, probate, estate administration, powers of attorney and family law.',
    ['P-000005', 'P-000002', 'P-000010'],
    ['P-000005'],
    ['Private Client, Trusts & Family'],
  );
  const tmEmployment = addTeam(
    'Employment & HR',
    'Employment contracts, settlement agreements, tribunal claims, TUPE, restructuring and HR advisory.',
    ['P-000005', 'P-000006', 'P-000010'],
    ['P-000005'],
    ['Employment & HR'],
  );
  const tmBanking = addTeam(
    'Banking, Finance & Restructuring',
    'Corporate lending, real estate finance, refinancing, security and insolvency.',
    ['P-000001', 'P-000007'],
    ['P-000007'],
    ['Banking, Finance & Restructuring'],
  );
  const tmRegulatory = addTeam(
    'Regulatory, Public & Specialist',
    'Data protection, health & safety, licensing, public procurement and charities.',
    ['P-000003', 'P-000006'],
    ['P-000003'],
    ['Regulatory, Public & Specialist'],
  );
  const tmIntake = addTeam(
    'Intake',
    'Central call handlers and new enquiry triage.',
    ['P-000010', 'P-000008', 'P-000001'],
    ['P-000008'],
    [],
  );
  const tmRisk = addTeam(
    'Risk & Compliance',
    'Conflicts, AML client due diligence, source of funds and regulatory compliance.',
    ['P-000003', 'P-000004', 'P-000001'],
    ['P-000003'],
    [],
  );
  const tmAccounts = addTeam(
    'Accounts',
    'Client monies on account, billing, disbursements and credit control.',
    ['P-000009', 'P-000007'],
    ['P-000009'],
    [],
  );

  // Person & Pending Matter created from Converted Employment & HR Enquiry ENQ-000003 (Sam Jones)
  const samJones = ext(-6, {
    titleId: v('title', 'Mr'),
    firstName: 'Sam',
    surname: 'Jones',
    jobTitle: 'Regional Sales Manager',
    emails: [
      email('sam.jones@pmail.example', 'Personal'),
      email('sam.jones@example.com', 'Personal', false),
    ],
    phones: [phone('07700 900412', 'Mobile')],
    addresses: [addr('42 Kimberley Road', 'Cardiff', 'CF23 5DL', 'Home', 'Penylan')],
    relationshipRoleIds: [role('Private client')],
    relationshipStatusId: v('relationship_status', 'Prospective'),
    relationshipOwnerId: 'P-000006',
    originId: v('origin', 'Website / Digital Enquiry'),
    firstKnownAt: day(-6),
    lastVerifiedAt: day(-6),
    lastInteractionAt: day(-5),
  });

  const mSamJonesTribunal = addMatter(-5, {
    matterNumber: 'JON002-0001',
    title: 'Unfair dismissal & ACAS early conciliation — Sam Jones v Valley Freight Solutions Ltd',
    shortDescription: 'Summary dismissal after 6 years service following a dispute over commission targets. ACAS early conciliation and Employment Tribunal unfair dismissal & notice pay claim.',
    clientId: samJones.id,
    matterStatusId: v('matter_status', 'Prospective / Enquiry'),
    sourceEnquiryId: 'ENQ-000003',
    practiceAreaId: v('work_type', 'Employment & HR'),
    workTypeSubcategoryId: subId('Employment & HR', 'Tribunal claims'),
    typeBadge: 'Litigation',
    matterTypeId: v('matter_type', 'Contentious'),
    clientTierId: v('client_tier', 'Private Client'),
    clientSectorId: v('sector', 'Private Individuals & Families'),
    billingBasisId: v('billing_basis', 'Hourly Rate'),
    riskRatingId: v('risk_rating', 'Low'),
    matterSizeId: v('matter_size', 'Small (£1k–£5k)'),
    jurisdictionGroupId: v('jurisdiction', 'UK Jurisdictions'),
    jurisdictionIds: [jurSysId('UK Jurisdictions', 'England & Wales')],
    governingLawId: jurSysId('UK Jurisdictions', 'England & Wales'),
    forumCourt: 'Cardiff Employment Tribunal',
    responsiblePartnerId: 'P-000005',
    supervisingPartnerId: 'P-000005',
    leadFeeEarnerId: 'P-000006',
    teamMemberIds: ['P-000010'],
    relationshipPartnerId: 'P-000005',
    instructingContactId: samJones.id,
    billingContactId: samJones.id,
    referrerTypeId: v('origin', 'Website / Digital Enquiry'),
    conflictCheckStatus: 'Clear',
    conflictCheckDate: day(-5),
    conflictClearedById: 'P-000003',
    amlStatus: 'Pending',
    amlCompletedAt: null,
    engagementLetterStatus: 'Drafting',
    engagementLetterSentAt: null,
    engagementLetterSignedAt: null,
    feeEstimateGbp: 4500,
    agreedFeeCapGbp: 5000,
    retainerMoniesOnAccountGbp: 0,
    stageId: v('matter_stage', 'Stage 1 — Inception & Onboarding'),
    milestoneId: msId('Stage 1 — Inception & Onboarding', 'Engagement letter'),
    enquiryReceivedAt: day(-6),
    openedAt: day(-5),
    targetCompletionAt: day(75),
    tags: ['employment tribunal', 'unfair dismissal', 'converted enquiry'],
    parties: [
      { id: 'MP-12', name: 'Valley Freight Solutions Ltd', role: 'Opposing party', linkedRecordId: null },
    ],
    fieldValues: {
      'FG02-001': 'Claimant',
      'FG02-003': 'Employment Tribunal — Wales (Cardiff)',
      'FG02-008': day(75),
      'FG07-001': 'Regional Sales Manager',
      'FG07-002': '2020-03-16',
      'FG07-003': day(-12),
      'FG07-004': 6,
      'FG07-005': 58000,
    },
  });

  // Additional PMS-aligned employees (FE002 Gethin Lloyd, FE003 Aled Thomas, FE006 Ffion Davies)
  // Note: FE004 Megan Howells, FE007 Rhys Bowen, and FE008 Catrin Owen are intentionally left
  // unseeded in 1Squared so they appear on the Admin > PMS links screen to be created in 1Squared.
  const empGethinLloyd = addPerson(`P-${String(++pn).padStart(6, '0')}`, -850, {
    titleId: v('title', 'Mr'),
    firstName: 'Gethin',
    surname: 'Lloyd',
    jobTitle: 'Managing Partner, Corporate & Commercial',
    emails: [email('gethin.lloyd@notalawfirm.example')],
    phones: [phone('029 2018 0112', 'Direct')],
    addresses: [addr('3 Bute Dock Chambers, Mount Stuart Square', 'Cardiff', 'CF10 5FQ', 'Work')],
    relationshipStatusId: v('relationship_status', 'Active'),
    relationshipRoleIds: [v('person_role', 'Internal colleague')],
    isEmployee: true,
    employeeRoleId: v('employee_role', 'Partner'),
    departmentId: v('department', 'Corporate & Commercial'),
    recordOwnerId: 'P-000004',
    lastVerifiedAt: day(-30),
    roles: ['managing_partner', 'partner'],
  });

  const empAledThomas = addPerson(`P-${String(++pn).padStart(6, '0')}`, -840, {
    titleId: v('title', 'Mr'),
    firstName: 'Aled',
    surname: 'Thomas',
    jobTitle: 'Senior Associate',
    emails: [email('aled.thomas@notalawfirm.example')],
    phones: [phone('029 2018 0113', 'Direct')],
    addresses: [addr('3 Bute Dock Chambers, Mount Stuart Square', 'Cardiff', 'CF10 5FQ', 'Work')],
    relationshipStatusId: v('relationship_status', 'Active'),
    relationshipRoleIds: [v('person_role', 'Internal colleague')],
    isEmployee: true,
    employeeRoleId: v('employee_role', 'Fee earner'),
    departmentId: v('department', 'Dispute Resolution'),
    recordOwnerId: 'P-000004',
    lastVerifiedAt: day(-30),
    roles: ['fee_earner'],
  });

  const empFfionDavies = addPerson(`P-${String(++pn).padStart(6, '0')}`, -830, {
    titleId: v('title', 'Ms'),
    firstName: 'Ffion',
    surname: 'Davies',
    jobTitle: 'Chartered Legal Executive',
    emails: [email('ffion.davies@notalawfirm.example')],
    phones: [phone('029 2018 0116', 'Direct')],
    addresses: [addr('3 Bute Dock Chambers, Mount Stuart Square', 'Cardiff', 'CF10 5FQ', 'Work')],
    relationshipStatusId: v('relationship_status', 'Active'),
    relationshipRoleIds: [v('person_role', 'Internal colleague')],
    isEmployee: true,
    employeeRoleId: v('employee_role', 'Fee earner'),
    departmentId: v('department', 'Private Client'),
    recordOwnerId: 'P-000004',
    lastVerifiedAt: day(-30),
    roles: ['fee_earner'],
  });

  // Real employees referenced by the Role-based Home page designs (Sarah Cole, Lowri Ellis, Nia Jenkins)
  const empSarahCole = addPerson(`P-${String(++pn).padStart(6, '0')}`, -820, {
    titleId: v('title', 'Ms'),
    firstName: 'Sarah',
    surname: 'Cole',
    jobTitle: 'Legal Secretary',
    emails: [email('sarah.cole@notalawfirm.example')],
    phones: [phone('029 2018 0121', 'Direct')],
    addresses: [addr('3 Bute Dock Chambers, Mount Stuart Square', 'Cardiff', 'CF10 5FQ', 'Work')],
    relationshipStatusId: v('relationship_status', 'Active'),
    relationshipRoleIds: [v('person_role', 'Internal colleague')],
    isEmployee: true,
    employeeRoleId: v('employee_role', 'Support staff'),
    departmentId: v('department', 'Real Estate'),
    recordOwnerId: 'P-000004',
    lastVerifiedAt: day(-30),
    roles: ['legal_secretary', 'enquiries_coordinator'],
    supportsIds: ['P-000001', 'P-000002'],
  });

  const empLowriEllis = addPerson(`P-${String(++pn).padStart(6, '0')}`, -815, {
    titleId: v('title', 'Ms'),
    firstName: 'Lowri',
    surname: 'Ellis',
    jobTitle: 'Enquiries Coordinator',
    emails: [email('lowri.ellis@notalawfirm.example')],
    phones: [phone('029 2018 0122', 'Direct')],
    addresses: [addr('3 Bute Dock Chambers, Mount Stuart Square', 'Cardiff', 'CF10 5FQ', 'Work')],
    relationshipStatusId: v('relationship_status', 'Active'),
    relationshipRoleIds: [v('person_role', 'Internal colleague')],
    isEmployee: true,
    employeeRoleId: v('employee_role', 'Support staff'),
    departmentId: v('department', 'Business Development'),
    recordOwnerId: 'P-000004',
    lastVerifiedAt: day(-30),
    appRole: 'call_handler',
    roles: ['enquiries_coordinator'],
  });

  const empNiaJenkins = addPerson(`P-${String(++pn).padStart(6, '0')}`, -810, {
    titleId: v('title', 'Ms'),
    firstName: 'Nia',
    surname: 'Jenkins',
    jobTitle: 'Credit Control Manager',
    emails: [email('nia.jenkins@notalawfirm.example')],
    phones: [phone('029 2018 0123', 'Direct')],
    addresses: [addr('3 Bute Dock Chambers, Mount Stuart Square', 'Cardiff', 'CF10 5FQ', 'Work')],
    relationshipStatusId: v('relationship_status', 'Active'),
    relationshipRoleIds: [v('person_role', 'Internal colleague')],
    isEmployee: true,
    employeeRoleId: v('employee_role', 'Finance'),
    departmentId: v('department', 'Finance'),
    recordOwnerId: 'P-000004',
    lastVerifiedAt: day(-30),
    roles: ['finance'],
  });

  // Add the new real employees to their respective teams
  tmRealEstate.memberIds = Array.from(new Set([...tmRealEstate.memberIds, empSarahCole.id]));
  tmCorporate.memberIds = Array.from(new Set([...tmCorporate.memberIds, empGethinLloyd.id]));
  tmCorporate.leadIds = Array.from(new Set([...tmCorporate.leadIds, empGethinLloyd.id]));
  tmDisputes.memberIds = Array.from(new Set([...tmDisputes.memberIds, empAledThomas.id]));
  tmPrivateClient.memberIds = Array.from(new Set([...tmPrivateClient.memberIds, empFfionDavies.id]));
  tmIntake.memberIds = Array.from(new Set([...tmIntake.memberIds, empLowriEllis.id]));
  tmAccounts.memberIds = Array.from(new Set([...tmAccounts.memberIds, empNiaJenkins.id]));

  // 8 Demo Users for Role-based Home pages (docs/role-home-pages.md)
  const demoFelicity = addPerson(`P-${String(++pn).padStart(6, '0')}`, -30, {
    titleId: v('title', 'Ms'),
    firstName: 'Felicity',
    surname: 'Fee-Earner',
    jobTitle: 'Solicitor (Demo)',
    emails: [email('felicity.fee-earner@notalawfirm.example')],
    phones: [phone('029 2018 0191', 'Direct')],
    addresses: [addr('3 Bute Dock Chambers, Mount Stuart Square', 'Cardiff', 'CF10 5FQ', 'Work')],
    relationshipStatusId: v('relationship_status', 'Active'),
    relationshipRoleIds: [v('person_role', 'Internal colleague')],
    isEmployee: true,
    employeeRoleId: v('employee_role', 'Fee earner'),
    departmentId: v('department', 'Real Estate'),
    recordOwnerId: 'P-000004',
    lastVerifiedAt: day(-30),
    roles: ['fee_earner'],
    demo: true,
    showsWorkOfId: 'P-000002', // Dafydd Evans
  });

  const demoPatrick = addPerson(`P-${String(++pn).padStart(6, '0')}`, -30, {
    titleId: v('title', 'Mr'),
    firstName: 'Patrick',
    surname: 'Partner',
    jobTitle: 'Partner, Head of Department (Demo)',
    emails: [email('patrick.partner@notalawfirm.example')],
    phones: [phone('029 2018 0192', 'Direct')],
    addresses: [addr('3 Bute Dock Chambers, Mount Stuart Square', 'Cardiff', 'CF10 5FQ', 'Work')],
    relationshipStatusId: v('relationship_status', 'Active'),
    relationshipRoleIds: [v('person_role', 'Internal colleague')],
    isEmployee: true,
    employeeRoleId: v('employee_role', 'Partner'),
    departmentId: v('department', 'Real Estate'),
    recordOwnerId: 'P-000004',
    lastVerifiedAt: day(-30),
    roles: ['partner', 'fee_earner'],
    demo: true,
    showsWorkOfId: 'P-000001', // Rhian Morgan
  });

  const demoSimone = addPerson(`P-${String(++pn).padStart(6, '0')}`, -30, {
    titleId: v('title', 'Ms'),
    firstName: 'Simone',
    surname: 'Secretary',
    jobTitle: 'Legal Secretary (Demo)',
    emails: [email('simone.secretary@notalawfirm.example')],
    phones: [phone('029 2018 0193', 'Direct')],
    addresses: [addr('3 Bute Dock Chambers, Mount Stuart Square', 'Cardiff', 'CF10 5FQ', 'Work')],
    relationshipStatusId: v('relationship_status', 'Active'),
    relationshipRoleIds: [v('person_role', 'Internal colleague')],
    isEmployee: true,
    employeeRoleId: v('employee_role', 'Support staff'),
    departmentId: v('department', 'Real Estate'),
    recordOwnerId: 'P-000004',
    lastVerifiedAt: day(-30),
    roles: ['legal_secretary', 'enquiries_coordinator'],
    demo: true,
    showsWorkOfId: empSarahCole.id, // Sarah Cole
    supportsIds: ['P-000001', 'P-000002'],
  });

  const demoEthel = addPerson(`P-${String(++pn).padStart(6, '0')}`, -30, {
    titleId: v('title', 'Ms'),
    firstName: 'Ethel',
    surname: 'Enquiries',
    jobTitle: 'Enquiries Coordinator (Demo)',
    emails: [email('ethel.enquiries@notalawfirm.example')],
    phones: [phone('029 2018 0194', 'Direct')],
    addresses: [addr('3 Bute Dock Chambers, Mount Stuart Square', 'Cardiff', 'CF10 5FQ', 'Work')],
    relationshipStatusId: v('relationship_status', 'Active'),
    relationshipRoleIds: [v('person_role', 'Internal colleague')],
    isEmployee: true,
    employeeRoleId: v('employee_role', 'Support staff'),
    departmentId: v('department', 'Business Development'),
    recordOwnerId: 'P-000004',
    lastVerifiedAt: day(-30),
    appRole: 'call_handler',
    roles: ['enquiries_coordinator'],
    demo: true,
    showsWorkOfId: empLowriEllis.id, // Lowri Ellis
  });

  const demoFrank = addPerson(`P-${String(++pn).padStart(6, '0')}`, -30, {
    titleId: v('title', 'Mr'),
    firstName: 'Frank',
    surname: 'Finance',
    jobTitle: 'Credit Control Manager (Demo)',
    emails: [email('frank.finance@notalawfirm.example')],
    phones: [phone('029 2018 0195', 'Direct')],
    addresses: [addr('3 Bute Dock Chambers, Mount Stuart Square', 'Cardiff', 'CF10 5FQ', 'Work')],
    relationshipStatusId: v('relationship_status', 'Active'),
    relationshipRoleIds: [v('person_role', 'Internal colleague')],
    isEmployee: true,
    employeeRoleId: v('employee_role', 'Finance'),
    departmentId: v('department', 'Finance'),
    recordOwnerId: 'P-000004',
    lastVerifiedAt: day(-30),
    roles: ['finance'],
    demo: true,
    showsWorkOfId: empNiaJenkins.id, // Nia Jenkins
  });

  const demoRita = addPerson(`P-${String(++pn).padStart(6, '0')}`, -30, {
    titleId: v('title', 'Ms'),
    firstName: 'Rita',
    surname: 'Risk',
    jobTitle: 'MLRO & COLP (Demo)',
    emails: [email('rita.risk@notalawfirm.example')],
    phones: [phone('029 2018 0196', 'Direct')],
    addresses: [addr('3 Bute Dock Chambers, Mount Stuart Square', 'Cardiff', 'CF10 5FQ', 'Work')],
    relationshipStatusId: v('relationship_status', 'Active'),
    relationshipRoleIds: [v('person_role', 'Internal colleague')],
    isEmployee: true,
    employeeRoleId: v('employee_role', 'Risk and compliance'),
    departmentId: v('department', 'Risk & Compliance'),
    recordOwnerId: 'P-000004',
    lastVerifiedAt: day(-30),
    roles: ['risk_compliance', 'partner'],
    demo: true,
    showsWorkOfId: 'P-000003', // Bethan Rees
  });

  const demoMartha = addPerson(`P-${String(++pn).padStart(6, '0')}`, -30, {
    titleId: v('title', 'Ms'),
    firstName: 'Martha',
    surname: 'Managing-Partner',
    jobTitle: 'Managing Partner (Demo)',
    emails: [email('martha.managing-partner@notalawfirm.example')],
    phones: [phone('029 2018 0197', 'Direct')],
    addresses: [addr('3 Bute Dock Chambers, Mount Stuart Square', 'Cardiff', 'CF10 5FQ', 'Work')],
    relationshipStatusId: v('relationship_status', 'Active'),
    relationshipRoleIds: [v('person_role', 'Internal colleague')],
    isEmployee: true,
    employeeRoleId: v('employee_role', 'Partner'),
    departmentId: v('department', 'Corporate & Commercial'),
    recordOwnerId: 'P-000004',
    lastVerifiedAt: day(-30),
    roles: ['managing_partner', 'partner'],
    demo: true,
    showsWorkOfId: empGethinLloyd.id, // Gethin Lloyd
  });

  const demoAdam = addPerson(`P-${String(++pn).padStart(6, '0')}`, -30, {
    titleId: v('title', 'Mr'),
    firstName: 'Adam',
    surname: 'Admin',
    jobTitle: 'Systems Administrator (Demo)',
    emails: [email('adam.admin@notalawfirm.example')],
    phones: [phone('029 2018 0198', 'Direct')],
    addresses: [addr('3 Bute Dock Chambers, Mount Stuart Square', 'Cardiff', 'CF10 5FQ', 'Work')],
    relationshipStatusId: v('relationship_status', 'Active'),
    relationshipRoleIds: [v('person_role', 'Internal colleague')],
    isEmployee: true,
    employeeRoleId: v('employee_role', 'System administrator'),
    departmentId: v('department', 'IT & Systems'),
    recordOwnerId: 'P-000004',
    lastVerifiedAt: day(-30),
    appRole: 'admin',
    roles: [
      'admin',
      'fee_earner',
      'partner',
      'legal_secretary',
      'enquiries_coordinator',
      'finance',
      'risk_compliance',
      'managing_partner',
    ],
    demo: true,
    showsWorkOfId: null,
  });

  // Add demo users to their corresponding teams so team-based queries work seamlessly
  tmRealEstate.memberIds = Array.from(new Set([...tmRealEstate.memberIds, demoFelicity.id, demoPatrick.id, demoSimone.id]));
  tmIntake.memberIds = Array.from(new Set([...tmIntake.memberIds, demoEthel.id]));
  tmAccounts.memberIds = Array.from(new Set([...tmAccounts.memberIds, demoFrank.id]));
  tmRisk.memberIds = Array.from(new Set([...tmRisk.memberIds, demoRita.id]));
  tmCorporate.memberIds = Array.from(new Set([...tmCorporate.memberIds, demoMartha.id]));

  // Alun Pugh (Executor of Margaret Pugh deceased — matches PMS client PUG001)
  const alunPugh = ext(-120, {
    titleId: v('title', 'Mr'),
    firstName: 'Alun',
    surname: 'Pugh',
    emails: [email('alun.pugh@example.com', 'Personal')],
    phones: [phone('07700 900511', 'Mobile')],
    addresses: [addr('3 Church Lane', 'Cardiff', 'CF5 2LA', 'Home', 'Llandaff')],
    relationshipRoleIds: [role('Private client')],
    relationshipStatusId: v('relationship_status', 'Active'),
    relationshipOwnerId: empFfionDavies.id,
    lastVerifiedAt: day(-90),
    customFields: { cf_will_held: true, cf_will_reference: 'W-2011-0087' },
  });

  // PMS-linked demo matters so all key acceptance-criteria matters can be opened directly in 1Squared:
  // M-000009: PUG001-0001 — Estate of the late Margaret Pugh (£33,510.60 client account balance)
  const mPughEstate = addMatter(-119, {
    matterNumber: 'PUG001-0001',
    title: 'Estate of the late Margaret Pugh',
    shortDescription: 'Grant of probate and administration of the estate of the late Mrs Margaret Pugh deceased.',
    clientId: alunPugh.id,
    practiceAreaId: v('work_type', 'Private Client'),
    workTypeSubcategoryId: subId('Private Client', 'Estate administration'),
    typeBadge: 'Probate',
    matterTypeId: v('matter_type', 'Advisory'),
    clientTierId: v('client_tier', 'Private Client'),
    clientSectorId: v('sector', 'Private Individuals & Families'),
    billingBasisId: v('billing_basis', 'Hourly Rate'),
    riskRatingId: v('risk_rating', 'Low'),
    matterSizeId: v('matter_size', 'Medium (£5k–£25k)'),
    responsiblePartnerId: 'P-000001',
    supervisingPartnerId: 'P-000001',
    leadFeeEarnerId: empFfionDavies.id,
    relationshipPartnerId: 'P-000001',
    instructingContactId: alunPugh.id,
    billingContactId: alunPugh.id,
    feeEstimateGbp: 12000,
    stageId: v('matter_stage', 'Stage 3 — Execution & Delivery'),
    milestoneId: msId('Stage 3 — Execution & Delivery', 'Main workstream'),
    tags: ['probate', 'estate administration', 'client account'],
  });

  // M-000010: BRI001-0003 — Acquisition of Afon Care Homes Ltd (WIP £11,057, Outstanding £22,637.40, 73% of £72,000 revised estimate pending acceptance)
  const mAfonAcquisition = addMatter(-74, {
    matterNumber: 'BRI001-0003',
    title: 'Acquisition of Afon Care Homes Ltd',
    shortDescription: 'Acquisition of the entire issued share capital of Afon Care Homes Ltd, including CQC regulatory due diligence and care home property portfolio review.',
    clientId: brightwater.id,
    practiceAreaId: v('work_type', 'Corporate & Commercial'),
    workTypeSubcategoryId: subId('Corporate & Commercial', 'Mergers & acquisitions'),
    typeBadge: 'M&A',
    matterTypeId: v('matter_type', 'Transactional'),
    clientTierId: brightwater.clientTierId,
    clientSectorId: brightwater.sectorId,
    billingBasisId: v('billing_basis', 'Hourly Rate'),
    riskRatingId: v('risk_rating', 'Medium'),
    matterSizeId: v('matter_size', 'Large (£25k–£100k)'),
    responsiblePartnerId: empGethinLloyd.id,
    supervisingPartnerId: empGethinLloyd.id,
    leadFeeEarnerId: empGethinLloyd.id,
    relationshipPartnerId: empGethinLloyd.id,
    instructingContactId: tom.id,
    billingContactId: tom.id,
    feeEstimateGbp: 72000,
    stageId: v('matter_stage', 'Stage 4 — Drafting & Negotiation'),
    milestoneId: msId('Stage 4 — Drafting & Negotiation', 'Counterparty negotiation'),
    tags: ['m&a', 'healthcare', 'revised estimate'],
  });

  // M-000011: SEV001-0001 — Group reorganisation - hive-up of Severn Freight trade (£27,984 recorded vs £25,000 cap)
  const mSevernReorg = addMatter(-193, {
    matterNumber: 'SEV001-0001',
    title: 'Group reorganisation - hive-up of Severn Freight trade',
    shortDescription: 'Intra-group hive-up of the trade and assets of Severn Freight Services Ltd into Severn Holdings plc group structure under a £25,000 capped fee.',
    clientId: severn.id,
    practiceAreaId: v('work_type', 'Corporate & Commercial'),
    workTypeSubcategoryId: subId('Corporate & Commercial', 'Company formations & structures'),
    typeBadge: 'Corporate',
    matterTypeId: v('matter_type', 'Transactional'),
    clientTierId: severn.clientTierId,
    clientSectorId: severn.sectorId,
    billingBasisId: v('billing_basis', 'Capped Fee'),
    riskRatingId: v('risk_rating', 'Low'),
    matterSizeId: v('matter_size', 'Medium (£5k–£25k)'),
    responsiblePartnerId: empGethinLloyd.id,
    supervisingPartnerId: empGethinLloyd.id,
    leadFeeEarnerId: empGethinLloyd.id,
    relationshipPartnerId: empGethinLloyd.id,
    instructingContactId: richard.id,
    billingContactId: nerys.id,
    feeEstimateGbp: 25000,
    agreedFeeCapGbp: 25000,
    stageId: v('matter_stage', 'Stage 4 — Drafting & Negotiation'),
    milestoneId: msId('Stage 4 — Drafting & Negotiation', 'Execution'),
    tags: ['reorganisation', 'capped fee', 'severn group'],
  });

  // M-000012: PEN001-0003 — Acquisition of land at Llandough Trading Estate (final bill paid after credit note)
  const mLlandough = addMatter(-277, {
    matterNumber: 'PEN001-0003',
    title: 'Acquisition of land at Llandough Trading Estate',
    shortDescription: 'Freehold commercial acquisition of development plot at Llandough Trading Estate, Penarth.',
    clientId: penarth.id,
    matterStatusId: v('matter_status', 'Closed'),
    recordStatusId: v('matter_status', 'Closed'),
    practiceAreaId: v('work_type', 'Real Estate & Property'),
    workTypeSubcategoryId: subId('Real Estate & Property', 'Commercial property'),
    typeBadge: 'Commercial',
    matterTypeId: v('matter_type', 'Transactional'),
    clientTierId: penarth.clientTierId,
    clientSectorId: penarth.sectorId,
    billingBasisId: v('billing_basis', 'Hourly Rate'),
    riskRatingId: v('risk_rating', 'Low'),
    matterSizeId: v('matter_size', 'Medium (£5k–£25k)'),
    responsiblePartnerId: 'P-000001',
    supervisingPartnerId: 'P-000001',
    leadFeeEarnerId: 'P-000001',
    relationshipPartnerId: 'P-000001',
    instructingContactId: alun.id,
    billingContactId: seren.id,
    feeEstimateGbp: 15000,
    closedAt: day(-63),
    completedAt: day(-63),
    stageId: v('matter_stage', 'Stage 7 — Post-Completion & Closure'),
    milestoneId: msId('Stage 7 — Post-Completion & Closure', 'File closure & archiving'),
    tags: ['commercial property', 'completed'],
  });

  // M-000013: HAR001-0003 — Butetown regeneration - development agreement (September & October unbilled WIP)
  const mButetown = addMatter(-242, {
    matterNumber: 'HAR001-0003',
    title: 'Butetown regeneration - development agreement',
    shortDescription: 'Mixed-use affordable housing regeneration development agreement, s.106 planning obligations and highways agreements in Butetown, Cardiff.',
    clientId: harbourline.id,
    practiceAreaId: v('work_type', 'Real Estate & Property'),
    workTypeSubcategoryId: subId('Real Estate & Property', 'Development & planning'),
    typeBadge: 'Development',
    matterTypeId: v('matter_type', 'Transactional'),
    clientTierId: harbourline.clientTierId,
    clientSectorId: harbourline.sectorId,
    billingBasisId: v('billing_basis', 'Hourly Rate'),
    riskRatingId: v('risk_rating', 'High'),
    matterSizeId: v('matter_size', 'Large (£25k–£100k)'),
    responsiblePartnerId: 'P-000001',
    supervisingPartnerId: 'P-000001',
    leadFeeEarnerId: 'P-000001',
    teamMemberIds: ['P-000002', empSarahCole.id, 'P-000010'],
    relationshipPartnerId: 'P-000001',
    instructingContactId: ffion.id,
    billingContactId: mark.id,
    feeEstimateGbp: 58000,
    stageId: v('matter_stage', 'Stage 4 — Drafting & Negotiation'),
    milestoneId: msId('Stage 4 — Drafting & Negotiation', 'Counterparty negotiation'),
    tags: ['regeneration', 'development agreement', 's106'],
    fieldValues: {
      'FG06-004': day(0),
    },
  });

  // M-000014: BAY001-0001 — New café lease - Mermaid Quay (90+ days overdue bill)
  const mBayLease = addMatter(-214, {
    matterNumber: 'BAY001-0001',
    title: 'New café lease - Mermaid Quay',
    shortDescription: 'Grant of commercial unit lease at Mermaid Quay, Cardiff Bay.',
    clientId: bayCafes.id,
    matterStatusId: v('matter_status', 'Closed'),
    recordStatusId: v('matter_status', 'Closed'),
    practiceAreaId: v('work_type', 'Real Estate & Property'),
    workTypeSubcategoryId: subId('Real Estate & Property', 'Landlord & tenant'),
    typeBadge: 'Leases',
    matterTypeId: v('matter_type', 'Transactional'),
    clientTierId: bayCafes.clientTierId,
    clientSectorId: bayCafes.sectorId,
    billingBasisId: v('billing_basis', 'Fixed Fee'),
    riskRatingId: v('risk_rating', 'Low'),
    matterSizeId: v('matter_size', 'Small (£1k–£5k)'),
    responsiblePartnerId: 'P-000001',
    supervisingPartnerId: 'P-000001',
    leadFeeEarnerId: 'P-000002',
    relationshipPartnerId: 'P-000001',
    instructingContactId: hannah.id,
    billingContactId: hannah.id,
    feeEstimateGbp: 2750,
    closedAt: day(-126),
    completedAt: day(-126),
    stageId: v('matter_stage', 'Stage 7 — Post-Completion & Closure'),
    milestoneId: msId('Stage 7 — Post-Completion & Closure', 'File closure & archiving'),
    tags: ['mermaid quay', 'retail lease'],
  });

  // M-000015: PEN001-0002 — Rent review & dilapidations - Units 1-3 Marina Parade (Dispute Resolution, Lead: Aled Thomas, Team: Dafydd Evans)
  const mMarinaParade = addMatter(-160, {
    matterNumber: 'PEN001-0002',
    title: 'Rent review & dilapidations — Units 1–3 Marina Parade',
    shortDescription: 'Contested rent review arbitration and terminal schedule of dilapidations on Units 1–3 Marina Parade, Penarth.',
    clientId: penarth.id,
    practiceAreaId: v('work_type', 'Dispute Resolution'),
    workTypeSubcategoryId: subId('Dispute Resolution', 'Property & real estate disputes'),
    typeBadge: 'Disputes',
    matterTypeId: v('matter_type', 'Contentious'),
    clientTierId: penarth.clientTierId,
    clientSectorId: penarth.sectorId,
    billingBasisId: v('billing_basis', 'Hourly Rate'),
    riskRatingId: v('risk_rating', 'Low'),
    matterSizeId: v('matter_size', 'Medium (£5k–£25k)'),
    responsiblePartnerId: 'P-000001',
    supervisingPartnerId: 'P-000001',
    leadFeeEarnerId: empAledThomas.id,
    teamMemberIds: ['P-000002', empSarahCole.id],
    relationshipPartnerId: 'P-000001',
    instructingContactId: alun.id,
    billingContactId: seren.id,
    feeEstimateGbp: 18000,
    stageId: v('matter_stage', 'Stage 3 — Execution & Delivery'),
    milestoneId: msId('Stage 3 — Execution & Delivery', 'Main workstream'),
    tags: ['dilapidations', 'rent review', 'marina parade'],
  });

  // M-000016: TGL001-0002 — Purchase of Plot 9, Parc Tŷ Glas (High-risk offshore SPV buyer, Dafydd Evans lead)
  const mPlot9TyGlas = addMatter(-3, {
    matterNumber: 'TGL001-0002',
    title: 'Purchase of Plot 9, Parc Tŷ Glas',
    shortDescription: 'Commercial development plot acquisition via Jersey SPV (Tŷ Glas Holdings (Jersey) Ltd); enhanced due diligence and source of wealth verification required.',
    clientId: tyGlas.id,
    matterStatusId: v('matter_status', 'Prospective / Enquiry'),
    practiceAreaId: v('work_type', 'Real Estate & Property'),
    workTypeSubcategoryId: subId('Real Estate & Property', 'Commercial property — acquisitions & disposals'),
    typeBadge: 'Commercial',
    matterTypeId: v('matter_type', 'Transactional'),
    clientTierId: v('client_tier', 'Gold'),
    clientSectorId: tyGlas.sectorId,
    billingBasisId: v('billing_basis', 'Fixed Fee'),
    riskRatingId: v('risk_rating', 'High'),
    matterSizeId: v('matter_size', 'Large (£25k–£100k)'),
    responsiblePartnerId: 'P-000001',
    supervisingPartnerId: 'P-000001',
    leadFeeEarnerId: 'P-000002',
    teamMemberIds: [empSarahCole.id, 'P-000010'],
    relationshipPartnerId: 'P-000001',
    instructingContactId: llinos.id,
    billingContactId: llinos.id,
    conflictCheckStatus: 'Clear',
    conflictCheckDate: day(-2),
    conflictClearedById: 'P-000003',
    amlStatus: 'Pending',
    amlCompletedAt: null,
    sourceOfFundsVerified: 'In progress',
    sourceOfWealthVerified: 'In progress',
    engagementLetterStatus: 'Sent',
    engagementLetterSentAt: day(-2),
    engagementLetterSignedAt: null,
    feeEstimateGbp: 28500,
    retainerMoniesOnAccountGbp: 0,
    stageId: v('matter_stage', 'Stage 1 — Inception & Onboarding'),
    milestoneId: msId('Stage 1 — Inception & Onboarding', 'AML & CDD'),
    targetCompletionAt: day(60),
    tags: ['high risk', 'offshore spv', 'edd', 'parc ty glas'],
    fieldValues: {
      'FG01-005': day(-1),
    },
  });

  // Suppress unused variable warnings if not referenced below
  void empAledThomas;
  void mPughEstate;
  void mAfonAcquisition;
  void mSevernReorg;
  void mLlandough;
  void mButetown;
  void mBayLease;
  void mMarinaParade;
  void mPlot9TyGlas;


  // 8 Demo Enquiries across statuses and practice areas (3 in Employment & HR)
  const enquiries: Enquiry[] = [];
  let enqn = 0;
  const addEnquiry = (
    offsetDays: number,
    hour: number,
    fields: Partial<Enquiry> &
      Pick<Enquiry, 'firstName' | 'lastName' | 'practiceAreaId' | 'summary' | 'notes' | 'status'>,
  ): Enquiry => {
    const id = `ENQ-${String(++enqn).padStart(6, '0')}`;
    const receivedAt = ts(offsetDays, hour);
    const urgencyId = fields.urgencyId ?? v('enquiry_urgency', 'Standard');
    const urgencyLabel = urgencyId.includes('emergency')
      ? 'Emergency'
      : urgencyId.includes('urgent')
        ? 'Urgent'
        : 'Standard';
    const firstContactDueAt =
      fields.firstContactDueAt ?? calculateFirstContactDue(receivedAt, urgencyLabel);

    const enq: Enquiry = {
      id,
      reference: id,
      receivedAt,
      takenById: fields.takenById ?? 'P-000010',
      channelId: fields.channelId ?? v('enquiry_channel', 'Phone'),
      firstName: fields.firstName,
      lastName: fields.lastName,
      callingOnBehalfOf: fields.callingOnBehalfOf ?? '',
      linkedOrganisationId: fields.linkedOrganisationId ?? null,
      email: fields.email ?? '',
      phone: fields.phone ?? '',
      preferredContactMethodId: fields.preferredContactMethodId ?? v('contact_method', 'Mobile call'),
      bestTimeToCall: fields.bestTimeToCall ?? 'Mornings before 11:30',
      address: fields.address ?? null,
      practiceAreaId: fields.practiceAreaId,
      workTypeSubcategoryId: fields.workTypeSubcategoryId ?? null,
      summary: fields.summary,
      notes: fields.notes,
      otherPartiesNamed: fields.otherPartiesNamed ?? '',
      urgencyId,
      keyDate: fields.keyDate ?? null,
      keyDateLabel: fields.keyDateLabel ?? '',
      sourceId: fields.sourceId ?? v('origin', 'Website / Digital Enquiry'),
      referrerPersonId: fields.referrerPersonId ?? null,
      privacyNoticeGiven: fields.privacyNoticeGiven ?? true,
      linkedPersonId: fields.linkedPersonId ?? null,
      assignedTeamId: fields.assignedTeamId ?? tmEmployment.id,
      routedToIntakeFallback: fields.routedToIntakeFallback ?? false,
      assignedToId: fields.assignedToId ?? null,
      status: fields.status,
      firstContactDueAt,
      nextActionDate: fields.nextActionDate ?? null,
      closeReasonId: fields.closeReasonId ?? null,
      closeNotes: fields.closeNotes,
      referredToOrganisationId: fields.referredToOrganisationId ?? null,
      referredToName: fields.referredToName,
      convertedMatterId: fields.convertedMatterId ?? null,
      contactLog: fields.contactLog ?? [],
      anonymisedAt: fields.anonymisedAt ?? null,
      createdById: fields.takenById ?? 'P-000010',
      createdAt: receivedAt,
      updatedById: fields.assignedToId ?? fields.takenById ?? 'P-000010',
      updatedAt: fields.updatedAt ?? receivedAt,
    };
    enquiries.push(enq);
    return enq;
  };

  // ENQ-000001: Employment & HR — New and unclaimed (Urgent)
  const enq1 = addEnquiry(0, 9, {
    firstName: 'Carys',
    lastName: 'Bevan',
    email: 'carys.bevan@pmail.example',
    phone: '07700 900318',
    address: addr('19 Oakfield Street', 'Cardiff', 'CF24 3RD', 'Home', 'Roath'),
    practiceAreaId: v('work_type', 'Employment & HR'),
    workTypeSubcategoryId: subId('Employment & HR', 'Settlement agreements'),
    urgencyId: v('enquiry_urgency', 'Urgent'),
    keyDate: day(4),
    keyDateLabel: 'Employer deadline to sign settlement agreement',
    summary: 'Offered settlement agreement by employer with 5-day deadline; needs independent advice',
    notes: 'Caller is Head of Marketing at Cardiff Bay Media Ltd. Handed a draft settlement agreement yesterday and told she has until Friday to return it signed. High-level details only recorded prior to conflict check.',
    otherPartiesNamed: 'Cardiff Bay Media Ltd',
    assignedTeamId: tmEmployment.id,
    assignedToId: null,
    status: 'New',
    nextActionDate: day(0),
  });

  // ENQ-000002: Employment & HR — Assigned with two failed contact attempts
  const enq2 = addEnquiry(-3, 11, {
    firstName: 'Rhodri',
    lastName: 'Hopkins',
    email: 'rhodri.hopkins@pmail.example',
    phone: '07700 900544',
    address: addr('8 St Andrews Crescent', 'Cardiff', 'CF10 3DD', 'Home'),
    practiceAreaId: v('work_type', 'Employment & HR'),
    workTypeSubcategoryId: subId('Employment & HR', 'Grievance, disciplinary & capability'),
    urgencyId: v('enquiry_urgency', 'Standard'),
    keyDate: day(5),
    keyDateLabel: 'Disciplinary hearing date',
    summary: 'Suspended pending disciplinary hearing next week; seeking advice on process',
    notes: 'Caller left message with reception requesting a call back regarding a workplace suspension at Western Logistics Group. High-level facts only taken.',
    otherPartiesNamed: 'Western Logistics Group Ltd',
    assignedTeamId: tmEmployment.id,
    assignedToId: 'P-000006',
    status: 'Assigned',
    nextActionDate: day(0),
    contactLog: [
      {
        id: 'CL-1',
        at: ts(-1, 15),
        method: 'Call',
        outcome: 'Left message',
        note: 'Rang mobile at 15:00; went to voicemail. Left message asking Rhodri to call back or confirm best time.',
        byId: 'P-000006',
      },
      {
        id: 'CL-2',
        at: ts(-2, 10),
        method: 'Call',
        outcome: 'No answer',
        note: 'Tried mobile, no answer and voicemail full. Sent short follow-up email with direct dial.',
        byId: 'P-000006',
      },
    ],
  });

  // ENQ-000003: Employment & HR — Converted to a pending Tribunal claims matter (Sam Jones)
  const enq3 = addEnquiry(-6, 10, {
    firstName: 'Sam',
    lastName: 'Jones',
    email: 'sam.jones@pmail.example',
    phone: '07700 900412',
    address: addr('42 Kimberley Road', 'Cardiff', 'CF23 5DL', 'Home', 'Penylan'),
    practiceAreaId: v('work_type', 'Employment & HR'),
    workTypeSubcategoryId: subId('Employment & HR', 'Tribunal claims'),
    urgencyId: v('enquiry_urgency', 'Urgent'),
    keyDate: day(75),
    keyDateLabel: 'Primary 3-month ET limitation deadline',
    summary: 'Dismissed last week after 6 years service, wants advice on unfair dismissal claim',
    notes: 'Dismissed without notice following commission dispute at Valley Freight Solutions Ltd. Conflict check cleared. Converted to pending Tribunal claims matter JON002-0001.',
    otherPartiesNamed: 'Valley Freight Solutions Ltd',
    linkedPersonId: samJones.id,
    assignedTeamId: tmEmployment.id,
    assignedToId: 'P-000006',
    status: 'Converted',
    convertedMatterId: mSamJonesTribunal.id,
    contactLog: [
      {
        id: 'CL-3',
        at: ts(-6, 14),
        method: 'Call',
        outcome: 'Spoke',
        note: 'Spoke with Sam for 20 minutes. Confirmed termination date, length of service (6 years) and salary (£58k). Explained conflict check and fee structure.',
        byId: 'P-000006',
      },
    ],
  });

  // ENQ-000004: Real Estate & Property — In contact (Emergency auction purchase)
  const enq4 = addEnquiry(-1, 14, {
    firstName: 'Elinor',
    lastName: 'Vaughan-davies',
    callingOnBehalfOf: 'Celtic Quayside Investments Ltd',
    email: 'elinor@celticquayside.example',
    phone: '029 2018 0611',
    address: addr('12 Mermaid Quay', 'Cardiff', 'CF10 5BZ', 'Work'),
    practiceAreaId: v('work_type', 'Real Estate & Property'),
    workTypeSubcategoryId: subId('Real Estate & Property', 'Commercial property — acquisitions & disposals'),
    urgencyId: v('enquiry_urgency', 'Emergency'),
    keyDate: day(21),
    keyDateLabel: '28-day auction completion deadline',
    summary: 'Won commercial lot at auction yesterday; urgent legal pack review & 28-day completion',
    notes: 'Purchased mixed-use parade in Newport at Allsop commercial auction for £1.15m. Needs urgent title review and bridging finance coordination.',
    otherPartiesNamed: 'Allsop Auctioneers, Principality Commercial',
    assignedTeamId: tmRealEstate.id,
    assignedToId: 'P-000002',
    status: 'In contact',
    nextActionDate: day(1),
    contactLog: [
      {
        id: 'CL-4',
        at: ts(-1, 15),
        method: 'Call',
        outcome: 'Spoke',
        note: 'Spoke with Elinor within 1 hour of call. Requested auction memorandum and company registration number to run conflict & AML checks.',
        byId: 'P-000002',
      },
    ],
  });

  // ENQ-000005: Private Client, Trusts & Family — New (unclaimed, past first-contact SLA)
  const enq5 = addEnquiry(-2, 9, {
    firstName: 'Bryn',
    lastName: 'Walters',
    email: 'bryn.walters@pmail.example',
    phone: '0117 496 0421',
    address: addr('7 Clifton Down Road', 'Bristol', 'BS8 4BF', 'Home', 'Clifton'),
    practiceAreaId: v('work_type', 'Private Client, Trusts & Family'),
    workTypeSubcategoryId: subId('Private Client, Trusts & Family', 'Probate & estate administration'),
    urgencyId: v('enquiry_urgency', 'Standard'),
    keyDate: day(45),
    keyDateLabel: 'IHT400 submission deadline (6 months from death)',
    summary: 'Executor of late uncle estate (£1.4m including agricultural land); needs probate help',
    notes: 'Referred by Gareth Hughes at Hughes Lloyd. Estate includes a farmhouse in Monmouthshire and investment portfolio.',
    channelId: v('enquiry_channel', 'Referral'),
    sourceId: v('origin', 'Professional Referral — Accountant'),
    referrerPersonId: gareth.id,
    assignedTeamId: tmPrivateClient.id,
    assignedToId: null,
    status: 'New',
    firstContactDueAt: ts(-1, 17),
    nextActionDate: day(0),
  });

  // ENQ-000006: Dispute Resolution & Litigation — Declined (Conflict with Penarth Estates Ltd)
  const enq6 = addEnquiry(-8, 11, {
    firstName: 'Marcus',
    lastName: 'Finch',
    callingOnBehalfOf: 'Bayview Retail Concessions Ltd',
    email: 'm.finch@bayviewconcessions.example',
    phone: '029 2018 0799',
    practiceAreaId: v('work_type', 'Dispute Resolution & Litigation'),
    workTypeSubcategoryId: subId('Dispute Resolution & Litigation', 'Property & real estate disputes'),
    urgencyId: v('enquiry_urgency', 'Urgent'),
    summary: 'Dispute with landlord Penarth Estates Ltd over service charge at Cardiff Bay Retail Park',
    notes: 'Prospective tenant client wished to challenge service charge apportionment at Cardiff Bay Retail Park. Penarth Estates Ltd is an existing Platinum client of the firm — declined due to direct conflict.',
    otherPartiesNamed: 'Penarth Estates Ltd',
    assignedTeamId: tmDisputes.id,
    assignedToId: 'P-000006',
    status: 'Declined',
    closeReasonId: v('enquiry_close_reason', 'Conflict'),
    closeNotes: 'Penarth Estates Ltd is an active client of the firm on Cardiff Bay Retail Park matters.',
  });

  // ENQ-000007: Corporate & Commercial — Referred out (Specialist patent litigation outside expertise)
  const enq7 = addEnquiry(-10, 16, {
    firstName: 'Dr Arwel',
    lastName: 'Maddock',
    callingOnBehalfOf: 'Severn Biotech Diagnostics Ltd',
    email: 'a.maddock@severnbiotech.example',
    phone: '0117 496 0884',
    practiceAreaId: v('work_type', 'Corporate & Commercial'),
    workTypeSubcategoryId: subId('Corporate & Commercial', 'IP, IT & technology agreements'),
    urgencyId: v('enquiry_urgency', 'Standard'),
    summary: 'European patent opposition before the EPO in Munich; needs patent attorney',
    notes: 'Requires specialist European Patent Attorney representation in chemical diagnostics opposition proceedings. Referred to Morgan Price IP practice.',
    assignedTeamId: tmCorporate.id,
    assignedToId: 'P-000007',
    status: 'Referred out',
    closeReasonId: v('enquiry_close_reason', 'Referred out'),
    referredToOrganisationId: morganPrice.id,
    referredToName: morganPrice.legalName,
  });

  // ENQ-000008: Private Client, Trusts & Family — Closed (No response after 3 attempts)
  const enq8 = addEnquiry(-15, 10, {
    firstName: 'Keira',
    lastName: 'Saunders',
    email: 'keira.saunders@pmail.example',
    phone: '07700 900119',
    channelId: v('enquiry_channel', 'Web form'),
    practiceAreaId: v('work_type', 'Private Client, Trusts & Family'),
    workTypeSubcategoryId: subId('Private Client, Trusts & Family', 'Wills & estate planning'),
    urgencyId: v('enquiry_urgency', 'Standard'),
    summary: 'Mirror wills enquiry via website form',
    notes: 'Submitted web enquiry asking about mirror wills and guardianship clauses. Three contact attempts made with no reply.',
    assignedTeamId: tmPrivateClient.id,
    assignedToId: 'P-000005',
    status: 'No response',
    closeReasonId: v('enquiry_close_reason', 'No response'),
    contactLog: [
      { id: 'CL-5', at: ts(-14, 11), method: 'Call', outcome: 'Left message', note: 'Left voicemail with direct number.', byId: 'P-000005' },
      { id: 'CL-6', at: ts(-12, 15), method: 'Email', outcome: 'Email sent', note: 'Sent follow-up email with Wills guide and appointment times.', byId: 'P-000005' },
      { id: 'CL-7', at: ts(-9, 10), method: 'Call', outcome: 'No answer', note: 'Third attempt, no reply. Closing as No response.', byId: 'P-000005' },
    ],
  });

  // ENQ-000009: Real Estate & Property — Assigned to Dafydd Evans (Urgent, Western Vale Homes Ltd)
  const enq9 = addEnquiry(0, 10, {
    firstName: 'Alun',
    lastName: 'Davies',
    callingOnBehalfOf: 'Western Vale Homes Ltd',
    linkedOrganisationId: westernVale.id,
    linkedPersonId: alun.id,
    email: 'alun@westernvalehomes.example',
    phone: '029 2018 0411',
    channelId: v('enquiry_channel', 'Phone'),
    sourceId: v('origin', 'Repeat / Existing Client'),
    practiceAreaId: v('work_type', 'Real Estate & Property'),
    workTypeSubcategoryId: subId('Real Estate & Property', 'Development & planning'),
    urgencyId: v('enquiry_urgency', 'Urgent'),
    keyDate: day(1),
    keyDateLabel: 'Vendor exclusivity expiry',
    summary: 'Option agreement & planning promotion on 14-acre residential site near Cowbridge',
    notes: 'Alun Davies rang on behalf of Western Vale Homes Ltd regarding a 14-acre residential development site near Cowbridge. Best time to call: 14:00–16:30.',
    bestTimeToCall: '14:00–16:30',
    otherPartiesNamed: 'Vale Landowners Consortium',
    assignedTeamId: tmRealEstate.id,
    assignedToId: 'P-000002',
    takenById: empLowriEllis.id,
    status: 'Assigned',
    firstContactDueAt: ts(0, 17),
    nextActionDate: day(0),
  });

  // ENQ-000010: Real Estate & Property — In contact with Dafydd Evans (Coastal Storage Ltd)
  const enq10 = addEnquiry(-3, 14, {
    firstName: 'Gareth',
    lastName: 'Pritchard',
    callingOnBehalfOf: 'Coastal Storage Ltd',
    email: 'g.pritchard@coastalstorage.example',
    phone: '029 2018 0644',
    channelId: v('enquiry_channel', 'Referral'),
    sourceId: v('origin', 'Professional Referral — Accountant'),
    referrerPersonId: gareth.id,
    practiceAreaId: v('work_type', 'Real Estate & Property'),
    workTypeSubcategoryId: subId('Real Estate & Property', 'Landlord & tenant'),
    urgencyId: v('enquiry_urgency', 'Standard'),
    summary: 'Assignment of commercial lease at Unit 7, Atlantic Wharf, Cardiff',
    notes: 'Referred by Gareth Hughes (Hughes Lloyd). Spoke Friday; client emailing heads of terms today. Ready to convert once conflict check runs.',
    otherPartiesNamed: 'Atlantic Wharf Estates Ltd',
    assignedTeamId: tmRealEstate.id,
    assignedToId: 'P-000002',
    takenById: empLowriEllis.id,
    status: 'In contact',
    nextActionDate: day(0),
    contactLog: [
      {
        id: 'CL-8',
        at: ts(-3, 16),
        method: 'Call',
        outcome: 'Spoke',
        note: 'Spoke Friday afternoon; Gareth Pritchard emailing signed heads of terms on Monday.',
        byId: 'P-000002',
      },
    ],
  });

  // ENQ-000011: Real Estate & Property — Unassigned in team queue (Tranter Haulage Ltd)
  const enq11 = addEnquiry(-1, 16, {
    firstName: 'Huw',
    lastName: 'Tranter',
    callingOnBehalfOf: 'Tranter Haulage Ltd',
    email: 'huw@tranterhaulage.example',
    phone: '01632 960120',
    channelId: v('enquiry_channel', 'Web form'),
    sourceId: v('origin', 'Website / Digital Enquiry'),
    practiceAreaId: v('work_type', 'Real Estate & Property'),
    workTypeSubcategoryId: subId('Real Estate & Property', 'Commercial property'),
    urgencyId: v('enquiry_urgency', 'Standard'),
    summary: 'Refinancing of distribution depot at Newport Docks (£1.8m facility)',
    notes: 'Web form enquiry received Friday 16:40. Needs commercial property finance quote and conflict check.',
    otherPartiesNamed: 'Barclays Corporate Banking',
    assignedTeamId: tmRealEstate.id,
    assignedToId: null,
    takenById: empLowriEllis.id,
    status: 'New',
    firstContactDueAt: ts(0, 17),
    nextActionDate: day(0),
  });

  // ENQ-000012: Corporate & Commercial — Assigned to Rhian Morgan (Gower Renewables Ltd)
  const enq12 = addEnquiry(0, 11, {
    firstName: 'Elin',
    lastName: 'Rees-Jones',
    callingOnBehalfOf: 'Gower Renewables Ltd',
    email: 'elin@gowerrenewables.example',
    phone: '01632 960310',
    channelId: v('enquiry_channel', 'Referral'),
    sourceId: v('origin', 'Professional Referral — Accountant'),
    referrerPersonId: gareth.id,
    practiceAreaId: v('work_type', 'Real Estate & Property'),
    workTypeSubcategoryId: subId('Real Estate & Property', 'Development & planning'),
    urgencyId: v('enquiry_urgency', 'Urgent'),
    summary: 'Solar farm lease option & grid easement — Gower Peninsula (42 acres)',
    notes: 'Referred by Gareth Hughes (Hughes Lloyd). Landowner heads of terms ready for partner review.',
    otherPartiesNamed: 'National Grid Electricity Distribution',
    assignedTeamId: tmRealEstate.id,
    assignedToId: 'P-000001',
    takenById: empLowriEllis.id,
    status: 'Assigned',
    firstContactDueAt: ts(0, 17),
    nextActionDate: day(0),
  });

  void enq9;
  void enq10;
  void enq11;
  void enq12;

  // ------------------------------------------------------------------ 6 Demo Quotes across statuses
  const quoteYear = today.getFullYear();
  const quotes: Quote[] = [];
  let qten = 0;
  const makeQuoteRef = (n: number) => `QTE-${quoteYear}-${String(n).padStart(4, '0')}`;

  // QTE-YYYY-0001: Follow-up due (overdue by 2 days), linked to ENQ-000010 (Coastal Storage Ltd)
  qten++;
  const qte1Ref = makeQuoteRef(qten);
  quotes.push({
    id: qte1Ref,
    reference: qte1Ref,
    version: 1,
    status: 'Follow-up due',
    clientType: 'prospect',
    linkedOrganisationId: null,
    linkedPersonId: null,
    prospectName: 'Gareth Pritchard',
    prospectOrganisationName: 'Coastal Storage Ltd',
    prospectEmail: 'g.pritchard@coastalstorage.example',
    prospectPhone: '029 2018 0644',
    linkedEnquiryId: enq10.id,
    convertedMatterId: null,
    practiceAreaId: v('work_type', 'Real Estate & Property'),
    workTypeSubcategoryId: subId('Real Estate & Property', 'Landlord & tenant'),
    scope:
      'Acting on the assignment of the commercial lease of Unit 7, Atlantic Wharf, Cardiff, including reviewing lease title, negotiating Licence to Assign with Atlantic Wharf Estates Ltd, and completing post-completion SDLT and HM Land Registry registration.',
    assumptions:
      "Assumes landlord's solicitors provide standard form Licence to Assign without superior landlord consent being required. Excludes advising on any rent deposit deed variations or schedule of condition.",
    feeBasis: 'Fixed fee',
    feeAmountExVat: 2850,
    hourlyRateGbp: null,
    vatAmount: 570,
    disbursements: [
      {
        id: 'QDISB-101',
        description: 'HM Land Registry official copies & priority searches',
        amountExVat: 45,
        vatApplicable: false,
      },
      {
        id: 'QDISB-102',
        description: 'Commercial drainage, environmental & local authority searches',
        amountExVat: 380,
        vatApplicable: true,
      },
    ],
    totalIncVat: 3921,
    feeEarnerId: 'P-000002',
    assignedTeamId: tmRealEstate.id,
    validUntil: day(20),
    followUpAfterDays: 7,
    sentAt: ts(-9, 14),
    nextFollowUpDate: day(-2),
    outcomeAt: null,
    declineReason: null,
    followUps: [],
    versionHistory: [],
    timeline: [
      {
        id: 'QT-101',
        kind: 'created',
        at: ts(-10, 11),
        byId: 'P-000002',
        title: 'Quote created (v1)',
        detail: `Created from enquiry ${enq10.reference} — Fixed fee £2,850 + VAT`,
      },
      {
        id: 'QT-102',
        kind: 'sent',
        at: ts(-9, 14),
        byId: 'P-000002',
        title: 'Marked as sent to Gareth Pritchard',
        detail: `First follow-up scheduled for ${day(-2)}`,
      },
    ],
    createdById: 'P-000002',
    createdAt: ts(-10, 11),
    updatedById: 'P-000002',
    updatedAt: ts(-9, 14),
  });

  // QTE-YYYY-0002: Sent (Revised v2 quote with v1 Superseded), linked to ENQ-000011 (Tranter Haulage Ltd)
  qten++;
  const qte2Ref = makeQuoteRef(qten);
  quotes.push({
    id: qte2Ref,
    reference: qte2Ref,
    version: 2,
    status: 'Sent',
    clientType: 'prospect',
    linkedOrganisationId: null,
    linkedPersonId: null,
    prospectName: 'Huw Tranter',
    prospectOrganisationName: 'Tranter Haulage Ltd',
    prospectEmail: 'huw@tranterhaulage.example',
    prospectPhone: '01632 960120',
    linkedEnquiryId: enq11.id,
    convertedMatterId: null,
    practiceAreaId: v('work_type', 'Real Estate & Property'),
    workTypeSubcategoryId: subId('Real Estate & Property', 'Commercial property'),
    scope:
      'Acting for Tranter Haulage Ltd on the £1.8m commercial refinancing of the Newport Docks distribution depot with Barclays Corporate Banking, including Certificate of Title, review of facility agreement, legal charge, and Companies House / Land Registry registrations.',
    assumptions:
      'Capped at £4,200 + VAT assuming single title number and no third-party occupier deeds of postponement. Excludes advising on interest rate hedging instruments.',
    feeBasis: 'Capped fee',
    feeAmountExVat: 4200,
    hourlyRateGbp: null,
    vatAmount: 840,
    disbursements: [
      {
        id: 'QDISB-201',
        description: 'Companies House charge registration fee',
        amountExVat: 15,
        vatApplicable: false,
      },
      {
        id: 'QDISB-202',
        description: 'Chancel, environmental & Highways searches (Newport Docks)',
        amountExVat: 420,
        vatApplicable: true,
      },
    ],
    totalIncVat: 5559,
    feeEarnerId: 'P-000001',
    assignedTeamId: tmRealEstate.id,
    validUntil: day(24),
    followUpAfterDays: 7,
    sentAt: ts(-2, 16),
    nextFollowUpDate: day(5),
    outcomeAt: null,
    declineReason: null,
    followUps: [
      {
        id: 'QFU-201',
        at: ts(-3, 11),
        method: 'Phone',
        note: 'Spoke with Huw Tranter regarding v1 estimate; board asked whether we could cap professional fees at £4,200 + VAT.',
        nextFollowUpDate: day(5),
        byId: 'P-000001',
      },
    ],
    versionHistory: [
      {
        version: 1,
        status: 'Superseded',
        feeBasis: 'Estimate',
        feeAmountExVat: 4500,
        hourlyRateGbp: null,
        vatAmount: 900,
        disbursements: [
          {
            id: 'QDISB-201-v1',
            description: 'Companies House charge registration fee',
            amountExVat: 15,
            vatApplicable: false,
          },
          {
            id: 'QDISB-202-v1',
            description: 'Chancel, environmental & Highways searches (Newport Docks)',
            amountExVat: 420,
            vatApplicable: true,
          },
        ],
        totalIncVat: 5919,
        scope:
          'Initial fee estimate for £1.8m commercial refinancing of the Newport Docks distribution depot with Barclays Corporate Banking.',
        assumptions: 'Standard single-property commercial refinancing assumptions.',
        validUntil: day(21),
        createdAt: ts(-6, 10),
        sentAt: ts(-6, 12),
        supersededAt: ts(-2, 15),
        byId: 'P-000001',
        revisionNote: 'Revised from £4,500 Estimate to £4,200 Capped fee following call with Huw Tranter.',
      },
    ],
    timeline: [
      {
        id: 'QT-201',
        kind: 'created',
        at: ts(-6, 10),
        byId: 'P-000001',
        title: 'Quote created (v1)',
        detail: `Linked to enquiry ${enq11.reference} — Estimate £4,500 + VAT`,
      },
      {
        id: 'QT-202',
        kind: 'sent',
        at: ts(-6, 12),
        byId: 'P-000001',
        title: 'v1 marked as sent',
        detail: 'Sent initial estimate to Huw Tranter',
      },
      {
        id: 'QT-203',
        kind: 'follow_up',
        at: ts(-3, 11),
        byId: 'P-000001',
        title: 'Follow-up logged (Phone)',
        detail: 'Spoke with Huw Tranter; requested capped fee option at £4,200 + VAT.',
      },
      {
        id: 'QT-204',
        kind: 'revised',
        at: ts(-2, 15),
        byId: 'P-000001',
        title: 'Revised quote to v2 (v1 marked Superseded)',
        detail: 'Updated fee basis to Capped fee £4,200 + VAT',
      },
      {
        id: 'QT-205',
        kind: 'sent',
        at: ts(-2, 16),
        byId: 'P-000001',
        title: 'v2 marked as sent',
        detail: `Next follow-up scheduled for ${day(5)}`,
      },
    ],
    createdById: 'P-000001',
    createdAt: ts(-6, 10),
    updatedById: 'P-000001',
    updatedAt: ts(-2, 16),
  });

  // QTE-YYYY-0003: Follow-up due (overdue by 4 days, assigned to Rhian Morgan P-000001), linked to ENQ-000005 (Bryn Walters)
  qten++;
  const qte3Ref = makeQuoteRef(qten);
  quotes.push({
    id: qte3Ref,
    reference: qte3Ref,
    version: 1,
    status: 'Follow-up due',
    clientType: 'prospect',
    linkedOrganisationId: null,
    linkedPersonId: null,
    prospectName: 'Bryn Walters',
    prospectOrganisationName: '',
    prospectEmail: 'bryn.walters@pmail.example',
    prospectPhone: '0117 496 0421',
    linkedEnquiryId: enq5.id,
    convertedMatterId: null,
    practiceAreaId: v('work_type', 'Private Client, Trusts & Family'),
    workTypeSubcategoryId: subId('Private Client, Trusts & Family', 'Probate & estate administration'),
    scope:
      "Full estate administration for late uncle's estate (approx. £1.4m including Monmouthshire agricultural land and investment portfolio), including preparing IHT400 and agricultural relief schedule, applying for Grant of Probate, collecting assets, and preparing estate accounts.",
    assumptions:
      'Estimate based on 20 hours at £320/hr. Assumes validity of the will is uncontested and no HMRC agricultural property relief valuation dispute arises. Conveyancing on any sale of the farmhouse will be quoted separately.',
    feeBasis: 'Hourly rate with estimate',
    feeAmountExVat: 6400,
    hourlyRateGbp: 320,
    vatAmount: 1280,
    disbursements: [
      {
        id: 'QDISB-301',
        description: 'Probate Registry application fee & sealed copies',
        amountExVat: 308,
        vatApplicable: false,
      },
      {
        id: 'QDISB-302',
        description: 'Statutory creditor notices (London Gazette & local press)',
        amountExVat: 210,
        vatApplicable: true,
      },
    ],
    totalIncVat: 8240,
    feeEarnerId: 'P-000001',
    assignedTeamId: tmPrivateClient.id,
    validUntil: day(18),
    followUpAfterDays: 7,
    sentAt: ts(-11, 15),
    nextFollowUpDate: day(-4),
    outcomeAt: null,
    declineReason: null,
    followUps: [],
    versionHistory: [],
    timeline: [
      {
        id: 'QT-301',
        kind: 'created',
        at: ts(-12, 10),
        byId: 'P-000001',
        title: 'Quote created (v1)',
        detail: `Linked to enquiry ${enq5.reference} — Hourly rate (£320/hr) with estimate £6,400 + VAT`,
      },
      {
        id: 'QT-302',
        kind: 'sent',
        at: ts(-11, 15),
        byId: 'P-000001',
        title: 'Marked as sent to Bryn Walters',
        detail: `First follow-up scheduled for ${day(-4)}`,
      },
    ],
    createdById: 'P-000001',
    createdAt: ts(-12, 10),
    updatedById: 'P-000001',
    updatedAt: ts(-11, 15),
  });

  // QTE-YYYY-0004: Draft quote (Standalone for existing client Penarth Estates Ltd, by Rhian Morgan P-000001)
  qten++;
  const qte4Ref = makeQuoteRef(qten);
  quotes.push({
    id: qte4Ref,
    reference: qte4Ref,
    version: 1,
    status: 'Draft',
    clientType: 'existing',
    linkedOrganisationId: penarth.id,
    linkedPersonId: alun.id,
    prospectName: 'Alun Davies',
    prospectOrganisationName: penarth.legalName,
    prospectEmail: 'a.davies@penarthestates.example',
    prospectPhone: '029 2018 0101',
    linkedEnquiryId: null,
    convertedMatterId: null,
    practiceAreaId: v('work_type', 'Real Estate & Property'),
    workTypeSubcategoryId: subId('Real Estate & Property', 'Landlord & tenant'),
    scope:
      'Drafting and negotiating deed of variation and licence for alterations for Unit 9, Cardiff Bay Retail Park (tenant solar PV roof installation).',
    assumptions:
      "Assumes landlord's structural engineer approves roof loading specification directly with tenant.",
    feeBasis: 'Fixed fee',
    feeAmountExVat: 1950,
    hourlyRateGbp: null,
    vatAmount: 390,
    disbursements: [
      {
        id: 'QDISB-401',
        description: 'HM Land Registry official copies',
        amountExVat: 14,
        vatApplicable: false,
      },
    ],
    totalIncVat: 2354,
    feeEarnerId: 'P-000001',
    assignedTeamId: tmRealEstate.id,
    validUntil: day(29),
    followUpAfterDays: 7,
    sentAt: null,
    nextFollowUpDate: null,
    outcomeAt: null,
    declineReason: null,
    followUps: [],
    versionHistory: [],
    timeline: [
      {
        id: 'QT-401',
        kind: 'created',
        at: ts(-1, 16),
        byId: 'P-000001',
        title: 'Draft quote created (v1)',
        detail: 'Fixed fee £1,950 + VAT for Penarth Estates Ltd',
      },
    ],
    createdById: 'P-000001',
    createdAt: ts(-1, 16),
    updatedById: 'P-000001',
    updatedAt: ts(-1, 16),
  });

  // QTE-YYYY-0005: Expired quote (valid-until date passed 7 days ago with no outcome)
  qten++;
  const qte5Ref = makeQuoteRef(qten);
  quotes.push({
    id: qte5Ref,
    reference: qte5Ref,
    version: 1,
    status: 'Expired',
    clientType: 'prospect',
    linkedOrganisationId: null,
    linkedPersonId: null,
    prospectName: 'Megan Lloyd-Anne',
    prospectOrganisationName: 'Cambria Foodservice Ltd',
    prospectEmail: 'm.lloyd@cambriafoodservice.example',
    prospectPhone: '029 2018 0881',
    linkedEnquiryId: null,
    convertedMatterId: null,
    practiceAreaId: v('work_type', 'Corporate & Commercial'),
    workTypeSubcategoryId: subId('Corporate & Commercial', 'Commercial contracts'),
    scope:
      'Review and redraft of standard B2B wholesale distribution terms and conditions, retention of title clauses, and credit account guarantee documentation.',
    assumptions:
      'Covers one round of revisions following client feedback call. Excludes bespoke international export terms.',
    feeBasis: 'Fixed fee',
    feeAmountExVat: 3250,
    hourlyRateGbp: null,
    vatAmount: 650,
    disbursements: [],
    totalIncVat: 3900,
    feeEarnerId: 'P-000007',
    assignedTeamId: tmCorporate.id,
    validUntil: day(-7),
    followUpAfterDays: 7,
    sentAt: ts(-37, 11),
    nextFollowUpDate: null,
    outcomeAt: ts(-7, 9),
    declineReason: null,
    followUps: [
      {
        id: 'QFU-501',
        at: ts(-25, 14),
        method: 'Email',
        note: 'Sent follow-up email checking whether board had reviewed scope; Megan replied that project was paused pending Q4 budget review.',
        nextFollowUpDate: day(-10),
        byId: 'P-000007',
      },
    ],
    versionHistory: [],
    timeline: [
      {
        id: 'QT-501',
        kind: 'created',
        at: ts(-38, 10),
        byId: 'P-000007',
        title: 'Quote created (v1)',
        detail: 'Fixed fee £3,250 + VAT',
      },
      {
        id: 'QT-502',
        kind: 'sent',
        at: ts(-37, 11),
        byId: 'P-000007',
        title: 'Marked as sent to Megan Lloyd-Anne',
        detail: `Valid until ${day(-7)}`,
      },
      {
        id: 'QT-503',
        kind: 'follow_up',
        at: ts(-25, 14),
        byId: 'P-000007',
        title: 'Follow-up logged (Email)',
        detail: 'Project paused pending Q4 budget review.',
      },
      {
        id: 'QT-504',
        kind: 'expired',
        at: ts(-7, 9),
        byId: null,
        title: 'Quote expired',
        detail: `Valid-until date (${day(-7)}) passed without an outcome.`,
      },
    ],
    createdById: 'P-000007',
    createdAt: ts(-38, 10),
    updatedById: 'P-000007',
    updatedAt: ts(-7, 9),
  });

  // QTE-YYYY-0006: Accepted quote (ready to convert to matter)
  qten++;
  const qte6Ref = makeQuoteRef(qten);
  quotes.push({
    id: qte6Ref,
    reference: qte6Ref,
    version: 1,
    status: 'Accepted',
    clientType: 'existing',
    linkedOrganisationId: castell.id,
    linkedPersonId: seren.id,
    prospectName: 'Seren Jenkins',
    prospectOrganisationName: castell.legalName,
    prospectEmail: 's.jenkins@castellhomes.example',
    prospectPhone: '029 2018 0220',
    linkedEnquiryId: null,
    convertedMatterId: null,
    practiceAreaId: v('work_type', 'Employment & HR'),
    workTypeSubcategoryId: subId('Employment & HR', 'Contracts, policies & handbooks'),
    scope:
      'Comprehensive review and update of Staff Handbook, hybrid working policy, disciplinary & grievance procedures, and senior executive service agreement template for 2026/27.',
    assumptions:
      'Includes one 90-minute HR workshop with line managers. Excludes individual TUPE consultation advice.',
    feeBasis: 'Fixed fee',
    feeAmountExVat: 3600,
    hourlyRateGbp: null,
    vatAmount: 720,
    disbursements: [],
    totalIncVat: 4320,
    feeEarnerId: 'P-000006',
    assignedTeamId: tmEmployment.id,
    validUntil: day(22),
    followUpAfterDays: 7,
    sentAt: ts(-7, 10),
    nextFollowUpDate: null,
    outcomeAt: ts(-1, 15),
    outcomeNote: 'Seren Jenkins confirmed acceptance by phone and asked us to open the matter.',
    declineReason: null,
    followUps: [
      {
        id: 'QFU-601',
        at: ts(-2, 11),
        method: 'Phone',
        note: 'Spoke with Seren Jenkins; HR director approved scope and confirming purchase order number.',
        nextFollowUpDate: null,
        byId: 'P-000006',
      },
    ],
    versionHistory: [],
    timeline: [
      {
        id: 'QT-601',
        kind: 'created',
        at: ts(-8, 9),
        byId: 'P-000006',
        title: 'Quote created (v1)',
        detail: 'Fixed fee £3,600 + VAT for Castell Homes (South Wales) Ltd',
      },
      {
        id: 'QT-602',
        kind: 'sent',
        at: ts(-7, 10),
        byId: 'P-000006',
        title: 'Marked as sent to Seren Jenkins',
        detail: `First follow-up scheduled for ${day(0)}`,
      },
      {
        id: 'QT-603',
        kind: 'follow_up',
        at: ts(-2, 11),
        byId: 'P-000006',
        title: 'Follow-up logged (Phone)',
        detail: 'HR director approved scope; confirming PO.',
      },
      {
        id: 'QT-604',
        kind: 'accepted',
        at: ts(-1, 15),
        byId: 'P-000006',
        title: 'Outcome recorded: Accepted',
        detail: 'Seren Jenkins confirmed acceptance by phone and asked us to open the matter.',
      },
    ],
    createdById: 'P-000006',
    createdAt: ts(-8, 9),
    updatedById: 'P-000006',
    updatedAt: ts(-1, 15),
  });

  // 15+ Demo Tasks across people and teams, including overdue and unclaimed ones
  const tasks: Task[] = [];
  let tskn = 0;
  const addTask = (
    createdOffset: number,
    fields: Partial<Task> & Pick<Task, 'title' | 'dueAt'>,
  ): Task => {
    const id = `TSK-${String(++tskn).padStart(6, '0')}`;
    const createdBy = fields.createdById ?? 'P-000001';
    const status = fields.status ?? 'To do';
    const t: Task = {
      id,
      reference: id,
      title: fields.title,
      description: fields.description ?? '',
      taskTypeId: fields.taskTypeId ?? v('task_type', 'General'),
      priorityId: fields.priorityId ?? v('task_priority', 'Normal'),
      dueAt: fields.dueAt,
      assignedTeamId: fields.assignedTeamId ?? null,
      assignedPersonId: fields.assignedPersonId ?? null,
      status,
      linkedRecords: fields.linkedRecords ?? [],
      createdById: createdBy,
      createdAt: ts(createdOffset, 9),
      updatedById: fields.updatedById ?? createdBy,
      updatedAt: ts(Math.min(createdOffset + 1, 0), 14),
      completedById: status === 'Done' ? (fields.completedById ?? fields.assignedPersonId ?? createdBy) : null,
      completedAt: status === 'Done' ? (fields.completedAt ?? ts(-1, 16)) : null,
      comments: fields.comments ?? [],
      autoTrigger: fields.autoTrigger ?? null,
    };
    tasks.push(t);
    return t;
  };

  // TSK-000001: Unclaimed Employment & HR team contact task for ENQ-000001 (Due today 17:30)
  addTask(0, {
    title: 'Contact new enquiry: Carys Bevan',
    description: 'Urgent settlement agreement enquiry (5-day deadline). Call Carys Bevan on 07700 900318.',
    taskTypeId: v('task_type', 'Call back'),
    priorityId: v('task_priority', 'Urgent'),
    dueAt: enq1.firstContactDueAt!,
    assignedTeamId: tmEmployment.id,
    assignedPersonId: null,
    status: 'To do',
    linkedRecords: [{ recordType: 'enquiry', recordId: enq1.id }],
    createdById: 'P-000010',
    autoTrigger: 'enquiry_contact',
  });

  // TSK-000002: Assigned contact task for ENQ-000002 (Rhodri Hopkins - 2 failed attempts, overdue)
  addTask(-3, {
    title: 'Contact new enquiry: Rhodri Hopkins',
    description: 'Third contact attempt required before considering No response closure. Disciplinary hearing next week.',
    taskTypeId: v('task_type', 'Call back'),
    priorityId: v('task_priority', 'High'),
    dueAt: day(-1),
    assignedTeamId: tmEmployment.id,
    assignedPersonId: 'P-000006',
    status: 'In progress',
    linkedRecords: [{ recordType: 'enquiry', recordId: enq2.id }],
    createdById: 'P-000010',
    autoTrigger: 'enquiry_contact',
    comments: [
      { id: 'TC-1', authorId: 'P-000006', at: ts(-1, 15), text: 'Two calls attempted without reaching Rhodri. Will try once more tomorrow morning.' },
    ],
  });

  // TSK-000003: Automatic Complete matter opening task for converted ENQ-000003 -> JON002-0001
  addTask(-5, {
    title: 'Complete matter opening: JON002-0001 (Sam Jones)',
    description: 'Complete AML verification, issue client care & engagement letter, and verify ACAS early conciliation certificate.',
    taskTypeId: v('task_type', 'Complete matter opening'),
    priorityId: v('task_priority', 'High'),
    dueAt: day(1),
    assignedTeamId: tmEmployment.id,
    assignedPersonId: 'P-000006',
    status: 'In progress',
    linkedRecords: [
      { recordType: 'matter', recordId: mSamJonesTribunal.id },
      { recordType: 'enquiry', recordId: enq3.id },
      { recordType: 'person', recordId: samJones.id },
    ],
    createdById: 'P-000006',
    autoTrigger: 'complete_matter_opening',
  });

  // TSK-000004: Overdue task for Rhian Morgan (P-000001, default user) on PEN001-0004
  addTask(-4, {
    title: 'Approve landlord service charge cap wording on Unit 4 lease',
    description: 'Review Alun Davies instructions on the £15,000 annual service charge cap and confirm to Dafydd Evans.',
    taskTypeId: v('task_type', 'Review'),
    priorityId: v('task_priority', 'High'),
    dueAt: day(-1),
    assignedTeamId: tmRealEstate.id,
    assignedPersonId: 'P-000001',
    status: 'To do',
    linkedRecords: [
      { recordType: 'matter', recordId: mPenarthLease.id },
      { recordType: 'organisation', recordId: penarth.id },
    ],
    createdById: 'P-000002',
    comments: [
      { id: 'TC-2', authorId: 'P-000002', at: ts(-2, 16), text: 'Morgan Price chasing for response ahead of Friday completion target.' },
    ],
  });

  // TSK-000005: Due today for Rhian Morgan (P-000001) on Tŷ Glas conflict
  addTask(-2, {
    title: 'Review COLP conflict note on Tŷ Glas Developments boundary overlap',
    description: 'Discuss information barrier requirements with Bethan Rees before confirming whether firm can act on TYG001-0001.',
    taskTypeId: v('task_type', 'Conflict check'),
    priorityId: v('task_priority', 'Urgent'),
    dueAt: day(0),
    assignedTeamId: tmRisk.id,
    assignedPersonId: 'P-000001',
    status: 'To do',
    linkedRecords: [
      { recordType: 'matter', recordId: mTyGlasDev.id },
      { recordType: 'organisation', recordId: tyGlas.id },
    ],
    createdById: 'P-000003',
  });

  // TSK-000006: Due this week for Rhian Morgan (P-000001)
  addTask(-3, {
    title: 'Call Alun Davies re Western Vale Homes Q4 pipeline',
    description: 'Follow up on two prospective residential development sites mentioned at last week board call.',
    taskTypeId: v('task_type', 'Follow up'),
    priorityId: v('task_priority', 'Normal'),
    dueAt: day(3),
    assignedTeamId: tmRealEstate.id,
    assignedPersonId: 'P-000001',
    status: 'To do',
    linkedRecords: [
      { recordType: 'person', recordId: alun.id },
      { recordType: 'organisation', recordId: westernVale.id },
    ],
    createdById: 'P-000008',
  });

  // TSK-000007: Due later for Rhian Morgan (P-000001)
  addTask(-5, {
    title: 'Sign off Harbourline Housing panel tender pricing schedule',
    description: 'Final partner sign-off on fixed-fee schedule for 2027 legal panel submission.',
    taskTypeId: v('task_type', 'Review'),
    priorityId: v('task_priority', 'Normal'),
    dueAt: day(12),
    assignedTeamId: tmRealEstate.id,
    assignedPersonId: 'P-000001',
    status: 'To do',
    linkedRecords: [{ recordType: 'organisation', recordId: harbourline.id }],
    createdById: 'P-000008',
  });

  // TSK-000008: Unclaimed Real Estate team task (overdue)
  addTask(-2, {
    title: 'Check HM Land Registry official copies for Celtic Quayside auction lot',
    description: 'Download title plan and epitome of title from Allsop portal for ENQ-000004.',
    taskTypeId: v('task_type', 'Review'),
    priorityId: v('task_priority', 'High'),
    dueAt: day(-1),
    assignedTeamId: tmRealEstate.id,
    assignedPersonId: null,
    status: 'To do',
    linkedRecords: [{ recordType: 'enquiry', recordId: enq4.id }],
    createdById: 'P-000002',
  });

  // TSK-000009: Unclaimed Private Client contact task for ENQ-000005 (Bryn Walters - overdue SLA)
  addTask(-2, {
    title: 'Contact new enquiry: Bryn Walters',
    description: 'Referred by Gareth Hughes (Hughes Lloyd). Probate & estate administration (£1.4m estate).',
    taskTypeId: v('task_type', 'Call back'),
    priorityId: v('task_priority', 'Normal'),
    dueAt: enq5.firstContactDueAt!,
    assignedTeamId: tmPrivateClient.id,
    assignedPersonId: null,
    status: 'To do',
    linkedRecords: [
      { recordType: 'enquiry', recordId: enq5.id },
      { recordType: 'person', recordId: gareth.id },
    ],
    createdById: 'P-000010',
    autoTrigger: 'enquiry_contact',
  });

  // TSK-000010: Automatic Send non-engagement letter task for declined ENQ-000006
  addTask(-7, {
    title: 'Send non-engagement letter: Marcus Finch',
    description: 'Confirm in writing that Not A Law Firm LLP cannot act due to a conflict of interest and no confidential information was retained.',
    taskTypeId: v('task_type', 'Send letter'),
    priorityId: v('task_priority', 'Normal'),
    dueAt: day(-5),
    assignedTeamId: tmDisputes.id,
    assignedPersonId: 'P-000006',
    status: 'Done',
    linkedRecords: [{ recordType: 'enquiry', recordId: enq6.id }],
    createdById: 'P-000006',
    completedById: 'P-000006',
    completedAt: ts(-6, 11),
    autoTrigger: 'non_engagement_letter',
  });

  // TSK-000011: Automatic Send non-engagement letter task for referred-out ENQ-000007
  addTask(-9, {
    title: 'Send non-engagement letter: Dr Arwel Maddock',
    description: 'Send referral confirmation and non-engagement letter introducing Morgan Price IP team.',
    taskTypeId: v('task_type', 'Send letter'),
    priorityId: v('task_priority', 'Normal'),
    dueAt: day(0),
    assignedTeamId: tmCorporate.id,
    assignedPersonId: 'P-000007',
    status: 'To do',
    linkedRecords: [
      { recordType: 'enquiry', recordId: enq7.id },
      { recordType: 'organisation', recordId: morganPrice.id },
    ],
    createdById: 'P-000007',
    autoTrigger: 'non_engagement_letter',
  });

  // TSK-000012: Task created by Rhian Morgan (P-000001) assigned to Dafydd Evans (P-000002)
  addTask(-3, {
    title: 'Chase Principality Building Society mortgage offer on 18 Cathedral View',
    description: 'Confirm valuation report has been processed for Mared Hughes purchase (HUG002-0001).',
    taskTypeId: v('task_type', 'Follow up'),
    priorityId: v('task_priority', 'Normal'),
    dueAt: day(2),
    assignedTeamId: tmRealEstate.id,
    assignedPersonId: 'P-000002',
    status: 'In progress',
    linkedRecords: [
      { recordType: 'matter', recordId: mMaredPurchase.id },
      { recordType: 'person', recordId: mared.id },
    ],
    createdById: 'P-000001',
  });

  // TSK-000013: Task created by Rhian Morgan (P-000001) assigned to Bethan Rees (P-000003)
  addTask(-4, {
    title: 'Verify certified proof of address for Mared Hughes',
    description: 'Check Welsh Water utility bill uploaded by client and update verification status.',
    taskTypeId: v('task_type', 'Conflict check'),
    priorityId: v('task_priority', 'High'),
    dueAt: day(-1),
    assignedTeamId: tmRisk.id,
    assignedPersonId: 'P-000003',
    status: 'Waiting',
    linkedRecords: [
      { recordType: 'person', recordId: mared.id },
      { recordType: 'matter', recordId: mMaredPurchase.id },
    ],
    createdById: 'P-000001',
  });

  // TSK-000014: Employment & HR team task claimed by Siân Llewellyn (P-000005)
  addTask(-2, {
    title: 'Prepare Respondent agenda for Bristol ET preliminary hearing (BRI001-0003)',
    description: 'Draft list of issues and case management agenda for Brightwater Care Group Ltd.',
    taskTypeId: v('task_type', 'Review'),
    priorityId: v('task_priority', 'High'),
    dueAt: day(4),
    assignedTeamId: tmEmployment.id,
    assignedPersonId: 'P-000005',
    status: 'In progress',
    linkedRecords: [
      { recordType: 'matter', recordId: mBrightwaterTribunal.id },
      { recordType: 'organisation', recordId: brightwater.id },
    ],
    createdById: 'P-000005',
  });

  // TSK-000015: Completed task for Rhian Morgan (P-000001)
  addTask(-7, {
    title: 'Send heads of terms to Penarth Estates board',
    description: 'Circulate signed heads of terms for Unit 4, Cardiff Bay Retail Park.',
    taskTypeId: v('task_type', 'Send letter'),
    priorityId: v('task_priority', 'Normal'),
    dueAt: day(-5),
    assignedTeamId: tmRealEstate.id,
    assignedPersonId: 'P-000001',
    status: 'Done',
    linkedRecords: [
      { recordType: 'matter', recordId: mPenarthLease.id },
      { recordType: 'organisation', recordId: penarth.id },
    ],
    createdById: 'P-000001',
    completedById: 'P-000001',
    completedAt: ts(-5, 17),
  });

  // Additional Role-Home-Page Tasks for Dafydd Evans (P-000002), Sarah Cole (empSarahCole), Nia Jenkins (empNiaJenkins), Lowri Ellis (empLowriEllis)
  // TSK-000016: Overdue 2d for Dafydd Evans on PRI001-0001
  addTask(-4, {
    title: 'Send final completion statement and transfer deed (TR1) for signature',
    description: 'Prepare final completion statement and send engrossed TR1 to Owen & Carys Price ahead of Friday completion.',
    taskTypeId: v('task_type', 'Send letter'),
    priorityId: v('task_priority', 'Urgent'),
    dueAt: day(-2),
    assignedTeamId: tmRealEstate.id,
    assignedPersonId: 'P-000002',
    status: 'To do',
    linkedRecords: [
      { recordType: 'matter', recordId: mOwenWill.id },
      { recordType: 'person', recordId: owen.id },
    ],
    createdById: 'P-000001',
  });

  // TSK-000017: Overdue 1d for Dafydd Evans on TGL001-0002
  addTask(-3, {
    title: 'Complete matter opening: TGL001-0002 (Tŷ Glas Developments Ltd)',
    description: 'Complete source of funds / EDD verification and obtain signed engagement letter.',
    taskTypeId: v('task_type', 'Complete matter opening'),
    priorityId: v('task_priority', 'High'),
    dueAt: day(-1),
    assignedTeamId: tmRealEstate.id,
    assignedPersonId: 'P-000002',
    status: 'In progress',
    linkedRecords: [
      { recordType: 'matter', recordId: mPlot9TyGlas.id },
      { recordType: 'organisation', recordId: tyGlas.id },
    ],
    createdById: 'P-000001',
    autoTrigger: 'complete_matter_opening',
  });

  // TSK-000018: Due today for Dafydd Evans on ENQ-000009 (Western Vale Homes Ltd)
  addTask(0, {
    title: 'Contact new enquiry: Western Vale Homes Ltd (Alun Davies)',
    description: 'Option agreement & planning promotion on 14-acre residential site near Cowbridge.',
    taskTypeId: v('task_type', 'Call back'),
    priorityId: v('task_priority', 'High'),
    dueAt: day(0),
    assignedTeamId: tmRealEstate.id,
    assignedPersonId: 'P-000002',
    status: 'To do',
    linkedRecords: [
      { recordType: 'enquiry', recordId: enq9.id },
      { recordType: 'organisation', recordId: westernVale.id },
    ],
    createdById: empLowriEllis.id,
    autoTrigger: 'enquiry_contact',
  });

  // TSK-000019: Due today for Dafydd Evans on PEN001-0001 / PEN001-0004
  addTask(-1, {
    title: "Review tenant's travelling draft lease and report on alienation clause",
    description: 'Review Morgan Price amendments to clause 18 (underletting) and send short note to Alun Davies.',
    taskTypeId: v('task_type', 'Review'),
    priorityId: v('task_priority', 'Normal'),
    dueAt: day(0),
    assignedTeamId: tmRealEstate.id,
    assignedPersonId: 'P-000002',
    status: 'In progress',
    linkedRecords: [
      { recordType: 'matter', recordId: mPenarthLease.id },
      { recordType: 'organisation', recordId: penarth.id },
    ],
    createdById: 'P-000001',
  });

  // TSK-000020: Due today for Dafydd Evans on HAR001-0003
  addTask(-2, {
    title: 'Circulate clean s.106 unilateral undertaking to Cardiff Council legal',
    description: 'Send agreed clean copy of s.106 unilateral undertaking on Butetown regeneration.',
    taskTypeId: v('task_type', 'Send letter'),
    priorityId: v('task_priority', 'Normal'),
    dueAt: day(0),
    assignedTeamId: tmRealEstate.id,
    assignedPersonId: 'P-000002',
    status: 'To do',
    linkedRecords: [
      { recordType: 'matter', recordId: mButetown.id },
      { recordType: 'organisation', recordId: harbourline.id },
    ],
    createdById: 'P-000001',
  });

  // TSK-000021: Waiting task for Dafydd Evans on PEN001-0001 / PEN001-0004
  addTask(-5, {
    title: 'Awaiting landlord instructions on rent deposit deed wording',
    description: 'Sent draft rent deposit deed to Alun Davies on 14 Oct; awaiting board confirmation.',
    taskTypeId: v('task_type', 'Follow up'),
    priorityId: v('task_priority', 'Normal'),
    dueAt: day(1),
    assignedTeamId: tmRealEstate.id,
    assignedPersonId: 'P-000002',
    status: 'Waiting',
    linkedRecords: [
      { recordType: 'matter', recordId: mPenarthLease.id },
      { recordType: 'organisation', recordId: penarth.id },
    ],
    createdById: 'P-000002',
  });

  // TSK-000022: Waiting task for Dafydd Evans on PEN001-0002
  addTask(-7, {
    title: 'Awaiting joint surveyor report from Cadwyn Surveying',
    description: 'Instructed Dr Sarah Holt (Cadwyn Surveying) on 12 Oct; joint inspection report due next week.',
    taskTypeId: v('task_type', 'Follow up'),
    priorityId: v('task_priority', 'Normal'),
    dueAt: day(3),
    assignedTeamId: tmRealEstate.id,
    assignedPersonId: 'P-000002',
    status: 'Waiting',
    linkedRecords: [
      { recordType: 'matter', recordId: mMarinaParade.id },
      { recordType: 'person', recordId: sarah.id },
    ],
    createdById: 'P-000002',
  });

  // TSK-000023: Unassigned Real Estate team task (Land Transaction Tax return on PRI001-0001)
  addTask(-1, {
    title: 'Prepare Land Transaction Tax (LTT) return draft for client approval',
    description: 'Draft WRA Land Transaction Tax return ahead of 23 Oct completion on 14 Cathedral Road.',
    taskTypeId: v('task_type', 'Send letter'),
    priorityId: v('task_priority', 'Normal'),
    dueAt: day(2),
    assignedTeamId: tmRealEstate.id,
    assignedPersonId: null,
    status: 'To do',
    linkedRecords: [
      { recordType: 'matter', recordId: mOwenWill.id },
      { recordType: 'person', recordId: owen.id },
    ],
    createdById: 'P-000002',
  });

  // TSK-000024: Assigned to Sarah Cole (Legal Secretary) — Overdue 1d
  addTask(-2, {
    title: 'Send non-engagement letter: Marcus Finch',
    description: 'Prepare and send conflict non-engagement letter for declined enquiry ENQ-000006.',
    taskTypeId: v('task_type', 'Send letter'),
    priorityId: v('task_priority', 'Urgent'),
    dueAt: day(-1),
    assignedTeamId: tmRealEstate.id,
    assignedPersonId: empSarahCole.id,
    status: 'To do',
    linkedRecords: [{ recordType: 'enquiry', recordId: enq6.id }],
    createdById: 'P-000002',
    autoTrigger: 'non_engagement_letter',
  });

  // TSK-000025: Assigned to Sarah Cole (Legal Secretary) — Due today
  addTask(-1, {
    title: 'Prepare engagement letter & client care pack — Tŷ Glas Developments Ltd',
    description: 'Generate fixed-fee commercial property engagement letter and AML checklist for TGL001-0002.',
    taskTypeId: v('task_type', 'Send letter'),
    priorityId: v('task_priority', 'High'),
    dueAt: day(0),
    assignedTeamId: tmRealEstate.id,
    assignedPersonId: empSarahCole.id,
    status: 'In progress',
    linkedRecords: [
      { recordType: 'matter', recordId: mPlot9TyGlas.id },
      { recordType: 'organisation', recordId: tyGlas.id },
    ],
    createdById: 'P-000002',
  });

  // TSK-000026: Assigned to Sarah Cole (Legal Secretary) — Due today
  addTask(-1, {
    title: 'Order OS1 priority search and bankruptcy searches (K16) ahead of completion',
    description: 'Run HM Land Registry OS1 priority search and K16 search on Owen & Carys Price (PRI001-0001).',
    taskTypeId: v('task_type', 'General'),
    priorityId: v('task_priority', 'Normal'),
    dueAt: day(0),
    assignedTeamId: tmRealEstate.id,
    assignedPersonId: empSarahCole.id,
    status: 'To do',
    linkedRecords: [
      { recordType: 'matter', recordId: mOwenWill.id },
      { recordType: 'person', recordId: owen.id },
    ],
    createdById: 'P-000002',
  });

  // TSK-000027: Assigned to Nia Jenkins (Finance / Credit control) — Overdue 1d
  addTask(-3, {
    title: 'Call Hannah Lewis re 94-day overdue invoice PV-2026-009 (£3,300.00)',
    description: 'Final telephone chase before partner escalation on BAY001-0001.',
    taskTypeId: v('task_type', 'Call back'),
    priorityId: v('task_priority', 'Urgent'),
    dueAt: day(-1),
    assignedTeamId: tmAccounts.id,
    assignedPersonId: empNiaJenkins.id,
    status: 'To do',
    linkedRecords: [
      { recordType: 'matter', recordId: mBayLease.id },
      { recordType: 'organisation', recordId: bayCafes.id },
    ],
    createdById: 'P-000009',
  });

  // TSK-000028: Assigned to Nia Jenkins (Finance / Credit control) — Due today
  addTask(-1, {
    title: 'Send statement of account to Brightwater Care Group Ltd (£22,637.40)',
    description: 'Include overdue invoice PV-2026-014 (£3,137.40) and upcoming due date on PV-2026-021.',
    taskTypeId: v('task_type', 'Send letter'),
    priorityId: v('task_priority', 'High'),
    dueAt: day(0),
    assignedTeamId: tmAccounts.id,
    assignedPersonId: empNiaJenkins.id,
    status: 'To do',
    linkedRecords: [{ recordType: 'organisation', recordId: brightwater.id }],
    createdById: 'P-000009',
  });

  // TSK-000029: Assigned to Rhian Morgan (Partner) — Due tomorrow
  addTask(-1, {
    title: 'Approve engrossment lease and licence for alterations on Unit 4',
    description: 'Partner sign-off on final engrossments for Penarth Estates Ltd ahead of exchange.',
    taskTypeId: v('task_type', 'Review'),
    priorityId: v('task_priority', 'Normal'),
    dueAt: day(1),
    assignedTeamId: tmRealEstate.id,
    assignedPersonId: 'P-000001',
    status: 'To do',
    linkedRecords: [
      { recordType: 'matter', recordId: mPenarthLease.id },
      { recordType: 'organisation', recordId: penarth.id },
    ],
    createdById: 'P-000002',
  });

  // Partner Sign-Offs & Approvals (02-partner-hod.html & 07-managing-partner.html)
  const signOffs: SignOffItem[] = [
    {
      id: 'SO-000001',
      kind: 'write_off',
      title: 'Write-off: £485.00 over fixed fee',
      matterNumber: 'PRI001-0001',
      matterId: mOwenWill.id,
      subtitle: 'PRI001-0001 · Owen & Carys Price · Requested by Dafydd Evans (time £1,985 vs £1,500 fixed fee)',
      requestedById: 'P-000002',
      requestedAt: ts(-1, 16),
      assignedPartnerId: 'P-000001',
      status: 'Pending',
    },
    {
      id: 'SO-000002',
      kind: 'matter_opening',
      title: 'Matter opening: Purchase of Plot 9, Parc Tŷ Glas',
      matterNumber: 'TGL001-0002',
      matterId: mPlot9TyGlas.id,
      subtitle: 'TGL001-0002 · Tŷ Glas Developments Ltd · High-risk rating requires partner sign-off alongside MLRO',
      requestedById: 'P-000002',
      requestedAt: ts(-1, 11),
      assignedPartnerId: 'P-000001',
      status: 'Pending',
    },
    {
      id: 'SO-000003',
      kind: 'undertaking',
      title: "Undertaking: discharge of seller's mortgage on completion",
      matterNumber: 'PRI001-0001',
      matterId: mOwenWill.id,
      subtitle: 'PRI001-0001 · Standard Law Society undertaking · Completion 23 Oct 2026',
      requestedById: 'P-000002',
      requestedAt: ts(0, 9),
      assignedPartnerId: 'P-000001',
      status: 'Pending',
    },
  ];

  const homePagesConfig = createDefaultHomePagesConfig(
    ts(0, 9),
    getActiveTenantConfiguration().branding.primaryDomain,
  );

  // Notifications for demo users
  const notifications: NotificationItem[] = [
    {
      id: 'NTF-000001',
      recipientId: 'P-000001',
      kind: 'task_overdue',
      title: 'Overdue task: Approve landlord service charge cap wording on Unit 4 lease',
      detail: 'TSK-000004 · PEN001-0004 was due yesterday',
      href: '/tasks/TSK-000004',
      recordId: 'TSK-000004',
      createdAt: ts(0, 8),
      read: false,
      byId: 'P-000002',
    },
    {
      id: 'NTF-000002',
      recipientId: 'P-000001',
      kind: 'task_assigned',
      title: 'Task assigned to you: Review COLP conflict note on Tŷ Glas Developments',
      detail: 'Assigned by Bethan Rees · Due today',
      href: '/tasks/TSK-000005',
      recordId: 'TSK-000005',
      createdAt: ts(-1, 14),
      read: false,
      byId: 'P-000003',
    },
    {
      id: 'NTF-000003',
      recipientId: 'P-000001',
      kind: 'task_comment',
      title: 'New comment on TSK-000004',
      detail: 'Dafydd Evans: "Morgan Price chasing for response ahead of Friday completion target."',
      href: '/tasks/TSK-000004',
      recordId: 'TSK-000004',
      createdAt: ts(-2, 16),
      read: false,
      byId: 'P-000002',
    },
    {
      id: 'NTF-000004',
      recipientId: 'P-000001',
      kind: 'team_task_arrived',
      title: 'New task in Real Estate & Property queue',
      detail: 'TSK-000008 — Check HM Land Registry official copies for Celtic Quayside auction lot',
      href: '/tasks/TSK-000008',
      recordId: 'TSK-000008',
      createdAt: ts(-1, 15),
      read: true,
      byId: 'P-000002',
    },
    {
      id: 'NTF-000005',
      recipientId: 'P-000005',
      kind: 'team_task_arrived',
      title: 'Urgent enquiry in Employment & HR queue: ENQ-000001 (Carys Bevan)',
      detail: 'TSK-000001 — Contact new enquiry: Carys Bevan · Due end of today',
      href: '/enquiries/ENQ-000001',
      recordId: 'ENQ-000001',
      createdAt: ts(0, 9),
      read: false,
      byId: 'P-000010',
    },
    {
      id: 'NTF-000006',
      recipientId: 'P-000006',
      kind: 'enquiry_assigned',
      title: 'Enquiry assigned to you: ENQ-000002 (Rhodri Hopkins)',
      detail: 'Employment & HR · Suspended pending disciplinary hearing next week',
      href: '/enquiries/ENQ-000002',
      recordId: 'ENQ-000002',
      createdAt: ts(-3, 12),
      read: false,
      byId: 'P-000005',
    },
  ];

  // ------------------------------------------------------------------ notes
  const notes: Note[] = [];
  let nn = 0;
  const note = (recordId: string, authorId: string, offset: number, text: string, hour = 11) => {
    notes.push({
      id: `N-${String(++nn).padStart(6, '0')}`,
      recordType: recordId.startsWith('P-') ? 'person' : recordId.startsWith('M-') ? 'matter' : 'organisation',
      recordId,
      authorId,
      at: ts(offset, hour),
      text,
    });
  };
  note(gareth.id, 'P-000001', -120, 'Lunch at the Bay. Gareth keen to introduce two property clients; asked about our capacity for development work.');
  note(gareth.id, 'P-000008', -40, 'Sent thank-you for Brightwater Care Group referral.');
  note(garethDup.id, 'P-000010', -5, 'Signed up to the Real Estate newsletter via the website. Mentioned he works at Hughes Lloyd.');
  note(mared.id, 'P-000002', -14, 'Referred by Gareth Hughes (Hughes Lloyd). Residential purchase, est. £2.5k. Prefers to speak Welsh.');
  note(mared.id, 'P-000003', -4, 'Electronic ID check returned a partial match; awaiting certified proof of address. MLRO referral opened.');
  note(penarth.id, 'P-000001', -2, 'Heads of terms agreed for Unit 4, Cardiff Bay Retail Park. Draft lease with tenant solicitors (Morgan Price).');
  note(harbourline.id, 'P-000001', -6, 'Panel tender 2027 kick-off. Ffion confirmed submission deadline 6 Nov.');
  note(tyGlas.id, 'P-000003', -1, 'Conflict search flagged Coastline Outdoor Ltd (counterparty on Penarth Estates matter). Do not proceed until cleared.');
  note(brightwater.id, 'P-000005', -2, 'Lease renewal across 3 sites. Instruction confirmed; referral from Hughes Lloyd.');
  note(alun.id, 'P-000001', -2, 'Call re break notice deadline. Alun also now sits on the Western Vale Homes board.');
  note(mPenarthLease.id, 'P-000002', -3, 'Revised travelling draft lease returned by Morgan Price Solicitors. Calling Alun Davies tomorrow morning to review tenant cap on service charge.');
  note(mSevernAcquisition.id, 'P-000007', -2, 'Disclosure letter and tax deed mark-up circulated to Hughes Lloyd (Anwen Lloyd) and W&I underwriter.');
  note(mHarbourlineDispute.id, 'P-000006', -1, 'Case conference with Geraint Williams KC and Dr Sarah Holt ahead of witness statement exchange deadline.');
  note(mTyGlasDev.id, 'P-000003', -1, 'Conflict review escalated to COLP. Coastline Outdoor Ltd boundary overlap checked against PEN001-0004.');

  // ------------------------------------------------------------------ custom fields
  const customLists: ChoiceList[] = [
    { key: 'cf_panel_appointment', label: 'Panel appointment', group: 'custom', appliesTo: ['organisation'], allowMultiple: false, hierarchical: false },
  ];
  const customValues: ChoiceValue[] = ['None', 'Preferred supplier', 'Panel member'].map((label, i) => ({
    id: v('cf_panel_appointment', label),
    listKey: 'cf_panel_appointment',
    label,
    sortOrder: i + 1,
    active: true,
    parentId: null,
  }));
  const customFields: CustomFieldDefinition[] = [
    { id: 'cf_will_held', recordType: 'person', label: 'Will held by firm', fieldType: 'yesNo', section: 'additional', required: false, sortOrder: 1, active: true },
    { id: 'cf_will_reference', recordType: 'person', label: 'Will reference', fieldType: 'text', section: 'additional', required: false, sortOrder: 2, active: true },
    { id: 'cf_panel_appointment', recordType: 'organisation', label: 'Panel appointment', fieldType: 'choice', optionsListKey: 'cf_panel_appointment', section: 'additional', required: false, sortOrder: 1, active: true },
  ];

  // ------------------------------------------------------------------ audit (one create entry per record)
  const audit: AuditEntry[] = [];
  let an = 0;
  for (const r of [...people, ...organisations, ...matters]) {
    audit.push({
      id: `AU-${String(++an).padStart(6, '0')}`,
      recordType: r.recordType,
      recordId: r.id,
      action: 'create',
      field: null,
      oldValue: null,
      newValue: 'Record created (demo data)',
      byId: r.createdById,
      at: r.createdAt,
    });
  }
  const seedValues = buildSeedLists().values;
  for (const enq of enquiries) {
    const chLabel = seedValues.find((x) => x.id === enq.channelId)?.label ?? 'Phone';
    const areaLabel = seedValues.find((x) => x.id === enq.practiceAreaId)?.label ?? '';
    audit.push({
      id: `AU-${String(++an).padStart(6, '0')}`,
      recordType: 'enquiry',
      recordId: enq.id,
      action: 'create',
      field: `Initial enquiry received (${chLabel.toLowerCase()})`,
      oldValue: null,
      newValue: [
        enq.reference,
        areaLabel || null,
        enq.summary ? `"${enq.summary.slice(0, 80)}"` : null,
      ]
        .filter(Boolean)
        .join(' · '),
      byId: enq.takenById,
      at: enq.receivedAt,
    });
  }
  for (const t of tasks) {
    audit.push({
      id: `AU-${String(++an).padStart(6, '0')}`,
      recordType: 'task',
      recordId: t.id,
      action: 'create',
      field: null,
      oldValue: null,
      newValue: `${t.reference} — ${t.title}`,
      byId: t.createdById,
      at: t.createdAt,
    });
  }
  for (const l of links) {
    for (const rid of [l.personId, l.organisationId]) {
      audit.push({
        id: `AU-${String(++an).padStart(6, '0')}`,
        recordType: rid.startsWith('P-') ? 'person' : 'organisation',
        recordId: rid,
        action: 'link',
        field: 'Organisation link',
        oldValue: null,
        newValue: `${l.personId} ↔ ${l.organisationId}`,
        byId: l.createdById,
        at: l.createdAt,
      });
    }
  }

  return {
    people,
    organisations,
    links,
    matters,
    teams,
    tasks,
    enquiries,
    quotes,
    notifications,
    enquirySettings: { ...DEFAULT_ENQUIRY_SETTINGS },
    taskSettings: {
      templates: DEFAULT_TASK_SETTINGS.templates.map((tpl) => ({ ...tpl })),
    },
    signOffs,
    homePagesConfig,
    notes,
    audit,
    customFields,
    customLists,
    customValues,
    recentlyViewed: {
      'P-000001': [
        enq1.id,
        mPenarthLease.id,
        penarth.id,
        mSevernAcquisition.id,
        mared.id,
        tyGlas.id,
        brightwater.id,
      ],
    },
    counters: {
      P: pn,
      O: 16,
      L: ln,
      M: mn,
      TM: tmn,
      TSK: tskn,
      ENQ: enqn,
      QTE: qten,
      NTF: notifications.length,
      SO: signOffs.length,
      N: nn,
      AU: an,
    },
  };
}

export function buildInitialSeedMatterPmsLinks(
  matters: Matter[],
  existingLinks: PmsLink[] = [],
  nowIso: string = new Date().toISOString(),
): PmsLink[] {
  const seededMatterLinks: PmsLink[] = [...existingLinks];
  const addSeedMatterLink = (matterId: string | undefined, pmsCode: string) => {
    if (!matterId) return;
    if (
      seededMatterLinks.some(
        (l) =>
          l.entityType === 'matter' &&
          (l.onesquaredId === matterId || l.pmsCode === pmsCode),
      )
    ) {
      return;
    }
    seededMatterLinks.push({
      id: `PMSL-M-${pmsCode}`,
      entityType: 'matter',
      onesquaredId: matterId,
      pmsCode,
      matchedBy: 'seed',
      matchedAt: nowIso,
    });
  };

  addSeedMatterLink(
    matters.find(
      (m) => m.matterNumber === 'PEN001-0004' || m.matterNumber === 'PEN001-0001',
    )?.id,
    'PEN001-0001',
  );
  addSeedMatterLink(
    matters.find((m) => m.matterNumber === 'PEN001-0002')?.id,
    'PEN001-0002',
  );
  addSeedMatterLink(
    matters.find((m) => m.matterNumber === 'PRI001-0001')?.id,
    'PRI001-0001',
  );
  addSeedMatterLink(
    matters.find((m) => m.matterNumber === 'PUG001-0001')?.id,
    'PUG001-0001',
  );
  addSeedMatterLink(
    matters.find((m) => m.id === 'M-000007')?.id,
    'BRI001-0001',
  );
  addSeedMatterLink(
    matters.find(
      (m) => m.matterNumber === 'BRI001-0003' && m.title.includes('Afon Care'),
    )?.id,
    'BRI001-0003',
  );
  addSeedMatterLink(
    matters.find((m) => m.matterNumber === 'SEV001-0001')?.id,
    'SEV001-0001',
  );
  addSeedMatterLink(
    matters.find((m) => m.matterNumber === 'PEN001-0003')?.id,
    'PEN001-0003',
  );
  addSeedMatterLink(
    matters.find((m) => m.matterNumber === 'HAR001-0003')?.id,
    'HAR001-0003',
  );
  addSeedMatterLink(
    matters.find((m) => m.matterNumber === 'BAY001-0001')?.id,
    'BAY001-0001',
  );
  addSeedMatterLink(
    matters.find((m) => m.matterNumber === 'JON002-0001')?.id,
    'SJO001-0001',
  );

  return seededMatterLinks;
}


