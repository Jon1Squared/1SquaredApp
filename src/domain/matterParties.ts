import type {
  CapacityGroupName,
  ChoiceValue,
  ConflictCheckParty,
  Matter,
  MatterParty,
  MatterPartyAlignment,
  MatterPartyCapacityDef,
  MatterPartyMigrationMappingEntry,
  MatterPartyMigrationReport,
  MatterPartyRelationshipDef,
  MatterPartyTaxonomy,
  WorkTypeProfileCode,
  WorkTypeProfileDef,
} from './types';

export const CAPACITY_GROUPS: CapacityGroupName[] = [
  'Ownership, control and authority',
  'Legal and professional advisers',
  'Disputes',
  'Transactional, corporate and property',
  'Employment',
  'Private client and family',
  'Neutral and official',
];

export const WORK_TYPE_PROFILES: WorkTypeProfileDef[] = [
  { code: 'ALL', covers: 'Every work type' },
  { code: 'LIT', covers: 'Civil litigation and dispute resolution' },
  { code: 'EMP', covers: 'Employment' },
  { code: 'PROP', covers: 'Commercial property, landlord & tenant, residential conveyancing' },
  { code: 'CORP', covers: 'Corporate, commercial, banking and finance' },
  { code: 'PC', covers: 'Private client: wills, probate, trusts, LPAs, Court of Protection' },
  { code: 'FAM', covers: 'Family' },
  { code: 'INS', covers: 'Insolvency and restructuring' },
  { code: 'REG', covers: 'Regulatory and public law' },
  { code: 'CRIM', covers: 'Criminal' },
  { code: 'CON', covers: 'Construction' },
];

export const RELATIONSHIP_SORT_ORDER: string[] = [
  'CL',
  'JC',
  'CC',
  'OP',
  'CP',
  'CO',
  'TP',
  'NO',
];

export const SEED_RELATIONSHIPS: MatterPartyRelationshipDef[] = [
  {
    code: 'CL',
    label: 'Client',
    description: 'The party instructing the firm',
    sortOrder: 1,
    active: true,
  },
  {
    code: 'JC',
    label: 'Joint client',
    description: 'Another client on the same matter (spouse, business partner, co-defendant)',
    sortOrder: 2,
    active: true,
  },
  {
    code: 'CC',
    label: 'Connected to client',
    description: 'Acts for, owns, is controlled by or advises the client',
    sortOrder: 3,
    active: true,
  },
  {
    code: 'OP',
    label: 'Opposing party',
    description: 'The other side in a dispute',
    sortOrder: 4,
    active: true,
  },
  {
    code: 'CP',
    label: 'Counterparty',
    description: 'The other side in a transaction',
    sortOrder: 5,
    active: true,
  },
  {
    code: 'CO',
    label: 'Connected to other side',
    description: 'Acts for, owns, is controlled by or advises the opposing party or counterparty',
    sortOrder: 6,
    active: true,
  },
  {
    code: 'TP',
    label: 'Interested third party',
    description: 'Has an interest in the outcome but is not on either side',
    sortOrder: 7,
    active: true,
  },
  {
    code: 'NO',
    label: 'Neutral / official',
    description: 'Court, tribunal, regulator, mediator or other neutral body',
    sortOrder: 8,
    active: true,
  },
];

interface RawCapacitySeed {
  code: string;
  label: string;
  group: CapacityGroupName;
  description?: string;
  allowedRelationships: string[];
  profiles: WorkTypeProfileCode[];
}

const RAW_CAPACITIES: RawCapacitySeed[] = [
  // Group: Ownership, control and authority
  {
    code: 'CAP_REPRESENTATIVE',
    label: 'Representative',
    group: 'Ownership, control and authority',
    allowedRelationships: ['CC', 'CO', 'TP'],
    profiles: ['ALL'],
  },
  {
    code: 'CAP_DECISION_MAKER',
    label: 'Decision-maker / authorised signatory',
    group: 'Ownership, control and authority',
    allowedRelationships: ['CC', 'CO', 'TP'],
    profiles: ['ALL'],
  },
  {
    code: 'CAP_DIRECTOR_OFFICER',
    label: 'Director / officer',
    group: 'Ownership, control and authority',
    allowedRelationships: ['CC', 'CO', 'TP'],
    profiles: ['ALL'],
  },
  {
    code: 'CAP_SHAREHOLDER_MEMBER',
    label: 'Shareholder / member',
    group: 'Ownership, control and authority',
    allowedRelationships: ['CL', 'JC', 'CC', 'CO', 'OP', 'CP', 'TP'],
    profiles: ['ALL'],
  },
  {
    code: 'CAP_BENEFICIAL_OWNER_PSC',
    label: 'Beneficial owner / PSC',
    group: 'Ownership, control and authority',
    allowedRelationships: ['CC', 'CO', 'TP'],
    profiles: ['ALL'],
  },
  {
    code: 'CAP_PARTNER_LLP',
    label: 'Partner (partnership / LLP)',
    group: 'Ownership, control and authority',
    allowedRelationships: ['CC', 'CO', 'TP'],
    profiles: ['ALL'],
  },
  {
    code: 'CAP_PARENT_COMPANY',
    label: 'Parent company',
    group: 'Ownership, control and authority',
    allowedRelationships: ['CC', 'CO', 'TP'],
    profiles: ['ALL'],
  },
  {
    code: 'CAP_SUBSIDIARY_GROUP_COMPANY',
    label: 'Subsidiary / group company',
    group: 'Ownership, control and authority',
    allowedRelationships: ['CC', 'CO', 'TP'],
    profiles: ['ALL'],
  },
  {
    code: 'CAP_EMPLOYEE',
    label: 'Employee',
    group: 'Ownership, control and authority',
    allowedRelationships: ['CC', 'CO', 'TP'],
    profiles: ['ALL'],
  },
  {
    code: 'CAP_ATTORNEY_LPA',
    label: 'Attorney (LPA)',
    group: 'Ownership, control and authority',
    allowedRelationships: ['CC', 'CO', 'TP'],
    profiles: ['PC', 'LIT', 'PROP'],
  },
  {
    code: 'CAP_DEPUTY_COP',
    label: 'Deputy (Court of Protection)',
    group: 'Ownership, control and authority',
    allowedRelationships: ['CC', 'CO', 'TP'],
    profiles: ['PC', 'LIT'],
  },
  {
    code: 'CAP_LITIGATION_FRIEND',
    label: 'Litigation friend',
    group: 'Ownership, control and authority',
    allowedRelationships: ['CC', 'CO'],
    profiles: ['LIT', 'FAM', 'PC'],
  },

  // Group: Legal and professional advisers
  {
    code: 'CAP_SOLICITOR',
    label: 'Solicitor',
    group: 'Legal and professional advisers',
    allowedRelationships: ['CC', 'CO', 'TP'],
    profiles: ['ALL'],
  },
  {
    code: 'CAP_BARRISTER_COUNSEL',
    label: 'Barrister / counsel',
    group: 'Legal and professional advisers',
    allowedRelationships: ['CC', 'CO', 'TP'],
    profiles: ['ALL'],
  },
  {
    code: 'CAP_AGENT_SOLICITOR',
    label: 'Agent solicitor / foreign counsel',
    group: 'Legal and professional advisers',
    allowedRelationships: ['CC', 'CO'],
    profiles: ['ALL'],
  },
  {
    code: 'CAP_EXPERT_WITNESS',
    label: 'Expert witness',
    group: 'Legal and professional advisers',
    description: 'NO = single joint expert',
    allowedRelationships: ['CC', 'CO', 'NO'],
    profiles: ['LIT', 'FAM', 'PROP', 'CON', 'EMP', 'PC', 'CRIM'],
  },
  {
    code: 'CAP_ACCOUNTANT',
    label: 'Accountant',
    group: 'Legal and professional advisers',
    allowedRelationships: ['CC', 'CO', 'TP'],
    profiles: ['ALL'],
  },
  {
    code: 'CAP_SURVEYOR_VALUER',
    label: 'Surveyor / valuer',
    group: 'Legal and professional advisers',
    allowedRelationships: ['CC', 'CO', 'TP', 'NO'],
    profiles: ['PROP', 'LIT', 'PC', 'CON', 'FAM', 'CORP'],
  },
  {
    code: 'CAP_FINANCIAL_ADVISER',
    label: 'Financial adviser',
    group: 'Legal and professional advisers',
    allowedRelationships: ['CC', 'CO', 'TP'],
    profiles: ['PC', 'FAM', 'CORP'],
  },
  {
    code: 'CAP_INSOLVENCY_PRACTITIONER',
    label: 'Insolvency practitioner',
    group: 'Legal and professional advisers',
    allowedRelationships: ['CL', 'CC', 'CO', 'OP', 'CP', 'TP'],
    profiles: ['INS', 'LIT', 'CORP', 'PROP'],
  },
  {
    code: 'CAP_OTHER_PROFESSIONAL_ADVISER',
    label: 'Other professional adviser',
    group: 'Legal and professional advisers',
    allowedRelationships: ['CC', 'CO', 'TP'],
    profiles: ['ALL'],
  },

  // Group: Disputes
  {
    code: 'CAP_CLAIMANT',
    label: 'Claimant',
    group: 'Disputes',
    allowedRelationships: ['CL', 'JC', 'OP', 'TP'],
    profiles: ['LIT', 'EMP', 'PROP', 'CON', 'PC', 'INS'],
  },
  {
    code: 'CAP_DEFENDANT',
    label: 'Defendant',
    group: 'Disputes',
    allowedRelationships: ['CL', 'JC', 'OP', 'TP'],
    profiles: ['LIT', 'PROP', 'CON', 'PC', 'INS', 'CRIM'],
  },
  {
    code: 'CAP_ADDITIONAL_PARTY_PART_20',
    label: 'Additional party (Part 20)',
    group: 'Disputes',
    allowedRelationships: ['CL', 'JC', 'OP', 'TP'],
    profiles: ['LIT', 'CON', 'PROP'],
  },
  {
    code: 'CAP_APPLICANT',
    label: 'Applicant',
    group: 'Disputes',
    allowedRelationships: ['CL', 'JC', 'OP', 'TP'],
    profiles: ['LIT', 'FAM', 'INS', 'EMP', 'PC'],
  },
  {
    code: 'CAP_RESPONDENT',
    label: 'Respondent',
    group: 'Disputes',
    allowedRelationships: ['CL', 'JC', 'OP', 'TP'],
    profiles: ['LIT', 'FAM', 'INS', 'EMP', 'PC', 'REG'],
  },
  {
    code: 'CAP_APPELLANT',
    label: 'Appellant',
    group: 'Disputes',
    allowedRelationships: ['CL', 'JC', 'OP', 'TP'],
    profiles: ['LIT', 'EMP', 'REG', 'CRIM', 'FAM'],
  },
  {
    code: 'CAP_INTERESTED_PARTY',
    label: 'Interested party',
    group: 'Disputes',
    allowedRelationships: ['CL', 'OP', 'TP'],
    profiles: ['REG', 'LIT'],
  },
  {
    code: 'CAP_WITNESS_OF_FACT',
    label: 'Witness of fact',
    group: 'Disputes',
    allowedRelationships: ['CC', 'CO', 'TP'],
    profiles: ['LIT', 'EMP', 'FAM', 'CRIM', 'REG', 'CON', 'PROP'],
  },
  {
    code: 'CAP_PROSECUTING_AUTHORITY',
    label: 'Prosecuting authority',
    group: 'Disputes',
    allowedRelationships: ['OP'],
    profiles: ['CRIM', 'REG'],
  },
  {
    code: 'CAP_COMPLAINANT_VICTIM',
    label: 'Complainant / victim',
    group: 'Disputes',
    allowedRelationships: ['OP', 'TP'],
    profiles: ['CRIM', 'REG'],
  },
  {
    code: 'CAP_INSURER',
    label: 'Insurer',
    group: 'Disputes',
    allowedRelationships: ['CL', 'CC', 'CO', 'OP', 'TP'],
    profiles: ['LIT', 'PROP', 'CON', 'CORP', 'EMP'],
  },
  {
    code: 'CAP_LOSS_ADJUSTER',
    label: 'Loss adjuster',
    group: 'Disputes',
    allowedRelationships: ['CC', 'CO', 'TP'],
    profiles: ['LIT', 'PROP', 'CON'],
  },
  {
    code: 'CAP_LITIGATION_FUNDER',
    label: 'Litigation funder',
    group: 'Disputes',
    allowedRelationships: ['CC', 'CO', 'TP'],
    profiles: ['LIT', 'CON', 'EMP', 'INS'],
  },

  // Group: Transactional, corporate and property
  {
    code: 'CAP_BUYER_ACQUIRER',
    label: 'Buyer / acquirer',
    group: 'Transactional, corporate and property',
    allowedRelationships: ['CL', 'JC', 'CP', 'TP'],
    profiles: ['CORP', 'PROP'],
  },
  {
    code: 'CAP_SELLER',
    label: 'Seller',
    group: 'Transactional, corporate and property',
    allowedRelationships: ['CL', 'JC', 'CP', 'TP'],
    profiles: ['CORP', 'PROP'],
  },
  {
    code: 'CAP_TARGET_COMPANY',
    label: 'Target company',
    group: 'Transactional, corporate and property',
    allowedRelationships: ['CL', 'CP', 'TP'],
    profiles: ['CORP'],
  },
  {
    code: 'CAP_INVESTOR',
    label: 'Investor',
    group: 'Transactional, corporate and property',
    allowedRelationships: ['CL', 'JC', 'CP', 'TP'],
    profiles: ['CORP'],
  },
  {
    code: 'CAP_LENDER_CHARGEE',
    label: 'Lender / chargee',
    group: 'Transactional, corporate and property',
    allowedRelationships: ['CL', 'CP', 'TP'],
    profiles: ['CORP', 'PROP', 'INS'],
  },
  {
    code: 'CAP_BORROWER',
    label: 'Borrower',
    group: 'Transactional, corporate and property',
    allowedRelationships: ['CL', 'JC', 'CP', 'TP'],
    profiles: ['CORP', 'PROP', 'INS'],
  },
  {
    code: 'CAP_GUARANTOR',
    label: 'Guarantor',
    group: 'Transactional, corporate and property',
    allowedRelationships: ['CL', 'JC', 'CC', 'CO', 'CP', 'TP'],
    profiles: ['CORP', 'PROP', 'INS', 'LIT'],
  },
  {
    code: 'CAP_LANDLORD',
    label: 'Landlord',
    group: 'Transactional, corporate and property',
    allowedRelationships: ['CL', 'JC', 'OP', 'CP', 'TP'],
    profiles: ['PROP', 'LIT'],
  },
  {
    code: 'CAP_TENANT',
    label: 'Tenant',
    group: 'Transactional, corporate and property',
    allowedRelationships: ['CL', 'JC', 'OP', 'CP', 'TP'],
    profiles: ['PROP', 'LIT'],
  },
  {
    code: 'CAP_CONTRACTOR_DEVELOPER',
    label: 'Contractor / developer',
    group: 'Transactional, corporate and property',
    allowedRelationships: ['CL', 'OP', 'CP', 'TP'],
    profiles: ['CON', 'PROP'],
  },
  {
    code: 'CAP_AGENT_BROKER',
    label: 'Agent / broker',
    group: 'Transactional, corporate and property',
    allowedRelationships: ['CC', 'CO', 'TP'],
    profiles: ['PROP', 'CORP'],
  },

  // Group: Employment
  {
    code: 'CAP_EMPLOYER',
    label: 'Employer',
    group: 'Employment',
    allowedRelationships: ['CL', 'JC', 'OP', 'TP'],
    profiles: ['EMP'],
  },
  {
    code: 'CAP_EMPLOYEE_WORKER',
    label: 'Employee / worker',
    group: 'Employment',
    allowedRelationships: ['CL', 'JC', 'OP', 'TP'],
    profiles: ['EMP'],
  },
  {
    code: 'CAP_TRADE_UNION',
    label: 'Trade union',
    group: 'Employment',
    allowedRelationships: ['CC', 'CO', 'TP'],
    profiles: ['EMP'],
  },

  // Group: Private client and family
  {
    code: 'CAP_DECEASED',
    label: 'Deceased',
    group: 'Private client and family',
    allowedRelationships: ['TP'],
    profiles: ['PC', 'LIT'],
  },
  {
    code: 'CAP_TESTATOR',
    label: 'Testator',
    group: 'Private client and family',
    allowedRelationships: ['CL', 'TP'],
    profiles: ['PC'],
  },
  {
    code: 'CAP_SETTLOR',
    label: 'Settlor',
    group: 'Private client and family',
    allowedRelationships: ['CL', 'TP'],
    profiles: ['PC'],
  },
  {
    code: 'CAP_DONOR_LPA',
    label: 'Donor (LPA)',
    group: 'Private client and family',
    allowedRelationships: ['CL', 'TP'],
    profiles: ['PC'],
  },
  {
    code: 'CAP_BENEFICIARY',
    label: 'Beneficiary',
    group: 'Private client and family',
    allowedRelationships: ['CL', 'JC', 'OP', 'TP'],
    profiles: ['PC', 'LIT'],
  },
  {
    code: 'CAP_EXECUTOR',
    label: 'Executor',
    group: 'Private client and family',
    allowedRelationships: ['CL', 'JC', 'OP', 'TP'],
    profiles: ['PC', 'LIT', 'PROP'],
  },
  {
    code: 'CAP_ADMINISTRATOR',
    label: 'Administrator',
    group: 'Private client and family',
    allowedRelationships: ['CL', 'JC', 'OP', 'TP'],
    profiles: ['PC', 'LIT', 'PROP'],
  },
  {
    code: 'CAP_TRUSTEE',
    label: 'Trustee',
    group: 'Private client and family',
    allowedRelationships: ['CL', 'JC', 'OP', 'CP', 'TP'],
    profiles: ['PC', 'LIT', 'PROP', 'CORP'],
  },
  {
    code: 'CAP_SPOUSE_CIVIL_PARTNER',
    label: 'Spouse / civil partner',
    group: 'Private client and family',
    allowedRelationships: ['CL', 'OP', 'TP'],
    profiles: ['FAM', 'PC'],
  },
  {
    code: 'CAP_FORMER_SPOUSE_CIVIL_PARTNER',
    label: 'Former spouse / civil partner',
    group: 'Private client and family',
    allowedRelationships: ['CL', 'OP', 'TP'],
    profiles: ['FAM', 'PC'],
  },
  {
    code: 'CAP_COHABITANT',
    label: 'Cohabitant',
    group: 'Private client and family',
    allowedRelationships: ['CL', 'OP', 'TP'],
    profiles: ['FAM', 'PC', 'PROP'],
  },
  {
    code: 'CAP_CHILD',
    label: 'Child',
    group: 'Private client and family',
    allowedRelationships: ['CC', 'TP'],
    profiles: ['FAM', 'PC'],
  },
  {
    code: 'CAP_PARENTAL_RESPONSIBILITY',
    label: 'Person with parental responsibility',
    group: 'Private client and family',
    allowedRelationships: ['CL', 'JC', 'OP', 'TP'],
    profiles: ['FAM'],
  },
  {
    code: 'CAP_CHILDRENS_GUARDIAN',
    label: "Children's guardian",
    group: 'Private client and family',
    allowedRelationships: ['NO'],
    profiles: ['FAM'],
  },

  // Group: Neutral and official
  {
    code: 'CAP_COURT_TRIBUNAL',
    label: 'Court / tribunal',
    group: 'Neutral and official',
    allowedRelationships: ['NO'],
    profiles: ['ALL'],
  },
  {
    code: 'CAP_JUDGE',
    label: 'Judge',
    group: 'Neutral and official',
    allowedRelationships: ['NO'],
    profiles: ['ALL'],
  },
  {
    code: 'CAP_ARBITRATOR',
    label: 'Arbitrator',
    group: 'Neutral and official',
    allowedRelationships: ['NO'],
    profiles: ['LIT', 'CON', 'PROP', 'CORP'],
  },
  {
    code: 'CAP_MEDIATOR',
    label: 'Mediator',
    group: 'Neutral and official',
    allowedRelationships: ['NO'],
    profiles: ['ALL'],
  },
  {
    code: 'CAP_ADJUDICATOR',
    label: 'Adjudicator / expert determiner',
    group: 'Neutral and official',
    allowedRelationships: ['NO'],
    profiles: ['CON', 'PROP', 'CORP'],
  },
  {
    code: 'CAP_OMBUDSMAN',
    label: 'Ombudsman',
    group: 'Neutral and official',
    allowedRelationships: ['NO'],
    profiles: ['LIT', 'PC', 'REG'],
  },
  {
    code: 'CAP_REGULATOR',
    label: 'Regulator',
    group: 'Neutral and official',
    allowedRelationships: ['NO', 'OP'],
    profiles: ['ALL'],
  },
  {
    code: 'CAP_PUBLIC_AUTHORITY',
    label: 'Public authority / government body',
    group: 'Neutral and official',
    allowedRelationships: ['NO', 'OP', 'CP', 'TP'],
    profiles: ['ALL'],
  },
];

export const SEED_CAPACITIES: MatterPartyCapacityDef[] = RAW_CAPACITIES.map((c, idx) => ({
  ...c,
  sortOrder: idx + 1,
  active: true,
}));

/**
 * Default mapping of every work_type subcategory in the system to one or more WorkTypeProfileCodes.
 * Also supports fallback inference from subcategory label and parent practice area.
 */
export const DEFAULT_WORK_TYPE_PROFILES: Record<string, WorkTypeProfileCode[]> = {
  // 1. Corporate & Commercial
  'work_type.corporate_and_commercial_company_formations_and_structures': ['CORP'],
  'work_type.corporate_and_commercial_shareholder_agreements': ['CORP'],
  'work_type.corporate_and_commercial_mergers_and_acquisitions': ['CORP'],
  'work_type.corporate_and_commercial_joint_ventures': ['CORP'],
  'work_type.corporate_and_commercial_commercial_contracts': ['CORP'],
  'work_type.corporate_and_commercial_agency_and_distribution': ['CORP'],
  'work_type.corporate_and_commercial_corporate_governance': ['CORP'],
  'work_type.corporate_and_commercial_due_diligence': ['CORP'],

  // 2. Real Estate & Property
  'work_type.real_estate_and_property_residential_conveyancing': ['PROP'],
  'work_type.real_estate_and_property_commercial_property': ['PROP'],
  'work_type.real_estate_and_property_commercial_property_acquisitions_and_disposals': ['PROP'],
  'work_type.real_estate_and_property_landlord_and_tenant': ['PROP', 'LIT'],
  'work_type.real_estate_and_property_development_and_planning': ['PROP', 'CON'],
  'work_type.real_estate_and_property_finance_and_secured_lending': ['PROP', 'CORP'],
  'work_type.real_estate_and_property_property_management': ['PROP'],
  'work_type.real_estate_and_property_construction_contracts': ['PROP', 'CON'],

  // 3. Employment & HR
  'work_type.employment_and_hr_employment_contracts': ['EMP'],
  'work_type.employment_and_hr_disciplinary_and_grievance': ['EMP'],
  'work_type.employment_and_hr_grievance_disciplinary_and_capability': ['EMP'],
  'work_type.employment_and_hr_settlement_agreements': ['EMP'],
  'work_type.employment_and_hr_redundancy_and_restructuring': ['EMP'],
  'work_type.employment_and_hr_tribunal_claims': ['EMP', 'LIT'],
  'work_type.employment_and_hr_tupe_transfers': ['EMP', 'CORP'],
  'work_type.employment_and_hr_hr_policies_and_handbooks': ['EMP'],
  'work_type.employment_and_hr_executive_and_senior_hire': ['EMP', 'CORP'],

  // 4. Dispute Resolution
  'work_type.dispute_resolution_pre_action_correspondence': ['LIT'],
  'work_type.dispute_resolution_court_pleadings': ['LIT'],
  'work_type.dispute_resolution_mediation_and_adr': ['LIT'],
  'work_type.dispute_resolution_arbitration': ['LIT'],
  'work_type.dispute_resolution_enforcement': ['LIT'],
  'work_type.dispute_resolution_injunctions_and_urgent_relief': ['LIT'],
  'work_type.dispute_resolution_cost_management': ['LIT'],
  'work_type.dispute_resolution_property_and_real_estate_disputes': ['LIT', 'PROP'],

  // 5. Intellectual Property
  'work_type.intellectual_property_trade_mark_applications': ['CORP', 'REG'],
  'work_type.intellectual_property_ip_assignment_and_licensing': ['CORP'],
  'work_type.intellectual_property_infringement_and_enforcement': ['LIT', 'CORP'],
  'work_type.intellectual_property_copyright_notices': ['CORP'],
  'work_type.intellectual_property_confidentiality_and_ndas': ['CORP'],
  'work_type.intellectual_property_ip_due_diligence': ['CORP'],

  // 6. Private Client
  'work_type.private_client_wills_and_codicils': ['PC'],
  'work_type.private_client_lasting_powers_of_attorney': ['PC'],
  'work_type.private_client_trusts_and_settlements': ['PC'],
  'work_type.private_client_estate_administration': ['PC'],
  'work_type.private_client_inheritance_tax_planning': ['PC'],
  'work_type.private_client_court_of_protection': ['PC', 'LIT'],

  // 7. Finance & Banking
  'work_type.finance_and_banking_loan_and_facility_agreements': ['CORP'],
  'work_type.finance_and_banking_security_documents': ['CORP', 'PROP'],
  'work_type.finance_and_banking_guarantees_and_indemnities': ['CORP'],
  'work_type.finance_and_banking_restructuring_and_insolvency': ['INS', 'CORP'],
  'work_type.finance_and_banking_regulatory_compliance': ['REG', 'CORP'],
  'work_type.finance_and_banking_asset_finance': ['CORP'],

  // 8. Regulatory & Compliance
  'work_type.regulatory_and_compliance_data_protection_and_gdpr': ['REG'],
  'work_type.regulatory_and_compliance_anti_bribery_and_corruption': ['REG', 'CRIM'],
  'work_type.regulatory_and_compliance_financial_services_regulation': ['REG', 'CORP'],
  'work_type.regulatory_and_compliance_health_and_safety': ['REG', 'CRIM'],
  'work_type.regulatory_and_compliance_environmental_and_planning': ['REG', 'PROP'],
  'work_type.regulatory_and_compliance_regulatory_investigations': ['REG', 'LIT', 'CRIM'],

  // 9. Technology & Digital
  'work_type.technology_and_digital_software_and_saas_agreements': ['CORP'],
  'work_type.technology_and_digital_data_sharing_and_processing': ['CORP', 'REG'],
  'work_type.technology_and_digital_outsourcing_contracts': ['CORP'],
  'work_type.technology_and_digital_cyber_incident_response': ['REG', 'LIT'],
  'work_type.technology_and_digital_ai_and_emerging_tech': ['CORP', 'REG'],
  'work_type.technology_and_digital_fintech_and_payments': ['CORP', 'REG'],

  // 10. Family
  'work_type.family_pre_nuptial_agreements': ['FAM'],
  'work_type.family_separation_and_divorce': ['FAM'],
  'work_type.family_financial_orders': ['FAM', 'LIT'],
  'work_type.family_children_arrangements': ['FAM'],
  'work_type.family_cohabitation_agreements': ['FAM', 'PROP'],
  'work_type.family_domestic_abuse_proceedings': ['FAM', 'LIT'],
};

export function inferProfilesForWorkTypeValue(
  subcat: ChoiceValue,
  parentArea?: ChoiceValue | null,
): WorkTypeProfileCode[] {
  if (DEFAULT_WORK_TYPE_PROFILES[subcat.id]) {
    return [...DEFAULT_WORK_TYPE_PROFILES[subcat.id]];
  }
  const lower = `${parentArea?.label ?? ''} ${subcat.label}`.toLowerCase();
  const profiles = new Set<WorkTypeProfileCode>();
  if (lower.includes('dispute') || lower.includes('litigat') || lower.includes('tribunal') || lower.includes('court') || lower.includes('pleading') || lower.includes('arbitrat') || lower.includes('mediat') || lower.includes('injunction') || lower.includes('enforcement')) {
    profiles.add('LIT');
  }
  if (lower.includes('employ') || lower.includes('tupe') || lower.includes('redundan') || lower.includes('grievance') || lower.includes('disciplinary') || lower.includes('settlement agreement') || lower.includes('hr ')) {
    profiles.add('EMP');
  }
  if (lower.includes('property') || lower.includes('real estate') || lower.includes('conveyanc') || lower.includes('landlord') || lower.includes('tenant') || lower.includes('lease') || lower.includes('planning')) {
    profiles.add('PROP');
  }
  if (lower.includes('construction')) {
    profiles.add('CON');
  }
  if (lower.includes('corporate') || lower.includes('commercial') || lower.includes('merger') || lower.includes('acquisition') || lower.includes('shareholder') || lower.includes('joint venture') || lower.includes('finance') || lower.includes('banking') || lower.includes('loan') || lower.includes('software') || lower.includes('intellectual property') || lower.includes('outsourcing')) {
    profiles.add('CORP');
  }
  if (lower.includes('private client') || lower.includes('will') || lower.includes('probate') || lower.includes('estate') || lower.includes('trust') || lower.includes('lasting power') || lower.includes('inheritance') || lower.includes('protection')) {
    profiles.add('PC');
  }
  if (lower.includes('family') || lower.includes('divorce') || lower.includes('nuptial') || lower.includes('children') || lower.includes('cohabit') || lower.includes('domestic abuse')) {
    profiles.add('FAM');
  }
  if (lower.includes('insolven') || lower.includes('restructur')) {
    profiles.add('INS');
  }
  if (lower.includes('regulat') || lower.includes('compliance') || lower.includes('gdpr') || lower.includes('data protection') || lower.includes('bribery') || lower.includes('health & safety') || lower.includes('environmental')) {
    profiles.add('REG');
  }
  if (lower.includes('crimin') || lower.includes('prosecut')) {
    profiles.add('CRIM');
  }
  if (profiles.size === 0) {
    profiles.add('CORP');
  }
  return Array.from(profiles);
}

export function buildDefaultMatterPartyTaxonomy(values: ChoiceValue[] = []): MatterPartyTaxonomy {
  const workTypeProfiles: Record<string, WorkTypeProfileCode[]> = {
    ...DEFAULT_WORK_TYPE_PROFILES,
  };
  const workTypeParents = new Map<string, ChoiceValue>();
  for (const v of values) {
    if (v.listKey === 'work_type' && !v.parentId) {
      workTypeParents.set(v.id, v);
    }
  }
  for (const v of values) {
    if (v.listKey === 'work_type' && v.parentId && !workTypeProfiles[v.id]) {
      workTypeProfiles[v.id] = inferProfilesForWorkTypeValue(v, workTypeParents.get(v.parentId));
    }
  }
  return {
    relationships: SEED_RELATIONSHIPS.map((r) => ({ ...r })),
    capacities: SEED_CAPACITIES.map((c) => ({
      ...c,
      allowedRelationships: [...c.allowedRelationships],
      profiles: [...c.profiles],
    })),
    workTypeProfiles,
  };
}

export function getRelationshipAlignment(relationshipCode: string | undefined | null): MatterPartyAlignment {
  switch (relationshipCode) {
    case 'CL':
    case 'JC':
    case 'CC':
      return 'aligned';
    case 'OP':
    case 'CP':
    case 'CO':
      return 'adverse';
    case 'NO':
      return 'neutral';
    case 'TP':
    default:
      return 'third_party';
  }
}

export function getProfilesForWorkType(
  taxonomy: MatterPartyTaxonomy,
  workTypeSubcategoryId: string | null | undefined,
): WorkTypeProfileCode[] {
  if (!workTypeSubcategoryId) return [];
  const mapped = taxonomy.workTypeProfiles[workTypeSubcategoryId];
  if (mapped && mapped.length > 0) return mapped;
  return DEFAULT_WORK_TYPE_PROFILES[workTypeSubcategoryId] ?? [];
}

/**
 * Returns capacities filtered by:
 * - active === true (plus any currently selected capacity codes so deactivated items stay visible on existing records)
 * - relationshipCode in allowedRelationships
 * - if !showAllCapacities: profiles includes 'ALL' or any profile mapped to workTypeSubcategoryId
 */
export function getAvailableCapacitiesForParty(opts: {
  taxonomy: MatterPartyTaxonomy;
  relationshipCode: string;
  workTypeSubcategoryId?: string | null;
  showAllCapacities?: boolean;
  includeCapacityCodes?: string[];
  excludeAllProfileForClientPrompt?: boolean;
}): MatterPartyCapacityDef[] {
  const {
    taxonomy,
    relationshipCode,
    workTypeSubcategoryId,
    showAllCapacities = false,
    includeCapacityCodes = [],
    excludeAllProfileForClientPrompt = false,
  } = opts;
  if (!relationshipCode) return [];
  const includeSet = new Set(includeCapacityCodes);
  const workProfiles = new Set<WorkTypeProfileCode>(
    getProfilesForWorkType(taxonomy, workTypeSubcategoryId),
  );

  return taxonomy.capacities
    .filter((cap) => {
      if (includeSet.has(cap.code)) return true;
      if (!cap.active) return false;
      if (!cap.allowedRelationships.includes(relationshipCode)) return false;
      if (showAllCapacities) return true;
      if (!workTypeSubcategoryId) return false;
      if (!excludeAllProfileForClientPrompt && cap.profiles.includes('ALL')) return true;
      return cap.profiles.some((p) => workProfiles.has(p));
    })
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Checks whether a given work type offers work-type-specific capacities for CL (or JC),
 * driving whether the Client's capacity selector is required and what examples to show in the placeholder.
 */
export function getWorkTypeClientCapacities(
  taxonomy: MatterPartyTaxonomy,
  workTypeSubcategoryId: string | null | undefined,
  relationshipCode: 'CL' | 'JC' = 'CL',
): MatterPartyCapacityDef[] {
  if (!workTypeSubcategoryId) return [];
  const workProfiles = new Set<WorkTypeProfileCode>(
    getProfilesForWorkType(taxonomy, workTypeSubcategoryId),
  );
  if (workProfiles.size === 0) return [];
  return taxonomy.capacities
    .filter(
      (cap) =>
        cap.active &&
        cap.allowedRelationships.includes(relationshipCode) &&
        (cap.profiles.some((p) => workProfiles.has(p)) || cap.profiles.includes('ALL')),
    )
    .sort((a, b) => {
      // Put work-type-specific capacities before generic 'ALL' capacities (like Shareholder / member)
      const aSpecific = a.profiles.some((p) => p !== 'ALL' && workProfiles.has(p)) ? 0 : 1;
      const bSpecific = b.profiles.some((p) => p !== 'ALL' && workProfiles.has(p)) ? 0 : 1;
      if (aSpecific !== bSpecific) return aSpecific - bSpecific;
      return a.sortOrder - b.sortOrder;
    });
}

/**
 * True when the work type's profiles include at least one capacity that is allowed for CL.
 */
export function isClientCapacityRequiredForWorkType(
  taxonomy: MatterPartyTaxonomy,
  workTypeSubcategoryId: string | null | undefined,
): boolean {
  if (!workTypeSubcategoryId) return false;
  const workProfiles = new Set<WorkTypeProfileCode>(
    getProfilesForWorkType(taxonomy, workTypeSubcategoryId),
  );
  if (workProfiles.size === 0) return false;
  return taxonomy.capacities.some(
    (cap) =>
      cap.active &&
      cap.allowedRelationships.includes('CL') &&
      cap.profiles.some((p) => workProfiles.has(p)),
  );
}

/**
 * Checks whether a capacity is typical for the current work type (i.e. 'ALL' or in workType's profiles).
 */
export function isCapacityTypicalForWorkType(
  taxonomy: MatterPartyTaxonomy,
  capacityCode: string,
  workTypeSubcategoryId: string | null | undefined,
): boolean {
  if (!workTypeSubcategoryId) return true;
  const cap = taxonomy.capacities.find((c) => c.code === capacityCode);
  if (!cap) return true;
  if (cap.profiles.includes('ALL')) return true;
  const workProfiles = new Set<WorkTypeProfileCode>(
    getProfilesForWorkType(taxonomy, workTypeSubcategoryId),
  );
  return cap.profiles.some((p) => workProfiles.has(p));
}

export function formatPartyRoleDisplay(
  taxonomy: MatterPartyTaxonomy,
  relationshipCode: string | undefined,
  capacityCodes: string[] | undefined,
  fallbackRole?: string,
): string {
  if (!relationshipCode && (!capacityCodes || capacityCodes.length === 0)) {
    return fallbackRole || 'Other party';
  }
  const rel = taxonomy.relationships.find((r) => r.code === relationshipCode);
  const capLabels = (capacityCodes ?? [])
    .map((code) => taxonomy.capacities.find((c) => c.code === code)?.label ?? code)
    .filter(Boolean);
  if (rel && capLabels.length > 0) {
    return `${rel.label} · ${capLabels.join(', ')}`;
  }
  if (rel) return rel.label;
  if (capLabels.length > 0) return capLabels.join(', ');
  return fallbackRole || 'Other party';
}

export function mapRelationshipToLegacyConflictRole(
  relationshipCode: string | undefined,
): ConflictCheckParty['role'] {
  switch (relationshipCode) {
    case 'CL':
    case 'JC':
      return 'Client';
    case 'CC':
      return 'Client contact';
    case 'OP':
    case 'CP':
      return 'Opponent';
    case 'CO':
      return 'Opposing solicitor';
    case 'NO':
    case 'TP':
    default:
      return 'Other party';
  }
}

export interface MatterPartyUsageCounts {
  byRelationshipCode: Record<string, number>;
  byCapacityCode: Record<string, number>;
  byWorkTypeSubcategoryId: Record<string, number>;
}

export function computeMatterPartyUsageCounts(matters: Matter[]): MatterPartyUsageCounts {
  const byRelationshipCode: Record<string, number> = {};
  const byCapacityCode: Record<string, number> = {};
  const byWorkTypeSubcategoryId: Record<string, number> = {};

  const incrementRel = (code?: string | null) => {
    if (!code) return;
    byRelationshipCode[code] = (byRelationshipCode[code] ?? 0) + 1;
  };
  const incrementCaps = (codes?: string[] | null) => {
    if (!codes) return;
    for (const c of codes) {
      if (!c) continue;
      byCapacityCode[c] = (byCapacityCode[c] ?? 0) + 1;
    }
  };

  for (const m of matters) {
    if (m.mergedIntoId) continue;
    if (m.workTypeSubcategoryId) {
      byWorkTypeSubcategoryId[m.workTypeSubcategoryId] =
        (byWorkTypeSubcategoryId[m.workTypeSubcategoryId] ?? 0) + 1;
    }
    // Every matter has a lead client (CL)
    if (m.clientId) {
      incrementRel('CL');
      const clientCaps = m.fieldValues?.['clientCapacityCodes'] as string[] | undefined;
      incrementCaps(clientCaps);
    }
    // Additional clients (JC)
    if (m.additionalClientIds?.length) {
      const jcCapsMap =
        (m.fieldValues?.['jointClientCapacityCodes'] as Record<string, string[]> | undefined) ?? {};
      for (const jcId of m.additionalClientIds) {
        incrementRel('JC');
        incrementCaps(jcCapsMap[jcId]);
      }
    }
    // Instructing contact (CC)
    if (m.instructingContactId && m.instructingContactId !== m.clientId) {
      incrementRel('CC');
      const instCaps = (m.fieldValues?.['instructingContactCapacityCodes'] as string[] | undefined) ?? [
        'CAP_REPRESENTATIVE',
        'CAP_DECISION_MAKER',
      ];
      incrementCaps(instCaps);
    }
    // Matter parties
    const seenPartyIds = new Set<string>();
    for (const p of m.parties ?? []) {
      seenPartyIds.add(p.id);
      incrementRel(p.relationshipCode);
      incrementCaps(p.capacityCodes);
    }
    for (const cp of m.conflictCheckRecord?.parties ?? []) {
      if (cp.isClientFixed || seenPartyIds.has(cp.id)) continue;
      incrementRel(cp.relationshipCode);
      incrementCaps(cp.capacityCodes);
    }
  }

  return {
    byRelationshipCode,
    byCapacityCode,
    byWorkTypeSubcategoryId,
  };
}

/**
 * Maps a legacy role string to the new two-field model according to Part 1.5.
 */
export function mapLegacyPartyRoleToTwoField(
  rawLegacyRole: string,
  matter?: Pick<Matter, 'workTypeSubcategoryId' | 'fieldValues' | 'title'> | null,
): {
  canonicalLegacyRole: string;
  relationshipCode: string;
  capacityCodes: string[];
  capacityLabel: string;
  needsCapacityPrompt: boolean;
} {
  const roleTrimmed = (rawLegacyRole || '').trim();
  const lower = roleTrimmed.toLowerCase();

  // Check exact / canonical table from Part 1.5 first:
  if (lower === 'instructing client' || lower === 'client') {
    const inferredCap = inferClientCapacityForMatter(matter);
    return {
      canonicalLegacyRole: 'Instructing client',
      relationshipCode: 'CL',
      capacityCodes: inferredCap ? [inferredCap.code] : [],
      capacityLabel: inferredCap ? `${inferredCap.label} (set per matter)` : '(set per matter)',
      needsCapacityPrompt: !inferredCap,
    };
  }
  if (lower === 'client representative') {
    return {
      canonicalLegacyRole: 'Client representative',
      relationshipCode: 'CC',
      capacityCodes: ['CAP_REPRESENTATIVE'],
      capacityLabel: 'Representative',
      needsCapacityPrompt: false,
    };
  }
  if (lower === 'client contact' || lower.startsWith('client contact')) {
    return {
      canonicalLegacyRole: 'Client contact',
      relationshipCode: 'CC',
      capacityCodes: ['CAP_REPRESENTATIVE'],
      capacityLabel: 'Representative',
      needsCapacityPrompt: false,
    };
  }
  if (lower === 'decision-maker' || lower === 'decision maker') {
    return {
      canonicalLegacyRole: 'Decision-maker',
      relationshipCode: 'CC',
      capacityCodes: ['CAP_DECISION_MAKER'],
      capacityLabel: 'Decision-maker / authorised signatory',
      needsCapacityPrompt: false,
    };
  }
  if (lower === 'opposing party' || lower === 'opponent') {
    return {
      canonicalLegacyRole: 'Opposing party / "Opponent"',
      relationshipCode: 'OP',
      capacityCodes: [],
      capacityLabel: '(none; prompt user to add)',
      needsCapacityPrompt: true,
    };
  }
  if (
    lower === 'opposing solicitor' ||
    lower === 'lead opposing solicitor' ||
    lower.includes('opposing solicitor')
  ) {
    return {
      canonicalLegacyRole: 'Opposing solicitor',
      relationshipCode: 'CO',
      capacityCodes: ['CAP_SOLICITOR'],
      capacityLabel: 'Solicitor',
      needsCapacityPrompt: false,
    };
  }
  if (lower === 'counterparty' || lower.includes('counterparty')) {
    return {
      canonicalLegacyRole: 'Counterparty',
      relationshipCode: 'CP',
      capacityCodes: [],
      capacityLabel: '(none; prompt user to add)',
      needsCapacityPrompt: true,
    };
  }
  if (
    lower === 'barrister / counsel' ||
    lower === 'leading counsel' ||
    lower.includes('barrister') ||
    lower.includes('counsel') ||
    lower.includes('chambers')
  ) {
    return {
      canonicalLegacyRole: 'Barrister / counsel',
      relationshipCode: 'CC',
      capacityCodes: ['CAP_BARRISTER_COUNSEL'],
      capacityLabel: 'Barrister / counsel',
      needsCapacityPrompt: false,
    };
  }
  if (
    lower === 'expert witness' ||
    lower.includes('expert')
  ) {
    return {
      canonicalLegacyRole: 'Expert witness',
      relationshipCode: 'CC',
      capacityCodes: ['CAP_EXPERT_WITNESS'],
      capacityLabel: 'Expert witness',
      needsCapacityPrompt: false,
    };
  }
  if (
    lower === 'professional adviser' ||
    lower.includes('adviser') ||
    lower.includes('tax partner') ||
    lower.includes('accountant') ||
    lower.includes('search provider')
  ) {
    return {
      canonicalLegacyRole: 'Professional adviser',
      relationshipCode: 'CC',
      capacityCodes: ['CAP_OTHER_PROFESSIONAL_ADVISER'],
      capacityLabel: 'Other professional adviser',
      needsCapacityPrompt: false,
    };
  }
  if (lower === 'witness' || lower === 'witness of fact') {
    return {
      canonicalLegacyRole: 'Witness',
      relationshipCode: 'TP',
      capacityCodes: ['CAP_WITNESS_OF_FACT'],
      capacityLabel: 'Witness of fact',
      needsCapacityPrompt: false,
    };
  }
  if (lower === 'court / tribunal' || lower.includes('court') || lower.includes('tribunal')) {
    return {
      canonicalLegacyRole: 'Court / tribunal',
      relationshipCode: 'NO',
      capacityCodes: ['CAP_COURT_TRIBUNAL'],
      capacityLabel: 'Court / tribunal',
      needsCapacityPrompt: false,
    };
  }
  if (
    lower === 'regulator / public authority' ||
    lower.includes('regulator') ||
    lower.includes('public authority')
  ) {
    return {
      canonicalLegacyRole: 'Regulator / public authority',
      relationshipCode: 'NO',
      capacityCodes: ['CAP_REGULATOR'],
      capacityLabel: 'Regulator',
      needsCapacityPrompt: false,
    };
  }
  return {
    canonicalLegacyRole: 'Other party',
    relationshipCode: 'TP',
    capacityCodes: [],
    capacityLabel: '(none; prompt user to add)',
    needsCapacityPrompt: true,
  };
}

export function inferClientCapacityForMatter(
  matter?: Pick<Matter, 'workTypeSubcategoryId' | 'fieldValues' | 'title'> | null,
): { code: string; label: string } | null {
  if (!matter) return null;
  const fv = matter.fieldValues ?? {};
  // Check explicit matter fields first
  const re03Role = String(fv['RE03-02'] ?? '').toLowerCase();
  if (re03Role.includes('landlord')) return { code: 'CAP_LANDLORD', label: 'Landlord' };
  if (re03Role.includes('tenant')) return { code: 'CAP_TENANT', label: 'Tenant' };

  const re01Role = String(fv['RE01-01'] ?? '').toLowerCase();
  if (re01Role.includes('purchase')) return { code: 'CAP_BUYER_ACQUIRER', label: 'Buyer / acquirer' };
  if (re01Role.includes('sale')) return { code: 'CAP_SELLER', label: 'Seller' };

  const cc03Role = String(fv['CC03-02'] ?? '').toLowerCase();
  if (cc03Role.includes('buyer')) return { code: 'CAP_BUYER_ACQUIRER', label: 'Buyer / acquirer' };
  if (cc03Role.includes('seller')) return { code: 'CAP_SELLER', label: 'Seller' };

  const fg02Role = String(fv['FG02-001'] ?? '').toLowerCase();
  if (fg02Role.includes('claimant')) return { code: 'CAP_CLAIMANT', label: 'Claimant' };
  if (fg02Role.includes('respondent')) return { code: 'CAP_RESPONDENT', label: 'Respondent' };
  if (fg02Role.includes('defendant')) return { code: 'CAP_DEFENDANT', label: 'Defendant' };
  if (fg02Role.includes('applicant')) return { code: 'CAP_APPLICANT', label: 'Applicant' };

  const subId = (matter.workTypeSubcategoryId ?? '').toLowerCase();
  const title = (matter.title ?? '').toLowerCase();
  if (subId.includes('wills_and_codicils')) return { code: 'CAP_TESTATOR', label: 'Testator' };
  if (subId.includes('lasting_powers_of_attorney')) return { code: 'CAP_DONOR_LPA', label: 'Donor (LPA)' };
  if (subId.includes('trusts_and_settlements')) return { code: 'CAP_SETTLOR', label: 'Settlor' };
  if (subId.includes('estate_administration')) return { code: 'CAP_EXECUTOR', label: 'Executor' };
  if (subId.includes('mergers_and_acquisitions') || title.includes('acquisition') || title.includes('purchase')) {
    return { code: 'CAP_BUYER_ACQUIRER', label: 'Buyer / acquirer' };
  }
  if (subId.includes('landlord_and_tenant') || title.includes('lease')) {
    return { code: 'CAP_LANDLORD', label: 'Landlord' };
  }
  if (subId.includes('development_and_planning')) {
    return { code: 'CAP_CONTRACTOR_DEVELOPER', label: 'Contractor / developer' };
  }
  if (subId.includes('company_formations_and_structures')) {
    return { code: 'CAP_SHAREHOLDER_MEMBER', label: 'Shareholder / member' };
  }
  return null;
}

const CANONICAL_MIGRATION_TABLE: Array<{
  key: string;
  legacyRole: string;
  relationshipCode: string;
  capacityCode: string | null;
  capacityLabel: string;
}> = [
  {
    key: 'Instructing client',
    legacyRole: 'Instructing client',
    relationshipCode: 'CL',
    capacityCode: null,
    capacityLabel: '(set per matter)',
  },
  {
    key: 'Client representative',
    legacyRole: 'Client representative',
    relationshipCode: 'CC',
    capacityCode: 'CAP_REPRESENTATIVE',
    capacityLabel: 'Representative',
  },
  {
    key: 'Decision-maker',
    legacyRole: 'Decision-maker',
    relationshipCode: 'CC',
    capacityCode: 'CAP_DECISION_MAKER',
    capacityLabel: 'Decision-maker / authorised signatory',
  },
  {
    key: 'Opposing party / "Opponent"',
    legacyRole: 'Opposing party / "Opponent"',
    relationshipCode: 'OP',
    capacityCode: null,
    capacityLabel: '(none; prompt user to add)',
  },
  {
    key: 'Opposing solicitor',
    legacyRole: 'Opposing solicitor',
    relationshipCode: 'CO',
    capacityCode: 'CAP_SOLICITOR',
    capacityLabel: 'Solicitor',
  },
  {
    key: 'Counterparty',
    legacyRole: 'Counterparty',
    relationshipCode: 'CP',
    capacityCode: null,
    capacityLabel: '(none; prompt user to add)',
  },
  {
    key: 'Barrister / counsel',
    legacyRole: 'Barrister / counsel',
    relationshipCode: 'CC',
    capacityCode: 'CAP_BARRISTER_COUNSEL',
    capacityLabel: 'Barrister / counsel',
  },
  {
    key: 'Expert witness',
    legacyRole: 'Expert witness',
    relationshipCode: 'CC',
    capacityCode: 'CAP_EXPERT_WITNESS',
    capacityLabel: 'Expert witness',
  },
  {
    key: 'Professional adviser',
    legacyRole: 'Professional adviser',
    relationshipCode: 'CC',
    capacityCode: 'CAP_OTHER_PROFESSIONAL_ADVISER',
    capacityLabel: 'Other professional adviser',
  },
  {
    key: 'Witness',
    legacyRole: 'Witness',
    relationshipCode: 'TP',
    capacityCode: 'CAP_WITNESS_OF_FACT',
    capacityLabel: 'Witness of fact',
  },
  {
    key: 'Court / tribunal',
    legacyRole: 'Court / tribunal',
    relationshipCode: 'NO',
    capacityCode: 'CAP_COURT_TRIBUNAL',
    capacityLabel: 'Court / tribunal',
  },
  {
    key: 'Regulator / public authority',
    legacyRole: 'Regulator / public authority',
    relationshipCode: 'NO',
    capacityCode: 'CAP_REGULATOR',
    capacityLabel: 'Regulator',
  },
  {
    key: 'Other party',
    legacyRole: '"Other party"',
    relationshipCode: 'TP',
    capacityCode: null,
    capacityLabel: '(none; prompt user to add)',
  },
  {
    key: 'Client contact',
    legacyRole: '"Client contact"',
    relationshipCode: 'CC',
    capacityCode: 'CAP_REPRESENTATIVE',
    capacityLabel: 'Representative',
  },
];

/**
 * Migrates legacy `matter_party_role` choice values (marking them inactive without deleting them)
 * and migrates all existing parties on matters (`matter.parties` and `matter.conflictCheckRecord?.parties`)
 * to the two-field Relationship + Capacity model, returning a migration report with counts per mapping.
 */
export function migrateMatterPartiesToTwoFieldModel(
  values: ChoiceValue[],
  matters: Matter[],
  taxonomy: MatterPartyTaxonomy,
  nowIso: string = new Date().toISOString(),
): {
  values: ChoiceValue[];
  matters: Matter[];
  report: MatterPartyMigrationReport;
} {
  let deactivatedLegacyRolesCount = 0;
  const nextValues = values.map((v) => {
    if (v.listKey === 'matter_party_role') {
      if (v.active) deactivatedLegacyRolesCount++;
      return {
        ...v,
        active: false,
      };
    }
    return v;
  });

  const countsByMapping: Record<string, MatterPartyMigrationMappingEntry> = {};
  for (const row of CANONICAL_MIGRATION_TABLE) {
    countsByMapping[row.key] = {
      legacyRole: row.legacyRole,
      relationshipCode: row.relationshipCode,
      capacityCode: row.capacityCode,
      capacityLabel: row.capacityLabel,
      count: 0,
    };
  }

  const recordMappingHit = (canonicalKey: string) => {
    if (countsByMapping[canonicalKey]) {
      countsByMapping[canonicalKey].count += 1;
    }
  };

  let migratedMatterPartiesCount = 0;
  let migratedConflictPartiesCount = 0;

  const nextMatters = matters.map((m) => {
    const nextFieldValues = { ...(m.fieldValues ?? {}) };

    // Ensure client capacity is set per matter on migration
    if (!nextFieldValues['clientCapacityCodes']) {
      const inferred = inferClientCapacityForMatter(m);
      if (inferred) {
        nextFieldValues['clientCapacityCodes'] = [inferred.code];
      }
      recordMappingHit('Instructing client');
    }

    // Ensure instructing contact default capacities are recorded if instructingContactId is present
    if (
      m.instructingContactId &&
      m.instructingContactId !== m.clientId &&
      !nextFieldValues['instructingContactCapacityCodes']
    ) {
      nextFieldValues['instructingContactCapacityCodes'] = [
        'CAP_REPRESENTATIVE',
        'CAP_DECISION_MAKER',
      ];
      recordMappingHit('Client contact');
    }

    // Find first OP or CP party id for default CO connection
    const nextParties: MatterParty[] = (m.parties ?? []).map((p) => {
      if (p.relationshipCode) {
        return {
          ...p,
          alignment: p.alignment ?? getRelationshipAlignment(p.relationshipCode),
        };
      }
      const mapped = mapLegacyPartyRoleToTwoField(p.role, m);
      recordMappingHit(mapped.canonicalLegacyRole);
      migratedMatterPartiesCount++;
      const entityType =
        p.entityType ??
        (p.linkedRecordId?.startsWith('P-')
          ? 'person'
          : p.linkedRecordId?.startsWith('O-')
            ? 'organisation'
            : p.name.toLowerCase().includes('ltd') ||
                p.name.toLowerCase().includes('llp') ||
                p.name.toLowerCase().includes('plc') ||
                p.name.toLowerCase().includes('solicitors') ||
                p.name.toLowerCase().includes('chambers') ||
                p.name.toLowerCase().includes('tribunal') ||
                p.name.toLowerCase().includes('court') ||
                p.name.toLowerCase().includes('association')
              ? 'organisation'
              : 'person');

      return {
        ...p,
        entityType,
        relationshipCode: mapped.relationshipCode,
        capacityCodes: mapped.capacityCodes,
        needsCapacityPrompt: mapped.needsCapacityPrompt,
        alignment: getRelationshipAlignment(mapped.relationshipCode),
        role: formatPartyRoleDisplay(
          taxonomy,
          mapped.relationshipCode,
          mapped.capacityCodes,
          p.role,
        ),
      };
    });

    // Connect CO / CC parties if not already connected
    const firstAdverseParty = nextParties.find(
      (p) => p.relationshipCode === 'OP' || p.relationshipCode === 'CP',
    );
    const finalizedParties = nextParties.map((p) => {
      if (p.connectedToPartyId !== undefined) return p;
      if (p.relationshipCode === 'CC') {
        return { ...p, connectedToPartyId: `client-${m.clientId}` };
      }
      if (p.relationshipCode === 'CO' && firstAdverseParty) {
        return { ...p, connectedToPartyId: firstAdverseParty.id };
      }
      return p;
    });

    let nextConflictRecord = m.conflictCheckRecord;
    if (m.conflictCheckRecord?.parties) {
      const nextConflictParties: ConflictCheckParty[] = m.conflictCheckRecord.parties.map((cp) => {
        if (cp.relationshipCode) {
          return {
            ...cp,
            alignment: cp.alignment ?? getRelationshipAlignment(cp.relationshipCode),
          };
        }
        const mapped = mapLegacyPartyRoleToTwoField(cp.role, m);
        migratedConflictPartiesCount++;
        return {
          ...cp,
          relationshipCode: mapped.relationshipCode,
          capacityCodes: mapped.capacityCodes,
          needsCapacityPrompt: mapped.needsCapacityPrompt,
          alignment: getRelationshipAlignment(mapped.relationshipCode),
        };
      });
      nextConflictRecord = {
        ...m.conflictCheckRecord,
        parties: nextConflictParties,
      };
    }

    return {
      ...m,
      fieldValues: nextFieldValues,
      parties: finalizedParties,
      conflictCheckRecord: nextConflictRecord,
    };
  });

  return {
    values: nextValues,
    matters: nextMatters,
    report: {
      migratedAt: nowIso,
      deactivatedLegacyRolesCount,
      migratedMatterPartiesCount,
      migratedConflictPartiesCount,
      countsByMapping,
    },
  };
}
