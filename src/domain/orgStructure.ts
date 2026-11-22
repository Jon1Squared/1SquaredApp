/**
 * Managed Organisation Structure Reference Tables with parent hierarchy:
 * Legal Entity -> Division -> Department -> Team / Practice Group
 * Legal Entity -> Office
 * Department -> Cost Centre & Profit Centre
 */
import { z } from 'zod';
import type {
  ChoiceValue,
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

export const ORG_STRUCTURE_VALIDATION_ERROR_CODE =
  'ORG_STRUCTURE_VALIDATION_ERROR' as const;

const NonEmptyTrimmedStringSchema = z.string().trim().min(1);

const OrgLegalEntitySchema = z
  .object({
    id: NonEmptyTrimmedStringSchema,
    name: NonEmptyTrimmedStringSchema,
    code: NonEmptyTrimmedStringSchema,
    isDefault: z.boolean().optional(),
    active: z.boolean(),
  })
  .strict();

const OrgDivisionSchema = z
  .object({
    id: NonEmptyTrimmedStringSchema,
    name: NonEmptyTrimmedStringSchema,
    code: NonEmptyTrimmedStringSchema,
    parentLegalEntityId: NonEmptyTrimmedStringSchema,
    active: z.boolean(),
  })
  .strict();

const OrgDepartmentSchema = z
  .object({
    id: NonEmptyTrimmedStringSchema,
    name: NonEmptyTrimmedStringSchema,
    code: NonEmptyTrimmedStringSchema,
    parentDivisionId: NonEmptyTrimmedStringSchema,
    defaultCostCentreId: z.string().trim(),
    defaultProfitCentreId: z.string().trim(),
    legacyChoiceValueId: z.string().nullable().optional(),
    practiceAreaIds: z.array(NonEmptyTrimmedStringSchema).optional(),
    active: z.boolean(),
  })
  .strict();

const OrgTeamOrPracticeGroupSchema = z
  .object({
    id: NonEmptyTrimmedStringSchema,
    name: NonEmptyTrimmedStringSchema,
    code: NonEmptyTrimmedStringSchema,
    parentDepartmentId: NonEmptyTrimmedStringSchema,
    active: z.boolean(),
  })
  .strict();

const OrgAddressSchema = z
  .object({
    id: NonEmptyTrimmedStringSchema,
    typeId: z.string().nullable(),
    line1: z.string(),
    line2: z.string(),
    town: z.string(),
    county: z.string(),
    postcode: z.string(),
    countryId: z.string().nullable(),
  })
  .strict();

const OrgOfficeSchema = z
  .object({
    id: NonEmptyTrimmedStringSchema,
    name: NonEmptyTrimmedStringSchema,
    code: NonEmptyTrimmedStringSchema,
    parentLegalEntityId: NonEmptyTrimmedStringSchema,
    address: OrgAddressSchema,
    active: z.boolean(),
  })
  .strict();

const OrgCostCentreSchema = z
  .object({
    id: NonEmptyTrimmedStringSchema,
    code: NonEmptyTrimmedStringSchema,
    name: NonEmptyTrimmedStringSchema,
    parentDepartmentId: NonEmptyTrimmedStringSchema.nullable(),
    active: z.boolean(),
  })
  .strict();

const OrgProfitCentreSchema = z
  .object({
    id: NonEmptyTrimmedStringSchema,
    code: NonEmptyTrimmedStringSchema,
    name: NonEmptyTrimmedStringSchema,
    parentDepartmentId: NonEmptyTrimmedStringSchema.nullable(),
    active: z.boolean(),
  })
  .strict();

function assertUniqueOrgCollectionIds(
  items: ReadonlyArray<{ readonly id: string }>,
  collectionKey: keyof OrgStructureCatalogue,
  ctx: z.RefinementCtx,
): Set<string> {
  const ids = new Set<string>();
  items.forEach((item, index) => {
    if (ids.has(item.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [collectionKey, index, 'id'],
        message: `Duplicate ID "${item.id}" in ${String(collectionKey)}.`,
      });
    } else {
      ids.add(item.id);
    }
  });
  return ids;
}

export const OrgStructureCatalogueSchema = z
  .object({
    legalEntities: z.array(OrgLegalEntitySchema).min(1),
    divisions: z.array(OrgDivisionSchema),
    departments: z.array(OrgDepartmentSchema),
    teamsOrPracticeGroups: z.array(OrgTeamOrPracticeGroupSchema),
    offices: z.array(OrgOfficeSchema),
    costCentres: z.array(OrgCostCentreSchema),
    profitCentres: z.array(OrgProfitCentreSchema),
    externalPayrollOnly: z.boolean().optional(),
    defaultProbationMonths: z.number().int().min(0).max(60).optional(),
  })
  .strict()
  .superRefine((catalogue, ctx) => {
    const legalEntityIds = assertUniqueOrgCollectionIds(
      catalogue.legalEntities,
      'legalEntities',
      ctx,
    );
    const divisionIds = assertUniqueOrgCollectionIds(
      catalogue.divisions,
      'divisions',
      ctx,
    );
    const departmentIds = assertUniqueOrgCollectionIds(
      catalogue.departments,
      'departments',
      ctx,
    );
    assertUniqueOrgCollectionIds(
      catalogue.teamsOrPracticeGroups,
      'teamsOrPracticeGroups',
      ctx,
    );
    assertUniqueOrgCollectionIds(catalogue.offices, 'offices', ctx);
    const costCentreIds = assertUniqueOrgCollectionIds(
      catalogue.costCentres,
      'costCentres',
      ctx,
    );
    const profitCentreIds = assertUniqueOrgCollectionIds(
      catalogue.profitCentres,
      'profitCentres',
      ctx,
    );

    catalogue.divisions.forEach((div, index) => {
      if (!legalEntityIds.has(div.parentLegalEntityId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['divisions', index, 'parentLegalEntityId'],
          message: `Division "${div.id}" references missing legal entity parentLegalEntityId "${div.parentLegalEntityId}".`,
        });
      }
    });

    catalogue.offices.forEach((office, index) => {
      if (!legalEntityIds.has(office.parentLegalEntityId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['offices', index, 'parentLegalEntityId'],
          message: `Office "${office.id}" references missing legal entity parentLegalEntityId "${office.parentLegalEntityId}".`,
        });
      }
    });

    catalogue.departments.forEach((dept, index) => {
      if (!divisionIds.has(dept.parentDivisionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['departments', index, 'parentDivisionId'],
          message: `Department "${dept.id}" references missing division parentDivisionId "${dept.parentDivisionId}".`,
        });
      }
      if (
        dept.defaultCostCentreId &&
        !costCentreIds.has(dept.defaultCostCentreId)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['departments', index, 'defaultCostCentreId'],
          message: `Department "${dept.id}" references missing cost centre defaultCostCentreId "${dept.defaultCostCentreId}".`,
        });
      }
      if (
        dept.defaultProfitCentreId &&
        !profitCentreIds.has(dept.defaultProfitCentreId)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['departments', index, 'defaultProfitCentreId'],
          message: `Department "${dept.id}" references missing profit centre defaultProfitCentreId "${dept.defaultProfitCentreId}".`,
        });
      }
    });

    catalogue.teamsOrPracticeGroups.forEach((team, index) => {
      if (!departmentIds.has(team.parentDepartmentId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['teamsOrPracticeGroups', index, 'parentDepartmentId'],
          message: `Team/practice group "${team.id}" references missing department parentDepartmentId "${team.parentDepartmentId}".`,
        });
      }
    });

    catalogue.costCentres.forEach((cc, index) => {
      if (cc.parentDepartmentId && !departmentIds.has(cc.parentDepartmentId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['costCentres', index, 'parentDepartmentId'],
          message: `Cost centre "${cc.id}" references missing department parentDepartmentId "${cc.parentDepartmentId}".`,
        });
      }
    });

    catalogue.profitCentres.forEach((pc, index) => {
      if (pc.parentDepartmentId && !departmentIds.has(pc.parentDepartmentId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['profitCentres', index, 'parentDepartmentId'],
          message: `Profit centre "${pc.id}" references missing department parentDepartmentId "${pc.parentDepartmentId}".`,
        });
      }
    });
  });

/**
 * Validates a full organisation structure catalogue against the strict Zod schema,
 * duplicate ID constraints, and referential integrity rules (`R644`).
 */
export function validateOrgStructureCatalogue(
  input: unknown,
):
  | { ok: true; data: OrgStructureCatalogue }
  | {
      ok: false;
      code: typeof ORG_STRUCTURE_VALIDATION_ERROR_CODE;
      error: string;
    } {
  const parsed = OrgStructureCatalogueSchema.safeParse(input);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .slice(0, 5)
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : 'orgStructure';
        return `${path}: ${issue.message}`;
      })
      .join('; ');
    return {
      ok: false,
      code: ORG_STRUCTURE_VALIDATION_ERROR_CODE,
      error: `${ORG_STRUCTURE_VALIDATION_ERROR_CODE}: ${summary || 'Invalid organisation structure.'}`,
    };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Produces a deterministic, zero-PII structural summary for audit before/after entries (`R644`).
 */
export function formatOrgStructureAuditSummary(
  cat: OrgStructureCatalogue,
): string {
  const sortById = <T extends { id: string }>(items: readonly T[]): T[] =>
    [...items].sort((a, b) => a.id.localeCompare(b.id));
  const entities = sortById(cat.legalEntities)
    .map((e) => `${e.id}:${e.active ? '1' : '0'}`)
    .join(',');
  const divisions = sortById(cat.divisions)
    .map((d) => `${d.id}->${d.parentLegalEntityId}:${d.active ? '1' : '0'}`)
    .join(',');
  const departments = sortById(cat.departments)
    .map(
      (d) =>
        `${d.id}->${d.parentDivisionId}(pa=${(d.practiceAreaIds ?? []).length}):${d.active ? '1' : '0'}`,
    )
    .join(',');
  const teams = sortById(cat.teamsOrPracticeGroups)
    .map((t) => `${t.id}->${t.parentDepartmentId}:${t.active ? '1' : '0'}`)
    .join(',');
  const offices = sortById(cat.offices)
    .map((o) => `${o.id}->${o.parentLegalEntityId}:${o.active ? '1' : '0'}`)
    .join(',');
  return [
    `entities(${cat.legalEntities.length})=[${entities}]`,
    `divisions(${cat.divisions.length})=[${divisions}]`,
    `departments(${cat.departments.length})=[${departments}]`,
    `teams(${cat.teamsOrPracticeGroups.length})=[${teams}]`,
    `offices(${cat.offices.length})=[${offices}]`,
    `costCentres=${cat.costCentres.length}`,
    `profitCentres=${cat.profitCentres.length}`,
    `externalPayrollOnly=${Boolean(cat.externalPayrollOnly)}`,
    `defaultProbationMonths=${cat.defaultProbationMonths ?? 6}`,
  ].join('; ');
}

export const DEFAULT_LEGAL_ENTITY_ID = 'LE-PRIMARY';

export const DEFAULT_PRACTICE_AREA_DEPARTMENT_MAP: Readonly<
  Record<string, string>
> = {
  'work_type.real_estate_and_property': 'DEPT-RE',
  'work_type.corporate_and_commercial': 'DEPT-CORP',
  'work_type.finance_and_banking': 'DEPT-CORP',
  'work_type.intellectual_property': 'DEPT-CORP',
  'work_type.technology_and_digital': 'DEPT-CORP',
  'work_type.dispute_resolution': 'DEPT-DR',
  'work_type.private_client': 'DEPT-PC',
  'work_type.family': 'DEPT-PC',
  'work_type.employment_and_hr': 'DEPT-EMP',
  'work_type.regulatory_and_compliance': 'DEPT-RISK',
};

export const DEFAULT_ORG_DEPARTMENTS: OrgDepartment[] = [
  {
    id: 'DEPT-RE',
    name: 'Real Estate',
    code: 'RE',
    parentDivisionId: 'DIV-LEGAL',
    defaultCostCentreId: 'CC-RE',
    defaultProfitCentreId: 'PC-RE',
    legacyChoiceValueId: 'department.real_estate',
    practiceAreaIds: ['work_type.real_estate_and_property'],
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
    practiceAreaIds: [
      'work_type.corporate_and_commercial',
      'work_type.finance_and_banking',
      'work_type.intellectual_property',
      'work_type.technology_and_digital',
    ],
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
    practiceAreaIds: ['work_type.dispute_resolution'],
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
    practiceAreaIds: ['work_type.private_client', 'work_type.family'],
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
    practiceAreaIds: ['work_type.employment_and_hr'],
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
    practiceAreaIds: ['work_type.regulatory_and_compliance'],
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
    practiceAreaIds: [],
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
    practiceAreaIds: [],
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
    practiceAreaIds: [],
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
    practiceAreaIds: [],
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
    practiceAreaIds: [],
    active: true,
  },
];

/**
 * Neutral default offices array (empty until configured per tenant or populated
 * by tenant seed data; prevents demo office names leaking into clean builds).
 */
export const DEFAULT_ORG_OFFICES: OrgOffice[] = [];

export const DEFAULT_ORG_TEAMS_OR_PRACTICE_GROUPS: OrgTeamOrPracticeGroup[] = [
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

export function buildDefaultOrgStructure(options: {
  legalName: string;
  shortCode?: string;
  legalEntityIds?: {
    primary?: string;
    services?: string;
    trust?: string;
  };
  offices?: OrgOffice[];
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
  const primaryId = options.legalEntityIds?.primary?.trim() || DEFAULT_LEGAL_ENTITY_ID;
  const servicesId = options.legalEntityIds?.services?.trim() || 'LE-SERV';
  const trustId = options.legalEntityIds?.trust?.trim() || 'LE-TRUST';

  const legalEntities: OrgLegalEntity[] = [
    {
      id: primaryId,
      name: legalName,
      code: `${codePrefix}LLP`,
      isDefault: true,
      active: true,
    },
    {
      id: servicesId,
      name: `${baseName} Services Ltd`,
      code: `${codePrefix}SRV`,
      isDefault: false,
      active: true,
    },
    {
      id: trustId,
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
      parentLegalEntityId: primaryId,
      active: true,
    },
    {
      id: 'DIV-BS',
      name: 'Business Services',
      code: 'BSV',
      parentLegalEntityId: primaryId,
      active: true,
    },
  ];

  const departments: OrgDepartment[] = DEFAULT_ORG_DEPARTMENTS.map((dept) => ({
    ...dept,
    practiceAreaIds: dept.practiceAreaIds ? [...dept.practiceAreaIds] : [],
  }));

  const teamsOrPracticeGroups: OrgTeamOrPracticeGroup[] =
    DEFAULT_ORG_TEAMS_OR_PRACTICE_GROUPS.map((tpg) => ({ ...tpg }));

  const offices: OrgOffice[] = (options.offices ?? DEFAULT_ORG_OFFICES).map(
    (office) => ({
      ...office,
      parentLegalEntityId: office.parentLegalEntityId || primaryId,
      address: { ...office.address },
    }),
  );

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
 * Maps an `employee_role` choice value ID or `metadata.systemKey` to the new `EmployeeRoleType` and default `EngagementType`.
 * Returns null if the role cannot be automatically mapped.
 */
export function mapLegacyEmployeeRoleToRoleType(
  employeeRoleId: string | null | undefined,
  values?: readonly ChoiceValue[],
): { roleType: EmployeeRoleType; engagementType: EngagementType; legacyEmployeeRoleId: string } | null {
  if (!employeeRoleId) return null;
  const trimmed = employeeRoleId.trim();
  const raw = trimmed.toLowerCase();

  if (values && values.length > 0) {
    const choiceVal = values.find(
      (v) => v.active && v.listKey === 'employee_role' && v.id === trimmed,
    );
    const sysKey = choiceVal?.systemKey?.trim().toLowerCase();
    if (sysKey === 'partner') {
      return {
        roleType: 'Partner/Member',
        engagementType: 'LLP member',
        legacyEmployeeRoleId: choiceVal!.id,
      };
    }
    if (sysKey === 'fee_earner' || sysKey === 'senior_solicitor' || sysKey === 'solicitor') {
      return {
        roleType: 'Fee earner',
        engagementType: 'Employee',
        legacyEmployeeRoleId: choiceVal!.id,
      };
    }
    if (sysKey === 'trainee_paralegal' || sysKey === 'trainee') {
      return {
        roleType: 'Trainee',
        engagementType: 'Employee',
        legacyEmployeeRoleId: choiceVal!.id,
      };
    }
    if (sysKey === 'apprentice') {
      return {
        roleType: 'Apprentice',
        engagementType: 'Employee',
        legacyEmployeeRoleId: choiceVal!.id,
      };
    }
    if (
      sysKey === 'practice_manager' ||
      sysKey === 'business_development' ||
      sysKey === 'risk_and_compliance' ||
      sysKey === 'finance' ||
      sysKey === 'support_staff' ||
      sysKey === 'system_administrator' ||
      sysKey === 'supervisor' ||
      sysKey === 'intake' ||
      sysKey === 'enquiries_coordinator'
    ) {
      return {
        roleType: 'Business services',
        engagementType: 'Employee',
        legacyEmployeeRoleId: choiceVal!.id,
      };
    }
  }

  if (raw === 'employee_role.partner') {
    return {
      roleType: 'Partner/Member',
      engagementType: 'LLP member',
      legacyEmployeeRoleId: 'employee_role.partner',
    };
  }
  if (
    raw === 'employee_role.fee_earner' ||
    raw === 'employee_role.solicitor' ||
    raw === 'employee_role.senior_solicitor'
  ) {
    return {
      roleType: 'Fee earner',
      engagementType: 'Employee',
      legacyEmployeeRoleId: 'employee_role.fee_earner',
    };
  }
  if (raw === 'employee_role.trainee' || raw === 'employee_role.trainee_paralegal') {
    return {
      roleType: 'Trainee',
      engagementType: 'Employee',
      legacyEmployeeRoleId: 'employee_role.fee_earner',
    };
  }
  if (raw === 'employee_role.apprentice') {
    return {
      roleType: 'Apprentice',
      engagementType: 'Employee',
      legacyEmployeeRoleId: 'employee_role.support_staff',
    };
  }
  const businessServicesRoleIds: Record<string, string> = {
    'employee_role.practice_manager': 'employee_role.practice_manager',
    'employee_role.business_development': 'employee_role.business_development',
    'employee_role.risk_and_compliance': 'employee_role.risk_and_compliance',
    'employee_role.finance': 'employee_role.finance',
    'employee_role.support_staff': 'employee_role.support_staff',
    'employee_role.system_administrator': 'employee_role.system_administrator',
    'employee_role.supervisor': 'employee_role.supervisor',
    'employee_role.intake': 'employee_role.intake',
    'employee_role.enquiries_coordinator': 'employee_role.enquiries_coordinator',
  };
  if (businessServicesRoleIds[raw]) {
    return {
      roleType: 'Business services',
      engagementType: 'Employee',
      legacyEmployeeRoleId: businessServicesRoleIds[raw],
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

/**
 * Resolves the owning `OrgDepartment` for a `work_type` top-level practice area.
 * Checks ChoiceValue `meta.departmentId`, then `OrgDepartment.practiceAreaIds`,
 * then canonical default mapping (`DEFAULT_PRACTICE_AREA_DEPARTMENT_MAP`),
 * then label/legacyChoiceValueId fallback.
 */
export function resolveDepartmentForPracticeArea(
  practiceAreaId: string | null | undefined,
  orgStructure?: Pick<OrgStructureCatalogue, 'departments'>,
  values: readonly Pick<ChoiceValue, 'id' | 'listKey' | 'label' | 'meta' | 'active'>[] = [],
  options?: { includeInactive?: boolean },
): OrgDepartment | null {
  if (!practiceAreaId) return null;
  const trimmed = practiceAreaId.trim();
  const allDepartments = orgStructure?.departments ?? DEFAULT_ORG_DEPARTMENTS;
  const departments = options?.includeInactive
    ? allDepartments
    : allDepartments.filter((d) => d.active);

  const paVal = values.find((v) => v.listKey === 'work_type' && v.id === trimmed);
  const explicitDeptId = paVal?.meta?.departmentId?.trim();
  if (explicitDeptId) {
    const matched = departments.find((d) => d.id === explicitDeptId);
    if (matched) return matched;
    if (!options?.includeInactive) {
      const existsInactive = allDepartments.find((d) => d.id === explicitDeptId);
      if (existsInactive) return null;
    }
  }

  const byPracticeAreaArray = departments.find((d) =>
    (d.practiceAreaIds ?? []).includes(trimmed),
  );
  if (byPracticeAreaArray) return byPracticeAreaArray;

  if (!options?.includeInactive) {
    const inactiveWithMapping = allDepartments.find(
      (d) => !d.active && (d.practiceAreaIds ?? []).includes(trimmed),
    );
    if (inactiveWithMapping) return null;
  }

  const canonicalDeptId = DEFAULT_PRACTICE_AREA_DEPARTMENT_MAP[trimmed];
  if (canonicalDeptId) {
    const byCanonical = departments.find((d) => d.id === canonicalDeptId);
    if (byCanonical) return byCanonical;
  }

  if (paVal) {
    const labelLower = paVal.label.trim().toLowerCase();
    const byName = departments.find(
      (d) => d.name.trim().toLowerCase() === labelLower,
    );
    if (byName) return byName;
  }

  return null;
}

/**
 * Returns top-level `work_type` practice areas mapped to the given `OrgDepartment.id`.
 */
export function resolvePracticeAreasForDepartment(
  departmentId: string | null | undefined,
  values: readonly Pick<ChoiceValue, 'id' | 'listKey' | 'label' | 'parentId' | 'sortOrder' | 'active' | 'meta'>[],
  orgStructure?: Pick<OrgStructureCatalogue, 'departments'>,
  options?: { includeInactive?: boolean },
): ChoiceValue[] {
  if (!departmentId) return [];
  const allDepartments = orgStructure?.departments ?? DEFAULT_ORG_DEPARTMENTS;
  const targetDept = allDepartments.find((d) => d.id === departmentId);
  if (targetDept && !targetDept.active && !options?.includeInactive) {
    return [];
  }

  return (values as ChoiceValue[])
    .filter((v) => {
      if (v.listKey !== 'work_type' || v.parentId) return false;
      if (!options?.includeInactive && !v.active) return false;
      const resolved = resolveDepartmentForPracticeArea(
        v.id,
        orgStructure,
        values,
        { includeInactive: options?.includeInactive },
      );
      return resolved?.id === departmentId;
    })
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Returns true when a `work_type` practice area or subcategory is active AND
 * (if mapped to an OrgDepartment) its mapped department is active (P13).
 */
export function isWorkTypeChoiceActive(
  workTypeChoiceId: string | null | undefined,
  values: readonly Pick<ChoiceValue, 'id' | 'listKey' | 'label' | 'parentId' | 'active' | 'meta'>[],
  orgStructure?: Pick<OrgStructureCatalogue, 'departments'>,
): boolean {
  if (!workTypeChoiceId) return false;
  const val = values.find((v) => v.listKey === 'work_type' && v.id === workTypeChoiceId);
  if (!val || !val.active) return false;

  const paId = val.parentId || val.id;
  const paVal = val.parentId
    ? values.find((v) => v.listKey === 'work_type' && v.id === val.parentId)
    : val;
  if (!paVal || !paVal.active) return false;

  const allDepartments = orgStructure?.departments ?? DEFAULT_ORG_DEPARTMENTS;
  const explicitDeptId =
    paVal.meta?.departmentId?.trim() ||
    allDepartments.find((d) => (d.practiceAreaIds ?? []).includes(paId))?.id ||
    DEFAULT_PRACTICE_AREA_DEPARTMENT_MAP[paId];
  if (explicitDeptId) {
    const dept = allDepartments.find((d) => d.id === explicitDeptId);
    if (dept && !dept.active) return false;
  }
  return true;
}

/**
 * Resolves synchronised active departments, active practice areas, and active
 * work-type subcategories across Admin, Intake, Quotes, and Matters (P13).
 */
export function resolveActiveWorkTypeHierarchy(
  values: readonly ChoiceValue[],
  orgStructure?: Pick<OrgStructureCatalogue, 'departments' | 'teamsOrPracticeGroups'>,
): {
  activeDepartments: OrgDepartment[];
  activePracticeAreas: ChoiceValue[];
  activeWorkTypesByPracticeArea: Record<string, ChoiceValue[]>;
  departmentByPracticeAreaId: Record<string, OrgDepartment>;
  defaultTeamIdByDepartmentId: Record<string, string>;
} {
  const departments = orgStructure?.departments ?? DEFAULT_ORG_DEPARTMENTS;
  const teams =
    orgStructure?.teamsOrPracticeGroups ?? DEFAULT_ORG_TEAMS_OR_PRACTICE_GROUPS;
  const activeDepartments = departments.filter((d) => d.active);
  const departmentByPracticeAreaId: Record<string, OrgDepartment> = {};
  const activePracticeAreas = values
    .filter((v) => {
      if (v.listKey !== 'work_type' || v.parentId) return false;
      return isWorkTypeChoiceActive(v.id, values, orgStructure);
    })
    .sort((a, b) => a.sortOrder - b.sortOrder);

  for (const pa of activePracticeAreas) {
    const dept = resolveDepartmentForPracticeArea(pa.id, orgStructure, values);
    if (dept) {
      departmentByPracticeAreaId[pa.id] = dept;
    }
  }

  const activePaIds = new Set(activePracticeAreas.map((pa) => pa.id));
  const activeWorkTypesByPracticeArea: Record<string, ChoiceValue[]> = {};
  for (const wt of values
    .filter(
      (v) =>
        v.listKey === 'work_type' &&
        Boolean(v.parentId) &&
        activePaIds.has(v.parentId!) &&
        v.active,
    )
    .sort((a, b) => a.sortOrder - b.sortOrder)) {
    const pid = wt.parentId!;
    if (!activeWorkTypesByPracticeArea[pid]) {
      activeWorkTypesByPracticeArea[pid] = [];
    }
    activeWorkTypesByPracticeArea[pid]!.push(wt);
  }

  const defaultTeamIdByDepartmentId: Record<string, string> = {};
  for (const dept of activeDepartments) {
    const firstTeam = teams.find(
      (t) => t.active && t.parentDepartmentId === dept.id,
    );
    if (firstTeam) {
      defaultTeamIdByDepartmentId[dept.id] = firstTeam.id;
    }
  }

  return {
    activeDepartments,
    activePracticeAreas,
    activeWorkTypesByPracticeArea,
    departmentByPracticeAreaId,
    defaultTeamIdByDepartmentId,
  };
}
