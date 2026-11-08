import { describe, expect, it, beforeEach } from 'vitest';
import {
  ALL_BUILTIN_ROLE_KEYS,
  ALL_PERMISSION_KEYS,
  AuthorisationError,
  approveTemplateVersion,
  canAccessMatter,
  canActorAccessGeneratedDocument,
  clearPermissionRequestCache,
  collectConfigDeprecationWarnings,
  CORE_FIELD_CATALOGUE,
  createDefaultRbacConfig,
  DEFAULT_RBAC_ROLES,
  hasPermission,
  isEntraMfaVerified,
  isRegisteredPermissionKey,
  loadAndValidateTenantConfig,
  mapEntraTokenClaimsToVerifiedOidcToken,
  migrateLegacyPersonOverrides,
  PERMISSION_REGISTRY,
  requirePermission,
  resolveAuthoritativeRoles,
  resolvePermissions,
  resolveTenantFromVerifiedToken,
  TenantDocumentRepository,
  validateTenantConfigWithWarnings,
  validateUserOverrideOrRoleMutation,
  type PermissionKey,
  type TenantConfiguration,
  type TenantContext,
} from '../src/index';
import notALawFirmBaseConfig from '../../client-not-a-law-firm/config/base.json';
import {
  computeStaffMatterStatus,
  createDefaultEmploymentRecord,
  findRecordsOwnedByLeavers,
  resolveEmployeePermissions as domainResolveEmployeePermissions,
} from '../../src/domain/employment';
import {
  getLeftRailVisibility as domainGetLeftRailVisibility,
  resolveEmployeeRoles,
} from '../../src/domain/homeConfig';
import {
  resolvePersonPermissionSet as domainResolvePersonPermissionSet,
  resolvePersonForEntraClaims as domainResolvePersonForEntraClaims,
} from '../../src/domain/rbac';
import {
  canPersonAccessMatter,
  canUserAccessMatter,
  canUserReassignTask,
  canUserTakeTask,
  getDefaultTenantRbacConfig,
  getLeftRailVisibility,
  getStoredActorSessionForPerson,
  hasEmployeePermission,
  hasPersonPermission,
  resolveEmployeePermissions,
  resolvePersonForEntraClaims,
  resolvePersonPermissions,
  resolveUserAppRole,
  runWithActiveActorSession,
  setRuntimeRbacConfigOverride,
} from '../../src/server/rbacRuntime';
import { saveStore } from '../../src/server/store';
import { buildDemoData } from '../../src/seed/demo';
import { NextRequest } from 'next/server';
import { POST as logoutPost } from '../../src/app/api/auth/logout/route';
import {
  addNoteToRecord,
  addTaskCommentRecord,
  anonymiseExpiredEnquiries,
  approveSignOff,
  assignEnquiryRecord,
  closeEnquiryRecord,
  createOrUpdateLink,
  deleteLink,
  discussSignOff,
  dismissDuplicateMatch,
  executeMerge,
  getAppSnapshot,
  getEmployeeDetailsForUser,
  logEmployeeRestrictedAccess,
  logEnquiryContactRecord,
  logQuoteFollowUpRecord,
  markQuoteSentRecord,
  previewRbacOverrides,
  prepareEnquiryConversion,
  prepareQuoteConversionRecord,
  reassignLeaverOwnedRecords,
  recordQuoteOutcomeRecord,
  remindTeamLeadOverdueCompliance,
  reopenEnquiryRecord,
  requireAuthenticatedActor,
  resetAllDemoData,
  resolveOrProvisionEntraEmployee,
  reviseQuoteRecord,
  runMatterConflictSearchRecord,
  saveEnquiryRecord,
  saveMatterRecord,
  saveOrganisationRecord,
  savePersonRecord,
  saveQuoteRecord,
  saveTaskRecord,
  sendEnquiryEmailRecord,
  updateEmployeeRolesAndSupports,
  updateEmployeeRoleSetting,
  updatePersonPermissionOverrides,
  updateTenantRbacConfig,
  withPageActor,
} from '../../src/server/services';
import {
  flushDocumentLifecycleSyncForTesting,
  retryMatterDocumentProvisioning,
} from '../../src/server/documentStoreServices';
import { getStore } from '../../src/server/store';
import {
  buildEntraSessionPayload,
  createSignedEntraSessionCookie,
  setTestEntraSessionOverride,
  verifySignedEntraSessionCookie,
} from '../../src/server/entraAuth';
import {
  getActiveTenantConfiguration,
  getActiveTenantRawBaseConfig,
  resolveCurrentTenantContext,
  setActiveTenantConfigForTesting,
} from '../../src/platform/tenantRuntime';
import {
  addChoiceValueAction,
  addHomeRoleAction,
  clearAllDataAction,
  createMatterStageGroupAction,
  createRecordFromPmsAction,
  deleteMatterPartyCapacityAction,
  deleteMatterPartyRelationshipAction,
  linkPmsRecordAction,
  prepareEnquiryConversionAction,
  prepareQuoteConversionAction,
  reorderChoiceValueAction,
  reorderCustomFieldAction,
  reorderMatterPartyRelationshipAction,
  rerunAutomaticPmsMatchingAction,
  resetDemoDataAction,
  resetHomePagesConfigAction,
  saveCustomFieldAction,
  saveEnquirySettingsAction,
  saveHomePagesConfigAction,
  saveMatterCostsConfigAction,
  saveOrganisationAction,
  savePersonAction,
  saveMatterPartyCapacityAction,
  saveMatterPartyRelationshipAction,
  saveOrgStructureAction,
  saveTaskSettingsAction,
  saveTeamAction,
  switchUserAction,
  syncMatterCostsRatesFromPmsAction,
  unlinkPmsRecordAction,
  updateChoiceValueAction,
  updateTenantRbacConfigAction,
  updateWorkTypeProfilesAction,
} from '../../src/app/actions';
import crypto from 'node:crypto';
import { isActionDenied } from '../../src/domain/actionResult';
import {
  buildEffectiveConflictParties,
  CONFLICT_SEARCHED_SOURCES,
  redactRecordId,
  searchMatterConflicts,
} from '../../src/domain/matterConflicts';
import {
  computeEnquiryConflictSnapshot,
  detectPreliminaryConflicts,
  runEnquiryConflictSearch,
} from '../../src/domain/enquiries';
import { canActorAccessMatterRecord } from '../src/domain/document-generation/permissions';
import type { ChoiceValue, Matter, Person, Task, Team } from '../../src/domain/types';

function makeBaseTenantConfig(tenantId = 'tenant-alpha'): TenantConfiguration {
  return loadAndValidateTenantConfig({
    ...(notALawFirmBaseConfig as Record<string, unknown>),
    tenantId,
  });
}

function makeTestPerson(overrides: Partial<Person> = {}): Person {
  return {
    id: 'P-TEST-01',
    recordType: 'person',
    recordOwnerId: 'P-000001',
    recordStatusId: 'person_record_status.active',
    createdById: 'P-000001',
    createdAt: '2026-01-01T00:00:00Z',
    updatedById: 'P-000001',
    updatedAt: '2026-01-01T00:00:00Z',
    sourceId: 'data_source.manual_entry',
    lastVerifiedAt: '2026-01-01',
    tags: [],
    duplicateStatusId: 'duplicate_status.none',
    notDuplicateOf: [],
    possibleMatchIds: [],
    mergedIntoId: null,
    lastInteractionAt: null,
    customFields: {},
    titleId: null,
    firstName: 'Test',
    middleNames: '',
    surname: 'Employee',
    preferredName: '',
    dateOfBirth: '1990-01-01',
    otherNames: [],
    jobTitle: 'Solicitor',
    emails: [
      {
        id: 'em-1',
        typeId: null,
        address: 'test@notalawfirm.example',
        isPrimary: true,
      },
    ],
    phones: [],
    preferredContactMethodId: null,
    preferredLanguageId: 'language.english',
    addresses: [],
    website: '',
    relationshipOwnerId: 'P-000001',
    relationshipStatusId: 'relationship_status.active',
    relationshipStandingId: null,
    relationshipRoleIds: [],
    originId: null,
    firstKnownAt: '2026-01-01',
    engagementLevelId: null,
    interests: '',
    relationshipNotes: '',
    marketingConsentId: 'marketing_consent.not_asked',
    consentRecord: '',
    verificationStatusId: 'verification_status.not_required',
    verifiedAt: null,
    verificationMethodId: null,
    verificationReviewerId: null,
    riskReferences: '',
    isEmployee: true,
    employeeRoleId: 'employee_role.fee_earner',
    departmentId: 'DEPT-CORP',
    roles: ['fee_earner'],
    createdFromEnquiryId: null,
    ...overrides,
  };
}

describe('Central Configuration-Driven RBAC (ADR-0010 .. ADR-0016)', () => {
  beforeEach(() => {
    clearPermissionRequestCache();
  });

  describe('1. Permission Registry & Field Catalogue Contract (ADR-0010)', () => {
    it('defines all 60 canonical permissions with metadata and MFA flags', () => {
      expect(ALL_PERMISSION_KEYS.length).toBe(60);
      for (const key of ALL_PERMISSION_KEYS) {
        const entry = PERMISSION_REGISTRY[key];
        expect(entry).toBeDefined();
        expect(entry.key).toBe(key);
        expect(entry.description.length).toBeGreaterThan(10);
        expect(['standard', 'confidential', 'restricted', 'critical']).toContain(
          entry.sensitivity,
        );
        expect(typeof entry.requiresMfa).toBe('boolean');
        expect(['1.0.0', '1.1.0']).toContain(entry.sinceVersion);
      }

      // Critical / administrative permissions require MFA
      expect(PERMISSION_REGISTRY['document_template:approve'].requiresMfa).toBe(true);
      expect(PERMISSION_REGISTRY['finance:manage_links'].requiresMfa).toBe(true);
      expect(PERMISSION_REGISTRY['admin:access'].requiresMfa).toBe(true);
      expect(PERMISSION_REGISTRY['rbac:manage_config'].requiresMfa).toBe(true);
      expect(PERMISSION_REGISTRY['rbac:manage_user_overrides'].requiresMfa).toBe(true);
      expect(PERMISSION_REGISTRY['matter:restriction:lift'].requiresMfa).toBe(true);
      expect(PERMISSION_REGISTRY['admin:data_reset'].requiresMfa).toBe(true);
    });

    it('enforces CI contract: every Field Catalogue entry references a registered PermissionKey', () => {
      expect(CORE_FIELD_CATALOGUE.length).toBeGreaterThan(0);
      for (const field of CORE_FIELD_CATALOGUE) {
        expect(
          isRegisteredPermissionKey(field.requiredPermission),
          `Catalogue field "${field.key}" references unregistered permission "${field.requiredPermission}"`,
        ).toBe(true);
      }
    });
  });

  describe('2. Baseline Effective Access Matrix Parity & Configurable Grants (ADR-0011)', () => {
    it('ships zero hardcoded department IDs in core default RBAC configuration', () => {
      const coreDefaults = createDefaultRbacConfig();
      expect(Object.keys(coreDefaults.departmentGrants)).toEqual([]);
      expect(Object.keys(coreDefaults.roles).sort()).toEqual(
        [...ALL_BUILTIN_ROLE_KEYS].sort(),
      );
    });

    it('reproduces the exact baseline permission matrix across all built-in roles', () => {
      const config = makeBaseTenantConfig();

      const defaultCtx = {
        tenantId: 'tenant-alpha',
        correlationId: 'corr-matrix',
        actorId: 'u-role',
        actorRoles: [] as string[],
        mfaVerified: false,
      };
      const resolveForRole = (role: string) =>
        resolvePermissions({
          context: { ...defaultCtx, actorId: `u-${role}`, actorRoles: [role] },
          actor: { userId: `u-${role}`, roles: [role] },
          config,
        });

      // R119: Calling resolvePermissions with an empty tenantId throws
      expect(() =>
        resolvePermissions({
          context: { ...defaultCtx, tenantId: '' },
          actor: { userId: 'u-admin', roles: ['admin'] },
          config,
        }),
      ).toThrow(/RBAC_TENANT_REQUIRED/);

      // Admin holds all 25 permissions
      const adminPerms = resolveForRole('admin');
      expect(adminPerms.permissionList.length).toBe(ALL_PERMISSION_KEYS.length);

      // Managing partner holds HR, payroll, sensitive, finance, risk, matter:restricted:access, template build/approve
      const mpPerms = resolveForRole('managing_partner');
      expect(mpPerms.has('employee:edit_core')).toBe(true);
      expect(mpPerms.has('employee:hr_restricted')).toBe(true);
      expect(mpPerms.has('employee:payroll')).toBe(true);
      expect(mpPerms.has('employee:sensitive')).toBe(true);
      expect(mpPerms.has('finance:view')).toBe(true);
      expect(mpPerms.has('risk:view')).toBe(true);
      expect(mpPerms.has('matter:restricted:access')).toBe(true);
      expect(mpPerms.has('document_template:approve')).toBe(true);
      expect(mpPerms.has('rbac:manage_user_overrides')).toBe(false);

      // Partner holds finance:view, admin:access, document_template:view_usage, but NOT risk:view or matter:restricted:access
      const partnerPerms = resolveForRole('partner');
      expect(partnerPerms.has('finance:view')).toBe(true);
      expect(partnerPerms.has('admin:access')).toBe(true);
      expect(partnerPerms.has('document_template:view_usage')).toBe(true);
      expect(partnerPerms.has('document_template:approve')).toBe(false);
      expect(partnerPerms.has('risk:view')).toBe(false);
      expect(partnerPerms.has('matter:restricted:access')).toBe(false);
      expect(partnerPerms.has('employee:payroll')).toBe(false);

      // Risk & compliance holds risk:view, matter:restricted:access, template approve, but NOT finance:view
      const riskPerms = resolveForRole('risk_compliance');
      expect(riskPerms.has('risk:view')).toBe(true);
      expect(riskPerms.has('matter:restricted:access')).toBe(true);
      expect(riskPerms.has('document_template:approve')).toBe(true);
      expect(riskPerms.has('finance:view')).toBe(false);

      // Finance holds finance:view, finance:credit_control, employee:payroll (via role), but NOT risk:view
      const finPerms = resolveForRole('finance');
      expect(finPerms.has('finance:view')).toBe(true);
      expect(finPerms.has('finance:credit_control')).toBe(true);
      expect(finPerms.has('risk:view')).toBe(false);
      expect(finPerms.has('document:generate')).toBe(true);

      // Fee earner holds finance:view_matter, document:generate, document:view, but NOT finance:view
      const fePerms = resolveForRole('fee_earner');
      expect(fePerms.has('finance:view_matter')).toBe(true);
      expect(fePerms.has('finance:view')).toBe(false);
      expect(fePerms.has('document:generate')).toBe(true);
      expect(fePerms.has('document:delete')).toBe(false);

      // Enquiries coordinator holds enquiry:intake_view, document:view, document:generate, but NOT finance:view_matter or document:delete
      const ecPerms = resolveForRole('enquiries_coordinator');
      expect(ecPerms.has('enquiry:intake_view')).toBe(true);
      expect(ecPerms.has('document:view')).toBe(true);
      expect(ecPerms.has('document:generate')).toBe(true);
      expect(ecPerms.has('document:delete')).toBe(false);
      expect(ecPerms.has('finance:view_matter')).toBe(false);
    });

    it('applies tenant-configured departmentGrants (DEPT-HR, DEPT-FIN, DEPT-RISK) and relationshipGrants', () => {
      const config = makeBaseTenantConfig();
      const baseCtx = {
        tenantId: 'tenant-alpha',
        correlationId: 'corr-dept',
        actorId: 'u-dept',
        actorRoles: ['fee_earner'],
        mfaVerified: false,
      };

      // Fee earner in DEPT-HR receives HR + payroll + sensitive permissions from tenant config
      const hrUserPerms = resolvePermissions({
        context: { ...baseCtx, actorId: 'u-hr' },
        actor: {
          userId: 'u-hr',
          roles: ['fee_earner'],
          departmentId: 'DEPT-HR',
        },
        config,
      });
      expect(hrUserPerms.has('employee:edit_core')).toBe(true);
      expect(hrUserPerms.has('employee:hr_restricted')).toBe(true);
      expect(hrUserPerms.has('employee:payroll')).toBe(true);
      expect(hrUserPerms.has('employee:sensitive')).toBe(true);

      // Fee earner in DEPT-FIN receives employee:payroll from tenant config, while DEPT-RISK receives employee:sensitive
      const finDeptPerms = resolvePermissions({
        context: { ...baseCtx, actorId: 'u-fin-dept' },
        actor: {
          userId: 'u-fin-dept',
          roles: ['fee_earner'],
          departmentId: 'DEPT-FIN',
        },
        config,
      });
      expect(finDeptPerms.has('employee:payroll')).toBe(true);

      const riskDeptPerms = resolvePermissions({
        context: { ...baseCtx, actorId: 'u-risk-dept' },
        actor: {
          userId: 'u-risk-dept',
          roles: ['fee_earner'],
          departmentId: 'DEPT-RISK',
        },
        config,
      });
      expect(riskDeptPerms.has('employee:sensitive')).toBe(true);

      // Line manager receives employee:edit_core for their direct report via relationshipGrants
      const lineMgrPerms = resolvePermissions({
        context: { ...baseCtx, actorId: 'u-mgr' },
        actor: {
          userId: 'u-mgr',
          roles: ['fee_earner'],
        },
        relationships: {
          isLineManagerOfTarget: true,
        },
        config,
      });
      expect(lineMgrPerms.has('employee:edit_core')).toBe(true);
      expect(lineMgrPerms.has('employee:payroll')).toBe(false);
    });
  });

  describe('3. Schema Validation & Deprecation of documentGeneration.permissions.roleDefaults', () => {
    it('rejects unknown permission strings and unknown identityMapping role keys', () => {
      const badPermRaw = {
        ...(notALawFirmBaseConfig as Record<string, unknown>),
        rbac: {
          ...createDefaultRbacConfig(),
          departmentGrants: {
            'DEPT-HR': ['not_a_real_permission:hack'],
          },
        },
      };
      expect(() => loadAndValidateTenantConfig(badPermRaw)).toThrow();

      const badRoleRaw = {
        ...(notALawFirmBaseConfig as Record<string, unknown>),
        rbac: {
          ...createDefaultRbacConfig(),
          identityMapping: {
            authorityMode: 'hybrid',
            entraGroupToRoleKey: {
              'group-id-1': ['non_existent_role_key'],
            },
            entraAppRoleToRoleKey: {},
            requireMfaForAdminPermissions: true,
          },
        },
      };
      expect(() => loadAndValidateTenantConfig(badRoleRaw)).toThrow(
        /unknown role key/i,
      );
    });

    it('emits deprecation warning when documentGeneration.permissions.roleDefaults is present and prefers rbac.roles', () => {
      // Base config without deprecated roleDefaults emits 0 warnings
      const cleanWarnings = collectConfigDeprecationWarnings(
        notALawFirmBaseConfig as Record<string, unknown>,
      );
      expect(cleanWarnings.length).toBe(0);

      // When rbac.roles is present alongside deprecated roleDefaults, a warning is emitted and rbac.roles wins
      const rawWithBoth = {
        ...(notALawFirmBaseConfig as Record<string, unknown>),
        rbac: createDefaultRbacConfig(),
        documentGeneration: {
          ...(((notALawFirmBaseConfig as Record<string, unknown>)
            .documentGeneration as Record<string, unknown>) ?? {}),
          permissions: {
            roleDefaults: {
              'document:delete': ['intake'],
              'finance:view': ['intake'],
            },
          },
        },
      };
      const { config, deprecationWarnings } =
        validateTenantConfigWithWarnings(rawWithBoth);
      expect(deprecationWarnings.length).toBe(1);
      expect(deprecationWarnings[0]).toContain(
        'documentGeneration.permissions.roleDefaults',
      );
      expect(deprecationWarnings[0]).toContain('rbac.roles');

      const intakePerms = resolvePermissions({
        context: {
          tenantId: 'tenant-alpha',
          correlationId: 'corr-intake',
          actorId: 'u-intake',
          actorRoles: ['intake'],
          mfaVerified: false,
        },
        actor: { userId: 'u-intake', roles: ['intake'] },
        config,
      });
      expect(intakePerms.has('document:delete')).toBe(false);
      expect(intakePerms.has('finance:view')).toBe(false);
    });
  });

  describe('4. Unified Person.permissionOverrides & Legacy Override Migration (ADR-0015)', () => {
    it('enforces explicit revoke over role, department, relationship, and grant', () => {
      const config = makeBaseTenantConfig();
      const perms = resolvePermissions({
        context: {
          tenantId: 'tenant-alpha',
          correlationId: 'corr-revoke',
          actorId: 'u-partner-revoked',
          actorRoles: ['partner'],
          mfaVerified: false,
        },
        actor: {
          userId: 'u-partner-revoked',
          roles: ['partner'],
          departmentId: 'DEPT-HR',
          permissionOverrides: {
            grant: ['risk:view', 'finance:view'],
            revoke: ['finance:view', 'employee:payroll'],
          },
        },
        config,
      });

      expect(perms.has('risk:view')).toBe(true);
      // Explicitly revoked even though partner role grants finance:view and DEPT-HR grants employee:payroll
      expect(perms.has('finance:view')).toBe(false);
      expect(perms.has('employee:payroll')).toBe(false);
    });

    it('migrates legacy employeePermissions (replacement) and documentPermissions (additive) losslessly', () => {
      const person = makeTestPerson({
        id: 'P-LEGACY-01',
        roles: ['managing_partner'],
        // Legacy replacement: restrict managing partner to only view_core + hr_restricted (revoking edit_core, payroll, sensitive)
        employeePermissions: ['employee:view_core', 'employee:hr_restricted'],
        // Legacy additive: grant document_template:build to a fee earner
        documentPermissions: ['document:delete'],
      });

      const empPerms = resolveEmployeePermissions(person, [person], []);
      expect(empPerms).toEqual(['employee:view_core', 'employee:hr_restricted']);
      expect(empPerms).not.toContain('employee:payroll');

      const feeEarnerBaseSet = new Set<PermissionKey>(
        DEFAULT_RBAC_ROLES.fee_earner.permissions,
      );
      const migrated = migrateLegacyPersonOverrides({
        basePermissions: new Set<PermissionKey>([
          ...DEFAULT_RBAC_ROLES.managing_partner.permissions.filter(
            (p) => p !== 'document:delete',
          ),
        ]),
        legacyEmployeePermissions: person.employeePermissions,
        legacyDocumentPermissions: ['document:delete'],
      });
      expect(migrated.grant).toContain('document:delete');
      expect(migrated.revoke).toContain('employee:edit_core');
      expect(migrated.revoke).toContain('employee:payroll');
      expect(migrated.revoke).toContain('employee:sensitive');
      expect(feeEarnerBaseSet.has('document:delete')).toBe(false);
    });
  });

  describe('5. Security Gates: Self-Escalation, Unheld Grants, MFA & Self-Approval (V-01 .. V-09)', () => {
    it('blocks self-modification and granting unheld permissions in validateUserOverrideOrRoleMutation', () => {
      const config = makeBaseTenantConfig();
      const adminPerms = resolvePermissions({
        actor: { userId: 'P-ADMIN', roles: ['admin'] },
        context: {
          tenantId: 'tenant-alpha',
          correlationId: 'corr-1',
          actorId: 'P-ADMIN',
          actorRoles: ['admin'],
          mfaVerified: true,
        },
        config,
      });

      // 1. Self-modification is always forbidden, even for admin
      expect(() =>
        validateUserOverrideOrRoleMutation({
          actorPermissions: adminPerms,
          targetPersonId: 'P-ADMIN',
          addedPermissions: ['finance:view'],
          rbacConfig: config.rbac,
        }),
      ).toThrowError(AuthorisationError);

      // 2. Requires MFA verified
      const adminNoMfaPerms = resolvePermissions({
        actor: { userId: 'P-ADMIN', roles: ['admin'] },
        context: {
          tenantId: 'tenant-alpha',
          correlationId: 'corr-2',
          actorId: 'P-ADMIN',
          actorRoles: ['admin'],
          mfaVerified: false,
        },
        config,
      });
      expect(() =>
        validateUserOverrideOrRoleMutation({
          actorPermissions: adminNoMfaPerms,
          targetPersonId: 'P-OTHER',
          addedPermissions: ['finance:view'],
          rbacConfig: config.rbac,
        }),
      ).toThrow(/Multi-factor authentication/i);

      // 3. Cannot grant a permission the actor does not hold (even if actor holds rbac:manage_user_overrides)
      const delegatedAdminPerms = resolvePermissions({
        actor: {
          userId: 'P-DELEGATED-ADMIN',
          roles: ['fee_earner'],
          permissionOverrides: {
            grant: ['rbac:manage_user_overrides'],
            revoke: [],
          },
        },
        context: {
          tenantId: 'tenant-alpha',
          correlationId: 'corr-3',
          actorId: 'P-DELEGATED-ADMIN',
          actorRoles: ['fee_earner'],
          mfaVerified: true,
        },
        config,
      });
      expect(() =>
        validateUserOverrideOrRoleMutation({
          actorPermissions: delegatedAdminPerms,
          targetPersonId: 'P-OTHER',
          addedPermissions: ['employee:payroll'],
          rbacConfig: config.rbac,
        }),
      ).toThrow(/acting user does not hold it/i);
    });

    it('enforces mfaVerified on requirePermission for critical permissions', () => {
      const config = makeBaseTenantConfig();
      expect(() =>
        requirePermission(
          {
            actor: { userId: 'P-RISK', roles: ['risk_compliance'] },
            context: {
              tenantId: 'tenant-alpha',
              correlationId: 'corr-mfa',
              actorId: 'P-RISK',
              actorRoles: ['risk_compliance'],
              mfaVerified: false,
            },
            config,
          },
          'document_template:approve',
        ),
      ).toThrow(/Multi-factor authentication/i);
    });

    it('blocks template self-approval when actor is either the version creator or submitter (V-03)', async () => {
      const config = makeBaseTenantConfig();
      const repo = new TenantDocumentRepository();
      const ctx = resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: true as const,
          sub: 'P-CREATOR',
          tenantId: 'tenant-alpha',
          email: 'creator@notalawfirm.example',
          name: 'Creator Partner',
          roles: ['managing_partner'],
          mfaVerified: true,
        },
        hostingMode: 'multi_tenant',
        environment: 'dev',
        correlationId: 'corr-doc',
      });

      repo.putTemplate(ctx, {
        id: 'TPL-1',
        tenantId: 'tenant-alpha',
        code: 'TEST_LETTER',
        name: 'Test Letter',
        description: 'Test',
        category: 'General',
        tags: [],
        outputDocumentType: 'letter',
        filenamePattern: '{{matter.reference}}',
        availabilityRules: {
          sourceContexts: ['matter'],
        },
        activeVersionId: null,
        status: 'Submitted',
        createdByUserId: 'P-CREATOR',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      });

      // Created by P-CREATOR, submitted by P-SUBMITTER
      repo.putTemplateVersion(ctx, {
        id: 'VER-1',
        tenantId: 'tenant-alpha',
        templateId: 'TPL-1',
        versionNumber: 1,
        engine: 'basic-merge',
        status: 'Submitted',
        storageProvider: 'local-fs',
        blobKey: 'templates/ver-1.docx',
        fileName: 'ver-1.docx',
        fileSha256: 'abc',
        fileSizeBytes: 100,
        scanStatus: 'clean',
        extractedPlaceholders: [],
        fieldMappings: {},
        promptedFields: [],
        createdByUserId: 'P-CREATOR',
        createdAt: '2026-01-01T00:00:00Z',
        submittedByUserId: 'P-SUBMITTER',
        submittedAt: '2026-01-01T01:00:00Z',
      });

      // P-CREATOR attempts to approve a version they created (even though submitted by someone else)
      expect(() =>
        approveTemplateVersion({
          ctx,
          repo,
          actor: {
            id: 'P-CREATOR',
            tenantId: ctx.tenantId,
            roles: ['managing_partner'],
            mfaVerified: true,
          },
          config,
          versionId: 'VER-1',
        }),
      ).toThrow(/TEMPLATE_SELF_APPROVAL_FORBIDDEN/);
    });
  });

  describe('6. "Viewing As" Isolation & Elimination of Label / jobTitle Escalation (ADR-0012, ADR-0013)', () => {
    it('never grants left-rail visibility to finance, risk, or admin when activeRole is not held in userRoles', () => {
      const tamperedRail = getLeftRailVisibility('admin', ['fee_earner']);
      expect(tamperedRail.finance).toBe(false);
      expect(tamperedRail.risk).toBe(false);
      expect(tamperedRail.admin).toBe(false);
    });

    it('never derives privileged roles from free-text jobTitle or mutable ChoiceValue labels', () => {
      const sneakyPerson = makeTestPerson({
        id: 'P-SNEAKY',
        roles: [],
        employeeRoleId: 'employee_role.fee_earner',
        jobTitle: 'Managing Partner, System Administrator, MLRO & Head of Finance',
      });

      // Authoritative fallback uses immutable employeeRoleId ('employee_role.fee_earner' -> ['fee_earner'])
      expect(resolveEmployeeRoles(sneakyPerson, [])).toEqual(['fee_earner']);

      // Even if a tenant renames 'employee_role.fee_earner' display label to 'System Administrator & Partner'
      const mutatedValues: ChoiceValue[] = [
        {
          id: 'employee_role.fee_earner',
          listKey: 'employee_role',
          label: 'System Administrator & Managing Partner',
          active: true,
          sortOrder: 1,
        },
      ];
      expect(resolveUserAppRole(sneakyPerson, [], mutatedValues)).toBe('fee_earner');

      const dummyTask: Task = {
        id: 'TSK-1',
        reference: 'TSK-1',
        title: 'Confidential task',
        description: '',
        taskTypeId: 'task_type.general',
        priorityId: 'task_priority.normal',
        dueAt: '2026-12-01',
        assignedTeamId: 'TEAM-OTHER',
        assignedPersonId: 'P-OTHER',
        status: 'To do',
        linkedRecords: [],
        createdById: 'P-OTHER',
        createdAt: '2026-01-01T00:00:00Z',
        updatedById: 'P-OTHER',
        updatedAt: '2026-01-01T00:00:00Z',
        completedById: null,
        completedAt: null,
        comments: [],
      };
      const otherTeam: Team = {
        id: 'TEAM-OTHER',
        name: 'Other Team',
        description: '',
        leadIds: ['P-OTHER'],
        memberIds: ['P-OTHER'],
        practiceAreaIds: [],
        active: true,
        createdById: 'P-OTHER',
        createdAt: '2026-01-01T00:00:00Z',
        updatedById: 'P-OTHER',
        updatedAt: '2026-01-01T00:00:00Z',
      };
      expect(
        canUserReassignTask('P-SNEAKY', dummyTask, [otherTeam], [sneakyPerson], mutatedValues),
      ).toBe(false);
      expect(
        canUserTakeTask(
          'P-SNEAKY',
          { ...dummyTask, assignedPersonId: null },
          [otherTeam],
          [sneakyPerson],
          mutatedValues,
        ),
      ).toBe(false);
    });
  });

  describe('7. Dynamic Staff-Matter & Linked-Document Access (ADR-0014)', () => {
    it('stores only named matter participants in restrictedAccessUserIds and evaluates role holders dynamically', () => {
      const staffClient = makeTestPerson({
        id: 'P-STAFF-CLIENT',
        roles: ['fee_earner'],
      });
      const respPartner = makeTestPerson({
        id: 'P-RESP-PARTNER',
        roles: ['partner'],
      });
      const riskOfficer = makeTestPerson({
        id: 'P-RISK-OFFICER',
        roles: ['risk_compliance'],
      });
      const uninvolvedPartner = makeTestPerson({
        id: 'P-OTHER-PARTNER',
        roles: ['partner'],
      });

      const matter = {
        id: 'M-STAFF-01',
        recordType: 'matter',
        matterNumber: 'STF001-0001',
        title: 'Staff conveyance',
        shortDescription: '',
        clientId: 'P-STAFF-CLIENT',
        additionalClientIds: [],
        matterStatusId: 'matter_status.active',
        departmentId: 'DEPT-PROP',
        workTypeCategoryId: 'wt.prop',
        workTypeSubcategoryId: 'wts.prop',
        responsiblePartnerId: 'P-RESP-PARTNER',
        supervisingPartnerId: null,
        leadFeeEarnerId: null,
        teamMemberIds: [],
        referredById: null,
        referralNotes: '',
        openedAt: '2026-01-01',
        targetCompletionDate: null,
        closedAt: null,
        archiveReference: '',
        destroyAfterDate: null,
        feeBasisId: null,
        feeEstimateGbp: null,
        agreedFeeCapGbp: null,
        billingAddressSameAsClient: true,
        billingAddress: null,
        purchaseOrderNumber: '',
        billingNotes: '',
        conflictCheckStatusId: null,
        conflictCheckedById: null,
        conflictCheckedAt: null,
        conflictNotes: '',
        amlRiskRatingId: null,
        amlCompletedAt: null,
        sourceOfFundsVerified: 'Pending',
        sourceOfFundsNotes: '',
        engagementLetterSentAt: null,
        engagementLetterSignedAt: null,
        keyDates: [],
        parties: [],
        fieldValues: {},
        createdById: 'P-RESP-PARTNER',
        createdAt: '2026-01-01T00:00:00Z',
        updatedById: 'P-RESP-PARTNER',
        updatedAt: '2026-01-01T00:00:00Z',
      } as unknown as Matter;

      const allPeople = [staffClient, respPartner, riskOfficer, uninvolvedPartner];
      const status = computeStaffMatterStatus(matter, allPeople);
      expect(status.isStaffMatter).toBe(true);
      // Only the named responsible partner is stored in restrictedAccessUserIds — NOT the risk officer
      expect(status.restrictedAccessUserIds).toEqual(['P-RESP-PARTNER']);

      const restrictedMatter: Matter = {
        ...matter,
        isStaffMatter: status.isStaffMatter,
        restrictedAccessUserIds: status.restrictedAccessUserIds,
      };

      // Named participant (responsible partner) has access
      expect(
        canUserAccessMatter(restrictedMatter, respPartner.id, respPartner),
      ).toBe(true);
      // Uninvolved partner does NOT have access
      expect(
        canUserAccessMatter(
          restrictedMatter,
          uninvolvedPartner.id,
          uninvolvedPartner,
        ),
      ).toBe(false);
      // Risk officer dynamically has access via matter:restricted:access
      expect(
        canUserAccessMatter(restrictedMatter, riskOfficer.id, riskOfficer),
      ).toBe(true);

      // When riskOfficer leaves the risk_compliance role, access is immediately lost without mutating the matter
      const formerRiskOfficer = { ...riskOfficer, roles: ['fee_earner'] };
      expect(
        canUserAccessMatter(
          restrictedMatter,
          formerRiskOfficer.id,
          formerRiskOfficer,
        ),
      ).toBe(false);

      // Generated document linked to the restricted staff matter is hidden on both Matter and Client screens
      const config = makeBaseTenantConfig();
      const doc = {
        id: 'DOC-STAFF-1',
        tenantId: 'tenant-alpha',
        templateId: 'TPL-1',
        templateVersionId: 'VER-1',
        templateVersionNumber: 1,
        title: 'Staff Engagement Letter',
        documentType: 'client_care_letter',
        outputFormat: 'docx' as const,
        storageKey: 'docs/staff-1.docx',
        fileName: 'staff-1.docx',
        contentSha256: '123',
        sizeBytes: 100,
        generatedByUserId: 'P-RESP-PARTNER',
        generatedAt: '2026-01-01T00:00:00Z',
        mergeValueSnapshot: {},
        missingFields: [],
        links: [
          {
            id: 'LNK-1',
            tenantId: 'tenant-alpha',
            documentId: 'DOC-STAFF-1',
            recordType: 'matter' as const,
            recordId: 'M-STAFF-01',
            linkedAt: '2026-01-01T00:00:00Z',
            linkedByUserId: 'P-RESP-PARTNER',
          },
          {
            id: 'LNK-2',
            tenantId: 'tenant-alpha',
            documentId: 'DOC-STAFF-1',
            recordType: 'person' as const,
            recordId: 'P-STAFF-CLIENT',
            linkedAt: '2026-01-01T00:00:00Z',
            linkedByUserId: 'P-RESP-PARTNER',
          },
        ],
        deletedAt: null,
        deletedByUserId: null,
        deleteReason: null,
        isDeleted: false,
      };

      const matterSubject = {
        id: restrictedMatter.id,
        isStaffMatter: true,
        restrictedAccessUserIds: restrictedMatter.restrictedAccessUserIds,
        responsiblePartnerId: restrictedMatter.responsiblePartnerId,
      };

      expect(
        canActorAccessGeneratedDocument(
          { id: 'P-OTHER-PARTNER', tenantId: config.tenantId, roles: ['partner'] },
          doc,
          [matterSubject],
          config,
        ),
      ).toBe(false);

      expect(
        canActorAccessGeneratedDocument(
          { id: 'P-RISK-OFFICER', tenantId: config.tenantId, roles: ['risk_compliance'] },
          doc,
          [matterSubject],
          config,
        ),
      ).toBe(true);
    });
  });

  describe('8. Two-Tenant RBAC Isolation (Platform Standard Rule 9)', () => {
    it('isolates custom roles, department grants, and request cache strictly by tenantId', () => {
      const tenantAConfig = loadAndValidateTenantConfig({
        ...(notALawFirmBaseConfig as Record<string, unknown>),
        tenantId: 'tenant-a',
        rbac: {
          ...createDefaultRbacConfig(),
          roles: {
            ...createDefaultRbacConfig().roles,
            costs_lawyer: {
              key: 'costs_lawyer',
              label: 'Costs Lawyer',
              isBuiltIn: false,
              permissions: ['finance:view', 'document:generate'],
            },
          },
          departmentGrants: {
            'DEPT-SHARED-CODE': ['employee:payroll'],
          },
        },
      });

      const tenantBConfig = loadAndValidateTenantConfig({
        ...(notALawFirmBaseConfig as Record<string, unknown>),
        tenantId: 'tenant-b',
        rbac: {
          ...createDefaultRbacConfig(),
          departmentGrants: {},
        },
      });

      const sameActor = {
        userId: 'U-SHARED-ID',
        roles: ['costs_lawyer', 'fee_earner'],
        departmentId: 'DEPT-SHARED-CODE',
      };

      const permsTenantA = resolvePermissions({
        context: {
          tenantId: 'tenant-a',
          correlationId: 'req-same',
          actorId: 'U-SHARED-ID',
          actorRoles: ['costs_lawyer', 'fee_earner'],
          mfaVerified: false,
        },
        actor: sameActor,
        config: tenantAConfig,
      });

      const permsTenantB = resolvePermissions({
        context: {
          tenantId: 'tenant-b',
          correlationId: 'req-same',
          actorId: 'U-SHARED-ID',
          actorRoles: ['costs_lawyer', 'fee_earner'],
          mfaVerified: false,
        },
        actor: sameActor,
        config: tenantBConfig,
      });

      expect(permsTenantA.has('finance:view')).toBe(true);
      expect(permsTenantA.has('employee:payroll')).toBe(true);

      // Tenant B does not define 'costs_lawyer' or 'DEPT-SHARED-CODE' grants and never reads Tenant A's cache
      expect(permsTenantB.has('finance:view')).toBe(false);
      expect(permsTenantB.has('employee:payroll')).toBe(false);
    });
  });

  describe('9. 1Squared Microsoft Entra ID OIDC Claim Normalization & Identity Mapping (ADR-0012)', () => {
    it('evaluates Entra MFA from amr / acrs claims and maps 1Squared.* App Roles + Group GUIDs', () => {
      const config = makeBaseTenantConfig();

      expect(isEntraMfaVerified({ amr: ['pwd', 'mfa'] })).toBe(true);
      expect(isEntraMfaVerified({ amr: ['ngcmfa'] })).toBe(true);
      expect(isEntraMfaVerified({ amr: ['fido'] })).toBe(true);
      expect(isEntraMfaVerified({ amr: ['pwd'] })).toBe(false);

      const verifiedToken = mapEntraTokenClaimsToVerifiedOidcToken({
        claims: {
          sub: 'entra-sub-1',
          oid: '8f2e91c0-4a12-4b9e-9c01-111111111111',
          tid: '00000000-0000-4000-8000-000000000099',
          preferred_username: 'Patrick.Partner@notalawfirm.example',
          name: 'Patrick Partner',
          roles: ['1Squared.Partner'],
          groups: ['00000000-0000-0000-0000-000000000104'], // Mapped to risk_compliance in base.json
          amr: ['pwd', 'mfa'],
        },
        tenantId: 'not-a-law-firm',
        rbacConfig: config.rbac,
      });

      expect(verifiedToken.__verifiedByOidcMiddleware).toBe(true);
      expect(verifiedToken.entraObjectId).toBe(
        '8f2e91c0-4a12-4b9e-9c01-111111111111',
      );
      expect(verifiedToken.entraTenantId).toBe(
        '00000000-0000-4000-8000-000000000099',
      );
      expect(verifiedToken.email).toBe('patrick.partner@notalawfirm.example');
      expect(verifiedToken.mfaVerified).toBe(true);
      expect(verifiedToken.roles).toContain('partner');
      expect(verifiedToken.roles).toContain('fee_earner');
      expect(verifiedToken.roles).toContain('risk_compliance');
    });

    it('matches Person by entraObjectId first, falls back to work email, and respects authorityMode', () => {
      const config = makeBaseTenantConfig();
      const dafydd = makeTestPerson({
        id: 'P-000002',
        firstName: 'Dafydd',
        surname: 'Evans',
        entraObjectId: 'oid-dafydd-guid',
        emails: [
          {
            id: 'em-dafydd',
            typeId: null,
            address: 'dafydd.evans@notalawfirm.example',
            isPrimary: true,
          },
        ],
        roles: ['fee_earner'],
      });

      // Match by entraObjectId even if UPN changed in Entra, and elevate via Entra App Role 1Squared.Partner
      const matched = resolvePersonForEntraClaims({
        claims: {
          oid: 'oid-dafydd-guid',
          preferred_username: 'd.evans.renamed@notalawfirm.example',
          roles: ['1Squared.Partner'],
          amr: ['pwd', 'mfa'],
        },
        people: [dafydd],
        rbacConfig: config.rbac,
      });

      expect(matched.person?.id).toBe('P-000002');
      expect(matched.permissions.has('finance:view')).toBe(true);
      expect(matched.permissions.mfaVerified).toBe(true);
    });
  });

  describe('10. Server Services: Audited Per-Person Overrides & Tenant RBAC Config Updates', () => {
    it('enforces self-modification & unheld-grant blocks and logs before/after audit entries', () => {
      resetAllDemoData('P-000001');
      const snap0 = getAppSnapshot('P-000001');
      const adamAdmin = snap0.people.find((p) => p.roles?.includes('admin'))!;
      expect(adamAdmin).toBeDefined();

      // 1. Self-modification is blocked on the server service
      const selfAttempt = updatePersonPermissionOverrides(
        adamAdmin.id,
        {
          grant: ['finance:view'],
          revoke: [],
          reason: 'Trying to modify myself',
        },
        adamAdmin.id,
        { mfaVerified: true },
      );
      expect(selfAttempt.ok).toBe(false);
      expect(selfAttempt.error).toMatch(/cannot modify their own/i);

      // 1b. Admin without MFA is rejected with MFA_REQUIRED (R53)
      const noMfaAttempt = updatePersonPermissionOverrides(
        'P-000002',
        {
          grant: ['risk:view'],
          revoke: [],
          reason: 'Missing MFA test',
        },
        adamAdmin.id,
      );
      expect(noMfaAttempt.ok).toBe(false);
      expect(noMfaAttempt.code).toBe('MFA_REQUIRED');

      // 2. Admin grants risk:view and revokes finance:view_matter on Dafydd Evans (P-000002) with Entra Object ID binding
      const validOverride = updatePersonPermissionOverrides(
        'P-000002',
        {
          grant: ['risk:view'],
          revoke: ['finance:view_matter'],
          reason: 'Temporary secondment to Compliance review',
          entraObjectId: '8f2e91c0-4a12-4b9e-9c01-dafydd000002',
        },
        adamAdmin.id,
        { mfaVerified: true },
      );
      expect(validOverride.ok).toBe(true);

      const dafyddSnap = getAppSnapshot('P-000002');
      expect(dafyddSnap.currentUserPermissions).toContain('risk:view');
      expect(dafyddSnap.currentUserPermissions).not.toContain(
        'finance:view_matter',
      );
      expect(dafyddSnap.currentUser.entraObjectId).toBe(
        '8f2e91c0-4a12-4b9e-9c01-dafydd000002',
      );

      // Audit entry recorded with before/after JSON
      const auditEntry = dafyddSnap.audit.find(
        (a) =>
          a.recordId === 'P-000002' &&
          a.field === 'Permission overrides & Entra ID binding',
      );
      expect(auditEntry).toBeDefined();
      expect(auditEntry?.newValue).toContain('Temporary secondment');

      // 3. Updating Tenant RBAC Config by non-admin is rejected; by admin without MFA is rejected; by admin with MFA succeeds and audits
      const unauthConfigAttempt = updateTenantRbacConfig(
        {
          departmentGrants: {
            'DEPT-HR': ['employee:view_core'],
          },
        },
        'P-000002',
        { mfaVerified: true },
      );
      expect(unauthConfigAttempt.ok).toBe(false);
      expect(unauthConfigAttempt.error).toContain('rbac:manage_config');

      const noMfaConfigAttempt = updateTenantRbacConfig(
        {
          departmentGrants: {
            'DEPT-HR': ['employee:view_core'],
          },
        },
        adamAdmin.id,
        { mfaVerified: false },
      );
      expect(noMfaConfigAttempt.ok).toBe(false);
      expect(noMfaConfigAttempt.code).toBe('MFA_REQUIRED');

      const adminConfigUpdate = updateTenantRbacConfig(
        {
          identityMapping: {
            ...dafyddSnap.rbacConfig.identityMapping,
            entraGroupToRoleKey: {
              ...dafyddSnap.rbacConfig.identityMapping.entraGroupToRoleKey,
              '11111111-2222-3333-4444-555555555555': ['partner'],
            },
          },
        },
        adamAdmin.id,
        { mfaVerified: true },
      );
      expect(adminConfigUpdate.ok).toBe(true);
      expect(
        adminConfigUpdate.rbacConfig?.identityMapping.entraGroupToRoleKey[
          '11111111-2222-3333-4444-555555555555'
        ],
      ).toEqual(['partner']);
    });

    it('enforces R52, R53, R54, R55, R60, R61, R62, R63, R70 and R71 security invariants', async () => {
      resetAllDemoData('P-000001');

      // R52: resolveOrProvisionEntraEmployee with roles: [] creates a person without admin and without admin:access
      const unmappedProvision = resolveOrProvisionEntraEmployee({
        oid: '00000000-0000-4000-8000-000000000502',
        tid: '00000000-0000-4000-8000-000000000099',
        sub: 'sub-unmapped-502',
        name: 'New Unmapped Starter',
        preferred_username: 'new.starter@notalawfirm.example',
        email: 'new.starter@notalawfirm.example',
        roles: [],
        amr: ['pwd', 'mfa'],
      });
      expect(unmappedProvision.person.roles).toEqual([]);
      expect(unmappedProvision.person.roles).not.toContain('admin');
      expect(unmappedProvision.person.departmentId).toBeNull();
      const unmappedSnap = getAppSnapshot(unmappedProvision.person.id);
      expect(unmappedSnap.currentUserPermissions).not.toContain('admin:access');

      // R53: updateTenantRbacConfigAction with mfaVerified: false returns MFA_REQUIRED
      setTestEntraSessionOverride({
        personId: 'P-000004',
        tenantId: 'not-a-law-firm',
        oid: '00000000-0000-4000-8000-000000000004',
        tid: '00000000-0000-4000-8000-000000000099',
        sub: 'P-000004',
        email: 'sian.morgan@notalawfirm.example',
        displayName: 'Sian Morgan',
        entraRoles: ['1Squared.Admin'],
        mappedRoles: ['admin'],
        entraGroups: [],
        mfaVerified: false,
        amr: ['pwd'],
        authenticatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      const actionRes = await updateTenantRbacConfigAction({});
      expect(actionRes.ok).toBe(false);
      expect(actionRes.code).toBe('MFA_REQUIRED');
      expect(actionRes.error).toContain('MFA_REQUIRED');
      setTestEntraSessionOverride(undefined);

      // R54: A fee earner giving themselves roles: ['admin'] gets ok: false; admin without MFA is rejected
      const feeEarnerSelfEscalation = updateEmployeeRolesAndSupports(
        'P-000002',
        { roles: ['admin'] },
        'P-000002',
        { mfaVerified: true },
      );
      expect(feeEarnerSelfEscalation.ok).toBe(false);
      const adminNoMfaRoleChange = updateEmployeeRolesAndSupports(
        'P-000002',
        { roles: ['partner', 'fee_earner'] },
        'P-000004',
        { mfaVerified: false },
      );
      expect(adminNoMfaRoleChange.ok).toBe(false);
      expect(adminNoMfaRoleChange.code).toBe('MFA_REQUIRED');
      const feeEarnerAppRoleEscalation = updateEmployeeRoleSetting(
        'P-000002',
        'admin',
        'P-000002',
        { mfaVerified: true },
      );
      expect(feeEarnerAppRoleEscalation.ok).toBe(false);

      // R55: resolveCurrentTenantContext() with no argument throws TENANCY_AUTH_ERROR
      expect(() => resolveCurrentTenantContext()).toThrow(/TENANCY_AUTH_ERROR/);

      // R60: An override for tenant A doesn't change getDefaultTenantRbacConfig('tenant-b')
      const baseTenantCfg = getActiveTenantRawBaseConfig();
      try {
        setActiveTenantConfigForTesting({ ...baseTenantCfg, tenantId: 'tenant-a' });
        setRuntimeRbacConfigOverride(
          {
            ...getDefaultTenantRbacConfig('tenant-a'),
            departmentGrants: { 'DEPT-CUSTOM-A': ['finance:view'] },
          },
          'tenant-a',
        );
        expect(
          getDefaultTenantRbacConfig('tenant-a').departmentGrants['DEPT-CUSTOM-A'],
        ).toEqual(['finance:view']);

        setActiveTenantConfigForTesting({ ...baseTenantCfg, tenantId: 'tenant-b' });
        expect(
          getDefaultTenantRbacConfig('tenant-b').departmentGrants['DEPT-CUSTOM-A'],
        ).toBeUndefined();

        setActiveTenantConfigForTesting({ ...baseTenantCfg, tenantId: 'tenant-a' });
        setRuntimeRbacConfigOverride(null, 'tenant-a');
      } finally {
        setActiveTenantConfigForTesting(null);
      }

      // R61: Under token_only, a person who signs in with 1Squared.Admin and then again with no roles loses admin
      updateTenantRbacConfig(
        {
          identityMapping: {
            ...getDefaultTenantRbacConfig().identityMapping,
            authorityMode: 'token_only',
          },
        },
        'P-000004',
        { mfaVerified: true },
      );
      const firstTokenSignIn = resolveOrProvisionEntraEmployee({
        oid: '00000000-0000-4000-8000-000000000601',
        tid: '00000000-0000-4000-8000-000000000099',
        sub: 'sub-601',
        name: 'Token Only User',
        email: 'token.only@notalawfirm.example',
        roles: ['1Squared.Admin'],
        amr: ['pwd', 'mfa'],
      });
      expect(firstTokenSignIn.person.roles).toContain('admin');
      const secondTokenSignIn = resolveOrProvisionEntraEmployee({
        oid: '00000000-0000-4000-8000-000000000601',
        tid: '00000000-0000-4000-8000-000000000099',
        sub: 'sub-601',
        name: 'Token Only User',
        email: 'token.only@notalawfirm.example',
        roles: [],
        amr: ['pwd', 'mfa'],
      });
      expect(secondTokenSignIn.person.roles).toEqual([]);
      expect(secondTokenSignIn.person.roles).not.toContain('admin');
      const tokenOnlySnap = getAppSnapshot(secondTokenSignIn.person.id);
      expect(tokenOnlySnap.currentUserPermissions).not.toContain('admin:access');

      // R61 (hybrid mode): Under hybrid authorityMode, token-derived roles apply for the current session
      // without mutating the stored person.roles on the employee record.
      updateTenantRbacConfig(
        {
          identityMapping: {
            ...getDefaultTenantRbacConfig().identityMapping,
            authorityMode: 'hybrid',
          },
        },
        'P-000004',
        { mfaVerified: true },
      );
      runWithActiveActorSession(
        {
          tenantId: 'not-a-law-firm',
          personId: 'P-000002',
          tokenRoles: [],
          expiresAtMs: Date.now() + 3600_000,
        },
        () => {
          const hybridSignIn = resolveOrProvisionEntraEmployee({
            oid: '00000000-0000-4000-8000-000000000002',
            tid: '00000000-0000-4000-8000-000000000099',
            sub: 'sub-002',
            name: 'Dafydd Evans',
            email: 'dafydd.evans@notalawfirm.example',
            roles: ['1Squared.RiskCompliance'],
            amr: ['pwd', 'mfa'],
          });
          expect(hybridSignIn.person.id).toBe('P-000002');
          // Stored employee roles remain ['fee_earner'] and do not permanently gain 'risk_compliance'
          expect(hybridSignIn.person.roles).toEqual(['fee_earner']);
          // Yet the active session permission set includes risk_compliance permissions (e.g. 'risk:view')
          const hybridSnap = runWithActiveActorSession(
            {
              tenantId: 'not-a-law-firm',
              personId: 'P-000002',
              tokenRoles: hybridSignIn.verifiedToken.roles,
              expiresAtMs: Date.now() + 3600_000,
            },
            () => getAppSnapshot('P-000002'),
          );
          expect(hybridSnap.currentUserPermissions).toContain('risk:view');
          // When the subsequent session has no token roles, the user falls back to stored ['fee_earner'] roles only
          const subsequentSignIn = resolveOrProvisionEntraEmployee({
            oid: '00000000-0000-4000-8000-000000000002',
            tid: '00000000-0000-4000-8000-000000000099',
            sub: 'sub-002',
            name: 'Dafydd Evans',
            email: 'dafydd.evans@notalawfirm.example',
            roles: [],
            amr: ['pwd', 'mfa'],
          });
          const hybridAfterSnap = runWithActiveActorSession(
            {
              tenantId: 'not-a-law-firm',
              personId: 'P-000002',
              tokenRoles: subsequentSignIn.verifiedToken.roles,
              expiresAtMs: Date.now() + 3600_000,
            },
            () => getAppSnapshot('P-000002'),
          );
          expect(hybridAfterSnap.currentUserPermissions).not.toContain(
            'risk:view',
          );
        },
      );

      // R63: getAppSnapshot(riskUser).employeeSensitiveRecords is empty; per-person read writes a view-sensitive audit entry
      const riskSnap = getAppSnapshot('P-000003');
      expect(riskSnap.employeeSensitiveRecords).toEqual({});
      logEmployeeRestrictedAccess('P-000002', 'sensitive', 'P-000004', 'Viewed sensitive HR tab');
      const afterSensitiveAuditSnap = getAppSnapshot('P-000004');
      expect(
        afterSensitiveAuditSnap.audit.some(
          (a) => a.recordId === 'P-000002' && a.action === 'view-sensitive',
        ),
      ).toBe(true);

      // R70: isEntraMfaVerified({ mfaVerified: true, amr: ['pwd'] }) returns false
      expect(isEntraMfaVerified({ mfaVerified: true, amr: ['pwd'] })).toBe(false);

      // R71: A matter with isStaffMatter: false and restrictedAccessUserIds: ['P-X'] is denied to P-Y
      const restrictedNonStaffMatter = {
        id: 'MAT-R71',
        isStaffMatter: false,
        hasEthicalWall: false,
        restrictedAccessUserIds: ['P-000001'],
      } as unknown as Matter;
      const personY = riskSnap.people.find((p) => p.id === 'P-000002')!;
      expect(
        canPersonAccessMatter(restrictedNonStaffMatter, personY.id, personY, {
          allPeople: riskSnap.people,
          teams: riskSnap.teams,
        }),
      ).toBe(false);

      // R75: A fee earner calling saveHomePagesConfigAction({ firmSettings: { demoMode: true } }) is rejected and demoMode remains off;
      // and a fee earner calling switchUserAction('P-000051') in demo mode is refused.
      setTestEntraSessionOverride({
        personId: 'P-000002',
        tenantId: 'not-a-law-firm',
        oid: '00000000-0000-4000-8000-000000000002',
        tid: '00000000-0000-4000-8000-000000000099',
        sub: '00000000-0000-4000-8000-000000000002',
        email: 'dafydd.evans@notalawfirm.example',
        displayName: 'Dafydd Evans',
        entraRoles: [],
        mappedRoles: ['fee_earner'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      const feeEarnerSaveHomeRes = await saveHomePagesConfigAction({
        firmSettings: { demoMode: true },
      });
      expect(feeEarnerSaveHomeRes.ok).toBe(false);
      expect(feeEarnerSaveHomeRes.code).toBe('FORBIDDEN');
      expect(getAppSnapshot('P-000002').homePagesConfig.firmSettings.demoMode).toBe(
        false,
      );
      const feeEarnerResetHomeRes = await resetHomePagesConfigAction();
      expect(feeEarnerResetHomeRes.ok).toBe(false);
      const feeEarnerAddRoleRes = await addHomeRoleAction({
        label: 'Unauthorized Role',
        purpose: 'Should fail',
      });
      expect(feeEarnerAddRoleRes.ok).toBe(false);

      // Reject enableDemoMode: true in live environment
      const rawBase = getActiveTenantRawBaseConfig();
      expect(() =>
        loadAndValidateTenantConfig(
          {
            ...rawBase,
            environment: 'live',
            featureFlags: {
              ...(rawBase.featureFlags as Record<string, unknown>),
              enableDemoMode: true,
            },
          },
          {},
          'live',
        ),
      ).toThrow(/enableDemoMode cannot be true when environment is/);

      // Even when demo mode is enabled in non-live tenant config, a fee earner switching to admin ('P-000051') is refused
      setActiveTenantConfigForTesting(
        {
          ...rawBase,
          featureFlags: {
            ...(rawBase.featureFlags as Record<string, unknown>),
            enableDemoMode: true,
          },
        },
        {},
      );
      try {
        await expect(switchUserAction('P-000051')).rejects.toThrow(
          /Cannot switch in Demo Mode to a persona holding permission/,
        );
      } finally {
        setActiveTenantConfigForTesting(null, undefined);
        setTestEntraSessionOverride(undefined);
      }

      resetAllDemoData('P-000001');
    });

    it('enforces R100 request/tenant-scoped token roles without cross-tenant, post-logout, or cross-user leakage', async () => {
      resetAllDemoData('P-000001');

      updateTenantRbacConfig(
        {
          identityMapping: {
            ...getDefaultTenantRbacConfig().identityMapping,
            authorityMode: 'hybrid',
          },
        },
        'P-000004',
        { mfaVerified: true },
      );

      // 1. Two-tenant isolation: P-000002 with ['admin'] token roles in tenant-a does NOT get admin permissions in tenant-b
      const baseTenantCfg = getActiveTenantRawBaseConfig();
      try {
        setActiveTenantConfigForTesting({ ...baseTenantCfg, tenantId: 'tenant-b' });
        const tenantBHybridRbac = {
          ...getDefaultTenantRbacConfig('tenant-b'),
          identityMapping: {
            ...getDefaultTenantRbacConfig('tenant-b').identityMapping,
            authorityMode: 'hybrid' as const,
          },
        };
        setRuntimeRbacConfigOverride(tenantBHybridRbac, 'tenant-b');
        setActiveTenantConfigForTesting({ ...baseTenantCfg, tenantId: 'tenant-a' });
        setRuntimeRbacConfigOverride(
          {
            ...getDefaultTenantRbacConfig('tenant-a'),
            identityMapping: {
              ...getDefaultTenantRbacConfig('tenant-a').identityMapping,
              authorityMode: 'hybrid' as const,
            },
          },
          'tenant-a',
        );
      } finally {
        setActiveTenantConfigForTesting(null);
      }

      const dafydd = getAppSnapshot('P-000002').people.find((p) => p.id === 'P-000002')!;
      const carys = getAppSnapshot('P-000001').people.find((p) => p.id === 'P-000001')!;
      expect(dafydd.roles).toEqual(['fee_earner']);

      // 1a. Outside runWithActiveActorSession, resolvePersonPermissions(person) returns stored roles only
      expect(resolvePersonPermissions(dafydd)).not.toContain('admin:access');
      expect(resolvePersonPermissions(dafydd)).not.toContain('risk:view');

      // 1b. Inside runWithActiveActorSession for tenant-a, token roles apply to tenant-a and never leak to tenant-b
      try {
        setActiveTenantConfigForTesting({ ...baseTenantCfg, tenantId: 'tenant-a' });
        const permsInTenantA = runWithActiveActorSession(
          {
            tenantId: 'tenant-a',
            personId: 'P-000002',
            tokenRoles: ['admin'],
            expiresAtMs: Date.now() + 3600_000,
          },
          () =>
            resolvePersonPermissions(dafydd, {
              context: {
                tenantId: 'tenant-a',
                correlationId: 'r100-tenant-a',
                actorId: 'P-000002',
                actorRoles: ['fee_earner'],
                mfaVerified: true,
              },
            }),
        );
        expect(permsInTenantA).toContain('admin:access');

        setActiveTenantConfigForTesting({ ...baseTenantCfg, tenantId: 'tenant-b' });
        const permsInTenantB = runWithActiveActorSession(
          {
            tenantId: 'tenant-a',
            personId: 'P-000002',
            tokenRoles: ['admin'],
            expiresAtMs: Date.now() + 3600_000,
          },
          () =>
            resolvePersonPermissions(dafydd, {
              context: {
                tenantId: 'tenant-b',
                correlationId: 'r100-tenant-b',
                actorId: 'P-000002',
                actorRoles: ['fee_earner'],
                mfaVerified: true,
              },
            }),
        );
        expect(permsInTenantB).not.toContain('admin:access');
      } finally {
        setActiveTenantConfigForTesting(null);
      }

      // 2. Two overlapping async requests (A and B, with an await between setting and checking) see only their own token roles
      const [overlapA, overlapB] = await Promise.all([
        runWithActiveActorSession(
          {
            tenantId: 'not-a-law-firm',
            personId: 'P-000002',
            tokenRoles: ['risk_compliance'],
            expiresAtMs: Date.now() + 3600_000,
          },
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 15));
            return {
              selfPerms: resolvePersonPermissions(dafydd),
              otherPerms: resolvePersonPermissions(carys),
            };
          },
        ),
        runWithActiveActorSession(
          {
            tenantId: 'not-a-law-firm',
            personId: 'P-000001',
            tokenRoles: ['finance'],
            expiresAtMs: Date.now() + 3600_000,
          },
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 15));
            return {
              selfPerms: resolvePersonPermissions(carys),
              otherPerms: resolvePersonPermissions(dafydd),
            };
          },
        ),
      ]);
      expect(overlapA.selfPerms).toContain('risk:view');
      expect(overlapA.selfPerms).not.toContain('finance:credit_control');
      expect(overlapB.selfPerms).toContain('finance:credit_control');
      // Request B evaluating Dafydd (user A) sees Dafydd's stored roles only (no risk:view from request A)
      expect(overlapB.otherPerms).not.toContain('risk:view');

      // Outside runWithActiveActorSession, resolvePersonPermissions returns stored roles only and getStoredActorSessionForPerson returns undefined
      expect(resolvePersonPermissions(dafydd)).not.toContain('risk:view');
      expect(
        getStoredActorSessionForPerson('P-000002', 'not-a-law-firm'),
      ).toBeUndefined();
      expect(
        getStoredActorSessionForPerson('P-000001', 'not-a-law-firm'),
      ).toBeUndefined();

      // 2b. Two concurrent sessions for the SAME person (P-000002) with different roles (['admin'] vs ['fee_earner']) each see only their own roles without overwriting each other
      const [samePersonAdminSession, samePersonFeeEarnerSession] =
        await Promise.all([
          runWithActiveActorSession(
            {
              tenantId: 'not-a-law-firm',
              personId: 'P-000002',
              tokenRoles: ['admin'],
              expiresAtMs: Date.now() + 3600_000,
            },
            async () => {
              await new Promise((resolve) => setTimeout(resolve, 15));
              return resolvePersonPermissions(dafydd);
            },
          ),
          runWithActiveActorSession(
            {
              tenantId: 'not-a-law-firm',
              personId: 'P-000002',
              tokenRoles: ['fee_earner'],
              expiresAtMs: Date.now() + 3600_000,
            },
            async () => {
              await new Promise((resolve) => setTimeout(resolve, 15));
              return resolvePersonPermissions(dafydd);
            },
          ),
        ]);
      expect(samePersonAdminSession).toContain('admin:access');
      expect(samePersonFeeEarnerSession).not.toContain('admin:access');

      // 2c. An Entra-only admin (stored roles: [], token mappedRoles: ['admin']) wrapped in withPageActor has admin:access
      const storeForPageActor = getStore();
      const entraOnlyAdmin = storeForPageActor.people.find(
        (p) => p.id === 'P-000002',
      )!;
      const prevRoles = entraOnlyAdmin.roles;
      const prevAppRole = entraOnlyAdmin.appRole;
      try {
        entraOnlyAdmin.roles = [];
        delete entraOnlyAdmin.appRole;
        setTestEntraSessionOverride({
          personId: 'P-000002',
          tenantId: 'not-a-law-firm',
          oid: '00000000-0000-4000-8000-000000000002',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: 'P-000002',
          email: 'dafydd.evans@notalawfirm.example',
          displayName: 'Dafydd Evans',
          entraRoles: ['1Squared.Admin'],
          mappedRoles: ['admin'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
        const canAccessAdminPage = await withPageActor(async (actor) =>
          hasPersonPermission(actor.person, 'admin:access'),
        );
        expect(canAccessAdminPage).toBe(true);
      } finally {
        entraOnlyAdmin.roles = prevRoles;
        entraOnlyAdmin.appRole = prevAppRole;
        setTestEntraSessionOverride(undefined);
      }

      // 3. Signing out clears the session cookies; an expired or signed-out session is rejected with UNAUTHENTICATED
      const userASignedCookie = createSignedEntraSessionCookie({
        personId: 'P-000002',
        tenantId: 'not-a-law-firm',
        oid: '00000000-0000-4000-8000-000000000002',
        tid: '11111111-2222-3333-4444-000000000000',
        sub: 'P-000002',
        email: 'dafydd.evans@notalawfirm.example',
        displayName: 'Dafydd Evans',
        entraRoles: ['risk_compliance'],
        mappedRoles: ['risk_compliance'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      const logoutReq = new NextRequest('http://localhost:3000/api/auth/logout', {
        method: 'POST',
        headers: {
          cookie: `onesquared_entra_session=${encodeURIComponent(userASignedCookie)}`,
        },
      });
      const logoutRes = await logoutPost(logoutReq);
      expect(logoutRes.status).toBe(303);
      expect(logoutRes.cookies.get('onesquared_entra_session')?.value ?? '').toBe('');

      // An expired session cookie is rejected by verifySignedEntraSessionCookie and requireAuthenticatedActor throws UNAUTHENTICATED when signed out
      const expiredCookie = createSignedEntraSessionCookie({
        personId: 'P-000002',
        tenantId: 'not-a-law-firm',
        oid: '00000000-0000-4000-8000-000000000002',
        tid: '11111111-2222-3333-4444-000000000000',
        sub: 'P-000002',
        email: 'dafydd.evans@notalawfirm.example',
        displayName: 'Dafydd Evans',
        entraRoles: ['risk_compliance'],
        mappedRoles: ['risk_compliance'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: new Date(Date.now() - 7200_000).toISOString(),
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      expect(verifySignedEntraSessionCookie(expiredCookie)).toBeNull();
      setTestEntraSessionOverride(null);
      try {
        await expect(requireAuthenticatedActor()).rejects.toThrow(
          /UNAUTHENTICATED/,
        );
      } finally {
        setTestEntraSessionOverride(undefined);
      }

      setRuntimeRbacConfigOverride(null, 'tenant-a');
      setRuntimeRbacConfigOverride(null, 'tenant-b');
      resetAllDemoData('P-000001');
    });

    it('provisions or links an employee on Entra ID OIDC callback and creates a signed session cookie', () => {
      resetAllDemoData('P-000001');

      const { person, verifiedToken, rbacConfig } =
        resolveOrProvisionEntraEmployee({
          oid: '99999999-aaaa-bbbb-cccc-000000000001',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: 'sub-demo-dev',
          name: 'Dev Admin User',
          preferred_username: 'dev.admin@notalawfirm.example',
          email: 'dev.admin@notalawfirm.example',
          roles: ['1Squared.Admin', '1Squared.ManagingPartner'],
          amr: ['pwd', 'mfa'],
        });

      expect(person.isEmployee).toBe(true);
      expect(person.entraObjectId).toBe('99999999-aaaa-bbbb-cccc-000000000001');
      expect(person.roles).toEqual(
        expect.arrayContaining(['admin', 'managing_partner']),
      );
      expect(verifiedToken.mfaVerified).toBe(true);

      const sessionPayload = buildEntraSessionPayload({
        personId: person.id,
        rawClaims: {
          oid: '99999999-aaaa-bbbb-cccc-000000000001',
          tid: '11111111-2222-3333-4444-000000000000',
          name: 'Dev Admin User',
          email: 'dev.admin@notalawfirm.example',
          roles: ['1Squared.Admin', '1Squared.ManagingPartner'],
          amr: ['pwd', 'mfa'],
        },
        verifiedToken,
        rbacConfig,
      });

      expect(sessionPayload.mfaVerified).toBe(true);
      expect(sessionPayload.mappedRoles).toEqual(
        expect.arrayContaining(['admin', 'managing_partner']),
      );
      const signedCookie = createSignedEntraSessionCookie(sessionPayload);
      expect(signedCookie).toContain('.');

      // Subsequent sign-in with the same oid resolves the existing employee record
      const secondSignIn = resolveOrProvisionEntraEmployee({
        oid: '99999999-aaaa-bbbb-cccc-000000000001',
        tid: '11111111-2222-3333-4444-000000000000',
        name: 'Dev Admin User',
        email: 'dev.admin@notalawfirm.example',
        roles: ['1Squared.Admin'],
        amr: ['pwd', 'mfa'],
      });
      expect(secondSignIn.person.id).toBe(person.id);

      resetAllDemoData('P-000001');
    });

    it('refuses Demo Mode persona switching to an employee with access to a restricted/staff matter not accessible to the signed-in actor (R104)', async () => {
      resetAllDemoData('P-000001');
      const rawBase = getActiveTenantRawBaseConfig();
      setActiveTenantConfigForTesting({
        ...rawBase,
        featureFlags: {
          ...((rawBase.featureFlags as Record<string, unknown>) ?? {}),
          enableDemoMode: true,
        },
      });

      try {
        const store = getStore();
        // Use a demo: true target persona (P-000002 marked demo: true with equal fee_earner permissions)
        const targetPersona = store.people.find((p) => p.id === 'P-000002')!;
        targetPersona.demo = true;
        targetPersona.roles = ['fee_earner'];
        targetPersona.appRole = 'fee_earner';

        const signedInFeeEarner = store.people.find((p) => p.id === 'P-000006')!;
        signedInFeeEarner.roles = ['fee_earner'];
        signedInFeeEarner.appRole = 'fee_earner';

        // Mark the first matter as a restricted staff matter where P-000002 is on restrictedAccessUserIds, and P-000006 is not
        const staffMatter = store.matters[0]!;
        staffMatter.isStaffMatter = true;
        staffMatter.restrictedAccessUserIds = ['P-000001', 'P-000002'];

        // Sign in as P-000006 (Owain Jenkins, fee_earner, not on restrictedAccessUserIds)
        setTestEntraSessionOverride({
          personId: 'P-000006',
          tenantId: 'not-a-law-firm',
          oid: '00000000-0000-4000-8000-000000000006',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: 'P-000006',
          email: 'owain.jenkins@notalawfirm.example',
          displayName: 'Owain Jenkins',
          entraRoles: ['fee_earner'],
          mappedRoles: ['fee_earner'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });

        // Attempting to switch in Demo Mode from P-000006 to P-000002 (demo: true, equal permissions, but named on restrictedAccessUserIds) is refused with the exact R104 message
        await expect(switchUserAction('P-000002')).rejects.toThrow(
          /Cannot switch in Demo Mode to a persona who has access to restricted or staff matters not accessible to the current actor/,
        );
      } finally {
        setTestEntraSessionOverride(undefined);
        setActiveTenantConfigForTesting(null);
        resetAllDemoData('P-000001');
      }
    });

    it('omits synthetic test-token entraObjectId values from seeded people when demo/test mode is disabled (R117)', () => {
      const rawBase = getActiveTenantRawBaseConfig();
      const prevNodeEnv = process.env.NODE_ENV;
      const prevPkgDir = process.env.PLATFORM_TENANT_PACKAGE_DIR;
      try {
        process.env.PLATFORM_TENANT_PACKAGE_DIR = 'client-not-a-law-firm';
        setActiveTenantConfigForTesting({
          ...rawBase,
          environment: 'live',
          featureFlags: {
            ...((rawBase.featureFlags as Record<string, unknown>) ?? {}),
            enableDemoMode: false,
          },
        });
        (process.env as Record<string, string | undefined>).NODE_ENV = 'production';

        const seeded = buildDemoData();
        expect(seeded.people.length).toBeGreaterThan(0);
        for (const p of seeded.people) {
          expect(p.entraObjectId).toBeUndefined();
        }
      } finally {
        (process.env as Record<string, string | undefined>).NODE_ENV = prevNodeEnv;
        if (prevPkgDir === undefined) {
          delete process.env.PLATFORM_TENANT_PACKAGE_DIR;
        } else {
          process.env.PLATFORM_TENANT_PACKAGE_DIR = prevPkgDir;
        }
        setActiveTenantConfigForTesting(null);
      }
    });

    it('enforces R106, R123, and R130: server-computed snapshot maps (canTakeByTaskId, permissionsByPersonId, firmPrimaryDomain) and audited sensitive employee reads', () => {
      resetAllDemoData('P-000001');
      try {
        const store = getStore();
        // Create an unassigned open task on a team (TM-000004 Corporate) that P-000001 (Real Estate Partner with task:claim_any) is not a member of, while P-000002 (Real Estate Fee Earner without task:claim_any) is also not a member of
        const corpTeam =
          store.teams.find((t) => !t.memberIds.includes('P-000001') && !t.memberIds.includes('P-000002')) ??
          store.teams[0]!;
        const unassignedCorpTask: Task = {
          ...store.tasks[0]!,
          id: 'TSK-R123-CLAIM-ANY',
          reference: 'TSK-R123',
          title: 'Unassigned Corporate Task',
          description: 'Test R123 task:claim_any on record task lists',
          status: 'To do',
          assignedPersonId: null,
          assignedTeamId: corpTeam.id,
          completedAt: null,
          completedById: null,
          linkedRecords: [
            {
              recordType: 'matter',
              recordId: store.matters[0]!.id,
            },
          ],
        };
        store.tasks.push(unassignedCorpTask);

        // R123: Partner P-000001 holds task:claim_any and sees canTakeByTaskId['TSK-R123-CLAIM-ANY'] === true even though not in corpTeam; Fee Earner P-000002 does not hold task:claim_any and sees false
        const partnerSnap = getAppSnapshot('P-000001');
        const feeEarnerSnap = getAppSnapshot('P-000002');
        expect(partnerSnap.canTakeByTaskId['TSK-R123-CLAIM-ANY']).toBe(true);
        expect(feeEarnerSnap.canTakeByTaskId['TSK-R123-CLAIM-ANY']).toBe(false);

        // R106: getAppSnapshot returns server-computed appRoleByPersonId, rolesByPersonId, permissionsByPersonId, canReopenByEnquiryId, and firmPrimaryDomain
        expect(partnerSnap.firmPrimaryDomain).toBe('notalawfirm.example');
        expect(partnerSnap.appRoleByPersonId['P-000004']).toBe('admin');
        expect(partnerSnap.rolesByPersonId['P-000002']).toContain('fee_earner');
        expect(partnerSnap.permissionsByPersonId['P-000004']).toContain(
          'admin:access',
        );

        // R130: getEmployeeDetailsForUser returns sensitive: null when logEmployeeRestrictedAccess returns null (e.g. caller without employee:view_sensitive or when logViewSensitive is false)
        store.employeeSensitiveRecords['P-000002'] = {
          personId: 'P-000002',
          RightToWorkStatus: 'Verified',
        } as unknown as (typeof store.employeeSensitiveRecords)[string];

        const deniedRead = getEmployeeDetailsForUser('P-000002', 'P-000006', {
          logViewSensitive: true,
        });
        expect(deniedRead.sensitive).toBeNull();
        expect(deniedRead.errors?.sensitivePermission).toBeDefined();

        const unauditedRead = getEmployeeDetailsForUser('P-000002', 'P-000004', {
          logViewSensitive: false,
        });
        expect(unauditedRead.sensitive).toBeNull();

        const auditedRead = getEmployeeDetailsForUser('P-000002', 'P-000004', {
          logViewSensitive: true,
        });
        expect(auditedRead.sensitive).not.toBeNull();

        // R139: A fee earner who leads a team (isTeamLeadOfAnyTeam: true) does NOT hold matter:reassign_ownership
        const dafydd = store.people.find((p) => p.id === 'P-000002')!;
        const teamLedByDafydd: Team = {
          ...store.teams[0]!,
          id: 'TM-R139-LEAD',
          leadIds: ['P-000002'],
          memberIds: ['P-000002'],
          active: true,
        };
        const dafyddAsTeamLeadPerms = resolvePersonPermissions(dafydd, {
          allPeople: store.people,
          teams: [...store.teams, teamLedByDafydd],
        });
        expect(dafyddAsTeamLeadPerms).toContain('task:claim_any');
        expect(dafyddAsTeamLeadPerms).not.toContain('matter:reassign_ownership');

        // R141: previewRbacOverrides enforces rbac:manage_user_overrides / rbac:manage_config, MFA, and schema validation on draft rbacConfig
        const previewRes = previewRbacOverrides(
          'P-000002',
          {
            grant: ['risk:view'],
            revoke: ['matter:create'],
          },
          'P-000004',
          { mfaVerified: true },
        );
        expect(previewRes.ok).toBe(true);
        expect(previewRes.permissions).toContain('risk:view');
        expect(previewRes.permissions).not.toContain('matter:create');

        // Fee earner (P-000002) is refused
        const previewFeeEarner = previewRbacOverrides(
          'P-000002',
          { grant: ['risk:view'], revoke: [] },
          'P-000002',
          { mfaVerified: true },
        );
        expect(previewFeeEarner.ok).toBe(false);

        // Missing MFA (mfaVerified: false) is refused with MFA_REQUIRED
        const previewNoMfa = previewRbacOverrides(
          'P-000002',
          { grant: ['risk:view'], revoke: [] },
          'P-000004',
          { mfaVerified: false },
        );
        expect(previewNoMfa.ok).toBe(false);
        expect(previewNoMfa.error).toMatch(/MFA_REQUIRED/);

        // Invalid rbacConfig is refused by validateRbacConfig
        const previewInvalidConfig = previewRbacOverrides(
          'P-000002',
          {
            grant: [],
            revoke: [],
            rbacConfig: 'not-an-object' as unknown as import('@/domain/rbac').RbacConfiguration,
          },
          'P-000004',
          { mfaVerified: true },
        );
        expect(previewInvalidConfig.ok).toBe(false);
        expect(previewInvalidConfig.error).toMatch(/RBAC_CONFIG_INVALID/);
      } finally {
        resetAllDemoData('P-000001');
      }
    });

    it('enforces explicit config.rbac and tenantId in domain helpers and honours tenant-only departmentGrants/revocations even after saveStore(undefined) (R148)', async () => {
      const store = getStore();
      const dafydd = store.people.find((p) => p.id === 'P-000002')!;

      // Domain functions must fail closed with RBAC_CONFIG_REQUIRED when config.rbac or tenantId is omitted
      expect(() => domainResolvePersonPermissionSet(dafydd)).toThrow(
        /RBAC_CONFIG_REQUIRED/,
      );
      expect(() =>
        domainResolvePersonPermissionSet(dafydd, {
          config: { rbac: createDefaultRbacConfig() },
        }),
      ).toThrow(/RBAC_CONFIG_REQUIRED/);
      expect(() => domainResolveEmployeePermissions(dafydd)).toThrow(
        /RBAC_CONFIG_REQUIRED/,
      );
      expect(() => domainGetLeftRailVisibility('fee_earner', ['fee_earner'])).toThrow(
        /RBAC_CONFIG_REQUIRED/,
      );
      expect(() =>
        domainResolvePersonForEntraClaims({
          claims: { oid: 'oid-1', tid: 'tid-1', sub: 'sub-1', email: 'a@b.c' },
          people: [dafydd],
        }),
      ).toThrow(/RBAC_CONFIG_REQUIRED/);

      // Configure a tenant-only departmentGrants entry ('DEPT-CUSTOM-IT') and revoke 'matter:create' from 'fee_earner'
      const customConfig = structuredClone(
        notALawFirmBaseConfig,
      ) as unknown as TenantConfiguration;
      const defaultRbac = createDefaultRbacConfig();
      const feeEarnerPerms = (
        customConfig.rbac?.roles?.['fee_earner']?.permissions ??
        defaultRbac.roles['fee_earner']!.permissions
      ).filter((p) => p !== 'matter:create');
      customConfig.rbac = {
        ...defaultRbac,
        ...customConfig.rbac,
        roles: {
          ...defaultRbac.roles,
          ...(customConfig.rbac?.roles ?? {}),
          fee_earner: {
            ...defaultRbac.roles['fee_earner']!,
            permissions: feeEarnerPerms,
          },
        },
        departmentGrants: {
          ...defaultRbac.departmentGrants,
          ...(customConfig.rbac?.departmentGrants ?? {}),
          'DEPT-CUSTOM-IT': ['employee:edit_core'],
        },
      };

      try {
        setActiveTenantConfigForTesting(
          customConfig as unknown as Record<string, unknown>,
        );
        setRuntimeRbacConfigOverride(undefined);
        // Also simulate saveStore when store has no runtime rbac override
        saveStore(store);

        const customItPerson = {
          ...dafydd,
          id: 'P-CUSTOM-IT',
          departmentId: 'DEPT-CUSTOM-IT',
          employment: {
            ...dafydd.employment!,
            departmentId: 'DEPT-CUSTOM-IT',
          },
        };

        // Outside session: tenant-only departmentGrants is honoured and revoked 'matter:create' is denied
        expect(
          hasEmployeePermission(
            customItPerson,
            'employee:edit_core',
            [customItPerson],
            store.teams,
          ),
        ).toBe(true);
        expect(hasPersonPermission(customItPerson, 'matter:create')).toBe(false);

        // Inside session: tenant-only departmentGrants is honoured and revoked 'matter:create' is denied
        await runWithActiveActorSession(
          {
            personId: customItPerson.id,
            tenantId: customConfig.tenantId,
            tokenRoles: ['fee_earner'],
            expiresAtMs: Date.now() + 3600_000,
          },
          async () => {
            expect(
              hasEmployeePermission(
                customItPerson,
                'employee:edit_core',
                [customItPerson],
                store.teams,
              ),
            ).toBe(true);
            expect(hasPersonPermission(customItPerson, 'matter:create')).toBe(
              false,
            );
          },
        );
      } finally {
        setActiveTenantConfigForTesting(null);
        setRuntimeRbacConfigOverride(undefined);
      }
    });
  });

  describe('12. Slice S0-03: Destructive Actions, Sign-Off Approvals, Enquiry Anonymisation (B3), Person Save (B11) & Ethical Walls (B12)', () => {
    beforeEach(() => {
      resetAllDemoData('P-000001');
      setTestEntraSessionOverride(undefined);
      setActiveTenantConfigForTesting(null);
    });

    it('1a. resetDemoDataAction and clearAllDataAction enforce admin:data_reset (admin only + MFA + non-live) and write data-reset / data-cleared audit entries', async () => {
      try {
        // Managing partner (P-000038) has admin:access, but NOT admin:data_reset
        setTestEntraSessionOverride({
          personId: 'P-000038',
          tenantId: 'not-a-law-firm',
          oid: '00000000-0000-4000-8000-000000000038',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: 'P-000038',
          email: 'gethin.lloyd@notalawfirm.example',
          displayName: 'Gethin Lloyd',
          entraRoles: ['managing_partner'],
          mappedRoles: ['managing_partner'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
        const mpReset = await resetDemoDataAction();
        expect(isActionDenied(mpReset)).toBe(true);
        if (isActionDenied(mpReset)) {
          expect(mpReset.code).toBe('FORBIDDEN');
        }

        // Admin (P-000004) without MFA is denied with MFA_REQUIRED
        setTestEntraSessionOverride({
          personId: 'P-000004',
          tenantId: 'not-a-law-firm',
          oid: '00000000-0000-4000-8000-000000000004',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: 'P-000004',
          email: 'huw.pritchard@notalawfirm.example',
          displayName: 'Huw Pritchard',
          entraRoles: ['admin'],
          mappedRoles: ['admin'],
          entraGroups: [],
          mfaVerified: false,
          amr: ['pwd'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
        const noMfaClear = await clearAllDataAction();
        expect(isActionDenied(noMfaClear)).toBe(true);
        if (isActionDenied(noMfaClear)) {
          expect(noMfaClear.code).toBe('MFA_REQUIRED');
        }

        // Admin with MFA in live environment is denied with FORBIDDEN
        setTestEntraSessionOverride({
          personId: 'P-000004',
          tenantId: 'not-a-law-firm',
          oid: '00000000-0000-4000-8000-000000000004',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: 'P-000004',
          email: 'huw.pritchard@notalawfirm.example',
          displayName: 'Huw Pritchard',
          entraRoles: ['admin'],
          mappedRoles: ['admin'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
        const prevEnv = process.env.PLATFORM_ENVIRONMENT;
        try {
          process.env.PLATFORM_ENVIRONMENT = 'live';
          setActiveTenantConfigForTesting({
            ...getActiveTenantRawBaseConfig(),
            environment: 'live',
            featureFlags: {
              ...(getActiveTenantRawBaseConfig().featureFlags as Record<string, unknown>),
              enableDemoMode: false,
            },
          });
          const liveReset = await resetDemoDataAction();
          expect(isActionDenied(liveReset)).toBe(true);
          if (isActionDenied(liveReset)) {
            expect(liveReset.code).toBe('FORBIDDEN');
          }
          const liveClear = await clearAllDataAction();
          expect(isActionDenied(liveClear)).toBe(true);
          if (isActionDenied(liveClear)) {
            expect(liveClear.code).toBe('FORBIDDEN');
          }
        } finally {
          process.env.PLATFORM_ENVIRONMENT = prevEnv;
          setActiveTenantConfigForTesting(null);
        }

        // Admin with MFA in test environment succeeds and writes data-reset / data-cleared audit entries with actor name & ID
        const okReset = await resetDemoDataAction();
        expect(isActionDenied(okReset)).toBe(false);
        const storeAfterReset = getStore();
        const resetAudit = storeAfterReset.audit.find(
          (a) => a.action === 'data-reset',
        );
        expect(resetAudit).toBeDefined();
        expect(resetAudit?.byId).toBe('P-000004');
        expect(resetAudit?.newValue).toContain('Huw Pritchard');

        const okClear = await clearAllDataAction();
        expect(isActionDenied(okClear)).toBe(false);
        const storeAfterClear = getStore();
        expect(storeAfterClear.people).toHaveLength(0);
        const clearAudit = storeAfterClear.audit.find(
          (a) => a.action === 'data-cleared',
        );
        expect(clearAudit).toBeDefined();
        expect(clearAudit?.byId).toBe('P-000004');
        expect(clearAudit?.newValue).toContain('Huw Pritchard');
      } finally {
        resetAllDemoData('P-000001');
        setTestEntraSessionOverride(undefined);
        setActiveTenantConfigForTesting(null);
      }
    });

    it('1b. approveSignOff and discussSignOff enforce signoff:approve, matter access, assignedPartnerId, no self-approval, status checks, and audit discussSignOff', async () => {
      const store = getStore();
      // SO-000001: requestedById P-000002, assignedPartnerId P-000001, matterId M-000002, status Pending
      // 1. Fee earner (P-000002) lacks signoff:approve
      const feApprove = approveSignOff('SO-000001', 'P-000002');
      expect(isActionDenied(feApprove)).toBe(true);

      // 2. Partner who is NOT assignedPartnerId (P-000005 is another partner) is denied when assignedPartnerId is set
      const otherPartnerApprove = approveSignOff('SO-000001', 'P-000005');
      expect(isActionDenied(otherPartnerApprove)).toBe(true);
      if (isActionDenied(otherPartnerApprove)) {
        expect(otherPartnerApprove.message).toMatch(/assigned partner/i);
      }

      // 3. No self-approval even when actor holds signoff:approve and assignedPartnerId matches or is null
      const item1 = store.signOffs.find((s) => s.id === 'SO-000001')!;
      item1.requestedById = 'P-000001';
      const selfApprove = approveSignOff('SO-000001', 'P-000001');
      expect(isActionDenied(selfApprove)).toBe(true);
      if (isActionDenied(selfApprove)) {
        expect(selfApprove.message).toMatch(/self-approval/i);
      }
      const selfDiscuss = discussSignOff('SO-000001', 'Self note', 'P-000001');
      expect(isActionDenied(selfDiscuss)).toBe(true);
      item1.requestedById = 'P-000002';

      // 4. Restricted linked matter that the assigned partner cannot access is denied
      const linkedMatter = store.matters.find((m) => m.id === item1.matterId)!;
      linkedMatter.hasEthicalWall = true;
      linkedMatter.restrictedAccessUserIds = ['P-000005'];
      linkedMatter.responsiblePartnerId = 'P-000005';
      linkedMatter.supervisingPartnerId = 'P-000005';
      linkedMatter.leadFeeEarnerId = 'P-000005';
      linkedMatter.teamMemberIds = ['P-000005'];
      const wallDenied = approveSignOff('SO-000001', 'P-000001');
      expect(isActionDenied(wallDenied)).toBe(true);
      if (isActionDenied(wallDenied)) {
        expect(wallDenied.message).toMatch(/matter/i);
      }
      linkedMatter.hasEthicalWall = false;
      linkedMatter.restrictedAccessUserIds = [];
      linkedMatter.responsiblePartnerId = 'P-000001';
      linkedMatter.supervisingPartnerId = 'P-000001';

      // 5. discussSignOff writes an audit entry and transitions status to Discussing
      const discRes = discussSignOff('SO-000001', 'Need client confirmation first', 'P-000001');
      expect(isActionDenied(discRes)).toBe(false);
      expect(item1.status).toBe('Discussing');
      const discAudit = store.audit.find(
        (a) =>
          a.field === 'Partner sign-off' &&
          a.newValue?.includes('Discussing: Write-off'),
      );
      expect(discAudit).toBeDefined();

      // 6. When assignedPartnerId is null, any holder of signoff:approve (who is not requestedById and can access the matter) may approve
      item1.assignedPartnerId = null;
      const unassignedApprove = approveSignOff('SO-000001', 'P-000038');
      expect(isActionDenied(unassignedApprove)).toBe(false);
      expect(item1.status).toBe('Approved');

      // 7. Re-approving or discussing an already Approved sign-off is denied
      const reApprove = approveSignOff('SO-000001', 'P-000038');
      expect(isActionDenied(reApprove)).toBe(true);
      const reDiscuss = discussSignOff('SO-000001', 'Too late', 'P-000038');
      expect(isActionDenied(reDiscuss)).toBe(true);
    });

    it('1c (B3). anonymiseExpiredEnquiries requires enquiry:anonymise and enforces isReadyForRetentionAnonymisation for single enquiries as well as bulk', async () => {
      const store = getStore();
      // Fee earner (P-000002) is denied enquiry:anonymise
      expect(() => anonymiseExpiredEnquiries('P-000002')).toThrow(AuthorisationError);

      // Find a closed unconverted enquiry that is RECENT (not past retentionMonths)
      const closedEnq = store.enquiries.find(
        (e) => e.status === 'Declined' && !e.anonymisedAt,
      )!;
      closedEnq.receivedAt = new Date().toISOString();
      const origFirstName = closedEnq.firstName;

      // Single-enquiry call with Risk & Compliance (P-000003) must NOT anonymise a recent closed enquiry (B3 regression)
      const prematureCount = anonymiseExpiredEnquiries('P-000003', closedEnq.id);
      expect(prematureCount).toBe(0);
      expect(closedEnq.firstName).toBe(origFirstName);
      expect(closedEnq.anonymisedAt).toBeNull();

      // Move receivedAt past retention period (24 months ago) -> now single-enquiry call anonymises it
      const twoYearsAgo = new Date();
      twoYearsAgo.setMonth(twoYearsAgo.getMonth() - 24);
      closedEnq.receivedAt = twoYearsAgo.toISOString();
      const expiredCount = anonymiseExpiredEnquiries('P-000003', closedEnq.id);
      expect(expiredCount).toBe(1);
      expect(closedEnq.firstName).toBe('Anonymised');
      expect(closedEnq.anonymisedAt).toBeTruthy();
    });

    it('1d. remindTeamLeadOverdueCompliance requires risk:view', () => {
      // Fee earner (P-000002) lacks risk:view
      const denied = remindTeamLeadOverdueCompliance('TM-000001', 'P-000002');
      expect(isActionDenied(denied)).toBe(true);

      // Risk & compliance (P-000003) has risk:view
      const allowed = remindTeamLeadOverdueCompliance('TM-000001', 'P-000003');
      expect(isActionDenied(allowed)).toBe(false);
      expect(allowed.ok).toBe(true);
    });

    it('1e (B11). savePersonRecord rejects security field mutations, enforces employee:edit_core on legacy/leaver paths, enforces contact:create/edit, and preserves entraObjectId', async () => {
      const store = getStore();
      const feeEarner = store.people.find((p) => p.id === 'P-000002')!;

      // 1. A fee earner cannot add admin to their own roles by saving their person record
      const selfEscalateRes = savePersonRecord(
        {
          firstName: feeEarner.firstName,
          surname: feeEarner.surname,
          roles: ['fee_earner', 'admin'],
        },
        { id: feeEarner.id, byId: feeEarner.id },
      );
      expect(isActionDenied(selfEscalateRes)).toBe(true);
      expect(
        store.people.find((p) => p.id === feeEarner.id)?.roles,
      ).not.toContain('admin');

      // Also rejected when spreading existing person and mutating roles or permissionOverrides
      const spreadEscalateRes = savePersonRecord(
        {
          ...feeEarner,
          permissionOverrides: { grant: ['admin:access'], revoke: [] },
        },
        { id: feeEarner.id, byId: feeEarner.id },
      );
      expect(isActionDenied(spreadEscalateRes)).toBe(true);

      // 2. worksAtFirm: false without employee:edit_core is denied
      const leaverWithoutPermRes = savePersonRecord(
        {
          firstName: feeEarner.firstName,
          surname: feeEarner.surname,
        },
        { id: feeEarner.id, byId: feeEarner.id, worksAtFirm: false },
      );
      expect(isActionDenied(leaverWithoutPermRes)).toBe(true);
      expect(leaverWithoutPermRes.errors?.permission).toMatch(/employee:edit_core/);

      // Legacy isEmployee: true without rawEmpInput and without employee:edit_core is also denied
      const legacyEmpCreateDenied = savePersonRecord(
        {
          firstName: 'Unauthorised',
          surname: 'Hire',
          isEmployee: true,
          employeeRoleId: 'employee_role.fee_earner',
        },
        { byId: feeEarner.id },
      );
      expect(isActionDenied(legacyEmpCreateDenied)).toBe(true);

      // 3. Contact create without contact:create (Finance P-000009 lacks contact:create and contact:edit) is denied
      const finCreateContact = savePersonRecord(
        {
          firstName: 'Invented',
          surname: 'Prospect',
        },
        { byId: 'P-000009' },
      );
      expect(isActionDenied(finCreateContact)).toBe(true);
      expect(finCreateContact.errors?.permission).toMatch(/contact:create/);

      // Contact edit without contact:edit is denied
      const existingContact = store.people.find((p) => !p.isEmployee && !p.employment)!;
      const finEditContact = savePersonRecord(
        {
          firstName: existingContact.firstName,
          surname: 'ChangedByFinance',
        },
        { id: existingContact.id, byId: 'P-000009' },
      );
      expect(isActionDenied(finEditContact)).toBe(true);
      expect(finEditContact.errors?.permission).toMatch(/contact:edit/);

      // 4. entraObjectId survives a save
      feeEarner.entraObjectId = '00000000-0000-4000-8000-000000000002';
      const partnerUpdateRes = savePersonRecord(
        {
          firstName: feeEarner.firstName,
          surname: feeEarner.surname,
          preferredName: 'Daf',
        },
        { id: feeEarner.id, byId: 'P-000001' },
      );
      expect(isActionDenied(partnerUpdateRes)).toBe(false);
      expect(partnerUpdateRes.errors).toBeUndefined();
      expect(partnerUpdateRes.person.entraObjectId).toBe(
        '00000000-0000-4000-8000-000000000002',
      );

      // 5 (R252). savePersonAction strips caller-supplied internalSystemStep so a user without contact:create/edit cannot bypass the check
      const riskOfficer = store.people.find((p) => p.id === 'P-000003')!;
      const savedOverrides = riskOfficer.permissionOverrides;
      riskOfficer.permissionOverrides = {
        grant: ['employee:edit_core'],
        revoke: ['contact:create', 'contact:edit'],
      };
      setTestEntraSessionOverride({
        personId: riskOfficer.id,
        tenantId: 'not-a-law-firm',
        oid: '00000000-0000-4000-8000-000000000003',
        tid: '00000000-0000-4000-8000-000000000099',
        sub: riskOfficer.id,
        email: 'bethan.rees@notalawfirm.example',
        displayName: 'Bethan Rees',
        entraRoles: [],
        mappedRoles: ['risk_compliance'],
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      try {
        const spoofedCreate = await savePersonAction(
          { firstName: 'Spoofed', surname: 'InternalStep' },
          {
            internalSystemStep: 'enquiry_conversion',
          } as unknown as Parameters<typeof savePersonAction>[1],
        );
        expect(isActionDenied(spoofedCreate)).toBe(true);
        expect(spoofedCreate.errors?.permission).toMatch(/contact:create/);

        const spoofedEdit = await savePersonAction(
          {
            firstName: existingContact.firstName,
            surname: 'SpoofedEdit',
          },
          {
            id: existingContact.id,
            internalSystemStep: 'enquiry_conversion',
          } as unknown as Parameters<typeof savePersonAction>[1],
        );
        expect(isActionDenied(spoofedEdit)).toBe(true);
        expect(spoofedEdit.errors?.permission).toMatch(/contact:edit/);
      } finally {
        riskOfficer.permissionOverrides = savedOverrides;
        setTestEntraSessionOverride(null);
      }
    });

    it('1f (B12). ethical walls fail closed in canAccessMatter and all wrappers even when restrictedAccessUserIds is empty', () => {
      const store = getStore();
      const emptyWallMatter: Matter = {
        ...store.matters.find((m) => m.id === 'M-000001')!,
        id: 'M-EMPTY-WALL',
        isStaffMatter: false,
        hasEthicalWall: true,
        restrictedAccessUserIds: [],
        responsiblePartnerId: 'P-000005',
        supervisingPartnerId: 'P-000005',
        leadFeeEarnerId: 'P-000005',
        teamMemberIds: [],
      };

      // Unnamed partner (P-000001) lacks matter:restricted:access -> denied
      const partner = store.people.find((p) => p.id === 'P-000001')!;
      expect(
        canPersonAccessMatter(emptyWallMatter, partner.id, partner, {
          allPeople: store.people,
          teams: store.teams,
        }),
      ).toBe(false);

      // Unnamed fee earner (P-000002) -> denied
      const feeEarner = store.people.find((p) => p.id === 'P-000002')!;
      expect(
        canPersonAccessMatter(emptyWallMatter, feeEarner.id, feeEarner, {
          allPeople: store.people,
          teams: store.teams,
        }),
      ).toBe(false);

      // Admin with matter:restricted:access explicitly revoked -> denied
      const adminWithoutOversight: Person = {
        ...store.people.find((p) => p.id === 'P-000004')!,
        permissionOverrides: {
          grant: [],
          revoke: ['matter:restricted:access'],
        },
      };
      expect(
        canPersonAccessMatter(
          emptyWallMatter,
          adminWithoutOversight.id,
          adminWithoutOversight,
          {
            allPeople: store.people,
            teams: store.teams,
          },
        ),
      ).toBe(false);

      // Document generation wrapper also fails closed on empty-allowlist ethical wall
      expect(
        canActorAccessMatterRecord(
          {
            id: partner.id,
            tenantId: 'not-a-law-firm',
            roles: ['partner'],
          },
          {
            id: emptyWallMatter.id,
            isStaffMatter: false,
            hasEthicalWall: true,
            restrictedAccessUserIds: [],
            responsiblePartnerId: 'P-000005',
          },
          getActiveTenantConfiguration(),
        ),
      ).toBe(false);

      // Named participant (P-000005) and Risk & Compliance (P-000003, has matter:restricted:access) are allowed
      const namedPartner = store.people.find((p) => p.id === 'P-000005')!;
      const riskOfficer = store.people.find((p) => p.id === 'P-000003')!;
      expect(
        canPersonAccessMatter(emptyWallMatter, namedPartner.id, namedPartner, {
          allPeople: store.people,
          teams: store.teams,
        }),
      ).toBe(true);
      expect(
        canPersonAccessMatter(emptyWallMatter, riskOfficer.id, riskOfficer, {
          allPeople: store.people,
          teams: store.teams,
        }),
      ).toBe(true);
    });
  });

  describe('S0-04: Admin saves and PMS link actions require admin:access or finance:manage_links with MFA, plus PMS creation and team self-escalation guards', () => {
    it('denies all 22 S0-04 actions without permission or without MFA, and allows them with MFA', async () => {
      try {
        resetAllDemoData('P-000001');
        const store = getStore();
        const orgStructure = store.orgStructure!;
        const taskSettings = store.taskSettings;
        const matterCostsConfig = store.matterCostsConfig!;
        const firstValue = store.values.find((v) => v.listKey === 'enquiry_channel') ?? store.values[0]!;
        const firstValueId = firstValue.id;
        const firstWorkTypeSubId = (
          store.values.find((v) => Boolean(v.parentId)) ?? store.values[0]!
        ).id;

        const invokeAll22 = async () => {
          const results = [
            await addChoiceValueAction({
              listKey: firstValue.listKey,
              label: 'S0-04 Test Source',
            }),
            await updateChoiceValueAction(firstValueId, {
              description: 'S0-04 description',
            }),
            await reorderChoiceValueAction(firstValueId, 1),
            await createMatterStageGroupAction({
              label: 'S0-04 Stage Group',
              mode: 'scratch',
            }),
            await saveCustomFieldAction({
              recordType: 'person',
              label: 'S0-04 Custom Field',
              fieldType: 'text',
              section: 'A',
              required: false,
            }),
            await reorderCustomFieldAction(store.customFields[0]!.id, 1),
            await saveTeamAction({
              name: 'S0-04 Test Team',
              memberIds: ['P-000001', 'P-000002'],
              leadIds: ['P-000001'],
              practiceAreaIds: [],
            }),
            await saveEnquirySettingsAction({ retentionMonths: 18 }),
            await saveTaskSettingsAction(taskSettings),
            await saveOrgStructureAction(orgStructure),
            await saveMatterPartyRelationshipAction({
              code: 'S004_REL',
              label: 'S0-04 Relationship',
              isNew: true,
            }),
            await reorderMatterPartyRelationshipAction('S004_REL', -1),
            await deleteMatterPartyRelationshipAction('S004_REL'),
            await saveMatterPartyCapacityAction({
              code: 'S004_CAP',
              label: 'S0-04 Capacity',
              group: 'Ownership, control and authority',
              allowedRelationships: ['CLIENT'],
              profiles: ['ALL'],
              isNew: true,
            }),
            await deleteMatterPartyCapacityAction('S004_CAP'),
            await updateWorkTypeProfilesAction(firstWorkTypeSubId, ['CORP']),
            await saveMatterCostsConfigAction(matterCostsConfig),
            await syncMatterCostsRatesFromPmsAction(),
            await linkPmsRecordAction('organisation', 'O-000001', 'CL-S004'),
            await unlinkPmsRecordAction(
              getStore().pmsLinks.find((l) => l.pmsCode === 'CL-S004')?.id ??
                getStore().pmsLinks[0]!.id,
            ),
            await rerunAutomaticPmsMatchingAction(),
            await createRecordFromPmsAction('organisation', 'CL001'),
          ];
          return results;
        };

        // 1. Fee earner (P-000002) with MFA is denied (FORBIDDEN) on all 22 actions
        setTestEntraSessionOverride({
          personId: 'P-000002',
          tenantId: 'not-a-law-firm',
          oid: '00000000-0000-4000-8000-000000000002',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: 'P-000002',
          email: 'dafydd.evans@notalawfirm.example',
          displayName: 'Dafydd Evans',
          entraRoles: ['fee_earner'],
          mappedRoles: ['fee_earner'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
        const deniedNoPerm = await invokeAll22();
        for (const res of deniedNoPerm) {
          expect(isActionDenied(res)).toBe(true);
          if (isActionDenied(res)) {
            expect(res.code).toBe('FORBIDDEN');
          }
        }

        // 2. Admin (P-000004) without MFA is denied (MFA_REQUIRED) on all 22 actions
        setTestEntraSessionOverride({
          personId: 'P-000004',
          tenantId: 'not-a-law-firm',
          oid: '00000000-0000-4000-8000-000000000004',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: 'P-000004',
          email: 'huw.pritchard@notalawfirm.example',
          displayName: 'Huw Pritchard',
          entraRoles: ['admin'],
          mappedRoles: ['admin'],
          entraGroups: [],
          mfaVerified: false,
          amr: ['pwd'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
        const deniedNoMfa = await invokeAll22();
        for (const res of deniedNoMfa) {
          expect(isActionDenied(res)).toBe(true);
          if (isActionDenied(res)) {
            expect(res.code).toBe('MFA_REQUIRED');
          }
        }

        // 3. Admin (P-000004) with MFA is allowed on all 22 actions
        setTestEntraSessionOverride({
          personId: 'P-000004',
          tenantId: 'not-a-law-firm',
          oid: '00000000-0000-4000-8000-000000000004',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: 'P-000004',
          email: 'huw.pritchard@notalawfirm.example',
          displayName: 'Huw Pritchard',
          entraRoles: ['admin'],
          mappedRoles: ['admin'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
        const allowedWithMfa = await invokeAll22();
        for (const res of allowedWithMfa) {
          expect(isActionDenied(res)).toBe(false);
        }
      } finally {
        setTestEntraSessionOverride(undefined);
        resetAllDemoData('P-000001');
      }
    });

    it('enforces employee:edit_core and matter:create on createRecordFromPmsAction and prevents self-escalation into team leadIds', async () => {
      try {
        resetAllDemoData('P-000001');
        const store = getStore();
        const adminPerson = store.people.find((p) => p.id === 'P-000004')!;

        setTestEntraSessionOverride({
          personId: adminPerson.id,
          tenantId: 'not-a-law-firm',
          oid: '00000000-0000-4000-8000-000000000004',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: adminPerson.id,
          email: 'huw.pritchard@notalawfirm.example',
          displayName: 'Huw Pritchard',
          entraRoles: ['admin'],
          mappedRoles: ['admin'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });

        // Self-escalation check: admin (P-000004) cannot add themselves into leadIds
        const selfLeadAttempt = await saveTeamAction({
          name: 'Self Lead Escalation Team',
          memberIds: [adminPerson.id, 'P-000001'],
          leadIds: [adminPerson.id],
          practiceAreaIds: [],
        });
        expect(isActionDenied(selfLeadAttempt)).toBe(true);
        expect(selfLeadAttempt.error).toMatch(/SELF_MODIFICATION_FORBIDDEN/i);

        const existingTeam = store.teams.find(
          (t) => !t.leadIds.includes(adminPerson.id),
        )!;
        const selfLeadEditAttempt = await saveTeamAction({
          id: existingTeam.id,
          name: existingTeam.name,
          description: existingTeam.description,
          memberIds: [...existingTeam.memberIds, adminPerson.id],
          leadIds: [...existingTeam.leadIds, adminPerson.id],
          practiceAreaIds: existingTeam.practiceAreaIds,
        });
        expect(isActionDenied(selfLeadEditAttempt)).toBe(true);
        expect(selfLeadEditAttempt.error).toMatch(/SELF_MODIFICATION_FORBIDDEN/i);

        // Revoke employee:edit_core on adminPerson -> createRecordFromPmsAction('employee', ...) is denied and creates no employee
        adminPerson.permissionOverrides = {
          grant: [],
          revoke: ['employee:edit_core'],
        };
        store.pmsLinks = store.pmsLinks.filter((l) => l.entityType !== 'employee');
        const peopleCountBefore = store.people.length;
        const empFromPmsDenied = await createRecordFromPmsAction('employee', 'FE01');
        expect(isActionDenied(empFromPmsDenied)).toBe(true);
        expect(empFromPmsDenied.ok).toBe(false);
        expect(empFromPmsDenied.error).toMatch(/employee:edit_core/i);
        expect(store.people.length).toBe(peopleCountBefore);

        // Revoke matter:create on adminPerson -> createRecordFromPmsAction('matter', ...) is denied
        adminPerson.permissionOverrides = {
          grant: [],
          revoke: ['matter:create'],
        };
        store.pmsLinks = store.pmsLinks.filter((l) => l.entityType !== 'matter');
        const mattersCountBefore = store.matters.length;
        const matterFromPmsDenied = await createRecordFromPmsAction(
          'matter',
          'MAT-PMS-001',
        );
        expect(isActionDenied(matterFromPmsDenied)).toBe(true);
        expect(matterFromPmsDenied.ok).toBe(false);
        expect(matterFromPmsDenied.error).toMatch(/matter:create/i);
        expect(store.matters.length).toBe(mattersCountBefore);
      } finally {
        setTestEntraSessionOverride(undefined);
        resetAllDemoData('P-000001');
      }
    });
  });

  describe('20. S0-05 Record Actions: Tasks, Enquiries, Quotes, Notes, and Leaver Reassignment (B8, B9, Item 13)', () => {
    it('denies task comment, task save, and task reassign on restricted matters or when not a team lead (B9)', () => {
      try {
        resetAllDemoData('P-000001');
        const store = getStore();
        // Create an ethical wall matter visible only to P-000001
        const wallMatter = store.matters.find((m) => m.id === 'M-000001')!;
        wallMatter.hasEthicalWall = true;
        wallMatter.restrictedAccessUserIds = ['P-000001'];
        wallMatter.responsiblePartnerId = 'P-000001';
        wallMatter.supervisingPartnerId = 'P-000001';
        wallMatter.leadFeeEarnerId = 'P-000001';
        wallMatter.teamMemberIds = [];

        // Create a task linked to that restricted matter
        const createRes = saveTaskRecord(
          {
            title: 'Confidential wall task',
            dueAt: '2026-12-01',
            assignedPersonId: 'P-000001',
            linkedRecords: [{ recordType: 'matter', recordId: wallMatter.id }],
          },
          'P-000001',
        );
        expect(createRes.task).toBeDefined();
        const wallTask = createRes.task!;

        // Fee earner P-000002 (not on allowlist) cannot see the task in getAppSnapshot
        const snapFeeEarner = getAppSnapshot('P-000002');
        expect(snapFeeEarner.tasks.some((t) => t.id === wallTask.id)).toBe(false);

        // B9: P-000002 cannot comment on a task linked to a restricted matter
        const commentDenied = addTaskCommentRecord(
          wallTask.id,
          'Attempted comment on restricted matter task',
          'P-000002',
        );
        expect(isActionDenied(commentDenied)).toBe(true);

        // P-000002 cannot link a new task to the restricted matter
        const linkRestrictedDenied = saveTaskRecord(
          {
            title: 'Probe restricted matter',
            dueAt: '2026-12-01',
            assignedPersonId: 'P-000002',
            linkedRecords: [{ recordType: 'matter', recordId: wallMatter.id }],
          },
          'P-000002',
        );
        expect(isActionDenied(linkRestrictedDenied)).toBe(true);

        // Non-lead fee earner (P-000002) cannot reassign a task created by and assigned to P-000001
        const teamWithoutP2Lead = store.teams.find((t) => !t.leadIds.includes('P-000002'))!;
        const normalTaskRes = saveTaskRecord(
          {
            title: 'Normal team task',
            dueAt: '2026-12-01',
            assignedPersonId: 'P-000001',
            assignedTeamId: teamWithoutP2Lead.id,
          },
          'P-000001',
        );
        const normalTask = normalTaskRes.task!;
        const reassignDenied = saveTaskRecord(
          {
            id: normalTask.id,
            title: normalTask.title,
            dueAt: normalTask.dueAt,
            assignedPersonId: 'P-000002',
            assignedTeamId: normalTask.assignedTeamId,
          },
          'P-000002',
        );
        expect(isActionDenied(reassignDenied)).toBe(true);
      } finally {
        resetAllDemoData('P-000001');
      }
    });

    it('enforces reopenEnquiryRecord rules and preserves unassigned status as New when unassigned (B8)', () => {
      try {
        resetAllDemoData('P-000001');
        const store = getStore();
        const openEnq = store.enquiries.find((e) => e.status === 'New' || e.status === 'Assigned')!;

        // 1. Reopening an already-open enquiry is denied
        const reopenOpenDenied = reopenEnquiryRecord(openEnq.id, 'P-000001');
        expect(isActionDenied(reopenOpenDenied)).toBe(true);

        // 2. Reopening a Converted enquiry is denied
        const convertedEnq = store.enquiries.find((e) => e.status === 'Converted') ?? openEnq;
        convertedEnq.status = 'Converted';
        const reopenConvertedDenied = reopenEnquiryRecord(convertedEnq.id, 'P-000001');
        expect(isActionDenied(reopenConvertedDenied)).toBe(true);

        // 3. Prepare a closed (Declined) enquiry with assignedToId = null on team 0
        const team = store.teams.find((t) => t.leadIds.length > 0)!;
        const teamLeadId = team.leadIds[0]!;
        const closedEnq = store.enquiries[0]!;
        closedEnq.status = 'Declined';
        closedEnq.assignedToId = null;
        closedEnq.assignedTeamId = team.id;
        closedEnq.convertedMatterId = null;

        // Non-lead, non-assignee fee earner (who is not in Intake) cannot reopen
        const nonLeadFeeEarner = store.people.find(
          (p) =>
            p.isEmployee &&
            p.id !== teamLeadId &&
            p.roles?.includes('fee_earner') &&
            !store.teams.some((t) => t.leadIds.includes(p.id)) &&
            !store.teams.some(
              (t) => t.name.toLowerCase().includes('intake') && t.memberIds.includes(p.id),
            ),
        )!;
        // Grant enquiry:reopen override to test the service-level canUserReopenEnquiry check specifically
        nonLeadFeeEarner.permissionOverrides = {
          grant: ['enquiry:reopen'],
          revoke: [],
        };
        const reopenByNonLead = reopenEnquiryRecord(closedEnq.id, nonLeadFeeEarner.id);
        expect(isActionDenied(reopenByNonLead)).toBe(true);

        // Team lead with enquiry:reopen revoked is refused (R267)
        const teamLeadPerson = store.people.find((p) => p.id === teamLeadId)!;
        teamLeadPerson.permissionOverrides = {
          grant: [],
          revoke: ['enquiry:reopen'],
        };
        const reopenNoPerm = reopenEnquiryRecord(closedEnq.id, teamLeadId);
        expect(isActionDenied(reopenNoPerm)).toBe(true);
        teamLeadPerson.permissionOverrides = undefined;

        // Team lead reopens unassigned closed enquiry -> status becomes 'New' and assignedToId stays null (B8)
        const reopenedRes = reopenEnquiryRecord(closedEnq.id, teamLeadId);
        expect(isActionDenied(reopenedRes)).toBe(false);
        expect(reopenedRes.enquiry?.status).toBe('New');
        expect(reopenedRes.enquiry?.assignedToId).toBeNull();
      } finally {
        resetAllDemoData('P-000001');
      }
    });

    it('denies quote viewing and editing for the finance role, and hides quotes linked to hidden enquiries or restricted matters (quote:view, quote:edit, R267)', () => {
      try {
        resetAllDemoData('P-000001');
        const store = getStore();
        const financeUser = store.people.find(
          (p) => p.isEmployee && p.roles?.includes('finance') && !p.roles?.includes('partner'),
        )!;
        expect(financeUser).toBeDefined();

        // Finance user does not hold quote:view -> getAppSnapshot returns empty quotes
        const snap = getAppSnapshot(financeUser.id);
        expect(snap.currentUserPermissions).not.toContain('quote:view');
        expect(snap.currentUserPermissions).not.toContain('quote:edit');
        expect(snap.quotes).toEqual([]);

        // R267: Fee earner P-000002 holds quote:view, but quotes linked to a restricted matter or hidden enquiry are hidden
        const wallMatter = store.matters[0]!;
        wallMatter.hasEthicalWall = true;
        wallMatter.restrictedAccessUserIds = ['P-000001'];
        wallMatter.responsiblePartnerId = 'P-000001';
        wallMatter.supervisingPartnerId = 'P-000001';
        wallMatter.leadFeeEarnerId = 'P-000001';
        wallMatter.teamMemberIds = [];

        const hiddenEnq = store.enquiries[0]!;
        hiddenEnq.status = 'Draft';
        hiddenEnq.createdById = 'P-000001';
        hiddenEnq.takenById = 'P-000001';

        const quoteOnRestrictedMatter = store.quotes[0]!;
        quoteOnRestrictedMatter.convertedMatterId = wallMatter.id;
        quoteOnRestrictedMatter.linkedEnquiryId = null;

        const quoteOnHiddenEnquiry = store.quotes[1]!;
        quoteOnHiddenEnquiry.linkedEnquiryId = hiddenEnq.id;
        quoteOnHiddenEnquiry.convertedMatterId = null;

        const feeEarnerSnap = getAppSnapshot('P-000002');
        expect(feeEarnerSnap.currentUserPermissions).toContain('quote:view');
        expect(
          feeEarnerSnap.quotes.some((q) => q.id === quoteOnRestrictedMatter.id),
        ).toBe(false);
        expect(
          feeEarnerSnap.quotes.some((q) => q.id === quoteOnHiddenEnquiry.id),
        ).toBe(false);

        const existingQuote = store.quotes[0]!;
        expect(
          isActionDenied(
            saveQuoteRecord(
              {
                clientType: 'prospect',
                prospectName: 'Test Prospect',
                practiceAreaId: existingQuote.practiceAreaId,
                scope: 'Test scope',
                feeBasis: 'Fixed fee',
                feeAmountExVat: 1500,
              },
              { byId: financeUser.id },
            ),
          ),
        ).toBe(true);
        expect(isActionDenied(markQuoteSentRecord(existingQuote.id, financeUser.id))).toBe(true);
        expect(
          isActionDenied(
            logQuoteFollowUpRecord(
              existingQuote.id,
              { method: 'Phone', note: 'Follow up', nextFollowUpDate: '2026-12-01' },
              financeUser.id,
            ),
          ),
        ).toBe(true);
        expect(
          isActionDenied(
            reviseQuoteRecord(
              existingQuote.id,
              {
                feeBasis: 'Fixed fee',
                feeAmountExVat: 2000,
                scope: 'Revised scope',
              },
              financeUser.id,
            ),
          ),
        ).toBe(true);
        expect(
          isActionDenied(
            recordQuoteOutcomeRecord(
              existingQuote.id,
              { outcome: 'Accepted' },
              financeUser.id,
            ),
          ),
        ).toBe(true);
      } finally {
        resetAllDemoData('P-000001');
      }
    });

    it('enforces dual permissions, leaver check, restricted matter allowlist update, SharePoint lifecycle sync, assignedPersonIds, open-only enquiries, and per-record audit on reassignLeaverOwnedRecords (Item 13, R266, R270)', async () => {
      try {
        resetAllDemoData('P-000001');
        const store = getStore();
        const actor = store.people.find((p) => p.id === 'P-000001')!;
        const activeEmp = store.people.find((p) => p.id === 'P-000002')!;
        const replacementEmp = store.people.find((p) => p.id === 'P-000003')!;

        const actorSession = {
          personId: actor.id,
          tenantId: 'not-a-law-firm',
          oid: '00000000-0000-4000-8000-000000000001',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: actor.id,
          email: 'rhian.morgan@notalawfirm.example',
          displayName: 'Rhian Morgan',
          entraRoles: ['partner'],
          mappedRoles: ['partner'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        };
        const verifiedActorSession = verifySignedEntraSessionCookie(
          createSignedEntraSessionCookie(actorSession),
        )!;
        setTestEntraSessionOverride(verifiedActorSession);

        // 1. Rejects when source person is still an active employee (not a leaver)
        const notLeaverRes = reassignLeaverOwnedRecords(
          activeEmp.id,
          replacementEmp.id,
          actor.id,
        );
        expect(isActionDenied(notLeaverRes)).toBe(true);

        // Mark P-000002 as a Leaver
        activeEmp.employment = {
          ...(activeEmp.employment ??
            createDefaultEmploymentRecord({
              person: activeEmp,
              allPeople: store.people,
              byId: 'P-000001',
              status: 'Leaver',
            })),
          status: 'Leaver',
        };

        // 2. Rejects when actor lacks matter:reassign_ownership or employee:edit_core
        actor.permissionOverrides = {
          grant: [],
          revoke: ['matter:reassign_ownership'],
        };
        expect(
          isActionDenied(
            reassignLeaverOwnedRecords(activeEmp.id, replacementEmp.id, actor.id),
          ),
        ).toBe(true);

        actor.permissionOverrides = {
          grant: [],
          revoke: ['employee:edit_core'],
        };
        expect(
          isActionDenied(
            reassignLeaverOwnedRecords(activeEmp.id, replacementEmp.id, actor.id),
          ),
        ).toBe(true);

        actor.permissionOverrides = undefined;

        // 3. Set up restricted matter, multi-assignee open task, and closed enquiry owned by leaver
        const restrictedMatter = store.matters[0]!;
        restrictedMatter.hasEthicalWall = true;
        restrictedMatter.leadFeeEarnerId = activeEmp.id;
        restrictedMatter.restrictedAccessUserIds = ['P-000001', activeEmp.id];

        // Provision a document store folder on restrictedMatter so syncMatterLifecycleOnSaveSync is exercised (R266)
        await retryMatterDocumentProvisioning(restrictedMatter.id, actor.id, {
          session: verifiedActorSession,
        });

        const sharedTask = store.tasks[0]!;
        sharedTask.status = 'To do';
        sharedTask.assignedPersonId = 'P-000001';
        sharedTask.assignedPersonIds = ['P-000001', activeEmp.id];

        // R270 & R293: findRecordsOwnedByLeavers finds multi-assignee tasks where leaver is in assignedPersonIds and labels roleField with assignedPersonIds
        const ownedBefore = findRecordsOwnedByLeavers(
          store.people,
          store.organisations,
          store.matters,
          store.tasks,
          store.enquiries,
          activeEmp.id,
        );
        const coOwnedTaskItem = ownedBefore.find(
          (item) => item.recordType === 'task' && item.recordId === sharedTask.id,
        );
        expect(coOwnedTaskItem).toBeDefined();
        expect(coOwnedTaskItem?.roleField).toBe('assignedPersonIds');
        expect(coOwnedTaskItem?.roleLabel).toBe('Co-assignee');

        const closedEnq = store.enquiries[0]!;
        closedEnq.status = 'Declined';
        closedEnq.assignedToId = activeEmp.id;

        const openEnq = store.enquiries[1]!;
        openEnq.status = 'Assigned';
        openEnq.assignedToId = activeEmp.id;

        const auditCountBefore = store.audit.length;
        const okRes = runWithActiveActorSession(
          {
            personId: actor.id,
            tenantId: 'not-a-law-firm',
            tokenRoles: ['partner'],
            expiresAtMs: Date.now() + 3_600_000,
            verifiedSession: verifiedActorSession,
          },
          () => reassignLeaverOwnedRecords(activeEmp.id, replacementEmp.id, actor.id),
        );
        await flushDocumentLifecycleSyncForTesting();
        expect(isActionDenied(okRes)).toBe(false);
        expect(okRes.reassignedCount).toBeGreaterThan(0);

        // Restricted matter updated: replacement added, leaver removed, no extra users added
        expect(restrictedMatter.leadFeeEarnerId).toBe(replacementEmp.id);
        expect(restrictedMatter.restrictedAccessUserIds).toContain(replacementEmp.id);
        expect(restrictedMatter.restrictedAccessUserIds).not.toContain(activeEmp.id);
        expect(restrictedMatter.restrictedAccessUserIds).toContain('P-000001');

        // R266: SharePoint lifecycle re-permission sync job ran for the restricted matter
        const leaverSyncJob = (store.documentLifecycleJobs ?? []).find(
          (j) =>
            j.matterId === restrictedMatter.id &&
            j.jobType === 'recalculate_permissions' &&
            j.correlationId.startsWith('corr-leaver-reassign-'),
        );
        expect(leaverSyncJob).toBeDefined();
        expect(leaverSyncJob?.status).toBe('succeeded');

        // Task assignedPersonIds updated
        expect(sharedTask.assignedPersonIds).toContain(replacementEmp.id);
        expect(sharedTask.assignedPersonIds).not.toContain(activeEmp.id);

        // Closed enquiry untouched; open enquiry reassigned
        expect(closedEnq.assignedToId).toBe(activeEmp.id);
        expect(openEnq.assignedToId).toBe(replacementEmp.id);

        // Per-record audit entries written for moved matter, task, and open enquiry
        const newAuditEntries = store.audit.slice(0, store.audit.length - auditCountBefore);
        expect(
          newAuditEntries.some(
            (a) => a.recordType === 'matter' && a.recordId === restrictedMatter.id,
          ),
        ).toBe(true);
        expect(
          newAuditEntries.some(
            (a) => a.recordType === 'task' && a.recordId === sharedTask.id,
          ),
        ).toBe(true);
        expect(
          newAuditEntries.some(
            (a) => a.recordType === 'enquiry' && a.recordId === openEnq.id,
          ),
        ).toBe(true);
      } finally {
        setTestEntraSessionOverride(null);
        resetAllDemoData('P-000001');
      }
    });

    it('enforces contact:create, contact:edit, internalSystemStep stripping on saveOrganisationAction (R252), record:merge on duplicates, enquiry permissions, R264 status/assignment lock, and R268 automatic enquiry assignment in saveTaskRecord (R267)', async () => {
      try {
        resetAllDemoData('P-000001');
        const store = getStore();
        const financeUser = store.people.find((p) => p.id === 'P-000009')!;
        const feeEarner = store.people.find((p) => p.id === 'P-000002')!;
        const riskOfficer = store.people.find((p) => p.id === 'P-000003')!;
        const existingOrg = store.organisations[0]!;
        const existingContact = store.people.find((p) => !p.isEmployee)!;

        // 1. saveOrganisationRecord, createOrUpdateLink, and deleteLink enforce contact:create / contact:edit
        expect(
          isActionDenied(
            saveOrganisationRecord(
              { legalName: 'Denied Org' },
              { byId: financeUser.id },
            ),
          ),
        ).toBe(true);
        expect(
          isActionDenied(
            saveOrganisationRecord(
              { legalName: 'Denied Org Edit' },
              { id: existingOrg.id, byId: financeUser.id },
            ),
          ),
        ).toBe(true);

        const createdOrgRes = saveOrganisationRecord(
          { legalName: 'Allowed Org Ltd' },
          { byId: feeEarner.id },
        );
        expect(isActionDenied(createdOrgRes)).toBe(false);

        const linkDeniedCreate = createOrUpdateLink(
          {
            personId: existingContact.id,
            organisationId: existingOrg.id,
            jobTitle: 'Director',
            department: '',
            roleWithinOrganisation: 'Director',
            contactRoleIds: [],
            isPrimaryContact: false,
            isCurrent: true,
            startDate: '2026-01-01',
            endDate: null,
            contactStatusId: null,
          },
          financeUser.id,
        );
        expect(isActionDenied(linkDeniedCreate)).toBe(true);

        const linkCreated = createOrUpdateLink(
          {
            personId: existingContact.id,
            organisationId: createdOrgRes.organisation.id,
            jobTitle: 'Director',
            department: '',
            roleWithinOrganisation: 'Director',
            contactRoleIds: [],
            isPrimaryContact: false,
            isCurrent: true,
            startDate: '2026-01-01',
            endDate: null,
            contactStatusId: null,
          },
          feeEarner.id,
        );
        expect(isActionDenied(linkCreated)).toBe(false);
        if (!isActionDenied(linkCreated)) {
          expect(
            isActionDenied(
              createOrUpdateLink(
                {
                  id: linkCreated.id,
                  personId: existingContact.id,
                  organisationId: createdOrgRes.organisation.id,
                  jobTitle: 'Updated Director',
                  department: '',
                  roleWithinOrganisation: 'Director',
                  contactRoleIds: [],
                  isPrimaryContact: false,
                  isCurrent: true,
                  startDate: '2026-01-01',
                  endDate: null,
                  contactStatusId: null,
                },
                financeUser.id,
              ),
            ),
          ).toBe(true);
          expect(isActionDenied(deleteLink(linkCreated.id, financeUser.id))).toBe(true);
          expect(isActionDenied(deleteLink(linkCreated.id, feeEarner.id))).toBe(false);
        }

        // 2 (R252). saveOrganisationAction strips internalSystemStep so a user with contact:edit only cannot create an org
        riskOfficer.permissionOverrides = {
          grant: ['contact:edit'],
          revoke: ['contact:create'],
        };
        setTestEntraSessionOverride({
          personId: riskOfficer.id,
          tenantId: 'not-a-law-firm',
          oid: '00000000-0000-4000-8000-000000000003',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: riskOfficer.id,
          email: 'bethan.rees@notalawfirm.example',
          displayName: 'Bethan Rees',
          entraRoles: ['risk_compliance'],
          mappedRoles: ['risk_compliance'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
        const spoofedOrgCreate = await saveOrganisationAction(
          { legalName: 'Spoofed Conversion Org' },
          {
            internalSystemStep: 'enquiry_conversion',
          } as unknown as Parameters<typeof saveOrganisationAction>[1],
        );
        expect(isActionDenied(spoofedOrgCreate)).toBe(true);
        expect(spoofedOrgCreate.errors?.permission).toMatch(/contact:create/);
        riskOfficer.permissionOverrides = undefined;

        // 3. record:merge on dismissDuplicateMatch and executeMerge
        const secondOrgRes = saveOrganisationRecord(
          { legalName: 'Duplicate Org Ltd' },
          { byId: feeEarner.id },
        );
        expect(
          isActionDenied(
            dismissDuplicateMatch(
              'organisation',
              createdOrgRes.organisation.id,
              secondOrgRes.organisation.id,
              feeEarner.id,
            ),
          ),
        ).toBe(true);
        expect(
          isActionDenied(
            executeMerge(
              'organisation',
              createdOrgRes.organisation.id,
              secondOrgRes.organisation.id,
              feeEarner.id,
            ),
          ),
        ).toBe(true);
        expect(
          isActionDenied(
            dismissDuplicateMatch(
              'organisation',
              createdOrgRes.organisation.id,
              secondOrgRes.organisation.id,
              riskOfficer.id,
            ),
          ),
        ).toBe(false);

        // 4. Refusals by permission key on assignEnquiryRecord, closeEnquiryRecord, logEnquiryContactRecord, sendEnquiryEmailRecord
        const openEnq = store.enquiries.find((e) => e.status === 'New' || e.status === 'Assigned')!;
        financeUser.permissionOverrides = {
          grant: [],
          revoke: ['enquiry:assign'],
        };
        expect(
          isActionDenied(assignEnquiryRecord(openEnq.id, feeEarner.id, null, financeUser.id)),
        ).toBe(true);
        financeUser.permissionOverrides = undefined;
        expect(
          isActionDenied(
            closeEnquiryRecord(
              openEnq.id,
              { targetStatus: 'Declined', closeNotes: 'Denied close' },
              financeUser.id,
            ),
          ),
        ).toBe(true);
        expect(
          isActionDenied(
            logEnquiryContactRecord(
              openEnq.id,
              { method: 'Phone', outcome: 'Spoke', note: 'Denied log' },
              financeUser.id,
            ),
          ),
        ).toBe(true);
        expect(
          isActionDenied(
            sendEnquiryEmailRecord(
              openEnq.id,
              {
                to: 'prospect@notalawfirm.example',
                subject: 'Test',
                bodyHtml: '<p>Test</p>',
                bodyText: 'Test',
              },
              financeUser.id,
            ),
          ),
        ).toBe(true);

        // 5 (R264, R292). saveEnquiryRecord refuses status or assignment changes on an existing non-draft enquiry
        // even when the actor holds enquiry:edit and only the specific action permission is revoked
        const closedEnq = store.enquiries.find((e) => e.id !== openEnq.id)!;
        closedEnq.status = 'Declined';
        closedEnq.assignedToId = feeEarner.id;

        // 5a. Actor with enquiry:edit but enquiry:reopen revoked cannot reopen a closed enquiry via saveEnquiryRecord
        feeEarner.permissionOverrides = {
          grant: ['enquiry:edit', 'enquiry:close', 'enquiry:assign'],
          revoke: ['enquiry:reopen'],
        };
        const bypassReopenRes = saveEnquiryRecord(
          { status: 'Assigned', summary: closedEnq.summary },
          { id: closedEnq.id, byId: feeEarner.id },
        );
        expect(isActionDenied(bypassReopenRes)).toBe(true);
        if (isActionDenied(bypassReopenRes)) {
          expect(bypassReopenRes.code).toBe('FORBIDDEN');
          expect(bypassReopenRes.message).toMatch(/Use the assign, close, or reopen actions/i);
        }

        // 5b. Actor with enquiry:edit but enquiry:close revoked cannot close an open enquiry via saveEnquiryRecord
        feeEarner.permissionOverrides = {
          grant: ['enquiry:edit', 'enquiry:reopen', 'enquiry:assign'],
          revoke: ['enquiry:close'],
        };
        const bypassCloseRes = saveEnquiryRecord(
          { status: 'Declined', summary: openEnq.summary },
          { id: openEnq.id, byId: feeEarner.id },
        );
        expect(isActionDenied(bypassCloseRes)).toBe(true);
        if (isActionDenied(bypassCloseRes)) {
          expect(bypassCloseRes.code).toBe('FORBIDDEN');
          expect(bypassCloseRes.message).toMatch(/Use the assign, close, or reopen actions/i);
        }

        // 5c. Actor with enquiry:edit but enquiry:assign revoked cannot change assignedToId or assignedTeamId via saveEnquiryRecord
        feeEarner.permissionOverrides = {
          grant: ['enquiry:edit', 'enquiry:reopen', 'enquiry:close'],
          revoke: ['enquiry:assign'],
        };
        const bypassAssignUserRes = saveEnquiryRecord(
          { assignedToId: 'P-000001', summary: openEnq.summary },
          { id: openEnq.id, byId: feeEarner.id },
        );
        expect(isActionDenied(bypassAssignUserRes)).toBe(true);
        if (isActionDenied(bypassAssignUserRes)) {
          expect(bypassAssignUserRes.code).toBe('FORBIDDEN');
          expect(bypassAssignUserRes.message).toMatch(/Use the assign, close, or reopen actions/i);
        }
        const bypassAssignTeamRes = saveEnquiryRecord(
          { assignedTeamId: 'TM-999999', summary: openEnq.summary },
          { id: openEnq.id, byId: feeEarner.id },
        );
        expect(isActionDenied(bypassAssignTeamRes)).toBe(true);
        if (isActionDenied(bypassAssignTeamRes)) {
          expect(bypassAssignTeamRes.code).toBe('FORBIDDEN');
          expect(bypassAssignTeamRes.message).toMatch(/Use the assign, close, or reopen actions/i);
        }
        feeEarner.permissionOverrides = undefined;

        // 5d (R292 positive control). A Draft enquiry can still be routed through saveEnquiryRecord with asDraft: false, status, assignedToId, and assignedTeamId
        const draftToRouteCreateRes = saveEnquiryRecord(
          {
            firstName: 'Route',
            lastName: 'FromDraft',
            email: 'route.fromdraft@notalawfirm.example',
            phone: '029 2000 1234',
            channelId: openEnq.channelId,
            practiceAreaId: openEnq.practiceAreaId,
            summary: 'Draft enquiry ready for routing',
            notes: 'Initial notes for routing from draft',
            urgencyId: openEnq.urgencyId,
            privacyNoticeGiven: true,
          },
          { asDraft: true, byId: feeEarner.id },
        );
        expect(isActionDenied(draftToRouteCreateRes)).toBe(false);
        expect(draftToRouteCreateRes.enquiry?.status).toBe('Draft');
        const targetTeamId = store.teams[0]!.id;
        const routedFromDraftRes = saveEnquiryRecord(
          {
            status: 'Assigned',
            assignedToId: feeEarner.id,
            assignedTeamId: targetTeamId,
          },
          { id: draftToRouteCreateRes.enquiry!.id, asDraft: false, byId: feeEarner.id },
        );
        expect(isActionDenied(routedFromDraftRes)).toBe(false);
        expect(routedFromDraftRes.enquiry?.status).toBe('Assigned');
        expect(routedFromDraftRes.enquiry?.assignedToId).toBe(feeEarner.id);
        expect(routedFromDraftRes.enquiry?.assignedTeamId).toBe(targetTeamId);

        // 6 (R267, R268, R293, R299). Automatic enquiry assignment inside saveTaskRecord requires enquiry:assign and skips Draft and closed enquiries
        const draftEnqRes = saveEnquiryRecord(
          { firstName: 'Draft', lastName: 'Enquiry', summary: 'Draft summary' },
          { asDraft: true, byId: feeEarner.id },
        );
        const draftEnq = draftEnqRes.enquiry!;
        const draftTaskRes = saveTaskRecord(
          {
            title: 'Task on draft enquiry',
            dueAt: '2026-12-01',
            assignedPersonId: feeEarner.id,
            linkedRecords: [{ recordType: 'enquiry', recordId: draftEnq.id }],
          },
          feeEarner.id,
        );
        expect(isActionDenied(draftTaskRes)).toBe(false);
        expect(draftTaskRes.task?.id).toBeTruthy();
        expect(draftTaskRes.task?.linkedRecords).toEqual([
          { recordType: 'enquiry', recordId: draftEnq.id },
        ]);
        expect(draftEnq.status).toBe('Draft');
        expect(draftEnq.assignedToId).toBeNull();

        // Closed (Declined) unassigned enquiry is not auto-assigned or reopened when a task is linked to it (R293, R299)
        closedEnq.status = 'Declined';
        closedEnq.assignedToId = null;
        const closedTaskRes = saveTaskRecord(
          {
            title: 'Task on declined enquiry',
            dueAt: '2026-12-01',
            assignedPersonId: feeEarner.id,
            linkedRecords: [{ recordType: 'enquiry', recordId: closedEnq.id }],
          },
          feeEarner.id,
        );
        expect(isActionDenied(closedTaskRes)).toBe(false);
        expect(closedTaskRes.task?.id).toBeTruthy();
        expect(closedTaskRes.task?.linkedRecords).toEqual([
          { recordType: 'enquiry', recordId: closedEnq.id },
        ]);
        expect(closedEnq.status).toBe('Declined');
        expect(closedEnq.assignedToId).toBeNull();

        const routedNewEnq = store.enquiries.find((e) => e.id === openEnq.id)!;
        routedNewEnq.status = 'New';
        routedNewEnq.assignedToId = null;

        // Actor without enquiry:assign does not auto-assign the enquiry
        feeEarner.permissionOverrides = {
          grant: [],
          revoke: ['enquiry:assign'],
        };
        saveTaskRecord(
          {
            title: 'Task without enquiry:assign',
            dueAt: '2026-12-01',
            assignedPersonId: feeEarner.id,
            linkedRecords: [{ recordType: 'enquiry', recordId: routedNewEnq.id }],
          },
          feeEarner.id,
        );
        expect(routedNewEnq.assignedToId).toBeNull();
        expect(routedNewEnq.status).toBe('New');

        // Actor with enquiry:assign auto-assigns the routed New enquiry
        feeEarner.permissionOverrides = undefined;
        saveTaskRecord(
          {
            title: 'Task with enquiry:assign',
            dueAt: '2026-12-01',
            assignedPersonId: feeEarner.id,
            linkedRecords: [{ recordType: 'enquiry', recordId: routedNewEnq.id }],
          },
          feeEarner.id,
        );
        expect(routedNewEnq.assignedToId).toBe(feeEarner.id);
        expect(routedNewEnq.status).toBe('Assigned');
      } finally {
        setTestEntraSessionOverride(null);
        resetAllDemoData('P-000001');
      }
    });

    it('enforces target-specific permissions on addNoteToRecord (restricted matter and employee record)', () => {
      try {
        resetAllDemoData('P-000001');
        const store = getStore();
        const wallMatter = store.matters[0]!;
        wallMatter.hasEthicalWall = true;
        wallMatter.restrictedAccessUserIds = ['P-000001'];
        wallMatter.responsiblePartnerId = 'P-000001';
        wallMatter.supervisingPartnerId = 'P-000001';
        wallMatter.leadFeeEarnerId = 'P-000001';
        wallMatter.teamMemberIds = [];

        // Fee earner P-000002 holds matter:edit and contact:edit, but cannot view wallMatter or edit employees
        const noteOnRestrictedMatter = addNoteToRecord(
          'matter',
          wallMatter.id,
          'Should fail on walled matter',
          'P-000002',
        );
        expect(isActionDenied(noteOnRestrictedMatter)).toBe(true);

        const noteOnEmployeeWithoutHrPerm = addNoteToRecord(
          'person',
          'P-000001',
          'Should fail on employee record without employee:edit_core',
          'P-000002',
        );
        expect(isActionDenied(noteOnEmployeeWithoutHrPerm)).toBe(true);
      } finally {
        resetAllDemoData('P-000001');
      }
    });
  });

  describe('21. S0-07 Conflict Fixes: Quote Conversion (B5), Enquiry Conversion, and Extended Conflict Search (B7, Item 1a)', () => {
    it('denies enquiry conversion and quote conversion without matter:create and creates nothing', async () => {
      try {
        resetAllDemoData('P-000001');
        const store = getStore();
        const peopleBefore = store.people.length;
        const orgsBefore = store.organisations.length;
        const linksBefore = store.links.length;

        // Finance user (P-000009) lacks matter:create
        setTestEntraSessionOverride({
          personId: 'P-000009',
          tenantId: 'not-a-law-firm',
          oid: '00000000-0000-4000-8000-000000000009',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: 'P-000009',
          email: 'gethin.powell@notalawfirm.example',
          displayName: 'Gethin Powell',
          entraRoles: ['finance'],
          mappedRoles: ['finance'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });

        const enqId = store.enquiries.find((e) => e.status !== 'Draft')!.id;
        const enqActionRes = await prepareEnquiryConversionAction(enqId, {
          createForBusiness: true,
        });
        expect(isActionDenied(enqActionRes)).toBe(true);
        if (isActionDenied(enqActionRes)) {
          expect(enqActionRes.code).toBe('FORBIDDEN');
        }
        const enqSvcRes = prepareEnquiryConversion(
          enqId,
          { createForBusiness: true },
          'P-000009',
        );
        expect(isActionDenied(enqSvcRes)).toBe(true);

        const quoteId = store.quotes[0]!.id;
        const quoteActionRes = await prepareQuoteConversionAction(quoteId);
        expect(isActionDenied(quoteActionRes)).toBe(true);
        const quoteSvcRes = prepareQuoteConversionRecord(quoteId, 'P-000009');
        expect(isActionDenied(quoteSvcRes)).toBe(true);

        expect(store.people.length).toBe(peopleBefore);
        expect(store.organisations.length).toBe(orgsBefore);
        expect(store.links.length).toBe(linksBefore);
      } finally {
        setTestEntraSessionOverride(undefined);
        resetAllDemoData('P-000001');
      }
    });

    it('blocks quote conversion on a high-severity conflict hit (creating nothing), and when clear creates records with outcome-derived conflict status, conflictDecision, and audit entry (B5)', async () => {
      try {
        resetAllDemoData('P-000001');
        const store = getStore();
        // Find an opposing party on an existing matter to trigger a high-severity hit
        const matterWithOpponent = store.matters.find(
          (m) =>
            !m.isStaffMatter &&
            !m.hasEthicalWall &&
            m.parties.some((p) => p.role === 'Opponent' || p.role === 'Counterparty'),
        )!;
        const opponentParty = matterWithOpponent.parties.find(
          (p) => p.role === 'Opponent' || p.role === 'Counterparty',
        )!;

        // 1. Create a prospect quote for that opposing party
        const blockedQuoteRes = saveQuoteRecord(
          {
            clientType: 'prospect',
            prospectName: 'Gareth OpponentContact',
            prospectOrganisationName: opponentParty.name,
            prospectEmail: 'gareth@opponent.example',
            practiceAreaId: matterWithOpponent.practiceAreaId,
            scope: 'Blocked quote scope',
            feeBasis: 'Fixed fee',
            feeAmountExVat: 2500,
          },
          { byId: 'P-000001' },
        );
        expect(blockedQuoteRes.quote).toBeDefined();
        const blockedQuote = blockedQuoteRes.quote!;

        const peopleBeforeBlock = store.people.length;
        const orgsBeforeBlock = store.organisations.length;
        const linksBeforeBlock = store.links.length;

        const blockedConv = prepareQuoteConversionRecord(blockedQuote.id, 'P-000001');
        expect(blockedConv.ok).toBe(false);
        expect(blockedConv.conflictBlocked).toBe(true);
        expect(blockedConv.conflictReasons?.length).toBeGreaterThan(0);
        // Nothing created when blocked
        expect(store.people.length).toBe(peopleBeforeBlock);
        expect(store.organisations.length).toBe(orgsBeforeBlock);
        expect(store.links.length).toBe(linksBeforeBlock);

        // 2. Create a clean prospect quote -> creates person, organisation (Cleared), conflictDecision, and audit entry
        const cleanQuoteRes = saveQuoteRecord(
          {
            clientType: 'prospect',
            prospectName: 'Seren CleanProspect',
            prospectOrganisationName: 'Solaris Clean Ventures Ltd',
            prospectEmail: 'seren@solaris-clean.example',
            practiceAreaId: matterWithOpponent.practiceAreaId,
            scope: 'Clean quote scope',
            feeBasis: 'Fixed fee',
            feeAmountExVat: 3000,
          },
          { byId: 'P-000001' },
        );
        const cleanQuote = cleanQuoteRes.quote!;
        const cleanConv = prepareQuoteConversionRecord(cleanQuote.id, 'P-000001');
        expect(cleanConv.ok).toBe(true);
        expect(cleanConv.clientId).toBeDefined();
        expect(cleanConv.instructingContactId).toBeDefined();

        const createdOrg = store.organisations.find((o) => o.id === cleanConv.clientId)!;
        expect(createdOrg).toBeDefined();
        expect(createdOrg.conflictDecision).toBeDefined();
        expect(createdOrg.conflictDecision?.outcome).toBe('Cleared');
        expect(createdOrg.conflictDecision?.decidedById).toBe('P-000001');
        expect(createdOrg.conflictDecision?.searchedSources).toEqual([
          ...CONFLICT_SEARCHED_SOURCES,
        ]);
        expect(
          store.audit.some(
            (a) =>
              a.recordType === 'organisation' &&
              a.recordId === createdOrg.id &&
              a.action === 'conflict-decision' &&
              a.field?.includes('Conflict check decision recorded on quote conversion'),
          ),
        ).toBe(true);

        // 2b. R254: An existing organisation set to "Conflict – declined" stays declined and blocks quote conversion
        const declinedStatusId = 'conflict_status.conflict_declined';
        const clearedWithConsentStatusId = 'conflict_status.cleared_with_consent';

        const declinedOrg = saveOrganisationRecord(
          {
            legalName: 'Declined Existing Org Ltd',
            conflictStatusId: declinedStatusId,
            conflictReference: 'CR-KEEP-DECLINED',
          },
          { byId: 'P-000001' },
        ).organisation!;
        expect(declinedOrg.conflictStatusId).toBe(declinedStatusId);

        const declinedOrgQuote = saveQuoteRecord(
          {
            clientType: 'existing',
            linkedOrganisationId: declinedOrg.id,
            practiceAreaId: matterWithOpponent.practiceAreaId,
            scope: 'Quote for declined existing org',
            feeBasis: 'Fixed fee',
            feeAmountExVat: 1800,
          },
          { byId: 'P-000001' },
        ).quote!;
        const declinedOrgConv = prepareQuoteConversionRecord(declinedOrgQuote.id, 'P-000001');
        expect(declinedOrgConv.ok).toBe(false);
        expect(declinedOrgConv.conflictBlocked).toBe(true);
        expect(declinedOrg.conflictStatusId).toBe(declinedStatusId);
        expect(declinedOrg.conflictReference).toBe('CR-KEEP-DECLINED');

        // 2c. R254: An existing organisation set to "Cleared with consent" keeps its status after a successful quote conversion
        const consentOrg = saveOrganisationRecord(
          {
            legalName: 'Consent Existing Org Ltd',
            conflictStatusId: clearedWithConsentStatusId,
            conflictReference: 'CR-KEEP-CONSENT',
          },
          { byId: 'P-000001' },
        ).organisation!;
        const consentOrgQuote = saveQuoteRecord(
          {
            clientType: 'existing',
            linkedOrganisationId: consentOrg.id,
            practiceAreaId: matterWithOpponent.practiceAreaId,
            scope: 'Quote for cleared-with-consent existing org',
            feeBasis: 'Fixed fee',
            feeAmountExVat: 2200,
          },
          { byId: 'P-000001' },
        ).quote!;
        const consentOrgConv = prepareQuoteConversionRecord(consentOrgQuote.id, 'P-000001');
        expect(consentOrgConv.ok).toBe(true);
        expect(consentOrg.conflictStatusId).toBe(clearedWithConsentStatusId);
        expect(consentOrg.conflictReference).toBe('CR-KEEP-CONSENT');
        expect(
          store.audit.some(
            (a) =>
              a.recordType === 'quote' &&
              a.recordId === consentOrgQuote.id &&
              a.action === 'conflict-decision',
          ),
        ).toBe(true);

        // 2d. R255: A quote with a non-blocking amber warning (private client whose employer is an existing client) converts without blocking
        const existingClientOrgId = matterWithOpponent.clientId;
        const privateClientEmployee = savePersonRecord(
          {
            firstName: 'Nia',
            surname: 'AmberWarningClient',
          },
          { byId: 'P-000001' },
        ).person!;
        store.links.push({
          id: 'L-R255-AMBER',
          personId: privateClientEmployee.id,
          organisationId: existingClientOrgId,
          jobTitle: 'Analyst',
          department: 'Operations',
          roleWithinOrganisation: 'Employee',
          contactRoleIds: [],
          isPrimaryContact: false,
          isCurrent: true,
          startDate: '2025-01-01',
          endDate: null,
          contactStatusId: null,
          createdById: 'P-000001',
          createdAt: '2025-01-01T09:00:00Z',
          updatedById: 'P-000001',
          updatedAt: '2025-01-01T09:00:00Z',
        });
        const amberQuote = saveQuoteRecord(
          {
            clientType: 'existing',
            linkedPersonId: privateClientEmployee.id,
            practiceAreaId: matterWithOpponent.practiceAreaId,
            scope: 'Private client quote with amber employer link',
            feeBasis: 'Fixed fee',
            feeAmountExVat: 1500,
          },
          { byId: 'P-000001' },
        ).quote!;
        const amberConv = prepareQuoteConversionRecord(amberQuote.id, 'P-000001');
        expect(amberConv.ok).toBe(true);
        expect(amberConv.conflictBlocked).toBeFalsy();
        expect(amberConv.conflictWarnings?.length).toBeGreaterThan(0);
        expect(amberConv.conflictWarnings?.[0]).toContain('linked to');
        const amberAudit = store.audit.find(
          (a) =>
            a.recordType === 'quote' &&
            a.recordId === amberQuote.id &&
            a.action === 'conflict-decision',
        );
        expect(amberAudit).toBeDefined();
        expect(amberAudit?.newValue).toContain('Potential conflict');

        // 2e. R297: A quote matching a declined organisation by name (without linkedOrganisationId) does NOT block,
        // emits the non-blocking warning even when the declined organisation is listed second among same-named organisations,
        // and sets the new prospect organisation's conflictDecision.outcome to 'Potential conflict'
        const clearedSameNameOrg = saveOrganisationRecord(
          {
            legalName: 'Declined Existing Org Ltd',
            conflictStatusId: 'conflict_status.cleared',
            conflictReference: 'CR-CLEARED-FIRST',
          },
          { byId: 'P-000001' },
        ).organisation!;
        // Move clearedSameNameOrg before declinedOrg so declinedOrg is listed second among same-named organisations
        const clearedIdx = store.organisations.findIndex((o) => o.id === clearedSameNameOrg.id);
        if (clearedIdx >= 0) {
          store.organisations.splice(clearedIdx, 1);
        }
        const declinedIdx = store.organisations.findIndex((o) => o.id === declinedOrg.id);
        store.organisations.splice(declinedIdx, 0, clearedSameNameOrg);

        const declinedByNameQuote = saveQuoteRecord(
          {
            clientType: 'prospect',
            prospectName: 'Dafydd NameMatch',
            prospectOrganisationName: 'Declined Existing Org Ltd',
            practiceAreaId: matterWithOpponent.practiceAreaId,
            scope: 'Quote matching declined org by name',
            feeBasis: 'Fixed fee',
            feeAmountExVat: 1900,
          },
          { byId: 'P-000001' },
        ).quote!;
        const declinedByNameConv = prepareQuoteConversionRecord(
          declinedByNameQuote.id,
          'P-000001',
        );
        expect(declinedByNameConv.ok).toBe(true);
        expect(declinedByNameConv.conflictBlocked).toBeFalsy();
        expect(declinedByNameConv.conflictWarnings).toContain(
          "An organisation with this name has conflict status 'Conflict – declined'. Check whether it is the same client.",
        );
        const createdSameNameProspectOrg = store.organisations.find(
          (o) => o.id === declinedByNameConv.clientId,
        )!;
        expect(createdSameNameProspectOrg.conflictDecision?.outcome).toBe('Potential conflict');
        expect(createdSameNameProspectOrg.conflictDecision?.matchesCount).toBe(0);

        // Linked declined organisation still hard-blocks
        const linkedDeclinedRecheck = prepareQuoteConversionRecord(declinedOrgQuote.id, 'P-000001');
        expect(linkedDeclinedRecheck.ok).toBe(false);
        expect(linkedDeclinedRecheck.conflictBlocked).toBe(true);

        // 3. Enquiry conversion for a new business also records conflictDecision and audit entry, and keeps conflictDecision on the converted matter (R304)
        const templateEnq = store.enquiries.find((e) => e.status !== 'Draft')!;

        // 3a. R307: An enquiry linked to a declined organisation is blocked on conversion, while an unlinked enquiry matching a declined organisation by name converts with the warning in conflictWarnings
        const linkedDeclinedEnq = saveEnquiryRecord(
          {
            channelId: templateEnq.channelId,
            firstName: 'Owain',
            lastName: 'DeclinedLinkedCaller',
            callingOnBehalfOf: declinedOrg.legalName,
            linkedOrganisationId: declinedOrg.id,
            email: 'owain@declined-linked.example',
            phone: '029 2018 0771',
            preferredContactMethodId: templateEnq.preferredContactMethodId,
            sourceId: templateEnq.sourceId,
            practiceAreaId: matterWithOpponent.practiceAreaId,
            summary: 'Enquiry linked to declined organisation',
            notes: 'High-level notes for linked declined organisation enquiry conversion test.',
            otherPartiesNamed: '',
            urgencyId: templateEnq.urgencyId,
            privacyNoticeGiven: true,
          },
          { byId: 'P-000001', asDraft: false },
        ).enquiry!;
        const linkedDeclinedEnqConv = prepareEnquiryConversion(
          linkedDeclinedEnq.id,
          { useOrganisationId: declinedOrg.id, createForBusiness: true },
          'P-000001',
        );
        expect(linkedDeclinedEnqConv.ok).toBe(false);
        expect(linkedDeclinedEnqConv.conflictBlocked).toBe(true);
        expect(linkedDeclinedEnqConv.conflictReasons).toContain(
          'Client organisation has conflict status "Conflict – declined".',
        );

        const declinedEnqOrg = saveOrganisationRecord(
          {
            legalName: 'Declined Enquiry Org Ltd',
            conflictStatusId: declinedStatusId,
            conflictReference: 'CR-ENQ-DECLINED',
          },
          { byId: 'P-000001' },
        ).organisation!;
        const unlinkedDeclinedNameEnq = saveEnquiryRecord(
          {
            channelId: templateEnq.channelId,
            firstName: 'Carys',
            lastName: 'DeclinedNameCaller',
            callingOnBehalfOf: declinedEnqOrg.legalName,
            email: 'carys@declined-name.example',
            phone: '029 2018 0772',
            preferredContactMethodId: templateEnq.preferredContactMethodId,
            sourceId: templateEnq.sourceId,
            practiceAreaId: matterWithOpponent.practiceAreaId,
            summary: 'Unlinked enquiry matching declined organisation by name',
            notes: 'High-level notes for unlinked declined organisation name match enquiry test.',
            otherPartiesNamed: '',
            urgencyId: templateEnq.urgencyId,
            privacyNoticeGiven: true,
          },
          { byId: 'P-000001', asDraft: false },
        ).enquiry!;
        const unlinkedDeclinedNameEnqConv = prepareEnquiryConversion(
          unlinkedDeclinedNameEnq.id,
          { createForBusiness: true },
          'P-000001',
        );
        expect(unlinkedDeclinedNameEnqConv.ok).toBe(true);
        expect(unlinkedDeclinedNameEnqConv.conflictBlocked).toBeFalsy();
        expect(unlinkedDeclinedNameEnqConv.conflictWarnings).toContain(
          "An organisation with this name has conflict status 'Conflict – declined'. Check whether it is the same client.",
        );
        expect(unlinkedDeclinedNameEnq.conflictDecision?.outcome).toBe('Potential conflict');
        expect(unlinkedDeclinedNameEnq.conflictDecision?.matchesCount).toBe(0);

        const cleanEnqRes = saveEnquiryRecord(
          {
            channelId: templateEnq.channelId,
            firstName: 'Idris',
            lastName: 'ClearCaller',
            callingOnBehalfOf: 'Meridian Clear Holdings Ltd',
            email: 'idris@meridian-clear.example',
            phone: '029 2018 0999',
            preferredContactMethodId: templateEnq.preferredContactMethodId,
            sourceId: templateEnq.sourceId,
            practiceAreaId: matterWithOpponent.practiceAreaId,
            summary: 'Clean enquiry for conversion',
            notes: 'High-level notes for clean enquiry conversion test.',
            otherPartiesNamed: 'None',
            urgencyId: templateEnq.urgencyId,
            privacyNoticeGiven: true,
          },
          { byId: 'P-000001', asDraft: false },
        );
        const cleanEnq = cleanEnqRes.enquiry!;
        const enqConv = prepareEnquiryConversion(
          cleanEnq.id,
          { createForBusiness: true },
          'P-000001',
        );
        expect(enqConv.ok).toBe(true);
        const enqCreatedOrg = store.organisations.find((o) => o.id === enqConv.clientId)!;
        expect(enqCreatedOrg.conflictDecision).toBeDefined();
        expect(enqCreatedOrg.conflictDecision?.outcome).toBe('Cleared');
        expect(enqCreatedOrg.conflictDecision?.decidedById).toBe('P-000001');
        expect(enqCreatedOrg.conflictDecision?.searchedSources).toEqual([
          ...CONFLICT_SEARCHED_SOURCES,
        ]);
        expect(
          store.audit.some(
            (a) =>
              a.recordType === 'organisation' &&
              a.recordId === enqCreatedOrg.id &&
              a.action === 'conflict-decision',
          ),
        ).toBe(true);

        setTestEntraSessionOverride({
          personId: 'P-000001',
          tenantId: 'not-a-law-firm',
          oid: '00000000-0000-4000-8000-000000000001',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: 'P-000001',
          email: 'glyn.morgan@notalawfirm.example',
          displayName: 'Glyn Morgan',
          entraRoles: ['managing_partner', 'admin'],
          mappedRoles: ['managing_partner', 'admin'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
        const convertedMatterRes = await withPageActor(() =>
          saveMatterRecord(
            {
              title: 'Meridian Clear Converted Matter',
              shortDescription: 'Matter created from enquiry conversion',
              clientId: enqConv.clientId!,
              instructingContactId: enqConv.instructingContactId,
              sourceEnquiryId: cleanEnq.id,
              practiceAreaId: matterWithOpponent.practiceAreaId,
              workTypeSubcategoryId: matterWithOpponent.workTypeSubcategoryId,
              matterTypeId: matterWithOpponent.matterTypeId,
              billingBasisId: matterWithOpponent.billingBasisId,
              jurisdictionGroupId: matterWithOpponent.jurisdictionGroupId,
              leadFeeEarnerId: 'P-000001',
              supervisingPartnerId: 'P-000001',
            },
            { byId: 'P-000001', saveMode: 'draft' },
          ),
        );
        expect(convertedMatterRes.matter?.conflictDecision).toBeDefined();
        expect(convertedMatterRes.matter?.conflictDecision?.outcome).toBe('Cleared');
        expect(convertedMatterRes.matter?.conflictDecision?.sourceRecordId).toBe(cleanEnq.id);

        // R308: Quote conversion conflictDecision is also carried onto matter.conflictDecision when opening a matter from a converted quote
        const convertedFromQuoteMatterRes = await withPageActor(() =>
          saveMatterRecord(
            {
              title: 'Solaris Clean Quote Converted Matter',
              shortDescription: 'Matter created from quote conversion',
              clientId: cleanConv.clientId!,
              instructingContactId: cleanConv.instructingContactId,
              sourceQuoteId: cleanQuote.id,
              practiceAreaId: matterWithOpponent.practiceAreaId,
              workTypeSubcategoryId: matterWithOpponent.workTypeSubcategoryId,
              matterTypeId: matterWithOpponent.matterTypeId,
              billingBasisId: matterWithOpponent.billingBasisId,
              jurisdictionGroupId: matterWithOpponent.jurisdictionGroupId,
              leadFeeEarnerId: 'P-000001',
              supervisingPartnerId: 'P-000001',
            },
            { byId: 'P-000001', saveMode: 'draft' },
          ),
        );
        expect(convertedFromQuoteMatterRes.matter?.conflictDecision).toBeDefined();
        expect(convertedFromQuoteMatterRes.matter?.conflictDecision?.outcome).toBe('Cleared');
        expect(convertedFromQuoteMatterRes.matter?.conflictDecision?.sourceRecordId).toBe(
          cleanQuote.id,
        );
      } finally {
        setTestEntraSessionOverride(undefined);
        resetAllDemoData('P-000001');
      }
    });

    it('finds hits from instructingContactId, billingContactId, additionalClientIds, and person–organisation links in both searches, records searchedSources, and redacts restricted matters in blocked reasons (B7)', () => {
      try {
        resetAllDemoData('P-000001');
        const store = getStore();

        // Create dedicated test records for the 4 new search sources
        const instrPerson = savePersonRecord(
          { firstName: 'Iolo', surname: 'InstructingHit' },
          { byId: 'P-000001' },
        ).person;
        const billPerson = savePersonRecord(
          { firstName: 'Bryn', surname: 'BillingHit' },
          { byId: 'P-000001' },
        ).person;
        const addlClientOrg = store.organisations[1]!;
        const employerOrg = store.organisations[2]!;
        const linkedEmployeePerson = savePersonRecord(
          { firstName: 'Ceri', surname: 'LinkedToOpponentOrg' },
          { byId: 'P-000001' },
        ).person;

        // Link Ceri to employerOrg
        store.links.push({
          id: 'L-S007-TEST',
          personId: linkedEmployeePerson.id,
          organisationId: employerOrg.id,
          jobTitle: 'Director',
          department: 'Board',
          roleWithinOrganisation: 'Director',
          contactRoleIds: [],
          isPrimaryContact: true,
          isCurrent: true,
          startDate: '2025-01-01',
          endDate: null,
          contactStatusId: null,
          createdById: 'P-000001',
          createdAt: '2025-01-01T09:00:00Z',
          updatedById: 'P-000001',
          updatedAt: '2025-01-01T09:00:00Z',
        });

        // Set up an existing visible matter with instructingContactId, billingContactId, additionalClientIds, and employerOrg as Opponent
        const baseMatter = store.matters.find(
          (m) => !m.isStaffMatter && !m.hasEthicalWall,
        )!;
        baseMatter.instructingContactId = instrPerson.id;
        baseMatter.billingContactId = billPerson.id;
        baseMatter.additionalClientIds = [addlClientOrg.id];
        baseMatter.parties.push({
          id: 'MP-S007-OPP',
          name: employerOrg.legalName,
          entityType: 'organisation',
          role: 'Opponent',
          linkedRecordId: employerOrg.id,
        });

        // Verify buildEffectiveConflictParties includes billingContactId
        const builtParties = buildEffectiveConflictParties({
          submittedParties: [],
          clientId: baseMatter.clientId,
          instructingContactId: instrPerson.id,
          billingContactId: billPerson.id,
          people: store.people,
          organisations: store.organisations,
        });
        expect(builtParties.some((p) => p.linkedRecordId === billPerson.id)).toBe(true);

        // 1. searchMatterConflicts finds instructingContactId, billingContactId, additionalClientIds, and person–organisation links
        const matterMatches = searchMatterConflicts(
          {
            currentMatterId: null,
            parties: [
              {
                id: 'cp-1',
                name: `${instrPerson.firstName} ${instrPerson.surname}`,
                entityType: 'person',
                role: 'Opponent',
                linkedRecordId: null,
              },
              {
                id: 'cp-2',
                name: `${billPerson.firstName} ${billPerson.surname}`,
                entityType: 'person',
                role: 'Opponent',
                linkedRecordId: null,
              },
              {
                id: 'cp-3',
                name: addlClientOrg.legalName,
                entityType: 'organisation',
                role: 'Opponent',
                linkedRecordId: null,
              },
              {
                id: 'cp-4',
                name: `${linkedEmployeePerson.firstName} ${linkedEmployeePerson.surname}`,
                entityType: 'person',
                role: 'Client',
                linkedRecordId: linkedEmployeePerson.id,
                isClientFixed: true,
              },
            ],
            canReviewConditions: true,
          },
          {
            matters: store.matters,
            enquiries: store.enquiries,
            people: store.people,
            organisations: store.organisations,
            links: store.links,
            tenantId: 'not-a-law-firm',
            canView: () => true,
            canViewEnquiry: () => true,
          },
        );
        expect(
          matterMatches.some(
            (m) => m.partyId === 'cp-1' && m.whereFound.includes('Instructing contact'),
          ),
        ).toBe(true);
        expect(
          matterMatches.some(
            (m) => m.partyId === 'cp-2' && m.whereFound.includes('Billing contact'),
          ),
        ).toBe(true);
        expect(
          matterMatches.some(
            (m) => m.partyId === 'cp-3' && m.whereFound.includes('Client on'),
          ),
        ).toBe(true);
        expect(
          matterMatches.some(
            (m) =>
              m.partyId === 'cp-4' &&
              m.matchedRecordId === employerOrg.id &&
              m.matterId === baseMatter.id,
          ),
        ).toBe(true);

        // 2. runEnquiryConflictSearch finds all 4 sources and computeEnquiryConflictSnapshot records searchedSources
        const enqCheck = runEnquiryConflictSearch(
          {
            firstName: linkedEmployeePerson.firstName,
            lastName: linkedEmployeePerson.surname,
            callingOnBehalfOf: '',
            otherPartiesNamed: `${instrPerson.firstName} ${instrPerson.surname}, ${billPerson.firstName} ${billPerson.surname}, ${addlClientOrg.legalName}`,
            linkedPersonId: linkedEmployeePerson.id,
          },
          store.people,
          store.organisations,
          store.matters,
          store.values,
          store.enquiries,
          null,
          store.links,
          () => true,
          'not-a-law-firm',
        );
        expect(
          enqCheck.allConflicts.some((h) =>
            h.matchedFields.some((f) => f.includes('instructing contact')),
          ),
        ).toBe(true);
        expect(
          enqCheck.allConflicts.some((h) =>
            h.matchedFields.some((f) => f.includes('billing contact')),
          ),
        ).toBe(true);
        expect(
          enqCheck.otherPartyClientMatches.some((h) => h.recordId === addlClientOrg.id),
        ).toBe(true);
        expect(
          enqCheck.clientAgainstPartyMatches.some((h) =>
            h.matchedFields.some(
              (f) => f.includes('person–organisation link') || f.includes('linked organisation'),
            ),
          ),
        ).toBe(true);

        const snap = computeEnquiryConflictSnapshot(
          {
            firstName: linkedEmployeePerson.firstName,
            lastName: linkedEmployeePerson.surname,
            callingOnBehalfOf: '',
            otherPartiesNamed: addlClientOrg.legalName,
            email: '',
            phone: '',
            postcode: '',
            addressLine1: '',
            addressLine2: '',
          },
          store.people,
          store.organisations,
          store.matters,
          store.values,
          {
            recordedAt: new Date().toISOString(),
            recordedById: 'P-000001',
            enquiries: store.enquiries,
            excludeEnquiryId: null,
            links: store.links,
            canViewMatter: () => true,
            tenantId: 'not-a-law-firm',
          },
        );
        expect(snap.searchedInput.searchedSources).toEqual([...CONFLICT_SEARCHED_SOURCES]);

        // 3. Redaction of restricted matters in blocked reasons for an actor without access
        const restrictedMatter = store.matters.find((m) => m.id !== baseMatter.id)!;
        restrictedMatter.hasEthicalWall = true;
        restrictedMatter.restrictedAccessUserIds = ['P-000001'];
        restrictedMatter.responsiblePartnerId = 'P-000001';
        restrictedMatter.supervisingPartnerId = 'P-000001';
        restrictedMatter.leadFeeEarnerId = 'P-000001';
        restrictedMatter.teamMemberIds = [];
        restrictedMatter.title = 'Ultra Secret Restricted Acquisition';
        restrictedMatter.parties = [
          {
            id: 'MP-SECRET-OPP',
            name: 'Vanguard Secret Counterparty Ltd',
            entityType: 'organisation',
            role: 'Opponent',
            linkedRecordId: null,
          },
        ];

        const templateEnq = store.enquiries.find((e) => e.status !== 'Draft')!;
        const blockedEnqRes = saveEnquiryRecord(
          {
            channelId: templateEnq.channelId,
            firstName: 'Evan',
            lastName: 'BlockedCaller',
            callingOnBehalfOf: 'Vanguard Secret Counterparty Ltd',
            email: 'evan@vanguard.example',
            phone: '029 2018 0777',
            preferredContactMethodId: templateEnq.preferredContactMethodId,
            sourceId: templateEnq.sourceId,
            practiceAreaId: baseMatter.practiceAreaId,
            summary: 'Enquiry hitting restricted matter',
            notes: 'High-level notes for restricted matter hit test.',
            otherPartiesNamed: 'None',
            urgencyId: templateEnq.urgencyId,
            privacyNoticeGiven: true,
          },
          { byId: 'P-000002', asDraft: false },
        );
        const blockedEnq = blockedEnqRes.enquiry!;
        // R280 (R258 follow-up): Quick conflict check recorded audit entry uses action 'conflict-decision' in both main and draft paths
        const mainQuickAudit = store.audit.find(
          (a) =>
            a.recordType === 'enquiry' &&
            a.recordId === blockedEnq.id &&
            a.field === 'Quick conflict check recorded',
        );
        expect(mainQuickAudit).toBeDefined();
        expect(mainQuickAudit?.action).toBe('conflict-decision');

        const draftCheckEnq = saveEnquiryRecord(
          {
            channelId: templateEnq.channelId,
            firstName: 'Draft',
            lastName: 'AuditCaller',
            practiceAreaId: baseMatter.practiceAreaId,
            summary: 'Draft enquiry conflict audit test',
            urgencyId: templateEnq.urgencyId,
          },
          { byId: 'P-000002', asDraft: true },
        ).enquiry!;
        const draftQuickAudit = store.audit.find(
          (a) =>
            a.recordType === 'enquiry' &&
            a.recordId === draftCheckEnq.id &&
            a.field === 'Quick conflict check recorded',
        );
        expect(draftQuickAudit).toBeDefined();
        expect(draftQuickAudit?.action).toBe('conflict-decision');

        // R256, R257 & R290: saveEnquiryRecord stores a redacted restricted hit in conflictSnapshot with a tenant-salted SHA-256 recordId
        expect(blockedEnq.conflictSnapshot).toBeDefined();
        const redactedSnapshotHit = blockedEnq.conflictSnapshot!.conflicts.find(
          (h) => h.name === 'Restricted matter',
        );
        expect(redactedSnapshotHit).toBeDefined();
        expect(redactedSnapshotHit!.recordId).toMatch(/^restricted-[0-9a-f]{16}$/);
        const expectedSha256Prefix = crypto
          .createHash('sha256')
          .update(`not-a-law-firm:${restrictedMatter.id}`)
          .digest('hex')
          .slice(0, 16);
        expect(redactRecordId('not-a-law-firm', restrictedMatter.id)).toBe(expectedSha256Prefix);
        expect(redactedSnapshotHit!.recordId).toBe(`restricted-${expectedSha256Prefix}`);
        expect(redactRecordId('not-a-law-firm', restrictedMatter.id)).not.toBe(
          redactRecordId('pembroke-vaughan', restrictedMatter.id),
        );
        const searchTenantA = runEnquiryConflictSearch(
          { callingOnBehalfOf: 'Vanguard Secret Counterparty Ltd' },
          store.people,
          store.organisations,
          store.matters,
          store.values,
          [],
          null,
          store.links,
          () => false,
          'not-a-law-firm',
        );
        const searchTenantB = runEnquiryConflictSearch(
          { callingOnBehalfOf: 'Vanguard Secret Counterparty Ltd' },
          store.people,
          store.organisations,
          store.matters,
          store.values,
          [],
          null,
          store.links,
          () => false,
          'pembroke-vaughan',
        );
        expect(searchTenantA.allConflicts[0]?.recordId).toMatch(/^restricted-[0-9a-f]{16}$/);
        expect(searchTenantB.allConflicts[0]?.recordId).toMatch(/^restricted-[0-9a-f]{16}$/);
        expect(searchTenantA.allConflicts[0]?.recordId).not.toBe(
          searchTenantB.allConflicts[0]?.recordId,
        );
        // R304: detectPreliminaryConflicts forwards tenantId so client and server hashes match
        const prelimTenantA = detectPreliminaryConflicts(
          { callingOnBehalfOf: 'Vanguard Secret Counterparty Ltd' },
          store.people,
          store.organisations,
          store.matters,
          store.values,
          [],
          null,
          store.links,
          () => false,
          'not-a-law-firm',
        );
        expect(prelimTenantA[0]?.recordId).toBe(searchTenantA.allConflicts[0]?.recordId);
        expect(redactedSnapshotHit!.recordId).not.toContain(restrictedMatter.id);
        expect(JSON.stringify(blockedEnq.conflictSnapshot)).not.toContain(restrictedMatter.id);
        expect(JSON.stringify(blockedEnq.conflictSnapshot)).not.toContain(
          restrictedMatter.matterNumber,
        );
        expect(JSON.stringify(blockedEnq.conflictSnapshot)).not.toContain(
          'Ultra Secret Restricted Acquisition',
        );

        // Fee earner P-000002 cannot view restrictedMatter
        const convDenied = prepareEnquiryConversion(blockedEnq.id, {}, 'P-000002');
        expect(convDenied.ok).toBe(false);
        expect(convDenied.conflictBlocked).toBe(true);
        const combinedReasons = (convDenied.conflictReasons ?? []).join(' | ');
        expect(combinedReasons).toContain('a restricted matter');
        expect(combinedReasons).not.toContain(restrictedMatter.matterNumber);
        expect(combinedReasons).not.toContain('Ultra Secret Restricted Acquisition');
      } finally {
        resetAllDemoData('P-000001');
      }
    });
  });
});
