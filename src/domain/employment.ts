/**
 * Domain logic for Employment records, permissions, effective dating,
 * conversion paths (contact/client <-> employee <-> leaver), and migration.
 */
import { addDays, toIsoDate } from './dates';
import { resolveLabel } from './lists';
import { personDisplayName } from './names';
import {
  buildDefaultOrgStructure,
  DEFAULT_LEGAL_ENTITY_ID,
  mapLegacyEmployeeRoleToRoleType,
  mapRoleTypeToLegacyEmployeeRoleId,
  resolveOrgDepartment,
  resolveOrgOffice,
} from './orgStructure';
import type {
  ChargeOutRateHistoryEntry,
  ChoiceValue,
  ContractType,
  DiversityMonitoringAnswers,
  Email,
  EmergencyContact,
  EmployeeMigrationReport,
  EmployeePermission,
  EmployeeRoleType,
  EmployeeSensitiveRecord,
  EmploymentAssignmentHistoryEntry,
  EmploymentContractTerms,
  EmploymentFeeEarnerDetails,
  EmploymentPayrollDetails,
  EmploymentRecord,
  EmploymentRightToWork,
  EmploymentStatus,
  EmploymentSystemsAccess,
  EngagementType,
  Enquiry,
  Matter,
  Organisation,
  OrgStructureCatalogue,
  Person,
  Phone,
  PmsLink,
  Task,
  Team,
  UnmappedEmployeeMigrationItem,
} from './types';

export const ENGAGEMENT_TYPES: EngagementType[] = [
  'Employee',
  'LLP member',
  'Consultant',
  'Contractor',
  'Secondee',
];

export const EMPLOYMENT_STATUSES: EmploymentStatus[] = [
  'Pre-start',
  'Active',
  'On leave',
  'Serving notice',
  'Leaver',
];

export const EMPLOYEE_ROLE_TYPES: EmployeeRoleType[] = [
  'Fee earner',
  'Business services',
  'Trainee',
  'Apprentice',
  'Partner/Member',
];

export const CONTRACT_TYPES: ContractType[] = [
  'Permanent',
  'Fixed term',
  'Temporary',
  'Zero hours',
];

import {
  ALL_EMPLOYEE_PERMISSIONS as CORE_ALL_EMPLOYEE_PERMISSIONS,
  canPersonAccessMatter,
  resolvePersonPermissionSet,
  type ResolvePersonPermissionsOptions,
} from './rbac';

export const ALL_EMPLOYEE_PERMISSIONS: EmployeePermission[] = [
  ...CORE_ALL_EMPLOYEE_PERMISSIONS,
];

export const DIVERSITY_OPTIONS = {
  ageBand: ['Under 25', '25–34', '35–44', '45–54', '55–64', '65+', 'Prefer not to say'],
  genderIdentity: ['Female', 'Male', 'Non-binary', 'Other', 'Prefer not to say'],
  ethnicity: [
    'Asian or Asian British',
    'Black, African, Caribbean or Black British',
    'Mixed or Multiple ethnic groups',
    'White',
    'Other ethnic group',
    'Prefer not to say',
  ],
  disability: ['Yes', 'No', 'Prefer not to say'],
  sexualOrientation: [
    'Bisexual',
    'Gay or Lesbian',
    'Heterosexual / Straight',
    'Other',
    'Prefer not to say',
  ],
  religionOrBelief: [
    'No religion',
    'Buddhist',
    'Christian',
    'Hindu',
    'Jewish',
    'Muslim',
    'Sikh',
    'Any other religion or belief',
    'Prefer not to say',
  ],
  socioEconomicBackground: [
    'State school',
    'Independent / fee-paying school',
    'Attended school outside UK',
    'Prefer not to say',
  ],
  caringResponsibilities: ['Yes', 'No', 'Prefer not to say'],
} as const;

export function emptyDiversityAnswers(): DiversityMonitoringAnswers {
  return {
    ageBand: 'Prefer not to say',
    genderIdentity: 'Prefer not to say',
    ethnicity: 'Prefer not to say',
    disability: 'Prefer not to say',
    sexualOrientation: 'Prefer not to say',
    religionOrBelief: 'Prefer not to say',
    socioEconomicBackground: 'Prefer not to say',
    caringResponsibilities: 'Prefer not to say',
  };
}

export function isFeeEarnerRoleType(
  roleType: EmployeeRoleType | string | null | undefined,
): boolean {
  return (
    roleType === 'Fee earner' ||
    roleType === 'Trainee' ||
    roleType === 'Partner/Member'
  );
}

/**
 * Resolves the employee data permissions for a user by delegating to the single
 * central `@platform/core` permission resolver (`resolvePersonPermissionSet`, ADR-0010 & ADR-0011).
 *
 * All department grants (`DEPT-HR`, `DEPT-FIN`, `DEPT-RISK`, etc.) and relationship grants
 * come from tenant configuration (`rbac.departmentGrants` and `rbac.relationshipGrants`).
 * Supports unified `user.permissionOverrides` (`grant` / `revoke`) as well as transitional
 * `user.employeePermissions`.
 */
export function resolveEmployeePermissions(
  user: Person | null | undefined,
  allPeople: Person[] = [],
  teams: Team[] = [],
  rbacOptions?: ResolvePersonPermissionsOptions,
): EmployeePermission[] {
  if (!user) return [];
  const resolved = resolvePersonPermissionSet(user, {
    ...rbacOptions,
    allPeople,
    teams,
  });
  return ALL_EMPLOYEE_PERMISSIONS.filter((perm) => resolved.has(perm));
}

export function hasEmployeePermission(
  user: Person | null | undefined,
  perm: EmployeePermission,
  allPeople: Person[] = [],
  teams: Team[] = [],
  rbacOptions?: ResolvePersonPermissionsOptions,
): boolean {
  return resolveEmployeePermissions(
    user,
    allPeople,
    teams,
    rbacOptions,
  ).includes(perm);
}

/**
 * Strips restricted sections from an EmploymentRecord at the API/service boundary
 * based on the requesting user's permissions and firm configuration.
 */
export function filterEmploymentForUser(
  employment: EmploymentRecord | null | undefined,
  user: Person | null | undefined,
  allPeople: Person[] = [],
  teams: Team[] = [],
  orgStructure?: OrgStructureCatalogue,
  rbacOptions?: ResolvePersonPermissionsOptions,
): EmploymentRecord | null {
  if (!employment) return null;
  const perms = new Set(
    resolveEmployeePermissions(user, allPeople, teams, rbacOptions),
  );
  if (!perms.has('employee:view_core')) {
    return null;
  }

  const copy: EmploymentRecord = structuredClone(employment);

  if (!perms.has('employee:hr_restricted')) {
    delete copy.contract;
    delete copy.rightToWork;
    delete copy.emergencyContacts;
  }

  if (!perms.has('employee:payroll')) {
    delete copy.payroll;
  } else if (orgStructure?.externalPayrollOnly && copy.payroll) {
    copy.payroll = {
      externalPayrollReference: copy.payroll.externalPayrollReference,
      nationalInsuranceNumber: '',
      bankAccountName: '',
      bankSortCode: '',
      bankAccountNumber: '',
      buildingSocietyRollNumber: '',
      starterDeclarationOrP45: '',
      studentLoanPlan: '',
      pensionAutoEnrolmentStatus: '',
      pensionOptOutDate: null,
    };
  }

  return copy;
}

/**
 * Validates UK National Insurance Number format (e.g. QQ 12 34 56 C).
 */
export function validateNationalInsuranceNumber(nino: string): boolean {
  const clean = nino.replace(/\s+/g, '').toUpperCase();
  if (!clean) return true; // empty is allowed unless required
  // Standard HMRC NI format: two prefix letters (excluding D,F,I,Q,U,V; second also excluding O; not BG,GB,NK,KN,TN,NT,ZZ), 6 digits, A-D suffix
  const regex = /^(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]$/;
  return regex.test(clean);
}

export function maskNationalInsuranceNumber(nino: string): string {
  const clean = nino.replace(/\s+/g, '').toUpperCase();
  if (!clean) return '';
  if (clean.length <= 3) return '•••';
  return `${'•'.repeat(clean.length - 3)}${clean.slice(-3)}`;
}

export function maskBankDetails(
  sortCode: string,
  accountNumber: string,
): { sortCode: string; accountNumber: string } {
  const cleanSort = sortCode.replace(/[^0-9]/g, '');
  const cleanAcc = accountNumber.replace(/[^0-9]/g, '');
  return {
    sortCode: cleanSort.length >= 2 ? `••-••-${cleanSort.slice(-2)}` : cleanSort ? '••-••-••' : '',
    accountNumber:
      cleanAcc.length >= 4 ? `${'•'.repeat(Math.max(4, cleanAcc.length - 4))}${cleanAcc.slice(-4)}` : cleanAcc ? '••••••••' : '',
  };
}

/**
 * Calculates probation end date from a start date (YYYY-MM-DD) and period in months.
 */
export function calculateProbationEndDate(
  startDate: string | null | undefined,
  months: number = 6,
): string | null {
  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate.trim())) return null;
  const [y, m, d] = startDate.trim().split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  return dt.toISOString().slice(0, 10);
}

/**
 * Calculates statutory HR retention date (default 6 years after leaving date).
 */
export function calculateHrRetentionDate(
  leavingDate: string | null | undefined,
  retentionYears: number = 6,
): string | null {
  if (!leavingDate || !/^\d{4}-\d{2}-\d{2}$/.test(leavingDate.trim())) return null;
  const [y, m, d] = leavingDate.trim().split('-').map(Number);
  const dt = new Date(Date.UTC(y + retentionYears, m - 1, d));
  return dt.toISOString().slice(0, 10);
}

/**
 * Returns true if the person is currently working at the firm (or about to start).
 */
export function isWorkingAtFirm(person: Person | null | undefined): boolean {
  if (!person || person.mergedIntoId) return false;
  if (person.employment) {
    return person.employment.status !== 'Leaver';
  }
  return Boolean(person.isEmployee);
}

/**
 * Only people with employment status Active, On leave or Serving notice appear in employee selectors.
 * Pre-start and Leaver are excluded from active employee selectors.
 */
export function isSelectableInEmployeeDropdown(person: Person | null | undefined): boolean {
  if (!person || person.mergedIntoId) return false;
  if (person.employment) {
    return (
      person.employment.status === 'Active' ||
      person.employment.status === 'On leave' ||
      person.employment.status === 'Serving notice'
    );
  }
  return Boolean(person.isEmployee);
}

export function isLeaverPerson(person: Person | null | undefined): boolean {
  if (!person) return false;
  return person.employment?.status === 'Leaver';
}

export function formatEmployeeSelectorOptionLabel(
  person: Person,
  values: ChoiceValue[],
): string {
  const name = personDisplayName(person);
  const roleLabel =
    person.employment?.jobTitle ||
    person.employment?.roleType ||
    resolveLabel(values, person.employeeRoleId) ||
    '';
  const leftSuffix = isLeaverPerson(person) ? ' — Left' : '';
  const statusSuffix =
    person.employment?.status === 'On leave'
      ? ' · On leave'
      : person.employment?.status === 'Serving notice'
        ? ' · Serving notice'
        : '';
  if (roleLabel) {
    return `${name} (${roleLabel}${statusSuffix}${leftSuffix})`;
  }
  return `${name}${leftSuffix ? ` (Left)` : ''}`;
}

export interface LeaverOwnedRecordItem {
  leaverId: string;
  leaverName: string;
  leavingDate: string | null;
  recordType: 'person' | 'organisation' | 'matter' | 'task' | 'enquiry';
  recordId: string;
  recordLabel: string;
  roleField: string;
  roleLabel: string;
}

/**
 * Builds a report of all active records still owned by or assigned to leavers so they can be reassigned.
 */
export function findRecordsOwnedByLeavers(
  people: Person[],
  organisations: Organisation[] = [],
  matters: Matter[] = [],
  tasks: Task[] = [],
  enquiries: Enquiry[] = [],
  filterLeaverId?: string,
): LeaverOwnedRecordItem[] {
  const leavers = new Map<string, Person>();
  for (const p of people) {
    if (isLeaverPerson(p) && (!filterLeaverId || p.id === filterLeaverId)) {
      leavers.set(p.id, p);
    }
  }
  if (leavers.size === 0) return [];

  const items: LeaverOwnedRecordItem[] = [];
  const pushIfLeaver = (
    empId: string | null | undefined,
    recordType: LeaverOwnedRecordItem['recordType'],
    recordId: string,
    recordLabel: string,
    roleField: string,
    roleLabel: string,
  ) => {
    if (!empId) return;
    const leaver = leavers.get(empId);
    if (!leaver) return;
    items.push({
      leaverId: leaver.id,
      leaverName: personDisplayName(leaver),
      leavingDate: leaver.employment?.contract?.leavingDate ?? leaver.employment?.effectiveTo ?? null,
      recordType,
      recordId,
      recordLabel,
      roleField,
      roleLabel,
    });
  };

  for (const p of people) {
    if (p.mergedIntoId || p.id === filterLeaverId) continue;
    const label = personDisplayName(p);
    pushIfLeaver(p.relationshipOwnerId, 'person', p.id, label, 'relationshipOwnerId', 'Relationship owner');
    pushIfLeaver(p.recordOwnerId, 'person', p.id, label, 'recordOwnerId', 'Record owner');
    pushIfLeaver(p.verificationReviewerId, 'person', p.id, label, 'verificationReviewerId', 'Verification reviewer');
  }

  for (const o of organisations) {
    if (o.mergedIntoId) continue;
    pushIfLeaver(o.relationshipPartnerId, 'organisation', o.id, o.legalName, 'relationshipPartnerId', 'Relationship partner');
    pushIfLeaver(o.recordOwnerId, 'organisation', o.id, o.legalName, 'recordOwnerId', 'Record owner');
    pushIfLeaver(o.reviewerId, 'organisation', o.id, o.legalName, 'reviewerId', 'Compliance reviewer');
  }

  for (const m of matters) {
    const label = `${m.matterNumber} — ${m.title}`;
    pushIfLeaver(m.responsiblePartnerId, 'matter', m.id, label, 'responsiblePartnerId', 'Responsible partner');
    pushIfLeaver(m.supervisingPartnerId, 'matter', m.id, label, 'supervisingPartnerId', 'Supervising partner');
    pushIfLeaver(m.leadFeeEarnerId, 'matter', m.id, label, 'leadFeeEarnerId', 'Lead fee earner');
  }

  for (const t of tasks) {
    if (t.status === 'Done' || t.status === 'Cancelled') continue;
    pushIfLeaver(t.assignedPersonId, 'task', t.id, `${t.reference} — ${t.title}`, 'assignedPersonId', 'Assigned person');
  }

  for (const e of enquiries) {
    if (e.status === 'Converted' || e.status === 'Declined' || e.status === 'Referred out' || e.status === 'No response') {
      continue;
    }
    pushIfLeaver(
      e.assignedToId,
      'enquiry',
      e.id,
      `${e.reference} — ${e.firstName} ${e.lastName}`.trim(),
      'assignedToId',
      'Assigned to',
    );
  }

  return items;
}

/**
 * Validates an EmploymentRecord submission and returns field-keyed error messages.
 */
export function validateEmploymentRecord(
  employment: Partial<EmploymentRecord> | null | undefined,
  opts: {
    personId?: string;
    dateOfBirth?: string | null;
    allPeople: Person[];
    orgStructure?: OrgStructureCatalogue;
    requireContractStartDate?: boolean;
  },
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!employment) return errors;

  // Date of birth is mandatory when working at the firm
  if (!opts.dateOfBirth || !opts.dateOfBirth.trim()) {
    errors.dateOfBirth = 'Date of birth is required when a person works at the firm.';
  }

  if (!employment.engagementType) {
    errors.engagementType = 'Engagement type is required.';
  }
  if (!employment.status) {
    errors.status = 'Employment status is required.';
  }
  if (!employment.employeeNumber || !employment.employeeNumber.trim()) {
    errors.employeeNumber = 'Employee number is required.';
  } else {
    const cleanNum = employment.employeeNumber.trim().toUpperCase();
    const dupEmpNum = opts.allPeople.find(
      (p) =>
        p.id !== opts.personId &&
        !p.mergedIntoId &&
        p.employment?.employeeNumber?.trim().toUpperCase() === cleanNum,
    );
    if (dupEmpNum) {
      errors.employeeNumber = `Employee number ${employment.employeeNumber.trim()} is already assigned to ${personDisplayName(dupEmpNum)}.`;
    }
  }

  if (!employment.jobTitle || !employment.jobTitle.trim()) {
    errors.jobTitle = 'Job title at the firm is required.';
  }
  if (!employment.roleType) {
    errors.roleType = 'Role type is required.';
  }
  if (!employment.departmentId || !employment.departmentId.trim()) {
    errors.departmentId = 'Department is required.';
  }
  if (!employment.isTopOfHierarchy && !employment.lineManagerId) {
    errors.lineManagerId = 'Line manager is required unless the person is at the top of the hierarchy.';
  }

  // Contract validation (when contract section is provided)
  if (employment.contract) {
    if (opts.requireContractStartDate && !employment.contract.startDate?.trim()) {
      errors.startDate = 'Start date is required.';
    }
    if (
      employment.contract.contractType === 'Fixed term' &&
      !employment.contract.fixedTermEndDate?.trim()
    ) {
      errors.fixedTermEndDate = 'Fixed term end date is required for fixed-term contracts.';
    }
  }

  // Fee earner validation (only when roleType is Fee earner, Trainee, or Partner/Member)
  if (isFeeEarnerRoleType(employment.roleType) && employment.feeEarner) {
    const code = employment.feeEarner.timekeeperCode?.trim();
    if (code) {
      const dupCode = opts.allPeople.find(
        (p) =>
          p.id !== opts.personId &&
          !p.mergedIntoId &&
          p.employment?.feeEarner?.timekeeperCode?.trim().toUpperCase() === code.toUpperCase(),
      );
      if (dupCode) {
        errors.timekeeperCode = `Timekeeper code ${code} is already assigned to ${personDisplayName(dupCode)}.`;
      }
    }
  }

  // Payroll validation
  if (employment.payroll?.nationalInsuranceNumber?.trim()) {
    if (!validateNationalInsuranceNumber(employment.payroll.nationalInsuranceNumber)) {
      errors.nationalInsuranceNumber =
        'National Insurance number must follow valid UK format (e.g. QQ 12 34 56 C).';
    }
  }

  return errors;
}

/**
 * Applies effective-dated tracking when assignment fields (department, team, office,
 * line manager, grade, job title, roleType, FTE) or charge-out rate change.
 */
export function applyEffectiveDatedEmploymentHistory(
  existing: EmploymentRecord | null | undefined,
  incoming: EmploymentRecord,
  byId: string,
  nowIso: string = new Date().toISOString(),
): EmploymentRecord {
  const today = nowIso.slice(0, 10);
  const effectiveFrom = incoming.effectiveFrom || today;
  const fte = incoming.contract?.fte ?? 1.0;

  let assignmentHistory: EmploymentAssignmentHistoryEntry[] = Array.isArray(
    existing?.assignmentHistory,
  )
    ? structuredClone(existing!.assignmentHistory)
    : Array.isArray(incoming.assignmentHistory)
      ? structuredClone(incoming.assignmentHistory)
      : [];

  if (!existing) {
    if (assignmentHistory.length === 0) {
      assignmentHistory = [
        {
          id: `asgn-${Date.now()}-1`,
          effectiveFrom,
          effectiveTo: incoming.status === 'Leaver' ? incoming.effectiveTo ?? today : null,
          jobTitle: incoming.jobTitle,
          gradeOrBand: incoming.gradeOrBand,
          roleType: incoming.roleType,
          divisionId: incoming.divisionId,
          departmentId: incoming.departmentId,
          teamOrPracticeGroupId: incoming.teamOrPracticeGroupId,
          officeId: incoming.officeId,
          costCentreId: incoming.costCentreId,
          profitCentreId: incoming.profitCentreId,
          lineManagerId: incoming.lineManagerId,
          fte,
          changedById: byId,
          changedAt: nowIso,
        },
      ];
    }
  } else {
    const existingFte = existing.contract?.fte ?? 1.0;
    const assignmentChanged =
      existing.departmentId !== incoming.departmentId ||
      existing.divisionId !== incoming.divisionId ||
      existing.teamOrPracticeGroupId !== incoming.teamOrPracticeGroupId ||
      existing.officeId !== incoming.officeId ||
      existing.lineManagerId !== incoming.lineManagerId ||
      existing.gradeOrBand !== incoming.gradeOrBand ||
      existing.jobTitle !== incoming.jobTitle ||
      existing.roleType !== incoming.roleType ||
      existingFte !== fte;

    if (assignmentChanged) {
      // Close any open assignment period
      assignmentHistory = assignmentHistory.map((entry) =>
        entry.effectiveTo === null ? { ...entry, effectiveTo: effectiveFrom } : entry,
      );
      assignmentHistory.push({
        id: `asgn-${Date.now()}-${assignmentHistory.length + 1}`,
        effectiveFrom,
        effectiveTo: incoming.status === 'Leaver' ? incoming.effectiveTo ?? today : null,
        jobTitle: incoming.jobTitle,
        gradeOrBand: incoming.gradeOrBand,
        roleType: incoming.roleType,
        divisionId: incoming.divisionId,
        departmentId: incoming.departmentId,
        teamOrPracticeGroupId: incoming.teamOrPracticeGroupId,
        officeId: incoming.officeId,
        costCentreId: incoming.costCentreId,
        profitCentreId: incoming.profitCentreId,
        lineManagerId: incoming.lineManagerId,
        fte,
        changedById: byId,
        changedAt: nowIso,
      });
    } else if (assignmentHistory.length === 0) {
      assignmentHistory = [
        {
          id: `asgn-${Date.now()}-1`,
          effectiveFrom: existing.effectiveFrom || effectiveFrom,
          effectiveTo: incoming.status === 'Leaver' ? incoming.effectiveTo ?? today : null,
          jobTitle: incoming.jobTitle,
          gradeOrBand: incoming.gradeOrBand,
          roleType: incoming.roleType,
          divisionId: incoming.divisionId,
          departmentId: incoming.departmentId,
          teamOrPracticeGroupId: incoming.teamOrPracticeGroupId,
          officeId: incoming.officeId,
          costCentreId: incoming.costCentreId,
          profitCentreId: incoming.profitCentreId,
          lineManagerId: incoming.lineManagerId,
          fte,
          changedById: byId,
          changedAt: nowIso,
        },
      ];
    }
  }

  // Effective-dated charge-out rate history for fee earners
  const feeEarner = incoming.feeEarner ? structuredClone(incoming.feeEarner) : null;
  if (feeEarner && feeEarner.chargeOutRateGbp !== null && feeEarner.chargeOutRateGbp !== undefined) {
    const rateFrom = feeEarner.chargeOutRateEffectiveFrom || effectiveFrom;
    const prevRate = existing?.feeEarner?.chargeOutRateGbp ?? null;
    let rateHistory: ChargeOutRateHistoryEntry[] = Array.isArray(
      existing?.feeEarner?.chargeOutRateHistory,
    )
      ? structuredClone(existing!.feeEarner!.chargeOutRateHistory)
      : Array.isArray(feeEarner.chargeOutRateHistory)
        ? structuredClone(feeEarner.chargeOutRateHistory)
        : [];

    if (prevRate !== null && prevRate !== feeEarner.chargeOutRateGbp) {
      rateHistory = rateHistory.map((r) =>
        r.effectiveTo === null ? { ...r, effectiveTo: rateFrom } : r,
      );
      rateHistory.push({
        id: `rate-${Date.now()}-${rateHistory.length + 1}`,
        rateGbpPerHour: feeEarner.chargeOutRateGbp,
        effectiveFrom: rateFrom,
        effectiveTo: incoming.status === 'Leaver' ? incoming.effectiveTo ?? today : null,
        changedById: byId,
        changedAt: nowIso,
      });
    } else if (rateHistory.length === 0) {
      rateHistory = [
        {
          id: `rate-${Date.now()}-1`,
          rateGbpPerHour: feeEarner.chargeOutRateGbp,
          effectiveFrom: rateFrom,
          effectiveTo: incoming.status === 'Leaver' ? incoming.effectiveTo ?? today : null,
          changedById: byId,
          changedAt: nowIso,
        },
      ];
    }
    feeEarner.chargeOutRateEffectiveFrom = rateFrom;
    feeEarner.chargeOutRateHistory = rateHistory;
  }

  return {
    ...incoming,
    effectiveFrom,
    assignmentHistory,
    ...(feeEarner !== null ? { feeEarner } : {}),
  };
}

/**
 * Conversion path 1 (Contact or client -> Employee):
 * Checks whether the person is a party on any open matter so Risk can be flagged
 * to consider an information barrier.
 */
export function findOpenMattersWherePersonIsParty(
  personId: string,
  matters: Matter[],
): Matter[] {
  if (!personId) return [];
  const closedStatuses = new Set([
    'matter_status.closed',
    'matter_status.archived',
    'matter_status.aborted',
    'matter_status.completed',
  ]);
  return matters.filter((m) => {
    if (closedStatuses.has(m.matterStatusId)) return false;
    if (m.clientId === personId) return true;
    if (Array.isArray(m.additionalClientIds) && m.additionalClientIds.includes(personId)) return true;
    if (m.instructingContactId === personId) return true;
    if (m.billingContactId === personId) return true;
    if (m.referrerContactId === personId) return true;
    if (m.parties.some((pt) => pt.linkedRecordId === personId)) return true;
    if (m.conflictCheckRecord?.parties.some((pt) => pt.linkedRecordId === personId)) return true;
    return false;
  });
}

/**
 * Conversion path 2 (Employee -> Client):
 * Determines if a matter involves a current employee as a client, marking it as a staff matter
 * with restricted access so colleagues cannot browse it by default.
 *
 * ADR-0014: `restrictedAccessUserIds` stores ONLY the named matter participants
 * (`responsiblePartnerId`, `supervisingPartnerId`, `leadFeeEarnerId`, `teamMemberIds`).
 * Oversight role holders (`admin`, `managing_partner`, `risk_compliance`) are evaluated
 * dynamically via the `matter:restricted:access` permission rather than stored in the list.
 */
export function computeStaffMatterStatus(
  matter: {
    clientId: string;
    additionalClientIds?: string[];
    responsiblePartnerId?: string | null;
    supervisingPartnerId?: string | null;
    leadFeeEarnerId?: string | null;
    teamMemberIds?: string[];
  },
  people: Person[],
): { isStaffMatter: boolean; restrictedAccessUserIds: string[] } {
  const clientPersonIds = [matter.clientId, ...(matter.additionalClientIds ?? [])].filter(
    (id) => id && id.startsWith('P-'),
  );
  const isStaff = clientPersonIds.some((cid) => {
    const p = people.find((x) => x.id === cid);
    return isWorkingAtFirm(p);
  });

  if (!isStaff) {
    return { isStaffMatter: false, restrictedAccessUserIds: [] };
  }

  const allowed = new Set<string>();
  if (matter.responsiblePartnerId) allowed.add(matter.responsiblePartnerId);
  if (matter.supervisingPartnerId) allowed.add(matter.supervisingPartnerId);
  if (matter.leadFeeEarnerId) allowed.add(matter.leadFeeEarnerId);
  for (const tid of matter.teamMemberIds ?? []) {
    if (tid) allowed.add(tid);
  }

  return {
    isStaffMatter: true,
    restrictedAccessUserIds: Array.from(allowed),
  };
}

/**
 * Checks whether a user can view a matter (enforces restricted access on staff matters
 * via `matter:restricted:access` permission + named matter participants, ADR-0014).
 */
export function canUserAccessMatter(
  matter: Matter,
  userId: string,
  user?: Person | null,
  rbacOptions?: ResolvePersonPermissionsOptions,
): boolean {
  return canPersonAccessMatter(matter, userId, user, rbacOptions);
}

/**
 * Right-to-work evidence helper for Client ID verification:
 * Shows Right-to-Work check details as "evidence on file" for the reviewer to consider,
 * without automatically changing Client ID verification status.
 */
export function getRightToWorkEvidenceOnFile(person: Person | null | undefined): {
  hasEvidence: boolean;
  summary: string;
  checkDate: string | null;
  method: string;
  documentType: string;
} {
  const rtw = person?.employment?.rightToWork;
  if (!rtw || (!rtw.checkDate && !rtw.documentType && !rtw.method)) {
    return {
      hasEvidence: false,
      summary: '',
      checkDate: null,
      method: '',
      documentType: '',
    };
  }
  const parts = [
    rtw.documentType || 'Right to work document',
    rtw.method ? `(${rtw.method})` : '',
    rtw.checkDate ? `checked on ${rtw.checkDate}` : '',
  ].filter(Boolean);
  return {
    hasEvidence: true,
    summary: parts.join(' '),
    checkDate: rtw.checkDate,
    method: rtw.method,
    documentType: rtw.documentType,
  };
}

/**
 * Conversion path 3 (Employee -> Leaver -> Contact):
 * Ends active employment details, deactivates firm-issued emails and phones,
 * applies HR retention rules to employment data separately from contact data,
 * and keeps the person record as a contact if they have other roles or the user chooses to.
 */
export function resolveConfiguredFirmPrimaryDomain(
  configOverride?: { branding?: { primaryDomain?: string } } | null,
): string {
  const primaryDomain = configOverride?.branding?.primaryDomain
    ?.trim()
    .toLowerCase();
  if (!primaryDomain) {
    throw new Error(
      'TENANT_CONFIG_ERROR: Tenant configuration is missing branding.primaryDomain.',
    );
  }
  return primaryDomain;
}

function isConfiguredFirmDomainEmail(
  address: string,
  firmWorkEmail?: string | null,
  primaryDomain?: string | null,
): boolean {
  const lower = address.trim().toLowerCase();
  if (!lower) return false;
  if (firmWorkEmail && lower === firmWorkEmail.trim().toLowerCase()) {
    return true;
  }
  const normalizedDomain = primaryDomain?.trim().toLowerCase() ?? '';
  if (!normalizedDomain) return false;
  return lower.endsWith(`@${normalizedDomain}`);
}

export function applyLeaverEffects(
  person: {
    emails: Email[];
    phones: Phone[];
    relationshipRoleIds: string[];
  },
  employment: EmploymentRecord,
  leavingDate: string,
  keepAsContact: boolean = true,
  primaryDomain?: string | null,
): {
  emails: Email[];
  phones: Phone[];
  relationshipRoleIds: string[];
  employment: EmploymentRecord;
} {
  const configuredDomain = resolveConfiguredFirmPrimaryDomain({
    branding: { primaryDomain: primaryDomain ?? undefined },
  });
  const endDt = leavingDate || new Date().toISOString().slice(0, 10);

  // Deactivate firm-issued emails and phones
  const updatedEmails = person.emails.map((em) => {
    const isFirmDomain =
      em.firmIssued ||
      isConfiguredFirmDomainEmail(
        em.address,
        employment.systems?.firmWorkEmail,
        configuredDomain,
      );
    if (isFirmDomain) {
      return { ...em, firmIssued: true, active: false, isPrimary: false };
    }
    return { ...em, active: em.active ?? true };
  });
  const firstActiveEmail = updatedEmails.find((e) => e.active !== false);
  if (firstActiveEmail && !updatedEmails.some((e) => e.active !== false && e.isPrimary)) {
    firstActiveEmail.isPrimary = true;
  }

  const updatedPhones = person.phones.map((ph) => {
    if (ph.firmIssued || ph.typeId === 'phone_type.work' || ph.typeId === 'phone_type.direct') {
      return { ...ph, firmIssued: true, active: false };
    }
    return { ...ph, active: ph.active ?? true };
  });

  // Remove 'Internal colleague' role if leaving, while keeping any external contact/client/referrer roles
  const updatedRoles = person.relationshipRoleIds.filter(
    (r) => r !== 'person_role.internal_colleague',
  );

  // End active employment assignment and rate history
  const updatedHistory = (employment.assignmentHistory ?? []).map((entry) =>
    entry.effectiveTo === null ? { ...entry, effectiveTo: endDt } : entry,
  );
  const updatedFeeEarner = employment.feeEarner
    ? {
        ...employment.feeEarner,
        chargeOutRateHistory: (employment.feeEarner.chargeOutRateHistory ?? []).map((r) =>
          r.effectiveTo === null ? { ...r, effectiveTo: endDt } : r,
        ),
      }
    : employment.feeEarner;

  const hrRetentionUntil = calculateHrRetentionDate(endDt, 6);

  const updatedEmployment: EmploymentRecord = {
    ...employment,
    status: 'Leaver',
    effectiveTo: endDt,
    assignmentHistory: updatedHistory,
    ...(updatedFeeEarner !== undefined ? { feeEarner: updatedFeeEarner } : {}),
    contract: {
      startDate: employment.contract?.startDate ?? employment.effectiveFrom ?? endDt,
      continuousServiceDate:
        employment.contract?.continuousServiceDate ??
        employment.contract?.startDate ??
        employment.effectiveFrom ??
        endDt,
      contractType: employment.contract?.contractType ?? 'Permanent',
      fixedTermEndDate: employment.contract?.fixedTermEndDate ?? null,
      fte: employment.contract?.fte ?? 1.0,
      workingPattern: employment.contract?.workingPattern ?? 'Full-time',
      workingPatternNotes: employment.contract?.workingPatternNotes ?? '',
      workLocationArrangement: employment.contract?.workLocationArrangement ?? 'Hybrid',
      probationPeriodMonths: employment.contract?.probationPeriodMonths ?? 6,
      probationEndDate: employment.contract?.probationEndDate ?? null,
      probationOutcome: employment.contract?.probationOutcome ?? 'Passed',
      noticePeriod: employment.contract?.noticePeriod ?? '3 months',
      holidayEntitlementDays: employment.contract?.holidayEntitlementDays ?? 25,
      leavingDate: endDt,
      leavingReasonId: employment.contract?.leavingReasonId ?? null,
      eligibleForRehire: employment.contract?.eligibleForRehire ?? 'Yes',
      keepAsContactOnLeave: keepAsContact,
      hrRetentionUntil,
    },
  };

  return {
    emails: updatedEmails,
    phones: updatedPhones,
    relationshipRoleIds: updatedRoles,
    employment: updatedEmployment,
  };
}

/**
 * Generates the next unique employee number (e.g. EMP-0001).
 */
export function generateNextEmployeeNumber(people: Person[]): string {
  let max = 0;
  for (const p of people) {
    const code = p.employment?.employeeNumber ?? '';
    const m = /^EMP-(\d+)$/i.exec(code.trim());
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return `EMP-${String(max + 1).padStart(4, '0')}`;
}

/**
 * Resolves the default Partner / Head of Department for a given OrgDepartment ID.
 */
export function resolveDefaultDepartmentPartnerId(
  deptId: string,
  allPeople: Person[],
  orgStructure: OrgStructureCatalogue = buildDefaultOrgStructure(),
): string {
  // Prefer a Partner/Member in the same department
  const sameDeptPartners = allPeople.filter((p) => {
    if (p.demo || p.mergedIntoId || (!p.isEmployee && !p.employment)) return false;
    const pDept = resolveOrgDepartment(
      p.employment?.departmentId || p.departmentId,
      orgStructure,
    );
    if (pDept?.id !== deptId) return false;
    return (
      p.employment?.roleType === 'Partner/Member' ||
      p.employeeRoleId === 'employee_role.partner' ||
      p.roles?.includes('partner')
    );
  });

  const primaryPartner =
    sameDeptPartners.find((p) => p.roles?.includes('managing_partner')) ??
    sameDeptPartners.find((p) => p.employeeRoleId === 'employee_role.partner') ??
    sameDeptPartners[0];
  if (primaryPartner) return primaryPartner.id;

  // Fallback dynamically to any active Managing Partner or Partner in the firm (zero hardcoded DEPT-* or P-00000* IDs)
  const anyFirmPartner =
    allPeople.find(
      (p) =>
        !p.demo &&
        !p.mergedIntoId &&
        (p.isEmployee || p.employment) &&
        p.roles?.includes('managing_partner'),
    ) ??
    allPeople.find(
      (p) =>
        !p.demo &&
        !p.mergedIntoId &&
        (p.isEmployee || p.employment) &&
        (p.roles?.includes('partner') ||
          p.employeeRoleId === 'employee_role.partner' ||
          p.employment?.roleType === 'Partner/Member'),
    );
  return anyFirmPartner?.id ?? allPeople[0]?.id ?? '';
}

/**
 * Generates a default EmploymentRecord for a person when creating or migrating an employee.
 */
export function createDefaultEmploymentRecord(opts: {
  person: Partial<Person> & { id: string; firstName: string; surname: string };
  allPeople: Person[];
  orgStructure?: OrgStructureCatalogue;
  byId: string;
  nowIso?: string;
  status?: EmploymentStatus;
  primaryDomain?: string | null;
}): EmploymentRecord {
  const orgStructure = opts.orgStructure ?? buildDefaultOrgStructure();
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const today = nowIso.slice(0, 10);

  const mappedRole = mapLegacyEmployeeRoleToRoleType(opts.person.employeeRoleId);
  const roleType: EmployeeRoleType = mappedRole?.roleType ?? 'Fee earner';
  const engagementType: EngagementType = mappedRole?.engagementType ?? 'Employee';

  const resolvedDept =
    resolveOrgDepartment(opts.person.departmentId, orgStructure) ?? orgStructure.departments[0];
  const resolvedOffice =
    resolveOrgOffice(opts.person.addresses?.[0]?.town, orgStructure) ?? orgStructure.offices[0];

  const defaultTeam =
    orgStructure.teamsOrPracticeGroups.find((t) => t.parentDepartmentId === resolvedDept.id) ??
    null;

  const isTop =
    opts.person.roles?.includes('managing_partner') ||
    (opts.person.jobTitle ?? '').toLowerCase().includes('managing partner');

  const deptPartnerId = resolveDefaultDepartmentPartnerId(
    resolvedDept.id,
    opts.allPeople,
    orgStructure,
  );
  const managingPartnerId =
    opts.allPeople.find((p) => !p.demo && p.roles?.includes('managing_partner'))?.id ??
    'P-000001';

  const defaultLineManagerId = isTop
    ? null
    : opts.person.id === deptPartnerId
      ? managingPartnerId !== opts.person.id
        ? managingPartnerId
        : 'P-000001'
      : deptPartnerId;

  const defaultSupervisingPartnerId =
    resolvedDept.parentDivisionId === 'DIV-LEGAL' || isFeeEarnerRoleType(roleType)
      ? deptPartnerId
      : null;

  const empNumber = generateNextEmployeeNumber(opts.allPeople);
  const startDate = opts.person.createdAt ? opts.person.createdAt.slice(0, 10) : today;

  const slugFirst = (opts.person.firstName || 'user')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
  const slugSurname = (opts.person.surname || 'staff')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');

  const configuredDomain = resolveConfiguredFirmPrimaryDomain({
    branding: { primaryDomain: opts.primaryDomain ?? undefined },
  });
  const firmEmail =
    opts.person.emails?.find(
      (e) =>
        e.firmIssued ||
        isConfiguredFirmDomainEmail(e.address, null, configuredDomain),
    )?.address ?? `${slugFirst}.${slugSurname}@${configuredDomain}`;
  const firmPhone = opts.person.phones?.[0]?.number ?? '';

  const record: EmploymentRecord = {
    id: `EREC-${opts.person.id}`,
    personId: opts.person.id,
    engagementType,
    status: opts.status ?? 'Pre-start',
    employeeNumber: empNumber,
    employingEntityId: DEFAULT_LEGAL_ENTITY_ID,
    jobTitle: opts.person.jobTitle || roleType,
    gradeOrBand:
      roleType === 'Partner/Member'
        ? 'Equity / Fixed Share Partner'
        : roleType === 'Fee earner'
          ? 'Senior Associate / Associate'
          : roleType === 'Trainee'
            ? 'Trainee Solicitor'
            : 'Business Services',
    roleType,
    divisionId: resolvedDept.parentDivisionId,
    departmentId: resolvedDept.id,
    teamOrPracticeGroupId: defaultTeam?.id ?? null,
    officeId: resolvedOffice.id,
    costCentreId: resolvedDept.defaultCostCentreId,
    profitCentreId: resolvedDept.defaultProfitCentreId,
    isTopOfHierarchy: Boolean(isTop),
    lineManagerId: defaultLineManagerId,
    supervisingPartnerId: defaultSupervisingPartnerId,
    timesheetApproverId: defaultLineManagerId,
    holidayApproverId: defaultLineManagerId,
    onboardingBuddyId: null,
    effectiveFrom: startDate,
    effectiveTo: null,
    assignmentHistory: [
      {
        id: `asgn-${opts.person.id}-1`,
        effectiveFrom: startDate,
        effectiveTo: null,
        jobTitle: opts.person.jobTitle || roleType,
        gradeOrBand:
          roleType === 'Partner/Member'
            ? 'Equity / Fixed Share Partner'
            : roleType === 'Fee earner'
              ? 'Senior Associate / Associate'
              : 'Business Services',
        roleType,
        divisionId: resolvedDept.parentDivisionId,
        departmentId: resolvedDept.id,
        teamOrPracticeGroupId: defaultTeam?.id ?? null,
        officeId: resolvedOffice.id,
        costCentreId: resolvedDept.defaultCostCentreId,
        profitCentreId: resolvedDept.defaultProfitCentreId,
        lineManagerId: defaultLineManagerId,
        fte: 1.0,
        changedById: opts.byId,
        changedAt: nowIso,
      },
    ],
    contract: {
      startDate,
      continuousServiceDate: startDate,
      contractType: 'Permanent',
      fixedTermEndDate: null,
      fte: 1.0,
      workingPattern: 'Full-time (37.5 hrs, Mon–Fri)',
      workingPatternNotes: '',
      workLocationArrangement: 'Hybrid',
      probationPeriodMonths: orgStructure.defaultProbationMonths ?? 6,
      probationEndDate: calculateProbationEndDate(
        startDate,
        orgStructure.defaultProbationMonths ?? 6,
      ),
      probationOutcome: 'Passed',
      noticePeriod: roleType === 'Partner/Member' ? '6 months' : '3 months',
      holidayEntitlementDays: roleType === 'Partner/Member' ? 30 : 25,
      leavingDate: null,
      leavingReasonId: null,
      eligibleForRehire: null,
      keepAsContactOnLeave: true,
      hrRetentionUntil: null,
    },
    feeEarner: isFeeEarnerRoleType(roleType)
      ? {
          timekeeperCode: '',
          chargeOutRateGbp: roleType === 'Partner/Member' ? 350 : roleType === 'Fee earner' ? 260 : 150,
          chargeOutRateEffectiveFrom: startDate,
          chargeOutRateHistory: [
            {
              id: `rate-${opts.person.id}-1`,
              rateGbpPerHour:
                roleType === 'Partner/Member' ? 350 : roleType === 'Fee earner' ? 260 : 150,
              effectiveFrom: startDate,
              effectiveTo: null,
              changedById: opts.byId,
              changedAt: nowIso,
            },
          ],
          chargeableHoursTarget: roleType === 'Partner/Member' ? 1200 : 1400,
          billingApprovalLimitGbp: roleType === 'Partner/Member' ? 25000 : 2500,
          sraNumber: '',
          practisingCertificateStatus: 'Current',
          practisingCertificateRenewalDate: `${new Date().getFullYear() + 1}-10-31`,
          admissionDate: startDate,
        }
      : null,
    rightToWork: {
      checkDate: startDate,
      method: 'Manual document check',
      documentType: 'UK Passport',
      expiryDate: null,
      followUpCheckDueDate: null,
      dbsCheckType: 'Standard DBS',
      dbsCheckDate: startDate,
      dbsOutcome: 'Clear',
      dbsReference: '',
      referencesReceived: true,
      referencesReceivedDate: startDate,
    },
    payroll: {
      externalPayrollReference: `PAY-${empNumber}`,
      nationalInsuranceNumber: '',
      bankAccountName: `${opts.person.firstName} ${opts.person.surname}`.trim(),
      bankSortCode: '',
      bankAccountNumber: '',
      buildingSocietyRollNumber: '',
      starterDeclarationOrP45: 'P45 received',
      studentLoanPlan: 'None',
      pensionAutoEnrolmentStatus: 'Eligible jobholder — enrolled',
      pensionOptOutDate: null,
    },
    emergencyContacts: [],
    systems: {
      networkLogin: `${slugFirst}.${slugSurname}`,
      buildingPassNumber: `BP-${opts.person.id.replace(/\D/g, '').slice(-4)}`,
      extension: firmPhone,
      firmWorkEmail: firmEmail,
      dataProtectionTrainingCompletedAt: startDate,
      amlTrainingCompletedAt: startDate,
      infoSecTrainingCompletedAt: startDate,
    },
    conflictCheckOnHire: null,
    createdById: opts.byId,
    createdAt: nowIso,
    updatedById: opts.byId,
    updatedAt: nowIso,
  };

  return record;
}

/**
 * Migration:
 * Converts each person with the current employee checkbox ticked (`isEmployee: true`)
 * into an employment record with status Active, mapping Employee role to Role type
 * and Department / team to the new organisation structure.
 * Lists any values that can't be mapped automatically for manual review.
 */
export function migrateEmployeesToEmploymentRecords(
  people: Person[],
  values: ChoiceValue[],
  orgStructure: OrgStructureCatalogue = buildDefaultOrgStructure(),
  pmsLinks: PmsLink[] = [],
  primaryDomain?: string | null,
  nowIso: string = new Date().toISOString(),
): { people: Person[]; report: EmployeeMigrationReport } {
  const unmappedRecords: UnmappedEmployeeMigrationItem[] = [];
  let migratedCount = 0;

  const updatedPeople: Person[] = [];

  for (const person of people) {
    if (!person.isEmployee && !person.employment) {
      updatedPeople.push(person);
      continue;
    }

    if (person.employment) {
      // Repair legacy seeded supervisingPartnerId/lineManagerId if pointing to non-employee P-000013 or missing on legal dept
      const empDept = resolveOrgDepartment(
        person.employment.departmentId || person.departmentId,
        orgStructure,
      );
      const deptPartnerId = empDept
        ? resolveDefaultDepartmentPartnerId(empDept.id, people, orgStructure)
        : 'P-000001';
      let patchedEmp = person.employment;
      const supPerson = patchedEmp.supervisingPartnerId
        ? people.find((x) => x.id === patchedEmp.supervisingPartnerId)
        : null;
      const supInvalid =
        !supPerson || (!supPerson.isEmployee && !supPerson.employment);
      const shouldFixDefaultDeptPartner =
        empDept &&
        empDept.parentDivisionId === 'DIV-LEGAL' &&
        (supInvalid ||
          (patchedEmp.supervisingPartnerId === 'P-000001' &&
            deptPartnerId !== 'P-000001' &&
            patchedEmp.updatedAt === patchedEmp.createdAt));
      if (shouldFixDefaultDeptPartner) {
        patchedEmp = {
          ...patchedEmp,
          supervisingPartnerId: deptPartnerId,
          lineManagerId:
            patchedEmp.lineManagerId === 'P-000013' ||
            (patchedEmp.lineManagerId === 'P-000001' &&
              deptPartnerId !== 'P-000001' &&
              person.id !== deptPartnerId)
              ? deptPartnerId
              : patchedEmp.lineManagerId,
        };
      }
      // Ensure firmIssued flags on work emails/phones and DOB fallback
      const synced = syncPersonWorkContactFlags(
        { ...person, employment: patchedEmp },
        orgStructure,
        primaryDomain,
      );
      updatedPeople.push(synced);
      continue;
    }

    // Check role mapping
    const roleLabel = resolveLabel(values, person.employeeRoleId) || person.employeeRoleId || '';
    const mappedRole =
      mapLegacyEmployeeRoleToRoleType(person.employeeRoleId) ??
      mapLegacyEmployeeRoleToRoleType(roleLabel);

    if (!mappedRole) {
      unmappedRecords.push({
        personId: person.id,
        personName: personDisplayName(person),
        field: 'employeeRoleId',
        rawValue: String(person.employeeRoleId ?? ''),
        reason: `Employee role "${roleLabel || person.employeeRoleId || 'empty'}" could not be mapped automatically to a Role type.`,
      });
    }

    // Check department mapping
    const deptLabel = resolveLabel(values, person.departmentId) || person.departmentId || '';
    const resolvedDept =
      resolveOrgDepartment(person.departmentId, orgStructure) ??
      resolveOrgDepartment(deptLabel, orgStructure);

    if (!resolvedDept) {
      unmappedRecords.push({
        personId: person.id,
        personName: personDisplayName(person),
        field: 'departmentId',
        rawValue: String(person.departmentId ?? ''),
        reason: `Department "${deptLabel || person.departmentId || 'empty'}" could not be mapped automatically to the new organisation structure.`,
      });
    }

    const emp = createDefaultEmploymentRecord({
      person,
      allPeople: [...updatedPeople, ...people.filter((p) => !updatedPeople.some((u) => u.id === p.id))],
      orgStructure,
      byId: person.updatedById || 'P-000004',
      nowIso,
      status: 'Active',
      primaryDomain,
    });

    if (mappedRole) {
      emp.roleType = mappedRole.roleType;
      emp.engagementType = mappedRole.engagementType;
    }
    if (resolvedDept) {
      emp.departmentId = resolvedDept.id;
      emp.divisionId = resolvedDept.parentDivisionId;
      emp.costCentreId = resolvedDept.defaultCostCentreId;
      emp.profitCentreId = resolvedDept.defaultProfitCentreId;
    }

    // Populate PMS timekeeper code if linked in PMS
    const pmsCode = pmsLinks.find(
      (l) => l.entityType === 'employee' && l.onesquaredId === person.id,
    )?.pmsCode;
    if (emp.feeEarner) {
      emp.feeEarner.timekeeperCode =
        pmsCode || `FE-${person.id.replace(/\D/g, '').slice(-3)}`;
      emp.feeEarner.sraNumber = `SRA-${600000 + parseInt(person.id.replace(/\D/g, '') || '1', 10)}`;
    }

    const migratedPerson: Person = syncPersonWorkContactFlags(
      {
        ...person,
        dateOfBirth: person.dateOfBirth || '1985-06-15',
        employment: emp,
      },
      orgStructure,
      primaryDomain,
    );

    updatedPeople.push(migratedPerson);
    migratedCount++;
  }

  return {
    people: updatedPeople,
    report: {
      migratedAt: nowIso,
      migratedCount,
      unmappedRecords,
    },
  };
}

/**
 * Ensures firm-issued work email & phone entries on the person are flagged `firmIssued: true`,
 * and syncs backward-compatible `isEmployee`, `employeeRoleId`, `departmentId` fields on `Person`.
 */
export function syncPersonWorkContactFlags(
  person: Person,
  orgStructure: OrgStructureCatalogue = buildDefaultOrgStructure(),
  primaryDomain?: string | null,
): Person {
  const emp = person.employment;
  if (!emp) {
    return person;
  }

  const isLeaver = emp.status === 'Leaver';
  const resolvedDept = resolveOrgDepartment(emp.departmentId, orgStructure);
  const legacyDeptId = resolvedDept?.legacyChoiceValueId ?? person.departmentId;
  const legacyRoleId = mapRoleTypeToLegacyEmployeeRoleId(emp.roleType, person.employeeRoleId);

  const emails = (person.emails ?? []).map((em) => {
    const isFirm =
      em.firmIssued ||
      isConfiguredFirmDomainEmail(
        em.address,
        emp.systems?.firmWorkEmail,
        primaryDomain,
      );
    if (isFirm) {
      return {
        ...em,
        typeId: em.typeId ?? 'email_type.work',
        firmIssued: true,
        active: isLeaver ? false : (em.active ?? true),
      };
    }
    return { ...em, active: em.active ?? true };
  });

  // If systems.firmWorkEmail is set and not yet in person.emails, add it as a Work email flagged firmIssued
  if (emp.systems?.firmWorkEmail?.trim()) {
    const fw = emp.systems.firmWorkEmail.trim();
    if (!emails.some((e) => e.address.toLowerCase() === fw.toLowerCase())) {
      emails.unshift({
        id: `em-firm-${Date.now()}`,
        address: fw,
        typeId: 'email_type.work',
        isPrimary: !isLeaver && !emails.some((e) => e.isPrimary),
        firmIssued: true,
        active: !isLeaver,
      });
    }
  }

  const phones = (person.phones ?? []).map((ph, idx) => {
    const isFirm =
      ph.firmIssued ||
      ph.typeId === 'phone_type.work' ||
      (idx === 0 && ph.typeId === 'phone_type.direct') ||
      (emp.systems?.extension && ph.number.trim() === emp.systems.extension.trim());
    if (isFirm) {
      return {
        ...ph,
        typeId: 'phone_type.work',
        firmIssued: true,
        active: isLeaver ? false : (ph.active ?? true),
      };
    }
    return { ...ph, active: ph.active ?? true };
  });

  // If systems.extension is set and not yet in person.phones, add it as a Work phone flagged firmIssued
  if (emp.systems?.extension?.trim()) {
    const ext = emp.systems.extension.trim();
    if (!phones.some((p) => p.number.trim() === ext)) {
      phones.push({
        id: `ph-ext-${Date.now()}`,
        number: ext,
        typeId: 'phone_type.work',
        firmIssued: true,
        active: !isLeaver,
      });
    }
  }

  return {
    ...person,
    emails,
    phones,
    isEmployee: !isLeaver,
    employeeRoleId: legacyRoleId,
    departmentId: legacyDeptId,
  };
}

/**
 * Maps an OrgDepartment ID to the corresponding `work_type` parent (practice area) choice value ID
 * when the department is a Legal Practice (`DIV-LEGAL`) department.
 */
const LEGAL_DEPT_TO_PRACTICE_AREA_ID: Record<string, string> = {
  'DEPT-RE': 'work_type.real_estate_and_property',
  'DEPT-CORP': 'work_type.corporate_and_commercial',
  'DEPT-DR': 'work_type.dispute_resolution',
  'DEPT-PC': 'work_type.private_client',
  'DEPT-EMP': 'work_type.employment_and_hr',
};

/**
 * Maps a `work_type` parent (practice area) choice value ID to the corresponding `OrgDepartment.id`s.
 */
const PRACTICE_AREA_TO_ORG_DEPT_IDS: Record<string, string[]> = {
  'work_type.real_estate_and_property': ['DEPT-RE'],
  'work_type.corporate_and_commercial': ['DEPT-CORP'],
  'work_type.intellectual_property': ['DEPT-CORP'],
  'work_type.finance_and_banking': ['DEPT-CORP'],
  'work_type.dispute_resolution': ['DEPT-DR'],
  'work_type.private_client': ['DEPT-PC'],
  'work_type.employment_and_hr': ['DEPT-EMP'],
  'work_type.regulatory_and_compliance': ['DEPT-RISK', 'DEPT-DR'],
};

/**
 * Resolves the New Matter `Department` (`practiceAreaId`) for a person if they have a
 * legal team department (`DIV-LEGAL`) assigned to them. Returns `''` if they belong
 * to a Business Services department or have no legal department assigned.
 */
export function resolvePracticeAreaIdForPersonDepartment(
  person: Person | null | undefined,
  practiceAreas: ChoiceValue[],
  orgStructure: OrgStructureCatalogue = buildDefaultOrgStructure(),
): string {
  if (!person) return '';
  const dept = resolveOrgDepartment(
    person.employment?.departmentId || person.departmentId,
    orgStructure,
  );
  if (!dept || dept.parentDivisionId !== 'DIV-LEGAL') {
    return '';
  }

  const mappedId = LEGAL_DEPT_TO_PRACTICE_AREA_ID[dept.id];
  if (mappedId && practiceAreas.some((pa) => pa.id === mappedId)) {
    return mappedId;
  }

  // Fallback for custom legal departments by matching name
  const deptNameLower = dept.name.trim().toLowerCase();
  const matchedPa = practiceAreas.find((pa) => {
    const lbl = pa.label.trim().toLowerCase();
    return lbl === deptNameLower || lbl.includes(deptNameLower) || deptNameLower.includes(lbl);
  });
  return matchedPa?.id ?? '';
}

/**
 * Resolves the set of `OrgDepartment.id`s that correspond to a selected New Matter `Department` (`practiceAreaId`).
 */
export function resolveOrgDepartmentIdsForPracticeArea(
  practiceAreaId: string | null | undefined,
  practiceAreas: ChoiceValue[],
  orgStructure: OrgStructureCatalogue = buildDefaultOrgStructure(),
): Set<string> {
  const result = new Set<string>();
  if (!practiceAreaId) return result;

  const direct = PRACTICE_AREA_TO_ORG_DEPT_IDS[practiceAreaId];
  if (direct) {
    for (const id of direct) result.add(id);
  }

  const pa = practiceAreas.find((p) => p.id === practiceAreaId);
  if (pa) {
    const paLower = pa.label.trim().toLowerCase();
    for (const dept of orgStructure.departments) {
      const deptLower = dept.name.trim().toLowerCase();
      if (
        deptLower === paLower ||
        paLower.includes(deptLower) ||
        deptLower.includes(paLower)
      ) {
        result.add(dept.id);
      }
    }
  }
  return result;
}

/**
 * Returns true if the person is a fee earner (Fee earner, Trainee, or Partner/Member).
 */
export function isPersonFeeEarnerForMatter(person: Person | null | undefined): boolean {
  if (!person) return false;
  if (person.employment?.roleType) {
    return isFeeEarnerRoleType(person.employment.roleType);
  }
  return (
    person.employeeRoleId === 'employee_role.fee_earner' ||
    person.employeeRoleId === 'employee_role.partner'
  );
}

/**
 * Filters employees for the New Matter `Responsible Partner` and `Fee Earner` dropdowns
 * so only people in the relevant (currently selected) department are shown.
 * When `includeSupervisingPartners` is true (e.g. for the Responsible Partner dropdown),
 * also includes the supervising partner of employees in that department if that department
 * has no partner directly assigned.
 */
export function filterEmployeesForMatterDepartment(opts: {
  employees: Person[];
  practiceAreaId: string | null | undefined;
  practiceAreas: ChoiceValue[];
  orgStructure?: OrgStructureCatalogue;
  includeSupervisingPartners?: boolean;
  preserveSelectedId?: string | null;
}): Person[] {
  const orgStructure = opts.orgStructure ?? buildDefaultOrgStructure();
  const baseEmployees = opts.employees.filter(
    (e) => !e.demo || e.id === opts.preserveSelectedId,
  );

  if (!opts.practiceAreaId) {
    return baseEmployees;
  }

  const targetDeptIds = resolveOrgDepartmentIdsForPracticeArea(
    opts.practiceAreaId,
    opts.practiceAreas,
    orgStructure,
  );
  if (targetDeptIds.size === 0) {
    return baseEmployees;
  }

  const inDept = baseEmployees.filter((emp) => {
    const empDept = resolveOrgDepartment(
      emp.employment?.departmentId || emp.departmentId,
      orgStructure,
    );
    return empDept ? targetDeptIds.has(empDept.id) : false;
  });

  const resultIds = new Set(inDept.map((e) => e.id));
  const result = [...inDept];

  // If filtering for Responsible Partner and the department's members have a supervising partner
  // who sits across departments (e.g. Dispute Resolution supervised by Rhian Morgan), include them
  if (opts.includeSupervisingPartners) {
    for (const member of inDept) {
      const supId = member.employment?.supervisingPartnerId;
      if (supId && !resultIds.has(supId)) {
        const supEmp = baseEmployees.find((e) => e.id === supId);
        if (supEmp) {
          resultIds.add(supEmp.id);
          result.push(supEmp);
        }
      }
    }
  }

  if (opts.preserveSelectedId && !resultIds.has(opts.preserveSelectedId)) {
    const preserved = baseEmployees.find((e) => e.id === opts.preserveSelectedId);
    if (preserved) {
      resultIds.add(preserved.id);
      result.push(preserved);
    }
  }

  return result;
}

/**
 * Computes the pre-selected New Matter values (`practiceAreaId`, `responsiblePartnerId`, `leadFeeEarnerId`)
 * for the currently logged-in user when creating a new matter:
 * - If the person has a legal team department assigned, pre-selects that `Department` (`practiceAreaId`).
 * - Pre-selects `Responsible Partner` to that person's `Supervising Partner` (`supervisingPartnerId`).
 * - Pre-selects `Fee Earner` to the logged-in person if they are a fee earner.
 */
export function resolveNewMatterDepartmentDefaults(opts: {
  currentUser: Person | null | undefined;
  allPeople: Person[];
  employees: Person[];
  practiceAreas: ChoiceValue[];
  orgStructure?: OrgStructureCatalogue;
}): {
  practiceAreaId: string;
  responsiblePartnerId: string | null;
  leadFeeEarnerId: string | null;
} {
  const orgStructure = opts.orgStructure ?? buildDefaultOrgStructure();
  const user = opts.currentUser;
  if (!user) {
    return { practiceAreaId: '', responsiblePartnerId: null, leadFeeEarnerId: null };
  }

  const effectiveUser =
    user.demo && user.showsWorkOfId
      ? (opts.allPeople.find((p) => p.id === user.showsWorkOfId) ?? user)
      : user;

  const practiceAreaId =
    resolvePracticeAreaIdForPersonDepartment(effectiveUser, opts.practiceAreas, orgStructure) ||
    resolvePracticeAreaIdForPersonDepartment(user, opts.practiceAreas, orgStructure);

  if (!practiceAreaId) {
    return { practiceAreaId: '', responsiblePartnerId: null, leadFeeEarnerId: null };
  }

  const deptEmployees = filterEmployeesForMatterDepartment({
    employees: opts.employees,
    practiceAreaId,
    practiceAreas: opts.practiceAreas,
    orgStructure,
    includeSupervisingPartners: true,
  });
  const deptEmpIds = new Set(deptEmployees.map((e) => e.id));

  const rawSupervisingPartnerId =
    effectiveUser.employment?.supervisingPartnerId ||
    user.employment?.supervisingPartnerId ||
    null;

  let responsiblePartnerId: string | null = null;
  if (rawSupervisingPartnerId && deptEmpIds.has(rawSupervisingPartnerId)) {
    responsiblePartnerId = rawSupervisingPartnerId;
  } else if (rawSupervisingPartnerId) {
    const validEmp = opts.employees.find((e) => e.id === rawSupervisingPartnerId && !e.demo);
    if (validEmp) {
      responsiblePartnerId = validEmp.id;
    }
  }

  const isFeeEarner =
    isPersonFeeEarnerForMatter(effectiveUser) || isPersonFeeEarnerForMatter(user);
  let leadFeeEarnerId: string | null = null;
  if (isFeeEarner) {
    if (deptEmpIds.has(effectiveUser.id)) {
      leadFeeEarnerId = effectiveUser.id;
    } else if (!user.demo && deptEmpIds.has(user.id)) {
      leadFeeEarnerId = user.id;
    }
  }

  return {
    practiceAreaId,
    responsiblePartnerId,
    leadFeeEarnerId,
  };
}

/**
 * Builds the sensitive information submission payload for `savePersonAction` / `savePersonRecord` (R76).
 * Returns `null` unless the person works at the firm, the actor has `employee:sensitive`,
 * and the sensitive section was both opened (`sensitiveRevealed`) and edited (`sensitiveEdited`).
 */
export function buildSensitiveSubmissionPayload(params: {
  isEmployee: boolean;
  canSensitive: boolean;
  sensitiveRevealed: boolean;
  sensitiveEdited: boolean;
  reasonableAdjustments: string;
  diversityAnswers: DiversityMonitoringAnswers;
}): Partial<EmployeeSensitiveRecord> | null {
  if (
    !params.isEmployee ||
    !params.canSensitive ||
    !params.sensitiveRevealed ||
    !params.sensitiveEdited
  ) {
    return null;
  }
  return {
    reasonableAdjustmentsNeeded: params.reasonableAdjustments.trim(),
    diversity: params.diversityAnswers,
  };
}

