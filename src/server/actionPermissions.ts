/**
 * Central action and API route permission policy registry
 * (`src/server/actionPermissions.ts`, ADR 0025 / Slice S0-02).
 *
 * Maps every exported server action in `src/app/actions.ts` and every HTTP method
 * handler in `src/app/api/**\/route.ts` (`<METHOD> /api/...`) to its authorisation
 * policy. Verified at test/CI time by `src/server/__tests__/actionPermissionGuard.test.ts`.
 */

import type { PermissionKey } from '@platform/core';

export type GapSliceId =
  | 'S0-03'
  | 'S0-04'
  | 'S0-05'
  | 'S0-06'
  | 'S0-07'
  | 'S0-10';

export type PolicyPermissionRequirement =
  | PermissionKey
  | { readonly anyOf: readonly PermissionKey[] };

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
  // HR / Employee restricted access (2)
  logEmployeeRestrictedAccessAction: {
    kind: 'permission',
    key: { anyOf: ['employee:payroll', 'employee:sensitive'] },
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
  markEngagementLetterDraftedAction: {
    kind: 'permission',
    key: 'matter:edit',
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

  // Tasks — claiming a task checks canUserTakeTask / task:claim_any (1)
  takeTaskAction: {
    kind: 'permission',
    key: 'task:claim_any',
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
    key: 'rbac:manage_user_overrides',
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
    key: 'document_template:view',
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
    key: 'document:generate',
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
    key: 'document_template:configure',
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
    key: 'keydate:resolve',
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
    key: 'signoff:approve',
    enforcedBy: 'service',
  },
  discussSignOffAction: {
    kind: 'permission',
    key: 'signoff:approve',
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
    key: 'admin:access',
    enforcedBy: 'action',
  },

  // S0-05: Record mutations — tasks, enquiries, organisations, links, notes, duplicates/merge, leavers & quotes (20)
  reassignLeaverOwnedRecordsAction: {
    kind: 'gap',
    slice: 'S0-05',
  },
  saveOrganisationAction: {
    kind: 'gap',
    slice: 'S0-05',
  },
  saveLinkAction: {
    kind: 'gap',
    slice: 'S0-05',
  },
  deleteLinkAction: {
    kind: 'gap',
    slice: 'S0-05',
  },
  addNoteAction: {
    kind: 'gap',
    slice: 'S0-05',
  },
  dismissDuplicateAction: {
    kind: 'gap',
    slice: 'S0-05',
  },
  mergeRecordsAction: {
    kind: 'gap',
    slice: 'S0-05',
  },
  saveTaskAction: {
    kind: 'gap',
    slice: 'S0-05',
  },
  addTaskCommentAction: {
    kind: 'gap',
    slice: 'S0-05',
  },
  saveEnquiryAction: {
    kind: 'gap',
    slice: 'S0-05',
  },
  assignEnquiryAction: {
    kind: 'gap',
    slice: 'S0-05',
  },
  logEnquiryContactAction: {
    kind: 'gap',
    slice: 'S0-05',
  },
  sendEnquiryEmailAction: {
    kind: 'gap',
    slice: 'S0-05',
  },
  closeEnquiryAction: {
    kind: 'gap',
    slice: 'S0-05',
  },
  reopenEnquiryAction: {
    kind: 'gap',
    slice: 'S0-05',
  },
  saveQuoteAction: {
    kind: 'gap',
    slice: 'S0-05',
  },
  markQuoteSentAction: {
    kind: 'gap',
    slice: 'S0-05',
  },
  logQuoteFollowUpAction: {
    kind: 'gap',
    slice: 'S0-05',
  },
  reviseQuoteAction: {
    kind: 'gap',
    slice: 'S0-05',
  },
  recordQuoteOutcomeAction: {
    kind: 'gap',
    slice: 'S0-05',
  },

  // S0-07: Enquiry and quote conversion (2)
  prepareEnquiryConversionAction: {
    kind: 'gap',
    slice: 'S0-07',
  },
  prepareQuoteConversionAction: {
    kind: 'gap',
    slice: 'S0-07',
  },

  // S0-10: Finance billing, write-off and credit-control actions (3)
  requestMatterBillAction: {
    kind: 'gap',
    slice: 'S0-10',
  },
  flagMatterWriteOffAction: {
    kind: 'gap',
    slice: 'S0-10',
  },
  recordInvoiceCreditControlActionAction: {
    kind: 'gap',
    slice: 'S0-10',
  },
} as const satisfies Record<string, ActionPolicy>;

export type RegisteredActionName = keyof typeof ACTION_PERMISSIONS;

export const ROUTE_PERMISSIONS = {
  'GET /api/address-lookup': {
    kind: 'authenticated',
    reason: 'Public UK postcode data; reads no tenant data (S0-01).',
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
  'GET /api/documents/download': {
    kind: 'permission',
    key: 'document:download',
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
      ],
    },
    enforcedBy: 'service',
  },
  'POST /api/matters/extract': {
    kind: 'gap',
    slice: 'S0-06',
    note: 'Checks sign-in only today; S0-06 adds create permissions, feature-flag checks, and blocks employee creation.',
  },
} as const satisfies Record<string, ActionPolicy>;

export type RegisteredRouteName = keyof typeof ROUTE_PERMISSIONS;

/**
 * Maximum number of `kind: 'gap'` policies across `ACTION_PERMISSIONS` and
 * `ROUTE_PERMISSIONS`. Equals the exact S0-02 baseline (54 actions + 1 route = 55)
 * and may only decrease as slices S0-03 to S0-07 and S0-10 close gaps.
 */
export const MAX_KNOWN_GAPS = 26;
