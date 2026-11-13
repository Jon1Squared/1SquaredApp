'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  AlertTriangle,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Edit2,
  FileCheck2,
  FileText,
  FolderOpen,
  Lock,
  Mail,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Upload,
  User,
  X,
} from 'lucide-react';
import {
  type IntakeSourceDocument,
  type MatterAiExtractionResult,
} from '@/domain/matterAiExtract';
import {
  runMatterConflictSearchAction,
  saveMatterAction,
  saveTaskAction,
  signOffMatterCostsAction,
  switchViewingRoleAction,
  updateMatterConflictRecordAction,
} from '@/app/actions';
import { isActionDenied } from '@/domain/actionResult';
import type { PartnerCostSignOffRecord } from '@/domain/matterFieldValues';
import { formatDate, formatDateTime, toIsoDate } from '@/domain/dates';
import {
  enquiryDisplayName,
  mergePeopleWithEnquiries,
} from '@/domain/enquiries';
import {
  filterEmployeesForMatterDepartment,
  resolveNewMatterDepartmentDefaults,
} from '@/domain/employment';
import { resolveLabel } from '@/domain/lists';
import {
  formatConversionConflictWarningsNotice,
  normaliseConversionConflictWarnings,
} from '@/domain/matterConflicts';
import {
  buildDefaultMatterPartyTaxonomy,
  CAPACITY_GROUPS,
  formatPartyRoleDisplay,
  getAvailableCapacitiesForParty,
  getProfilesForWorkType,
  getRelationshipAlignment,
  getWorkTypeClientCapacities,
  inferClientCapacityForMatter,
  isCapacityTypicalForWorkType,
  isClientCapacityRequiredForWorkType,
  mapLegacyPartyRoleToTwoField,
  mapRelationshipToLegacyConflictRole,
  RELATIONSHIP_SORT_ORDER,
} from '@/domain/matterParties';
import { resolveOrgDepartment } from '@/domain/orgStructure';
import {
  calculateDisbursementsTotal,
  lookupRatesForMatter,
  mapBillingBasisLabelToWorkBasis,
  mapWorkBasisToBillingBasisId,
  resolveMatterCostsSnapshot,
  WORK_BASIS_OPTIONS,
} from '@/domain/matterCosts';
import {
  deriveClientAttributes,
  fieldGroupsForSubcategory,
  findSubcategoryRule,
  MATTER_FIELD_MODEL,
  type MatterModelField,
  resolveFieldOptions,
  specificFieldsForSubcategory,
} from '@/domain/matters';
import { personDisplayName } from '@/domain/names';
import {
  MATTER_RISK_SECTIONS,
  summarizeMatterRiskAssessment,
  type CustomKeyDateEntry,
} from '@/domain/matterOpeningRecord';
import { formatGbp, quoteWorkTypeSummary } from '@/domain/quotes';
import {
  allowedNameEdits,
  editDistance,
  normaliseComparableName,
  organisationNameLooseMatch,
  personNameLooseMatch,
  tokensSoundAlike,
} from '@/domain/normalise';
import type {
  ChoiceList,
  ChoiceValue,
  ConflictCheckMatch,
  ConflictCheckParty,
  ConflictCheckRecord,
  ConflictCheckRecordInput,
  ConflictCheckRunAudit,
  ConflictCheckStatusPill,
  ConflictConditionType,
  ConflictMatchDisposition,
  ConflictPartyEntityType,
  ConflictPartyRole,
  ConflictReviewerComment,
  ConflictReviewerDecisionType,
  CustomFieldDefinition,
  CustomGradeRateRow,
  Enquiry,
  Matter,
  MatterCostsConfig,
  MatterCostsSnapshot,
  MatterCostWorkBasis,
  MatterDisbursementEntry,
  MatterParty,
  MatterPartyIdentifiers,
  MatterPartyTaxonomy,
  Organisation,
  OrgStructureCatalogue,
  Person,
  PersonOrganisationLink,
  Quote,
} from '@/domain/types';
import {
  CreateTaskModal,
  type CreateTaskSubmitPayload,
  type SuggestedTaskAssignee,
} from './CreateTaskModal';
import { OrganisationFormClient } from './OrganisationFormClient';
import { PersonFormClient } from './PersonFormClient';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

interface MatterFormClientProps {
  existing?: Matter | null;
  isReopenedDraft?: boolean;
  initialClientId?: string | null;
  initialSubcategoryName?: string | null;
  initialEnquiry?: Enquiry | null;
  initialQuote?: Quote | null;
  initialInstructingContactId?: string | null;
  initialConflictWarnings?: string[];
  activeViewingRole?: string;
  people: Person[];
  organisations: Organisation[];
  links: PersonOrganisationLink[];
  matters: Matter[];
  enquiries?: Enquiry[];
  lists?: ChoiceList[];
  values: ChoiceValue[];
  customFields?: CustomFieldDefinition[];
  employees: Person[];
  currentUser: Person;
  orgStructure: OrgStructureCatalogue;
  matterPartyTaxonomy?: MatterPartyTaxonomy;
  matterCostsConfig: MatterCostsConfig;
  canReassignOwnership?: boolean;
  canSignOffCosts?: boolean;
  initialSignOffEstimateGbp?: number | null;
  suggestedMatterGovernanceAssignees?: {
    riskReviewerId: string | null;
    practiceManagerId: string | null;
  };
  enableAiMatterExtraction?: boolean;
  aiProviderChoice?: 'azure_openai_uk' | 'anthropic' | 'disabled';
  enableMatterCostsGovernance?: boolean;
  tenantId: string;
}

type OptionalTabKey =
  | 'most_used'
  | 'billing'
  | 'key_dates'
  | 'matter_facts'
  | 'compliance'
  | 'custom_fields';

function rolePillTone(
  role: ConflictPartyRole,
  relationshipCode?: string,
): 'positive' | 'warning' | 'alert' | 'neutral' {
  if (relationshipCode === 'CL' || relationshipCode === 'JC') return 'positive';
  if (relationshipCode === 'OP' || relationshipCode === 'CP' || relationshipCode === 'CO')
    return 'warning';
  if (relationshipCode === 'CC' || relationshipCode === 'TP' || relationshipCode === 'NO')
    return 'neutral';
  if (role === 'Client') return 'positive';
  if (role === 'Opponent') return 'warning';
  return 'neutral';
}

function formatIdentifiersSummary(
  entityType: ConflictPartyEntityType,
  identifiers?: MatterPartyIdentifiers,
): string {
  if (!identifiers) return '';
  if (entityType === 'organisation') {
    return [
      identifiers.companyNumber ? `Co. no. ${identifiers.companyNumber}` : null,
      identifiers.registeredTown ? identifiers.registeredTown : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }
  return [
    identifiers.dateOfBirth ? `DOB ${identifiers.dateOfBirth}` : null,
    identifiers.previousNames ? `Prev: ${identifiers.previousNames}` : null,
    identifiers.town ? identifiers.town : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function strengthPillTone(
  strength: 'Exact' | 'Close' | 'Possible',
): 'alert' | 'warning' | 'neutral' {
  if (strength === 'Exact') return 'alert';
  if (strength === 'Close') return 'warning';
  return 'neutral';
}

function statusPillTone(
  status: ConflictCheckStatusPill | 'Draft',
): 'positive' | 'warning' | 'alert' | 'neutral' {
  if (status === 'Cleared' || status === 'Approved') return 'positive';
  if (status === 'Referred' || status === 'In progress' || status === 'Draft') return 'warning';
  if (status === 'Declined') return 'alert';
  return 'neutral';
}

let nextClientItemSeq = 1;
function nextClientItemId(prefix: string): string {
  return `${prefix}-${++nextClientItemSeq}`;
}

export function MatterFormClient({
  existing,
  isReopenedDraft = false,
  initialClientId,
  initialSubcategoryName,
  initialEnquiry,
  initialQuote,
  initialInstructingContactId,
  initialConflictWarnings,
  activeViewingRole = 'fee_earner',
  people: initialPeople,
  organisations: initialOrganisations,
  links: initialLinks,
  matters,
  enquiries = [],
  lists = [],
  values,
  customFields = [],
  employees: initialEmployees,
  currentUser,
  orgStructure,
  matterPartyTaxonomy,
  matterCostsConfig,
  canReassignOwnership = false,
  canSignOffCosts = false,
  initialSignOffEstimateGbp = null,
  suggestedMatterGovernanceAssignees,
  enableAiMatterExtraction = false,
  aiProviderChoice = 'disabled',
  enableMatterCostsGovernance = false,
  tenantId,
}: MatterFormClientProps) {
  const router = useRouter();
  const { showToast } = useToast();
  const today = toIsoDate(new Date());

  const costsConfig = matterCostsConfig;
  const conversionConflictWarnings = useMemo(
    () => normaliseConversionConflictWarnings(initialConflictWarnings),
    [initialConflictWarnings],
  );
  const conversionConflictWarningNotice = useMemo(
    () => formatConversionConflictWarningsNotice(conversionConflictWarnings),
    [conversionConflictWarnings],
  );

  const taxonomy = useMemo(
    () => matterPartyTaxonomy ?? buildDefaultMatterPartyTaxonomy(values),
    [matterPartyTaxonomy, values],
  );

  const [people, setPeople] = useState<Person[]>(() =>
    mergePeopleWithEnquiries(initialPeople, enquiries, values),
  );
  const [organisations, setOrganisations] = useState<Organisation[]>(initialOrganisations);
  const [links, setLinks] = useState<PersonOrganisationLink[]>(initialLinks);

  const employees = useMemo(() => {
    const byId = new Map<string, Person>();
    for (const emp of initialEmployees) {
      byId.set(emp.id, emp);
    }
    for (const p of people) {
      if (p.isEmployee) {
        byId.set(p.id, p);
      }
    }
    return Array.from(byId.values());
  }, [initialEmployees, people]);

  useEffect(() => {
    queueMicrotask(() => {
      setPeople(mergePeopleWithEnquiries(initialPeople, enquiries, values));
    });
  }, [initialPeople, enquiries, values]);

  useEffect(() => {
    queueMicrotask(() => {
      setOrganisations(initialOrganisations);
    });
  }, [initialOrganisations]);

  useEffect(() => {
    queueMicrotask(() => {
      setLinks(initialLinks);
    });
  }, [initialLinks]);

  const card1Ref = useRef<HTMLElement | null>(null);
  const cardCostsRef = useRef<HTMLElement | null>(null);
  const cardRiskRef = useRef<HTMLElement | null>(null);
  const card2Ref = useRef<HTMLElement | null>(null);
  const card3Ref = useRef<HTMLElement | null>(null);
  const card4Ref = useRef<HTMLElement | null>(null);
  const card5Ref = useRef<HTMLElement | null>(null);

  const practiceAreas = useMemo(
    () =>
      values
        .filter((v) => v.listKey === 'work_type' && !v.parentId && v.active)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [values],
  );

  const isEditingExistingMatter = Boolean(
    existing &&
      existing.matterNumber &&
      existing.matterNumber !== 'DRAFT' &&
      existing.conflictCheckStatus !== 'Draft' &&
      !isReopenedDraft,
  );

  // Support unlimited multiple clients on a matter
  const [clientIds, setClientIds] = useState<string[]>(() => {
    if (existing?.clientId) {
      const extraFromProp = existing.additionalClientIds ?? [];
      const extraFromFields =
        (existing.fieldValues?.['additionalClientIds'] as string[] | undefined) ?? [];
      return Array.from(
        new Set([existing.clientId, ...extraFromProp, ...extraFromFields].filter(Boolean)),
      );
    }
    if (initialClientId) {
      return [initialClientId];
    }
    if (initialQuote?.linkedOrganisationId) {
      return [initialQuote.linkedOrganisationId];
    }
    if (initialQuote?.linkedPersonId) {
      return [initialQuote.linkedPersonId];
    }
    if (initialEnquiry?.linkedOrganisationId) {
      return [initialEnquiry.linkedOrganisationId];
    }
    if (initialEnquiry?.linkedPersonId) {
      return [initialEnquiry.linkedPersonId];
    }
    return [];
  });

  const clientId = clientIds[0] ?? '';
  function setClientId(nextId: string) {
    setClientIds(nextId ? [nextId] : []);
  }

  // Client Lookup & Add Pop-up Modal state
  const [clientModalOpen, setClientModalOpen] = useState<boolean>(false);
  const [clientModalView, setClientModalView] = useState<
    'search' | 'new_person' | 'new_org' | 'edit_person' | 'edit_org'
  >('search');
  const [editingClientRecordId, setEditingClientRecordId] = useState<string | null>(null);
  const [clientSearchFirstName, setClientSearchFirstName] = useState<string>('');
  const [clientSearchSurname, setClientSearchSurname] = useState<string>('');
  const [clientSearchOrg, setClientSearchOrg] = useState<string>('');
  const [tickedClientIds, setTickedClientIds] = useState<string[]>([]);

  const [instructingContactId, setInstructingContactId] = useState<string | null>(
    existing?.instructingContactId ??
      initialInstructingContactId ??
      initialQuote?.linkedPersonId ??
      initialEnquiry?.linkedPersonId ??
      null,
  );
  const [title, setTitle] = useState<string>(() => {
    if (existing?.title && existing.title !== 'Draft matter') return existing.title;
    if (initialQuote) {
      const wt = quoteWorkTypeSummary(initialQuote, values);
      const scopePreview = initialQuote.scope?.trim().split(/[\r\n.]/)[0]?.trim() || '';
      return scopePreview ? `${wt} — ${scopePreview.slice(0, 80)}` : wt;
    }
    if (initialEnquiry?.summary?.trim()) return initialEnquiry.summary.trim();
    return '';
  });
  const [shortDescription, setShortDescription] = useState<string>(() => {
    if (existing?.shortDescription) return existing.shortDescription;
    if (initialQuote) {
      const parts: string[] = [];
      if (initialQuote.scope?.trim()) parts.push(initialQuote.scope.trim());
      if (initialQuote.assumptions?.trim()) {
        parts.push(`Assumptions & exclusions: ${initialQuote.assumptions.trim()}`);
      }
      if (initialQuote.disbursements?.length) {
        const disbText = initialQuote.disbursements
          .map((d) => `${d.description} (${formatGbp(d.amountExVat)}${d.vatApplicable ? ' + VAT' : ''})`)
          .join('; ');
        parts.push(`Disbursements: ${disbText}`);
      }
      if (parts.length > 0) return parts.join('\n\n');
    }
    if (initialEnquiry?.notes?.trim()) return initialEnquiry.notes.trim();
    if (initialEnquiry?.summary?.trim()) return initialEnquiry.summary.trim();
    return '';
  });

  // Pre-selected Department, Responsible Partner (from Supervising Partner), and Fee Earner
  // when creating a new matter for a logged-in person who has a legal team department assigned
  const userMatterDefaults = useMemo(
    () =>
      resolveNewMatterDepartmentDefaults({
        currentUser,
        allPeople: people,
        employees,
        practiceAreas,
      }),
    [currentUser, people, employees, practiceAreas],
  );

  const initialSubcatVal = useMemo(() => {
    if (!initialSubcategoryName) return null;
    const lower = initialSubcategoryName.trim().toLowerCase();
    return (
      values.find(
        (v) =>
          v.listKey === 'work_type' &&
          Boolean(v.parentId) &&
          v.active &&
          v.label.trim().toLowerCase() === lower,
      ) ?? null
    );
  }, [initialSubcategoryName, values]);

  const [practiceAreaId, setPracticeAreaId] = useState<string>(
    () =>
      existing?.practiceAreaId ??
      initialQuote?.practiceAreaId ??
      initialEnquiry?.practiceAreaId ??
      initialSubcatVal?.parentId ??
      userMatterDefaults.practiceAreaId,
  );
  const [owningDepartmentId, setOwningDepartmentId] = useState<string>(
    () =>
      existing?.owningDepartmentId ??
      resolveOrgDepartment(
        existing?.practiceAreaId ??
          initialQuote?.practiceAreaId ??
          initialEnquiry?.practiceAreaId ??
          initialSubcatVal?.parentId ??
          userMatterDefaults.practiceAreaId,
        orgStructure,
      )?.id ??
      '',
  );
  const [owningDepartmentExplicitlyChosen, setOwningDepartmentExplicitlyChosen] =
    useState<boolean>(() => Boolean(existing?.owningDepartmentId));
  const [owningTeamId, setOwningTeamId] = useState<string>(
    () => existing?.owningTeamId ?? '',
  );
  const availableOwningTeams = useMemo(
    () =>
      orgStructure.teamsOrPracticeGroups.filter(
        (t) =>
          t.active &&
          (!owningDepartmentId || t.parentDepartmentId === owningDepartmentId),
      ),
    [orgStructure, owningDepartmentId],
  );
  const [workTypeSubcategoryId, setWorkTypeSubcategoryId] = useState<string>(() => {
    if (existing?.workTypeSubcategoryId) return existing.workTypeSubcategoryId;
    if (initialQuote?.workTypeSubcategoryId) return initialQuote.workTypeSubcategoryId;
    if (initialEnquiry?.workTypeSubcategoryId) return initialEnquiry.workTypeSubcategoryId;
    if (initialSubcatVal?.id) return initialSubcatVal.id;
    const targetPaId = initialQuote?.practiceAreaId ?? initialEnquiry?.practiceAreaId;
    if (targetPaId) {
      const firstSub = values.find(
        (v) => v.listKey === 'work_type' && v.parentId === targetPaId && v.active,
      );
      if (firstSub) return firstSub.id;
    }
    return '';
  });

  const enquiryResponsiblePartnerDefault = useMemo(() => {
    const sourceFeeEarnerId = initialQuote?.feeEarnerId ?? initialEnquiry?.assignedToId ?? null;
    const sourcePracticeAreaId =
      initialQuote?.practiceAreaId ?? initialEnquiry?.practiceAreaId ?? null;
    if (!sourceFeeEarnerId && !sourcePracticeAreaId) return null;
    if (sourceFeeEarnerId) {
      const assignedEmp = employees.find((e) => e.id === sourceFeeEarnerId);
      if (assignedEmp?.employment?.supervisingPartnerId) {
        return assignedEmp.employment.supervisingPartnerId;
      }
      if (
        assignedEmp &&
        (assignedEmp.employment?.roleType === 'Partner/Member' ||
          (assignedEmp.jobTitle || '').toLowerCase().includes('partner'))
      ) {
        return assignedEmp.id;
      }
    }
    if (sourcePracticeAreaId) {
      const deptPartners = filterEmployeesForMatterDepartment({
        employees,
        practiceAreaId: sourcePracticeAreaId,
        practiceAreas,
        includeSupervisingPartners: true,
      });
      const partner = deptPartners.find(
        (e) =>
          e.employment?.roleType === 'Partner/Member' ||
          (e.employment?.jobTitle || e.jobTitle || '').toLowerCase().includes('partner'),
      );
      if (partner) return partner.id;
    }
    return null;
  }, [initialQuote, initialEnquiry, employees, practiceAreas]);

  const [responsiblePartnerId, setResponsiblePartnerId] = useState<string | null>(
    () =>
      existing?.responsiblePartnerId ??
      enquiryResponsiblePartnerDefault ??
      userMatterDefaults.responsiblePartnerId,
  );
  const [leadFeeEarnerId, setLeadFeeEarnerId] = useState<string | null>(
    () =>
      existing?.leadFeeEarnerId ??
      initialQuote?.feeEarnerId ??
      initialEnquiry?.assignedToId ??
      userMatterDefaults.leadFeeEarnerId,
  );
  const [supervisingPartnerId, setSupervisingPartnerId] = useState<string | null>(
    () =>
      existing?.supervisingPartnerId ??
      enquiryResponsiblePartnerDefault ??
      userMatterDefaults.responsiblePartnerId,
  );
  const [relationshipPartnerId, setRelationshipPartnerId] = useState<string | null>(
    () => existing?.relationshipPartnerId ?? enquiryResponsiblePartnerDefault ?? null,
  );
  const [billingContactId, setBillingContactId] = useState<string | null>(
    () =>
      existing?.billingContactId ??
      initialInstructingContactId ??
      initialQuote?.linkedPersonId ??
      initialEnquiry?.linkedPersonId ??
      null,
  );

  // Update pre-selected defaults when switching the logged-in user on a fresh new matter screen
  const prevUserIdRef = useRef(currentUser.id);
  useEffect(() => {
    if (prevUserIdRef.current !== currentUser.id) {
      prevUserIdRef.current = currentUser.id;
      if (!existing && !initialEnquiry && !initialQuote) {
        queueMicrotask(() => {
          setPracticeAreaId(userMatterDefaults.practiceAreaId);
          setWorkTypeSubcategoryId('');
          setResponsiblePartnerId(userMatterDefaults.responsiblePartnerId);
          setLeadFeeEarnerId(userMatterDefaults.leadFeeEarnerId);
          setSupervisingPartnerId(userMatterDefaults.responsiblePartnerId);
        });
      }
    }
  }, [
    currentUser.id,
    existing,
    initialEnquiry,
    initialQuote,
    userMatterDefaults,
  ]);

  // Filter Responsible Partner and Fee Earner dropdown options to only people in the relevant department
  const responsiblePartnerOptions = useMemo(
    () =>
      filterEmployeesForMatterDepartment({
        employees,
        practiceAreaId,
        practiceAreas,
        includeSupervisingPartners: true,
        preserveSelectedId: responsiblePartnerId,
      }),
    [employees, practiceAreaId, practiceAreas, responsiblePartnerId],
  );

  const feeEarnerOptions = useMemo(
    () =>
      filterEmployeesForMatterDepartment({
        employees,
        practiceAreaId,
        practiceAreas,
        includeSupervisingPartners: false,
        preserveSelectedId: leadFeeEarnerId,
      }),
    [employees, practiceAreaId, practiceAreas, leadFeeEarnerId],
  );

  // Filter "Add team member" dropdown strictly to people in the chosen department
  const teamMemberDepartmentOptions = useMemo(
    () =>
      practiceAreaId
        ? filterEmployeesForMatterDepartment({
            employees,
            practiceAreaId,
            practiceAreas,
            includeSupervisingPartners: false,
          })
        : [],
    [employees, practiceAreaId, practiceAreas],
  );

  // Additional team members (role derived from each employee's job title)
  const [additionalTeamRoles, setAdditionalTeamRoles] = useState<
    { personId: string; role: string }[]
  >(() => {
    if (!existing) return [];
    const savedRoles =
      (existing.fieldValues?.['teamMemberRoles'] as Record<string, string> | undefined) ?? {};
    const rows: { personId: string; role: string }[] = [];
    const seen = new Set<string>();
    if (existing.responsiblePartnerId) seen.add(existing.responsiblePartnerId);
    if (existing.leadFeeEarnerId) seen.add(existing.leadFeeEarnerId);

    if (existing.supervisingPartnerId && !seen.has(existing.supervisingPartnerId)) {
      seen.add(existing.supervisingPartnerId);
      const supEmp = employees.find((e) => e.id === existing.supervisingPartnerId);
      rows.push({
        personId: existing.supervisingPartnerId,
        role:
          supEmp?.employment?.jobTitle ||
          supEmp?.jobTitle ||
          savedRoles[existing.supervisingPartnerId] ||
          'Supervising partner',
      });
    }
    if (existing.relationshipPartnerId && !seen.has(existing.relationshipPartnerId)) {
      seen.add(existing.relationshipPartnerId);
      const relEmp = employees.find((e) => e.id === existing.relationshipPartnerId);
      rows.push({
        personId: existing.relationshipPartnerId,
        role:
          relEmp?.employment?.jobTitle ||
          relEmp?.jobTitle ||
          savedRoles[existing.relationshipPartnerId] ||
          'Relationship partner',
      });
    }
    for (const tid of existing.teamMemberIds ?? []) {
      if (seen.has(tid)) continue;
      seen.add(tid);
      const emp = employees.find((e) => e.id === tid);
      rows.push({
        personId: tid,
        role:
          emp?.employment?.jobTitle ||
          emp?.jobTitle ||
          savedRoles[tid] ||
          'Team member',
      });
    }
    return rows;
  });
  const [newTeamPersonId, setNewTeamPersonId] = useState<string>('');
  const [teamEmployeeSearchQuery, setTeamEmployeeSearchQuery] = useState<string>('');
  const [showTeamEmployeeSuggestions, setShowTeamEmployeeSuggestions] =
    useState<boolean>(false);

  const teamEmployeeSearchResults = useMemo(() => {
    const q = teamEmployeeSearchQuery.trim().toLowerCase();
    if (!q) return [];
    return employees
      .filter((emp) => !emp.demo)
      .filter((emp) => {
        const name = personDisplayName(emp).toLowerCase();
        const jobTitle = (emp.employment?.jobTitle || emp.jobTitle || '').toLowerCase();
        const deptName = (
          resolveOrgDepartment(emp.employment?.departmentId || emp.departmentId)?.name ||
          resolveLabel(values, emp.departmentId) ||
          ''
        ).toLowerCase();
        const email = (emp.emails[0]?.address || '').toLowerCase();
        return (
          name.includes(q) ||
          jobTitle.includes(q) ||
          deptName.includes(q) ||
          email.includes(q)
        );
      })
      .slice(0, 8);
  }, [employees, teamEmployeeSearchQuery, values]);

  function handleAddTeamRole(personIdToAdd?: string) {
    const pid = personIdToAdd ?? newTeamPersonId;
    if (!pid) return;
    const emp = employees.find((e) => e.id === pid);
    const roleToUse =
      emp?.employment?.jobTitle?.trim() || emp?.jobTitle?.trim() || 'Team member';
    setAdditionalTeamRoles((prev) => {
      const idx = prev.findIndex((r) => r.personId === pid);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { personId: pid, role: roleToUse };
        return next;
      }
      return [...prev, { personId: pid, role: roleToUse }];
    });
    if (!personIdToAdd || personIdToAdd === newTeamPersonId) {
      setNewTeamPersonId('');
    }
    setTeamEmployeeSearchQuery('');
    setShowTeamEmployeeSuggestions(false);
  }

  function handleRemoveTeamRole(personId: string) {
    if (supervisingPartnerId === personId) setSupervisingPartnerId(null);
    if (relationshipPartnerId === personId) setRelationshipPartnerId(null);
    setAdditionalTeamRoles((prev) => prev.filter((r) => r.personId !== personId));
  }

  // 2 · PARTIES TO CHECK state (two-field Relationship + Capacity model)
  const [clientCapacityCodes, setClientCapacityCodes] = useState<string[]>(() => {
    const saved = existing?.fieldValues?.['clientCapacityCodes'] as string[] | undefined;
    if (Array.isArray(saved) && saved.length > 0) return saved;
    const fixedCl = existing?.conflictCheckRecord?.parties?.find((p) => p.id === 'party-client');
    if (fixedCl?.capacityCodes?.length) return fixedCl.capacityCodes;
    const inferred = existing ? inferClientCapacityForMatter(existing) : null;
    if (inferred) return [inferred.code];
    if (initialEnquiry || initialQuote) {
      const typicalCaps = getWorkTypeClientCapacities(
        taxonomy,
        workTypeSubcategoryId ||
          initialQuote?.workTypeSubcategoryId ||
          initialEnquiry?.workTypeSubcategoryId ||
          null,
        'CL',
      );
      if (typicalCaps.length > 0) return [typicalCaps[0].code];
    }
    return [];
  });

  const [jointClientCapacityCodes, setJointClientCapacityCodes] = useState<
    Record<string, string[]>
  >(() => {
    const saved = existing?.fieldValues?.['jointClientCapacityCodes'] as
      | Record<string, string[]>
      | undefined;
    if (saved && typeof saved === 'object') return saved;
    return {};
  });

  const [instructingContactCapacityCodes, setInstructingContactCapacityCodes] = useState<
    string[]
  >(() => {
    const saved = existing?.fieldValues?.['instructingContactCapacityCodes'] as
      | string[]
      | undefined;
    if (Array.isArray(saved) && saved.length > 0) return saved;
    const fixedInst = existing?.conflictCheckRecord?.parties?.find(
      (p) => p.id === 'party-instructing',
    );
    if (fixedInst?.capacityCodes?.length) return fixedInst.capacityCodes;
    return ['CAP_REPRESENTATIVE', 'CAP_DECISION_MAKER'];
  });

  const [otherParties, setOtherParties] = useState<ConflictCheckParty[]>(() => {
    const partiesEdited = Boolean(existing?.fieldValues?.['partiesEdited']);
    const mapMatterParty = (pt: MatterParty): ConflictCheckParty => {
      const mapped = pt.relationshipCode
        ? {
            relationshipCode: pt.relationshipCode,
            capacityCodes: pt.capacityCodes ?? [],
            needsCapacityPrompt: Boolean(pt.needsCapacityPrompt),
          }
        : mapLegacyPartyRoleToTwoField(pt.role, existing ?? undefined);
      const entityType: ConflictPartyEntityType =
        pt.entityType ?? (pt.linkedRecordId?.startsWith('P-') ? 'person' : 'organisation');
      const alignment = pt.alignment ?? getRelationshipAlignment(mapped.relationshipCode);
      return {
        id: pt.id,
        name: pt.name,
        entityType,
        role: mapRelationshipToLegacyConflictRole(mapped.relationshipCode),
        relationshipCode: mapped.relationshipCode,
        capacityCodes: mapped.capacityCodes,
        connectedToPartyId: pt.connectedToPartyId ?? null,
        identifiers: pt.identifiers,
        needsCapacityPrompt: mapped.needsCapacityPrompt,
        alignment,
        linkedRecordId: pt.linkedRecordId,
        subtitle: formatPartyRoleDisplay(
          taxonomy,
          mapped.relationshipCode,
          mapped.capacityCodes,
          pt.role,
        ),
      };
    };

    if (partiesEdited && existing?.parties) {
      return existing.parties.map(mapMatterParty);
    }
    if (existing?.parties?.length) {
      return existing.parties.map(mapMatterParty);
    }
    if (existing?.conflictCheckRecord?.parties) {
      return existing.conflictCheckRecord.parties
        .filter((p) => !p.isClientFixed)
        .map((p) => {
          const mapped = p.relationshipCode
            ? {
                relationshipCode: p.relationshipCode,
                capacityCodes: p.capacityCodes ?? [],
                needsCapacityPrompt: Boolean(p.needsCapacityPrompt),
              }
            : mapLegacyPartyRoleToTwoField(p.role, existing ?? undefined);
          return {
            ...p,
            relationshipCode: mapped.relationshipCode,
            capacityCodes: mapped.capacityCodes,
            needsCapacityPrompt: mapped.needsCapacityPrompt,
            alignment: p.alignment ?? getRelationshipAlignment(mapped.relationshipCode),
          };
        });
    }
    if (initialEnquiry?.otherPartiesNamed?.trim()) {
      const names = initialEnquiry.otherPartiesNamed
        .split(/[,;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const subVal = values.find(
        (v) => v.id === (initialEnquiry.workTypeSubcategoryId ?? ''),
      );
      const subLbl = (subVal?.label ?? '').toLowerCase();
      const defaultCap = subLbl.includes('tribunal')
        ? 'CAP_EMPLOYER'
        : subLbl.includes('landlord')
          ? 'CAP_TENANT'
          : subLbl.includes('property') || subLbl.includes('acquisition')
            ? 'CAP_SELLER'
            : 'CAP_OTHER';

      return names.map((nm, idx) => {
        const lowerNm = nm.toLowerCase();
        const matchedOrg = organisations.find(
          (o) => !o.mergedIntoId && o.legalName.toLowerCase() === lowerNm,
        );
        const matchedPerson = !matchedOrg
          ? people.find(
              (p) =>
                !p.mergedIntoId &&
                !p.isEmployee &&
                personDisplayName(p).toLowerCase() === lowerNm,
            )
          : undefined;
        const isPersonEntity =
          Boolean(matchedPerson) ||
          (!matchedOrg &&
            !/\b(ltd|limited|llp|plc|inc|corp|company|association|council|partners|solicitors|group|holdings|estates|solutions|investments|auctioneers|commercial|bank|trust)\b/i.test(
              nm,
            ) &&
            nm.split(/\s+/).length <= 3);
        const entityType: ConflictPartyEntityType = isPersonEntity
          ? 'person'
          : 'organisation';
        const capCodes = [defaultCap];
        return {
          id: `enq-party-${idx + 1}`,
          name: nm,
          entityType,
          role: 'Opponent',
          relationshipCode: 'OP',
          capacityCodes: capCodes,
          connectedToPartyId: null,
          needsCapacityPrompt: false,
          alignment: 'adverse',
          linkedRecordId: matchedOrg?.id ?? matchedPerson?.id ?? null,
          subtitle: formatPartyRoleDisplay(taxonomy, 'OP', capCodes, 'Opponent'),
        };
      });
    }
    return [];
  });

  // "+ Add party" / Edit party modal & inputs (Part 2.2)
  const [partyModalOpen, setPartyModalOpen] = useState<boolean>(false);
  const [editingPartyId, setEditingPartyId] = useState<string | null>(null);
  const [newPartyName, setNewPartyName] = useState('');
  const [newPartyType, setNewPartyType] = useState<ConflictPartyEntityType>('organisation');
  const [newPartyRelationshipCode, setNewPartyRelationshipCode] = useState<string>('');
  const [newPartyCapacityCodes, setNewPartyCapacityCodes] = useState<string[]>([]);
  const [showAllCapacities, setShowAllCapacities] = useState<boolean>(false);
  const [newPartyConnectedToId, setNewPartyConnectedToId] = useState<string>('');
  const [newPartyMoreDetailsOpen, setNewPartyMoreDetailsOpen] = useState<boolean>(false);
  const [newPartyIdentifiers, setNewPartyIdentifiers] = useState<MatterPartyIdentifiers>({});
  const [newPartyLinkedId, setNewPartyLinkedId] = useState<string | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [capacityDropdownOpen, setCapacityDropdownOpen] = useState(false);

  // 3 · CONFLICT SEARCH state
  const [hasRunSearch, setHasRunSearch] = useState<boolean>(
    Boolean(existing?.conflictCheckRecord?.lastRunAtDisplay),
  );
  const [lastRunAtDisplay, setLastRunAtDisplay] = useState<string | null>(
    existing?.conflictCheckRecord?.lastRunAtDisplay ?? null,
  );
  const [lastRunByName, setLastRunByName] = useState<string | null>(
    existing?.conflictCheckRecord?.lastRunByName ?? null,
  );
  const [partiesChangedSinceSearch, setPartiesChangedSinceSearch] = useState<boolean>(false);
  const [matches, setMatches] = useState<ConflictCheckMatch[]>(
    existing?.conflictCheckRecord?.matches ?? [],
  );
  const [searchRuns, setSearchRuns] = useState<ConflictCheckRunAudit[]>(
    existing?.conflictCheckRecord?.runs ?? [],
  );

  // 4 · OUTCOME AND DECLARATION state
  const [declarationConfirmed, setDeclarationConfirmed] = useState<boolean>(
    existing?.conflictCheckRecord?.declarationConfirmed ?? false,
  );
  const [reviewerMessage, setReviewerMessage] = useState<string>(
    existing?.conflictCheckRecord?.reviewerMessage ?? '',
  );

  // 6 · MORE DETAILS (optional, minimised by default)
  const [section1Open, setSection1Open] = useState<boolean>(true);
  const [sectionCostsOpen, setSectionCostsOpen] = useState<boolean>(false);
  const [section2Open, setSection2Open] = useState<boolean>(false);
  const [section3Open, setSection3Open] = useState<boolean>(false);
  const [section4Open, setSection4Open] = useState<boolean>(false);
  const [section5Open, setSection5Open] = useState<boolean>(false);
  const [moreDetailsOpen, setMoreDetailsOpen] = useState<boolean>(false);
  const [optionalTab, setOptionalTab] = useState<OptionalTabKey>('most_used');

  // Optional fields state
  const subcategoryVal = useMemo(
    () => values.find((v) => v.id === workTypeSubcategoryId),
    [values, workTypeSubcategoryId],
  );
  const subcategoryLabel = subcategoryVal?.label ?? 'Landlord & tenant';
  const matrixRule = useMemo(() => findSubcategoryRule(subcategoryLabel), [subcategoryLabel]);

  const [typeBadge, setTypeBadge] = useState(
    existing?.typeBadge ?? '',
  );
  const [matterTypeId, setMatterTypeId] = useState(
    existing?.matterTypeId ?? '',
  );
  const [billingBasisId, setBillingBasisId] = useState(() => {
    if (existing?.billingBasisId) return existing.billingBasisId;
    if (initialQuote) {
      const basisOptions = values.filter((v) => v.listKey === 'billing_basis' && v.active);
      if (initialQuote.feeBasis === 'Fixed fee') {
        const fixed = basisOptions.find((v) => v.label.toLowerCase().includes('fixed'));
        if (fixed) return fixed.id;
      } else if (initialQuote.feeBasis === 'Capped fee') {
        const capped = basisOptions.find((v) => v.label.toLowerCase().includes('cap'));
        if (capped) return capped.id;
      } else {
        const hourly = basisOptions.find((v) => v.label.toLowerCase().includes('hourly'));
        if (hourly) return hourly.id;
      }
    }
    return '';
  });
  const [clientTierId, setClientTierId] = useState<string | null>(
    existing?.clientTierId ?? null,
  );
  const [clientSectorId, setClientSectorId] = useState<string | null>(
    existing?.clientSectorId ?? null,
  );
  const [riskRatingId, setRiskRatingId] = useState(
    existing?.riskRatingId ?? '',
  );
  const [matterSizeId, setMatterSizeId] = useState<string | null>(
    existing?.matterSizeId ?? null,
  );
  const [feeEstimateGbp, setFeeEstimateGbp] = useState<string>(() => {
    if (existing?.feeEstimateGbp != null) return String(existing.feeEstimateGbp);
    if (initialQuote) return String(initialQuote.feeAmountExVat);
    return '';
  });
  const [agreedFeeCapGbp, setAgreedFeeCapGbp] = useState<string>(() => {
    if (existing?.agreedFeeCapGbp != null) return String(existing.agreedFeeCapGbp);
    if (
      initialQuote &&
      (initialQuote.feeBasis === 'Capped fee' || initialQuote.feeBasis === 'Fixed fee')
    ) {
      return String(initialQuote.feeAmountExVat);
    }
    return '';
  });
  const [retainerMoniesOnAccountGbp, setRetainerMoniesOnAccountGbp] = useState<string>(
    existing?.retainerMoniesOnAccountGbp != null
      ? String(existing.retainerMoniesOnAccountGbp)
      : '',
  );
  const [openedAt, setOpenedAt] = useState<string | null>(existing?.openedAt ?? null);
  const [targetCompletionAt, setTargetCompletionAt] = useState<string | null>(
    existing?.targetCompletionAt ?? initialEnquiry?.keyDate ?? null,
  );
  const [amlStatus, setAmlStatus] = useState<string>(existing?.amlStatus ?? '');
  const [sourceOfFundsVerified, setSourceOfFundsVerified] = useState<string>(
    existing?.sourceOfFundsVerified ?? '',
  );
  const [engagementLetterStatus, setEngagementLetterStatus] = useState<string>(
    existing?.engagementLetterStatus ?? '',
  );
  const [forumCourt, setForumCourt] = useState<string>(existing?.forumCourt ?? '');
  const [fieldValues, setFieldValues] = useState<Record<string, unknown>>(() => {
    const base = existing?.fieldValues ?? {};
    if (initialQuote && !existing) {
      return {
        ...base,
        quoteId: initialQuote.id,
        quoteReference: initialQuote.reference,
        quoteFeeBasis: initialQuote.feeBasis,
        quoteFeeAmountExVat: initialQuote.feeAmountExVat,
        quoteHourlyRateGbp: initialQuote.hourlyRateGbp ?? null,
        quoteDisbursements: initialQuote.disbursements,
        quoteScope: initialQuote.scope,
        quoteAssumptions: initialQuote.assumptions,
      };
    }
    return base;
  });

  // 2 · MATTER COSTS state (initialised from existing matter, quote, or client-customised rate card)
  const initialMatterCosts = useMemo(
    () =>
      resolveMatterCostsSnapshot({
        existing,
        initialQuote,
        practiceAreaId,
        config: costsConfig,
        values,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [costWorkBasis, setCostWorkBasis] = useState<MatterCostWorkBasis>(
    initialMatterCosts.workBasis,
  );
  const [costRateSource, setCostRateSource] = useState<
    'app_table' | 'pms' | 'custom_override'
  >(initialMatterCosts.rateSource);
  const [costRateCardId, setCostRateCardId] = useState<string>(
    initialMatterCosts.rateCardId ?? costsConfig.rateCards[0]?.id ?? 'RC-DEFAULT',
  );
  const [partnerRateGbp, setPartnerRateGbp] = useState<string>(
    String(initialMatterCosts.partnerRateGbp),
  );
  const [associateRateGbp, setAssociateRateGbp] = useState<string>(
    String(initialMatterCosts.associateRateGbp),
  );
  const [traineeRateGbp, setTraineeRateGbp] = useState<string>(
    String(initialMatterCosts.traineeRateGbp),
  );
  const [customGradeRates, setCustomGradeRates] = useState<CustomGradeRateRow[]>(
    initialMatterCosts.customGrades ?? [],
  );
  const [costDisbursements, setCostDisbursements] = useState<MatterDisbursementEntry[]>(
    initialMatterCosts.disbursements,
  );
  const [newDisbursementDescription, setNewDisbursementDescription] =
    useState<string>('');
  const [newDisbursementAmount, setNewDisbursementAmount] = useState<string>('');
  const [newDisbursementVat, setNewDisbursementVat] = useState<boolean>(true);
  const [paymentOnAccountRequired, setPaymentOnAccountRequired] = useState<
    'Yes' | 'No' | ''
  >(initialMatterCosts.paymentOnAccountRequired);
  const [costNotes, setCostNotes] = useState<string>(
    initialMatterCosts.notes ?? '',
  );

  const activeRateCards = useMemo(
    () => costsConfig.rateCards.filter((rc) => rc.active),
    [costsConfig.rateCards],
  );

  const selectedRateCard = useMemo(
    () =>
      activeRateCards.find((rc) => rc.id === costRateCardId) ??
      activeRateCards.find((rc) => rc.practiceAreaId === practiceAreaId) ??
      activeRateCards[0] ??
      null,
    [activeRateCards, costRateCardId, practiceAreaId],
  );

  function applyRateCardToState(
    cardId: string,
    preferSource?: 'app_table' | 'pms',
  ) {
    const card =
      activeRateCards.find((rc) => rc.id === cardId) ??
      activeRateCards[0];
    if (!card) return;
    setCostRateCardId(card.id);
    const usePms =
      preferSource === 'pms' ||
      (preferSource !== 'app_table' &&
        (costsConfig.rateSourceMode === 'pms_only' ||
          (costsConfig.rateSourceMode === 'pms_when_linked' &&
            costsConfig.pmsLinkActive)) &&
        card.pmsPartnerRateGbp != null);
    setCostRateSource(usePms ? 'pms' : 'app_table');
    setPartnerRateGbp(
      String(
        usePms && card.pmsPartnerRateGbp != null
          ? card.pmsPartnerRateGbp
          : card.partnerRateGbp,
      ),
    );
    setAssociateRateGbp(
      String(
        usePms && card.pmsAssociateRateGbp != null
          ? card.pmsAssociateRateGbp
          : card.associateRateGbp,
      ),
    );
    setTraineeRateGbp(
      String(
        usePms && card.pmsTraineeRateGbp != null
          ? card.pmsTraineeRateGbp
          : card.traineeRateGbp,
      ),
    );
    setCustomGradeRates(
      (card.customGrades ?? []).map((g) => ({
        ...g,
        hourlyRateGbp:
          usePms && g.pmsRateGbp != null ? g.pmsRateGbp : g.hourlyRateGbp,
      })),
    );
  }

  // Automatically look up the department's rate card when Department changes in Step 1 (unless manually overridden)
  const prevCostPracticeAreaRef = useRef<string>(practiceAreaId);
  useEffect(() => {
    if (prevCostPracticeAreaRef.current === practiceAreaId) return;
    prevCostPracticeAreaRef.current = practiceAreaId;
    if (costRateSource === 'custom_override') return;
    const lookedUp = lookupRatesForMatter({
      config: costsConfig,
      practiceAreaId,
      preferredSource: costRateSource === 'pms' ? 'pms' : 'app_table',
    });
    queueMicrotask(() => {
      if (lookedUp.rateCard.id) setCostRateCardId(lookedUp.rateCard.id);
      setCostRateSource(lookedUp.activeSource);
      setPartnerRateGbp(String(lookedUp.partnerRateGbp));
      setAssociateRateGbp(String(lookedUp.associateRateGbp));
      setTraineeRateGbp(String(lookedUp.traineeRateGbp));
      setCustomGradeRates(lookedUp.customGrades);
    });
  }, [practiceAreaId, costsConfig, costRateSource]);

  function handleSelectWorkBasis(nextBasis: MatterCostWorkBasis) {
    setCostWorkBasis(nextBasis);
    const mappedBbId = mapWorkBasisToBillingBasisId(nextBasis, values);
    if (mappedBbId) {
      setBillingBasisId(mappedBbId);
    }
    const riskFeeAnswer =
      nextBasis === 'fixed_fee'
        ? 'Fixed fee'
        : nextBasis === 'hourly_rates' || nextBasis === 'capped'
          ? 'Hourly'
          : '';
    if (riskFeeAnswer) {
      setRiskAnswers((prev) => ({ ...prev, feeBasis: riskFeeAnswer }));
    }
  }

  function handleAddDisbursementRow(preset?: {
    description: string;
    amountGbp: number;
    vatApplicable?: boolean;
  }) {
    const desc = (preset ? preset.description : newDisbursementDescription).trim();
    const rawAmt = preset ? preset.amountGbp : Number(newDisbursementAmount);
    if (!desc) return;
    const amountGbp = Number.isFinite(rawAmt) && rawAmt >= 0 ? rawAmt : 0;
    const entry: MatterDisbursementEntry = {
      id: nextClientItemId('DISB'),
      description: desc,
      amountGbp,
      vatApplicable: preset ? (preset.vatApplicable ?? true) : newDisbursementVat,
    };
    setCostDisbursements((prev) => [...prev, entry]);
    if (!preset) {
      setNewDisbursementDescription('');
      setNewDisbursementAmount('');
    }
  }

  function handleUpdateDisbursementRow(
    id: string,
    patch: Partial<MatterDisbursementEntry>,
  ) {
    setCostDisbursements((prev) =>
      prev.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    );
  }

  function handleRemoveDisbursementRow(id: string) {
    setCostDisbursements((prev) => prev.filter((d) => d.id !== id));
  }

  function handleSelectPaymentOnAccount(choice: 'Yes' | 'No') {
    setPaymentOnAccountRequired(choice);
    if (choice === 'No') {
      setRetainerMoniesOnAccountGbp('');
      setRiskAnswers((prev) => ({
        ...prev,
        moneyOnAccountRequested: 'No, justified',
      }));
    } else {
      setRiskAnswers((prev) => ({
        ...prev,
        moneyOnAccountRequested: 'Yes',
      }));
    }
  }

  const disbursementsTotalGbp = useMemo(
    () => calculateDisbursementsTotal(costDisbursements),
    [costDisbursements],
  );

  const numericFeeEstimateGbp = useMemo(() => {
    const n = Number(String(feeEstimateGbp).replace(/[£,\s]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [feeEstimateGbp]);

  const numericAgreedCapGbp = useMemo(() => {
    const n = Number(String(agreedFeeCapGbp).replace(/[£,\s]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [agreedFeeCapGbp]);

  const numericPoaAmountGbp = useMemo(() => {
    const n = Number(String(retainerMoniesOnAccountGbp).replace(/[£,\s]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [retainerMoniesOnAccountGbp]);

  const matterCostsCompletion = useMemo(() => {
    const hasBasis = Boolean(costWorkBasis);
    const hasEstimate =
      numericFeeEstimateGbp != null ||
      (costWorkBasis === 'capped' && numericAgreedCapGbp != null);
    const hasPoaChoice =
      paymentOnAccountRequired === 'Yes' || paymentOnAccountRequired === 'No';
    const doneCount =
      (hasBasis ? 1 : 0) + (hasEstimate ? 1 : 0) + (hasPoaChoice ? 1 : 0);
    return {
      doneCount,
      totalRequired: 3,
      remainingCount: 3 - doneCount,
      isComplete: doneCount === 3,
    };
  }, [
    costWorkBasis,
    numericFeeEstimateGbp,
    numericAgreedCapGbp,
    paymentOnAccountRequired,
  ]);

  function buildMatterCostsSnapshotPayload(): MatterCostsSnapshot {
    const finalDisbursements = [...costDisbursements];
    if (newDisbursementDescription.trim()) {
      const pendingAmt = Number(newDisbursementAmount);
      finalDisbursements.push({
        id: `DISB-${Date.now()}`,
        description: newDisbursementDescription.trim(),
        amountGbp: Number.isFinite(pendingAmt) && pendingAmt >= 0 ? pendingAmt : 0,
        vatApplicable: newDisbursementVat,
      });
    }
    const disbTotal = calculateDisbursementsTotal(finalDisbursements);
    return {
      workBasis: costWorkBasis,
      rateCardId: selectedRateCard?.id ?? costRateCardId ?? 'RC-DEFAULT',
      rateCardName: selectedRateCard?.name ?? 'Firm Standard Rates',
      rateSource: costRateSource,
      partnerRateGbp: Number(partnerRateGbp) || 375,
      associateRateGbp: Number(associateRateGbp) || 265,
      traineeRateGbp: Number(traineeRateGbp) || 150,
      customGrades: customGradeRates,
      totalEstimateGbp: numericFeeEstimateGbp,
      agreedCapGbp: costWorkBasis === 'capped' ? numericAgreedCapGbp : null,
      disbursements: finalDisbursements,
      disbursementsTotalGbp: disbTotal,
      paymentOnAccountRequired,
      paymentOnAccountAmountGbp:
        paymentOnAccountRequired === 'Yes' ? numericPoaAmountGbp : null,
      notes: costNotes.trim() || undefined,
      updatedAt: new Date().toISOString(),
    };
  }

  // 2 · MATTER RISK ASSESSMENT state
  const [riskAnswers, setRiskAnswers] = useState<Record<string, string>>(() => {
    const saved = existing?.fieldValues?.['riskAssessment'] as
      | { answers?: Record<string, string> }
      | undefined;
    if (saved?.answers && typeof saved.answers === 'object') {
      return { ...saved.answers };
    }
    if (initialEnquiry) {
      const prefilled: Record<string, string> = {};
      if (initialEnquiry.keyDate) {
        prefilled.imminentDeadlines = 'Yes';
      }
      const spokeInPerson = initialEnquiry.contactLog?.some(
        (c) => c.method === 'In person' && c.outcome === 'Spoke',
      );
      const spokeVideo = initialEnquiry.contactLog?.some(
        (c) => c.method === 'Video call' && c.outcome === 'Spoke',
      );
      if (spokeInPerson) {
        prefilled.clientDealingMethod = 'Met in person';
      } else if (spokeVideo) {
        prefilled.clientDealingMethod = 'Video call with ID check';
      } else {
        prefilled.clientDealingMethod = 'Remote only or via introducer';
      }
      return prefilled;
    }
    return {};
  });
  const [riskFollowUps, setRiskFollowUps] = useState<Record<string, string>>(() => {
    const saved = existing?.fieldValues?.['riskAssessment'] as
      | { followUps?: Record<string, string> }
      | undefined;
    if (saved?.followUps && typeof saved.followUps === 'object') {
      return { ...saved.followUps };
    }
    return {};
  });
  const [expandedRiskSectionIds, setExpandedRiskSectionIds] = useState<string[]>([
    'about_instruction',
  ]);
  const [riskListView, setRiskListView] = useState<boolean>(false);
  const [customKeyDates, setCustomKeyDates] = useState<CustomKeyDateEntry[]>(() => {
    const saved = existing?.fieldValues?.['customKeyDates'];
    if (Array.isArray(saved)) {
      return saved.filter(
        (d): d is CustomKeyDateEntry =>
          Boolean(d && typeof d === 'object' && typeof d.date === 'string'),
      );
    }
    if (initialEnquiry?.keyDate) {
      return [
        {
          id: `RISK-DATE-ENQ-${initialEnquiry.id}`,
          date: initialEnquiry.keyDate,
          label: initialEnquiry.keyDateLabel?.trim() || 'Enquiry key date / deadline',
        },
      ];
    }
    return [];
  });
  const [newKeyDateValue, setNewKeyDateValue] = useState<string>('');
  const [newKeyDateLabel, setNewKeyDateLabel] = useState<string>('');

  function toggleRiskSectionExpanded(sectionId: string) {
    setExpandedRiskSectionIds((prev) =>
      prev.includes(sectionId) ? prev.filter((id) => id !== sectionId) : [...prev, sectionId],
    );
  }

  function handleAddCustomKeyDate() {
    const dVal = newKeyDateValue.trim();
    if (!dVal) return;
    const lblVal = newKeyDateLabel.trim() || 'Imminent deadline / key date';
    const entry: CustomKeyDateEntry = {
      id: `RISK-DATE-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      date: dVal,
      label: lblVal,
    };
    setCustomKeyDates((prev) =>
      [...prev, entry].sort((a, b) => a.date.localeCompare(b.date)),
    );
    setNewKeyDateValue('');
    setNewKeyDateLabel('');
  }

  function handleRemoveCustomKeyDate(id: string) {
    setCustomKeyDates((prev) => prev.filter((d) => d.id !== id));
  }

  const practiceAreaVal = useMemo(
    () => values.find((v) => v.id === practiceAreaId),
    [values, practiceAreaId],
  );

  // Acceptable client money threshold (£) for the selected work type (or parent practice area)
  const workTypeClientMoneyThresholdGbp = useMemo(() => {
    const raw =
      subcategoryVal?.meta?.clientMoneyThresholdGbp ??
      practiceAreaVal?.meta?.clientMoneyThresholdGbp ??
      '100000';
    const num = Number(raw);
    return Number.isFinite(num) && num >= 0 ? num : 100000;
  }, [subcategoryVal, practiceAreaVal]);

  // Pre-fill Q1.1 (Is this work in scope of the Money Laundering Regulations?) and Q6.1 (Fee basis) when work type changes
  const prevWorkTypeKeyRef = useRef<string>(
    `${existing?.practiceAreaId ?? ''}__${existing?.workTypeSubcategoryId ?? ''}`,
  );
  useEffect(() => {
    const currentKey = `${practiceAreaId}__${workTypeSubcategoryId}`;
    const isInitialMount = prevWorkTypeKeyRef.current === currentKey;
    prevWorkTypeKeyRef.current = currentKey;

    if (!workTypeSubcategoryId && !practiceAreaId) return;
    const amlScopeMeta =
      subcategoryVal?.meta?.amlInScope ?? practiceAreaVal?.meta?.amlInScope;
    if (amlScopeMeta !== undefined) {
      const nextMlrAnswer =
        amlScopeMeta === 'false' ? 'No, out of scope' : 'Yes, in scope';
      setRiskAnswers((prev) => {
        if (isInitialMount && prev.inScopeMlr) return prev;
        if (prev.inScopeMlr === nextMlrAnswer) return prev;
        return { ...prev, inScopeMlr: nextMlrAnswer };
      });
    }

    const bbId =
      subcategoryVal?.meta?.billingBasisId ??
      practiceAreaVal?.meta?.billingBasisId ??
      billingBasisId;
    if (bbId) {
      const bbLabel = resolveLabel(values, bbId).toLowerCase();
      let mappedFeeBasis = '';
      if (bbLabel.includes('fixed')) mappedFeeBasis = 'Fixed fee';
      else if (bbLabel.includes('hourly')) mappedFeeBasis = 'Hourly';
      else if (bbLabel.includes('conditional') || bbLabel.includes('damages') || bbLabel.includes('cfa') || bbLabel.includes('dba'))
        mappedFeeBasis = 'CFA or DBA';
      else if (bbLabel) mappedFeeBasis = 'Other';
      if (mappedFeeBasis) {
        setRiskAnswers((prev) => {
          if (prev.feeBasis) return prev;
          return { ...prev, feeBasis: mappedFeeBasis };
        });
      }
    }
  }, [
    practiceAreaId,
    workTypeSubcategoryId,
    subcategoryVal,
    practiceAreaVal,
    billingBasisId,
    values,
  ]);

  // Lookup client relationship & CDD status for Q2.1 (Is this a new or existing client?)
  const derivedClientRelationshipCdd = useMemo<{
    option: 'New client' | 'Existing, CDD current' | 'Existing, CDD needs refresh' | '';
    summary: string;
  }>(() => {
    if (clientIds.length === 0) {
      return { option: '', summary: '' };
    }

    let anyHasPriorMatters = false;
    let allCddCurrent = true;
    const details: string[] = [];

    for (const cid of clientIds) {
      const priorMatters = matters.filter(
        (m) =>
          m.id !== existing?.id &&
          m.conflictCheckStatus !== 'Draft' &&
          (m.clientId === cid || m.additionalClientIds?.includes(cid)),
      );
      if (priorMatters.length > 0) {
        anyHasPriorMatters = true;
      }

      if (cid.startsWith('O-')) {
        const org = organisations.find((o) => o.id === cid);
        if (!org) continue;
        const verLabel = resolveLabel(values, org.verificationStatusId).toLowerCase();
        const relLabel = resolveLabel(values, org.relationshipStatusId).toLowerCase();
        if (relLabel.includes('active') || relLabel.includes('existing')) {
          anyHasPriorMatters = true;
        }
        const reviewExpired = Boolean(org.reviewDate && org.reviewDate < today);
        const hasVerifiedMatter = priorMatters.some((m) => m.amlStatus === 'Verified');
        const hasIncompleteMatter = priorMatters.some(
          (m) => m.amlStatus === 'Pending' || m.amlStatus === 'CMI incomplete',
        );
        const isCurrent =
          (verLabel.includes('verified') || verLabel.includes('complete') || hasVerifiedMatter) &&
          !verLabel.includes('expired') &&
          !verLabel.includes('pending') &&
          !verLabel.includes('refresh') &&
          !reviewExpired &&
          !hasIncompleteMatter;
        if (!isCurrent) {
          allCddCurrent = false;
          details.push(
            `${org.legalName}: ${
              reviewExpired
                ? `CDD review date expired (${org.reviewDate})`
                : verLabel
                  ? `CDD ${resolveLabel(values, org.verificationStatusId)}`
                  : 'CDD verification not current'
            }`,
          );
        } else {
          details.push(
            `${org.legalName}: CDD verified${
              org.reviewDate ? ` (review due ${org.reviewDate})` : ''
            }`,
          );
        }
      } else {
        const person = people.find((p) => p.id === cid);
        if (!person) continue;
        const verLabel = resolveLabel(values, person.verificationStatusId).toLowerCase();
        const relLabel = resolveLabel(values, person.relationshipStatusId).toLowerCase();
        if (relLabel.includes('active') || relLabel.includes('existing')) {
          anyHasPriorMatters = true;
        }
        const hasVerifiedMatter = priorMatters.some((m) => m.amlStatus === 'Verified');
        const hasIncompleteMatter = priorMatters.some(
          (m) => m.amlStatus === 'Pending' || m.amlStatus === 'CMI incomplete',
        );
        const isCurrent =
          (verLabel.includes('verified') || verLabel.includes('complete') || hasVerifiedMatter) &&
          !verLabel.includes('expired') &&
          !verLabel.includes('pending') &&
          !verLabel.includes('refresh') &&
          !hasIncompleteMatter;
        if (!isCurrent) {
          allCddCurrent = false;
          details.push(
            `${personDisplayName(person)}: ${
              verLabel
                ? `CDD ${resolveLabel(values, person.verificationStatusId)}`
                : 'CDD verification not current'
            }`,
          );
        } else {
          details.push(
            `${personDisplayName(person)}: CDD verified${
              person.verifiedAt ? ` (${person.verifiedAt})` : ''
            }`,
          );
        }
      }
    }

    if (!anyHasPriorMatters) {
      return {
        option: 'New client',
        summary: 'Pre-filled from client record (no prior matters)',
      };
    }
    if (allCddCurrent) {
      return {
        option: 'Existing, CDD current',
        summary: `Pre-filled from client record (${details.join('; ')})`,
      };
    }
    return {
      option: 'Existing, CDD needs refresh',
      summary: `Pre-filled from client record (${details.join('; ')})`,
    };
  }, [clientIds, matters, existing?.id, organisations, people, values, today]);

  // Pre-fill Q2.1 when clientIds change
  const prevClientsKeyRef = useRef<string>(clientIds.join(','));
  useEffect(() => {
    const nextKey = clientIds.join(',');
    const changed = prevClientsKeyRef.current !== nextKey;
    prevClientsKeyRef.current = nextKey;

    if (!derivedClientRelationshipCdd.option) return;
    setRiskAnswers((prev) => {
      if (!changed && prev.clientRelationshipStatus) return prev;
      if (prev.clientRelationshipStatus === derivedClientRelationshipCdd.option) return prev;
      return {
        ...prev,
        clientRelationshipStatus: derivedClientRelationshipCdd.option,
      };
    });
  }, [clientIds, derivedClientRelationshipCdd.option]);

  // Compute active risk sections, per-section completion counts, per-section risk, and overall risk via shared builder
  const riskAssessmentSummary = useMemo(
    () =>
      summarizeMatterRiskAssessment({
        answers: riskAnswers,
        followUps: riskFollowUps,
        customKeyDates,
        completedById: currentUser.id,
        completedByName: personDisplayName(currentUser),
        leadFeeEarnerId: leadFeeEarnerId || null,
        leadFeeEarnerName: leadFeeEarnerId
          ? people.find((p) => p.id === leadFeeEarnerId)
            ? personDisplayName(people.find((p) => p.id === leadFeeEarnerId)!)
            : leadFeeEarnerId
          : null,
      }),
    [riskAnswers, riskFollowUps, customKeyDates, leadFeeEarnerId, currentUser, people],
  );

  // Sync calculated overall risk level to riskRatingId
  useEffect(() => {
    if (!riskAssessmentSummary.overallRisk) return;
    const targetLabel = riskAssessmentSummary.overallRisk.toLowerCase();
    const matchVal = values.find(
      (v) =>
        v.listKey === 'risk_rating' &&
        v.active &&
        v.label.toLowerCase().startsWith(targetLabel),
    );
    if (matchVal && matchVal.id !== riskRatingId) {
      queueMicrotask(() => {
        setRiskRatingId(matchVal.id);
      });
    }
  }, [riskAssessmentSummary.overallRisk, values, riskRatingId]);

  // Progress / Stage state (0-indexed: Stage 1 = 0 .. Stage 6 = 5)
  const [stageIdx, setStageIdx] = useState<number>(() => {
    if (existing?.stageId) {
      const lbl = resolveLabel(values, existing.stageId);
      const m = lbl.match(/Stage\s+(\d+)/i);
      if (m) return Math.min(6, Math.max(1, Number(m[1]))) - 1;
    }
    return isEditingExistingMatter ? 3 : 0;
  });

  const stageSteps = useMemo(() => {
    return [
      { name: 'Intake', meta: 'Done' },
      { name: 'Matter opening', meta: 'Completed' },
      { name: 'Due diligence', meta: 'Completed' },
      { name: 'Drafting & negotiation', meta: 'Current' },
      { name: 'Execution / completion', meta: 'Upcoming' },
      { name: 'Close', meta: '—' },
    ];
  }, []);

  // Matter facts state (Client ref, Claim value, Responsible office, Source of work)
  const [clientReference, setClientReference] = useState<string>(
    () => ((existing?.fieldValues?.['CORE-005'] as string) ?? '').trim(),
  );
  const [claimValue, setClaimValue] = useState<string>(() => {
    const savedClaim = ((existing?.fieldValues?.['claimValue'] as string) ?? '').trim();
    if (savedClaim) return savedClaim;
    if (existing?.matterSizeId) {
      return resolveLabel(values, existing.matterSizeId);
    }
    return '';
  });
  const [responsibleOffice, setResponsibleOffice] = useState<string>(() => {
    const savedOffice = ((existing?.fieldValues?.['responsibleOffice'] as string) ?? '').trim();
    if (savedOffice) return savedOffice;
    return '';
  });
  const [sourceOfWork, setSourceOfWork] = useState<string>(() => {
    const savedSource = ((existing?.fieldValues?.['sourceOfWork'] as string) ?? '').trim();
    if (savedSource) return savedSource;
    if (existing?.referrerTypeId) {
      return resolveLabel(values, existing.referrerTypeId) || 'Existing client';
    }
    if (initialEnquiry?.sourceId) {
      return resolveLabel(values, initialEnquiry.sourceId) || 'Existing client';
    }
    return 'Existing client';
  });

  // Draft / Referred / Reviewer mode states
  const [reopenedDraftBanner, setReopenedDraftBanner] = useState<string | null>(
    isReopenedDraft
      ? existing?.conflictCheckRecord?.savedDraftAtDisplay || formatDateTime(new Date().toISOString())
      : null,
  );
  const [workflowState, setWorkflowState] = useState<
    'editing' | 'referred_readonly' | 'approved' | 'declined'
  >(() => {
    if (existing?.conflictCheckRecord?.status === 'Referred') return 'referred_readonly';
    if (existing?.conflictCheckRecord?.status === 'Approved') return 'approved';
    if (existing?.conflictCheckRecord?.status === 'Declined') return 'declined';
    return 'editing';
  });
  const [isReviewerMode, setIsReviewerMode] = useState<boolean>(
    activeViewingRole === 'risk_compliance',
  );
  const [comments, setComments] = useState<ConflictReviewerComment[]>(
    existing?.conflictCheckRecord?.comments ?? [],
  );
  const [newCommentText, setNewCommentText] = useState('');
  const [saving, setSaving] = useState(false);

  // AI Document & Email Extraction state
  const [aiPanelOpen, setAiPanelOpen] = useState<boolean>(false);
  const [stagedDocs, setStagedDocs] = useState<IntakeSourceDocument[]>([]);
  const [isDraggingFiles, setIsDraggingFiles] = useState<boolean>(false);
  const [showPasteInput, setShowPasteInput] = useState<boolean>(false);
  const [pastedDocName, setPastedDocName] = useState<string>('');
  const [pastedDocContent, setPastedDocContent] = useState<string>('');
  const [previewDocId, setPreviewDocId] = useState<string | null>(null);
  const [extractingAi, setExtractingAi] = useState<boolean>(false);
  const [aiExtractionResult, setAiExtractionResult] =
    useState<MatterAiExtractionResult | null>(null);
  const [selectedAiMatterIdx, setSelectedAiMatterIdx] = useState<number>(0);
  const [showAiDetailedReport, setShowAiDetailedReport] = useState<boolean>(true);
  const [aiErrorMsg, setAiErrorMsg] = useState<string | null>(null);
  const [aiCitations, setAiCitations] = useState<
    Record<string, { sourceDoc: string; quote: string; confidence: string }>
  >({});
  const fileUploadInputRef = useRef<HTMLInputElement | null>(null);
  const folderUploadInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    try {
      window.localStorage.removeItem('onesquared_claude_api_key');
    } catch {
      // Ignore storage errors
    }
  }, []);

  const SUPPORTED_INTAKE_EXTENSIONS = [
    '.eml',
    '.msg',
    '.txt',
    '.md',
    '.pdf',
    '.doc',
    '.docx',
    '.rtf',
    '.csv',
    '.html',
  ];

  async function readDroppedEntries(
    items: DataTransferItemList,
  ): Promise<File[]> {
    const collected: File[] = [];

    async function traverseEntry(entry: FileSystemEntry): Promise<void> {
      if (entry.isFile) {
        const fileEntry = entry as FileSystemFileEntry;
        const file = await new Promise<File | null>((resolve) => {
          fileEntry.file(
            (f) => resolve(f),
            () => resolve(null),
          );
        });
        if (file) {
          collected.push(file);
        }
      } else if (entry.isDirectory) {
        const dirEntry = entry as FileSystemDirectoryEntry;
        const reader = dirEntry.createReader();
        const readBatch = (): Promise<FileSystemEntry[]> =>
          new Promise((resolve) => {
            reader.readEntries(
              (entries) => resolve(entries),
              () => resolve([]),
            );
          });
        let batch = await readBatch();
        while (batch.length > 0) {
          for (const child of batch) {
            await traverseEntry(child);
          }
          batch = await readBatch();
        }
      }
    }

    const entries: FileSystemEntry[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const entry =
          typeof item.webkitGetAsEntry === 'function'
            ? item.webkitGetAsEntry()
            : null;
        if (entry) {
          entries.push(entry);
        }
      }
    }

    if (entries.length === 0) return [];

    for (const entry of entries) {
      await traverseEntry(entry);
    }
    return collected;
  }

  async function processUploadedFiles(fileList: FileList | File[]) {
    const rawFiles = Array.from(fileList);
    if (rawFiles.length === 0) return;
    const loaded: IntakeSourceDocument[] = [];
    const skippedNames: string[] = [];

    for (const file of rawFiles) {
      const lowerName = file.name.toLowerCase();
      // Skip hidden/system/temp files (e.g. .DS_Store, Thumbs.db, desktop.ini, ~$ Word lock files)
      if (
        file.name.startsWith('.') ||
        file.name.startsWith('~$') ||
        lowerName === 'thumbs.db' ||
        lowerName === 'desktop.ini'
      ) {
        continue;
      }

      const hasSupportedExt = SUPPORTED_INTAKE_EXTENSIONS.some((ext) =>
        lowerName.endsWith(ext),
      );
      if (!hasSupportedExt) {
        continue;
      }

      try {
        const kind: IntakeSourceDocument['kind'] =
          lowerName.endsWith('.eml') || lowerName.endsWith('.msg') ? 'email' : 'document';
        const sizeKb = Math.max(1, Math.round(file.size / 1024));
        const sizeLabel = `${sizeKb} KB`;

        const arrayBuf = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuf);
        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < bytes.byteLength; i += chunkSize) {
          const sub = bytes.subarray(i, i + chunkSize);
          binary += String.fromCharCode(...Array.from(sub));
        }
        const base64Data = typeof btoa !== 'undefined' ? btoa(binary) : '';

        const isBinaryFormat =
          lowerName.endsWith('.pdf') ||
          lowerName.endsWith('.docx') ||
          lowerName.endsWith('.doc') ||
          lowerName.endsWith('.msg');

        const textPreview = isBinaryFormat
          ? `[Binary ${lowerName.split('.').pop()?.toUpperCase()} file: ${file.name} (${sizeLabel}) — parsed on server during extraction]`
          : new TextDecoder('utf-8', { fatal: false }).decode(bytes);

        loaded.push({
          id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: file.name,
          kind,
          mimeType: file.type || 'application/octet-stream',
          sizeLabel,
          content: textPreview,
          base64Data,
        });
      } catch (err) {
        console.warn(`Skipped unreadable file or directory "${file.name}":`, err);
        skippedNames.push(file.name);
      }
    }

    if (loaded.length > 0) {
      setStagedDocs((prev) => [...prev, ...loaded]);
      setAiErrorMsg(null);
    } else if (skippedNames.length > 0) {
      setAiErrorMsg(
        `Could not read ${skippedNames.join(', ')}. If you are uploading a folder or cloud-synced files (e.g. OneDrive), use "Select folder" or ensure the files are downloaded locally.`,
      );
    }
  }

  async function handleFileUploadChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      const filesCopy = Array.from(e.target.files);
      e.target.value = '';
      await processUploadedFiles(filesCopy);
    }
  }

  function handleAddPastedDocument() {
    if (!pastedDocContent.trim()) return;
    const name =
      pastedDocName.trim() || `Pasted Email / Note (${stagedDocs.length + 1}).eml`;
    const newDoc: IntakeSourceDocument = {
      id: `paste-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      kind: name.toLowerCase().endsWith('.eml') ? 'email' : 'note',
      sizeLabel: `${Math.max(1, Math.round(pastedDocContent.length / 1024))} KB`,
      content: pastedDocContent.trim(),
    };
    setStagedDocs((prev) => [...prev, newDoc]);
    setPastedDocName('');
    setPastedDocContent('');
    setShowPasteInput(false);
    setAiErrorMsg(null);
  }

  function applyAiExtractionToForm(res: MatterAiExtractionResult, matterIdx = 0) {
    setSelectedAiMatterIdx(matterIdx);
    const activeMatter = res.matters?.[matterIdx];
    const mTitle = activeMatter ? activeMatter.title : res.title;
    const mPracticeArea = activeMatter ? activeMatter.practiceArea : res.practiceArea;
    const mWorkType = activeMatter ? activeMatter.workType : res.workType;
    const mRespPartner = activeMatter
      ? activeMatter.responsiblePartner
      : res.responsiblePartner;
    const mLeadFe = activeMatter ? activeMatter.leadFeeEarner : res.leadFeeEarner;
    const mRisks = activeMatter ? activeMatter.riskSuggestions : res.riskSuggestions;
    const mKeyDates = activeMatter ? activeMatter.keyDates : res.keyDates;
    const mClientCap = activeMatter
      ? activeMatter.clientCapacityCode
      : res.clientCapacityCode;
    const mOtherParties = activeMatter ? activeMatter.otherParties : res.otherParties;
    const mShortDesc = activeMatter
      ? activeMatter.shortDescription
      : res.shortDescription;
    const mFeeEst = activeMatter ? activeMatter.feeEstimateGbp : res.feeEstimateGbp;
    const mFeeCap = activeMatter ? activeMatter.agreedFeeCapGbp : res.agreedFeeCapGbp;
    const mMoa = activeMatter
      ? activeMatter.retainerMoniesOnAccountGbp
      : res.retainerMoniesOnAccountGbp;
    const mTargetDate = activeMatter
      ? activeMatter.targetCompletionAt
      : res.targetCompletionAt;
    const mClientRef = activeMatter ? activeMatter.clientReference : res.clientReference;
    const mClaimVal = activeMatter ? activeMatter.claimValue : res.claimValue;
    const mForumCourt = activeMatter ? activeMatter.forumCourt : res.forumCourt;

    const nextCitations: Record<
      string,
      { sourceDoc: string; quote: string; confidence: string }
    > = {};

    // 1. Section 1: Matter Details & Team
    if (mPracticeArea?.matchedId) {
      setPracticeAreaId(mPracticeArea.matchedId);
      nextCitations['practiceArea'] = {
        sourceDoc: mPracticeArea.sourceDoc,
        quote: mPracticeArea.quote,
        confidence: mPracticeArea.confidence,
      };
    }
    if (mWorkType?.matchedId) {
      setWorkTypeSubcategoryId(mWorkType.matchedId);
      nextCitations['workType'] = {
        sourceDoc: mWorkType.sourceDoc,
        quote: mWorkType.quote,
        confidence: mWorkType.confidence,
      };
    }
    if (res.client?.matchedRecordId) {
      setClientIds([res.client.matchedRecordId]);
      nextCitations['client'] = {
        sourceDoc: res.client.sourceDoc,
        quote: res.client.quote,
        confidence: res.client.confidence,
      };
    }
    if (res.instructingContact?.matchedPersonId) {
      setInstructingContactId(res.instructingContact.matchedPersonId);
      nextCitations['instructingContact'] = {
        sourceDoc: res.instructingContact.sourceDoc,
        quote: res.instructingContact.quote,
        confidence: res.instructingContact.confidence,
      };
    }
    if (res.billingContact?.matchedPersonId) {
      setBillingContactId(res.billingContact.matchedPersonId);
    }
    if (mTitle?.value) {
      setTitle(mTitle.value);
      nextCitations['title'] = {
        sourceDoc: mTitle.sourceDoc,
        quote: mTitle.quote,
        confidence: mTitle.confidence,
      };
    }
    if (mRespPartner?.matchedPersonId) {
      setResponsiblePartnerId(mRespPartner.matchedPersonId);
      setSupervisingPartnerId(mRespPartner.matchedPersonId);
      nextCitations['responsiblePartner'] = {
        sourceDoc: mRespPartner.sourceDoc,
        quote: mRespPartner.quote,
        confidence: 'high',
      };
    }
    if (mLeadFe?.matchedPersonId) {
      setLeadFeeEarnerId(mLeadFe.matchedPersonId);
      nextCitations['leadFeeEarner'] = {
        sourceDoc: mLeadFe.sourceDoc,
        quote: mLeadFe.quote,
        confidence: 'high',
      };
    }

    // 2. Section 2: Matter Risk Assessment
    if (mRisks.length > 0) {
      const nextAnswers: Record<string, string> = {};
      const nextFollowUps: Record<string, string> = {};
      for (const s of mRisks) {
        nextAnswers[s.questionId] = s.answer;
        if (s.followUp) {
          nextFollowUps[s.questionId] = s.followUp;
        }
        nextCitations[`risk.${s.questionId}`] = {
          sourceDoc: s.sourceDoc,
          quote: s.quote,
          confidence: s.confidence,
        };
      }
      queueMicrotask(() => {
        setRiskAnswers(nextAnswers);
        setRiskFollowUps(nextFollowUps);
        setExpandedRiskSectionIds(MATTER_RISK_SECTIONS.map((sec) => sec.id));
      });
    }

    if (mKeyDates.length > 0) {
      const extractedDates: CustomKeyDateEntry[] = mKeyDates.map((kd, idx) => ({
        id: `AI-DATE-${Date.now()}-${idx}`,
        label: kd.label,
        date: kd.date,
      }));
      setCustomKeyDates(
        extractedDates.sort((a, b) => a.date.localeCompare(b.date)),
      );
    } else {
      setCustomKeyDates([]);
    }

    // 3. Section 3: Matter Parties
    if (mClientCap?.value) {
      setClientCapacityCodes([mClientCap.value]);
    }
    if (mOtherParties.length > 0) {
      const builtParties: ConflictCheckParty[] = mOtherParties.map((pt, idx) => {
        const legacyRole = mapRelationshipToLegacyConflictRole(pt.relationshipCode);
        const identifiers: MatterPartyIdentifiers =
          pt.entityType === 'organisation'
            ? {
                companyNumber: pt.companyNumber,
                registeredTown: pt.town,
              }
            : {
                town: pt.town,
              };
        const detailParts = [
          pt.roleDescription,
          pt.contactDetails,
          pt.address,
          formatIdentifiersSummary(pt.entityType, identifiers),
        ].filter(Boolean);
        return {
          id: `ai-party-${Date.now()}-${idx}`,
          name: pt.matchedRecordName || pt.name,
          entityType: pt.entityType,
          role: legacyRole,
          relationshipCode: pt.relationshipCode,
          capacityCodes: pt.capacityCodes,
          connectedToPartyId: null,
          identifiers,
          alignment: getRelationshipAlignment(pt.relationshipCode),
          linkedRecordId: pt.matchedRecordId ?? null,
          subtitle:
            detailParts.join(' · ') ||
            formatPartyRoleDisplay(
              taxonomy,
              pt.relationshipCode,
              pt.capacityCodes,
              legacyRole,
            ),
        };
      });

      // Resolve connectedToPartyName to connectedToPartyId (e.g. opposing solicitor linked to opposing party)
      for (let i = 0; i < mOtherParties.length; i++) {
        const connName = mOtherParties[i]?.connectedToPartyName;
        if (connName && typeof connName === 'string') {
          const target = builtParties.find(
            (bp) =>
              bp.name &&
              (bp.name.toLowerCase().includes(connName.toLowerCase()) ||
                connName.toLowerCase().includes(bp.name.toLowerCase())),
          );
          if (target) {
            builtParties[i].connectedToPartyId = target.id;
          }
        }
      }

      setOtherParties(builtParties);
      setPartiesChangedSinceSearch(true);
    }

    // 4. Section 6: More Details
    if (mShortDesc?.value) {
      setShortDescription(mShortDesc.value);
      nextCitations['shortDescription'] = {
        sourceDoc: mShortDesc.sourceDoc,
        quote: mShortDesc.quote,
        confidence: mShortDesc.confidence,
      };
    }
    if (res.billing?.billingBasis) {
      const q = res.billing.billingBasis.toLowerCase();
      const matchedBb = values.find(
        (v) =>
          v.listKey === 'billing_basis' &&
          v.active &&
          (v.label.toLowerCase().includes(q) || q.includes(v.label.toLowerCase())),
      );
      if (matchedBb) {
        setBillingBasisId(matchedBb.id);
      }
      const mappedBasis = mapBillingBasisLabelToWorkBasis(res.billing.billingBasis);
      setCostWorkBasis(mappedBasis);
    } else if (mFeeCap?.value) {
      setCostWorkBasis('capped');
    } else if (mFeeEst?.value) {
      setCostWorkBasis('hourly_rates');
    }
    if (res.client?.existingClientNote) {
      setSourceOfWork(`Existing client — ${res.client.existingClientNote}`);
    }
    setFeeEstimateGbp(mFeeEst?.value || '');
    setAgreedFeeCapGbp(mFeeCap?.value || '');
    setRetainerMoniesOnAccountGbp(mMoa?.value || '');
    if (mMoa?.value && Number(mMoa.value) > 0) {
      setPaymentOnAccountRequired('Yes');
    } else if (
      mRisks.some(
        (r) =>
          r.questionId === 'moneyOnAccountRequested' &&
          r.answer.toLowerCase().startsWith('no'),
      )
    ) {
      setPaymentOnAccountRequired('No');
    } else if (
      mRisks.some(
        (r) =>
          r.questionId === 'moneyOnAccountRequested' &&
          r.answer.toLowerCase().startsWith('yes'),
      )
    ) {
      setPaymentOnAccountRequired('Yes');
    }
    setTargetCompletionAt(mTargetDate?.value || null);
    setClientReference(mClientRef?.value || '');
    setClaimValue(mClaimVal?.value || '');
    setForumCourt(mForumCourt?.value || '');

    setAiCitations(nextCitations);
    setSection1Open(true);
    setSectionCostsOpen(true);
  }

  async function handleRunAiExtraction(docsToExtract?: IntakeSourceDocument[]) {
    const docs = docsToExtract ?? stagedDocs;
    if (docs.length === 0) {
      showToast('Please upload files or paste an email first');
      return;
    }
    setExtractingAi(true);
    setAiErrorMsg(null);
    try {
      const response = await fetch('/api/matters/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documents: docs,
        }),
      });
      const data = (await response.json()) as {
        extraction?: MatterAiExtractionResult;
        organisations?: Organisation[];
        people?: Person[];
        links?: PersonOrganisationLink[];
        error?: string;
      };
      if (!response.ok || !data.extraction) {
        throw new Error(data.error || 'Could not extract matter data');
      }
      if (data.organisations?.length) {
        setOrganisations((prev) => {
          const byId = new Map(prev.map((o) => [o.id, o]));
          for (const o of data.organisations!) byId.set(o.id, o);
          return Array.from(byId.values());
        });
      }
      if (data.people?.length) {
        setPeople((prev) => {
          const byId = new Map(prev.map((p) => [p.id, p]));
          for (const p of data.people!) byId.set(p.id, p);
          return Array.from(byId.values());
        });
      }
      if (data.links?.length) {
        setLinks((prev) => {
          const byId = new Map(prev.map((l) => [l.id, l]));
          for (const l of data.links!) byId.set(l.id, l);
          return Array.from(byId.values());
        });
      }
      setAiExtractionResult(data.extraction);
      applyAiExtractionToForm(data.extraction, 0);
      const mattersCount = data.extraction.matters?.length || 1;
      showToast(
        `Extracted ${mattersCount} matter${mattersCount === 1 ? '' : 's'}, ${data.extraction.otherParties.length} conflict parties, and ${data.extraction.riskSuggestions.length} risk answers from ${docs.length} document${docs.length === 1 ? '' : 's'}`,
      );
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Failed to extract from documents';
      setAiErrorMsg(msg);
      showToast(msg);
    } finally {
      setExtractingAi(false);
    }
  }

  // Sync Reviewer mode when top bar "Viewing as" changes to Risk / Compliance
  useEffect(() => {
    queueMicrotask(() => {
      if (activeViewingRole === 'risk_compliance') {
        setIsReviewerMode(true);
      } else {
        setIsReviewerMode(false);
      }
    });
  }, [activeViewingRole]);

  // Origin screen information for the "← Back to ..." link and Cancel button
  const [referrerInfo, setReferrerInfo] = useState<{ label: string; href: string } | null>(
    null,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !document.referrer) return;
    try {
      const refUrl = new URL(document.referrer);
      if (refUrl.origin !== window.location.origin) return;
      const p = refUrl.pathname;
      let nextInfo: { label: string; href: string } | null = null;
      if (p.startsWith('/people/')) {
        const pid = p.split('/')[2];
        const found = people.find((x) => x.id === pid);
        nextInfo = found
          ? { label: personDisplayName(found), href: p }
          : { label: 'People', href: '/people' };
      } else if (p.startsWith('/organisations/')) {
        const oid = p.split('/')[2];
        const found = organisations.find((x) => x.id === oid);
        nextInfo = found
          ? { label: found.legalName, href: p }
          : { label: 'Organisations', href: '/organisations' };
      } else if (p.startsWith('/enquiries/')) {
        nextInfo = { label: 'Enquiry', href: p };
      } else if (p.startsWith('/matters/')) {
        nextInfo = { label: 'Matters', href: '/matters' };
      } else if (p === '/people') {
        nextInfo = { label: 'People', href: '/people' };
      } else if (p === '/organisations') {
        nextInfo = { label: 'Organisations', href: '/organisations' };
      } else if (p === '/matters') {
        nextInfo = { label: 'Matters', href: '/matters' };
      } else if (p === '/tasks') {
        nextInfo = { label: 'Tasks', href: '/tasks' };
      } else if (p === '/') {
        nextInfo = { label: 'Home', href: '/' };
      }
      if (nextInfo) {
        queueMicrotask(() => {
          setReferrerInfo(nextInfo);
        });
      }
    } catch {
      // ignore invalid referrer URL
    }
  }, [people, organisations]);

  const backTarget = useMemo<{ label: string; href: string | null }>(() => {
    if (existing && isEditingExistingMatter) {
      return {
        label: existing.matterNumber || existing.title || 'Matter',
        href: `/matters/${existing.id}`,
      };
    }
    if (existing && !isEditingExistingMatter) {
      return {
        label: 'Matters',
        href: '/matters',
      };
    }
    const originPersonId =
      initialInstructingContactId ||
      (initialClientId?.startsWith('P-') ? initialClientId : null);
    if (originPersonId) {
      const foundPerson = people.find((p) => p.id === originPersonId);
      if (foundPerson) {
        return {
          label: personDisplayName(foundPerson),
          href: `/people/${foundPerson.id}`,
        };
      }
    }
    if (initialClientId?.startsWith('O-')) {
      const foundOrg = organisations.find((o) => o.id === initialClientId);
      if (foundOrg) {
        return {
          label: foundOrg.legalName,
          href: `/organisations/${foundOrg.id}`,
        };
      }
    }
    if (initialEnquiry) {
      return {
        label: initialEnquiry.reference,
        href: `/enquiries/${initialEnquiry.id}`,
      };
    }
    if (referrerInfo) {
      return referrerInfo;
    }
    return { label: '', href: null };
  }, [
    existing,
    isEditingExistingMatter,
    initialInstructingContactId,
    initialClientId,
    initialEnquiry,
    people,
    organisations,
    referrerInfo,
  ]);

  const sessionDraftKey = useMemo(
    () =>
      `onesquared_matter_form_draft_${
        existing?.id || initialEnquiry?.id || initialQuote?.id || initialClientId || 'new'
      }`,
    [existing?.id, initialEnquiry?.id, initialQuote?.id, initialClientId],
  );

  const [leaveWarningModalOpen, setLeaveWarningModalOpen] = useState<boolean>(false);
  const [leaveWarningTargetHref, setLeaveWarningTargetHref] = useState<string | null>(null);
  const [restoredSessionDirty, setRestoredSessionDirty] = useState<boolean>(false);

  // Clear any legacy sessionStorage draft keys so cancelled/abandoned form details are never remembered
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const key = sessionStorage.key(i);
        if (key && key.startsWith('onesquared_matter_form_draft_')) {
          sessionStorage.removeItem(key);
        }
      }
    } catch {
      // ignore storage errors
    }
  }, [sessionDraftKey]);

  const currentFormStateSignature = useMemo(
    () =>
      JSON.stringify({
        clientIds,
        instructingContactId,
        billingContactId,
        title,
        shortDescription,
        practiceAreaId,
        workTypeSubcategoryId,
        responsiblePartnerId,
        leadFeeEarnerId,
        clientCapacityCodes,
        otherParties,
        riskAnswers,
        riskFollowUps,
        customKeyDates,
        matches,
        hasRunSearch,
        declarationConfirmed,
        feeEstimateGbp,
        agreedFeeCapGbp,
        retainerMoniesOnAccountGbp,
        clientReference,
        claimValue,
      }),
    [
      clientIds,
      instructingContactId,
      billingContactId,
      title,
      shortDescription,
      practiceAreaId,
      workTypeSubcategoryId,
      responsiblePartnerId,
      leadFeeEarnerId,
      clientCapacityCodes,
      otherParties,
      riskAnswers,
      riskFollowUps,
      customKeyDates,
      matches,
      hasRunSearch,
      declarationConfirmed,
      feeEstimateGbp,
      agreedFeeCapGbp,
      retainerMoniesOnAccountGbp,
      clientReference,
      claimValue,
    ],
  );

  const [initialSnapshot, setInitialSnapshot] = useState<string>(
    () => currentFormStateSignature,
  );

  const isFormModified =
    initialSnapshot !== currentFormStateSignature || restoredSessionDirty;

  const hasUnsavedChanges =
    workflowState === 'editing' &&
    !isReviewerMode &&
    (isFormModified || Boolean((initialEnquiry || initialQuote) && !existing));

  // Warn before browser tab close / reload if there are unsaved changes
  useEffect(() => {
    if (typeof window === 'undefined' || !hasUnsavedChanges || saving) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue =
        'You have unsaved matter details on this page. Leaving now could cause your entered data to be lost.';
      return e.returnValue;
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsavedChanges, saving]);

  // Intercept in-app link clicks (e.g. left-rail navigation) when there are unsaved changes
  useEffect(() => {
    if (typeof document === 'undefined' || !hasUnsavedChanges || saving) return;
    function onDocLinkClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      if (anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const rawHref = anchor.getAttribute('href') || '';
      if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) return;
      try {
        const nextUrl = new URL(anchor.href, window.location.origin);
        if (
          nextUrl.origin === window.location.origin &&
          nextUrl.pathname === window.location.pathname &&
          nextUrl.search === window.location.search
        ) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        setLeaveWarningTargetHref(`${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
        setLeaveWarningModalOpen(true);
      } catch {
        // ignore invalid href
      }
    }
    document.addEventListener('click', onDocLinkClick, true);
    return () => document.removeEventListener('click', onDocLinkClick, true);
  }, [hasUnsavedChanges, saving]);

  function performImmediateNavigate(targetHref?: string | null) {
    if (typeof window !== 'undefined') {
      try {
        sessionStorage.removeItem(sessionDraftKey);
      } catch {
        // ignore storage errors
      }
    }
    if (targetHref) {
      router.push(targetHref);
      return;
    }
    if (existing && !isEditingExistingMatter) {
      router.push('/matters');
      return;
    }
    if (backTarget.href) {
      router.push(backTarget.href);
      return;
    }
    router.push('/matters');
  }

  function handleNavigateBack(e?: React.MouseEvent) {
    if (e) e.preventDefault();
    if (hasUnsavedChanges && !saving) {
      setLeaveWarningTargetHref(
        existing && !isEditingExistingMatter ? '/matters' : backTarget.href,
      );
      setLeaveWarningModalOpen(true);
      return;
    }
    performImmediateNavigate(
      existing && !isEditingExistingMatter ? '/matters' : backTarget.href,
    );
  }

  // Helper to check what fields are missing to convert a Person or Organisation to a Client
  function getMissingClientFieldsForPerson(p: Person): string[] {
    const missing: string[] = [];
    if (!p.firstName?.trim()) missing.push('First name');
    if (!p.surname?.trim()) missing.push('Surname');
    if (!p.dateOfBirth?.trim()) missing.push('Date of birth');
    const hasEmail = p.emails.some((e) => e.address.trim().length > 0);
    const hasPhone = p.phones.some((ph) => ph.number.trim().length > 0);
    if (!hasEmail && !hasPhone) missing.push('Email or phone');
    return missing;
  }

  function getMissingClientFieldsForOrg(o: Organisation): string[] {
    const missing: string[] = [];
    if (!o.legalName?.trim()) missing.push('Legal name');
    if (!o.organisationTypeId) missing.push('Organisation type');
    if (!o.companyNumber?.trim()) missing.push('Company number');
    if (!o.registeredAddress?.line1?.trim() || !o.registeredAddress?.postcode?.trim()) {
      missing.push('Registered address');
    }
    return missing;
  }

  // Resolved Client & Instructing Contact objects
  const selectedClients = useMemo(() => {
    return clientIds
      .map((cid) => {
        if (cid.startsWith('O-')) {
          const org = organisations.find((o) => o.id === cid);
          if (!org) return null;
          const missingClientFields = getMissingClientFieldsForOrg(org);
          return {
            id: org.id,
            entityType: 'organisation' as const,
            name: org.legalName,
            organisationName: org.legalName,
            details: [
              org.companyNumber ? `Co. no. ${org.companyNumber}` : null,
              org.registeredAddress?.town ?? null,
              org.generalEmail || null,
            ]
              .filter(Boolean)
              .join(' · '),
            missingClientFields,
            org,
            person: null,
          };
        }
        const person = people.find((p) => p.id === cid);
        if (!person) return null;
        const primaryLink = links.find((l) => l.personId === person.id && l.isCurrent);
        const linkedOrg = primaryLink
          ? organisations.find((o) => o.id === primaryLink.organisationId)
          : null;
        const email =
          person.emails.find((e) => e.isPrimary)?.address ?? person.emails[0]?.address ?? null;
        const missingClientFields = getMissingClientFieldsForPerson(person);
        return {
          id: person.id,
          entityType: 'person' as const,
          name: personDisplayName(person),
          organisationName: linkedOrg?.legalName ?? '—',
          details: [
            person.jobTitle || null,
            email,
            person.addresses[0]?.town ?? null,
          ]
            .filter(Boolean)
            .join(' · '),
          missingClientFields,
          org: linkedOrg ?? null,
          person,
        };
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x));
  }, [clientIds, organisations, people, links]);

  const selectedClientOrg = useMemo(
    () => organisations.find((o) => o.id === clientId) ?? null,
    [organisations, clientId],
  );
  const selectedClientPerson = useMemo(
    () => people.find((p) => p.id === clientId) ?? null,
    [people, clientId],
  );
  const clientDisplayName = useMemo(() => {
    if (selectedClients.length > 1) {
      return selectedClients.map((c) => c.name).join(', ');
    }
    if (selectedClientOrg) return selectedClientOrg.legalName;
    if (selectedClientPerson) return personDisplayName(selectedClientPerson);
    return '';
  }, [selectedClients, selectedClientOrg, selectedClientPerson]);

  const instructingPerson = useMemo(
    () => (instructingContactId ? people.find((p) => p.id === instructingContactId) ?? null : null),
    [people, instructingContactId],
  );
  const instructingDisplayName = useMemo(
    () => (instructingPerson ? personDisplayName(instructingPerson) : ''),
    [instructingPerson],
  );

  // Contacts linked to the selected client orgs (or person clients)
  const clientContacts = useMemo(() => {
    const orgIds = clientIds.filter((id) => id.startsWith('O-'));
    if (orgIds.length > 0) {
      const candidatePersonIds = new Set<string>();
      for (const oid of orgIds) {
        for (const l of links) {
          if (l.organisationId === oid && l.isCurrent) {
            candidatePersonIds.add(l.personId);
          }
        }
      }
      const linked = people.filter((p) => candidatePersonIds.has(p.id));
      if (linked.length > 0) return linked;
    }
    return people.filter((p) => !p.isEmployee && !p.mergedIntoId && !clientIds.includes(p.id));
  }, [clientIds, links, people]);

  // Only show Instructing contact if client(s) are under 18 or are an organisation
  const showInstructingContact = useMemo(() => {
    return selectedClients.some((c) => {
      if (c.entityType === 'organisation') return true;
      if (c.entityType === 'person' && c.person?.dateOfBirth) {
        const dobStr = c.person.dateOfBirth;
        const birth = new Date(dobStr.length === 10 ? `${dobStr}T00:00:00` : dobStr);
        const ref = new Date(today.length === 10 ? `${today}T00:00:00` : today);
        if (!Number.isNaN(birth.getTime()) && !Number.isNaN(ref.getTime())) {
          let age = ref.getFullYear() - birth.getFullYear();
          const m = ref.getMonth() - birth.getMonth();
          if (m < 0 || (m === 0 && ref.getDate() < birth.getDate())) {
            age--;
          }
          if (age < 18) return true;
        }
      }
      return false;
    });
  }, [selectedClients, today]);

  function openClientLookupModal() {
    setEditingClientRecordId(null);
    setClientSearchFirstName('');
    setClientSearchSurname('');
    setClientSearchOrg('');
    setTickedClientIds([]);
    setClientModalView('search');
    setClientModalOpen(true);
  }

  function openEditClientModal(recordId: string) {
    setEditingClientRecordId(recordId);
    setClientModalView(recordId.startsWith('O-') ? 'edit_org' : 'edit_person');
    setClientModalOpen(true);
  }

  function handleAddClientsToMatter(idsToAdd: string[], toastMsg?: string) {
    if (idsToAdd.length === 0) return;
    setClientIds((prev) => {
      const merged = Array.from(new Set([...prev, ...idsToAdd]));
      return merged;
    });
    // Auto-populate instructing contact if an organisation client is added and instructing contact is not yet set
    if (!instructingContactId) {
      const firstOrgClient = idsToAdd.find((id) => id.startsWith('O-'));
      if (firstOrgClient) {
        const linkedContact = links.find(
          (l) => l.organisationId === firstOrgClient && l.isCurrent,
        );
        if (linkedContact) {
          setInstructingContactId(linkedContact.personId);
        }
      }
    }
    if (hasRunSearch) {
      setPartiesChangedSinceSearch(true);
    }
    setClientModalOpen(false);
    setClientModalView('search');
    setTickedClientIds([]);
    if (toastMsg) {
      showToast(toastMsg);
    }
  }

  function handleRemoveClientFromMatter(idToRemove: string) {
    setClientIds((prev) => prev.filter((id) => id !== idToRemove));
    if (instructingContactId === idToRemove) {
      setInstructingContactId(null);
    }
    if (hasRunSearch) {
      setPartiesChangedSinceSearch(true);
    }
  }

  function toggleTickedClientId(id: string) {
    setTickedClientIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  const hasClientSearchQuery = Boolean(
    clientSearchFirstName.trim() || clientSearchSurname.trim() || clientSearchOrg.trim(),
  );

  // Live search results in the Client Lookup pop-up (blank until details entered, includes fuzzy & phonetic matches)
  const clientLookupResults = useMemo(() => {
    const fnRaw = clientSearchFirstName.trim();
    const snRaw = clientSearchSurname.trim();
    const orgRaw = clientSearchOrg.trim();
    if (!fnRaw && !snRaw && !orgRaw) {
      return [];
    }

    const fn = normaliseComparableName(fnRaw);
    const sn = normaliseComparableName(snRaw);
    const orgQ = normaliseComparableName(orgRaw);

    const checkTokenMatch = (
      queryVal: string,
      candidates: string[],
    ): 'exact' | 'similar spelling' | 'sounds like' | null => {
      const qTokens = normaliseComparableName(queryVal).split(' ').filter(Boolean);
      if (qTokens.length === 0) return null;

      let best: 'exact' | 'similar spelling' | 'sounds like' | null = null;
      for (const cand of candidates) {
        const cNorm = normaliseComparableName(cand);
        if (!cNorm) continue;
        if (cNorm.includes(normaliseComparableName(queryVal))) {
          return 'exact';
        }
        const cTokens = cNorm.split(' ').filter(Boolean);
        // Check if every query token matches a candidate token (exact, fuzzy edit distance, or phonetic)
        let allMatched = true;
        let usedFuzzy: 'similar spelling' | 'sounds like' | null = null;
        for (const qt of qTokens) {
          let tokenMatched = false;
          for (const ct of cTokens) {
            if (ct.includes(qt)) {
              tokenMatched = true;
              break;
            }
            const minLen = Math.min(qt.length, ct.length);
            const maxEdits = minLen >= 4 ? allowedNameEdits(minLen) : minLen === 3 ? 1 : 0;
            if (maxEdits > 0 && editDistance(qt, ct) <= maxEdits) {
              tokenMatched = true;
              if (!usedFuzzy) usedFuzzy = 'similar spelling';
              break;
            }
            if (qt.length >= 3 && ct.length >= 3 && tokensSoundAlike(qt, ct)) {
              tokenMatched = true;
              if (!usedFuzzy) usedFuzzy = 'sounds like';
              break;
            }
          }
          if (!tokenMatched) {
            allMatched = false;
            break;
          }
        }
        if (allMatched) {
          if (!usedFuzzy) return 'exact';
          if (best !== 'similar spelling') best = usedFuzzy;
        }
      }
      return best;
    };

    const results: {
      id: string;
      entityType: 'person' | 'organisation';
      name: string;
      firstName: string;
      surname: string;
      organisationName: string;
      details: string;
      alreadyAdded: boolean;
      missingClientFields: string[];
      matchNote: 'similar spelling' | 'sounds like' | null;
      rank: number;
    }[] = [];

    // 1. Search People (including employees who may also be clients/contacts — single record rule)
    for (const p of people) {
      if (p.mergedIntoId || p.demo) continue;
      const personLinks = links.filter((l) => l.personId === p.id && l.isCurrent);
      const linkedOrgs = personLinks
        .map((l) => organisations.find((o) => o.id === l.organisationId))
        .filter((o): o is Organisation => Boolean(o));
      const orgNames = linkedOrgs.map((o) => o.legalName).join(', ');

      let matchNote: 'similar spelling' | 'sounds like' | null = null;

      if (fn) {
        const fnRes = checkTokenMatch(fn, [
          p.firstName,
          p.preferredName ?? '',
          ...p.otherNames.map((n) => n.name),
        ]);
        if (!fnRes) continue;
        if (fnRes !== 'exact') matchNote = fnRes;
      }

      if (sn) {
        const snRes = checkTokenMatch(sn, [
          p.surname,
          ...p.otherNames.map((n) => n.name),
        ]);
        if (!snRes) continue;
        if (snRes !== 'exact' && !matchNote) matchNote = snRes;
      }

      if (!matchNote && fn && sn) {
        const loose = personNameLooseMatch(
          `${fnRaw} ${snRaw}`,
          `${p.firstName} ${p.surname}`,
        );
        if (loose) matchNote = loose;
      }

      if (orgQ) {
        const orgCandidates = linkedOrgs.flatMap((o) => [
          o.legalName,
          ...o.otherNames.map((n) => n.name),
        ]);
        const orgRes = checkTokenMatch(orgQ, orgCandidates);
        const looseOrg = linkedOrgs
          .map((o) => organisationNameLooseMatch(orgRaw, o.legalName))
          .find(Boolean);
        if (!orgRes && !looseOrg) continue;
        if (orgRes && orgRes !== 'exact' && !matchNote) matchNote = orgRes;
        else if (!orgRes && looseOrg && !matchNote) matchNote = looseOrg;
      }

      const email =
        p.emails.find((e) => e.isPrimary)?.address ?? p.emails[0]?.address ?? null;
      results.push({
        id: p.id,
        entityType: 'person',
        name: personDisplayName(p),
        firstName: p.firstName,
        surname: p.surname,
        organisationName: orgNames || '—',
        details: [p.jobTitle || null, email, p.addresses[0]?.town ?? null]
          .filter(Boolean)
          .join(' · '),
        alreadyAdded: clientIds.includes(p.id),
        missingClientFields: getMissingClientFieldsForPerson(p),
        matchNote,
        rank: matchNote ? 2 : 1,
      });
    }

    // 2. Search Organisations
    for (const o of organisations) {
      if (o.mergedIntoId) continue;
      const orgCandidates = [o.legalName, ...o.otherNames.map((n) => n.name)];
      let matchNote: 'similar spelling' | 'sounds like' | null = null;

      if (orgQ) {
        const orgRes = checkTokenMatch(orgQ, orgCandidates);
        const looseOrg = organisationNameLooseMatch(orgRaw, o.legalName);
        if (!orgRes && !looseOrg) continue;
        if (orgRes && orgRes !== 'exact') matchNote = orgRes;
        else if (!orgRes && looseOrg) matchNote = looseOrg;
      } else if (fn || sn) {
        const combinedQuery = [fnRaw, snRaw].filter(Boolean).join(' ');
        const orgRes = checkTokenMatch(combinedQuery, orgCandidates);
        const looseOrg = organisationNameLooseMatch(combinedQuery, o.legalName);
        if (!orgRes && !looseOrg) continue;
        if (orgRes && orgRes !== 'exact') matchNote = orgRes;
        else if (!orgRes && looseOrg) matchNote = looseOrg;
      }

      results.push({
        id: o.id,
        entityType: 'organisation',
        name: o.legalName,
        firstName: '—',
        surname: '—',
        organisationName: o.legalName,
        details: [
          o.companyNumber ? `Co. no. ${o.companyNumber}` : null,
          o.registeredAddress?.town ?? null,
          o.generalEmail || null,
        ]
          .filter(Boolean)
          .join(' · '),
        alreadyAdded: clientIds.includes(o.id),
        missingClientFields: getMissingClientFieldsForOrg(o),
        matchNote,
        rank: matchNote ? 2 : 1,
      });
    }

    return results.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  }, [
    clientSearchFirstName,
    clientSearchSurname,
    clientSearchOrg,
    people,
    organisations,
    links,
    clientIds,
  ]);

  const matchedOrgForNewPerson = useMemo(() => {
    const q = clientSearchOrg.trim().toLowerCase();
    if (!q) return '';
    const found = organisations.find(
      (o) => !o.mergedIntoId && o.legalName.toLowerCase().includes(q),
    );
    return found?.id ?? '';
  }, [clientSearchOrg, organisations]);

  const subcategoriesForPractice = useMemo(
    () =>
      values
        .filter((v) => v.listKey === 'work_type' && v.parentId === practiceAreaId && v.active)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [values, practiceAreaId],
  );

  // Fixed client parties + user-added parties (Part 2.1 & 2.6)
  const fixedClientParties = useMemo<ConflictCheckParty[]>(() => {
    const list: ConflictCheckParty[] = [];
    for (let i = 0; i < selectedClients.length; i++) {
      const c = selectedClients[i];
      const isLead = i === 0;
      const relCode = isLead ? 'CL' : 'JC';
      const capCodes = isLead
        ? clientCapacityCodes
        : jointClientCapacityCodes[c.id] ?? [];
      const identifiers: MatterPartyIdentifiers =
        c.entityType === 'organisation' && c.org
          ? {
              companyNumber: c.org.companyNumber || undefined,
              registeredTown: c.org.registeredAddress?.town || undefined,
            }
          : c.person
            ? {
                dateOfBirth: c.person.dateOfBirth || undefined,
                previousNames:
                  c.person.otherNames?.map((n) => n.name).join(', ') || undefined,
                town: c.person.addresses?.[0]?.town || undefined,
              }
            : {};
      list.push({
        id: isLead ? 'party-client' : `party-client-${c.id}`,
        name: c.name,
        entityType: c.entityType,
        role: 'Client',
        relationshipCode: relCode,
        capacityCodes: capCodes,
        connectedToPartyId: null,
        identifiers,
        alignment: 'aligned',
        linkedRecordId: c.id,
        subtitle:
          c.entityType === 'organisation' && c.org
            ? `Company no. ${c.org.companyNumber || '04918201'} · ${isLead ? 'Client' : 'Joint client'}`
            : c.organisationName && c.organisationName !== '—'
              ? `${isLead ? 'Client' : 'Joint client'} · ${c.organisationName}`
              : isLead
                ? 'Client'
                : 'Joint client',
        isClientFixed: true,
      });
    }
    if (showInstructingContact && instructingContactId && !clientIds.includes(instructingContactId)) {
      list.push({
        id: 'party-instructing',
        name: instructingDisplayName,
        entityType: 'person',
        role: 'Client contact',
        relationshipCode: 'CC',
        capacityCodes: instructingContactCapacityCodes,
        connectedToPartyId: 'party-client',
        identifiers: instructingPerson
          ? {
              dateOfBirth: instructingPerson.dateOfBirth || undefined,
              previousNames:
                instructingPerson.otherNames?.map((n) => n.name).join(', ') || undefined,
              town: instructingPerson.addresses?.[0]?.town || undefined,
            }
          : undefined,
        alignment: 'aligned',
        linkedRecordId: instructingContactId,
        subtitle: instructingPerson?.jobTitle
          ? `${instructingPerson.jobTitle} · ${selectedClients[0]?.name || ''}`
          : `Instructing contact · ${selectedClients[0]?.name || ''}`,
        isClientFixed: true,
      });
    }
    return list;
  }, [
    selectedClients,
    clientIds,
    showInstructingContact,
    instructingContactId,
    instructingDisplayName,
    instructingPerson,
    clientCapacityCodes,
    jointClientCapacityCodes,
    instructingContactCapacityCodes,
  ]);

  const allPartiesToCheck = useMemo<ConflictCheckParty[]>(
    () => [...fixedClientParties, ...otherParties],
    [fixedClientParties, otherParties],
  );

  // Taxonomy-driven helpers for Section 2
  const activeAddPartyRelationships = useMemo(
    () =>
      taxonomy.relationships
        .filter((r) => r.active && r.code !== 'CL' && r.code !== 'JC')
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [taxonomy],
  );

  const clientAllowedCapacities = useMemo(
    () => getWorkTypeClientCapacities(taxonomy, workTypeSubcategoryId, 'CL'),
    [taxonomy, workTypeSubcategoryId],
  );

  const jointClientAllowedCapacities = useMemo(
    () => getWorkTypeClientCapacities(taxonomy, workTypeSubcategoryId, 'JC'),
    [taxonomy, workTypeSubcategoryId],
  );

  const instructingAllowedCapacities = useMemo(
    () =>
      getAvailableCapacitiesForParty({
        taxonomy,
        relationshipCode: 'CC',
        workTypeSubcategoryId,
        showAllCapacities: true,
      }),
    [taxonomy, workTypeSubcategoryId],
  );

  const clientCapacityRequired = useMemo(
    () => isClientCapacityRequiredForWorkType(taxonomy, workTypeSubcategoryId),
    [taxonomy, workTypeSubcategoryId],
  );

  const availableCapacitiesForAdd = useMemo(() => {
    if (!workTypeSubcategoryId && !showAllCapacities) return [];
    return getAvailableCapacitiesForParty({
      taxonomy,
      relationshipCode: newPartyRelationshipCode,
      workTypeSubcategoryId,
      showAllCapacities,
      includeCapacityCodes: newPartyCapacityCodes,
    });
  }, [
    taxonomy,
    newPartyRelationshipCode,
    workTypeSubcategoryId,
    showAllCapacities,
    newPartyCapacityCodes,
  ]);

  const groupedCapacitiesForAdd = useMemo(() => {
    return CAPACITY_GROUPS.map((groupName) => ({
      group: groupName,
      items: availableCapacitiesForAdd.filter((c) => c.group === groupName),
    })).filter((g) => g.items.length > 0);
  }, [availableCapacitiesForAdd]);

  // Default "Connected to" when Relationship changes to CC or CO (Part 2.2.5)
  function getDefaultConnectedToForRelationship(relCode: string): string {
    if (relCode === 'CC') {
      return fixedClientParties.find((p) => p.relationshipCode === 'CL')?.id ?? 'party-client';
    }
    if (relCode === 'CO') {
      const firstAdverse = otherParties.find(
        (p) => p.relationshipCode === 'OP' || p.relationshipCode === 'CP',
      );
      return firstAdverse?.id ?? '';
    }
    return '';
  }

  function handleSelectAddPartyRelationship(nextRelCode: string) {
    setNewPartyRelationshipCode(nextRelCode);
    setShowAllCapacities(false);
    setNewPartyConnectedToId(getDefaultConnectedToForRelationship(nextRelCode));
    // Keep only capacities that are valid for the newly chosen relationship
    setNewPartyCapacityCodes((prev) =>
      prev.filter((code) => {
        const def = taxonomy.capacities.find((c) => c.code === code);
        return Boolean(def?.allowedRelationships.includes(nextRelCode));
      }),
    );
  }

  // Group all parties on the matter by canonical relationship order (Part 2.3)
  const groupedPartiesByRelationship = useMemo(() => {
    return RELATIONSHIP_SORT_ORDER.map((relCode) => {
      const relDef = taxonomy.relationships.find((r) => r.code === relCode);
      const partiesInGroup = allPartiesToCheck.filter(
        (pt) => (pt.relationshipCode || (pt.isClientFixed ? 'CL' : 'TP')) === relCode,
      );
      return {
        code: relCode,
        label: relDef?.label ?? relCode,
        description: relDef?.description ?? '',
        parties: partiesInGroup,
      };
    }).filter((g) => g.parties.length > 0);
  }, [allPartiesToCheck, taxonomy]);

  // Soft warnings (Part 2.4)
  const workTypeProfiles = useMemo(
    () => getProfilesForWorkType(taxonomy, workTypeSubcategoryId),
    [taxonomy, workTypeSubcategoryId],
  );

  const missingAdversePartySoftWarning = useMemo(() => {
    if (!workTypeSubcategoryId) return null;
    const expectsOpOrCp = workTypeProfiles.some((p) =>
      ['LIT', 'EMP', 'PROP', 'CORP'].includes(p),
    );
    if (!expectsOpOrCp) return null;
    const hasOpOrCp = otherParties.some(
      (p) => p.relationshipCode === 'OP' || p.relationshipCode === 'CP',
    );
    if (hasOpOrCp) return null;
    return 'This work type typically involves an Opposing party (OP) or Counterparty (CP), but none has been added yet.';
  }, [workTypeSubcategoryId, workTypeProfiles, otherParties]);

  const duplicatePartySoftWarning = useMemo(() => {
    const warnings: string[] = [];
    // Check live input in Add party form against parties already on the matter
    const candName = newPartyName.trim().toLowerCase();
    const candCoNo = newPartyIdentifiers.companyNumber?.trim().toLowerCase();
    if (candName) {
      const matchByName = allPartiesToCheck.find(
        (p) => p.id !== editingPartyId && p.name.trim().toLowerCase() === candName,
      );
      if (matchByName) {
        warnings.push(
          `"${matchByName.name}" is already listed on this matter (${
            taxonomy.relationships.find((r) => r.code === matchByName.relationshipCode)?.label ||
            matchByName.role
          }).`,
        );
      }
    }
    if (candCoNo) {
      const matchByCo = allPartiesToCheck.find(
        (p) =>
          p.id !== editingPartyId &&
          p.identifiers?.companyNumber?.trim().toLowerCase() === candCoNo,
      );
      if (matchByCo) {
        warnings.push(
          `Company number ${newPartyIdentifiers.companyNumber} matches "${matchByCo.name}" already on this matter.`,
        );
      }
    }
    // Also check if two already-added parties share a name or company number
    const seenNames = new Map<string, string>();
    const seenCoNos = new Map<string, string>();
    for (const p of allPartiesToCheck) {
      const n = p.name.trim().toLowerCase();
      if (n && seenNames.has(n)) {
        warnings.push(`Duplicate party name on matter: "${p.name}".`);
      } else if (n) {
        seenNames.set(n, p.name);
      }
      const cno = p.identifiers?.companyNumber?.trim().toLowerCase();
      if (cno && seenCoNos.has(cno)) {
        warnings.push(
          `Duplicate company number (${p.identifiers?.companyNumber}) on "${p.name}" and "${seenCoNos.get(cno)}".`,
        );
      } else if (cno) {
        seenCoNos.set(cno, p.name);
      }
    }
    return Array.from(new Set(warnings));
  }, [
    newPartyName,
    newPartyIdentifiers.companyNumber,
    allPartiesToCheck,
    editingPartyId,
    taxonomy.relationships,
  ]);

  // Typeahead suggestions when typing in "+ Add party"
  const partySuggestions = useMemo(() => {
    const q = newPartyName.trim().toLowerCase();
    const results: {
      id: string;
      name: string;
      entityType: ConflictPartyEntityType;
      subtitle: string;
      identifiers: MatterPartyIdentifiers;
    }[] = [];

    if (q.length >= 1) {
      for (const o of organisations) {
        if (o.mergedIntoId) continue;
        if (results.some((r) => r.id === o.id)) continue;
        if (
          o.legalName.toLowerCase().includes(q) ||
          o.otherNames.some((n) => n.name.toLowerCase().includes(q)) ||
          (o.companyNumber && o.companyNumber.toLowerCase().includes(q))
        ) {
          results.push({
            id: o.id,
            name: o.legalName,
            entityType: 'organisation',
            subtitle: [
              'Organisation',
              o.companyNumber ? `Co. no. ${o.companyNumber}` : null,
              o.registeredAddress?.town || 'UK',
            ]
              .filter(Boolean)
              .join(' · '),
            identifiers: {
              companyNumber: o.companyNumber || undefined,
              registeredTown: o.registeredAddress?.town || undefined,
            },
          });
        }
      }
      for (const p of people) {
        if (p.mergedIntoId || p.demo || p.isEmployee) continue;
        const pName = personDisplayName(p);
        if (results.some((r) => r.id === p.id)) continue;
        if (
          pName.toLowerCase().includes(q) ||
          p.otherNames.some((n) => n.name.toLowerCase().includes(q))
        ) {
          results.push({
            id: p.id,
            name: pName,
            entityType: 'person',
            subtitle: [
              'Person',
              p.jobTitle || 'Contact',
              p.addresses?.[0]?.town || null,
            ]
              .filter(Boolean)
              .join(' · '),
            identifiers: {
              dateOfBirth: p.dateOfBirth || undefined,
              previousNames: p.otherNames?.map((n) => n.name).join(', ') || undefined,
              town: p.addresses?.[0]?.town || undefined,
            },
          });
        }
      }
      for (const enq of enquiries) {
        if (enq.anonymisedAt) continue;
        const behalf = (enq.callingOnBehalfOf ?? '').trim();
        if (
          behalf &&
          behalf.toLowerCase().includes(q) &&
          !results.some((r) => r.name.toLowerCase() === behalf.toLowerCase())
        ) {
          results.push({
            id: enq.linkedOrganisationId || enq.id,
            name: behalf,
            entityType: 'organisation',
            subtitle: ['Enquiry organisation', enq.reference, enq.address?.town || null]
              .filter(Boolean)
              .join(' · '),
            identifiers: {
              registeredTown: enq.address?.town || undefined,
            },
          });
        }
        const otherNames = (enq.otherPartiesNamed ?? '')
          .split(/[,;/\n]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        for (const otherName of otherNames) {
          if (
            otherName.toLowerCase().includes(q) &&
            !results.some((r) => r.name.toLowerCase() === otherName.toLowerCase())
          ) {
            const isLikelyPerson =
              !/\b(ltd|limited|llp|plc|inc|corp|company|association|council|partners|solicitors|group|holdings|estates|solutions|investments|auctioneers|commercial|bank|trust)\b/i.test(
                otherName,
              ) && otherName.split(/\s+/).length <= 3;
            results.push({
              id: `${enq.id}-other-${otherName}`,
              name: otherName,
              entityType: isLikelyPerson ? 'person' : 'organisation',
              subtitle: [
                isLikelyPerson ? 'Person (from enquiry)' : 'Organisation (from enquiry)',
                `Named on ${enq.reference}`,
              ].join(' · '),
              identifiers: {},
            });
          }
        }
      }
    }

    return results.slice(0, 6);
  }, [newPartyName, organisations, people, enquiries]);

  // Run conflict search handler (executes server-side across all tenant matters, including restricted matters)
  async function handleRunConflictSearch() {
    try {
      const serverRes = await runMatterConflictSearchAction({
        currentMatterId: savedDraftMatterId ?? existing?.id ?? null,
        sourceEnquiryId:
          existing?.sourceEnquiryId ??
          initialEnquiry?.id ??
          initialQuote?.linkedEnquiryId ??
          null,
        parties: allPartiesToCheck,
        previousMatches: matches,
      });
      if (serverRes.errors && Object.keys(serverRes.errors).length > 0) {
        showToast(
          serverRes.errors.permission ||
            'The conflict search couldn’t run. Please try again.',
        );
        return;
      }
      const computed = serverRes.matches;
      const runTime =
        serverRes.run?.runAtDisplay || formatDateTime(new Date().toISOString());
      const runnerName =
        serverRes.run?.runByName ||
        `${currentUser.firstName} ${currentUser.surname[0] || ''}.`.trim();

      setMatches(computed);
      if (serverRes.matter?.rowVersion != null) {
        setSavedMatterRowVersion(serverRes.matter.rowVersion);
      }
      setHasRunSearch(true);
      setLastRunAtDisplay(runTime);
      setLastRunByName(runnerName);
      setPartiesChangedSinceSearch(false);
      setReopenedDraftBanner(null);

      const potCount = computed.filter((m) => m.disposition === 'potential_conflict').length;
      const newAudit: ConflictCheckRunAudit = serverRes.run ?? {
        id: `run-${Date.now()}`,
        runAtDisplay: runTime,
        runById: currentUser.id,
        runByName: runnerName,
        searchTerms: allPartiesToCheck.map((p) => p.name),
        partiesCount: allPartiesToCheck.length,
        matchesCount: computed.length,
        potentialConflictsCount: potCount,
      };
      setSearchRuns((prev) => [newAudit, ...prev]);
      showToast(
        `Conflict search completed · ${allPartiesToCheck.length} parties checked · ${computed.length} ${
          computed.length === 1 ? 'match' : 'matches'
        }`,
      );
    } catch {
      showToast('The conflict search couldn’t run. Please try again.');
    }
  }

  function resetAddPartyForm() {
    setPartyModalOpen(false);
    setEditingPartyId(null);
    setNewPartyName('');
    setNewPartyType('organisation');
    setNewPartyRelationshipCode('');
    setNewPartyCapacityCodes([]);
    setShowAllCapacities(false);
    setNewPartyConnectedToId('');
    setNewPartyMoreDetailsOpen(false);
    setNewPartyIdentifiers({});
    setNewPartyLinkedId(null);
    setShowSuggestions(false);
    setCapacityDropdownOpen(false);
  }

  function openAddPartyModal() {
    setEditingPartyId(null);
    setNewPartyName('');
    setNewPartyType('organisation');
    setNewPartyRelationshipCode('');
    setNewPartyCapacityCodes([]);
    setShowAllCapacities(false);
    setNewPartyConnectedToId('');
    setNewPartyMoreDetailsOpen(false);
    setNewPartyIdentifiers({});
    setNewPartyLinkedId(null);
    setShowSuggestions(false);
    setCapacityDropdownOpen(false);
    setPartyModalOpen(true);
  }

  function handleStartEditParty(party: ConflictCheckParty) {
    setEditingPartyId(party.id);
    setNewPartyName(party.name);
    setNewPartyType(party.entityType);
    setNewPartyRelationshipCode(party.relationshipCode || 'OP');
    setNewPartyCapacityCodes(party.capacityCodes ?? []);
    setNewPartyConnectedToId(party.connectedToPartyId ?? '');
    setNewPartyIdentifiers(party.identifiers ?? {});
    setNewPartyMoreDetailsOpen(
      Boolean(
        party.identifiers?.companyNumber ||
          party.identifiers?.registeredTown ||
          party.identifiers?.dateOfBirth ||
          party.identifiers?.previousNames ||
          party.identifiers?.town,
      ),
    );
    setNewPartyLinkedId(party.linkedRecordId ?? null);
    setPartyModalOpen(true);
  }

  // Add or update party handler (Part 2.2 & 2.6)
  function handleAddParty(customParty?: {
    id?: string;
    name: string;
    entityType: ConflictPartyEntityType;
    relationshipCode: string;
    capacityCodes: string[];
    connectedToPartyId?: string | null;
    identifiers?: MatterPartyIdentifiers;
    linkedRecordId?: string | null;
    subtitle?: string;
  }) {
    const nameToUse = (customParty ? customParty.name : newPartyName).trim();
    if (!nameToUse) return;
    const typeToUse = customParty ? customParty.entityType : newPartyType;
    const relCodeToUse =
      (customParty ? customParty.relationshipCode : newPartyRelationshipCode) || 'OP';
    const capCodesToUse = customParty
      ? customParty.capacityCodes
      : newPartyCapacityCodes;

    const connectedToUse =
      customParty !== undefined
        ? customParty.connectedToPartyId ?? null
        : ['CC', 'CO', 'TP'].includes(relCodeToUse)
          ? newPartyConnectedToId || getDefaultConnectedToForRelationship(relCodeToUse) || null
          : null;

    const identifiersToUse: MatterPartyIdentifiers | undefined = customParty
      ? customParty.identifiers
      : typeToUse === 'organisation'
        ? {
            companyNumber: newPartyIdentifiers.companyNumber?.trim() || undefined,
            registeredTown: newPartyIdentifiers.registeredTown?.trim() || undefined,
          }
        : {
            dateOfBirth: newPartyIdentifiers.dateOfBirth?.trim() || undefined,
            previousNames: newPartyIdentifiers.previousNames?.trim() || undefined,
            town: newPartyIdentifiers.town?.trim() || undefined,
          };

    const linkedToUse =
      customParty?.linkedRecordId !== undefined ? customParty.linkedRecordId : newPartyLinkedId;

    const legacyRole = mapRelationshipToLegacyConflictRole(relCodeToUse);
    const alignment = getRelationshipAlignment(relCodeToUse);
    const displaySub =
      customParty?.subtitle ||
      formatIdentifiersSummary(typeToUse, identifiersToUse) ||
      formatPartyRoleDisplay(taxonomy, relCodeToUse, capCodesToUse, legacyRole);

    if (editingPartyId) {
      setOtherParties((prev) =>
        prev.map((p) =>
          p.id === editingPartyId
            ? {
                ...p,
                name: nameToUse,
                entityType: typeToUse,
                role: legacyRole,
                relationshipCode: relCodeToUse,
                capacityCodes: capCodesToUse,
                connectedToPartyId: connectedToUse,
                identifiers: identifiersToUse,
                needsCapacityPrompt: capCodesToUse.length === 0,
                alignment,
                linkedRecordId: linkedToUse ?? null,
                subtitle: displaySub,
              }
            : p,
        ),
      );
      resetAddPartyForm();
    } else {
      const created: ConflictCheckParty = {
        id: customParty?.id ?? nextClientItemId('party'),
        name: nameToUse,
        entityType: typeToUse,
        role: legacyRole,
        relationshipCode: relCodeToUse,
        capacityCodes: capCodesToUse,
        connectedToPartyId: connectedToUse,
        identifiers: identifiersToUse,
        needsCapacityPrompt: capCodesToUse.length === 0,
        alignment,
        linkedRecordId: linkedToUse ?? null,
        subtitle: displaySub,
        relatedEntitiesIncluded: false,
      };
      setOtherParties((prev) => [...prev, created]);
      resetAddPartyForm();
    }

    if (hasRunSearch) {
      setPartiesChangedSinceSearch(true);
    }
  }

  // Removing a party that other parties are connected to warns the user and clears those links (Part 2.3)
  function handleRemoveParty(partyId: string) {
    const target = otherParties.find((p) => p.id === partyId);
    const connectedDependents = otherParties.filter(
      (p) => p.id !== partyId && p.connectedToPartyId === partyId,
    );
    if (connectedDependents.length > 0) {
      const depNames = connectedDependents.map((d) => d.name).join(', ');
      const confirmed =
        typeof window === 'undefined'
          ? true
          : window.confirm(
              `Removing "${target?.name || 'this party'}" will clear the "Connected to" link on: ${depNames}. Continue?`,
            );
      if (!confirmed) return;
    }

    setOtherParties((prev) =>
      prev
        .filter((p) => p.id !== partyId && p.parentPartyId !== partyId)
        .map((p) =>
          p.connectedToPartyId === partyId ? { ...p, connectedToPartyId: null } : p,
        ),
    );
    if (editingPartyId === partyId) {
      resetAddPartyForm();
    }
    setMatches((prev) => prev.filter((m) => m.partyId !== partyId));
    if (hasRunSearch) {
      setPartiesChangedSinceSearch(true);
    }
    if (connectedDependents.length > 0) {
      showToast(
        `Removed ${target?.name || 'party'} and cleared connection links on ${connectedDependents.length} ${
          connectedDependents.length === 1 ? 'party' : 'parties'
        }.`,
      );
    }
  }

  // "Include related entities" per organisation
  function handleIncludeRelatedEntities(orgParty: ConflictCheckParty) {
    if (orgParty.relatedEntitiesIncluded) return;
    const relatedToAdd: ConflictCheckParty[] = [];
    const connectedRelCode =
      orgParty.relationshipCode === 'OP' ||
      orgParty.relationshipCode === 'CP' ||
      orgParty.relationshipCode === 'CO'
        ? 'CO'
        : orgParty.relationshipCode === 'CL' ||
            orgParty.relationshipCode === 'JC' ||
            orgParty.relationshipCode === 'CC'
          ? 'CC'
          : 'TP';
    const connectedAlignment = getRelationshipAlignment(connectedRelCode);

    // Check links in store for people linked to this organisation
    const linkedPeople = links
      .filter((l) => l.organisationId === orgParty.linkedRecordId && l.isCurrent)
      .map((l) => people.find((p) => p.id === l.personId))
      .filter((p): p is Person => Boolean(p && !p.demo && !p.mergedIntoId));

    for (const lp of linkedPeople) {
      const isDir = (lp.jobTitle || '').toLowerCase().includes('director');
      relatedToAdd.push({
        id: nextClientItemId(`rel-${lp.id}`),
        name: personDisplayName(lp),
        entityType: 'person',
        role: 'Related party',
        relationshipCode: connectedRelCode,
        capacityCodes: [isDir ? 'CAP_DIRECTOR' : 'CAP_REPRESENTATIVE'],
        connectedToPartyId: orgParty.id,
        alignment: connectedAlignment,
        linkedRecordId: lp.id,
        subtitle: `${lp.jobTitle || 'Contact'} · Connected to ${orgParty.name}`,
        parentPartyId: orgParty.id,
      });
    }

    // Check parent/subsidiary organisations in store
    if (orgParty.linkedRecordId) {
      const orgRecord = organisations.find((o) => o.id === orgParty.linkedRecordId);
      if (orgRecord?.parentOrganisationId) {
        const parentOrg = organisations.find(
          (o) => o.id === orgRecord.parentOrganisationId && !o.mergedIntoId,
        );
        if (parentOrg) {
          relatedToAdd.push({
            id: nextClientItemId(`rel-org-${parentOrg.id}`),
            name: parentOrg.legalName,
            entityType: 'organisation',
            role: 'Related party',
            relationshipCode: connectedRelCode,
            capacityCodes: ['CAP_PARENT_COMPANY'],
            connectedToPartyId: orgParty.id,
            alignment: connectedAlignment,
            linkedRecordId: parentOrg.id,
            subtitle: `Parent company · Connected to ${orgParty.name}`,
            parentPartyId: orgParty.id,
          });
        }
      }
      const childOrgs = organisations.filter(
        (o) => o.parentOrganisationId === orgParty.linkedRecordId && !o.mergedIntoId,
      );
      for (const child of childOrgs) {
        relatedToAdd.push({
          id: nextClientItemId(`rel-org-${child.id}`),
          name: child.legalName,
          entityType: 'organisation',
          role: 'Related party',
          relationshipCode: connectedRelCode,
          capacityCodes: ['CAP_SUBSIDIARY'],
          connectedToPartyId: orgParty.id,
          alignment: connectedAlignment,
          linkedRecordId: child.id,
          subtitle: `Subsidiary / group company · Connected to ${orgParty.name}`,
          parentPartyId: orgParty.id,
        });
      }
    }

    setOtherParties((prev) => {
      const updated = prev.map((p) =>
        p.id === orgParty.id ? { ...p, relatedEntitiesIncluded: true } : p,
      );
      const existingNames = new Set(updated.map((p) => p.name.toLowerCase()));
      const filteredNew = relatedToAdd.filter(
        (r) => !existingNames.has(r.name.toLowerCase()),
      );
      return [...updated, ...filteredNew];
    });

    if (hasRunSearch) {
      setPartiesChangedSinceSearch(true);
    }
    showToast(
      `Added ${relatedToAdd.length} related ${
        relatedToAdd.length === 1 ? 'entity' : 'entities'
      } for ${orgParty.name}`,
    );
  }

  // Update match disposition or note
  function updateMatch(matchId: string, patch: Partial<ConflictCheckMatch>) {
    setMatches((prev) =>
      prev.map((m) => (m.id === matchId ? { ...m, ...patch } : m)),
    );
  }

  // Validation & progress calculation
  const requiredCard1Total = showInstructingContact ? 4 : 3;
  const mandatoryDetailsDoneCount = useMemo(() => {
    let c = 0;
    if (clientId) c++;
    if (showInstructingContact && instructingContactId) c++;
    if (title.trim()) c++;
    if (practiceAreaId && workTypeSubcategoryId) c++;
    return c;
  }, [
    clientId,
    showInstructingContact,
    instructingContactId,
    title,
    practiceAreaId,
    workTypeSubcategoryId,
  ]);

  const isClientCapacityComplete =
    !clientCapacityRequired || clientCapacityCodes.length >= 1;
  const areAddedPartiesCapacitiesComplete = otherParties.every(
    (p) => (p.capacityCodes?.length ?? 0) >= 1,
  );
  const isCard1Complete = mandatoryDetailsDoneCount === requiredCard1Total;
  const isCard2Complete =
    otherParties.length >= 1 &&
    isClientCapacityComplete &&
    areAddedPartiesCapacitiesComplete;
  const isCard3SearchFresh = hasRunSearch && !partiesChangedSinceSearch;

  const reviewedMatchesCount = useMemo(() => {
    return matches.filter((m) => {
      if (!m.disposition) return false;
      if (
        (m.disposition === 'same_no_conflict' || m.disposition === 'potential_conflict') &&
        !m.note.trim()
      ) {
        return false;
      }
      return true;
    }).length;
  }, [matches]);

  const allMatchesReviewed =
    hasRunSearch && (matches.length === 0 || reviewedMatchesCount === matches.length);

  const potentialConflictsCount = useMemo(
    () => matches.filter((m) => m.disposition === 'potential_conflict').length,
    [matches],
  );

  const isReferredOutcome = potentialConflictsCount > 0;

  // Missing items list for Submit button tooltip
  const missingItems = useMemo(() => {
    const missing: string[] = [];
    if (!clientId) missing.push('Client');
    if (showInstructingContact && !instructingContactId) {
      missing.push('Instructing contact');
    }
    if (!title.trim()) missing.push('Matter description');
    if (!practiceAreaId || !workTypeSubcategoryId)
      missing.push('Department and work type');
    if (clientCapacityRequired && clientCapacityCodes.length === 0)
      missing.push("Client's capacity in this matter");
    if (otherParties.length === 0)
      missing.push('At least 1 other party to check');
    else if (!areAddedPartiesCapacitiesComplete)
      missing.push('Capacity for every party on the matter');
    if (!hasRunSearch) missing.push('Run conflict search');
    else if (partiesChangedSinceSearch)
      missing.push('Re-run conflict search (parties changed)');
    if (hasRunSearch && !allMatchesReviewed) {
      missing.push(
        `Review all conflict matches and add required notes (${reviewedMatchesCount} of ${matches.length} complete)`,
      );
    }
    if (!declarationConfirmed)
      missing.push('Confirm the parties declaration checkbox');
    return missing;
  }, [
    clientId,
    showInstructingContact,
    instructingContactId,
    title,
    practiceAreaId,
    workTypeSubcategoryId,
    clientCapacityRequired,
    clientCapacityCodes.length,
    otherParties.length,
    areAddedPartiesCapacitiesComplete,
    hasRunSearch,
    partiesChangedSinceSearch,
    allMatchesReviewed,
    reviewedMatchesCount,
    matches.length,
    declarationConfirmed,
  ]);

  const canSubmit = missingItems.length === 0 && workflowState === 'editing' && !isReviewerMode;

  // Step X of 5 for the right-hand MATTER OPENING progress card
  const completedStepsCount = useMemo(() => {
    let steps = 0;
    if (isCard1Complete) steps++;
    if (matterCostsCompletion.isComplete) steps++;
    if (riskAssessmentSummary.isComplete) steps++;
    if (isCard2Complete) steps++;
    if (isCard3SearchFresh && allMatchesReviewed) steps++;
    if (declarationConfirmed) steps++;
    return steps;
  }, [
    isCard1Complete,
    matterCostsCompletion.isComplete,
    riskAssessmentSummary.isComplete,
    isCard2Complete,
    isCard3SearchFresh,
    allMatchesReviewed,
    declarationConfirmed,
  ]);

  // Conflict check status pill
  const conflictStatusPillLabel = useMemo<ConflictCheckStatusPill>(() => {
    if (workflowState === 'approved') return 'Approved';
    if (workflowState === 'declined') return 'Declined';
    if (workflowState === 'referred_readonly' || isReviewerMode) return 'Referred';
    if (!hasRunSearch && otherParties.length === 0) return 'Not started';
    if (!hasRunSearch || partiesChangedSinceSearch || !allMatchesReviewed || !declarationConfirmed) {
      return 'In progress';
    }
    return isReferredOutcome ? 'Referred' : 'Cleared';
  }, [
    workflowState,
    isReviewerMode,
    hasRunSearch,
    otherParties.length,
    partiesChangedSinceSearch,
    allMatchesReviewed,
    declarationConfirmed,
    isReferredOutcome,
  ]);

  // Build snapshot object for saving
  function buildConflictRecordSnapshot(
    overrideStatus?: ConflictCheckStatusPill,
    overrideOutcome?: ConflictCheckRecord['outcomeLabel'],
  ): ConflictCheckRecordInput {
    const statusToUse = overrideStatus ?? conflictStatusPillLabel;
    const outcomeToUse: ConflictCheckRecord['outcomeLabel'] =
      overrideOutcome ??
      (isReferredOutcome ? 'Referred to risk for review' : 'Cleared by fee earner');

    return {
      status: statusToUse,
      outcomeLabel: outcomeToUse,
      declarationConfirmed,
      reviewerMessage,
      lastRunAtDisplay: lastRunAtDisplay || null,
      lastRunById: lastRunAtDisplay ? currentUser.id : null,
      lastRunByName: lastRunByName || null,
      savedDraftAtDisplay: formatDateTime(new Date().toISOString()),
      submittedAtDisplay:
        statusToUse === 'In progress'
          ? null
          : formatDateTime(new Date().toISOString()),
      submittedByName:
        people.find((p) => p.id === (leadFeeEarnerId || currentUser.id))
          ? personDisplayName(
              people.find((p) => p.id === (leadFeeEarnerId || currentUser.id))!,
            )
          : personDisplayName(currentUser),
      parties: allPartiesToCheck,
      matches,
      runs: searchRuns,
      comments,
    };
  }

  // Convert ConflictCheckParty to MatterParty preserving the two-field model (Part 2.6)
  function toMatterParty(p: ConflictCheckParty): MatterParty {
    const relCode = p.relationshipCode || 'OP';
    const capCodes = p.capacityCodes ?? [];
    return {
      id: p.id,
      name: p.name,
      entityType: p.entityType,
      role: formatPartyRoleDisplay(taxonomy, relCode, capCodes, p.role),
      relationshipCode: relCode,
      capacityCodes: capCodes,
      connectedToPartyId: p.connectedToPartyId ?? null,
      identifiers: p.identifiers,
      needsCapacityPrompt: p.needsCapacityPrompt,
      alignment: p.alignment ?? getRelationshipAlignment(relCode),
      linkedRecordId: p.linkedRecordId,
    };
  }

  const [savedDraftMatterId, setSavedDraftMatterId] = useState<string | null>(
    existing?.id ?? null,
  );
  const [savedMatterRowVersion, setSavedMatterRowVersion] = useState<number>(
    existing?.rowVersion ?? 1,
  );
  const [serverSaveErrors, setServerSaveErrors] = useState<Record<string, string>>({});
  const [partnerCostSignOff, setPartnerCostSignOff] =
    useState<PartnerCostSignOffRecord | null>(
      () =>
        (existing?.fieldValues?.['partnerCostSignOff'] as
          | PartnerCostSignOffRecord
          | undefined) ?? null,
    );
  const [savedEstimateGbp, setSavedEstimateGbp] = useState<number | null>(() => {
    if (initialSignOffEstimateGbp != null) return initialSignOffEstimateGbp;
    if (!existing) return null;
    return Number(
      existing.feeEstimateGbp ??
        existing.agreedFeeCapGbp ??
        initialMatterCosts.totalEstimateGbp ??
        initialMatterCosts.agreedCapGbp ??
        0,
    );
  });
  const [signOffNote, setSignOffNote] = useState<string>('');
  const [signingOffCosts, setSigningOffCosts] = useState<boolean>(false);

  const currentFormEstimateGbp = Number(
    numericFeeEstimateGbp ??
      numericAgreedCapGbp ??
      initialMatterCosts.totalEstimateGbp ??
      initialMatterCosts.agreedCapGbp ??
      0,
  );
  const hasUnsavedEstimateChanges =
    savedEstimateGbp === null || currentFormEstimateGbp !== savedEstimateGbp;

  async function handleSignOffMatterCosts() {
    const targetId = savedDraftMatterId ?? existing?.id;
    if (!targetId) {
      showToast('Save the draft matter first before signing off costs.');
      return;
    }
    if (hasUnsavedEstimateChanges) {
      showToast('Save your changes before signing off');
      return;
    }
    setSigningOffCosts(true);
    try {
      const res = await signOffMatterCostsAction(
        targetId,
        signOffNote.trim() || undefined,
      );
      setSigningOffCosts(false);
      if (isActionDenied(res)) {
        showToast(res.message || 'Could not sign off matter costs');
        return;
      }
      if (res.errors && Object.keys(res.errors).length > 0) {
        showToast(
          Object.values(res.errors)[0] ?? 'Could not sign off matter costs',
        );
        return;
      }
      if (res.matter) {
        if (res.matter.rowVersion != null) {
          setSavedMatterRowVersion(res.matter.rowVersion);
        }
        const record =
          (res.matter.fieldValues?.['partnerCostSignOff'] as
            | PartnerCostSignOffRecord
            | undefined) ?? null;
        setPartnerCostSignOff(record);
        if (record?.signedOffEstimateGbp != null) {
          setSavedEstimateGbp(record.signedOffEstimateGbp);
        }
        setSignOffNote('');
        showToast(res.warnings?.[0] ?? 'Partner cost sign-off recorded');
        router.refresh();
      }
    } catch {
      setSigningOffCosts(false);
      showToast('Could not sign off matter costs');
    }
  }

  const [assignModalOpen, setAssignModalOpen] = useState<boolean>(false);
  const [assignSubmitting, setAssignSubmitting] = useState<boolean>(false);

  // People on this matter for quick selection in the Create task modal
  const suggestedMatterTaskAssignees = useMemo<SuggestedTaskAssignee[]>(() => {
    const seen = new Set<string>();
    const list: SuggestedTaskAssignee[] = [];
    const addPerson = (personId: string | null | undefined, badgeLabel: string) => {
      if (!personId || seen.has(personId)) return;
      const emp = employees.find((e) => e.id === personId) ?? people.find((p) => p.id === personId);
      if (!emp) return;
      seen.add(personId);
      list.push({ person: emp, badgeLabel });
    };

    addPerson(leadFeeEarnerId, 'Fee earner');
    addPerson(supervisingPartnerId || responsiblePartnerId, 'Supervising partner');
    if (responsiblePartnerId && responsiblePartnerId !== supervisingPartnerId) {
      addPerson(responsiblePartnerId, 'Responsible partner');
    }
    addPerson(relationshipPartnerId, 'Relationship partner');
    for (const r of additionalTeamRoles) {
      addPerson(r.personId, r.role || 'Team member');
    }
    if (newTeamPersonId) {
      const emp = employees.find((e) => e.id === newTeamPersonId);
      addPerson(
        newTeamPersonId,
        emp?.employment?.jobTitle?.trim() || emp?.jobTitle?.trim() || 'Team member',
      );
    }

    if (suggestedMatterGovernanceAssignees?.riskReviewerId) {
      addPerson(suggestedMatterGovernanceAssignees.riskReviewerId, 'Risk & Compliance');
    }
    if (suggestedMatterGovernanceAssignees?.practiceManagerId) {
      addPerson(suggestedMatterGovernanceAssignees.practiceManagerId, 'Practice manager');
    }

    return list;
  }, [
    leadFeeEarnerId,
    supervisingPartnerId,
    responsiblePartnerId,
    relationshipPartnerId,
    additionalTeamRoles,
    newTeamPersonId,
    employees,
    people,
    suggestedMatterGovernanceAssignees,
  ]);

  const initialSelectedAssignPersonIds = useMemo<string[]>(() => {
    if (leadFeeEarnerId) return [leadFeeEarnerId];
    if (suggestedMatterTaskAssignees.length > 0) {
      return [suggestedMatterTaskAssignees[0].person.id];
    }
    return [];
  }, [leadFeeEarnerId, suggestedMatterTaskAssignees]);

  function handleOpenAssignModal() {
    setAssignModalOpen(true);
  }

  // Save draft handler
  async function handleSaveDraft() {
    setSaving(true);
    setServerSaveErrors({});
    try {
      const snapshot = buildConflictRecordSnapshot('In progress', 'Pending');
      const matterParties: MatterParty[] = otherParties.map(toMatterParty);
      const res = await saveMatterAction(
        {
          title: title.trim(),
          shortDescription,
          clientId,
          additionalClientIds: clientIds.slice(1),
          sourceEnquiryId:
            existing?.sourceEnquiryId ??
            initialEnquiry?.id ??
            initialQuote?.linkedEnquiryId ??
            null,
          sourceQuoteId: existing?.sourceQuoteId ?? initialQuote?.id ?? null,
          enquiryReceivedAt:
            existing?.enquiryReceivedAt ??
            (initialEnquiry?.receivedAt ? initialEnquiry.receivedAt.slice(0, 10) : undefined),
          practiceAreaId,
          workTypeSubcategoryId,
          owningDepartmentId: owningDepartmentId || undefined,
          owningTeamId: owningTeamId || undefined,
          typeBadge,
          matterTypeId,
          billingBasisId,
          clientTierId,
          clientSectorId,
          riskRatingId,
          matterSizeId,
          referrerTypeId: existing?.referrerTypeId ?? initialEnquiry?.sourceId ?? null,
          referrerContactId:
            existing?.referrerContactId ?? initialEnquiry?.referrerPersonId ?? null,
          responsiblePartnerId,
          supervisingPartnerId,
          leadFeeEarnerId,
          relationshipPartnerId,
          instructingContactId,
          billingContactId,
          parties: matterParties,
          conflictCheckRecord: snapshot,
          feeEstimateGbp: feeEstimateGbp ? Number(feeEstimateGbp) : null,
          agreedFeeCapGbp: agreedFeeCapGbp ? Number(agreedFeeCapGbp) : null,
          retainerMoniesOnAccountGbp: retainerMoniesOnAccountGbp
            ? Number(retainerMoniesOnAccountGbp)
            : null,
          fieldValues: {
            ...fieldValues,
            additionalClientIds: clientIds.slice(1),
            clientCapacityCodes,
            jointClientCapacityCodes,
            instructingContactCapacityCodes,
            customKeyDates,
            matterCosts: buildMatterCostsSnapshotPayload(),
            riskAssessment: {
              answers: riskAnswers,
              followUps: riskFollowUps,
              customKeyDates,
            },
          },
        },
        {
          id: savedDraftMatterId ?? existing?.id,
          saveMode: 'draft',
          expectedRowVersion: savedMatterRowVersion,
        },
      );
      setSaving(false);
      if (res.errors && Object.keys(res.errors).length > 0) {
        setServerSaveErrors(res.errors);
        showToast(Object.values(res.errors)[0] ?? 'Could not save draft');
        return;
      }
      if (res.matter) {
        setSavedDraftMatterId(res.matter.id);
        if (res.matter.rowVersion != null) {
          setSavedMatterRowVersion(res.matter.rowVersion);
        }
        setSavedEstimateGbp(currentFormEstimateGbp);
        setPartnerCostSignOff(
          (res.matter.fieldValues?.['partnerCostSignOff'] as
            | PartnerCostSignOffRecord
            | undefined) ?? null,
        );
        if (typeof window !== 'undefined') {
          try {
            sessionStorage.removeItem(sessionDraftKey);
          } catch {
            // ignore
          }
        }
        setInitialSnapshot(currentFormStateSignature);
        setRestoredSessionDirty(false);
        const draftLabel = clientDisplayName || title.trim() || 'Untitled matter';
        showToast(
          initialQuote
            ? `Draft saved · Quote ${initialQuote.reference}${initialEnquiry ? ` & ${initialEnquiry.reference}` : ''} linked to matter`
            : initialEnquiry
              ? `Draft saved · ${initialEnquiry.reference} moved to Closed (Converted to matter)`
              : `Draft saved · Added "Conflict check · ${draftLabel} · Draft" to your To Do list`,
        );
      }
    } catch {
      setSaving(false);
      showToast('Could not save draft');
    }
  }

  async function handleConfirmAssignTask(payload: CreateTaskSubmitPayload) {
    setAssignSubmitting(true);
    setServerSaveErrors({});
    try {
      let targetMatterId = savedDraftMatterId ?? existing?.id ?? null;
      if (!isEditingExistingMatter) {
        const snapshot = buildConflictRecordSnapshot('In progress', 'Pending');
        const matterParties: MatterParty[] = otherParties.map(toMatterParty);
        const draftRes = await saveMatterAction(
          {
            title: title.trim(),
            shortDescription,
            clientId,
            additionalClientIds: clientIds.slice(1),
            sourceEnquiryId:
              existing?.sourceEnquiryId ??
              initialEnquiry?.id ??
              initialQuote?.linkedEnquiryId ??
              null,
            sourceQuoteId: existing?.sourceQuoteId ?? initialQuote?.id ?? null,
            enquiryReceivedAt:
              existing?.enquiryReceivedAt ??
              (initialEnquiry?.receivedAt
                ? initialEnquiry.receivedAt.slice(0, 10)
                : undefined),
            practiceAreaId,
            workTypeSubcategoryId,
            owningDepartmentId: owningDepartmentId || undefined,
            owningTeamId: owningTeamId || undefined,
            typeBadge,
            matterTypeId,
            billingBasisId,
            clientTierId,
            clientSectorId,
            riskRatingId,
            matterSizeId,
            referrerTypeId:
              existing?.referrerTypeId ?? initialEnquiry?.sourceId ?? null,
            referrerContactId:
              existing?.referrerContactId ?? initialEnquiry?.referrerPersonId ?? null,
            responsiblePartnerId,
            supervisingPartnerId,
            leadFeeEarnerId,
            relationshipPartnerId,
            instructingContactId,
            billingContactId,
            parties: matterParties,
            conflictCheckRecord: snapshot,
            feeEstimateGbp: feeEstimateGbp ? Number(feeEstimateGbp) : null,
            agreedFeeCapGbp: agreedFeeCapGbp ? Number(agreedFeeCapGbp) : null,
            retainerMoniesOnAccountGbp: retainerMoniesOnAccountGbp
              ? Number(retainerMoniesOnAccountGbp)
              : null,
            fieldValues: {
              ...fieldValues,
              additionalClientIds: clientIds.slice(1),
              clientCapacityCodes,
              jointClientCapacityCodes,
              instructingContactCapacityCodes,
              customKeyDates,
              matterCosts: buildMatterCostsSnapshotPayload(),
              riskAssessment: {
                answers: riskAnswers,
                followUps: riskFollowUps,
                customKeyDates,
              },
            },
          },
          {
            id: targetMatterId ?? undefined,
            saveMode: 'draft',
            expectedRowVersion: savedMatterRowVersion,
          },
        );
        if (draftRes.errors && Object.keys(draftRes.errors).length > 0) {
          setServerSaveErrors(draftRes.errors);
          setAssignSubmitting(false);
          showToast(Object.values(draftRes.errors)[0] ?? 'Could not save draft');
          return;
        }
        if (draftRes.matter) {
          targetMatterId = draftRes.matter.id;
          setSavedDraftMatterId(draftRes.matter.id);
          if (draftRes.matter.rowVersion != null) {
            setSavedMatterRowVersion(draftRes.matter.rowVersion);
          }
          setSavedEstimateGbp(currentFormEstimateGbp);
          setPartnerCostSignOff(
            (draftRes.matter.fieldValues?.['partnerCostSignOff'] as
              | PartnerCostSignOffRecord
              | undefined) ?? null,
          );
          setInitialSnapshot(currentFormStateSignature);
          setRestoredSessionDirty(false);
        }
      }

      const linkedRecords: {
        recordType: 'matter' | 'person' | 'organisation' | 'enquiry';
        recordId: string;
      }[] = [];
      if (targetMatterId) {
        linkedRecords.push({ recordType: 'matter', recordId: targetMatterId });
      }
      if (clientId) {
        linkedRecords.push({
          recordType: clientId.startsWith('P-') ? 'person' : 'organisation',
          recordId: clientId,
        });
      }
      if (initialEnquiry?.id) {
        linkedRecords.push({
          recordType: 'enquiry',
          recordId: initialEnquiry.id,
        });
      }

      await saveTaskAction({
        title: payload.title,
        description: payload.details || undefined,
        dueAt: payload.dueAtIso,
        assignedPersonId: payload.assignedPersonIds[0] ?? null,
        assignedPersonIds: payload.assignedPersonIds,
        multiAssigneeMode: payload.multiAssigneeMode,
        linkedRecords,
      });

      const assigneeNames = payload.assignedPersonIds
        .map((pid) => {
          const emp = employees.find((e) => e.id === pid) ?? people.find((p) => p.id === pid);
          return emp ? personDisplayName(emp) : null;
        })
        .filter(Boolean)
        .join(', ');

      setAssignSubmitting(false);
      setAssignModalOpen(false);
      showToast(
        `Assigned "${payload.title}" to ${assigneeNames || 'selected staff'}`,
      );
    } catch {
      setAssignSubmitting(false);
      showToast('Could not assign task');
    }
  }

  const canSaveExisting =
    Boolean(clientId && title.trim() && practiceAreaId && workTypeSubcategoryId) && !saving;

  function resolveSavePayloadExtras() {
    const finalRoles = [...additionalTeamRoles];
    if (
      newTeamPersonId &&
      !finalRoles.some((r) => r.personId === newTeamPersonId)
    ) {
      const emp = employees.find((e) => e.id === newTeamPersonId);
      finalRoles.push({
        personId: newTeamPersonId,
        role:
          emp?.employment?.jobTitle?.trim() || emp?.jobTitle?.trim() || 'Team member',
      });
    }
    const finalTeamMemberIds = finalRoles.map((r) => r.personId);
    const finalTeamMemberRoles = Object.fromEntries(
      finalRoles.map((r) => [r.personId, r.role]),
    );
    let finalSupervisingPartnerId = supervisingPartnerId;
    let finalRelationshipPartnerId = relationshipPartnerId;
    for (const r of finalRoles) {
      if (r.role === 'Supervising partner') finalSupervisingPartnerId = r.personId;
      if (r.role === 'Relationship partner') finalRelationshipPartnerId = r.personId;
    }

    const finalOtherParties = [...otherParties];
    if (newPartyName.trim() && newPartyCapacityCodes.length > 0 && !editingPartyId) {
      const legacyRole = mapRelationshipToLegacyConflictRole(newPartyRelationshipCode);
      finalOtherParties.push({
        id: `party-${Date.now()}`,
        name: newPartyName.trim(),
        entityType: newPartyType,
        role: legacyRole,
        relationshipCode: newPartyRelationshipCode,
        capacityCodes: newPartyCapacityCodes,
        connectedToPartyId: ['CC', 'CO', 'TP'].includes(newPartyRelationshipCode)
          ? newPartyConnectedToId || null
          : null,
        identifiers: newPartyIdentifiers,
        alignment: getRelationshipAlignment(newPartyRelationshipCode),
        linkedRecordId: newPartyLinkedId ?? null,
        subtitle: formatPartyRoleDisplay(
          taxonomy,
          newPartyRelationshipCode,
          newPartyCapacityCodes,
          legacyRole,
        ),
      });
    }
    const matterParties: MatterParty[] = finalOtherParties.map(toMatterParty);

    const selectedStageId =
      values.find(
        (v) =>
          v.listKey === 'matter_stage' &&
          !v.parentId &&
          v.label.toLowerCase().startsWith(`stage ${stageIdx + 1}`),
      )?.id ?? existing?.stageId;

    const matchedSize = values.find(
      (v) =>
        v.listKey === 'matter_size' &&
        v.label.toLowerCase() === claimValue.trim().toLowerCase(),
    );
    const matchedOrigin = values.find(
      (v) =>
        v.listKey === 'origin' &&
        v.label.toLowerCase() === sourceOfWork.trim().toLowerCase(),
    );

    const finalCustomKeyDates = [...customKeyDates];
    if (newKeyDateValue.trim()) {
      finalCustomKeyDates.push({
        id: `RISK-DATE-${Date.now()}`,
        date: newKeyDateValue.trim(),
        label: newKeyDateLabel.trim() || 'Imminent deadline / key date',
      });
    }

    const updatedFieldValues: Record<string, unknown> = {
      ...fieldValues,
      'CORE-005': clientReference.trim(),
      claimValue: claimValue.trim(),
      responsibleOffice: responsibleOffice.trim(),
      sourceOfWork: sourceOfWork.trim(),
      teamMemberRoles: finalTeamMemberRoles,
      partiesEdited: true,
      additionalClientIds: clientIds.slice(1),
      clientCapacityCodes,
      jointClientCapacityCodes,
      instructingContactCapacityCodes,
      customKeyDates: finalCustomKeyDates,
      matterCosts: buildMatterCostsSnapshotPayload(),
      riskAssessment: {
        answers: riskAnswers,
        followUps: riskFollowUps,
        customKeyDates: finalCustomKeyDates,
      },
    };

    return {
      finalTeamMemberIds,
      finalSupervisingPartnerId,
      finalRelationshipPartnerId,
      finalOtherParties,
      matterParties,
      selectedStageId,
      matchedSizeId: matchedSize?.id ?? matterSizeId,
      matchedOriginId: matchedOrigin?.id ?? existing?.referrerTypeId ?? null,
      updatedFieldValues,
    };
  }

  // Save changes handler when editing an existing opened matter
  async function handleSaveExistingMatter() {
    if (!canSaveExisting || !existing) return;
    setSaving(true);
    setServerSaveErrors({});
    try {
      const {
        finalTeamMemberIds,
        finalSupervisingPartnerId,
        finalRelationshipPartnerId,
        finalOtherParties,
        matterParties,
        selectedStageId,
        matchedSizeId,
        matchedOriginId,
        updatedFieldValues,
      } = resolveSavePayloadExtras();

      const res = await saveMatterAction(
        {
          matterNumber: existing.matterNumber,
          title: title.trim(),
          shortDescription,
          clientId,
          additionalClientIds: clientIds.slice(1),
          practiceAreaId,
          workTypeSubcategoryId,
          owningDepartmentId: owningDepartmentId || undefined,
          owningTeamId: owningTeamId || undefined,
          typeBadge,
          matterTypeId,
          billingBasisId,
          clientTierId,
          clientSectorId,
          riskRatingId,
          matterSizeId: matchedSizeId,
          referrerTypeId: matchedOriginId,
          responsiblePartnerId,
          supervisingPartnerId: finalSupervisingPartnerId,
          leadFeeEarnerId,
          relationshipPartnerId: finalRelationshipPartnerId,
          teamMemberIds: finalTeamMemberIds,
          instructingContactId,
          billingContactId,
          parties: matterParties,
          stageId: selectedStageId,
          openedAt: openedAt ?? existing.openedAt ?? today,
          amlStatus,
          sourceOfFundsVerified,
          engagementLetterStatus,
          forumCourt,
          feeEstimateGbp: feeEstimateGbp ? Number(feeEstimateGbp) : null,
          agreedFeeCapGbp: agreedFeeCapGbp ? Number(agreedFeeCapGbp) : null,
          retainerMoniesOnAccountGbp: retainerMoniesOnAccountGbp
            ? Number(retainerMoniesOnAccountGbp)
            : null,
          targetCompletionAt,
          conflictCheckRecord: existing.conflictCheckRecord
            ? {
                status: existing.conflictCheckRecord.status,
                outcomeLabel: existing.conflictCheckRecord.outcomeLabel,
                declarationConfirmed: existing.conflictCheckRecord.declarationConfirmed,
                reviewerMessage: existing.conflictCheckRecord.reviewerMessage,
                lastRunAtDisplay: existing.conflictCheckRecord.lastRunAtDisplay,
                lastRunById: existing.conflictCheckRecord.lastRunById,
                lastRunByName: existing.conflictCheckRecord.lastRunByName,
                savedDraftAtDisplay: existing.conflictCheckRecord.savedDraftAtDisplay,
                submittedAtDisplay: existing.conflictCheckRecord.submittedAtDisplay,
                submittedByName: existing.conflictCheckRecord.submittedByName,
                parties: [...fixedClientParties, ...finalOtherParties],
                matches: existing.conflictCheckRecord.matches,
                runs: existing.conflictCheckRecord.runs,
                comments: existing.conflictCheckRecord.comments,
              }
            : undefined,
          fieldValues: updatedFieldValues,
        },
        { id: existing.id, expectedRowVersion: savedMatterRowVersion },
      );
      setSaving(false);
      if (res.errors && Object.keys(res.errors).length > 0) {
        setServerSaveErrors(res.errors);
        showToast(Object.values(res.errors)[0] ?? 'Could not save matter changes');
        return;
      }
      if (res.matter) {
        if (res.matter.rowVersion != null) {
          setSavedMatterRowVersion(res.matter.rowVersion);
        }
        showToast(`Saved changes to ${res.matter.matterNumber}`);
        router.push(`/matters/${res.matter.id}`);
        router.refresh();
      }
    } catch {
      setSaving(false);
      showToast('Could not save matter changes');
    }
  }

  // Submit handler (Cleared or Referred)
  async function handleSubmitMatter() {
    if (isEditingExistingMatter) {
      await handleSaveExistingMatter();
      return;
    }
    if (!canSubmit) return;
    setSaving(true);
    setServerSaveErrors({});
    try {
      const {
        finalTeamMemberIds,
        finalSupervisingPartnerId,
        finalRelationshipPartnerId,
        matterParties,
        matchedSizeId,
        matchedOriginId,
        updatedFieldValues,
      } = resolveSavePayloadExtras();

      // Intake stage complete → Stage 1 or Stage 2
      const intakeCompleteStageId =
        values.find(
          (v) =>
            v.listKey === 'matter_stage' &&
            !v.parentId &&
            v.label.startsWith('Stage 1'),
        )?.id ?? '';

      const cmiIncompleteStatusId =
        values.find((v) => v.listKey === 'matter_status' && v.label === 'CMI incomplete')
          ?.id ?? undefined;

      const resolvedSourceEnquiryId =
        existing?.sourceEnquiryId ??
        initialEnquiry?.id ??
        initialQuote?.linkedEnquiryId ??
        null;
      const resolvedSourceQuoteId =
        existing?.sourceQuoteId ?? initialQuote?.id ?? null;
      const resolvedEnquiryReceivedAt =
        existing?.enquiryReceivedAt ??
        (initialEnquiry?.receivedAt ? initialEnquiry.receivedAt.slice(0, 10) : undefined);
      const resolvedReferrerTypeId =
        matchedOriginId ?? initialEnquiry?.sourceId ?? null;
      const resolvedReferrerContactId =
        existing?.referrerContactId ?? initialEnquiry?.referrerPersonId ?? null;

      if (!isReferredOutcome) {
        // CLEARED ROUTE → Opens matter with status CMI incomplete (amber), stage Intake complete
        const snapshot = buildConflictRecordSnapshot('Cleared', 'Cleared by fee earner');
        const res = await saveMatterAction(
          {
            title: title.trim(),
            shortDescription,
            clientId,
            additionalClientIds: clientIds.slice(1),
            sourceEnquiryId: resolvedSourceEnquiryId,
            sourceQuoteId: resolvedSourceQuoteId,
            enquiryReceivedAt: resolvedEnquiryReceivedAt,
            matterStatusId: cmiIncompleteStatusId,
            practiceAreaId,
            workTypeSubcategoryId,
            owningDepartmentId: owningDepartmentId || undefined,
            owningTeamId: owningTeamId || undefined,
            typeBadge,
            matterTypeId,
            billingBasisId,
            clientTierId,
            clientSectorId,
            riskRatingId,
            matterSizeId: matchedSizeId,
            referrerTypeId: resolvedReferrerTypeId,
            referrerContactId: resolvedReferrerContactId,
            responsiblePartnerId,
            supervisingPartnerId: finalSupervisingPartnerId,
            leadFeeEarnerId,
            relationshipPartnerId: finalRelationshipPartnerId,
            teamMemberIds: finalTeamMemberIds,
            instructingContactId,
            billingContactId,
            parties: matterParties,
            conflictCheckDate: today,
            conflictNotes: matches
              .map((m) => `${m.partyName}: ${m.note}`)
              .filter(Boolean)
              .join(' | '),
            stageId: intakeCompleteStageId,
            openedAt: today,
            amlStatus: amlStatus || 'CMI incomplete',
            sourceOfFundsVerified,
            engagementLetterStatus,
            forumCourt,
            feeEstimateGbp: feeEstimateGbp ? Number(feeEstimateGbp) : null,
            agreedFeeCapGbp: agreedFeeCapGbp ? Number(agreedFeeCapGbp) : null,
            retainerMoniesOnAccountGbp: retainerMoniesOnAccountGbp
              ? Number(retainerMoniesOnAccountGbp)
              : null,
            targetCompletionAt,
            conflictCheckRecord: snapshot,
            fieldValues: updatedFieldValues,
          },
          {
            id: savedDraftMatterId ?? existing?.id,
            saveMode: 'submit_cleared',
            expectedRowVersion: savedMatterRowVersion,
          },
        );
        setSaving(false);
        if (res.errors && Object.keys(res.errors).length > 0) {
          setServerSaveErrors(res.errors);
          showToast(Object.values(res.errors)[0] ?? 'Could not open matter');
          return;
        }
        if (res.matter) {
          if (res.matter.rowVersion != null) {
            setSavedMatterRowVersion(res.matter.rowVersion);
          }
          if (typeof window !== 'undefined') {
            try {
              sessionStorage.removeItem(sessionDraftKey);
            } catch {
              // ignore
            }
          }
          showToast(
            initialQuote
              ? `Matter opened · Conflict check cleared · Quote ${initialQuote.reference} converted`
              : initialEnquiry
                ? `Matter opened · Conflict check cleared · ${initialEnquiry.reference} moved to Closed`
                : 'Matter opened · Conflict check cleared',
          );
          router.push(`/matters/${res.matter.id}`);
          router.refresh();
        }
      } else {
        // REFERRED ROUTE → Status "Pending conflict review", task created for risk team, read-only Referred view
        const snapshot = buildConflictRecordSnapshot(
          'Referred',
          'Referred to risk for review',
        );
        const res = await saveMatterAction(
          {
            title: title.trim(),
            shortDescription,
            clientId,
            additionalClientIds: clientIds.slice(1),
            sourceEnquiryId: resolvedSourceEnquiryId,
            sourceQuoteId: resolvedSourceQuoteId,
            enquiryReceivedAt: resolvedEnquiryReceivedAt,
            practiceAreaId,
            workTypeSubcategoryId,
            owningDepartmentId: owningDepartmentId || undefined,
            owningTeamId: owningTeamId || undefined,
            typeBadge,
            matterTypeId,
            billingBasisId,
            clientTierId,
            clientSectorId,
            riskRatingId,
            matterSizeId: matchedSizeId,
            referrerTypeId: resolvedReferrerTypeId,
            referrerContactId: resolvedReferrerContactId,
            responsiblePartnerId,
            supervisingPartnerId: finalSupervisingPartnerId,
            leadFeeEarnerId,
            relationshipPartnerId: finalRelationshipPartnerId,
            teamMemberIds: finalTeamMemberIds,
            instructingContactId,
            billingContactId,
            parties: matterParties,
            conflictCheckDate: today,
            conflictNotes: reviewerMessage,
            stageId: intakeCompleteStageId,
            feeEstimateGbp: feeEstimateGbp ? Number(feeEstimateGbp) : null,
            agreedFeeCapGbp: agreedFeeCapGbp ? Number(agreedFeeCapGbp) : null,
            retainerMoniesOnAccountGbp: retainerMoniesOnAccountGbp
              ? Number(retainerMoniesOnAccountGbp)
              : null,
            conflictCheckRecord: snapshot,
            fieldValues: updatedFieldValues,
          },
          {
            id: savedDraftMatterId ?? existing?.id,
            saveMode: 'submit_referred',
            expectedRowVersion: savedMatterRowVersion,
          },
        );
        setSaving(false);
        if (res.errors && Object.keys(res.errors).length > 0) {
          setServerSaveErrors(res.errors);
          showToast(Object.values(res.errors)[0] ?? 'Could not submit matter');
          return;
        }
        if (res.matter) {
          setSavedDraftMatterId(res.matter.id);
          if (res.matter.rowVersion != null) {
            setSavedMatterRowVersion(res.matter.rowVersion);
          }
          setSavedEstimateGbp(currentFormEstimateGbp);
        }
        setWorkflowState('referred_readonly');
        showToast(
          'Referred to Risk & Compliance · Task created for risk team · Status: Pending conflict review',
        );
      }
    } catch {
      setSaving(false);
      showToast('Could not submit matter');
    }
  }

  // Reviewer final decision handler
  async function handleReviewerFinalise(decision: 'approve' | 'decline') {
    setSaving(true);
    const hasConditions = matches.some(
      (m) =>
        m.disposition === 'potential_conflict' &&
        m.reviewerDecision === 'approve_with_conditions',
    );
    const nextStatus: ConflictCheckStatusPill =
      decision === 'approve' ? 'Approved' : 'Declined';
    const nextOutcome: ConflictCheckRecord['outcomeLabel'] =
      decision === 'approve'
        ? hasConditions
          ? 'Approved with conditions'
          : 'Approved by Risk & Compliance'
        : 'Declined by Risk & Compliance';

    const snapshot = buildConflictRecordSnapshot(nextStatus, nextOutcome);
    setWorkflowState(decision === 'approve' ? 'approved' : 'declined');

    let warningMsg: string | undefined;
    if (existing?.id) {
      const res = await updateMatterConflictRecordAction(existing.id, snapshot);
      if (res?.matter?.rowVersion != null) {
        setSavedMatterRowVersion(res.matter.rowVersion);
      }
      warningMsg = res?.warnings?.[0];
    }
    setSaving(false);
    showToast(
      warningMsg ??
        (decision === 'approve'
          ? `Conflict check ${hasConditions ? 'approved with conditions' : 'approved'} · Recorded on conflict check record`
          : 'Conflict check declined · Recorded on conflict check record'),
    );
  }

  function handleAddComment() {
    if (!newCommentText.trim()) return;
    const added: ConflictReviewerComment = {
      id: `c-${Date.now()}`,
      authorId: currentUser.id,
      authorName: personDisplayName(currentUser),
      authorRole:
        currentUser.employment?.jobTitle ||
        currentUser.jobTitle ||
        (isReviewerMode ? 'Risk & Compliance' : 'Fee earner'),
      atDisplay: formatDateTime(new Date().toISOString()),
      text: newCommentText.trim(),
    };
    setComments((prev) => [...prev, added]);
    setNewCommentText('');
  }

  function scrollToCard(
    ref: React.RefObject<HTMLElement | null>,
    sectionNumber?: 1 | 'costs' | 2 | 3 | 4 | 5 | 6,
  ) {
    if (sectionNumber === 1) setSection1Open(true);
    else if (sectionNumber === 'costs') setSectionCostsOpen(true);
    else if (sectionNumber === 2) setSection2Open(true);
    else if (sectionNumber === 3) setSection3Open(true);
    else if (sectionNumber === 4) setSection4Open(true);
    else if (sectionNumber === 5) setSection5Open(true);
    else if (sectionNumber === 6) setMoreDetailsOpen(true);
    setTimeout(() => {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 30);
  }

  const isReadOnlyFeeEarner =
    !isEditingExistingMatter && (workflowState !== 'editing' || isReviewerMode);

  // Dynamic optional fields from matrix
  const activeFieldGroups = useMemo(
    () => fieldGroupsForSubcategory(subcategoryLabel),
    [subcategoryLabel],
  );
  const activeSpecificFields = useMemo(
    () => specificFieldsForSubcategory(subcategoryLabel),
    [subcategoryLabel],
  );

  function setDynamicValue(fieldId: string, val: unknown) {
    setFieldValues((prev) => ({ ...prev, [fieldId]: val }));
  }

  function renderOptionalFieldControl(field: MatterModelField) {
    const raw = fieldValues[field.id];
    const strVal = raw == null ? '' : String(raw);
    const options = resolveFieldOptions(field, values, {
      practiceAreaId,
      jurisdictionGroupId: '',
      stageId: '',
    });

    if (field.dataType === 'Yes/No' || field.dataType === 'Yes/No/N/A') {
      return (
        <select
          className="field-select"
          value={strVal}
          onChange={(e) => setDynamicValue(field.id, e.target.value)}
        >
          <option value="">Unknown value</option>
          <option value="Yes">Yes</option>
          <option value="No">No</option>
          {field.dataType === 'Yes/No/N/A' ? <option value="N/A">N/A</option> : null}
        </select>
      );
    }
    if (field.dataType === 'Picklist' && options.length > 0) {
      return (
        <select
          className="field-select"
          value={strVal}
          onChange={(e) => setDynamicValue(field.id, e.target.value)}
        >
          <option value="">Unknown value</option>
          {options.map((opt) => (
            <option key={opt.id} value={opt.label}>
              {opt.label}
            </option>
          ))}
        </select>
      );
    }
    if (field.dataType === 'Date') {
      return (
        <input
          type="date"
          className="field-input"
          value={strVal}
          onChange={(e) => setDynamicValue(field.id, e.target.value)}
        />
      );
    }
    return (
      <input
        type="text"
        className="field-input"
        placeholder="Unknown value"
        value={strVal}
        onChange={(e) => setDynamicValue(field.id, e.target.value)}
      />
    );
  }

  return (
    <div className="new-enquiry-page" style={{ maxWidth: 1380 }}>
      {/* TWO-COLUMN LAYOUT: MAIN CONTENT LEFT (~2/3), STICKY RIGHT COLUMN (~1/3) */}
      <div className="person-form-layout">
        {/* ==================== LEFT MAIN COLUMN ==================== */}
        <div className="person-form-main-col">
          {/* PAGE HEADER (24px back link + 40px title row = 64px, matching 24px offset + 40px buttons on right) */}
          <div className="new-enquiry-header" style={{ marginBottom: 0 }}>
            <div>
              <a
                href={backTarget.href ?? '/matters'}
                onClick={handleNavigateBack}
                className="new-enquiry-back"
                style={{ display: 'block', lineHeight: '20px', marginBottom: 4 }}
              >
                {backTarget.label ? `← Back to ${backTarget.label}` : '← Back'}
              </a>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 10,
                  minHeight: 40,
                  marginTop: 0,
                }}
              >
                <h1 className="new-enquiry-title" style={{ fontSize: 26 }}>
                  {isEditingExistingMatter
                    ? `Edit matter · ${existing?.matterNumber}`
                    : 'Open a new matter'}
                </h1>
                {isEditingExistingMatter ? (
                  <StatusPill label="Open" tone="positive" />
                ) : workflowState === 'editing' && !isReviewerMode ? (
                  <StatusPill label="Draft" tone="neutral" />
                ) : workflowState === 'referred_readonly' || isReviewerMode ? (
                  <StatusPill label="Referred" tone="warning" />
                ) : workflowState === 'approved' ? (
                  <StatusPill label="Approved" tone="positive" />
                ) : (
                  <StatusPill label="Declined" tone="alert" />
                )}
                <span
                  style={{
                    fontSize: 13,
                    color: 'var(--text-secondary)',
                    fontWeight: 500,
                  }}
                >
                  {isEditingExistingMatter
                    ? `${clientDisplayName || 'Client'} · Stage ${stageIdx + 1} of ${stageSteps.length} (${stageSteps[stageIdx]?.name})`
                    : workflowState === 'referred_readonly' || isReviewerMode
                      ? 'Matter status: Pending conflict review · Reference assigned when matter opens'
                      : workflowState === 'approved'
                        ? 'Reference assigned · Ready to open'
                        : 'Reference assigned when matter opens'}
                </span>
              </div>
            </div>
          </div>

          {/* SAVED DRAFT REOPENED / CONVERSION BANNERS */}
          {initialQuote ? (
            <div
              className="conflict-banner"
              role="status"
              style={{
                background: 'rgba(15, 118, 110, 0.06)',
                border: '1px solid rgba(15, 118, 110, 0.28)',
                color: 'var(--text-primary)',
                flexDirection: 'column',
                alignItems: 'stretch',
                gap: 8,
                marginBottom: 0,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <CheckCircle2 size={16} color="var(--accent-primary, #0f766e)" style={{ flexShrink: 0 }} />
                  <span>
                    <strong>Converting from Accepted Quote {initialQuote.reference} (v{initialQuote.version})</strong> · {initialQuote.feeBasis} · {formatGbp(initialQuote.feeAmountExVat)} ex VAT. Client, work type, fee earner, fee basis, agreed fee, disbursements, scope and assumptions have been pre-filled below.
                  </span>
                </div>
                <Link
                  href={`/quotes/${initialQuote.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn--secondary btn--sm"
                  style={{ borderRadius: 999, flexShrink: 0 }}
                  title="Opens quote in a new browser tab so you can return to this new matter screen without losing any entered details"
                >
                  View quote ↗
                </Link>
              </div>
              {initialQuote.disbursements.length > 0 || initialQuote.assumptions ? (
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', paddingLeft: 26 }}>
                  {initialQuote.disbursements.length > 0 ? (
                    <div>
                      <strong>Disbursements:</strong>{' '}
                      {initialQuote.disbursements
                        .map((d) => `${d.description} (${formatGbp(d.amountExVat)}${d.vatApplicable ? ' + VAT' : ''})`)
                        .join(' · ')}
                    </div>
                  ) : null}
                  {initialQuote.assumptions ? (
                    <div style={{ marginTop: 2 }}>
                      <strong>Assumptions &amp; exclusions:</strong> {initialQuote.assumptions}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {initialEnquiry ? (
            <div
              className="conflict-banner"
              role="status"
              style={{
                background: 'rgba(15, 118, 110, 0.06)',
                border: '1px solid rgba(15, 118, 110, 0.28)',
                color: 'var(--text-primary)',
                marginBottom: 0,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <CheckCircle2 size={16} color="var(--accent-primary, #0f766e)" style={{ flexShrink: 0 }} />
                <span>
                  <strong>Converting from Enquiry {initialEnquiry.reference}</strong> ({[initialEnquiry.firstName, initialEnquiry.lastName].filter(Boolean).join(' ')}{initialEnquiry.callingOnBehalfOf ? ` · ${initialEnquiry.callingOnBehalfOf}` : ''}). Details from the enquiry have been pre-filled below, and the full enquiry record &amp; contact log will be attached as the first activity on the matter.
                </span>
              </div>
              <Link
                href={`/enquiries/${initialEnquiry.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn--secondary btn--sm"
                style={{ borderRadius: 999, flexShrink: 0 }}
                title="Opens enquiry in a new browser tab so you can return to this new matter screen without losing any entered details"
              >
                View enquiry ↗
              </Link>
            </div>
          ) : null}

          {conversionConflictWarningNotice ? (
            <div
              className="conflict-banner conflict-banner--amber"
              role="status"
              data-testid="conversion-conflict-warning-banner"
              style={{ marginBottom: 0 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <AlertTriangle size={16} style={{ flexShrink: 0 }} />
                <span>{conversionConflictWarningNotice}</span>
              </div>
            </div>
          ) : null}

          {reopenedDraftBanner ? (
            <div className="conflict-banner conflict-banner--amber" role="status" style={{ marginBottom: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Clock size={16} style={{ flexShrink: 0 }} />
                <span>
                  <strong>Saved {reopenedDraftBanner}.</strong> Results may be out of date. Run again.
                </span>
              </div>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                style={{ borderRadius: 999 }}
                onClick={handleRunConflictSearch}
              >
                <RefreshCw size={13} />
                <span>Run conflict search</span>
              </button>
            </div>
          ) : null}

          {/* REFERRED / REVIEWER BANNER */}
          {!isEditingExistingMatter && workflowState === 'referred_readonly' && !isReviewerMode ? (
            <div className="conflict-banner conflict-banner--amber" role="status" style={{ marginBottom: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Lock size={16} style={{ flexShrink: 0 }} />
                <span>
                  <strong>Submitted and referred to Risk &amp; Compliance</strong>.
                  Matter status is <strong>Pending conflict review</strong> and a task has been assigned
                  to the Risk team. Snapshot is locked read-only.
                </span>
              </div>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                style={{ borderRadius: 999 }}
                onClick={() => setIsReviewerMode(true)}
              >
                <ShieldAlert size={14} />
                <span>Switch to Risk / Compliance reviewer view</span>
              </button>
            </div>
          ) : null}

          {!isEditingExistingMatter && isReviewerMode ? (
            <div className="conflict-banner conflict-banner--reviewer" role="status" style={{ marginBottom: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <ShieldCheck size={17} style={{ flexShrink: 0 }} />
                <span>
                  <strong>Viewing as Risk / Compliance ({personDisplayName(currentUser)}).</strong> Fee earner inputs
                  are read-only. Review each flagged potential conflict below and record your decision.
                </span>
              </div>
              <StatusPill label="Risk / Compliance review" tone="warning" />
            </div>
          ) : null}

          {/* ================================================================
              AI DOCUMENT & EMAIL EXTRACTION PANEL
              ================================================================ */}
          {!isReadOnlyFeeEarner &&
          enableAiMatterExtraction &&
          aiProviderChoice === 'anthropic' ? (
            <section
              className="new-enquiry-card"
              aria-labelledby="ai-intake-heading"
              style={{
                border: aiExtractionResult
                  ? '1.5px solid rgba(15, 118, 110, 0.45)'
                  : '1px solid var(--border-subtle)',
                background: aiExtractionResult
                  ? 'linear-gradient(180deg, rgba(15, 118, 110, 0.04) 0%, var(--bg-surface) 100%)'
                  : 'var(--bg-surface)',
              }}
            >
              <div
                className="new-enquiry-card__top"
                style={{
                  cursor: 'pointer',
                  marginBottom: aiPanelOpen ? undefined : 0,
                }}
                onClick={() => setAiPanelOpen((o) => !o)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Sparkles size={16} color="var(--accent-primary, #0f766e)" />
                  <h2 id="ai-intake-heading" className="new-enquiry-card__label">
                    PRE-FILL FROM EMAILS &amp; DOCUMENTS (AI)
                  </h2>
                  {aiExtractionResult ? (
                    <StatusPill
                      label={
                        aiExtractionResult.modelName === 'local-fallback'
                          ? '✓ Pre-filled (local fallback)'
                          : '✓ Pre-filled (Claude AI)'
                      }
                      tone={
                        aiExtractionResult.modelName === 'local-fallback'
                          ? 'warning'
                          : 'positive'
                      }
                    />
                  ) : stagedDocs.length > 0 ? (
                    <StatusPill
                      label={`${stagedDocs.length} ${
                        stagedDocs.length === 1 ? 'document' : 'documents'
                      } ready`}
                      tone="neutral"
                    />
                  ) : (
                    <span
                      style={{
                        fontSize: 12,
                        color: 'var(--text-secondary)',
                        fontWeight: 500,
                      }}
                    >
                      Upload emails (.eml, .msg) or documents (.pdf, .docx, .txt) to auto-complete Sections 1–6
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    aria-expanded={aiPanelOpen}
                    onClick={(e) => {
                      e.stopPropagation();
                      setAiPanelOpen((o) => !o);
                    }}
                  >
                    {aiPanelOpen ? (
                      <>
                        <span>Minimise</span>
                        <ChevronDown size={15} />
                      </>
                    ) : (
                      <>
                        <span>Maximise</span>
                        <ChevronRight size={15} />
                      </>
                    )}
                  </button>
                </div>
              </div>

              {aiPanelOpen ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {/* File Dropzone + Upload + Paste + Claude API Key controls */}
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setIsDraggingFiles(true);
                    }}
                    onDragLeave={() => setIsDraggingFiles(false)}
                    onDrop={async (e) => {
                      e.preventDefault();
                      setIsDraggingFiles(false);
                      if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
                        const droppedFiles = await readDroppedEntries(e.dataTransfer.items);
                        if (droppedFiles.length > 0) {
                          await processUploadedFiles(droppedFiles);
                          return;
                        }
                      }
                      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                        await processUploadedFiles(Array.from(e.dataTransfer.files));
                      }
                    }}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                      padding: '14px 16px',
                      borderRadius: 10,
                      background: isDraggingFiles
                        ? 'rgba(15, 118, 110, 0.08)'
                        : 'var(--bg-surface-subtle)',
                      border: isDraggingFiles
                        ? '1.5px dashed var(--accent-primary, #0f766e)'
                        : '1px dashed var(--border-default)',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        flexWrap: 'wrap',
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                          Drop emails, documents, or a folder here, or select files / folder to upload
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                          Supports Outlook emails (<code>.msg</code>, <code>.eml</code>), PDFs (<code>.pdf</code>), Word documents (<code>.docx</code>), and text notes (<code>.txt</code>)
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <input
                          ref={fileUploadInputRef}
                          type="file"
                          multiple
                          accept=".eml,.msg,.txt,.md,.pdf,.doc,.docx,.rtf,.csv,.html"
                          style={{ display: 'none' }}
                          onChange={handleFileUploadChange}
                        />
                        <input
                          ref={folderUploadInputRef}
                          type="file"
                          multiple
                          {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
                          style={{ display: 'none' }}
                          onChange={handleFileUploadChange}
                        />
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          onClick={() => fileUploadInputRef.current?.click()}
                        >
                          <Upload size={13} />
                          <span>Select files</span>
                        </button>
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          onClick={() => folderUploadInputRef.current?.click()}
                        >
                          <FolderOpen size={13} />
                          <span>Select folder</span>
                        </button>
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          onClick={() => setShowPasteInput((s) => !s)}
                        >
                          <Plus size={13} />
                          <span>Paste email / attendance note</span>
                        </button>
                      </div>
                    </div>

                    {/* Paste email / note input box */}
                    {showPasteInput ? (
                      <div
                        style={{
                          padding: '12px',
                          borderRadius: 8,
                          background: 'var(--bg-surface)',
                          border: '1px solid var(--border-default)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8,
                        }}
                      >
                        <input
                          type="text"
                          className="field-input"
                          placeholder="Document or email title (e.g. FW: Client instruction email.eml)"
                          value={pastedDocName}
                          onChange={(e) => setPastedDocName(e.target.value)}
                        />
                        <textarea
                          className="field-input"
                          rows={5}
                          placeholder="Paste email headers & body or attendance note text here..."
                          value={pastedDocContent}
                          onChange={(e) => setPastedDocContent(e.target.value)}
                          style={{ resize: 'vertical' }}
                        />
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => setShowPasteInput(false)}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="btn btn--primary btn--sm"
                            disabled={!pastedDocContent.trim()}
                            onClick={handleAddPastedDocument}
                          >
                            Add to Staged Documents
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  {/* Staged Documents List + Preview */}
                  {stagedDocs.length > 0 ? (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                        padding: '12px 14px',
                        borderRadius: 10,
                        border: '1px solid var(--border-subtle)',
                        background: 'var(--bg-surface)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                          flexWrap: 'wrap',
                        }}
                      >
                        <span style={{ fontSize: 12.5, fontWeight: 700 }}>
                          Staged Emails &amp; Documents ({stagedDocs.length})
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => {
                              setStagedDocs([]);
                              setPreviewDocId(null);
                              setAiExtractionResult(null);
                              setAiErrorMsg(null);
                              setAiCitations({});
                            }}
                          >
                            Clear all
                          </button>
                          <button
                            type="button"
                            className="btn btn--primary btn--sm"
                            disabled={extractingAi}
                            onClick={() => void handleRunAiExtraction()}
                          >
                            <Sparkles size={13} />
                            <span>
                              {extractingAi
                                ? 'Extracting data with Claude…'
                                : 'Extract & Pre-fill Matter Form'}
                            </span>
                          </button>
                        </div>
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {stagedDocs.map((doc) => {
                          const isPreviewOpen = previewDocId === doc.id;
                          return (
                            <div
                              key={doc.id}
                              style={{
                                border: '1px solid var(--border-subtle)',
                                borderRadius: 8,
                                padding: '8px 10px',
                                background: 'var(--bg-surface-subtle)',
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  gap: 8,
                                }}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  {doc.kind === 'email' ? (
                                    <Mail size={14} color="var(--text-secondary)" />
                                  ) : (
                                    <FileText size={14} color="var(--text-secondary)" />
                                  )}
                                  <span style={{ fontWeight: 600, fontSize: 13 }}>
                                    {doc.name}
                                  </span>
                                  {doc.sizeLabel ? (
                                    <span
                                      style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}
                                    >
                                      ({doc.sizeLabel})
                                    </span>
                                  ) : null}
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <button
                                    type="button"
                                    className="btn btn--ghost btn--sm"
                                    style={{ height: 24, fontSize: 12, padding: '0 8px' }}
                                    onClick={() =>
                                      setPreviewDocId(isPreviewOpen ? null : doc.id)
                                    }
                                  >
                                    {isPreviewOpen ? 'Hide preview' : 'Preview'}
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn--ghost btn--sm"
                                    style={{ height: 24, padding: '0 6px' }}
                                    onClick={() =>
                                      setStagedDocs((prev) =>
                                        prev.filter((d) => d.id !== doc.id),
                                      )
                                    }
                                  >
                                    <X size={13} />
                                  </button>
                                </div>
                              </div>
                              {isPreviewOpen ? (
                                <pre
                                  style={{
                                    marginTop: 8,
                                    padding: '10px 12px',
                                    borderRadius: 6,
                                    background: 'var(--bg-surface)',
                                    border: '1px solid var(--border-subtle)',
                                    fontSize: 12,
                                    lineHeight: 1.5,
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-word',
                                    maxHeight: 240,
                                    overflowY: 'auto',
                                    fontFamily: 'inherit',
                                  }}
                                >
                                  {doc.content}
                                </pre>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  {/* Error Banner if API Key missing or call failed */}
                  {aiErrorMsg ? (
                    <div
                      style={{
                        padding: '10px 12px',
                        borderRadius: 8,
                        background: 'rgba(217, 48, 37, 0.08)',
                        border: '1px solid rgba(217, 48, 37, 0.3)',
                        fontSize: 12.5,
                        color: '#d93025',
                      }}
                    >
                      <strong>Extraction error:</strong> {aiErrorMsg}
                    </div>
                  ) : null}

                  {aiExtractionResult ? (() => {
                    const activeAiMatter =
                      aiExtractionResult.matters?.[selectedAiMatterIdx] ?? null;
                    const dispWorkType =
                      activeAiMatter?.workType?.label ||
                      aiExtractionResult.workType?.label ||
                      '—';
                    const dispSubType =
                      activeAiMatter?.workType?.subTypeDetail ||
                      aiExtractionResult.workType?.subTypeDetail ||
                      '';
                    const dispRisks =
                      activeAiMatter?.riskSuggestions ??
                      aiExtractionResult.riskSuggestions;
                    const dispKeyDates =
                      activeAiMatter?.keyDates ?? aiExtractionResult.keyDates;
                    const dispParties =
                      activeAiMatter?.otherParties ?? aiExtractionResult.otherParties;
                    const dispFeeEst =
                      activeAiMatter?.feeEstimateGbp ?? aiExtractionResult.feeEstimateGbp;
                    const dispClientRef =
                      activeAiMatter?.clientReference ??
                      aiExtractionResult.clientReference;
                    const dispForum =
                      activeAiMatter?.forumCourt ?? aiExtractionResult.forumCourt;
                    const dispCaseNo =
                      activeAiMatter?.caseNumber ?? aiExtractionResult.caseNumber;
                    const dispClaimVal =
                      activeAiMatter?.claimValue ?? aiExtractionResult.claimValue;
                    const dispAcas =
                      activeAiMatter?.acasEc ?? aiExtractionResult.acasEc;
                    const dispFunding =
                      activeAiMatter?.funding ?? aiExtractionResult.funding;
                    const dispConf =
                      activeAiMatter?.confidentiality ??
                      aiExtractionResult.confidentiality;
                    const dispFe =
                      activeAiMatter?.leadFeeEarner ??
                      aiExtractionResult.leadFeeEarner;

                    return (
                    <div
                      style={{
                        padding: '12px 14px',
                        borderRadius: 10,
                        background: 'rgba(15, 118, 110, 0.06)',
                        border: '1px solid rgba(15, 118, 110, 0.28)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                          flexWrap: 'wrap',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <CheckCircle2 size={16} color="#0f766e" />
                          <span style={{ fontWeight: 700, fontSize: 13.5 }}>
                            Extraction Applied to Form
                          </span>
                          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                            ·{' '}
                            {aiExtractionResult.modelName === 'local-fallback'
                              ? 'Local fallback (offline / deterministic)'
                              : aiExtractionResult.modelName}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            style={{ height: 26, fontSize: 12 }}
                            onClick={() => setShowAiDetailedReport((s) => !s)}
                          >
                            {showAiDetailedReport
                              ? 'Hide detailed report'
                              : 'Show detailed report'}
                          </button>
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            style={{ height: 26, fontSize: 12 }}
                            onClick={() => {
                              setSection1Open(true);
                              setSection2Open(true);
                              setSection3Open(true);
                              setMoreDetailsOpen(true);
                            }}
                          >
                            Expand pre-filled sections (1, 2, 3 &amp; 6)
                          </button>
                        </div>
                      </div>

                      {/* Multi-Matter Switcher if multiple matters were detected in the document pack */}
                      {aiExtractionResult.matters &&
                      aiExtractionResult.matters.length > 1 ? (
                        <div
                          style={{
                            padding: '8px 10px',
                            borderRadius: 8,
                            background: 'var(--bg-surface)',
                            border: '1px solid rgba(15, 118, 110, 0.3)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 10,
                            flexWrap: 'wrap',
                          }}
                        >
                          <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                            {aiExtractionResult.matters.length} separate matters identified in documents — select which matter to pre-fill:
                          </div>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {aiExtractionResult.matters.map((mOpt, mIdx) => {
                              const isSelected = selectedAiMatterIdx === mIdx;
                              return (
                                <button
                                  key={mOpt.matterRef || mIdx}
                                  type="button"
                                  className={
                                    isSelected
                                      ? 'btn btn--primary btn--sm'
                                      : 'btn btn--secondary btn--sm'
                                  }
                                  style={{ height: 28, fontSize: 12 }}
                                  onClick={() => {
                                    applyAiExtractionToForm(aiExtractionResult, mIdx);
                                    showToast(
                                      `Switched form pre-fill to ${mOpt.matterRef}`,
                                    );
                                  }}
                                >
                                  <span>
                                    {mOpt.matterRef}:{' '}
                                    {mOpt.workType?.label ||
                                      mOpt.title?.value?.slice(0, 32) ||
                                      `Matter ${mIdx + 1}`}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}

                      <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.45 }}>
                        {aiExtractionResult.summary}
                      </div>

                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                          gap: 8,
                          fontSize: 12.5,
                        }}
                      >
                        <div
                          style={{
                            padding: '8px 10px',
                            borderRadius: 8,
                            background: 'var(--bg-surface)',
                            border: '1px solid var(--border-subtle)',
                          }}
                        >
                          <div style={{ fontWeight: 700, marginBottom: 3 }}>
                            Section 1 · Matter Details &amp; Team
                          </div>
                          <div style={{ color: 'var(--text-secondary)' }}>
                            Client:{' '}
                            <strong style={{ color: 'var(--text-primary)' }}>
                              {aiExtractionResult.client?.matchedRecordName ||
                                aiExtractionResult.client?.name ||
                                '—'}
                            </strong>{' '}
                            {aiExtractionResult.client?.companyNumber
                              ? `(Co. ${aiExtractionResult.client.companyNumber})`
                              : ''}
                          </div>
                          <div style={{ color: 'var(--text-secondary)' }}>
                            Work type:{' '}
                            <strong style={{ color: 'var(--text-primary)' }}>
                              {dispWorkType}
                            </strong>
                          </div>
                          {dispFe?.name ? (
                            <div style={{ color: 'var(--text-secondary)' }}>
                              Fee earner:{' '}
                              <strong style={{ color: 'var(--text-primary)' }}>
                                {dispFe.name}
                              </strong>
                            </div>
                          ) : null}
                        </div>

                        <div
                          style={{
                            padding: '8px 10px',
                            borderRadius: 8,
                            background: 'var(--bg-surface)',
                            border: '1px solid var(--border-subtle)',
                          }}
                        >
                          <div style={{ fontWeight: 700, marginBottom: 3 }}>
                            Section 2 · Risk Assessment
                          </div>
                          <div style={{ color: 'var(--text-secondary)' }}>
                            <strong style={{ color: 'var(--text-primary)' }}>
                              {dispRisks.length}
                            </strong>{' '}
                            risk questions answered with citations
                          </div>
                          <div style={{ color: 'var(--text-secondary)' }}>
                            <strong style={{ color: 'var(--text-primary)' }}>
                              {dispKeyDates.length}
                            </strong>{' '}
                            key dates added to critical dates list
                          </div>
                        </div>

                        <div
                          style={{
                            padding: '8px 10px',
                            borderRadius: 8,
                            background: 'var(--bg-surface)',
                            border: '1px solid var(--border-subtle)',
                          }}
                        >
                          <div style={{ fontWeight: 700, marginBottom: 3 }}>
                            Section 3 · Matter Parties
                          </div>
                          <div style={{ color: 'var(--text-secondary)' }}>
                            <strong style={{ color: 'var(--text-primary)' }}>
                              {dispParties.length}
                            </strong>{' '}
                            parties staged for Conflict Check
                          </div>
                          {activeAiMatter?.clientRole || aiExtractionResult.clientRole ? (
                            <div style={{ color: 'var(--text-secondary)' }}>
                              Client role:{' '}
                              <strong style={{ color: 'var(--text-primary)' }}>
                                {activeAiMatter?.clientRole ||
                                  aiExtractionResult.clientRole}
                              </strong>
                            </div>
                          ) : null}
                        </div>

                        <div
                          style={{
                            padding: '8px 10px',
                            borderRadius: 8,
                            background: 'var(--bg-surface)',
                            border: '1px solid var(--border-subtle)',
                          }}
                        >
                          <div style={{ fontWeight: 700, marginBottom: 3 }}>
                            Section 6 · More Details
                          </div>
                          <div style={{ color: 'var(--text-secondary)' }}>
                            Fee estimate:{' '}
                            <strong style={{ color: 'var(--text-primary)' }}>
                              {dispFeeEst?.value
                                ? `£${Number(dispFeeEst.value).toLocaleString('en-GB')}`
                                : dispFunding?.feeEstimate || '—'}
                            </strong>{' '}
                            · PO / Ref:{' '}
                            <strong style={{ color: 'var(--text-primary)' }}>
                              {dispClientRef?.value || '—'}
                            </strong>
                          </div>
                          {dispForum?.value || dispCaseNo?.value ? (
                            <div style={{ color: 'var(--text-secondary)' }}>
                              {[dispForum?.value, dispCaseNo?.value]
                                .filter(Boolean)
                                .join(' · ')}
                            </div>
                          ) : null}
                        </div>
                      </div>

                      {/* Expandable Detailed Intelligence Breakdown */}
                      {showAiDetailedReport ? (
                        <div
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 10,
                            padding: '12px',
                            borderRadius: 8,
                            background: 'var(--bg-surface)',
                            border: '1px solid var(--border-subtle)',
                            fontSize: 12.5,
                          }}
                        >
                          <div
                            style={{
                              display: 'grid',
                              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                              gap: 12,
                            }}
                          >
                            {/* Client & Contacts Detail */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 2 }}>
                                Client &amp; Contacts
                              </div>
                              {aiExtractionResult.client?.registeredOffice ? (
                                <div>
                                  <span style={{ color: 'var(--text-secondary)' }}>Registered office: </span>
                                  <span>{aiExtractionResult.client.registeredOffice}</span>
                                </div>
                              ) : null}
                              {aiExtractionResult.client?.tradingAddress ? (
                                <div>
                                  <span style={{ color: 'var(--text-secondary)' }}>Trading address: </span>
                                  <span>{aiExtractionResult.client.tradingAddress}</span>
                                </div>
                              ) : null}
                              {aiExtractionResult.client?.existingClientNote ? (
                                <div>
                                  <span style={{ color: 'var(--text-secondary)' }}>Existing client: </span>
                                  <span>{aiExtractionResult.client.existingClientNote}</span>
                                </div>
                              ) : null}
                              {aiExtractionResult.instructingContact ? (
                                <div>
                                  <span style={{ color: 'var(--text-secondary)' }}>Instructing contact: </span>
                                  <strong>{aiExtractionResult.instructingContact.name}</strong>
                                  {[
                                    aiExtractionResult.instructingContact.jobTitle,
                                    aiExtractionResult.instructingContact.email,
                                    aiExtractionResult.instructingContact.phone,
                                    aiExtractionResult.instructingContact.mobile,
                                  ]
                                    .filter(Boolean)
                                    .map((x) => ` · ${x}`)
                                    .join('')}
                                </div>
                              ) : null}
                              {aiExtractionResult.billingContact ? (
                                <div>
                                  <span style={{ color: 'var(--text-secondary)' }}>Billing contact: </span>
                                  <strong>{aiExtractionResult.billingContact.name}</strong>
                                  {[
                                    aiExtractionResult.billingContact.jobTitle,
                                    aiExtractionResult.billingContact.email,
                                    aiExtractionResult.billingContact.phone,
                                  ]
                                    .filter(Boolean)
                                    .map((x) => ` · ${x}`)
                                    .join('')}
                                </div>
                              ) : null}
                            </div>

                            {/* Billing & Funding / Insurance Detail */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 2 }}>
                                Billing, Budget &amp; Funding / Insurance
                              </div>
                              {aiExtractionResult.billing?.invoiceEntity ? (
                                <div>
                                  <span style={{ color: 'var(--text-secondary)' }}>Invoice entity: </span>
                                  <strong>{aiExtractionResult.billing.invoiceEntity}</strong>
                                </div>
                              ) : null}
                              {aiExtractionResult.billing?.invoiceAddress ? (
                                <div>
                                  <span style={{ color: 'var(--text-secondary)' }}>Invoice address: </span>
                                  <span>{aiExtractionResult.billing.invoiceAddress}</span>
                                </div>
                              ) : null}
                              {aiExtractionResult.billing?.invoiceEmail ? (
                                <div>
                                  <span style={{ color: 'var(--text-secondary)' }}>Invoice email: </span>
                                  <span>{aiExtractionResult.billing.invoiceEmail}</span>
                                </div>
                              ) : null}
                              {aiExtractionResult.billing?.budgetSummary ? (
                                <div>
                                  <span style={{ color: 'var(--text-secondary)' }}>Budget: </span>
                                  <span>{aiExtractionResult.billing.budgetSummary}</span>
                                </div>
                              ) : null}
                              {aiExtractionResult.billing?.paymentTerms ? (
                                <div>
                                  <span style={{ color: 'var(--text-secondary)' }}>Payment terms: </span>
                                  <span>{aiExtractionResult.billing.paymentTerms}</span>
                                </div>
                              ) : null}
                              {dispFunding ? (
                                <div>
                                  <span style={{ color: 'var(--text-secondary)' }}>Funding: </span>
                                  <strong>{dispFunding.type}</strong>
                                  {dispFunding.insurer ? ` · Insurer: ${dispFunding.insurer}` : ''}
                                  {dispFunding.policyNumber ? ` · Policy: ${dispFunding.policyNumber}` : ''}
                                  {dispFunding.excess ? ` · Excess: ${dispFunding.excess}` : ''}
                                  {dispFunding.insurerRef ? ` · Ref: ${dispFunding.insurerRef}` : ''}
                                </div>
                              ) : null}
                            </div>

                            {/* Matter Specifics: Tribunal, Case No, ACAS, Confidentiality */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 2 }}>
                                {activeAiMatter?.matterRef || 'Matter'} Specifics
                              </div>
                              {dispSubType ? (
                                <div>
                                  <span style={{ color: 'var(--text-secondary)' }}>Sub-type: </span>
                                  <span>{dispSubType}</span>
                                </div>
                              ) : null}
                              {dispClaimVal?.value ? (
                                <div>
                                  <span style={{ color: 'var(--text-secondary)' }}>Claim value: </span>
                                  <strong>{dispClaimVal.value}</strong>
                                </div>
                              ) : null}
                              {dispAcas ? (
                                <div>
                                  <span style={{ color: 'var(--text-secondary)' }}>ACAS EC: </span>
                                  <strong>{dispAcas.certificate}</strong>
                                  {dispAcas.dayA ? ` · Day A: ${dispAcas.dayA}` : ''}
                                  {dispAcas.dayB ? ` · Day B: ${dispAcas.dayB}` : ''}
                                </div>
                              ) : null}
                              {dispConf?.value ? (
                                <div>
                                  <span style={{ color: 'var(--text-secondary)' }}>Confidentiality: </span>
                                  <strong style={{ color: '#b45309' }}>{dispConf.value}</strong>
                                </div>
                              ) : null}
                              {dispKeyDates.length > 0 ? (
                                <div style={{ marginTop: 2 }}>
                                  <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>
                                    Key dates ({dispKeyDates.length}):
                                  </span>
                                  <ul style={{ margin: '3px 0 0 16px', padding: 0 }}>
                                    {dispKeyDates.map((kd, kIdx) => (
                                      <li key={kIdx} style={{ marginBottom: 2 }}>
                                        <strong>{kd.date}</strong> — {kd.label}
                                        {kd.sourceDoc ? (
                                          <span style={{ color: 'var(--text-secondary)', fontSize: 11.5 }}>
                                            {' '}
                                            [{kd.sourceDoc}]
                                          </span>
                                        ) : null}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              ) : null}
                            </div>
                          </div>

                          {/* Extracted Parties for Conflict Check */}
                          {dispParties.length > 0 ? (
                            <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
                              <div style={{ fontWeight: 700, marginBottom: 6 }}>
                                Extracted Parties for Conflict Check ({dispParties.length})
                              </div>
                              <div
                                style={{
                                  display: 'grid',
                                  gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
                                  gap: 6,
                                }}
                              >
                                {dispParties.map((pt, pIdx) => (
                                  <div
                                    key={pIdx}
                                    style={{
                                      padding: '6px 8px',
                                      borderRadius: 6,
                                      background: 'var(--bg-surface-subtle)',
                                      border: '1px solid var(--border-subtle)',
                                      display: 'flex',
                                      flexDirection: 'column',
                                      gap: 2,
                                    }}
                                  >
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                                      <strong style={{ fontSize: 12.5 }}>{pt.name}</strong>
                                      <span
                                        style={{
                                          fontSize: 10.5,
                                          fontWeight: 700,
                                          padding: '1px 6px',
                                          borderRadius: 999,
                                          background: 'var(--bg-surface)',
                                          border: '1px solid var(--border-default)',
                                        }}
                                      >
                                        {pt.relationshipCode}
                                      </span>
                                    </div>
                                    {pt.roleDescription ? (
                                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                                        {pt.roleDescription}
                                      </div>
                                    ) : null}
                                    {pt.contactDetails || pt.address ? (
                                      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                                        {[pt.contactDetails, pt.address].filter(Boolean).join(' · ')}
                                      </div>
                                    ) : null}
                                    {pt.sourceDoc ? (
                                      <div style={{ fontSize: 10.5, color: 'var(--accent-primary, #0f766e)', fontWeight: 600 }}>
                                        Source: {pt.sourceDoc}
                                      </div>
                                    ) : null}
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    );
                  })() : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {/* ================================================================
              CARD 1 · MATTER DETAILS (4 required)
              ================================================================ */}
          <section
            ref={card1Ref}
            className="new-enquiry-card"
            aria-labelledby="card-1-heading"
          >
            <div
              className="new-enquiry-card__top"
              style={{
                cursor: 'pointer',
                marginBottom: section1Open ? undefined : 0,
              }}
              onClick={() => setSection1Open((o) => !o)}
            >
              <h2 id="card-1-heading" className="new-enquiry-card__label">
                1 · MATTER DETAILS &amp; TEAM
              </h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {isCard1Complete ? (
                  <StatusPill label="✓ Complete" tone="positive" />
                ) : (
                  <span className="conflict-req-pill">
                    {requiredCard1Total - mandatoryDetailsDoneCount} of {requiredCard1Total}{' '}
                    required
                  </span>
                )}
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  aria-expanded={section1Open}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSection1Open((o) => !o);
                  }}
                >
                  {section1Open ? (
                    <>
                      <span>Minimise</span>
                      <ChevronDown size={15} />
                    </>
                  ) : (
                    <>
                      <span>Maximise</span>
                      <ChevronRight size={15} />
                    </>
                  )}
                </button>
              </div>
            </div>

            {section1Open ? (
            <div className="form-grid" style={{ gap: '14px 16px' }}>
              {/* Client (multi-client table + '+' lookup button) */}
              <div className="field-group field-group--full">
                <label className="field-label">
                  Client <span className="field-required">*</span>
                </label>

                {selectedClients.length > 0 ? (
                  <div
                    style={{
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 10,
                      overflow: 'hidden',
                      marginBottom: 8,
                    }}
                  >
                    <table
                      className="enquiries-table"
                      style={{ width: '100%', borderCollapse: 'collapse' }}
                    >
                      <thead>
                        <tr>
                          <th style={{ padding: '7px 12px', textAlign: 'left' }}>Name</th>
                          <th style={{ padding: '7px 12px', textAlign: 'left' }}>Type</th>
                          <th style={{ padding: '7px 12px', textAlign: 'left' }}>
                            Organisation / Details
                          </th>
                          {!isReadOnlyFeeEarner ? (
                            <th style={{ padding: '7px 12px', width: 48, textAlign: 'right' }}>
                              <span className="sr-only">Remove</span>
                            </th>
                          ) : null}
                        </tr>
                      </thead>
                      <tbody>
                        {selectedClients.map((c, idx) => {
                          const hasMissing = c.missingClientFields.length > 0;
                          return (
                            <tr
                              key={c.id}
                              title={
                                hasMissing
                                  ? `Click to complete client details (${c.missingClientFields.join(', ')})`
                                  : `Click to view or edit ${c.name}`
                              }
                              style={{
                                borderTop: '1px solid var(--border-subtle)',
                                background: hasMissing
                                  ? 'rgba(217, 48, 37, 0.04)'
                                  : 'var(--bg-surface)',
                                cursor: isReadOnlyFeeEarner ? 'default' : 'pointer',
                              }}
                              onClick={() => {
                                if (!isReadOnlyFeeEarner) {
                                  openEditClientModal(c.id);
                                }
                              }}
                            >
                              <td style={{ padding: '8px 12px' }}>
                                <div
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 8,
                                    flexWrap: 'wrap',
                                    fontWeight: 600,
                                    color: 'var(--text-primary)',
                                  }}
                                >
                                  {hasMissing ? (
                                    <AlertCircle
                                      size={16}
                                      color="#d93025"
                                      aria-label={`Details needed for ${c.name}`}
                                      style={{ flexShrink: 0 }}
                                    />
                                  ) : c.entityType === 'organisation' ? (
                                    <Building2 size={14} color="var(--text-secondary)" />
                                  ) : (
                                    <User size={14} color="var(--text-secondary)" />
                                  )}
                                  <span
                                    style={{
                                      textDecoration: !isReadOnlyFeeEarner
                                        ? 'underline'
                                        : 'none',
                                      textDecorationColor: hasMissing
                                        ? '#d93025'
                                        : 'var(--border-default)',
                                      textUnderlineOffset: 3,
                                    }}
                                  >
                                    {c.name}
                                  </span>
                                  {idx === 0 && selectedClients.length > 1 ? (
                                    <StatusPill label="Lead client" tone="positive" />
                                  ) : null}
                                  {hasMissing ? (
                                    <span
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 4,
                                        fontSize: 11.5,
                                        fontWeight: 700,
                                        color: '#d93025',
                                        background: 'rgba(217, 48, 37, 0.1)',
                                        border: '1px solid rgba(217, 48, 37, 0.28)',
                                        borderRadius: 999,
                                        padding: '2px 8px',
                                      }}
                                    >
                                      ! Details needed: {c.missingClientFields.join(', ')}
                                    </span>
                                  ) : null}
                                </div>
                              </td>
                              <td style={{ padding: '8px 12px' }}>
                                <StatusPill
                                  label={
                                    c.entityType === 'organisation' ? 'Organisation' : 'Person'
                                  }
                                  tone="neutral"
                                />
                              </td>
                              <td
                                style={{
                                  padding: '8px 12px',
                                  color: 'var(--text-secondary)',
                                  fontSize: 12.5,
                                }}
                              >
                                {c.entityType === 'person'
                                  ? [
                                      c.organisationName !== '—' ? c.organisationName : null,
                                      c.details || null,
                                    ]
                                      .filter(Boolean)
                                      .join(' · ') || '—'
                                  : c.details || '—'}
                              </td>
                              {!isReadOnlyFeeEarner ? (
                                <td
                                  style={{ padding: '8px 12px', textAlign: 'right' }}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <button
                                    type="button"
                                    className="btn btn--ghost btn--sm"
                                    aria-label={`Remove ${c.name} as client`}
                                    style={{ padding: '0 6px', height: 26 }}
                                    onClick={() => handleRemoveClientFromMatter(c.id)}
                                  >
                                    <X size={14} />
                                  </button>
                                </td>
                              ) : null}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : null}

                {!isReadOnlyFeeEarner ? (
                  <div>
                    <button
                      type="button"
                      id="nm-add-client-btn"
                      aria-label="Add client"
                      title="Look up or add a client to this matter"
                      className="btn btn--secondary btn--sm"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        borderRadius: 999,
                        padding: '5px 12px',
                        fontWeight: 600,
                      }}
                      onClick={openClientLookupModal}
                    >
                      <Plus size={15} strokeWidth={2.5} />
                      <span>
                        {selectedClients.length === 0 ? 'Add client' : 'Add another client'}
                      </span>
                    </button>
                  </div>
                ) : null}
              </div>

              {/* Instructing contact (only shown when client(s) are under 18 or are an organisation) */}
              {showInstructingContact ? (
                <div className="field-group">
                  <label className="field-label" htmlFor="nm-instructing">
                    Instructing contact <span className="field-required">*</span>
                  </label>
                  <select
                    id="nm-instructing"
                    className="field-select"
                    value={instructingContactId ?? ''}
                    disabled={isReadOnlyFeeEarner}
                    onChange={(e) => {
                      setInstructingContactId(e.target.value || null);
                      if (hasRunSearch) setPartiesChangedSinceSearch(true);
                    }}
                  >
                    <option value="">Select instructing contact…</option>
                    {clientContacts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {personDisplayName(p)}
                        {p.jobTitle ? ` — ${p.jobTitle}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {/* Matter description (full width) */}
              <div className="field-group field-group--full">
                <label className="field-label" htmlFor="nm-description">
                  Matter description <span className="field-required">*</span>
                </label>
                <input
                  id="nm-description"
                  type="text"
                  className="field-input"
                  value={title}
                  disabled={isReadOnlyFeeEarner}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>

              {/* Department and work type (two linked dropdowns) */}
              <div className="field-group">
                <label className="field-label" htmlFor="nm-department">
                  Department <span className="field-required">*</span>
                </label>
                <select
                  id="nm-department"
                  className="field-select"
                  value={practiceAreaId}
                  disabled={isReadOnlyFeeEarner}
                  onChange={(e) => {
                    const nextPa = e.target.value;
                    setPracticeAreaId(nextPa);
                    if (
                      (!isEditingExistingMatter || canReassignOwnership) &&
                      !owningDepartmentExplicitlyChosen &&
                      !owningTeamId
                    ) {
                      const nextOrgDept = resolveOrgDepartment(nextPa, orgStructure);
                      const nextOwningDeptId = nextOrgDept?.id ?? '';
                      setOwningDepartmentId(nextOwningDeptId);
                    }
                    const firstSub = values
                      .filter(
                        (v) =>
                          v.listKey === 'work_type' &&
                          v.parentId === nextPa &&
                          v.active,
                      )
                      .sort((a, b) => a.sortOrder - b.sortOrder)[0];
                    setWorkTypeSubcategoryId(
                      isEditingExistingMatter ? (firstSub?.id ?? '') : '',
                    );

                    const nextPartnerOpts = filterEmployeesForMatterDepartment({
                      employees,
                      practiceAreaId: nextPa,
                      practiceAreas,
                      includeSupervisingPartners: true,
                    });
                    const nextFeOpts = filterEmployeesForMatterDepartment({
                      employees,
                      practiceAreaId: nextPa,
                      practiceAreas,
                      includeSupervisingPartners: false,
                    });
                    const nextPartnerIds = new Set(nextPartnerOpts.map((p) => p.id));
                    const nextFeIds = new Set(nextFeOpts.map((p) => p.id));

                    if (
                      nextPa === userMatterDefaults.practiceAreaId &&
                      userMatterDefaults.responsiblePartnerId &&
                      nextPartnerIds.has(userMatterDefaults.responsiblePartnerId)
                    ) {
                      if (!responsiblePartnerId || !nextPartnerIds.has(responsiblePartnerId)) {
                        setResponsiblePartnerId(userMatterDefaults.responsiblePartnerId);
                      }
                    } else if (responsiblePartnerId && !nextPartnerIds.has(responsiblePartnerId)) {
                      setResponsiblePartnerId(null);
                    }

                    if (
                      nextPa === userMatterDefaults.practiceAreaId &&
                      userMatterDefaults.leadFeeEarnerId &&
                      nextFeIds.has(userMatterDefaults.leadFeeEarnerId)
                    ) {
                      if (!leadFeeEarnerId || !nextFeIds.has(leadFeeEarnerId)) {
                        setLeadFeeEarnerId(userMatterDefaults.leadFeeEarnerId);
                      }
                    } else if (leadFeeEarnerId && !nextFeIds.has(leadFeeEarnerId)) {
                      setLeadFeeEarnerId(null);
                    }

                    if (newTeamPersonId && !nextFeIds.has(newTeamPersonId)) {
                      setNewTeamPersonId('');
                    }
                  }}
                >
                  <option value="">Select department…</option>
                  {practiceAreas.map((pa) => (
                    <option key={pa.id} value={pa.id}>
                      {pa.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="nm-worktype">
                  Work type <span className="field-required">*</span>
                </label>
                <select
                  id="nm-worktype"
                  className="field-select"
                  value={workTypeSubcategoryId}
                  disabled={isReadOnlyFeeEarner}
                  onChange={(e) => setWorkTypeSubcategoryId(e.target.value)}
                >
                  <option value="">Select work type…</option>
                  {subcategoriesForPractice.map((sub) => (
                    <option key={sub.id} value={sub.id}>
                      {sub.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="nm-owning-department">
                  Owning department (document routing)
                </label>
                <select
                  id="nm-owning-department"
                  className="field-select"
                  value={owningDepartmentId}
                  disabled={isReadOnlyFeeEarner || (isEditingExistingMatter && !canReassignOwnership)}
                  onChange={(e) => {
                    const nextDeptId = e.target.value;
                    setOwningDepartmentExplicitlyChosen(Boolean(nextDeptId));
                    setOwningDepartmentId(nextDeptId);
                    if (
                      owningTeamId &&
                      !orgStructure.teamsOrPracticeGroups.some(
                        (t) => t.id === owningTeamId && t.parentDepartmentId === nextDeptId,
                      )
                    ) {
                      setOwningTeamId('');
                    }
                  }}
                >
                  <option value="">Select owning department…</option>
                  {orgStructure.departments
                    .filter((d) => d.active || d.id === owningDepartmentId)
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} ({d.code}){!d.active ? ' (Inactive)' : ''}
                      </option>
                    ))}
                </select>
                {isEditingExistingMatter && !canReassignOwnership ? (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                    Reassigning an opened matter’s owning department requires matter ownership reassignment permission.
                  </div>
                ) : null}
                {serverSaveErrors.owningDepartmentId ? (
                  <div className="field-error" style={{ color: 'var(--status-alert)', fontSize: 12, marginTop: 4 }}>
                    {serverSaveErrors.owningDepartmentId}
                  </div>
                ) : null}
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="nm-owning-team">
                  Owning team / practice group (document routing)
                </label>
                <select
                  id="nm-owning-team"
                  className="field-select"
                  value={owningTeamId}
                  disabled={isReadOnlyFeeEarner || (isEditingExistingMatter && !canReassignOwnership)}
                  onChange={(e) => setOwningTeamId(e.target.value)}
                >
                  <option value="">Select owning team…</option>
                  {availableOwningTeams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.code})
                    </option>
                  ))}
                </select>
                {isEditingExistingMatter && !canReassignOwnership ? (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                    Reassigning an opened matter’s owning team requires matter ownership reassignment permission.
                  </div>
                ) : null}
                {serverSaveErrors.owningTeamId ? (
                  <div className="field-error" style={{ color: 'var(--status-alert)', fontSize: 12, marginTop: 4 }}>
                    {serverSaveErrors.owningTeamId}
                  </div>
                ) : null}
              </div>
              {serverSaveErrors.costsGovernance ||
              serverSaveErrors.extensions ||
              serverSaveErrors.keyDates ||
              serverSaveErrors.conflict ||
              serverSaveErrors.permission ||
              serverSaveErrors.access ? (
                <div
                  className="field-group field-group--full"
                  role="alert"
                  style={{
                    padding: '10px 12px',
                    borderRadius: 8,
                    background: 'rgba(220, 38, 38, 0.08)',
                    border: '1px solid var(--status-alert)',
                    color: 'var(--status-alert)',
                    fontSize: 13,
                  }}
                >
                  {serverSaveErrors.costsGovernance ||
                    serverSaveErrors.extensions ||
                    serverSaveErrors.keyDates ||
                    serverSaveErrors.conflict ||
                    serverSaveErrors.permission ||
                    serverSaveErrors.access}
                </div>
              ) : null}

              {/* Responsible partner and fee earner */}
              <div className="field-group">
                <label className="field-label" htmlFor="nm-partner">
                  Responsible partner
                </label>
                <select
                  id="nm-partner"
                  className="field-select"
                  value={responsiblePartnerId ?? ''}
                  disabled={isReadOnlyFeeEarner}
                  onChange={(e) => setResponsiblePartnerId(e.target.value || null)}
                >
                  <option value="">Select partner…</option>
                  {responsiblePartnerOptions.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {personDisplayName(emp)} ({emp.jobTitle})
                    </option>
                  ))}
                </select>
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="nm-fee-earner">
                  Fee earner
                </label>
                <select
                  id="nm-fee-earner"
                  className="field-select"
                  value={leadFeeEarnerId ?? ''}
                  disabled={isReadOnlyFeeEarner}
                  onChange={(e) => setLeadFeeEarnerId(e.target.value || null)}
                >
                  <option value="">Select fee earner…</option>
                  {feeEarnerOptions.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {personDisplayName(emp)} ({emp.jobTitle})
                    </option>
                  ))}
                </select>
              </div>

              {/* OTHER TEAM MEMBERS */}
              <div
                className="field-group field-group--full"
                style={{
                  marginTop: 4,
                  paddingTop: 12,
                  borderTop: '1px solid var(--border-subtle)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 8,
                  }}
                >
                  <label className="field-label" style={{ marginBottom: 0 }}>
                    Other team members ({additionalTeamRoles.length})
                  </label>
                </div>

                {additionalTeamRoles.length > 0 ? (
                  <ul
                    className="worklist"
                    style={{
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 10,
                      padding: '0 12px',
                      marginBottom: 10,
                    }}
                  >
                    {additionalTeamRoles.map((tr) => {
                      const emp = employees.find((e) => e.id === tr.personId);
                      const empName = emp ? personDisplayName(emp) : tr.personId;
                      const empJobTitle =
                        emp?.employment?.jobTitle || emp?.jobTitle || tr.role || 'Team member';
                      const empDept =
                        resolveOrgDepartment(emp?.employment?.departmentId || emp?.departmentId)
                          ?.name ||
                        resolveLabel(values, emp?.departmentId) ||
                        '';
                      return (
                        <li key={tr.personId} className="worklist-row">
                          <div className="worklist-main">
                            <div className="worklist-title" style={{ marginBottom: 0 }}>
                              {empName}
                            </div>
                            <div className="worklist-meta">
                              {[empJobTitle, empDept].filter(Boolean).join(' · ')}
                            </div>
                          </div>
                          <div
                            className="worklist-right"
                            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                          >
                            {!isReadOnlyFeeEarner ? (
                              <button
                                type="button"
                                className="btn btn--ghost btn--sm"
                                aria-label={`Remove ${empName} from team`}
                                style={{ padding: '0 6px', height: 28 }}
                                onClick={() => handleRemoveTeamRole(tr.personId)}
                              >
                                <X size={14} />
                              </button>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}

                {!isReadOnlyFeeEarner ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'flex-end',
                      flexWrap: 'wrap',
                      gap: 10,
                    }}
                  >
                    <div style={{ flex: '1 1 220px' }}>
                      <label className="field-label" htmlFor="nm-add-team-person">
                        Add team member
                      </label>
                      <select
                        id="nm-add-team-person"
                        className="field-select"
                        value={newTeamPersonId}
                        onChange={(e) => setNewTeamPersonId(e.target.value)}
                      >
                        <option value="">
                          {practiceAreaId
                            ? 'Select colleague in department…'
                            : 'Select department first…'}
                        </option>
                        {teamMemberDepartmentOptions.map((emp) => (
                          <option key={emp.id} value={emp.id}>
                            {personDisplayName(emp)} (
                            {emp.employment?.jobTitle || emp.jobTitle || 'Team member'})
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      type="button"
                      className="btn btn--secondary"
                      style={{ borderRadius: 999, height: 38 }}
                      disabled={!newTeamPersonId}
                      onClick={() => handleAddTeamRole()}
                    >
                      <Plus size={15} />
                      <span>Add team member</span>
                    </button>

                    {/* Internal people search (employees across all departments) */}
                    <div style={{ position: 'relative', flex: '1 1 260px' }}>
                      <label className="field-label" htmlFor="nm-team-employee-search">
                        Internal people search (employees)
                      </label>
                      <input
                        id="nm-team-employee-search"
                        type="text"
                        className="field-input"
                        placeholder="Search all employees by name, job title or department…"
                        value={teamEmployeeSearchQuery}
                        onFocus={() => setShowTeamEmployeeSuggestions(true)}
                        onBlur={() =>
                          setTimeout(() => setShowTeamEmployeeSuggestions(false), 180)
                        }
                        onChange={(e) => {
                          setTeamEmployeeSearchQuery(e.target.value);
                          setShowTeamEmployeeSuggestions(true);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            const firstAvailable = teamEmployeeSearchResults.find(
                              (emp) =>
                                !additionalTeamRoles.some((r) => r.personId === emp.id),
                            );
                            if (firstAvailable) {
                              handleAddTeamRole(firstAvailable.id);
                            }
                          }
                        }}
                      />
                      {showTeamEmployeeSuggestions &&
                      teamEmployeeSearchQuery.trim().length > 0 ? (
                        <div className="conflict-typeahead-menu" role="listbox">
                          <div className="conflict-typeahead-header">
                            Matching internal employees ({teamEmployeeSearchResults.length})
                          </div>
                          {teamEmployeeSearchResults.length === 0 ? (
                            <div
                              style={{
                                padding: '10px 12px',
                                fontSize: 12.5,
                                color: 'var(--text-secondary)',
                              }}
                            >
                              No matching employees found.
                            </div>
                          ) : (
                            teamEmployeeSearchResults.map((emp) => {
                              const empName = personDisplayName(emp);
                              const empJobTitle =
                                emp.employment?.jobTitle || emp.jobTitle || 'Team member';
                              const empDept =
                                resolveOrgDepartment(
                                  emp.employment?.departmentId || emp.departmentId,
                                )?.name ||
                                resolveLabel(values, emp.departmentId) ||
                                '';
                              const alreadyInTeam = additionalTeamRoles.some(
                                (r) => r.personId === emp.id,
                              );
                              return (
                                <button
                                  key={emp.id}
                                  type="button"
                                  className="conflict-typeahead-item"
                                  disabled={alreadyInTeam}
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    if (!alreadyInTeam) {
                                      handleAddTeamRole(emp.id);
                                    }
                                  }}
                                >
                                  <div>
                                    <div style={{ fontWeight: 700, fontSize: 13 }}>
                                      {empName}
                                    </div>
                                    <div
                                      style={{
                                        fontSize: 11.5,
                                        color: 'var(--text-secondary)',
                                      }}
                                    >
                                      {[empJobTitle, empDept].filter(Boolean).join(' · ')}
                                    </div>
                                  </div>
                                  <StatusPill
                                    label={alreadyInTeam ? 'Added' : '+ Add'}
                                    tone={alreadyInTeam ? 'positive' : 'neutral'}
                                  />
                                </button>
                              );
                            })
                          )}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
            ) : null}
          </section>

          {/* ================================================================
              CARD 2 · MATTER COSTS (Work basis, App / PMS Rates Table, Total estimate, Disbursements & Payment on Account)
              ================================================================ */}
          <section
            ref={cardCostsRef}
            className="new-enquiry-card"
            aria-labelledby="card-costs-heading"
          >
            <div
              className="new-enquiry-card__top"
              style={{
                cursor: 'pointer',
                marginBottom: sectionCostsOpen ? undefined : 0,
              }}
              onClick={() => setSectionCostsOpen((o) => !o)}
            >
              <div>
                <h2 id="card-costs-heading" className="new-enquiry-card__label">
                  2 · {(costsConfig.sectionTitle || 'MATTER COSTS').toUpperCase()}
                </h2>
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  flexWrap: 'wrap',
                }}
              >
                <StatusPill
                  label={
                    WORK_BASIS_OPTIONS.find((opt) => opt.key === costWorkBasis)?.label ??
                    'Hourly rates'
                  }
                  tone="neutral"
                />
                {numericFeeEstimateGbp != null ? (
                  <StatusPill
                    label={`Est. ${formatGbp(numericFeeEstimateGbp)}${
                      disbursementsTotalGbp > 0
                        ? ` + ${formatGbp(disbursementsTotalGbp)} disb.`
                        : ''
                    }`}
                    tone="neutral"
                  />
                ) : null}
                {matterCostsCompletion.isComplete ? (
                  <StatusPill label="✓ Complete" tone="positive" />
                ) : (
                  <span className="conflict-req-pill">
                    {matterCostsCompletion.remainingCount} of{' '}
                    {matterCostsCompletion.totalRequired} to complete
                  </span>
                )}
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  aria-expanded={sectionCostsOpen}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSectionCostsOpen((o) => !o);
                  }}
                >
                  {sectionCostsOpen ? (
                    <>
                      <span>Minimise</span>
                      <ChevronDown size={15} />
                    </>
                  ) : (
                    <>
                      <span>Maximise</span>
                      <ChevronRight size={15} />
                    </>
                  )}
                </button>
              </div>
            </div>

            {sectionCostsOpen ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                {/* Client Customisation & Rate Source Banner */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: 10,
                    padding: '10px 14px',
                    borderRadius: 10,
                    background: 'var(--bg-surface-subtle)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: 'var(--text-primary)',
                      }}
                    >
                      Client rate configuration:{' '}
                      <span style={{ color: 'var(--accent-primary, #0f766e)' }}>
                        {costsConfig.clientProfileName}
                      </span>
                    </span>
                    <StatusPill
                      label={
                        costsConfig.pmsLinkActive
                          ? 'PMS Rates Link: Available'
                          : 'Application Rates Table (PMS ready)'
                      }
                      tone={costsConfig.pmsLinkActive ? 'positive' : 'neutral'}
                    />
                  </div>
                  <Link
                    href="/admin/rates-and-costs"
                    className="panel-link"
                    style={{ fontSize: 12.5, fontWeight: 600 }}
                  >
                    Customise rate tables &amp; PMS link in Admin →
                  </Link>
                </div>

                {/* 1. Work / Fee Basis */}
                <div className="field-group">
                  <label className="field-label">
                    1. Is the work Fixed fee, Hourly rates, or Capped?{' '}
                    <span className="field-required">*</span>
                  </label>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
                      gap: 10,
                      marginTop: 4,
                    }}
                    role="radiogroup"
                    aria-label="Matter work fee basis"
                  >
                    {WORK_BASIS_OPTIONS.map((opt) => {
                      const active = costWorkBasis === opt.key;
                      return (
                        <button
                          key={opt.key}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          disabled={isReadOnlyFeeEarner}
                          onClick={() => handleSelectWorkBasis(opt.key)}
                          style={{
                            textAlign: 'left',
                            padding: '12px 14px',
                            borderRadius: 10,
                            border: active
                              ? '2px solid var(--accent-primary, #0f766e)'
                              : '1px solid var(--border-default)',
                            background: active
                              ? 'rgba(15, 118, 110, 0.07)'
                              : 'var(--bg-surface)',
                            cursor: isReadOnlyFeeEarner ? 'default' : 'pointer',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 4,
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: 8,
                            }}
                          >
                            <span
                              style={{
                                fontSize: 13.5,
                                fontWeight: 700,
                                color: 'var(--text-primary)',
                              }}
                            >
                              {opt.label}
                            </span>
                            {active ? (
                              <Check
                                size={15}
                                color="var(--accent-primary, #0f766e)"
                                strokeWidth={2.6}
                              />
                            ) : null}
                          </div>
                          <span
                            style={{
                              fontSize: 12,
                              color: 'var(--text-secondary)',
                              lineHeight: 1.35,
                            }}
                          >
                            {opt.description}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 2. Hourly Rates Table Lookup (shown when Hourly rates or Capped is selected) */}
                {costWorkBasis === 'hourly_rates' || costWorkBasis === 'capped' ? (
                  <div
                    style={{
                      padding: '14px 16px',
                      borderRadius: 10,
                      border: '1px solid var(--border-subtle)',
                      background: 'var(--bg-surface-subtle)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 14,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        flexWrap: 'wrap',
                        gap: 10,
                      }}
                    >
                      <div>
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 700,
                            color: 'var(--text-primary)',
                          }}
                        >
                          Hourly Rates Table Lookup (Partner, Associate &amp; Trainee)
                        </div>
                        <div
                          style={{
                            fontSize: 12,
                            color: 'var(--text-secondary)',
                            marginTop: 2,
                          }}
                        >
                          Rates are looked up automatically for the selected Department from the Application Rates Table or PMS Rate Table (when linked).
                        </div>
                      </div>

                      {/* Source switcher: Application Rates Table vs PMS Rates Lookup */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          flexWrap: 'wrap',
                        }}
                      >
                        <div
                          className="conflict-seg-group"
                          role="group"
                          aria-label="Rates lookup source"
                        >
                          <button
                            type="button"
                            className={`conflict-seg-btn ${
                              costRateSource === 'app_table'
                                ? 'conflict-seg-btn--active'
                                : ''
                            }`}
                            style={{ height: 28, padding: '0 10px', fontSize: 12 }}
                            disabled={isReadOnlyFeeEarner}
                            onClick={() =>
                              applyRateCardToState(
                                selectedRateCard?.id ?? costRateCardId,
                                'app_table',
                              )
                            }
                          >
                            Application Rates Table
                          </button>
                          <button
                            type="button"
                            className={`conflict-seg-btn ${
                              costRateSource === 'pms'
                                ? 'conflict-seg-btn--active'
                                : ''
                            }`}
                            style={{ height: 28, padding: '0 10px', fontSize: 12 }}
                            disabled={isReadOnlyFeeEarner}
                            onClick={() =>
                              applyRateCardToState(
                                selectedRateCard?.id ?? costRateCardId,
                                'pms',
                              )
                            }
                          >
                            PMS Rates Table{costsConfig.pmsLinkActive ? ' (Linked)' : ' (Preview)'}
                          </button>
                        </div>

                        {costRateSource === 'custom_override' ? (
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            style={{ borderRadius: 999, height: 28, fontSize: 12 }}
                            onClick={() =>
                              applyRateCardToState(
                                selectedRateCard?.id ?? costRateCardId,
                                costsConfig.pmsLinkActive &&
                                  costsConfig.rateSourceMode !== 'app_table'
                                  ? 'pms'
                                  : 'app_table',
                              )
                            }
                          >
                            <RefreshCw size={12} />
                            <span>Reset to rate table</span>
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {/* Rate card selector */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        flexWrap: 'wrap',
                        gap: 12,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          flex: '1 1 280px',
                        }}
                      >
                        <label
                          htmlFor="nm-cost-rate-card"
                          style={{
                            fontSize: 12.5,
                            fontWeight: 600,
                            color: 'var(--text-secondary)',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          Rate card:
                        </label>
                        <select
                          id="nm-cost-rate-card"
                          className="field-select"
                          style={{ maxWidth: 380, height: 34, fontSize: 13 }}
                          disabled={isReadOnlyFeeEarner}
                          value={selectedRateCard?.id ?? costRateCardId}
                          onChange={(e) =>
                            applyRateCardToState(
                              e.target.value,
                              costRateSource === 'pms' ? 'pms' : 'app_table',
                            )
                          }
                        >
                          {activeRateCards.map((rc) => (
                            <option key={rc.id} value={rc.id}>
                              {rc.name} ({rc.pmsDepartmentCode || 'Standard'})
                            </option>
                          ))}
                        </select>
                      </div>

                      <StatusPill
                        label={
                          costRateSource === 'pms'
                            ? 'Source: PMS Fee Earner Rates'
                            : costRateSource === 'custom_override'
                              ? 'Source: Matter Custom Rate Override'
                              : 'Source: Application Rates Table'
                        }
                        tone={
                          costRateSource === 'pms'
                            ? 'positive'
                            : costRateSource === 'custom_override'
                              ? 'warning'
                              : 'neutral'
                        }
                      />
                    </div>

                    {/* Partner / Associate / Trainee Hourly Rates Table */}
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(195px, 1fr))',
                        gap: 12,
                      }}
                    >
                      {/* Partner Rate */}
                      <div
                        style={{
                          padding: '12px 14px',
                          borderRadius: 8,
                          background: 'var(--bg-surface)',
                          border: '1px solid var(--border-subtle)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                          }}
                        >
                          <label
                            htmlFor="nm-rate-partner"
                            style={{
                              fontSize: 12.5,
                              fontWeight: 700,
                              color: 'var(--text-primary)',
                            }}
                          >
                            Partner (£/hr)
                          </label>
                          <span
                            style={{
                              fontSize: 11,
                              color: 'var(--text-muted)',
                              fontWeight: 600,
                            }}
                          >
                            ex VAT
                          </span>
                        </div>
                        <input
                          id="nm-rate-partner"
                          type="number"
                          min="0"
                          step="5"
                          className="field-input"
                          style={{ fontWeight: 700, fontSize: 15 }}
                          disabled={
                            isReadOnlyFeeEarner || !costsConfig.allowMatterRateOverrides
                          }
                          value={partnerRateGbp}
                          onChange={(e) => {
                            setPartnerRateGbp(e.target.value);
                            setCostRateSource('custom_override');
                          }}
                        />
                        {selectedRateCard ? (
                          <div
                            style={{
                              fontSize: 11.5,
                              color: 'var(--text-secondary)',
                              display: 'flex',
                              justifyContent: 'space-between',
                              gap: 6,
                            }}
                          >
                            <span>App table: £{selectedRateCard.partnerRateGbp}/hr</span>
                            <span>
                              PMS:{' '}
                              {selectedRateCard.pmsPartnerRateGbp != null
                                ? `£${selectedRateCard.pmsPartnerRateGbp}/hr`
                                : '—'}
                            </span>
                          </div>
                        ) : null}
                      </div>

                      {/* Associate Rate */}
                      <div
                        style={{
                          padding: '12px 14px',
                          borderRadius: 8,
                          background: 'var(--bg-surface)',
                          border: '1px solid var(--border-subtle)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                          }}
                        >
                          <label
                            htmlFor="nm-rate-associate"
                            style={{
                              fontSize: 12.5,
                              fontWeight: 700,
                              color: 'var(--text-primary)',
                            }}
                          >
                            Associate (£/hr)
                          </label>
                          <span
                            style={{
                              fontSize: 11,
                              color: 'var(--text-muted)',
                              fontWeight: 600,
                            }}
                          >
                            ex VAT
                          </span>
                        </div>
                        <input
                          id="nm-rate-associate"
                          type="number"
                          min="0"
                          step="5"
                          className="field-input"
                          style={{ fontWeight: 700, fontSize: 15 }}
                          disabled={
                            isReadOnlyFeeEarner || !costsConfig.allowMatterRateOverrides
                          }
                          value={associateRateGbp}
                          onChange={(e) => {
                            setAssociateRateGbp(e.target.value);
                            setCostRateSource('custom_override');
                          }}
                        />
                        {selectedRateCard ? (
                          <div
                            style={{
                              fontSize: 11.5,
                              color: 'var(--text-secondary)',
                              display: 'flex',
                              justifyContent: 'space-between',
                              gap: 6,
                            }}
                          >
                            <span>App table: £{selectedRateCard.associateRateGbp}/hr</span>
                            <span>
                              PMS:{' '}
                              {selectedRateCard.pmsAssociateRateGbp != null
                                ? `£${selectedRateCard.pmsAssociateRateGbp}/hr`
                                : '—'}
                            </span>
                          </div>
                        ) : null}
                      </div>

                      {/* Trainee Rate */}
                      <div
                        style={{
                          padding: '12px 14px',
                          borderRadius: 8,
                          background: 'var(--bg-surface)',
                          border: '1px solid var(--border-subtle)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                          }}
                        >
                          <label
                            htmlFor="nm-rate-trainee"
                            style={{
                              fontSize: 12.5,
                              fontWeight: 700,
                              color: 'var(--text-primary)',
                            }}
                          >
                            Trainee (£/hr)
                          </label>
                          <span
                            style={{
                              fontSize: 11,
                              color: 'var(--text-muted)',
                              fontWeight: 600,
                            }}
                          >
                            ex VAT
                          </span>
                        </div>
                        <input
                          id="nm-rate-trainee"
                          type="number"
                          min="0"
                          step="5"
                          className="field-input"
                          style={{ fontWeight: 700, fontSize: 15 }}
                          disabled={
                            isReadOnlyFeeEarner || !costsConfig.allowMatterRateOverrides
                          }
                          value={traineeRateGbp}
                          onChange={(e) => {
                            setTraineeRateGbp(e.target.value);
                            setCostRateSource('custom_override');
                          }}
                        />
                        {selectedRateCard ? (
                          <div
                            style={{
                              fontSize: 11.5,
                              color: 'var(--text-secondary)',
                              display: 'flex',
                              justifyContent: 'space-between',
                              gap: 6,
                            }}
                          >
                            <span>App table: £{selectedRateCard.traineeRateGbp}/hr</span>
                            <span>
                              PMS:{' '}
                              {selectedRateCard.pmsTraineeRateGbp != null
                                ? `£${selectedRateCard.pmsTraineeRateGbp}/hr`
                                : '—'}
                            </span>
                          </div>
                        ) : null}
                      </div>

                      {/* Any Client-Customised Additional Grades */}
                      {customGradeRates.map((cg) => (
                        <div
                          key={cg.id}
                          style={{
                            padding: '12px 14px',
                            borderRadius: 8,
                            background: 'var(--bg-surface)',
                            border: '1px solid var(--border-subtle)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 6,
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                            }}
                          >
                            <label
                              style={{
                                fontSize: 12.5,
                                fontWeight: 700,
                                color: 'var(--text-primary)',
                              }}
                            >
                              {cg.label} (£/hr)
                            </label>
                            <span
                              style={{
                                fontSize: 11,
                                color: 'var(--text-muted)',
                                fontWeight: 600,
                              }}
                            >
                              Custom grade
                            </span>
                          </div>
                          <input
                            type="number"
                            min="0"
                            step="5"
                            className="field-input"
                            style={{ fontWeight: 700, fontSize: 15 }}
                            disabled={
                              isReadOnlyFeeEarner || !costsConfig.allowMatterRateOverrides
                            }
                            value={String(cg.hourlyRateGbp)}
                            onChange={(e) => {
                              const nextRate = Number(e.target.value) || 0;
                              setCustomGradeRates((prev) =>
                                prev.map((row) =>
                                  row.id === cg.id ? { ...row, hourlyRateGbp: nextRate } : row,
                                ),
                              );
                              setCostRateSource('custom_override');
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {/* 3. Total Estimate (& Agreed Cap when Capped is selected) */}
                <div
                  className="form-grid"
                  style={{ gap: '14px 16px', alignItems: 'flex-start' }}
                >
                  <div className="field-group">
                    <label className="field-label" htmlFor="nm-cost-total-estimate">
                      2.{' '}
                      {costWorkBasis === 'fixed_fee'
                        ? 'Total Fixed Fee Estimate (£ ex VAT)'
                        : 'Total Estimate (£ ex VAT)'}{' '}
                      <span className="field-required">*</span>
                    </label>
                    <input
                      id="nm-cost-total-estimate"
                      type="number"
                      min="0"
                      step="50"
                      className="field-input"
                      placeholder="e.g. 3500"
                      disabled={isReadOnlyFeeEarner}
                      value={feeEstimateGbp}
                      onChange={(e) => {
                        setFeeEstimateGbp(e.target.value);
                        if (costWorkBasis === 'fixed_fee') {
                          setAgreedFeeCapGbp(e.target.value);
                        }
                      }}
                    />
                    <span className="field-hint">
                      Used automatically in the Client Care Letter &amp; PMS financial budget.
                    </span>
                  </div>

                  {costWorkBasis === 'capped' ? (
                    <div className="field-group">
                      <label className="field-label" htmlFor="nm-cost-agreed-cap">
                        Agreed Fee Cap (£ ex VAT){' '}
                        <span className="field-required">*</span>
                      </label>
                      <input
                        id="nm-cost-agreed-cap"
                        type="number"
                        min="0"
                        step="50"
                        className="field-input"
                        placeholder="e.g. 5000"
                        disabled={isReadOnlyFeeEarner}
                        value={agreedFeeCapGbp}
                        onChange={(e) => setAgreedFeeCapGbp(e.target.value)}
                      />
                      <span className="field-hint">
                        Maximum professional fees to be billed without prior client approval.
                      </span>
                    </div>
                  ) : null}
                </div>

                {/* 4. Disbursements Costs (Description + Amount, multiple allowed) */}
                <div
                  style={{
                    padding: '14px 16px',
                    borderRadius: 10,
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-surface-subtle)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      flexWrap: 'wrap',
                      gap: 8,
                    }}
                  >
                    <div>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 700,
                          color: 'var(--text-primary)',
                        }}
                      >
                        3. Disbursements Costs
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: 'var(--text-secondary)',
                          marginTop: 2,
                        }}
                      >
                        Add expected third-party disbursements (each with a description and amount).
                      </div>
                    </div>
                    <StatusPill
                      label={
                        costDisbursements.length > 0
                          ? `${costDisbursements.length} item${
                              costDisbursements.length === 1 ? '' : 's'
                            } · ${formatGbp(disbursementsTotalGbp)}`
                          : 'No disbursements added'
                      }
                      tone={costDisbursements.length > 0 ? 'positive' : 'neutral'}
                    />
                  </div>

                  {/* Quick-add preset pills from client config */}
                  {!isReadOnlyFeeEarner && costsConfig.disbursementPresets.length > 0 ? (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: 6,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 11.5,
                          fontWeight: 600,
                          color: 'var(--text-secondary)',
                          marginRight: 2,
                        }}
                      >
                        Quick add:
                      </span>
                      {costsConfig.disbursementPresets.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          className="btn btn--ghost btn--sm"
                          style={{
                            height: 26,
                            padding: '0 10px',
                            fontSize: 11.5,
                            borderRadius: 999,
                            border: '1px solid var(--border-default)',
                            background: 'var(--bg-surface)',
                          }}
                          onClick={() =>
                            handleAddDisbursementRow({
                              description: preset.description,
                              amountGbp: preset.defaultAmountGbp,
                              vatApplicable: preset.vatApplicable,
                            })
                          }
                        >
                          + {preset.description} (£{preset.defaultAmountGbp})
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {/* Existing disbursement rows */}
                  {costDisbursements.length > 0 ? (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      {costDisbursements.map((disb, idx) => (
                        <div
                          key={disb.id}
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '1fr 150px auto auto',
                            gap: 8,
                            alignItems: 'center',
                            padding: '8px 10px',
                            borderRadius: 8,
                            background: 'var(--bg-surface)',
                            border: '1px solid var(--border-subtle)',
                          }}
                        >
                          <input
                            type="text"
                            className="field-input"
                            aria-label={`Disbursement ${idx + 1} description`}
                            placeholder="Disbursement description"
                            disabled={isReadOnlyFeeEarner}
                            value={disb.description}
                            onChange={(e) =>
                              handleUpdateDisbursementRow(disb.id, {
                                description: e.target.value,
                              })
                            }
                          />
                          <div style={{ position: 'relative' }}>
                            <input
                              type="number"
                              min="0"
                              step="1"
                              className="field-input"
                              aria-label={`Disbursement ${idx + 1} amount (£)`}
                              placeholder="Amount (£)"
                              disabled={isReadOnlyFeeEarner}
                              value={String(disb.amountGbp)}
                              onChange={(e) =>
                                handleUpdateDisbursementRow(disb.id, {
                                  amountGbp: Number(e.target.value) || 0,
                                })
                              }
                            />
                          </div>
                          <label
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 5,
                              fontSize: 12,
                              color: 'var(--text-secondary)',
                              cursor: isReadOnlyFeeEarner ? 'default' : 'pointer',
                              whiteSpace: 'nowrap',
                              padding: '0 4px',
                            }}
                          >
                            <input
                              type="checkbox"
                              disabled={isReadOnlyFeeEarner}
                              checked={disb.vatApplicable !== false}
                              onChange={(e) =>
                                handleUpdateDisbursementRow(disb.id, {
                                  vatApplicable: e.target.checked,
                                })
                              }
                            />
                            <span>+ VAT</span>
                          </label>
                          {!isReadOnlyFeeEarner ? (
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              aria-label={`Remove ${disb.description}`}
                              style={{ height: 30, padding: '0 8px' }}
                              onClick={() => handleRemoveDisbursementRow(disb.id)}
                            >
                              <X size={14} />
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {/* Add new disbursement row */}
                  {!isReadOnlyFeeEarner ? (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 150px auto auto',
                        gap: 8,
                        alignItems: 'center',
                      }}
                    >
                      <input
                        type="text"
                        className="field-input"
                        placeholder="Add disbursement description (e.g. Counsel's fee, Search fees, Court issue fee)…"
                        value={newDisbursementDescription}
                        onChange={(e) => setNewDisbursementDescription(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleAddDisbursementRow();
                          }
                        }}
                      />
                      <input
                        type="number"
                        min="0"
                        step="1"
                        className="field-input"
                        placeholder="Amount (£)"
                        value={newDisbursementAmount}
                        onChange={(e) => setNewDisbursementAmount(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleAddDisbursementRow();
                          }
                        }}
                      />
                      <label
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 5,
                          fontSize: 12,
                          color: 'var(--text-secondary)',
                          cursor: 'pointer',
                          whiteSpace: 'nowrap',
                          padding: '0 4px',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={newDisbursementVat}
                          onChange={(e) => setNewDisbursementVat(e.target.checked)}
                        />
                        <span>+ VAT</span>
                      </label>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        style={{ borderRadius: 999, height: 38, whiteSpace: 'nowrap' }}
                        disabled={!newDisbursementDescription.trim()}
                        onClick={() => handleAddDisbursementRow()}
                      >
                        <Plus size={14} />
                        <span>Add disbursement</span>
                      </button>
                    </div>
                  ) : null}

                  {/* Running Totals Summary Bar */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      flexWrap: 'wrap',
                      gap: 12,
                      paddingTop: 10,
                      borderTop: '1px solid var(--border-subtle)',
                      fontSize: 12.5,
                    }}
                  >
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                      <span style={{ color: 'var(--text-secondary)' }}>
                        Professional fees estimate:{' '}
                        <strong style={{ color: 'var(--text-primary)' }}>
                          {numericFeeEstimateGbp != null
                            ? formatGbp(numericFeeEstimateGbp)
                            : '£0'}
                        </strong>
                      </span>
                      <span style={{ color: 'var(--text-secondary)' }}>
                        Disbursements ({costDisbursements.length}):{' '}
                        <strong style={{ color: 'var(--text-primary)' }}>
                          {formatGbp(disbursementsTotalGbp)}
                        </strong>
                      </span>
                    </div>
                    <span
                      style={{
                        fontWeight: 700,
                        fontSize: 13.5,
                        color: 'var(--text-primary)',
                      }}
                    >
                      Combined total estimate (ex VAT):{' '}
                      {formatGbp((numericFeeEstimateGbp ?? 0) + disbursementsTotalGbp)}
                    </span>
                  </div>
                </div>

                {/* 5. Payment on Account */}
                <div
                  className="form-grid"
                  style={{ gap: '14px 16px', alignItems: 'flex-start' }}
                >
                  <div className="field-group">
                    <label className="field-label">
                      4. Is Payment on Account required?{' '}
                      <span className="field-required">*</span>
                    </label>
                    <div
                      style={{
                        display: 'flex',
                        gap: 8,
                        marginTop: 4,
                      }}
                      role="radiogroup"
                      aria-label="Is Payment on Account required?"
                    >
                      {(['Yes', 'No'] as const).map((choice) => {
                        const isSelected = paymentOnAccountRequired === choice;
                        return (
                          <button
                            key={choice}
                            type="button"
                            role="radio"
                            aria-checked={isSelected}
                            disabled={isReadOnlyFeeEarner}
                            onClick={() => handleSelectPaymentOnAccount(choice)}
                            style={{
                              padding: '8px 20px',
                              borderRadius: 999,
                              fontSize: 13,
                              fontWeight: isSelected ? 700 : 500,
                              border: isSelected
                                ? '2px solid var(--accent-primary, #0f766e)'
                                : '1px solid var(--border-default)',
                              background: isSelected
                                ? 'rgba(15, 118, 110, 0.08)'
                                : 'var(--bg-surface)',
                              color: 'var(--text-primary)',
                              cursor: isReadOnlyFeeEarner ? 'default' : 'pointer',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                            }}
                          >
                            {isSelected ? (
                              <Check
                                size={14}
                                color="var(--accent-primary, #0f766e)"
                                strokeWidth={2.6}
                              />
                            ) : null}
                            <span>{choice}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {paymentOnAccountRequired === 'Yes' ? (
                    <div className="field-group">
                      <label className="field-label" htmlFor="nm-cost-poa-amount">
                        Payment on Account amount (£)
                      </label>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          id="nm-cost-poa-amount"
                          type="number"
                          min="0"
                          step="50"
                          className="field-input"
                          placeholder={`e.g. ${
                            costsConfig.defaultPaymentOnAccountAmountGbp || 1000
                          }`}
                          disabled={isReadOnlyFeeEarner}
                          value={retainerMoniesOnAccountGbp}
                          onChange={(e) => setRetainerMoniesOnAccountGbp(e.target.value)}
                        />
                        {!isReadOnlyFeeEarner &&
                        (numericFeeEstimateGbp != null || disbursementsTotalGbp > 0) ? (
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            style={{
                              borderRadius: 999,
                              height: 36,
                              whiteSpace: 'nowrap',
                              fontSize: 12,
                            }}
                            onClick={() => {
                              const suggested = Math.max(
                                disbursementsTotalGbp,
                                Math.round(((numericFeeEstimateGbp ?? 0) * 0.25) / 50) * 50,
                                costsConfig.defaultPaymentOnAccountAmountGbp || 500,
                              );
                              setRetainerMoniesOnAccountGbp(String(suggested));
                            }}
                          >
                            Suggest 25% / Disb.
                          </button>
                        ) : null}
                      </div>
                      <span className="field-hint">
                        Automatically populates the Payment on Account clause in the Client Care Letter.
                      </span>
                    </div>
                  ) : null}
                </div>

                {enableMatterCostsGovernance &&
                (partnerCostSignOff ||
                  (canSignOffCosts && (savedDraftMatterId || existing?.id))) ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      flexWrap: 'wrap',
                      gap: 12,
                      padding: '10px 14px',
                      borderRadius: 10,
                      border: '1px solid var(--border-subtle)',
                      background: 'var(--bg-surface-subtle)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                        fontSize: 12.5,
                        color: 'var(--text-secondary)',
                      }}
                    >
                      {partnerCostSignOff ? (
                        <div>
                          <strong style={{ color: 'var(--text-primary)' }}>
                            Partner cost sign-off completed
                          </strong>{' '}
                          by {partnerCostSignOff.byName} (
                          {formatGbp(partnerCostSignOff.signedOffEstimateGbp ?? 0)})
                          {partnerCostSignOff.note ? ` · "${partnerCostSignOff.note}"` : ''}
                        </div>
                      ) : (
                        <span>
                          High-value fee estimates require partner cost sign-off before opening.
                        </span>
                      )}
                      {canSignOffCosts && (savedDraftMatterId || existing?.id) ? (
                        <span>
                          {hasUnsavedEstimateChanges
                            ? 'Save your changes before signing off'
                            : `You're signing off ${formatGbp(savedEstimateGbp ?? 0)}`}
                        </span>
                      ) : null}
                    </div>
                    {canSignOffCosts && (savedDraftMatterId || existing?.id) ? (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          flexWrap: 'wrap',
                        }}
                      >
                        <input
                          type="text"
                          className="field-input"
                          style={{ height: 32, width: 220, fontSize: 12 }}
                          placeholder="Optional sign-off note…"
                          aria-label="Partner cost sign-off note"
                          value={signOffNote}
                          onChange={(e) => setSignOffNote(e.target.value)}
                          disabled={signingOffCosts || hasUnsavedEstimateChanges}
                        />
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          disabled={signingOffCosts || hasUnsavedEstimateChanges}
                          onClick={handleSignOffMatterCosts}
                        >
                          <ShieldCheck size={14} />
                          <span>
                            {partnerCostSignOff ? 'Re-sign off costs' : 'Sign off costs'}
                          </span>
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>

          {/* ================================================================
              PROGRESS / STAGE BAR CARD (shown when editing an existing matter)
              ================================================================ */}
          {isEditingExistingMatter ? (
            <section
              className="new-enquiry-card"
              aria-labelledby="card-stage-heading"
            >
              <div className="new-enquiry-card__top">
                <h2 id="card-stage-heading" className="new-enquiry-card__label">
                  PROGRESS · STAGE {stageIdx + 1} OF {stageSteps.length} ({stageSteps[stageIdx]?.name})
                </h2>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <button
                    type="button"
                    className="panel-link"
                    disabled={stageIdx <= 0}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      cursor: stageIdx > 0 ? 'pointer' : 'default',
                      opacity: stageIdx > 0 ? 1 : 0.45,
                      fontWeight: 600,
                    }}
                    onClick={() => setStageIdx((i) => Math.max(0, i - 1))}
                  >
                    ← Move back a stage
                  </button>
                  <button
                    type="button"
                    className="panel-link"
                    disabled={stageIdx >= stageSteps.length - 1}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      cursor: stageIdx < stageSteps.length - 1 ? 'pointer' : 'default',
                      opacity: stageIdx < stageSteps.length - 1 ? 1 : 0.45,
                      fontWeight: 600,
                    }}
                    onClick={() =>
                      setStageIdx((i) => Math.min(stageSteps.length - 1, i + 1))
                    }
                  >
                    Move to next stage →
                  </button>
                </div>
              </div>

              <div className="matter-stage-grid" style={{ marginTop: 4 }}>
                {stageSteps.map((st, idx) => {
                  const isFilled = idx <= stageIdx;
                  const isCurrent = idx === stageIdx;
                  const isUpcoming = idx > stageIdx;
                  const metaText = isCurrent
                    ? 'Current'
                    : idx < stageIdx && st.meta === 'Current'
                      ? 'Completed'
                      : st.meta;
                  return (
                    <div
                      key={st.name}
                      className="matter-stage-col"
                      style={{ cursor: 'pointer' }}
                      onClick={() => setStageIdx(idx)}
                    >
                      <div
                        className={`matter-stage-col__bar ${
                          isFilled ? 'matter-stage-col__bar--active' : ''
                        }`}
                      />
                      <div
                        className={`matter-stage-col__name ${
                          isCurrent
                            ? 'matter-stage-col__name--current'
                            : isUpcoming
                              ? 'matter-stage-col__name--upcoming'
                              : ''
                        }`}
                      >
                        {st.name}
                      </div>
                      <div
                        className={`matter-stage-col__meta ${
                          isCurrent ? 'matter-stage-col__meta--current' : ''
                        }`}
                      >
                        {metaText}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          {/* ================================================================
              MATTER FACTS CARD (Client ref, Claim value, Responsible office, Source of work)
              ================================================================ */}
          {isEditingExistingMatter ? (
            <section
              className="new-enquiry-card"
              aria-labelledby="card-facts-heading"
            >
              <div className="new-enquiry-card__top">
                <h2 id="card-facts-heading" className="new-enquiry-card__label">
                  MATTER FACTS
                </h2>
                <StatusPill
                  label={`${responsibleOffice || 'Office'} · ${
                    practiceAreas.find((p) => p.id === practiceAreaId)?.label ||
                    'Department'
                  }`}
                  tone="neutral"
                />
              </div>

              <div className="form-grid" style={{ gap: '14px 16px' }}>
                <div className="field-group">
                  <label className="field-label" htmlFor="nm-fact-client-ref">
                    Client reference
                  </label>
                  <input
                    id="nm-fact-client-ref"
                    type="text"
                    className="field-input"
                    placeholder="Client's own reference (e.g. BRI-HR-2026-09)"
                    value={clientReference}
                    onChange={(e) => setClientReference(e.target.value)}
                  />
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="nm-fact-claim-value">
                    Claim value (estimated)
                  </label>
                  <input
                    id="nm-fact-claim-value"
                    type="text"
                    list="nm-claim-value-options"
                    className="field-input"
                    placeholder="e.g. Medium (£5k–£25k)"
                    value={claimValue}
                    onChange={(e) => setClaimValue(e.target.value)}
                  />
                  <datalist id="nm-claim-value-options">
                    <option value="Small (£1k–£5k)" />
                    <option value="Medium (£5k–£25k)" />
                    <option value="Large (£25k–£100k)" />
                    <option value="Major (£100k–£500k)" />
                    <option value="High Value (£500k+)" />
                  </datalist>
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="nm-fact-office">
                    Responsible office
                  </label>
                  <input
                    id="nm-fact-office"
                    type="text"
                    list="nm-office-options"
                    className="field-input"
                    placeholder={
                      orgStructure.offices[0]?.name
                        ? `e.g. ${orgStructure.offices[0].name}`
                        : 'Office name'
                    }
                    value={responsibleOffice}
                    onChange={(e) => setResponsibleOffice(e.target.value)}
                  />
                  <datalist id="nm-office-options">
                    {orgStructure.offices
                      .filter((o) => o.active !== false)
                      .map((o) => (
                        <option key={o.id} value={o.name} />
                      ))}
                  </datalist>
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="nm-fact-source">
                    Source of work
                  </label>
                  <input
                    id="nm-fact-source"
                    type="text"
                    list="nm-source-options"
                    className="field-input"
                    placeholder="e.g. Existing client — cross-referral from Corporate"
                    value={sourceOfWork}
                    onChange={(e) => setSourceOfWork(e.target.value)}
                  />
                  <datalist id="nm-source-options">
                    <option value="Existing client — cross-referral from Corporate" />
                    <option value="Repeat / Existing Client" />
                    <option value="Professional Referral — Accountant" />
                    <option value="Website / Digital Enquiry" />
                    <option value="Panel Appointment" />
                    <option value="Personal Recommendation" />
                  </datalist>
                </div>
              </div>
            </section>
          ) : null}

          {/* ================================================================
              CARD 2 · MATTER RISK ASSESSMENT (7 expandable/collapsible sub-sections)
              ================================================================ */}
          <section
            ref={cardRiskRef}
            className="new-enquiry-card"
            aria-labelledby="card-risk-heading"
          >
            <div
              className="new-enquiry-card__top"
              style={{
                cursor: 'pointer',
                marginBottom: section2Open ? undefined : 0,
              }}
              onClick={() => setSection2Open((o) => !o)}
            >
              <div>
                <h2 id="card-risk-heading" className="new-enquiry-card__label">
                  3 · MATTER RISK ASSESSMENT
                </h2>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {riskAssessmentSummary.overallRisk ? (
                  <StatusPill
                    label={`Risk: ${riskAssessmentSummary.overallRisk}`}
                    tone={
                      riskAssessmentSummary.overallRisk === 'High'
                        ? 'alert'
                        : riskAssessmentSummary.overallRisk === 'Medium'
                          ? 'warning'
                          : 'positive'
                    }
                  />
                ) : null}
                {riskAssessmentSummary.isComplete ? (
                  <StatusPill label="✓ Complete" tone="positive" />
                ) : (
                  <span className="conflict-req-pill">
                    {riskAssessmentSummary.remainingQuestions} of{' '}
                    {riskAssessmentSummary.totalQuestions} to complete
                  </span>
                )}
                {section2Open ? (
                  <>
                    <div
                      className="conflict-seg-group"
                      role="group"
                      aria-label="Matter risk assessment view mode"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        className={`conflict-seg-btn ${
                          !riskListView ? 'conflict-seg-btn--active' : ''
                        }`}
                        style={{ height: 26, padding: '0 10px', fontSize: 12 }}
                        onClick={() => setRiskListView(false)}
                      >
                        Sections
                      </button>
                      <button
                        type="button"
                        className={`conflict-seg-btn ${
                          riskListView ? 'conflict-seg-btn--active' : ''
                        }`}
                        style={{ height: 26, padding: '0 10px', fontSize: 12 }}
                        onClick={() => setRiskListView(true)}
                      >
                        One long list
                      </button>
                    </div>
                    {!riskListView ? (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        style={{ height: 26, padding: '0 8px', fontSize: 12 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          const allIds = riskAssessmentSummary.visibleSections.map((s) => s.id);
                          const allExpanded = allIds.every((id) =>
                            expandedRiskSectionIds.includes(id),
                          );
                          setExpandedRiskSectionIds(allExpanded ? [] : allIds);
                        }}
                      >
                        {riskAssessmentSummary.visibleSections.every((s) =>
                          expandedRiskSectionIds.includes(s.id),
                        )
                          ? 'Collapse all'
                          : 'Expand all'}
                      </button>
                    ) : null}
                  </>
                ) : null}
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  aria-expanded={section2Open}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSection2Open((o) => !o);
                  }}
                >
                  {section2Open ? (
                    <>
                      <span>Minimise</span>
                      <ChevronDown size={15} />
                    </>
                  ) : (
                    <>
                      <span>Maximise</span>
                      <ChevronRight size={15} />
                    </>
                  )}
                </button>
              </div>
            </div>

            {section2Open ? (
              riskListView ? (
                <div
                  style={{
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 10,
                    background: 'var(--bg-surface)',
                    overflow: 'hidden',
                  }}
                >
                  {riskAssessmentSummary.visibleSections.map((sec, secIdx) => (
                    <React.Fragment key={sec.id}>
                      {/* Section dividing row with section title (e.g. "1. About this instruction") */}
                      <div
                        style={{
                          padding: '8px 16px',
                          background: 'var(--bg-surface-subtle)',
                          borderTop:
                            secIdx > 0 ? '1px solid var(--border-subtle)' : 'none',
                          borderBottom: '1px solid var(--border-subtle)',
                          fontSize: 12.5,
                          fontWeight: 700,
                          color: 'var(--text-primary)',
                        }}
                      >
                        {sec.number}. {sec.title}
                      </div>

                      {sec.visibleQuestions.map((q, qIdx) => {
                        const selectedVal = riskAnswers[q.id] ?? '';
                        const selectedOpt = q.options.find(
                          (o) => o.label === selectedVal,
                        );
                        const showFollowUp = Boolean(selectedOpt?.triggersFollowUp);
                        const isLastInSec = qIdx === sec.visibleQuestions.length - 1;

                        return (
                          <div
                            key={q.id}
                            style={{
                              padding: '12px 16px',
                              borderBottom: !isLastInSec
                                ? '1px solid var(--border-subtle)'
                                : 'none',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 8,
                            }}
                          >
                            <div
                              style={{
                                display: 'grid',
                                gridTemplateColumns:
                                  'minmax(240px, 1fr) minmax(260px, auto)',
                                gap: 16,
                                alignItems: 'center',
                              }}
                            >
                              {/* Left: Question & helper notes */}
                              <div
                                style={{
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: 4,
                                  minWidth: 0,
                                }}
                              >
                                <label
                                  className="field-label"
                                  style={{
                                    marginBottom: 0,
                                    fontSize: 13.5,
                                    fontWeight: 600,
                                    color: 'var(--text-primary)',
                                  }}
                                >
                                  {q.question}
                                </label>
                                {q.id === 'inScopeMlr' &&
                                (workTypeSubcategoryId || practiceAreaId) ? (
                                  <span
                                    style={{
                                      fontSize: 11.5,
                                      color: 'var(--text-secondary)',
                                      fontWeight: 500,
                                    }}
                                  >
                                    Pre-filled from work type
                                  </span>
                                ) : null}
                                {q.id === 'clientRelationshipStatus' &&
                                derivedClientRelationshipCdd.summary ? (
                                  <span
                                    style={{
                                      fontSize: 11.5,
                                      color: 'var(--text-secondary)',
                                      fontWeight: 500,
                                    }}
                                  >
                                    {derivedClientRelationshipCdd.summary}
                                  </span>
                                ) : null}
                                {q.id === 'holdClientMoney' ? (
                                  <span
                                    style={{
                                      fontSize: 11.5,
                                      color: 'var(--text-secondary)',
                                      fontWeight: 600,
                                    }}
                                  >
                                    Firm threshold for this work type: £
                                    {workTypeClientMoneyThresholdGbp.toLocaleString(
                                      'en-GB',
                                    )}
                                  </span>
                                ) : null}
                                {aiCitations[`risk.${q.id}`] ? (
                                  <span
                                    title={`Source (${aiCitations[`risk.${q.id}`].sourceDoc}): "${aiCitations[`risk.${q.id}`].quote}"`}
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      alignSelf: 'flex-start',
                                      gap: 4,
                                      fontSize: 11.5,
                                      fontWeight: 600,
                                      color: 'var(--accent-primary, #0f766e)',
                                      background: 'rgba(15, 118, 110, 0.08)',
                                      border: '1px solid rgba(15, 118, 110, 0.25)',
                                      borderRadius: 999,
                                      padding: '1px 8px',
                                    }}
                                  >
                                    <Sparkles size={11} />
                                    <span>
                                      AI pre-filled ·{' '}
                                      {aiCitations[`risk.${q.id}`].sourceDoc}
                                    </span>
                                  </span>
                                ) : null}
                                {aiCitations[`risk.${q.id}`]?.quote ? (
                                  <div
                                    style={{
                                      fontSize: 12,
                                      color: 'var(--text-secondary)',
                                      fontStyle: 'italic',
                                      borderLeft:
                                        '2px solid rgba(15, 118, 110, 0.35)',
                                      paddingLeft: 8,
                                    }}
                                  >
                                    &ldquo;{aiCitations[`risk.${q.id}`].quote}&rdquo;
                                  </div>
                                ) : null}
                              </div>

                              {/* Right: Potential answers */}
                              <div
                                style={{
                                  display: 'flex',
                                  flexWrap: 'wrap',
                                  gap: 8,
                                  justifyContent: 'flex-end',
                                }}
                                role="radiogroup"
                                aria-label={q.question}
                              >
                                {q.options.map((opt) => {
                                  const isSelected = selectedVal === opt.label;
                                  return (
                                    <button
                                      key={opt.label}
                                      type="button"
                                      role="radio"
                                      aria-checked={isSelected}
                                      disabled={isReadOnlyFeeEarner}
                                      onClick={() =>
                                        setRiskAnswers((prev) => ({
                                          ...prev,
                                          [q.id]: opt.label,
                                        }))
                                      }
                                      style={{
                                        padding: '6px 14px',
                                        borderRadius: 999,
                                        fontSize: 13,
                                        fontWeight: isSelected ? 700 : 500,
                                        cursor: isReadOnlyFeeEarner
                                          ? 'default'
                                          : 'pointer',
                                        border: isSelected
                                          ? '1.5px solid var(--accent-primary, #0f766e)'
                                          : '1px solid var(--border-default)',
                                        background: isSelected
                                          ? 'rgba(15, 118, 110, 0.1)'
                                          : 'var(--bg-surface)',
                                        color: isSelected
                                          ? 'var(--text-primary)'
                                          : 'var(--text-secondary)',
                                        transition: 'all 0.12s ease',
                                      }}
                                    >
                                      {opt.label}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>

                            {/* Follow-up control when triggered */}
                            {showFollowUp ? (
                              q.followUpType === 'key_dates' ? (
                                <div
                                  style={{
                                    marginTop: 4,
                                    padding: '12px 14px',
                                    borderRadius: 8,
                                    background: 'var(--bg-surface-subtle)',
                                    border: '1px solid var(--border-subtle)',
                                  }}
                                >
                                  <div
                                    style={{
                                      fontSize: 12.5,
                                      fontWeight: 700,
                                      color: 'var(--text-primary)',
                                      marginBottom: 8,
                                    }}
                                  >
                                    {q.followUpLabel || 'Add dates'}{' '}
                                    <span
                                      style={{
                                        fontWeight: 400,
                                        color: 'var(--text-secondary)',
                                      }}
                                    >
                                      (added to the matter&apos;s key dates list)
                                    </span>
                                  </div>

                                  {customKeyDates.length > 0 ? (
                                    <ul
                                      className="worklist"
                                      style={{
                                        marginBottom: 10,
                                        background: 'var(--bg-surface)',
                                        border: '1px solid var(--border-subtle)',
                                        borderRadius: 8,
                                        padding: '0 10px',
                                      }}
                                    >
                                      {customKeyDates.map((kd) => (
                                        <li
                                          key={kd.id}
                                          className="worklist-row"
                                          style={{ padding: '6px 0' }}
                                        >
                                          <div className="worklist-main">
                                            <span
                                              style={{
                                                fontWeight: 600,
                                                fontSize: 13,
                                                color: 'var(--text-primary)',
                                              }}
                                            >
                                              {kd.label}
                                            </span>
                                            <span
                                              className="worklist-meta"
                                              style={{ marginLeft: 8 }}
                                            >
                                              {kd.date}
                                            </span>
                                          </div>
                                          {!isReadOnlyFeeEarner ? (
                                            <div className="worklist-right">
                                              <button
                                                type="button"
                                                className="btn btn--ghost btn--sm"
                                                aria-label={`Remove ${kd.label}`}
                                                style={{
                                                  padding: '0 6px',
                                                  height: 24,
                                                }}
                                                onClick={() =>
                                                  handleRemoveCustomKeyDate(kd.id)
                                                }
                                              >
                                                <X size={13} />
                                              </button>
                                            </div>
                                          ) : null}
                                        </li>
                                      ))}
                                    </ul>
                                  ) : null}

                                  {!isReadOnlyFeeEarner ? (
                                    <div
                                      style={{
                                        display: 'flex',
                                        alignItems: 'flex-end',
                                        gap: 8,
                                        flexWrap: 'wrap',
                                      }}
                                    >
                                      <div style={{ flex: '0 0 165px' }}>
                                        <label
                                          className="field-label"
                                          style={{ fontSize: 11.5 }}
                                        >
                                          Date
                                        </label>
                                        <input
                                          type="date"
                                          className="field-input"
                                          value={newKeyDateValue}
                                          onChange={(e) =>
                                            setNewKeyDateValue(e.target.value)
                                          }
                                        />
                                      </div>
                                      <div style={{ flex: '1 1 220px' }}>
                                        <label
                                          className="field-label"
                                          style={{ fontSize: 11.5 }}
                                        >
                                          Description
                                        </label>
                                        <input
                                          type="text"
                                          className="field-input"
                                          placeholder="e.g. Limitation date, Court deadline, Hearing…"
                                          value={newKeyDateLabel}
                                          onChange={(e) =>
                                            setNewKeyDateLabel(e.target.value)
                                          }
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                              e.preventDefault();
                                              handleAddCustomKeyDate();
                                            }
                                          }}
                                        />
                                      </div>
                                      <button
                                        type="button"
                                        className="btn btn--secondary btn--sm"
                                        style={{ borderRadius: 999, height: 38 }}
                                        disabled={!newKeyDateValue.trim()}
                                        onClick={handleAddCustomKeyDate}
                                      >
                                        <Plus size={14} />
                                        <span>Add date</span>
                                      </button>
                                    </div>
                                  ) : null}
                                </div>
                              ) : (
                                <div
                                  style={{
                                    marginTop: 4,
                                    padding: '10px 12px',
                                    borderRadius: 8,
                                    background: 'var(--bg-surface-subtle)',
                                    border: '1px solid var(--border-subtle)',
                                  }}
                                >
                                  <label
                                    className="field-label"
                                    style={{ fontSize: 12, marginBottom: 4 }}
                                  >
                                    {q.followUpLabel}
                                  </label>
                                  <input
                                    type="text"
                                    className="field-input"
                                    disabled={isReadOnlyFeeEarner}
                                    placeholder={q.followUpLabel}
                                    value={riskFollowUps[q.id] ?? ''}
                                    onChange={(e) =>
                                      setRiskFollowUps((prev) => ({
                                        ...prev,
                                        [q.id]: e.target.value,
                                      }))
                                    }
                                  />
                                </div>
                              )
                            ) : null}
                          </div>
                        );
                      })}
                    </React.Fragment>
                  ))}
                </div>
              ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {riskAssessmentSummary.visibleSections.map((sec) => {
                const isSecExpanded = expandedRiskSectionIds.includes(sec.id);
                return (
                  <div
                    key={sec.id}
                    style={{
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 10,
                      background: 'var(--bg-surface)',
                      overflow: 'hidden',
                    }}
                  >
                    <button
                      type="button"
                      aria-expanded={isSecExpanded}
                      onClick={() => toggleRiskSectionExpanded(sec.id)}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        padding: '11px 14px',
                        background: isSecExpanded
                          ? 'var(--bg-surface-subtle)'
                          : 'var(--bg-surface)',
                        border: 'none',
                        borderBottom: isSecExpanded
                          ? '1px solid var(--border-subtle)'
                          : 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                        font: 'inherit',
                        color: 'var(--text-primary)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {isSecExpanded ? (
                          <ChevronDown size={16} color="var(--text-secondary)" />
                        ) : (
                          <ChevronRight size={16} color="var(--text-secondary)" />
                        )}
                        <span style={{ fontWeight: 700, fontSize: 13.5 }}>
                          {sec.number}. {sec.title}
                        </span>
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          flexWrap: 'wrap',
                        }}
                      >
                        {sec.sectionRisk ? (
                          <StatusPill
                            label={sec.sectionRisk}
                            tone={
                              sec.sectionRisk === 'High'
                                ? 'alert'
                                : sec.sectionRisk === 'Medium'
                                  ? 'warning'
                                  : 'positive'
                            }
                          />
                        ) : null}
                        {sec.remainingCount === 0 ? (
                          <StatusPill label="✓ Complete" tone="positive" />
                        ) : (
                          <span className="conflict-req-pill">
                            {sec.remainingCount}{' '}
                            {sec.remainingCount === 1 ? 'question' : 'questions'} to complete
                          </span>
                        )}
                      </div>
                    </button>

                    {isSecExpanded ? (
                      <div
                        style={{
                          padding: '14px 16px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 16,
                        }}
                      >
                        {sec.visibleQuestions.map((q) => {
                          const selectedVal = riskAnswers[q.id] ?? '';
                          const selectedOpt = q.options.find(
                            (o) => o.label === selectedVal,
                          );
                          const showFollowUp = Boolean(selectedOpt?.triggersFollowUp);

                          return (
                            <div
                              key={q.id}
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 8,
                                paddingBottom: 12,
                                borderBottom: '1px solid var(--border-subtle)',
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'baseline',
                                  justifyContent: 'space-between',
                                  gap: 10,
                                  flexWrap: 'wrap',
                                }}
                              >
                                <label
                                  className="field-label"
                                  style={{
                                    marginBottom: 0,
                                    fontSize: 13.5,
                                    fontWeight: 600,
                                    color: 'var(--text-primary)',
                                  }}
                                >
                                  {q.question}
                                </label>
                                {q.id === 'inScopeMlr' &&
                                (workTypeSubcategoryId || practiceAreaId) ? (
                                  <span
                                    style={{
                                      fontSize: 11.5,
                                      color: 'var(--text-secondary)',
                                      fontWeight: 500,
                                    }}
                                  >
                                    Pre-filled from work type
                                  </span>
                                ) : null}
                                {q.id === 'clientRelationshipStatus' &&
                                derivedClientRelationshipCdd.summary ? (
                                  <span
                                    style={{
                                      fontSize: 11.5,
                                      color: 'var(--text-secondary)',
                                      fontWeight: 500,
                                    }}
                                  >
                                    {derivedClientRelationshipCdd.summary}
                                  </span>
                                ) : null}
                                {q.id === 'holdClientMoney' ? (
                                  <span
                                    style={{
                                      fontSize: 11.5,
                                      color: 'var(--text-secondary)',
                                      fontWeight: 600,
                                    }}
                                  >
                                    Firm threshold for this work type: £
                                    {workTypeClientMoneyThresholdGbp.toLocaleString('en-GB')}
                                  </span>
                                ) : null}
                                {aiCitations[`risk.${q.id}`] ? (
                                  <span
                                    title={`Source (${aiCitations[`risk.${q.id}`].sourceDoc}): "${aiCitations[`risk.${q.id}`].quote}"`}
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: 4,
                                      fontSize: 11.5,
                                      fontWeight: 600,
                                      color: 'var(--accent-primary, #0f766e)',
                                      background: 'rgba(15, 118, 110, 0.08)',
                                      border: '1px solid rgba(15, 118, 110, 0.25)',
                                      borderRadius: 999,
                                      padding: '1px 8px',
                                    }}
                                  >
                                    <Sparkles size={11} />
                                    <span>
                                      AI pre-filled · {aiCitations[`risk.${q.id}`].sourceDoc}
                                    </span>
                                  </span>
                                ) : null}
                              </div>
                              {aiCitations[`risk.${q.id}`]?.quote ? (
                                <div
                                  style={{
                                    fontSize: 12,
                                    color: 'var(--text-secondary)',
                                    fontStyle: 'italic',
                                    borderLeft: '2px solid rgba(15, 118, 110, 0.35)',
                                    paddingLeft: 8,
                                  }}
                                >
                                  &ldquo;{aiCitations[`risk.${q.id}`].quote}&rdquo;
                                </div>
                              ) : null}

                              {/* Option buttons */}
                              <div
                                style={{
                                  display: 'flex',
                                  flexWrap: 'wrap',
                                  gap: 8,
                                }}
                                role="radiogroup"
                                aria-label={q.question}
                              >
                                {q.options.map((opt) => {
                                  const isSelected = selectedVal === opt.label;
                                  return (
                                    <button
                                      key={opt.label}
                                      type="button"
                                      role="radio"
                                      aria-checked={isSelected}
                                      disabled={isReadOnlyFeeEarner}
                                      onClick={() =>
                                        setRiskAnswers((prev) => ({
                                          ...prev,
                                          [q.id]: opt.label,
                                        }))
                                      }
                                      style={{
                                        padding: '6px 14px',
                                        borderRadius: 999,
                                        fontSize: 13,
                                        fontWeight: isSelected ? 700 : 500,
                                        cursor: isReadOnlyFeeEarner ? 'default' : 'pointer',
                                        border: isSelected
                                          ? '1.5px solid var(--accent-primary, #0f766e)'
                                          : '1px solid var(--border-default)',
                                        background: isSelected
                                          ? 'rgba(15, 118, 110, 0.1)'
                                          : 'var(--bg-surface)',
                                        color: isSelected
                                          ? 'var(--text-primary)'
                                          : 'var(--text-secondary)',
                                        transition: 'all 0.12s ease',
                                      }}
                                    >
                                      {opt.label}
                                    </button>
                                  );
                                })}
                              </div>

                              {/* Follow-up control when triggered */}
                              {showFollowUp ? (
                                q.followUpType === 'key_dates' ? (
                                  <div
                                    style={{
                                      marginTop: 6,
                                      padding: '12px 14px',
                                      borderRadius: 8,
                                      background: 'var(--bg-surface-subtle)',
                                      border: '1px solid var(--border-subtle)',
                                    }}
                                  >
                                    <div
                                      style={{
                                        fontSize: 12.5,
                                        fontWeight: 700,
                                        color: 'var(--text-primary)',
                                        marginBottom: 8,
                                      }}
                                    >
                                      {q.followUpLabel || 'Add dates'}{' '}
                                      <span
                                        style={{
                                          fontWeight: 400,
                                          color: 'var(--text-secondary)',
                                        }}
                                      >
                                        (added to the matter&apos;s key dates list)
                                      </span>
                                    </div>

                                    {customKeyDates.length > 0 ? (
                                      <ul
                                        className="worklist"
                                        style={{
                                          marginBottom: 10,
                                          background: 'var(--bg-surface)',
                                          border: '1px solid var(--border-subtle)',
                                          borderRadius: 8,
                                          padding: '0 10px',
                                        }}
                                      >
                                        {customKeyDates.map((kd) => (
                                          <li
                                            key={kd.id}
                                            className="worklist-row"
                                            style={{ padding: '6px 0' }}
                                          >
                                            <div className="worklist-main">
                                              <span
                                                style={{
                                                  fontWeight: 600,
                                                  fontSize: 13,
                                                  color: 'var(--text-primary)',
                                                }}
                                              >
                                                {kd.label}
                                              </span>
                                              <span
                                                className="worklist-meta"
                                                style={{ marginLeft: 8 }}
                                              >
                                                {kd.date}
                                              </span>
                                            </div>
                                            {!isReadOnlyFeeEarner ? (
                                              <div className="worklist-right">
                                                <button
                                                  type="button"
                                                  className="btn btn--ghost btn--sm"
                                                  aria-label={`Remove ${kd.label}`}
                                                  style={{ padding: '0 6px', height: 24 }}
                                                  onClick={() =>
                                                    handleRemoveCustomKeyDate(kd.id)
                                                  }
                                                >
                                                  <X size={13} />
                                                </button>
                                              </div>
                                            ) : null}
                                          </li>
                                        ))}
                                      </ul>
                                    ) : null}

                                    {!isReadOnlyFeeEarner ? (
                                      <div
                                        style={{
                                          display: 'flex',
                                          alignItems: 'flex-end',
                                          gap: 8,
                                          flexWrap: 'wrap',
                                        }}
                                      >
                                        <div style={{ flex: '0 0 165px' }}>
                                          <label
                                            className="field-label"
                                            style={{ fontSize: 11.5 }}
                                          >
                                            Date
                                          </label>
                                          <input
                                            type="date"
                                            className="field-input"
                                            value={newKeyDateValue}
                                            onChange={(e) =>
                                              setNewKeyDateValue(e.target.value)
                                            }
                                          />
                                        </div>
                                        <div style={{ flex: '1 1 220px' }}>
                                          <label
                                            className="field-label"
                                            style={{ fontSize: 11.5 }}
                                          >
                                            Description
                                          </label>
                                          <input
                                            type="text"
                                            className="field-input"
                                            placeholder="e.g. Limitation date, Court deadline, Hearing…"
                                            value={newKeyDateLabel}
                                            onChange={(e) =>
                                              setNewKeyDateLabel(e.target.value)
                                            }
                                            onKeyDown={(e) => {
                                              if (e.key === 'Enter') {
                                                e.preventDefault();
                                                handleAddCustomKeyDate();
                                              }
                                            }}
                                          />
                                        </div>
                                        <button
                                          type="button"
                                          className="btn btn--secondary btn--sm"
                                          style={{ borderRadius: 999, height: 38 }}
                                          disabled={!newKeyDateValue.trim()}
                                          onClick={handleAddCustomKeyDate}
                                        >
                                          <Plus size={14} />
                                          <span>Add date</span>
                                        </button>
                                      </div>
                                    ) : null}
                                  </div>
                                ) : (
                                  <div
                                    style={{
                                      marginTop: 4,
                                      padding: '10px 12px',
                                      borderRadius: 8,
                                      background: 'var(--bg-surface-subtle)',
                                      border: '1px solid var(--border-subtle)',
                                    }}
                                  >
                                    <label
                                      className="field-label"
                                      style={{ fontSize: 12, marginBottom: 4 }}
                                    >
                                      {q.followUpLabel}
                                    </label>
                                    <input
                                      type="text"
                                      className="field-input"
                                      disabled={isReadOnlyFeeEarner}
                                      placeholder={q.followUpLabel}
                                      value={riskFollowUps[q.id] ?? ''}
                                      onChange={(e) =>
                                        setRiskFollowUps((prev) => ({
                                          ...prev,
                                          [q.id]: e.target.value,
                                        }))
                                      }
                                    />
                                  </div>
                                )
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
              )
            ) : null}
          </section>

          {/* ================================================================
              CARD 3 · MATTER PARTIES (at least 1 other party)
              ================================================================ */}
          <section
            ref={card2Ref}
            className="new-enquiry-card"
            aria-labelledby="card-2-heading"
          >
            <div
              className="new-enquiry-card__top"
              style={{
                cursor: 'pointer',
                marginBottom: section3Open ? undefined : 0,
              }}
              onClick={() => setSection3Open((o) => !o)}
            >
              <h2 id="card-2-heading" className="new-enquiry-card__label">
                4 · MATTER PARTIES
              </h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {isCard2Complete || isEditingExistingMatter ? (
                  <StatusPill
                    label={`✓ ${allPartiesToCheck.length} parties`}
                    tone="positive"
                  />
                ) : (
                  <span className="conflict-req-pill">
                    {clientCapacityRequired && clientCapacityCodes.length === 0
                      ? 'client capacity + at least 1 other party'
                      : 'at least 1 other party'}
                  </span>
                )}
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  aria-expanded={section3Open}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSection3Open((o) => !o);
                  }}
                >
                  {section3Open ? (
                    <>
                      <span>Minimise</span>
                      <ChevronDown size={15} />
                    </>
                  ) : (
                    <>
                      <span>Maximise</span>
                      <ChevronRight size={15} />
                    </>
                  )}
                </button>
              </div>
            </div>

            {section3Open ? (
            <>
            {/* SOFT WARNINGS (Part 2.4 — non-blocking) */}
            {missingAdversePartySoftWarning ? (
              <div
                role="status"
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '9px 12px',
                  marginBottom: 10,
                  borderRadius: 8,
                  background: 'rgba(245, 158, 11, 0.1)',
                  border: '1px solid rgba(245, 158, 11, 0.35)',
                  color: '#92400e',
                  fontSize: 12.5,
                }}
              >
                <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{missingAdversePartySoftWarning}</span>
              </div>
            ) : null}

            {duplicatePartySoftWarning.length > 0 ? (
              <div
                role="status"
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '9px 12px',
                  marginBottom: 10,
                  borderRadius: 8,
                  background: 'rgba(245, 158, 11, 0.1)',
                  border: '1px solid rgba(245, 158, 11, 0.35)',
                  color: '#92400e',
                  fontSize: 12.5,
                }}
              >
                <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                <div>
                  {duplicatePartySoftWarning.map((msg, idx) => (
                    <div key={idx}>{msg}</div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* GROUPED PARTY LIST BY RELATIONSHIP (Part 2.1 & 2.3) */}
            <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
              {groupedPartiesByRelationship.length === 0 ? (
                <div
                  style={{
                    padding: '16px 4px',
                    fontSize: 13,
                    color: 'var(--text-secondary)',
                  }}
                >
                  Select a client in Section 1 or add a party below to begin conflict checking.
                </div>
              ) : (
                groupedPartiesByRelationship.map((group) => (
                  <div key={group.code} style={{ marginTop: 8 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '6px 4px 4px',
                        fontSize: 11,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      <span>
                        {group.label} ({group.parties.length})
                      </span>
                      <span style={{ fontWeight: 500, textTransform: 'none' }}>
                        {group.description}
                      </span>
                    </div>
                    <ul className="worklist">
                      {group.parties.map((pt) => {
                        const relCode = pt.relationshipCode || group.code;
                        const relLabel =
                          taxonomy.relationships.find((r) => r.code === relCode)?.label ||
                          pt.role;
                        const capCodes = pt.capacityCodes ?? [];
                        const connectedTarget = pt.connectedToPartyId
                          ? allPartiesToCheck.find((x) => x.id === pt.connectedToPartyId)
                          : null;
                        const idSummary = formatIdentifiersSummary(
                          pt.entityType,
                          pt.identifiers,
                        );
                        const isLeadClientRow = pt.id === 'party-client';
                        const isJointClientRow =
                          pt.isClientFixed &&
                          pt.id.startsWith('party-client-') &&
                          relCode === 'JC';
                        const isInstructingRow = pt.id === 'party-instructing';
                        const jointClientRecordId = isJointClientRow
                          ? pt.linkedRecordId || pt.id.replace('party-client-', '')
                          : '';

                        const exampleClientRole =
                          clientAllowedCapacities[0]?.label || 'Landlord';

                        return (
                          <li
                            key={pt.id}
                            className="worklist-row"
                            style={{
                              paddingLeft: pt.parentPartyId ? 24 : 0,
                              alignItems: 'flex-start',
                              gap: 12,
                            }}
                          >
                            <div className="worklist-main" style={{ flex: 1 }}>
                              <div
                                className="worklist-title"
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  flexWrap: 'wrap',
                                }}
                              >
                                {pt.entityType === 'organisation' ? (
                                  <Building2 size={14} color="var(--text-secondary)" />
                                ) : (
                                  <User size={14} color="var(--text-secondary)" />
                                )}
                                <span style={{ fontWeight: 600 }}>{pt.name}</span>

                                {!pt.linkedRecordId && !pt.isClientFixed ? (
                                  <span
                                    style={{
                                      fontSize: 11,
                                      padding: '1px 7px',
                                      borderRadius: 999,
                                      background: 'var(--bg-surface-subtle)',
                                      border: '1px solid var(--border-subtle)',
                                      color: 'var(--text-secondary)',
                                      fontWeight: 500,
                                    }}
                                  >
                                    New contact (created on save)
                                  </span>
                                ) : null}

                                {pt.entityType === 'organisation' &&
                                !pt.isClientFixed &&
                                !pt.parentPartyId ? (
                                  pt.relatedEntitiesIncluded ? (
                                    <span
                                      style={{
                                        fontSize: 11.5,
                                        color: 'var(--pill-positive-fg)',
                                        fontWeight: 600,
                                      }}
                                    >
                                      ✓ Related entities included
                                    </span>
                                  ) : !isReadOnlyFeeEarner ? (
                                    <button
                                      type="button"
                                      className="conflict-inline-link"
                                      onClick={() => handleIncludeRelatedEntities(pt)}
                                    >
                                      + Include related entities
                                    </button>
                                  ) : null
                                ) : null}
                              </div>

                              {/* Identifiers & Connected To line */}
                              <div
                                className="worklist-meta"
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  flexWrap: 'wrap',
                                  gap: 8,
                                  marginTop: 2,
                                }}
                              >
                                <span>
                                  {idSummary ||
                                    pt.subtitle ||
                                    (pt.entityType === 'organisation'
                                      ? 'Organisation'
                                      : 'Person')}
                                </span>
                                {connectedTarget ? (
                                  <span
                                    style={{
                                      fontSize: 11.5,
                                      fontWeight: 600,
                                      color: 'var(--text-primary)',
                                      background: 'var(--bg-surface-subtle)',
                                      padding: '1px 8px',
                                      borderRadius: 999,
                                      border: '1px solid var(--border-subtle)',
                                    }}
                                  >
                                    Connected to: {connectedTarget.name}
                                  </span>
                                ) : null}
                              </div>

                              {/* CAPACITY CHIPS & INLINE SELECTORS (Part 2.1 & 2.3 & 2.4) */}
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  flexWrap: 'wrap',
                                  gap: 6,
                                  marginTop: 6,
                                }}
                              >
                                {capCodes.map((capCode) => {
                                  const capDef = taxonomy.capacities.find(
                                    (c) => c.code === capCode,
                                  );
                                  const capLabel = capDef?.label ?? capCode;
                                  const isTypical = isCapacityTypicalForWorkType(
                                    taxonomy,
                                    capCode,
                                    workTypeSubcategoryId,
                                  );
                                  return (
                                    <span
                                      key={capCode}
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 5,
                                        padding: '2px 9px',
                                        borderRadius: 999,
                                        fontSize: 12,
                                        fontWeight: 600,
                                        background: isTypical
                                          ? 'var(--bg-surface-subtle)'
                                          : 'rgba(245, 158, 11, 0.14)',
                                        border: isTypical
                                          ? '1px solid var(--border-default)'
                                          : '1px solid rgba(245, 158, 11, 0.45)',
                                        color: isTypical
                                          ? 'var(--text-primary)'
                                          : '#92400e',
                                      }}
                                    >
                                      <span>{capLabel}</span>
                                      {!isTypical ? (
                                        <span
                                          title="This capacity is not in the profiles mapped to the selected work type"
                                          style={{
                                            fontSize: 10.5,
                                            fontWeight: 700,
                                            color: '#b45309',
                                          }}
                                        >
                                          · Not typical for this work type
                                        </span>
                                      ) : null}
                                      {!isReadOnlyFeeEarner ? (
                                        <button
                                          type="button"
                                          aria-label={`Remove capacity ${capLabel}`}
                                          style={{
                                            border: 'none',
                                            background: 'transparent',
                                            padding: 0,
                                            cursor: 'pointer',
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            color: 'var(--text-secondary)',
                                          }}
                                          onClick={() => {
                                            if (isLeadClientRow) {
                                              setClientCapacityCodes((prev) =>
                                                prev.filter((c) => c !== capCode),
                                              );
                                            } else if (isJointClientRow) {
                                              setJointClientCapacityCodes((prev) => ({
                                                ...prev,
                                                [jointClientRecordId]: (
                                                  prev[jointClientRecordId] ?? []
                                                ).filter((c) => c !== capCode),
                                              }));
                                            } else if (isInstructingRow) {
                                              setInstructingContactCapacityCodes((prev) =>
                                                prev.filter((c) => c !== capCode),
                                              );
                                            } else {
                                              setOtherParties((prev) =>
                                                prev.map((item) =>
                                                  item.id === pt.id
                                                    ? {
                                                        ...item,
                                                        capacityCodes: (
                                                          item.capacityCodes ?? []
                                                        ).filter((c) => c !== capCode),
                                                      }
                                                    : item,
                                                ),
                                              );
                                            }
                                            if (hasRunSearch) {
                                              setPartiesChangedSinceSearch(true);
                                            }
                                          }}
                                        >
                                          <X size={12} />
                                        </button>
                                      ) : null}
                                    </span>
                                  );
                                })}

                                {/* Inline capacity selector for Lead Client row (Part 2.1) */}
                                {isLeadClientRow && !isReadOnlyFeeEarner ? (
                                  workTypeSubcategoryId ? (
                                    clientAllowedCapacities.length > 0 ? (
                                      <div
                                        style={{
                                          display: 'inline-flex',
                                          alignItems: 'center',
                                          gap: 6,
                                          flexWrap: 'wrap',
                                        }}
                                      >
                                        <select
                                          aria-label="Client's role in this matter"
                                          className="field-select"
                                          style={{
                                            height: 28,
                                            fontSize: 12,
                                            padding: '2px 24px 2px 8px',
                                            width: 'auto',
                                            minWidth: 250,
                                          }}
                                          value=""
                                          onChange={(e) => {
                                            const code = e.target.value;
                                            if (!code) return;
                                            setClientCapacityCodes((prev) =>
                                              prev.includes(code) ? prev : [...prev, code],
                                            );
                                            if (hasRunSearch) {
                                              setPartiesChangedSinceSearch(true);
                                            }
                                          }}
                                        >
                                          <option value="">
                                            {clientCapacityCodes.length === 0
                                              ? `Client's role in this matter (e.g. ${exampleClientRole})…`
                                              : '+ Add another client capacity…'}
                                          </option>
                                          {clientAllowedCapacities
                                            .filter(
                                              (c) => !clientCapacityCodes.includes(c.code),
                                            )
                                            .map((c) => (
                                              <option key={c.code} value={c.code}>
                                                {c.label}
                                              </option>
                                            ))}
                                        </select>
                                        {clientCapacityRequired &&
                                        clientCapacityCodes.length === 0 ? (
                                          <span
                                            style={{
                                              fontSize: 11.5,
                                              fontWeight: 700,
                                              color: '#b45309',
                                            }}
                                          >
                                            * Required for this work type
                                          </span>
                                        ) : null}
                                      </div>
                                    ) : null
                                  ) : (
                                    <span
                                      style={{
                                        fontSize: 11.5,
                                        color: 'var(--text-secondary)',
                                      }}
                                    >
                                      Choose a work type in Section 1 to select client&apos;s capacity
                                    </span>
                                  )
                                ) : null}

                                {/* Inline capacity selector for Joint Client row (Part 2.1) */}
                                {isJointClientRow &&
                                !isReadOnlyFeeEarner &&
                                workTypeSubcategoryId &&
                                jointClientAllowedCapacities.length > 0 ? (
                                  <select
                                    aria-label={`Joint client capacity for ${pt.name}`}
                                    className="field-select"
                                    style={{
                                      height: 28,
                                      fontSize: 12,
                                      padding: '2px 24px 2px 8px',
                                      width: 'auto',
                                      minWidth: 240,
                                    }}
                                    value=""
                                    onChange={(e) => {
                                      const code = e.target.value;
                                      if (!code) return;
                                      setJointClientCapacityCodes((prev) => {
                                        const cur = prev[jointClientRecordId] ?? [];
                                        return {
                                          ...prev,
                                          [jointClientRecordId]: cur.includes(code)
                                            ? cur
                                            : [...cur, code],
                                        };
                                      });
                                      if (hasRunSearch) {
                                        setPartiesChangedSinceSearch(true);
                                      }
                                    }}
                                  >
                                    <option value="">
                                      {capCodes.length === 0
                                        ? `Joint client's role (e.g. ${
                                            jointClientAllowedCapacities[0]?.label || 'Landlord'
                                          })…`
                                        : '+ Add capacity…'}
                                    </option>
                                    {jointClientAllowedCapacities
                                      .filter((c) => !capCodes.includes(c.code))
                                      .map((c) => (
                                        <option key={c.code} value={c.code}>
                                          {c.label}
                                        </option>
                                      ))}
                                  </select>
                                ) : null}

                                {/* Inline capacity selector for Instructing Contact row (Part 2.1) */}
                                {isInstructingRow && !isReadOnlyFeeEarner ? (
                                  <select
                                    aria-label="Add capacity for instructing contact"
                                    className="field-select"
                                    style={{
                                      height: 26,
                                      fontSize: 11.5,
                                      padding: '2px 22px 2px 8px',
                                      width: 'auto',
                                    }}
                                    value=""
                                    onChange={(e) => {
                                      const code = e.target.value;
                                      if (!code) return;
                                      setInstructingContactCapacityCodes((prev) =>
                                        prev.includes(code) ? prev : [...prev, code],
                                      );
                                      if (hasRunSearch) {
                                        setPartiesChangedSinceSearch(true);
                                      }
                                    }}
                                  >
                                    <option value="">+ Add capacity…</option>
                                    {instructingAllowedCapacities
                                      .filter((c) => !capCodes.includes(c.code))
                                      .map((c) => (
                                        <option key={c.code} value={c.code}>
                                          {c.label}
                                        </option>
                                      ))}
                                  </select>
                                ) : null}

                                {/* Prompt for user-added or migrated parties that have no capacity yet */}
                                {!pt.isClientFixed &&
                                capCodes.length === 0 &&
                                !isReadOnlyFeeEarner ? (
                                  <select
                                    aria-label={`Select capacity for ${pt.name}`}
                                    className="field-select"
                                    style={{
                                      height: 28,
                                      fontSize: 12,
                                      padding: '2px 24px 2px 8px',
                                      width: 'auto',
                                      borderColor: '#d97706',
                                    }}
                                    value=""
                                    onChange={(e) => {
                                      const code = e.target.value;
                                      if (!code) return;
                                      setOtherParties((prev) =>
                                        prev.map((item) =>
                                          item.id === pt.id
                                            ? {
                                                ...item,
                                                capacityCodes: [code],
                                                needsCapacityPrompt: false,
                                              }
                                            : item,
                                        ),
                                      );
                                      if (hasRunSearch) {
                                        setPartiesChangedSinceSearch(true);
                                      }
                                    }}
                                  >
                                    <option value="">
                                      * Select capacity for {pt.name}…
                                    </option>
                                    {getAvailableCapacitiesForParty({
                                      taxonomy,
                                      relationshipCode: relCode,
                                      workTypeSubcategoryId,
                                      showAllCapacities: !workTypeSubcategoryId,
                                    }).map((c) => (
                                      <option key={c.code} value={c.code}>
                                        {c.label}
                                      </option>
                                    ))}
                                  </select>
                                ) : null}
                              </div>
                            </div>

                            {/* RIGHT SIDE: Relationship badge + Edit & Remove buttons */}
                            <div
                              className="worklist-right"
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                flexShrink: 0,
                              }}
                            >
                              <StatusPill
                                label={relLabel}
                                tone={rolePillTone(pt.role, relCode)}
                              />
                              {!pt.isClientFixed && !isReadOnlyFeeEarner ? (
                                <>
                                  <button
                                    type="button"
                                    className="btn btn--ghost btn--sm"
                                    aria-label={`Edit ${pt.name}`}
                                    style={{ padding: '0 8px', height: 26, gap: 4 }}
                                    onClick={() => handleStartEditParty(pt)}
                                  >
                                    <Edit2 size={13} />
                                    <span style={{ fontSize: 12 }}>Edit</span>
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn--ghost btn--sm"
                                    aria-label={`Remove ${pt.name}`}
                                    style={{ padding: '0 8px', height: 26, gap: 4 }}
                                    onClick={() => handleRemoveParty(pt.id)}
                                  >
                                    <X size={14} />
                                    <span style={{ fontSize: 12 }}>Remove</span>
                                  </button>
                                </>
                              ) : isEditingExistingMatter &&
                                pt.id === 'party-instructing' ? (
                                <button
                                  type="button"
                                  className="btn btn--ghost btn--sm"
                                  aria-label={`Remove ${pt.name}`}
                                  style={{ padding: '0 8px', height: 26, gap: 4 }}
                                  onClick={() => setInstructingContactId(null)}
                                >
                                  <X size={14} />
                                  <span style={{ fontSize: 12 }}>Remove</span>
                                </button>
                              ) : null}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))
              )}
            </div>

            {/* "+ ADD PARTY" BUTTON (opens pop-up modal) */}
            {!isReadOnlyFeeEarner ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginTop: 14,
                  paddingTop: 12,
                  borderTop: '1px solid var(--border-subtle)',
                }}
              >
                <button
                  type="button"
                  className="btn btn--secondary"
                  style={{ borderRadius: 999, height: 38 }}
                  onClick={openAddPartyModal}
                >
                  <Plus size={15} />
                  <span>Add party</span>
                </button>
              </div>
            ) : null}
            </>
            ) : null}
          </section>

          {/* ================================================================
              CARD 4 · CONFLICT SEARCH
              ================================================================ */}
          <section
            ref={card3Ref}
            className="new-enquiry-card"
            aria-labelledby="card-3-heading"
          >
            <div
              className="new-enquiry-card__top"
              style={{
                cursor: 'pointer',
                marginBottom: section4Open ? undefined : 0,
              }}
              onClick={() => setSection4Open((o) => !o)}
            >
              <h2 id="card-3-heading" className="new-enquiry-card__label">
                5 · CONFLICT SEARCH
              </h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {hasRunSearch && !partiesChangedSinceSearch && allMatchesReviewed ? (
                  <StatusPill label="✓ Reviewed" tone="positive" />
                ) : hasRunSearch ? (
                  <StatusPill
                    label={`${reviewedMatchesCount} of ${matches.length} reviewed`}
                    tone="warning"
                  />
                ) : (
                  <span className="conflict-req-pill">Required</span>
                )}
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  aria-expanded={section4Open}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSection4Open((o) => !o);
                  }}
                >
                  {section4Open ? (
                    <>
                      <span>Minimise</span>
                      <ChevronDown size={15} />
                    </>
                  ) : (
                    <>
                      <span>Maximise</span>
                      <ChevronRight size={15} />
                    </>
                  )}
                </button>
              </div>
            </div>

            {section4Open ? (
            <>
            {/* Run button & last run metadata */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 12,
              }}
            >
              <div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  Searches names, previous names, emails, phone numbers and addresses
                  across all open and closed matters, clients and opponents.
                </div>
                {hasRunSearch ? (
                  <div
                    style={{
                      fontSize: 12.5,
                      color: 'var(--text-muted)',
                      marginTop: 4,
                      fontWeight: 600,
                    }}
                  >
                    Last run {lastRunAtDisplay || '—'} by{' '}
                    {lastRunByName || personDisplayName(currentUser) || 'Fee earner'}
                  </div>
                ) : null}
              </div>

              {!isReadOnlyFeeEarner ? (
                <button
                  type="button"
                  className="btn btn--primary"
                  style={{ borderRadius: 999 }}
                  disabled={otherParties.length === 0}
                  onClick={handleRunConflictSearch}
                >
                  <Search size={15} />
                  <span>Run conflict search</span>
                </button>
              ) : null}
            </div>

            {/* AMBER BANNER IF PARTIES CHANGED AFTER SEARCH */}
            {partiesChangedSinceSearch ? (
              <div
                className="conflict-banner conflict-banner--amber"
                role="alert"
                style={{ margin: 0 }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <AlertTriangle size={16} />
                  <span>
                    <strong>
                      Parties have changed since the last search. Run again before
                      submitting.
                    </strong>
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  style={{ borderRadius: 999 }}
                  onClick={handleRunConflictSearch}
                >
                  Run again
                </button>
              </div>
            ) : null}

            {/* GROUPED RESULTS BY PARTY */}
            {hasRunSearch ? (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  marginTop: 4,
                }}
              >
                {allPartiesToCheck.map((party) => {
                  const partyMatches = matches.filter((m) => m.partyId === party.id);
                  return (
                    <div key={party.id} className="conflict-party-group">
                      <div className="conflict-party-group__head">
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            flexWrap: 'wrap',
                          }}
                        >
                          <strong style={{ fontSize: 14 }}>{party.name}</strong>
                          <StatusPill
                            label={party.role}
                            tone={rolePillTone(party.role)}
                          />
                        </div>
                        {partyMatches.length === 0 ? (
                          <StatusPill label="No matches" tone="positive" />
                        ) : (
                          <StatusPill
                            label={`${partyMatches.length} ${
                              partyMatches.length === 1 ? 'match' : 'matches'
                            }`}
                            tone={
                              partyMatches.some(
                                (m) => m.disposition === 'potential_conflict',
                              )
                                ? 'alert'
                                : 'warning'
                            }
                          />
                        )}
                      </div>

                      {partyMatches.map((m) => {
                        const needsNote =
                          m.disposition === 'same_no_conflict' ||
                          m.disposition === 'potential_conflict';
                        const missingNote = needsNote && !m.note.trim();

                        return (
                          <div key={m.id} className="conflict-match-row">
                            <div className="conflict-match-row__top">
                              <div>
                                <div
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 8,
                                    flexWrap: 'wrap',
                                  }}
                                >
                                  <span
                                    style={{
                                      fontWeight: 700,
                                      fontSize: 13.5,
                                      color: 'var(--text-primary)',
                                    }}
                                  >
                                    {m.matchedRecordName}
                                  </span>
                                  <StatusPill
                                    label={`${m.strength} match`}
                                    tone={strengthPillTone(m.strength)}
                                  />
                                  {m.restricted ? (
                                    <StatusPill
                                      label="Refer to Risk"
                                      tone="alert"
                                    />
                                  ) : null}
                                  <span
                                    style={{
                                      fontSize: 13,
                                      fontWeight: 600,
                                      color: 'var(--text-primary)',
                                    }}
                                  >
                                    {m.whereFound}
                                  </span>
                                </div>
                                {!m.restricted ? (
                                  <div
                                    style={{
                                      fontSize: 12,
                                      color: 'var(--text-secondary)',
                                      marginTop: 3,
                                    }}
                                  >
                                    Responsible partner:{' '}
                                    <strong>{m.responsiblePartnerName || '—'}</strong> · Date:{' '}
                                    {m.dateLabel || '—'}
                                    {m.matchedOn ? ` · Matched on: ${m.matchedOn}` : ''}
                                  </div>
                                ) : null}
                              </div>

                              {/* 3 Segmented disposition buttons */}
                              <div
                                className="conflict-seg-group"
                                role="group"
                                aria-label={`Disposition for ${m.matchedRecordName}`}
                              >
                                <button
                                  type="button"
                                  disabled={isReadOnlyFeeEarner || Boolean(m.restricted)}
                                  className={`conflict-seg-btn ${
                                    m.disposition === 'not_the_same'
                                      ? 'conflict-seg-btn--active'
                                      : ''
                                  }`}
                                  onClick={() =>
                                    updateMatch(m.id, { disposition: 'not_the_same' })
                                  }
                                >
                                  Not the same
                                </button>
                                <button
                                  type="button"
                                  disabled={isReadOnlyFeeEarner || Boolean(m.restricted)}
                                  className={`conflict-seg-btn ${
                                    m.disposition === 'same_no_conflict'
                                      ? 'conflict-seg-btn--active conflict-seg-btn--green'
                                      : ''
                                  }`}
                                  onClick={() =>
                                    updateMatch(m.id, {
                                      disposition: 'same_no_conflict',
                                    })
                                  }
                                >
                                  Same – no conflict
                                </button>
                                <button
                                  type="button"
                                  disabled={isReadOnlyFeeEarner}
                                  className={`conflict-seg-btn ${
                                    m.disposition === 'potential_conflict'
                                      ? 'conflict-seg-btn--active conflict-seg-btn--amber'
                                      : ''
                                  }`}
                                  onClick={() =>
                                    updateMatch(m.id, {
                                      disposition: 'potential_conflict',
                                    })
                                  }
                                >
                                  Potential conflict
                                </button>
                              </div>
                            </div>

                            {/* Short note required for "Same – no conflict" and "Potential conflict" */}
                            {needsNote ? (
                              <div style={{ marginTop: 10 }}>
                                <label
                                  className="field-label"
                                  style={{ fontSize: 12 }}
                                >
                                  Fee earner disposition note{' '}
                                  <span className="field-required">*</span>
                                </label>
                                <input
                                  type="text"
                                  className="field-input"
                                  disabled={isReadOnlyFeeEarner}
                                  placeholder={
                                    m.disposition === 'same_no_conflict'
                                      ? 'Explain why there is no conflict (e.g. acting on the same side on ABC123-0001)…'
                                      : 'Explain the potential conflict and why it is being referred to Risk…'
                                  }
                                  value={m.note}
                                  onChange={(e) =>
                                    updateMatch(m.id, { note: e.target.value })
                                  }
                                />
                                {missingNote && !isReadOnlyFeeEarner ? (
                                  <div
                                    style={{
                                      fontSize: 11.5,
                                      color: 'var(--pill-alert-fg)',
                                      marginTop: 4,
                                    }}
                                  >
                                    A short note is required for this disposition.
                                  </div>
                                ) : null}
                              </div>
                            ) : null}

                            {/* REVIEWER CONTROLS (when Viewing as Risk / Compliance) */}
                            {isReviewerMode &&
                            m.disposition === 'potential_conflict' ? (
                              <div className="conflict-reviewer-box">
                                <div className="conflict-reviewer-box__head">
                                  <span className="conflict-reviewer-box__title">
                                    <ShieldCheck size={14} />
                                    <span>
                                      Risk / Compliance Reviewer Decision
                                    </span>
                                  </span>
                                  <div
                                    className="conflict-seg-group"
                                    role="group"
                                    aria-label="Reviewer decision"
                                  >
                                    <button
                                      type="button"
                                      className={`conflict-seg-btn ${
                                        m.reviewerDecision === 'approve'
                                          ? 'conflict-seg-btn--active conflict-seg-btn--green'
                                          : ''
                                      }`}
                                      onClick={() =>
                                        updateMatch(m.id, {
                                          reviewerDecision: 'approve',
                                          reviewerConditionType: null,
                                        })
                                      }
                                    >
                                      Approve
                                    </button>
                                    <button
                                      type="button"
                                      className={`conflict-seg-btn ${
                                        m.reviewerDecision ===
                                        'approve_with_conditions'
                                          ? 'conflict-seg-btn--active conflict-seg-btn--amber'
                                          : ''
                                      }`}
                                      onClick={() =>
                                        updateMatch(m.id, {
                                          reviewerDecision:
                                            'approve_with_conditions',
                                          reviewerConditionType:
                                            m.reviewerConditionType ||
                                            'consent_obtained',
                                        })
                                      }
                                    >
                                      Approve with conditions
                                    </button>
                                    <button
                                      type="button"
                                      className={`conflict-seg-btn ${
                                        m.reviewerDecision === 'decline'
                                          ? 'conflict-seg-btn--active conflict-seg-btn--red'
                                          : ''
                                      }`}
                                      onClick={() =>
                                        updateMatch(m.id, {
                                          reviewerDecision: 'decline',
                                          reviewerConditionType: null,
                                        })
                                      }
                                    >
                                      Decline
                                    </button>
                                  </div>
                                </div>

                                {m.reviewerDecision ===
                                'approve_with_conditions' ? (
                                  <div
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: 10,
                                      marginTop: 10,
                                      flexWrap: 'wrap',
                                    }}
                                  >
                                    <span
                                      style={{
                                        fontSize: 12,
                                        fontWeight: 600,
                                        color: 'var(--text-secondary)',
                                      }}
                                    >
                                      Condition type:
                                    </span>
                                    <button
                                      type="button"
                                      className={`conflict-demo-pill ${
                                        (m.reviewerConditionType ||
                                          'consent_obtained') ===
                                        'consent_obtained'
                                          ? 'conflict-demo-pill--active'
                                          : ''
                                      }`}
                                      onClick={() =>
                                        updateMatch(m.id, {
                                          reviewerConditionType:
                                            'consent_obtained' as ConflictConditionType,
                                        })
                                      }
                                    >
                                      Consent obtained
                                    </button>
                                    <button
                                      type="button"
                                      className={`conflict-demo-pill ${
                                        m.reviewerConditionType ===
                                        'information_barrier'
                                          ? 'conflict-demo-pill--active'
                                          : ''
                                      }`}
                                      onClick={() =>
                                        updateMatch(m.id, {
                                          reviewerConditionType:
                                            'information_barrier' as ConflictConditionType,
                                        })
                                      }
                                    >
                                      Information barrier
                                    </button>
                                  </div>
                                ) : null}

                                <div style={{ marginTop: 10 }}>
                                  <label
                                    className="field-label"
                                    style={{ fontSize: 12 }}
                                  >
                                    Reviewer condition / decision note{' '}
                                    <span className="field-required">*</span>
                                  </label>
                                  <input
                                    type="text"
                                    className="field-input"
                                    placeholder="Record condition details (e.g. written consent obtained or information barrier protocol)…"
                                    value={m.reviewerNote ?? ''}
                                    onChange={(e) =>
                                      updateMatch(m.id, {
                                        reviewerNote: e.target.value,
                                      })
                                    }
                                  />
                                </div>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div
                style={{
                  padding: '16px',
                  borderRadius: 10,
                  background: 'var(--bg-subtle)',
                  color: 'var(--text-secondary)',
                  fontSize: 13,
                }}
              >
                {otherParties.length === 0
                  ? 'Add at least 1 other party in Card 3, then click "Run conflict search".'
                  : 'Ready to search. Click "Run conflict search" to check all listed parties across open and closed matters.'}
              </div>
            )}
            </>
            ) : null}
          </section>

          {/* ================================================================
              CARD 5 · OUTCOME AND DECLARATION
              ================================================================ */}
          <section
            ref={card4Ref}
            className="new-enquiry-card"
            aria-labelledby="card-4-heading"
          >
            <div
              className="new-enquiry-card__top"
              style={{
                cursor: 'pointer',
                marginBottom: section5Open ? undefined : 0,
              }}
              onClick={() => setSection5Open((o) => !o)}
            >
              <h2 id="card-4-heading" className="new-enquiry-card__label">
                6 · OUTCOME AND DECLARATION
              </h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {declarationConfirmed ? (
                  <StatusPill label="✓ Confirmed" tone="positive" />
                ) : (
                  <span className="conflict-req-pill">1 required</span>
                )}
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  aria-expanded={section5Open}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSection5Open((o) => !o);
                  }}
                >
                  {section5Open ? (
                    <>
                      <span>Minimise</span>
                      <ChevronDown size={15} />
                    </>
                  ) : (
                    <>
                      <span>Maximise</span>
                      <ChevronRight size={15} />
                    </>
                  )}
                </button>
              </div>
            </div>

            {section5Open ? (
            <>
            {/* Auto-generated summary line */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 12,
                padding: '12px 14px',
                borderRadius: 10,
                background: isReferredOutcome
                  ? 'var(--pill-warning-bg)'
                  : hasRunSearch
                    ? 'var(--pill-positive-bg)'
                    : 'var(--bg-subtle)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: 13.5,
                    fontWeight: 700,
                    color: 'var(--text-primary)',
                  }}
                >
                  {allPartiesToCheck.length} parties checked · {matches.length}{' '}
                  {matches.length === 1 ? 'match' : 'matches'} ·{' '}
                  {potentialConflictsCount}{' '}
                  {potentialConflictsCount === 1
                    ? 'potential conflict'
                    : 'potential conflicts'}
                </div>
                <div
                  style={{
                    fontSize: 12.5,
                    color: 'var(--text-secondary)',
                    marginTop: 2,
                  }}
                >
                  {isReferredOutcome
                    ? 'One or more matches are marked as a potential conflict. Submitting will refer this matter to Risk & Compliance for review.'
                    : hasRunSearch
                      ? 'No conflicts identified. Fee earner can clear and open the matter immediately.'
                      : 'Run the conflict search above to calculate the conflict outcome.'}
                </div>
              </div>

              {hasRunSearch ? (
                isReferredOutcome ? (
                  <StatusPill label="Referred to risk for review" tone="warning" />
                ) : (
                  <StatusPill label="Cleared by fee earner" tone="positive" />
                )
              ) : (
                <StatusPill label="Awaiting search" tone="neutral" />
              )}
            </div>

            {/* Optional message to reviewer when outcome is Referred */}
            {isReferredOutcome ? (
              <div className="field-group">
                <label className="field-label" htmlFor="nm-reviewer-msg">
                  Message to Risk &amp; Compliance reviewer (optional)
                </label>
                <textarea
                  id="nm-reviewer-msg"
                  rows={2}
                  className="field-textarea"
                  disabled={isReadOnlyFeeEarner}
                  placeholder="Add context for the Risk reviewer (e.g. why the matters are unrelated or proposed safeguards)…"
                  value={reviewerMessage}
                  onChange={(e) => setReviewerMessage(e.target.value)}
                />
              </div>
            ) : null}

            {/* Required declaration checkbox */}
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                cursor: isReadOnlyFeeEarner ? 'default' : 'pointer',
                fontSize: 13.5,
                fontWeight: 600,
                color: 'var(--text-primary)',
                paddingTop: 4,
              }}
            >
              <input
                type="checkbox"
                checked={declarationConfirmed}
                disabled={isReadOnlyFeeEarner}
                onChange={(e) => setDeclarationConfirmed(e.target.checked)}
                style={{ width: 17, height: 17, accentColor: 'var(--teal)' }}
              />
              <span>
                I confirm the parties listed are complete to the best of my knowledge.{' '}
                <span className="field-required">*</span>
              </span>
            </label>

            {/* REVIEWER COMMENT THREAD (shown in Reviewer view or Referred state) */}
            {isReviewerMode || workflowState !== 'editing' ? (
              <div className="conflict-comment-thread">
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 12,
                    fontWeight: 800,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    color: 'var(--text-secondary)',
                    marginBottom: 10,
                  }}
                >
                  <MessageSquare size={14} />
                  <span>Risk &amp; Compliance review comment thread ({comments.length})</span>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {comments.map((c) => (
                    <div key={c.id} className="conflict-comment-item">
                      <div className="conflict-comment-item__meta">
                        <strong>{c.authorName}</strong> · <span>{c.authorRole}</span> ·{' '}
                        <span>{c.atDisplay}</span>
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                        {c.text}
                      </div>
                    </div>
                  ))}
                </div>

                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    marginTop: 10,
                  }}
                >
                  <input
                    type="text"
                    className="field-input"
                    placeholder="Add a comment to the conflict review thread…"
                    value={newCommentText}
                    onChange={(e) => setNewCommentText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddComment();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn--secondary"
                    style={{ borderRadius: 999 }}
                    onClick={handleAddComment}
                  >
                    Post comment
                  </button>
                </div>
              </div>
            ) : null}
            </>
            ) : null}
          </section>

          {/* ================================================================
              CARD 6 · MORE DETAILS (optional, collapsed by default)
              ================================================================ */}
          <section
            ref={card5Ref}
            className="new-enquiry-card"
            aria-labelledby="card-5-heading"
          >
            <div
              className="new-enquiry-card__top"
              style={{
                cursor: 'pointer',
                marginBottom: moreDetailsOpen ? undefined : 0,
              }}
              onClick={() => setMoreDetailsOpen((o) => !o)}
            >
              <div>
                <h2 id="card-5-heading" className="new-enquiry-card__label">
                  7 · MORE DETAILS
                </h2>
                <div
                  style={{
                    fontSize: 12.5,
                    color: 'var(--text-secondary)',
                    marginTop: 3,
                  }}
                >
                  Not needed to open the matter. You can complete these later.
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="conflict-req-pill">Optional</span>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  aria-expanded={moreDetailsOpen}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMoreDetailsOpen((o) => !o);
                  }}
                >
                  {moreDetailsOpen ? (
                    <>
                      <span>Minimise</span>
                      <ChevronDown size={15} />
                    </>
                  ) : (
                    <>
                      <span>Maximise</span>
                      <ChevronRight size={15} />
                    </>
                  )}
                </button>
              </div>
            </div>

            {moreDetailsOpen ? (
              <div>
                {/* Reuse tab pattern from Add a person */}
                <div
                  className="form-tabs-bar"
                  role="tablist"
                  aria-label="Optional matter details"
                >
                  {(
                    [
                      { key: 'most_used' as const, label: 'Most used' },
                      { key: 'billing' as const, label: 'Billing' },
                      { key: 'key_dates' as const, label: 'Key dates' },
                      { key: 'matter_facts' as const, label: 'Matter facts' },
                      { key: 'compliance' as const, label: 'Compliance' },
                      { key: 'custom_fields' as const, label: 'Custom fields' },
                    ]
                  ).map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      role="tab"
                      aria-selected={optionalTab === t.key}
                      className={`form-tab-btn ${
                        optionalTab === t.key ? 'form-tab-btn--active' : ''
                      }`}
                      onClick={() => setOptionalTab(t.key)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                {optionalTab === 'most_used' ? (
                  <div className="form-grid" style={{ gap: '14px 16px' }}>
                    <div className="field-group field-group--full">
                      <label className="field-label">Scope / short summary</label>
                      <textarea
                        rows={2}
                        className="field-textarea"
                        placeholder="Unknown value"
                        value={shortDescription}
                        onChange={(e) => setShortDescription(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Matter type</label>
                      <select
                        className="field-select"
                        value={matterTypeId}
                        onChange={(e) => setMatterTypeId(e.target.value)}
                      >
                        <option value="">Unknown value</option>
                        {values
                          .filter((v) => v.listKey === 'matter_type' && v.active)
                          .map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.label}
                            </option>
                          ))}
                      </select>
                    </div>
                    <div className="field-group">
                      <label className="field-label">Supervising partner</label>
                      <select
                        className="field-select"
                        value={supervisingPartnerId ?? ''}
                        onChange={(e) => setSupervisingPartnerId(e.target.value || null)}
                      >
                        <option value="">Unknown value</option>
                        {employees.map((emp) => (
                          <option key={emp.id} value={emp.id}>
                            {personDisplayName(emp)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                ) : null}

                {optionalTab === 'billing' ? (
                  <div className="form-grid" style={{ gap: '14px 16px' }}>
                    <div className="field-group">
                      <label className="field-label">Billing basis</label>
                      <select
                        className="field-select"
                        value={billingBasisId}
                        onChange={(e) => setBillingBasisId(e.target.value)}
                      >
                        <option value="">Unknown value</option>
                        {values
                          .filter((v) => v.listKey === 'billing_basis' && v.active)
                          .map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.label}
                            </option>
                          ))}
                      </select>
                    </div>
                    <div className="field-group">
                      <label className="field-label">Billing contact</label>
                      <select
                        className="field-select"
                        value={billingContactId ?? ''}
                        onChange={(e) => setBillingContactId(e.target.value || null)}
                      >
                        <option value="">Unknown value</option>
                        {clientContacts.map((p) => (
                          <option key={p.id} value={p.id}>
                            {personDisplayName(p)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field-group">
                      <label className="field-label">Fee estimate (£)</label>
                      <input
                        type="number"
                        className="field-input"
                        placeholder="Unknown value"
                        value={feeEstimateGbp}
                        onChange={(e) => setFeeEstimateGbp(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Agreed fee cap (£)</label>
                      <input
                        type="number"
                        className="field-input"
                        placeholder="Unknown value"
                        value={agreedFeeCapGbp}
                        onChange={(e) => setAgreedFeeCapGbp(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Monies on account (£)</label>
                      <input
                        type="number"
                        className="field-input"
                        placeholder="Unknown value"
                        value={retainerMoniesOnAccountGbp}
                        onChange={(e) => setRetainerMoniesOnAccountGbp(e.target.value)}
                      />
                    </div>
                  </div>
                ) : null}

                {optionalTab === 'key_dates' ? (
                  <div className="form-grid" style={{ gap: '14px 16px' }}>
                    <div className="field-group">
                      <label className="field-label">Opened date</label>
                      <input
                        type="date"
                        className="field-input"
                        value={openedAt ?? ''}
                        onChange={(e) => setOpenedAt(e.target.value || null)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Target completion date</label>
                      <input
                        type="date"
                        className="field-input"
                        value={targetCompletionAt ?? ''}
                        onChange={(e) => setTargetCompletionAt(e.target.value || null)}
                      />
                    </div>
                    {customKeyDates.length > 0 ? (
                      <div className="field-group field-group--full">
                        <label className="field-label">
                          Key dates from Matter risk assessment ({customKeyDates.length})
                        </label>
                        <ul
                          className="worklist"
                          style={{
                            border: '1px solid var(--border-subtle)',
                            borderRadius: 8,
                            padding: '0 12px',
                          }}
                        >
                          {customKeyDates.map((kd) => (
                            <li key={kd.id} className="worklist-row">
                              <div className="worklist-main">
                                <span style={{ fontWeight: 600 }}>{kd.label}</span>
                                <span className="worklist-meta" style={{ marginLeft: 8 }}>
                                  {kd.date}
                                </span>
                              </div>
                              <div className="worklist-right">
                                <button
                                  type="button"
                                  className="btn btn--ghost btn--sm"
                                  onClick={() => handleRemoveCustomKeyDate(kd.id)}
                                >
                                  <X size={13} />
                                </button>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {optionalTab === 'matter_facts' ? (
                  <div className="form-grid" style={{ gap: '14px 16px' }}>
                    <div className="field-group">
                      <label className="field-label">Client reference</label>
                      <input
                        type="text"
                        className="field-input"
                        placeholder="Client's own reference"
                        value={clientReference}
                        onChange={(e) => setClientReference(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Claim value (estimated)</label>
                      <input
                        type="text"
                        className="field-input"
                        placeholder="e.g. Medium (£5k–£25k)"
                        value={claimValue}
                        onChange={(e) => setClaimValue(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Responsible office</label>
                      <input
                        type="text"
                        className="field-input"
                        placeholder={
                          orgStructure.offices[0]?.name
                            ? `e.g. ${orgStructure.offices[0].name}`
                            : 'Office name'
                        }
                        value={responsibleOffice}
                        onChange={(e) => setResponsibleOffice(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Source of work</label>
                      <input
                        type="text"
                        className="field-input"
                        placeholder="e.g. Existing client — cross-referral from Corporate"
                        value={sourceOfWork}
                        onChange={(e) => setSourceOfWork(e.target.value)}
                      />
                    </div>
                    {activeSpecificFields.slice(0, 6).map((field) => (
                      <div key={field.id} className="field-group">
                        <label className="field-label">{field.name}</label>
                        {renderOptionalFieldControl(field)}
                      </div>
                    ))}
                    {activeFieldGroups.flatMap((g) => g.fields).slice(0, 4).map((field) => (
                      <div key={field.id} className="field-group">
                        <label className="field-label">{field.name}</label>
                        {renderOptionalFieldControl(field)}
                      </div>
                    ))}
                  </div>
                ) : null}

                {optionalTab === 'compliance' ? (
                  <div className="form-grid" style={{ gap: '14px 16px' }}>
                    <div className="field-group">
                      <label className="field-label">Risk rating</label>
                      <select
                        className="field-select"
                        value={riskRatingId}
                        onChange={(e) => setRiskRatingId(e.target.value)}
                      >
                        <option value="">Unknown value</option>
                        {values
                          .filter((v) => v.listKey === 'risk_rating' && v.active)
                          .map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.label}
                            </option>
                          ))}
                      </select>
                    </div>
                    <div className="field-group">
                      <label className="field-label">Client due diligence (AML)</label>
                      <select
                        className="field-select"
                        value={amlStatus}
                        onChange={(e) => setAmlStatus(e.target.value)}
                      >
                        <option value="">Unknown value</option>
                        <option value="Pending">Pending</option>
                        <option value="Verified">Verified</option>
                        <option value="In progress">In progress</option>
                      </select>
                    </div>
                    <div className="field-group">
                      <label className="field-label">Source of funds verified</label>
                      <select
                        className="field-select"
                        value={sourceOfFundsVerified}
                        onChange={(e) => setSourceOfFundsVerified(e.target.value)}
                      >
                        <option value="">Unknown value</option>
                        <option value="In progress">In progress</option>
                        <option value="Yes">Yes</option>
                        <option value="No">No</option>
                        <option value="N/A">N/A</option>
                      </select>
                    </div>
                    <div className="field-group">
                      <label className="field-label">Engagement letter status</label>
                      <select
                        className="field-select"
                        value={engagementLetterStatus}
                        onChange={(e) => setEngagementLetterStatus(e.target.value)}
                      >
                        <option value="">Unknown value</option>
                        <option value="Drafting">Drafting</option>
                        <option value="Sent to client">Sent to client</option>
                        <option value="Signed & returned">Signed &amp; returned</option>
                      </select>
                    </div>
                  </div>
                ) : null}

                {optionalTab === 'custom_fields' ? (
                  <div className="form-grid" style={{ gap: '14px 16px' }}>
                    <div className="field-group">
                      <label className="field-label">Client own reference</label>
                      <input
                        type="text"
                        className="field-input"
                        placeholder="Unknown value"
                        value={clientReference}
                        onChange={(e) => setClientReference(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Forum / Court / Registry</label>
                      <input
                        type="text"
                        className="field-input"
                        placeholder="Unknown value"
                        value={forumCourt}
                        onChange={(e) => setForumCourt(e.target.value)}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        </div>

        {/* ==================== RIGHT STICKY COLUMN ==================== */}
        <aside className="person-form-side-col" style={{ marginTop: 24 }}>
          {/* STICKY TOP ACTIONS (24px top offset + 40px button row = 64px, matching left header so cards align at top) */}
          <div className="new-enquiry-footer-actions" style={{ justifyContent: 'flex-end', minHeight: 40 }}>
            {isEditingExistingMatter ? (
              <>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => handleNavigateBack()}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  style={{ borderRadius: 999 }}
                  disabled={!canSaveExisting || saving}
                  onClick={handleSaveExistingMatter}
                >
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
              </>
            ) : isReviewerMode ? (
              <>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    setIsReviewerMode(false);
                    setWorkflowState('editing');
                  }}
                >
                  Exit reviewer view
                </button>
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={saving}
                  onClick={() => handleReviewerFinalise('decline')}
                >
                  Decline matter
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  style={{ borderRadius: 999 }}
                  disabled={saving}
                  onClick={() => handleReviewerFinalise('approve')}
                >
                  {matches.some(
                    (m) =>
                      m.disposition === 'potential_conflict' &&
                      m.reviewerDecision === 'approve_with_conditions',
                  )
                    ? 'Record approval with conditions'
                    : 'Approve & open matter'}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => handleNavigateBack()}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--secondary"
                  style={{ borderRadius: 999 }}
                  disabled={saving || workflowState !== 'editing'}
                  onClick={handleSaveDraft}
                >
                  Save draft
                </button>
                <button
                  type="button"
                  className="btn btn--secondary"
                  style={{ borderRadius: 999 }}
                  disabled={saving || workflowState !== 'editing'}
                  onClick={handleOpenAssignModal}
                >
                  Assign
                </button>
                <span
                  title={
                    !canSubmit && missingItems.length > 0
                      ? `Still needed before submitting:\n• ${missingItems.join('\n• ')}`
                      : 'All mandatory items complete — click to submit'
                  }
                  style={{ display: 'inline-block' }}
                >
                  <button
                    type="button"
                    className="btn btn--primary"
                    style={{ borderRadius: 999 }}
                    disabled={!canSubmit || saving}
                    onClick={handleSubmitMatter}
                  >
                    Submit
                  </button>
                </span>
              </>
            )}
          </div>

          {/* CARD 1 · "MATTER OPENING" PROGRESS */}
          <section className="new-enquiry-card" aria-label="Matter opening progress">
            <div className="new-enquiry-card__top">
              <h2 className="new-enquiry-card__label">MATTER OPENING</h2>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: 'var(--text-secondary)',
                }}
              >
                Step {Math.max(1, completedStepsCount)} of 6
              </span>
            </div>

            {/* Segmented green bar reused from Matter Progress card */}
            <div
              className="client-stage-bars"
              style={{ margin: '0 0 6px' }}
              aria-label={`Step ${completedStepsCount} of 6`}
            >
              {[1, 2, 3, 4, 5, 6].map((seg) => (
                <div
                  key={seg}
                  className={`client-stage-bar ${
                    seg <= completedStepsCount ? 'client-stage-bar--filled' : ''
                  }`}
                />
              ))}
            </div>

            {/* Vertical tick list in "Intake & compliance" style — each row scrolls to its card */}
            <ul className="worklist" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <li
                className="worklist-row conflict-step-row"
                onClick={() => scrollToCard(card1Ref, 1)}
              >
                <div
                  className="worklist-main"
                  style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  {isCard1Complete ? (
                    <Check size={15} color="var(--pill-positive-fg)" strokeWidth={2.6} />
                  ) : (
                    <span className="conflict-step-circle" />
                  )}
                  <span style={{ fontSize: 13, fontWeight: 600 }}>Matter details</span>
                </div>
                <div className="worklist-right">
                  <span
                    className="worklist-meta"
                    style={{
                      color: isCard1Complete
                        ? 'var(--pill-positive-fg)'
                        : 'var(--text-secondary)',
                      fontWeight: isCard1Complete ? 700 : 500,
                    }}
                  >
                    {isCard1Complete
                      ? '✓ Complete'
                      : `${mandatoryDetailsDoneCount} of ${requiredCard1Total}`}
                  </span>
                </div>
              </li>

              <li
                className="worklist-row conflict-step-row"
                onClick={() => scrollToCard(cardCostsRef, 'costs')}
              >
                <div
                  className="worklist-main"
                  style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  {matterCostsCompletion.isComplete ? (
                    <Check size={15} color="var(--pill-positive-fg)" strokeWidth={2.6} />
                  ) : (
                    <span className="conflict-step-circle" />
                  )}
                  <span style={{ fontSize: 13, fontWeight: 600 }}>Matter costs</span>
                </div>
                <div className="worklist-right">
                  <span
                    className="worklist-meta"
                    style={{
                      color: matterCostsCompletion.isComplete
                        ? 'var(--pill-positive-fg)'
                        : 'var(--text-secondary)',
                      fontWeight: matterCostsCompletion.isComplete ? 700 : 500,
                    }}
                  >
                    {matterCostsCompletion.isComplete
                      ? `✓ ${
                          WORK_BASIS_OPTIONS.find((opt) => opt.key === costWorkBasis)?.label ??
                          'Complete'
                        }`
                      : `${matterCostsCompletion.doneCount} of ${matterCostsCompletion.totalRequired}`}
                  </span>
                </div>
              </li>

              <li
                className="worklist-row conflict-step-row"
                onClick={() => scrollToCard(cardRiskRef, 2)}
              >
                <div
                  className="worklist-main"
                  style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  {riskAssessmentSummary.isComplete ? (
                    <Check size={15} color="var(--pill-positive-fg)" strokeWidth={2.6} />
                  ) : (
                    <span className="conflict-step-circle" />
                  )}
                  <span style={{ fontSize: 13, fontWeight: 600 }}>Matter risk assessment</span>
                </div>
                <div className="worklist-right">
                  <span
                    className="worklist-meta"
                    style={{
                      color: riskAssessmentSummary.isComplete
                        ? 'var(--pill-positive-fg)'
                        : 'var(--text-secondary)',
                      fontWeight: riskAssessmentSummary.isComplete ? 700 : 500,
                    }}
                  >
                    {riskAssessmentSummary.isComplete
                      ? `✓ Complete${
                          riskAssessmentSummary.overallRisk
                            ? ` (${riskAssessmentSummary.overallRisk})`
                            : ''
                        }`
                      : `${riskAssessmentSummary.remainingQuestions} to complete`}
                  </span>
                </div>
              </li>

              <li
                className="worklist-row conflict-step-row"
                onClick={() => scrollToCard(card2Ref, 3)}
              >
                <div
                  className="worklist-main"
                  style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  {isCard2Complete ? (
                    <Check size={15} color="var(--pill-positive-fg)" strokeWidth={2.6} />
                  ) : (
                    <span className="conflict-step-circle" />
                  )}
                  <span style={{ fontSize: 13, fontWeight: 600 }}>Parties added</span>
                </div>
                <div className="worklist-right">
                  <span
                    className="worklist-meta"
                    style={{
                      color: isCard2Complete
                        ? 'var(--pill-positive-fg)'
                        : 'var(--text-secondary)',
                      fontWeight: isCard2Complete ? 700 : 500,
                    }}
                  >
                    {isCard2Complete
                      ? `✓ ${allPartiesToCheck.length} parties`
                      : 'Add at least 1'}
                  </span>
                </div>
              </li>

              <li
                className="worklist-row conflict-step-row"
                onClick={() => scrollToCard(card3Ref, 4)}
              >
                <div
                  className="worklist-main"
                  style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  {hasRunSearch && !partiesChangedSinceSearch ? (
                    <Check size={15} color="var(--pill-positive-fg)" strokeWidth={2.6} />
                  ) : hasRunSearch ? (
                    <AlertCircle size={15} color="var(--pill-warning-fg)" />
                  ) : (
                    <span className="conflict-step-circle" />
                  )}
                  <span style={{ fontSize: 13, fontWeight: 600 }}>Conflict search</span>
                </div>
                <div className="worklist-right">
                  <span
                    className="worklist-meta"
                    style={{
                      color: partiesChangedSinceSearch
                        ? 'var(--pill-warning-fg)'
                        : hasRunSearch
                           ? 'var(--pill-positive-fg)'
                          : 'var(--text-secondary)',
                      fontWeight: hasRunSearch ? 700 : 500,
                    }}
                  >
                    {partiesChangedSinceSearch
                      ? '⟳ Re-run needed'
                      : hasRunSearch
                        ? '⟳ Run 17:42'
                        : '○ Not run'}
                  </span>
                </div>
              </li>

              <li
                className="worklist-row conflict-step-row"
                onClick={() => scrollToCard(card3Ref, 4)}
              >
                <div
                  className="worklist-main"
                  style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  {allMatchesReviewed ? (
                    <Check size={15} color="var(--pill-positive-fg)" strokeWidth={2.6} />
                  ) : hasRunSearch ? (
                    <AlertCircle size={15} color="var(--pill-warning-fg)" />
                  ) : (
                    <span className="conflict-step-circle" />
                  )}
                  <span style={{ fontSize: 13, fontWeight: 600 }}>Matches reviewed</span>
                </div>
                <div className="worklist-right">
                  <span
                    className="worklist-meta"
                    style={{
                      color: allMatchesReviewed
                        ? 'var(--pill-positive-fg)'
                        : hasRunSearch
                          ? 'var(--pill-warning-fg)'
                          : 'var(--text-secondary)',
                      fontWeight: hasRunSearch ? 700 : 500,
                    }}
                  >
                    {!hasRunSearch
                      ? '—'
                      : allMatchesReviewed
                        ? `✓ ${matches.length} of ${matches.length} reviewed`
                        : `! ${reviewedMatchesCount} of ${matches.length} reviewed`}
                  </span>
                </div>
              </li>

              <li
                className="worklist-row conflict-step-row"
                onClick={() => scrollToCard(card4Ref, 5)}
              >
                <div
                  className="worklist-main"
                  style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  {declarationConfirmed ? (
                    <Check size={15} color="var(--pill-positive-fg)" strokeWidth={2.6} />
                  ) : (
                    <span className="conflict-step-circle" />
                  )}
                  <span style={{ fontSize: 13, fontWeight: 600 }}>Declaration</span>
                </div>
                <div className="worklist-right">
                  <span
                    className="worklist-meta"
                    style={{
                      color: declarationConfirmed
                        ? 'var(--pill-positive-fg)'
                        : 'var(--text-secondary)',
                      fontWeight: declarationConfirmed ? 700 : 500,
                    }}
                  >
                    {declarationConfirmed ? '✓ Confirmed' : '○ Not confirmed'}
                  </span>
                </div>
              </li>
            </ul>
          </section>
        </aside>
      </div>

      {/* ==================== CLIENT LOOKUP & ADD POP-UP MODAL ==================== */}
      {clientModalOpen ? (
        <div
          className="modal-backdrop"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1200,
            background: 'rgba(15, 23, 42, 0.52)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            padding: '32px 20px',
            overflowY: 'auto',
          }}
          onClick={() => setClientModalOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={
              clientModalView === 'search'
                ? 'Look up or add client'
                : clientModalView === 'new_person'
                  ? 'Add new person as client'
                  : 'Add new organisation as client'
            }
            style={{
              width: '100%',
              maxWidth: clientModalView === 'search' ? 920 : 1240,
              background: 'var(--bg-surface)',
              borderRadius: 14,
              border: '1px solid var(--border-default)',
              boxShadow: '0 24px 60px rgba(15, 23, 42, 0.24)',
              overflow: 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* MODAL TOP BAR */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '16px 22px',
                borderBottom: '1px solid var(--border-subtle)',
                background: 'var(--bg-surface-subtle)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
                  {clientModalView === 'search'
                    ? 'Add client or contact to matter'
                    : clientModalView === 'new_person'
                      ? 'New person · Add as client'
                      : clientModalView === 'edit_person'
                        ? 'Complete client details · Person'
                        : clientModalView === 'edit_org'
                          ? 'Complete client details · Organisation'
                          : 'New organisation · Add as client'}
                </h2>
              </div>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                aria-label="Close client lookup modal"
                onClick={() => setClientModalOpen(false)}
              >
                <X size={16} />
              </button>
            </div>

            {clientModalView === 'search' ? (
              <div style={{ padding: '20px 22px' }}>
                {/* 3 SEARCH INPUTS: FIRST NAME, SURNAME, ORGANISATION */}
                <div
                  className="form-grid"
                  style={{
                    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                    gap: 14,
                    marginBottom: 18,
                  }}
                >
                  <div className="field-group">
                    <label className="field-label" htmlFor="client-lookup-fn">
                      First name
                    </label>
                    <input
                      id="client-lookup-fn"
                      type="text"
                      className="field-input"
                      placeholder="e.g. Alun"
                      value={clientSearchFirstName}
                      onChange={(e) => setClientSearchFirstName(e.target.value)}
                      autoFocus
                    />
                  </div>
                  <div className="field-group">
                    <label className="field-label" htmlFor="client-lookup-sn">
                      Surname
                    </label>
                    <input
                      id="client-lookup-sn"
                      type="text"
                      className="field-input"
                      placeholder="e.g. Davies"
                      value={clientSearchSurname}
                      onChange={(e) => setClientSearchSurname(e.target.value)}
                    />
                  </div>
                  <div className="field-group">
                    <label className="field-label" htmlFor="client-lookup-org">
                      Organisation
                    </label>
                    <input
                      id="client-lookup-org"
                      type="text"
                      className="field-input"
                      placeholder="e.g. Acme Holdings Ltd"
                      value={clientSearchOrg}
                      onChange={(e) => setClientSearchOrg(e.target.value)}
                    />
                  </div>
                </div>

                {/* RESULTS HEADER & TABLE (blank until any details are entered) */}
                {hasClientSearchQuery ? (
                  <>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: 8,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '0.04em',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        Matching people &amp; organisations ({clientLookupResults.length})
                      </span>
                      {tickedClientIds.length > 0 ? (
                        <span
                          style={{
                            fontSize: 12.5,
                            fontWeight: 600,
                            color: 'var(--accent-primary)',
                          }}
                        >
                          {tickedClientIds.length} selected
                        </span>
                      ) : null}
                    </div>

                    <div
                      style={{
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 10,
                        maxHeight: 340,
                        overflowY: 'auto',
                        marginBottom: 18,
                      }}
                    >
                      {clientLookupResults.length === 0 ? (
                        <div
                          style={{
                            padding: '28px 20px',
                            textAlign: 'center',
                            color: 'var(--text-secondary)',
                            fontSize: 13.5,
                          }}
                        >
                          No matching people or organisations found in the system. Use the buttons
                          below to add a new person or organisation.
                        </div>
                      ) : (
                        <table
                          className="enquiries-table"
                          style={{ width: '100%', borderCollapse: 'collapse' }}
                        >
                          <thead>
                            <tr>
                              <th style={{ width: 42, padding: '8px 12px', textAlign: 'center' }}>
                                <span className="sr-only">Select</span>
                              </th>
                              <th style={{ padding: '8px 12px', textAlign: 'left' }}>Name</th>
                              <th style={{ padding: '8px 12px', textAlign: 'left' }}>Type</th>
                              <th style={{ padding: '8px 12px', textAlign: 'left' }}>
                                Organisation
                              </th>
                              <th style={{ padding: '8px 12px', textAlign: 'left' }}>Details</th>
                            </tr>
                          </thead>
                          <tbody>
                            {clientLookupResults.map((row) => {
                              const isChecked =
                                row.alreadyAdded || tickedClientIds.includes(row.id);
                              return (
                                <tr
                                  key={row.id}
                                  style={{
                                    borderTop: '1px solid var(--border-subtle)',
                                    cursor: row.alreadyAdded ? 'default' : 'pointer',
                                    background: isChecked
                                      ? 'var(--bg-surface-subtle)'
                                      : 'var(--bg-surface)',
                                  }}
                                  onClick={() => {
                                    if (!row.alreadyAdded) {
                                      toggleTickedClientId(row.id);
                                    }
                                  }}
                                >
                                  <td
                                    style={{ padding: '8px 12px', textAlign: 'center' }}
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <input
                                      type="checkbox"
                                      aria-label={`Select ${row.name} as client`}
                                      checked={isChecked}
                                      disabled={row.alreadyAdded}
                                      onChange={() => {
                                        if (!row.alreadyAdded) {
                                          toggleTickedClientId(row.id);
                                        }
                                      }}
                                    />
                                  </td>
                                  <td style={{ padding: '8px 12px', fontWeight: 600 }}>
                                    <div
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 8,
                                        flexWrap: 'wrap',
                                      }}
                                    >
                                      {row.missingClientFields.length > 0 ? (
                                        <AlertCircle
                                          size={15}
                                          color="#d93025"
                                          aria-label={`Details needed to convert to client: ${row.missingClientFields.join(', ')}`}
                                          style={{ flexShrink: 0 }}
                                        />
                                      ) : row.entityType === 'organisation' ? (
                                        <Building2 size={14} color="var(--text-secondary)" />
                                      ) : (
                                        <User size={14} color="var(--text-secondary)" />
                                      )}
                                      <span>{row.name}</span>
                                      {row.missingClientFields.length > 0 ? (
                                        <span
                                          style={{
                                            fontSize: 11,
                                            fontWeight: 700,
                                            color: '#d93025',
                                            background: 'rgba(217, 48, 37, 0.1)',
                                            border: '1px solid rgba(217, 48, 37, 0.28)',
                                            borderRadius: 999,
                                            padding: '1px 7px',
                                          }}
                                        >
                                          ! Details needed: {row.missingClientFields.join(', ')}
                                        </span>
                                      ) : null}
                                      {row.matchNote ? (
                                        <StatusPill
                                          label={
                                            row.matchNote === 'similar spelling'
                                              ? 'Similar spelling'
                                              : 'Sounds alike'
                                          }
                                          tone="warning"
                                        />
                                      ) : null}
                                      {row.alreadyAdded ? (
                                        <StatusPill label="Already added" tone="positive" />
                                      ) : null}
                                    </div>
                                  </td>
                                  <td style={{ padding: '8px 12px' }}>
                                    <StatusPill
                                      label={
                                        row.entityType === 'organisation'
                                          ? 'Organisation'
                                          : 'Person'
                                      }
                                      tone="neutral"
                                    />
                                  </td>
                                  <td style={{ padding: '8px 12px', fontSize: 13 }}>
                                    {row.organisationName}
                                  </td>
                                  <td
                                    style={{
                                      padding: '8px 12px',
                                      fontSize: 12.5,
                                      color: 'var(--text-secondary)',
                                    }}
                                  >
                                    {row.details || '—'}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </>
                ) : (
                  <div style={{ minHeight: 16 }} />
                )}

                {/* MODAL FOOTER: CREATE NEW PERSON / ORG OR ADD TICKED */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: 12,
                    paddingTop: 14,
                    borderTop: '1px solid var(--border-subtle)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span
                      style={{
                        fontSize: 12.5,
                        color: 'var(--text-secondary)',
                        fontWeight: 500,
                      }}
                    >
                      Not in the list?
                    </span>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      style={{ borderRadius: 999 }}
                      onClick={() => setClientModalView('new_person')}
                    >
                      <Plus size={14} />
                      <span>Add new person</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      style={{ borderRadius: 999 }}
                      onClick={() => setClientModalView('new_org')}
                    >
                      <Plus size={14} />
                      <span>Add new organisation</span>
                    </button>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => setClientModalOpen(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn btn--primary"
                      style={{ borderRadius: 999 }}
                      disabled={tickedClientIds.length === 0}
                      onClick={() =>
                        handleAddClientsToMatter(
                          tickedClientIds,
                          `Added ${tickedClientIds.length} ${
                            tickedClientIds.length === 1 ? 'client' : 'clients'
                          } to matter`,
                        )
                      }
                    >
                      Add selected as client{tickedClientIds.length > 1 ? 's' : ''}
                      {tickedClientIds.length > 0 ? ` (${tickedClientIds.length})` : ''}
                    </button>
                  </div>
                </div>
              </div>
            ) : clientModalView === 'new_person' || clientModalView === 'edit_person' ? (
              <div style={{ padding: '20px 24px', maxHeight: '80vh', overflowY: 'auto' }}>
                <PersonFormClient
                  embeddedInModal
                  highlightMissingClientFields={clientModalView === 'edit_person'}
                  existing={
                    clientModalView === 'edit_person'
                      ? people.find((p) => p.id === editingClientRecordId) ?? null
                      : null
                  }
                  initialFirstName={clientSearchFirstName}
                  initialSurname={clientSearchSurname}
                  initialLinkOrgId={matchedOrgForNewPerson}
                  allPeople={people}
                  organisations={organisations}
                  matters={matters}
                  enquiries={enquiries}
                  employees={employees}
                  lists={lists}
                  values={values}
                  customFields={customFields}
                  currentUserId={currentUser.id}
                  tenantId={tenantId}
                  orgStructure={orgStructure}
                  onCancelModal={() => setClientModalOpen(false)}
                  onSelectExistingPerson={(existingPerson) => {
                    handleAddClientsToMatter(
                      [existingPerson.id],
                      `Added existing contact ${personDisplayName(existingPerson)} as client`,
                    );
                  }}
                  onPersonCreated={(savedPerson, linkedOrgId) => {
                    setPeople((prev) => {
                      const filtered =
                        editingClientRecordId && editingClientRecordId !== savedPerson.id
                          ? prev.filter((p) => p.id !== editingClientRecordId)
                          : prev;
                      return filtered.some((p) => p.id === savedPerson.id)
                        ? filtered.map((p) => (p.id === savedPerson.id ? savedPerson : p))
                        : [...filtered, savedPerson];
                    });
                    if (editingClientRecordId && editingClientRecordId !== savedPerson.id) {
                      setClientIds((prev) =>
                        prev.map((id) => (id === editingClientRecordId ? savedPerson.id : id)),
                      );
                    }
                    if (linkedOrgId) {
                      setLinks((prev) => [
                        ...prev,
                        {
                          id: `L-MODAL-${Date.now()}`,
                          personId: savedPerson.id,
                          organisationId: linkedOrgId,
                          jobTitle: savedPerson.jobTitle,
                          department: '',
                          roleWithinOrganisation: savedPerson.jobTitle,
                          contactRoleIds: [],
                          isPrimaryContact: true,
                          isCurrent: true,
                          startDate: null,
                          endDate: null,
                          contactStatusId: null,
                          createdById: currentUser.id,
                          createdAt: today,
                          updatedById: currentUser.id,
                          updatedAt: today,
                        },
                      ]);
                    }
                    handleAddClientsToMatter(
                      [savedPerson.id],
                      clientModalView === 'edit_person'
                        ? `Updated client details for ${personDisplayName(savedPerson)}`
                        : `Created ${personDisplayName(savedPerson)} and added as client`,
                    );
                  }}
                />
              </div>
            ) : (
              <div style={{ padding: '20px 24px', maxHeight: '80vh', overflowY: 'auto' }}>
                <OrganisationFormClient
                  embeddedInModal
                  highlightMissingClientFields={clientModalView === 'edit_org'}
                  existing={
                    clientModalView === 'edit_org'
                      ? organisations.find((o) => o.id === editingClientRecordId) ?? null
                      : null
                  }
                  initialLegalName={
                    clientSearchOrg ||
                    [clientSearchFirstName, clientSearchSurname].filter(Boolean).join(' ')
                  }
                  allOrganisations={organisations}
                  allPeople={people}
                  matters={matters}
                  enquiries={enquiries}
                  employees={employees}
                  lists={lists}
                  values={values}
                  customFields={customFields}
                  currentUserId={currentUser.id}
                  tenantId={tenantId}
                  onCancelModal={() => setClientModalOpen(false)}
                  onSelectExistingOrganisation={(existingOrg) => {
                    handleAddClientsToMatter(
                      [existingOrg.id],
                      `Added existing organisation ${existingOrg.legalName} as client`,
                    );
                  }}
                  onOrganisationCreated={(savedOrg) => {
                    setOrganisations((prev) =>
                      prev.some((o) => o.id === savedOrg.id)
                        ? prev.map((o) => (o.id === savedOrg.id ? savedOrg : o))
                        : [...prev, savedOrg],
                    );
                    handleAddClientsToMatter(
                      [savedOrg.id],
                      clientModalView === 'edit_org'
                        ? `Updated client details for ${savedOrg.legalName}`
                        : `Created ${savedOrg.legalName} and added as client`,
                    );
                  }}
                />
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* ==================== ADD / EDIT PARTY POP-UP MODAL ==================== */}
      {partyModalOpen ? (
        <div
          className="modal-backdrop"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1200,
            background: 'rgba(15, 23, 42, 0.52)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            padding: '32px 20px',
            overflowY: 'auto',
          }}
          onClick={resetAddPartyForm}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={
              editingPartyId
                ? 'Edit party on matter'
                : newPartyType === 'person'
                  ? 'New person · Add as party'
                  : 'New organisation · Add as party'
            }
            style={{
              width: '100%',
              maxWidth: 1240,
              background: 'var(--bg-surface)',
              borderRadius: 14,
              border: '1px solid var(--border-default)',
              boxShadow: '0 24px 60px rgba(15, 23, 42, 0.24)',
              overflow: 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* MODAL TOP BAR */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
                flexWrap: 'wrap',
                padding: '16px 22px',
                borderBottom: '1px solid var(--border-subtle)',
                background: 'var(--bg-surface-subtle)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
                  {editingPartyId
                    ? `Edit party · ${newPartyType === 'person' ? 'Person' : 'Organisation'}`
                    : newPartyType === 'person'
                      ? 'New person · Add as party'
                      : 'New organisation · Add as party'}
                </h2>
                <div
                  className="conflict-seg-group"
                  role="group"
                  aria-label="Party record type"
                >
                  <button
                    type="button"
                    className={`conflict-seg-btn ${
                      newPartyType === 'organisation' ? 'conflict-seg-btn--active' : ''
                    }`}
                    onClick={() => setNewPartyType('organisation')}
                  >
                    <Building2 size={14} style={{ marginRight: 5 }} />
                    Organisation
                  </button>
                  <button
                    type="button"
                    className={`conflict-seg-btn ${
                      newPartyType === 'person' ? 'conflict-seg-btn--active' : ''
                    }`}
                    onClick={() => setNewPartyType('person')}
                  >
                    <User size={14} style={{ marginRight: 5 }} />
                    Person
                  </button>
                </div>
              </div>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                aria-label="Close add party modal"
                onClick={resetAddPartyForm}
              >
                <X size={16} />
              </button>
            </div>

            {/* MODAL BODY: MIRRORS NEW PERSON AND NEW ORG SCREEN (NAME ONLY MANDATORY) */}
            <div style={{ padding: '20px 24px', maxHeight: '82vh', overflowY: 'auto' }}>
              {(() => {
                const partyRoleTopSlot = (
                  <section
                    className="new-enquiry-card"
                    aria-label="Role on this matter"
                    style={{ marginBottom: 14 }}
                  >
                    <div className="new-enquiry-card__top">
                      <h2 className="new-enquiry-card__label">ROLE ON THIS MATTER</h2>
                      <span className="new-enquiry-badge">Optional</span>
                    </div>

                    <div
                      className="form-grid"
                      style={{
                        gridTemplateColumns: ['CC', 'CO', 'TP'].includes(newPartyRelationshipCode)
                          ? 'repeat(3, minmax(0, 1fr))'
                          : 'repeat(2, minmax(0, 1fr))',
                        gap: 14,
                        marginTop: 4,
                      }}
                    >
                      {/* Relationship */}
                      <div className="field-group">
                        <label className="field-label" htmlFor="nm-party-relationship">
                          Relationship
                        </label>
                        <select
                          id="nm-party-relationship"
                          className="field-select"
                          value={newPartyRelationshipCode}
                          onChange={(e) => handleSelectAddPartyRelationship(e.target.value)}
                        >
                          <option value="">Please select…</option>
                          {activeAddPartyRelationships.map((rel) => (
                            <option key={rel.code} value={rel.code}>
                              {rel.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* Capacity */}
                      <div className="field-group">
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 8,
                          }}
                        >
                          <label className="field-label" htmlFor="nm-party-capacity-select">
                            Capacity
                          </label>
                          {workTypeSubcategoryId && newPartyRelationshipCode ? (
                            <button
                              type="button"
                              className="conflict-inline-link"
                              style={{ fontSize: 11.5 }}
                              onClick={() => setShowAllCapacities((prev) => !prev)}
                            >
                              {showAllCapacities
                                ? 'Filter by work type'
                                : 'Show all capacities'}
                            </button>
                          ) : null}
                        </div>

                        {!workTypeSubcategoryId ? (
                          <select
                            id="nm-party-capacity-select"
                            className="field-select"
                            disabled
                            value=""
                          >
                            <option value="">Choose a work type in Section 1 first…</option>
                          </select>
                        ) : !newPartyRelationshipCode ? (
                          <select
                            id="nm-party-capacity-select"
                            className="field-select"
                            disabled
                            value=""
                          >
                            <option value="">Select a relationship first…</option>
                          </select>
                        ) : (
                          <div>
                            <select
                              id="nm-party-capacity-select"
                              className="field-select"
                              value=""
                              onChange={(e) => {
                                const code = e.target.value;
                                if (!code) return;
                                setNewPartyCapacityCodes((prev) =>
                                  prev.includes(code) ? prev : [...prev, code],
                                );
                              }}
                            >
                              <option value="">
                                {newPartyCapacityCodes.length === 0
                                  ? 'Select one or more capacities…'
                                  : `${newPartyCapacityCodes.length} selected — add another…`}
                              </option>
                              {groupedCapacitiesForAdd.map((grp) => (
                                <optgroup key={grp.group} label={grp.group}>
                                  {grp.items.map((cap) => (
                                    <option
                                      key={cap.code}
                                      value={cap.code}
                                      disabled={newPartyCapacityCodes.includes(cap.code)}
                                    >
                                      {newPartyCapacityCodes.includes(cap.code)
                                        ? `✓ ${cap.label}`
                                        : cap.label}
                                    </option>
                                  ))}
                                </optgroup>
                              ))}
                            </select>

                            {newPartyCapacityCodes.length > 0 ? (
                              <div
                                style={{
                                  display: 'flex',
                                  flexWrap: 'wrap',
                                  gap: 5,
                                  marginTop: 6,
                                }}
                              >
                                {newPartyCapacityCodes.map((code) => {
                                  const capDef = taxonomy.capacities.find(
                                    (c) => c.code === code,
                                  );
                                  return (
                                    <span
                                      key={code}
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 4,
                                        padding: '2px 8px',
                                        borderRadius: 999,
                                        fontSize: 11.5,
                                        fontWeight: 600,
                                        background: 'var(--bg-surface-subtle)',
                                        border: '1px solid var(--border-default)',
                                      }}
                                    >
                                      <span>{capDef?.label ?? code}</span>
                                      <button
                                        type="button"
                                        aria-label={`Remove ${capDef?.label ?? code}`}
                                        style={{
                                          border: 'none',
                                          background: 'transparent',
                                          padding: 0,
                                          cursor: 'pointer',
                                          display: 'inline-flex',
                                          alignItems: 'center',
                                        }}
                                        onClick={() =>
                                          setNewPartyCapacityCodes((prev) =>
                                            prev.filter((c) => c !== code),
                                          )
                                        }
                                      >
                                        <X size={11} />
                                      </button>
                                    </span>
                                  );
                                })}
                              </div>
                            ) : null}
                          </div>
                        )}
                      </div>

                      {/* Connected to (shown for CC, CO and TP) */}
                      {['CC', 'CO', 'TP'].includes(newPartyRelationshipCode) ? (
                        <div className="field-group">
                          <label className="field-label" htmlFor="nm-party-connected-to">
                            Connected to
                          </label>
                          <select
                            id="nm-party-connected-to"
                            className="field-select"
                            value={newPartyConnectedToId}
                            onChange={(e) => setNewPartyConnectedToId(e.target.value)}
                          >
                            <option value="">None / not specified</option>
                            {allPartiesToCheck
                              .filter((p) => p.id !== editingPartyId)
                              .map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name} (
                                  {taxonomy.relationships.find(
                                    (r) => r.code === p.relationshipCode,
                                  )?.label || p.role}
                                  )
                                </option>
                              ))}
                          </select>
                        </div>
                      ) : null}
                    </div>
                  </section>
                );

                if (newPartyType === 'person') {
                  const existingPartyPerson = newPartyLinkedId
                    ? people.find((p) => p.id === newPartyLinkedId) ?? null
                    : null;
                  const nameParts = newPartyName.trim().split(/\s+/).filter(Boolean);
                  const initFirstName = nameParts[0] ?? '';
                  const initSurname = nameParts.slice(1).join(' ');

                  const addPersonRecordToMatter = (personRec: Person, toastText: string) => {
                    handleAddParty({
                      id: editingPartyId ?? undefined,
                      name: personDisplayName(personRec),
                      entityType: 'person',
                      relationshipCode: newPartyRelationshipCode,
                      capacityCodes: newPartyCapacityCodes,
                      connectedToPartyId: ['CC', 'CO', 'TP'].includes(newPartyRelationshipCode)
                        ? newPartyConnectedToId ||
                          getDefaultConnectedToForRelationship(newPartyRelationshipCode) ||
                          null
                        : null,
                      identifiers: {
                        dateOfBirth: personRec.dateOfBirth || undefined,
                        previousNames:
                          personRec.otherNames?.map((n) => n.name).join(', ') || undefined,
                        town: personRec.addresses?.[0]?.town || undefined,
                      },
                      linkedRecordId: personRec.id,
                    });
                    showToast(toastText);
                  };

                  return (
                    <PersonFormClient
                      key={`party-person-${editingPartyId ?? 'new'}-${newPartyLinkedId ?? 'unlinked'}`}
                      embeddedInModal
                      nameOnlyMandatory
                      modalTitle={
                        editingPartyId
                          ? `Edit ${existingPartyPerson ? personDisplayName(existingPartyPerson) : newPartyName || 'person'}`
                          : 'Add a person'
                      }
                      modalSubmitLabel={
                        editingPartyId
                          ? 'Save changes & update party'
                          : 'Create person & add as party'
                      }
                      modalCancelLabel="Cancel"
                      modalSelectExistingLabel={(p) =>
                        `Add ${personDisplayName(p)} as party`
                      }
                      topSlot={partyRoleTopSlot}
                      existing={existingPartyPerson}
                      initialFirstName={initFirstName}
                      initialSurname={initSurname}
                      allPeople={people}
                      organisations={organisations}
                      matters={matters}
                      enquiries={enquiries}
                      employees={employees}
                      lists={lists}
                      values={values}
                      customFields={customFields}
                      currentUserId={currentUser.id}
                      tenantId={tenantId}
                      orgStructure={orgStructure}
                      onCancelModal={resetAddPartyForm}
                      onSelectExistingPerson={(existingPerson) => {
                        addPersonRecordToMatter(
                          existingPerson,
                          `Added ${personDisplayName(existingPerson)} to matter parties`,
                        );
                      }}
                      onPersonCreated={(savedPerson, linkedOrgId) => {
                        setPeople((prev) =>
                          prev.some((p) => p.id === savedPerson.id)
                            ? prev.map((p) => (p.id === savedPerson.id ? savedPerson : p))
                            : [...prev, savedPerson],
                        );
                        if (linkedOrgId) {
                          setLinks((prev) => [
                            ...prev,
                            {
                              id: `L-PARTY-MODAL-${Date.now()}`,
                              personId: savedPerson.id,
                              organisationId: linkedOrgId,
                              jobTitle: savedPerson.jobTitle,
                              department: '',
                              roleWithinOrganisation: savedPerson.jobTitle,
                              contactRoleIds: [],
                              isPrimaryContact: true,
                              isCurrent: true,
                              startDate: null,
                              endDate: null,
                              contactStatusId: null,
                              createdById: currentUser.id,
                              createdAt: today,
                              updatedById: currentUser.id,
                              updatedAt: today,
                            },
                          ]);
                        }
                        addPersonRecordToMatter(
                          savedPerson,
                          editingPartyId
                            ? `Updated party ${personDisplayName(savedPerson)}`
                            : `Created ${personDisplayName(savedPerson)} and added as party`,
                        );
                      }}
                    />
                  );
                }

                const existingPartyOrg = newPartyLinkedId
                  ? organisations.find((o) => o.id === newPartyLinkedId) ?? null
                  : null;

                const addOrgRecordToMatter = (orgRec: Organisation, toastText: string) => {
                  handleAddParty({
                    id: editingPartyId ?? undefined,
                    name: orgRec.legalName,
                    entityType: 'organisation',
                    relationshipCode: newPartyRelationshipCode,
                    capacityCodes: newPartyCapacityCodes,
                    connectedToPartyId: ['CC', 'CO', 'TP'].includes(newPartyRelationshipCode)
                      ? newPartyConnectedToId ||
                        getDefaultConnectedToForRelationship(newPartyRelationshipCode) ||
                        null
                      : null,
                    identifiers: {
                      companyNumber: orgRec.companyNumber || undefined,
                      previousNames:
                        orgRec.otherNames?.map((n) => n.name).join(', ') || undefined,
                      registeredTown: orgRec.registeredAddress?.town || undefined,
                    },
                    linkedRecordId: orgRec.id,
                  });
                  showToast(toastText);
                };

                return (
                  <OrganisationFormClient
                    key={`party-org-${editingPartyId ?? 'new'}-${newPartyLinkedId ?? 'unlinked'}`}
                    embeddedInModal
                    nameOnlyMandatory
                    modalTitle={
                      editingPartyId
                        ? `Edit ${existingPartyOrg ? existingPartyOrg.legalName : newPartyName || 'organisation'}`
                        : 'Add an organisation'
                    }
                    modalSubmitLabel={
                      editingPartyId
                        ? 'Save changes & update party'
                        : 'Create Org. & add as party'
                    }
                    modalCancelLabel="Cancel"
                    modalSelectExistingLabel={(o) => `Add ${o.legalName} as party`}
                    topSlot={partyRoleTopSlot}
                    existing={existingPartyOrg}
                    initialLegalName={newPartyName}
                    initialCompanyNumber={newPartyIdentifiers.companyNumber}
                    allOrganisations={organisations}
                    allPeople={people}
                    matters={matters}
                    enquiries={enquiries}
                    employees={employees}
                    lists={lists}
                    values={values}
                    customFields={customFields}
                    currentUserId={currentUser.id}
                    tenantId={tenantId}
                    onCancelModal={resetAddPartyForm}
                    onSelectExistingOrganisation={(existingOrg) => {
                      addOrgRecordToMatter(
                        existingOrg,
                        `Added ${existingOrg.legalName} to matter parties`,
                      );
                    }}
                    onOrganisationCreated={(savedOrg) => {
                      setOrganisations((prev) =>
                        prev.some((o) => o.id === savedOrg.id)
                          ? prev.map((o) => (o.id === savedOrg.id ? savedOrg : o))
                          : [...prev, savedOrg],
                      );
                      addOrgRecordToMatter(
                        savedOrg,
                        editingPartyId
                          ? `Updated party ${savedOrg.legalName}`
                          : `Created ${savedOrg.legalName} and added as party`,
                      );
                    }}
                  />
                );
              })()}
            </div>
          </div>
        </div>
      ) : null}

      {/* ==================== UNSAVED CHANGES / LEAVE WARNING MODAL ==================== */}
      {leaveWarningModalOpen ? (
        <div
          className="modal-backdrop"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1400,
            background: 'rgba(15, 23, 42, 0.56)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          }}
          onClick={() => setLeaveWarningModalOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="leave-matter-warning-title"
            style={{
              width: '100%',
              maxWidth: 520,
              background: 'var(--bg-surface)',
              borderRadius: 14,
              border: '1px solid var(--border-default)',
              boxShadow: '0 24px 60px rgba(15, 23, 42, 0.28)',
              padding: '22px 24px',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 999,
                  background: 'var(--pill-warning-bg)',
                  color: 'var(--pill-warning-fg)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <AlertTriangle size={18} />
              </div>
              <div style={{ flex: 1 }}>
                <h2
                  id="leave-matter-warning-title"
                  style={{ margin: 0, fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}
                >
                  Leave this page? Data you have entered could be lost
                </h2>
                <p
                  style={{
                    margin: '8px 0 0',
                    fontSize: 13.5,
                    lineHeight: 1.5,
                    color: 'var(--text-secondary)',
                  }}
                >
                  You have unsaved details on this new matter screen. If you leave now without
                  saving a draft, the information you have entered could be lost.
                  {initialEnquiry ? (
                    <>
                      {' '}
                      (Tip: use <strong>View enquiry ↗</strong> in the banner above to open{' '}
                      <strong>{initialEnquiry.reference}</strong> in a new tab while keeping this
                      page open.)
                    </>
                  ) : null}
                </p>
              </div>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                gap: 10,
                flexWrap: 'wrap',
                marginTop: 20,
                paddingTop: 14,
                borderTop: '1px solid var(--border-subtle)',
              }}
            >
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => setLeaveWarningModalOpen(false)}
              >
                Stay on this page
              </button>
              {!isEditingExistingMatter ? (
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={saving}
                  onClick={async () => {
                    const target = leaveWarningTargetHref;
                    setLeaveWarningModalOpen(false);
                    await handleSaveDraft();
                    performImmediateNavigate(target);
                  }}
                >
                  Save draft &amp; leave
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn--primary"
                style={{
                  background: 'var(--pill-alert-fg, #b91c1c)',
                  borderColor: 'var(--pill-alert-fg, #b91c1c)',
                }}
                onClick={() => {
                  const target = leaveWarningTargetHref;
                  setLeaveWarningModalOpen(false);
                  performImmediateNavigate(target);
                }}
              >
                Leave without saving
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* CREATE / ASSIGN TASK MODAL */}
      <CreateTaskModal
        open={assignModalOpen}
        headerTitle="Create task"
        headerSubtitle="Create a task on this matter and assign it to one or more people."
        peopleSectionLabel="PEOPLE ON THIS MATTER"
        initialTaskName={`New matter submission for ${title.trim() || '[MATTER NAME]'}`}
        taskNamePlaceholder="New matter submission for [MATTER NAME]"
        suggestedPeople={suggestedMatterTaskAssignees}
        initialSelectedPersonIds={initialSelectedAssignPersonIds}
        employees={employees}
        values={values}
        defaultDueHoursFromNow={48}
        submitting={assignSubmitting}
        submitLabel="Create task"
        onClose={() => setAssignModalOpen(false)}
        onSubmit={handleConfirmAssignTask}
      />
    </div>
  );
}
