/**
 * Seed choice lists. Every value is editable in admin.
 * Ids are stable (`listKey.slug`) so demo data can reference them.
 */
import taxonomy from './data/taxonomy.json';
import type { ChoiceList, ChoiceValue, ListGroup, RecordType } from '@/domain/types';

export function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

export function vid(listKey: string, label: string): string {
  return `${listKey}.${slug(label)}`;
}

type Seed = string | { label: string; description?: string; guidance?: string; systemKey?: string; meta?: Record<string, string> };

interface ListSeed {
  key: string;
  label: string;
  group: ListGroup;
  appliesTo: RecordType[];
  allowMultiple?: boolean;
  description?: string;
  values: Seed[];
}

const BOTH: RecordType[] = ['person', 'organisation'];
const P: RecordType[] = ['person'];
const O: RecordType[] = ['organisation'];

function find<T extends { dimension: string }>(arr: T[], dimension: string): T {
  const d = arr.find((x) => x.dimension === dimension);
  if (!d) throw new Error(`Taxonomy dimension not found: ${dimension}`);
  return d;
}

const crm = taxonomy.crmAndRelationships;
const cm = taxonomy.clientAndMatter;

function fromTaxonomy(dim: { values: { name: string; description?: string; guidance?: string }[] }): Seed[] {
  return dim.values.map((v) => ({ label: v.name, description: v.description, guidance: v.guidance }));
}

const FLAT_LISTS: ListSeed[] = [
  // ---------------- People ----------------
  { key: 'title', label: 'Title', group: 'people', appliesTo: P, values: ['Mr', 'Mrs', 'Miss', 'Ms', 'Mx', 'Dr', 'Prof', 'Rev', 'Sir', 'Dame', 'Lord', 'Lady'] },
  {
    key: 'person_role',
    label: 'Person relationship roles',
    group: 'people',
    appliesTo: P,
    allowMultiple: true,
    values: [
      { label: 'Client contact', description: 'Contact at a client organisation' },
      { label: 'Private client', description: 'An individual who is a client in their own right' },
      { label: 'Referrer', description: 'Refers work to the firm' },
      { label: 'Introducer', description: 'Introduces work, often under a formal agreement' },
      { label: 'Supplier contact', description: 'Contact at a supplier' },
      { label: 'Counsel', description: 'Barrister or KC instructed by the firm' },
      { label: 'Expert', description: 'Independent expert or consultant' },
      { label: 'Internal colleague', description: 'Colleague within the firm' },
      { label: 'Professional adviser', description: 'Accountant, tax adviser, IFA or similar' },
      { label: 'Opposing party', description: 'The other side in a dispute or transaction' },
    ],
  },
  {
    key: 'person_record_status',
    label: 'Person record status',
    group: 'people',
    appliesTo: P,
    values: [
      { label: 'Active', systemKey: 'active' },
      { label: 'Archived', systemKey: 'archived', description: 'Hidden from default lists; still searchable' },
      { label: 'Deceased', systemKey: 'deceased', description: 'Hidden from default lists; still searchable' },
      { label: 'Merged', systemKey: 'merged', description: 'Merged into another record' },
    ],
  },
  {
    key: 'employee_role',
    label: 'Employee roles',
    group: 'people',
    appliesTo: P,
    description: 'Each employee has exactly one role.',
    values: [
      { label: 'Partner', description: 'Equity partner, salaried partner' },
      { label: 'Fee earner', description: 'Solicitor, associate, legal executive, paralegal' },
      { label: 'Practice manager', description: 'Oversees a practice area' },
      { label: 'Business development', description: 'Manages client and referrer relationships' },
      { label: 'Risk and compliance', description: 'Conflicts, onboarding and compliance' },
      { label: 'Finance', description: 'Billing, credit control and financial administration' },
      { label: 'Support staff', description: 'Legal secretary, administrator, operations support' },
      { label: 'System administrator', description: 'Manages application configuration and access' },
    ],
  },
  {
    key: 'department',
    label: 'Department or team',
    group: 'people',
    appliesTo: P,
    values: ['Real Estate', 'Corporate & Commercial', 'Dispute Resolution', 'Private Client', 'Employment', 'Risk & Compliance', 'Finance', 'Business Development', 'Operations', 'IT & Systems'],
  },
  {
    key: 'leaving_reason',
    label: 'Leaving reason',
    group: 'people',
    appliesTo: P,
    description: 'Reason an employee or member left the firm.',
    values: [
      'Resignation',
      'Retirement',
      'End of fixed term',
      'Redundancy',
      'Dismissal',
      'Mutual agreement',
      'Transfer / TUPE',
      'Other',
    ],
  },
  { key: 'other_name_type', label: 'Alternative name type', group: 'people', appliesTo: P, values: ['Previous name', 'Maiden name', 'Also known as', 'Alias'] },
  {
    key: 'verification_method',
    label: 'Verification method',
    group: 'people',
    appliesTo: P,
    values: ['Electronic ID check', 'Passport (certified copy)', 'Driving licence (certified copy)', 'In-person meeting', 'Third-party confirmation', 'Companies House check'],
  },
  {
    key: 'marketing_consent',
    label: 'Marketing consent',
    group: 'people',
    appliesTo: P,
    values: [
      { label: 'Consented', description: 'Opted in to marketing communications' },
      { label: 'Not asked', description: 'Consent not yet requested' },
      { label: 'Objected', description: 'Has objected to marketing; do not send' },
      { label: 'Withdrawn', description: 'Previously consented, now withdrawn' },
    ],
  },

  // ---------------- Organisations ----------------
  {
    key: 'organisation_type',
    label: 'Organisation types',
    group: 'organisations',
    appliesTo: O,
    values: ['Company', 'plc', 'LLP', 'Partnership', 'Sole trader', 'Charity', 'Public body', 'Law firm', "Barristers' chambers", 'Supplier', 'Non-profit', 'Insurer', 'Trust'],
  },
  {
    key: 'organisation_relationship_type',
    label: 'Organisation relationship types',
    group: 'organisations',
    appliesTo: O,
    allowMultiple: true,
    values: ['Client', 'Former client', 'Prospect', 'Referrer', 'Introducer', 'Business development contact', 'Supplier', 'Strategic partner', 'Opposing solicitors', 'Counterparty', 'Barristers', 'Experts and consultants', 'Professional adviser'],
  },
  {
    key: 'organisation_record_status',
    label: 'Organisation record status',
    group: 'organisations',
    appliesTo: O,
    values: [
      { label: 'Active', systemKey: 'active' },
      { label: 'Archived', systemKey: 'archived', description: 'Hidden from default lists; still searchable' },
      { label: 'Merged', systemKey: 'merged', description: 'Merged into another record' },
      { label: 'Dissolved', systemKey: 'dissolved', description: 'Organisation no longer exists' },
    ],
  },
  { key: 'onboarding_status', label: 'Onboarding status', group: 'organisations', appliesTo: O, values: ['Not started', 'In progress', 'Awaiting documents', 'Complete', 'On hold', 'Declined'] },
  {
    key: 'conflict_status',
    label: 'Conflict check status',
    group: 'organisations',
    appliesTo: O,
    values: [
      'Not checked',
      'In progress',
      { label: 'Cleared', systemKey: 'cleared' },
      { label: 'Potential conflict', systemKey: 'potential_conflict', description: 'Possible conflict identified; needs review before acting' },
      'Cleared with consent',
      'Conflict – declined',
    ],
  },
  { key: 'risk_assessment_status', label: 'Risk assessment status', group: 'organisations', appliesTo: O, values: ['Not started', 'In progress', 'Complete', 'Review due'] },
  { key: 'invoice_preference', label: 'Invoice preference', group: 'organisations', appliesTo: O, values: ['Email (PDF)', 'Post', 'Client portal', 'Consolidated monthly', 'E-billing (LEDES)'] },
  { key: 'payment_terms', label: 'Payment terms', group: 'organisations', appliesTo: O, values: ['On receipt', '14 days', '30 days', '60 days', 'Monthly in arrears', 'Money on account'] },
  { key: 'org_name_type', label: 'Organisation name type', group: 'organisations', appliesTo: O, values: ['Trading name', 'Former name', 'Abbreviation'] },

  // ---------------- Shared ----------------
  { key: 'relationship_status', label: 'Relationship status', group: 'shared', appliesTo: BOTH, values: ['Prospective', 'Active', 'Dormant', 'Former'] },
  {
    key: 'contact_role',
    label: 'Contact roles on a link',
    group: 'shared',
    appliesTo: BOTH,
    allowMultiple: true,
    values: ['Key relationship contact', 'Billing', 'Operational', 'Decision-maker or sponsor', 'Legal or compliance', 'Other'],
  },
  { key: 'contact_status', label: 'Contact status', group: 'shared', appliesTo: BOTH, values: ['Active', 'Left organisation', 'Do not contact', 'Unknown'] },
  {
    key: 'duplicate_status',
    label: 'Duplicate status',
    group: 'shared',
    appliesTo: BOTH,
    values: [
      { label: 'None', systemKey: 'none' },
      { label: 'Possible match', systemKey: 'possible_match', description: 'Flagged as possibly the same as another record' },
      { label: 'Confirmed duplicate', systemKey: 'confirmed_duplicate' },
      { label: 'Merged', systemKey: 'merged' },
    ],
  },
  {
    key: 'verification_status',
    label: 'Verification status',
    group: 'shared',
    appliesTo: BOTH,
    values: [
      { label: 'Not started', systemKey: 'not_started' },
      { label: 'In progress', systemKey: 'in_progress' },
      { label: 'Verified', systemKey: 'verified' },
      { label: 'Expired', systemKey: 'expired', description: 'Verification has lapsed and must be renewed' },
      { label: 'Not required', systemKey: 'not_required' },
    ],
  },
  { key: 'data_source', label: 'Data source', group: 'shared', appliesTo: BOTH, values: ['Manual entry', 'Import', 'Referral', 'Integration', 'Website enquiry'] },
  { key: 'contact_method', label: 'Contact method', group: 'shared', appliesTo: P, values: ['Email', 'Mobile call', 'Landline call', 'Text message', 'Post'] },
  { key: 'language', label: 'Language', group: 'shared', appliesTo: P, values: ['English', 'Welsh', 'Polish', 'Urdu', 'Arabic', 'Punjabi', 'Bengali', 'French', 'Spanish', 'Romanian'] },
  { key: 'address_type', label: 'Address type', group: 'shared', appliesTo: BOTH, values: ['Home', 'Work', 'Registered office', 'Correspondence', 'Billing', 'Previous'] },
  { key: 'phone_type', label: 'Phone type', group: 'shared', appliesTo: BOTH, values: ['Mobile', 'Direct', 'Work', 'Home', 'Switchboard'] },
  { key: 'email_type', label: 'Email type', group: 'shared', appliesTo: BOTH, values: ['Work', 'Personal', 'Billing', 'Other'] },
  {
    key: 'country',
    label: 'Country',
    group: 'shared',
    appliesTo: BOTH,
    values: ['United Kingdom', 'Ireland', 'Jersey', 'Guernsey', 'Isle of Man', 'France', 'Germany', 'Spain', 'Netherlands', 'Belgium', 'Italy', 'Poland', 'Switzerland', 'United States', 'Canada', 'Australia', 'United Arab Emirates', 'Singapore', 'Hong Kong'],
  },

  // ---------------- Taxonomy ----------------
  { key: 'relationship_standing', label: 'Relationship standing', group: 'taxonomy', appliesTo: BOTH, description: find(crm, 'Relationship Status').description, values: fromTaxonomy(find(crm, 'Relationship Status')) },
  { key: 'origin', label: 'Origin / source of relationship', group: 'taxonomy', appliesTo: BOTH, description: find(crm, 'Referrer / Source Type').description, values: fromTaxonomy(find(crm, 'Referrer / Source Type')) },
  { key: 'engagement_level', label: 'Engagement level', group: 'taxonomy', appliesTo: BOTH, description: find(crm, 'Engagement Level').description, values: fromTaxonomy(find(crm, 'Engagement Level')) },
  { key: 'pipeline_stage', label: 'Pipeline stage', group: 'taxonomy', appliesTo: O, description: find(crm, 'Pipeline Stage').description, values: fromTaxonomy(find(crm, 'Pipeline Stage')) },
  { key: 'sector', label: 'Client sector', group: 'taxonomy', appliesTo: O, description: find(cm, 'Client Sector').description, values: fromTaxonomy(find(cm, 'Client Sector')) },
  { key: 'client_tier', label: 'Client tier', group: 'taxonomy', appliesTo: O, description: find(cm, 'Client Tier').description, values: fromTaxonomy(find(cm, 'Client Tier')) },
  { key: 'risk_rating', label: 'Risk rating', group: 'taxonomy', appliesTo: O, description: find(cm, 'Risk Rating').description, values: fromTaxonomy(find(cm, 'Risk Rating')) },
  { key: 'contact_type', label: 'Contact type', group: 'taxonomy', appliesTo: BOTH, description: find(crm, 'Contact Type').description, values: fromTaxonomy(find(crm, 'Contact Type')) },

  // ---------------- Matters and documents (flat) ----------------
  {
    key: 'matter_status',
    label: 'Matter Status',
    group: 'matters',
    appliesTo: [],
    description: 'Operational status of a matter or engagement.',
    values: [
      { label: 'Prospective / Enquiry', systemKey: 'prospective' },
      { label: 'CMI incomplete', systemKey: 'cmi_incomplete' },
      { label: 'Active', systemKey: 'active' },
      { label: 'On Hold', systemKey: 'on_hold' },
      { label: 'Completed', systemKey: 'completed' },
      { label: 'Closed', systemKey: 'closed' },
      { label: 'Archived', systemKey: 'archived' },
      { label: 'Aborted / Lost', systemKey: 'aborted' },
    ],
  },
  { key: 'matter_type', label: 'Matter type', group: 'matters', appliesTo: [], description: find(cm, 'Matter Type').description, values: fromTaxonomy(find(cm, 'Matter Type')) },
  { key: 'billing_basis', label: 'Billing Basis', group: 'matters', appliesTo: [], description: find(cm, 'Billing Basis').description, values: fromTaxonomy(find(cm, 'Billing Basis')) },
  { key: 'matter_size', label: 'Matter size', group: 'matters', appliesTo: [], description: find(cm, 'Matter Size').description, values: fromTaxonomy(find(cm, 'Matter Size')) },
  {
    key: 'matter_party_role',
    label: 'Matter Parties',
    group: 'matters',
    appliesTo: [],
    allowMultiple: true,
    description: 'Two-field matter party taxonomy: Relationships, Capacities and Work type profiles.',
    values: [
      { label: 'Instructing client', description: 'The person or entity instructing the firm' },
      { label: 'Client representative', description: "The client's day-to-day contact" },
      { label: 'Decision-maker', description: 'Approves advice, expenditure or settlement' },
      { label: 'Opposing party', description: 'The other party in a dispute or transaction' },
      { label: 'Opposing solicitor', description: 'Represents the other party' },
      { label: 'Counterparty', description: 'Another party to a transaction' },
      { label: 'Barrister / counsel', description: 'Provides specialist legal advice or advocacy' },
      { label: 'Expert witness', description: 'Provides specialist evidence' },
      { label: 'Professional adviser', description: 'Accountant, tax adviser, financial adviser or similar' },
      { label: 'Witness', description: 'Provides evidence or factual information' },
      { label: 'Court / tribunal', description: 'A relevant judicial body' },
      { label: 'Regulator / public authority', description: 'A relevant regulatory or government body' },
      { label: 'Other party', description: 'Any other third party connected to the matter' },
      { label: 'Client contact', description: 'Day-to-day contact at the client organisation' },
    ],
  },
  {
    key: 'matter_employee_role',
    label: 'Employees',
    group: 'matters',
    appliesTo: [],
    description: 'Roles on a future matter team link. Never stored on the person.',
    values: [
      { label: 'Matter lead', description: 'Responsible for delivery of a matter' },
      { label: 'Matter team member', description: 'Assigned to work on a matter' },
      { label: 'Matter admin', description: 'Administrative support for a matter' },
    ],
  },

  // ---------------- Enquiries ----------------
  {
    key: 'enquiry_channel',
    label: 'Enquiry channel',
    group: 'enquiries',
    appliesTo: [],
    description: 'How the prospective client or referrer contacted the firm.',
    values: [
      { label: 'Phone', systemKey: 'phone' },
      { label: 'Email', systemKey: 'email' },
      { label: 'Web form', systemKey: 'web_form' },
      { label: 'Walk-in', systemKey: 'walk_in' },
      { label: 'Referral', systemKey: 'referral' },
      { label: 'Existing client', systemKey: 'existing_client' },
    ],
  },
  {
    key: 'enquiry_urgency',
    label: 'Enquiry urgency',
    group: 'enquiries',
    appliesTo: [],
    description: 'Determines the first-contact response time SLA.',
    values: [
      { label: 'Standard', systemKey: 'standard', description: 'End of the next working day' },
      { label: 'Urgent', systemKey: 'urgent', description: 'End of the same working day' },
      { label: 'Emergency', systemKey: 'emergency', description: 'Within 2 working hours' },
    ],
  },
  {
    key: 'enquiry_close_reason',
    label: 'Enquiry close reason',
    group: 'enquiries',
    appliesTo: [],
    description: 'Reason recorded when an enquiry is declined, referred out or closed without conversion.',
    values: [
      { label: 'Conflict', systemKey: 'conflict', description: 'Conflict of interest prevents the firm acting' },
      { label: 'Outside our expertise', systemKey: 'outside_expertise' },
      { label: 'Not commercially viable', systemKey: 'not_viable' },
      { label: 'Client went elsewhere', systemKey: 'went_elsewhere' },
      { label: 'No response', systemKey: 'no_response', description: 'Contact attempts exhausted with no reply' },
      { label: 'Referred out', systemKey: 'referred_out', description: 'Passed to another firm or specialist service' },
      { label: 'Other', systemKey: 'other' },
    ],
  },

  // ---------------- Tasks ----------------
  {
    key: 'task_type',
    label: 'Task type',
    group: 'tasks',
    appliesTo: [],
    description: 'Category of work item assigned to a person or team.',
    values: [
      { label: 'Call back', systemKey: 'call_back' },
      { label: 'Follow up', systemKey: 'follow_up' },
      { label: 'Send letter', systemKey: 'send_letter' },
      { label: 'Conflict check', systemKey: 'conflict_check' },
      { label: 'Review', systemKey: 'review' },
      { label: 'Complete matter opening', systemKey: 'complete_matter_opening' },
      { label: 'General', systemKey: 'general' },
    ],
  },
  {
    key: 'task_priority',
    label: 'Task priority',
    group: 'tasks',
    appliesTo: [],
    description: 'Priority level for tasks.',
    values: [
      { label: 'Low', systemKey: 'low' },
      { label: 'Normal', systemKey: 'normal' },
      { label: 'High', systemKey: 'high' },
      { label: 'Urgent', systemKey: 'urgent' },
    ],
  },
  {
    key: 'task_status',
    label: 'Task status',
    group: 'tasks',
    appliesTo: [],
    description: 'Lifecycle status of a task.',
    values: [
      { label: 'To do', systemKey: 'todo' },
      { label: 'In progress', systemKey: 'in_progress' },
      { label: 'Waiting', systemKey: 'waiting' },
      { label: 'Done', systemKey: 'done' },
      { label: 'Cancelled', systemKey: 'cancelled' },
    ],
  },
];

interface HierSeed {
  key: string;
  label: string;
  group?: ListGroup;
  description?: string;
  parents: { label: string; description?: string; meta?: Record<string, string>; children: Seed[] }[];
}

function defaultWorkTypeAmlScope(practiceArea: string, subcategoryName?: string, badge?: string): 'true' | 'false' {
  const pa = practiceArea.toLowerCase();
  const sub = (subcategoryName ?? '').toLowerCase();
  const b = (badge ?? '').toLowerCase();
  if (b.includes('litigation') || b.includes('adr') || b.includes('enforcement') || sub.includes('tribunal')) {
    return 'false';
  }
  if (
    pa.includes('real estate') ||
    pa.includes('property') ||
    pa.includes('corporate') ||
    pa.includes('private client') ||
    pa.includes('finance') ||
    pa.includes('banking')
  ) {
    return 'true';
  }
  return 'false';
}

function defaultWorkTypeThreshold(practiceArea: string): string {
  const pa = practiceArea.toLowerCase();
  if (pa.includes('real estate') || pa.includes('property') || pa.includes('corporate') || pa.includes('finance')) {
    return '250000';
  }
  if (pa.includes('private client')) {
    return '100000';
  }
  return '25000';
}

const HIERARCHIES: HierSeed[] = [
  {
    key: 'work_type',
    label: 'Worktype / Matters',
    group: 'matters',
    description: 'Practice area → sub-category',
    parents: taxonomy.workType.map((w) => ({
      label: w.practiceArea,
      meta: {
        amlInScope: defaultWorkTypeAmlScope(w.practiceArea),
        clientMoneyThresholdGbp: defaultWorkTypeThreshold(w.practiceArea),
      },
      children: w.subcategories.map((s) => ({
        label: s.name,
        meta: {
          badge: s.badge,
          amlInScope: defaultWorkTypeAmlScope(w.practiceArea, s.name, s.badge),
          clientMoneyThresholdGbp: defaultWorkTypeThreshold(w.practiceArea),
        },
      })),
    })),
  },
  {
    key: 'document_type',
    label: 'Document type',
    group: 'documents',
    description: 'Category → document type',
    parents: taxonomy.documentType.map((d) => ({
      label: d.category,
      children: d.documentTypes.map((t) => ({ label: t.name, description: t.description })),
    })),
  },
  {
    key: 'jurisdiction',
    label: 'Jurisdiction',
    group: 'matters',
    description: 'Group → legal system',
    parents: taxonomy.jurisdiction.map((j) => ({
      label: j.group,
      children: j.systems.map((s) => ({ label: s.name, description: s.notes })),
    })),
  },
  {
    key: 'matter_stage',
    label: 'Matter stage',
    group: 'matters',
    description: 'Stage → milestone',
    parents: taxonomy.matterStage.map((s) => ({
      label: s.stage,
      description: s.description,
      children: s.milestones.map((m) => ({ label: m.name, description: m.description, meta: { code: m.code } })),
    })),
  },
  {
    key: 'audience',
    label: 'Audience',
    group: 'documents',
    description: 'Group → audience type',
    parents: taxonomy.audience.map((a) => ({
      label: a.group,
      children: a.types.map((t) => ({ label: t.name, description: t.notes })),
    })),
  },
];

const MATTERS_GROUP_ORDER = [
  'work_type',
  'matter_type',
  'matter_status',
  'matter_party_role',
  'matter_employee_role',
  'matter_stage',
  'matter_size',
  'billing_basis',
  'jurisdiction',
];

const DOCUMENTS_GROUP_ORDER = ['document_type', 'audience'];

function toValue(listKey: string, seed: Seed, sortOrder: number, parentId: string | null = null, idPrefix = ''): ChoiceValue {
  const s = typeof seed === 'string' ? { label: seed } : seed;
  const v: ChoiceValue = {
    id: vid(listKey, idPrefix + s.label),
    listKey,
    label: s.label,
    sortOrder,
    active: true,
    parentId,
  };
  if (s.description) v.description = s.description;
  if (s.guidance) v.guidance = s.guidance;
  if (s.systemKey) v.systemKey = s.systemKey;
  if (s.meta) v.meta = s.meta;
  return v;
}

const ADDITIONAL_MATTER_STAGE_GROUPS: {
  label: string;
  description?: string;
  stages: string[];
}[] = [
  {
    label: 'Civil litigation (multi-track)',
    stages: [
      'Pre-action',
      'Issue and statements of case',
      'CMC and directions',
      'Disclosure',
      'Witness statements',
      'Expert evidence',
      'Pre-trial review',
      'Trial preparation',
      'Trial',
      'Judgment, costs and enforcement',
      'Appeal',
    ],
  },
  {
    label: 'Employment tribunal claim',
    stages: [
      'ACAS early conciliation',
      'ET1 / ET3',
      'Preliminary hearing',
      'Disclosure and bundle',
      'Witness statements',
      'Final hearing',
      'Remedy hearing',
      'Reconsideration / EAT appeal',
    ],
  },
  {
    label: 'Family – financial remedies',
    stages: [
      'Initial advice',
      'Voluntary disclosure',
      'Negotiation / mediation / arbitration',
      'MIAM',
      'Form A issued',
      'Form E exchange',
      'First Appointment',
      'FDR',
      'Final hearing',
      'Consent order drafted and approved',
      'Implementation (pension sharing, transfers, sale)',
    ],
  },
  {
    label: 'Residential conveyancing – purchase',
    stages: [
      'Onboarding, ID/AML and source of funds',
      'Pre-exchange',
      'Ready to exchange',
      'Exchanged',
      'Pre-completion',
      'Completed',
      'Post-completion (SDLT/LTT return, discharge, registration)',
      'Registration complete',
    ],
  },
  {
    label: 'Probate and estate administration',
    stages: [
      'Initial instruction',
      'Identify assets and liabilities',
      'Valuations',
      'Inheritance tax account and payment',
      'Grant application',
      'Collect assets and pay liabilities',
      'Interim distribution',
      'Estate accounts and clearance',
      'Final distribution',
    ],
  },
  {
    label: 'Corporate M&A – share purchase (buy-side)',
    stages: [
      'Heads of terms and engagement',
      'Due diligence',
      'SPA, disclosure letter and ancillaries',
      'Signing / exchange',
      'Satisfying conditions',
      'Completion',
      'Post-completion',
    ],
  },
  {
    label: 'Debt recovery',
    stages: [
      'Letter before action',
      'Claim issued',
      'Judgment obtained',
      'Enforcement',
    ],
  },
  {
    label: 'Advisory / non-contentious advice',
    stages: [
      'Instructed',
      'Advising',
      'Advice delivered',
    ],
  },
];

export function buildSeedLists(): { lists: ChoiceList[]; values: ChoiceValue[] } {
  const lists: ChoiceList[] = [];
  const values: ChoiceValue[] = [];

  for (const l of FLAT_LISTS) {
    const list: ChoiceList = {
      key: l.key,
      label: l.label,
      group: l.group,
      appliesTo: l.appliesTo,
      allowMultiple: !!l.allowMultiple,
      hierarchical: false,
    };
    if (l.description) list.description = l.description;
    lists.push(list);
    l.values.forEach((v, i) => values.push(toValue(l.key, v, i + 1)));
  }

  values.push({
    id: 'matter_stage_group.default_group',
    listKey: 'matter_stage_group',
    label: 'Default Group',
    description: 'Standard firm-wide matter stage and milestone framework',
    sortOrder: 1,
    active: true,
    parentId: null,
    systemKey: 'default_group',
  });

  for (const h of HIERARCHIES) {
    const list: ChoiceList = { key: h.key, label: h.label, group: h.group ?? 'matters', appliesTo: [], allowMultiple: false, hierarchical: true };
    if (h.description) list.description = h.description;
    lists.push(list);
    h.parents.forEach((p, i) => {
      const parent = toValue(
        h.key,
        {
          label: p.label,
          description: p.description,
          meta:
            h.key === 'matter_stage'
              ? { stageGroupId: 'matter_stage_group.default_group' }
              : p.meta,
        },
        i + 1,
      );
      values.push(parent);
      p.children.forEach((c, j) => {
        // Child ids include the parent slug so duplicate names across parents stay unique.
        values.push(toValue(h.key, c, j + 1, parent.id, slug(p.label) + ' '));
      });
    });
  }

  ADDITIONAL_MATTER_STAGE_GROUPS.forEach((grp, gIdx) => {
    const groupId = vid('matter_stage_group', grp.label);
    values.push({
      id: groupId,
      listKey: 'matter_stage_group',
      label: grp.label,
      description: grp.description,
      sortOrder: gIdx + 2,
      active: true,
      parentId: null,
    });
    grp.stages.forEach((stageLabel, sIdx) => {
      values.push(
        toValue(
          'matter_stage',
          {
            label: stageLabel,
            meta: { stageGroupId: groupId },
          },
          sIdx + 1,
          null,
          slug(grp.label) + ' ',
        ),
      );
    });
  });

  // Sort the 'matters' and 'documents' group lists in the canonical taxonomy order
  lists.sort((a, b) => {
    if (a.group === 'matters' && b.group === 'matters') {
      const idxA = MATTERS_GROUP_ORDER.indexOf(a.key);
      const idxB = MATTERS_GROUP_ORDER.indexOf(b.key);
      return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
    }
    if (a.group === 'documents' && b.group === 'documents') {
      const idxA = DOCUMENTS_GROUP_ORDER.indexOf(a.key);
      const idxB = DOCUMENTS_GROUP_ORDER.indexOf(b.key);
      return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
    }
    return 0;
  });

  // Sanity: unique ids
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v.id)) throw new Error(`Duplicate seed value id ${v.id}`);
    seen.add(v.id);
  }
  return { lists, values };
}
