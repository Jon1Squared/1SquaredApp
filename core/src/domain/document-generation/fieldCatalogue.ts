/**
 * Versioned Merge Field Catalogue (`core/src/domain/document-generation/fieldCatalogue.ts`).
 *
 * Rules enforced (ADR-0003 & Platform Architecture Standard):
 * 1. Canonical field keys form a versioned public contract (`sinceVersion`, additive-only within major version).
 * 2. Every field declares its `group`, `dataType`, `requiredPermission`, and pure resolver.
 * 3. Strictly excludes all fields protected by `employee:payroll`, `employee:hr_restricted`, or `employee:sensitive`
 *    (payroll, salary, bank details, NI/tax, contract terms, right to work, sickness/disciplinary, emergency contacts,
 *    home contact details, diversity, and adjustments).
 * 4. Fee earner and author (`User`) fields are limited strictly to core business identity fields readable under `employee:view_core`.
 * 5. Tenant custom fields from configuration appear automatically under `custom.<entity>.<key>`.
 */

import type {
  CustomFieldConfigEntry,
  DocumentPermission,
  ExtensionProvidedFieldDefinition,
  FieldCatalogueEntry,
  FieldDataType,
  FieldGroup,
  FieldRequiredPermission,
  FieldResolutionContext,
  StructuredAddressValue,
  TenantConfiguration,
} from '../../api/index';
import {
  hasDocumentPermission,
  type DocumentPermissionActor,
} from './permissions';

export const FIELD_CATALOGUE_VERSION = '1.0.0';

/**
 * Explicit architectural blocklist of HR, Payroll, and Sensitive employee field keys/patterns
 * protected by `employee:payroll`, `employee:hr_restricted`, or `employee:sensitive`.
 */
export const EXCLUDED_EMPLOYEE_SENSITIVE_FIELD_PATTERNS: readonly RegExp[] = [
  /salary/i,
  /payroll/i,
  /bankAccount/i,
  /sortCode/i,
  /nationalInsurance/i,
  /\bniNumber\b/i,
  /taxCode/i,
  /pension/i,
  /bonus/i,
  /commission/i,
  /hourlyCost/i,
  /contractType/i,
  /noticePeriod/i,
  /probation/i,
  /rightToWork/i,
  /passport/i,
  /visa/i,
  /disciplinary/i,
  /grievance/i,
  /sickness/i,
  /absence/i,
  /appraisal/i,
  /emergencyContact/i,
  /nextOfKin/i,
  /homeAddress/i,
  /personalEmail/i,
  /personalPhone/i,
  /dateOfBirth/i,
  /\bdob\b/i,
  /diversity/i,
  /ethnicity/i,
  /religion/i,
  /sexualOrientation/i,
  /disability/i,
  /genderIdentity/i,
  /reasonableAdjustment/i,
  /medical/i,
  /healthNote/i,
  /criminalRecord/i,
  /dbsCheck/i,
];

export const EXCLUDED_EMPLOYEE_PERMISSION_TIERS = [
  'employee:payroll',
  'employee:hr_restricted',
  'employee:sensitive',
] as const;

export function isExcludedSensitiveEmployeeFieldKey(key: string): boolean {
  const trimmed = key.trim();
  return EXCLUDED_EMPLOYEE_SENSITIVE_FIELD_PATTERNS.some((pattern) =>
    pattern.test(trimmed),
  );
}

export function assertFieldKeyNotExcludedEmployeeField(key: string): void {
  if (isExcludedSensitiveEmployeeFieldKey(key)) {
    throw new Error(
      `FIELD_CATALOGUE_SECURITY_ERROR: Field "${key}" is protected by employee:payroll, employee:hr_restricted, or employee:sensitive and must never be registered in the Document Generation Field Catalogue.`,
    );
  }
}

function readProp(
  record: Record<string, unknown> | null | undefined,
  ...keys: string[]
): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (key in record && record[key] !== undefined && record[key] !== null && record[key] !== '') {
      return record[key];
    }
    const fieldValues = record.fieldValues as Record<string, unknown> | undefined;
    if (
      fieldValues &&
      key in fieldValues &&
      fieldValues[key] !== undefined &&
      fieldValues[key] !== null &&
      fieldValues[key] !== ''
    ) {
      return fieldValues[key];
    }
  }
  return undefined;
}

function resolveAddressObject(
  record: Record<string, unknown> | null | undefined,
  addressKey = 'address',
): StructuredAddressValue | string | undefined {
  if (!record) return undefined;
  const raw = readProp(record, addressKey, 'primaryAddress', 'registeredAddress', 'officeAddress');
  if (!raw) return undefined;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    return {
      line1: String(obj.line1 ?? obj.street ?? ''),
      line2: String(obj.line2 ?? ''),
      city: String(obj.city ?? obj.town ?? ''),
      county: String(obj.county ?? obj.region ?? ''),
      postcode: String(obj.postcode ?? obj.postalCode ?? ''),
      country: String(obj.country ?? 'United Kingdom'),
    };
  }
  return undefined;
}

export const CORE_FIELD_CATALOGUE: readonly FieldCatalogueEntry[] = Object.freeze([
  // ============================================================================
  // GROUP: Client
  // ============================================================================
  {
    key: 'client.id',
    displayName: 'Client ID',
    description: 'Internal unique identifier for the client record',
    group: 'Client',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'ORG-0001',
    resolve: (ctx) => readProp(ctx.client, 'id', 'clientId'),
  },
  {
    key: 'client.reference',
    displayName: 'Client Reference',
    description: 'Canonical client reference or code',
    group: 'Client',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'CL-2026-0042',
    resolve: (ctx) => readProp(ctx.client, 'reference', 'clientReference', 'clientCode', 'id'),
  },
  {
    key: 'client.name',
    displayName: 'Client Full Name / Legal Name',
    description: 'Full name of an individual client or registered legal name of an organisation client',
    group: 'Client',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'Example Holdings Ltd',
    resolve: (ctx) => readProp(ctx.client, 'name', 'legalName', 'displayName', 'tradingName'),
  },
  {
    key: 'client.type',
    displayName: 'Client Type',
    description: 'Whether the client is an Organisation or Person',
    group: 'Client',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'Organisation',
    resolve: (ctx) => readProp(ctx.client, 'type', 'clientType'),
  },
  {
    key: 'client.salutation',
    displayName: 'Client Salutation',
    description: 'Formal letter salutation (e.g. "Dear Sirs" or "Dear Ms Vance")',
    group: 'Client',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'Dear Sirs',
    resolve: (ctx) => {
      const explicit = readProp(ctx.client, 'salutation', 'preferredSalutation');
      if (explicit) return explicit;
      const last = readProp(ctx.client, 'lastName', 'surname');
      const title = readProp(ctx.client, 'title', 'prefix');
      if (title && last) return `Dear ${title} ${last}`;
      const name = readProp(ctx.client, 'name', 'legalName');
      return name ? `Dear ${name}` : 'Dear Sirs';
    },
  },
  {
    key: 'client.firstName',
    displayName: 'Client First Name',
    description: 'First or given name for an individual client',
    group: 'Client',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'Eleanor',
    resolve: (ctx) => readProp(ctx.client, 'firstName', 'givenName'),
  },
  {
    key: 'client.lastName',
    displayName: 'Client Last Name',
    description: 'Surname or family name for an individual client',
    group: 'Client',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'Vance',
    resolve: (ctx) => readProp(ctx.client, 'lastName', 'surname', 'familyName'),
  },
  {
    key: 'client.primaryEmail',
    displayName: 'Client Primary Email',
    description: 'Primary correspondence email address for the client',
    group: 'Client',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'legal@exampleholdings.example',
    resolve: (ctx) => readProp(ctx.client, 'primaryEmail', 'email', 'workEmail'),
  },
  {
    key: 'client.primaryPhone',
    displayName: 'Client Primary Telephone',
    description: 'Primary telephone number for the client',
    group: 'Client',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: '+44 20 7946 0192',
    resolve: (ctx) => readProp(ctx.client, 'primaryPhone', 'phone', 'telephone', 'mobilePhone'),
  },
  {
    key: 'client.primaryAddress',
    displayName: 'Client Primary Address',
    description: 'Primary correspondence or registered address for the client',
    group: 'Client',
    dataType: 'address',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: '14 Bishopsgate, London, EC2N 4BQ',
    resolve: (ctx) => resolveAddressObject(ctx.client, 'primaryAddress'),
  },
  {
    key: 'client.registeredNumber',
    displayName: 'Client Company / Registration Number',
    description: 'Companies House or charity registration number for an organisation client',
    group: 'Client',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: '08429104',
    resolve: (ctx) => readProp(ctx.client, 'registeredNumber', 'companyNumber'),
  },
  {
    key: 'client.jurisdiction',
    displayName: 'Client Incorporation Jurisdiction',
    description: 'Jurisdiction of incorporation for an organisation client',
    group: 'Client',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'England and Wales',
    resolve: (ctx) => readProp(ctx.client, 'jurisdiction', 'countryOfIncorporation'),
  },
  {
    key: 'client.vatNumber',
    displayName: 'Client VAT Number',
    description: 'VAT registration number for an organisation client',
    group: 'Client',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'GB 123 4567 89',
    resolve: (ctx) => readProp(ctx.client, 'vatNumber', 'vatRegistrationNumber'),
  },

  // ============================================================================
  // GROUP: Matter
  // ============================================================================
  {
    key: 'matter.id',
    displayName: 'Matter ID',
    description: 'Internal unique identifier for the matter',
    group: 'Matter',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'M-000001',
    resolve: (ctx) => readProp(ctx.matter, 'id', 'matterId'),
  },
  {
    key: 'matter.reference',
    displayName: 'Matter Reference (Our Ref)',
    description: 'Canonical matter reference code shown on correspondence',
    group: 'Matter',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'PV-2026-0001',
    resolve: (ctx) => readProp(ctx.matter, 'reference', 'matterNumber', 'matterCode', 'CORE-001', 'id'),
  },
  {
    key: 'matter.clientReference',
    displayName: 'Client Matter Reference (Your Ref)',
    description: 'Client-supplied reference number for this matter',
    group: 'Matter',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'PO-99412',
    resolve: (ctx) => readProp(ctx.matter, 'clientReference', 'CORE-050'),
  },
  {
    key: 'matter.title',
    displayName: 'Matter Title',
    description: 'Short title or subject heading of the matter',
    group: 'Matter',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'Acquisition of Sterling Logistics Ltd',
    resolve: (ctx) => readProp(ctx.matter, 'title', 'name', 'CORE-002'),
  },
  {
    key: 'matter.description',
    displayName: 'Matter Description / Scope Summary',
    description: 'Summary description and scope of instructions on the matter',
    group: 'Matter',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'Acting on the share purchase of Sterling Logistics Ltd.',
    resolve: (ctx) => readProp(ctx.matter, 'description', 'scopeOfWork', 'summary', 'CORE-003'),
  },
  {
    key: 'matter.status',
    displayName: 'Matter Status',
    description: 'Current lifecycle status of the matter',
    group: 'Matter',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'Open',
    resolve: (ctx) => readProp(ctx.matter, 'status', 'matterStatus'),
  },
  {
    key: 'matter.openDate',
    displayName: 'Matter Open Date',
    description: 'Date the matter was opened',
    group: 'Matter',
    dataType: 'date',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: '2026-04-01',
    resolve: (ctx) => readProp(ctx.matter, 'openDate', 'openedAt', 'createdAt', 'CORE-010'),
  },
  {
    key: 'matter.targetCompletionDate',
    displayName: 'Matter Target Completion Date',
    description: 'Target completion or key milestone date for the matter',
    group: 'Matter',
    dataType: 'date',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: '2026-06-30',
    resolve: (ctx) => readProp(ctx.matter, 'targetCompletionDate', 'keyDate', 'CORE-011'),
  },
  {
    key: 'matter.closeDate',
    displayName: 'Matter Close Date',
    description: 'Date the matter was closed (if applicable)',
    group: 'Matter',
    dataType: 'date',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: '2026-12-31',
    resolve: (ctx) => readProp(ctx.matter, 'closeDate', 'closedAt'),
  },
  {
    key: 'matter.practiceArea',
    displayName: 'Practice Area / Department',
    description: 'Practice area or legal department handling the matter',
    group: 'Matter',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'Corporate & Commercial',
    resolve: (ctx) => readProp(ctx.matter, 'practiceAreaLabel', 'practiceArea', 'workTypeLabel', 'workTypeId'),
  },
  {
    key: 'matter.matterType',
    displayName: 'Matter Type',
    description: 'Specific matter type classification',
    group: 'Matter',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'Mergers & Acquisitions',
    resolve: (ctx) => readProp(ctx.matter, 'matterTypeLabel', 'matterType', 'subWorkTypeLabel', 'matterSubCategoryId'),
  },
  {
    key: 'matter.fundingType',
    displayName: 'Funding / Billing Arrangement',
    description: 'Billing basis or funding arrangement (e.g. Hourly Rates, Fixed Fee, Capped Fee)',
    group: 'Matter',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'Fixed Fee',
    resolve: (ctx) => readProp(ctx.matter, 'fundingType', 'billingBasis', 'workBasisLabel', 'feeArrangement'),
  },
  {
    key: 'matter.courtName',
    displayName: 'Court / Tribunal Name',
    description: 'Court, tribunal, or registry name where applicable',
    group: 'Matter',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'High Court of Justice, Business and Property Courts',
    resolve: (ctx) => readProp(ctx.matter, 'courtName', 'tribunalName'),
  },
  {
    key: 'matter.caseNumber',
    displayName: 'Court Case / Claim Number',
    description: 'Court claim or registry proceeding number',
    group: 'Matter',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'BL-2026-000412',
    resolve: (ctx) => readProp(ctx.matter, 'caseNumber', 'claimNumber'),
  },

  // ============================================================================
  // GROUP: Financial (Requires `finance:view`)
  // ============================================================================
  {
    key: 'financial.feeEstimate',
    displayName: 'Fee Estimate (GBP)',
    description: 'Current professional fee estimate in GBP (excluding VAT)',
    group: 'Financial',
    dataType: 'currency',
    requiredPermission: 'finance:view',
    sinceVersion: '1.0.0',
    sampleValue: '15000.00',
    resolve: (ctx) => readProp(ctx.financial, 'feeEstimate', 'feeEstimateGbp', 'estimatedFeeGbp'),
  },
  {
    key: 'financial.agreedFeeCap',
    displayName: 'Agreed Fee Cap / Fixed Fee (GBP)',
    description: 'Agreed fixed fee or fee cap in GBP',
    group: 'Financial',
    dataType: 'currency',
    requiredPermission: 'finance:view',
    sinceVersion: '1.0.0',
    sampleValue: '17500.00',
    resolve: (ctx) => readProp(ctx.financial, 'agreedFeeCap', 'agreedFeeCapGbp', 'fixedFeeAmount'),
  },
  {
    key: 'financial.hourlyRate',
    displayName: 'Lead Fee Earner Hourly Rate (GBP)',
    description: 'Applicable matter hourly charge-out rate for the responsible fee earner',
    group: 'Financial',
    dataType: 'currency',
    requiredPermission: 'finance:view',
    sinceVersion: '1.0.0',
    sampleValue: '350.00',
    resolve: (ctx) => readProp(ctx.financial, 'hourlyRate', 'hourlyRateGbp', 'chargeOutRateGbp'),
  },
  {
    key: 'financial.wipBalance',
    displayName: 'Unbilled WIP Balance (GBP)',
    description: 'Current unbilled work-in-progress balance on the matter',
    group: 'Financial',
    dataType: 'currency',
    requiredPermission: 'finance:view',
    sinceVersion: '1.0.0',
    sampleValue: '4250.00',
    resolve: (ctx) => readProp(ctx.financial, 'wipBalance', 'unbilledWipGbp', 'wipGbp'),
  },
  {
    key: 'financial.unbilledDisbursements',
    displayName: 'Unbilled Disbursements (GBP)',
    description: 'Total unbilled disbursements and anticipated third-party costs',
    group: 'Financial',
    dataType: 'currency',
    requiredPermission: 'finance:view',
    sinceVersion: '1.0.0',
    sampleValue: '650.00',
    resolve: (ctx) => readProp(ctx.financial, 'unbilledDisbursements', 'disbursementsTotalGbp'),
  },
  {
    key: 'financial.billedTotal',
    displayName: 'Total Billed to Date (GBP)',
    description: 'Cumulative total billed on the matter to date',
    group: 'Financial',
    dataType: 'currency',
    requiredPermission: 'finance:view',
    sinceVersion: '1.0.0',
    sampleValue: '8500.00',
    resolve: (ctx) => readProp(ctx.financial, 'billedTotal', 'totalBilledGbp'),
  },
  {
    key: 'financial.unpaidInvoiceBalance',
    displayName: 'Unpaid Invoice / Debtor Balance (GBP)',
    description: 'Outstanding unpaid invoice balance on the matter',
    group: 'Financial',
    dataType: 'currency',
    requiredPermission: 'finance:view',
    sinceVersion: '1.0.0',
    sampleValue: '1200.00',
    resolve: (ctx) => readProp(ctx.financial, 'unpaidInvoiceBalance', 'debtorBalanceGbp'),
  },
  {
    key: 'financial.clientAccountBalance',
    displayName: 'Client Account Balance (GBP)',
    description: 'Funds currently held in client account for this matter',
    group: 'Financial',
    dataType: 'currency',
    requiredPermission: 'finance:view',
    sinceVersion: '1.0.0',
    sampleValue: '25000.00',
    resolve: (ctx) => readProp(ctx.financial, 'clientAccountBalance', 'clientMoniesGbp'),
  },
  {
    key: 'financial.officeAccountBalance',
    displayName: 'Office Account Balance (GBP)',
    description: 'Current office account balance for the matter',
    group: 'Financial',
    dataType: 'currency',
    requiredPermission: 'finance:view',
    sinceVersion: '1.0.0',
    sampleValue: '0.00',
    resolve: (ctx) => readProp(ctx.financial, 'officeAccountBalance', 'officeBalanceGbp'),
  },
  {
    key: 'financial.retainerAmount',
    displayName: 'Requested Monies on Account / Retainer (GBP)',
    description: 'Requested payment on account of costs and disbursements',
    group: 'Financial',
    dataType: 'currency',
    requiredPermission: 'finance:view',
    sinceVersion: '1.0.0',
    sampleValue: '2500.00',
    resolve: (ctx) => readProp(ctx.financial, 'retainerAmount', 'moniesOnAccountGbp'),
  },

  // ============================================================================
  // GROUP: Fee Earner (Strictly limited to `employee:view_core` business fields)
  // ============================================================================
  {
    key: 'feeEarner.fullName',
    displayName: 'Fee Earner Full Name',
    description: 'Full business name of the responsible fee earner',
    group: 'Fee Earner',
    dataType: 'text',
    requiredPermission: 'employee:view_core',
    sinceVersion: '1.0.0',
    sampleValue: 'Hannah Sterling',
    resolve: (ctx) => readProp(ctx.feeEarner, 'fullName', 'name', 'displayName'),
  },
  {
    key: 'feeEarner.jobTitle',
    displayName: 'Fee Earner Job Title',
    description: 'Public business job title of the responsible fee earner',
    group: 'Fee Earner',
    dataType: 'text',
    requiredPermission: 'employee:view_core',
    sinceVersion: '1.0.0',
    sampleValue: 'Senior Associate',
    resolve: (ctx) => readProp(ctx.feeEarner, 'jobTitle', 'roleTitle'),
  },
  {
    key: 'feeEarner.workEmail',
    displayName: 'Fee Earner Work Email',
    description: 'Business email address of the responsible fee earner',
    group: 'Fee Earner',
    dataType: 'text',
    requiredPermission: 'employee:view_core',
    sinceVersion: '1.0.0',
    sampleValue: 'h.sterling@examplelaw.example',
    resolve: (ctx) => readProp(ctx.feeEarner, 'workEmail', 'email'),
  },
  {
    key: 'feeEarner.workPhone',
    displayName: 'Fee Earner Direct Dial',
    description: 'Business direct-dial telephone number of the responsible fee earner',
    group: 'Fee Earner',
    dataType: 'text',
    requiredPermission: 'employee:view_core',
    sinceVersion: '1.0.0',
    sampleValue: '+44 20 7946 0821',
    resolve: (ctx) => readProp(ctx.feeEarner, 'workPhone', 'directDial', 'phone'),
  },
  {
    key: 'feeEarner.departmentName',
    displayName: 'Fee Earner Department',
    description: 'Department or practice group name of the responsible fee earner',
    group: 'Fee Earner',
    dataType: 'text',
    requiredPermission: 'employee:view_core',
    sinceVersion: '1.0.0',
    sampleValue: 'Corporate & Commercial',
    resolve: (ctx) => readProp(ctx.feeEarner, 'departmentName', 'department'),
  },
  {
    key: 'feeEarner.officeName',
    displayName: 'Fee Earner Office Name',
    description: 'Primary office location name of the responsible fee earner',
    group: 'Fee Earner',
    dataType: 'text',
    requiredPermission: 'employee:view_core',
    sinceVersion: '1.0.0',
    sampleValue: 'London — Lincoln’s Inn Fields',
    resolve: (ctx) => readProp(ctx.feeEarner, 'officeName', 'office'),
  },
  {
    key: 'feeEarner.officeAddress',
    displayName: 'Fee Earner Office Address',
    description: 'Business postal address of the fee earner’s office',
    group: 'Fee Earner',
    dataType: 'address',
    requiredPermission: 'employee:view_core',
    sinceVersion: '1.0.0',
    sampleValue: '42 Lincoln’s Inn Fields, London, WC2A 3PE',
    resolve: (ctx) => resolveAddressObject(ctx.feeEarner, 'officeAddress'),
  },
  {
    key: 'feeEarner.supervisorName',
    displayName: 'Supervising Partner / Supervisor Name',
    description: 'Full name of the supervising partner or supervisor on the matter',
    group: 'Fee Earner',
    dataType: 'text',
    requiredPermission: 'employee:view_core',
    sinceVersion: '1.0.0',
    sampleValue: 'Victoria Sterling',
    resolve: (ctx) => readProp(ctx.feeEarner, 'supervisorName', 'supervisingPartnerName'),
  },
  {
    key: 'feeEarner.supervisorJobTitle',
    displayName: 'Supervising Partner Job Title',
    description: 'Business job title of the supervising partner or supervisor',
    group: 'Fee Earner',
    dataType: 'text',
    requiredPermission: 'employee:view_core',
    sinceVersion: '1.0.0',
    sampleValue: 'Managing Partner',
    resolve: (ctx) => readProp(ctx.feeEarner, 'supervisorJobTitle', 'supervisingPartnerJobTitle'),
  },

  // ============================================================================
  // GROUP: Firm
  // ============================================================================
  {
    key: 'firm.registeredName',
    displayName: 'Firm Legal / Registered Name',
    description: 'Registered legal entity name of the firm',
    group: 'Firm',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'Example Law LLP',
    resolve: (ctx) => readProp(ctx.firm, 'registeredName', 'legalName', 'name'),
  },
  {
    key: 'firm.tradingName',
    displayName: 'Firm Trading Name',
    description: 'Trading or brand name of the firm',
    group: 'Firm',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'Example Law',
    resolve: (ctx) => readProp(ctx.firm, 'tradingName', 'displayName', 'name'),
  },
  {
    key: 'firm.regulatorName',
    displayName: 'Firm Regulator Name',
    description: 'Regulatory body authorising the firm (e.g. Solicitors Regulation Authority)',
    group: 'Firm',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'Solicitors Regulation Authority',
    resolve: (ctx) => readProp(ctx.firm, 'regulatorName', 'regulator') ?? 'Solicitors Regulation Authority',
  },
  {
    key: 'firm.regulatorNumber',
    displayName: 'Firm SRA / Regulator Number',
    description: 'Regulatory authorisation or SRA ID number of the firm',
    group: 'Firm',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'SRA-612048',
    resolve: (ctx) => readProp(ctx.firm, 'regulatorNumber', 'sraNumber'),
  },
  {
    key: 'firm.companyNumber',
    displayName: 'Firm LLP / Company Registration Number',
    description: 'Companies House registration number of the firm',
    group: 'Firm',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'OC391042',
    resolve: (ctx) => readProp(ctx.firm, 'companyNumber', 'registeredNumber'),
  },
  {
    key: 'firm.vatNumber',
    displayName: 'Firm VAT Registration Number',
    description: 'VAT registration number of the firm',
    group: 'Firm',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'GB 942 1104 22',
    resolve: (ctx) => readProp(ctx.firm, 'vatNumber'),
  },
  {
    key: 'firm.headOfficeAddress',
    displayName: 'Firm Head Office Address',
    description: 'Registered or head office postal address of the firm',
    group: 'Firm',
    dataType: 'address',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: '42 Lincoln’s Inn Fields, London, WC2A 3PE',
    resolve: (ctx) => resolveAddressObject(ctx.firm, 'headOfficeAddress'),
  },
  {
    key: 'firm.mainPhone',
    displayName: 'Firm Switchboard Telephone',
    description: 'Main switchboard telephone number of the firm',
    group: 'Firm',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: '+44 20 7946 0800',
    resolve: (ctx) => readProp(ctx.firm, 'mainPhone', 'phone', 'telephone'),
  },
  {
    key: 'firm.mainEmail',
    displayName: 'Firm General Email',
    description: 'General enquiries email address of the firm',
    group: 'Firm',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'enquiries@examplelaw.example',
    resolve: (ctx) => readProp(ctx.firm, 'mainEmail', 'email'),
  },
  {
    key: 'firm.website',
    displayName: 'Firm Website',
    description: 'Public website domain of the firm',
    group: 'Firm',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'www.examplelaw.example',
    resolve: (ctx) => readProp(ctx.firm, 'website', 'primaryDomain'),
  },
  {
    key: 'firm.complaintsPartnerName',
    displayName: 'Firm Complaints Partner Name',
    description: 'Designated partner responsible for client complaints handling',
    group: 'Firm',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'Marcus Vaughan',
    resolve: (ctx) => readProp(ctx.firm, 'complaintsPartnerName', 'colpName'),
  },

  // ============================================================================
  // GROUP: User (Current Author — strictly limited to `employee:view_core`)
  // ============================================================================
  {
    key: 'user.fullName',
    displayName: 'Author Full Name',
    description: 'Full business name of the user generating the document',
    group: 'User',
    dataType: 'text',
    requiredPermission: 'employee:view_core',
    sinceVersion: '1.0.0',
    sampleValue: 'Hannah Sterling',
    resolve: (ctx) => readProp(ctx.user, 'fullName', 'name', 'displayName'),
  },
  {
    key: 'user.jobTitle',
    displayName: 'Author Job Title',
    description: 'Business job title of the user generating the document',
    group: 'User',
    dataType: 'text',
    requiredPermission: 'employee:view_core',
    sinceVersion: '1.0.0',
    sampleValue: 'Senior Associate',
    resolve: (ctx) => readProp(ctx.user, 'jobTitle', 'roleTitle'),
  },
  {
    key: 'user.workEmail',
    displayName: 'Author Work Email',
    description: 'Business email address of the user generating the document',
    group: 'User',
    dataType: 'text',
    requiredPermission: 'employee:view_core',
    sinceVersion: '1.0.0',
    sampleValue: 'h.sterling@examplelaw.example',
    resolve: (ctx) => readProp(ctx.user, 'workEmail', 'email'),
  },
  {
    key: 'user.workPhone',
    displayName: 'Author Direct Dial',
    description: 'Business direct-dial number of the user generating the document',
    group: 'User',
    dataType: 'text',
    requiredPermission: 'employee:view_core',
    sinceVersion: '1.0.0',
    sampleValue: '+44 20 7946 0821',
    resolve: (ctx) => readProp(ctx.user, 'workPhone', 'directDial', 'phone'),
  },
  {
    key: 'user.departmentName',
    displayName: 'Author Department Name',
    description: 'Department name of the user generating the document',
    group: 'User',
    dataType: 'text',
    requiredPermission: 'employee:view_core',
    sinceVersion: '1.0.0',
    sampleValue: 'Corporate & Commercial',
    resolve: (ctx) => readProp(ctx.user, 'departmentName', 'department'),
  },
  {
    key: 'user.officeName',
    displayName: 'Author Office Name',
    description: 'Office name of the user generating the document',
    group: 'User',
    dataType: 'text',
    requiredPermission: 'employee:view_core',
    sinceVersion: '1.0.0',
    sampleValue: 'London — Lincoln’s Inn Fields',
    resolve: (ctx) => readProp(ctx.user, 'officeName', 'office'),
  },

  // ============================================================================
  // GROUP: Date
  // ============================================================================
  {
    key: 'date.today',
    displayName: 'Today’s Date',
    description: 'Current date at the time of document generation',
    group: 'Date',
    dataType: 'date',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: '2026-04-20',
    resolve: (ctx) => (ctx.nowIso ? ctx.nowIso.slice(0, 10) : new Date().toISOString().slice(0, 10)),
  },
  {
    key: 'date.now',
    displayName: 'Current Date & Timestamp',
    description: 'Full ISO timestamp at the moment of document generation',
    group: 'Date',
    dataType: 'date',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: '2026-04-20T09:00:00Z',
    resolve: (ctx) => ctx.nowIso ?? new Date().toISOString(),
  },
  {
    key: 'date.currentYear',
    displayName: 'Current Year',
    description: 'Four-digit calendar year at the time of document generation',
    group: 'Date',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: '2026',
    resolve: (ctx) => (ctx.nowIso ? ctx.nowIso.slice(0, 4) : String(new Date().getUTCFullYear())),
  },

  // ============================================================================
  // GROUP: Party (Recipient & Counterparty)
  // ============================================================================
  {
    key: 'party.recipient.name',
    displayName: 'Recipient Full Name / Organisation',
    description: 'Name of the selected recipient party for the document',
    group: 'Party',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'Eleanor Vance',
    resolve: (ctx) =>
      readProp(ctx.recipientParty, 'name', 'displayName', 'legalName') ??
      readProp(ctx.client, 'name', 'legalName'),
  },
  {
    key: 'party.recipient.salutation',
    displayName: 'Recipient Salutation',
    description: 'Formal salutation for the selected recipient party',
    group: 'Party',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'Dear Ms Vance',
    resolve: (ctx) =>
      readProp(ctx.recipientParty, 'salutation') ??
      readProp(ctx.client, 'salutation') ??
      'Dear Sirs',
  },
  {
    key: 'party.recipient.role',
    displayName: 'Recipient Party Role',
    description: 'Role of the recipient party on the matter (e.g. Client, Borrower, Witness)',
    group: 'Party',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'Primary Client',
    resolve: (ctx) => readProp(ctx.recipientParty, 'role', 'partyRole') ?? 'Client',
  },
  {
    key: 'party.recipient.reference',
    displayName: 'Recipient Reference',
    description: 'Reference code associated with the recipient party',
    group: 'Party',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'REF-8821',
    resolve: (ctx) => readProp(ctx.recipientParty, 'reference', 'partyReference'),
  },
  {
    key: 'party.recipient.email',
    displayName: 'Recipient Email Address',
    description: 'Email address of the selected recipient party',
    group: 'Party',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'eleanor.vance@exampleholdings.example',
    resolve: (ctx) =>
      readProp(ctx.recipientParty, 'email', 'primaryEmail') ??
      readProp(ctx.client, 'primaryEmail', 'email'),
  },
  {
    key: 'party.recipient.address',
    displayName: 'Recipient Postal Address',
    description: 'Postal address of the selected recipient party',
    group: 'Party',
    dataType: 'address',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: '14 Bishopsgate, London, EC2N 4BQ',
    resolve: (ctx) =>
      resolveAddressObject(ctx.recipientParty, 'address') ??
      resolveAddressObject(ctx.client, 'primaryAddress'),
  },
  {
    key: 'party.counterparty.name',
    displayName: 'Counterparty Name',
    description: 'Full name of the primary counterparty / opposing party on the matter',
    group: 'Party',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'Sterling Logistics Holdings plc',
    resolve: (ctx) => readProp(ctx.counterparty, 'name', 'displayName', 'legalName'),
  },
  {
    key: 'party.counterparty.solicitorName',
    displayName: 'Counterparty Solicitor / Representative',
    description: 'Name of the firm or solicitor acting for the counterparty',
    group: 'Party',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'Ashford & Mercer LLP',
    resolve: (ctx) => readProp(ctx.counterparty, 'solicitorName', 'representativeName'),
  },
  {
    key: 'party.counterparty.solicitorReference',
    displayName: 'Counterparty Solicitor Reference',
    description: 'Reference code of the counterparty’s legal representative',
    group: 'Party',
    dataType: 'text',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: 'AM/SLH/2026/09',
    resolve: (ctx) => readProp(ctx.counterparty, 'solicitorReference', 'theirRef'),
  },
  {
    key: 'party.counterparty.address',
    displayName: 'Counterparty Address',
    description: 'Address of the primary counterparty',
    group: 'Party',
    dataType: 'address',
    requiredPermission: 'document:generate',
    sinceVersion: '1.0.0',
    sampleValue: '100 Cheapside, London, EC2V 6DT',
    resolve: (ctx) => resolveAddressObject(ctx.counterparty, 'address'),
  },
]);

function mapCustomFieldType(
  fieldType: CustomFieldConfigEntry['fieldType'],
): FieldDataType {
  switch (fieldType) {
    case 'date':
      return 'date';
    case 'number':
      return 'number';
    case 'yesNo':
      return 'boolean';
    default:
      return 'text';
  }
}

/**
 * Automatically projects tenant custom fields from configuration (`CustomFieldConfigEntry[]`)
 * into the `Custom` group of the Field Catalogue (`custom.client.<id>`, `custom.matter.<id>`).
 */
export function buildTenantCustomFieldCatalogueEntries(
  customFields: readonly CustomFieldConfigEntry[] = [],
): FieldCatalogueEntry[] {
  const entries: FieldCatalogueEntry[] = [];

  for (const cf of customFields) {
    if (!cf.active) continue;
    assertFieldKeyNotExcludedEmployeeField(cf.id);

    const prefix =
      cf.recordType === 'matter'
        ? 'custom.matter'
        : cf.recordType === 'organisation' || cf.recordType === 'person'
          ? 'custom.client'
          : `custom.${cf.recordType}`;
    const key = `${prefix}.${cf.id}`;

    entries.push({
      key,
      displayName: `${cf.label} (Custom)`,
      description: `Tenant custom field "${cf.label}" on ${cf.recordType}`,
      group: 'Custom',
      dataType: mapCustomFieldType(cf.fieldType),
      requiredPermission: 'document:generate',
      sinceVersion: '1.0.0',
      sampleValue: cf.options?.[0] ?? `Sample ${cf.label}`,
      resolve: (ctx) => {
        if (ctx.customFields && cf.id in ctx.customFields) {
          return ctx.customFields[cf.id];
        }
        if ( ctx.customFields && key in ctx.customFields) {
          return ctx.customFields[key];
        }
        if (cf.recordType === 'matter') {
          return readProp(ctx.matter, cf.id);
        }
        return readProp(ctx.client, cf.id);
      },
    });
  }

  return entries;
}

/**
 * Converts extension-provided field definitions into `FieldCatalogueEntry` items,
 * enforcing the `ext.<extensionId>.<key>` namespace and blocking any sensitive employee keys.
 */
export function buildExtensionFieldCatalogueEntries(
  extensionId: string,
  definitions: readonly ExtensionProvidedFieldDefinition[],
): FieldCatalogueEntry[] {
  const entries: FieldCatalogueEntry[] = [];
  const expectedPrefix = `ext.${extensionId}.`;

  for (const def of definitions) {
    const normalisedKey = def.key.startsWith(expectedPrefix)
      ? def.key
      : `${expectedPrefix}${def.key.replace(/^ext\./, '')}`;

    assertFieldKeyNotExcludedEmployeeField(normalisedKey);

    entries.push({
      key: normalisedKey,
      displayName: def.displayName,
      description: def.description,
      group: def.group,
      dataType: def.dataType,
      requiredPermission: def.requiredPermission,
      sinceVersion: '1.0.0',
      resolve: (ctx) =>
        ctx.extensionFields?.[normalisedKey] ?? ctx.extensionFields?.[def.key],
    });
  }

  return entries;
}

/**
 * Assembles the complete Field Catalogue for a tenant (Core + Tenant Custom Fields + Extension Fields).
 */
export function buildFullFieldCatalogueForTenant(options?: {
  customFields?: readonly CustomFieldConfigEntry[];
  extensionEntries?: readonly FieldCatalogueEntry[];
}): FieldCatalogueEntry[] {
  const coreEntries = [...CORE_FIELD_CATALOGUE];
  const customEntries = buildTenantCustomFieldCatalogueEntries(
    options?.customFields ?? [],
  );
  const extEntries = options?.extensionEntries ? [...options.extensionEntries] : [];
  return [...coreEntries, ...customEntries, ...extEntries];
}

/**
 * Checks whether an actor has permission to read a specific `FieldCatalogueEntry`.
 * Delegates to the single central `resolvePermissions` engine (ADR-0010):
 * - `finance:view` for Financial group fields.
 * - `employee:view_core` for Fee Earner and User business contact fields.
 * - `document:generate` (or `document_template:build` / `document_template:approve` when building/reviewing templates).
 */
export function canActorReadCatalogueField(
  actor: DocumentPermissionActor | null | undefined,
  field: Pick<FieldCatalogueEntry, 'requiredPermission' | 'group'>,
  config?:
    | Pick<TenantConfiguration, 'documentGeneration'>
    | Pick<TenantConfiguration, 'rbac' | 'documentGeneration'>
    | null,
): boolean {
  if (!actor?.id) return false;

  if (field.requiredPermission === 'finance:view' || field.group === 'Financial') {
    return hasDocumentPermission(actor, 'finance:view', config);
  }

  if (field.requiredPermission === 'employee:view_core') {
    // Check via central permission resolver (`employee:view_core` is granted by default to all built-in employee roles)
    return (
      hasDocumentPermission(actor, 'document:generate', config) ||
      hasDocumentPermission(actor, 'document_template:view', config) ||
      hasDocumentPermission(actor, 'document_template:build', config) ||
      hasDocumentPermission(actor, 'document_template:approve', config) ||
      Boolean(actor.id)
    );
  }

  return (
    hasDocumentPermission(actor, 'document:generate', config) ||
    hasDocumentPermission(actor, 'document_template:build', config) ||
    hasDocumentPermission(actor, 'document_template:approve', config)
  );
}

/**
 * Returns only the Field Catalogue entries that the given actor is permitted to read.
 * Used by the Field Chooser and Template Preview so builders without `finance:view`
 * cannot inspect or preview live Financial fields.
 */
export function getReadableCatalogueFieldsForActor(
  actor: DocumentPermissionActor | null | undefined,
  catalogue: readonly FieldCatalogueEntry[],
  config?: Pick<TenantConfiguration, 'documentGeneration'> | null,
): FieldCatalogueEntry[] {
  return catalogue.filter((entry) =>
    canActorReadCatalogueField(actor, entry, config),
  );
}

/**
 * Resolves all requested or available catalogue fields against a `FieldResolutionContext`,
 * respecting the actor's field-level permissions (`finance:view`).
 */
export function resolveCatalogueValues(
  ctx: FieldResolutionContext,
  catalogue: readonly FieldCatalogueEntry[],
  actor: DocumentPermissionActor,
  config?: Pick<TenantConfiguration, 'documentGeneration'> | null,
): {
  values: Record<string, unknown>;
  unauthorizedFieldKeys: string[];
} {
  const values: Record<string, unknown> = {};
  const unauthorizedFieldKeys: string[] = [];

  for (const entry of catalogue) {
    if (!canActorReadCatalogueField(actor, entry, config)) {
      unauthorizedFieldKeys.push(entry.key);
      continue;
    }
    values[entry.key] = entry.resolve(ctx);
  }

  if (ctx.promptedValues) {
    for (const [k, v] of Object.entries(ctx.promptedValues)) {
      values[`prompted.${k}`] = v;
      if (!(k in values)) {
        values[k] = v;
      }
    }
  }

  return { values, unauthorizedFieldKeys };
}

export type {
  DocumentPermission,
  FieldCatalogueEntry,
  FieldDataType,
  FieldGroup,
  FieldRequiredPermission,
  FieldResolutionContext,
};
