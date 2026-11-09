'use client';

import React, { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  addChoiceValueAction,
  anonymiseExpiredEnquiriesAction,
  clearAllDataAction,
  createMatterStageGroupAction,
  reorderChoiceValueAction,
  reorderCustomFieldAction,
  resetDemoDataAction,
  saveCustomFieldAction,
  saveEnquirySettingsAction,
  saveOrgStructureAction,
  saveTaskSettingsAction,
  saveTeamAction,
  updateChoiceValueAction,
  updateEmployeeRoleAction,
  updateEmployeeRolesAndSupportsAction,
} from '@/app/actions';
import { isActionDenied } from '@/domain/actionResult';
import {
  CUSTOM_FIELD_SCREEN_OPTIONS,
  formatSectionLocationLabel,
  getDefaultSectionForRecordType,
  getScreenFieldLocations,
} from '@/domain/customFields';
import { isReadyForRetentionAnonymisation } from '@/domain/enquiries';
import { whereUsed } from '@/domain/fieldRegistry';
import { canDeactivate, resolveLabel, valuesForList } from '@/domain/lists';
import { buildDefaultMatterPartyTaxonomy } from '@/domain/matterParties';
import { personDisplayName, primaryEmail } from '@/domain/names';
import { buildDefaultOrgStructure } from '@/domain/orgStructure';
import { findPracticeAreaRoutingClashes, userTeams } from '@/domain/tasks';
import type {
  AppRole,
  ChoiceList,
  ChoiceValue,
  CustomFieldDefinition,
  CustomFieldRecordType,
  CustomFieldType,
  Enquiry,
  EnquirySettings,
  FormSection,
  HomePagesConfig,
  HomeRoleKey,
  ListGroup,
  Matter,
  MatterCostsConfig,
  MatterPartyMigrationReport,
  MatterPartyTaxonomy,
  Organisation,
  OrgStructureCatalogue,
  Person,
  RecordType,
  TaskSettings,
  Team,
} from '@/domain/types';
import type { PmsAdminSnapshot } from '@/server/services';
import { DocumentStoresAdminPanel } from './DocumentStoresAdminPanel';
import { DocumentTemplatesAdminPanel } from './DocumentTemplatesAdminPanel';
import { HomePagesAdminSection } from './HomePagesAdminSection';
import { MatterCostsAdminSection } from './MatterCostsAdminSection';
import { MatterPartiesAdminSection } from './MatterPartiesAdminSection';
import { PmsLinksAdminSection } from './PmsLinksAdminSection';
import { RbacAdminSection } from './RbacAdminSection';
import { KeyDatesAdminPanel } from './KeyDatesAdminPanel';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';
import type { PermissionKey, RbacConfiguration } from '@/domain/rbac';
import type { KeyDatePermission, KeyDatesConfig } from '@/domain/keyDates.types';

export type AdminTab =
  | 'home-pages'
  | 'rbac-and-entra'
  | 'org-structure'
  | 'rates-and-costs'
  | 'document-templates'
  | 'document-stores'
  | 'key-dates'
  | 'lists'
  | 'custom-fields'
  | 'teams'
  | 'enquiry-settings'
  | 'task-settings'
  | 'employees'
  | 'pms-links'
  | 'demo-data';

const GROUP_LABELS: { key: ListGroup; label: string }[] = [
  { key: 'people', label: 'People' },
  { key: 'organisations', label: 'Organisations' },
  { key: 'shared', label: 'Shared' },
  { key: 'taxonomy', label: 'Taxonomy' },
  { key: 'matters', label: 'Matters' },
  { key: 'documents', label: 'Documents' },
  { key: 'enquiries', label: 'Enquiries' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'custom', label: 'Custom field lists' },
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

const LIST_GROUP_OVERRIDES: Record<string, ListGroup> = {
  document_type: 'documents',
  audience: 'documents',
};

const LIST_LABEL_OVERRIDES: Record<string, string> = {
  work_type: 'Worktype / Matters',
  matter_type: 'Matter type',
  matter_status: 'Matter Status',
  matter_party_role: 'Matter Parties',
  matter_employee_role: 'Employees',
  matter_stage: 'Matter stage',
  matter_size: 'Matter size',
  billing_basis: 'Billing Basis',
  jurisdiction: 'Jurisdiction',
  audience: 'Audience',
  document_type: 'Document type',
};

const MATTER_ROLE_KEYS = new Set(['matter_party_role', 'matter_employee_role']);

const FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  text: 'Short text',
  longText: 'Long text',
  number: 'Number',
  date: 'Date',
  yesNo: 'Yes / No',
  choice: 'Choice (drop-down)',
};

const APP_ROLE_LABELS: Record<AppRole, string> = {
  call_handler: 'Call handler',
  fee_earner: 'Fee earner / caseworker',
  team_lead: 'Team lead / supervising partner',
  admin: 'Admin',
};

interface Props {
  initialTab: AdminTab;
  initialListKey?: string;
  activeViewingRole?: string;
  lists: ChoiceList[];
  values: ChoiceValue[];
  customFields: CustomFieldDefinition[];
  people: Person[];
  organisations?: Organisation[];
  matters?: Matter[];
  teams: Team[];
  enquirySettings: EnquirySettings;
  taskSettings: TaskSettings;
  enquiries: Enquiry[];
  pmsAdmin?: PmsAdminSnapshot;
  homePagesConfig?: HomePagesConfig;
  defaultRoleConfigs?: import('@/domain/types').RoleHomeConfig[];
  orgStructure?: OrgStructureCatalogue;
  matterPartyTaxonomy?: MatterPartyTaxonomy;
  matterPartyMigrationReport?: MatterPartyMigrationReport;
  matterCostsConfig?: MatterCostsConfig;
  enableMatterCostsGovernance?: boolean;
  enablePmsLiveRateSync?: boolean;
  currentUserId?: string;
  currentUserPermissions?: PermissionKey[];
  appRoleByPersonId?: Record<string, AppRole>;
  rolesByPersonId?: Record<string, HomeRoleKey[]>;
  permissionsByPersonId?: Record<string, PermissionKey[]>;
  rbacConfig: RbacConfiguration;
  keyDatesConfig?: KeyDatesConfig;
  currentUserKeyDatePermissions?: KeyDatePermission[];
  entraSession?: import('@/server/entraAuth').EntraSessionPayload | null;
  entraEnvStatus?: import('@/server/entraAuth').EntraEnvStatus;
  authError?: string;
  authSuccess?: boolean;
  firmName?: string;
}

export function AdminClient({
  initialTab,
  initialListKey,
  activeViewingRole,
  lists,
  values,
  customFields,
  people,
  organisations = [],
  matters = [],
  teams,
  enquirySettings,
  taskSettings,
  enquiries,
  pmsAdmin,
  homePagesConfig,
  defaultRoleConfigs,
  orgStructure: orgStructureProp,
  matterPartyTaxonomy,
  matterPartyMigrationReport,
  matterCostsConfig,
  enableMatterCostsGovernance = false,
  enablePmsLiveRateSync = false,
  currentUserId,
  currentUserPermissions,
  appRoleByPersonId = {},
  rolesByPersonId = {},
  permissionsByPersonId = {},
  rbacConfig,
  keyDatesConfig,
  currentUserKeyDatePermissions = [],
  entraSession,
  entraEnvStatus,
  authError,
  authSuccess,
  firmName = 'Firm',
}: Props) {
  const { showToast } = useToast();
  const [tab, setTab] = useState<AdminTab>(initialTab);
  const [orgCatalogue, setOrgCatalogue] = useState<OrgStructureCatalogue>(
    () => orgStructureProp ?? buildDefaultOrgStructure({ legalName: firmName || 'Firm' }),
  );
  const [newDivName, setNewDivName] = useState('');
  const [newDivCode, setNewDivCode] = useState('');
  const [newDeptName, setNewDeptName] = useState('');
  const [newDeptCode, setNewDeptCode] = useState('');
  const [newDeptDivId, setNewDeptDivId] = useState('DIV-LEGAL');
  const [newDeptCcId, setNewDeptCcId] = useState('CC-RE');
  const [newDeptPcId, setNewDeptPcId] = useState('PC-RE');
  const [newTeamName, setNewTeamName] = useState('');
  const [newTeamCode, setNewTeamCode] = useState('');
  const [newTeamDeptId, setNewTeamDeptId] = useState('DEPT-RE');
  const [newOfficeName, setNewOfficeName] = useState('');
  const [newOfficeCode, setNewOfficeCode] = useState('');
  const [newCcName, setNewCcName] = useState('');
  const [newCcCode, setNewCcCode] = useState('');
  const [newPcName, setNewPcName] = useState('');
  const [newPcCode, setNewPcCode] = useState('');
  const [selectedListKey, setSelectedListKey] = useState<string>(
    initialListKey && lists.some((l) => l.key === initialListKey)
      ? initialListKey
      : 'relationship_standing',
  );
  const [openListGroups, setOpenListGroups] = useState<Set<ListGroup>>(() => {
    const init = new Set<ListGroup>();
    if (initialListKey) {
      const found = lists.find((l) => l.key === initialListKey);
      if (found) init.add(LIST_GROUP_OVERRIDES[found.key] ?? found.group);
    }
    return init;
  });
  const [matterRolesOpen, setMatterRolesOpen] = useState(
    () => initialListKey === 'matter_party_role' || initialListKey === 'matter_employee_role',
  );
  const [pending, startTransition] = useTransition();

  const normalizedLists = useMemo(() => {
    const mapped = lists.map((l) => {
      const nextLabel = LIST_LABEL_OVERRIDES[l.key] ?? l.label;
      const nextGroup = LIST_GROUP_OVERRIDES[l.key] ?? l.group;
      return nextLabel !== l.label || nextGroup !== l.group
        ? { ...l, label: nextLabel, group: nextGroup }
        : l;
    });
    mapped.sort((a, b) => {
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
    return mapped;
  }, [lists]);

  const toggleListGroup = (groupKey: ListGroup) => {
    setOpenListGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  };

  // Value editor state
  const [editingValId, setEditingValId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editGuidance, setEditGuidance] = useState('');
  const [editMatterTypeId, setEditMatterTypeId] = useState('');
  const [editMatterStageId, setEditMatterStageId] = useState('');
  const [editBillingBasisId, setEditBillingBasisId] = useState('');
  const [editAmlInScope, setEditAmlInScope] = useState(true);
  const [editClientMoneyThresholdGbp, setEditClientMoneyThresholdGbp] = useState('100000');

  // Add value state & popup modal state
  const DEFAULT_STAGE_GROUP_ID = 'matter_stage_group.default_group';
  const [addValueModalOpen, setAddValueModalOpen] = useState(false);
  const [newValLabel, setNewValLabel] = useState('');
  const [newValDesc, setNewValDesc] = useState('');
  const [newValGuidance, setNewValGuidance] = useState('');
  const [newValParentId, setNewValParentId] = useState<string>('');
  const [newValMatterTypeId, setNewValMatterTypeId] = useState<string>('');
  const [newValMatterStageId, setNewValMatterStageId] = useState<string>(DEFAULT_STAGE_GROUP_ID);
  const [newValBillingBasisId, setNewValBillingBasisId] = useState<string>('');
  const [newValAmlInScope, setNewValAmlInScope] = useState<boolean>(true);
  const [newValClientMoneyThresholdGbp, setNewValClientMoneyThresholdGbp] =
    useState<string>('100000');
  const [newValStageGroupId, setNewValStageGroupId] = useState<string>(DEFAULT_STAGE_GROUP_ID);

  // Matter stage group modal state
  const [stageGroupModalOpen, setStageGroupModalOpen] = useState(false);
  const [newStageGroupLabel, setNewStageGroupLabel] = useState('');
  const [newStageGroupDesc, setNewStageGroupDesc] = useState('');
  const [newStageGroupMode, setNewStageGroupMode] = useState<'from_default' | 'scratch'>(
    'from_default',
  );
  const [selectedDefaultStageIds, setSelectedDefaultStageIds] = useState<string[]>([]);

  // Collapsible parent value categories (collapsed by default)
  const [expandedParentIds, setExpandedParentIds] = useState<Set<string>>(() => new Set());
  const [expandedStageGroupIds, setExpandedStageGroupIds] = useState<Set<string>>(() => new Set());
  const [workTypeSearch, setWorkTypeSearch] = useState('');

  const toggleParentExpanded = (parentId: string) => {
    setExpandedParentIds((prev) => {
      const next = new Set(prev);
      if (next.has(parentId)) {
        next.delete(parentId);
      } else {
        next.add(parentId);
      }
      return next;
    });
  };

  const toggleStageGroupExpanded = (groupId: string) => {
    setExpandedStageGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  // Custom fields state
  const [cfRecordType, setCfRecordType] = useState<CustomFieldRecordType>('enquiry');
  const [cfModalOpen, setCfModalOpen] = useState(false);
  const [editingCf, setEditingCf] = useState<CustomFieldDefinition | null>(null);
  const [cfLabel, setCfLabel] = useState('');
  const [cfType, setCfType] = useState<CustomFieldType>('text');
  const [cfSection, setCfSection] = useState<FormSection>('enquiry_details');
  const [cfRequired, setCfRequired] = useState(false);
  const [cfOptionsText, setCfOptionsText] = useState('');

  // Team editor modal state
  const [teamModalOpen, setTeamModalOpen] = useState(false);
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);
  const [teamName, setTeamName] = useState('');
  const [teamDesc, setTeamDesc] = useState('');
  const [teamMemberIds, setTeamMemberIds] = useState<string[]>([]);
  const [teamLeadIds, setTeamLeadIds] = useState<string[]>([]);
  const [teamPracticeAreaIds, setTeamPracticeAreaIds] = useState<string[]>([]);

  // Enquiry settings state
  const [emergencyHours, setEmergencyHours] = useState(enquirySettings.emergencyHours);
  const [workDayStart, setWorkDayStart] = useState(enquirySettings.workDayStart);
  const [workDayEnd, setWorkDayEnd] = useState(enquirySettings.workDayEnd);
  const [failedAttempts, setFailedAttempts] = useState(
    enquirySettings.failedAttemptsBeforeSuggestNoResponse,
  );
  const [retentionMonths, setRetentionMonths] = useState(enquirySettings.retentionMonths);

  // Task settings state
  const [templates, setTemplates] = useState(taskSettings.templates);

  const selectedList = useMemo(
    () => normalizedLists.find((l) => l.key === selectedListKey) ?? normalizedLists[0],
    [normalizedLists, selectedListKey],
  );

  const listValues = useMemo(
    () => valuesForList(values, selectedList.key),
    [values, selectedList.key],
  );

  const topLevelValues = useMemo(
    () => listValues.filter((v) => !v.parentId),
    [listValues],
  );

  const practiceAreas = useMemo(
    () => valuesForList(values, 'work_type').filter((v) => !v.parentId && v.active),
    [values],
  );

  const matterTypeOptions = useMemo(
    () => valuesForList(values, 'matter_type').filter((v) => v.active),
    [values],
  );

  const matterStageValues = useMemo(
    () => valuesForList(values, 'matter_stage'),
    [values],
  );

  const activeMatterStageValues = useMemo(
    () => matterStageValues.filter((v) => v.active),
    [matterStageValues],
  );

  const matterStageGroups = useMemo<ChoiceValue[]>(() => {
    const stored = valuesForList(values, 'matter_stage_group');
    const hasDefault = stored.some((g) => g.id === DEFAULT_STAGE_GROUP_ID);
    const defaultEntry: ChoiceValue = {
      id: DEFAULT_STAGE_GROUP_ID,
      listKey: 'matter_stage_group',
      label: 'Default Group',
      description: 'Default matter stages and milestones setup.',
      sortOrder: 1,
      active: true,
      systemKey: 'default_group',
    };
    return hasDefault ? stored : [defaultEntry, ...stored];
  }, [values]);

  const matterStageParents = useMemo(
    () => activeMatterStageValues.filter((v) => !v.parentId),
    [activeMatterStageValues],
  );

  const defaultGroupStages = useMemo(
    () =>
      matterStageValues.filter(
        (v) =>
          !v.parentId &&
          (!v.meta?.stageGroupId || v.meta.stageGroupId === DEFAULT_STAGE_GROUP_ID),
      ),
    [matterStageValues],
  );

  const resolveMatterStageOptionLabel = (id?: string): string => {
    if (!id) return '';
    if (id === DEFAULT_STAGE_GROUP_ID) {
      const found = values.find((v) => v.id === DEFAULT_STAGE_GROUP_ID);
      return found ? found.label : 'Default Group';
    }
    const found = values.find((v) => v.id === id);
    if (!found) return '';
    if (found.listKey === 'matter_stage_group') {
      return `${found.label} (Stage group)`;
    }
    if (found.parentId) {
      const parent = values.find((v) => v.id === found.parentId);
      const grpId = parent?.meta?.stageGroupId || DEFAULT_STAGE_GROUP_ID;
      const grp = matterStageGroups.find((g) => g.id === grpId);
      return `${grp ? `${grp.label} › ` : ''}${parent ? `${parent.label} › ` : ''}${found.label}`;
    }
    const grpId = found.meta?.stageGroupId || DEFAULT_STAGE_GROUP_ID;
    const grp = matterStageGroups.find((g) => g.id === grpId);
    return `${grp ? `${grp.label} › ` : ''}${found.label}`;
  };

  const billingBasisOptions = useMemo(
    () => valuesForList(values, 'billing_basis').filter((v) => v.active),
    [values],
  );

  const taskTypes = useMemo(
    () => valuesForList(values, 'task_type').filter((v) => v.active),
    [values],
  );

  const taskPriorities = useMemo(
    () => valuesForList(values, 'task_priority').filter((v) => v.active),
    [values],
  );

  const routingClashes = useMemo(
    () => findPracticeAreaRoutingClashes(teams),
    [teams],
  );

  const customFieldUsage = useMemo(
    () =>
      customFields
        .filter((cf) => cf.optionsListKey === selectedList.key)
        .map(
          (cf) =>
            `${cf.recordType === 'person' ? 'Person' : 'Organisation'} custom field · ${cf.label}`,
        ),
    [customFields, selectedList.key],
  );

  const usageLocations = useMemo(
    () => whereUsed(selectedList.key, customFieldUsage),
    [selectedList.key, customFieldUsage],
  );

  const employees = useMemo(
    () =>
      people
        .filter((p) => p.isEmployee && !p.mergedIntoId)
        .sort((a, b) => personDisplayName(a).localeCompare(personDisplayName(b))),
    [people],
  );

  const expiredUnconvertedEnquiriesCount = useMemo(
    () =>
      enquiries.filter((e) =>
        isReadyForRetentionAnonymisation(e, retentionMonths || 12, new Date()),
      ).length,
    [enquiries, retentionMonths],
  );

  const startEditValue = (v: ChoiceValue) => {
    setEditingValId(v.id);
    setEditLabel(v.label);
    setEditDesc(v.description ?? '');
    setEditGuidance(v.guidance ?? '');
    setEditMatterTypeId(v.meta?.matterTypeId ?? '');
    setEditMatterStageId(
      v.meta?.matterStageId ?? (selectedList.key === 'work_type' ? DEFAULT_STAGE_GROUP_ID : ''),
    );
    setEditBillingBasisId(v.meta?.billingBasisId ?? '');
    setEditAmlInScope(v.meta?.amlInScope !== 'false');
    setEditClientMoneyThresholdGbp(v.meta?.clientMoneyThresholdGbp ?? '100000');
  };

  const handleSaveValue = (id: string) => {
    if (!editLabel.trim()) return;
    startTransition(async () => {
      const metaPatch: Record<string, string> | undefined =
        selectedList.key === 'work_type'
          ? {
              matterTypeId: editMatterTypeId,
              matterStageId: editMatterStageId,
              billingBasisId: editBillingBasisId,
              amlInScope: editAmlInScope ? 'true' : 'false',
              clientMoneyThresholdGbp: editClientMoneyThresholdGbp.trim() || '100000',
            }
          : undefined;
      const res = await updateChoiceValueAction(id, {
        label: editLabel.trim(),
        description: editDesc,
        guidance: editGuidance,
        meta: metaPatch,
      });
      if (res.error) {
        showToast(res.error);
        return;
      }
      setEditingValId(null);
      showToast('List value updated');
    });
  };

  const handleToggleValueActive = (v: ChoiceValue) => {
    startTransition(async () => {
      const res = await updateChoiceValueAction(v.id, { active: !v.active });
      if (res.error) {
        showToast(res.error);
        return;
      }
      showToast(v.active ? 'Value deactivated for new records' : 'Value activated');
    });
  };

  const handleReorderValue = (id: string, dir: -1 | 1) => {
    startTransition(async () => {
      await reorderChoiceValueAction(id, dir);
    });
  };

  const openAddValueModal = (presetStageGroupId?: string, presetParentId?: string) => {
    setNewValLabel('');
    setNewValDesc('');
    setNewValGuidance('');
    setNewValParentId(presetParentId ?? '');
    setNewValMatterTypeId('');
    setNewValMatterStageId(selectedList.key === 'work_type' ? DEFAULT_STAGE_GROUP_ID : '');
    setNewValBillingBasisId('');
    const parentVal = presetParentId ? values.find((v) => v.id === presetParentId) : undefined;
    setNewValAmlInScope(parentVal?.meta?.amlInScope ? parentVal.meta.amlInScope !== 'false' : true);
    setNewValClientMoneyThresholdGbp(parentVal?.meta?.clientMoneyThresholdGbp ?? '100000');
    setNewValStageGroupId(presetStageGroupId || DEFAULT_STAGE_GROUP_ID);
    setAddValueModalOpen(true);
  };

  const openStageGroupModal = () => {
    setNewStageGroupLabel('');
    setNewStageGroupDesc('');
    setNewStageGroupMode('from_default');
    setSelectedDefaultStageIds(defaultGroupStages.map((s) => s.id));
    setStageGroupModalOpen(true);
  };

  const handleCreateStageGroup = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newStageGroupLabel.trim()) return;
    startTransition(async () => {
      const grp = await createMatterStageGroupAction({
        label: newStageGroupLabel.trim(),
        description: newStageGroupDesc.trim() || undefined,
        mode: newStageGroupMode,
        selectedDefaultStageIds:
          newStageGroupMode === 'from_default' ? selectedDefaultStageIds : [],
      });
      if (grp?.id) {
        setExpandedStageGroupIds((prev) => new Set(prev).add(grp.id));
      }
      setStageGroupModalOpen(false);
      showToast('Matter stage group created');
    });
  };

  const handleAddValue = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newValLabel.trim()) return;
    const parentToExpand = selectedList.hierarchical && newValParentId ? newValParentId : null;
    startTransition(async () => {
      const meta: Record<string, string> = {};
      if (selectedList.key === 'work_type') {
        if (newValMatterTypeId) {
          meta.matterTypeId = newValMatterTypeId;
          const mtLabel = resolveLabel(values, newValMatterTypeId);
          if (mtLabel) meta.badge = mtLabel;
        }
        if (newValMatterStageId) meta.matterStageId = newValMatterStageId;
        if (newValBillingBasisId) meta.billingBasisId = newValBillingBasisId;
        meta.amlInScope = newValAmlInScope ? 'true' : 'false';
        meta.clientMoneyThresholdGbp = newValClientMoneyThresholdGbp.trim() || '100000';
      } else if (selectedList.key === 'matter_stage' && !parentToExpand) {
        meta.stageGroupId = newValStageGroupId || DEFAULT_STAGE_GROUP_ID;
      }
      await addChoiceValueAction({
        listKey: selectedList.key,
        label: newValLabel.trim(),
        description: newValDesc.trim() || undefined,
        guidance: newValGuidance.trim() || undefined,
        parentId: parentToExpand,
        meta: Object.keys(meta).length > 0 ? meta : undefined,
      });
      if (parentToExpand) {
        setExpandedParentIds((prev) => new Set(prev).add(parentToExpand));
      }
      if (selectedList.key === 'matter_stage' && !parentToExpand) {
        setExpandedStageGroupIds((prev) =>
          new Set(prev).add(newValStageGroupId || DEFAULT_STAGE_GROUP_ID),
        );
      }
      setNewValLabel('');
      setNewValDesc('');
      setNewValGuidance('');
      setNewValParentId('');
      setNewValMatterTypeId('');
      setNewValMatterStageId('');
      setNewValBillingBasisId('');
      setAddValueModalOpen(false);
      showToast('Value added to list');
    });
  };

  const openNewCfModal = () => {
    setEditingCf(null);
    setCfLabel('');
    setCfType('text');
    setCfSection(getDefaultSectionForRecordType(cfRecordType));
    setCfRequired(false);
    setCfOptionsText('');
    setCfModalOpen(true);
  };

  const openEditCfModal = (def: CustomFieldDefinition) => {
    setEditingCf(def);
    setCfLabel(def.label);
    setCfType(def.fieldType);
    setCfSection(def.section);
    setCfRequired(def.required);
    const existingOpts = def.optionsListKey
      ? valuesForList(values, def.optionsListKey).map((v) => v.label)
      : [];
    setCfOptionsText(existingOpts.join(', '));
    setCfModalOpen(true);
  };

  const handleSaveCf = (e: React.FormEvent) => {
    e.preventDefault();
    if (!cfLabel.trim()) return;
    startTransition(async () => {
      await saveCustomFieldAction({
        id: editingCf?.id,
        recordType: editingCf?.recordType ?? cfRecordType,
        label: cfLabel.trim(),
        fieldType: cfType,
        section: cfSection,
        required: cfRequired,
        options:
          cfType === 'choice'
            ? cfOptionsText
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined,
      });
      setCfModalOpen(false);
      showToast('Custom field saved to client configuration');
    });
  };

  const handleToggleCfRequired = (def: CustomFieldDefinition) => {
    startTransition(async () => {
      await saveCustomFieldAction({
        id: def.id,
        recordType: def.recordType,
        label: def.label,
        fieldType: def.fieldType,
        section: def.section,
        required: !def.required,
        active: def.active,
      });
      showToast(
        !def.required
          ? `"${def.label}" is now mandatory`
          : `"${def.label}" is now optional`,
      );
    });
  };

  const handleChangeCfLocation = (def: CustomFieldDefinition, nextSection: FormSection) => {
    startTransition(async () => {
      await saveCustomFieldAction({
        id: def.id,
        recordType: def.recordType,
        label: def.label,
        fieldType: def.fieldType,
        section: nextSection,
        required: def.required,
        active: def.active,
      });
      showToast(
        `Moved "${def.label}" to ${formatSectionLocationLabel(def.recordType, nextSection)}`,
      );
    });
  };

  const handleToggleCfActive = (def: CustomFieldDefinition) => {
    startTransition(async () => {
      await saveCustomFieldAction({
        id: def.id,
        recordType: def.recordType,
        label: def.label,
        fieldType: def.fieldType,
        section: def.section,
        required: def.required,
        active: !def.active,
      });
      showToast(def.active ? 'Custom field deactivated' : 'Custom field activated');
    });
  };

  const openNewTeamModal = () => {
    setEditingTeam(null);
    setTeamName('');
    setTeamDesc('');
    setTeamMemberIds([]);
    setTeamLeadIds([]);
    setTeamPracticeAreaIds([]);
    setTeamModalOpen(true);
  };

  const openEditTeamModal = (tm: Team) => {
    setEditingTeam(tm);
    setTeamName(tm.name);
    setTeamDesc(tm.description);
    setTeamMemberIds([...tm.memberIds]);
    setTeamLeadIds([...tm.leadIds]);
    setTeamPracticeAreaIds([...tm.practiceAreaIds]);
    setTeamModalOpen(true);
  };

  const handleSaveTeam = (e: React.FormEvent) => {
    e.preventDefault();
    if (!teamName.trim()) return;
    startTransition(async () => {
      const res = await saveTeamAction({
        id: editingTeam?.id,
        name: teamName.trim(),
        description: teamDesc.trim(),
        memberIds: teamMemberIds,
        leadIds: teamLeadIds,
        practiceAreaIds: teamPracticeAreaIds,
        active: editingTeam?.active ?? true,
      });
      if (res.error) {
        showToast(res.error);
        return;
      }
      setTeamModalOpen(false);
      showToast('Team saved');
    });
  };

  const handleToggleTeamActive = (tm: Team) => {
    startTransition(async () => {
      await saveTeamAction({
        id: tm.id,
        name: tm.name,
        description: tm.description,
        memberIds: tm.memberIds,
        leadIds: tm.leadIds,
        practiceAreaIds: tm.practiceAreaIds,
        active: !tm.active,
      });
      showToast(tm.active ? 'Team deactivated' : 'Team activated');
    });
  };

  const handleSaveEnquirySettings = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      await saveEnquirySettingsAction({
        emergencyHours: Math.max(1, Number(emergencyHours) || 2),
        workDayStart,
        workDayEnd,
        failedAttemptsBeforeSuggestNoResponse: Math.max(1, Number(failedAttempts) || 3),
        retentionMonths: Math.max(1, Number(retentionMonths) || 12),
      });
      showToast('Enquiry settings updated');
    });
  };

  const handleSaveTaskSettings = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      await saveTaskSettingsAction({ templates });
      showToast('Automatic task templates updated');
    });
  };

  const renderValueRow = (
    v: ChoiceValue,
    idx: number,
    total: number,
    isChild = false,
    childCount = 0,
  ) => {
    const isEditing = editingValId === v.id;
    const deactivateCheck = canDeactivate(v);
    const isExpanded = expandedParentIds.has(v.id);

    const matterTypeLabel = v.meta?.matterTypeId
      ? resolveLabel(values, v.meta.matterTypeId)
      : v.meta?.badge ?? '';
    const matterStageLabel = v.meta?.matterStageId
      ? resolveMatterStageOptionLabel(v.meta.matterStageId)
      : '';
    const billingBasisLabel = v.meta?.billingBasisId
      ? resolveLabel(values, v.meta.billingBasisId)
      : '';

    return (
      <div
        key={v.id}
        className="list-row"
        style={isChild ? { paddingLeft: 32 } : undefined}
      >
        <div className="list-row__main" style={{ flex: 1 }}>
          {isEditing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 560 }}>
              <input
                type="text"
                className="field-input"
                aria-label="Value label"
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
              />
              <input
                type="text"
                className="field-input"
                placeholder="Description (shown as help text in drop-downs)"
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
              />
              <input
                type="text"
                className="field-input"
                placeholder="Classification guidance (optional)"
                value={editGuidance}
                onChange={(e) => setEditGuidance(e.target.value)}
              />
              {selectedList.key === 'work_type' ? (
                <div className="form-grid" style={{ gap: 8 }}>
                  <div className="field-group">
                    <label className="field-label" style={{ fontSize: 12 }}>
                      Matter type
                    </label>
                    <select
                      className="field-select"
                      value={editMatterTypeId}
                      onChange={(e) => setEditMatterTypeId(e.target.value)}
                    >
                      <option value="">Select matter type…</option>
                      {matterTypeOptions.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field-group">
                    <label className="field-label" style={{ fontSize: 12 }}>
                      Matter stage
                    </label>
                    <select
                      className="field-select"
                      value={editMatterStageId}
                      onChange={(e) => setEditMatterStageId(e.target.value)}
                    >
                      <option value="">Select matter stage…</option>
                      <optgroup label="Matter Stage Groups">
                        {matterStageGroups
                          .filter((g) => g.active)
                          .map((grp) => (
                            <option key={grp.id} value={grp.id}>
                              {grp.label} (Stage group)
                            </option>
                          ))}
                      </optgroup>
                      {matterStageGroups
                        .filter((g) => g.active)
                        .map((grp) => {
                          const groupStages = matterStageParents.filter((stg) =>
                            grp.id === DEFAULT_STAGE_GROUP_ID
                              ? !stg.meta?.stageGroupId ||
                                stg.meta.stageGroupId === DEFAULT_STAGE_GROUP_ID
                              : stg.meta?.stageGroupId === grp.id,
                          );
                          if (groupStages.length === 0) return null;
                          return (
                            <optgroup key={`grp-stages-${grp.id}`} label={`${grp.label} — Stages`}>
                              {groupStages.map((stg) => {
                                const milestones = activeMatterStageValues.filter(
                                  (m) => m.parentId === stg.id,
                                );
                                return (
                                  <React.Fragment key={stg.id}>
                                    <option value={stg.id}>
                                      {stg.label} ({grp.label} · Stage)
                                    </option>
                                    {milestones.map((ms) => (
                                      <option key={ms.id} value={ms.id}>
                                        {'  ↳ '}
                                        {ms.meta?.code ? `${ms.meta.code} — ` : ''}
                                        {ms.label}
                                      </option>
                                    ))}
                                  </React.Fragment>
                                );
                              })}
                            </optgroup>
                          );
                        })}
                    </select>
                  </div>
                  <div className="field-group">
                    <label className="field-label" style={{ fontSize: 12 }}>
                      Billing basis
                    </label>
                    <select
                      className="field-select"
                      value={editBillingBasisId}
                      onChange={(e) => setEditBillingBasisId(e.target.value)}
                    >
                      <option value="">Select billing basis…</option>
                      {billingBasisOptions.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field-group">
                    <label className="field-label" style={{ fontSize: 12 }}>
                      Acceptable client money threshold (£)
                    </label>
                    <input
                      type="number"
                      min={0}
                      step={1000}
                      className="field-input"
                      value={editClientMoneyThresholdGbp}
                      onChange={(e) => setEditClientMoneyThresholdGbp(e.target.value)}
                    />
                  </div>
                  <div
                    className="field-group"
                    style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <label
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 13,
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={editAmlInScope}
                        onChange={(e) => setEditAmlInScope(e.target.checked)}
                      />
                      <span>In scope for Money Laundering Regulations</span>
                    </label>
                  </div>
                </div>
              ) : null}
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  disabled={pending}
                  onClick={() => handleSaveValue(v.id)}
                >
                  Save
                </button>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => setEditingValId(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <div
                className="list-row__title"
                style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
              >
                <button
                  type="button"
                  onClick={() => toggleParentExpanded(v.id)}
                  aria-expanded={isExpanded}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    border: 'none',
                    background: 'transparent',
                    padding: 0,
                    font: 'inherit',
                    color: 'inherit',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  {isExpanded ? (
                    <ChevronDown size={16} aria-hidden="true" />
                  ) : (
                    <ChevronRight size={16} aria-hidden="true" />
                  )}
                  <span>
                    {isChild ? '↳ ' : ''}
                    {v.label}
                  </span>
                  {childCount > 0 ? (
                    <span className="admin-group-toggle__count">{childCount}</span>
                  ) : null}
                </button>{' '}
                {!v.active ? <StatusPill label="Inactive" tone="neutral" /> : null}
                {isExpanded && v.systemKey ? (
                  <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
                    {' '}
                    · system key: {v.systemKey}
                  </span>
                ) : null}
              </div>
              {isExpanded ? (
                <div style={{ paddingLeft: 22 }}>
                  {v.description ? <div className="list-row__meta">{v.description}</div> : null}
                  {v.guidance ? (
                    <div className="list-row__meta" style={{ fontStyle: 'italic' }}>
                      Guidance: {v.guidance}
                    </div>
                  ) : null}
                  {selectedList.key === 'work_type' &&
                  (matterTypeLabel ||
                    matterStageLabel ||
                    billingBasisLabel ||
                    v.meta?.amlInScope !== undefined ||
                    v.meta?.clientMoneyThresholdGbp) ? (
                    <div
                      className="list-row__meta"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        flexWrap: 'wrap',
                        marginTop: 4,
                      }}
                    >
                      {matterTypeLabel ? (
                        <span>
                          <strong>Matter type:</strong> {matterTypeLabel}
                        </span>
                      ) : null}
                      {matterStageLabel ? (
                        <span>
                          {matterTypeLabel ? '· ' : ''}
                          <strong>Matter stage:</strong> {matterStageLabel}
                        </span>
                      ) : null}
                      {billingBasisLabel ? (
                        <span>
                          {matterTypeLabel || matterStageLabel ? '· ' : ''}
                          <strong>Billing basis:</strong> {billingBasisLabel}
                        </span>
                      ) : null}
                      <span>
                        {matterTypeLabel || matterStageLabel || billingBasisLabel ? '· ' : ''}
                        <strong>MLR scope:</strong>{' '}
                        {v.meta?.amlInScope === 'false' ? 'Out of scope' : 'In scope'}
                      </span>
                      {v.meta?.clientMoneyThresholdGbp ? (
                        <span>
                          · <strong>Client money threshold:</strong> £
                          {Number(v.meta.clientMoneyThresholdGbp).toLocaleString('en-GB')}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>

        {!isEditing && isExpanded ? (
          <div className="list-row__aside">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              aria-label={`Move ${v.label} up`}
              disabled={idx === 0 || pending}
              onClick={() => handleReorderValue(v.id, -1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              aria-label={`Move ${v.label} down`}
              disabled={idx === total - 1 || pending}
              onClick={() => handleReorderValue(v.id, 1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => startEditValue(v)}
            >
              Rename / edit
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={!deactivateCheck.ok || pending}
              title={!deactivateCheck.ok ? deactivateCheck.reason : undefined}
              onClick={() => handleToggleValueActive(v)}
            >
              {v.active ? 'Deactivate' : 'Activate'}
            </button>
          </div>
        ) : null}
      </div>
    );
  };

  const cfForSelectedType = useMemo(
    () =>
      customFields
        .filter((d) => d.recordType === cfRecordType)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [customFields, cfRecordType],
  );

  return (
    <div className="page-wide">
      <div className="page-header">
        <h1>Administration</h1>
      </div>

      <div className="tabs-bar" role="tablist" aria-label="Administration sections">
        {homePagesConfig ? (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'home-pages'}
            className={`tab-btn ${tab === 'home-pages' ? 'tab-btn--active' : ''}`}
            onClick={() => setTab('home-pages')}
          >
            Home pages ({homePagesConfig.roles.length})
          </button>
        ) : null}
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'lists'}
          className={`tab-btn ${tab === 'lists' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('lists')}
        >
          Lists &amp; taxonomy ({lists.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'org-structure'}
          className={`tab-btn ${tab === 'org-structure' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('org-structure')}
        >
          Organisation structure &amp; teams ({orgCatalogue.departments.length} depts · {teams.length} teams)
        </button>
        {enableMatterCostsGovernance ? (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'rates-and-costs'}
            className={`tab-btn ${tab === 'rates-and-costs' ? 'tab-btn--active' : ''}`}
            onClick={() => setTab('rates-and-costs')}
          >
            Rates &amp; matter costs ({matterCostsConfig?.rateCards.length ?? 6} rate cards)
          </button>
        ) : null}
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'document-templates'}
          className={`tab-btn ${tab === 'document-templates' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('document-templates')}
        >
          Document templates &amp; usage
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'document-stores'}
          className={`tab-btn ${tab === 'document-stores' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('document-stores')}
        >
          Document Stores &amp; DMS
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'enquiry-settings'}
          className={`tab-btn ${tab === 'enquiry-settings' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('enquiry-settings')}
        >
          Enquiry settings
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'task-settings'}
          className={`tab-btn ${tab === 'task-settings' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('task-settings')}
        >
          Task settings
        </button>
        {keyDatesConfig ? (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'key-dates'}
            className={`tab-btn ${tab === 'key-dates' ? 'tab-btn--active' : ''}`}
            onClick={() => setTab('key-dates')}
          >
            Key dates &amp; limitation ({keyDatesConfig.keyDateTypes?.length ?? 0} types)
          </button>
        ) : null}
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'custom-fields'}
          className={`tab-btn ${tab === 'custom-fields' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('custom-fields')}
        >
          Custom fields ({customFields.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'employees'}
          className={`tab-btn ${tab === 'employees' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('employees')}
        >
          Firm employees ({employees.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'rbac-and-entra'}
          className={`tab-btn ${tab === 'rbac-and-entra' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('rbac-and-entra')}
        >
          RBAC &amp; Entra ID
        </button>
        {pmsAdmin ? (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'pms-links'}
            className={`tab-btn ${tab === 'pms-links' ? 'tab-btn--active' : ''}`}
            onClick={() => setTab('pms-links')}
          >
            PMS links ({pmsAdmin.pmsLinks.length})
          </button>
        ) : null}
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'demo-data'}
          className={`tab-btn ${tab === 'demo-data' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('demo-data')}
        >
          Demo data
        </button>
      </div>

      {/* TAB: RBAC & ENTRA ID */}
      {tab === 'rbac-and-entra' && (
        <RbacAdminSection
          currentUserId={currentUserId}
          currentUserPermissions={currentUserPermissions}
          permissionsByPersonId={permissionsByPersonId}
          rbacConfig={rbacConfig}
          people={people}
          teams={teams}
          orgStructure={orgCatalogue}
          entraSession={entraSession}
          entraEnvStatus={entraEnvStatus}
          authError={authError}
          authSuccess={authSuccess}
        />
      )}

      {/* TAB: KEY DATES & LIMITATION */}
      {tab === 'key-dates' && keyDatesConfig && (
        <KeyDatesAdminPanel
          initialConfig={keyDatesConfig}
          userPermissions={currentUserKeyDatePermissions}
          currentUserId={currentUserId}
        />
      )}

      {/* TAB 1: CHOICE LISTS */}
      {tab === 'lists' && (
        <div className="admin-split">
          <aside className="admin-sidebar" aria-label="Choice lists">
            {GROUP_LABELS.map((grp) => {
              const grpLists = normalizedLists.filter((l) => l.group === grp.key);
              if (grpLists.length === 0) return null;
              const isOpen = openListGroups.has(grp.key);
              const hasActiveItem = grpLists.some((l) => l.key === selectedList.key);
              const roleLists = grpLists.filter((l) => MATTER_ROLE_KEYS.has(l.key));
              const hasActiveRoleItem = roleLists.some((l) => l.key === selectedList.key);

              return (
                <div key={grp.key} className="admin-group">
                  <button
                    type="button"
                    className={`admin-group-toggle ${isOpen ? 'admin-group-toggle--open' : ''} ${
                      hasActiveItem && !isOpen ? 'admin-group-toggle--has-active' : ''
                    }`}
                    aria-expanded={isOpen}
                    onClick={() => toggleListGroup(grp.key)}
                  >
                    <span className="admin-group-toggle__label">{grp.label}</span>
                    <span className="admin-group-toggle__right">
                      <span className="admin-group-toggle__count">{grpLists.length}</span>
                      {isOpen ? (
                        <ChevronDown size={15} aria-hidden="true" />
                      ) : (
                        <ChevronRight size={15} aria-hidden="true" />
                      )}
                    </span>
                  </button>
                  {isOpen ? (
                    <div className="admin-group__items">
                      {grpLists.map((l) => {
                        if (grp.key === 'matters' && l.key === 'matter_employee_role') {
                          return null;
                        }
                        if (grp.key === 'matters' && l.key === 'matter_party_role') {
                          return (
                            <div key="matter_roles_submenu" className="admin-submenu">
                              <button
                                type="button"
                                className={`admin-list-item admin-submenu-toggle ${
                                  hasActiveRoleItem && !matterRolesOpen
                                    ? 'admin-list-item--active'
                                    : ''
                                }`}
                                aria-expanded={matterRolesOpen}
                                onClick={() => setMatterRolesOpen((prev) => !prev)}
                              >
                                <span>Matter Roles</span>
                                <span className="admin-group-toggle__right">
                                  <span className="admin-group-toggle__count">
                                    {roleLists.length}
                                  </span>
                                  {matterRolesOpen ? (
                                    <ChevronDown size={14} aria-hidden="true" />
                                  ) : (
                                    <ChevronRight size={14} aria-hidden="true" />
                                  )}
                                </span>
                              </button>
                              {matterRolesOpen ? (
                                <div className="admin-submenu__items">
                                  {roleLists.map((rl) => {
                                    const activeRole = rl.key === selectedList.key;
                                    return (
                                      <button
                                        key={rl.key}
                                        type="button"
                                        className={`admin-list-item admin-list-item--sub ${
                                          activeRole ? 'admin-list-item--active' : ''
                                        }`}
                                        onClick={() => {
                                          setSelectedListKey(rl.key);
                                          setEditingValId(null);
                                          setExpandedParentIds(new Set());
                                        }}
                                      >
                                        <span>{rl.label}</span>
                                      </button>
                                    );
                                  })}
                                </div>
                              ) : null}
                            </div>
                          );
                        }

                        const active = l.key === selectedList.key;
                        return (
                          <button
                            key={l.key}
                            type="button"
                            className={`admin-list-item ${active ? 'admin-list-item--active' : ''}`}
                            onClick={() => {
                              setSelectedListKey(l.key);
                              setEditingValId(null);
                              setExpandedParentIds(new Set());
                            }}
                          >
                            <span>{l.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </aside>

          <div>
            {selectedList.key === 'matter_party_role' ? (
              <MatterPartiesAdminSection
                taxonomy={matterPartyTaxonomy ?? buildDefaultMatterPartyTaxonomy(values)}
                migrationReport={matterPartyMigrationReport}
                values={values}
                matters={matters}
              />
            ) : (
              <>
            <div className="list-section__header" style={{ alignItems: 'flex-start' }}>
              <div>
                <h2 style={{ fontSize: 22, fontWeight: 700 }}>{selectedList.label}</h2>
                {selectedList.description ? (
                  <p className="muted" style={{ marginTop: 4 }}>
                    {selectedList.description}
                  </p>
                ) : null}
                <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                  <strong>Where used:</strong>{' '}
                  {usageLocations.length > 0
                    ? usageLocations.join(' · ')
                    : 'Available for future pillars'}
                  {' · '}
                  {selectedList.allowMultiple ? 'Allows multiple values' : 'Single value'}
                  {selectedList.hierarchical ? ' · Two-level hierarchy' : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {selectedList.key === 'matter_stage' ? (
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={openStageGroupModal}
                  >
                    + Add group
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => openAddValueModal()}
                >
                  + Add value
                </button>
              </div>
            </div>

            {/* Values list */}
            <div style={{ marginTop: 16 }}>
              {selectedList.key === 'work_type' ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginBottom: 12,
                    maxWidth: 460,
                  }}
                >
                  <input
                    type="search"
                    className="field-input"
                    aria-label="Search worktypes"
                    placeholder="Search practice areas or worktypes…"
                    value={workTypeSearch}
                    onChange={(e) => setWorkTypeSearch(e.target.value)}
                  />
                  {workTypeSearch ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => setWorkTypeSearch('')}
                    >
                      Clear
                    </button>
                  ) : null}
                </div>
              ) : null}

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  marginBottom: 8,
                }}
              >
                <div className="section-label">
                  {selectedList.key === 'matter_stage'
                    ? `Groups (${matterStageGroups.length}) · Stages & milestones (${listValues.length})`
                    : `Values (${listValues.length})`}
                </div>
                {listValues.length > 0 ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      const targetItems = selectedList.hierarchical ? topLevelValues : listValues;
                      const allExpanded = targetItems.every((tv) => expandedParentIds.has(tv.id));
                      if (allExpanded) {
                        setExpandedParentIds(new Set());
                      } else {
                        setExpandedParentIds(new Set(listValues.map((tv) => tv.id)));
                      }
                    }}
                  >
                    {(selectedList.hierarchical ? topLevelValues : listValues).every((tv) =>
                      expandedParentIds.has(tv.id),
                    )
                      ? 'Collapse all'
                      : 'Expand all'}
                  </button>
                ) : null}
              </div>

              {selectedList.key === 'matter_stage'
                ? matterStageGroups.map((grp) => {
                    const groupStages = topLevelValues.filter((stg) =>
                      grp.id === DEFAULT_STAGE_GROUP_ID
                        ? !stg.meta?.stageGroupId ||
                          stg.meta.stageGroupId === DEFAULT_STAGE_GROUP_ID
                        : stg.meta?.stageGroupId === grp.id,
                    );
                    const isGrpExpanded = expandedStageGroupIds.has(grp.id);
                    const isEditingGrp = editingValId === grp.id;

                    return (
                      <div
                        key={grp.id}
                        className="card"
                        style={{ marginBottom: 14, padding: '14px 16px' }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            justifyContent: 'space-between',
                            gap: 12,
                          }}
                        >
                          <div style={{ flex: 1 }}>
                            {isEditingGrp ? (
                              <div
                                style={{
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: 8,
                                  maxWidth: 480,
                                }}
                              >
                                <input
                                  type="text"
                                  className="field-input"
                                  aria-label="Group name"
                                  value={editLabel}
                                  onChange={(e) => setEditLabel(e.target.value)}
                                />
                                <input
                                  type="text"
                                  className="field-input"
                                  placeholder="Group description (optional)"
                                  value={editDesc}
                                  onChange={(e) => setEditDesc(e.target.value)}
                                />
                                <div style={{ display: 'flex', gap: 8 }}>
                                  <button
                                    type="button"
                                    className="btn btn--primary btn--sm"
                                    disabled={pending}
                                    onClick={() => handleSaveValue(grp.id)}
                                  >
                                    Save group
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn--secondary btn--sm"
                                    onClick={() => setEditingValId(null)}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  onClick={() => toggleStageGroupExpanded(grp.id)}
                                  aria-expanded={isGrpExpanded}
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 8,
                                    border: 'none',
                                    background: 'transparent',
                                    padding: 0,
                                    font: 'inherit',
                                    fontWeight: 700,
                                    fontSize: 16,
                                    color: 'inherit',
                                    cursor: 'pointer',
                                    textAlign: 'left',
                                  }}
                                >
                                  {isGrpExpanded ? (
                                    <ChevronDown size={18} aria-hidden="true" />
                                  ) : (
                                    <ChevronRight size={18} aria-hidden="true" />
                                  )}
                                  <span>{grp.label}</span>
                                  <span className="admin-group-toggle__count">
                                    {groupStages.length} stage{groupStages.length === 1 ? '' : 's'}
                                  </span>
                                </button>
                                {grp.description ? (
                                  <div
                                    className="muted"
                                    style={{ fontSize: 13, marginTop: 4, marginLeft: 26 }}
                                  >
                                    {grp.description}
                                  </div>
                                ) : null}
                              </>
                            )}
                          </div>

                          {!isEditingGrp ? (
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <button
                                type="button"
                                className="btn btn--secondary btn--sm"
                                onClick={() => openAddValueModal(grp.id)}
                              >
                                + Add stage
                              </button>
                              {values.some((v) => v.id === grp.id) ? (
                                <button
                                  type="button"
                                  className="btn btn--ghost btn--sm"
                                  onClick={() => startEditValue(grp)}
                                >
                                  Rename group
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                        </div>

                        {isGrpExpanded ? (
                          <div
                            style={{
                              marginTop: 12,
                              marginLeft: 20,
                              paddingLeft: 16,
                              borderLeft: '2px solid var(--color-divider)',
                            }}
                          >
                            {groupStages.length === 0 ? (
                              <div
                                className="muted"
                                style={{
                                  fontSize: 13,
                                  padding: '12px 14px',
                                  background: 'var(--bg-subtle, #f8fafc)',
                                  borderRadius: 6,
                                }}
                              >
                                No stages in this group yet. Use <strong>+ Add stage</strong> to
                                create stages from scratch.
                              </div>
                            ) : (
                              groupStages.map((parent, pIdx) => {
                                const children = listValues.filter(
                                  (c) => c.parentId === parent.id,
                                );
                                const isExpanded = expandedParentIds.has(parent.id);
                                return (
                                  <React.Fragment key={parent.id}>
                                    {renderValueRow(
                                      parent,
                                      pIdx,
                                      groupStages.length,
                                      false,
                                      children.length,
                                    )}
                                    {isExpanded ? (
                                      <div
                                        style={{
                                          marginLeft: 24,
                                          paddingLeft: 16,
                                          borderLeft: '2px solid var(--color-divider)',
                                          marginBottom: 8,
                                        }}
                                      >
                                        {children.map((ch, cIdx) =>
                                          renderValueRow(ch, cIdx, children.length, true, 0),
                                        )}
                                        <div style={{ paddingLeft: 12, margin: '6px 0 8px' }}>
                                          <button
                                            type="button"
                                            className="btn btn--ghost btn--sm"
                                            onClick={() => openAddValueModal(grp.id, parent.id)}
                                          >
                                            + Add milestone to {parent.label}
                                          </button>
                                        </div>
                                      </div>
                                    ) : null}
                                  </React.Fragment>
                                );
                              })
                            )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                : selectedList.hierarchical
                  ? (() => {
                      const q =
                        selectedList.key === 'work_type'
                          ? workTypeSearch.trim().toLowerCase()
                          : '';
                      const matchesQuery = (item: ChoiceValue) => {
                        if (!q) return true;
                        return (
                          item.label.toLowerCase().includes(q) ||
                          (item.description ?? '').toLowerCase().includes(q) ||
                          (item.guidance ?? '').toLowerCase().includes(q) ||
                          (item.meta?.badge ?? '').toLowerCase().includes(q)
                        );
                      };

                      const filteredGroups = topLevelValues
                        .map((parent) => {
                          const allChildren = listValues.filter((c) => c.parentId === parent.id);
                          if (!q) {
                            return {
                              parent,
                              visibleChildren: allChildren,
                              totalChildCount: allChildren.length,
                            };
                          }
                          const parentMatches = matchesQuery(parent);
                          const matchingChildren = allChildren.filter(matchesQuery);
                          if (!parentMatches && matchingChildren.length === 0) {
                            return null;
                          }
                          return {
                            parent,
                            visibleChildren:
                              matchingChildren.length > 0 ? matchingChildren : allChildren,
                            totalChildCount: allChildren.length,
                          };
                        })
                        .filter((g): g is NonNullable<typeof g> => g !== null);

                      if (q && filteredGroups.length === 0) {
                        return (
                          <div className="muted" style={{ padding: '12px 0' }}>
                            No worktypes match &ldquo;{workTypeSearch.trim()}&rdquo;.
                          </div>
                        );
                      }

                      return filteredGroups.map(
                        ({ parent, visibleChildren, totalChildCount }, pIdx) => {
                          const isExpanded = Boolean(q) || expandedParentIds.has(parent.id);
                          return (
                            <React.Fragment key={parent.id}>
                              {renderValueRow(
                                parent,
                                pIdx,
                                filteredGroups.length,
                                false,
                                totalChildCount,
                              )}
                              {isExpanded && visibleChildren.length > 0 ? (
                                <div
                                  style={{
                                    marginLeft: 24,
                                    paddingLeft: 16,
                                    borderLeft: '2px solid var(--color-divider)',
                                    marginBottom: 8,
                                  }}
                                >
                                  {visibleChildren.map((ch, cIdx) =>
                                    renderValueRow(ch, cIdx, visibleChildren.length, true, 0),
                                  )}
                                </div>
                              ) : null}
                            </React.Fragment>
                          );
                        },
                      );
                    })()
                  : listValues.map((v, idx) =>
                      renderValueRow(v, idx, listValues.length, false, 0),
                    )}
            </div>
              </>
            )}
          </div>

          {addValueModalOpen ? (
            <div className="modal-backdrop" onClick={() => setAddValueModalOpen(false)}>
              <div
                className="modal"
                style={{ maxWidth: 680 }}
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-labelledby="add-worktype-modal-title"
              >
                <div className="modal__header">
                  <h2 id="add-worktype-modal-title" className="modal__title">
                    Add value to {selectedList.label}
                  </h2>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setAddValueModalOpen(false)}
                  >
                    Close
                  </button>
                </div>

                <form onSubmit={handleAddValue}>
                  <div className="modal__body">
                    <div className="form-grid">
                      <div className="field-group">
                        <label className="field-label" htmlFor="modal-val-label">
                          Label *
                        </label>
                        <input
                          id="modal-val-label"
                          type="text"
                          required
                          autoFocus
                          className="field-input"
                          placeholder="New option label…"
                          value={newValLabel}
                          onChange={(e) => setNewValLabel(e.target.value)}
                        />
                      </div>

                      {selectedList.key === 'matter_stage' && !newValParentId ? (
                        <div className="field-group">
                          <label className="field-label" htmlFor="modal-val-stage-group">
                            Matter stage group
                          </label>
                          <select
                            id="modal-val-stage-group"
                            className="field-select"
                            value={newValStageGroupId}
                            onChange={(e) => setNewValStageGroupId(e.target.value)}
                          >
                            {matterStageGroups
                              .filter((g) => g.active)
                              .map((grp) => (
                                <option key={grp.id} value={grp.id}>
                                  {grp.label}
                                </option>
                              ))}
                          </select>
                        </div>
                      ) : null}

                      {selectedList.hierarchical ? (
                        <div className="field-group">
                          <label className="field-label" htmlFor="modal-val-parent">
                            Parent category
                          </label>
                          <select
                            id="modal-val-parent"
                            className="field-select"
                            value={newValParentId}
                            onChange={(e) => setNewValParentId(e.target.value)}
                          >
                            <option value="">
                              {selectedList.key === 'matter_stage'
                                ? 'Top-level stage'
                                : 'Top-level value'}
                            </option>
                            {selectedList.key === 'matter_stage'
                              ? matterStageGroups.map((grp) => {
                                  const grpStages = topLevelValues.filter((tv) =>
                                    grp.id === DEFAULT_STAGE_GROUP_ID
                                      ? !tv.meta?.stageGroupId ||
                                        tv.meta.stageGroupId === DEFAULT_STAGE_GROUP_ID
                                      : tv.meta?.stageGroupId === grp.id,
                                  );
                                  if (grpStages.length === 0) return null;
                                  return (
                                    <optgroup key={grp.id} label={grp.label}>
                                      {grpStages.map((tv) => (
                                        <option key={tv.id} value={tv.id}>
                                          {tv.label} ({grp.label})
                                        </option>
                                      ))}
                                    </optgroup>
                                  );
                                })
                              : topLevelValues.map((tv) => (
                                  <option key={tv.id} value={tv.id}>
                                    {tv.label}
                                  </option>
                                ))}
                          </select>
                        </div>
                      ) : null}

                      <div className="field-group">
                        <label className="field-label" htmlFor="modal-val-desc">
                          Description / help text
                        </label>
                        <input
                          id="modal-val-desc"
                          type="text"
                          className="field-input"
                          placeholder="Shown under drop-downs…"
                          value={newValDesc}
                          onChange={(e) => setNewValDesc(e.target.value)}
                        />
                      </div>

                      <div className="field-group">
                        <label className="field-label" htmlFor="modal-val-guidance">
                          Guidance (optional)
                        </label>
                        <input
                          id="modal-val-guidance"
                          type="text"
                          className="field-input"
                          placeholder="When to pick this option…"
                          value={newValGuidance}
                          onChange={(e) => setNewValGuidance(e.target.value)}
                        />
                      </div>

                      {selectedList.key === 'work_type' ? (
                        <>
                          <div className="field-group">
                            <label className="field-label" htmlFor="modal-val-matter-type">
                              Matter type
                            </label>
                            <select
                              id="modal-val-matter-type"
                              className="field-select"
                              value={newValMatterTypeId}
                              onChange={(e) => setNewValMatterTypeId(e.target.value)}
                            >
                              <option value="">Select matter type…</option>
                              {matterTypeOptions.map((opt) => (
                                <option key={opt.id} value={opt.id}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="modal-val-billing-basis">
                              Billing basis
                            </label>
                            <select
                              id="modal-val-billing-basis"
                              className="field-select"
                              value={newValBillingBasisId}
                              onChange={(e) => setNewValBillingBasisId(e.target.value)}
                            >
                              <option value="">Select billing basis…</option>
                              {billingBasisOptions.map((opt) => (
                                <option key={opt.id} value={opt.id}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="field-group">
                            <label className="field-label" htmlFor="modal-val-threshold">
                              Acceptable client money threshold (£)
                            </label>
                            <input
                              id="modal-val-threshold"
                              type="number"
                              min={0}
                              step={1000}
                              className="field-input"
                              value={newValClientMoneyThresholdGbp}
                              onChange={(e) => setNewValClientMoneyThresholdGbp(e.target.value)}
                            />
                          </div>

                          <div
                            className="field-group"
                            style={{ display: 'flex', alignItems: 'center', paddingTop: 22 }}
                          >
                            <label
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 8,
                                fontSize: 13,
                                cursor: 'pointer',
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={newValAmlInScope}
                                onChange={(e) => setNewValAmlInScope(e.target.checked)}
                              />
                              <span>In scope for Money Laundering Regulations</span>
                            </label>
                          </div>

                          <div className="field-group" style={{ gridColumn: '1 / -1' }}>
                            <label className="field-label" htmlFor="modal-val-matter-stage">
                              Matter stage
                            </label>
                            <select
                              id="modal-val-matter-stage"
                              className="field-select"
                              value={newValMatterStageId}
                              onChange={(e) => setNewValMatterStageId(e.target.value)}
                            >
                              <option value="">Select matter stage…</option>
                              <optgroup label="Matter Stage Groups">
                                {matterStageGroups
                                  .filter((g) => g.active)
                                  .map((grp) => (
                                    <option key={grp.id} value={grp.id}>
                                      {grp.label} (Stage group)
                                    </option>
                                  ))}
                              </optgroup>
                              {matterStageGroups
                                .filter((g) => g.active)
                                .map((grp) => {
                                  const groupStages = matterStageParents.filter((stg) =>
                                    grp.id === DEFAULT_STAGE_GROUP_ID
                                      ? !stg.meta?.stageGroupId ||
                                        stg.meta.stageGroupId === DEFAULT_STAGE_GROUP_ID
                                      : stg.meta?.stageGroupId === grp.id,
                                  );
                                  if (groupStages.length === 0) return null;
                                  return (
                                    <optgroup
                                      key={`modal-grp-${grp.id}`}
                                      label={`${grp.label} — Stages`}
                                    >
                                      {groupStages.map((stg) => {
                                        const milestones = activeMatterStageValues.filter(
                                          (m) => m.parentId === stg.id,
                                        );
                                        return (
                                          <React.Fragment key={stg.id}>
                                            <option value={stg.id}>
                                              {stg.label} ({grp.label} · Stage)
                                            </option>
                                            {milestones.map((ms) => (
                                              <option key={ms.id} value={ms.id}>
                                                {'  ↳ '}
                                                {ms.meta?.code ? `${ms.meta.code} — ` : ''}
                                                {ms.label}
                                              </option>
                                            ))}
                                          </React.Fragment>
                                        );
                                      })}
                                    </optgroup>
                                  );
                                })}
                            </select>

                            <div
                              style={{
                                marginTop: 10,
                                border: '1px solid var(--border-subtle, #e2e8f0)',
                                borderRadius: 8,
                                padding: 12,
                                maxHeight: 240,
                                overflowY: 'auto',
                                background: 'var(--bg-subtle, #f8fafc)',
                              }}
                            >
                              <div
                                className="section-label"
                                style={{ marginBottom: 8, fontSize: 11 }}
                              >
                                Available options from Matter stage screen
                              </div>
                              {matterStageGroups
                                .filter((g) => g.active)
                                .map((grp) => {
                                  const groupStages = matterStageParents.filter((stg) =>
                                    grp.id === DEFAULT_STAGE_GROUP_ID
                                      ? !stg.meta?.stageGroupId ||
                                        stg.meta.stageGroupId === DEFAULT_STAGE_GROUP_ID
                                      : stg.meta?.stageGroupId === grp.id,
                                  );
                                  const isGroupSelected = newValMatterStageId === grp.id;
                                  return (
                                    <div key={grp.id} style={{ marginBottom: 10 }}>
                                      <label
                                        style={{
                                          display: 'flex',
                                          alignItems: 'center',
                                          gap: 8,
                                          fontWeight: 600,
                                          fontSize: 13,
                                          cursor: 'pointer',
                                        }}
                                      >
                                        <input
                                          type="radio"
                                          name="worktype-matter-stage-option"
                                          checked={isGroupSelected}
                                          onChange={() => setNewValMatterStageId(grp.id)}
                                        />
                                        <span>{grp.label} (All stages in group)</span>
                                      </label>
                                      {groupStages.length > 0 ? (
                                        <div
                                          style={{
                                            paddingLeft: 24,
                                            marginTop: 4,
                                            display: 'flex',
                                            flexDirection: 'column',
                                            gap: 4,
                                          }}
                                        >
                                          {groupStages.map((stg) => {
                                            const milestones = activeMatterStageValues.filter(
                                              (m) => m.parentId === stg.id,
                                            );
                                            return (
                                              <label
                                                key={stg.id}
                                                style={{
                                                  display: 'flex',
                                                  alignItems: 'center',
                                                  gap: 8,
                                                  fontSize: 13,
                                                  cursor: 'pointer',
                                                }}
                                              >
                                                <input
                                                  type="radio"
                                                  name="worktype-matter-stage-option"
                                                  checked={newValMatterStageId === stg.id}
                                                  onChange={() => setNewValMatterStageId(stg.id)}
                                                />
                                                <span>
                                                  {stg.label}{' '}
                                                  <span className="muted" style={{ fontSize: 12 }}>
                                                    ({milestones.length} milestone
                                                    {milestones.length === 1 ? '' : 's'})
                                                  </span>
                                                </span>
                                              </label>
                                            );
                                          })}
                                        </div>
                                      ) : null}
                                    </div>
                                  );
                                })}
                            </div>
                          </div>
                        </>
                      ) : null}
                    </div>
                  </div>

                  <div className="modal__footer">
                    <button
                      type="button"
                      className="btn btn--secondary"
                      onClick={() => setAddValueModalOpen(false)}
                    >
                      Cancel
                    </button>
                    <button type="submit" className="btn btn--primary" disabled={pending}>
                      Add value
                    </button>
                  </div>
                </form>
              </div>
            </div>
          ) : null}

          {stageGroupModalOpen ? (
            <div className="modal-backdrop" onClick={() => setStageGroupModalOpen(false)}>
              <div
                className="modal"
                style={{ maxWidth: 640 }}
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-labelledby="add-stage-group-modal-title"
              >
                <div className="modal__header">
                  <h2 id="add-stage-group-modal-title" className="modal__title">
                    Add matter stage group
                  </h2>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setStageGroupModalOpen(false)}
                  >
                    Close
                  </button>
                </div>

                <form onSubmit={handleCreateStageGroup}>
                  <div className="modal__body">
                    <div className="form-grid">
                      <div className="field-group">
                        <label className="field-label" htmlFor="stage-group-label">
                          Group name *
                        </label>
                        <input
                          id="stage-group-label"
                          type="text"
                          required
                          autoFocus
                          className="field-input"
                          placeholder="e.g. Residential Conveyancing Group…"
                          value={newStageGroupLabel}
                          onChange={(e) => setNewStageGroupLabel(e.target.value)}
                        />
                      </div>

                      <div className="field-group">
                        <label className="field-label" htmlFor="stage-group-desc">
                          Description (optional)
                        </label>
                        <input
                          id="stage-group-desc"
                          type="text"
                          className="field-input"
                          placeholder="When this stage group is used…"
                          value={newStageGroupDesc}
                          onChange={(e) => setNewStageGroupDesc(e.target.value)}
                        />
                      </div>

                      <div className="field-group" style={{ gridColumn: '1 / -1' }}>
                        <label className="field-label">Group setup</label>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <label
                            style={{
                              display: 'flex',
                              alignItems: 'flex-start',
                              gap: 8,
                              cursor: 'pointer',
                            }}
                          >
                            <input
                              type="radio"
                              name="stage-group-mode"
                              checked={newStageGroupMode === 'from_default'}
                              onChange={() => setNewStageGroupMode('from_default')}
                              style={{ marginTop: 3 }}
                            />
                            <div>
                              <div style={{ fontWeight: 600 }}>
                                Use sections from Default Group and edit
                              </div>
                              <div className="muted" style={{ fontSize: 12 }}>
                                Copy selected stages and milestones from the Default Group so you
                                can edit, reorder, or add to them for this group.
                              </div>
                            </div>
                          </label>

                          <label
                            style={{
                              display: 'flex',
                              alignItems: 'flex-start',
                              gap: 8,
                              cursor: 'pointer',
                            }}
                          >
                            <input
                              type="radio"
                              name="stage-group-mode"
                              checked={newStageGroupMode === 'scratch'}
                              onChange={() => setNewStageGroupMode('scratch')}
                              style={{ marginTop: 3 }}
                            />
                            <div>
                              <div style={{ fontWeight: 600 }}>Create completely from scratch</div>
                              <div className="muted" style={{ fontSize: 12 }}>
                                Start with an empty group and add your own stages and milestones.
                              </div>
                            </div>
                          </label>
                        </div>
                      </div>

                      {newStageGroupMode === 'from_default' ? (
                        <div className="field-group" style={{ gridColumn: '1 / -1' }}>
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              marginBottom: 6,
                            }}
                          >
                            <label className="field-label" style={{ marginBottom: 0 }}>
                              Select Default Group sections to include (
                              {selectedDefaultStageIds.length} of {defaultGroupStages.length})
                            </label>
                            <div style={{ display: 'flex', gap: 8 }}>
                              <button
                                type="button"
                                className="btn btn--ghost btn--sm"
                                onClick={() =>
                                  setSelectedDefaultStageIds(defaultGroupStages.map((s) => s.id))
                                }
                              >
                                Select all
                              </button>
                              <button
                                type="button"
                                className="btn btn--ghost btn--sm"
                                onClick={() => setSelectedDefaultStageIds([])}
                              >
                                Clear
                              </button>
                            </div>
                          </div>

                          <div
                            style={{
                              border: '1px solid var(--border-subtle, #e2e8f0)',
                              borderRadius: 8,
                              padding: 10,
                              maxHeight: 220,
                              overflowY: 'auto',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 8,
                            }}
                          >
                            {defaultGroupStages.map((stg) => {
                              const checked = selectedDefaultStageIds.includes(stg.id);
                              const msCount = matterStageValues.filter(
                                (m) => m.parentId === stg.id,
                              ).length;
                              return (
                                <label
                                  key={stg.id}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'flex-start',
                                    gap: 8,
                                    cursor: 'pointer',
                                  }}
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={(e) => {
                                      if (e.target.checked) {
                                        setSelectedDefaultStageIds((prev) => [...prev, stg.id]);
                                      } else {
                                        setSelectedDefaultStageIds((prev) =>
                                          prev.filter((id) => id !== stg.id),
                                        );
                                      }
                                    }}
                                    style={{ marginTop: 3 }}
                                  />
                                  <div>
                                    <div style={{ fontWeight: 600, fontSize: 13 }}>
                                      {stg.label}{' '}
                                      <span className="muted" style={{ fontWeight: 400 }}>
                                        ({msCount} milestone{msCount === 1 ? '' : 's'})
                                      </span>
                                    </div>
                                    {stg.description ? (
                                      <div className="muted" style={{ fontSize: 12 }}>
                                        {stg.description}
                                      </div>
                                    ) : null}
                                  </div>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="modal__footer">
                    <button
                      type="button"
                      className="btn btn--secondary"
                      onClick={() => setStageGroupModalOpen(false)}
                    >
                      Cancel
                    </button>
                    <button type="submit" className="btn btn--primary" disabled={pending}>
                      Create group
                    </button>
                  </div>
                </form>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {/* TAB: ENQUIRY SETTINGS */}
      {tab === 'enquiry-settings' && (
        <div style={{ maxWidth: 760 }}>
          <form onSubmit={handleSaveEnquirySettings} className="subcard">
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>
              Enquiry SLA, working hours &amp; retention settings
            </h2>
            <p className="muted" style={{ marginBottom: 16 }}>
              Controls how due times are calculated on automatic first-contact tasks, when to
              suggest closing unresponsive enquiries, and the retention period for unconverted
              enquiries.
            </p>

            <div className="form-grid">
              <div className="field-group">
                <label className="field-label" htmlFor="enq-emergency-hours">
                  Emergency response target (working hours)
                </label>
                <input
                  id="enq-emergency-hours"
                  type="number"
                  min={1}
                  max={24}
                  className="field-input"
                  value={emergencyHours}
                  onChange={(e) => setEmergencyHours(Number(e.target.value))}
                />
                <span className="field-help">
                  Default: 2 working hours. Urgent = end of same working day; Standard = end of next working day.
                </span>
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="enq-failed-attempts">
                  Failed contact attempts before suggesting &lsquo;No response&rsquo;
                </label>
                <input
                  id="enq-failed-attempts"
                  type="number"
                  min={1}
                  max={10}
                  className="field-input"
                  value={failedAttempts}
                  onChange={(e) => setFailedAttempts(Number(e.target.value))}
                />
                <span className="field-help">
                  Default: 3 failed attempts without a &lsquo;Spoke&rsquo; outcome. Enquiries are never closed automatically.
                </span>
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="enq-work-start">
                  Working day start (HH:MM)
                </label>
                <input
                  id="enq-work-start"
                  type="time"
                  className="field-input"
                  value={workDayStart}
                  onChange={(e) => setWorkDayStart(e.target.value)}
                />
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="enq-work-end">
                  Working day end (HH:MM)
                </label>
                <input
                  id="enq-work-end"
                  type="time"
                  className="field-input"
                  value={workDayEnd}
                  onChange={(e) => setWorkDayEnd(e.target.value)}
                />
              </div>

              <div className="field-group field-group--full">
                <label className="field-label" htmlFor="enq-retention-months">
                  Unconverted enquiry retention period (months)
                </label>
                <input
                  id="enq-retention-months"
                  type="number"
                  min={1}
                  max={120}
                  className="field-input"
                  style={{ maxWidth: 220 }}
                  value={retentionMonths}
                  onChange={(e) => setRetentionMonths(Number(e.target.value))}
                />
                <span className="field-help">
                  Default: 12 months. After this period, personal details on closed unconverted enquiries can be removed while keeping practice area, channel, dates and outcome for reporting.
                </span>
              </div>
            </div>

            <div style={{ marginTop: 16 }}>
              <button type="submit" className="btn btn--primary" disabled={pending}>
                Save enquiry settings
              </button>
            </div>
          </form>

          <div className="subcard" style={{ marginTop: 20 }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>
              Privacy &amp; data retention check
            </h3>
            <p className="muted" style={{ marginBottom: 12 }}>
              Removes personal details (name, email, phone, address, notes and other parties named)
              from closed unconverted enquiries older than {retentionMonths} months, retaining
              practice area, channel, dates and outcome for reporting. Currently eligible:{' '}
              <strong>{expiredUnconvertedEnquiriesCount}</strong> enquiries.
            </p>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={pending || expiredUnconvertedEnquiriesCount === 0}
              onClick={() =>
                startTransition(async () => {
                  const res = await anonymiseExpiredEnquiriesAction();
                  if (isActionDenied(res)) {
                    showToast(res.message);
                    return;
                  }
                  showToast(`Anonymised ${res.count} expired unconverted enquiries`);
                })
              }
            >
              Run retention anonymisation ({expiredUnconvertedEnquiriesCount} eligible)
            </button>
          </div>
        </div>
      )}

      {/* TAB: TASK SETTINGS */}
      {tab === 'task-settings' && (
        <div style={{ maxWidth: 820 }}>
          <form onSubmit={handleSaveTaskSettings} className="subcard">
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>
              Automatic task templates &amp; due-date offsets
            </h2>
            <p className="muted" style={{ marginBottom: 16 }}>
              These three automatic tasks are raised by the system at key lifecycle points. Use{' '}
              <code>{'{name}'}</code> or <code>{'{matterNumber}'}</code> in the title template.
            </p>

            {templates.map((tpl, idx) => (
              <div
                key={tpl.trigger}
                className="subcard"
                style={{ marginBottom: 14, background: 'var(--bg-subtle)' }}
              >
                <div style={{ fontWeight: 700, marginBottom: 8 }}>
                  {tpl.trigger === 'enquiry_contact'
                    ? '1. New enquiry saved → Call back / First contact'
                    : tpl.trigger === 'non_engagement_letter'
                      ? '2. Enquiry declined or referred out → Send non-engagement letter'
                      : '3. Enquiry converted to matter → Complete matter opening'}
                </div>
                <div className="form-grid">
                  <div className="field-group field-group--full">
                    <label className="field-label">Title template</label>
                    <input
                      type="text"
                      className="field-input"
                      value={tpl.titleTemplate}
                      onChange={(e) => {
                        const next = [...templates];
                        next[idx] = { ...tpl, titleTemplate: e.target.value };
                        setTemplates(next);
                      }}
                    />
                  </div>
                  <div className="field-group">
                    <label className="field-label">Default task type</label>
                    <select
                      className="field-select"
                      value={tpl.taskTypeId}
                      onChange={(e) => {
                        const next = [...templates];
                        next[idx] = { ...tpl, taskTypeId: e.target.value };
                        setTemplates(next);
                      }}
                    >
                      {taskTypes.map((tt) => (
                        <option key={tt.id} value={tt.id}>
                          {tt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field-group">
                    <label className="field-label">Default priority</label>
                    <select
                      className="field-select"
                      value={tpl.priorityId}
                      onChange={(e) => {
                        const next = [...templates];
                        next[idx] = { ...tpl, priorityId: e.target.value };
                        setTemplates(next);
                      }}
                    >
                      {taskPriorities.map((tp) => (
                        <option key={tp.id} value={tp.id}>
                          {tp.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {tpl.trigger !== 'enquiry_contact' ? (
                    <div className="field-group">
                      <label className="field-label">Due offset (working days)</label>
                      <input
                        type="number"
                        min={1}
                        max={30}
                        className="field-input"
                        value={tpl.dueWorkingDaysOffset}
                        onChange={(e) => {
                          const next = [...templates];
                          next[idx] = {
                            ...tpl,
                            dueWorkingDaysOffset: Math.max(1, Number(e.target.value) || 1),
                          };
                          setTemplates(next);
                        }}
                      />
                    </div>
                  ) : (
                    <div className="field-group">
                      <label className="field-label">Due calculation</label>
                      <div className="muted" style={{ fontSize: 13, paddingTop: 8 }}>
                        Driven by enquiry urgency (Emergency = {emergencyHours}h, Urgent = end of
                        same working day, Standard = end of next working day).
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}

            <div style={{ marginTop: 14 }}>
              <button type="submit" className="btn btn--primary" disabled={pending}>
                Save task settings
              </button>
            </div>
          </form>
        </div>
      )}

      {/* TAB: CUSTOM FIELDS */}
      {tab === 'custom-fields' && (
        <div>
          <div
            className="subcard"
            style={{
              marginBottom: 16,
              borderLeft: '4px solid var(--accent-primary, #1f6feb)',
              background: 'var(--surface-subtle, rgba(31, 111, 235, 0.04))',
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
                <strong style={{ fontSize: 14 }}>
                  Client Custom Fields, Screen Locations &amp; Mandatory Rules
                </strong>
                <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                  All core application fields remain available to every client. Additional client
                  fields, their screen locations, and mandatory status are saved per client in{' '}
                  <code>config/base.json</code>.
                </div>
              </div>
              <StatusPill label="Layer 2 · Client Configuration" tone="positive" />
            </div>
          </div>

          <div className="list-section__header" style={{ marginBottom: 18 }}>
            <div className="filter-bar" style={{ margin: 0, flexWrap: 'wrap' }}>
              {CUSTOM_FIELD_SCREEN_OPTIONS.map((scr) => {
                const count = customFields.filter((d) => d.recordType === scr.recordType).length;
                return (
                  <button
                    key={scr.recordType}
                    type="button"
                    className={`btn btn--sm ${
                      cfRecordType === scr.recordType ? 'btn--primary' : 'btn--secondary'
                    }`}
                    onClick={() => setCfRecordType(scr.recordType)}
                  >
                    {scr.label} ({count})
                  </button>
                );
              })}
            </div>
            <button type="button" className="btn btn--primary" onClick={openNewCfModal}>
              + Add custom field
            </button>
          </div>

          {cfForSelectedType.length === 0 ? (
            <p className="muted">
              No custom fields configured for the{' '}
              {CUSTOM_FIELD_SCREEN_OPTIONS.find((s) => s.recordType === cfRecordType)?.label ??
                cfRecordType}
              . Click <strong>+ Add custom field</strong> to add one and choose its location and
              mandatory status.
            </p>
          ) : (
            cfForSelectedType.map((def, idx) => {
              const opts = def.optionsListKey
                ? valuesForList(values, def.optionsListKey)
                    .filter((v) => v.active)
                    .map((v) => v.label)
                : [];
              const screenLocations = getScreenFieldLocations(def.recordType);
              return (
                <div key={def.id} className="list-row">
                  <div className="list-row__main">
                    <div className="list-row__title">
                      {def.label}{' '}
                      {def.required ? (
                        <StatusPill label="Mandatory" tone="warning" />
                      ) : (
                        <StatusPill label="Optional" tone="neutral" />
                      )}
                      {!def.active ? <StatusPill label="Inactive" tone="neutral" /> : null}
                    </div>
                    <div className="list-row__meta">
                      Type: {FIELD_TYPE_LABELS[def.fieldType]} · Location:{' '}
                      <strong>{formatSectionLocationLabel(def.recordType, def.section)}</strong>
                      {opts.length > 0 ? ` · Options: ${opts.join(', ')}` : ''}
                    </div>
                  </div>
                  <div className="list-row__aside" style={{ flexWrap: 'wrap', gap: 6 }}>
                    <select
                      aria-label={`Screen location for ${def.label}`}
                      className="field-select"
                      style={{ height: 30, fontSize: 12.5, padding: '0 24px 0 8px', width: 'auto' }}
                      disabled={pending}
                      value={def.section}
                      onChange={(e) =>
                        handleChangeCfLocation(def, e.target.value as FormSection)
                      }
                    >
                      {screenLocations.map((loc) => (
                        <option key={loc.value} value={loc.value}>
                          {loc.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={pending}
                      onClick={() => handleToggleCfRequired(def)}
                      title="Toggle whether this field is mandatory or optional"
                    >
                      {def.required ? 'Make optional' : 'Make mandatory'}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={idx === 0 || pending}
                      onClick={() =>
                        startTransition(async () => {
                          await reorderCustomFieldAction(def.id, -1);
                        })
                      }
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={idx === cfForSelectedType.length - 1 || pending}
                      onClick={() =>
                        startTransition(async () => {
                          await reorderCustomFieldAction(def.id, 1);
                        })
                      }
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => openEditCfModal(def)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => handleToggleCfActive(def)}
                    >
                      {def.active ? 'Deactivate' : 'Activate'}
                    </button>
                  </div>
                </div>
              );
            })
          )}

          {cfModalOpen ? (
            <div className="modal-backdrop" role="dialog" aria-modal="true">
              <div className="modal-card">
                <div className="modal-header">
                  <h2>
                    {editingCf
                      ? `Edit custom field: ${editingCf.label}`
                      : `Add custom field (${
                          CUSTOM_FIELD_SCREEN_OPTIONS.find(
                            (s) => s.recordType === cfRecordType,
                          )?.label ?? cfRecordType
                        })`}
                  </h2>
                </div>
                <form onSubmit={handleSaveCf}>
                  <div className="form-grid">
                    <div className="field-group field-group--full">
                      <label className="field-label" htmlFor="cf-label-input">
                        Field label *
                      </label>
                      <input
                        id="cf-label-input"
                        type="text"
                        required
                        className="field-input"
                        placeholder="e.g. Legal aid eligibility checked, Referral source code"
                        value={cfLabel}
                        onChange={(e) => setCfLabel(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label" htmlFor="cf-type-select">
                        Field type
                      </label>
                      <select
                        id="cf-type-select"
                        className="field-select"
                        value={cfType}
                        onChange={(e) => setCfType(e.target.value as CustomFieldType)}
                      >
                        <option value="text">Short text</option>
                        <option value="longText">Long text</option>
                        <option value="number">Number</option>
                        <option value="date">Date</option>
                        <option value="yesNo">Yes / No</option>
                        <option value="choice">Choice (drop-down)</option>
                      </select>
                    </div>
                    <div className="field-group">
                      <label className="field-label" htmlFor="cf-section-select">
                        Location on screen
                      </label>
                      <select
                        id="cf-section-select"
                        className="field-select"
                        value={cfSection}
                        onChange={(e) => setCfSection(e.target.value as FormSection)}
                      >
                        {getScreenFieldLocations(editingCf?.recordType ?? cfRecordType).map(
                          (loc) => (
                            <option key={loc.value} value={loc.value}>
                              {loc.label}
                            </option>
                          ),
                        )}
                      </select>
                    </div>
                    {cfType === 'choice' ? (
                      <div className="field-group field-group--full">
                        <label className="field-label" htmlFor="cf-options-input">
                          Choice options (comma-separated)
                        </label>
                        <input
                          id="cf-options-input"
                          type="text"
                          className="field-input"
                          placeholder="Option 1, Option 2, Option 3"
                          value={cfOptionsText}
                          onChange={(e) => setCfOptionsText(e.target.value)}
                        />
                      </div>
                    ) : null}
                    <div className="field-group field-group--full">
                      <label className="checkbox-pill">
                        <input
                          type="checkbox"
                          checked={cfRequired}
                          onChange={(e) => setCfRequired(e.target.checked)}
                        />
                        <span>Mandatory field (required before saving / routing)</span>
                      </label>
                    </div>
                  </div>
                  <div className="modal-actions">
                    <button
                      type="button"
                      className="btn btn--secondary"
                      onClick={() => setCfModalOpen(false)}
                    >
                      Cancel
                    </button>
                    <button type="submit" className="btn btn--primary" disabled={pending}>
                      Save custom field
                    </button>
                  </div>
                </form>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {/* TAB: ORGANISATION STRUCTURE */}
      {tab === 'org-structure' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div className="list-section__header" style={{ marginBottom: 4 }}>
            <p className="muted" style={{ margin: 0 }}>
              Managed reference tables for {firmName}&apos;s hierarchical organisation
              structure: <strong>Legal Entity → Division → Department → Team / Practice Group</strong>,
              plus <strong>Offices</strong>, <strong>Cost Centres</strong>, and{' '}
              <strong>Profit Centres</strong>. Selecting a Department on an employee record
              automatically defaults its parent Division, Cost Centre, and Profit Centre.
            </p>
          </div>

          {/* 1. Legal Entities & Divisions */}
          <div className="subcard">
            <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>
              1 · Legal Entities &amp; Divisions
            </h3>
            <div style={{ marginBottom: 12, fontSize: 13 }}>
              <strong>Employing Legal Entities:</strong>{' '}
              {orgCatalogue.legalEntities.map((le) => `${le.name} (${le.code})`).join(', ')}
            </div>
            <table className="data-table" style={{ fontSize: 13, marginBottom: 12 }}>
              <thead>
                <tr>
                  <th>Division ID</th>
                  <th>Code</th>
                  <th>Division Name</th>
                  <th>Parent Legal Entity</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {orgCatalogue.divisions.map((div) => (
                  <tr key={div.id}>
                    <td>{div.id}</td>
                    <td>
                      <code>{div.code}</code>
                    </td>
                    <td>
                      <strong>{div.name}</strong>
                    </td>
                    <td>
                      {orgCatalogue.legalEntities.find((le) => le.id === div.parentLegalEntityId)
                        ?.name ?? div.parentLegalEntityId}
                    </td>
                    <td>{div.active ? 'Active' : 'Inactive'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="text"
                className="field-input"
                style={{ maxWidth: 220 }}
                placeholder="New division name"
                value={newDivName}
                onChange={(e) => setNewDivName(e.target.value)}
              />
              <input
                type="text"
                className="field-input"
                style={{ maxWidth: 120 }}
                placeholder="Code (e.g. OPS)"
                value={newDivCode}
                onChange={(e) => setNewDivCode(e.target.value.toUpperCase())}
              />
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                disabled={pending || !newDivName.trim() || !newDivCode.trim()}
                onClick={() => {
                  const id = `DIV-${newDivCode.trim().toUpperCase()}`;
                  const next: OrgStructureCatalogue = {
                    ...orgCatalogue,
                    divisions: [
                      ...orgCatalogue.divisions,
                      {
                        id,
                        code: newDivCode.trim().toUpperCase(),
                        name: newDivName.trim(),
                        parentLegalEntityId: orgCatalogue.legalEntities[0]?.id ?? 'LE-PV-LLP',
                        active: true,
                      },
                    ],
                  };
                  setOrgCatalogue(next);
                  setNewDivName('');
                  setNewDivCode('');
                  startTransition(async () => {
                    await saveOrgStructureAction(next);
                    showToast(`Added division ${id}`);
                  });
                }}
              >
                + Add division
              </button>
            </div>
          </div>

          {/* 2. Departments (with parent Division & default Cost/Profit Centre) */}
          <div className="subcard">
            <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>
              2 · Departments (linked to Division, Default Cost Centre &amp; Profit Centre)
            </h3>
            <table className="data-table" style={{ fontSize: 13, marginBottom: 12 }}>
              <thead>
                <tr>
                  <th>Dept ID</th>
                  <th>Code</th>
                  <th>Department Name</th>
                  <th>Parent Division</th>
                  <th>Default Cost Centre</th>
                  <th>Default Profit Centre</th>
                </tr>
              </thead>
              <tbody>
                {orgCatalogue.departments.map((dept) => {
                  const div = orgCatalogue.divisions.find((d) => d.id === dept.parentDivisionId);
                  const cc = orgCatalogue.costCentres.find(
                    (c) => c.id === dept.defaultCostCentreId,
                  );
                  const pc = orgCatalogue.profitCentres.find(
                    (p) => p.id === dept.defaultProfitCentreId,
                  );
                  return (
                    <tr key={dept.id}>
                      <td>{dept.id}</td>
                      <td>
                        <code>{dept.code}</code>
                      </td>
                      <td>
                        <strong>{dept.name}</strong>
                      </td>
                      <td>{div ? `${div.name} (${div.code})` : dept.parentDivisionId}</td>
                      <td>{cc ? `${cc.code} — ${cc.name}` : '—'}</td>
                      <td>{pc ? `${pc.code} — ${pc.name}` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="text"
                className="field-input"
                style={{ maxWidth: 200 }}
                placeholder="New department name"
                value={newDeptName}
                onChange={(e) => setNewDeptName(e.target.value)}
              />
              <input
                type="text"
                className="field-input"
                style={{ maxWidth: 110 }}
                placeholder="Code (e.g. TAX)"
                value={newDeptCode}
                onChange={(e) => setNewDeptCode(e.target.value.toUpperCase())}
              />
              <select
                className="field-select"
                style={{ maxWidth: 190 }}
                value={newDeptDivId}
                onChange={(e) => setNewDeptDivId(e.target.value)}
              >
                {orgCatalogue.divisions.map((d) => (
                  <option key={d.id} value={d.id}>
                    Div: {d.name}
                  </option>
                ))}
              </select>
              <select
                className="field-select"
                style={{ maxWidth: 190 }}
                value={newDeptCcId}
                onChange={(e) => setNewDeptCcId(e.target.value)}
              >
                {orgCatalogue.costCentres.map((c) => (
                  <option key={c.id} value={c.id}>
                    CC: {c.code}
                  </option>
                ))}
              </select>
              <select
                className="field-select"
                style={{ maxWidth: 190 }}
                value={newDeptPcId}
                onChange={(e) => setNewDeptPcId(e.target.value)}
              >
                {orgCatalogue.profitCentres.map((p) => (
                  <option key={p.id} value={p.id}>
                    PC: {p.code}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                disabled={pending || !newDeptName.trim() || !newDeptCode.trim()}
                onClick={() => {
                  const id = `DEPT-${newDeptCode.trim().toUpperCase()}`;
                  const next: OrgStructureCatalogue = {
                    ...orgCatalogue,
                    departments: [
                      ...orgCatalogue.departments,
                      {
                        id,
                        code: newDeptCode.trim().toUpperCase(),
                        name: newDeptName.trim(),
                        parentDivisionId: newDeptDivId,
                        defaultCostCentreId: newDeptCcId || 'CC-RE',
                        defaultProfitCentreId: newDeptPcId || 'PC-RE',
                        legacyChoiceValueId: null,
                        active: true,
                      },
                    ],
                  };
                  setOrgCatalogue(next);
                  setNewDeptName('');
                  setNewDeptCode('');
                  startTransition(async () => {
                    await saveOrgStructureAction(next);
                    showToast(`Added department ${id}`);
                  });
                }}
              >
                + Add department
              </button>
            </div>
          </div>

          {/* 3. Teams & Practice Groups */}
          <div className="subcard">
            <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>
              3 · Teams &amp; Practice Groups (linked to parent Department)
            </h3>
            <table className="data-table" style={{ fontSize: 13, marginBottom: 12 }}>
              <thead>
                <tr>
                  <th>Team ID</th>
                  <th>Code</th>
                  <th>Team / Practice Group Name</th>
                  <th>Parent Department</th>
                </tr>
              </thead>
              <tbody>
                {orgCatalogue.teamsOrPracticeGroups.map((tm) => {
                  const dept = orgCatalogue.departments.find(
                    (d) => d.id === tm.parentDepartmentId,
                  );
                  return (
                    <tr key={tm.id}>
                      <td>{tm.id}</td>
                      <td>
                        <code>{tm.code}</code>
                      </td>
                      <td>
                        <strong>{tm.name}</strong>
                      </td>
                      <td>{dept ? `${dept.name} (${dept.code})` : tm.parentDepartmentId}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="text"
                className="field-input"
                style={{ maxWidth: 220 }}
                placeholder="New team / practice group name"
                value={newTeamName}
                onChange={(e) => setNewTeamName(e.target.value)}
              />
              <input
                type="text"
                className="field-input"
                style={{ maxWidth: 130 }}
                placeholder="Code (e.g. RE-PLAN)"
                value={newTeamCode}
                onChange={(e) => setNewTeamCode(e.target.value.toUpperCase())}
              />
              <select
                className="field-select"
                style={{ maxWidth: 220 }}
                value={newTeamDeptId}
                onChange={(e) => setNewTeamDeptId(e.target.value)}
              >
                {orgCatalogue.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    Dept: {d.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                disabled={pending || !newTeamName.trim() || !newTeamCode.trim()}
                onClick={() => {
                  const id = `TEAM-${newTeamCode.trim().toUpperCase()}`;
                  const next: OrgStructureCatalogue = {
                    ...orgCatalogue,
                    teamsOrPracticeGroups: [
                      ...orgCatalogue.teamsOrPracticeGroups,
                      {
                        id,
                        code: newTeamCode.trim().toUpperCase(),
                        name: newTeamName.trim(),
                        parentDepartmentId: newTeamDeptId,
                        active: true,
                      },
                    ],
                  };
                  setOrgCatalogue(next);
                  setNewTeamName('');
                  setNewTeamCode('');
                  startTransition(async () => {
                    await saveOrgStructureAction(next);
                    showToast(`Added team / practice group ${id}`);
                  });
                }}
              >
                + Add team / practice group
              </button>
            </div>
          </div>

          {/* 3b. Operational Teams, Team Leads, Members & Enquiry Practice-Area Routing */}
          <div className="subcard">
            <div className="list-section__header" style={{ marginBottom: 12 }}>
              <div>
                <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>
                  4 · Operational Teams, Team Leads &amp; Enquiry Practice-Area Routing
                </h3>
                <p className="muted" style={{ fontSize: 13 }}>
                  Operational teams hold shared task queues, designate Team Leads, and route incoming
                  enquiries by practice area. Employees assigned to a Department or Team in their{' '}
                  <strong>Works at the firm</strong> record are automatically added to the matching
                  operational team (and removed when marked as a Leaver).
                </p>
              </div>
              <button type="button" className="btn btn--primary btn--sm" onClick={openNewTeamModal}>
                + Create team
              </button>
            </div>

            {routingClashes.length > 0 ? (
              <div className="banner banner--warning" style={{ marginBottom: 14 }}>
                <div>
                  <strong>Practice area routing clash detected:</strong>{' '}
                  {routingClashes
                    .map((c) => {
                      const paLabel = resolveLabel(values, c.practiceAreaId);
                      const teamNames = c.teamIds
                        .map((tid) => teams.find((t) => t.id === tid)?.name ?? tid)
                        .join(', ');
                      return `${paLabel} is assigned to multiple active teams (${teamNames})`;
                    })
                    .join(' · ')}
                  . Each practice area should map to a single active team so incoming enquiries route
                  deterministically.
                </div>
              </div>
            ) : null}

            {teams.map((tm) => {
              const leadNames = tm.leadIds
                .map((id) => {
                  const p = people.find((x) => x.id === id);
                  return p ? personDisplayName(p) : id;
                })
                .join(', ');
              const memberNames = tm.memberIds
                .map((id) => {
                  const p = people.find((x) => x.id === id);
                  return p ? personDisplayName(p) : id;
                })
                .join(', ');
              const mappedPracticeAreas = tm.practiceAreaIds.map((paId) =>
                resolveLabel(values, paId),
              );

              return (
                <div key={tm.id} className="list-row">
                  <div className="list-row__main">
                    <div className="list-row__title">
                      {tm.name}{' '}
                      <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>
                        ({tm.id})
                      </span>{' '}
                      {!tm.active ? <StatusPill label="Inactive" tone="neutral" /> : null}
                      {mappedPracticeAreas.map((pa) => (
                        <StatusPill key={pa} label={`Routes: ${pa}`} tone="positive" />
                      ))}
                    </div>
                    {tm.description ? (
                      <div className="list-row__meta">{tm.description}</div>
                    ) : null}
                    <div className="list-row__meta" style={{ marginTop: 4 }}>
                      <strong>Team leads ({tm.leadIds.length}):</strong> {leadNames || 'None'} ·{' '}
                      <strong>Members ({tm.memberIds.length}):</strong> {memberNames || 'None'}
                    </div>
                  </div>
                  <div className="list-row__aside">
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => openEditTeamModal(tm)}
                    >
                      Edit team
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={pending}
                      onClick={() => handleToggleTeamActive(tm)}
                    >
                      {tm.active ? 'Deactivate' : 'Activate'}
                    </button>
                  </div>
                </div>
              );
            })}

            {teamModalOpen ? (
              <div className="modal-backdrop" role="dialog" aria-modal="true">
                <div className="modal-card" style={{ maxWidth: 680 }}>
                  <div className="modal-header">
                    <h2>{editingTeam ? `Edit team: ${editingTeam.name}` : 'Create team'}</h2>
                  </div>
                  <form onSubmit={handleSaveTeam}>
                    <div className="form-grid">
                      <div className="field-group field-group--full">
                        <label className="field-label" htmlFor="team-name-input">
                          Team name *
                        </label>
                        <input
                          id="team-name-input"
                          type="text"
                          required
                          className="field-input"
                          placeholder="e.g. Employment & HR"
                          value={teamName}
                          onChange={(e) => setTeamName(e.target.value)}
                        />
                      </div>
                      <div className="field-group field-group--full">
                        <label className="field-label" htmlFor="team-desc-input">
                          Description (optional)
                        </label>
                        <input
                          id="team-desc-input"
                          type="text"
                          className="field-input"
                          placeholder="Short summary of what this team handles…"
                          value={teamDesc}
                          onChange={(e) => setTeamDesc(e.target.value)}
                        />
                      </div>

                      <div className="field-group field-group--full">
                        <div className="field-label">Practice areas routed to this team</div>
                        <div className="checkbox-group" style={{ marginTop: 6 }}>
                          {practiceAreas.map((pa) => {
                            const checked = teamPracticeAreaIds.includes(pa.id);
                            const otherTeams = teams.filter(
                              (t) =>
                                t.active &&
                                t.id !== editingTeam?.id &&
                                t.practiceAreaIds.includes(pa.id),
                            );
                            return (
                              <label key={pa.id} className="checkbox-pill">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setTeamPracticeAreaIds((prev) => [...prev, pa.id]);
                                    } else {
                                      setTeamPracticeAreaIds((prev) =>
                                        prev.filter((id) => id !== pa.id),
                                      );
                                    }
                                  }}
                                />
                                <span>
                                  {pa.label}
                                  {otherTeams.length > 0
                                    ? ` (currently on ${otherTeams.map((t) => t.name).join(', ')})`
                                    : ''}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      </div>

                      <div className="field-group field-group--full">
                        <div className="field-label">Team members</div>
                        <div className="checkbox-group" style={{ marginTop: 6 }}>
                          {employees.map((emp) => {
                            const checked = teamMemberIds.includes(emp.id);
                            return (
                              <label key={emp.id} className="checkbox-pill">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setTeamMemberIds((prev) => [...prev, emp.id]);
                                    } else {
                                      setTeamMemberIds((prev) =>
                                        prev.filter((id) => id !== emp.id),
                                      );
                                      setTeamLeadIds((prev) =>
                                        prev.filter((id) => id !== emp.id),
                                      );
                                    }
                                  }}
                                />
                                <span>
                                  {personDisplayName(emp)} ({resolveLabel(values, emp.employeeRoleId)})
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      </div>

                      <div className="field-group field-group--full">
                        <div className="field-label">
                          Team leads (can assign and reassign team enquiries &amp; tasks)
                        </div>
                        <div className="checkbox-group" style={{ marginTop: 6 }}>
                          {employees
                            .filter((emp) => teamMemberIds.includes(emp.id))
                            .map((emp) => {
                              const checked = teamLeadIds.includes(emp.id);
                              return (
                                <label key={emp.id} className="checkbox-pill">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={(e) => {
                                      if (e.target.checked) {
                                        setTeamLeadIds((prev) => [...prev, emp.id]);
                                      } else {
                                        setTeamLeadIds((prev) =>
                                          prev.filter((id) => id !== emp.id),
                                        );
                                      }
                                    }}
                                  />
                                  <span>{personDisplayName(emp)}</span>
                                </label>
                              );
                            })}
                          {teamMemberIds.length === 0 ? (
                            <span className="muted" style={{ fontSize: 13 }}>
                              Select team members above first to designate team leads.
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    <div className="modal-actions">
                      <button
                        type="button"
                        className="btn btn--secondary"
                        onClick={() => setTeamModalOpen(false)}
                      >
                        Cancel
                      </button>
                      <button type="submit" className="btn btn--primary" disabled={pending}>
                        Save team
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            ) : null}
          </div>

          {/* 5. Offices, Cost Centres & Profit Centres */}
          <div className="form-grid-3">
            <div className="subcard">
              <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Offices</h3>
              <ul style={{ margin: '0 0 10px', paddingLeft: 18, fontSize: 13 }}>
                {orgCatalogue.offices.map((o) => (
                  <li key={o.id}>
                    <strong>{o.name}</strong> ({o.code})
                  </li>
                ))}
              </ul>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <input
                  type="text"
                  className="field-input"
                  placeholder="Office name"
                  value={newOfficeName}
                  onChange={(e) => setNewOfficeName(e.target.value)}
                />
                <input
                  type="text"
                  className="field-input"
                  placeholder="Code (e.g.SWA)"
                  value={newOfficeCode}
                  onChange={(e) => setNewOfficeCode(e.target.value.toUpperCase())}
                />
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  disabled={pending || !newOfficeName.trim() || !newOfficeCode.trim()}
                  onClick={() => {
                    const id = `OFF-${newOfficeCode.trim().toUpperCase()}`;
                    const next: OrgStructureCatalogue = {
                      ...orgCatalogue,
                      offices: [
                        ...orgCatalogue.offices,
                        {
                          id,
                          code: newOfficeCode.trim().toUpperCase(),
                          name: newOfficeName.trim(),
                          parentLegalEntityId: 'LE-PV-LLP',
                          address: {
                            id: `addr-${id}`,
                            typeId: null,
                            line1: newOfficeName.trim(),
                            line2: '',
                            town: newOfficeName.trim(),
                            county: '',
                            postcode: '',
                            countryId: null,
                          },
                          active: true,
                        },
                      ],
                    };
                    setOrgCatalogue(next);
                    setNewOfficeName('');
                    setNewOfficeCode('');
                    startTransition(async () => {
                      await saveOrgStructureAction(next);
                      showToast(`Added office ${id}`);
                    });
                  }}
                >
                  + Add office
                </button>
              </div>
            </div>

            <div className="subcard">
              <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Cost Centres</h3>
              <ul style={{ margin: '0 0 10px', paddingLeft: 18, fontSize: 13 }}>
                {orgCatalogue.costCentres.map((c) => (
                  <li key={c.id}>
                    <code>{c.code}</code> — {c.name}
                  </li>
                ))}
              </ul>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <input
                  type="text"
                  className="field-input"
                  placeholder="Cost centre name"
                  value={newCcName}
                  onChange={(e) => setNewCcName(e.target.value)}
                />
                <input
                  type="text"
                  className="field-input"
                  placeholder="Code (e.g. CC-TAX)"
                  value={newCcCode}
                  onChange={(e) => setNewCcCode(e.target.value.toUpperCase())}
                />
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  disabled={pending || !newCcName.trim() || !newCcCode.trim()}
                  onClick={() => {
                    const code = newCcCode.trim().toUpperCase();
                    const next: OrgStructureCatalogue = {
                      ...orgCatalogue,
                      costCentres: [
                        ...orgCatalogue.costCentres,
                        {
                          id: code,
                          code,
                          name: newCcName.trim(),
                          parentDepartmentId: null,
                          active: true,
                        },
                      ],
                    };
                    setOrgCatalogue(next);
                    setNewCcName('');
                    setNewCcCode('');
                    startTransition(async () => {
                      await saveOrgStructureAction(next);
                      showToast(`Added cost centre ${code}`);
                    });
                  }}
                >
                  + Add cost centre
                </button>
              </div>
            </div>

            <div className="subcard">
              <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Profit Centres</h3>
              <ul style={{ margin: '0 0 10px', paddingLeft: 18, fontSize: 13 }}>
                {orgCatalogue.profitCentres.map((p) => (
                  <li key={p.id}>
                    <code>{p.code}</code> — {p.name}
                  </li>
                ))}
              </ul>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <input
                  type="text"
                  className="field-input"
                  placeholder="Profit centre name"
                  value={newPcName}
                  onChange={(e) => setNewPcName(e.target.value)}
                />
                <input
                  type="text"
                  className="field-input"
                  placeholder="Code (e.g. PC-TAX)"
                  value={newPcCode}
                  onChange={(e) => setNewPcCode(e.target.value.toUpperCase())}
                />
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  disabled={pending || !newPcName.trim() || !newPcCode.trim()}
                  onClick={() => {
                    const code = newPcCode.trim().toUpperCase();
                    const next: OrgStructureCatalogue = {
                      ...orgCatalogue,
                      profitCentres: [
                        ...orgCatalogue.profitCentres,
                        {
                          id: code,
                          code,
                          name: newPcName.trim(),
                          parentDepartmentId: null,
                          active: true,
                        },
                      ],
                    };
                    setOrgCatalogue(next);
                    setNewPcName('');
                    setNewPcCode('');
                    startTransition(async () => {
                      await saveOrgStructureAction(next);
                      showToast(`Added profit centre ${code}`);
                    });
                  }}
                >
                  + Add profit centre
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB: EMPLOYEES */}
      {tab === 'employees' && (
        <div>
          <div className="list-section__header" style={{ marginBottom: 14 }}>
            <p className="muted">
              Firm employees of {firmName}. Each employee has a multi-role array (the
              first role is their Home page role, additional roles appear in &ldquo;Viewing as&rdquo;),
              optional supported fee earners (for Legal secretaries), and an application permission
              role.
            </p>
            <Link href="/people/new" className="btn btn--primary btn--sm">
              + Add employee
            </Link>
          </div>
          {employees.map((emp) => {
            const resolvedRole =
              appRoleByPersonId[emp.id] ?? emp.appRole ?? 'fee_earner';
            const empTeams = userTeams(emp.id, teams);
            const empRoles = rolesByPersonId[emp.id] ?? emp.roles ?? [];
            const availableRoles = homePagesConfig?.roles ?? [];
            const realEmpsForSupport = employees.filter((e) => !e.demo && e.id !== emp.id);
            const showsWorkPerson = emp.showsWorkOfId
              ? people.find((p) => p.id === emp.showsWorkOfId)
              : null;

            return (
              <div key={emp.id} className="list-row" style={{ alignItems: 'flex-start' }}>
                <div className="list-row__main" style={{ flex: 1 }}>
                  <div className="list-row__title">
                    <Link href={`/people/${emp.id}`}>{personDisplayName(emp)}</Link>{' '}
                    <span className="muted" style={{ fontWeight: 400 }}>
                      ({emp.id})
                    </span>{' '}
                    {emp.demo ? <StatusPill label="Demo persona" tone="warning" /> : null}
                  </div>
                  <div className="list-row__meta">
                    {[
                      resolveLabel(values, emp.employeeRoleId),
                      resolveLabel(values, emp.departmentId),
                      emp.jobTitle,
                      primaryEmail(emp),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  {showsWorkPerson ? (
                    <div className="list-row__meta" style={{ marginTop: 2 }}>
                      <strong>Shows work of:</strong> {personDisplayName(showsWorkPerson)} (
                      {showsWorkPerson.id})
                    </div>
                  ) : null}
                  <div className="list-row__meta" style={{ marginTop: 4 }}>
                    <strong>Teams:</strong>{' '}
                    {empTeams.length > 0
                      ? empTeams
                          .map((tm) =>
                            tm.leadIds.includes(emp.id) ? `${tm.name} (Lead)` : tm.name,
                          )
                          .join(', ')
                      : 'None'}
                  </div>

                  {/* Multi-role selector */}
                  {availableRoles.length > 0 ? (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
                        Home roles (1st = Home role, others in &ldquo;Viewing as&rdquo;):
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {availableRoles.map((r) => {
                          const active = empRoles.includes(r.key);
                          const isPrimary = empRoles[0] === r.key;
                          return (
                            <button
                              key={r.key}
                              type="button"
                              className={`btn btn--sm ${active ? 'btn--primary' : 'btn--secondary'}`}
                              style={{ fontSize: 12, minHeight: 28, padding: '2px 10px' }}
                              disabled={pending}
                              onClick={() => {
                                const nextRoles = active
                                  ? empRoles.length > 1
                                    ? empRoles.filter((k) => k !== r.key)
                                    : empRoles
                                  : [...empRoles, r.key];
                                startTransition(async () => {
                                  await updateEmployeeRolesAndSupportsAction(emp.id, {
                                    roles: nextRoles,
                                  });
                                  showToast(`Updated Home roles for ${personDisplayName(emp)}`);
                                });
                              }}
                            >
                              {isPrimary ? '★ ' : active ? '✓ ' : ''}
                              {r.shortLabel || r.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  {/* Supports selector for Legal secretaries */}
                  {empRoles.includes('legal_secretary') ? (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
                        Supports fee earners:
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {realEmpsForSupport.map((fe) => {
                          const currentSupports = emp.supportsIds ?? [];
                          const isSupported = currentSupports.includes(fe.id);
                          return (
                            <button
                              key={fe.id}
                              type="button"
                              className={`btn btn--sm ${isSupported ? 'btn--primary' : 'btn--secondary'}`}
                              style={{ fontSize: 12, minHeight: 28, padding: '2px 10px' }}
                              disabled={pending}
                              onClick={() => {
                                const nextSupports = isSupported
                                  ? currentSupports.filter((id) => id !== fe.id)
                                  : [...currentSupports, fe.id];
                                startTransition(async () => {
                                  await updateEmployeeRolesAndSupportsAction(emp.id, {
                                    supportsIds: nextSupports,
                                  });
                                  showToast(`Updated supported fee earners for ${personDisplayName(emp)}`);
                                });
                              }}
                            >
                              {isSupported ? '✓ ' : '+ '}
                              {personDisplayName(fe)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="list-row__aside" style={{ gap: 8 }}>
                  <StatusPill label={resolveLabel(values, emp.employeeRoleId)} tone="positive" />
                  <select
                    aria-label={`Application role for ${personDisplayName(emp)}`}
                    className="field-select"
                    style={{ width: 230, fontSize: 13, padding: '4px 8px' }}
                    value={emp.appRole ?? 'auto'}
                    onChange={(e) => {
                      const val = e.target.value;
                      startTransition(async () => {
                        await updateEmployeeRoleAction(
                          emp.id,
                          val === 'auto' ? null : (val as AppRole),
                        );
                        showToast(`Updated role for ${personDisplayName(emp)}`);
                      });
                    }}
                  >
                    <option value="auto">
                      Auto ({APP_ROLE_LABELS[resolvedRole]})
                    </option>
                    <option value="call_handler">Call handler</option>
                    <option value="fee_earner">Fee earner / caseworker</option>
                    <option value="team_lead">Team lead / supervising partner</option>
                    <option value="admin">Admin</option>
                  </select>
                  <Link href={`/people/${emp.id}/edit`} className="btn btn--secondary btn--sm">
                    Edit
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* TAB: DOCUMENT TEMPLATES & USAGE */}
      {tab === 'document-templates' && (
        <DocumentTemplatesAdminPanel currentUserId={currentUserId ?? people[0]?.id ?? ''} />
      )}

      {/* TAB: DOCUMENT STORES & DMS */}
      {tab === 'document-stores' && <DocumentStoresAdminPanel />}

      {/* TAB: RATES & MATTER COSTS */}
      {tab === 'rates-and-costs' && enableMatterCostsGovernance && matterCostsConfig && (
        <MatterCostsAdminSection
          initialConfig={matterCostsConfig}
          values={values}
          enablePmsLiveRateSync={enablePmsLiveRateSync}
        />
      )}

      {/* TAB: HOME PAGES */}
      {tab === 'home-pages' && homePagesConfig && (
        <HomePagesAdminSection
          initialConfig={homePagesConfig}
          defaultRoleConfigs={defaultRoleConfigs}
          activeViewingRole={activeViewingRole}
          rolesByPersonId={rolesByPersonId}
          people={people}
          teams={teams}
          values={values}
          onNavigateToEmployeeRoles={() => {
            setTab('lists');
            setSelectedListKey('employee_role');
            setOpenListGroups((prev) => new Set([...prev, 'people']));
          }}
        />
      )}

      {/* TAB: PMS LINKS */}
      {tab === 'pms-links' && pmsAdmin && (
        <PmsLinksAdminSection
          pmsAdmin={pmsAdmin}
          organisations={organisations}
          people={people}
          matters={matters}
        />
      )}

      {/* TAB: DEMO DATA */}
      {tab === 'demo-data' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 680 }}>
          <div className="subcard">
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
              Clear all data (New Client Deployment)
            </h2>
            <p className="muted" style={{ marginBottom: 16 }}>
              Empties all clients, organisations, people, employees, matters, enquiries, quotes,
              tasks, teams, PMS links, notes, and audit logs so you can inspect the application as a
              brand-new client deployment with only the Core platform taxonomy and default tenant
              configuration.
            </p>
            <button
              type="button"
              className="btn btn--primary"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const res = await clearAllDataAction();
                  if (isActionDenied(res)) {
                    showToast(res.message);
                    return;
                  }
                  showToast('Cleared all records — signing out to refresh session');
                  const logoutForm = document.createElement('form');
                  logoutForm.method = 'POST';
                  logoutForm.action = '/api/auth/logout';
                  document.body.appendChild(logoutForm);
                  logoutForm.submit();
                })
              }
            >
              Clear all data (New Client Deployment)
            </button>
          </div>

          <div className="subcard">
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
              Load {firmName} demo dataset
            </h2>
            <p className="muted" style={{ marginBottom: 16 }}>
              Restores the seeded people, employees, organisations, links, matters, teams, enquiries,
              quotes, tasks, notifications, choice lists, custom fields, notes, and PMS links to
              their demo starting state.
            </p>
            <button
              type="button"
              className="btn btn--secondary"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const res = await resetDemoDataAction();
                  if (isActionDenied(res)) {
                    showToast(res.message);
                    return;
                  }
                  showToast('Demo data restored');
                  window.location.reload();
                })
              }
            >
              Load demo dataset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
