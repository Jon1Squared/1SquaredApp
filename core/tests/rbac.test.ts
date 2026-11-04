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
  getAppSnapshot,
  getEmployeeDetailsForUser,
  logEmployeeRestrictedAccess,
  previewRbacOverrides,
  requireAuthenticatedActor,
  resetAllDemoData,
  resolveOrProvisionEntraEmployee,
  updateEmployeeRolesAndSupports,
  updateEmployeeRoleSetting,
  updatePersonPermissionOverrides,
  updateTenantRbacConfig,
  withPageActor,
} from '../../src/server/services';
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
  addHomeRoleAction,
  resetHomePagesConfigAction,
  saveHomePagesConfigAction,
  switchUserAction,
  updateTenantRbacConfigAction,
} from '../../src/app/actions';
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
    it('defines all 44 canonical permissions with metadata and MFA flags', () => {
      expect(ALL_PERMISSION_KEYS.length).toBe(44);
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
});
