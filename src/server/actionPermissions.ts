/**
 * Central action and API route permission policy registry
 * (`src/server/actionPermissions.ts`, ADR 0025 / Slice S0-02).
 *
 * Maps every exported server action in `src/app/actions.ts` and every HTTP method
 * handler in `src/app/api/**\/route.ts` (`<METHOD> /api/...`) to its authorisation
 * policy. Verified at test/CI time by `src/server/__tests__/actionPermissionGuard.test.ts`.
 */

import type { JobOnlyPermissionKey, PermissionKey } from '@platform/core';

export type GapSliceId =
  | 'S0-03'
  | 'S0-04'
  | 'S0-05'
  | 'S0-06'
  | 'S0-07';

export type PolicyPermissionRequirement =
  | PermissionKey
  | { readonly anyOf: readonly PermissionKey[] }
  | { readonly allOf: readonly PermissionKey[] };

export type ActionPolicy =
  | {
      readonly kind: 'permission';
      readonly key: PolicyPermissionRequirement;
      readonly enforcedBy: 'action' | 'service';
    }
  | {
      readonly kind: 'authenticated';
      readonly reason: string;
    }
  | {
      readonly kind: 'public';
      readonly reason: string;
    }
  | {
      readonly kind: 'gap';
      readonly slice: GapSliceId;
      readonly note?: string;
    };

export const ACTION_PERMISSIONS = {
  // ---------------------------------------------------------------------------
  // Authenticated self-scoped / presentation-only / demo-only actions (4)
  // ---------------------------------------------------------------------------
  switchUserAction: {
    kind: 'authenticated',
    reason:
      'Demo persona switch gated in switchUserInDemoMode to non-live tenants with featureFlags.enableDemoMode and no privilege elevation.',
  },
  switchViewingRoleAction: {
    kind: 'authenticated',
    reason:
      'Presentation-only Home role preview selector (ADR 0013); switchViewingRole verifies the actor holds the role or is an administrator.',
  },
  markNotificationReadAction: {
    kind: 'authenticated',
    reason:
      'Self-scoped notification state: markNotificationRead only updates notifications addressed to the authenticated actor (recipientId === userId).',
  },
  markAllNotificationsReadAction: {
    kind: 'authenticated',
    reason:
      'Self-scoped notification state: markAllNotificationsRead only updates notifications addressed to the authenticated actor (recipientId === userId).',
  },
  searchGlobalRecordsAction: {
    kind: 'authenticated',
    reason:
      'Every authenticated user can run global server-side search; TenantSearchRepository enforces per-entity RBAC permissions and record-level visibility inside SQL WHERE clauses before ranking or counting.',
  },
  previewIntakeDuplicatesAndConflictsAction: {
    kind: 'permission',
    key: {
      anyOf: [
        'contact:create',
        'contact:edit',
        'employee:edit_core',
        'enquiry:create',
        'enquiry:edit',
        'quote:edit',
        'matter:create',
        'matter:edit',
      ],
    },
    enforcedBy: 'action',
  },
  searchEntityPickerAction: {
    kind: 'authenticated',
    reason:
      'Authenticated form entity pickers execute read-only SQL searches enforcing quote:view, restricted matter / personal Draft SQL visibility predicates, and stripping all HR/employment/payroll/override/Entra fields.',
  },
  listClientPriorMattersAction: {
    kind: 'permission',
    key: { anyOf: ['matter:create', 'matter:edit'] },
    enforcedBy: 'action',
  },
  getEntityRecordForEditAction: {
    kind: 'permission',
    key: {
      anyOf: ['contact:edit', 'matter:create', 'matter:edit', 'employee:edit_core'],
    },
    enforcedBy: 'action',
  },
  getMyNotificationPreferencesAction: {
    kind: 'permission',
    key: 'notification:view_own',
    enforcedBy: 'action',
  },
  updateMyNotificationPreferencesAction: {
    kind: 'permission',
    key: 'notification:manage_own_preferences',
    enforcedBy: 'action',
  },

  // ---------------------------------------------------------------------------
  // Enforced at action wrapper level — S0-02 pilot (1)
  // ---------------------------------------------------------------------------
  updateTenantRbacConfigAction: {
    kind: 'permission',
    key: 'rbac:manage_config',
    enforcedBy: 'action',
  },

  // ---------------------------------------------------------------------------
  // Enforced inside the service layer today (47)
  // ---------------------------------------------------------------------------
  // HR / Employee restricted access (3)
  logEmployeeRestrictedAccessAction: {
    kind: 'permission',
    key: { anyOf: ['employee:payroll', 'employee:sensitive'] },
    enforcedBy: 'service',
  },
  revealEmployeePayrollAction: {
    kind: 'permission',
    key: 'employee:payroll',
    enforcedBy: 'service',
  },
  revealEmployeeSensitiveRecordAction: {
    kind: 'permission',
    key: 'employee:sensitive',
    enforcedBy: 'service',
  },

  // Matters (6)
  saveMatterAction: {
    kind: 'permission',
    key: { anyOf: ['matter:create', 'matter:edit'] },
    enforcedBy: 'service',
  },
  signOffMatterCostsAction: {
    kind: 'permission',
    key: 'matter:costs:sign_off',
    enforcedBy: 'service',
  },
  liftMatterRestrictionAction: {
    kind: 'permission',
    key: 'matter:restriction:lift',
    enforcedBy: 'service',
  },
  runMatterConflictSearchAction: {
    kind: 'permission',
    key: { anyOf: ['matter:create', 'matter:edit'] },
    enforcedBy: 'service',
  },
  updateMatterConflictRecordAction: {
    kind: 'permission',
    key: 'matter:edit',
    enforcedBy: 'service',
  },
  updateMatterLifecycleStatusAction: {
    kind: 'permission',
    key: 'matter:edit',
    enforcedBy: 'service',
  },

  // Tasks — claiming a task checks canUserTakeTask / task:edit (1)
  takeTaskAction: {
    kind: 'permission',
    key: { anyOf: ['task:edit', 'task:claim_any'] },
    enforcedBy: 'service',
  },

  // RBAC & Home configuration (7)
  updateEmployeeRoleAction: {
    kind: 'permission',
    key: 'rbac:manage_user_overrides',
    enforcedBy: 'service',
  },
  saveHomePagesConfigAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'service',
  },
  resetHomePagesConfigAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'service',
  },
  addHomeRoleAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'service',
  },
  updateEmployeeRolesAndSupportsAction: {
    kind: 'permission',
    key: 'rbac:manage_user_overrides',
    enforcedBy: 'service',
  },
  previewRbacOverridesAction: {
    kind: 'permission',
    key: { anyOf: ['admin:access', 'rbac:manage_user_overrides', 'rbac:manage_config'] },
    enforcedBy: 'service',
  },
  updatePersonPermissionOverridesAction: {
    kind: 'permission',
    key: 'rbac:manage_user_overrides',
    enforcedBy: 'service',
  },

  // Document Generation (16)
  getDocumentGenerationSnapshotAction: {
    kind: 'permission',
    key: { anyOf: ['document:view', 'document_template:view'] },
    enforcedBy: 'service',
  },
  uploadTemplateDraftAction: {
    kind: 'permission',
    key: 'document_template:build',
    enforcedBy: 'service',
  },
  updateTemplateDraftAction: {
    kind: 'permission',
    key: 'document_template:build',
    enforcedBy: 'service',
  },
  submitTemplateVersionAction: {
    kind: 'permission',
    key: 'document_template:build',
    enforcedBy: 'service',
  },
  approveTemplateVersionAction: {
    kind: 'permission',
    key: 'document_template:approve',
    enforcedBy: 'service',
  },
  rejectTemplateVersionAction: {
    kind: 'permission',
    key: 'document_template:approve',
    enforcedBy: 'service',
  },
  retireTemplateAction: {
    kind: 'permission',
    key: 'document_template:approve',
    enforcedBy: 'service',
  },
  rollbackTemplateVersionAction: {
    kind: 'permission',
    key: 'document_template:approve',
    enforcedBy: 'service',
  },
  exportTemplatePackageAction: {
    kind: 'permission',
    key: 'document_template:build',
    enforcedBy: 'service',
  },
  importTemplatePackageAction: {
    kind: 'permission',
    key: 'document_template:build',
    enforcedBy: 'service',
  },
  previewTemplateAction: {
    kind: 'permission',
    key: { anyOf: ['document_template:view', 'document_template:build', 'document:generate'] },
    enforcedBy: 'service',
  },
  generateDocumentAction: {
    kind: 'permission',
    key: 'document:generate',
    enforcedBy: 'service',
  },
  downloadGeneratedDocumentAction: {
    kind: 'permission',
    key: 'document:download',
    enforcedBy: 'service',
  },
  deleteGeneratedDocumentAction: {
    kind: 'permission',
    key: 'document:delete',
    enforcedBy: 'service',
  },
  getTemplateUsageReportAction: {
    kind: 'permission',
    key: 'document_template:view_usage',
    enforcedBy: 'service',
  },
  updateDocumentGenerationConfigAction: {
    kind: 'permission',
    key: {
      anyOf: ['document_template:build', 'rbac:manage_config', 'admin:access'],
    },
    enforcedBy: 'service',
  },

  // Key Dates & Limitation (15)
  previewLimitationCalculationAction: {
    kind: 'permission',
    key: 'keydate:view',
    enforcedBy: 'service',
  },
  createOrProposeKeyDateAction: {
    kind: 'permission',
    key: 'keydate:edit',
    enforcedBy: 'service',
  },
  proposeProvisionalKeyDateAction: {
    kind: 'permission',
    key: 'keydate:edit',
    enforcedBy: 'service',
  },
  verifyProposedKeyDateAction: {
    kind: 'permission',
    key: 'keydate:verify',
    enforcedBy: 'service',
  },
  rejectProposedKeyDateAction: {
    kind: 'permission',
    key: 'keydate:verify',
    enforcedBy: 'service',
  },
  supersedeConfirmedKeyDateAction: {
    kind: 'permission',
    key: 'keydate:edit',
    enforcedBy: 'service',
  },
  resolveKeyDateOutcomeAction: {
    kind: 'permission',
    key: { anyOf: ['keydate:resolve', 'keydate:waive'] },
    enforcedBy: 'service',
  },
  reassignKeyDateTeamAction: {
    kind: 'permission',
    key: 'keydate:edit',
    enforcedBy: 'service',
  },
  recordKeyDateNotApplicableAction: {
    kind: 'permission',
    key: 'keydate:edit',
    enforcedBy: 'service',
  },
  acknowledgeKeyDateReminderAction: {
    kind: 'permission',
    key: 'keydate:view',
    enforcedBy: 'service',
  },
  runKeyDateReminderSchedulerAction: {
    kind: 'permission',
    key: 'keydate:configure',
    enforcedBy: 'service',
  },
  queryKeyDatesTeamDiaryAction: {
    kind: 'permission',
    key: 'keydate:view',
    enforcedBy: 'service',
  },
  getKeyDateExceptionsReportAction: {
    kind: 'permission',
    key: 'keydate:view_any_team',
    enforcedBy: 'service',
  },
  exportKeyDateExceptionsReportAction: {
    kind: 'permission',
    key: 'keydate:view_any_team',
    enforcedBy: 'service',
  },
  saveKeyDatesConfigAction: {
    kind: 'permission',
    key: 'keydate:configure',
    enforcedBy: 'service',
  },

  // ---------------------------------------------------------------------------
  // Known baseline gaps (54 actions), tagged with the Stage 0 slice that closes each
  // ---------------------------------------------------------------------------
  // S0-03: Destructive, sign-off approval, retention anonymisation, compliance reminder & person save (7)
  savePersonAction: {
    kind: 'permission',
    key: {
      anyOf: ['employee:edit_core', 'contact:create', 'contact:edit'],
    },
    enforcedBy: 'service',
  },
  resetDemoDataAction: {
    kind: 'permission',
    key: 'admin:data_reset',
    enforcedBy: 'action',
  },
  clearAllDataAction: {
    kind: 'permission',
    key: 'admin:data_reset',
    enforcedBy: 'action',
  },
  approveSignOffAction: {
    kind: 'permission',
    key: { anyOf: ['signoff:approve', 'register:approve'] },
    enforcedBy: 'service',
  },
  discussSignOffAction: {
    kind: 'permission',
    key: { anyOf: ['signoff:approve', 'register:approve'] },
    enforcedBy: 'service',
  },
  anonymiseExpiredEnquiriesAction: {
    kind: 'permission',
    key: 'enquiry:anonymise',
    enforcedBy: 'action',
  },
  remindTeamLeadOverdueComplianceAction: {
    kind: 'permission',
    key: 'risk:view',
    enforcedBy: 'action',
  },

  // S0-04: Admin saves — lists, custom fields, teams, settings, org structure, party taxonomy, costs config & PMS links (22)
  addChoiceValueAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'action',
  },
  updateChoiceValueAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'action',
  },
  reorderChoiceValueAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'action',
  },
  createMatterStageGroupAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'action',
  },
  saveCustomFieldAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'action',
  },
  reorderCustomFieldAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'action',
  },
  saveTeamAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'action',
  },
  saveEnquirySettingsAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'action',
  },
  saveTaskSettingsAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'action',
  },
  saveOrgStructureAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'action',
  },
  saveMatterPartyRelationshipAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'action',
  },
  reorderMatterPartyRelationshipAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'action',
  },
  deleteMatterPartyRelationshipAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'action',
  },
  saveMatterPartyCapacityAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'action',
  },
  deleteMatterPartyCapacityAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'action',
  },
  updateWorkTypeProfilesAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'action',
  },
  saveWorkTypesConfigAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'action',
  },
  saveMatterCostsConfigAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'action',
  },
  syncMatterCostsRatesFromPmsAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'action',
  },
  linkPmsRecordAction: {
    kind: 'permission',
    key: 'finance:manage_links',
    enforcedBy: 'action',
  },
  unlinkPmsRecordAction: {
    kind: 'permission',
    key: 'finance:manage_links',
    enforcedBy: 'action',
  },
  rerunAutomaticPmsMatchingAction: {
    kind: 'permission',
    key: 'finance:manage_links',
    enforcedBy: 'action',
  },
  createRecordFromPmsAction: {
    kind: 'permission',
    key: 'finance:manage_links',
    enforcedBy: 'action',
  },
  loadPmsLinksAdminDataAction: {
    kind: 'permission',
    key: 'finance:manage_links',
    enforcedBy: 'action',
  },
  getExpiredEnquiriesCountAction: {
    kind: 'permission',
    key: { anyOf: ['admin:access', 'enquiry:anonymise'] },
    enforcedBy: 'action',
  },

  // S0-05: Record mutations — tasks, enquiries, organisations, links, notes, duplicates/merge, leavers & quotes (20)
  reassignLeaverOwnedRecordsAction: {
    kind: 'permission',
    key: 'matter:reassign_ownership',
    enforcedBy: 'action',
  },
  saveOrganisationAction: {
    kind: 'permission',
    key: { anyOf: ['contact:create', 'contact:edit'] },
    enforcedBy: 'action',
  },
  saveLinkAction: {
    kind: 'permission',
    key: { anyOf: ['contact:create', 'contact:edit'] },
    enforcedBy: 'action',
  },
  deleteLinkAction: {
    kind: 'permission',
    key: 'contact:edit',
    enforcedBy: 'action',
  },
  addNoteAction: {
    kind: 'permission',
    key: { anyOf: ['contact:edit', 'matter:edit', 'employee:edit_core'] },
    enforcedBy: 'service',
  },
  dismissDuplicateAction: {
    kind: 'permission',
    key: 'record:merge',
    enforcedBy: 'action',
  },
  mergeRecordsAction: {
    kind: 'permission',
    key: 'record:merge',
    enforcedBy: 'action',
  },
  saveTaskAction: {
    kind: 'permission',
    key: 'task:edit',
    enforcedBy: 'action',
  },
  addTaskCommentAction: {
    kind: 'permission',
    key: 'task:comment',
    enforcedBy: 'action',
  },
  saveEnquiryAction: {
    kind: 'permission',
    key: { anyOf: ['enquiry:create', 'enquiry:edit'] },
    enforcedBy: 'action',
  },
  assignEnquiryAction: {
    kind: 'permission',
    key: 'enquiry:assign',
    enforcedBy: 'action',
  },
  logEnquiryContactAction: {
    kind: 'permission',
    key: 'enquiry:edit',
    enforcedBy: 'action',
  },
  sendEnquiryEmailAction: {
    kind: 'permission',
    key: 'enquiry:edit',
    enforcedBy: 'action',
  },
  closeEnquiryAction: {
    kind: 'permission',
    key: 'enquiry:close',
    enforcedBy: 'action',
  },
  reopenEnquiryAction: {
    kind: 'permission',
    key: 'enquiry:reopen',
    enforcedBy: 'action',
  },
  saveQuoteAction: {
    kind: 'permission',
    key: 'quote:edit',
    enforcedBy: 'action',
  },
  sendQuoteEmailAction: {
    kind: 'permission',
    key: 'quote:edit',
    enforcedBy: 'action',
  },
  markQuoteSentOfflineAction: {
    kind: 'permission',
    key: 'quote:edit',
    enforcedBy: 'action',
  },
  logQuoteFollowUpAction: {
    kind: 'permission',
    key: 'quote:edit',
    enforcedBy: 'action',
  },
  reviseQuoteAction: {
    kind: 'permission',
    key: 'quote:edit',
    enforcedBy: 'action',
  },
  recordQuoteOutcomeAction: {
    kind: 'permission',
    key: 'quote:edit',
    enforcedBy: 'action',
  },

  // S0-07: Enquiry and quote conversion (2)
  prepareEnquiryConversionAction: {
    kind: 'permission',
    key: 'matter:create',
    enforcedBy: 'action',
  },
  prepareQuoteConversionAction: {
    kind: 'permission',
    key: 'matter:create',
    enforcedBy: 'action',
  },

  // S0-10: Finance billing, write-off and credit-control actions (3)
  requestMatterBillAction: {
    kind: 'permission',
    key: 'finance:credit_control',
    enforcedBy: 'action',
  },
  flagMatterWriteOffAction: {
    kind: 'permission',
    key: 'finance:credit_control',
    enforcedBy: 'action',
  },
  recordInvoiceCreditControlActionAction: {
    kind: 'permission',
    key: 'finance:credit_control',
    enforcedBy: 'action',
  },

  // S0-28a: Negotiated client, parent-group & matter rate overrides (7)
  listClientRateOverridesAction: {
    kind: 'permission',
    key: {
      anyOf: [
        'finance:view',
        'finance:view_matter',
        'finance:credit_control',
        'admin:access',
      ],
    },
    enforcedBy: 'action',
  },
  saveClientRateOverrideAction: {
    kind: 'permission',
    key: {
      anyOf: ['matter:costs:sign_off', 'finance:credit_control', 'admin:access'],
    },
    enforcedBy: 'service',
  },
  deleteClientRateOverrideAction: {
    kind: 'permission',
    key: {
      anyOf: ['matter:costs:sign_off', 'finance:credit_control', 'admin:access'],
    },
    enforcedBy: 'service',
  },
  listMatterRateOverridesAction: {
    kind: 'permission',
    key: {
      anyOf: [
        'finance:view',
        'finance:view_matter',
        'finance:credit_control',
        'admin:access',
        'matter:costs:sign_off',
      ],
    },
    enforcedBy: 'action',
  },
  saveMatterRateOverrideAction: {
    kind: 'permission',
    key: {
      anyOf: [
        'matter:costs:sign_off',
        'finance:credit_control',
        'admin:access',
      ],
    },
    enforcedBy: 'action',
  },
  deleteMatterRateOverrideAction: {
    kind: 'permission',
    key: {
      anyOf: [
        'matter:costs:sign_off',
        'finance:credit_control',
        'admin:access',
      ],
    },
    enforcedBy: 'action',
  },
  resolveApplicableRatesAction: {
    kind: 'permission',
    key: {
      anyOf: [
        'finance:view',
        'finance:view_matter',
        'finance:credit_control',
        'admin:access',
        'quote:view',
        'quote:edit',
        'matter:edit',
      ],
    },
    enforcedBy: 'action',
  },
  listRegistersWorkspaceAction: {
    kind: 'permission',
    key: { anyOf: ['register:view', 'undertaking:manage', 'cdd:view'] },
    enforcedBy: 'action',
  },
  getRegisterRecordDetailAction: {
    kind: 'permission',
    key: { anyOf: ['register:view', 'undertaking:manage', 'cdd:view'] },
    enforcedBy: 'action',
  },
  createRegisterRecordAction: {
    kind: 'permission',
    key: { anyOf: ['register:create', 'undertaking:manage'] },
    enforcedBy: 'action',
  },
  transitionRegisterRecordAction: {
    kind: 'permission',
    key: {
      anyOf: [
        'register:edit',
        'register:approve',
        'signoff:approve',
        'undertaking:manage',
        'cdd:record',
      ],
    },
    enforcedBy: 'action',
  },
  updateRegisterRecordAction: {
    kind: 'permission',
    key: { anyOf: ['register:edit', 'undertaking:manage'] },
    enforcedBy: 'action',
  },
  saveRegistersConfigAction: {
    kind: 'permission',
    key: 'register:configure',
    enforcedBy: 'action',
  },
  startOrLoadClientCddAction: {
    kind: 'permission',
    key: { anyOf: ['cdd:view', 'cdd:record'] },
    enforcedBy: 'action',
  },
  recordCddChecklistItemAction: {
    kind: 'permission',
    key: 'cdd:record',
    enforcedBy: 'action',
  },
  completeClientCddAction: {
    kind: 'permission',
    key: 'cdd:record',
    enforcedBy: 'action',
  },
  recordManualSanctionsPepAction: {
    kind: 'permission',
    key: 'cdd:record',
    enforcedBy: 'action',
  },
  saveCddConfigAction: {
    kind: 'permission',
    key: { allOf: ['admin:access', 'register:configure'] },
    enforcedBy: 'action',
  },
  openProspectiveMatterAction: {
    kind: 'permission',
    key: 'matter:edit',
    enforcedBy: 'action',
  },
  recordEngagementLetterSignedAction: {
    kind: 'permission',
    key: 'matter:edit',
    enforcedBy: 'action',
  },
  overrideMatterOpeningPreconditionAction: {
    kind: 'permission',
    key: 'matter:opening_gate:override',
    enforcedBy: 'action',
  },
  revokeMatterOpeningOverrideAction: {
    kind: 'permission',
    key: 'matter:opening_gate:override',
    enforcedBy: 'action',
  },
  saveMatterNumberingConfigAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'action',
  },
  sendEngagementLetterAction: {
    kind: 'permission',
    key: 'matter:edit',
    enforcedBy: 'action',
  },
  stopCommunicationChaseAction: {
    kind: 'permission',
    key: { anyOf: ['matter:edit', 'quote:edit', 'money_on_account:request'] },
    enforcedBy: 'service',
  },
  retryCommunicationChaseAction: {
    kind: 'permission',
    key: { anyOf: ['matter:edit', 'quote:edit', 'money_on_account:request'] },
    enforcedBy: 'service',
  },
  sendNonEngagementLetterAction: {
    kind: 'permission',
    key: { anyOf: ['enquiry:edit', 'enquiry:close', 'matter:edit'] },
    enforcedBy: 'action',
  },
  saveEngagementConfigAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'service',
  },
  saveChasingConfigAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'service',
  },
  listOutboxMessagesForAdminAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'service',
  },
  getOutboxMessageForAdminAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'service',
  },
  createAndSendMoneyOnAccountRequestAction: {
    kind: 'permission',
    key: 'money_on_account:request',
    enforcedBy: 'action',
  },
  cancelMoneyOnAccountRequestAction: {
    kind: 'permission',
    key: 'money_on_account:request',
    enforcedBy: 'action',
  },
  recordMoneyOnAccountReceiptAction: {
    kind: 'permission',
    key: 'money_on_account:record_receipt',
    enforcedBy: 'action',
  },
  matchPmsClientLedgerReceiptAction: {
    kind: 'permission',
    key: { allOf: ['money_on_account:record_receipt', 'finance:view_matter'] },
    enforcedBy: 'action',
  },
  reverseMoneyOnAccountReceiptAction: {
    kind: 'permission',
    key: 'money_on_account:record_receipt',
    enforcedBy: 'action',
  },
  saveMoneyOnAccountConfigAction: {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'service',
  },
} as const satisfies Record<string, ActionPolicy>;

export type RegisteredActionName = keyof typeof ACTION_PERMISSIONS;

export const ROUTE_PERMISSIONS = {
  'GET /api/address-lookup': {
    kind: 'authenticated',
    reason: 'R371 405 Method Not Allowed stub; use POST /api/address-lookup with a JSON body.',
  },
  'POST /api/address-lookup': {
    kind: 'authenticated',
    reason: 'Public UK postcode data; reads no tenant data (S0-01, R371 POST).',
  },
  'GET /api/auth/login': {
    kind: 'public',
    reason: 'Starts the Microsoft Entra ID OIDC PKCE sign-in flow.',
  },
  'GET /api/auth/callback/microsoft-entra-id': {
    kind: 'public',
    reason:
      'Handles the Microsoft Entra ID OIDC authorization-code redirect callback.',
  },
  'GET /api/auth/logout': {
    kind: 'public',
    reason:
      'Returns 405 Method Not Allowed with Allow: POST header (R62 logout CSRF protection).',
  },
  'POST /api/auth/logout': {
    kind: 'public',
    reason: 'Clears session and PKCE cookies to sign out the current browser.',
  },
  'GET /api/health/live': {
    kind: 'public',
    reason:
      'Azure Container Apps liveness probe endpoint; confirms process responsiveness with no tenant data or DB queries (R580).',
  },
  'GET /api/health/ready': {
    kind: 'public',
    reason:
      'Azure Container Apps readiness probe endpoint; checks PostgreSQL pool connectivity and required schema migrations with no tenant data in the response (R580).',
  },
  'GET /api/documents/download': {
    kind: 'permission',
    key: { anyOf: ['document:download', 'document:view'] },
    enforcedBy: 'service',
  },
  'GET /api/document-stores': {
    kind: 'permission',
    key: {
      anyOf: [
        'document_store:configure',
        'document_template:configure',
        'document_access:review',
      ],
    },
    enforcedBy: 'service',
  },
  'POST /api/document-stores': {
    kind: 'permission',
    key: {
      anyOf: [
        'document_store:configure',
        'document_template:configure',
        'document_access:review',
      ],
    },
    enforcedBy: 'service',
  },
  'GET /api/matters/[id]/documents': {
    kind: 'permission',
    key: { anyOf: ['document:view', 'document:download'] },
    enforcedBy: 'service',
  },
  'POST /api/matters/[id]/documents': {
    kind: 'permission',
    key: {
      anyOf: [
        'document:upload',
        'document:edit',
        'document:delete',
        'document:provision',
        'matter:edit',
      ],
    },
    enforcedBy: 'service',
  },
  'POST /api/matters/extract': {
    kind: 'permission',
    key: 'matter:create',
    enforcedBy: 'action',
  },
  'POST /api/evidence/upload': {
    kind: 'permission',
    key: { anyOf: ['cdd:record', 'matter:edit', 'money_on_account:record_receipt'] },
    enforcedBy: 'service',
  },
  'GET /api/evidence/download': {
    kind: 'permission',
    key: {
      anyOf: [
        'cdd:view',
        'matter:edit',
        'document:view',
        'money_on_account:view',
        'money_on_account:record_receipt',
      ],
    },
    enforcedBy: 'service',
  },
  'GET /api/admin/outbox/[id]/attachments/[ordinal]': {
    kind: 'permission',
    key: 'admin:access',
    enforcedBy: 'service',
  },
  'GET /api/quotes/[id]/pdf': {
    kind: 'permission',
    key: 'quote:view',
    enforcedBy: 'action',
  },
} as const satisfies Record<string, ActionPolicy>;

export type RegisteredRouteName = keyof typeof ROUTE_PERMISSIONS;

export interface JobPolicy {
  readonly kind: 'job';
  readonly permission: JobOnlyPermissionKey;
  readonly jobOnly: true;
  readonly timeoutMs: number;
  readonly defaultRunHourLocal?: number;
  readonly description: string;
}

/**
 * Central background job permission policy registry (ADR 0030 §3 / Slice S0-19).
 *
 * Every registered CLI job in `scripts/run-job.ts` must have an entry here mapping
 * its `jobKey` to a `jobOnly: true` permission in `PERMISSION_REGISTRY`.
 */
export const JOB_PERMISSIONS = {
  provision: {
    kind: 'job',
    permission: 'tenant:provision',
    jobOnly: true,
    timeoutMs: 120_000,
    description:
      'Provision per-tenant PostgreSQL databases, NOLOGIN roles, NOINHERIT runtime Entra principal, and public schema privileges.',
  },
  migrate: {
    kind: 'job',
    permission: 'tenant:migrate',
    jobOnly: true,
    timeoutMs: 120_000,
    description:
      'Apply pending per-tenant PostgreSQL expand/contract migrations across active registry tenants.',
  },
  'seed-demo': {
    kind: 'job',
    permission: 'tenant:seed_demo',
    jobOnly: true,
    timeoutMs: 300_000,
    description:
      'Seed non-live demo tenant database and blob storage with invented demo data and optional Entra ID user mapping.',
  },
  'key-date-reminders': {
    kind: 'job',
    permission: 'keydate:run_reminders',
    jobOnly: true,
    timeoutMs: 120_000,
    defaultRunHourLocal: 2,
    description:
      'Evaluate due key date reminders, follow-up tasks, and overdue escalations per tenant.',
  },
  'usage-retention-purge': {
    kind: 'job',
    permission: 'document_generation:purge_usage',
    jobOnly: true,
    timeoutMs: 120_000,
    defaultRunHourLocal: 2,
    description:
      'Purge expired document generation usage events and daily summaries per tenant.',
  },
  'enquiry-retention-anonymise': {
    kind: 'job',
    permission: 'enquiry:run_retention_anonymise',
    jobOnly: true,
    timeoutMs: 120_000,
    defaultRunHourLocal: 2,
    description:
      'Anonymise closed unconverted enquiries past the tenant retention period once per local day.',
  },
  'register-reminders': {
    kind: 'job',
    permission: 'register:run_reminders',
    jobOnly: true,
    timeoutMs: 120_000,
    defaultRunHourLocal: 8,
    description:
      'Dispatch due and periodic review reminders for active firm register records and undertakings once per stage.',
  },
  'outbox-drain': {
    kind: 'job',
    permission: 'notification:drain_outbox',
    jobOnly: true,
    timeoutMs: 120_000,
    description:
      'Drain due tenant email and Teams activity outbox messages with retry/backoff and scrub expired content past outboxContentRetentionDays (ADR 0027 / ADR 0035 / ADR 0030 variant).',
  },
  'notification-digests': {
    kind: 'job',
    permission: 'notification:send_digests',
    jobOnly: true,
    timeoutMs: 120_000,
    defaultRunHourLocal: 8,
    description:
      'Compile and queue daily and weekly email notification digests per tenant user once per working weekday in tenant timezone (ADR 0035 / ADR 0030).',
  },
  'quote-expiry': {
    kind: 'job',
    permission: 'quote:run_expiry',
    jobOnly: true,
    timeoutMs: 120_000,
    defaultRunHourLocal: 2,
    description:
      'Transition Sent and Follow-up due quotes past validUntil to Expired with timeline and zero-PII audit once per local day in tenant timezone (ADR 0030, R663).',
  },
  'communication-chases': {
    kind: 'job',
    permission: 'communication:run_chases',
    jobOnly: true,
    timeoutMs: 120_000,
    defaultRunHourLocal: 8,
    description:
      'Run automated communication chasing steps (day-7 and day-14 client reminder emails, day-21 escalation tasks) across engagement letters, quotes, and money on account once per local day in tenant timezone (ADR 0030, ADR 0042).',
  },
} as const satisfies Record<string, JobPolicy>;

export type RegisteredJobName = keyof typeof JOB_PERMISSIONS;
export type JobName = RegisteredJobName;

/**
 * Maximum number of `kind: 'gap'` policies across `ACTION_PERMISSIONS` and
 * `ROUTE_PERMISSIONS`. Equals the exact S0-02 baseline (54 actions + 1 route = 55)
 * and may only decrease as slices S0-03 to S0-07 and S0-10 close gaps.
 */
export const MAX_KNOWN_GAPS = 0;
