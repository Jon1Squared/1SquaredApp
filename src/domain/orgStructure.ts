/**
 * Managed Organisation Structure Reference Tables with parent hierarchy:
 * Legal Entity -> Division -> Department -> Team / Practice Group
 * Legal Entity -> Office
 * Department -> Cost Centre & Profit Centre
 */
import type {
  EmployeeRoleType,
  EngagementType,
  OrgCostCentre,
  OrgDepartment,
  OrgDivision,
  OrgLegalEntity,
  OrgOffice,
  OrgProfitCentre,
  OrgStructureCatalogue,
  OrgTeamOrPracticeGroup,
} from './types';

export const DEFAULT_LEGAL_ENTITY_ID = 'LE-PV-LLP';

export const DEFAULT_ORG_DEPARTMENTS: OrgDepartment[] = [
  {
    id: 'DEPT-RE',
    name: 'Real Estate',
    code: 'RE',
    parentDivisionId: 'DIV-LEGAL',
    defaultCostCentreId: 'CC-RE',
    defaultProfitCentreId: 'PC-RE',
    legacyChoiceValueId: 'department.real_estate',
    active: true,
  },
  {
    id: 'DEPT-CORP',
    name: 'Corporate & Commercial',
    code: 'CORP',
    parentDivisionId: 'DIV-LEGAL',
    defaultCostCentreId: 'CC-CORP',
    defaultProfitCentreId: 'PC-CORP',
    legacyChoiceValueId: 'department.corporate_and_commercial',
    active: true,
  },
  {
    id: 'DEPT-DR',
    name: 'Dispute Resolution',
    code: 'DR',
    parentDivisionId: 'DIV-LEGAL',
    defaultCostCentreId: 'CC-DR',
    defaultProfitCentreId: 'PC-DR',
    legacyChoiceValueId: 'department.dispute_resolution',
    active: true,
  },
  {
    id: 'DEPT-PC',
    name: 'Private Client',
    code: 'PC',
    parentDivisionId: 'DIV-LEGAL',
    defaultCostCentreId: 'CC-PC',
    defaultProfitCentreId: 'PC-PC',
    legacyChoiceValueId: 'department.private_client',
    active: true,
  },
  {
    id: 'DEPT-EMP',
    name: 'Employment',
    code: 'EMP',
    parentDivisionId: 'DIV-LEGAL',
    defaultCostCentreId: 'CC-EMP',
    defaultProfitCentreId: 'PC-EMP',
    legacyChoiceValueId: 'department.employment',
    active: true,
  },
  {
    id: 'DEPT-RISK',
    name: 'Risk & Compliance',
    code: 'RISK',
    parentDivisionId: 'DIV-BS',
    defaultCostCentreId: 'CC-RISK',
    defaultProfitCentreId: 'PC-CENTRAL',
    legacyChoiceValueId: 'department.risk_and_compliance',
    active: true,
  },
  {
    id: 'DEPT-FIN',
    name: 'Finance',
    code: 'FIN',
    parentDivisionId: 'DIV-BS',
    defaultCostCentreId: 'CC-FIN',
    defaultProfitCentreId: 'PC-CENTRAL',
    legacyChoiceValueId: 'department.finance',
    active: true,
  },
  {
    id: 'DEPT-BD',
    name: 'Business Development',
    code: 'BD',
    parentDivisionId: 'DIV-BS',
    defaultCostCentreId: 'CC-BD',
    defaultProfitCentreId: 'PC-CENTRAL',
    legacyChoiceValueId: 'department.business_development',
    active: true,
  },
  {
    id: 'DEPT-OPS',
    name: 'Operations',
    code: 'OPS',
    parentDivisionId: 'DIV-BS',
    defaultCostCentreId: 'CC-OPS',
    defaultProfitCentreId: 'PC-CENTRAL',
    legacyChoiceValueId: 'department.operations',
    active: true,
  },
  {
    id: 'DEPT-IT',
    name: 'IT & Systems',
    code: 'IT',
    parentDivisionId: 'DIV-BS',
    defaultCostCentreId: 'CC-IT',
    defaultProfitCentreId: 'PC-CENTRAL',
    legacyChoiceValueId: 'department.it_and_systems',
    active: true,
  },
  {
    id: 'DEPT-HR',
    name: 'People & HR',
    code: 'HR',
    parentDivisionId: 'DIV-BS',
    defaultCostCentreId: 'CC-HR',
    defaultProfitCentreId: 'PC-CENTRAL',
    legacyChoiceValueId: null,
    active: true,
  },
];

export const DEFAULT_ORG_OFFICES: OrgOffice[] = [
  {
    id: 'OFF-CDF',
    name: 'Cardiff',
    code: 'CDF',
    parentLegalEntityId: 'LE-PV-LLP',
    address: {
      id: 'addr-off-cdf',
      typeId: 'address_type.work',
      line1: '3 Bute Dock Chambers, Mount Stuart Square',
      line2: '',
      town: 'Cardiff',
      county: 'South Glamorgan',
      postcode: 'CF10 5FQ',
      countryId: 'country.united_kingdom',
    },
    active: true,
  },
  {
    id: 'OFF-BRI',
    name: 'Bristol',
    code: 'BRI',
    parentLegalEntityId: 'LE-PV-LLP',
    address: {
      id: 'addr-off-bri',
      typeId: 'address_type.work',
      line1: '21 Redcliffe Quay',
      line2: '',
      town: 'Bristol',
      county: 'Bristol',
      postcode: 'BS1 6HU',
      countryId: 'country.united_kingdom',
    },
    active: true,
  },
  {
    id: 'OFF-LON',
    name: 'London',
    code: 'LON',
    parentLegalEntityId: 'LE-PV-LLP',
    address: {
      id: 'addr-off-lon',
      typeId: 'address_type.work',
      line1: '9 Temple Row Chambers, Fleet Street',
      line2: '',
      town: 'London',
      county: 'Greater London',
      postcode: 'EC4Y 1AA',
      countryId: 'country.united_kingdom',
    },
    active: true,
  },
];

export function buildDefaultOrgStructure(options: {
  legalName: string;
  shortCode?: string;
}): OrgStructureCatalogue {
  const legalName = options?.legalName?.trim();
  if (!legalName) {
    throw new Error(
      'ORG_STRUCTURE_CONFIG_ERROR: options.legalName is required when building the default organisation structure.',
    );
  }
  const baseName =
    legalName.replace(/\s+(LLP|Ltd|Limited|PLC)$/i, '').trim() || legalName;
  const codePrefix = (
    options.shortCode?.trim() ||
    baseName.replace(/[^A-Za-z0-9]/g, '').toUpperCase() ||
    'FIRM'
  ).slice(0, 4);
  const legalEntities: OrgLegalEntity[] = [
    {
      id: 'LE-PV-LLP',
      name: legalName,
      code: `${codePrefix}LLP`,
      isDefault: true,
      active: true,
    },
    {
      id: 'LE-PV-SERV',
      name: `${baseName} Services Ltd`,
      code: `${codePrefix}SRV`,
      isDefault: false,
      active: true,
    },
    {
      id: 'LE-PV-TRUST',
      name: `${baseName} Trustees Ltd`,
      code: `${codePrefix}TRU`,
      isDefault: false,
      active: true,
    },
  ];

  const divisions: OrgDivision[] = [
    {
      id: 'DIV-LEGAL',
      name: 'Legal Practice',
      code: 'LEG',
      parentLegalEntityId: 'LE-PV-LLP',
      active: true,
    },
    {
      id: 'DIV-BS',
      name: 'Business Services',
      code: 'BSV',
      parentLegalEntityId: 'LE-PV-LLP',
      active: true,
    },
  ];

  const departments: OrgDepartment[] = DEFAULT_ORG_DEPARTMENTS.map((dept) => ({ ...dept }));

  const teamsOrPracticeGroups: OrgTeamOrPracticeGroup[] = [
    {
      id: 'TPG-RE-COMM',
      name: 'Commercial Property',
      code: 'RE-COM',
      parentDepartmentId: 'DEPT-RE',
      active: true,
    },
    {
      id: 'TPG-RE-RES',
      name: 'Residential Conveyancing',
      code: 'RE-RES',
      parentDepartmentId: 'DEPT-RE',
      active: true,
    },
    {
      id: 'TPG-RE-DEV',
      name: 'Property Development & Planning',
      code: 'RE-DEV',
      parentDepartmentId: 'DEPT-RE',
      active: true,
    },
    {
      id: 'TPG-CORP-MA',
      name: 'M&A and Corporate Finance',
      code: 'CORP-MA',
      parentDepartmentId: 'DEPT-CORP',
      active: true,
    },
    {
      id: 'TPG-CORP-COM',
      name: 'Commercial & Technology',
      code: 'CORP-COM',
      parentDepartmentId: 'DEPT-CORP',
      active: true,
    },
    {
      id: 'TPG-DR-COM',
      name: 'Commercial Litigation',
      code: 'DR-COM',
      parentDepartmentId: 'DEPT-DR',
      active: true,
    },
    {
      id: 'TPG-DR-PROP',
      name: 'Property Litigation',
      code: 'DR-PROP',
      parentDepartmentId: 'DEPT-DR',
      active: true,
    },
    {
      id: 'TPG-PC-WILLS',
      name: 'Wills, Trusts & Probate',
      code: 'PC-WTP',
      parentDepartmentId: 'DEPT-PC',
      active: true,
    },
    {
      id: 'TPG-PC-TAX',
      name: 'Private Wealth & Tax',
      code: 'PC-TAX',
      parentDepartmentId: 'DEPT-PC',
      active: true,
    },
    {
      id: 'TPG-EMP-ADV',
      name: 'Employment Advisory & Tribunals',
      code: 'EMP-ADV',
      parentDepartmentId: 'DEPT-EMP',
      active: true,
    },
    {
      id: 'TPG-RISK-AML',
      name: 'Conflicts, AML & Regulatory',
      code: 'RISK-AML',
      parentDepartmentId: 'DEPT-RISK',
      active: true,
    },
    {
      id: 'TPG-FIN-OPS',
      name: 'Billing, Credit Control & Cashiering',
      code: 'FIN-OPS',
      parentDepartmentId: 'DEPT-FIN',
      active: true,
    },
    {
      id: 'TPG-BD-INTAKE',
      name: 'Client Intake & Marketing',
      code: 'BD-INT',
      parentDepartmentId: 'DEPT-BD',
      active: true,
    },
    {
      id: 'TPG-OPS-SEC',
      name: 'Secretarial & Workplace Operations',
      code: 'OPS-SEC',
      parentDepartmentId: 'DEPT-OPS',
      active: true,
    },
    {
      id: 'TPG-IT-SYS',
      name: 'Business Systems & Infrastructure',
      code: 'IT-SYS',
      parentDepartmentId: 'DEPT-IT',
      active: true,
    },
    {
      id: 'TPG-HR-OPS',
      name: 'HR & Talent Development',
      code: 'HR-OPS',
      parentDepartmentId: 'DEPT-HR',
      active: true,
    },
  ];

  const offices: OrgOffice[] = DEFAULT_ORG_OFFICES.map((office) => ({
    ...office,
    address: { ...office.address },
  }));

  const costCentres: OrgCostCentre[] = [
    { id: 'CC-RE', code: 'CC-101', name: '101 · Real Estate', parentDepartmentId: 'DEPT-RE', active: true },
    { id: 'CC-CORP', code: 'CC-102', name: '102 · Corporate & Commercial', parentDepartmentId: 'DEPT-CORP', active: true },
    { id: 'CC-DR', code: 'CC-103', name: '103 · Dispute Resolution', parentDepartmentId: 'DEPT-DR', active: true },
    { id: 'CC-PC', code: 'CC-104', name: '104 · Private Client', parentDepartmentId: 'DEPT-PC', active: true },
    { id: 'CC-EMP', code: 'CC-105', name: '105 · Employment', parentDepartmentId: 'DEPT-EMP', active: true },
    { id: 'CC-RISK', code: 'CC-201', name: '201 · Risk & Compliance', parentDepartmentId: 'DEPT-RISK', active: true },
    { id: 'CC-FIN', code: 'CC-202', name: '202 · Finance', parentDepartmentId: 'DEPT-FIN', active: true },
    { id: 'CC-BD', code: 'CC-203', name: '203 · Business Development', parentDepartmentId: 'DEPT-BD', active: true },
    { id: 'CC-OPS', code: 'CC-204', name: '204 · Operations', parentDepartmentId: 'DEPT-OPS', active: true },
    { id: 'CC-IT', code: 'CC-205', name: '205 · IT & Systems', parentDepartmentId: 'DEPT-IT', active: true },
    { id: 'CC-HR', code: 'CC-206', name: '206 · People & HR', parentDepartmentId: 'DEPT-HR', active: true },
  ];

  const profitCentres: OrgProfitCentre[] = [
    { id: 'PC-RE', code: 'PC-101', name: 'PC-101 · Real Estate Practice', parentDepartmentId: 'DEPT-RE', active: true },
    { id: 'PC-CORP', code: 'PC-102', name: 'PC-102 · Corporate & Commercial Practice', parentDepartmentId: 'DEPT-CORP', active: true },
    { id: 'PC-DR', code: 'PC-103', name: 'PC-103 · Dispute Resolution Practice', parentDepartmentId: 'DEPT-DR', active: true },
    { id: 'PC-PC', code: 'PC-104', name: 'PC-104 · Private Client Practice', parentDepartmentId: 'DEPT-PC', active: true },
    { id: 'PC-EMP', code: 'PC-105', name: 'PC-105 · Employment Practice', parentDepartmentId: 'DEPT-EMP', active: true },
    { id: 'PC-CENTRAL', code: 'PC-900', name: 'PC-900 · Firm Central / Shared Services', parentDepartmentId: null, active: true },
  ];

  return {
    legalEntities,
    divisions,
    departments,
    teamsOrPracticeGroups,
    offices,
    costCentres,
    profitCentres,
    externalPayrollOnly: false,
    defaultProbationMonths: 6,
  };
}

/**
 * Maps a legacy `employee_role` choice value ID or label to the new `EmployeeRoleType` and default `EngagementType`.
 * Returns null if the role cannot be automatically mapped.
 */
export function mapLegacyEmployeeRoleToRoleType(
  employeeRoleIdOrLabel: string | null | undefined,
): { roleType: EmployeeRoleType; engagementType: EngagementType; legacyEmployeeRoleId: string } | null {
  if (!employeeRoleIdOrLabel) return null;
  const raw = employeeRoleIdOrLabel.trim().toLowerCase();

  if (raw === 'employee_role.partner' || raw === 'partner' || raw === 'partner/member') {
    return {
      roleType: 'Partner/Member',
      engagementType: 'LLP member',
      legacyEmployeeRoleId: 'employee_role.partner',
    };
  }
  if (raw === 'employee_role.fee_earner' || raw === 'fee earner') {
    return {
      roleType: 'Fee earner',
      engagementType: 'Employee',
      legacyEmployeeRoleId: 'employee_role.fee_earner',
    };
  }
  if (raw === 'trainee' || raw === 'employee_role.trainee') {
    return {
      roleType: 'Trainee',
      engagementType: 'Employee',
      legacyEmployeeRoleId: 'employee_role.fee_earner',
    };
  }
  if (raw === 'apprentice' || raw === 'employee_role.apprentice') {
    return {
      roleType: 'Apprentice',
      engagementType: 'Employee',
      legacyEmployeeRoleId: 'employee_role.support_staff',
    };
  }
  const businessServicesRoles: Record<string, string> = {
    'employee_role.practice_manager': 'employee_role.practice_manager',
    'practice manager': 'employee_role.practice_manager',
    'employee_role.business_development': 'employee_role.business_development',
    'business development': 'employee_role.business_development',
    'employee_role.risk_and_compliance': 'employee_role.risk_and_compliance',
    'risk and compliance': 'employee_role.risk_and_compliance',
    'employee_role.finance': 'employee_role.finance',
    finance: 'employee_role.finance',
    'employee_role.support_staff': 'employee_role.support_staff',
    'support staff': 'employee_role.support_staff',
    'employee_role.system_administrator': 'employee_role.system_administrator',
    'system administrator': 'employee_role.system_administrator',
    'business services': 'employee_role.support_staff',
  };
  if (businessServicesRoles[raw]) {
    return {
      roleType: 'Business services',
      engagementType: 'Employee',
      legacyEmployeeRoleId: businessServicesRoles[raw],
    };
  }
  return null;
}

/**
 * Maps a new `EmployeeRoleType` back to a compatible legacy `employeeRoleId` for backward compatibility
 * with components that read `person.employeeRoleId`.
 */
export function mapRoleTypeToLegacyEmployeeRoleId(
  roleType: EmployeeRoleType,
  existingEmployeeRoleId?: string | null,
): string {
  if (roleType === 'Partner/Member') return 'employee_role.partner';
  if (roleType === 'Fee earner' || roleType === 'Trainee') return 'employee_role.fee_earner';
  if (roleType === 'Apprentice') return 'employee_role.support_staff';
  // For Business services, preserve a more specific business service role if already set
  if (
    existingEmployeeRoleId &&
    existingEmployeeRoleId !== 'employee_role.partner' &&
    existingEmployeeRoleId !== 'employee_role.fee_earner'
  ) {
    return existingEmployeeRoleId;
  }
  return 'employee_role.support_staff';
}

/**
 * Maps a legacy `department` choice value ID or label, or an `OrgDepartment.id`, to an `OrgDepartment`.
 */
export function resolveOrgDepartment(
  deptIdOrLegacyId: string | null | undefined,
  orgStructure?: Pick<OrgStructureCatalogue, 'departments'>,
): OrgDepartment | null {
  if (!deptIdOrLegacyId) return null;
  const departments = orgStructure?.departments ?? DEFAULT_ORG_DEPARTMENTS;
  const trimmed = deptIdOrLegacyId.trim();
  const byId = departments.find((d) => d.id === trimmed);
  if (byId) return byId;
  const byLegacy = departments.find((d) => d.legacyChoiceValueId === trimmed);
  if (byLegacy) return byLegacy;
  const byName = departments.find(
    (d) => d.name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (byName) return byName;
  return null;
}

/**
 * Resolves the office from an address town or office ID/name.
 */
export function resolveOrgOffice(
  officeIdOrName: string | null | undefined,
  orgStructure?: Pick<OrgStructureCatalogue, 'offices'>,
): OrgOffice | null {
  if (!officeIdOrName) return null;
  const offices = orgStructure?.offices ?? DEFAULT_ORG_OFFICES;
  const trimmed = officeIdOrName.trim();
  return (
    offices.find(
      (o) =>
        o.id === trimmed ||
        o.name.toLowerCase() === trimmed.toLowerCase() ||
        o.code.toLowerCase() === trimmed.toLowerCase(),
    ) ?? null
  );
}
