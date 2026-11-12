import { describe, expect, it, beforeEach, vi } from 'vitest';
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
  TenantConfigurationSchema,
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
  createRecordFromPms,
  deleteLink,
  discussSignOff,
  dismissDuplicateMatch,
  executeMerge,
  getAppSnapshot,
  getClientPmsViewBundle,
  getEmployeeDetailsForUser,
  getMatterPmsViewBundle,
  getMatterRepository,
  getPartyRepository,
  linkPmsRecord,
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
  listAuditEntriesForRecord,
} from '../../src/server/services';
import {
  flushDocumentLifecycleSyncForTesting,
  getRepositorySingleton,
  retryMatterDocumentProvisioning,
} from '../../src/server/documentStoreServices';
import {
  getFirmFinance,
  getMatterFinanceRows,
  getMyFinanceFigures,
} from '../../src/server/financeServices';
import {
  buildFeeEarnerWeeklyTime,
  buildFirmFinanceRollups,
  canUserViewFinance,
} from '../../src/domain/pms';
import { getPmsSource } from '../../src/pms/pmsSource';
import { attentionList } from '../../src/domain/attention';
import { clearStoreMemoryCache, getStore, resetStore } from '../../src/server/store';
import {
  auditEntriesWrittenSince,
  makeVerifiedTestEntraSession,
  runAsTestActor,
  testTenantCtx,
} from '../../src/server/testSupport/auditTestSupport';
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
  flagMatterWriteOffAction,
  linkPmsRecordAction,
  prepareEnquiryConversionAction,
  prepareQuoteConversionAction,
  recordInvoiceCreditControlActionAction,
  reorderChoiceValueAction,
  requestMatterBillAction,
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
  formatConversionConflictWarningsNotice,
  normaliseConversionConflictWarnings,
  redactRecordId,
  searchMatterConflicts,
} from '../../src/domain/matterConflicts';
import { getDocumentRepository } from '../../src/server/documentGenerationServices';
import PersonProfilePage from '../../src/app/people/[id]/page';
import EditPersonPage from '../../src/app/people/[id]/edit/page';
import OrganisationProfilePage from '../../src/app/organisations/[id]/page';
import EditOrganisationPage from '../../src/app/organisations/[id]/edit/page';
import {
  computeEnquiryConflictSnapshot,
  detectPreliminaryConflicts,
  runEnquiryConflictSearch,
} from '../../src/domain/enquiries';
import { canActorAccessMatterRecord } from '../src/domain/document-generation/permissions';
import type { ChoiceValue, Matter, Person, Task, Team } from '../../src/domain/types';
import { testDataResetContext } from '../../src/test/testTenantContexts';

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
  // S0-15: firm audit lives in PostgreSQL audit_entries; each test only inspects entries written
  // after it started. A time window is used because resetAllDemoData re-imports audit_entries and
  // restarts the AU- sequence, so ID-based marks taken before a reset are not reliable.
  let rbacAuditMark = 0;
  const auditSinceTestStart = () => auditEntriesWrittenSince(rbacAuditMark);
  const auditSinceIds = (at: string) => Date.parse(at) >= rbacAuditMark;
  beforeEach(() => {
    clearPermissionRequestCache();
    rbacAuditMark = Date.now();
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

      await repo.putTemplate(ctx, {
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
      await repo.putTemplateVersion(ctx, {
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
      await expect(approveTemplateVersion({
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
        })).rejects.toThrow(/TEMPLATE_SELF_APPROVAL_FORBIDDEN/);
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
    it('enforces self-modification & unheld-grant blocks and logs before/after audit entries', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      const snap0 = await runAsTestActor('P-000001', () => getAppSnapshot('P-000001'));
      const adamAdmin = snap0.people.find((p) => p.roles?.includes('admin'))!;
      expect(adamAdmin).toBeDefined();

      // 1. Self-modification is blocked on the server service
      const selfAttempt = await runAsTestActor(adamAdmin.id, () =>
        updatePersonPermissionOverrides(
          adamAdmin.id,
          {
            grant: ['finance:view'],
            revoke: [],
            reason: 'Trying to modify myself',
          },
          adamAdmin.id,
          { mfaVerified: true },
        ),
      );
      expect(selfAttempt.ok).toBe(false);
      expect(selfAttempt.error).toMatch(/cannot modify their own/i);

      // 1b. Admin without MFA is rejected with MFA_REQUIRED (R53)
      const noMfaAttempt = await runAsTestActor(
        adamAdmin.id,
        () =>
          updatePersonPermissionOverrides(
            'P-000002',
            {
              grant: ['risk:view'],
              revoke: [],
              reason: 'Missing MFA test',
            },
            adamAdmin.id,
          ),
        { mfaVerified: false },
      );
      expect(noMfaAttempt.ok).toBe(false);
      expect(noMfaAttempt.code).toBe('MFA_REQUIRED');

      // 2. Admin grants risk:view and revokes finance:view_matter on Dafydd Evans (P-000002) with Entra Object ID binding
      const validOverride = await runAsTestActor(adamAdmin.id, () =>
        updatePersonPermissionOverrides(
          'P-000002',
          {
            grant: ['risk:view'],
            revoke: ['finance:view_matter'],
            reason: 'Temporary secondment to Compliance review',
            entraObjectId: '8f2e91c0-4a12-4b9e-9c01-dafydd000002',
          },
          adamAdmin.id,
          { mfaVerified: true },
        ),
      );
      expect(validOverride.ok).toBe(true);

      const dafyddSnap = await runAsTestActor('P-000002', () => getAppSnapshot('P-000002'));
      expect(dafyddSnap.currentUserPermissions).toContain('risk:view');
      expect(dafyddSnap.currentUserPermissions).not.toContain(
        'finance:view_matter',
      );
      expect(dafyddSnap.currentUser.entraObjectId).toBe(
        '8f2e91c0-4a12-4b9e-9c01-dafydd000002',
      );

      // Audit entry recorded with before/after JSON
      const auditEntry = (await auditSinceTestStart()).find(
        (a) =>
          a.recordId === 'P-000002' &&
          a.field === 'Permission overrides & Entra ID binding',
      );
      expect(auditEntry).toBeDefined();
      expect(auditEntry?.newValue).toContain('Temporary secondment');

      // 3. Updating Tenant RBAC Config by non-admin is rejected; by admin without MFA is rejected; by admin with MFA succeeds and audits
      const unauthConfigAttempt = await runAsTestActor('P-000002', () =>
        updateTenantRbacConfig(
          {
            departmentGrants: {
              'DEPT-HR': ['employee:view_core'],
            },
          },
          'P-000002',
          { mfaVerified: true },
        ),
      );
      expect(unauthConfigAttempt.ok).toBe(false);
      expect(unauthConfigAttempt.error).toContain('rbac:manage_config');

      const noMfaConfigAttempt = await runAsTestActor(
        adamAdmin.id,
        () =>
          updateTenantRbacConfig(
            {
              departmentGrants: {
                'DEPT-HR': ['employee:view_core'],
              },
            },
            adamAdmin.id,
            { mfaVerified: false },
          ),
        { mfaVerified: false },
      );
      expect(noMfaConfigAttempt.ok).toBe(false);
      expect(noMfaConfigAttempt.code).toBe('MFA_REQUIRED');

      const adminConfigUpdate = await runAsTestActor(adamAdmin.id, () =>
        updateTenantRbacConfig(
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
        ),
      );
      expect(adminConfigUpdate.ok).toBe(true);
      expect(
        adminConfigUpdate.rbacConfig?.identityMapping.entraGroupToRoleKey[
          '11111111-2222-3333-4444-555555555555'
        ],
      ).toEqual(['partner']);
    });

    it('enforces R52, R53, R54, R55, R60, R61, R62, R63, R70 and R71 security invariants', async () => {
      resetStore();
      await resetAllDemoData('P-000001', testDataResetContext());

      // R52: resolveOrProvisionEntraEmployee with roles: [] creates a person without admin and without admin:access
      const unmappedProvision = await resolveOrProvisionEntraEmployee({
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
      const unmappedSnap = await runAsTestActor(unmappedProvision.person.id, () =>
        getAppSnapshot(unmappedProvision.person.id),
      );
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
      const feeEarnerSelfEscalation = await runAsTestActor('P-000002', () =>
        updateEmployeeRolesAndSupports(
          'P-000002',
          { roles: ['admin'] },
          'P-000002',
          { mfaVerified: true },
        ),
      );
      expect(feeEarnerSelfEscalation.ok).toBe(false);
      const adminNoMfaRoleChange = await runAsTestActor(
        'P-000004',
        () =>
          updateEmployeeRolesAndSupports(
            'P-000002',
            { roles: ['partner', 'fee_earner'] },
            'P-000004',
            { mfaVerified: false },
          ),
        { mfaVerified: false },
      );
      expect(adminNoMfaRoleChange.ok).toBe(false);
      expect(adminNoMfaRoleChange.code).toBe('MFA_REQUIRED');
      const feeEarnerAppRoleEscalation = await runAsTestActor('P-000002', () =>
        updateEmployeeRoleSetting(
          'P-000002',
          'admin',
          'P-000002',
          { mfaVerified: true },
        ),
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
      await runAsTestActor('P-000004', () =>
        updateTenantRbacConfig(
          {
            identityMapping: {
              ...getDefaultTenantRbacConfig().identityMapping,
              authorityMode: 'token_only',
            },
          },
          'P-000004',
          { mfaVerified: true },
        ),
      );
      const firstTokenSignIn = await resolveOrProvisionEntraEmployee({
        oid: '00000000-0000-4000-8000-000000000601',
        tid: '00000000-0000-4000-8000-000000000099',
        sub: 'sub-601',
        name: 'Token Only User',
        email: 'token.only@notalawfirm.example',
        roles: ['1Squared.Admin'],
        amr: ['pwd', 'mfa'],
      });
      expect(firstTokenSignIn.person.roles).toContain('admin');
      const secondTokenSignIn = await resolveOrProvisionEntraEmployee({
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
      const tokenOnlySnap = await runAsTestActor(secondTokenSignIn.person.id, () =>
        getAppSnapshot(secondTokenSignIn.person.id),
      );
      expect(tokenOnlySnap.currentUserPermissions).not.toContain('admin:access');

      // R61 (hybrid mode): Under hybrid authorityMode, token-derived roles apply for the current session
      // without mutating the stored person.roles on the employee record.
      await runAsTestActor('P-000004', () =>
        updateTenantRbacConfig(
          {
            identityMapping: {
              ...getDefaultTenantRbacConfig().identityMapping,
              authorityMode: 'hybrid',
            },
          },
          'P-000004',
          { mfaVerified: true },
        ),
      );
      await runWithActiveActorSession(
        {
          tenantId: 'not-a-law-firm',
          personId: 'P-000002',
          tokenRoles: [],
          expiresAtMs: Date.now() + 3600_000,
        },
        async () => {
          const hybridSignIn = await resolveOrProvisionEntraEmployee({
            oid: '00000000-0000-4000-8000-000000000002',
            tid: '00000000-0000-4000-8000-000000000099',
            sub: 'sub-002',
            name: 'Dafydd Evans',
            preferred_username: 'dafydd.evans@notalawfirm.example',
            email: 'dafydd.evans@notalawfirm.example',
            roles: ['1Squared.RiskCompliance'],
            amr: ['pwd', 'mfa'],
          });
          expect(hybridSignIn.person.id).toBe('P-000002');
          // Stored employee roles remain ['fee_earner'] and do not permanently gain 'risk_compliance'
          expect(hybridSignIn.person.roles).toEqual(['fee_earner']);
          // Yet the active session permission set includes risk_compliance permissions (e.g. 'risk:view')
          const hybridSnap = await runWithActiveActorSession(
            {
              tenantId: 'not-a-law-firm',
              personId: 'P-000002',
              tokenRoles: hybridSignIn.verifiedToken.roles,
              expiresAtMs: Date.now() + 3600_000,
              verifiedSession: makeVerifiedTestEntraSession('P-000002', {
                roles: hybridSignIn.verifiedToken.roles,
              }),
            },
            async () => getAppSnapshot('P-000002'),
          );
          expect(hybridSnap.currentUserPermissions).toContain('risk:view');
          // When the subsequent session has no token roles, the user falls back to stored ['fee_earner'] roles only
          const subsequentSignIn = await resolveOrProvisionEntraEmployee({
            oid: '00000000-0000-4000-8000-000000000002',
            tid: '00000000-0000-4000-8000-000000000099',
            sub: 'sub-002',
            name: 'Dafydd Evans',
            email: 'dafydd.evans@notalawfirm.example',
            roles: [],
            amr: ['pwd', 'mfa'],
          });
          const hybridAfterSnap = await runWithActiveActorSession(
            {
              tenantId: 'not-a-law-firm',
              personId: 'P-000002',
              tokenRoles: subsequentSignIn.verifiedToken.roles,
              expiresAtMs: Date.now() + 3600_000,
              verifiedSession: makeVerifiedTestEntraSession('P-000002', {
                roles: subsequentSignIn.verifiedToken.roles,
              }),
            },
            async () => getAppSnapshot('P-000002'),
          );
          expect(hybridAfterSnap.currentUserPermissions).not.toContain(
            'risk:view',
          );
        },
      );

      // R63: getAppSnapshot(riskUser).employeeSensitiveRecords is empty; per-person read writes a view-sensitive audit entry
      const riskSnap = await runAsTestActor('P-000003', () => getAppSnapshot('P-000003'));
      expect(riskSnap.employeeSensitiveRecords).toEqual({});
      await runAsTestActor('P-000004', () =>
        logEmployeeRestrictedAccess('P-000002', 'sensitive', 'P-000004', 'Viewed sensitive HR tab'),
      );
      const afterSensitiveAudit = (
        await runAsTestActor('P-000004', () =>
          listAuditEntriesForRecord('employee_sensitive', 'P-000002', 'P-000004', { limit: 1000 }),
        )
      ).filter((a) => auditSinceIds(a.at));
      expect(
        afterSensitiveAudit.some(
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
      expect((await getAppSnapshot('P-000002')).homePagesConfig.firmSettings.demoMode).toBe(
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

      await resetAllDemoData('P-000001', testDataResetContext());
    });

    it('enforces R100 request/tenant-scoped token roles without cross-tenant, post-logout, or cross-user leakage', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());

      await runAsTestActor('P-000004', () =>
        updateTenantRbacConfig(
          {
            identityMapping: {
              ...getDefaultTenantRbacConfig().identityMapping,
              authorityMode: 'hybrid',
            },
          },
          'P-000004',
          { mfaVerified: true },
        ),
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

      const dafydd = (
        await runAsTestActor('P-000002', () => getAppSnapshot('P-000002'))
      ).people.find((p) => p.id === 'P-000002')!;
      const carys = (
        await runAsTestActor('P-000001', () => getAppSnapshot('P-000001'))
      ).people.find((p) => p.id === 'P-000001')!;
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
        await runWithActiveActorSession(
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
        await runWithActiveActorSession(
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
          await runWithActiveActorSession(
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
          await runWithActiveActorSession(
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
      const entraOnlyAdmin = (await getPartyRepository().getPersonById<Person>(
        testDataResetContext(),
        'P-000002',
      ))!;
      const prevRoles = entraOnlyAdmin.roles;
      const prevAppRole = entraOnlyAdmin.appRole;
      try {
        entraOnlyAdmin.roles = [];
        delete entraOnlyAdmin.appRole;
        await getPartyRepository().putPerson(testDataResetContext(), entraOnlyAdmin);
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
        await getPartyRepository().putPerson(testDataResetContext(), entraOnlyAdmin);
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
      await resetAllDemoData('P-000001', testDataResetContext());
    });

    it('provisions or links an employee on Entra ID OIDC callback and creates a signed session cookie', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());

      const { person, verifiedToken, rbacConfig } =
        await resolveOrProvisionEntraEmployee({
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
      const secondSignIn = await resolveOrProvisionEntraEmployee({
        oid: '99999999-aaaa-bbbb-cccc-000000000001',
        tid: '11111111-2222-3333-4444-000000000000',
        name: 'Dev Admin User',
        email: 'dev.admin@notalawfirm.example',
        roles: ['1Squared.Admin'],
        amr: ['pwd', 'mfa'],
      });
      expect(secondSignIn.person.id).toBe(person.id);

      await resetAllDemoData('P-000001', testDataResetContext());
    });

    it('refuses Demo Mode persona switching to an employee with access to a restricted/staff matter not accessible to the signed-in actor (R104)', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      const rawBase = getActiveTenantRawBaseConfig();
      setActiveTenantConfigForTesting({
        ...rawBase,
        featureFlags: {
          ...((rawBase.featureFlags as Record<string, unknown>) ?? {}),
          enableDemoMode: true,
        },
      });

      try {
        const ctx = testDataResetContext();
        // Use a demo: true target persona (P-000002 marked demo: true with equal fee_earner permissions)
        const targetPersona = (await getPartyRepository().getPersonById<Person>(ctx, 'P-000002'))!;
        targetPersona.demo = true;
        targetPersona.roles = ['fee_earner'];
        targetPersona.appRole = 'fee_earner';
        await getPartyRepository().putPerson(ctx, targetPersona);

        const signedInFeeEarner = (await getPartyRepository().getPersonById<Person>(ctx, 'P-000006'))!;
        signedInFeeEarner.roles = ['fee_earner'];
        signedInFeeEarner.appRole = 'fee_earner';
        await getPartyRepository().putPerson(ctx, signedInFeeEarner);

        // Mark the first matter as a restricted staff matter where P-000002 is on restrictedAccessUserIds, and P-000006 is not
        const staffMatter = (await getMatterRepository().listAllMatters<Matter>(ctx))[0]!;
        staffMatter.isStaffMatter = true;
        staffMatter.restrictedAccessUserIds = ['P-000001', 'P-000002'];
        await getMatterRepository().putMatter(ctx, staffMatter, { expectedRowVersion: null });

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
        await resetAllDemoData('P-000001', testDataResetContext());
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

    it('enforces R106, R123, and R130: server-computed snapshot maps (canTakeByTaskId, permissionsByPersonId, firmPrimaryDomain) and audited sensitive employee reads', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
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
        const partnerSnap = await runAsTestActor('P-000001', () => getAppSnapshot('P-000001'));
        const feeEarnerSnap = await runAsTestActor('P-000002', () => getAppSnapshot('P-000002'));
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

        const deniedRead = await runAsTestActor('P-000006', () =>
          getEmployeeDetailsForUser('P-000002', 'P-000006', {
            logViewSensitive: true,
          }),
        );
        expect(deniedRead.sensitive).toBeNull();
        expect(deniedRead.errors?.sensitivePermission).toBeDefined();

        const unauditedRead = await runAsTestActor('P-000004', () =>
          getEmployeeDetailsForUser('P-000002', 'P-000004', {
            logViewSensitive: false,
          }),
        );
        expect(unauditedRead.sensitive).toBeNull();

        const auditedRead = await runAsTestActor('P-000004', () =>
          getEmployeeDetailsForUser('P-000002', 'P-000004', {
            logViewSensitive: true,
          }),
        );
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
        const previewRes = await runAsTestActor(
          'P-000004',
          () =>
            previewRbacOverrides(
              'P-000002',
              {
                grant: ['risk:view'],
                revoke: ['matter:create'],
              },
              'P-000004',
              { mfaVerified: true },
            ),
          { mfaVerified: true },
        );
        expect(previewRes.ok).toBe(true);
        expect(previewRes.permissions).toContain('risk:view');
        expect(previewRes.permissions).not.toContain('matter:create');

        // Fee earner (P-000002) is refused
        const previewFeeEarner = await runAsTestActor(
          'P-000002',
          () =>
            previewRbacOverrides(
              'P-000002',
              { grant: ['risk:view'], revoke: [] },
              'P-000002',
              { mfaVerified: true },
            ),
          { mfaVerified: true },
        );
        expect(previewFeeEarner.ok).toBe(false);

        // Missing MFA (mfaVerified: false) is refused with MFA_REQUIRED
        const previewNoMfa = await runAsTestActor(
          'P-000004',
          () =>
            previewRbacOverrides(
              'P-000002',
              { grant: ['risk:view'], revoke: [] },
              'P-000004',
              { mfaVerified: false },
            ),
          { mfaVerified: false },
        );
        expect(previewNoMfa.ok).toBe(false);
        expect(previewNoMfa.error).toMatch(/MFA_REQUIRED/);

        // Invalid rbacConfig is refused by validateRbacConfig
        const previewInvalidConfig = await runAsTestActor(
          'P-000004',
          () =>
            previewRbacOverrides(
              'P-000002',
              {
                grant: [],
                revoke: [],
                rbacConfig: 'not-an-object' as unknown as import('@/domain/rbac').RbacConfiguration,
              },
              'P-000004',
              { mfaVerified: true },
            ),
          { mfaVerified: true },
        );
        expect(previewInvalidConfig.ok).toBe(false);
        expect(previewInvalidConfig.error).toMatch(/RBAC_CONFIG_INVALID/);
      } finally {
        await resetAllDemoData('P-000001', testDataResetContext());
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
    beforeEach(async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
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
          expect(mpReset.message).toBe(
            "[FORBIDDEN] Permission 'admin:data_reset' is required to resetDemoDataAction.",
          );
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
          expect(noMfaClear.message).toBe(
            "[MFA_REQUIRED] Multi-factor authentication (MFA) is required for administrative permission 'admin:data_reset' (clearAllDataAction).",
          );
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
          await getPartyRepository().putPeople(testDataResetContext(), getStore().people);
          const liveReset = await resetDemoDataAction();
          expect(isActionDenied(liveReset)).toBe(true);
          if (isActionDenied(liveReset)) {
            expect(liveReset.code).toBe('FORBIDDEN');
            expect(liveReset.message).toBe(
              'Demo data reset is disabled in the live environment.',
            );
          }
          const liveClear = await clearAllDataAction();
          expect(isActionDenied(liveClear)).toBe(true);
          if (isActionDenied(liveClear)) {
            expect(liveClear.code).toBe('FORBIDDEN');
            expect(liveClear.message).toBe(
              'Clearing all data is disabled in the live environment.',
            );
          }
        } finally {
          process.env.PLATFORM_ENVIRONMENT = prevEnv;
          setActiveTenantConfigForTesting(null);
        }

        // Non-live environment with enableDemoMode=false is also denied with its own reason
        const flagOffReset = await resetDemoDataAction();
        expect(isActionDenied(flagOffReset)).toBe(true);
        if (isActionDenied(flagOffReset)) {
          expect(flagOffReset.code).toBe('FORBIDDEN');
          expect(flagOffReset.message).toBe(
            'Demo data reset is disabled when enableDemoMode is false.',
          );
        }
        const flagOffClear = await clearAllDataAction();
        expect(isActionDenied(flagOffClear)).toBe(true);
        if (isActionDenied(flagOffClear)) {
          expect(flagOffClear.code).toBe('FORBIDDEN');
          expect(flagOffClear.message).toBe(
            'Clearing all data is disabled when enableDemoMode is false.',
          );
        }

        // Admin with MFA in test environment with enableDemoMode=true succeeds and writes data-reset / data-cleared audit entries with actor name & ID
        setActiveTenantConfigForTesting(null, {
          featureFlags: { enableDemoMode: true },
        });
        const okReset = await resetDemoDataAction();
        expect(isActionDenied(okReset)).toBe(false);
        const resetAudit = (await auditSinceTestStart()).find(
          (a) => a.action === 'data-reset',
        );
        expect(resetAudit).toBeDefined();
        expect(resetAudit?.byId).toBe('P-000004');
        expect(resetAudit?.newValue).toContain('Huw Pritchard');

        const okClear = await clearAllDataAction();
        expect(isActionDenied(okClear)).toBe(false);
        expect(await getPartyRepository().listAllPeople(testDataResetContext())).toHaveLength(0);
        const clearAudit = (await auditSinceTestStart()).find(
          (a) => a.action === 'data-cleared',
        );
        expect(clearAudit).toBeDefined();
        expect(clearAudit?.byId).toBe('P-000004');
        expect(clearAudit?.newValue).toContain('Huw Pritchard');
      } finally {
        await resetAllDemoData('P-000001', testDataResetContext());
        setTestEntraSessionOverride(undefined);
        setActiveTenantConfigForTesting(null);
      }
    });

    it('1b. approveSignOff and discussSignOff enforce signoff:approve, matter access, assignedPartnerId, no self-approval, status checks, and audit discussSignOff', async () => {
      const store = getStore();
      const ctx = testDataResetContext();
      // SO-000001: requestedById P-000002, assignedPartnerId P-000001, matterId M-000002, status Pending
      // 1. Fee earner (P-000002) lacks signoff:approve
      const feApprove = await runAsTestActor('P-000002', () =>
        approveSignOff('SO-000001', 'P-000002'),
      );
      expect(isActionDenied(feApprove)).toBe(true);

      // 2. Partner who is NOT assignedPartnerId (P-000005 is another partner) is denied when assignedPartnerId is set
      const otherPartnerApprove = await runAsTestActor('P-000005', () =>
        approveSignOff('SO-000001', 'P-000005'),
      );
      expect(isActionDenied(otherPartnerApprove)).toBe(true);
      if (isActionDenied(otherPartnerApprove)) {
        expect(otherPartnerApprove.message).toMatch(/assigned partner/i);
      }

      // 3. No self-approval even when actor holds signoff:approve and assignedPartnerId matches or is null
      const item1 = store.signOffs.find((s) => s.id === 'SO-000001')!;
      item1.requestedById = 'P-000001';
      const selfApprove = await runAsTestActor('P-000001', () =>
        approveSignOff('SO-000001', 'P-000001'),
      );
      expect(isActionDenied(selfApprove)).toBe(true);
      if (isActionDenied(selfApprove)) {
        expect(selfApprove.message).toMatch(/self-approval/i);
      }
      const selfDiscuss = await runAsTestActor('P-000001', () =>
        discussSignOff('SO-000001', 'Self note', 'P-000001'),
      );
      expect(isActionDenied(selfDiscuss)).toBe(true);
      item1.requestedById = 'P-000002';

      // 4. Restricted linked matter that the assigned partner cannot access is denied
      const linkedMatter = (await getMatterRepository().getMatterById<Matter>(ctx, item1.matterId!))!;
      linkedMatter.hasEthicalWall = true;
      linkedMatter.restrictedAccessUserIds = ['P-000005'];
      linkedMatter.responsiblePartnerId = 'P-000005';
      linkedMatter.supervisingPartnerId = 'P-000005';
      linkedMatter.leadFeeEarnerId = 'P-000005';
      linkedMatter.teamMemberIds = ['P-000005'];
      await getMatterRepository().putMatter(ctx, linkedMatter, { expectedRowVersion: null });
      const wallDenied = await runAsTestActor('P-000001', () =>
        approveSignOff('SO-000001', 'P-000001'),
      );
      expect(isActionDenied(wallDenied)).toBe(true);
      if (isActionDenied(wallDenied)) {
        expect(wallDenied.message).toMatch(/matter/i);
      }
      linkedMatter.hasEthicalWall = false;
      linkedMatter.restrictedAccessUserIds = [];
      linkedMatter.responsiblePartnerId = 'P-000001';
      linkedMatter.supervisingPartnerId = 'P-000001';
      await getMatterRepository().putMatter(ctx, linkedMatter, { expectedRowVersion: null });

      // 5. discussSignOff writes an audit entry and transitions status to Discussing
      const discRes = await runAsTestActor('P-000001', () =>
        discussSignOff('SO-000001', 'Need client confirmation first', 'P-000001'),
      );
      expect(isActionDenied(discRes)).toBe(false);
      expect(item1.status).toBe('Discussing');
      const discAudit = (await auditSinceTestStart()).find(
        (a) =>
          a.field === 'Partner sign-off' &&
          a.newValue?.includes('Discussing: Write-off'),
      );
      expect(discAudit).toBeDefined();

      // 6. When assignedPartnerId is null, any holder of signoff:approve (who is not requestedById and can access the matter) may approve
      item1.assignedPartnerId = null;
      const unassignedApprove = await runAsTestActor('P-000038', () =>
        approveSignOff('SO-000001', 'P-000038'),
      );
      expect(isActionDenied(unassignedApprove)).toBe(false);
      expect(item1.status).toBe('Approved');

      // 7. Re-approving or discussing an already Approved sign-off is denied
      const reApprove = await runAsTestActor('P-000038', () =>
        approveSignOff('SO-000001', 'P-000038'),
      );
      expect(isActionDenied(reApprove)).toBe(true);
      const reDiscuss = await runAsTestActor('P-000038', () =>
        discussSignOff('SO-000001', 'Too late', 'P-000038'),
      );
      expect(isActionDenied(reDiscuss)).toBe(true);
    });

    it('1c (B3). anonymiseExpiredEnquiries requires enquiry:anonymise and enforces isReadyForRetentionAnonymisation for single enquiries as well as bulk', async () => {
      const store = getStore();
      // Fee earner (P-000002) is denied enquiry:anonymise
      await expect(
        runAsTestActor('P-000002', () => anonymiseExpiredEnquiries('P-000002')),
      ).rejects.toThrow(AuthorisationError);

      // Find a closed unconverted enquiry that is RECENT (not past retentionMonths)
      const closedEnq = store.enquiries.find(
        (e) => e.status === 'Declined' && !e.anonymisedAt,
      )!;
      closedEnq.receivedAt = new Date().toISOString();
      const origFirstName = closedEnq.firstName;

      // Single-enquiry call with Risk & Compliance (P-000003) must NOT anonymise a recent closed enquiry (B3 regression)
      const prematureCount = await runAsTestActor('P-000003', () =>
        anonymiseExpiredEnquiries('P-000003', closedEnq.id),
      );
      expect(prematureCount).toBe(0);
      expect(closedEnq.firstName).toBe(origFirstName);
      expect(closedEnq.anonymisedAt).toBeNull();

      // Move receivedAt past retention period (24 months ago) -> now single-enquiry call anonymises it
      const twoYearsAgo = new Date();
      twoYearsAgo.setMonth(twoYearsAgo.getMonth() - 24);
      closedEnq.receivedAt = twoYearsAgo.toISOString();
      const expiredCount = await runAsTestActor('P-000003', () =>
        anonymiseExpiredEnquiries('P-000003', closedEnq.id),
      );
      expect(expiredCount).toBe(1);
      expect(closedEnq.firstName).toBe('Anonymised');
      expect(closedEnq.anonymisedAt).toBeTruthy();
    });

    it('1d. remindTeamLeadOverdueCompliance requires risk:view', async () => {
      // Fee earner (P-000002) lacks risk:view
      const denied = await runAsTestActor('P-000002', () =>
        remindTeamLeadOverdueCompliance('TM-000001', 'P-000002'),
      );
      expect(isActionDenied(denied)).toBe(true);

      // Risk & compliance (P-000003) has risk:view
      const allowed = await runAsTestActor('P-000003', () =>
        remindTeamLeadOverdueCompliance('TM-000001', 'P-000003'),
      );
      expect(isActionDenied(allowed)).toBe(false);
      expect(allowed.ok).toBe(true);
    });

    it('1e (B11). savePersonRecord rejects security field mutations, enforces employee:edit_core on legacy/leaver paths, enforces contact:create/edit, and preserves entraObjectId', async () => {
      const ctx = testDataResetContext();
      const allPeople = await getPartyRepository().listAllPeople<Person>(ctx);
      const feeEarner = allPeople.find((p) => p.id === 'P-000002')!;

      // 1. A fee earner cannot add admin to their own roles by saving their person record
      const selfEscalateRes = await runAsTestActor(feeEarner.id, () =>
        savePersonRecord(
          {
            firstName: feeEarner.firstName,
            surname: feeEarner.surname,
            roles: ['fee_earner', 'admin'],
          },
          { id: feeEarner.id, byId: feeEarner.id },
        ),
      );
      expect(isActionDenied(selfEscalateRes)).toBe(true);
      expect(
        (await getPartyRepository().getPersonById<Person>(ctx, feeEarner.id))?.roles,
      ).not.toContain('admin');

      // Also rejected when spreading existing person and mutating roles or permissionOverrides
      const spreadEscalateRes = await runAsTestActor(feeEarner.id, () =>
        savePersonRecord(
          {
            ...feeEarner,
            permissionOverrides: { grant: ['admin:access'], revoke: [] },
          },
          { id: feeEarner.id, byId: feeEarner.id },
        ),
      );
      expect(isActionDenied(spreadEscalateRes)).toBe(true);

      // 2. worksAtFirm: false without employee:edit_core is denied
      const leaverWithoutPermRes = await runAsTestActor(feeEarner.id, () =>
        savePersonRecord(
          {
            firstName: feeEarner.firstName,
            surname: feeEarner.surname,
          },
          { id: feeEarner.id, byId: feeEarner.id, worksAtFirm: false },
        ),
      );
      expect(isActionDenied(leaverWithoutPermRes)).toBe(true);
      expect(leaverWithoutPermRes.errors?.permission).toMatch(/employee:edit_core/);

      // Legacy isEmployee: true without rawEmpInput and without employee:edit_core is also denied
      const legacyEmpCreateDenied = await runAsTestActor(feeEarner.id, () =>
        savePersonRecord(
          {
            firstName: 'Unauthorised',
            surname: 'Hire',
            isEmployee: true,
            employeeRoleId: 'employee_role.fee_earner',
          },
          { byId: feeEarner.id },
        ),
      );
      expect(isActionDenied(legacyEmpCreateDenied)).toBe(true);

      // 3. Contact create without contact:create (Finance P-000009 lacks contact:create and contact:edit) is denied
      const finCreateContact = await runAsTestActor('P-000009', () =>
        savePersonRecord(
          {
            firstName: 'Invented',
            surname: 'Prospect',
          },
          { byId: 'P-000009' },
        ),
      );
      expect(isActionDenied(finCreateContact)).toBe(true);
      expect(finCreateContact.errors?.permission).toMatch(/contact:create/);

      // Contact edit without contact:edit is denied
      const existingContact = allPeople.find((p) => !p.isEmployee && !p.employment)!;
      const finEditContact = await runAsTestActor('P-000009', () =>
        savePersonRecord(
          {
            firstName: existingContact.firstName,
            surname: 'ChangedByFinance',
          },
          { id: existingContact.id, byId: 'P-000009' },
        ),
      );
      expect(isActionDenied(finEditContact)).toBe(true);
      expect(finEditContact.errors?.permission).toMatch(/contact:edit/);

      // 4. entraObjectId survives a save
      feeEarner.entraObjectId = '00000000-0000-4000-8000-000000000002';
      await getPartyRepository().putPerson(ctx, feeEarner);
      const partnerUpdateRes = await runAsTestActor('P-000001', () =>
        savePersonRecord(
          {
            firstName: feeEarner.firstName,
            surname: feeEarner.surname,
            preferredName: 'Daf',
          },
          { id: feeEarner.id, byId: 'P-000001' },
        ),
      );
      expect(isActionDenied(partnerUpdateRes)).toBe(false);
      expect(partnerUpdateRes.errors).toBeUndefined();
      expect(partnerUpdateRes.person.entraObjectId).toBe(
        '00000000-0000-4000-8000-000000000002',
      );

      // 5 (R252). savePersonAction strips caller-supplied internalSystemStep so a user without contact:create/edit cannot bypass the check
      const riskOfficer = allPeople.find((p) => p.id === 'P-000003')!;
      const savedOverrides = riskOfficer.permissionOverrides;
      riskOfficer.permissionOverrides = {
        grant: ['employee:edit_core'],
        revoke: ['contact:create', 'contact:edit'],
      };
      await getPartyRepository().putPerson(ctx, riskOfficer);
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
        await getPartyRepository().putPerson(ctx, riskOfficer);
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
        await resetAllDemoData('P-000001', testDataResetContext());
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
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });

    it('enforces employee:edit_core and matter:create on createRecordFromPmsAction and prevents self-escalation into team leadIds', async () => {
      try {
        await resetAllDemoData('P-000001', testDataResetContext());
        const store = getStore();
        const ctx = testDataResetContext();
        const adminPerson = (await getPartyRepository().getPersonById<Person>(ctx, 'P-000004'))!;

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
        await getPartyRepository().putPerson(ctx, adminPerson);
        store.pmsLinks = store.pmsLinks.filter((l) => l.entityType !== 'employee');
        const peopleCountBefore = (await getPartyRepository().listAllPeople(ctx)).length;
        const empFromPmsDenied = await createRecordFromPmsAction('employee', 'FE01');
        expect(isActionDenied(empFromPmsDenied)).toBe(true);
        expect(empFromPmsDenied.ok).toBe(false);
        expect(empFromPmsDenied.error).toMatch(/employee:edit_core/i);
        expect((await getPartyRepository().listAllPeople(ctx)).length).toBe(peopleCountBefore);

        // Revoke matter:create on adminPerson -> createRecordFromPmsAction('matter', ...) is denied
        adminPerson.permissionOverrides = {
          grant: [],
          revoke: ['matter:create'],
        };
        await getPartyRepository().putPerson(ctx, adminPerson);
        store.pmsLinks = store.pmsLinks.filter((l) => l.entityType !== 'matter');
        const mattersCountBefore = (await getMatterRepository().listAllMatters(ctx)).length;
        const matterFromPmsDenied = await createRecordFromPmsAction(
          'matter',
          'MAT-PMS-001',
        );
        expect(isActionDenied(matterFromPmsDenied)).toBe(true);
        expect(matterFromPmsDenied.ok).toBe(false);
        expect(matterFromPmsDenied.error).toMatch(/matter:create/i);
        expect((await getMatterRepository().listAllMatters(ctx)).length).toBe(mattersCountBefore);
      } finally {
        setTestEntraSessionOverride(undefined);
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });
  });

  describe('20. S0-05 Record Actions: Tasks, Enquiries, Quotes, Notes, and Leaver Reassignment (B8, B9, Item 13)', () => {
    it('denies task comment, task save, and task reassign on restricted matters or when not a team lead (B9)', async () => {
      try {
        await resetAllDemoData('P-000001', testDataResetContext());
        const store = getStore();
        const ctx = testDataResetContext();
        // Create an ethical wall matter visible only to P-000001
        const wallMatter = (await getMatterRepository().getMatterById<Matter>(ctx, 'M-000001'))!;
        wallMatter.hasEthicalWall = true;
        wallMatter.restrictedAccessUserIds = ['P-000001'];
        wallMatter.responsiblePartnerId = 'P-000001';
        wallMatter.supervisingPartnerId = 'P-000001';
        wallMatter.leadFeeEarnerId = 'P-000001';
        wallMatter.teamMemberIds = [];
        await getMatterRepository().putMatter(ctx, wallMatter, { expectedRowVersion: null });

        // Create a task linked to that restricted matter
        const createRes = await runAsTestActor('P-000001', () =>
          saveTaskRecord(
            {
              title: 'Confidential wall task',
              dueAt: '2026-12-01',
              assignedPersonId: 'P-000001',
              linkedRecords: [{ recordType: 'matter', recordId: wallMatter.id }],
            },
            'P-000001',
          ),
        );
        expect(createRes.task).toBeDefined();
        const wallTask = createRes.task!;

        // Fee earner P-000002 (not on allowlist) cannot see the task in getAppSnapshot
        const snapFeeEarner = await runAsTestActor('P-000002', () =>
          getAppSnapshot('P-000002'),
        );
        expect(snapFeeEarner.tasks.some((t) => t.id === wallTask.id)).toBe(false);

        // B9: P-000002 cannot comment on a task linked to a restricted matter
        const commentDenied = await runAsTestActor('P-000002', () =>
          addTaskCommentRecord(
            wallTask.id,
            'Attempted comment on restricted matter task',
            'P-000002',
          ),
        );
        expect(isActionDenied(commentDenied)).toBe(true);

        // P-000002 cannot link a new task to the restricted matter
        const linkRestrictedDenied = await runAsTestActor('P-000002', () =>
          saveTaskRecord(
            {
              title: 'Probe restricted matter',
              dueAt: '2026-12-01',
              assignedPersonId: 'P-000002',
              linkedRecords: [{ recordType: 'matter', recordId: wallMatter.id }],
            },
            'P-000002',
          ),
        );
        expect(isActionDenied(linkRestrictedDenied)).toBe(true);

        // Non-lead fee earner (P-000002) cannot reassign a task created by and assigned to P-000001
        const teamWithoutP2Lead = store.teams.find((t) => !t.leadIds.includes('P-000002'))!;
        const normalTaskRes = await runAsTestActor('P-000001', () =>
          saveTaskRecord(
            {
              title: 'Normal team task',
              dueAt: '2026-12-01',
              assignedPersonId: 'P-000001',
              assignedTeamId: teamWithoutP2Lead.id,
            },
            'P-000001',
          ),
        );
        const normalTask = normalTaskRes.task!;
        const reassignDenied = await runAsTestActor('P-000002', () =>
          saveTaskRecord(
            {
              id: normalTask.id,
              title: normalTask.title,
              dueAt: normalTask.dueAt,
              assignedPersonId: 'P-000002',
              assignedTeamId: normalTask.assignedTeamId,
            },
            'P-000002',
          ),
        );
        expect(isActionDenied(reassignDenied)).toBe(true);
      } finally {
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });

    it('enforces reopenEnquiryRecord rules and preserves unassigned status as New when unassigned (B8)', async () => {
      try {
        await resetAllDemoData('P-000001', testDataResetContext());
        const store = getStore();
        const openEnq = store.enquiries.find((e) => e.status === 'New' || e.status === 'Assigned')!;

        // 1. Reopening an already-open enquiry is denied
        const reopenOpenDenied = await runAsTestActor('P-000001', () =>
          reopenEnquiryRecord(openEnq.id, 'P-000001'),
        );
        expect(isActionDenied(reopenOpenDenied)).toBe(true);

        // 2. Reopening a Converted enquiry is denied
        const convertedEnq = store.enquiries.find((e) => e.status === 'Converted') ?? openEnq;
        convertedEnq.status = 'Converted';
        const reopenConvertedDenied = await runAsTestActor('P-000001', () =>
          reopenEnquiryRecord(convertedEnq.id, 'P-000001'),
        );
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
        const ctx = testDataResetContext();
        const allPeople = await getPartyRepository().listAllPeople<Person>(ctx);
        const nonLeadFeeEarner = allPeople.find(
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
        await getPartyRepository().putPerson(ctx, nonLeadFeeEarner);
        const reopenByNonLead = await runAsTestActor(nonLeadFeeEarner.id, () =>
          reopenEnquiryRecord(closedEnq.id, nonLeadFeeEarner.id),
        );
        expect(isActionDenied(reopenByNonLead)).toBe(true);

        // Team lead with enquiry:reopen revoked is refused (R267)
        const teamLeadPerson = allPeople.find((p) => p.id === teamLeadId)!;
        teamLeadPerson.permissionOverrides = {
          grant: [],
          revoke: ['enquiry:reopen'],
        };
        await getPartyRepository().putPerson(ctx, teamLeadPerson);
        const reopenNoPerm = await runAsTestActor(teamLeadId, () =>
          reopenEnquiryRecord(closedEnq.id, teamLeadId),
        );
        expect(isActionDenied(reopenNoPerm)).toBe(true);
        teamLeadPerson.permissionOverrides = undefined;
        await getPartyRepository().putPerson(ctx, teamLeadPerson);

        // Team lead reopens unassigned closed enquiry -> status becomes 'New' and assignedToId stays null (B8)
        const reopenedRes = await runAsTestActor(teamLeadId, () =>
          reopenEnquiryRecord(closedEnq.id, teamLeadId),
        );
        expect(isActionDenied(reopenedRes)).toBe(false);
        expect(reopenedRes.enquiry?.status).toBe('New');
        expect(reopenedRes.enquiry?.assignedToId).toBeNull();
      } finally {
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });

    it('denies quote viewing and editing for the finance role, and hides quotes linked to hidden enquiries or restricted matters (quote:view, quote:edit, R267)', async () => {
      try {
        await resetAllDemoData('P-000001', testDataResetContext());
        const store = getStore();
        const financeUser = store.people.find(
          (p) => p.isEmployee && p.roles?.includes('finance') && !p.roles?.includes('partner'),
        )!;
        expect(financeUser).toBeDefined();

        // Finance user does not hold quote:view -> getAppSnapshot returns empty quotes
        const snap = await runAsTestActor(financeUser.id, () =>
          getAppSnapshot(financeUser.id),
        );
        expect(snap.currentUserPermissions).not.toContain('quote:view');
        expect(snap.currentUserPermissions).not.toContain('quote:edit');
        expect(snap.quotes).toEqual([]);

        // R267: Fee earner P-000002 holds quote:view, but quotes linked to a restricted matter or hidden enquiry are hidden
        const ctx = testDataResetContext();
        const wallMatter = (await getMatterRepository().listAllMatters<Matter>(ctx))[0]!;
        wallMatter.hasEthicalWall = true;
        wallMatter.restrictedAccessUserIds = ['P-000001'];
        wallMatter.responsiblePartnerId = 'P-000001';
        wallMatter.supervisingPartnerId = 'P-000001';
        wallMatter.leadFeeEarnerId = 'P-000001';
        wallMatter.teamMemberIds = [];
        await getMatterRepository().putMatter(ctx, wallMatter, { expectedRowVersion: null });

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

        const feeEarnerSnap = await runAsTestActor('P-000002', () =>
          getAppSnapshot('P-000002'),
        );
        expect(feeEarnerSnap.currentUserPermissions).toContain('quote:view');
        expect(
          feeEarnerSnap.quotes.some((q) => q.id === quoteOnRestrictedMatter.id),
        ).toBe(false);
        expect(
          feeEarnerSnap.quotes.some((q) => q.id === quoteOnHiddenEnquiry.id),
        ).toBe(false);

        const existingQuote = store.quotes[0]!;
        await runAsTestActor(financeUser.id, async () => {
          expect(
            isActionDenied(
              await saveQuoteRecord(
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
          expect(isActionDenied(await markQuoteSentRecord(existingQuote.id, financeUser.id))).toBe(true);
          expect(
            isActionDenied(
              await logQuoteFollowUpRecord(
                existingQuote.id,
                { method: 'Phone', note: 'Follow up', nextFollowUpDate: '2026-12-01' },
                financeUser.id,
              ),
            ),
          ).toBe(true);
          expect(
            isActionDenied(
              await reviseQuoteRecord(
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
              await recordQuoteOutcomeRecord(
                existingQuote.id,
                { outcome: 'Accepted' },
                financeUser.id,
              ),
            ),
          ).toBe(true);
        });
      } finally {
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });

    it('enforces dual permissions, leaver check, restricted matter allowlist update, SharePoint lifecycle sync, assignedPersonIds, open-only enquiries, and per-record audit on reassignLeaverOwnedRecords (Item 13, R266, R270)', async () => {
      try {
        await resetAllDemoData('P-000001', testDataResetContext());
        const store = getStore();
        const ctx = testDataResetContext();
        const allPeople = await getPartyRepository().listAllPeople<Person>(ctx);
        const allOrgs = await getPartyRepository().listAllOrganisations<import('@/domain/types').Organisation>(ctx);
        const allMatters = await getMatterRepository().listAllMatters<Matter>(ctx);
        const actor = allPeople.find((p) => p.id === 'P-000001')!;
        const activeEmp = allPeople.find((p) => p.id === 'P-000002')!;
        const replacementEmp = allPeople.find((p) => p.id === 'P-000003')!;

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
        const notLeaverRes = await reassignLeaverOwnedRecords(
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
              allPeople,
              byId: 'P-000001',
              status: 'Leaver',
            })),
          status: 'Leaver',
        };
        await getPartyRepository().putPerson(ctx, activeEmp);

        // 2. Rejects when actor lacks matter:reassign_ownership or employee:edit_core
        actor.permissionOverrides = {
          grant: [],
          revoke: ['matter:reassign_ownership'],
        };
        await getPartyRepository().putPerson(ctx, actor);
        expect(
          isActionDenied(
            await reassignLeaverOwnedRecords(activeEmp.id, replacementEmp.id, actor.id),
          ),
        ).toBe(true);

        actor.permissionOverrides = {
          grant: [],
          revoke: ['employee:edit_core'],
        };
        await getPartyRepository().putPerson(ctx, actor);
        expect(
          isActionDenied(
            await reassignLeaverOwnedRecords(activeEmp.id, replacementEmp.id, actor.id),
          ),
        ).toBe(true);

        actor.permissionOverrides = undefined;
        await getPartyRepository().putPerson(ctx, actor);

        // 3. Set up restricted matter, multi-assignee open task, and closed enquiry owned by leaver
        const restrictedMatter = allMatters[0]!;
        restrictedMatter.hasEthicalWall = true;
        restrictedMatter.leadFeeEarnerId = activeEmp.id;
        restrictedMatter.restrictedAccessUserIds = ['P-000001', activeEmp.id];
        await getMatterRepository().putMatter(ctx, restrictedMatter, { expectedRowVersion: null });

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
          allPeople,
          allOrgs,
          allMatters,
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

        const leaverAuditMark = Date.now();
        const okRes = await runWithActiveActorSession(
          {
            personId: actor.id,
            tenantId: 'not-a-law-firm',
            tokenRoles: ['partner'],
            expiresAtMs: Date.now() + 3_600_000,
            verifiedSession: verifiedActorSession,
          },
          async () => reassignLeaverOwnedRecords(activeEmp.id, replacementEmp.id, actor.id),
        );
        await flushDocumentLifecycleSyncForTesting();
        expect(isActionDenied(okRes)).toBe(false);
        expect(okRes.reassignedCount).toBeGreaterThan(0);

        // Restricted matter updated: replacement added, leaver removed, no extra users added
        const updatedRestrictedMatter = (await getMatterRepository().getMatterById<Matter>(
          ctx,
          restrictedMatter.id,
          { includeRestricted: true },
        ))!;
        expect(updatedRestrictedMatter.leadFeeEarnerId).toBe(replacementEmp.id);
        expect(updatedRestrictedMatter.restrictedAccessUserIds).toContain(replacementEmp.id);
        expect(updatedRestrictedMatter.restrictedAccessUserIds).not.toContain(activeEmp.id);
        expect(updatedRestrictedMatter.restrictedAccessUserIds).toContain('P-000001');

        // R266: SharePoint lifecycle re-permission sync job ran for the restricted matter
        await flushDocumentLifecycleSyncForTesting();
        const leaverCheckCtx = resolveTenantFromVerifiedToken({
          verifiedToken: {
            __verifiedByOidcMiddleware: true,
            sub: 'P-000001',
            tenantId: getActiveTenantConfiguration().tenantId,
            email: 'admin@notalawfirm.example',
            name: 'Admin',
            roles: ['admin'],
            mfaVerified: true,
          },
          hostingMode: getActiveTenantConfiguration().hostingMode,
          environment: getActiveTenantConfiguration().environment,
          correlationId: 'corr-leaver-job-check',
        });
        const leaverSyncJob = (await getRepositorySingleton().listLifecycleJobs(leaverCheckCtx)).find(
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
        const newAuditEntries = await auditEntriesWrittenSince(leaverAuditMark);
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
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });

    it('enforces contact:create, contact:edit, internalSystemStep stripping on saveOrganisationAction (R252), record:merge on duplicates, enquiry permissions, R264 status/assignment lock, and R268 automatic enquiry assignment in saveTaskRecord (R267)', async () => {
      try {
        await resetAllDemoData('P-000001', testDataResetContext());
        const store = getStore();
        const ctx = testDataResetContext();
        const allPeople = await getPartyRepository().listAllPeople<Person>(ctx);
        const allOrgs = await getPartyRepository().listAllOrganisations<import('@/domain/types').Organisation>(ctx);
        const financeUser = allPeople.find((p) => p.id === 'P-000009')!;
        const feeEarner = allPeople.find((p) => p.id === 'P-000002')!;
        const riskOfficer = allPeople.find((p) => p.id === 'P-000003')!;
        const existingOrg = allOrgs[0]!;
        const existingContact = allPeople.find((p) => !p.isEmployee)!;

        // 1. saveOrganisationRecord, createOrUpdateLink, and deleteLink enforce contact:create / contact:edit
        expect(
          isActionDenied(
            await runAsTestActor(financeUser.id, () =>
              saveOrganisationRecord(
                { legalName: 'Denied Org' },
                { byId: financeUser.id },
              ),
            ),
          ),
        ).toBe(true);
        expect(
          isActionDenied(
            await runAsTestActor(financeUser.id, () =>
              saveOrganisationRecord(
                { legalName: 'Denied Org Edit' },
                { id: existingOrg.id, byId: financeUser.id },
              ),
            ),
          ),
        ).toBe(true);

        const createdOrgRes = await runAsTestActor(feeEarner.id, () =>
          saveOrganisationRecord(
            { legalName: 'Allowed Org Ltd' },
            { byId: feeEarner.id },
          ),
        );
        expect(isActionDenied(createdOrgRes)).toBe(false);

        const linkDeniedCreate = await runAsTestActor(financeUser.id, () =>
          createOrUpdateLink(
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
          ),
        );
        expect(isActionDenied(linkDeniedCreate)).toBe(true);

        const linkCreated = await runAsTestActor(feeEarner.id, () =>
          createOrUpdateLink(
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
          ),
        );
        expect(isActionDenied(linkCreated)).toBe(false);
        if (!isActionDenied(linkCreated)) {
          expect(
            isActionDenied(
              await runAsTestActor(financeUser.id, () =>
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
            ),
          ).toBe(true);
          expect(
            isActionDenied(
              await runAsTestActor(financeUser.id, () =>
                deleteLink(linkCreated.id, financeUser.id),
              ),
            ),
          ).toBe(true);
          expect(
            isActionDenied(
              await runAsTestActor(feeEarner.id, () =>
                deleteLink(linkCreated.id, feeEarner.id),
              ),
            ),
          ).toBe(false);
        }

        // 2 (R252). saveOrganisationAction strips internalSystemStep so a user with contact:edit only cannot create an org
        riskOfficer.permissionOverrides = {
          grant: ['contact:edit'],
          revoke: ['contact:create'],
        };
        await getPartyRepository().putPerson(ctx, riskOfficer);
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
        await getPartyRepository().putPerson(ctx, riskOfficer);
        setTestEntraSessionOverride(undefined);

        // 3. record:merge on dismissDuplicateMatch and executeMerge
        const secondOrgRes = await runAsTestActor(feeEarner.id, () =>
          saveOrganisationRecord(
            { legalName: 'Duplicate Org Ltd' },
            { byId: feeEarner.id },
          ),
        );
        expect(
          isActionDenied(
            await runAsTestActor(feeEarner.id, () =>
              dismissDuplicateMatch(
                'organisation',
                createdOrgRes.organisation.id,
                secondOrgRes.organisation.id,
                feeEarner.id,
              ),
            ),
          ),
        ).toBe(true);
        expect(
          isActionDenied(
            await runAsTestActor(feeEarner.id, () =>
              executeMerge(
                'organisation',
                createdOrgRes.organisation.id,
                secondOrgRes.organisation.id,
                feeEarner.id,
              ),
            ),
          ),
        ).toBe(true);
        expect(
          isActionDenied(
            await runAsTestActor(riskOfficer.id, () =>
              dismissDuplicateMatch(
                'organisation',
                createdOrgRes.organisation.id,
                secondOrgRes.organisation.id,
                riskOfficer.id,
              ),
            ),
          ),
        ).toBe(false);

        // 4. Refusals by permission key on assignEnquiryRecord, closeEnquiryRecord, logEnquiryContactRecord, sendEnquiryEmailRecord
        const openEnq = store.enquiries.find((e) => e.status === 'New' || e.status === 'Assigned')!;
        financeUser.permissionOverrides = {
          grant: [],
          revoke: ['enquiry:assign'],
        };
        await getPartyRepository().putPerson(ctx, financeUser);
        expect(
          isActionDenied(
            await runAsTestActor(financeUser.id, () =>
              assignEnquiryRecord(openEnq.id, feeEarner.id, null, financeUser.id),
            ),
          ),
        ).toBe(true);
        financeUser.permissionOverrides = undefined;
        await getPartyRepository().putPerson(ctx, financeUser);
        expect(
          isActionDenied(
            await runAsTestActor(financeUser.id, () =>
              closeEnquiryRecord(
                openEnq.id,
                { targetStatus: 'Declined', closeNotes: 'Denied close' },
                financeUser.id,
              ),
            ),
          ),
        ).toBe(true);
        expect(
          isActionDenied(
            await runAsTestActor(financeUser.id, () =>
              logEnquiryContactRecord(
                openEnq.id,
                { method: 'Phone', outcome: 'Spoke', note: 'Denied log' },
                financeUser.id,
              ),
            ),
          ),
        ).toBe(true);
        expect(
          isActionDenied(
            await runAsTestActor(financeUser.id, () =>
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
          ),
        ).toBe(true);

        // 5 (R264, R292). saveEnquiryRecord refuses status or assignment changes on an existing non-draft enquiry
        // even when the actor holds enquiry:edit and only the specific action permission is revoked
        const closedEnq = store.enquiries.find((e) => e.id !== openEnq.id)!;
        closedEnq.status = 'Declined';
        closedEnq.assignedToId = feeEarner.id;

        await runAsTestActor(feeEarner.id, async () => {
          // 5a. Actor with enquiry:edit but enquiry:reopen revoked cannot reopen a closed enquiry via saveEnquiryRecord
          feeEarner.permissionOverrides = {
            grant: ['enquiry:edit', 'enquiry:close', 'enquiry:assign'],
            revoke: ['enquiry:reopen'],
          };
          await getPartyRepository().putPerson(ctx, feeEarner);
          const bypassReopenRes = await saveEnquiryRecord(
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
          await getPartyRepository().putPerson(ctx, feeEarner);
          const bypassCloseRes = await saveEnquiryRecord(
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
          await getPartyRepository().putPerson(ctx, feeEarner);
          const bypassAssignUserRes = await saveEnquiryRecord(
            { assignedToId: 'P-000001', summary: openEnq.summary },
            { id: openEnq.id, byId: feeEarner.id },
          );
          expect(isActionDenied(bypassAssignUserRes)).toBe(true);
          if (isActionDenied(bypassAssignUserRes)) {
            expect(bypassAssignUserRes.code).toBe('FORBIDDEN');
            expect(bypassAssignUserRes.message).toMatch(/Use the assign, close, or reopen actions/i);
          }
          const bypassAssignTeamRes = await saveEnquiryRecord(
            { assignedTeamId: 'TM-999999', summary: openEnq.summary },
            { id: openEnq.id, byId: feeEarner.id },
          );
          expect(isActionDenied(bypassAssignTeamRes)).toBe(true);
          if (isActionDenied(bypassAssignTeamRes)) {
            expect(bypassAssignTeamRes.code).toBe('FORBIDDEN');
            expect(bypassAssignTeamRes.message).toMatch(/Use the assign, close, or reopen actions/i);
          }
          feeEarner.permissionOverrides = undefined;
          await getPartyRepository().putPerson(ctx, feeEarner);

          // 5d (R292 positive control). A Draft enquiry can still be routed through saveEnquiryRecord with asDraft: false, status, assignedToId, and assignedTeamId
          const draftToRouteCreateRes = await saveEnquiryRecord(
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
          const routedFromDraftRes = await saveEnquiryRecord(
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
          const draftEnqRes = await saveEnquiryRecord(
            { firstName: 'Draft', lastName: 'Enquiry', summary: 'Draft summary' },
            { asDraft: true, byId: feeEarner.id },
          );
          const draftEnq = draftEnqRes.enquiry!;
          const draftTaskRes = await saveTaskRecord(
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
          const closedTaskRes = await saveTaskRecord(
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
          await getPartyRepository().putPerson(ctx, feeEarner);
          await saveTaskRecord(
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
          await getPartyRepository().putPerson(ctx, feeEarner);
          await saveTaskRecord(
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
        });
      } finally {
        setTestEntraSessionOverride(null);
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });

    it('enforces target-specific permissions on addNoteToRecord (restricted matter and employee record)', async () => {
      try {
        await resetAllDemoData('P-000001', testDataResetContext());
        const ctx = testDataResetContext();
        const wallMatter = (await getMatterRepository().listAllMatters<Matter>(ctx))[0]!;
        wallMatter.hasEthicalWall = true;
        wallMatter.restrictedAccessUserIds = ['P-000001'];
        wallMatter.responsiblePartnerId = 'P-000001';
        wallMatter.supervisingPartnerId = 'P-000001';
        wallMatter.leadFeeEarnerId = 'P-000001';
        wallMatter.teamMemberIds = [];
        await getMatterRepository().putMatter(ctx, wallMatter, { expectedRowVersion: null });

        // Fee earner P-000002 holds matter:edit and contact:edit, but cannot view wallMatter or edit employees
        const noteOnRestrictedMatter = await runAsTestActor('P-000002', () =>
          addNoteToRecord(
            'matter',
            wallMatter.id,
            'Should fail on walled matter',
            'P-000002',
          ),
        );
        expect(isActionDenied(noteOnRestrictedMatter)).toBe(true);

        const noteOnEmployeeWithoutHrPerm = await runAsTestActor('P-000002', () =>
          addNoteToRecord(
            'person',
            'P-000001',
            'Should fail on employee record without employee:edit_core',
            'P-000002',
          ),
        );
        expect(isActionDenied(noteOnEmployeeWithoutHrPerm)).toBe(true);
      } finally {
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });
  });

  describe('21. S0-07 Conflict Fixes: Quote Conversion (B5), Enquiry Conversion, and Extended Conflict Search (B7, Item 1a)', () => {
    it('denies enquiry conversion and quote conversion without matter:create and creates nothing', async () => {
      try {
        await resetAllDemoData('P-000001', testDataResetContext());
        const store = getStore();
        const ctx = testDataResetContext();
        const peopleBefore = (await getPartyRepository().listAllPeople(ctx)).length;
        const orgsBefore = (await getPartyRepository().listAllOrganisations(ctx)).length;
        const linksBefore = (await getPartyRepository().listAllLinks(ctx)).length;

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
        const enqSvcRes = await prepareEnquiryConversion(
          enqId,
          { createForBusiness: true },
          'P-000009',
        );
        expect(isActionDenied(enqSvcRes)).toBe(true);

        const quoteId = store.quotes[0]!.id;
        const quoteActionRes = await prepareQuoteConversionAction(quoteId);
        expect(isActionDenied(quoteActionRes)).toBe(true);
        const quoteSvcRes = await prepareQuoteConversionRecord(quoteId, 'P-000009');
        expect(isActionDenied(quoteSvcRes)).toBe(true);

        expect((await getPartyRepository().listAllPeople(ctx)).length).toBe(peopleBefore);
        expect((await getPartyRepository().listAllOrganisations(ctx)).length).toBe(orgsBefore);
        expect((await getPartyRepository().listAllLinks(ctx)).length).toBe(linksBefore);
      } finally {
        setTestEntraSessionOverride(undefined);
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });

    it('blocks quote conversion on a high-severity conflict hit (creating nothing), and when clear creates records with outcome-derived conflict status, conflictDecision, and audit entry (B5)', async () => {
      try {
        await resetAllDemoData('P-000001', testDataResetContext());
        const store = getStore();
        const ctx = testDataResetContext();
        await runAsTestActor('P-000001', async () => {
          // Find an opposing party on an existing matter to trigger a high-severity hit
          const allMatters = await getMatterRepository().listAllMatters<Matter>(ctx);
          const matterWithOpponent = allMatters.find(
            (m) =>
              !m.isStaffMatter &&
              !m.hasEthicalWall &&
              m.parties.some((p) => p.role === 'Opponent' || p.role === 'Counterparty'),
          )!;
          const opponentParty = matterWithOpponent.parties.find(
            (p) => p.role === 'Opponent' || p.role === 'Counterparty',
          )!;

          // 1. Create a prospect quote for that opposing party
          const blockedQuoteRes = await saveQuoteRecord(
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

          const peopleBeforeBlock = (await getPartyRepository().listAllPeople(ctx)).length;
          const orgsBeforeBlock = (await getPartyRepository().listAllOrganisations(ctx)).length;
          const linksBeforeBlock = (await getPartyRepository().listAllLinks(ctx)).length;

          const blockedConv = await prepareQuoteConversionRecord(blockedQuote.id, 'P-000001');
          expect(blockedConv.ok).toBe(false);
          expect(blockedConv.conflictBlocked).toBe(true);
          expect(blockedConv.conflictReasons?.length).toBeGreaterThan(0);
          // Nothing created when blocked
          expect((await getPartyRepository().listAllPeople(ctx)).length).toBe(peopleBeforeBlock);
          expect((await getPartyRepository().listAllOrganisations(ctx)).length).toBe(orgsBeforeBlock);
          expect((await getPartyRepository().listAllLinks(ctx)).length).toBe(linksBeforeBlock);

          // 2. Create a clean prospect quote -> creates person, organisation (Cleared), conflictDecision, and audit entry
          const cleanQuoteRes = await saveQuoteRecord(
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
          const cleanConv = await prepareQuoteConversionRecord(cleanQuote.id, 'P-000001');
          expect(cleanConv.ok).toBe(true);
          expect(cleanConv.clientId).toBeDefined();
          expect(cleanConv.instructingContactId).toBeDefined();

          const createdOrg = (await getPartyRepository().getOrganisationById<import('@/domain/types').Organisation>(
            ctx,
            cleanConv.clientId!,
          ))!;
          expect(createdOrg).toBeDefined();
          expect(createdOrg.conflictDecision).toBeDefined();
          expect(createdOrg.conflictDecision?.outcome).toBe('Cleared');
          expect(createdOrg.conflictDecision?.decidedById).toBe('P-000001');
          expect(createdOrg.conflictDecision?.searchedSources).toEqual([
            ...CONFLICT_SEARCHED_SOURCES,
          ]);
          expect(
            (await auditSinceTestStart()).some(
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

          const declinedOrg = (await saveOrganisationRecord(
            {
              legalName: 'Declined Existing Org Ltd',
              conflictStatusId: declinedStatusId,
              conflictReference: 'CR-KEEP-DECLINED',
            },
            { byId: 'P-000001' },
          )).organisation!;
          expect(declinedOrg.conflictStatusId).toBe(declinedStatusId);

          const declinedOrgQuote = (await saveQuoteRecord(
            {
              clientType: 'existing',
              linkedOrganisationId: declinedOrg.id,
              practiceAreaId: matterWithOpponent.practiceAreaId,
              scope: 'Quote for declined existing org',
              feeBasis: 'Fixed fee',
              feeAmountExVat: 1800,
            },
            { byId: 'P-000001' },
          )).quote!;
          const declinedOrgConv = await prepareQuoteConversionRecord(declinedOrgQuote.id, 'P-000001');
          expect(declinedOrgConv.ok).toBe(false);
          expect(declinedOrgConv.conflictBlocked).toBe(true);
          expect(declinedOrg.conflictStatusId).toBe(declinedStatusId);
          expect(declinedOrg.conflictReference).toBe('CR-KEEP-DECLINED');

          // 2c. R254: An existing organisation set to "Cleared with consent" keeps its status after a successful quote conversion
          const consentOrg = (await saveOrganisationRecord(
            {
              legalName: 'Consent Existing Org Ltd',
              conflictStatusId: clearedWithConsentStatusId,
              conflictReference: 'CR-KEEP-CONSENT',
            },
            { byId: 'P-000001' },
          )).organisation!;
          const consentOrgQuote = (await saveQuoteRecord(
            {
              clientType: 'existing',
              linkedOrganisationId: consentOrg.id,
              practiceAreaId: matterWithOpponent.practiceAreaId,
              scope: 'Quote for cleared-with-consent existing org',
              feeBasis: 'Fixed fee',
              feeAmountExVat: 2200,
            },
            { byId: 'P-000001' },
          )).quote!;
          const consentOrgConv = await prepareQuoteConversionRecord(consentOrgQuote.id, 'P-000001');
          expect(consentOrgConv.ok).toBe(true);
          expect(consentOrg.conflictStatusId).toBe(clearedWithConsentStatusId);
          expect(consentOrg.conflictReference).toBe('CR-KEEP-CONSENT');
          expect(
            (await auditSinceTestStart()).some(
              (a) =>
                a.recordType === 'quote' &&
                a.recordId === consentOrgQuote.id &&
                a.action === 'conflict-decision',
            ),
          ).toBe(true);

          // 2d. R255: A quote with a non-blocking amber warning (private client whose employer is an existing client) converts without blocking
          const existingClientOrgId = matterWithOpponent.clientId;
          const privateClientEmployee = (await savePersonRecord(
            {
              firstName: 'Nia',
              surname: 'AmberWarningClient',
            },
            { byId: 'P-000001' },
          )).person!;
          await getPartyRepository().putLink(ctx, {
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
          const amberQuote = (await saveQuoteRecord(
            {
              clientType: 'existing',
              linkedPersonId: privateClientEmployee.id,
              practiceAreaId: matterWithOpponent.practiceAreaId,
              scope: 'Private client quote with amber employer link',
              feeBasis: 'Fixed fee',
              feeAmountExVat: 1500,
            },
            { byId: 'P-000001' },
          )).quote!;
          const amberConv = await prepareQuoteConversionRecord(amberQuote.id, 'P-000001');
          expect(amberConv.ok).toBe(true);
          expect(amberConv.conflictBlocked).toBeFalsy();
          expect(amberConv.conflictWarnings?.length).toBeGreaterThan(0);
          expect(amberConv.conflictWarnings?.[0]).toContain('linked to');
          const amberAudit = (await auditSinceTestStart()).find(
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
          await saveOrganisationRecord(
            {
              legalName: 'Declined Existing Org Ltd',
              conflictStatusId: 'conflict_status.cleared',
              conflictReference: 'CR-CLEARED-FIRST',
            },
            { byId: 'P-000001' },
          );

          const declinedByNameQuote = (await saveQuoteRecord(
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
          )).quote!;
          const declinedByNameConv = await prepareQuoteConversionRecord(
            declinedByNameQuote.id,
            'P-000001',
          );
          expect(declinedByNameConv.ok).toBe(true);
          expect(declinedByNameConv.conflictBlocked).toBeFalsy();
          expect(declinedByNameConv.conflictWarnings).toContain(
            "An organisation with this name has conflict status 'Conflict – declined'. Check whether it is the same client.",
          );
          const createdSameNameProspectOrg = (await getPartyRepository().getOrganisationById<import('@/domain/types').Organisation>(
            ctx,
            declinedByNameConv.clientId!,
          ))!;
          expect(createdSameNameProspectOrg.conflictDecision?.outcome).toBe('Potential conflict');
          expect(createdSameNameProspectOrg.conflictDecision?.matchesCount).toBe(0);
          // R312: Quote conversion with a warning stores it on conflictDecision.warnings
          expect(declinedByNameQuote.conflictDecision?.warnings).toContain(
            "An organisation with this name has conflict status 'Conflict – declined'. Check whether it is the same client.",
          );
          expect(amberQuote.conflictDecision?.warnings).toEqual(
            amberConv.conflictWarnings,
          );

          // Linked declined organisation still hard-blocks
          const linkedDeclinedRecheck = await prepareQuoteConversionRecord(declinedOrgQuote.id, 'P-000001');
          expect(linkedDeclinedRecheck.ok).toBe(false);
          expect(linkedDeclinedRecheck.conflictBlocked).toBe(true);

          // 3. Enquiry conversion for a new business also records conflictDecision and audit entry, and keeps conflictDecision on the converted matter (R304)
          const templateEnq = store.enquiries.find((e) => e.status !== 'Draft')!;

          // 3a. R307: An enquiry linked to a declined organisation is blocked on conversion, while an unlinked enquiry matching a declined organisation by name converts with the warning in conflictWarnings
          const linkedDeclinedEnq = (await saveEnquiryRecord(
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
          )).enquiry!;
          const linkedDeclinedEnqConv = await prepareEnquiryConversion(
            linkedDeclinedEnq.id,
            { useOrganisationId: declinedOrg.id, createForBusiness: true },
            'P-000001',
          );
          expect(linkedDeclinedEnqConv.ok).toBe(false);
          expect(linkedDeclinedEnqConv.conflictBlocked).toBe(true);
          expect(linkedDeclinedEnqConv.conflictReasons).toContain(
            'Client organisation has conflict status "Conflict – declined".',
          );
          expect(
            (await auditSinceTestStart()).some(
              (a) =>
                a.recordType === 'enquiry' &&
                a.recordId === linkedDeclinedEnq.id &&
                a.action === 'conflict-decision' &&
                a.field === 'Enquiry conversion blocked by conflict check',
            ),
          ).toBe(true);

          const declinedEnqOrg = (await saveOrganisationRecord(
            {
              legalName: 'Declined Enquiry Org Ltd',
              conflictStatusId: declinedStatusId,
              conflictReference: 'CR-ENQ-DECLINED',
            },
            { byId: 'P-000001' },
          )).organisation!;
          const unlinkedDeclinedNameEnq = (await saveEnquiryRecord(
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
          )).enquiry!;
          const unlinkedDeclinedNameEnqConv = await prepareEnquiryConversion(
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
          // R312: Enquiry conversion with a warning stores it on conflictDecision.warnings
          expect(unlinkedDeclinedNameEnq.conflictDecision?.warnings).toEqual(
            unlinkedDeclinedNameEnqConv.conflictWarnings,
          );
          // R312: A user who cannot see the enquiry gets no warnings from the snapshot used by /matters/new
          const restrictedMatter = (await getMatterRepository().listAllMatters<Matter>(ctx))[0]!;
          const savedMatterSnap = structuredClone(restrictedMatter);
          const prevConvertedMatterId = unlinkedDeclinedNameEnq.convertedMatterId;
          restrictedMatter.isStaffMatter = true;
          restrictedMatter.restrictedAccessUserIds = ['P-000001'];
          restrictedMatter.responsiblePartnerId = 'P-000001';
          restrictedMatter.supervisingPartnerId = 'P-000001';
          restrictedMatter.leadFeeEarnerId = 'P-000001';
          restrictedMatter.teamMemberIds = [];
          await getMatterRepository().putMatter(ctx, restrictedMatter, { expectedRowVersion: null });
          unlinkedDeclinedNameEnq.convertedMatterId = restrictedMatter.id;
          try {
            const nonParticipantSnap = await runAsTestActor('P-000002', () =>
              getAppSnapshot('P-000002'),
            );
            const resolvedEnquiryForNonParticipant = nonParticipantSnap.enquiries.find(
              (e) => e.id === unlinkedDeclinedNameEnq.id,
            );
            expect(resolvedEnquiryForNonParticipant).toBeUndefined();
            expect(
              normaliseConversionConflictWarnings(
                resolvedEnquiryForNonParticipant?.conflictDecision?.warnings,
              ),
            ).toEqual([]);
          } finally {
            await getMatterRepository().putMatter(ctx, savedMatterSnap, { expectedRowVersion: null });
            unlinkedDeclinedNameEnq.convertedMatterId = prevConvertedMatterId;
          }
          // R311: Shared helper turns conflictWarnings into the user-visible notice for toast and new-matter banner
          expect(
            formatConversionConflictWarningsNotice(
              unlinkedDeclinedNameEnqConv.conflictWarnings,
            ),
          ).toBe(
            "Conflict warning: An organisation with this name has conflict status 'Conflict – declined'. Check whether it is the same client.",
          );
          expect(
            formatConversionConflictWarningsNotice(declinedByNameConv.conflictWarnings),
          ).toContain(
            "Conflict warning: An organisation with this name has conflict status 'Conflict – declined'. Check whether it is the same client.",
          );
          expect(formatConversionConflictWarningsNotice(undefined)).toBeNull();
          expect(formatConversionConflictWarningsNotice([])).toBeNull();
          expect(
            normaliseConversionConflictWarnings([
              '  First warning  ',
              '',
              'First warning',
              'Second warning',
            ]),
          ).toEqual(['First warning', 'Second warning']);

          const cleanEnqRes = await saveEnquiryRecord(
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
          const enqConv = await prepareEnquiryConversion(
            cleanEnq.id,
            { createForBusiness: true },
            'P-000001',
          );
          expect(enqConv.ok).toBe(true);
          const enqCreatedOrg = (await getPartyRepository().getOrganisationById<import('@/domain/types').Organisation>(
            ctx,
            enqConv.clientId!,
          ))!;
          expect(enqCreatedOrg.conflictDecision).toBeDefined();
          expect(enqCreatedOrg.conflictDecision?.outcome).toBe('Cleared');
          expect(enqCreatedOrg.conflictDecision?.decidedById).toBe('P-000001');
          expect(enqCreatedOrg.conflictDecision?.searchedSources).toEqual([
            ...CONFLICT_SEARCHED_SOURCES,
          ]);
          expect(
            (await auditSinceTestStart()).some(
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
          const convertedMatterRes = await withPageActor(async () =>
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
          const convertedFromQuoteMatterRes = await withPageActor(async () =>
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
        });
      } finally {
        setTestEntraSessionOverride(undefined);
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });

    it('finds hits from instructingContactId, billingContactId, additionalClientIds, and person–organisation links in both searches, records searchedSources, and redacts restricted matters in blocked reasons (B7)', async () => {
      try {
        await resetAllDemoData('P-000001', testDataResetContext());
        const store = getStore();
        const ctx = testDataResetContext();

        // Create dedicated test records for the 4 new search sources
        const instrPerson = (
          await runAsTestActor('P-000001', () =>
            savePersonRecord(
              { firstName: 'Iolo', surname: 'InstructingHit' },
              { byId: 'P-000001' },
            ),
          )
        ).person;
        const billPerson = (
          await runAsTestActor('P-000001', () =>
            savePersonRecord(
              { firstName: 'Bryn', surname: 'BillingHit' },
              { byId: 'P-000001' },
            ),
          )
        ).person;
        const initialOrgs = await getPartyRepository().listAllOrganisations<import('@/domain/types').Organisation>(ctx);
        const addlClientOrg = initialOrgs[1]!;
        const employerOrg = initialOrgs[2]!;
        const linkedEmployeePerson = (
          await runAsTestActor('P-000001', () =>
            savePersonRecord(
              { firstName: 'Ceri', surname: 'LinkedToOpponentOrg' },
              { byId: 'P-000001' },
            ),
          )
        ).person;

        // Link Ceri to employerOrg
        await getPartyRepository().putLink(ctx, {
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
        const initialMatters = await getMatterRepository().listAllMatters<Matter>(ctx);
        const baseMatter = initialMatters.find(
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
        await getMatterRepository().putMatter(ctx, baseMatter, { expectedRowVersion: null });

        const allPeople = await getPartyRepository().listAllPeople<Person>(ctx);
        const allOrgs = await getPartyRepository().listAllOrganisations<import('@/domain/types').Organisation>(ctx);
        const allLinks = await getPartyRepository().listAllLinks<import('@/domain/types').PersonOrganisationLink>(ctx);
        let allMatters = await getMatterRepository().listAllMatters<Matter>(ctx);

        // Verify buildEffectiveConflictParties includes billingContactId
        const builtParties = buildEffectiveConflictParties({
          submittedParties: [],
          clientId: baseMatter.clientId,
          instructingContactId: instrPerson.id,
          billingContactId: billPerson.id,
          people: allPeople,
          organisations: allOrgs,
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
            matters: allMatters,
            enquiries: store.enquiries,
            people: allPeople,
            organisations: allOrgs,
            links: allLinks,
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
          allPeople,
          allOrgs,
          allMatters,
          store.values,
          store.enquiries,
          null,
          allLinks,
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
          allPeople,
          allOrgs,
          allMatters,
          store.values,
          {
            recordedAt: new Date().toISOString(),
            recordedById: 'P-000001',
            enquiries: store.enquiries,
            excludeEnquiryId: null,
            links: allLinks,
            canViewMatter: () => true,
            tenantId: 'not-a-law-firm',
          },
        );
        expect(snap.searchedInput.searchedSources).toEqual([...CONFLICT_SEARCHED_SOURCES]);

        // 3. Redaction of restricted matters in blocked reasons for an actor without access
        const restrictedMatter = allMatters.find((m) => m.id !== baseMatter.id)!;
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
        await getMatterRepository().putMatter(ctx, restrictedMatter, { expectedRowVersion: null });
        allMatters = await getMatterRepository().listAllMatters<Matter>(ctx);

        const templateEnq = store.enquiries.find((e) => e.status !== 'Draft')!;
        const blockedEnqRes = await runAsTestActor('P-000002', () =>
          saveEnquiryRecord(
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
          ),
        );
        const blockedEnq = blockedEnqRes.enquiry!;
        // R280 (R258 follow-up): Quick conflict check recorded audit entry uses action 'conflict-decision' in both main and draft paths
        const mainQuickAudit = (await auditSinceTestStart()).find(
          (a) =>
            a.recordType === 'enquiry' &&
            a.recordId === blockedEnq.id &&
            a.field === 'Quick conflict check recorded',
        );
        expect(mainQuickAudit).toBeDefined();
        expect(mainQuickAudit?.action).toBe('conflict-decision');

        const draftCheckEnq = (
          await runAsTestActor('P-000002', () =>
            saveEnquiryRecord(
              {
                channelId: templateEnq.channelId,
                firstName: 'Draft',
                lastName: 'AuditCaller',
                practiceAreaId: baseMatter.practiceAreaId,
                summary: 'Draft enquiry conflict audit test',
                urgencyId: templateEnq.urgencyId,
              },
              { byId: 'P-000002', asDraft: true },
            ),
          )
        ).enquiry!;
        const draftQuickAudit = (await auditSinceTestStart()).find(
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
          allPeople,
          allOrgs,
          allMatters,
          store.values,
          [],
          null,
          allLinks,
          () => false,
          'not-a-law-firm',
        );
        const searchTenantB = runEnquiryConflictSearch(
          { callingOnBehalfOf: 'Vanguard Secret Counterparty Ltd' },
          allPeople,
          allOrgs,
          allMatters,
          store.values,
          [],
          null,
          allLinks,
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
          allPeople,
          allOrgs,
          allMatters,
          store.values,
          [],
          null,
          allLinks,
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
        const convDenied = await runAsTestActor('P-000002', () =>
          prepareEnquiryConversion(blockedEnq.id, {}, 'P-000002'),
        );
        expect(convDenied.ok).toBe(false);
        expect(convDenied.conflictBlocked).toBe(true);
        const combinedReasons = (convDenied.conflictReasons ?? []).join(' | ');
        expect(combinedReasons).toContain('a restricted matter');
        expect(combinedReasons).not.toContain(restrictedMatter.matterNumber);
        expect(combinedReasons).not.toContain('Ultra Secret Restricted Acquisition');
      } finally {
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });
  });

  describe('S0-09: Merge repoints every reference, link de-duplication, PMS collision, document repository read-back, employee/leaver refusal, and tombstone redirects', () => {
    function setVerifiedAdminMergeSession() {
      const cfg = getActiveTenantConfiguration();
      const sessionPayload = verifySignedEntraSessionCookie(
        createSignedEntraSessionCookie({
          personId: 'P-000004',
          tenantId: cfg.tenantId,
          oid: '00000000-0000-4000-8000-000000000004',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: 'P-000004',
          email: 'huw.pritchard@notalawfirm.example',
          displayName: 'Admin',
          entraRoles: ['admin'],
          mappedRoles: ['admin'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      )!;
      setTestEntraSessionOverride(sessionPayload);
    }

    it('denies merge without record:merge, refuses active employees, firm staff, or leavers, and fails closed without a verified session (R271)', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      try {
        const s1 = (
          await runAsTestActor('P-000001', () =>
            savePersonRecord(
              { firstName: 'Gareth', surname: 'Survivor', isEmployee: false },
              { byId: 'P-000001' },
            ),
          )
        ).person!;
        const m1 = (
          await runAsTestActor('P-000001', () =>
            savePersonRecord(
              { firstName: 'Gareth', surname: 'Duplicate', isEmployee: false },
              { byId: 'P-000001' },
            ),
          )
        ).person!;

        // 1. Denied without record:merge (fee earner P-000002 lacks record:merge)
        const deniedNoPerm = await runAsTestActor('P-000002', () =>
          executeMerge('person', s1.id, m1.id, 'P-000002'),
        );
        expect(isActionDenied(deniedNoPerm)).toBe(true);
        if (isActionDenied(deniedNoPerm)) {
          expect(deniedNoPerm.code).toBe('FORBIDDEN');
        }

        // 2. Denied when either record is an active employee (P-000002)
        const deniedActiveEmpAsMerged = await runAsTestActor('P-000004', () =>
          executeMerge('person', s1.id, 'P-000002', 'P-000004'),
        );
        expect(isActionDenied(deniedActiveEmpAsMerged)).toBe(true);
        const deniedActiveEmpAsSurvivor = await runAsTestActor('P-000004', () =>
          executeMerge('person', 'P-000002', m1.id, 'P-000004'),
        );
        expect(isActionDenied(deniedActiveEmpAsSurvivor)).toBe(true);

        // 3. Denied when a record has worksAtFirm or employment data (including a leaver)
        const ctx = testDataResetContext();
        const allPeople = await getPartyRepository().listAllPeople<Person>(ctx);
        const leaverContact = allPeople.find((p) => p.id === m1.id)!;
        leaverContact.isEmployee = false;
        leaverContact.employment = createDefaultEmploymentRecord({
          person: leaverContact,
          allPeople,
          byId: 'P-000004',
          status: 'Leaver',
          primaryDomain: 'notalawfirm.example',
        });
        await getPartyRepository().putPerson(ctx, leaverContact);
        const deniedLeaver = await runAsTestActor('P-000004', () =>
          executeMerge('person', s1.id, m1.id, 'P-000004'),
        );
        expect(isActionDenied(deniedLeaver)).toBe(true);
        if (isActionDenied(deniedLeaver)) {
          expect(deniedLeaver.code).toBe('FORBIDDEN');
        }

        // 4. R271: Without a verified Entra session for the actor, executeMerge fails closed with UNAUTHENTICATED
        leaverContact.employment = undefined;
        await getPartyRepository().putPerson(ctx, leaverContact);
        setTestEntraSessionOverride(null);
        await expect(executeMerge('person', s1.id, m1.id, 'P-000004')).rejects.toThrow(/UNAUTHENTICATED/);
      } finally {
        setTestEntraSessionOverride(undefined);
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });

    it('1. Matter: repoints clientId, additionalClientIds (de-duplicated), instructingContactId, billingContactId, referrerContactId, parties[].linkedRecordId, and conflictCheckRecord parties/matches (R275)', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      try {
        setVerifiedAdminMergeSession();
        const survivorPerson = (await savePersonRecord(
          { firstName: 'Alun', surname: 'MatterSurvivor', isEmployee: false },
          { byId: 'P-000004' },
        )).person!;
        const mergedPerson = (await savePersonRecord(
          { firstName: 'Alun', surname: 'MatterDuplicate', isEmployee: false },
          { byId: 'P-000004' },
        )).person!;
        const survivorOrg = (await saveOrganisationRecord(
          { legalName: 'Bryn Matter Survivor Ltd' },
          { byId: 'P-000004' },
        )).organisation!;
        const mergedOrg = (await saveOrganisationRecord(
          { legalName: 'Bryn Matter Duplicate Ltd' },
          { byId: 'P-000004' },
        )).organisation!;

        const ctx = testDataResetContext();
        const matter = (await getMatterRepository().listAllMatters<Matter>(ctx))[0]!;
        matter.clientId = mergedOrg.id;
        matter.additionalClientIds = [survivorPerson.id, mergedPerson.id];
        matter.instructingContactId = mergedPerson.id;
        matter.billingContactId = mergedPerson.id;
        matter.referrerContactId = mergedPerson.id;
        matter.parties = [
          {
            id: 'MP-MERGE-1',
            name: 'Alun MatterDuplicate',
            role: 'Opponent',
            entityType: 'person',
            linkedRecordId: mergedPerson.id,
          },
          {
            id: 'MP-MERGE-2',
            name: 'Bryn Matter Duplicate Ltd',
            role: 'Other party',
            entityType: 'organisation',
            linkedRecordId: mergedOrg.id,
          },
        ];
        matter.conflictCheckRecord = {
          status: 'Cleared',
          outcomeLabel: 'Cleared by fee earner',
          declarationConfirmed: true,
          reviewerMessage: '',
          lastRunAtDisplay: '2026-11-07',
          lastRunById: 'P-000001',
          lastRunByName: 'Carys',
          parties: [
            {
              id: 'CP-1',
              name: 'Alun',
              entityType: 'person',
              role: 'Client contact',
              linkedRecordId: mergedPerson.id,
            },
            {
              id: 'CP-2',
              name: 'Bryn Dup',
              entityType: 'organisation',
              role: 'Client',
              linkedRecordId: mergedOrg.id,
            },
          ],
          matches: [
            {
              id: 'CM-1',
              partyId: 'CP-1',
              partyName: 'Alun',
              matchedRecordId: mergedPerson.id,
              matchedRecordName: 'Alun',
              matchedRecordType: 'person',
              strength: 'Exact',
              whereFound: 'Directory',
              responsiblePartnerId: null,
              responsiblePartnerName: '',
              dateLabel: '2026-11-07',
              disposition: 'same_no_conflict',
              note: 'Same contact',
            },
            {
              id: 'CM-2',
              partyId: 'CP-2',
              partyName: 'Bryn Dup',
              matchedRecordId: mergedOrg.id,
              matchedRecordName: 'Bryn Dup',
              matchedRecordType: 'organisation',
              strength: 'Exact',
              whereFound: 'Directory',
              responsiblePartnerId: null,
              responsiblePartnerName: '',
              dateLabel: '2026-11-07',
              disposition: 'same_no_conflict',
              note: 'Same org',
            },
          ],
          runs: [],
          comments: [],
        };
        await getMatterRepository().putMatter(ctx, matter, { expectedRowVersion: null });

        expect(
          isActionDenied(await executeMerge('person', survivorPerson.id, mergedPerson.id, 'P-000004')),
        ).toBe(false);
        expect(
          isActionDenied(await executeMerge('organisation', survivorOrg.id, mergedOrg.id, 'P-000004')),
        ).toBe(false);

        const updatedMatter = (await getMatterRepository().getMatterById<Matter>(ctx, matter.id))!;
        expect(updatedMatter.clientId).toBe(survivorOrg.id);
        expect(updatedMatter.additionalClientIds).toEqual([survivorPerson.id]);
        expect(updatedMatter.instructingContactId).toBe(survivorPerson.id);
        expect(updatedMatter.billingContactId).toBe(survivorPerson.id);
        expect(updatedMatter.referrerContactId).toBe(survivorPerson.id);
        expect(updatedMatter.parties.find((p) => p.id === 'MP-MERGE-1')?.linkedRecordId).toBe(
          survivorPerson.id,
        );
        expect(updatedMatter.parties.find((p) => p.id === 'MP-MERGE-2')?.linkedRecordId).toBe(
          survivorOrg.id,
        );
        expect(
          updatedMatter.conflictCheckRecord?.parties.find((p) => p.id === 'CP-1')?.linkedRecordId,
        ).toBe(survivorPerson.id);
        expect(
          updatedMatter.conflictCheckRecord?.parties.find((p) => p.id === 'CP-2')?.linkedRecordId,
        ).toBe(survivorOrg.id);
        expect(
          updatedMatter.conflictCheckRecord?.matches.find((m) => m.id === 'CM-1')?.matchedRecordId,
        ).toBe(survivorPerson.id);
        expect(
          updatedMatter.conflictCheckRecord?.matches.find((m) => m.id === 'CM-2')?.matchedRecordId,
        ).toBe(survivorOrg.id);
      } finally {
        setTestEntraSessionOverride(undefined);
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });

    it('2. Enquiry: repoints linkedOrganisationId, referrerPersonId, linkedPersonId, referredToOrganisationId, and conflictSnapshot conflicts/knownPeople/knownOrganisations (R275)', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      try {
        setVerifiedAdminMergeSession();
        const survivorPerson = (await savePersonRecord(
          { firstName: 'Alun', surname: 'EnqSurvivor', isEmployee: false },
          { byId: 'P-000004' },
        )).person!;
        const mergedPerson = (await savePersonRecord(
          { firstName: 'Alun', surname: 'EnqDuplicate', isEmployee: false },
          { byId: 'P-000004' },
        )).person!;
        const survivorOrg = (await saveOrganisationRecord(
          { legalName: 'Bryn Enq Survivor Ltd' },
          { byId: 'P-000004' },
        )).organisation!;
        const mergedOrg = (await saveOrganisationRecord(
          { legalName: 'Bryn Enq Duplicate Ltd' },
          { byId: 'P-000004' },
        )).organisation!;

        const store = getStore();
        const enq = store.enquiries[0]!;
        enq.linkedOrganisationId = mergedOrg.id;
        enq.referredToOrganisationId = mergedOrg.id;
        enq.referrerPersonId = mergedPerson.id;
        enq.linkedPersonId = mergedPerson.id;
        enq.conflictSnapshot = {
          recordedAt: new Date().toISOString(),
          recordedById: 'P-000001',
          searchedInput: {
            firstName: 'Alun',
            lastName: 'Bryn',
            callingOnBehalfOf: 'Bryn Holdings',
            otherPartiesNamed: '',
            email: '',
            phone: '',
            postcode: '',
            addressLine1: '',
            addressLine2: '',
          },
          matchCount: 2,
          highestSeverity: 'medium',
          conflictStatus: 'Check',
          conflicts: [
            {
              recordId: mergedPerson.id,
              recordType: 'person',
              name: 'Alun',
              recordLabel: 'Person',
              queryTerm: 'Alun',
              href: `/people/${mergedPerson.id}`,
              reason: 'Name match',
              matchedFields: ['Name'],
              severity: 'medium',
              strength: 80,
              blocking: false,
            },
            {
              recordId: mergedOrg.id,
              recordType: 'organisation',
              name: 'Bryn Holdings',
              recordLabel: 'Organisation',
              queryTerm: 'Bryn',
              href: `/organisations/${mergedOrg.id}`,
              reason: 'Name match',
              matchedFields: ['Name'],
              severity: 'medium',
              strength: 80,
              blocking: false,
            },
          ],
          knownPeople: [
            { id: survivorPerson.id, formattedReasons: 'Existing' },
            { id: mergedPerson.id, formattedReasons: 'Duplicate' },
          ],
          knownOrganisations: [{ id: mergedOrg.id, formattedReasons: 'Duplicate Org' }],
        };

        await executeMerge('person', survivorPerson.id, mergedPerson.id, 'P-000004');
        await executeMerge('organisation', survivorOrg.id, mergedOrg.id, 'P-000004');

        const updatedEnq = getStore().enquiries.find((e) => e.id === enq.id)!;
        expect(updatedEnq.linkedOrganisationId).toBe(survivorOrg.id);
        expect(updatedEnq.referredToOrganisationId).toBe(survivorOrg.id);
        expect(updatedEnq.referrerPersonId).toBe(survivorPerson.id);
        expect(updatedEnq.linkedPersonId).toBe(survivorPerson.id);
        expect(updatedEnq.conflictSnapshot?.conflicts[0]?.recordId).toBe(survivorPerson.id);
        expect(updatedEnq.conflictSnapshot?.conflicts[0]?.href).toBe(
          `/people/${survivorPerson.id}`,
        );
        expect(updatedEnq.conflictSnapshot?.conflicts[1]?.recordId).toBe(survivorOrg.id);
        expect(updatedEnq.conflictSnapshot?.conflicts[1]?.href).toBe(
          `/organisations/${survivorOrg.id}`,
        );
        expect(updatedEnq.conflictSnapshot?.knownPeople.map((kp) => kp.id)).toEqual([
          survivorPerson.id,
        ]);
        expect(updatedEnq.conflictSnapshot?.knownOrganisations.map((ko) => ko.id)).toEqual([
          survivorOrg.id,
        ]);
      } finally {
        setTestEntraSessionOverride(undefined);
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });

    it('3. Quote: repoints linkedOrganisationId and linkedPersonId (R275)', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      try {
        setVerifiedAdminMergeSession();
        const survivorPerson = (await savePersonRecord(
          { firstName: 'Alun', surname: 'QuoteSurvivor', isEmployee: false },
          { byId: 'P-000004' },
        )).person!;
        const mergedPerson = (await savePersonRecord(
          { firstName: 'Alun', surname: 'QuoteDuplicate', isEmployee: false },
          { byId: 'P-000004' },
        )).person!;
        const survivorOrg = (await saveOrganisationRecord(
          { legalName: 'Bryn Quote Survivor Ltd' },
          { byId: 'P-000004' },
        )).organisation!;
        const mergedOrg = (await saveOrganisationRecord(
          { legalName: 'Bryn Quote Duplicate Ltd' },
          { byId: 'P-000004' },
        )).organisation!;

        const quote = getStore().quotes[0]!;
        quote.linkedOrganisationId = mergedOrg.id;
        quote.linkedPersonId = mergedPerson.id;

        await executeMerge('person', survivorPerson.id, mergedPerson.id, 'P-000004');
        await executeMerge('organisation', survivorOrg.id, mergedOrg.id, 'P-000004');

        const updatedQuote = getStore().quotes.find((q) => q.id === quote.id)!;
        expect(updatedQuote.linkedOrganisationId).toBe(survivorOrg.id);
        expect(updatedQuote.linkedPersonId).toBe(survivorPerson.id);
      } finally {
        setTestEntraSessionOverride(undefined);
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });

    it('4. Task: repoints and de-duplicates linkedRecords[].recordId (R275)', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      try {
        setVerifiedAdminMergeSession();
        const survivorPerson = (await savePersonRecord(
          { firstName: 'Alun', surname: 'TaskSurvivor', isEmployee: false },
          { byId: 'P-000004' },
        )).person!;
        const mergedPerson = (await savePersonRecord(
          { firstName: 'Alun', surname: 'TaskDuplicate', isEmployee: false },
          { byId: 'P-000004' },
        )).person!;
        const survivorOrg = (await saveOrganisationRecord(
          { legalName: 'Bryn Task Survivor Ltd' },
          { byId: 'P-000004' },
        )).organisation!;
        const mergedOrg = (await saveOrganisationRecord(
          { legalName: 'Bryn Task Duplicate Ltd' },
          { byId: 'P-000004' },
        )).organisation!;

        const task = getStore().tasks[0]!;
        task.linkedRecords = [
          { recordType: 'person', recordId: survivorPerson.id },
          { recordType: 'person', recordId: mergedPerson.id },
          { recordType: 'organisation', recordId: mergedOrg.id },
        ];

        await executeMerge('person', survivorPerson.id, mergedPerson.id, 'P-000004');
        await executeMerge('organisation', survivorOrg.id, mergedOrg.id, 'P-000004');

        const updatedTask = getStore().tasks.find((t) => t.id === task.id)!;
        expect(updatedTask.linkedRecords).toEqual([
          { recordType: 'person', recordId: survivorPerson.id },
          { recordType: 'organisation', recordId: survivorOrg.id },
        ]);
      } finally {
        setTestEntraSessionOverride(undefined);
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });

    it('5. Person–organisation links (store.links): repoints non-colliding links and on collision keeps survivor link while carrying over isCurrent, primary-contact status, and dates (R273, R275)', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      try {
        setVerifiedAdminMergeSession();
        const survivorPerson = (await savePersonRecord(
          { firstName: 'Alun', surname: 'LinkSurvivor', isEmployee: false },
          { byId: 'P-000004' },
        )).person!;
        const mergedPerson = (await savePersonRecord(
          { firstName: 'Alun', surname: 'LinkDuplicate', isEmployee: false },
          { byId: 'P-000004' },
        )).person!;
        const survivorOrg = (await saveOrganisationRecord(
          { legalName: 'Bryn Link Survivor Ltd' },
          { byId: 'P-000004' },
        )).organisation!;
        const secondOrg = (await saveOrganisationRecord(
          { legalName: 'Bryn Second Counterpart Ltd' },
          { byId: 'P-000004' },
        )).organisation!;

        // Survivor has a PAST non-primary link to survivorOrg; merged record has a CURRENT primary link with earlier startDate
        await createOrUpdateLink(
          {
            personId: survivorPerson.id,
            organisationId: survivorOrg.id,
            jobTitle: 'Former Director',
            department: '',
            roleWithinOrganisation: 'Director',
            contactRoleIds: [],
            isPrimaryContact: false,
            isCurrent: false,
            startDate: '2023-01-01',
            endDate: '2024-06-30',
            contactStatusId: null,
          },
          'P-000004',
        );
        await createOrUpdateLink(
          {
            personId: mergedPerson.id,
            organisationId: survivorOrg.id,
            jobTitle: 'Current Managing Director',
            department: 'Board',
            roleWithinOrganisation: 'Director',
            contactRoleIds: [],
            isPrimaryContact: true,
            isCurrent: true,
            startDate: '2021-03-15',
            endDate: null,
            contactStatusId: null,
          },
          'P-000004',
        );
        await createOrUpdateLink(
          {
            personId: mergedPerson.id,
            organisationId: secondOrg.id,
            jobTitle: 'Advisor',
            department: '',
            roleWithinOrganisation: 'Advisor',
            contactRoleIds: [],
            isPrimaryContact: false,
            isCurrent: true,
            startDate: '2025-01-01',
            endDate: null,
            contactStatusId: null,
          },
          'P-000004',
        );

        await executeMerge('person', survivorPerson.id, mergedPerson.id, 'P-000004');

        const updatedLinks = await getPartyRepository().listAllLinks<import('@/domain/types').PersonOrganisationLink>(
          testDataResetContext(),
        );
        expect(updatedLinks.some((l) => l.personId === mergedPerson.id)).toBe(false);
        const collidingLinks = updatedLinks.filter(
          (l) => l.personId === survivorPerson.id && l.organisationId === survivorOrg.id,
        );
        expect(collidingLinks).toHaveLength(1);
        expect(collidingLinks[0]?.isCurrent).toBe(true);
        expect(collidingLinks[0]?.isPrimaryContact).toBe(true);
        expect(collidingLinks[0]?.startDate).toBe('2021-03-15');
        expect(collidingLinks[0]?.endDate).toBeNull();
        expect(
          updatedLinks.some(
            (l) => l.personId === survivorPerson.id && l.organisationId === secondOrg.id,
          ),
        ).toBe(true);
      } finally {
        setTestEntraSessionOverride(undefined);
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });

    it('6. Organisation: repoints parentOrganisationId on subsidiaries while leaving relationshipPartnerId unchanged (R275)', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      try {
        setVerifiedAdminMergeSession();
        const survivorOrg = (await saveOrganisationRecord(
          {
            legalName: 'Bryn Parent Survivor Ltd',
            relationshipPartnerId: 'P-000001',
          },
          { byId: 'P-000004' },
        )).organisation!;
        const mergedOrg = (await saveOrganisationRecord(
          {
            legalName: 'Bryn Parent Duplicate Ltd',
            relationshipPartnerId: 'P-000003',
          },
          { byId: 'P-000004' },
        )).organisation!;
        const childOrg = (await saveOrganisationRecord(
          {
            legalName: 'Bryn Subsidiary Ltd',
            parentOrganisationId: mergedOrg.id,
          },
          { byId: 'P-000004' },
        )).organisation!;

        await executeMerge('organisation', survivorOrg.id, mergedOrg.id, 'P-000004');

        const updatedOrgs = await getPartyRepository().listAllOrganisations<import('@/domain/types').Organisation>(
          testDataResetContext(),
        );
        const updatedChildOrg = updatedOrgs.find((o) => o.id === childOrg.id)!;
        expect(updatedChildOrg.parentOrganisationId).toBe(survivorOrg.id);
        const updatedSurvivorOrg = updatedOrgs.find((o) => o.id === survivorOrg.id)!;
        expect(updatedSurvivorOrg.relationshipPartnerId).toBe('P-000001');
      } finally {
        setTestEntraSessionOverride(undefined);
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });

    it('7. PMS links (store.pmsLinks): repoints non-colliding links and on collision keeps survivor link, records pmsLinkConflicts, and writes audit entry (R275)', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      try {
        setVerifiedAdminMergeSession();
        const survivorPerson = (await savePersonRecord(
          { firstName: 'Alun', surname: 'PmsSurvivor', isEmployee: false },
          { byId: 'P-000004' },
        )).person!;
        const mergedPerson = (await savePersonRecord(
          { firstName: 'Alun', surname: 'PmsDuplicate', isEmployee: false },
          { byId: 'P-000004' },
        )).person!;
        const survivorOrg = (await saveOrganisationRecord(
          { legalName: 'Bryn Pms Survivor Ltd' },
          { byId: 'P-000004' },
        )).organisation!;
        const mergedOrg = (await saveOrganisationRecord(
          { legalName: 'Bryn Pms Duplicate Ltd' },
          { byId: 'P-000004' },
        )).organisation!;

        await linkPmsRecord('person', mergedPerson.id, 'PMS-PER-MERGED', 'P-000004');
        await linkPmsRecord('organisation', survivorOrg.id, 'PMS-ORG-SURV', 'P-000004');
        await linkPmsRecord('organisation', mergedOrg.id, 'PMS-ORG-MERG', 'P-000004');

        await executeMerge('person', survivorPerson.id, mergedPerson.id, 'P-000004');
        const orgMergeHistory = await executeMerge(
          'organisation',
          survivorOrg.id,
          mergedOrg.id,
          'P-000004',
        );

        const updatedStore = getStore();
        const personPmsLinks = updatedStore.pmsLinks.filter(
          (l) =>
            l.entityType === 'person' &&
            (l.onesquaredId === survivorPerson.id || l.onesquaredId === mergedPerson.id),
        );
        expect(personPmsLinks).toHaveLength(1);
        expect(personPmsLinks[0]?.onesquaredId).toBe(survivorPerson.id);
        expect(personPmsLinks[0]?.pmsCode).toBe('PMS-PER-MERGED');

        const orgPmsLinks = updatedStore.pmsLinks.filter(
          (l) =>
            l.entityType === 'organisation' &&
            (l.onesquaredId === survivorOrg.id || l.onesquaredId === mergedOrg.id),
        );
        expect(orgPmsLinks).toHaveLength(1);
        expect(orgPmsLinks[0]?.onesquaredId).toBe(survivorOrg.id);
        expect(orgPmsLinks[0]?.pmsCode).toBe('PMS-ORG-SURV');
        expect(orgMergeHistory.pmsLinkConflicts).toEqual([
          { keptPmsCode: 'PMS-ORG-SURV', discardedPmsCode: 'PMS-ORG-MERG' },
        ]);
        expect(
          (await auditSinceTestStart()).some(
            (a) =>
              a.recordId === survivorOrg.id &&
              a.action === 'merge' &&
              a.field === 'PMS link conflict' &&
              a.oldValue === 'PMS-ORG-MERG' &&
              a.newValue === 'PMS-ORG-SURV',
          ),
        ).toBe(true);
      } finally {
        setTestEntraSessionOverride(undefined);
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });

    it('8. Generated documents and documentLinks: repoints primaryClientId, recipientPartyId, and documentLinks in both store and TenantDocumentRepository (R275)', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      try {
        setVerifiedAdminMergeSession();
        const survivorPerson = (await savePersonRecord(
          { firstName: 'Alun', surname: 'DocSurvivor', isEmployee: false },
          { byId: 'P-000004' },
        )).person!;
        const mergedPerson = (await savePersonRecord(
          { firstName: 'Alun', surname: 'DocDuplicate', isEmployee: false },
          { byId: 'P-000004' },
        )).person!;
        const survivorOrg = (await saveOrganisationRecord(
          { legalName: 'Bryn Doc Survivor Ltd' },
          { byId: 'P-000004' },
        )).organisation!;
        const mergedOrg = (await saveOrganisationRecord(
          { legalName: 'Bryn Doc Duplicate Ltd' },
          { byId: 'P-000004' },
        )).organisation!;

        const store = getStore();
        const resetCtx = testDataResetContext();
        const matter = (await getMatterRepository().listAllMatters<Matter>(resetCtx))[0]!;
        const tenantCfg = getActiveTenantConfiguration();
        const repo = getDocumentRepository();
        const adminActor = (await getPartyRepository().getPersonById<Person>(resetCtx, 'P-000004'))!;
        const ctx = resolveTenantFromVerifiedToken({
          verifiedToken: {
            __verifiedByOidcMiddleware: true,
            sub: adminActor.id,
            tenantId: tenantCfg.tenantId,
            email: adminActor.emails[0]?.address ?? 'admin@notalawfirm.example',
            name: 'Admin User',
            roles: ['admin'],
            entraObjectId: adminActor.entraObjectId ?? '00000000-0000-4000-8000-000000000004',
            mfaVerified: true,
          },
          hostingMode: tenantCfg.hostingMode,
          environment: tenantCfg.environment,
          correlationId: 'test-s0-09-doc-repo',
        });

        const docRecord = {
          id: 'DOC-S009-1',
          tenantId: ctx.tenantId,
          title: 'Client Care Letter',
          fileName: 'ccl.docx',
          documentType: 'letter',
          outputFormat: 'docx' as const,
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          fileSizeBytes: 1024,
          fileSha256: 'abc123',
          templateId: 'TPL-1',
          templateName: 'CCL',
          templateVersionId: 'TPLV-1',
          templateVersionNumber: 1,
          storageProvider: 'local-fs' as const,
          storageKey: 'blob-s009-1',
          generatedByUserId: 'P-000004',
          generatedAt: new Date().toISOString(),
          primaryMatterId: matter.id,
          primaryClientId: mergedOrg.id,
          recipientPartyId: mergedPerson.id,
          isDeleted: false,
        };
        const docLinkPerson = {
          id: 'DL-S009-PER',
          tenantId: ctx.tenantId,
          documentId: docRecord.id,
          entityType: 'person' as const,
          entityId: mergedPerson.id,
          linkRole: 'recipient_party' as const,
          createdAt: new Date().toISOString(),
        };
        const docLinkOrg = {
          id: 'DL-S009-ORG',
          tenantId: ctx.tenantId,
          documentId: docRecord.id,
          entityType: 'organisation' as const,
          entityId: mergedOrg.id,
          linkRole: 'primary_client' as const,
          createdAt: new Date().toISOString(),
        };
        store.documents = [...(store.documents ?? []), { ...docRecord }];
        store.documentLinks = [
          ...(store.documentLinks ?? []),
          { ...docLinkPerson },
          { ...docLinkOrg },
        ];
        await repo.putDocument(ctx, docRecord);
        await repo.putDocumentLink(ctx, docLinkPerson);
        await repo.putDocumentLink(ctx, docLinkOrg);

        await executeMerge('person', survivorPerson.id, mergedPerson.id, 'P-000004');
        await executeMerge('organisation', survivorOrg.id, mergedOrg.id, 'P-000004');

        const storeDoc = (await repo.getDocumentById(ctx, docRecord.id))!;
        expect(storeDoc.primaryClientId).toBe(survivorOrg.id);
        expect(storeDoc.recipientPartyId).toBe(survivorPerson.id);
        expect(
          (await repo.listLinksForDocument(ctx, docRecord.id)).some(
            (l) => l.entityId === mergedPerson.id || l.entityId === mergedOrg.id,
          ),
        ).toBe(false);

        const docsForSurvivorPerson = await repo.listDocumentsForEntity(
          ctx,
          'person',
          survivorPerson.id,
        );
        expect(docsForSurvivorPerson.map((d) => d.id)).toContain(docRecord.id);
        expect(await repo.listDocumentsForEntity(ctx, 'person', mergedPerson.id)).toHaveLength(0);

        const docsForSurvivorOrg = await repo.listDocumentsForEntity(
          ctx,
          'organisation',
          survivorOrg.id,
        );
        expect(docsForSurvivorOrg.map((d) => d.id)).toContain(docRecord.id);
        expect(await repo.listDocumentsForEntity(ctx, 'organisation', mergedOrg.id)).toHaveLength(0);
      } finally {
        setTestEntraSessionOverride(undefined);
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });

    it('9. Notes, Person.createdFromEnquiryId, recentlyViewed, notifications, and untouched pre-existing audit recordIds (R275)', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      try {
        setVerifiedAdminMergeSession();
        const survivorPerson = (await savePersonRecord(
          { firstName: 'Alun', surname: 'MiscSurvivor', isEmployee: false },
          { byId: 'P-000004' },
        )).person!;
        const mergedPerson = (await savePersonRecord(
          { firstName: 'Alun', surname: 'MiscDuplicate', isEmployee: false },
          { byId: 'P-000004' },
        )).person!;
        const survivorOrg = (await saveOrganisationRecord(
          { legalName: 'Bryn Misc Survivor Ltd' },
          { byId: 'P-000004' },
        )).organisation!;
        const mergedOrg = (await saveOrganisationRecord(
          { legalName: 'Bryn Misc Duplicate Ltd' },
          { byId: 'P-000004' },
        )).organisation!;

        const store = getStore();
        const ctx = testDataResetContext();
        const storeMergedPerson = (await getPartyRepository().getPersonById<Person>(ctx, mergedPerson.id))!;
        storeMergedPerson.createdFromEnquiryId = 'ENQ-ORIGIN-99';
        await getPartyRepository().putPerson(ctx, storeMergedPerson);

        await addNoteToRecord('person', mergedPerson.id, 'Merged person note', 'P-000004');
        store.recentlyViewed['P-000001'] = [mergedPerson.id, survivorPerson.id, mergedOrg.id];
        store.notifications.push({
          id: 'NTF-MERGE-1',
          recipientId: 'P-000001',
          kind: 'enquiry_assigned',
          title: 'Follow up with Alun',
          detail: 'Call client',
          href: `/people/${mergedPerson.id}`,
          recordId: mergedPerson.id,
          createdAt: new Date().toISOString(),
          read: false,
          byId: 'P-000004',
        });

        const preMergeAuditIdsForMergedPerson = (await auditSinceTestStart())
          .filter((a) => a.recordId === mergedPerson.id)
          .map((a) => a.id);
        expect(preMergeAuditIdsForMergedPerson.length).toBeGreaterThan(0);

        await executeMerge('person', survivorPerson.id, mergedPerson.id, 'P-000004');
        await executeMerge('organisation', survivorOrg.id, mergedOrg.id, 'P-000004');

        const updatedStore = getStore();
        const updatedNotes = await getPartyRepository().listAllNotes<import('@/domain/types').Note>(ctx);
        const updatedPeople = await getPartyRepository().listAllPeople<Person>(ctx);
        expect(
          updatedNotes.some(
            (n) =>
              n.recordId === survivorPerson.id &&
              n.mergedFromId === mergedPerson.id &&
              n.text === 'Merged person note',
          ),
        ).toBe(true);
        const updatedSurvivorPerson = updatedPeople.find(
          (p) => p.id === survivorPerson.id,
        )!;
        const updatedMergedPerson = updatedPeople.find((p) => p.id === mergedPerson.id)!;
        expect(updatedSurvivorPerson.createdFromEnquiryId).toBe('ENQ-ORIGIN-99');
        expect(updatedMergedPerson.createdFromEnquiryId).toBeNull();
        expect(updatedMergedPerson.mergedIntoId).toBe(survivorPerson.id);

        expect(updatedStore.recentlyViewed['P-000001']).toEqual([
          survivorPerson.id,
          survivorOrg.id,
        ]);
        const updatedNotif = updatedStore.notifications.find((n) => n.id === 'NTF-MERGE-1')!;
        expect(updatedNotif.recordId).toBe(survivorPerson.id);
        expect(updatedNotif.href).toBe(`/people/${survivorPerson.id}`);

        const postMergeMergedPersonAudit = await auditSinceTestStart();
        for (const auditId of preMergeAuditIdsForMergedPerson) {
          const entry = postMergeMergedPersonAudit.find((a) => a.id === auditId)!;
          expect(entry.recordId).toBe(mergedPerson.id);
        }
      } finally {
        setTestEntraSessionOverride(undefined);
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });

    it('10. Atomic rollback (R272, R282, R296, R406): rolls back both PostgreSQL TenantDocumentRepository and JSON store via RecordDeltaCompensator when saveStore fails after PostgreSQL repointing', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      const repo = getDocumentRepository();
      const savedJsonValue = global.__oneSquaredLastSavedStoreJson;
      try {
        setVerifiedAdminMergeSession();
        const survivorPerson = (await savePersonRecord(
          { firstName: 'Alun', surname: 'RollbackSurvivor', isEmployee: false },
          { byId: 'P-000004' },
        )).person!;
        const mergedPerson = (await savePersonRecord(
          { firstName: 'Alun', surname: 'RollbackMerged', isEmployee: false },
          { byId: 'P-000004' },
        )).person!;

        const store = getStore();
        const resetCtx = testDataResetContext();
        const matter = (await getMatterRepository().listAllMatters<Matter>(resetCtx))[0]!;
        matter.instructingContactId = mergedPerson.id;
        await getMatterRepository().putMatter(resetCtx, matter, { expectedRowVersion: null });
        const enq = store.enquiries[0]!;
        enq.linkedPersonId = mergedPerson.id;

        const tenantCfg = getActiveTenantConfiguration();
        const adminActor = (await getPartyRepository().getPersonById<Person>(resetCtx, 'P-000004'))!;
        const ctx = resolveTenantFromVerifiedToken({
          verifiedToken: {
            __verifiedByOidcMiddleware: true,
            sub: adminActor.id,
            tenantId: tenantCfg.tenantId,
            email: adminActor.emails[0]?.address ?? 'admin@notalawfirm.example',
            name: 'Admin User',
            roles: ['admin'],
            entraObjectId: adminActor.entraObjectId ?? '00000000-0000-4000-8000-000000000004',
            mfaVerified: true,
          },
          hostingMode: tenantCfg.hostingMode,
          environment: tenantCfg.environment,
          correlationId: 'test-s0-09-r282',
        });

        const doc1 = {
          id: 'DOC-R282-1',
          tenantId: ctx.tenantId,
          title: 'First Document',
          fileName: 'doc1.docx',
          documentType: 'letter',
          outputFormat: 'docx' as const,
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          fileSizeBytes: 512,
          fileSha256: 'sha-r282-1',
          templateId: 'TPL-1',
          templateName: 'CCL',
          templateVersionId: 'TPLV-1',
          templateVersionNumber: 1,
          storageProvider: 'local-fs' as const,
          storageKey: 'blob-r282-1',
          generatedByUserId: 'P-000004',
          generatedAt: new Date().toISOString(),
          primaryMatterId: matter.id,
          primaryClientId: mergedPerson.id,
          recipientPartyId: mergedPerson.id,
          isDeleted: false,
        };
        const doc2 = {
          ...doc1,
          id: 'DOC-R282-2',
          title: 'Second Document',
          fileName: 'doc2.docx',
          storageKey: 'blob-r282-2',
        };
        const link1 = {
          id: 'DL-R282-1',
          tenantId: ctx.tenantId,
          documentId: doc1.id,
          entityType: 'person' as const,
          entityId: mergedPerson.id,
          linkRole: 'recipient_party' as const,
          createdAt: new Date().toISOString(),
        };
        await repo.putDocument(ctx, doc1);
        await repo.putDocument(ctx, doc2);
        await repo.putDocumentLink(ctx, link1);
        saveStore(store);

        // R296: clearStoreMemoryCache throws outside test environments
        const prevVitest = process.env.VITEST;
        const prevNodeEnv = process.env.NODE_ENV;
        try {
          delete process.env.VITEST;
          (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
          expect(() => clearStoreMemoryCache()).toThrow(
            /clearStoreMemoryCache is only permitted in test environments/,
          );
        } finally {
          if (prevVitest !== undefined) process.env.VITEST = prevVitest;
          (process.env as Record<string, string | undefined>).NODE_ENV = prevNodeEnv;
        }

        // Force saveStore to fail AFTER PostgreSQL repointMergedEntityWithDelta has committed
        let currentSavedJson = global.__oneSquaredLastSavedStoreJson;
        let failNextSave = true;
        Object.defineProperty(global, '__oneSquaredLastSavedStoreJson', {
          configurable: true,
          get() {
            return currentSavedJson;
          },
          set(val: string | undefined) {
            if (failNextSave) {
              failNextSave = false;
              throw new Error('SIMULATED_POST_PG_SAVE_STORE_FAILURE');
            }
            currentSavedJson = val;
          },
        });

        await expect(
          executeMerge('person', survivorPerson.id, mergedPerson.id, 'P-000004'),
        ).rejects.toThrow(/SIMULATED_POST_PG_SAVE_STORE_FAILURE/);

        // PostgreSQL documents and links are compensated back to their pre-merge state
        expect((await repo.getDocumentById(ctx, doc1.id))?.primaryClientId).toBe(mergedPerson.id);
        expect((await repo.getDocumentById(ctx, doc1.id))?.recipientPartyId).toBe(mergedPerson.id);
        expect((await repo.getDocumentById(ctx, doc2.id))?.primaryClientId).toBe(mergedPerson.id);
        expect(
          (await repo.listDocumentsForEntity(ctx, 'person', mergedPerson.id)).map((d) => d.id),
        ).toEqual(expect.arrayContaining([doc1.id, doc2.id]));
        const survivorRepoDocIds = (
          await repo.listDocumentsForEntity(ctx, 'person', survivorPerson.id)
        ).map((d) => d.id);
        expect(survivorRepoDocIds).not.toContain(doc1.id);
        expect(survivorRepoDocIds).not.toContain(doc2.id);

        expect(
          (await getMatterRepository().getMatterById<Matter>(ctx, matter.id))?.instructingContactId,
        ).toBe(mergedPerson.id);
        clearStoreMemoryCache();
        const reloadedAfterLoopFail = getStore();
        expect(
          (await getMatterRepository().getMatterById<Matter>(ctx, matter.id))?.instructingContactId,
        ).toBe(mergedPerson.id);
        expect(reloadedAfterLoopFail.enquiries.find((e) => e.id === enq.id)?.linkedPersonId).toBe(
          mergedPerson.id,
        );
        expect(
          (await getPartyRepository().getPersonById<Person>(ctx, mergedPerson.id))?.mergedIntoId,
        ).toBeNull();
        expect(await getPartyRepository().listAllMergeHistory(ctx)).toHaveLength(0);
      } finally {
        Object.defineProperty(global, '__oneSquaredLastSavedStoreJson', {
          configurable: true,
          writable: true,
          value: savedJsonValue,
        });
        setTestEntraSessionOverride(undefined);
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });

    it('10b. Atomic rollback Case 2 (R272, R282, R296): rolls back in-memory and persisted store when PostgreSQL repointMergedEntityWithDelta throws before saveStore', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      const repo = getDocumentRepository();
      const origRepoint = repo.repointMergedEntityWithDelta.bind(repo);
      try {
        setVerifiedAdminMergeSession();
        const survivorPerson = (await savePersonRecord(
          { firstName: 'Alun', surname: 'RollbackSurvivorCase2', isEmployee: false },
          { byId: 'P-000004' },
        )).person!;
        const mergedPerson = (await savePersonRecord(
          { firstName: 'Alun', surname: 'RollbackMergedCase2', isEmployee: false },
          { byId: 'P-000004' },
        )).person!;

        const store = getStore();
        const ctx = testDataResetContext();
        const matter = (await getMatterRepository().listAllMatters<Matter>(ctx))[0]!;
        matter.instructingContactId = mergedPerson.id;
        await getMatterRepository().putMatter(ctx, matter, { expectedRowVersion: null });
        const enq = store.enquiries[0]!;
        enq.linkedPersonId = mergedPerson.id;
        saveStore(store);

        repo.repointMergedEntityWithDelta = async () => {
          throw new Error('SIMULATED_PRE_SAVE_DOC_STEP_FAILURE');
        };
        await expect(
          executeMerge('person', survivorPerson.id, mergedPerson.id, 'P-000004'),
        ).rejects.toThrow(/SIMULATED_PRE_SAVE_DOC_STEP_FAILURE/);
        repo.repointMergedEntityWithDelta = origRepoint;

        const inMemoryAfterPreSaveFail = getStore();
        expect(
          (await getMatterRepository().getMatterById<Matter>(ctx, matter.id))?.instructingContactId,
        ).toBe(mergedPerson.id);
        expect(
          inMemoryAfterPreSaveFail.enquiries.find((e) => e.id === enq.id)?.linkedPersonId,
        ).toBe(mergedPerson.id);
        expect(
          (await getPartyRepository().getPersonById<Person>(ctx, mergedPerson.id))?.mergedIntoId,
        ).toBeNull();
        expect(await getPartyRepository().listAllMergeHistory(ctx)).toHaveLength(0);

        clearStoreMemoryCache();
        const reloadedAfterPreSaveFail = getStore();
        expect(
          (await getMatterRepository().getMatterById<Matter>(ctx, matter.id))?.instructingContactId,
        ).toBe(mergedPerson.id);
        expect(
          reloadedAfterPreSaveFail.enquiries.find((e) => e.id === enq.id)?.linkedPersonId,
        ).toBe(mergedPerson.id);
        expect(
          (await getPartyRepository().getPersonById<Person>(ctx, mergedPerson.id))?.mergedIntoId,
        ).toBeNull();
        expect(await getPartyRepository().listAllMergeHistory(ctx)).toHaveLength(0);
      } finally {
        repo.repointMergedEntityWithDelta = origRepoint;
        setTestEntraSessionOverride(undefined);
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });

    it('10c. Atomic rollback Case 3 (R309): when both the first saveStore and the rollback saveStore throw, logs rollback failure with correlationId and tenantId only and rethrows the original error', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const savedJsonValue = global.__oneSquaredLastSavedStoreJson;
      try {
        setVerifiedAdminMergeSession();
        const survivorPerson = (await savePersonRecord(
          { firstName: 'Alun', surname: 'RollbackSurvivorCase3', isEmployee: false },
          { byId: 'P-000004' },
        )).person!;
        const mergedPerson = (await savePersonRecord(
          { firstName: 'Alun', surname: 'RollbackMergedCase3', isEmployee: false },
          { byId: 'P-000004' },
        )).person!;

        const store = getStore();
        const enq = store.enquiries[0]!;
        enq.linkedPersonId = mergedPerson.id;
        saveStore(store);

        const priorSavedJson = global.__oneSquaredLastSavedStoreJson;
        let saveAttempts = 0;
        Object.defineProperty(global, '__oneSquaredLastSavedStoreJson', {
          configurable: true,
          get() {
            return priorSavedJson;
          },
          set() {
            saveAttempts += 1;
            if (saveAttempts === 1) {
              throw new Error('SIMULATED_FIRST_SAVE_STORE_FAILURE');
            }
            throw new Error('SIMULATED_ROLLBACK_SAVE_STORE_FAILURE');
          },
        });

        await expect(executeMerge('person', survivorPerson.id, mergedPerson.id, 'P-000004')).rejects.toThrow('SIMULATED_FIRST_SAVE_STORE_FAILURE');
        expect(saveAttempts).toBe(2);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        const loggedArg = String(errorSpy.mock.calls[0]?.[0] ?? '');
        const parsedLog = JSON.parse(loggedArg) as {
          level?: string;
          event?: string;
          correlationId?: string;
          tenantId?: string;
        };
        expect(parsedLog.level).toBe('error');
        expect(parsedLog.event).toBe('merge.rollback_save_failed');
        expect(parsedLog.correlationId).toBeTruthy();
        expect(parsedLog.tenantId).toBe('not-a-law-firm');
        expect(loggedArg).not.toContain('RollbackSurvivorCase3');
        expect(loggedArg).not.toContain('RollbackMergedCase3');
        expect(loggedArg).not.toContain('SIMULATED_');
      } finally {
        Object.defineProperty(global, '__oneSquaredLastSavedStoreJson', {
          configurable: true,
          writable: true,
          value: savedJsonValue,
        });
        errorSpy.mockRestore();
        setTestEntraSessionOverride(undefined);
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });

    it('redirects merged person and organisation tombstone pages and edit pages to the survivor', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      try {
        setVerifiedAdminMergeSession();
        const sPerson = (await savePersonRecord(
          { firstName: 'Nia', surname: 'Survivor', isEmployee: false },
          { byId: 'P-000004' },
        )).person!;
        const mPerson = (await savePersonRecord(
          { firstName: 'Nia', surname: 'Merged', isEmployee: false },
          { byId: 'P-000004' },
        )).person!;
        await executeMerge('person', sPerson.id, mPerson.id, 'P-000004');

        const sOrg = (await saveOrganisationRecord(
          { legalName: 'Nia Survivor Co' },
          { byId: 'P-000004' },
        )).organisation!;
        const mOrg = (await saveOrganisationRecord(
          { legalName: 'Nia Merged Co' },
          { byId: 'P-000004' },
        )).organisation!;
        await executeMerge('organisation', sOrg.id, mOrg.id, 'P-000004');

        const captureRedirect = async (fn: () => Promise<unknown>): Promise<string> => {
          try {
            await fn();
            return '';
          } catch (err) {
            const digest = (err as { digest?: string })?.digest ?? '';
            return digest || (err instanceof Error ? err.message : String(err));
          }
        };

        const personViewRedirect = await captureRedirect(() =>
          PersonProfilePage({
            params: Promise.resolve({ id: mPerson.id }),
            searchParams: Promise.resolve({}),
          }),
        );
        expect(personViewRedirect).toContain(
          `/people/${sPerson.id}?mergedFrom=${mPerson.id}`,
        );

        const personEditRedirect = await captureRedirect(() =>
          EditPersonPage({
            params: Promise.resolve({ id: mPerson.id }),
          }),
        );
        expect(personEditRedirect).toContain(`/people/${sPerson.id}/edit`);

        const orgViewRedirect = await captureRedirect(() =>
          OrganisationProfilePage({
            params: Promise.resolve({ id: mOrg.id }),
            searchParams: Promise.resolve({}),
          }),
        );
        expect(orgViewRedirect).toContain(
          `/organisations/${sOrg.id}?mergedFrom=${mOrg.id}`,
        );

        const orgEditRedirect = await captureRedirect(() =>
          EditOrganisationPage({
            params: Promise.resolve({ id: mOrg.id }),
          }),
        );
        expect(orgEditRedirect).toContain(`/organisations/${sOrg.id}/edit`);
      } finally {
        setTestEntraSessionOverride(undefined);
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });
  });

  describe('Slice S0-10: Finance data delivery and credit-control permission gating (ADR 0029)', () => {
    const REMOVED_SNAPSHOT_FINANCE_KEYS = [
      'canViewFinance',
      'pmsExtractInfo',
      'pmsLinks',
      'pmsSummaryByMatterId',
      'pmsSummaryByClientId',
      'allMatterFins',
      'allClientFins',
      'allFeeEarnerPerformance',
      'myFeeEarnerFigures',
      'myWeeklyTime',
      'pmsAgedDebt',
      'pmsInvoices',
      'pmsMonthlyFeesBilled',
      'pmsCashReceived',
      'pmsDepartmentFinancials',
      'pmsAllDisbursements',
      'pmsClientAccountByMatterCode',
    ] as const;

    it('1. getAppSnapshot for any role contains none of the removed finance fields and exposes capabilities only', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      const roleTestUsers = [
        {
          id: 'P-000001',
          expected: { canViewFirm: true, canViewMatter: true, canCreditControl: true },
        },
        {
          id: 'P-000002',
          expected: { canViewFirm: false, canViewMatter: true, canCreditControl: false },
        },
        {
          id: 'P-000004',
          expected: { canViewFirm: true, canViewMatter: true, canCreditControl: true },
        },
        {
          id: 'P-000006',
          expected: { canViewFirm: false, canViewMatter: true, canCreditControl: false },
        },
        {
          id: 'P-000009',
          expected: { canViewFirm: true, canViewMatter: true, canCreditControl: true },
        },
        {
          id: 'P-000010',
          expected: { canViewFirm: false, canViewMatter: false, canCreditControl: false },
        },
      ];

      for (const { id, expected } of roleTestUsers) {
        const snap = await runAsTestActor(id, () => getAppSnapshot(id));
        for (const removedKey of REMOVED_SNAPSHOT_FINANCE_KEYS) {
          expect(
            removedKey in (snap as unknown as Record<string, unknown>),
            `Expected ${removedKey} to be absent from getAppSnapshot(${id})`,
          ).toBe(false);
        }
        expect(snap.finance).toEqual(expected);
      }

      // Verify leftRailVisibility does not widen finance capabilities for a risk/compliance user without finance permissions
      const ctx = testDataResetContext();
      const riskPerson = (await getPartyRepository().getPersonById<Person>(ctx, 'P-000003'))!;
      riskPerson.permissionOverrides = {
        grant: ['risk:view'],
        revoke: ['finance:view', 'finance:view_matter', 'finance:credit_control'],
      };
      await getPartyRepository().putPerson(ctx, riskPerson);
      const riskSnap = await runAsTestActor('P-000003', () => getAppSnapshot('P-000003'));
      expect(riskSnap.finance).toEqual({
        canViewFirm: false,
        canViewMatter: false,
        canCreditControl: false,
      });
    });

    it('2. canUserViewFinance(null) is false and attentionList hides PMS financial alerts by default or without capability', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      const snap = await runAsTestActor('P-000001', () => getAppSnapshot('P-000001'));
      expect(canUserViewFinance(null, snap.teams, snap.values)).toBe(false);
      expect(canUserViewFinance(undefined, snap.teams, snap.values)).toBe(false);

      const rowsRes = await getMatterFinanceRows('P-000001');
      expect(isActionDenied(rowsRes)).toBe(false);
      if (isActionDenied(rowsRes)) return;

      const allRecords = [...snap.people, ...snap.organisations];
      const today = new Date('2026-10-16T10:00:00Z');
      const itemsDefault = attentionList(allRecords, snap.values, today, {
        tasks: snap.tasks,
        enquiries: snap.enquiries,
        teams: snap.teams,
        matters: snap.matters,
        pmsSummaryByMatterId: rowsRes.pmsSummaryByMatterId,
      });
      expect(itemsDefault.some((i) => i.kind.startsWith('pms_'))).toBe(false);

      // Support staff / enquiries coordinator snapshot attention list has no PMS financial alerts
      const supportSnap = await runAsTestActor('P-000010', () => getAppSnapshot('P-000010'));
      expect(
        supportSnap.attention.some((i) => i.kind.startsWith('pms_')),
      ).toBe(false);
    });

    it('3. each finance loader returns FORBIDDEN when its permission key is removed and returns data when granted, and fee earner gets FORBIDDEN from getFirmFinance', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      try {
        const store = getStore();
        const ctx = testTenantCtx('P-000001');
        const partyRepo = getPartyRepository();
        const partner = (await partyRepo.getPersonById<import('@/domain/types').Person>(ctx, 'P-000001'))!;

        // Positive controls with partner (holds finance:view_matter and finance:view)
        const okRows = await getMatterFinanceRows('P-000001');
        expect(isActionDenied(okRows)).toBe(false);
        if (!isActionDenied(okRows)) {
          expect(okRows.allMatterFins.length).toBeGreaterThan(0);
        }

        const okMine = await getMyFinanceFigures('P-000001');
        expect(isActionDenied(okMine)).toBe(false);
        if (!isActionDenied(okMine)) {
          expect(okMine.myFeeEarnerFigures).not.toBeNull();
        }

        const okFirm = await getFirmFinance('P-000001');
        expect(isActionDenied(okFirm)).toBe(false);
        if (!isActionDenied(okFirm)) {
          expect(okFirm.allFeeEarnerPerformance.length).toBeGreaterThan(0);
        }

        const okMatterBundle = await getMatterPmsViewBundle('M-000001', 'P-000001');
        expect(isActionDenied(okMatterBundle)).toBe(false);

        const okClientBundle = await getClientPmsViewBundle('organisation', 'O-000001', 'P-000001');
        expect(isActionDenied(okClientBundle)).toBe(false);

        // Revoke finance:view_matter on partner and assert FORBIDDEN on the 4 matter-level loaders
        partner.permissionOverrides = {
          grant: [],
          revoke: ['finance:view_matter'],
        };
        await partyRepo.putPerson(ctx, partner);

        const deniedRows = await getMatterFinanceRows('P-000001');
        expect(isActionDenied(deniedRows)).toBe(true);
        if (isActionDenied(deniedRows)) {
          expect(deniedRows.code).toBe('FORBIDDEN');
          expect(deniedRows.message).toContain('finance:view_matter');
        }

        const deniedMine = await getMyFinanceFigures('P-000001');
        expect(isActionDenied(deniedMine)).toBe(true);
        if (isActionDenied(deniedMine)) {
          expect(deniedMine.code).toBe('FORBIDDEN');
          expect(deniedMine.message).toContain('finance:view_matter');
        }

        const deniedMatterBundle = await getMatterPmsViewBundle('M-000001', 'P-000001');
        expect(isActionDenied(deniedMatterBundle)).toBe(true);
        if (isActionDenied(deniedMatterBundle)) {
          expect(deniedMatterBundle.code).toBe('FORBIDDEN');
          expect(deniedMatterBundle.message).toContain('finance:view_matter');
        }

        const deniedClientBundle = await getClientPmsViewBundle('organisation', 'O-000001', 'P-000001');
        expect(isActionDenied(deniedClientBundle)).toBe(true);
        if (isActionDenied(deniedClientBundle)) {
          expect(deniedClientBundle.code).toBe('FORBIDDEN');
          expect(deniedClientBundle.message).toContain('finance:view_matter');
        }

        // Revoke finance:view on partner and assert FORBIDDEN on getFirmFinance
        partner.permissionOverrides = {
          grant: [],
          revoke: ['finance:view'],
        };
        await partyRepo.putPerson(ctx, partner);
        const deniedFirm = await getFirmFinance('P-000001');
        expect(isActionDenied(deniedFirm)).toBe(true);
        if (isActionDenied(deniedFirm)) {
          expect(deniedFirm.code).toBe('FORBIDDEN');
          expect(deniedFirm.message).toContain('finance:view');
        }

        partner.permissionOverrides = undefined;
        await partyRepo.putPerson(ctx, partner);

        // Fee earner (P-000002, holds finance:view_matter only) gets own figures and matter rows, and FORBIDDEN from getFirmFinance
        const feRows = await getMatterFinanceRows('P-000002');
        expect(isActionDenied(feRows)).toBe(false);
        if (!isActionDenied(feRows)) {
          expect(feRows.allMatterFins.length).toBeGreaterThan(0);
        }

        const feMine = await getMyFinanceFigures('P-000002');
        expect(isActionDenied(feMine)).toBe(false);
        if (!isActionDenied(feMine)) {
          expect(feMine.myFeeEarnerFigures?.fee_earner_id).toBe('FE005');
          expect(feMine.myWeeklyTime?.feeEarnerId).toBe('FE005');
        }

        const feFirm = await getFirmFinance('P-000002');
        expect(isActionDenied(feFirm)).toBe(true);
        if (isActionDenied(feFirm)) {
          expect(feFirm.code).toBe('FORBIDDEN');
          expect(feFirm.message).toContain('finance:view');
        }

        // R314: Unlinked PMS matters fail closed on all 4 matter-level loaders, while getFirmFinance includes them, and allUnlinkedPmsMatters requires finance:manage_links
        const pms = getPmsSource();
        const linkedMatterCodes = new Set(
          store.pmsLinks.filter((l) => l.entityType === 'matter').map((l) => l.pmsCode),
        );
        const unlinkedMatterCodes = pms
          .listMatters()
          .map((m) => m.matter_code)
          .filter((c) => !linkedMatterCodes.has(c));
        expect(unlinkedMatterCodes.length).toBe(9);
        expect(unlinkedMatterCodes).toContain('BRI001-0002');
        expect(unlinkedMatterCodes).toContain('SEV001-0002');

        if (!isActionDenied(feRows)) {
          for (const unlinkedCode of unlinkedMatterCodes) {
            expect(feRows.allMatterFins.some((m) => m.matter_code === unlinkedCode)).toBe(
              false,
            );
            expect(feRows.pmsAgedDebt.some((i) => i.matter_code === unlinkedCode)).toBe(
              false,
            );
            expect(feRows.pmsInvoices.some((i) => i.matter_code === unlinkedCode)).toBe(
              false,
            );
            expect(
              feRows.pmsAllDisbursements.some((d) => d.matter_code === unlinkedCode),
            ).toBe(false);
            expect(unlinkedCode in feRows.pmsClientAccountByMatterCode).toBe(false);
          }
        }

        // Unlink PEN001-0001 (M-000001, where FE005 has 7.0h Oct time and £3,010 unbilled WIP across Sept+Oct) and verify getMyFinanceFigures excludes it
        const penLinkIdx = store.pmsLinks.findIndex(
          (l) => l.entityType === 'matter' && l.pmsCode === 'PEN001-0001',
        );
        expect(penLinkIdx).toBeGreaterThanOrEqual(0);
        const [removedPenLink] = store.pmsLinks.splice(penLinkIdx, 1);
        const feMineWithoutPen = await getMyFinanceFigures('P-000002');
        store.pmsLinks.splice(penLinkIdx, 0, removedPenLink!);
        expect(isActionDenied(feMineWithoutPen)).toBe(false);
        if (!isActionDenied(feMine) && !isActionDenied(feMineWithoutPen)) {
          expect(
            Math.round(
              ((feMine.myFeeEarnerFigures?.chargeable_hours_this_month ?? 0) -
                (feMineWithoutPen.myFeeEarnerFigures?.chargeable_hours_this_month ?? 0)) *
                10,
            ) / 10,
          ).toBe(7.0);
          expect(
            Math.round(
              ((feMine.myFeeEarnerFigures?.unbilled_wip ?? 0) -
                (feMineWithoutPen.myFeeEarnerFigures?.unbilled_wip ?? 0)) *
                100,
            ) / 100,
          ).toBe(3010);
        }

        // getClientPmsViewBundle for O-000005 (SEV001) excludes unlinked SEV001-0002 for a finance:view_matter user
        const feClientBundle = await getClientPmsViewBundle(
          'organisation',
          'O-000005',
          'P-000002',
        );
        expect(isActionDenied(feClientBundle)).toBe(false);
        if (!isActionDenied(feClientBundle)) {
          expect(
            feClientBundle.clientBundle?.matters.map((m) => m.matter_code),
          ).toEqual(['SEV001-0001']);
          expect(
            feClientBundle.clientBundle?.invoices.some(
              (inv) => inv.matter_code === 'SEV001-0002',
            ),
          ).toBe(false);
        }

        // getMatterPmsViewBundle on unlinked M-000002: allUnlinkedPmsMatters is empty without finance:manage_links and populated with finance:manage_links
        const feMatterBundle = await getMatterPmsViewBundle('M-000002', 'P-000002');
        expect(isActionDenied(feMatterBundle)).toBe(false);
        if (!isActionDenied(feMatterBundle)) {
          expect(feMatterBundle.matterBundle).toBeNull();
          expect(feMatterBundle.allUnlinkedPmsMatters).toEqual([]);
          expect(feMatterBundle.unlinkedPmsMattersForClient).toEqual([]);
        }
        const partnerMatterBundle = await getMatterPmsViewBundle('M-000002', 'P-000001');
        expect(isActionDenied(partnerMatterBundle)).toBe(false);
        if (!isActionDenied(partnerMatterBundle)) {
          expect(partnerMatterBundle.allUnlinkedPmsMatters).toEqual([]);
          expect(partnerMatterBundle.unlinkedPmsMattersForClient).toEqual([]);
        }
        const adminMatterBundle = await getMatterPmsViewBundle('M-000002', 'P-000004');
        expect(isActionDenied(adminMatterBundle)).toBe(false);
        if (!isActionDenied(adminMatterBundle)) {
          expect(adminMatterBundle.allUnlinkedPmsMatters.length).toBe(9);
        }

        // getFirmFinance (finance:view) includes unlinked PMS rows in firm totals (£181,673.48)
        if (!isActionDenied(okFirm)) {
          expect(okFirm.pmsMonthlyFeesBilled.yearToDateTotal).toBe(181673.48);
        }
      } finally {
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });

    it('4. restricted matters (1 staff matter and 1 ethical-wall matter in PMS) are excluded from every firm, client, and fee-earner rollup total with exact row-sum deltas', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      try {
        const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
        const round1 = (n: number) => Math.round((n + Number.EPSILON) * 10) / 10;
        const ctx = testTenantCtx('P-000001');
        const matterRepo = getMatterRepository();
        const partyRepo = getPartyRepository();
        const allMatters = await matterRepo.listAllMatters<import('@/domain/types').Matter>(ctx);
        const pms = getPmsSource();
        const extractInfo = pms.getExtractInfo();

        // BAY001-0001 (M-000014, Bay Cafés Ltd): mark as staff matter restricted to P-000001
        // (has billed=2750, wip=0, paid=0, debt=3300, overdueDebt=3300 in 90+ bucket)
        const staffMatter = allMatters.find((m) => m.matterNumber === 'BAY001-0001')!;
        staffMatter.isStaffMatter = true;
        staffMatter.restrictedAccessUserIds = ['P-000001'];
        staffMatter.leadFeeEarnerId = 'P-000001';
        staffMatter.responsiblePartnerId = 'P-000001';
        staffMatter.supervisingPartnerId = 'P-000001';
        staffMatter.teamMemberIds = [];
        await matterRepo.putMatter(ctx, staffMatter, { expectedRowVersion: null });

        // BRI001-0003 (M-000010, Acquisition of Afon Care Homes Ltd, Brightwater Care Group Ltd):
        // mark as ethical-wall matter restricted to P-000001 and P-000004 (has billed=41842, wip=11057, paid=29793, debt=22637.40 in Not yet due, octHours=41.5 including 24.1h / £8,194 WIP by FE002 P-000004)
        const wallMatter = allMatters.find(
          (m) => m.matterNumber === 'BRI001-0003' && m.title.includes('Afon Care'),
        )!;
        wallMatter.hasEthicalWall = true;
        wallMatter.restrictedAccessUserIds = ['P-000001', 'P-000004'];
        wallMatter.leadFeeEarnerId = 'P-000001';
        wallMatter.responsiblePartnerId = 'P-000001';
        wallMatter.supervisingPartnerId = 'P-000001';
        wallMatter.teamMemberIds = [];
        await matterRepo.putMatter(ctx, wallMatter, { expectedRowVersion: null });

        // Allow-listed user: P-000001 (Partner, holds finance:view & finance:view_matter, and is on both allow-lists)
        // Outsider user: P-000009 (Gethin Powell, Finance Manager, holds finance:view & finance:view_matter, on neither allow-list)
        const allowFirm = await getFirmFinance('P-000001');
        const outsiderFirm = await getFirmFinance('P-000009');
        expect(isActionDenied(allowFirm)).toBe(false);
        expect(isActionDenied(outsiderFirm)).toBe(false);
        if (isActionDenied(allowFirm) || isActionDenied(outsiderFirm)) return;

        // 0. Assert allowFirm equals buildFirmFinanceRollups(rows, new Set())
        const baselineRollups = buildFirmFinanceRollups(
          {
            asAtDate: extractInfo.asAtDate,
            feeEarners: pms.listFeeEarners(),
            clients: pms.listClients(),
            matterFinancials: pms.getAllMatterFinancials(),
            invoices: pms.listAllInvoiceBalances(),
            timeEntries: pms.listAllTimeEntries(),
            payments: pms.listAllPayments(),
          },
          new Set(),
        );
        expect(allowFirm.pmsMonthlyFeesBilled).toEqual(
          baselineRollups.pmsMonthlyFeesBilled,
        );
        expect(allowFirm.pmsCashReceived).toEqual(baselineRollups.pmsCashReceived);
        expect(allowFirm.pmsDepartmentFinancials).toEqual(
          baselineRollups.pmsDepartmentFinancials,
        );
        expect(allowFirm.allFeeEarnerPerformance).toEqual(
          baselineRollups.allFeeEarnerPerformance,
        );
        expect(allowFirm.allClientFins).toEqual(baselineRollups.allClientFins);

        // Summed rows of the staff matter (BAY001-0001) and walled matter (BRI001-0003):
        // Fees billed: 2750 + 41842 = 44592
        // Unbilled WIP: 0 + 11057 = 11057
        // Outstanding debt: 3300 + 22637.40 = 25937.40
        // Overdue debt: 3300 + 0 = 3300
        // Current-month (Oct) chargeable hours: 0 + 41.5 = 41.5
        // Previous-month (Sep) cash receipts: 0 + 29793 = 29793 (1 receipt)

        // 1. Monthly fees billed: allowed - outsider === 44592
        expect(
          round2(
            allowFirm.pmsMonthlyFeesBilled.yearToDateTotal -
              outsiderFirm.pmsMonthlyFeesBilled.yearToDateTotal,
          ),
        ).toBe(44592);

        // 2. Cash received: allowed - outsider equals exact payments on restricted matters
        expect(
          round2(
            allowFirm.pmsCashReceived.previousMonthTotal -
              outsiderFirm.pmsCashReceived.previousMonthTotal,
          ),
        ).toBe(29793);
        expect(
          allowFirm.pmsCashReceived.previousMonthReceiptCount -
            outsiderFirm.pmsCashReceived.previousMonthReceiptCount,
        ).toBe(1);

        // 3. Fee-earner performance: chargeable hours, current-month hours, time value, and WIP deltas
        const allowTotalMonthHours = round1(
          allowFirm.allFeeEarnerPerformance.reduce(
            (s, f) => s + f.chargeable_hours_this_month,
            0,
          ),
        );
        const outsiderTotalMonthHours = round1(
          outsiderFirm.allFeeEarnerPerformance.reduce(
            (s, f) => s + f.chargeable_hours_this_month,
            0,
          ),
        );
        expect(round1(allowTotalMonthHours - outsiderTotalMonthHours)).toBe(41.5);

        const allowTotalWip = round2(
          allowFirm.allFeeEarnerPerformance.reduce((s, f) => s + f.unbilled_wip, 0),
        );
        const outsiderTotalWip = round2(
          outsiderFirm.allFeeEarnerPerformance.reduce((s, f) => s + f.unbilled_wip, 0),
        );
        expect(round2(allowTotalWip - outsiderTotalWip)).toBe(11057);

        // 4. Department financials & firmTotal: exact deltas for billed, WIP, debt, overdueDebt, and currentMonthHours
        expect(
          round2(
            allowFirm.pmsDepartmentFinancials.firmTotal.billedThisYear -
              outsiderFirm.pmsDepartmentFinancials.firmTotal.billedThisYear,
          ),
        ).toBe(44592);
        expect(
          round2(
            allowFirm.pmsDepartmentFinancials.firmTotal.unbilledWip -
              outsiderFirm.pmsDepartmentFinancials.firmTotal.unbilledWip,
          ),
        ).toBe(11057);
        expect(
          round2(
            allowFirm.pmsDepartmentFinancials.firmTotal.outstandingDebt -
              outsiderFirm.pmsDepartmentFinancials.firmTotal.outstandingDebt,
          ),
        ).toBe(25937.4);
        expect(
          round2(
            allowFirm.pmsDepartmentFinancials.firmTotal.overdueDebt -
              outsiderFirm.pmsDepartmentFinancials.firmTotal.overdueDebt,
          ),
        ).toBe(3300);
        expect(
          round1(
            allowFirm.pmsDepartmentFinancials.firmTotal.currentMonthHours -
              outsiderFirm.pmsDepartmentFinancials.firmTotal.currentMonthHours,
          ),
        ).toBe(41.5);

        const allowPropDept = allowFirm.pmsDepartmentFinancials.departments.find(
          (d) => d.practiceArea === 'Real Estate & Property',
        )!;
        const outsiderPropDept = outsiderFirm.pmsDepartmentFinancials.departments.find(
          (d) => d.practiceArea === 'Real Estate & Property',
        )!;
        expect(round2(allowPropDept.overdueDebt - outsiderPropDept.overdueDebt)).toBe(
          3300,
        );

        const allowCorpDept = allowFirm.pmsDepartmentFinancials.departments.find(
          (d) => d.practiceArea === 'Corporate & Commercial',
        )!;
        const outsiderCorpDept = outsiderFirm.pmsDepartmentFinancials.departments.find(
          (d) => d.practiceArea === 'Corporate & Commercial',
        )!;
        expect(
          round1(allowCorpDept.currentMonthHours - outsiderCorpDept.currentMonthHours),
        ).toBe(41.5);

        // 5. Client financials (allClientFins): exact aged buckets and per-client cash (total_paid)
        const allowBay = allowFirm.allClientFins.find((c) => c.client_code === 'BAY001')!;
        const outsiderBay = outsiderFirm.allClientFins.find(
          (c) => c.client_code === 'BAY001',
        )!;
        expect(round2(allowBay.fees_billed - outsiderBay.fees_billed)).toBe(2750);
        expect(round2(allowBay.unbilled_wip - outsiderBay.unbilled_wip)).toBe(0);
        expect(round2(allowBay.total_paid - outsiderBay.total_paid)).toBe(0);
        expect(round2(allowBay.outstanding_debt - outsiderBay.outstanding_debt)).toBe(
          3300,
        );
        expect(round2(allowBay.aged_not_yet_due - outsiderBay.aged_not_yet_due)).toBe(0);
        expect(round2(allowBay.aged_1_30 - outsiderBay.aged_1_30)).toBe(0);
        expect(round2(allowBay.aged_31_60 - outsiderBay.aged_31_60)).toBe(0);
        expect(round2(allowBay.aged_61_90 - outsiderBay.aged_61_90)).toBe(0);
        expect(round2(allowBay.aged_90_plus - outsiderBay.aged_90_plus)).toBe(3300);

        const allowBri = allowFirm.allClientFins.find((c) => c.client_code === 'BRI001')!;
        const outsiderBri = outsiderFirm.allClientFins.find(
          (c) => c.client_code === 'BRI001',
        )!;
        expect(round2(allowBri.fees_billed - outsiderBri.fees_billed)).toBe(41842);
        expect(round2(allowBri.unbilled_wip - outsiderBri.unbilled_wip)).toBe(11057);
        expect(round2(allowBri.total_paid - outsiderBri.total_paid)).toBe(29793);
        expect(round2(allowBri.outstanding_debt - outsiderBri.outstanding_debt)).toBe(
          22637.4,
        );
        expect(round2(allowBri.aged_not_yet_due - outsiderBri.aged_not_yet_due)).toBe(
          22637.4,
        );
        expect(round2(allowBri.aged_1_30 - outsiderBri.aged_1_30)).toBe(0);

        // 6. Organisation profile client bundles (Bay Cafés Ltd and Brightwater Care Group Ltd)
        const allowBayOrgView = await getClientPmsViewBundle(
          'organisation',
          staffMatter.clientId,
          'P-000001',
        );
        const outsiderBayOrgView = await getClientPmsViewBundle(
          'organisation',
          staffMatter.clientId,
          'P-000009',
        );
        expect(isActionDenied(allowBayOrgView)).toBe(false);
        expect(isActionDenied(outsiderBayOrgView)).toBe(false);
        if (isActionDenied(allowBayOrgView) || isActionDenied(outsiderBayOrgView)) return;
        expect(
          round2(
            allowBayOrgView.clientBundle!.summary.fees_billed -
              outsiderBayOrgView.clientBundle!.summary.fees_billed,
          ),
        ).toBe(2750);
        expect(
          round2(
            allowBayOrgView.clientBundle!.summary.aged_90_plus -
              outsiderBayOrgView.clientBundle!.summary.aged_90_plus,
          ),
        ).toBe(3300);

        const allowBriOrgView = await getClientPmsViewBundle(
          'organisation',
          wallMatter.clientId,
          'P-000001',
        );
        const outsiderBriOrgView = await getClientPmsViewBundle(
          'organisation',
          wallMatter.clientId,
          'P-000009',
        );
        expect(isActionDenied(allowBriOrgView)).toBe(false);
        expect(isActionDenied(outsiderBriOrgView)).toBe(false);
        if (isActionDenied(allowBriOrgView) || isActionDenied(outsiderBriOrgView)) return;
        expect(
          round2(
            allowBriOrgView.clientBundle!.summary.total_paid -
              outsiderBriOrgView.clientBundle!.summary.total_paid,
          ),
        ).toBe(29793);
        expect(
          round2(
            allowBriOrgView.clientBundle!.summary.aged_not_yet_due -
              outsiderBriOrgView.clientBundle!.summary.aged_not_yet_due,
          ),
        ).toBe(22637.4);

        // 7. getMyFinanceFigures and buildFeeEarnerWeeklyTime exclusion for FE002 (P-000038, Gethin Lloyd)
        const fe002Person = (await partyRepo.getPersonById<import('@/domain/types').Person>(ctx, 'P-000038'))!;
        fe002Person.roles = ['partner', 'fee_earner'];
        await partyRepo.putPerson(ctx, fe002Person);
        wallMatter.restrictedAccessUserIds = ['P-000001', 'P-000038'];
        await matterRepo.putMatter(ctx, wallMatter, { expectedRowVersion: null });
        const allowMy = await getMyFinanceFigures('P-000038');
        wallMatter.leadFeeEarnerId = 'P-000001';
        wallMatter.restrictedAccessUserIds = ['P-000001'];
        await matterRepo.putMatter(ctx, wallMatter, { expectedRowVersion: null });
        const outsiderMy = await getMyFinanceFigures('P-000038');
        expect(isActionDenied(allowMy)).toBe(false);
        expect(isActionDenied(outsiderMy)).toBe(false);
        if (!isActionDenied(allowMy) && !isActionDenied(outsiderMy)) {
          expect(
            round1(
              (allowMy.myFeeEarnerFigures?.chargeable_hours_this_month ?? 0) -
                (outsiderMy.myFeeEarnerFigures?.chargeable_hours_this_month ?? 0),
            ),
          ).toBe(24.1);
          expect(
            round2(
              (allowMy.myFeeEarnerFigures?.unbilled_wip ?? 0) -
                (outsiderMy.myFeeEarnerFigures?.unbilled_wip ?? 0),
            ),
          ).toBe(8194);
          expect(
            round1(
              (allowMy.myWeeklyTime?.weekTotalHours ?? 0) -
                (outsiderMy.myWeeklyTime?.weekTotalHours ?? 0),
            ),
          ).toBe(9.8);
          expect(
            round1(
              (allowMy.myWeeklyTime?.monthToDateHours ?? 0) -
                (outsiderMy.myWeeklyTime?.monthToDateHours ?? 0),
            ),
          ).toBe(24.1);
          expect(
            round2(
              (allowMy.myWeeklyTime?.myUnbilledWip ?? 0) -
                (outsiderMy.myWeeklyTime?.myUnbilledWip ?? 0),
            ),
          ).toBe(8194);
        }

        // Direct buildFeeEarnerWeeklyTime check for FE002 with and without BRI001-0003 excluded
        const fe2 = pms.listFeeEarners().find((fe) => fe.fee_earner_id === 'FE002')!;
        const allTe = pms.listAllTimeEntries();
        const weekAllowed = buildFeeEarnerWeeklyTime({
          feeEarner: fe2,
          timeEntries: allTe,
          asAtDate: extractInfo.asAtDate,
        })!;
        const weekOutsider = buildFeeEarnerWeeklyTime({
          feeEarner: fe2,
          timeEntries: allTe.filter((t) => t.matter_code !== 'BRI001-0003'),
          asAtDate: extractInfo.asAtDate,
        })!;
        expect(round1(weekAllowed.weekTotalHours - weekOutsider.weekTotalHours)).toBe(9.8);
        expect(
          round1(weekAllowed.monthToDateHours - weekOutsider.monthToDateHours),
        ).toBe(24.1);
        expect(round2(weekAllowed.myUnbilledWip - weekOutsider.myUnbilledWip)).toBe(8194);

        // 8. getMatterFinanceRows(actor, [restrictedMatter.id]) for an outsider returns FORBIDDEN
        const deniedRestrictedRows = await getMatterFinanceRows('P-000009', [staffMatter.id]);
        expect(isActionDenied(deniedRestrictedRows)).toBe(true);
        if (isActionDenied(deniedRestrictedRows)) {
          expect(deniedRestrictedRows.code).toBe('FORBIDDEN');
          expect(deniedRestrictedRows.message).toBe('Matter not found or access denied.');
        }
        const deniedWallRows = await getMatterFinanceRows('P-000009', [wallMatter.id]);
        expect(isActionDenied(deniedWallRows)).toBe(true);
        if (isActionDenied(deniedWallRows)) {
          expect(deniedWallRows.code).toBe('FORBIDDEN');
          expect(deniedWallRows.message).toBe('Matter not found or access denied.');
        }
      } finally {
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });

    it('5. the three credit-control actions are denied without finance:credit_control, denied on an inaccessible matter, and allowed otherwise', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      try {
        const store = getStore();
        const ctx = testDataResetContext();
        const partner = (await getPartyRepository().getPersonById<Person>(ctx, 'P-000001'))!;

        setTestEntraSessionOverride({
          personId: 'P-000001',
          tenantId: 'not-a-law-firm',
          oid: '00000000-0000-4000-8000-000000000001',
          tid: '00000000-0000-4000-8000-000000000099',
          sub: '00000000-0000-4000-8000-000000000001',
          email: 'rhian.morgan@notalawfirm.example',
          displayName: 'Rhian Morgan',
          entraRoles: [],
          mappedRoles: ['partner'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });

        // 1. Positive control: partner with finance:credit_control and access to HAR001-0003 (M-000013) succeeds
        const okBill = await requestMatterBillAction('HAR001-0003');
        expect(isActionDenied(okBill)).toBe(false);
        if (!isActionDenied(okBill)) {
          expect(okBill.ok).toBe(true);
        }

        const okWriteOff = await flagMatterWriteOffAction('HAR001-0003', 450);
        expect(isActionDenied(okWriteOff)).toBe(false);
        if (!isActionDenied(okWriteOff)) {
          expect(okWriteOff.ok).toBe(true);
        }

        const okCc = await recordInvoiceCreditControlActionAction({
          invoiceNumber: 'PV/2026/0040',
          matterCode: 'HAR001-0003',
          clientCode: 'HAR001',
          actionType: 'log_call',
          note: 'Spoke to AP team',
        });
        expect(isActionDenied(okCc)).toBe(false);
        if (!isActionDenied(okCc)) {
          expect(okCc.ok).toBe(true);
        }

        // 2. R315: Mismatched clientCode or invoiceNumber from another matter returns FORBIDDEN and writes no note or task
        const notesBeforeR315 = (await getPartyRepository().listAllNotes(ctx)).length;
        const tasksBeforeR315 = store.tasks.length;
        const mismatchedClientCc = await recordInvoiceCreditControlActionAction({
          invoiceNumber: 'PV/2026/0040',
          matterCode: 'HAR001-0003',
          clientCode: 'SEV001',
          actionType: 'log_call',
          note: 'Attempted cross-client chase note',
        });
        expect(isActionDenied(mismatchedClientCc)).toBe(true);
        if (isActionDenied(mismatchedClientCc)) {
          expect(mismatchedClientCc.code).toBe('FORBIDDEN');
          expect(mismatchedClientCc.message).toMatch(/Client code does not match/i);
        }
        expect((await getPartyRepository().listAllNotes(ctx)).length).toBe(notesBeforeR315);
        expect(store.tasks.length).toBe(tasksBeforeR315);

        const wrongMatterInvoiceCc = await recordInvoiceCreditControlActionAction({
          invoiceNumber: 'PV/2026/0021', // belongs to BAY001-0001, not HAR001-0003
          matterCode: 'HAR001-0003',
          clientCode: 'HAR001',
          actionType: 'log_call',
          note: 'Attempted cross-matter invoice chase',
        });
        expect(isActionDenied(wrongMatterInvoiceCc)).toBe(true);
        if (isActionDenied(wrongMatterInvoiceCc)) {
          expect(wrongMatterInvoiceCc.code).toBe('FORBIDDEN');
          expect(wrongMatterInvoiceCc.message).toMatch(
            /Invoice does not belong to the specified matter/i,
          );
        }
        expect((await getPartyRepository().listAllNotes(ctx)).length).toBe(notesBeforeR315);
        expect(store.tasks.length).toBe(tasksBeforeR315);

        // 2b. R337: An unlinked PMS code whose text equals the matterNumber of an accessible 1Squared matter returns FORBIDDEN on all 3 actions and writes no task, sign-off, or note, and invalid amountGbp values are rejected
        const harLinkIdx = store.pmsLinks.findIndex(
          (l) => l.entityType === 'matter' && l.pmsCode === 'HAR001-0003',
        );
        expect(harLinkIdx).toBeGreaterThanOrEqual(0);
        const [removedHarLink] = store.pmsLinks.splice(harLinkIdx, 1);
        const signOffsBeforeR337 = (store.signOffs ?? []).length;
        try {
          const unlinkedBill = await requestMatterBillAction('HAR001-0003');
          expect(isActionDenied(unlinkedBill)).toBe(true);
          if (isActionDenied(unlinkedBill)) {
            expect(unlinkedBill.code).toBe('FORBIDDEN');
            expect(unlinkedBill.message).toBe('Matter not found or access denied.');
          }

          const unlinkedWriteOff = await flagMatterWriteOffAction('HAR001-0003', 450);
          expect(isActionDenied(unlinkedWriteOff)).toBe(true);
          if (isActionDenied(unlinkedWriteOff)) {
            expect(unlinkedWriteOff.code).toBe('FORBIDDEN');
            expect(unlinkedWriteOff.message).toBe('Matter not found or access denied.');
          }

          const unlinkedCc = await recordInvoiceCreditControlActionAction({
            invoiceNumber: 'PV/2026/0040',
            matterCode: 'HAR001-0003',
            clientCode: 'HAR001',
            actionType: 'log_call',
            note: 'Should fail on unlinked matter',
          });
          expect(isActionDenied(unlinkedCc)).toBe(true);
          if (isActionDenied(unlinkedCc)) {
            expect(unlinkedCc.code).toBe('FORBIDDEN');
            expect(unlinkedCc.message).toBe('Matter not found or access denied.');
          }

          expect(store.tasks.length).toBe(tasksBeforeR315);
          expect((store.signOffs ?? []).length).toBe(signOffsBeforeR337);
          expect((await getPartyRepository().listAllNotes(ctx)).length).toBe(notesBeforeR315);
        } finally {
          store.pmsLinks.splice(harLinkIdx, 0, removedHarLink!);
        }

        for (const invalidAmount of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
          const badAmtRes = await flagMatterWriteOffAction('HAR001-0003', invalidAmount);
          expect(isActionDenied(badAmtRes)).toBe(true);
          if (isActionDenied(badAmtRes)) {
            expect(badAmtRes.code).toBe('FORBIDDEN');
            expect(badAmtRes.message).toMatch(/finite number greater than 0/i);
          }
        }
        expect((store.signOffs ?? []).length).toBe(signOffsBeforeR337);

        // 2c. R372: A linked matter code whose PMS matter is missing from the PMS database returns FORBIDDEN on all 3 actions and writes no task, sign-off, or note
        store.pmsLinks.push({
          id: 'PMSL-R372-MISSING-PMS',
          entityType: 'matter',
          onesquaredId: 'M-000001',
          pmsCode: 'MISSING999-0001',
          matchedBy: 'manual',
          matchedAt: '2026-10-16T09:00:00Z',
          matchedByUserId: 'P-000004',
        });
        try {
          const missingPmsBill = await requestMatterBillAction('MISSING999-0001');
          expect(isActionDenied(missingPmsBill)).toBe(true);
          if (isActionDenied(missingPmsBill)) {
            expect(missingPmsBill.code).toBe('FORBIDDEN');
            expect(missingPmsBill.message).toBe('Matter not found or access denied.');
          }

          const missingPmsWriteOff = await flagMatterWriteOffAction('MISSING999-0001', 450);
          expect(isActionDenied(missingPmsWriteOff)).toBe(true);
          if (isActionDenied(missingPmsWriteOff)) {
            expect(missingPmsWriteOff.code).toBe('FORBIDDEN');
            expect(missingPmsWriteOff.message).toBe('Matter not found or access denied.');
          }

          const missingPmsCc = await recordInvoiceCreditControlActionAction({
            invoiceNumber: 'PV/2026/0040',
            matterCode: 'MISSING999-0001',
            clientCode: 'PEN001',
            actionType: 'log_call',
            note: 'Should fail when PMS matter does not exist',
          });
          expect(isActionDenied(missingPmsCc)).toBe(true);
          if (isActionDenied(missingPmsCc)) {
            expect(missingPmsCc.code).toBe('FORBIDDEN');
            expect(missingPmsCc.message).toBe('Matter not found or access denied.');
          }

          expect(store.tasks.length).toBe(tasksBeforeR315);
          expect((store.signOffs ?? []).length).toBe(signOffsBeforeR337);
          expect((await getPartyRepository().listAllNotes(ctx)).length).toBe(notesBeforeR315);
        } finally {
          const idx = store.pmsLinks.findIndex((l) => l.id === 'PMSL-R372-MISSING-PMS');
          if (idx >= 0) store.pmsLinks.splice(idx, 1);
        }

        // 3. Revoke finance:credit_control on partner: all 3 actions return FORBIDDEN mentioning finance:credit_control
        partner.permissionOverrides = {
          grant: [],
          revoke: ['finance:credit_control'],
        };
        await getPartyRepository().putPerson(ctx, partner);

        const noPermBill = await requestMatterBillAction('HAR001-0003');
        expect(isActionDenied(noPermBill)).toBe(true);
        if (isActionDenied(noPermBill)) {
          expect(noPermBill.code).toBe('FORBIDDEN');
          expect(noPermBill.message).toContain('finance:credit_control');
        }

        const noPermWriteOff = await flagMatterWriteOffAction('HAR001-0003', 450);
        expect(isActionDenied(noPermWriteOff)).toBe(true);
        if (isActionDenied(noPermWriteOff)) {
          expect(noPermWriteOff.code).toBe('FORBIDDEN');
          expect(noPermWriteOff.message).toContain('finance:credit_control');
        }

        const noPermCc = await recordInvoiceCreditControlActionAction({
          invoiceNumber: 'PV/2026/0040',
          matterCode: 'HAR001-0003',
          clientCode: 'HAR001',
          actionType: 'log_call',
        });
        expect(isActionDenied(noPermCc)).toBe(true);
        if (isActionDenied(noPermCc)) {
          expect(noPermCc.code).toBe('FORBIDDEN');
          expect(noPermCc.message).toContain('finance:credit_control');
        }

        // 3. Restore finance:credit_control, but restrict HAR001-0003 (M-000013) to P-000004 only: all 3 actions return FORBIDDEN
        partner.permissionOverrides = undefined;
        await getPartyRepository().putPerson(ctx, partner);
        const allMatters = await getMatterRepository().listAllMatters<Matter>(ctx);
        const targetMatter = allMatters.find((m) => m.matterNumber === 'HAR001-0003')!;
        targetMatter.isStaffMatter = true;
        targetMatter.restrictedAccessUserIds = ['P-000004'];
        targetMatter.leadFeeEarnerId = 'P-000004';
        targetMatter.responsiblePartnerId = 'P-000004';
        targetMatter.supervisingPartnerId = 'P-000004';
        targetMatter.teamMemberIds = [];
        await getMatterRepository().putMatter(ctx, targetMatter, { expectedRowVersion: null });

        const restrictedBill = await requestMatterBillAction('HAR001-0003');
        expect(isActionDenied(restrictedBill)).toBe(true);
        if (isActionDenied(restrictedBill)) {
          expect(restrictedBill.code).toBe('FORBIDDEN');
          expect(restrictedBill.message).toMatch(/access denied/i);
        }

        const restrictedWriteOff = await flagMatterWriteOffAction('HAR001-0003', 450);
        expect(isActionDenied(restrictedWriteOff)).toBe(true);
        if (isActionDenied(restrictedWriteOff)) {
          expect(restrictedWriteOff.code).toBe('FORBIDDEN');
          expect(restrictedWriteOff.message).toMatch(/access denied/i);
        }

        const restrictedCc = await recordInvoiceCreditControlActionAction({
          invoiceNumber: 'PV/2026/0040',
          matterCode: 'HAR001-0003',
          clientCode: 'HAR001',
          actionType: 'escalate',
        });
        expect(isActionDenied(restrictedCc)).toBe(true);
        if (isActionDenied(restrictedCc)) {
          expect(restrictedCc.code).toBe('FORBIDDEN');
          expect(restrictedCc.message).toMatch(/access denied/i);
        }
      } finally {
        setTestEntraSessionOverride(undefined);
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });
  });
  describe('S0-30 (B13, R373): Employee identity binding — person email save protection and verified-domain non-privileged sign-in linking', () => {
    it('1. requires employee:edit_core for any employee/leaver email change and mfaVerified === true only when adding or changing an address, allows leaver deactivation and secondary address removal without MFA (auditing both), allows contact:edit on non-employees, and ignores reordering/label/case/whitespace edits (R398)', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      try {
        const ctx = testDataResetContext();
        const allPeople = await getPartyRepository().listAllPeople<Person>(ctx);
        const feeEarner = allPeople.find((p) => p.id === 'P-000002')!;
        const targetEmployee = allPeople.find((p) => p.id === 'P-000005')!;
        const adminPerson = allPeople.find((p) => p.id === 'P-000004')!;
        targetEmployee.entraObjectId = '00000000-0000-4000-8000-000000000005';
        await getPartyRepository().putPerson(ctx, targetEmployee);

        // Explicitly ensure feeEarner has contact:edit and lacks employee:edit_core
        feeEarner.permissionOverrides = {
          grant: ['contact:edit'],
          revoke: ['employee:edit_core'],
        };
        await getPartyRepository().putPerson(ctx, feeEarner);

        const originalEmailsJson = JSON.stringify(targetEmployee.emails);
        const originalPrimaryAddr = targetEmployee.emails[0]!.address;

        // 1a. A contact:edit-only actor (fee_earner P-000002) changing an employee's primary email gets FORBIDDEN (code and message), and reloaded store is unchanged
        const forbiddenRes = await runAsTestActor(feeEarner.id, () =>
          savePersonRecord(
            {
              firstName: targetEmployee.firstName,
              surname: targetEmployee.surname,
              emails: [
                {
                  ...targetEmployee.emails[0]!,
                  address: 'hijack.attempt@notalawfirm.example',
                },
              ],
            },
            { id: targetEmployee.id, byId: feeEarner.id, mfaVerified: true },
          ),
        );
        expect(isActionDenied(forbiddenRes)).toBe(true);
        expect(forbiddenRes.code).toBe('FORBIDDEN');
        expect(forbiddenRes.message).toBe(
          'You do not have permission (employee:edit_core) to change an employee or leaver email address.',
        );
        expect(
          JSON.stringify(
            (await getPartyRepository().getPersonById<Person>(ctx, targetEmployee.id))!.emails,
          ),
        ).toBe(originalEmailsJson);

        // Also denied on a former employee (leaver: isEmployee === false, employment.status === 'Leaver')
        const leaverPerson = allPeople.find((p) => p.id === 'P-000006')!;
        leaverPerson.isEmployee = false;
        leaverPerson.employment = {
          ...leaverPerson.employment!,
          status: 'Leaver',
        };
        await getPartyRepository().putPerson(ctx, leaverPerson);
        const leaverEmailsBefore = JSON.stringify(leaverPerson.emails);
        const forbiddenLeaverRes = await runAsTestActor(feeEarner.id, () =>
          savePersonRecord(
            {
              firstName: leaverPerson.firstName,
              surname: leaverPerson.surname,
              emails: [
                {
                  id: 'em-leaver-hijack',
                  address: 'leaver.hijack@notalawfirm.example',
                  typeId: 'email_type.personal',
                  isPrimary: true,
                  active: true,
                },
              ],
            },
            { id: leaverPerson.id, byId: feeEarner.id, mfaVerified: true },
          ),
        );
        expect(isActionDenied(forbiddenLeaverRes)).toBe(true);
        expect(forbiddenLeaverRes.code).toBe('FORBIDDEN');
        expect(forbiddenLeaverRes.message).toBe(
          'You do not have permission (employee:edit_core) to change an employee or leaver email address.',
        );
        expect(
          JSON.stringify(
            (await getPartyRepository().getPersonById<Person>(ctx, leaverPerson.id))!.emails,
          ),
        ).toBe(leaverEmailsBefore);

        // Also denied if attempting to inject a new work email via employmentSubmitted.systems.firmWorkEmail
        const forbiddenSysEmailRes = await runAsTestActor(feeEarner.id, () =>
          savePersonRecord(
            {
              firstName: targetEmployee.firstName,
              surname: targetEmployee.surname,
            },
            {
              id: targetEmployee.id,
              byId: feeEarner.id,
              mfaVerified: true,
              employmentSubmitted: {
                ...targetEmployee.employment!,
                systems: {
                  ...targetEmployee.employment!.systems!,
                  firmWorkEmail: 'hijack.sys@notalawfirm.example',
                },
              },
            },
          ),
        );
        expect(isActionDenied(forbiddenSysEmailRes)).toBe(true);
        expect(forbiddenSysEmailRes.code).toBe('FORBIDDEN');
        expect(forbiddenSysEmailRes.message).toBe(
          'You do not have permission (employee:edit_core) to change an employee or leaver email address.',
        );

        // 1b. Reordering an employee's emails, changing a label (typeId), or changing case/whitespace/inactive emails is NOT treated as an identity change
        targetEmployee.emails = [
          targetEmployee.emails[0]!,
          {
            id: 'em-secondary-p5',
            address: 'sian.alt@notalawfirm.example',
            typeId: 'email_type.work',
            isPrimary: false,
            active: true,
          },
        ];
        await getPartyRepository().putPerson(ctx, targetEmployee);
        const reorderedAndRelabelled = [
          {
            ...targetEmployee.emails[1]!,
            address: '  SIAN.ALT@NOTALAWFIRM.EXAMPLE  ',
            typeId: 'email_type.other',
            isPrimary: true,
          },
          {
            ...targetEmployee.emails[0]!,
            isPrimary: false,
          },
          {
            id: 'em-inactive-old',
            address: 'historical.inactive@example.org',
            typeId: 'email_type.personal',
            isPrimary: false,
            active: false,
          },
        ];
        const reorderRes = await runAsTestActor(
          feeEarner.id,
          () =>
            savePersonRecord(
              {
                firstName: targetEmployee.firstName,
                surname: targetEmployee.surname,
                emails: reorderedAndRelabelled,
              },
              {
                id: targetEmployee.id,
                byId: feeEarner.id,
                mfaVerified: false,
                employmentSubmitted: null,
              },
            ),
          { mfaVerified: false },
        );
        expect(isActionDenied(reorderRes)).toBe(false);
        expect(reorderRes.errors).toBeUndefined();
        expect(
          (await auditSinceTestStart()).some(
            (a) =>
              a.recordId === targetEmployee.id &&
              a.field === 'Employee sign-in email',
          ),
        ).toBe(false);

        // R384: Saving an existing employee with an employment payload (hasEmploymentPayload === true) still requires employee:edit_core
        const empPayloadWithoutPermRes = await runAsTestActor(feeEarner.id, () =>
          savePersonRecord(
            {
              firstName: targetEmployee.firstName,
              surname: targetEmployee.surname,
              preferredName: 'UnauthorisedEmpPayload',
            },
            { id: targetEmployee.id, byId: feeEarner.id, mfaVerified: true },
          ),
        );
        expect(isActionDenied(empPayloadWithoutPermRes)).toBe(true);
        expect(empPayloadWithoutPermRes.code).toBe('FORBIDDEN');
        expect(empPayloadWithoutPermRes.message).toBe(
          'You do not have permission (employee:edit_core) to create or edit employment records.',
        );

        // 1c. A contact:edit actor can still change a non-employee contact's email (positive control)
        const nonEmployee = allPeople.find((p) => !p.isEmployee && !p.employment)!;
        const contactEmailRes = await runAsTestActor(
          feeEarner.id,
          () =>
            savePersonRecord(
              {
                firstName: nonEmployee.firstName,
                surname: nonEmployee.surname,
                emails: [
                  {
                    id: 'em-contact-updated',
                    address: 'updated.contact@client.example',
                    typeId: 'email_type.personal',
                    isPrimary: true,
                    active: true,
                  },
                ],
              },
              { id: nonEmployee.id, byId: feeEarner.id, mfaVerified: false },
            ),
          { mfaVerified: false },
        );
        expect(isActionDenied(contactEmailRes)).toBe(false);
        expect(contactEmailRes.errors).toBeUndefined();
        expect(
          (await getPartyRepository().getPersonById<Person>(ctx, nonEmployee.id))?.emails[0]?.address,
        ).toBe('updated.contact@client.example');

        // 1d. Adding or replacing an address (or changing firmWorkEmail to a new value) without MFA gives MFA_REQUIRED, and reloaded store is unchanged (R398)
        adminPerson.permissionOverrides = {
          grant: ['employee:edit_core'],
          revoke: [],
        };
        await getPartyRepository().putPerson(ctx, adminPerson);
        const targetBeforeNoMfaJson = JSON.stringify(
          (await getPartyRepository().getPersonById<Person>(ctx, targetEmployee.id))!,
        );
        const noMfaReplaceRes = await runAsTestActor(
          adminPerson.id,
          () =>
            savePersonRecord(
              {
                firstName: targetEmployee.firstName,
                surname: targetEmployee.surname,
                emails: [
                  {
                    id: targetEmployee.emails[0]!.id,
                    address: 'sian.renamed@notalawfirm.example',
                    typeId: 'email_type.work',
                    isPrimary: true,
                    active: true,
                  },
                ],
              },
              { id: targetEmployee.id, byId: adminPerson.id, mfaVerified: false },
            ),
          { mfaVerified: false },
        );
        expect(isActionDenied(noMfaReplaceRes)).toBe(true);
        expect(noMfaReplaceRes.code).toBe('MFA_REQUIRED');
        expect(noMfaReplaceRes.message).toBe(
          'Multi-factor authentication (MFA) is required to change an employee or leaver email address.',
        );
        clearStoreMemoryCache();
        expect(
          JSON.stringify((await getPartyRepository().getPersonById<Person>(ctx, targetEmployee.id))!),
        ).toBe(targetBeforeNoMfaJson);

        const reloadedTargetForAdd = (await getPartyRepository().getPersonById<Person>(
          ctx,
          targetEmployee.id,
        ))!;
        const noMfaAddRes = await runAsTestActor(
          adminPerson.id,
          () =>
            savePersonRecord(
              {
                firstName: reloadedTargetForAdd.firstName,
                surname: reloadedTargetForAdd.surname,
                emails: [
                  ...reloadedTargetForAdd.emails,
                  {
                    id: 'em-added-no-mfa',
                    address: 'sian.added@notalawfirm.example',
                    typeId: 'email_type.work',
                    isPrimary: false,
                    active: true,
                  },
                ],
              },
              { id: reloadedTargetForAdd.id, byId: adminPerson.id, mfaVerified: false },
            ),
          { mfaVerified: false },
        );
        expect(isActionDenied(noMfaAddRes)).toBe(true);
        expect(noMfaAddRes.code).toBe('MFA_REQUIRED');
        clearStoreMemoryCache();
        expect(
          JSON.stringify((await getPartyRepository().getPersonById<Person>(ctx, targetEmployee.id))!),
        ).toBe(targetBeforeNoMfaJson);

        const reloadedTargetForFirmWork = (await getPartyRepository().getPersonById<Person>(
          ctx,
          targetEmployee.id,
        ))!;
        const noMfaFirmWorkChangeRes = await runAsTestActor(
          adminPerson.id,
          () =>
            savePersonRecord(
              {
                firstName: reloadedTargetForFirmWork.firstName,
                surname: reloadedTargetForFirmWork.surname,
              },
              {
                id: reloadedTargetForFirmWork.id,
                byId: adminPerson.id,
                mfaVerified: false,
                employmentSubmitted: {
                  ...reloadedTargetForFirmWork.employment!,
                  systems: {
                    ...reloadedTargetForFirmWork.employment!.systems!,
                    firmWorkEmail: 'sian.changed-firm@notalawfirm.example',
                  },
                },
              },
            ),
          { mfaVerified: false },
        );
        expect(isActionDenied(noMfaFirmWorkChangeRes)).toBe(true);
        expect(noMfaFirmWorkChangeRes.code).toBe('MFA_REQUIRED');
        clearStoreMemoryCache();
        expect(
          JSON.stringify((await getPartyRepository().getPersonById<Person>(ctx, targetEmployee.id))!),
        ).toBe(targetBeforeNoMfaJson);

        // R398: Removing a secondary active address WITHOUT employee:edit_core still returns FORBIDDEN;
        // removing it WITH employee:edit_core and NO MFA succeeds and writes the Employee sign-in email audit entry
        const reloadedFeeEarner = (await getPartyRepository().getPersonById<Person>(
          ctx,
          feeEarner.id,
        ))!;
        reloadedFeeEarner.permissionOverrides = {
          grant: ['contact:edit'],
          revoke: ['employee:edit_core'],
        };
        await getPartyRepository().putPerson(ctx, reloadedFeeEarner);
        const reloadedAdmin = (await getPartyRepository().getPersonById<Person>(
          ctx,
          adminPerson.id,
        ))!;
        reloadedAdmin.permissionOverrides = {
          grant: ['employee:edit_core'],
          revoke: [],
        };
        await getPartyRepository().putPerson(ctx, reloadedAdmin);
        const targetWithSecondary = (await getPartyRepository().getPersonById<Person>(
          ctx,
          targetEmployee.id,
        ))!;
        const primaryOnlyEmails = targetWithSecondary.emails.filter(
          (e) =>
            e.active !== false &&
            e.address.trim().toLowerCase() === originalPrimaryAddr.toLowerCase(),
        );
        expect(primaryOnlyEmails).toHaveLength(1);

        const removeSecondaryForbiddenRes = await runAsTestActor(
          reloadedFeeEarner.id,
          () =>
            savePersonRecord(
              {
                firstName: targetWithSecondary.firstName,
                surname: targetWithSecondary.surname,
                emails: primaryOnlyEmails,
              },
              {
                id: targetWithSecondary.id,
                byId: reloadedFeeEarner.id,
                mfaVerified: false,
                employmentSubmitted: null,
              },
            ),
          { mfaVerified: false },
        );
        expect(isActionDenied(removeSecondaryForbiddenRes)).toBe(true);
        expect(removeSecondaryForbiddenRes.code).toBe('FORBIDDEN');

        const removeSecondaryWithoutMfaRes = await runAsTestActor(
          reloadedAdmin.id,
          () =>
            savePersonRecord(
              {
                firstName: targetWithSecondary.firstName,
                surname: targetWithSecondary.surname,
                emails: primaryOnlyEmails,
              },
              {
                id: targetWithSecondary.id,
                byId: reloadedAdmin.id,
                mfaVerified: false,
              },
            ),
          { mfaVerified: false },
        );
        expect(isActionDenied(removeSecondaryWithoutMfaRes)).toBe(false);
        expect(removeSecondaryWithoutMfaRes.errors).toBeUndefined();
        expect(
          removeSecondaryWithoutMfaRes.person.emails
            .filter((e) => e.active !== false)
            .map((e) => e.address.trim().toLowerCase()),
        ).toEqual([originalPrimaryAddr.toLowerCase()]);
        const removeSecondaryAudit = (await auditSinceTestStart()).find(
          (a) =>
            a.recordId === targetEmployee.id &&
            a.action === 'update' &&
            a.field === 'Employee sign-in email',
        );
        expect(removeSecondaryAudit).toBeDefined();
        expect(removeSecondaryAudit?.oldValue).toContain(
          originalPrimaryAddr.toLowerCase(),
        );
        expect(removeSecondaryAudit?.oldValue).toContain(
          'sian.alt@notalawfirm.example',
        );
        expect(removeSecondaryAudit?.newValue).toBe(
          originalPrimaryAddr.toLowerCase(),
        );

        // R398: Marking an active employee as a leaver (without emails in input) with employee:edit_core and NO MFA succeeds:
        // firm email is deactivated, firmWorkEmail is kept, and the Employee sign-in email audit entry records the change
        const leaverCandidate = (await getPartyRepository().getPersonById<Person>(ctx, 'P-000007'))!;
        const candidateOriginalFirmWorkEmail =
          leaverCandidate.employment!.systems!.firmWorkEmail ?? '';
        expect(candidateOriginalFirmWorkEmail).toBeTruthy();
        expect(
          leaverCandidate.emails.some((e) => e.active !== false),
        ).toBe(true);

        const markLeaverWithoutMfaRes = await runAsTestActor(
          reloadedAdmin.id,
          () =>
            savePersonRecord(
              {
                firstName: leaverCandidate.firstName,
                surname: leaverCandidate.surname,
              },
              {
                id: leaverCandidate.id,
                byId: reloadedAdmin.id,
                mfaVerified: false,
                worksAtFirm: false,
              },
            ),
          { mfaVerified: false },
        );
        expect(isActionDenied(markLeaverWithoutMfaRes)).toBe(false);
        expect(markLeaverWithoutMfaRes.errors).toBeUndefined();
        expect(markLeaverWithoutMfaRes.person.isEmployee).toBe(false);
        expect(markLeaverWithoutMfaRes.person.employment?.status).toBe('Leaver');
        expect(
          markLeaverWithoutMfaRes.person.emails.every((e) => e.active === false),
        ).toBe(true);
        expect(
          markLeaverWithoutMfaRes.person.employment?.systems?.firmWorkEmail,
        ).toBe(candidateOriginalFirmWorkEmail);
        const leaverEmailAudit = (await auditSinceTestStart()).find(
          (a) =>
            a.recordId === leaverCandidate.id &&
            a.action === 'update' &&
            a.field === 'Employee sign-in email',
        );
        expect(leaverEmailAudit).toBeDefined();
        expect(leaverEmailAudit?.oldValue).toContain(
          candidateOriginalFirmWorkEmail.trim().toLowerCase(),
        );
        expect(leaverEmailAudit?.newValue).toBeNull();

        // R398: Clearing firmWorkEmail without adding a new address needs employee:edit_core and NO MFA, and is audited
        const clearFirmWorkWithoutMfaRes = await runAsTestActor(
          reloadedAdmin.id,
          () =>
            savePersonRecord(
              {
                firstName: leaverCandidate.firstName,
                surname: leaverCandidate.surname,
              },
              {
                id: leaverCandidate.id,
                byId: reloadedAdmin.id,
                mfaVerified: false,
                employmentSubmitted: {
                  ...markLeaverWithoutMfaRes.person.employment!,
                  systems: {
                    ...markLeaverWithoutMfaRes.person.employment!.systems!,
                    firmWorkEmail: '',
                  },
                },
              },
            ),
          { mfaVerified: false },
        );
        expect(isActionDenied(clearFirmWorkWithoutMfaRes)).toBe(false);
        expect(
          clearFirmWorkWithoutMfaRes.person.employment?.systems?.firmWorkEmail,
        ).toBe('');

        // R383: Promoting an existing contact (who already has an active email) to an employee without MFA is denied with MFA_REQUIRED and leaves the reloaded store unchanged
        const reloadedNonEmployee = (await getPartyRepository().getPersonById<Person>(
          ctx,
          nonEmployee.id,
        ))!;
        const nonEmployeeBeforePromoteJson = JSON.stringify(reloadedNonEmployee);
        const promoteWithoutMfaRes = await runAsTestActor(
          adminPerson.id,
          () =>
            savePersonRecord(
              {
                firstName: reloadedNonEmployee.firstName,
                surname: reloadedNonEmployee.surname,
                isEmployee: true,
                employeeRoleId: 'employee_role.solicitor',
                departmentId: 'DEPT-RE',
              },
              { id: reloadedNonEmployee.id, byId: adminPerson.id, mfaVerified: false },
            ),
          { mfaVerified: false },
        );
        expect(isActionDenied(promoteWithoutMfaRes)).toBe(true);
        expect(promoteWithoutMfaRes.code).toBe('MFA_REQUIRED');
        expect(promoteWithoutMfaRes.message).toBe(
          'Multi-factor authentication (MFA) is required to change an employee or leaver email address.',
        );
        clearStoreMemoryCache();
        expect(
          JSON.stringify(
            (await getPartyRepository().getPersonById<Person>(ctx, nonEmployee.id))!,
          ),
        ).toBe(nonEmployeeBeforePromoteJson);

        // Promoting that contact to an employee WITH MFA succeeds and writes the Employee sign-in email audit entry (including both existing and synthesised firm emails, R393)
        const promoteWithMfaRes = await runAsTestActor(adminPerson.id, () =>
          savePersonRecord(
            {
              firstName: reloadedNonEmployee.firstName,
              surname: reloadedNonEmployee.surname,
              isEmployee: true,
              employeeRoleId: 'employee_role.solicitor',
              departmentId: 'DEPT-RE',
            },
            { id: reloadedNonEmployee.id, byId: adminPerson.id, mfaVerified: true },
          ),
        );
        expect(isActionDenied(promoteWithMfaRes)).toBe(false);
        expect(promoteWithMfaRes.person.isEmployee).toBe(true);
        const promoteEmailAudit = (await auditSinceTestStart()).find(
          (a) =>
            a.recordId === nonEmployee.id &&
            a.action === 'update' &&
            a.field === 'Employee sign-in email',
        );
        expect(promoteEmailAudit).toBeDefined();
        expect(promoteEmailAudit?.oldValue).toBeNull();
        expect(promoteEmailAudit?.newValue).toContain('updated.contact@client.example');
        expect(promoteEmailAudit?.newValue).toContain(
          `${reloadedNonEmployee.firstName.trim().toLowerCase()}.${reloadedNonEmployee.surname.trim().toLowerCase()}@notalawfirm.example`,
        );

        // R393: Promoting a contact with NO emails to an employee synthesises first.surname@<primaryDomain>:
        // without MFA -> denied with MFA_REQUIRED and reloaded store unchanged; with MFA -> audit entry includes the synthesised address
        const createdNoEmailContact = await runAsTestActor(
          feeEarner.id,
          () =>
            savePersonRecord(
              {
                firstName: 'Ceri',
                surname: 'Noemail',
                emails: [],
              },
              { byId: feeEarner.id, mfaVerified: false },
            ),
          { mfaVerified: false },
        );
        expect(isActionDenied(createdNoEmailContact)).toBe(false);
        const noEmailContactId = createdNoEmailContact.person.id;
        expect(createdNoEmailContact.person.emails).toEqual([]);
        const noEmailContactBeforeJson = JSON.stringify(
          (await getPartyRepository().getPersonById<Person>(ctx, noEmailContactId))!,
        );

        const promoteNoEmailsWithoutMfaRes = await runAsTestActor(
          adminPerson.id,
          () =>
            savePersonRecord(
              {
                firstName: 'Ceri',
                surname: 'Noemail',
                isEmployee: true,
                employeeRoleId: 'employee_role.solicitor',
                departmentId: 'DEPT-RE',
              },
              { id: noEmailContactId, byId: adminPerson.id, mfaVerified: false },
            ),
          { mfaVerified: false },
        );
        expect(isActionDenied(promoteNoEmailsWithoutMfaRes)).toBe(true);
        expect(promoteNoEmailsWithoutMfaRes.code).toBe('MFA_REQUIRED');
        expect(promoteNoEmailsWithoutMfaRes.message).toBe(
          'Multi-factor authentication (MFA) is required to change an employee or leaver email address.',
        );
        clearStoreMemoryCache();
        expect(
          JSON.stringify((await getPartyRepository().getPersonById<Person>(ctx, noEmailContactId))!),
        ).toBe(noEmailContactBeforeJson);
        expect(
          (await auditSinceTestStart()).some(
            (a) =>
              a.recordId === noEmailContactId &&
              a.field === 'Employee sign-in email',
          ),
        ).toBe(false);

        const promoteNoEmailsWithMfaRes = await runAsTestActor(adminPerson.id, () =>
          savePersonRecord(
            {
              firstName: 'Ceri',
              surname: 'Noemail',
              isEmployee: true,
              employeeRoleId: 'employee_role.solicitor',
              departmentId: 'DEPT-RE',
            },
            { id: noEmailContactId, byId: adminPerson.id, mfaVerified: true },
          ),
        );
        expect(isActionDenied(promoteNoEmailsWithMfaRes)).toBe(false);
        expect(promoteNoEmailsWithMfaRes.person.isEmployee).toBe(true);
        const synthesisedEmailAudit = (await auditSinceTestStart()).find(
          (a) =>
            a.recordId === noEmailContactId &&
            a.action === 'update' &&
            a.field === 'Employee sign-in email',
        );
        expect(synthesisedEmailAudit).toBeDefined();
        expect(synthesisedEmailAudit?.oldValue).toBeNull();
        expect(synthesisedEmailAudit?.newValue).toBe(
          'ceri.noemail@notalawfirm.example',
        );

        // Also verify via savePersonAction with a non-MFA session
        setTestEntraSessionOverride({
          personId: adminPerson.id,
          tenantId: 'not-a-law-firm',
          oid: '00000000-0000-4000-8000-000000000004',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: adminPerson.id,
          email: 'catrin.williams@notalawfirm.example',
          displayName: 'Catrin Williams',
          entraRoles: ['admin'],
          mappedRoles: ['admin'],
          entraGroups: [],
          mfaVerified: false,
          amr: ['pwd'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
        const actionNoMfaRes = await savePersonAction(
          {
            firstName: targetEmployee.firstName,
            surname: targetEmployee.surname,
            emails: [
              {
                id: targetEmployee.emails[0]!.id,
                address: 'sian.renamed@notalawfirm.example',
                typeId: 'email_type.work',
                isPrimary: true,
                active: true,
              },
            ],
          },
          { id: targetEmployee.id },
        );
        expect(isActionDenied(actionNoMfaRes)).toBe(true);
        expect(actionNoMfaRes.code).toBe('MFA_REQUIRED');
        expect(actionNoMfaRes.message).toBe(
          'Multi-factor authentication (MFA) is required to change an employee or leaver email address.',
        );

        // 1e. With employee:edit_core and MFA, the change is allowed, writes the dedicated audit entry, and keeps existing entraObjectId
        const currentTargetEmp = (await getPartyRepository().getPersonById<Person>(ctx, targetEmployee.id))!;
        currentTargetEmp.entraObjectId = '00000000-0000-4000-8000-000000000005';
        await getPartyRepository().putPerson(ctx, currentTargetEmp);
        setTestEntraSessionOverride({
          personId: adminPerson.id,
          tenantId: 'not-a-law-firm',
          oid: '00000000-0000-4000-8000-000000000004',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: adminPerson.id,
          email: 'catrin.williams@notalawfirm.example',
          displayName: 'Catrin Williams',
          entraRoles: ['admin'],
          mappedRoles: ['admin'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
        const allowedRes = await savePersonAction(
          {
            firstName: targetEmployee.firstName,
            surname: targetEmployee.surname,
            emails: [
              {
                id: targetEmployee.emails[0]!.id,
                address: 'sian.renamed@notalawfirm.example',
                typeId: 'email_type.work',
                isPrimary: true,
                active: true,
              },
            ],
          },
          { id: targetEmployee.id },
        );
        expect(isActionDenied(allowedRes)).toBe(false);
        expect(allowedRes.errors).toBeUndefined();
        expect(allowedRes.person.emails[0]?.address).toBe(
          'sian.renamed@notalawfirm.example',
        );
        expect(allowedRes.person.entraObjectId).toBe(
          '00000000-0000-4000-8000-000000000005',
        );
        const emailAudit = (await auditSinceTestStart()).find(
          (a) =>
            a.recordId === targetEmployee.id &&
            a.action === 'update' &&
            a.field === 'Employee sign-in email',
        );
        expect(emailAudit).toBeDefined();
        expect(emailAudit?.oldValue).toContain(originalPrimaryAddr.toLowerCase());
        expect(emailAudit?.newValue).toBe('sian.renamed@notalawfirm.example');

        // R383 & R394: Creating an employee from PMS requires mfaVerified === true (fails closed without MFA even when no actor session is active) and writes the Employee sign-in email audit entry when MFA is verified
        getStore().pmsLinks = getStore().pmsLinks.filter(
          (l) => !(l.entityType === 'employee' && l.pmsCode === 'FE001'),
        );
        saveStore(getStore());
        setTestEntraSessionOverride({
          personId: adminPerson.id,
          tenantId: 'not-a-law-firm',
          oid: '00000000-0000-4000-8000-000000000004',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: adminPerson.id,
          email: 'catrin.williams@notalawfirm.example',
          displayName: 'Catrin Williams',
          entraRoles: ['admin'],
          mappedRoles: ['admin'],
          entraGroups: [],
          mfaVerified: false,
          amr: ['pwd'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
        const pmsEmpNoMfaRes = await createRecordFromPms(
          'employee',
          'FE001',
          adminPerson.id,
          { mfaVerified: false },
        );
        expect(pmsEmpNoMfaRes.ok).toBe(false);
        expect(pmsEmpNoMfaRes.code).toBe('MFA_REQUIRED');

        setTestEntraSessionOverride({
          personId: adminPerson.id,
          tenantId: 'not-a-law-firm',
          oid: '00000000-0000-4000-8000-000000000004',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: adminPerson.id,
          email: 'catrin.williams@notalawfirm.example',
          displayName: 'Catrin Williams',
          entraRoles: ['admin'],
          mappedRoles: ['admin'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
        const pmsEmpRes = await createRecordFromPmsAction('employee', 'FE001');
        expect(pmsEmpRes.ok).toBe(true);
        expect(pmsEmpRes.createdId).toBeDefined();
        const pmsEmpEmailAudit = (await auditSinceTestStart()).find(
          (a) =>
            a.recordId === pmsEmpRes.createdId &&
            a.action === 'update' &&
            a.field === 'Employee sign-in email',
        );
        expect(pmsEmpEmailAudit).toBeDefined();
        expect(pmsEmpEmailAudit?.oldValue).toBeNull();
        expect(pmsEmpEmailAudit?.newValue).toBeTruthy();
      } finally {
        setTestEntraSessionOverride(undefined);
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });

    it('2. links only non-privileged single-match employees in allowed linking domains on sign-in, writes an entra-link audit entry without logging PII, refuses privileged and ambiguous links without provisioning, and blocks R373 end-to-end takeover', async () => {
      await resetAllDemoData('P-000001', testDataResetContext());
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const ctx = testDataResetContext();
        const initialPeople = await getPartyRepository().listAllPeople<Person>(ctx);
        // Clear synthetic test OIDs so personas start unbound as in demo/onboarding
        for (const p of initialPeople) {
          delete p.entraObjectId;
          await getPartyRepository().putPerson(ctx, p);
        }

        const feeEarner = initialPeople.find((p) => p.id === 'P-000002')!;
        const feeEarnerEmail = feeEarner.emails[0]!.address;

        // 2a. Unverified email claim alone (no preferred_username/upn and no xms_edov, or string xms_edov: "true") does NOT link, and does not store the unverified email on the provisioned record (R387, R389)
        const unverifiedEmailAttempt = await resolveOrProvisionEntraEmployee({
          oid: '11111111-0000-4000-8000-000000000201',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: 'sub-unverified-201',
          name: 'Unverified Email Caller',
          email: feeEarnerEmail,
          roles: [],
          amr: ['pwd', 'mfa'],
        });
        expect(unverifiedEmailAttempt.person.id).not.toBe(feeEarner.id);
        expect(unverifiedEmailAttempt.person.emails).toEqual([]);
        expect(
          (await getPartyRepository().getPersonById<Person>(ctx, feeEarner.id))?.entraObjectId,
        ).toBeUndefined();

        const stringEdovAttempt = await resolveOrProvisionEntraEmployee({
          oid: '11111111-0000-4000-8000-000000000202',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: 'sub-string-edov-202',
          name: 'String Edov Caller',
          email: feeEarnerEmail,
          xms_edov: 'true' as unknown as boolean,
          roles: [],
          amr: ['pwd', 'mfa'],
        });
        expect(stringEdovAttempt.person.id).not.toBe(feeEarner.id);
        expect(stringEdovAttempt.person.emails).toEqual([]);
        expect(
          (await getPartyRepository().getPersonById<Person>(ctx, feeEarner.id))?.entraObjectId,
        ).toBeUndefined();

        // 2b. Sign-in with preferred_username in the tenant's linking domain binds ordinary unbound employee P-000002 and writes an entra-link audit entry
        const linkedOrd = await resolveOrProvisionEntraEmployee(
          {
            oid: '11111111-0000-4000-8000-000000000002',
            tid: '11111111-2222-3333-4444-000000000000',
            sub: 'sub-dafydd-002',
            name: 'Dafydd Evans',
            preferred_username: feeEarnerEmail,
            email: feeEarnerEmail,
            roles: [],
            amr: ['pwd', 'mfa'],
          },
          { correlationId: 'corr-req-test-002' },
        );
        expect(linkedOrd.person.id).toBe(feeEarner.id);
        expect(linkedOrd.person.entraObjectId).toBe(
          '11111111-0000-4000-8000-000000000002',
        );
        expect(
          (await getPartyRepository().getPersonById<Person>(ctx, feeEarner.id))?.entraObjectId,
        ).toBe('11111111-0000-4000-8000-000000000002');
        const linkAudit = (await auditSinceTestStart()).find(
          (a) =>
            a.recordId === feeEarner.id &&
            a.action === 'entra-link' &&
            a.field === 'Entra ID Email Link',
        );
        expect(linkAudit).toBeDefined();
        expect(linkAudit?.newValue).not.toContain(feeEarnerEmail);
        expect(linkAudit?.newValue).not.toContain(
          '11111111-0000-4000-8000-000000000002',
        );
        const signInAudit = (await auditSinceTestStart()).find(
          (a) =>
            a.recordId === feeEarner.id &&
            a.action === 'update' &&
            a.field === 'Entra ID OIDC Sign-In',
        );
        expect(signInAudit).toBeDefined();
        expect(signInAudit?.newValue).toContain('correlationId=corr-req-test-002');
        expect(signInAudit?.newValue).not.toContain('oid=');
        // Verify server logs contain only personId, correlationId, and tenantId — never the email or oid
        const loggedCalls = infoSpy.mock.calls.map((c) => String(c[0]));
        const boundLog = loggedCalls.find((s) =>
          s.includes('ENTRA_EMAIL_LINK_BOUND'),
        );
        expect(boundLog).toBeDefined();
        const parsedLog = JSON.parse(boundLog!);
        expect(parsedLog.personId).toBe(feeEarner.id);
        expect(parsedLog.tenantId).toBe('not-a-law-firm');
        expect(parsedLog.correlationId).toBe('corr-req-test-002');
        expect(boundLog).not.toContain(feeEarnerEmail);
        expect(boundLog).not.toContain('11111111-0000-4000-8000-000000000002');

        // Also verify verified email claim (xms_edov: true) when preferred_username/upn is absent binds an ordinary unbound employee (P-000009 Finance), and unsafe correlationId options are sanitised (R399)
        const financeUser = (await getPartyRepository().getPersonById<Person>(ctx, 'P-000009'))!;
        const financeEmail = financeUser.emails[0]!.address;
        const linkedViaVerifiedEmail = await resolveOrProvisionEntraEmployee(
          {
            oid: '11111111-0000-4000-8000-000000000009',
            tid: '11111111-2222-3333-4444-000000000009',
            sub: 'sub-gethin-009',
            name: 'Gethin Powell',
            email: financeEmail,
            xms_edov: true,
            roles: [],
            amr: ['pwd', 'mfa'],
          },
          { correlationId: 'x; roles=admin; mfa=true' },
        );
        expect(linkedViaVerifiedEmail.person.id).toBe(financeUser.id);
        expect(linkedViaVerifiedEmail.person.entraObjectId).toBe(
          '11111111-0000-4000-8000-000000000009',
        );
        const financeSignInAudit = (await auditSinceTestStart()).find(
          (a) =>
            a.recordId === financeUser.id &&
            a.action === 'update' &&
            a.field === 'Entra ID OIDC Sign-In',
        );
        expect(financeSignInAudit?.newValue).toMatch(
          /correlationId=corr-entra-signin-[0-9a-f-]{36}$/i,
        );
        expect(financeSignInAudit?.newValue).not.toContain('roles=admin');

        // 2c. Sign-in with an email outside the linking domains doesn't bind
        const secretary = (await getPartyRepository().getPersonById<Person>(ctx, 'P-000010'))!;
        secretary.emails = [
          {
            id: 'em-sec-ext',
            address: 'nia.edwards@external-domain.example',
            typeId: 'email_type.work',
            isPrimary: true,
            active: true,
          },
        ];
        await getPartyRepository().putPerson(ctx, secretary);
        const outsideDomainSignIn = await resolveOrProvisionEntraEmployee({
          oid: '11111111-0000-4000-8000-000000000010',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: 'sub-nia-010',
          name: 'Nia Edwards',
          preferred_username: 'nia.edwards@external-domain.example',
          roles: [],
          amr: ['pwd', 'mfa'],
        });
        expect(outsideDomainSignIn.person.id).not.toBe(secretary.id);
        expect(
          (await getPartyRepository().getPersonById<Person>(ctx, 'P-000010'))?.entraObjectId,
        ).toBeUndefined();

        // 2d. R382 & R396: Sign-in matching a privileged persona (P-000004 System Administrator, and an admin-role persona) by email refuses to link AND refuses to provision a duplicate, leaving store.people.length unchanged, no record with the token's oid, and a persisted entra-link refusal audit entry across clearStoreMemoryCache()
        const adminPerson = (await getPartyRepository().getPersonById<Person>(ctx, 'P-000004'))!;
        const adminEmail = adminPerson.emails[0]!.address;
        const peopleCountBeforePrivRefusal = (await getPartyRepository().listAllPeople(ctx)).length;
        await expect(resolveOrProvisionEntraEmployee({
            oid: '11111111-0000-4000-8000-000000000004',
            tid: '11111111-2222-3333-4444-000000000000',
            sub: 'sub-admin-004',
            name: 'Catrin Williams',
            preferred_username: adminEmail,
            email: adminEmail,
            xms_edov: true,
            roles: [],
            amr: ['pwd', 'mfa'],
          })).rejects.toThrow('Your account needs to be linked by an administrator.');
        clearStoreMemoryCache();
        const peopleAfterPrivRefusal = await getPartyRepository().listAllPeople<Person>(ctx);
        expect(peopleAfterPrivRefusal.length).toBe(peopleCountBeforePrivRefusal);
        expect(
          peopleAfterPrivRefusal.find((p) => p.id === 'P-000004')?.entraObjectId,
        ).toBeUndefined();
        expect(
          peopleAfterPrivRefusal.some(
            (p) => p.entraObjectId === '11111111-0000-4000-8000-000000000004',
          ),
        ).toBe(false);
        const privRefusalAudit = (await auditSinceTestStart()).find(
          (a) =>
            a.recordId === 'P-000004' &&
            a.action === 'entra-link' &&
            a.field === 'Entra ID Email Link Refused',
        );
        expect(privRefusalAudit).toBeDefined();
        expect(privRefusalAudit?.newValue).toContain('P-000004');
        expect(privRefusalAudit?.newValue).toContain('correlationId=');
        expect(privRefusalAudit?.newValue).not.toContain(adminEmail);
        expect(privRefusalAudit?.newValue).not.toContain(
          '11111111-0000-4000-8000-000000000004',
        );

        const managingPartner = (await getPartyRepository().getPersonById<Person>(ctx, 'P-000038'))!;
        managingPartner.roles = ['admin'];
        await getPartyRepository().putPerson(ctx, managingPartner);
        const mpEmail = managingPartner.emails[0]!.address;
        await expect(resolveOrProvisionEntraEmployee({
            oid: '11111111-0000-4000-8000-000000000038',
            tid: '11111111-2222-3333-4444-000000000000',
            sub: 'sub-mp-038',
            name: 'Gethin Lloyd',
            preferred_username: mpEmail,
            email: mpEmail,
            xms_edov: true,
            roles: [],
            amr: ['pwd', 'mfa'],
          })).rejects.toThrow('Your account needs to be linked by an administrator.');
        clearStoreMemoryCache();
        const peopleAfterMpRefusal = await getPartyRepository().listAllPeople<Person>(ctx);
        expect(peopleAfterMpRefusal.length).toBe(peopleCountBeforePrivRefusal);
        expect(
          peopleAfterMpRefusal.find((p) => p.id === 'P-000038')?.entraObjectId,
        ).toBeUndefined();
        expect(
          peopleAfterMpRefusal.some(
            (p) => p.entraObjectId === '11111111-0000-4000-8000-000000000038',
          ),
        ).toBe(false);

        // 2e. Two unbound employees with the same address: no binding, no duplicate provisioned, and ambiguity is persisted as entra-link without the address or oid
        const empA = (await getPartyRepository().getPersonById<Person>(ctx, 'P-000006'))!;
        const empB = (await getPartyRepository().getPersonById<Person>(ctx, 'P-000007'))!;
        // Make both non-privileged fee earners with the same work email
        empA.roles = ['fee_earner'];
        empA.employeeRoleId = 'employee_role.solicitor';
        empB.roles = ['fee_earner'];
        empB.employeeRoleId = 'employee_role.solicitor';
        const sharedAddr = 'shared.inbox@notalawfirm.example';
        empA.emails = [
          {
            id: 'em-dup-a',
            address: sharedAddr,
            typeId: 'email_type.work',
            isPrimary: true,
            active: true,
          },
        ];
        empB.emails = [
          {
            id: 'em-dup-b',
            address: sharedAddr,
            typeId: 'email_type.work',
            isPrimary: true,
            active: true,
          },
        ];
        await getPartyRepository().putPerson(ctx, empA);
        await getPartyRepository().putPerson(ctx, empB);
        const peopleCountBeforeAmbigRefusal = (await getPartyRepository().listAllPeople(ctx)).length;
        await expect(resolveOrProvisionEntraEmployee({
            oid: '11111111-0000-4000-8000-000000000067',
            tid: '11111111-2222-3333-4444-000000000000',
            sub: 'sub-dup-067',
            name: 'Duplicate Email User',
            preferred_username: sharedAddr,
            roles: [],
            amr: ['pwd', 'mfa'],
          })).rejects.toThrow('Your account needs to be linked by an administrator.');
        clearStoreMemoryCache();
        const peopleAfterAmbigRefusal = await getPartyRepository().listAllPeople<Person>(ctx);
        expect(peopleAfterAmbigRefusal.length).toBe(peopleCountBeforeAmbigRefusal);
        expect(
          peopleAfterAmbigRefusal.find((p) => p.id === 'P-000006')?.entraObjectId,
        ).toBeUndefined();
        expect(
          peopleAfterAmbigRefusal.find((p) => p.id === 'P-000007')?.entraObjectId,
        ).toBeUndefined();
        expect(
          peopleAfterAmbigRefusal.some(
            (p) => p.entraObjectId === '11111111-0000-4000-8000-000000000067',
          ),
        ).toBe(false);
        const ambigAudit = (await auditSinceTestStart()).find(
          (a) =>
            a.action === 'entra-link' &&
            a.field === 'Entra ID Email Link Ambiguous',
        );
        expect(ambigAudit).toBeDefined();
        expect(ambigAudit?.newValue).toContain('correlationId=');
        expect(ambigAudit?.newValue).not.toContain(sharedAddr);
        expect(ambigAudit?.newValue).not.toContain(
          '11111111-0000-4000-8000-000000000067',
        );

        // 2f. emailLinking.enabled: false disables email binding while existing oid bindings still work
        const unboundIntake = (await getPartyRepository().getPersonById<Person>(ctx, 'P-000008'))!;
        unboundIntake.roles = ['intake'];
        unboundIntake.employeeRoleId = 'employee_role.enquiries_coordinator';
        await getPartyRepository().putPerson(ctx, unboundIntake);
        const intakeEmail = unboundIntake.emails[0]!.address;
        await runAsTestActor('P-000004', () =>
          updateTenantRbacConfig(
            {
              identityMapping: {
                ...getDefaultTenantRbacConfig().identityMapping,
                emailLinking: {
                  enabled: false,
                  domains: [],
                },
              },
            },
            'P-000004',
            { mfaVerified: true },
          ),
        );
        const disabledEmailLinkAttempt = await resolveOrProvisionEntraEmployee({
          oid: '11111111-0000-4000-8000-000000000008',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: 'sub-intake-008',
          name: 'Carys Hughes',
          preferred_username: intakeEmail,
          roles: [],
          amr: ['pwd', 'mfa'],
        });
        expect(disabledEmailLinkAttempt.person.id).not.toBe(unboundIntake.id);
        expect(
          (await getPartyRepository().getPersonById<Person>(ctx, 'P-000008'))?.entraObjectId,
        ).toBeUndefined();

        // Existing oid binding on feeEarner (P-000002) still resolves P-000002 even when emailLinking.enabled is false
        const existingOidSignIn = await resolveOrProvisionEntraEmployee({
          oid: '11111111-0000-4000-8000-000000000002',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: 'sub-dafydd-002',
          name: 'Dafydd Evans',
          preferred_username: 'renamed.upn@other.example',
          roles: [],
          amr: ['pwd', 'mfa'],
        });
        expect(existingOidSignIn.person.id).toBe(feeEarner.id);

        // Re-enable emailLinking for the end-to-end R373 attack test
        await runAsTestActor('P-000004', () =>
          updateTenantRbacConfig(
            {
              identityMapping: {
                ...getDefaultTenantRbacConfig().identityMapping,
                emailLinking: {
                  enabled: true,
                  domains: [],
                },
              },
            },
            'P-000004',
            { mfaVerified: true },
          ),
        );

        // 2g. End-to-end R373 attack:
        // Step 1: Fee earner P-000002 tries to edit admin P-000004's email -> denied with FORBIDDEN
        const currentAdmin = (await getPartyRepository().getPersonById<Person>(ctx, 'P-000004'))!;
        const attackerEditAttempt = await runAsTestActor(feeEarner.id, () =>
          savePersonRecord(
            {
              firstName: currentAdmin.firstName,
              surname: currentAdmin.surname,
              emails: [
                {
                  id: 'em-attacker-controlled',
                  address: 'second.account@notalawfirm.example',
                  typeId: 'email_type.work',
                  isPrimary: true,
                  active: true,
                },
              ],
            },
            { id: currentAdmin.id, byId: feeEarner.id, mfaVerified: true },
          ),
        );
        expect(isActionDenied(attackerEditAttempt)).toBe(true);
        expect(attackerEditAttempt.code).toBe('FORBIDDEN');
        expect(attackerEditAttempt.message).toBe(
          'You do not have permission (employee:edit_core) to change an employee or leaver email address.',
        );

        // Step 2: Even if P-000004's email is set directly in the store to the attacker's address, signing in as that address is refused (throws) and neither binds P-000004 nor provisions a duplicate
        currentAdmin.emails = [
          {
            id: 'em-attacker-direct',
            address: 'second.account@notalawfirm.example',
            typeId: 'email_type.work',
            isPrimary: true,
            active: true,
          },
        ];
        delete currentAdmin.entraObjectId;
        await getPartyRepository().putPerson(ctx, currentAdmin);

        const peopleCountBeforeAttackerSignIn = (await getPartyRepository().listAllPeople(ctx)).length;
        await expect(resolveOrProvisionEntraEmployee({
            oid: '99999999-0000-4000-8000-999999999999',
            tid: '11111111-2222-3333-4444-000000000000',
            sub: 'sub-attacker-999',
            name: 'Attacker Second Account',
            preferred_username: 'second.account@notalawfirm.example',
            email: 'second.account@notalawfirm.example',
            xms_edov: true,
            roles: [],
            amr: ['pwd', 'mfa'],
          })).rejects.toThrow('Your account needs to be linked by an administrator.');
        const peopleAfterAttackerSignIn = await getPartyRepository().listAllPeople<Person>(ctx);
        expect(peopleAfterAttackerSignIn.length).toBe(peopleCountBeforeAttackerSignIn);
        expect(
          peopleAfterAttackerSignIn.find((p) => p.id === 'P-000004')?.entraObjectId,
        ).toBeUndefined();
        expect(
          peopleAfterAttackerSignIn.some(
            (p) => p.entraObjectId === '99999999-0000-4000-8000-999999999999',
          ),
        ).toBe(false);
      } finally {
        infoSpy.mockRestore();
        warnSpy.mockRestore();
        await resetAllDemoData('P-000001', testDataResetContext());
      }
    });

    it('3. validates rbac.identityMapping.emailLinking in TenantConfigurationSchema and updateTenantRbacConfig', async () => {
      const validCfg = structuredClone(notALawFirmBaseConfig) as Record<
        string,
        unknown
      >;
      validCfg.rbac = {
        ...createDefaultRbacConfig(),
        identityMapping: {
          ...createDefaultRbacConfig().identityMapping,
          emailLinking: {
            enabled: true,
            domains: ['notalawfirm.example', 'subsidiary.co.uk'],
          },
        },
      };
      const parsedValid = TenantConfigurationSchema.safeParse(validCfg);
      expect(parsedValid.success).toBe(true);
      if (parsedValid.success) {
        expect(parsedValid.data.rbac.identityMapping.emailLinking).toEqual({
          enabled: true,
          domains: ['notalawfirm.example', 'subsidiary.co.uk'],
        });
      }

      // Rejects a non-string domain or uppercase/invalid domain in TenantConfigurationSchema
      const invalidNonStringCfg = structuredClone(validCfg);
      (
        (invalidNonStringCfg.rbac as Record<string, unknown>)
          .identityMapping as Record<string, unknown>
      ).emailLinking = {
        enabled: true,
        domains: [12345],
      };
      expect(
        TenantConfigurationSchema.safeParse(invalidNonStringCfg).success,
      ).toBe(false);

      const invalidUppercaseCfg = structuredClone(validCfg);
      (
        (invalidUppercaseCfg.rbac as Record<string, unknown>)
          .identityMapping as Record<string, unknown>
      ).emailLinking = {
        enabled: true,
        domains: ['UpperCaseDomain.com'],
      };
      expect(
        TenantConfigurationSchema.safeParse(invalidUppercaseCfg).success,
      ).toBe(false);

      // Also rejects invalid domain in updateTenantRbacConfig service
      const badServiceUpdate = await runAsTestActor('P-000004', () =>
        updateTenantRbacConfig(
          {
            identityMapping: {
              ...getDefaultTenantRbacConfig().identityMapping,
              emailLinking: {
                enabled: true,
                domains: ['not_a_valid_domain'],
              },
            },
          },
          'P-000004',
          { mfaVerified: true },
        ),
      );
      expect(badServiceUpdate.ok).toBe(false);
      expect(badServiceUpdate.error).toContain('emailLinking.domains');

      // R386: Rejects non-boolean emailLinking.enabled ("false" or null) in updateTenantRbacConfig and leaves stored configuration unchanged
      const configBeforeBadEnabled = JSON.stringify(getDefaultTenantRbacConfig());
      const stringEnabledUpdate = await runAsTestActor('P-000004', () =>
        updateTenantRbacConfig(
          {
            identityMapping: {
              ...getDefaultTenantRbacConfig().identityMapping,
              emailLinking: {
                enabled: 'false' as unknown as boolean,
                domains: [],
              },
            },
          },
          'P-000004',
          { mfaVerified: true },
        ),
      );
      expect(stringEnabledUpdate.ok).toBe(false);
      expect(stringEnabledUpdate.error).toBe(
        'emailLinking.enabled must be a boolean.',
      );
      expect(JSON.stringify(getDefaultTenantRbacConfig())).toBe(
        configBeforeBadEnabled,
      );

      const nullEnabledUpdate = await runAsTestActor('P-000004', () =>
        updateTenantRbacConfig(
          {
            identityMapping: {
              ...getDefaultTenantRbacConfig().identityMapping,
              emailLinking: {
                enabled: null as unknown as boolean,
                domains: [],
              },
            },
          },
          'P-000004',
          { mfaVerified: true },
        ),
      );
      expect(nullEnabledUpdate.ok).toBe(false);
      expect(nullEnabledUpdate.error).toBe(
        'emailLinking.enabled must be a boolean.',
      );
      expect(JSON.stringify(getDefaultTenantRbacConfig())).toBe(
        configBeforeBadEnabled,
      );
    });
  });
});
