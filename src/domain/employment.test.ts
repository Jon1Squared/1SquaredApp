import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  applyEffectiveDatedEmploymentHistory,
  applyLeaverEffects,
  buildSensitiveSubmissionPayload,
  calculateHrRetentionDate,
  calculateProbationEndDate,
  computeStaffMatterStatus,
  emptyDiversityAnswers,
  filterEmployeesForMatterDepartment,
  findOpenMattersWherePersonIsParty,
  findRecordsOwnedByLeavers,
  formatEmployeeSelectorOptionLabel,
  getRightToWorkEvidenceOnFile,
  isFeeEarnerRoleType,
  isLeaverPerson,
  isSelectableInEmployeeDropdown,
  maskBankDetails,
  maskNationalInsuranceNumber,
  migrateEmployeesToEmploymentRecords,
  resolveNewMatterDepartmentDefaults,
  validateEmploymentRecord,
  validateNationalInsuranceNumber,
} from './employment';
import {
  canUserAccessMatter,
  filterEmploymentForUser,
  resolveEmployeePermissions,
} from '../server/rbacRuntime';
import {
  buildDefaultOrgStructure,
  mapLegacyEmployeeRoleToRoleType,
  resolveOrgDepartment,
} from './orgStructure';
import { getStore, resetStore } from '../server/store';
import {
  getAppSnapshot,
  getEmployeeDetailsForUser,
  listAuditEntriesForRecord,
  logEmployeeRestrictedAccess,
  reassignLeaverOwnedRecords,
  saveMatterRecord,
  savePersonRecord,
} from '../server/services';
import {
  createSignedEntraSessionCookie,
  verifySignedEntraSessionCookie,
} from '../server/entraAuth';
import { runWithActiveActorSession } from './rbac';
import type { EmploymentRecord, Person } from './types';

describe('Employee section, conversion paths, migration & permissions', () => {
  beforeAll(() => {
    resetStore();
  });
  afterAll(() => {
    resetStore();
  });

  describe('1. Validation & formatting rules', () => {
    it('validates UK National Insurance numbers and masks NI / bank details by default', () => {
      expect(validateNationalInsuranceNumber('JC 12 34 56 C')).toBe(true);
      expect(validateNationalInsuranceNumber('AB123456A')).toBe(true);
      // Invalid prefixes (GB, NK, TN, ZZ, D/F/I/Q/U/V letters)
      expect(validateNationalInsuranceNumber('GB123456A')).toBe(false);
      expect(validateNationalInsuranceNumber('ZZ123456A')).toBe(false);
      expect(validateNationalInsuranceNumber('DA123456A')).toBe(false);
      expect(validateNationalInsuranceNumber('12345')).toBe(false);

      expect(maskNationalInsuranceNumber('JC123456C')).toBe('••••••56C');
      const maskedBank = maskBankDetails('20-00-15', '12345678');
      expect(maskedBank.sortCode).toBe('••-••-15');
      expect(maskedBank.accountNumber).toBe('••••5678');
    });

    it('calculates probation end date and statutory 6-year HR retention date', () => {
      expect(calculateProbationEndDate('2026-01-15', 6)).toBe('2026-07-15');
      expect(calculateHrRetentionDate('2026-09-30', 6)).toBe('2032-09-30');
    });

    it('enforces mandatory DOB, job title, department, unique employee number, unique timekeeper code, line manager, and conditional role/contract fields', () => {
      const store = getStore();
      const existingEmpPerson = store.people.find((p) => p.employment)!;
      const existingEmpNumber = existingEmpPerson.employment!.employeeNumber;
      const existingTkCode =
        store.people.find((p) => p.employment?.feeEarner?.timekeeperCode)?.employment
          ?.feeEarner?.timekeeperCode ?? 'FE-001';

      const invalidEmployment: Partial<EmploymentRecord> = {
        engagementType: 'Employee',
        status: 'Pre-start',
        employeeNumber: existingEmpNumber, // duplicate!
        employingEntityId: 'LE-PV-LLP',
        jobTitle: '',
        gradeOrBand: 'Band 4',
        roleType: 'Fee earner',
        divisionId: 'DIV-LEGAL',
        departmentId: '',
        teamOrPracticeGroupId: null,
        officeId: 'OFF-CDF',
        costCentreId: 'CC-RE',
        profitCentreId: 'PC-RE',
        isTopOfHierarchy: false,
        lineManagerId: null,
        supervisingPartnerId: null,
        timesheetApproverId: null,
        holidayApproverId: null,
        onboardingBuddyId: null,
        effectiveFrom: '2026-04-01',
        effectiveTo: null,
        assignmentHistory: [],
        contract: {
          startDate: '',
          continuousServiceDate: '',
          contractType: 'Fixed term',
          fixedTermEndDate: null,
          fte: 1.0,
          workingPattern: 'Full-time',
          workingPatternNotes: '',
          workLocationArrangement: 'Hybrid',
          probationPeriodMonths: 6,
          probationEndDate: null,
          probationEndDateOverridden: false,
          probationOutcome: 'Pending',
          noticePeriod: '3 months',
          holidayEntitlementDays: 25,
          leavingDate: null,
          leavingReasonId: null,
          eligibleForRehire: 'Yes',
          keepAsContactOnLeave: true,
          hrRetentionUntil: null,
        },
        feeEarner: {
          timekeeperCode: existingTkCode, // duplicate!
          chargeOutRateGbp: 300,
          chargeOutRateEffectiveFrom: '2026-04-01',
          chargeOutRateHistory: [],
          chargeableHoursTarget: 1400,
          billingApprovalLimitGbp: 2500,
          sraNumber: '',
          practisingCertificateStatus: 'Current',
          practisingCertificateRenewalDate: null,
          admissionDate: null,
        },
        payroll: {
          externalPayrollReference: 'PAY-1',
          nationalInsuranceNumber: 'INVALID-NI',
          bankAccountName: 'Test',
          bankSortCode: '20-00-00',
          bankAccountNumber: '12345678',
          buildingSocietyRollNumber: '',
          starterDeclarationOrP45: 'P45 received',
          studentLoanPlan: 'None',
          pensionAutoEnrolmentStatus: 'Eligible jobholder — enrolled',
          pensionOptOutDate: null,
        },
      };

      const errors = validateEmploymentRecord(invalidEmployment, {
        personId: 'P-NEW-TEST',
        dateOfBirth: '',
        allPeople: store.people,
        orgStructure: store.orgStructure,
        requireContractStartDate: true,
      });

      expect(errors.dateOfBirth).toBeDefined();
      expect(errors.employeeNumber).toBeDefined();
      expect(errors.jobTitle).toBeDefined();
      expect(errors.departmentId).toBeDefined();
      expect(errors.lineManagerId).toBeDefined();
      expect(errors.startDate).toBeDefined();
      expect(errors.fixedTermEndDate).toBeDefined();
      expect(errors.timekeeperCode).toBeDefined();
      expect(errors.nationalInsuranceNumber).toBeDefined();
    });

    it('shows Fee earner details only when roleType is Fee earner, Trainee, or Partner/Member', () => {
      expect(isFeeEarnerRoleType('Fee earner')).toBe(true);
      expect(isFeeEarnerRoleType('Trainee')).toBe(true);
      expect(isFeeEarnerRoleType('Partner/Member')).toBe(true);
      expect(isFeeEarnerRoleType('Business services')).toBe(false);
      expect(isFeeEarnerRoleType('Apprentice')).toBe(false);
    });
  });

  describe('2. Organisation structure hierarchy & data migration', () => {
    it('maps legacy employee_role and department choice values into managed reference tables and reports unmapped values', () => {
      expect(mapLegacyEmployeeRoleToRoleType('employee_role.partner')).toMatchObject({
        roleType: 'Partner/Member',
        engagementType: 'LLP member',
      });
      expect(mapLegacyEmployeeRoleToRoleType('employee_role.trainee')).toMatchObject({
        roleType: 'Trainee',
        engagementType: 'Employee',
      });

      const org = buildDefaultOrgStructure({ legalName: 'Test Firm LLP' });
      const resolvedRealEstate = resolveOrgDepartment('department.real_estate', org);
      expect(resolvedRealEstate?.id).toBe('DEPT-RE');
      expect(resolvedRealEstate?.parentDivisionId).toBe('DIV-LEGAL');
      expect(resolvedRealEstate?.defaultCostCentreId).toBe('CC-RE');

      const store = getStore();
      // Add an employee with an unmapped legacy role & department to verify migration reporting
      const customPerson: Person = {
        ...store.people[0],
        id: 'P-999901',
        firstName: 'Test',
        surname: 'Unmapped',
        isEmployee: true,
        employeeRoleId: 'employee_role.unknown_custom',
        departmentId: 'department.unknown_custom',
        employment: null,
      };
      const migration = migrateEmployeesToEmploymentRecords(
        [...store.people, customPerson],
        store.values,
        store.orgStructure,
        store.pmsLinks,
        'notalawfirm.example',
      );

      expect(migration.report.migratedCount).toBeGreaterThanOrEqual(1);
      expect(
        migration.report.unmappedRecords.some(
          (u) => u.personId === 'P-999901' && u.field === 'employeeRoleId',
        ),
      ).toBe(true);
      expect(
        migration.report.unmappedRecords.some(
          (u) => u.personId === 'P-999901' && u.field === 'departmentId',
        ),
      ).toBe(true);
    });
  });

  describe('3. Effective dating (movers & rate changes)', () => {
    it('preserves history with effectiveFrom and effectiveTo when department, job title, grade, office, line manager, FTE or charge-out rate changes', () => {
      const store = getStore();
      const empPerson = store.people.find((p) => p.id === 'P-000002')!;
      const prevEmp = empPerson.employment!;

      const nextEmp: EmploymentRecord = {
        ...prevEmp,
        jobTitle: 'Partner',
        gradeOrBand: 'Equity Partner',
        departmentId: 'DEPT-CORP',
        effectiveFrom: '2026-05-01',
        contract: {
          ...prevEmp.contract!,
          fte: 0.8,
        },
        feeEarner: {
          ...prevEmp.feeEarner!,
          chargeOutRateGbp: 425,
          chargeOutRateEffectiveFrom: '2026-05-01',
        },
      };

      const dated = applyEffectiveDatedEmploymentHistory(
        prevEmp,
        nextEmp,
        'P-000004',
        '2026-05-01T09:00:00Z',
      );
      expect(dated.assignmentHistory.length).toBeGreaterThanOrEqual(2);
      const closedEntry = dated.assignmentHistory.find((h) => h.effectiveTo !== null);
      const currentEntry = dated.assignmentHistory.find((h) => h.effectiveTo === null);
      expect(closedEntry).toBeDefined();
      expect(currentEntry?.jobTitle).toBe('Partner');
      expect(currentEntry?.departmentId).toBe('DEPT-CORP');
      expect(currentEntry?.fte).toBe(0.8);

      const rateHistory = dated.feeEarner?.chargeOutRateHistory ?? [];
      expect(rateHistory.length).toBeGreaterThanOrEqual(2);
      expect(rateHistory.find((r) => r.effectiveTo === null)?.rateGbpPerHour).toBe(425);
    });
  });

  describe('4. Four conversion paths & single Person record rule', () => {
    it('Path A & B (Contact / Client -> Employee): keeps single person record, preserves external contact jobTitle, detects open matter party conflict, and flags to Risk for an information barrier', async () => {
      const store = getStore();
      // Find a non-employee person who is a party or instructing contact on an open matter
      const nonEmployeeParty = store.people.find(
        (p) =>
          !p.isEmployee &&
          !p.employment &&
          findOpenMattersWherePersonIsParty(p.id, store.matters).length > 0,
      )!;
      expect(nonEmployeeParty).toBeDefined();
      const externalJobTitle = nonEmployeeParty.jobTitle;

      const conflicts = findOpenMattersWherePersonIsParty(nonEmployeeParty.id, store.matters);
      expect(conflicts.length).toBeGreaterThan(0);

      // Save this existing contact/client as joining the firm (Employee) via System Admin P-000004
      const res = await savePersonRecord(
        {
          ...nonEmployeeParty,
          firstName: nonEmployeeParty.firstName,
          surname: nonEmployeeParty.surname,
          dateOfBirth: nonEmployeeParty.dateOfBirth || '1985-06-15',
          isEmployee: true,
        },
        {
          id: nonEmployeeParty.id,
          byId: 'P-000004',
          mfaVerified: true,
          worksAtFirm: true,
          employmentSubmitted: {
            engagementType: 'Employee',
            status: 'Pre-start',
            employeeNumber: 'EMP-99881',
            employingEntityId: 'LE-PV-LLP',
            jobTitle: 'Associate',
            gradeOrBand: 'Band 3',
            roleType: 'Fee earner',
            divisionId: 'DIV-LEGAL',
            departmentId: 'DEPT-RE',
            teamOrPracticeGroupId: 'TEAM-RE-COMM',
            officeId: 'OFF-CDF',
            costCentreId: 'CC-RE',
            profitCentreId: 'PC-RE',
            isTopOfHierarchy: false,
            lineManagerId: 'P-000001',
            supervisingPartnerId: 'P-000001',
            timesheetApproverId: 'P-000001',
            holidayApproverId: 'P-000001',
            onboardingBuddyId: null,
            effectiveFrom: '2026-06-01',
            effectiveTo: null,
            contract: {
              startDate: '2026-06-01',
              continuousServiceDate: '2026-06-01',
              contractType: 'Permanent',
              fixedTermEndDate: null,
              fte: 1.0,
              workingPattern: 'Full-time',
              workingPatternNotes: '',
              workLocationArrangement: 'Hybrid',
              probationPeriodMonths: 6,
              probationEndDate: '2026-12-01',
              probationEndDateOverridden: false,
              probationOutcome: 'Pending',
              noticePeriod: '3 months',
              holidayEntitlementDays: 25,
              leavingDate: null,
              leavingReasonId: null,
              eligibleForRehire: 'Yes',
              keepAsContactOnLeave: true,
              hrRetentionUntil: null,
            },
            feeEarner: {
              timekeeperCode: 'FE-NEW99881',
              chargeOutRateGbp: 275,
              chargeOutRateEffectiveFrom: '2026-06-01',
              chargeOutRateHistory: [],
              chargeableHoursTarget: 1400,
              billingApprovalLimitGbp: 2500,
              sraNumber: 'SRA-99881',
              practisingCertificateStatus: 'Current',
              practisingCertificateRenewalDate: '2026-10-31',
              admissionDate: '2020-09-01',
            },
          },
        },
      );

      expect(res.errors).toBeUndefined();
      // Same person ID is preserved — never duplicated
      expect(res.person.id).toBe(nonEmployeeParty.id);
      // External contact job title is not overwritten by firm job title
      expect(res.person.jobTitle).toBe(externalJobTitle);
      expect(res.person.employment?.jobTitle).toBe('Associate');
      // Conflict check on hire flagged to Risk for information barrier
      expect(res.person.employment?.conflictCheckOnHire?.flaggedToRisk).toBe(true);
      expect(res.person.employment?.conflictCheckOnHire?.informationBarrierConsidered).toBe(
        true,
      );
      expect(res.person.employment?.conflictCheckOnHire?.openMatterIds.length).toBeGreaterThan(
        0,
      );
    });

    it('Path C (Employee -> Client): marks matter as staff matter with restricted access and shows Right-to-Work evidence on file without auto-completing Client ID verification', async () => {
      const store = getStore();
      const employeeClient = store.people.find((p) => p.id === 'P-000002')!;
      const initialVerificationStatus = employeeClient.verificationStatusId;

      const rtwEvidence = getRightToWorkEvidenceOnFile(employeeClient);
      expect(rtwEvidence.hasEvidence).toBe(true);
      expect(employeeClient.verificationStatusId).toBe(initialVerificationStatus);

      // Create a matter where active employee P-000002 is the client
      const staffCheck = computeStaffMatterStatus(
        {
          clientId: 'P-000002',
          responsiblePartnerId: 'P-000001',
          supervisingPartnerId: 'P-000001',
          leadFeeEarnerId: 'P-000001',
          teamMemberIds: [],
        },
        store.people,
      );
      expect(staffCheck.isStaffMatter).toBe(true);
      expect(staffCheck.restrictedAccessUserIds).toContain('P-000001');

      const templateMatter = store.matters[0];
      const verifiedSession = verifySignedEntraSessionCookie(
        createSignedEntraSessionCookie({
          personId: 'P-000001',
          tenantId: 'not-a-law-firm',
          oid: '00000000-0000-4000-8000-000000000001',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: 'P-000001',
          email: 'rhian.morgan@notalawfirm.example',
          displayName: 'Rhian Morgan',
          entraRoles: ['partner'],
          mappedRoles: ['partner'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      )!;
      const matterRes = await runWithActiveActorSession(
        {
          personId: 'P-000001',
          tenantId: 'not-a-law-firm',
          tokenRoles: ['partner'],
          expiresAtMs: Date.now() + 3600_000,
          verifiedSession,
        },
        async () =>
          saveMatterRecord(
            {
              title: 'Residential purchase for staff member',
              clientId: 'P-000002',
              practiceAreaId: templateMatter.practiceAreaId,
              workTypeSubcategoryId: templateMatter.workTypeSubcategoryId,
              responsiblePartnerId: 'P-000001',
              supervisingPartnerId: 'P-000001',
              leadFeeEarnerId: 'P-000001',
              teamMemberIds: [],
            },
            { byId: 'P-000001' },
          ),
      );
      expect(matterRes.errors).toBeUndefined();
      expect(matterRes.matter).not.toBeNull();
      expect(matterRes.matter!.isStaffMatter).toBe(true);

      // Involved partner P-000001 can access; uninvolved fee earner P-000005 cannot browse by default
      const p1 = store.people.find((p) => p.id === 'P-000001')!;
      const p5 = store.people.find((p) => p.id === 'P-000005')!;
      expect(canUserAccessMatter(matterRes.matter!, 'P-000001', p1)).toBe(true);
      expect(canUserAccessMatter(matterRes.matter!, 'P-000005', p5)).toBe(false);
    });

    it('Path D (Employee -> Leaver -> Contact): sets status to Leaver, deactivates firm-issued email/extension, keeps personal contact details & marketing consent, hides from employee selectors, and supports reassigning owned records', async () => {
      const store = getStore();
      const target = store.people.find((p) => p.id === 'P-000005')!;
      const personalEmail = {
        id: 'em-personal-5',
        address: 'personal.contact@example.com',
        typeId: 'email_type.personal',
        isPrimary: false,
        firmIssued: false,
        active: true,
      };

      const saveRes = await savePersonRecord(
        {
          ...target,
          firstName: target.firstName,
          surname: target.surname,
          emails: [...target.emails, personalEmail],
          marketingConsentId: 'marketing_consent.opted_in',
        },
        {
          id: target.id,
          byId: 'P-000004',
          mfaVerified: true,
          worksAtFirm: true,
          keepAsContactOnLeave: true,
          employmentSubmitted: {
            ...target.employment!,
            status: 'Leaver',
            effectiveTo: '2026-08-31',
            contract: {
              ...target.employment!.contract!,
              leavingDate: '2026-08-31',
              leavingReasonId: 'leaving_reason.resignation',
              keepAsContactOnLeave: true,
            },
          },
        },
      );

      expect(saveRes.errors).toBeUndefined();
      const leaverUpdated = saveRes.person;
      expect(leaverUpdated.isEmployee).toBe(false);
      expect(leaverUpdated.employment?.status).toBe('Leaver');
      expect(leaverUpdated.employment?.effectiveTo).toBe('2026-08-31');
      expect(leaverUpdated.employment?.contract?.hrRetentionUntil).toBe('2032-08-31');

      // Firm-issued work email & phone are marked inactive; personal email & marketing consent remain active
      const firmEmail = leaverUpdated.emails.find((e) => e.firmIssued);
      const keptPersonal = leaverUpdated.emails.find(
        (e) => e.address === 'personal.contact@example.com',
      );
      expect(firmEmail?.active).toBe(false);
      expect(keptPersonal?.active).toBe(true);
      expect(leaverUpdated.marketingConsentId).toBe('marketing_consent.opted_in');

      // R154: An email on the configured primaryDomain is deactivated on leave even if firmIssued was false, whereas a personal domain is never inferred as the firm's
      const unflaggedFirmDomainEmail = {
        id: 'em-unflagged-firm-5',
        address: 'unflagged.work@notalawfirm.example',
        typeId: 'email_type.other',
        isPrimary: false,
        firmIssued: false,
        active: true,
      };
      const secondLeaverSave = await savePersonRecord(
        {
          ...leaverUpdated,
          emails: [...leaverUpdated.emails, unflaggedFirmDomainEmail],
        },
        {
          id: target.id,
          byId: 'P-000004',
          worksAtFirm: true,
          keepAsContactOnLeave: true,
          employmentSubmitted: {
            ...leaverUpdated.employment!,
            status: 'Leaver',
          },
        },
      );
      expect(
        secondLeaverSave.person.emails.find(
          (e) => e.address === 'unflagged.work@notalawfirm.example',
        )?.active,
      ).toBe(false);
      expect(
        secondLeaverSave.person.emails.find(
          (e) => e.address === 'personal.contact@example.com',
        )?.active,
      ).toBe(true);

      // Selector rules: Leaver is no longer selectable, and existing references show "Left"
      expect(isSelectableInEmployeeDropdown(leaverUpdated)).toBe(false);
      expect(isLeaverPerson(leaverUpdated)).toBe(true);
      expect(formatEmployeeSelectorOptionLabel(leaverUpdated, store.values)).toContain(
        'Left',
      );

      // Assign a person record to this leaver and test reassignment
      store.people[0].relationshipOwnerId = leaverUpdated.id;
      const ownedBefore = findRecordsOwnedByLeavers(
        store.people,
        store.organisations,
        store.matters,
        store.tasks,
        store.enquiries,
        leaverUpdated.id,
      );
      expect(ownedBefore.length).toBeGreaterThan(0);

      const reassignRes = await reassignLeaverOwnedRecords(
        leaverUpdated.id,
        'P-000001',
        'P-000004',
      );
      expect(reassignRes.errors).toBeUndefined();
      expect(reassignRes.reassignedCount).toBeGreaterThan(0);

      const ownedAfter = findRecordsOwnedByLeavers(
        store.people,
        store.organisations,
        store.matters,
        store.tasks,
        store.enquiries,
        leaverUpdated.id,
      );
      expect(ownedAfter.length).toBe(0);
      resetStore();
    });
  });

  describe('5. API & UI permissions and audit logging', () => {
    it('enforces employee:view_core, employee:edit_core, employee:hr_restricted, employee:payroll, and employee:sensitive at the API level and logs views/updates', async () => {
      const store = getStore();
      // P-000004 is System Administrator / HR Admin (all 5 permissions)
      const adminUser = store.people.find((p) => p.id === 'P-000004')!;
      // Create a basic employee with only employee:view_core
      const basicUser: Person = {
        ...store.people.find((p) => p.id === 'P-000002')!,
        id: 'P-BASIC-VIEWER',
        appRole: null,
        roles: [],
        employeeRoleId: 'employee_role.solicitor',
        departmentId: 'department.real_estate',
        employeePermissions: ['employee:view_core'],
      };

      const adminPerms = resolveEmployeePermissions(adminUser, store.people, store.teams);
      const basicPerms = resolveEmployeePermissions(basicUser, store.people, store.teams);

      expect(adminPerms).toContain('employee:payroll');
      expect(adminPerms).toContain('employee:sensitive');
      expect(basicPerms).toEqual(['employee:view_core']);

      // API filtering: basicUser receives core employment & systems, but NOT contract, rightToWork, payroll, or emergencyContacts
      const targetEmp = store.people.find((p) => p.id === 'P-000002')!;
      const filteredForBasic = filterEmploymentForUser(
        targetEmp.employment,
        basicUser,
        store.people,
        store.teams,
      );
      expect(filteredForBasic?.jobTitle).toBeDefined();
      expect(filteredForBasic?.contract).toBeUndefined();
      expect(filteredForBasic?.rightToWork).toBeUndefined();
      expect(filteredForBasic?.payroll).toBeUndefined();
      expect(filteredForBasic?.emergencyContacts).toBeUndefined();

      // Snapshot for non-payroll/non-sensitive user P-000002 omits sensitive records and payroll
      const snapshotForP2 = await getAppSnapshot('P-000002');
      expect(Object.keys(snapshotForP2.employeeSensitiveRecords)).toHaveLength(0);
      const p1InSnapshot = snapshotForP2.people.find((p) => p.id === 'P-000001')!;
      expect(p1InSnapshot.employment?.payroll).toBeUndefined();

      // Audit logging when viewing payroll or sensitive details via getEmployeeDetailsForUser & logEmployeeRestrictedAccess
      const hrAudit = async () => [
        ...(await listAuditEntriesForRecord('employee_payroll', 'P-000002', 'P-000004', { limit: 1000 })),
        ...(await listAuditEntriesForRecord('employee_sensitive', 'P-000002', 'P-000004', { limit: 1000 })),
      ];
      const auditBefore = await hrAudit();
      const payrollViewsBefore = auditBefore.filter((a) => a.action === 'view-payroll').length;
      const sensitiveViewsBefore = auditBefore.filter((a) => a.action === 'view-sensitive').length;
      const detailsRes = await getEmployeeDetailsForUser('P-000002', 'P-000004', {
        logViewPayroll: true,
        logViewSensitive: true,
      });
      expect(detailsRes.errors).toBeUndefined();
      const auditAfter = await hrAudit();
      expect(auditAfter.length).toBeGreaterThan(auditBefore.length);
      expect(auditAfter.filter((a) => a.action === 'view-payroll').length).toBe(payrollViewsBefore + 1);
      expect(auditAfter.filter((a) => a.action === 'view-sensitive').length).toBe(sensitiveViewsBefore + 1);

      const logRes = await logEmployeeRestrictedAccess(
        'P-000002',
        'payroll',
        'P-000004',
        'Revealed masked NI and bank details in UI',
      );
      expect(logRes.error).toBeUndefined();
      expect(logRes.auditEntry?.action).toBe('view-payroll');
    });

    it('preserves existing employeeSensitiveRecords[id] when saving a person without sensitiveSubmitted (R76)', async () => {
      const store = getStore();
      const target = store.people.find((p) => p.id === 'P-000002')!;

      // First save a sensitive record on P-000002 as HR Admin P-000004
      await savePersonRecord(
        {
          ...target,
          firstName: target.firstName,
          surname: target.surname,
        },
        {
          id: target.id,
          byId: 'P-000004',
          worksAtFirm: true,
          employmentSubmitted: target.employment,
          sensitiveSubmitted: {
            reasonableAdjustmentsNeeded: 'Ergonomic standing desk and dual monitors',
          },
        },
      );
      expect(
        store.employeeSensitiveRecords?.[target.id]?.reasonableAdjustmentsNeeded,
      ).toBe('Ergonomic standing desk and dual monitors');

      const countSensitiveAudit = async (action: string) =>
        (
          await listAuditEntriesForRecord('employee_sensitive', target.id, 'P-000004', { limit: 1000 })
        ).filter((a) => a.recordId === target.id && a.action === action).length;
      const sensitiveAuditCountBefore = await countSensitiveAudit('update-sensitive');

      // Form helper sends null unless the sensitive section was both revealed and edited
      expect(
        buildSensitiveSubmissionPayload({
          isEmployee: true,
          canSensitive: true,
          sensitiveRevealed: false,
          sensitiveEdited: false,
          reasonableAdjustments: '',
          diversityAnswers: emptyDiversityAnswers(),
        }),
      ).toBeNull();
      expect(
        buildSensitiveSubmissionPayload({
          isEmployee: true,
          canSensitive: true,
          sensitiveRevealed: true,
          sensitiveEdited: false,
          reasonableAdjustments: 'Opened but not edited',
          diversityAnswers: emptyDiversityAnswers(),
        }),
      ).toBeNull();
      expect(
        buildSensitiveSubmissionPayload({
          isEmployee: true,
          canSensitive: true,
          sensitiveRevealed: true,
          sensitiveEdited: true,
          reasonableAdjustments: 'Screen reader licence',
          diversityAnswers: emptyDiversityAnswers(),
        }),
      ).toEqual({
        reasonableAdjustmentsNeeded: 'Screen reader licence',
        diversity: emptyDiversityAnswers(),
      });

      // Server enforcement: even if a caller sends a blank sensitiveSubmitted payload without opening/editing
      // the sensitive section, savePersonRecord refuses to overwrite the existing sensitive record
      const uneditedServerAttempt = await savePersonRecord(
        {
          ...target,
          firstName: target.firstName,
          surname: target.surname,
          preferredName: 'Daf',
        },
        {
          id: target.id,
          byId: 'P-000004',
          worksAtFirm: true,
          employmentSubmitted: target.employment,
          sensitiveSubmitted: {
            reasonableAdjustmentsNeeded: '',
            diversity: emptyDiversityAnswers(),
          },
          sensitiveSectionOpened: false,
          sensitiveSectionEdited: false,
        },
      );
      expect(uneditedServerAttempt.errors).toBeUndefined();
      expect(
        store.employeeSensitiveRecords?.[target.id]?.reasonableAdjustmentsNeeded,
      ).toBe('Ergonomic standing desk and dual monitors');

      // Now save P-000002 again (e.g. updating preferredName) without revealing/submitting sensitive section
      const updateRes = await savePersonRecord(
        {
          ...target,
          firstName: target.firstName,
          surname: target.surname,
          preferredName: 'Daf',
        },
        {
          id: target.id,
          byId: 'P-000004',
          worksAtFirm: true,
          employmentSubmitted: target.employment,
          sensitiveSubmitted: null,
        },
      );
      expect(updateRes.errors).toBeUndefined();
      expect(
        store.employeeSensitiveRecords?.[target.id]?.reasonableAdjustmentsNeeded,
      ).toBe('Ergonomic standing desk and dual monitors');
      const sensitiveAuditCountAfter = await countSensitiveAudit('update-sensitive');
      expect(sensitiveAuditCountAfter).toBe(sensitiveAuditCountBefore);

      // When both sensitiveSectionOpened and sensitiveSectionEdited are true, server applies the update
      await savePersonRecord(
        {
          ...target,
          firstName: target.firstName,
          surname: target.surname,
        },
        {
          id: target.id,
          byId: 'P-000004',
          worksAtFirm: true,
          employmentSubmitted: target.employment,
          sensitiveSubmitted: {
            reasonableAdjustmentsNeeded: 'Ergonomic standing desk and dual monitors',
          },
          sensitiveSectionOpened: true,
          sensitiveSectionEdited: true,
        },
      );

      // R103 & R76: Calling getEmployeeDetailsForUser without logViewSensitive: true returns sensitive: null and writes no view-sensitive audit entry
      const viewAuditCountBefore = await countSensitiveAudit('view-sensitive');
      const unrevealed = await getEmployeeDetailsForUser(target.id, 'P-000004');
      expect(unrevealed.sensitive).toBeNull();
      const viewAuditCountAfterUnrevealed = await countSensitiveAudit('view-sensitive');
      expect(viewAuditCountAfterUnrevealed).toBe(viewAuditCountBefore);

      // Revealing on demand via getEmployeeDetailsForUser with logViewSensitive: true returns the preserved record and logs view-sensitive
      const revealed = await getEmployeeDetailsForUser(target.id, 'P-000004', {
        logViewSensitive: true,
      });
      expect(revealed.sensitive?.reasonableAdjustmentsNeeded).toBe(
        'Ergonomic standing desk and dual monitors',
      );
      const viewAuditCountAfterRevealed = await countSensitiveAudit('view-sensitive');
      expect(viewAuditCountAfterRevealed).toBe(viewAuditCountBefore + 1);
    });
  });

  describe('6. New Matter department pre-selection and department-scoped dropdowns', () => {
    it('pre-selects Department, Responsible Partner (from Supervising Partner), and Fee Earner for a fee earner in a legal department', async () => {
      const snap = await getAppSnapshot('P-000002'); // Dafydd Evans (Real Estate Fee Earner)
      const practiceAreas = snap.values.filter(
        (v) => v.listKey === 'work_type' && !v.parentId && v.active,
      );

      const defaults = resolveNewMatterDepartmentDefaults({
        currentUser: snap.currentUser,
        allPeople: snap.people,
        employees: snap.employees,
        practiceAreas,
      });

      expect(defaults.practiceAreaId).toBe('work_type.real_estate_and_property');
      expect(defaults.responsiblePartnerId).toBe('P-000001'); // Rhian Morgan (Supervising Partner)
      expect(defaults.leadFeeEarnerId).toBe('P-000002'); // Dafydd Evans (logged-in fee earner)
    });

    it('pre-selects Department and Responsible Partner but leaves Fee Earner blank for support staff in a legal department', async () => {
      const snap = await getAppSnapshot('P-000010'); // Nia Edwards (Real Estate Legal Secretary)
      const practiceAreas = snap.values.filter(
        (v) => v.listKey === 'work_type' && !v.parentId && v.active,
      );

      const defaults = resolveNewMatterDepartmentDefaults({
        currentUser: snap.currentUser,
        allPeople: snap.people,
        employees: snap.employees,
        practiceAreas,
      });

      expect(defaults.practiceAreaId).toBe('work_type.real_estate_and_property');
      expect(defaults.responsiblePartnerId).toBe('P-000001'); // Rhian Morgan (Supervising Partner)
      expect(defaults.leadFeeEarnerId).toBeNull();
    });

    it('does not pre-select Department, Responsible Partner, or Fee Earner when logged-in user is in a Business Services department', async () => {
      const snap = await getAppSnapshot('P-000009'); // Gethin Powell (Finance)
      const practiceAreas = snap.values.filter(
        (v) => v.listKey === 'work_type' && !v.parentId && v.active,
      );

      const defaults = resolveNewMatterDepartmentDefaults({
        currentUser: snap.currentUser,
        allPeople: snap.people,
        employees: snap.employees,
        practiceAreas,
      });

      expect(defaults.practiceAreaId).toBe('');
      expect(defaults.responsiblePartnerId).toBeNull();
      expect(defaults.leadFeeEarnerId).toBeNull();
    });

    it('filters Responsible Partner and Fee Earner dropdown options strictly to people in the relevant department', async () => {
      const snap = await getAppSnapshot('P-000001');
      const practiceAreas = snap.values.filter(
        (v) => v.listKey === 'work_type' && !v.parentId && v.active,
      );

      const rePeople = filterEmployeesForMatterDepartment({
        employees: snap.employees,
        practiceAreaId: 'work_type.real_estate_and_property',
        practiceAreas,
      });
      expect(rePeople.map((p) => p.id)).toContain('P-000001'); // Rhian Morgan
      expect(rePeople.map((p) => p.id)).toContain('P-000002'); // Dafydd Evans
      expect(rePeople.map((p) => p.id)).not.toContain('P-000005'); // Siân Llewellyn (Private Client)
      expect(rePeople.map((p) => p.id)).not.toContain('P-000006'); // Owain Jenkins (Dispute Resolution)

      const pcPeople = filterEmployeesForMatterDepartment({
        employees: snap.employees,
        practiceAreaId: 'work_type.private_client',
        practiceAreas,
      });
      expect(pcPeople.map((p) => p.id)).toContain('P-000005'); // Siân Llewellyn
      expect(pcPeople.map((p) => p.id)).not.toContain('P-000001'); // Rhian Morgan (Real Estate)
      expect(pcPeople.map((p) => p.id)).not.toContain('P-000002'); // Dafydd Evans (Real Estate)
    });
  });
});
