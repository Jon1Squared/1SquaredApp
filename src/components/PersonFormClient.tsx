'use client';

import React, { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronDown, Eye, EyeOff, ShieldAlert } from 'lucide-react';
import {
  logEmployeeRestrictedAccessAction,
  reassignLeaverOwnedRecordsAction,
  revealEmployeeSensitiveRecordAction,
  savePersonAction,
} from '@/app/actions';
import { findPersonDuplicates, formatDuplicateReasons } from '@/domain/duplicates';
import {
  buildSensitiveSubmissionPayload,
  calculateHrRetentionDate,
  calculateProbationEndDate,
  CONTRACT_TYPES,
  DIVERSITY_OPTIONS,
  EMPLOYEE_ROLE_TYPES,
  EMPLOYMENT_STATUSES,
  emptyDiversityAnswers,
  ENGAGEMENT_TYPES,
  findOpenMattersWherePersonIsParty,
  findRecordsOwnedByLeavers,
  generateNextEmployeeNumber,
  getRightToWorkEvidenceOnFile,
  isFeeEarnerRoleType,
  isWorkingAtFirm,
   type LeaverOwnedRecordItem,
  maskBankDetails,
  maskNationalInsuranceNumber,
  validateNationalInsuranceNumber,
} from '@/domain/employment';
import {
  detectPreliminaryConflicts,
  findEnquiryEntityMatches,
  hasQuickConflictCheckInputs,
  mergePeopleWithEnquiries,
} from '@/domain/enquiries';
import { InfoPopover } from './InfoPopover';
import { resolveLabel, valueBySystemKey, valuesForList } from '@/domain/lists';
import { personDisplayName, primaryEmail } from '@/domain/names';
import {
  buildDefaultOrgStructure,
  DEFAULT_LEGAL_ENTITY_ID,
  mapLegacyEmployeeRoleToRoleType,
  mapRoleTypeToLegacyEmployeeRoleId,
  resolveOrgDepartment,
  resolveOrgOffice,
} from '@/domain/orgStructure';
import type {
  Address,
  ChoiceList,
  ChoiceValue,
  ContractType,
  CustomFieldDefinition,
  DiversityMonitoringAnswers,
  Email,
  EmergencyContact,
  EmployeePermission,
  EmployeeRoleType,
  EmployeeSensitiveRecord,
  EmploymentRecord,
  EmploymentStatus,
  EngagementType,
  Enquiry,
  Matter,
  Organisation,
  OrgStructureCatalogue,
  OtherName,
  Person,
  Phone,
  ProbationOutcome,
  RightToWorkMethod,
  WorkLocationArrangement,
} from '@/domain/types';
import {
  ChoiceMultiGroup,
  ChoiceSelect,
  EmployeeSelect,
  emptyAddress,
  SingleAddressEditor,
} from './FormControls';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

interface Props {
  existing?: Person | null;
  allPeople: Person[];
  organisations: Organisation[];
  matters?: Matter[];
  enquiries?: Enquiry[];
  employees: Person[];
  lists: ChoiceList[];
  values: ChoiceValue[];
  customFields: CustomFieldDefinition[];
  currentUserId: string;
  orgStructure?: OrgStructureCatalogue;
  currentUserEmployeePermissions?: EmployeePermission[];
  existingSensitive?: EmployeeSensitiveRecord | null;
  leaverOwnedRecords?: LeaverOwnedRecordItem[];
  embeddedInModal?: boolean;
  nameOnlyMandatory?: boolean;
  modalTitle?: string;
  modalSubmitLabel?: string;
  modalCancelLabel?: string;
  modalSelectExistingLabel?: (person: Person) => string;
  topSlot?: React.ReactNode;
  highlightMissingClientFields?: boolean;
  initialFirstName?: string;
  initialSurname?: string;
  initialLinkOrgId?: string;
  onCancelModal?: () => void;
  onSelectExistingPerson?: (person: Person) => void;
  onPersonCreated?: (person: Person, linkedOrgId?: string) => void;
}

const DEMO_POSTCODE_ADDRESSES: Record<
  string,
  { line1: string; line2: string; town: string; county: string }[]
> = {
  CF101AA: [
    { line1: '12 Park Place', line2: '', town: 'Cardiff', county: 'South Glamorgan' },
    { line1: '14 Park Place', line2: 'Suite 2', town: 'Cardiff', county: 'South Glamorgan' },
  ],
  CF105FQ: [
    {
      line1: '3 Bute Dock Chambers',
      line2: 'Mount Stuart Square',
      town: 'Cardiff',
      county: 'South Glamorgan',
    },
  ],
  CF119HS: [
    { line1: '18 Cathedral View', line2: 'Pontcanna', town: 'Cardiff', county: 'South Glamorgan' },
  ],
  CF641TQ: [
    { line1: 'Marina House, 14 Ferry Road', line2: '', town: 'Penarth', county: 'Vale of Glamorgan' },
  ],
  BS16DZ: [
    { line1: 'Severn House, 1 Temple Quay', line2: '', town: 'Bristol', county: 'Bristol' },
  ],
};

type SectionKey =
  | 'most_used'
  | 'personal'
  | 'employee'
  | 'organisation'
  | 'relationship'
  | 'compliance'
  | 'custom';

type EmployeeSubTabKey =
  | 'core'
  | 'contract'
  | 'fee_earner'
  | 'right_to_work'
  | 'payroll'
  | 'emergency_contacts'
  | 'sensitive'
  | 'systems';

export function PersonFormClient({
  existing,
  allPeople,
  organisations,
  matters = [],
  enquiries = [],
  employees,
  lists,
  values,
  customFields,
  currentUserId,
  orgStructure: orgStructureProp,
  currentUserEmployeePermissions,
  existingSensitive = null,
  leaverOwnedRecords: leaverOwnedRecordsProp,
  embeddedInModal = false,
  nameOnlyMandatory = false,
  modalTitle,
  modalSubmitLabel,
  modalCancelLabel,
  modalSelectExistingLabel,
  topSlot,
  highlightMissingClientFields = false,
  initialFirstName,
  initialSurname,
  initialLinkOrgId,
  onCancelModal,
  onSelectExistingPerson,
  onPersonCreated,
}: Props) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [continueAnyway, setContinueAnyway] = useState(false);

  const orgStructure = useMemo(
    () => orgStructureProp ?? buildDefaultOrgStructure(),
    [orgStructureProp],
  );

  const currentUser = useMemo(
    () => allPeople.find((p) => p.id === currentUserId) ?? null,
    [allPeople, currentUserId],
  );

  const userPerms = useMemo<Set<EmployeePermission>>(
    () => new Set(currentUserEmployeePermissions ?? []),
    [currentUserEmployeePermissions],
  );

  const canViewCore = userPerms.has('employee:view_core');
  const canEditCore = userPerms.has('employee:edit_core');
  const canHrRestricted = userPerms.has('employee:hr_restricted');
  const canPayroll = userPerms.has('employee:payroll');
  const canSensitive = userPerms.has('employee:sensitive');

  // Active tab in "2 · MORE DETAILS"
  const [activeTab, setActiveTab] = useState<SectionKey>('most_used');
  // Active sub-tab in "Works at the firm"
  const [empSubTab, setEmpSubTab] = useState<EmployeeSubTabKey>('core');

  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const defaultWorkEmailType = useMemo(
    () => valuesForList(values, 'email_type').find((v) => v.label === 'Work')?.id ?? null,
    [values],
  );
  const defaultMobileType = useMemo(
    () => valuesForList(values, 'phone_type').find((v) => v.label === 'Mobile')?.id ?? null,
    [values],
  );
  const defaultHomeAddressType = useMemo(
    () => valuesForList(values, 'address_type').find((v) => v.label === 'Home')?.id ?? null,
    [values],
  );
  const countries = useMemo(
    () => valuesForList(values, 'country').filter((v) => v.active),
    [values],
  );
  const defaultCountryId = useMemo(
    () =>
      countries.find((v) => v.label === 'United Kingdom' || v.label === 'Wales')?.id ??
      countries[0]?.id ??
      null,
    [countries],
  );
  const origins = useMemo(
    () => valuesForList(values, 'origin').filter((v) => v.active),
    [values],
  );
  const defaultActiveStatus = useMemo(
    () => valueBySystemKey(values, 'person_record_status', 'active')?.id ?? '',
    [values],
  );
  const defaultRelStatus = useMemo(
    () => valuesForList(values, 'relationship_status').find((v) => v.label === 'Active')?.id ?? null,
    [values],
  );
  const defaultLanguage = useMemo(
    () => valuesForList(values, 'language').find((v) => v.label === 'English')?.id ?? null,
    [values],
  );
  const defaultConsent = useMemo(
    () =>
      valuesForList(values, 'marketing_consent').find((v) => v.label === 'Not asked')?.id ?? null,
    [values],
  );
  const defaultVerification = useMemo(
    () =>
      valueBySystemKey(values, 'verification_status', 'not_started')?.id ??
      valuesForList(values, 'verification_status')[0]?.id ??
      null,
    [values],
  );
  const defaultSource = useMemo(
    () => valuesForList(values, 'data_source').find((v) => v.label === 'Manual entry')?.id ?? null,
    [values],
  );

  // Mandatory & Personal details
  const [createdFromEnquiryId, setCreatedFromEnquiryId] = useState<string | null>(
    existing?.createdFromEnquiryId ?? null,
  );
  const [titleId, setTitleId] = useState<string | null>(existing?.titleId ?? null);
  const [firstName, setFirstName] = useState(existing?.firstName ?? initialFirstName ?? '');
  const [middleNames, setMiddleNames] = useState(existing?.middleNames ?? '');
  const [surname, setSurname] = useState(existing?.surname ?? initialSurname ?? '');
  const [preferredName, setPreferredName] = useState(existing?.preferredName ?? '');
  const [dateOfBirth, setDateOfBirth] = useState(existing?.dateOfBirth ?? '');
  const [jobTitle, setJobTitle] = useState(existing?.jobTitle ?? '');
  const [otherNames, setOtherNames] = useState<OtherName[]>(existing?.otherNames ?? []);
  const [emails, setEmails] = useState<Email[]>(
    existing?.emails?.length
      ? existing.emails
      : [
          {
            id: 'em-1',
            address: '',
            typeId: defaultWorkEmailType,
            isPrimary: true,
          },
        ],
  );
  const [phones, setPhones] = useState<Phone[]>(
    existing?.phones?.length
      ? existing.phones
      : [
          {
            id: 'ph-1',
            number: '',
            typeId: defaultMobileType,
          },
        ],
  );
  const [addresses, setAddresses] = useState<Address[]>(
    existing?.addresses?.length
      ? existing.addresses
      : [
          {
            id: 'addr-primary',
            typeId: defaultHomeAddressType,
            line1: '',
            line2: '',
            town: '',
            county: '',
            postcode: '',
            countryId: defaultCountryId,
          },
        ],
  );
  const [addressModalOpen, setAddressModalOpen] = useState(false);

  const primaryAddr: Address = addresses[0] ?? {
    id: 'addr-primary',
    typeId: defaultHomeAddressType,
    line1: '',
    line2: '',
    town: '',
    county: '',
    postcode: '',
    countryId: defaultCountryId,
  };

  const updatePrimaryAddress = (patch: Partial<Address>) => {
    setAddresses((prev) => {
      const current = prev[0] ?? {
        id: 'addr-primary',
        typeId: defaultHomeAddressType,
        line1: '',
        line2: '',
        town: '',
        county: '',
        postcode: '',
        countryId: defaultCountryId,
      };
      const updated = { ...current, ...patch };
      return [updated, ...prev.slice(1)];
    });
  };

  const [preferredContactMethodId, setPreferredContactMethodId] = useState<string | null>(
    existing?.preferredContactMethodId ?? null,
  );
  const [preferredLanguageId, setPreferredLanguageId] = useState<string | null>(
    existing?.preferredLanguageId ?? defaultLanguage,
  );
  const [website, setWebsite] = useState(existing?.website ?? '');

  // =========================================================================
  // Employee / Engagement at the firm ("Works at the firm")
  // =========================================================================
  const existingEmp = existing?.employment ?? null;
  const initialMappedRole = useMemo(
    () => mapLegacyEmployeeRoleToRoleType(existing?.employeeRoleId),
    [existing?.employeeRoleId],
  );
  const initialResolvedDept = useMemo(
    () =>
      resolveOrgDepartment(
        existingEmp?.departmentId ?? existing?.departmentId,
        orgStructure,
      ) ?? orgStructure.departments[0],
    [existingEmp?.departmentId, existing?.departmentId, orgStructure],
  );
  const initialResolvedOffice = useMemo(
    () =>
      resolveOrgOffice(
        existingEmp?.officeId ?? existing?.addresses?.[0]?.town,
        orgStructure,
      ) ?? orgStructure.offices[0],
    [existingEmp?.officeId, existing?.addresses, orgStructure],
  );

  const [isEmployee, setIsEmployee] = useState(
    Boolean(existingEmp || existing?.isEmployee),
  );
  const [employeeRoleId, setEmployeeRoleId] = useState<string | null>(
    existing?.employeeRoleId ?? null,
  );
  const [departmentId, setDepartmentId] = useState<string | null>(
    existing?.departmentId ?? null,
  );

  // 1. Core employment
  const [empEngagementType, setEmpEngagementType] = useState<EngagementType>(
    existingEmp?.engagementType ?? initialMappedRole?.engagementType ?? 'Employee',
  );
  const [empStatus, setEmpStatus] = useState<EmploymentStatus>(
    existingEmp?.status ?? (existing?.isEmployee ? 'Active' : 'Pre-start'),
  );
  const [empNumber, setEmpNumber] = useState<string>(
    () => existingEmp?.employeeNumber ?? generateNextEmployeeNumber(allPeople),
  );
  const [empEntityId, setEmpEntityId] = useState<string>(
    existingEmp?.employingEntityId ?? DEFAULT_LEGAL_ENTITY_ID,
  );
  // Firm job title is separate from contact job title (`jobTitle` on Person)
  const [empJobTitle, setEmpJobTitle] = useState<string>(
    existingEmp?.jobTitle ?? (existing?.isEmployee ? existing.jobTitle : ''),
  );
  const [empGradeOrBand, setEmpGradeOrBand] = useState<string>(
    existingEmp?.gradeOrBand ?? '',
  );
  const [empRoleType, setEmpRoleType] = useState<EmployeeRoleType>(
    existingEmp?.roleType ?? initialMappedRole?.roleType ?? 'Fee earner',
  );
  const [empDivisionId, setEmpDivisionId] = useState<string | null>(
    existingEmp?.divisionId ?? initialResolvedDept?.parentDivisionId ?? 'DIV-LEGAL',
  );
  const [empDepartmentId, setEmpDepartmentId] = useState<string>(
    existingEmp?.departmentId ?? initialResolvedDept?.id ?? 'DEPT-RE',
  );
  const [empTeamOrPgId, setEmpTeamOrPgId] = useState<string | null>(
    existingEmp?.teamOrPracticeGroupId ??
      orgStructure.teamsOrPracticeGroups.find(
        (t) => t.parentDepartmentId === (existingEmp?.departmentId ?? initialResolvedDept?.id),
      )?.id ??
      null,
  );
  const [empOfficeId, setEmpOfficeId] = useState<string | null>(
    existingEmp?.officeId ?? initialResolvedOffice?.id ?? 'OFF-CDF',
  );
  const [empCostCentreId, setEmpCostCentreId] = useState<string | null>(
    existingEmp?.costCentreId ?? initialResolvedDept?.defaultCostCentreId ?? 'CC-RE',
  );
  const [empProfitCentreId, setEmpProfitCentreId] = useState<string | null>(
    existingEmp?.profitCentreId ?? initialResolvedDept?.defaultProfitCentreId ?? 'PC-RE',
  );
  const [empIsTopOfHierarchy, setEmpIsTopOfHierarchy] = useState<boolean>(
    Boolean(existingEmp?.isTopOfHierarchy),
  );
  const [empLineManagerId, setEmpLineManagerId] = useState<string | null>(
    existingEmp?.lineManagerId ?? (existingEmp?.isTopOfHierarchy ? null : 'P-000001'),
  );
  const [empSupervisingPartnerId, setEmpSupervisingPartnerId] = useState<string | null>(
    existingEmp?.supervisingPartnerId ?? null,
  );
  const [empTimesheetApproverId, setEmpTimesheetApproverId] = useState<string | null>(
    existingEmp?.timesheetApproverId ?? existingEmp?.lineManagerId ?? 'P-000001',
  );
  const [empHolidayApproverId, setEmpHolidayApproverId] = useState<string | null>(
    existingEmp?.holidayApproverId ?? existingEmp?.lineManagerId ?? 'P-000001',
  );
  const [empOnboardingBuddyId, setEmpOnboardingBuddyId] = useState<string | null>(
    existingEmp?.onboardingBuddyId ?? null,
  );
  const [empEffectiveFrom, setEmpEffectiveFrom] = useState<string>(
    existingEmp?.effectiveFrom ?? todayStr,
  );
  const [showAssignmentHistory, setShowAssignmentHistory] = useState(false);

  // 2. Contract and terms (HR restricted)
  const [empStartDate, setEmpStartDate] = useState<string>(
    existingEmp?.contract?.startDate ?? existingEmp?.effectiveFrom ?? todayStr,
  );
  const [empContinuousServiceDate, setEmpContinuousServiceDate] = useState<string>(
    existingEmp?.contract?.continuousServiceDate ??
      existingEmp?.contract?.startDate ??
      existingEmp?.effectiveFrom ??
      todayStr,
  );
  const [empContractType, setEmpContractType] = useState<ContractType>(
    existingEmp?.contract?.contractType ?? 'Permanent',
  );
  const [empFixedTermEndDate, setEmpFixedTermEndDate] = useState<string>(
    existingEmp?.contract?.fixedTermEndDate ?? '',
  );
  const [empFte, setEmpFte] = useState<number>(existingEmp?.contract?.fte ?? 1.0);
  const [empWorkingPattern, setEmpWorkingPattern] = useState<string>(
    existingEmp?.contract?.workingPattern ?? 'Full-time (37.5 hrs, Mon–Fri)',
  );
  const [empWorkingPatternNotes, setEmpWorkingPatternNotes] = useState<string>(
    existingEmp?.contract?.workingPatternNotes ?? '',
  );
  const [empWorkLocationArrangement, setEmpWorkLocationArrangement] =
    useState<WorkLocationArrangement>(
      existingEmp?.contract?.workLocationArrangement ?? 'Hybrid',
    );
  const [empProbationMonths, setEmpProbationMonths] = useState<number>(
    existingEmp?.contract?.probationPeriodMonths ??
      orgStructure.defaultProbationMonths ??
      6,
  );
  const [empProbationEndDateOverridden, setEmpProbationEndDateOverridden] =
    useState<boolean>(Boolean(existingEmp?.contract?.probationEndDateOverridden));
  const [empProbationEndDate, setEmpProbationEndDate] = useState<string>(
    () =>
      existingEmp?.contract?.probationEndDate ??
      calculateProbationEndDate(
        existingEmp?.contract?.startDate ?? todayStr,
        existingEmp?.contract?.probationPeriodMonths ??
          orgStructure.defaultProbationMonths ??
          6,
      ) ??
      '',
  );
  const [empProbationOutcome, setEmpProbationOutcome] = useState<ProbationOutcome>(
    existingEmp?.contract?.probationOutcome ?? 'Pending',
  );
  const [empNoticePeriod, setEmpNoticePeriod] = useState<string>(
    existingEmp?.contract?.noticePeriod ?? '3 months',
  );
  const [empHolidayEntitlement, setEmpHolidayEntitlement] = useState<number>(
    existingEmp?.contract?.holidayEntitlementDays ?? 25,
  );
  const [empLeavingDate, setEmpLeavingDate] = useState<string>(
    existingEmp?.contract?.leavingDate ?? '',
  );
  const [empLeavingReasonId, setEmpLeavingReasonId] = useState<string | null>(
    existingEmp?.contract?.leavingReasonId ?? null,
  );
  const [empEligibleForRehire, setEmpEligibleForRehire] = useState<
    'Yes' | 'No' | 'Conditional' | null
  >(existingEmp?.contract?.eligibleForRehire ?? 'Yes');
  const [empKeepAsContactOnLeave, setEmpKeepAsContactOnLeave] = useState<boolean>(
    existingEmp?.contract?.keepAsContactOnLeave ?? true,
  );

  // 3. Fee earner details (shown only when roleType is Fee earner, Trainee, or Partner/Member)
  const [feTimekeeperCode, setFeTimekeeperCode] = useState<string>(
    existingEmp?.feeEarner?.timekeeperCode ?? '',
  );
  const [feChargeOutRate, setFeChargeOutRate] = useState<string>(
    existingEmp?.feeEarner?.chargeOutRateGbp !== null &&
      existingEmp?.feeEarner?.chargeOutRateGbp !== undefined
      ? String(existingEmp.feeEarner.chargeOutRateGbp)
      : '',
  );
  const [feRateEffectiveFrom, setFeRateEffectiveFrom] = useState<string>(
    existingEmp?.feeEarner?.chargeOutRateEffectiveFrom ?? todayStr,
  );
  const [feChargeableHoursTarget, setFeChargeableHoursTarget] = useState<string>(
    existingEmp?.feeEarner?.chargeableHoursTarget !== null &&
      existingEmp?.feeEarner?.chargeableHoursTarget !== undefined
      ? String(existingEmp.feeEarner.chargeableHoursTarget)
      : '1400',
  );
  const [feBillingApprovalLimit, setFeBillingApprovalLimit] = useState<string>(
    existingEmp?.feeEarner?.billingApprovalLimitGbp !== null &&
      existingEmp?.feeEarner?.billingApprovalLimitGbp !== undefined
      ? String(existingEmp.feeEarner.billingApprovalLimitGbp)
      : '2500',
  );
  const [feSraNumber, setFeSraNumber] = useState<string>(
    existingEmp?.feeEarner?.sraNumber ?? '',
  );
  const [fePractisingCertStatus, setFePractisingCertStatus] = useState<
    'Current' | 'Pending renewal' | 'Conditions attached' | 'Suspended' | 'Not applicable' | ''
  >(existingEmp?.feeEarner?.practisingCertificateStatus ?? 'Current');
  const [fePractisingCertRenewalDate, setFePractisingCertRenewalDate] = useState<string>(
    existingEmp?.feeEarner?.practisingCertificateRenewalDate ?? '',
  );
  const [feAdmissionDate, setFeAdmissionDate] = useState<string>(
    existingEmp?.feeEarner?.admissionDate ?? '',
  );
  const [showRateHistory, setShowRateHistory] = useState(false);

  // 4. Right to work and vetting (HR restricted)
  const [rtwCheckDate, setRtwCheckDate] = useState<string>(
    existingEmp?.rightToWork?.checkDate ?? '',
  );
  const [rtwMethod, setRtwMethod] = useState<RightToWorkMethod | ''>(
    existingEmp?.rightToWork?.method ?? '',
  );
  const [rtwDocumentType, setRtwDocumentType] = useState<string>(
    existingEmp?.rightToWork?.documentType ?? '',
  );
  const [rtwExpiryDate, setRtwExpiryDate] = useState<string>(
    existingEmp?.rightToWork?.expiryDate ?? '',
  );
  const [rtwFollowUpDate, setRtwFollowUpDate] = useState<string>(
    existingEmp?.rightToWork?.followUpCheckDueDate ?? '',
  );
  const [dbsCheckType, setDbsCheckType] = useState<string>(
    existingEmp?.rightToWork?.dbsCheckType ?? 'Standard DBS',
  );
  const [dbsCheckDate, setDbsCheckDate] = useState<string>(
    existingEmp?.rightToWork?.dbsCheckDate ?? '',
  );
  const [dbsOutcome, setDbsOutcome] = useState<string>(
    existingEmp?.rightToWork?.dbsOutcome ?? '',
  );
  const [dbsReference, setDbsReference] = useState<string>(
    existingEmp?.rightToWork?.dbsReference ?? '',
  );
  const [referencesReceived, setReferencesReceived] = useState<'yes' | 'no' | ''>(
    existingEmp?.rightToWork?.referencesReceived === true
      ? 'yes'
      : existingEmp?.rightToWork?.referencesReceived === false
        ? 'no'
        : '',
  );
  const [referencesReceivedDate, setReferencesReceivedDate] = useState<string>(
    existingEmp?.rightToWork?.referencesReceivedDate ?? '',
  );

  // 5. Payroll and benefits (Payroll restricted)
  const [externalPayrollOnlyMode, setExternalPayrollOnlyMode] = useState<boolean>(
    Boolean(orgStructure.externalPayrollOnly),
  );
  const [payExternalRef, setPayExternalRef] = useState<string>(
    existingEmp?.payroll?.externalPayrollReference ?? `PAY-${empNumber}`,
  );
  const [payNiNumber, setPayNiNumber] = useState<string>(
    existingEmp?.payroll?.nationalInsuranceNumber ?? '',
  );
  const [payBankAccountName, setPayBankAccountName] = useState<string>(
    existingEmp?.payroll?.bankAccountName ?? '',
  );
  const [payBankSortCode, setPayBankSortCode] = useState<string>(
    existingEmp?.payroll?.bankSortCode ?? '',
  );
  const [payBankAccountNumber, setPayBankAccountNumber] = useState<string>(
    existingEmp?.payroll?.bankAccountNumber ?? '',
  );
  const [payBuildingSocietyRoll, setPayBuildingSocietyRoll] = useState<string>(
    existingEmp?.payroll?.buildingSocietyRollNumber ?? '',
  );
  const [payStarterDecl, setPayStarterDecl] = useState<string>(
    existingEmp?.payroll?.starterDeclarationOrP45 ?? 'P45 received',
  );
  const [payStudentLoan, setPayStudentLoan] = useState<string>(
    existingEmp?.payroll?.studentLoanPlan ?? 'None',
  );
  const [payPensionStatus, setPayPensionStatus] = useState<string>(
    existingEmp?.payroll?.pensionAutoEnrolmentStatus ?? 'Eligible jobholder — enrolled',
  );
  const [payPensionOptOutDate, setPayPensionOptOutDate] = useState<string>(
    existingEmp?.payroll?.pensionOptOutDate ?? '',
  );
  const [payrollMasked, setPayrollMasked] = useState<boolean>(true);

  // 6. Emergency contacts (HR restricted, inline on employment record — never separate Person records)
  const [emergencyContacts, setEmergencyContacts] = useState<EmergencyContact[]>(
    existingEmp?.emergencyContacts ?? [],
  );

  // 7. Sensitive information (special category data — stored separately with its own permission & audit)
  const [reasonableAdjustments, setReasonableAdjustments] = useState<string>(
    existingSensitive?.reasonableAdjustmentsNeeded ?? '',
  );
  const [diversityAnswers, setDiversityAnswers] = useState<DiversityMonitoringAnswers>(
    () => ({
      ...emptyDiversityAnswers(),
      ...(existingSensitive?.diversity ?? {}),
    }),
  );
  const [sensitiveRevealed, setSensitiveRevealed] = useState<boolean>(false);
  const [sensitiveEdited, setSensitiveEdited] = useState<boolean>(false);

  // 8. Systems and access
  const [sysNetworkLogin, setSysNetworkLogin] = useState<string>(
    existingEmp?.systems?.networkLogin ?? '',
  );
  const [sysBuildingPass, setSysBuildingPass] = useState<string>(
    existingEmp?.systems?.buildingPassNumber ?? '',
  );
  const [sysExtension, setSysExtension] = useState<string>(
    existingEmp?.systems?.extension ?? '',
  );
  const [sysFirmWorkEmail, setSysFirmWorkEmail] = useState<string>(
    existingEmp?.systems?.firmWorkEmail ??
      existing?.emails?.find(
        (e) =>
          e.address.toLowerCase().includes('@notalawfirm') ||
          e.address.toLowerCase().includes('@pembrokevaughan'),
      )?.address ??
      '',
  );
  const [sysDpTrainingDate, setSysDpTrainingDate] = useState<string>(
    existingEmp?.systems?.dataProtectionTrainingCompletedAt ?? '',
  );
  const [sysAmlTrainingDate, setSysAmlTrainingDate] = useState<string>(
    existingEmp?.systems?.amlTrainingCompletedAt ?? '',
  );
  const [sysInfoSecTrainingDate, setSysInfoSecTrainingDate] = useState<string>(
    existingEmp?.systems?.infoSecTrainingCompletedAt ?? '',
  );

  // Reassignment target state when a person is marked as Leaver and owns records
  const [reassignTargetEmployeeId, setReassignTargetEmployeeId] = useState<string>(
    employees.find((e) => e.id !== existing?.id)?.id ?? 'P-000001',
  );

  // Check if existing contact/client is a party on any open matter (for conflict check on hire)
  const openMattersWherePersonIsParty = useMemo(
    () =>
      existing
        ? findOpenMattersWherePersonIsParty(existing.id, matters)
        : [],
    [existing, matters],
  );

  // Records owned by this person if they are a leaver (or being marked as a leaver)
  const leaverRecordsForPerson = useMemo(() => {
    if (!existing) return [];
    if (leaverOwnedRecordsProp) {
      const fromProp = leaverOwnedRecordsProp.filter((r) => r.leaverId === existing.id);
      if (fromProp.length > 0) return fromProp;
    }
    if (empStatus === 'Leaver') {
      const simulatedPeople = allPeople.map((p) =>
        p.id === existing.id
          ? {
              ...p,
              employment: {
                ...(p.employment ?? ({} as EmploymentRecord)),
                status: 'Leaver' as const,
              },
            }
          : p,
      );
      return findRecordsOwnedByLeavers(simulatedPeople, organisations, matters, [], [], existing.id);
    }
    return [];
  }, [existing, leaverOwnedRecordsProp, empStatus, allPeople, organisations, matters]);

  // Right-to-work evidence on file (shown in Compliance tab without altering Client ID verification status)
  const rightToWorkEvidence = useMemo(() => {
    if (rtwCheckDate || rtwDocumentType || rtwMethod) {
      return {
        hasEvidence: true,
        summary: [
          rtwDocumentType || 'Right to work document',
          rtwMethod ? `(${rtwMethod})` : '',
          rtwCheckDate ? `checked on ${rtwCheckDate}` : '',
        ]
          .filter(Boolean)
          .join(' '),
      };
    }
    return getRightToWorkEvidenceOnFile(existing);
  }, [rtwCheckDate, rtwDocumentType, rtwMethod, existing]);

  const availableDepartments = useMemo(
    () =>
      orgStructure.departments.filter(
        (d) => d.active && (!empDivisionId || d.parentDivisionId === empDivisionId),
      ),
    [orgStructure.departments, empDivisionId],
  );

  const availableTeams = useMemo(
    () =>
      orgStructure.teamsOrPracticeGroups.filter(
        (t) => t.active && (!empDepartmentId || t.parentDepartmentId === empDepartmentId),
      ),
    [orgStructure.teamsOrPracticeGroups, empDepartmentId],
  );

  const handleEmpDepartmentChange = (nextDeptId: string) => {
    setEmpDepartmentId(nextDeptId);
    const dept = orgStructure.departments.find((d) => d.id === nextDeptId);
    if (dept) {
      setEmpDivisionId(dept.parentDivisionId);
      setEmpCostCentreId(dept.defaultCostCentreId);
      setEmpProfitCentreId(dept.defaultProfitCentreId);
      setDepartmentId(dept.legacyChoiceValueId ?? dept.id);
      const firstTeam = orgStructure.teamsOrPracticeGroups.find(
        (t) => t.active && t.parentDepartmentId === dept.id,
      );
      setEmpTeamOrPgId(firstTeam?.id ?? null);
    }
  };

  const handleLineManagerChange = (nextMgrId: string | null) => {
    const prevMgrId = empLineManagerId;
    setEmpLineManagerId(nextMgrId);
    if (!empTimesheetApproverId || empTimesheetApproverId === prevMgrId) {
      setEmpTimesheetApproverId(nextMgrId);
    }
    if (!empHolidayApproverId || empHolidayApproverId === prevMgrId) {
      setEmpHolidayApproverId(nextMgrId);
    }
  };

  const handleStartDateChange = (nextStart: string) => {
    const prevStart = empStartDate;
    setEmpStartDate(nextStart);
    if (!empContinuousServiceDate || empContinuousServiceDate === prevStart) {
      setEmpContinuousServiceDate(nextStart);
    }
    if (!empProbationEndDateOverridden) {
      const calc = calculateProbationEndDate(nextStart, empProbationMonths);
      if (calc) setEmpProbationEndDate(calc);
    }
  };

  const handleProbationMonthsChange = (nextMonths: number) => {
    setEmpProbationMonths(nextMonths);
    if (!empProbationEndDateOverridden && empStartDate) {
      const calc = calculateProbationEndDate(empStartDate, nextMonths);
      if (calc) setEmpProbationEndDate(calc);
    }
  };

  const handleTogglePayrollMask = () => {
    const nextMasked = !payrollMasked;
    setPayrollMasked(nextMasked);
    if (!nextMasked && existing?.id) {
      startTransition(async () => {
        await logEmployeeRestrictedAccessAction(
          existing.id,
          'payroll',
          'Revealed masked NI and bank details in UI',
        );
      });
    }
  };

  const handleRevealSensitive = () => {
    setSensitiveRevealed(true);
    if (existing?.id) {
      startTransition(async () => {
        const res = await revealEmployeeSensitiveRecordAction(existing.id);
        if (res.ok && res.sensitive) {
          setReasonableAdjustments(res.sensitive.reasonableAdjustmentsNeeded ?? '');
          setDiversityAnswers({
            ...emptyDiversityAnswers(),
            ...(res.sensitive.diversity ?? {}),
          });
        }
      });
    }
  };

  // Optional initial organisation link (when creating a new person)
  const [linkOrgId, setLinkOrgId] = useState(initialLinkOrgId ?? '');
  const [linkJobTitle, setLinkJobTitle] = useState('');
  const [linkDepartment, setLinkDepartment] = useState('');
  const [linkRoleWithinOrg, setLinkRoleWithinOrg] = useState('');
  const [linkContactRoleIds, setLinkContactRoleIds] = useState<string[]>([]);
  const [linkPrimary, setLinkPrimary] = useState(false);

  // Relationship management
  const [relationshipOwnerId, setRelationshipOwnerId] = useState<string | null>(
    existing?.relationshipOwnerId ?? currentUserId,
  );
  const [relationshipStatusId, setRelationshipStatusId] = useState<string | null>(
    existing?.relationshipStatusId ?? defaultRelStatus,
  );
  const [relationshipStandingId, setRelationshipStandingId] = useState<string | null>(
    existing?.relationshipStandingId ?? null,
  );
  const [relationshipRoleIds, setRelationshipRoleIds] = useState<string[]>(
    existing?.relationshipRoleIds ?? [],
  );
  const [originId, setOriginId] = useState<string | null>(existing?.originId ?? null);
  const [firstKnownAt, setFirstKnownAt] = useState(
    existing?.firstKnownAt ?? new Date().toISOString().slice(0, 10),
  );
  const [lastInteractionAt, setLastInteractionAt] = useState(existing?.lastInteractionAt ?? '');
  const [engagementLevelId, setEngagementLevelId] = useState<string | null>(
    existing?.engagementLevelId ?? null,
  );
  const [interests, setInterests] = useState(existing?.interests ?? '');
  const [relationshipNotes, setRelationshipNotes] = useState(existing?.relationshipNotes ?? '');
  const [marketingConsentId, setMarketingConsentId] = useState<string | null>(
    existing?.marketingConsentId ?? defaultConsent,
  );
  const [consentRecord, setConsentRecord] = useState(existing?.consentRecord ?? '');

  // Compliance and administration
  const [recordStatusId, setRecordStatusId] = useState(
    existing?.recordStatusId ?? defaultActiveStatus,
  );
  const [recordOwnerId, setRecordOwnerId] = useState<string | null>(
    existing?.recordOwnerId ?? currentUserId,
  );
  const [verificationStatusId, setVerificationStatusId] = useState<string | null>(
    existing?.verificationStatusId ?? defaultVerification,
  );
  const [verifiedAt, setVerifiedAt] = useState(existing?.verifiedAt ?? '');
  const [verificationMethodId, setVerificationMethodId] = useState<string | null>(
    existing?.verificationMethodId ?? null,
  );
  const [verificationReviewerId, setVerificationReviewerId] = useState<string | null>(
    existing?.verificationReviewerId ?? null,
  );
  const [riskReferences, setRiskReferences] = useState(existing?.riskReferences ?? '');
  const [sourceId, setSourceId] = useState<string | null>(existing?.sourceId ?? defaultSource);
  const [lastVerifiedAt, setLastVerifiedAt] = useState(
    existing?.lastVerifiedAt ?? new Date().toISOString().slice(0, 10),
  );
  const [tagsText, setTagsText] = useState((existing?.tags ?? []).join(', '));

  // Custom fields
  const [cfValues, setCfValues] = useState<Record<string, unknown>>(existing?.customFields ?? {});

  const personCustomDefs = useMemo(
    () =>
      customFields
        .filter((d) => d.recordType === 'person' && d.active)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [customFields],
  );

  const hasCustomOriginOption = Boolean(
    originId && !origins.some((o) => o.id === originId),
  );

  const cleanEmails = useMemo(
    () => emails.filter((e) => e.address.trim().length > 0),
    [emails],
  );
  const cleanPhones = useMemo(
    () => phones.filter((p) => p.number.trim().length > 0),
    [phones],
  );

  const primaryEmailValue = emails[0]?.address ?? '';
  const primaryPhoneValue = phones[0]?.number ?? '';

  const hasContactInfo = cleanEmails.length > 0 || cleanPhones.length > 0;
  const mandatoryMissingCount = nameOnlyMandatory
    ? (!firstName.trim() ? 1 : 0) +
      (!surname.trim() ? 1 : 0) +
      (isEmployee && !dateOfBirth.trim() ? 1 : 0)
    : (!firstName.trim() ? 1 : 0) +
      (!surname.trim() ? 1 : 0) +
      (!hasContactInfo ? 1 : 0) +
      ((embeddedInModal || isEmployee) && !dateOfBirth.trim() ? 1 : 0);

  const mergedAllPeople = useMemo(
    () => mergePeopleWithEnquiries(allPeople, enquiries, values),
    [allPeople, enquiries, values],
  );

  // Exclude the record being edited from duplicate / conflict self-matches
  const otherPeople = useMemo(
    () => (existing ? mergedAllPeople.filter((p) => p.id !== existing.id) : mergedAllPeople),
    [mergedAllPeople, existing],
  );

  // Live duplicate check while typing
  const liveDuplicates = useMemo(
    () =>
      findPersonDuplicates(
        {
          id: existing?.id,
          firstName,
          surname,
          preferredName,
          emails: cleanEmails.map((e) => e.address),
          phones: cleanPhones.map((p) => p.number),
          addresses: addresses.filter((a) => a.line1.trim() && a.postcode.trim()),
        },
        mergedAllPeople,
        existing?.notDuplicateOf,
        { fuzzy: true },
      ).filter((m) => m.reasons.some((r) => r !== 'address' && r !== 'postcode')),
    [
      existing?.id,
      existing?.notDuplicateOf,
      firstName,
      surname,
      preferredName,
      cleanEmails,
      cleanPhones,
      addresses,
      mergedAllPeople,
    ],
  );

  // Quick Conflict Check (identical to the Enquiry screen)
  const linkedOrgName = useMemo(
    () => (linkOrgId ? organisations.find((o) => o.id === linkOrgId)?.legalName ?? '' : ''),
    [linkOrgId, organisations],
  );
  const otherNamesJoined = useMemo(
    () =>
      [
        preferredName.trim() && preferredName.trim() !== firstName.trim()
          ? `${preferredName.trim()} ${surname.trim()}`.trim()
          : '',
        ...otherNames.map((n) => n.name.trim()),
      ]
        .filter(Boolean)
        .join(', '),
    [preferredName, firstName, surname, otherNames],
  );

  const liveEntityMatches = useMemo(
    () =>
      findEnquiryEntityMatches(
        {
          firstName,
          lastName: surname,
          email: primaryEmailValue,
          phone: primaryPhoneValue,
          callingOnBehalfOf: linkedOrgName,
          postcode: primaryAddr.postcode,
          addressLine1: primaryAddr.line1,
          addressLine2: primaryAddr.line2,
          otherPartiesNamed: otherNamesJoined,
        },
        otherPeople,
        organisations,
        enquiries,
      ),
    [
      firstName,
      surname,
      primaryEmailValue,
      primaryPhoneValue,
      linkedOrgName,
      primaryAddr.postcode,
      primaryAddr.line1,
      primaryAddr.line2,
      otherNamesJoined,
      otherPeople,
      organisations,
      enquiries,
    ],
  );

  const possibleConflicts = useMemo(
    () =>
      detectPreliminaryConflicts(
        {
          firstName,
          lastName: surname,
          callingOnBehalfOf: linkedOrgName,
          otherPartiesNamed: otherNamesJoined,
          email: primaryEmailValue,
          phone: primaryPhoneValue,
          address: {
            line1: primaryAddr.line1,
            line2: primaryAddr.line2,
            postcode: primaryAddr.postcode,
          },
          linkedPersonId: null,
          linkedOrganisationId: linkOrgId || null,
        },
        otherPeople,
        organisations,
        matters,
        values,
        enquiries,
      ),
    [
      firstName,
      surname,
      linkedOrgName,
      otherNamesJoined,
      primaryEmailValue,
      primaryPhoneValue,
      primaryAddr.line1,
      primaryAddr.line2,
      primaryAddr.postcode,
      linkOrgId,
      otherPeople,
      organisations,
      matters,
      values,
      enquiries,
    ],
  );

  const conflictKeys = useMemo(
    () => new Set(possibleConflicts.map((h) => `${h.recordType}:${h.recordId}`)),
    [possibleConflicts],
  );

  const entityReasonsByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of liveEntityMatches.people) map.set(`person:${m.person.id}`, m.formattedReasons);
    for (const m of liveEntityMatches.organisations) {
      map.set(`organisation:${m.organisation.id}`, m.formattedReasons);
    }
    return map;
  }, [liveEntityMatches]);

  const knownPeople = useMemo(
    () => liveEntityMatches.people.filter((m) => !conflictKeys.has(`person:${m.person.id}`)),
    [liveEntityMatches, conflictKeys],
  );

  const knownOrganisations = useMemo(
    () =>
      liveEntityMatches.organisations.filter(
        (m) => !conflictKeys.has(`organisation:${m.organisation.id}`),
      ),
    [liveEntityMatches, conflictKeys],
  );

  const hasSearchInputs = useMemo(
    () =>
      hasQuickConflictCheckInputs({
        firstName,
        lastName: surname,
        callingOnBehalfOf: linkedOrgName,
        otherPartiesNamed: otherNamesJoined,
        email: primaryEmailValue,
        phone: primaryPhoneValue,
        postcode: primaryAddr.postcode,
      }) || Boolean(primaryAddr.line1.trim() && primaryAddr.postcode.trim()),
    [
      firstName,
      surname,
      linkedOrgName,
      otherNamesJoined,
      primaryEmailValue,
      primaryPhoneValue,
      primaryAddr.postcode,
      primaryAddr.line1,
    ],
  );

  const hasHighSeverityConflict = useMemo(
    () => possibleConflicts.some((h) => h.severity === 'high' || h.blocking),
    [possibleConflicts],
  );

  const distinctMatchedCount = conflictKeys.size + knownPeople.length + knownOrganisations.length;

  const linkExistingOrg = (o: Organisation) => {
    setLinkOrgId(o.id);
    if (!primaryAddr.line1.trim() && o.registeredAddress) {
      updatePrimaryAddress({
        line1: o.registeredAddress.line1,
        line2: o.registeredAddress.line2,
        town: o.registeredAddress.town,
        county: o.registeredAddress.county,
        postcode: o.registeredAddress.postcode,
        countryId: o.registeredAddress.countryId,
      });
    }
    showToast(`Linked to ${o.legalName} (${o.id})`);
  };

  const handleFindAddress = () => {
    setAddressModalOpen(true);
    const clean = (primaryAddr.postcode ?? '').replace(/\s+/g, '').toUpperCase();
    if (!clean) {
      return;
    }
    for (const p of allPeople) {
      const addr = p.addresses.find(
        (a) => (a.postcode ?? '').replace(/\s+/g, '').toUpperCase() === clean,
      );
      if (addr) {
        updatePrimaryAddress({
          line1: addr.line1,
          line2: addr.line2,
          town: addr.town,
          county: addr.county,
          postcode: addr.postcode,
          ...(addr.countryId ? { countryId: addr.countryId } : {}),
        });
        showToast(`Filled address for ${addr.postcode}`);
        return;
      }
    }
    for (const o of organisations) {
      const addr = o.registeredAddress;
      if (addr && (addr.postcode ?? '').replace(/\s+/g, '').toUpperCase() === clean) {
        updatePrimaryAddress({
          line1: addr.line1,
          line2: addr.line2,
          town: addr.town,
          county: addr.county,
          postcode: addr.postcode,
          ...(addr.countryId ? { countryId: addr.countryId } : {}),
        });
        showToast(`Filled address for ${addr.postcode}`);
        return;
      }
    }
    const preset = DEMO_POSTCODE_ADDRESSES[clean]?.[0];
    if (preset) {
      updatePrimaryAddress({
        line1: preset.line1,
        line2: preset.line2,
        town: preset.town,
        county: preset.county,
      });
      showToast(`Filled address for ${primaryAddr.postcode.toUpperCase()}`);
      return;
    }
    const isBristol = clean.startsWith('BS');
    updatePrimaryAddress({
      line1: '14 High Street',
      line2: '',
      town: isBristol ? 'Bristol' : 'Cardiff',
      county: isBristol ? 'Bristol' : 'South Glamorgan',
    });
    showToast(`Filled address for ${primaryAddr.postcode.toUpperCase()}`);
  };

  const submitPerson = (forceFlagDuplicate = false) => {
    setErrorMsg(null);

    if (!firstName.trim() || !surname.trim()) {
      setErrorMsg('First name and surname are required.');
      return;
    }
    if ((highlightMissingClientFields || isEmployee) && !dateOfBirth.trim()) {
      setErrorMsg(
        isEmployee
          ? 'Date of birth is required when a person works at the firm.'
          : 'Date of birth is required to convert this contact to a client.',
      );
      return;
    }
    if (!nameOnlyMandatory && cleanEmails.length === 0 && cleanPhones.length === 0) {
      setErrorMsg('Please provide at least a phone number or an email address.');
      return;
    }

    if (isEmployee) {
      if (!empEngagementType) {
        setActiveTab('employee');
        setEmpSubTab('core');
        setErrorMsg('Engagement type is required.');
        return;
      }
      if (!empStatus) {
        setActiveTab('employee');
        setEmpSubTab('core');
        setErrorMsg('Employment status is required.');
        return;
      }
      if (!empNumber.trim()) {
        setActiveTab('employee');
        setEmpSubTab('core');
        setErrorMsg('Employee number is required.');
        return;
      }
      if (!empJobTitle.trim()) {
        setActiveTab('employee');
        setEmpSubTab('core');
        setErrorMsg('Job title at the firm is required.');
        return;
      }
      if (!empRoleType) {
        setActiveTab('employee');
        setEmpSubTab('core');
        setErrorMsg('Role type is required.');
        return;
      }
      if (!empDepartmentId) {
        setActiveTab('employee');
        setEmpSubTab('core');
        setErrorMsg('Department is required.');
        return;
      }
      if (!empIsTopOfHierarchy && !empLineManagerId) {
        setActiveTab('employee');
        setEmpSubTab('core');
        setErrorMsg('Line manager is required unless at the top of the hierarchy.');
        return;
      }
      if (canHrRestricted && !empStartDate.trim()) {
        setActiveTab('employee');
        setEmpSubTab('contract');
        setErrorMsg('Employment start date is required.');
        return;
      }
      if (
        canHrRestricted &&
        empContractType === 'Fixed term' &&
        !empFixedTermEndDate.trim()
      ) {
        setActiveTab('employee');
        setEmpSubTab('contract');
        setErrorMsg('Fixed term end date is required for fixed-term contracts.');
        return;
      }
      if (canPayroll && payNiNumber.trim() && !validateNationalInsuranceNumber(payNiNumber)) {
        setActiveTab('employee');
        setEmpSubTab('payroll');
        setErrorMsg(
          'National Insurance number must follow valid UK format (e.g. QQ 12 34 56 C).',
        );
        return;
      }
    }

    const shouldFlagDuplicate =
      forceFlagDuplicate || (continueAnyway && liveDuplicates.length > 0);

    const employmentPayload: Partial<EmploymentRecord> | null =
      isEmployee && canEditCore
        ? {
            engagementType: empEngagementType,
            status: empStatus,
            employeeNumber: empNumber.trim(),
            employingEntityId: empEntityId,
            jobTitle: empJobTitle.trim(),
            gradeOrBand: empGradeOrBand.trim(),
            roleType: empRoleType,
            divisionId: empDivisionId,
            departmentId: empDepartmentId,
            teamOrPracticeGroupId: empTeamOrPgId,
            officeId: empOfficeId,
            costCentreId: empCostCentreId,
            profitCentreId: empProfitCentreId,
            isTopOfHierarchy: empIsTopOfHierarchy,
            lineManagerId: empIsTopOfHierarchy ? null : empLineManagerId,
            supervisingPartnerId: empSupervisingPartnerId,
            timesheetApproverId: empTimesheetApproverId || empLineManagerId,
            holidayApproverId: empHolidayApproverId || empLineManagerId,
            onboardingBuddyId: empOnboardingBuddyId,
            effectiveFrom: empEffectiveFrom || todayStr,
            effectiveTo: empStatus === 'Leaver' ? empLeavingDate || todayStr : null,
            ...(canHrRestricted
              ? {
                  contract: {
                    startDate: empStartDate,
                    continuousServiceDate: empContinuousServiceDate || empStartDate,
                    contractType: empContractType,
                    fixedTermEndDate:
                      empContractType === 'Fixed term' ? empFixedTermEndDate || null : null,
                    fte: Number(empFte) || 1.0,
                    workingPattern: empWorkingPattern.trim(),
                    workingPatternNotes: empWorkingPatternNotes.trim(),
                    workLocationArrangement: empWorkLocationArrangement,
                    probationPeriodMonths: Number(empProbationMonths) || 6,
                    probationEndDate: empProbationEndDate || null,
                    probationEndDateOverridden: empProbationEndDateOverridden,
                    probationOutcome: empProbationOutcome,
                    noticePeriod: empNoticePeriod.trim(),
                    holidayEntitlementDays: Number(empHolidayEntitlement) || 25,
                    leavingDate: empLeavingDate || null,
                    leavingReasonId: empLeavingReasonId,
                    eligibleForRehire: empEligibleForRehire,
                    keepAsContactOnLeave: empKeepAsContactOnLeave,
                    hrRetentionUntil:
                      empStatus === 'Leaver' && (empLeavingDate || todayStr)
                        ? calculateHrRetentionDate(empLeavingDate || todayStr, 6)
                        : null,
                  },
                  rightToWork: {
                    checkDate: rtwCheckDate || null,
                    method: rtwMethod,
                    documentType: rtwDocumentType.trim(),
                    expiryDate: rtwExpiryDate || null,
                    followUpCheckDueDate: rtwFollowUpDate || null,
                    dbsCheckType: dbsCheckType.trim(),
                    dbsCheckDate: dbsCheckDate || null,
                    dbsOutcome: dbsOutcome.trim(),
                    dbsReference: dbsReference.trim(),
                    referencesReceived:
                      referencesReceived === 'yes'
                        ? true
                        : referencesReceived === 'no'
                          ? false
                          : null,
                    referencesReceivedDate: referencesReceivedDate || null,
                  },
                  emergencyContacts: emergencyContacts.filter((ec) => ec.name.trim()),
                }
              : {}),
            ...(isFeeEarnerRoleType(empRoleType)
              ? {
                  feeEarner: {
                    timekeeperCode: feTimekeeperCode.trim(),
                    chargeOutRateGbp: feChargeOutRate.trim()
                      ? Number(feChargeOutRate)
                      : null,
                    chargeOutRateEffectiveFrom: feRateEffectiveFrom || todayStr,
                    chargeOutRateHistory:
                      existingEmp?.feeEarner?.chargeOutRateHistory ?? [],
                    chargeableHoursTarget: feChargeableHoursTarget.trim()
                      ? Number(feChargeableHoursTarget)
                      : null,
                    billingApprovalLimitGbp: feBillingApprovalLimit.trim()
                      ? Number(feBillingApprovalLimit)
                      : null,
                    sraNumber: feSraNumber.trim(),
                    practisingCertificateStatus: fePractisingCertStatus,
                    practisingCertificateRenewalDate:
                      fePractisingCertRenewalDate || null,
                    admissionDate: feAdmissionDate || null,
                  },
                }
              : { feeEarner: null }),
            ...(canPayroll
              ? {
                  payroll: {
                    externalPayrollReference: payExternalRef.trim(),
                    nationalInsuranceNumber: externalPayrollOnlyMode
                      ? ''
                      : payNiNumber.trim().toUpperCase(),
                    bankAccountName: externalPayrollOnlyMode
                      ? ''
                      : payBankAccountName.trim(),
                    bankSortCode: externalPayrollOnlyMode ? '' : payBankSortCode.trim(),
                    bankAccountNumber: externalPayrollOnlyMode
                      ? ''
                      : payBankAccountNumber.trim(),
                    buildingSocietyRollNumber: externalPayrollOnlyMode
                      ? ''
                      : payBuildingSocietyRoll.trim(),
                    starterDeclarationOrP45: externalPayrollOnlyMode
                      ? ''
                      : payStarterDecl,
                    studentLoanPlan: externalPayrollOnlyMode ? '' : payStudentLoan,
                    pensionAutoEnrolmentStatus: externalPayrollOnlyMode
                      ? ''
                      : payPensionStatus,
                    pensionOptOutDate: externalPayrollOnlyMode
                      ? null
                      : payPensionOptOutDate || null,
                  },
                }
              : {}),
            systems: {
              networkLogin: sysNetworkLogin.trim(),
              buildingPassNumber: sysBuildingPass.trim(),
              extension: sysExtension.trim(),
              firmWorkEmail: sysFirmWorkEmail.trim(),
              dataProtectionTrainingCompletedAt: sysDpTrainingDate || null,
              amlTrainingCompletedAt: sysAmlTrainingDate || null,
              infoSecTrainingCompletedAt: sysInfoSecTrainingDate || null,
            },
          }
        : null;

    const sensitivePayload: Partial<EmployeeSensitiveRecord> | null =
      buildSensitiveSubmissionPayload({
        isEmployee,
        canSensitive,
        sensitiveRevealed,
        sensitiveEdited,
        reasonableAdjustments,
        diversityAnswers,
      });

    const mappedLegacyRoleId = isEmployee
      ? mapRoleTypeToLegacyEmployeeRoleId(empRoleType, employeeRoleId)
      : null;
    const mappedLegacyDeptId = isEmployee
      ? resolveOrgDepartment(empDepartmentId, orgStructure)?.legacyChoiceValueId ??
        departmentId
      : null;

    startTransition(async () => {
      const res = await savePersonAction(
        {
          titleId,
          firstName: firstName.trim(),
          middleNames: middleNames.trim(),
          surname: surname.trim(),
          preferredName: preferredName.trim(),
          dateOfBirth: dateOfBirth || null,
          otherNames: otherNames.filter((n) => n.name.trim()),
          jobTitle: jobTitle.trim(),
          emails: cleanEmails,
          phones: cleanPhones,
          addresses: addresses.filter(
            (a) =>
              a.line1.trim() ||
              a.line2.trim() ||
              a.town.trim() ||
              a.county.trim() ||
              a.postcode.trim(),
          ),
          preferredContactMethodId,
          preferredLanguageId,
          website: website.trim(),
          isEmployee: isEmployee && empStatus !== 'Leaver',
          employeeRoleId: mappedLegacyRoleId,
          departmentId: mappedLegacyDeptId,
          relationshipOwnerId,
          relationshipStatusId,
          relationshipStandingId,
          relationshipRoleIds,
          originId: originId || null,
          firstKnownAt: firstKnownAt || null,
          lastInteractionAt: lastInteractionAt || null,
          engagementLevelId,
          interests,
          relationshipNotes,
          marketingConsentId,
          consentRecord,
          recordStatusId,
          recordOwnerId,
          verificationStatusId,
          verifiedAt: verifiedAt || null,
          verificationMethodId,
          verificationReviewerId,
          riskReferences,
          sourceId,
          lastVerifiedAt: lastVerifiedAt || null,
          tags: tagsText
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          ...(createdFromEnquiryId ? { createdFromEnquiryId } : {}),
        },
        {
          id: existing?.id,
          customFieldsSubmitted: cfValues,
          flagPossibleDuplicate: shouldFlagDuplicate,
          matchedDuplicateIds: shouldFlagDuplicate
            ? liveDuplicates.map((m) => m.record.id)
            : undefined,
          worksAtFirm: isEmployee,
          employmentSubmitted: employmentPayload,
          sensitiveSubmitted: sensitivePayload,
          sensitiveSectionOpened: sensitiveRevealed,
          sensitiveSectionEdited: sensitiveEdited,
          keepAsContactOnLeave: empKeepAsContactOnLeave,
          initialLink:
            !existing && linkOrgId
              ? {
                  organisationId: linkOrgId,
                  jobTitle: linkJobTitle || jobTitle,
                  department: linkDepartment,
                  roleWithinOrganisation: linkRoleWithinOrg,
                  contactRoleIds: linkContactRoleIds,
                  isPrimaryContact: linkPrimary,
                }
              : null,
        },
      );

      if (res.errors && Object.keys(res.errors).length > 0) {
        setErrorMsg(Object.values(res.errors).join(' '));
        return;
      }

      if (onPersonCreated) {
        onPersonCreated(res.person, linkOrgId || undefined);
        return;
      }

      showToast('Person saved');
      router.push(`/people/${res.person.id}`);
    });
  };

  const setPrimaryEmailValue = (nextAddr: string) => {
    setEmails((prev) => {
      if (prev.length === 0) {
        return [
          {
            id: 'em-1',
            address: nextAddr,
            typeId: defaultWorkEmailType,
            isPrimary: true,
          },
        ];
      }
      const next = [...prev];
      next[0] = { ...next[0], address: nextAddr };
      return next;
    });
  };

  const setPrimaryPhoneValue = (nextNum: string) => {
    setPhones((prev) => {
      if (prev.length === 0) {
        return [
          {
            id: 'ph-1',
            number: nextNum,
            typeId: defaultMobileType,
          },
        ];
      }
      const next = [...prev];
      next[0] = { ...next[0], number: nextNum };
      return next;
    });
  };

  const setCfVal = (id: string, val: unknown) => {
    setCfValues((prev) => ({ ...prev, [id]: val }));
  };

  return (
    <div className="new-enquiry-page" style={embeddedInModal ? { padding: 0, maxWidth: 'none' } : undefined}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submitPerson(liveDuplicates.length > 0);
        }}
      >
        <div className="person-form-layout">
          {/* ==============================================================
              LEFT COLUMN (~65%): 1 · MANDATORY DETAILS + Expandable Sections
              ============================================================== */}
          <div className="person-form-main-col">
            {/* Header Row (matching Enquiry screen) */}
            <div
              className="new-enquiry-header"
              style={embeddedInModal ? { marginBottom: 0, minHeight: 40 } : { marginBottom: 0 }}
            >
              <div style={{ width: '100%' }}>
                {!embeddedInModal ? (
                  <Link href={existing ? `/people/${existing.id}` : '/people'} className="new-enquiry-back">
                    ← Back to {existing ? personDisplayName(existing) : 'people'}
                  </Link>
                ) : null}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 16,
                    flexWrap: 'wrap',
                  }}
                >
                  <h1 className="new-enquiry-title">
                    {modalTitle ?? (existing ? `Edit ${personDisplayName(existing)}` : 'Add a person')}
                  </h1>
                </div>
              </div>
            </div>

            {liveDuplicates.length > 0 ? (
              <div className="banner banner--warning" role="alert">
                <div>
                  <strong>Possible duplicate detected</strong>{' '}
                  <InfoPopover
                    label="About duplicate checks"
                    title="How duplicate checks work"
                    docHref="/docs/duplicate-checks"
                    docLabel="Read about duplicate checks"
                  >
                    <p>
                      Existing records are compared on name (including misspellings and names that sound
                      alike), email, phone and address.
                    </p>
                    <p>
                      A shared address on its own isn&rsquo;t treated as a duplicate, because family
                      members and colleagues often share one.
                    </p>
                  </InfoPopover>
                  {' '}
                  {liveDuplicates.map((m, idx) => (
                    <span key={m.record.id}>
                      {idx > 0 ? '; ' : ''}
                      <strong>{personDisplayName(m.record)}</strong> ({m.record.id}
                      {primaryEmail(m.record) ? `, ${primaryEmail(m.record)}` : ''}) —{' '}
                      {formatDuplicateReasons(m.reasons)}
                    </span>
                  ))}
                  {continueAnyway ? (
                    <div style={{ marginTop: 4 }}>
                      Continuing anyway — saving will flag this record as a{' '}
                      <strong>Possible match</strong> for review.
                    </div>
                  ) : null}
                </div>
                <div className="banner__actions">
                  {onSelectExistingPerson ? (
                    liveDuplicates.map((m) => (
                      <button
                        key={`add-dup-${m.record.id}`}
                        type="button"
                        className="btn btn--primary btn--sm"
                        onClick={() => onSelectExistingPerson(m.record)}
                      >
                        {modalSelectExistingLabel
                          ? modalSelectExistingLabel(m.record)
                          : `Add ${personDisplayName(m.record)} as client`}
                      </button>
                    ))
                  ) : (
                    <>
                      {liveDuplicates[0].record.id.startsWith('ENQ-') ? (
                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          onClick={() => {
                            const rec = liveDuplicates[0].record;
                            if (!firstName.trim()) setFirstName(rec.firstName);
                            if (!surname.trim()) setSurname(rec.surname);
                            if (!primaryEmailValue.trim() && rec.emails[0]?.address) {
                              setPrimaryEmailValue(rec.emails[0].address);
                            }
                            if (!primaryPhoneValue.trim() && rec.phones[0]?.number) {
                              setPrimaryPhoneValue(rec.phones[0].number);
                            }
                            if (!primaryAddr.line1.trim() && rec.addresses[0]) {
                              updatePrimaryAddress(rec.addresses[0]);
                            }
                            setCreatedFromEnquiryId(rec.id);
                            showToast(`Pre-filled details from enquiry ${rec.id}`);
                          }}
                        >
                          Pre-fill from enquiry
                        </button>
                      ) : null}
                      <Link
                        href={`/people/${liveDuplicates[0].record.id}`}
                        className="btn btn--secondary btn--sm"
                      >
                        Open record
                      </Link>
                    </>
                  )}
                  {!continueAnyway ? (
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => setContinueAnyway(true)}
                    >
                      Continue anyway
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {errorMsg ? (
              <div className="banner banner--alert" role="alert">
                <span>{errorMsg}</span>
              </div>
            ) : null}

            {topSlot}
            <section className="new-enquiry-card" aria-labelledby="person-mandatory-heading">
              <div className="new-enquiry-card__top">
                <h2 id="person-mandatory-heading" className="new-enquiry-card__label">
                  1 · MANDATORY DETAILS
                </h2>
                <span
                  className={`new-enquiry-badge ${mandatoryMissingCount === 0 ? 'new-enquiry-badge--ok' : ''}`}
                >
                  {mandatoryMissingCount === 0
                    ? 'Complete'
                    : `${mandatoryMissingCount} required`}
                </span>
              </div>

              <div className="form-grid-3" style={{ marginTop: 4 }}>
                <div className="field-group">
                  <label
                    className="field-label"
                    htmlFor="p-first"
                    style={
                      highlightMissingClientFields && !firstName.trim()
                        ? { color: '#d93025', fontWeight: 700 }
                        : undefined
                    }
                  >
                    First name <span style={{ color: 'var(--coral, #d94a27)' }}>*</span>
                  </label>
                  <input
                    id="p-first"
                    type="text"
                    required
                    autoFocus={!existing}
                    className="field-input"
                    style={
                      highlightMissingClientFields && !firstName.trim()
                        ? {
                            borderColor: '#d93025',
                            boxShadow: '0 0 0 2px rgba(217, 48, 37, 0.16)',
                            background: 'rgba(217, 48, 37, 0.04)',
                          }
                        : undefined
                    }
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                  />
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="p-middle">
                    Middle name
                  </label>
                  <input
                    id="p-middle"
                    type="text"
                    className="field-input"
                    value={middleNames}
                    onChange={(e) => setMiddleNames(e.target.value)}
                  />
                </div>

                <div className="field-group">
                  <label
                    className="field-label"
                    htmlFor="p-surname"
                    style={
                      highlightMissingClientFields && !surname.trim()
                        ? { color: '#d93025', fontWeight: 700 }
                        : undefined
                    }
                  >
                    Surname <span style={{ color: 'var(--coral, #d94a27)' }}>*</span>
                  </label>
                  <input
                    id="p-surname"
                    type="text"
                    required
                    className="field-input"
                    style={
                      highlightMissingClientFields && !surname.trim()
                        ? {
                            borderColor: '#d93025',
                            boxShadow: '0 0 0 2px rgba(217, 48, 37, 0.16)',
                            background: 'rgba(217, 48, 37, 0.04)',
                          }
                        : undefined
                    }
                    value={surname}
                    onChange={(e) => setSurname(e.target.value)}
                  />
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="p-preferred">
                    Preferred name{' '}
                    <span className="muted" style={{ fontWeight: 400 }}>
                      (if different to first name)
                    </span>
                  </label>
                  <input
                    id="p-preferred"
                    type="text"
                    className="field-input"
                    value={preferredName}
                    onChange={(e) => setPreferredName(e.target.value)}
                  />
                </div>

                <div className="field-group">
                  <label
                    className="field-label"
                    htmlFor="p-dob"
                    style={
                      (highlightMissingClientFields || isEmployee) && !dateOfBirth.trim()
                        ? { color: '#d93025', fontWeight: 700 }
                        : undefined
                    }
                  >
                    Date of birth{' '}
                    {(!nameOnlyMandatory && embeddedInModal) || isEmployee ? (
                      <span style={{ color: 'var(--coral, #d94a27)' }}>*</span>
                    ) : null}
                  </label>
                  <input
                    id="p-dob"
                    type="date"
                    required={highlightMissingClientFields || isEmployee}
                    className="field-input"
                    style={
                      (highlightMissingClientFields || isEmployee) && !dateOfBirth.trim()
                        ? {
                            borderColor: '#d93025',
                            boxShadow: '0 0 0 2px rgba(217, 48, 37, 0.16)',
                            background: 'rgba(217, 48, 37, 0.04)',
                          }
                        : undefined
                    }
                    value={dateOfBirth}
                    onChange={(e) => setDateOfBirth(e.target.value)}
                  />
                  {highlightMissingClientFields && !dateOfBirth.trim() ? (
                    <span style={{ fontSize: 12, color: '#d93025', fontWeight: 600, marginTop: 2 }}>
                      Required to convert contact to a client
                    </span>
                  ) : isEmployee && !dateOfBirth.trim() ? (
                    <span style={{ fontSize: 12, color: '#d93025', fontWeight: 600, marginTop: 2 }}>
                      Date of birth is mandatory when a person works at the firm
                    </span>
                  ) : null}
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="p-origin">
                    How they heard about us
                  </label>
                  <select
                    id="p-origin"
                    className="field-select"
                    value={originId ?? ''}
                    onChange={(e) => setOriginId(e.target.value || null)}
                  >
                    <option value="">Not asked yet</option>
                    {hasCustomOriginOption && originId ? (
                      <option value={originId}>
                        {resolveLabel(values, originId) || originId}
                      </option>
                    ) : null}
                    {origins.map((orig) => (
                      <option key={orig.id} value={orig.id}>
                        {orig.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field-group">
                  <label
                    className="field-label"
                    htmlFor="p-email"
                    style={
                      highlightMissingClientFields && !hasContactInfo
                        ? { color: '#d93025', fontWeight: 700 }
                        : undefined
                    }
                  >
                    Email{' '}
                    {!nameOnlyMandatory ? (
                      <span style={{ color: 'var(--coral, #d94a27)' }}>*</span>
                    ) : null}
                  </label>
                  <input
                    id="p-email"
                    type="email"
                    className="field-input"
                    style={
                      highlightMissingClientFields && !hasContactInfo
                        ? {
                            borderColor: '#d93025',
                            boxShadow: '0 0 0 2px rgba(217, 48, 37, 0.16)',
                            background: 'rgba(217, 48, 37, 0.04)',
                          }
                        : undefined
                    }
                    value={primaryEmailValue}
                    onChange={(e) => setPrimaryEmailValue(e.target.value)}
                  />
                </div>

                <div className="field-group">
                  <label
                    className="field-label"
                    htmlFor="p-phone"
                    style={
                      highlightMissingClientFields && !hasContactInfo
                        ? { color: '#d93025', fontWeight: 700 }
                        : undefined
                    }
                  >
                    Phone{' '}
                    {!nameOnlyMandatory ? (
                      <span style={{ color: 'var(--coral, #d94a27)' }}>*</span>
                    ) : null}
                  </label>
                  <input
                    id="p-phone"
                    type="tel"
                    className="field-input"
                    style={
                      highlightMissingClientFields && !hasContactInfo
                        ? {
                            borderColor: '#d93025',
                            boxShadow: '0 0 0 2px rgba(217, 48, 37, 0.16)',
                            background: 'rgba(217, 48, 37, 0.04)',
                          }
                        : undefined
                    }
                    value={primaryPhoneValue}
                    onChange={(e) => setPrimaryPhoneValue(e.target.value)}
                  />
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="p-pref-contact">
                    Preferred contact method
                  </label>
                  <ChoiceSelect
                    id="p-pref-contact"
                    listKey="contact_method"
                    values={values}
                    value={preferredContactMethodId}
                    onChange={setPreferredContactMethodId}
                  />
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="p-pref-language">
                    Preferred language
                  </label>
                  <ChoiceSelect
                    id="p-pref-language"
                    listKey="language"
                    values={values}
                    value={preferredLanguageId}
                    onChange={setPreferredLanguageId}
                  />
                </div>

                {/* ADDRESS SUBSECTION (same format as the Enquiry screen) */}
                <div className="field-group field-group--full" style={{ marginTop: 4 }}>
                  <SingleAddressEditor
                    bare
                    fieldLabelStyle
                    inputId="p-postcode"
                    label="Address"
                    hintText=""
                    address={primaryAddr}
                    values={values}
                    onChange={(nextAddr) => {
                      const next = [...addresses];
                      next[0] = nextAddr ?? emptyAddress(defaultCountryId);
                      setAddresses(next);
                    }}
                  />
                </div>
              </div>
            </section>

            {/* ================================================================
                2 · MORE DETAILS — TABBED VIEW FOR OPTIONAL SECTIONS
                ================================================================ */}
            <section className="new-enquiry-card" aria-labelledby="person-more-heading">
              <div className="new-enquiry-card__top">
                <h2 id="person-more-heading" className="new-enquiry-card__label">
                  2 · MORE DETAILS
                </h2>
              </div>

              <div className="form-tabs-bar" role="tablist" aria-label="Additional person details">
                {(
                  [
                    { key: 'most_used' as const, label: 'Most used', visible: true },
                    { key: 'personal' as const, label: 'Personal & contact', visible: true },
                    { key: 'organisation' as const, label: 'Organisation', visible: true },
                    { key: 'relationship' as const, label: 'Relationship', visible: true },
                    { key: 'compliance' as const, label: 'Compliance', visible: true },
                    { key: 'employee' as const, label: 'Works at the firm', visible: canViewCore },
                    { key: 'custom' as const, label: 'Custom fields', visible: true },
                  ]
                )
                  .filter((tab) => tab.visible)
                  .map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      role="tab"
                      aria-selected={activeTab === tab.key}
                      className={`form-tab-btn ${activeTab === tab.key ? 'form-tab-btn--active' : ''}`}
                      onClick={() => setActiveTab(tab.key)}
                    >
                      {tab.label}
                    </button>
                  ))}
              </div>

              {/* TAB 0: Most used */}
              {activeTab === 'most_used' ? (
                <div role="tabpanel">
                  <div className="form-grid-3">
                    <div className="field-group">
                      <label className="field-label" htmlFor="p-most-title">
                        Title
                      </label>
                      <ChoiceSelect
                        id="p-most-title"
                        listKey="title"
                        values={values}
                        value={titleId}
                        onChange={setTitleId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label" htmlFor="p-most-job">
                        Job title
                      </label>
                      <input
                        id="p-most-job"
                        type="text"
                        className="field-input"
                        value={jobTitle}
                        onChange={(e) => {
                          setJobTitle(e.target.value);
                          if (!linkJobTitle || linkJobTitle === jobTitle) {
                            setLinkJobTitle(e.target.value);
                          }
                        }}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label" htmlFor="p-most-org">
                        Link to an organisation
                      </label>
                      {!existing && !isEmployee ? (
                        <select
                          id="p-most-org"
                          className="field-select"
                          value={linkOrgId}
                          onChange={(e) => setLinkOrgId(e.target.value)}
                        >
                          <option value="">Not linked right now…</option>
                          {organisations
                            .filter((o) => !o.mergedIntoId)
                            .map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.legalName} ({o.id})
                              </option>
                            ))}
                        </select>
                      ) : (
                        <input
                          id="p-most-org"
                          type="text"
                          className="field-input"
                          disabled
                          value={
                            isEmployee
                              ? 'Not A Law Firm LLP (Employee)'
                              : 'Manage on person record'
                          }
                        />
                      )}
                    </div>

                    {!existing && !isEmployee && linkOrgId ? (
                      <>
                        <div className="field-group">
                          <label className="field-label">Department or team</label>
                          <input
                            type="text"
                            className="field-input"
                            value={linkDepartment}
                            onChange={(e) => setLinkDepartment(e.target.value)}
                          />
                        </div>
                        <div className="field-group">
                          <label className="field-label">Role within the organisation</label>
                          <input
                            type="text"
                            className="field-input"
                            value={linkRoleWithinOrg}
                            onChange={(e) => setLinkRoleWithinOrg(e.target.value)}
                          />
                        </div>
                        <div className="field-group">
                          <label className="field-label">Primary contact</label>
                          <label className="checkbox-pill" style={{ marginTop: 6 }}>
                            <input
                              type="checkbox"
                              checked={linkPrimary}
                              onChange={(e) => setLinkPrimary(e.target.checked)}
                            />
                            <span>Primary contact for this organisation</span>
                          </label>
                        </div>
                        <div className="field-group field-group--full">
                          <label className="field-label">Contact roles</label>
                          <ChoiceMultiGroup
                            listKey="contact_role"
                            values={values}
                            selectedIds={linkContactRoleIds}
                            onChange={setLinkContactRoleIds}
                          />
                        </div>
                      </>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {/* TAB 1: Personal & contact */}
              {activeTab === 'personal' ? (
                <div role="tabpanel">
                  <div className="form-grid-3">
                    <div className="field-group">
                      <label className="field-label" htmlFor="p-title">
                        Title
                      </label>
                      <ChoiceSelect
                        id="p-title"
                        listKey="title"
                        values={values}
                        value={titleId}
                        onChange={setTitleId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label" htmlFor="p-job">
                        Job title
                      </label>
                      <input
                        id="p-job"
                        type="text"
                        className="field-input"
                        value={jobTitle}
                        onChange={(e) => {
                          setJobTitle(e.target.value);
                          if (!linkJobTitle || linkJobTitle === jobTitle) {
                            setLinkJobTitle(e.target.value);
                          }
                        }}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label" htmlFor="p-former-names">
                        Former or alternative names
                      </label>
                      <input
                        id="p-former-names"
                        type="text"
                        className="field-input"
                        placeholder="e.g. maiden name — included in conflict check"
                        value={otherNames[0]?.name ?? ''}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (otherNames.length === 0) {
                            setOtherNames([{ id: 'on-1', name: val, typeId: null }]);
                          } else {
                            const next = [...otherNames];
                            next[0] = { ...next[0], name: val };
                            setOtherNames(next);
                          }
                        }}
                      />
                    </div>

                    <div className="field-group">
                      <label className="field-label" htmlFor="p-website">
                        Website
                      </label>
                      <input
                        id="p-website"
                        type="text"
                        className="field-input"
                        placeholder="https://"
                        value={website}
                        onChange={(e) => setWebsite(e.target.value)}
                      />
                    </div>
                  </div>

                  {/* Additional emails (beyond primary) */}
                  {emails.slice(1).map((em, sliceIdx) => {
                    const idx = sliceIdx + 1;
                    return (
                      <div key={em.id} className="repeatable-row" style={{ marginTop: 12 }}>
                        <input
                          type="email"
                          className="field-input"
                          placeholder="Additional email address"
                          aria-label={`Email address ${idx + 1}`}
                          value={em.address}
                          onChange={(e) => {
                            const next = [...emails];
                            next[idx] = { ...em, address: e.target.value };
                            setEmails(next);
                          }}
                        />
                        <ChoiceSelect
                          listKey="email_type"
                          values={values}
                          value={em.typeId}
                          onChange={(typeId) => {
                            const next = [...emails];
                            next[idx] = { ...em, typeId };
                            setEmails(next);
                          }}
                        />
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() => setEmails(emails.filter((_, i) => i !== idx))}
                        >
                          Remove
                        </button>
                      </div>
                    );
                  })}

                  {/* Additional phones (beyond primary) */}
                  {phones.slice(1).map((ph, sliceIdx) => {
                    const idx = sliceIdx + 1;
                    return (
                      <div key={ph.id} className="repeatable-row" style={{ marginTop: 12 }}>
                        <input
                          type="tel"
                          className="field-input"
                          placeholder="Additional phone number"
                          aria-label={`Phone number ${idx + 1}`}
                          value={ph.number}
                          onChange={(e) => {
                            const next = [...phones];
                            next[idx] = { ...ph, number: e.target.value };
                            setPhones(next);
                          }}
                        />
                        <ChoiceSelect
                          listKey="phone_type"
                          values={values}
                          value={ph.typeId}
                          onChange={(typeId) => {
                            const next = [...phones];
                            next[idx] = { ...ph, typeId };
                            setPhones(next);
                          }}
                        />
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() => setPhones(phones.filter((_, i) => i !== idx))}
                        >
                          Remove
                        </button>
                      </div>
                    );
                  })}

                  {/* Additional addresses (beyond primary) */}
                  {addresses.slice(1).map((addr, sliceIdx) => {
                    const idx = sliceIdx + 1;
                    return (
                      <div key={addr.id} className="subcard" style={{ marginTop: 12 }}>
                        <div className="list-section__header">
                          <span className="section-label">Address {idx + 1}</span>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => setAddresses(addresses.filter((_, i) => i !== idx))}
                          >
                            Remove
                          </button>
                        </div>
                        <SingleAddressEditor
                          bare
                          showTypeSelect
                          label={`Address ${idx + 1}`}
                          address={addr}
                          values={values}
                          onChange={(nextAddr) => {
                            const next = [...addresses];
                            next[idx] = nextAddr
                              ? { ...nextAddr, id: addr.id }
                              : emptyAddress(defaultCountryId);
                            setAddresses(next);
                          }}
                        />
                      </div>
                    );
                  })}

                  <div className="form-dashed-add-row">
                    <button
                      type="button"
                      className="form-dashed-add-btn"
                      onClick={() =>
                        setEmails([
                          ...emails,
                          {
                            id: `em-${Date.now()}`,
                            address: '',
                            typeId: defaultWorkEmailType,
                            isPrimary: false,
                          },
                        ])
                      }
                    >
                      + Add another email
                    </button>
                    <button
                      type="button"
                      className="form-dashed-add-btn"
                      onClick={() =>
                        setPhones([
                          ...phones,
                          { id: `ph-${Date.now()}`, number: '', typeId: defaultMobileType },
                        ])
                      }
                    >
                      + Add another phone
                    </button>
                    <button
                      type="button"
                      className="form-dashed-add-btn"
                      onClick={() => setAddresses([...addresses, emptyAddress(defaultCountryId)])}
                    >
                      + Add another address
                    </button>
                  </div>
                </div>
              ) : null}

              {/* TAB 2: Organisation */}
              {activeTab === 'organisation' ? (
                <div role="tabpanel">
                  {!existing && !isEmployee ? (
                    <div className="form-grid-3">
                      <div className="field-group field-group--full">
                        <label className="field-label">Link to an existing organisation</label>
                        <select
                          className="field-select"
                          value={linkOrgId}
                          onChange={(e) => setLinkOrgId(e.target.value)}
                        >
                          <option value="">Not linked right now…</option>
                          {organisations
                            .filter((o) => !o.mergedIntoId)
                            .map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.legalName} ({o.id})
                              </option>
                            ))}
                        </select>
                      </div>
                      {linkOrgId ? (
                        <>
                          <div className="field-group">
                            <label className="field-label">Job title at organisation</label>
                            <input
                              type="text"
                              className="field-input"
                              value={linkJobTitle || jobTitle}
                              placeholder="e.g. Finance Director"
                              onChange={(e) => {
                                setLinkJobTitle(e.target.value);
                                setJobTitle(e.target.value);
                              }}
                            />
                          </div>
                          <div className="field-group">
                            <label className="field-label">Department or team</label>
                            <input
                              type="text"
                              className="field-input"
                              value={linkDepartment}
                              onChange={(e) => setLinkDepartment(e.target.value)}
                            />
                          </div>
                          <div className="field-group">
                            <label className="field-label">Role within the organisation</label>
                            <input
                              type="text"
                              className="field-input"
                              value={linkRoleWithinOrg}
                              onChange={(e) => setLinkRoleWithinOrg(e.target.value)}
                            />
                          </div>
                          <div className="field-group">
                            <label className="field-label">Primary contact</label>
                            <label className="checkbox-pill" style={{ marginTop: 6 }}>
                              <input
                                type="checkbox"
                                checked={linkPrimary}
                                onChange={(e) => setLinkPrimary(e.target.checked)}
                              />
                              <span>Primary contact for this organisation</span>
                            </label>
                          </div>
                          <div className="field-group field-group--full">
                            <label className="field-label">Contact roles</label>
                            <ChoiceMultiGroup
                              listKey="contact_role"
                              values={values}
                              selectedIds={linkContactRoleIds}
                              onChange={setLinkContactRoleIds}
                            />
                          </div>
                        </>
                      ) : null}
                    </div>
                  ) : (
                    <p className="muted" style={{ margin: 0, fontSize: '0.88rem' }}>
                      {isEmployee
                        ? 'This person is marked as an employee of Not A Law Firm LLP.'
                        : 'Organisation links can be managed from the person record page.'}
                    </p>
                  )}
                </div>
              ) : null}

              {/* TAB 3: Relationship */}
              {activeTab === 'relationship' ? (
                <div role="tabpanel">
                  <div className="form-grid-3">
                    <div className="field-group">
                      <label className="field-label">Relationship owner (employee)</label>
                      <EmployeeSelect
                        employees={employees}
                        allPeople={allPeople}
                        values={values}
                        value={relationshipOwnerId}
                        onChange={setRelationshipOwnerId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Relationship status</label>
                      <ChoiceSelect
                        listKey="relationship_status"
                        values={values}
                        value={relationshipStatusId}
                        onChange={setRelationshipStatusId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Relationship standing</label>
                      <ChoiceSelect
                        listKey="relationship_standing"
                        values={values}
                        value={relationshipStandingId}
                        onChange={setRelationshipStandingId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Engagement level</label>
                      <ChoiceSelect
                        listKey="engagement_level"
                        values={values}
                        value={engagementLevelId}
                        onChange={setEngagementLevelId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Date first known</label>
                      <input
                        type="date"
                        className="field-input"
                        value={firstKnownAt}
                        onChange={(e) => setFirstKnownAt(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Last meaningful interaction</label>
                      <input
                        type="date"
                        className="field-input"
                        value={lastInteractionAt}
                        onChange={(e) => setLastInteractionAt(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Marketing consent</label>
                      <ChoiceSelect
                        listKey="marketing_consent"
                        values={values}
                        value={marketingConsentId}
                        onChange={setMarketingConsentId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Consent or objection record</label>
                      <input
                        type="text"
                        className="field-input"
                        value={consentRecord}
                        onChange={(e) => setConsentRecord(e.target.value)}
                      />
                    </div>
                    <div className="field-group field-group--full">
                      <label className="field-label">Relationship roles</label>
                      <ChoiceMultiGroup
                        listKey="person_role"
                        values={values}
                        selectedIds={relationshipRoleIds}
                        onChange={setRelationshipRoleIds}
                      />
                    </div>
                    <div className="field-group field-group--full">
                      <label className="field-label">Interests and preferences</label>
                      <textarea
                        className="field-textarea"
                        rows={2}
                        value={interests}
                        onChange={(e) => setInterests(e.target.value)}
                      />
                    </div>
                    <div className="field-group field-group--full">
                      <label className="field-label">Relationship notes</label>
                      <textarea
                        className="field-textarea"
                        rows={3}
                        value={relationshipNotes}
                        onChange={(e) => setRelationshipNotes(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              ) : null}

              {/* TAB 4: Compliance */}
              {activeTab === 'compliance' ? (
                <div role="tabpanel">
                  {rightToWorkEvidence.hasEvidence ? (
                    <div
                      className="subcard"
                      style={{
                        marginBottom: 14,
                        padding: '10px 14px',
                        background: 'rgba(13, 122, 82, 0.06)',
                        borderColor: 'rgba(13, 122, 82, 0.28)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span className="pill pill--ok" style={{ fontSize: 12 }}>
                          Right-to-work evidence on file
                        </span>
                        <span style={{ fontSize: 13 }}>
                          {rightToWorkEvidence.summary} — available for reference; Client ID verification for AML must still be completed and signed off separately.
                        </span>
                      </div>
                    </div>
                  ) : null}
                  <div className="form-grid-3">
                    <div className="field-group">
                      <label className="field-label">Contact record status</label>
                      <ChoiceSelect
                        listKey="person_record_status"
                        values={values}
                        value={recordStatusId}
                        onChange={(v) => setRecordStatusId(v ?? defaultActiveStatus)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Record owner</label>
                      <EmployeeSelect
                        employees={employees}
                        allPeople={allPeople}
                        values={values}
                        value={recordOwnerId}
                        onChange={setRecordOwnerId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Client ID verification status</label>
                      <ChoiceSelect
                        listKey="verification_status"
                        values={values}
                        value={verificationStatusId}
                        onChange={setVerificationStatusId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Verification date</label>
                      <input
                        type="date"
                        className="field-input"
                        value={verifiedAt}
                        onChange={(e) => setVerifiedAt(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Verification method</label>
                      <ChoiceSelect
                        listKey="verification_method"
                        values={values}
                        value={verificationMethodId}
                        onChange={setVerificationMethodId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Verification reviewer</label>
                      <EmployeeSelect
                        employees={employees}
                        allPeople={allPeople}
                        values={values}
                        value={verificationReviewerId}
                        onChange={setVerificationReviewerId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Data source</label>
                      <ChoiceSelect
                        listKey="data_source"
                        values={values}
                        value={sourceId}
                        onChange={setSourceId}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Last verified date</label>
                      <input
                        type="date"
                        className="field-input"
                        value={lastVerifiedAt}
                        onChange={(e) => setLastVerifiedAt(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Tags (comma-separated)</label>
                      <input
                        type="text"
                        className="field-input"
                        placeholder="wills, private-client, VIP"
                        value={tagsText}
                        onChange={(e) => setTagsText(e.target.value)}
                      />
                    </div>
                    <div className="field-group field-group--full">
                      <label className="field-label">
                        Risk assessment / due diligence references
                      </label>
                      <input
                        type="text"
                        className="field-input"
                        value={riskReferences}
                        onChange={(e) => setRiskReferences(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              ) : null}

              {/* TAB 5: Works at the firm (Full Employee & Engagement Section) */}
              {activeTab === 'employee' && canViewCore ? (
                <div role="tabpanel">
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: 12,
                    }}
                  >
                    <label className="checkbox-pill">
                      <input
                        type="checkbox"
                        disabled={!canEditCore}
                        checked={isEmployee}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setIsEmployee(checked);
                          if (checked && !empJobTitle.trim() && jobTitle.trim()) {
                            // Do not overwrite contact jobTitle; leave empJobTitle blank for firm role entry
                          }
                        }}
                      />
                      <span>Works at the firm (Employee, LLP member, Consultant, Contractor or Secondee)</span>
                    </label>
                    {isEmployee ? (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span className="pill pill--neutral">{empEngagementType}</span>
                        <span
                          className={`pill ${
                            empStatus === 'Active'
                              ? 'pill--ok'
                              : empStatus === 'Leaver'
                                ? 'pill--warn'
                                : 'pill--neutral'
                          }`}
                        >
                          Status: {empStatus}
                        </span>
                        <span className="pill pill--neutral">Emp #{empNumber || '—'}</span>
                      </div>
                    ) : null}
                  </div>

                  {/* Conflict warning if converting an existing contact/client who is a party on an open matter */}
                  {isEmployee && openMattersWherePersonIsParty.length > 0 ? (
                    <div
                      className="subcard"
                      style={{
                        marginTop: 14,
                        borderColor: '#d97706',
                        background: 'rgba(245, 158, 11, 0.08)',
                      }}
                    >
                      <div style={{ fontWeight: 700, color: '#b45309', marginBottom: 4 }}>
                        ⚠ Open matter party conflict detected — Risk &amp; Compliance will be notified
                      </div>
                      <p style={{ margin: '0 0 8px', fontSize: 13 }}>
                        This person is currently recorded as a party on{' '}
                        <strong>{openMattersWherePersonIsParty.length}</strong> open matter(s). Saving their
                        engagement record will keep this single person record, run a conflict check, and flag
                        these matters to Risk &amp; Compliance so an information barrier can be considered:
                      </p>
                      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                        {openMattersWherePersonIsParty.map((m) => (
                          <li key={m.id}>
                            <strong>{m.matterNumber}</strong> — {m.title}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {/* Leaver reassignment banner when status is Leaver and person still owns records */}
                  {isEmployee && empStatus === 'Leaver' && leaverRecordsForPerson.length > 0 ? (
                    <div
                      className="subcard"
                      style={{
                        marginTop: 14,
                        borderColor: '#d97706',
                        background: 'rgba(245, 158, 11, 0.08)',
                      }}
                    >
                      <div style={{ fontWeight: 700, color: '#b45309', marginBottom: 4 }}>
                        ⚠ Leaver still owns {leaverRecordsForPerson.length} record(s) — Reassign ownership
                      </div>
                      <p style={{ margin: '0 0 10px', fontSize: 13 }}>
                        Marking this person as a Leaver will deactivate their firm-issued work email and
                        extension, end their active assignment history, and retain their contact record. They
                        are still referenced as owner or supervisor on the following records:
                      </p>
                      <ul style={{ margin: '0 0 10px', paddingLeft: 18, fontSize: 12.5 }}>
                        {leaverRecordsForPerson.slice(0, 6).map((item, idx) => (
                          <li key={`${item.recordId}-${item.roleField}-${idx}`}>
                            <strong>{item.recordLabel}</strong> — {item.roleLabel}
                          </li>
                        ))}
                        {leaverRecordsForPerson.length > 6 ? (
                          <li>…and {leaverRecordsForPerson.length - 6} more</li>
                        ) : null}
                      </ul>
                      { existing ? (
                        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                          <label style={{ fontSize: 13, fontWeight: 600 }}>Reassign all to:</label>
                          <select
                            className="field-select"
                            style={{ maxWidth: 280 }}
                            value={reassignTargetEmployeeId}
                            onChange={(e) => setReassignTargetEmployeeId(e.target.value)}
                          >
                            {employees
                              .filter((e) => e.id !== existing.id)
                              .map((e) => (
                                <option key={e.id} value={e.id}>
                                  {personDisplayName(e)}
                                </option>
                              ))}
                          </select>
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            onClick={() => {
                              startTransition(async () => {
                                const res = await reassignLeaverOwnedRecordsAction(
                                  existing.id,
                                  reassignTargetEmployeeId,
                                );
                                if (!res.errors) {
                                  showToast(
                                    `Reassigned ${res.reassignedCount} record(s) from ${personDisplayName(existing)}.`,
                                  );
                                  router.refresh();
                                } else {
                                  showToast(
                                    Object.values(res.errors)[0] ?? 'Failed to reassign records.',
                                  );
                                }
                              });
                            }}
                          >
                            Reassign owned records now
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {isEmployee ? (
                    <div style={{ marginTop: 16 }}>
                      {/* Employee section sub-navigation (permission & role filtered) */}
                      <div
                        className="form-tabs-bar"
                        role="tablist"
                        aria-label="Employee details subsections"
                        style={{ marginBottom: 16 }}
                      >
                        {(
                          [
                            {
                              key: 'core' as const,
                              label: 'Core employment',
                              visible: canViewCore,
                            },
                            {
                              key: 'contract' as const,
                              label: 'Contract & terms',
                              visible: canHrRestricted,
                            },
                            {
                              key: 'fee_earner' as const,
                              label: 'Fee earner details',
                              visible:
                                canViewCore && isFeeEarnerRoleType(empRoleType),
                            },
                            {
                              key: 'right_to_work' as const,
                              label: 'Right to work & vetting',
                              visible: canHrRestricted,
                            },
                            {
                              key: 'payroll' as const,
                              label: 'Payroll & benefits',
                              visible: canPayroll,
                            },
                            {
                              key: 'emergency_contacts' as const,
                              label: `Emergency contacts (${emergencyContacts.length})`,
                              visible: canHrRestricted,
                            },
                            {
                              key: 'sensitive' as const,
                              label: 'Sensitive information',
                              visible: canSensitive,
                            },
                            {
                              key: 'systems' as const,
                              label: 'Systems & access',
                              visible: canViewCore,
                            },
                          ]
                        )
                          .filter((t) => t.visible)
                          .map((sub) => (
                            <button
                              key={sub.key}
                              type="button"
                              role="tab"
                              aria-selected={empSubTab === sub.key}
                              className={`form-tab-btn ${empSubTab === sub.key ? 'form-tab-btn--active' : ''}`}
                              onClick={() => setEmpSubTab(sub.key)}
                            >
                              {sub.label}
                            </button>
                          ))}
                      </div>

                      {/* SUB-TAB 1: Core employment (visible to HR and line managers) */}
                      {empSubTab === 'core' ? (
                        <div>
                          <div className="form-grid-3">
                            <div className="field-group">
                              <label className="field-label" htmlFor="emp-engagement-type">
                                Engagement type <span style={{ color: 'var(--coral, #d94a27)' }}>*</span>
                              </label>
                              <select
                                id="emp-engagement-type"
                                className="field-select"
                                disabled={!canEditCore}
                                value={empEngagementType}
                                onChange={(e) =>
                                  setEmpEngagementType(e.target.value as EngagementType)
                                }
                              >
                                {ENGAGEMENT_TYPES.map((t) => (
                                  <option key={t} value={t}>
                                    {t}
                                  </option>
                                ))}
                              </select>
                            </div>

                            <div className="field-group">
                              <label className="field-label" htmlFor="emp-status">
                                Employment status <span style={{ color: 'var(--coral, #d94a27)' }}>*</span>
                              </label>
                              <select
                                id="emp-status"
                                className="field-select"
                                disabled={!canEditCore}
                                value={empStatus}
                                onChange={(e) => {
                                  const nextStatus = e.target.value as EmploymentStatus;
                                  setEmpStatus(nextStatus);
                                  if (nextStatus === 'Leaver' && !empLeavingDate) {
                                    setEmpLeavingDate(todayStr);
                                  }
                                }}
                              >
                                {EMPLOYMENT_STATUSES.map((s) => (
                                  <option key={s} value={s}>
                                    {s}
                                  </option>
                                ))}
                              </select>
                            </div>

                            <div className="field-group">
                              <label className="field-label" htmlFor="emp-number">
                                Employee number (unique) <span style={{ color: 'var(--coral, #d94a27)' }}>*</span>
                              </label>
                              <input
                                id="emp-number"
                                type="text"
                                className="field-input"
                                disabled={!canEditCore}
                                value={empNumber}
                                onChange={(e) => setEmpNumber(e.target.value)}
                              />
                            </div>

                            <div className="field-group">
                              <label className="field-label" htmlFor="emp-entity">
                                Employing entity <span style={{ color: 'var(--coral, #d94a27)' }}>*</span>
                              </label>
                              <select
                                id="emp-entity"
                                className="field-select"
                                disabled={!canEditCore}
                                value={empEntityId}
                                onChange={(e) => setEmpEntityId(e.target.value)}
                              >
                                {orgStructure.legalEntities
                                  .filter((le) => le.active)
                                  .map((le) => (
                                    <option key={le.id} value={le.id}>
                                      {le.name} ({le.code})
                                    </option>
                                  ))}
                              </select>
                            </div>

                            <div className="field-group">
                              <label className="field-label" htmlFor="emp-job-title">
                                Job title at the firm <span style={{ color: 'var(--coral, #d94a27)' }}>*</span>
                              </label>
                              <input
                                id="emp-job-title"
                                type="text"
                                className="field-input"
                                disabled={!canEditCore}
                                placeholder="e.g. Senior Associate (distinct from external contact job title)"
                                value={empJobTitle}
                                onChange={(e) => setEmpJobTitle(e.target.value)}
                              />
                            </div>

                            <div className="field-group">
                              <label className="field-label" htmlFor="emp-grade">
                                Grade or band
                              </label>
                              <input
                                id="emp-grade"
                                type="text"
                                className="field-input"
                                disabled={!canEditCore}
                                placeholder="e.g. Band 4 / Senior Associate"
                                value={empGradeOrBand}
                                onChange={(e) => setEmpGradeOrBand(e.target.value)}
                              />
                            </div>

                            <div className="field-group">
                              <label className="field-label" htmlFor="emp-role-type">
                                Role type <span style={{ color: 'var(--coral, #d94a27)' }}>*</span>
                              </label>
                              <select
                                id="emp-role-type"
                                className="field-select"
                                disabled={!canEditCore}
                                value={empRoleType}
                                onChange={(e) => {
                                  const nextRole = e.target.value as EmployeeRoleType;
                                  setEmpRoleType(nextRole);
                                  setEmployeeRoleId(mapRoleTypeToLegacyEmployeeRoleId(nextRole));
                                  if (nextRole === 'Partner/Member' && empEngagementType === 'Employee') {
                                    setEmpEngagementType('LLP member');
                                  }
                                }}
                              >
                                {EMPLOYEE_ROLE_TYPES.map((rt) => (
                                  <option key={rt} value={rt}>
                                    {rt}
                                  </option>
                                ))}
                              </select>
                            </div>

                            <div className="field-group">
                              <label className="field-label" htmlFor="emp-division">
                                Division
                              </label>
                              <select
                                id="emp-division"
                                className="field-select"
                                disabled={!canEditCore}
                                value={empDivisionId ?? ''}
                                onChange={(e) => {
                                  const nextDiv = e.target.value || null;
                                  setEmpDivisionId(nextDiv);
                                  const firstDept = orgStructure.departments.find(
                                    (d) => d.active && (!nextDiv || d.parentDivisionId === nextDiv),
                                  );
                                  if (firstDept) {
                                    handleEmpDepartmentChange(firstDept.id);
                                  }
                                }}
                              >
                                <option value="">All divisions</option>
                                {orgStructure.divisions
                                  .filter(
                                    (div) =>
                                      div.active &&
                                      (!empEntityId || div.parentLegalEntityId === empEntityId),
                                  )
                                  .map((div) => (
                                    <option key={div.id} value={div.id}>
                                      {div.name} ({div.code})
                                    </option>
                                  ))}
                              </select>
                            </div>

                            <div className="field-group">
                              <label className="field-label" htmlFor="emp-department">
                                Department <span style={{ color: 'var(--coral, #d94a27)' }}>*</span>
                              </label>
                              <select
                                id="emp-department"
                                className="field-select"
                                disabled={!canEditCore}
                                value={empDepartmentId}
                                onChange={(e) => handleEmpDepartmentChange(e.target.value)}
                              >
                                <option value="">Select department…</option>
                                {availableDepartments.map((d) => (
                                  <option key={d.id} value={d.id}>
                                    {d.name} ({d.code})
                                  </option>
                                ))}
                              </select>
                            </div>

                            <div className="field-group">
                              <label className="field-label" htmlFor="emp-team">
                                Team or practice group
                              </label>
                              <select
                                id="emp-team"
                                className="field-select"
                                disabled={!canEditCore}
                                value={empTeamOrPgId ?? ''}
                                onChange={(e) => setEmpTeamOrPgId(e.target.value || null)}
                              >
                                <option value="">Select team / practice group…</option>
                                {availableTeams.map((t) => (
                                  <option key={t.id} value={t.id}>
                                    {t.name} ({t.code})
                                  </option>
                                ))}
                              </select>
                            </div>

                            <div className="field-group">
                              <label className="field-label" htmlFor="emp-office">
                                Office location
                              </label>
                              <select
                                id="emp-office"
                                className="field-select"
                                disabled={!canEditCore}
                                value={empOfficeId ?? ''}
                                onChange={(e) => setEmpOfficeId(e.target.value || null)}
                              >
                                <option value="">Select office…</option>
                                {orgStructure.offices
                                  .filter((o) => o.active)
                                  .map((o) => (
                                    <option key={o.id} value={o.id}>
                                      {o.name} ({o.code})
                                    </option>
                                  ))}
                              </select>
                            </div>

                            <div className="field-group">
                              <label className="field-label" htmlFor="emp-cost-centre">
                                Cost centre (defaults from department)
                              </label>
                              <select
                                id="emp-cost-centre"
                                className="field-select"
                                disabled={!canEditCore}
                                value={empCostCentreId ?? ''}
                                onChange={(e) => setEmpCostCentreId(e.target.value || null)}
                              >
                                <option value="">Select cost centre…</option>
                                {orgStructure.costCentres
                                  .filter((cc) => cc.active)
                                  .map((cc) => (
                                    <option key={cc.id} value={cc.id}>
                                      {cc.code} — {cc.name}
                                    </option>
                                  ))}
                              </select>
                            </div>

                            <div className="field-group">
                              <label className="field-label" htmlFor="emp-profit-centre">
                                Profit centre (defaults from department)
                              </label>
                              <select
                                id="emp-profit-centre"
                                className="field-select"
                                disabled={!canEditCore}
                                value={empProfitCentreId ?? ''}
                                onChange={(e) => setEmpProfitCentreId(e.target.value || null)}
                              >
                                <option value="">Select profit centre…</option>
                                {orgStructure.profitCentres
                                  .filter((pc) => pc.active)
                                  .map((pc) => (
                                    <option key={pc.id} value={pc.id}>
                                      {pc.code} — {pc.name}
                                    </option>
                                  ))}
                              </select>
                            </div>

                            <div className="field-group">
                              <div
                                style={{
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  alignItems: 'center',
                                }}
                              >
                                <label className="field-label">
                                  Line manager{' '}
                                  {!empIsTopOfHierarchy ? (
                                    <span style={{ color: 'var(--coral, #d94a27)' }}>*</span>
                                  ) : null}
                                </label>
                                <label
                                  style={{
                                    fontSize: 11.5,
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 4,
                                    cursor: 'pointer',
                                  }}
                                >
                                  <input
                                    type="checkbox"
                                    disabled={!canEditCore}
                                    checked={empIsTopOfHierarchy}
                                    onChange={(e) => {
                                      setEmpIsTopOfHierarchy(e.target.checked);
                                      if (e.target.checked) setEmpLineManagerId(null);
                                    }}
                                  />
                                  Top of hierarchy
                                </label>
                              </div>
                              <EmployeeSelect
                                employees={employees.filter((e) => e.id !== existing?.id)}
                                allPeople={allPeople}
                                values={values}
                                value={empLineManagerId}
                                onChange={handleLineManagerChange}
                                disabled={!canEditCore || empIsTopOfHierarchy}
                                placeholder={
                                  empIsTopOfHierarchy
                                    ? 'None (top of hierarchy)'
                                    : 'Select line manager…'
                                }
                              />
                            </div>

                            <div className="field-group">
                              <label className="field-label">Supervising partner or supervisor</label>
                              <EmployeeSelect
                                employees={employees.filter((e) => e.id !== existing?.id)}
                                allPeople={allPeople}
                                values={values}
                                value={empSupervisingPartnerId}
                                onChange={setEmpSupervisingPartnerId}
                              />
                            </div>

                            <div className="field-group">
                              <label className="field-label">
                                Timesheet approver (defaults to line manager)
                              </label>
                              <EmployeeSelect
                                employees={employees.filter((e) => e.id !== existing?.id)}
                                allPeople={allPeople}
                                values={values}
                                value={empTimesheetApproverId}
                                onChange={setEmpTimesheetApproverId}
                              />
                            </div>

                            <div className="field-group">
                              <label className="field-label">
                                Holiday approver (defaults to line manager)
                              </label>
                              <EmployeeSelect
                                employees={employees.filter((e) => e.id !== existing?.id)}
                                allPeople={allPeople}
                                values={values}
                                value={empHolidayApproverId}
                                onChange={setEmpHolidayApproverId}
                              />
                            </div>

                            <div className="field-group">
                              <label className="field-label">Onboarding buddy</label>
                              <EmployeeSelect
                                employees={employees.filter((e) => e.id !== existing?.id)}
                                allPeople={allPeople}
                                values={values}
                                value={empOnboardingBuddyId}
                                onChange={setEmpOnboardingBuddyId}
                              />
                            </div>

                            <div className="field-group">
                              <label className="field-label" htmlFor="emp-effective-from">
                                Assignment effective from
                              </label>
                              <input
                                id="emp-effective-from"
                                type="date"
                                className="field-input"
                                disabled={!canEditCore}
                                value={empEffectiveFrom}
                                onChange={(e) => setEmpEffectiveFrom(e.target.value)}
                              />
                            </div>
                          </div>

                          {/* Effective-dated assignment history */}
                          {existingEmp?.assignmentHistory &&
                          existingEmp.assignmentHistory.length > 0 ? (
                            <div style={{ marginTop: 14 }}>
                              <button
                                type="button"
                                className="btn btn--ghost btn--sm"
                                onClick={() => setShowAssignmentHistory((v) => !v)}
                              >
                                {showAssignmentHistory ? 'Hide' : 'View'} effective-dated assignment
                                history ({existingEmp.assignmentHistory.length})
                              </button>
                              {showAssignmentHistory ? (
                                <div className="subcard" style={{ marginTop: 8, overflowX: 'auto' }}>
                                  <table className="data-table" style={{ fontSize: 12.5 }}>
                                    <thead>
                                      <tr>
                                        <th>Effective From</th>
                                        <th>Effective To</th>
                                        <th>Job Title</th>
                                        <th>Grade</th>
                                        <th>Department</th>
                                        <th>Office</th>
                                        <th>FTE</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {existingEmp.assignmentHistory.map((h) => {
                                        const deptObj = orgStructure.departments.find(
                                          (d) => d.id === h.departmentId,
                                        );
                                        const offObj = orgStructure.offices.find(
                                          (o) => o.id === h.officeId,
                                        );
                                        return (
                                          <tr key={h.id}>
                                            <td>{h.effectiveFrom}</td>
                                            <td>{h.effectiveTo ?? 'Current'}</td>
                                            <td>{h.jobTitle}</td>
                                            <td>{h.gradeOrBand || '—'}</td>
                                            <td>{deptObj?.name ?? h.departmentId}</td>
                                            <td>{offObj?.name ?? h.officeId ?? '—'}</td>
                                            <td>{h.fte}</td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      {/* SUB-TAB 2: Contract and terms (HR restricted) */}
                      {empSubTab === 'contract' && canHrRestricted ? (
                        <div className="form-grid-3">
                          <div className="field-group">
                            <label className="field-label" htmlFor="emp-start-date">
                              Start date <span style={{ color: 'var(--coral, #d94a27)' }}>*</span>
                            </label>
                            <input
                              id="emp-start-date"
                              type="date"
                              className="field-input"
                              value={empStartDate}
                              onChange={(e) => handleStartDateChange(e.target.value)}
                            />
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="emp-csd">
                              Continuous service date (defaults to start date)
                            </label>
                            <input
                              id="emp-csd"
                              type="date"
                              className="field-input"
                              value={empContinuousServiceDate}
                              onChange={(e) => setEmpContinuousServiceDate(e.target.value)}
                            />
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="emp-contract-type">
                              Contract type
                            </label>
                            <select
                              id="emp-contract-type"
                              className="field-select"
                              value={empContractType}
                              onChange={(e) => setEmpContractType(e.target.value as ContractType)}
                            >
                              {CONTRACT_TYPES.map((ct) => (
                                <option key={ct} value={ct}>
                                  {ct}
                                </option>
                              ))}
                            </select>
                          </div>

                          {empContractType === 'Fixed term' ? (
                            <div className="field-group">
                              <label className="field-label" htmlFor="emp-fixed-end">
                                Fixed-term end date <span style={{ color: 'var(--coral, #d94a27)' }}>*</span>
                              </label>
                              <input
                                id="emp-fixed-end"
                                type="date"
                                className="field-input"
                                value={empFixedTermEndDate}
                                onChange={(e) => setEmpFixedTermEndDate(e.target.value)}
                              />
                            </div>
                          ) : null}

                          <div className="field-group">
                            <label className="field-label" htmlFor="emp-fte">
                              FTE (0.1 – 1.0)
                            </label>
                            <input
                              id="emp-fte"
                              type="number"
                              step="0.05"
                              min="0.1"
                              max="1.0"
                              className="field-input"
                              value={empFte}
                              onChange={(e) => setEmpFte(Number(e.target.value) || 1.0)}
                            />
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="emp-working-pattern">
                              Working pattern
                            </label>
                            <input
                              id="emp-working-pattern"
                              type="text"
                              className="field-input"
                              placeholder="e.g. Full-time (37.5 hrs, Mon–Fri)"
                              value={empWorkingPattern}
                              onChange={(e) => setEmpWorkingPattern(e.target.value)}
                            />
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="emp-work-loc">
                              Work location arrangement
                            </label>
                            <select
                              id="emp-work-loc"
                              className="field-select"
                              value={empWorkLocationArrangement}
                              onChange={(e) =>
                                setEmpWorkLocationArrangement(
                                  e.target.value as WorkLocationArrangement,
                                )
                              }
                            >
                              {(['Office', 'Hybrid', 'Remote'] as WorkLocationArrangement[]).map((w) => (
                                <option key={w} value={w}>
                                  {w}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="field-group field-group--full">
                            <label className="field-label" htmlFor="emp-pattern-notes">
                              Working pattern notes
                            </label>
                            <input
                              id="emp-pattern-notes"
                              type="text"
                              className="field-input"
                              placeholder="e.g. Non-working day Wednesday afternoon; school-hours flexibility"
                              value={empWorkingPatternNotes}
                              onChange={(e) => setEmpWorkingPatternNotes(e.target.value)}
                            />
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="emp-prob-months">
                              Probation period (months)
                            </label>
                            <input
                              id="emp-prob-months"
                              type="number"
                              min="0"
                              max="24"
                              className="field-input"
                              value={empProbationMonths}
                              onChange={(e) =>
                                handleProbationMonthsChange(Number(e.target.value) || 0)
                              }
                            />
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="emp-prob-end">
                              Probation end date (calculated, overridable)
                            </label>
                            <input
                              id="emp-prob-end"
                              type="date"
                              className="field-input"
                              value={empProbationEndDate}
                              onChange={(e) => {
                                setEmpProbationEndDate(e.target.value);
                                setEmpProbationEndDateOverridden(true);
                              }}
                            />
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="emp-prob-outcome">
                              Probation outcome
                            </label>
                            <select
                              id="emp-prob-outcome"
                              className="field-select"
                              value={empProbationOutcome}
                              onChange={(e) =>
                                setEmpProbationOutcome(e.target.value as ProbationOutcome)
                              }
                            >
                              <option value="Pending">Pending</option>
                              <option value="Passed">Passed</option>
                              <option value="Extended">Extended</option>
                              <option value="Failed">Failed</option>
                              <option value="Not applicable">Not applicable</option>
                            </select>
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="emp-notice">
                              Notice period
                            </label>
                            <input
                              id="emp-notice"
                              type="text"
                              className="field-input"
                              placeholder="e.g. 3 months"
                              value={empNoticePeriod}
                              onChange={(e) => setEmpNoticePeriod(e.target.value)}
                            />
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="emp-holiday">
                              Holiday entitlement (days, FTE pro-rata)
                            </label>
                            <input
                              id="emp-holiday"
                              type="number"
                              step="0.5"
                              className="field-input"
                              value={empHolidayEntitlement}
                              onChange={(e) =>
                                setEmpHolidayEntitlement(Number(e.target.value) || 0)
                              }
                            />
                          </div>

                          {/* Leaver / exit fields */}
                          <div className="field-group">
                            <label className="field-label" htmlFor="emp-leaving-date">
                              Leaving date {empStatus === 'Leaver' ? '*' : ''}
                            </label>
                            <input
                              id="emp-leaving-date"
                              type="date"
                              className="field-input"
                              value={empLeavingDate}
                              onChange={(e) => setEmpLeavingDate(e.target.value)}
                            />
                          </div>

                          <div className="field-group">
                            <label className="field-label">Leaving reason</label>
                            <ChoiceSelect
                              listKey="leaving_reason"
                              values={values}
                              value={empLeavingReasonId}
                              onChange={setEmpLeavingReasonId}
                            />
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="emp-rehire">
                              Eligible for re-hire
                            </label>
                            <select
                              id="emp-rehire"
                              className="field-select"
                              value={empEligibleForRehire ?? ''}
                              onChange={(e) =>
                                setEmpEligibleForRehire(
                                  (e.target.value || null) as 'Yes' | 'No' | 'Conditional' | null,
                                )
                              }
                            >
                              <option value="">Not specified</option>
                              <option value="Yes">Yes</option>
                              <option value="No">No</option>
                              <option value="Conditional">Conditional</option>
                            </select>
                          </div>

                          <div className="field-group field-group--full">
                            <label className="checkbox-pill">
                              <input
                                type="checkbox"
                                checked={empKeepAsContactOnLeave}
                                onChange={(e) => setEmpKeepAsContactOnLeave(e.target.checked)}
                              />
                              <span>
                                Keep as an alumni/external contact when leaving (retains personal
                                contact details &amp; marketing consent; deactivates firm-issued work
                                email &amp; extension)
                              </span>
                            </label>
                            {empLeavingDate ? (
                              <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>
                                Statutory HR record retention until:{' '}
                                <strong>{calculateHrRetentionDate(empLeavingDate)}</strong> (6 years
                                from leaving date).
                              </p>
                            ) : null}
                          </div>
                        </div>
                      ) : null}

                      {/* SUB-TAB 3: Fee earner details (shown only when roleType is Fee earner, Trainee, or Partner/Member) */}
                      {empSubTab === 'fee_earner' && isFeeEarnerRoleType(empRoleType) ? (
                        <div>
                          <div className="form-grid-3">
                            <div className="field-group">
                              <label className="field-label" htmlFor="fe-code">
                                Timekeeper / fee earner code (unique){' '}
                                <span style={{ color: 'var(--coral, #d94a27)' }}>*</span>
                              </label>
                              <input
                                id="fe-code"
                                type="text"
                                className="field-input"
                                disabled={!canEditCore}
                                placeholder="e.g. FE-EVANS"
                                value={feTimekeeperCode}
                                onChange={(e) => setFeTimekeeperCode(e.target.value)}
                              />
                            </div>

                            <div className="field-group">
                              <label className="field-label" htmlFor="fe-rate">
                                Charge-out rate (£/hr, effective-dated)
                              </label>
                              <input
                                id="fe-rate"
                                type="number"
                                step="5"
                                className="field-input"
                                disabled={!canEditCore}
                                placeholder="e.g. 320"
                                value={feChargeOutRate}
                                onChange={(e) => setFeChargeOutRate(e.target.value)}
                              />
                            </div>

                            <div className="field-group">
                              <label className="field-label" htmlFor="fe-rate-eff">
                                Rate effective from
                              </label>
                              <input
                                id="fe-rate-eff"
                                type="date"
                                className="field-input"
                                disabled={!canEditCore}
                                value={feRateEffectiveFrom}
                                onChange={(e) => setFeRateEffectiveFrom(e.target.value)}
                              />
                            </div>

                            <div className="field-group">
                              <label className="field-label" htmlFor="fe-hours-target">
                                Chargeable hours target (annual)
                              </label>
                              <input
                                id="fe-hours-target"
                                type="number"
                                step="25"
                                className="field-input"
                                disabled={!canEditCore}
                                value={feChargeableHoursTarget}
                                onChange={(e) => setFeChargeableHoursTarget(e.target.value)}
                              />
                            </div>

                            <div className="field-group">
                              <label className="field-label" htmlFor="fe-billing-limit">
                                Billing or write-off approval limit (£)
                              </label>
                              <input
                                id="fe-billing-limit"
                                type="number"
                                step="500"
                                className="field-input"
                                disabled={!canEditCore}
                                value={feBillingApprovalLimit}
                                onChange={(e) => setFeBillingApprovalLimit(e.target.value)}
                              />
                            </div>

                            <div className="field-group">
                              <label className="field-label" htmlFor="fe-sra">
                                SRA number
                              </label>
                              <input
                                id="fe-sra"
                                type="text"
                                className="field-input"
                                disabled={!canEditCore}
                                placeholder="e.g. SRA-612044"
                                value={feSraNumber}
                                onChange={(e) => setFeSraNumber(e.target.value)}
                              />
                            </div>

                            <div className="field-group">
                              <label className="field-label" htmlFor="fe-pc-status">
                                Practising certificate status
                              </label>
                              <select
                                id="fe-pc-status"
                                className="field-select"
                                disabled={!canEditCore}
                                value={fePractisingCertStatus}
                                onChange={(e) =>
                                  setFePractisingCertStatus(
                                    e.target.value as typeof fePractisingCertStatus,
                                  )
                                }
                              >
                                <option value="">Select…</option>
                                <option value="Current">Current</option>
                                <option value="Pending renewal">Pending renewal</option>
                                <option value="Conditions attached">Conditions attached</option>
                                <option value="Suspended">Suspended</option>
                                <option value="Not applicable">Not applicable</option>
                              </select>
                            </div>

                            <div className="field-group">
                              <label className="field-label" htmlFor="fe-pc-renewal">
                                Practising certificate renewal date
                              </label>
                              <input
                                id="fe-pc-renewal"
                                type="date"
                                className="field-input"
                                disabled={!canEditCore}
                                value={fePractisingCertRenewalDate}
                                onChange={(e) => setFePractisingCertRenewalDate(e.target.value)}
                              />
                            </div>

                            <div className="field-group">
                              <label className="field-label" htmlFor="fe-admission">
                                Admission date
                              </label>
                              <input
                                id="fe-admission"
                                type="date"
                                className="field-input"
                                disabled={!canEditCore}
                                value={feAdmissionDate}
                                onChange={(e) => setFeAdmissionDate(e.target.value)}
                              />
                            </div>
                          </div>

                          {existingEmp?.feeEarner?.chargeOutRateHistory &&
                          existingEmp.feeEarner.chargeOutRateHistory.length > 0 ? (
                            <div style={{ marginTop: 14 }}>
                              <button
                                type="button"
                                className="btn btn--ghost btn--sm"
                                onClick={() => setShowRateHistory((v) => !v)}
                              >
                                {showRateHistory ? 'Hide' : 'View'} charge-out rate history (
                                {existingEmp.feeEarner.chargeOutRateHistory.length})
                              </button>
                              {showRateHistory ? (
                                <div className="subcard" style={{ marginTop: 8 }}>
                                  <table className="data-table" style={{ fontSize: 12.5 }}>
                                    <thead>
                                      <tr>
                                        <th>Effective From</th>
                                        <th>Effective To</th>
                                        <th>Rate (£/hr)</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {existingEmp.feeEarner.chargeOutRateHistory.map((r) => (
                                        <tr key={r.id}>
                                          <td>{r.effectiveFrom}</td>
                                          <td>{r.effectiveTo ?? 'Current'}</td>
                                          <td>£{r.rateGbpPerHour}/hr</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      {/* SUB-TAB 4: Right to work and vetting (HR only) */}
                      {empSubTab === 'right_to_work' && canHrRestricted ? (
                        <div className="form-grid-3">
                          <div className="field-group">
                            <label className="field-label" htmlFor="rtw-date">
                              Right to work check date
                            </label>
                            <input
                              id="rtw-date"
                              type="date"
                              className="field-input"
                              value={rtwCheckDate}
                              onChange={(e) => setRtwCheckDate(e.target.value)}
                            />
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="rtw-method">
                              Right to work check method
                            </label>
                            <select
                              id="rtw-method"
                              className="field-select"
                              value={rtwMethod}
                              onChange={(e) =>
                                setRtwMethod(e.target.value as RightToWorkMethod | '')
                              }
                            >
                              <option value="">Select method…</option>
                              {(
                                [
                                  'Manual document check',
                                  'Online Home Office share code',
                                  'IDSP',
                                ] as RightToWorkMethod[]
                              ).map((m) => (
                                <option key={m} value={m}>
                                  {m}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="rtw-doc">
                              Document type
                            </label>
                            <input
                              id="rtw-doc"
                              type="text"
                              className="field-input"
                              placeholder="e.g. UK Passport / Home Office Share Code"
                              value={rtwDocumentType}
                              onChange={(e) => setRtwDocumentType(e.target.value)}
                            />
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="rtw-expiry">
                              Permission expiry date (if time-limited)
                            </label>
                            <input
                              id="rtw-expiry"
                              type="date"
                              className="field-input"
                              value={rtwExpiryDate}
                              onChange={(e) => setRtwExpiryDate(e.target.value)}
                            />
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="rtw-followup">
                              Follow-up check due date
                            </label>
                            <input
                              id="rtw-followup"
                              type="date"
                              className="field-input"
                              value={rtwFollowUpDate}
                              onChange={(e) => setRtwFollowUpDate(e.target.value)}
                            />
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="dbs-type">
                              DBS or vetting check type
                            </label>
                            <input
                              id="dbs-type"
                              type="text"
                              className="field-input"
                              placeholder="e.g. Standard DBS / Basic DBS / SRA screening"
                              value={dbsCheckType}
                              onChange={(e) => setDbsCheckType(e.target.value)}
                            />
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="dbs-date">
                              DBS check date
                            </label>
                            <input
                              id="dbs-date"
                              type="date"
                              className="field-input"
                              value={dbsCheckDate}
                              onChange={(e) => setDbsCheckDate(e.target.value)}
                            />
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="dbs-outcome">
                              DBS outcome
                            </label>
                            <input
                              id="dbs-outcome"
                              type="text"
                              className="field-input"
                              placeholder="e.g. Clear"
                              value={dbsOutcome}
                              onChange={(e) => setDbsOutcome(e.target.value)}
                            />
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="dbs-ref">
                              DBS certificate / check reference
                            </label>
                            <input
                              id="dbs-ref"
                              type="text"
                              className="field-input"
                              placeholder="e.g. DBS-001894512"
                              value={dbsReference}
                              onChange={(e) => setDbsReference(e.target.value)}
                            />
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="rtw-refs">
                              References received
                            </label>
                            <select
                              id="rtw-refs"
                              className="field-select"
                              value={referencesReceived}
                              onChange={(e) =>
                                setReferencesReceived(e.target.value as 'yes' | 'no' | '')
                              }
                            >
                              <option value="">Select…</option>
                              <option value="yes">Yes</option>
                              <option value="no">No</option>
                            </select>
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="rtw-refs-date">
                              References received date
                            </label>
                            <input
                              id="rtw-refs-date"
                              type="date"
                              className="field-input"
                              value={referencesReceivedDate}
                              onChange={(e) => setReferencesReceivedDate(e.target.value)}
                            />
                          </div>
                        </div>
                      ) : null}

                      {/* SUB-TAB 5: Payroll and benefits (restricted to HR/payroll permission) */}
                      {empSubTab === 'payroll' && canPayroll ? (
                        <div>
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              flexWrap: 'wrap',
                              gap: 12,
                              marginBottom: 14,
                            }}
                          >
                            <label className="checkbox-pill">
                              <input
                                type="checkbox"
                                checked={externalPayrollOnlyMode}
                                onChange={(e) => setExternalPayrollOnlyMode(e.target.checked)}
                              />
                              <span>
                                External payroll mode (store only external payroll reference; hide NI
                                &amp; bank details)
                              </span>
                            </label>

                            {!externalPayrollOnlyMode ? (
                              <button
                                type="button"
                                className="btn btn--secondary btn--sm"
                                onClick={handleTogglePayrollMask}
                              >
                                {payrollMasked
                                  ? 'Reveal NI & bank details (logged to audit)'
                                  : 'Mask NI & bank details'}
                              </button>
                            ) : null}
                          </div>

                          <div className="form-grid-3">
                            <div className="field-group">
                              <label className="field-label" htmlFor="pay-ext-ref">
                                External payroll reference
                              </label>
                              <input
                                id="pay-ext-ref"
                                type="text"
                                className="field-input"
                                value={payExternalRef}
                                onChange={(e) => setPayExternalRef(e.target.value)}
                              />
                            </div>

                            {!externalPayrollOnlyMode ? (
                              <>
                                <div className="field-group">
                                  <label className="field-label" htmlFor="pay-ni">
                                    National Insurance number (UK format)
                                  </label>
                                  {payrollMasked ? (
                                    <input
                                      id="pay-ni"
                                      type="text"
                                      className="field-input"
                                      readOnly
                                      value={maskNationalInsuranceNumber(payNiNumber)}
                                    />
                                  ) : (
                                    <input
                                      id="pay-ni"
                                      type="text"
                                      className="field-input"
                                      placeholder="e.g. QQ123456C"
                                      value={payNiNumber}
                                      onChange={(e) =>
                                        setPayNiNumber(e.target.value.toUpperCase())
                                      }
                                    />
                                  )}
                                </div>

                                <div className="field-group">
                                  <label className="field-label" htmlFor="pay-bank-name">
                                    Bank account holder name
                                  </label>
                                  <input
                                    id="pay-bank-name"
                                    type="text"
                                    className="field-input"
                                    disabled={payrollMasked}
                                    value={payBankAccountName}
                                    onChange={(e) => setPayBankAccountName(e.target.value)}
                                  />
                                </div>

                                <div className="field-group">
                                  <label className="field-label" htmlFor="pay-sort-code">
                                    Bank sort code
                                  </label>
                                  {payrollMasked ? (
                                    <input
                                      id="pay-sort-code"
                                      type="text"
                                      className="field-input"
                                      readOnly
                                      value={
                                        maskBankDetails(payBankSortCode, payBankAccountNumber)
                                          .sortCode
                                      }
                                    />
                                  ) : (
                                    <input
                                      id="pay-sort-code"
                                      type="text"
                                      className="field-input"
                                      placeholder="20-00-00"
                                      value={payBankSortCode}
                                      onChange={(e) => setPayBankSortCode(e.target.value)}
                                    />
                                  )}
                                </div>

                                <div className="field-group">
                                  <label className="field-label" htmlFor="pay-acc-num">
                                    Bank account number
                                  </label>
                                  {payrollMasked ? (
                                    <input
                                      id="pay-acc-num"
                                      type="text"
                                      className="field-input"
                                      readOnly
                                      value={
                                        maskBankDetails(payBankSortCode, payBankAccountNumber)
                                          .accountNumber
                                      }
                                    />
                                  ) : (
                                    <input
                                      id="pay-acc-num"
                                      type="text"
                                      className="field-input"
                                      placeholder="8-digit account number"
                                      value={payBankAccountNumber}
                                      onChange={(e) => setPayBankAccountNumber(e.target.value)}
                                    />
                                  )}
                                </div>

                                <div className="field-group">
                                  <label className="field-label" htmlFor="pay-bs-roll">
                                    Building society roll number (optional)
                                  </label>
                                  <input
                                    id="pay-bs-roll"
                                    type="text"
                                    className="field-input"
                                    disabled={payrollMasked}
                                    value={payBuildingSocietyRoll}
                                    onChange={(e) => setPayBuildingSocietyRoll(e.target.value)}
                                  />
                                </div>

                                <div className="field-group">
                                  <label className="field-label" htmlFor="pay-starter">
                                    Starter declaration or P45 received
                                  </label>
                                  <select
                                    id="pay-starter"
                                    className="field-select"
                                    value={payStarterDecl}
                                    onChange={(e) => setPayStarterDecl(e.target.value)}
                                  >
                                    <option value="P45 received">P45 received</option>
                                    <option value="Starter Declaration A">
                                      Starter Declaration A
                                    </option>
                                    <option value="Starter Declaration B">
                                      Starter Declaration B
                                    </option>
                                    <option value="Starter Declaration C">
                                      Starter Declaration C
                                    </option>
                                    <option value="Pending">Pending</option>
                                  </select>
                                </div>

                                <div className="field-group">
                                  <label className="field-label" htmlFor="pay-student-loan">
                                    Student loan plan
                                  </label>
                                  <select
                                    id="pay-student-loan"
                                    className="field-select"
                                    value={payStudentLoan}
                                    onChange={(e) => setPayStudentLoan(e.target.value)}
                                  >
                                    <option value="None">None</option>
                                    <option value="Plan 1">Plan 1</option>
                                    <option value="Plan 2">Plan 2</option>
                                    <option value="Plan 4">Plan 4</option>
                                    <option value="Plan 5">Plan 5</option>
                                    <option value="Postgraduate Loan">Postgraduate Loan</option>
                                  </select>
                                </div>

                                <div className="field-group">
                                  <label className="field-label" htmlFor="pay-pension">
                                    Pension auto-enrolment status
                                  </label>
                                  <select
                                    id="pay-pension"
                                    className="field-select"
                                    value={payPensionStatus}
                                    onChange={(e) => setPayPensionStatus(e.target.value)}
                                  >
                                    <option value="Eligible jobholder — enrolled">
                                      Eligible jobholder — enrolled
                                    </option>
                                    <option value="Non-eligible jobholder — opted in">
                                      Non-eligible jobholder — opted in
                                    </option>
                                    <option value="Opted out">Opted out</option>
                                    <option value="Postponed">Postponed</option>
                                    <option value="Not applicable (LLP member / contractor)">
                                      Not applicable (LLP member / contractor)
                                    </option>
                                  </select>
                                </div>

                                <div className="field-group">
                                  <label className="field-label" htmlFor="pay-pension-optout">
                                    Pension opt-out date
                                  </label>
                                  <input
                                    id="pay-pension-optout"
                                    type="date"
                                    className="field-input"
                                    value={payPensionOptOutDate}
                                    onChange={(e) => setPayPensionOptOutDate(e.target.value)}
                                  />
                                </div>
                              </>
                            ) : null}
                          </div>
                        </div>
                      ) : null}

                      {/* SUB-TAB 6: Emergency contacts (HR only, stored inline on EmploymentRecord) */}
                      {empSubTab === 'emergency_contacts' && canHrRestricted ? (
                        <div>
                          <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>
                            Stored inline on the employment record (never as separate CRM person
                            records, so they do not appear in client lists, marketing or conflict
                            searches).
                          </p>
                          {emergencyContacts.map((ec, idx) => (
                            <div
                              key={ec.id}
                              className="subcard"
                              style={{ marginBottom: 10 }}
                            >
                              <div className="form-grid-3">
                                <div className="field-group">
                                  <label className="field-label">Contact name *</label>
                                  <input
                                    type="text"
                                    className="field-input"
                                    placeholder="Full name"
                                    value={ec.name}
                                    onChange={(e) => {
                                      const next = [...emergencyContacts];
                                      next[idx] = { ...ec, name: e.target.value };
                                      setEmergencyContacts(next);
                                    }}
                                  />
                                </div>
                                <div className="field-group">
                                  <label className="field-label">Relationship *</label>
                                  <input
                                    type="text"
                                    className="field-input"
                                    placeholder="e.g. Spouse, Partner, Parent"
                                    value={ec.relationship}
                                    onChange={(e) => {
                                      const next = [...emergencyContacts];
                                      next[idx] = { ...ec, relationship: e.target.value };
                                      setEmergencyContacts(next);
                                    }}
                                  />
                                </div>
                                <div className="field-group">
                                  <label className="field-label">Primary phone *</label>
                                  <input
                                    type="tel"
                                    className="field-input"
                                    placeholder="07700 900000"
                                    value={ec.phone}
                                    onChange={(e) => {
                                      const next = [...emergencyContacts];
                                      next[idx] = { ...ec, phone: e.target.value };
                                      setEmergencyContacts(next);
                                    }}
                                  />
                                </div>
                                <div className="field-group">
                                  <label className="field-label">Alternative phone</label>
                                  <input
                                    type="tel"
                                    className="field-input"
                                    placeholder="Optional secondary number"
                                    value={ec.alternativePhone}
                                    onChange={(e) => {
                                      const next = [...emergencyContacts];
                                      next[idx] = { ...ec, alternativePhone: e.target.value };
                                      setEmergencyContacts(next);
                                    }}
                                  />
                                </div>
                                <div
                                  className="field-group"
                                  style={{ display: 'flex', alignItems: 'flex-end' }}
                                >
                                  <button
                                    type="button"
                                    className="btn btn--ghost btn--sm"
                                    onClick={() =>
                                      setEmergencyContacts(
                                        emergencyContacts.filter((_, i) => i !== idx),
                                      )
                                    }
                                  >
                                    Remove emergency contact
                                  </button>
                                </div>
                              </div>
                            </div>
                          ))}
                          <button
                            type="button"
                            className="form-dashed-add-btn"
                            onClick={() =>
                              setEmergencyContacts([
                                ...emergencyContacts,
                                {
                                  id: `ec-${Date.now()}`,
                                  name: '',
                                  relationship: '',
                                  phone: '',
                                  alternativePhone: '',
                                },
                              ])
                            }
                          >
                            + Add emergency contact
                          </button>
                        </div>
                      ) : null}

                      {/* SUB-TAB 7: Sensitive information (HR special category data, separate store & audit) */}
                      {empSubTab === 'sensitive' && canSensitive ? (
                        <div>
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              marginBottom: 12,
                              flexWrap: 'wrap',
                              gap: 8,
                            }}
                          >
                            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                              Special category data — stored separately from the main employment
                              record with its own permission and audit trail. All diversity questions
                              are optional and default to &ldquo;Prefer not to say&rdquo;.
                            </p>
                            {!sensitiveRevealed ? (
                              <button
                                type="button"
                                className="btn btn--secondary btn--sm"
                                onClick={handleRevealSensitive}
                              >
                                View / edit sensitive information (logged to audit)
                              </button>
                            ) : null}
                          </div>

                          {sensitiveRevealed ? (
                            <div className="form-grid-3">
                              <div className="field-group field-group--full">
                                <label className="field-label" htmlFor="sens-adjustments">
                                  Reasonable adjustments needed
                                </label>
                                <textarea
                                  id="sens-adjustments"
                                  className="field-textarea"
                                  rows={2}
                                  placeholder="Record any workplace adjustments agreed with the colleague"
                                  value={reasonableAdjustments}
                                  onChange={(e) => {
                                    setReasonableAdjustments(e.target.value);
                                    setSensitiveEdited(true);
                                  }}
                                />
                              </div>

                              {(
                                [
                                  {
                                    key: 'ageBand' as const,
                                    label: 'Age band',
                                    options: [
                                      'Prefer not to say',
                                      'Under 25',
                                      '25–34',
                                      '35–44',
                                      '45–54',
                                      '55–64',
                                      '65+',
                                    ],
                                  },
                                  {
                                    key: 'genderIdentity' as const,
                                    label: 'Gender',
                                    options: [
                                      'Prefer not to say',
                                      'Female',
                                      'Male',
                                      'Non-binary',
                                      'Other',
                                    ],
                                  },
                                  {
                                    key: 'ethnicity' as const,
                                    label: 'Ethnicity',
                                    options: [
                                      'Prefer not to say',
                                      'Asian or Asian British',
                                      'Black, African, Caribbean or Black British',
                                      'Mixed or Multiple ethnic groups',
                                      'White',
                                      'Other ethnic group',
                                    ],
                                  },
                                  {
                                    key: 'disability' as const,
                                    label: 'Disability (Equality Act 2010)',
                                    options: ['Prefer not to say', 'No', 'Yes'],
                                  },
                                  {
                                    key: 'sexualOrientation' as const,
                                    label: 'Sexual orientation',
                                    options: [
                                      'Prefer not to say',
                                      'Heterosexual / Straight',
                                      'Gay or Lesbian',
                                      'Bisexual',
                                      'Other',
                                    ],
                                  },
                                  {
                                    key: 'religionOrBelief' as const,
                                    label: 'Religion or belief',
                                    options: [
                                      'Prefer not to say',
                                      'No religion or belief',
                                      'Buddhist',
                                      'Christian',
                                      'Hindu',
                                      'Jewish',
                                      'Muslim',
                                      'Sikh',
                                      'Other',
                                    ],
                                  },
                                  {
                                    key: 'socioEconomicBackground' as const,
                                    label: 'School type attended (SRA socio-economic)',
                                    options: [
                                      'Prefer not to say',
                                      'UK state-run or state-funded school',
                                      'UK independent or fee-paying school',
                                      'Attended school outside the UK',
                                    ],
                                  },
                                  {
                                    key: 'caringResponsibilities' as const,
                                    label: 'Primary carer / caring responsibilities',
                                    options: ['Prefer not to say', 'No', 'Yes'],
                                  },
                                ]
                              ).map((q) => (
                                <div key={q.key} className="field-group">
                                  <label className="field-label">{q.label}</label>
                                  <select
                                    className="field-select"
                                    value={diversityAnswers[q.key] ?? 'Prefer not to say'}
                                    onChange={(e) => {
                                      setDiversityAnswers({
                                        ...diversityAnswers,
                                        [q.key]: e.target.value,
                                      });
                                      setSensitiveEdited(true);
                                    }}
                                  >
                                    {q.options.map((opt) => (
                                      <option key={opt} value={opt}>
                                        {opt}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      {/* SUB-TAB 8: Systems and access */}
                      {empSubTab === 'systems' ? (
                        <div className="form-grid-3">
                          <div className="field-group">
                            <label className="field-label" htmlFor="sys-login">
                              Network login
                            </label>
                            <input
                              id="sys-login"
                              type="text"
                              className="field-input"
                              disabled={!canEditCore}
                              placeholder="e.g. PEMBROKE\\c.evans"
                              value={sysNetworkLogin}
                              onChange={(e) => setSysNetworkLogin(e.target.value)}
                            />
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="sys-pass">
                              Building pass number
                            </label>
                            <input
                              id="sys-pass"
                              type="text"
                              className="field-input"
                              disabled={!canEditCore}
                              placeholder="e.g. BP-00101"
                              value={sysBuildingPass}
                              onChange={(e) => setSysBuildingPass(e.target.value)}
                            />
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="sys-ext">
                              Firm extension (stored as a firm-issued Work phone)
                            </label>
                            <input
                              id="sys-ext"
                              type="text"
                              className="field-input"
                              disabled={!canEditCore}
                              placeholder="e.g. ext. 2101"
                              value={sysExtension}
                              onChange={(e) => setSysExtension(e.target.value)}
                            />
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="sys-work-email">
                              Firm-issued Work email (deactivated on leaving)
                            </label>
                            <input
                              id="sys-work-email"
                              type="email"
                              className="field-input"
                              disabled={!canEditCore}
                              placeholder="name@notalawfirm.example"
                              value={sysFirmWorkEmail}
                              onChange={(e) => setSysFirmWorkEmail(e.target.value)}
                            />
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="sys-dp-train">
                              Mandatory training: Data Protection completed
                            </label>
                            <input
                              id="sys-dp-train"
                              type="date"
                              className="field-input"
                              disabled={!canEditCore}
                              value={sysDpTrainingDate}
                              onChange={(e) => setSysDpTrainingDate(e.target.value)}
                            />
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="sys-aml-train">
                              Mandatory training: Anti-Money Laundering completed
                            </label>
                            <input
                              id="sys-aml-train"
                              type="date"
                              className="field-input"
                              disabled={!canEditCore}
                              value={sysAmlTrainingDate}
                              onChange={(e) => setSysAmlTrainingDate(e.target.value)}
                            />
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="sys-infosec-train">
                              Mandatory training: Information Security completed
                            </label>
                            <input
                              id="sys-infosec-train"
                              type="date"
                              className="field-input"
                              disabled={!canEditCore}
                              value={sysInfoSecTrainingDate}
                              onChange={(e) => setSysInfoSecTrainingDate(e.target.value)}
                            />
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* TAB 6: Custom fields */}
              {activeTab === 'custom' ? (
                <div role="tabpanel">
                  {personCustomDefs.length > 0 ? (
                    <div className="form-grid-3">
                      {personCustomDefs.map((def) => {
                        const raw = cfValues[def.id];
                        return (
                          <div
                            key={def.id}
                            className={`field-group ${def.fieldType === 'longText' ? 'field-group--full' : ''}`}
                          >
                            <label className="field-label" htmlFor={`cf-${def.id}`}>
                              {def.label}
                              {def.required ? ' *' : ''}
                            </label>
                            {def.fieldType === 'text' && (
                              <input
                                id={`cf-${def.id}`}
                                type="text"
                                className="field-input"
                                value={typeof raw === 'string' ? raw : ''}
                                onChange={(e) => setCfVal(def.id, e.target.value)}
                              />
                            )}
                            {def.fieldType === 'longText' && (
                              <textarea
                                id={`cf-${def.id}`}
                                className="field-textarea"
                                rows={3}
                                value={typeof raw === 'string' ? raw : ''}
                                onChange={(e) => setCfVal(def.id, e.target.value)}
                              />
                            )}
                            {def.fieldType === 'number' && (
                              <input
                                id={`cf-${def.id}`}
                                type="number"
                                className="field-input"
                                value={raw === null || raw === undefined ? '' : String(raw)}
                                onChange={(e) =>
                                  setCfVal(
                                    def.id,
                                    e.target.value === '' ? null : Number(e.target.value),
                                  )
                                }
                              />
                            )}
                            {def.fieldType === 'date' && (
                              <input
                                id={`cf-${def.id}`}
                                type="date"
                                className="field-input"
                                value={typeof raw === 'string' ? raw : ''}
                                onChange={(e) => setCfVal(def.id, e.target.value || null)}
                              />
                            )}
                            {def.fieldType === 'yesNo' && (
                              <select
                                id={`cf-${def.id}`}
                                className="field-select"
                                value={
                                  raw === true || raw === 'true'
                                    ? 'true'
                                    : raw === false || raw === 'false'
                                      ? 'false'
                                      : ''
                                }
                                onChange={(e) =>
                                  setCfVal(
                                    def.id,
                                    e.target.value === '' ? null : e.target.value === 'true',
                                  )
                                }
                              >
                                <option value="">Select…</option>
                                <option value="true">Yes</option>
                                <option value="false">No</option>
                              </select>
                            )}
                            {def.fieldType === 'choice' && def.optionsListKey && (
                              <ChoiceSelect
                                id={`cf-${def.id}`}
                                listKey={def.optionsListKey}
                                values={values}
                                value={typeof raw === 'string' ? raw : null}
                                onChange={(v) => setCfVal(def.id, v)}
                              />
                            )}
                            {lists ? null : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="muted" style={{ margin: 0, fontSize: '0.88rem' }}>
                      No custom fields are currently configured for people records.
                    </p>
                  )}
                </div>
              ) : null}
            </section>
          </div>

          {/* ==============================================================
              RIGHT COLUMN (~35%): STICKY ACTIONS + QUICK CONFLICT CHECK
              ============================================================== */}
          <div
            className="person-form-side-col"
            style={embeddedInModal ? { top: 0, marginTop: 0 } : undefined}
          >
            <div
              className="new-enquiry-footer-actions"
              style={{ justifyContent: 'flex-end' }}
            >
              {embeddedInModal && onCancelModal ? (
                <button
                  type="button"
                  onClick={onCancelModal}
                  className="btn btn--secondary"
                  style={{ borderRadius: 999, padding: '0 20px' }}
                >
                  Cancel
                </button>
              ) : (
                <Link
                  href={existing ? `/people/${existing.id}` : '/people'}
                  className="btn btn--secondary"
                  style={{ borderRadius: 999, padding: '0 20px' }}
                >
                  Cancel
                </Link>
              )}
              <button
                type="button"
                className="btn btn--primary"
                style={{ borderRadius: 999, padding: '0 22px' }}
                disabled={pending}
                onClick={() => submitPerson(liveDuplicates.length > 0)}
              >
                {pending
                  ? 'Saving…'
                  : modalSubmitLabel
                    ? modalSubmitLabel
                    : existing
                      ? 'Save changes'
                      : embeddedInModal
                        ? 'Create person & add as client'
                        : 'Create person'}
              </button>
            </div>

            <section
              className="new-enquiry-card new-enquiry-card--grow"
              aria-labelledby="sec-conflict-heading"
            >
              <div className="new-enquiry-card__top">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <h2 id="sec-conflict-heading" className="new-enquiry-card__label">
                    QUICK CONFLICT CHECK
                  </h2>
                  <InfoPopover
                    label="About the quick conflict check"
                    title="What the quick conflict check looks for"
                    docHref="/docs/quick-conflict-check"
                    docLabel="How the quick conflict check works"
                  >
                    <p>
                      As you type, the person&rsquo;s details are compared with existing People,
                      Organisations and matters.
                    </p>
                    <ul>
                      <li>
                        <strong>Possible conflicts</strong>: the person or their organisation is a
                        known opposite party (by name, email, phone or address).
                      </li>
                      <li>
                        <strong>Already known to us</strong>: existing records with the same name,
                        email, phone, address or postcode.
                      </li>
                      <li>
                        Misspellings and names that sound alike are shown as amber &ldquo;check&rdquo;
                        results rather than red conflicts.
                      </li>
                    </ul>
                    <p>
                      It&rsquo;s indicative only. The full conflict check runs before a matter is
                      opened.
                    </p>
                  </InfoPopover>
                </div>
                {!hasSearchInputs ? (
                  <span className="new-enquiry-badge">Waiting</span>
                ) : hasHighSeverityConflict ? (
                  <span className="new-enquiry-badge new-enquiry-badge--alert">
                    Possible conflict
                  </span>
                ) : distinctMatchedCount > 0 ? (
                  <span className="new-enquiry-badge new-enquiry-badge--warn">
                    {distinctMatchedCount} {distinctMatchedCount === 1 ? 'match' : 'matches'}
                  </span>
                ) : (
                  <span className="new-enquiry-badge new-enquiry-badge--ok">No matches</span>
                )}
              </div>

              <p className="muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.45 }}>
                Runs as you type the person&rsquo;s name, organisation, email, phone or address.
              </p>

              {/* Dynamic results area */}
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  maxHeight: 360,
                  overflowY: 'auto',
                }}
              >
                {linkOrgId ? (
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 10px',
                      borderRadius: 8,
                      background: 'var(--bg-subtle)',
                    }}
                  >
                    <StatusPill
                      label={`Linked: ${organisations.find((o) => o.id === linkOrgId)?.legalName ?? linkOrgId}`}
                      tone="positive"
                    />
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => setLinkOrgId('')}
                    >
                      Unlink
                    </button>
                  </div>
                ) : null}

                {hasSearchInputs && distinctMatchedCount === 0 ? (
                  <div
                    style={{
                      padding: '8px 10px',
                      borderRadius: 8,
                      background: 'var(--bg-subtle)',
                      color: 'var(--text-secondary)',
                      fontSize: 12.5,
                      lineHeight: 1.45,
                    }}
                  >
                    No conflicts or existing records matched.
                  </div>
                ) : null}

                {possibleConflicts.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        color: 'var(--text-muted)',
                      }}
                    >
                      Possible conflicts
                    </div>
                    {possibleConflicts.map((hit) => {
                      const isHigh = hit.severity === 'high' || hit.blocking;
                      const key = `${hit.recordType}:${hit.recordId}`;
                      const isSimilarOnly = hit.matchedFields.every(
                        (f) => f.includes('similar spelling') || f.includes('sounds like'),
                      );
                      const matchedOn = Array.from(
                        new Set([
                          ...hit.matchedFields,
                          ...(entityReasonsByKey.get(key)?.split(', ') ?? []),
                        ]),
                      ).join(', ');
                      const person =
                        hit.recordType === 'person'
                          ? otherPeople.find((p) => p.id === hit.recordId)
                          : undefined;
                      const org =
                        hit.recordType === 'organisation'
                          ? organisations.find((o) => o.id === hit.recordId)
                          : undefined;
                      const isLinked = Boolean(org && linkOrgId === org.id);
                      return (
                        <div
                          key={`conflict-${hit.recordType}-${hit.recordId}`}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'flex-start',
                            gap: 8,
                            padding: '8px 10px',
                            borderRadius: 8,
                            background: isHigh ? '#fde8e4' : '#fdf0d9',
                            color: isHigh ? '#9a230b' : '#7a4204',
                            fontSize: 12.5,
                          }}
                        >
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 700 }}>
                              {isHigh
                                ? 'Possible conflict: '
                                : isSimilarOnly
                                  ? 'Similar name, check: '
                                  : hit.recordType === 'matter'
                                    ? 'Matter / party match: '
                                    : 'Check: '}
                              <Link
                                href={hit.href}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ color: 'inherit', textDecoration: 'underline' }}
                              >
                                {hit.recordLabel}
                              </Link>
                            </div>
                            <div>{hit.reason}</div>
                            {matchedOn ? (
                              <div style={{ fontSize: 11.5, opacity: 0.85, marginTop: 2 }}>
                                Matched on: {matchedOn}
                              </div>
                            ) : null}
                          </div>
                          {person ? (
                            onSelectExistingPerson ? (
                              <button
                                type="button"
                                className="btn btn--primary btn--sm"
                                onClick={() => onSelectExistingPerson(person)}
                              >
                                {modalSelectExistingLabel
                                  ? modalSelectExistingLabel(person)
                                  : 'Add as client'}
                              </button>
                            ) : (
                              <Link
                                href={`/people/${person.id}`}
                                className="btn btn--secondary btn--sm"
                              >
                                Open
                              </Link>
                            )
                          ) : org && !existing ? (
                            isLinked ? (
                              <StatusPill label="Linked" tone="positive" />
                            ) : (
                              <button
                                type="button"
                                className="btn btn--secondary btn--sm"
                                onClick={() => linkExistingOrg(org)}
                              >
                                Link
                              </button>
                            )
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                {knownPeople.length > 0 || knownOrganisations.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        color: 'var(--text-muted)',
                      }}
                    >
                      Already known to us
                    </div>

                    {knownPeople.map((m) => (
                      <div
                        key={m.person.id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 8,
                          padding: '8px 10px',
                          borderRadius: 8,
                          border: '1px solid var(--border-subtle)',
                          fontSize: 12.5,
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700 }}>
                            <Link
                              href={`/people/${m.person.id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {personDisplayName(m.person)}
                            </Link>{' '}
                            <span className="muted">({m.person.id})</span>
                          </div>
                          <div className="muted" style={{ fontSize: 11.5 }}>
                            Matched on: {m.formattedReasons} ·{' '}
                            {resolveLabel(values, m.person.relationshipStatusId)}
                          </div>
                        </div>
                        {onSelectExistingPerson ? (
                          <button
                            type="button"
                            className="btn btn--primary btn--sm"
                            onClick={() => onSelectExistingPerson(m.person)}
                          >
                            {modalSelectExistingLabel
                              ? modalSelectExistingLabel(m.person)
                              : 'Add as client'}
                          </button>
                        ) : (
                          <Link
                            href={`/people/${m.person.id}`}
                            className="btn btn--secondary btn--sm"
                          >
                            Open
                          </Link>
                        )}
                      </div>
                    ))}

                    {knownOrganisations.map((m) => (
                      <div
                        key={m.organisation.id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 8,
                          padding: '8px 10px',
                          borderRadius: 8,
                          border: '1px solid var(--border-subtle)',
                          fontSize: 12.5,
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700 }}>
                            <Link
                              href={`/organisations/${m.organisation.id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {m.organisation.legalName}
                            </Link>{' '}
                            <span className="muted">({m.organisation.id})</span>
                          </div>
                          <div className="muted" style={{ fontSize: 11.5 }}>
                            Matched on: {m.formattedReasons} ·{' '}
                            {resolveLabel(values, m.organisation.relationshipStatusId)}
                          </div>
                        </div>
                        {!existing ? (
                          linkOrgId === m.organisation.id ? (
                            <StatusPill label="Linked" tone="positive" />
                          ) : (
                            <button
                              type="button"
                              className="btn btn--secondary btn--sm"
                              onClick={() => linkExistingOrg(m.organisation)}
                            >
                              Link
                            </button>
                          )
                        ) : (
                          <Link
                            href={`/organisations/${m.organisation.id}`}
                            className="btn btn--secondary btn--sm"
                          >
                            Open
                          </Link>
                        )}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              <p
                className="muted"
                style={{ margin: 'auto 0 0', fontSize: 12.5, lineHeight: 1.4 }}
              >
                Indicative only. The full conflict check runs before a matter is opened.
              </p>
            </section>
          </div>
        </div>
      </form>

      {/* Address Modal (same format as the Enquiry screen) */}
      {addressModalOpen ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="person-address-modal-title"
          onClick={() => setAddressModalOpen(false)}
        >
          <div
            className="modal"
            style={{ maxWidth: 520 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal__header">
              <h3 id="person-address-modal-title" className="modal__title">
                Address
              </h3>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setAddressModalOpen(false)}
              >
                ✕
              </button>
            </div>
            <div
              className="modal__body"
              style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
            >
              <div className="field-group">
                <label className="field-label" htmlFor="p-modal-postcode">
                  Postcode
                </label>
                <div className="new-enquiry-postcode-row">
                  <input
                    id="p-modal-postcode"
                    type="text"
                    className="field-input"
                    placeholder="E.G. CF10 1AA"
                    value={primaryAddr.postcode}
                    onChange={(e) => updatePrimaryAddress({ postcode: e.target.value })}
                  />
                  <button
                    type="button"
                    className="btn btn--secondary"
                    style={{ borderRadius: 999, padding: '0 16px' }}
                    onClick={() => {
                      const clean = (primaryAddr.postcode ?? '')
                        .replace(/\s+/g, '')
                        .toUpperCase();
                      if (!clean) {
                        showToast('Enter a postcode first (e.g. CF10 1AA).');
                        return;
                      }
                      handleFindAddress();
                    }}
                  >
                    Find address
                  </button>
                </div>
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="p-line1">
                  Address line 1
                </label>
                <input
                  id="p-line1"
                  type="text"
                  className="field-input"
                  value={primaryAddr.line1}
                  onChange={(e) => updatePrimaryAddress({ line1: e.target.value })}
                />
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="p-line2">
                  Address line 2
                </label>
                <input
                  id="p-line2"
                  type="text"
                  className="field-input"
                  value={primaryAddr.line2}
                  onChange={(e) => updatePrimaryAddress({ line2: e.target.value })}
                />
              </div>

              <div className="new-enquiry-row-2">
                <div className="field-group">
                  <label className="field-label" htmlFor="p-town">
                    Town / city
                  </label>
                  <input
                    id="p-town"
                    type="text"
                    className="field-input"
                    value={primaryAddr.town}
                    onChange={(e) => updatePrimaryAddress({ town: e.target.value })}
                  />
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="p-county">
                    County / region
                  </label>
                  <input
                    id="p-county"
                    type="text"
                    className="field-input"
                    value={primaryAddr.county}
                    onChange={(e) => updatePrimaryAddress({ county: e.target.value })}
                  />
                </div>
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="p-country">
                  Country
                </label>
                <select
                  id="p-country"
                  className="field-select"
                  value={primaryAddr.countryId ?? ''}
                  onChange={(e) => updatePrimaryAddress({ countryId: e.target.value || null })}
                >
                  {countries.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="modal__footer">
              {[
                primaryAddr.line1,
                primaryAddr.line2,
                primaryAddr.town,
                primaryAddr.county,
                primaryAddr.postcode,
              ].some((s) => s.trim().length > 0) ? (
                <button
                  type="button"
                  className="btn btn--secondary"
                  style={{ marginRight: 'auto' }}
                  onClick={() =>
                    updatePrimaryAddress({
                      line1: '',
                      line2: '',
                      town: '',
                      county: '',
                      postcode: '',
                    })
                  }
                >
                  Clear address
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setAddressModalOpen(false)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
