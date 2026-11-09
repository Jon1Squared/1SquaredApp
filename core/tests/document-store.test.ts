/**
 * Comprehensive Test Suite for External Document Store Integration (`core/tests/document-store.test.ts`).
 *
 * Covers Section 11 of the specification:
 * 1. Unit tests: folder template resolution, extends vs replaces, all 5 operations, template validation,
 *    routing rule matching, token rendering & sanitisation, permission compilation (standard, cross-team,
 *    restricted, closed), SharePoint URL parsing, role mapping, error normalisation, and scale warnings.
 * 2. Contract tests: `DocumentStoreProvider` contract suite against `SharePointDocumentStoreProvider`
 *    with `MockSharePointGraphBackend` (including large-file resumable upload >= 4 MiB, conflict modes,
 *    and HTTP 429 retry).
 * 3. Security tests: user-facing operations never invoke provisioning identity, 1Squared matter access
 *    blocks before any Graph call, store denial creates a reconciliation finding, restricted matter
 *    strips department/team groups, OBO token cache is encrypted and isolated per tenant & user.
 * 4. Two-tenant isolation tests: Tenant A cannot read, list, upload to, or provision into Tenant B's
 *    store, even with tampered matter IDs, folder IDs, drive IDs, or forged tenant claims.
 * 5. Lifecycle & reconciliation tests: idempotent retry, partial failure recovery, team/restriction/dept
 *    changes, closure & reopening, additive template updates on open matters, and permission drift
 *    detection & remediation.
 * 6. Static architecture check: zero client names, URLs, or group IDs in `core/`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import * as CoreBarrel from '../src/index';
import {
  ALLOWED_PATH_TOKENS,
  CORE_VERSION,
  DocumentStoreProviderRegistry,
  DocumentStoreTokenService,
  FORBIDDEN_BROAD_SHAREPOINT_PERMISSIONS,
  GENERIC_USER_DOCUMENT_STORE_UNAVAILABLE_MESSAGE,
  GRAPH_RESUMABLE_UPLOAD_THRESHOLD_BYTES,
  SHAREPOINT_ROLE_MAPPING,
  SharePointDocumentStoreProvider,
  TenantDocumentStoreRepository,
  TenantMigrationRunner,
  TenantScopedEncryptedTokenCache,
  applyTemplateAdditionsToOpenMattersJob,
  buildDocumentStoreAuditEvent,
  closeMatterFolderJob,
  collectStructuredConfigDeprecationWarnings,
  compileDepartmentFolderPermissions,
  compileMatterFolderPermissions,
  compileTeamFolderPermissions,
  computeAdditiveTemplateDiff,
  encodeMockTokenWithClaims,
  evaluateLibraryScopeScaleStatus,
  executeUserMatterDocumentOperation,
  findUnknownPathTokens,
  linkExistingMatterFolderJob,
  loadAndValidateTenantConfig,
  normaliseDocumentStoreError,
  parseSharePointLocationUrl,
  provisionMatterDocumentsJob,
  recalculateMatterPermissionsJob,
  reconcileDocumentStorePermissionsJob,
  remediateReconciliationFinding,
  renderBasePath,
  renderFolderNameTemplate,
  reopenMatterFolderJob,
  resolveMatterDocumentRoute,
  resolveMatterFolderTemplate,
  resolveTenantFromVerifiedToken,
  runTenantSharePointHealthCheckJob,
  sanitiseFolderNameSegment,
  PERMISSION_REGISTRY,
  validateDocumentConfigAgainstTenantData,
  validateDocumentStoreConfig,
  validateMatterFolderTemplatesConfig,
  validateRawFolderNameSegment,
  validateTenantConfigWithWarnings,
  type DocumentAccessConfig,
  type DocumentRoutingRule,
  type DocumentStoreConfig,
  type MatterDocumentLocationRecord,
  type MatterFolderTemplatesConfig,
  type MatterRoutingSubject,
  type ProvisioningAccessContext,
  type TenantContext,
  type UserAccessContext,
} from '../src/index';
import { MockSharePointGraphBackend } from '../src/testing';
import { POST as postDocumentStoresRoute } from '@/app/api/document-stores/route';
import { GET as getMatterDocumentsRoute } from '@/app/api/matters/[id]/documents/route';
import {
  hasPersonPermission,
  runWithActiveActorSession,
} from '@/server/rbacRuntime';
import { getActiveTenantConfiguration } from '@/platform/tenantRuntime';
import {
  buildEntraSessionPayload,
  createSignedEntraSessionCookie,
  setTestEntraSessionOverride,
  verifySignedEntraSessionCookie,
  type VerifiedEntraSessionPayload,
} from '@/server/entraAuth';
import {
  applyAdminTemplateAdditionsToOpenMatters,
  browseMatterDocumentStoreFolder,
  buildMatterRoutingSubject,
  buildTenantContextForUser,
  downloadMatterStoreDocument,
  ensureMatterDocumentStoreProvisioned,
  ensureRepositorySyncedWithStore,
  flushDocumentLifecycleSyncForTesting,
  getDocumentStoresAdminDashboard,
  getRegistrySingleton,
  linkExistingMatterDocumentFolder,
  mutateMatterStoreItem,
  persistRepositoryToStore,
  previewAdminMatterFolderTemplate,
  remediateAdminReconciliationFinding,
  resetDocumentStoreSingletonsForTesting,
  resolveAdminSharePointLocationUrl,
  resolvePersonOrgAssignment,
  retryMatterDocumentProvisioning,
  runAdminDocumentReconciliationScan,
  saveAdminDocumentStoreConfiguration,
  setBeforeMatterDocumentsCloseHookForTesting,
  syncMatterLifecycleOnSaveSync,
  testAdminDocumentStoreConnection,
  uploadMatterStoreDocument,
} from '@/server/documentStoreServices';
import {
  liftMatterRestriction,
  markEngagementLetterDrafted,
  saveMatterRecord,
  savePersonRecord,
  updateMatterConflictRecord,
} from '@/server/services';
import { getStore, saveStore } from '@/server/store';

void CORE_VERSION;

function makeTenantContext(overrides: {
  tenantId: string;
  actorId?: string;
  actorName?: string;
  actorEmail?: string;
  actorUpn?: string;
  actorRoles?: string[];
  actorGroups?: string[];
  entraObjectId?: string;
  entraTenantId?: string;
  mfaVerified?: boolean;
  correlationId?: string;
}): TenantContext {
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: overrides.actorId ?? 'user-1',
      tenantId: overrides.tenantId,
      name: overrides.actorName ?? 'Alex Practitioner',
      email: overrides.actorEmail ?? 'alex@firm-alpha.example',
      upn: overrides.actorUpn ?? 'alex@firm-alpha.example',
      roles: overrides.actorRoles ?? ['fee_earner'],
      groups: overrides.actorGroups ?? ['grp-dept-prop', 'grp-team-res'],
      entraObjectId:
        overrides.entraObjectId !== undefined
          ? overrides.entraObjectId
          : 'oid-user-alex-001',
      entraTenantId: overrides.entraTenantId ?? 'entra-tenant-alpha-001',
      mfaVerified: overrides.mfaVerified ?? true,
    },
    hostingMode: 'multi_tenant',
    environment: 'test',
    correlationId: overrides.correlationId ?? 'corr-test-001',
  });
}

function makeGenericStores(prefix = 'alpha'): DocumentStoreConfig[] {
  return [
    {
      storeId: `${prefix}-sp-primary`,
      displayName: 'Primary Practice SharePoint Store',
      providerType: 'sharepoint',
      isDefault: true,
      enabled: true,
      auth: {
        entraTenantId: `entra-${prefix}-001`,
        credentialMode: 'client_certificate',
        clientId: `app-${prefix}-001`,
        certificateKeyVaultSecretRef: `kv://kv-${prefix}-test/sp-provisioning-cert`,
        delegatedPermissionScope: 'Files.ReadWrite.All',
      },
      sharepoint: {
        hostname: `${prefix}.sharepoint.com`,
        siteRelativePath: '/sites/PracticeDMS',
        siteId: `site-${prefix}-001`,
        libraries: [
          {
            libraryId: 'lib-matters',
            displayName: 'Matter Repository',
            libraryUrlSegment: 'Matter Repository',
            driveId: `drive-${prefix}-matters`,
          },
          {
            libraryId: 'lib-disputes',
            displayName: 'Disputes Repository',
            libraryUrlSegment: 'Disputes Repository',
            driveId: `drive-${prefix}-disputes`,
          },
        ],
      },
    },
  ];
}

function makeGenericRoutingRules(prefix = 'alpha'): DocumentRoutingRule[] {
  return [
    {
      ruleId: 'route-disputes',
      match: { departmentId: 'DEPT-LIT' },
      storeId: `${prefix}-sp-primary`,
      libraryId: 'lib-disputes',
      basePath: '{departmentCode}/{teamCode}',
    },
    {
      ruleId: 'route-default',
      match: 'default',
      storeId: `${prefix}-sp-primary`,
      libraryId: 'lib-matters',
      basePath: '{departmentCode}/{teamCode}',
    },
  ];
}

function makeGenericAccessConfig(): DocumentAccessConfig {
  return {
    uniqueScopeWarningThreshold: 4000,
    autoRemediateDrift: false,
    departmentEntraGroups: {
      'DEPT-PROP': 'grp-dept-prop',
      'DEPT-LIT': 'grp-dept-lit',
      'DEPT-CORP': 'grp-dept-corp',
    },
    teamEntraGroups: {
      'TEAM-RES': 'grp-team-res',
      'TEAM-COMM': 'grp-team-comm',
      'TEAM-LIT-A': 'grp-team-lit-a',
    },
    defaultPolicy: {
      libraryRoot: [
        {
          groupId: 'grp-dms-admins',
          level: 'manage',
          description: 'DMS Administrators',
        },
        {
          groupId: 'grp-risk-oversight',
          level: 'read',
          description: 'Risk Oversight',
        },
      ],
      owningDepartment: 'read',
      owningTeam: 'edit',
      otherDepartments: 'none',
      matterTeamOutsider: 'edit',
      restrictedMatter: {
        allowedUserLevel: 'edit',
        groups: [
          {
            groupId: 'grp-risk-oversight',
            level: 'read',
            description: 'Risk Oversight',
          },
        ],
      },
      closedMatter: 'read',
    },
  };
}

function makeGenericTemplatesConfig(): MatterFolderTemplatesConfig {
  return {
    default: {
      templateId: 'tpl-default',
      version: 1,
      mode: 'replaces',
      nodes: [
        { name: '01 Client Care', filingAliases: ['client_care'] },
        { name: '02 Correspondence', filingAliases: ['correspondence'] },
        {
          name: '03 Working Drafts',
          children: [{ name: 'Internal Notes' }],
        },
        { name: '04 Final Documents' },
        { name: '05 Billing' },
      ],
    },
    byDepartment: {
      'DEPT-PROP': {
        templateId: 'tpl-dept-prop',
        version: 1,
        mode: 'extends',
        operations: [
          {
            op: 'add',
            parentPath: '/',
            node: { name: '03a Searches' },
          },
        ],
      },
    },
    byWorkType: {
      'wt.residential_conveyancing': {
        templateId: 'tpl-wt-conveyancing',
        version: 2,
        mode: 'extends',
        operations: [
          {
            op: 'add',
            parentPath: '/',
            node: { name: '03b Title and Contract' },
          },
          {
            op: 'rename',
            path: '05 Billing',
            newName: '05 Completion and Billing',
          },
        ],
      },
      'wt.custom_replacement': {
        templateId: 'tpl-wt-custom',
        version: 1,
        mode: 'replaces',
        nodes: [
          { name: 'A Intake' },
          { name: 'B Execution' },
        ],
      },
    },
  };
}

function makeMatterSubject(
  overrides: Partial<MatterRoutingSubject> = {},
): MatterRoutingSubject {
  return {
    matterId: 'M-1001',
    matterNumber: 'MAT-2026-0001',
    clientNumber: 'CLI-001',
    matterDescription: 'Purchase of 10 High Street',
    departmentId: 'DEPT-PROP',
    departmentCode: 'PROP',
    teamId: 'TEAM-RES',
    teamCode: 'RES',
    workTypeId: 'wt.residential_conveyancing',
    practiceAreaId: 'wt.property',
    workTypeCode: 'CONV',
    isRestricted: false,
    restrictedAccessUserIds: [],
    owningTeamMemberIds: ['user-1', 'user-2'],
    matterTeamMemberIds: ['user-1', 'user-2'],
    isClosed: false,
    ...overrides,
  };
}

describe('External Document Store Integration (Sections 1–14)', () => {
  // ============================================================================
  // 1. Unit Tests: Folder Templates, Routing, Security, URL Parser, Role Mapping
  // ============================================================================
  describe('1. Unit Tests: Templates, Routing, Security, URL Parser & Error Normalisation', () => {
    it('resolves folder templates across workType -> department -> default with extends and replaces', () => {
      const config = makeGenericTemplatesConfig();

      // 1. Default fallback
      const defaultResolved = resolveMatterFolderTemplate({
        templatesConfig: config,
        departmentId: 'DEPT-UNKNOWN',
        workTypeId: 'wt.unknown',
      });
      expect(defaultResolved.templateId).toBe('tpl-default');
      expect(defaultResolved.resolutionChain).toEqual(['tpl-default']);
      expect(defaultResolved.flatRelativePaths).toContain('01 Client Care');
      expect(defaultResolved.flatRelativePaths).toContain(
        '03 Working Drafts/Internal Notes',
      );

      // 2. Department + WorkType both extending default
      const propConvResolved = resolveMatterFolderTemplate({
        templatesConfig: config,
        departmentId: 'DEPT-PROP',
        workTypeId: 'wt.residential_conveyancing',
      });
      expect(propConvResolved.templateId).toBe('tpl-wt-conveyancing');
      expect(propConvResolved.version).toBe(2);
      expect(propConvResolved.resolutionChain).toEqual([
        'tpl-default',
        'tpl-dept-prop',
        'tpl-wt-conveyancing',
      ]);
      expect(propConvResolved.flatRelativePaths).toContain('03a Searches');
      expect(propConvResolved.flatRelativePaths).toContain(
        '03b Title and Contract',
      );
      expect(propConvResolved.flatRelativePaths).toContain(
        '05 Completion and Billing',
      );
      expect(propConvResolved.flatRelativePaths).not.toContain('05 Billing');

      // 3. WorkType with mode: 'replaces' discards base layers
      const replacedResolved = resolveMatterFolderTemplate({
        templatesConfig: config,
        departmentId: 'DEPT-PROP',
        workTypeId: 'wt.custom_replacement',
      });
      expect(replacedResolved.templateId).toBe('tpl-wt-custom');
      expect(replacedResolved.resolutionChain).toEqual(['tpl-wt-custom']);
      expect(replacedResolved.flatRelativePaths).toEqual([
        'A Intake',
        'B Execution',
      ]);
    });

    it('supports all 5 template operations: add, remove, rename, move, and setAccess (with scale warning)', () => {
      const config: MatterFolderTemplatesConfig = {
        default: {
          templateId: 'tpl-base',
          version: 1,
          mode: 'replaces',
          nodes: [
            { name: 'Folder A' },
            { name: 'Folder B' },
            { name: 'Folder C' },
          ],
        },
        byWorkType: {
          'wt.ops': {
            templateId: 'tpl-ops',
            version: 1,
            mode: 'extends',
            operations: [
              {
                op: 'add',
                parentPath: 'Folder A',
                node: { name: 'Subfolder A1' },
              },
              {
                op: 'remove',
                path: 'Folder B',
              },
              {
                op: 'rename',
                path: 'Folder C',
                newName: 'Folder C Renamed',
              },
              {
                op: 'move',
                path: 'Folder A/Subfolder A1',
                newParentPath: 'Folder C Renamed',
              },
              {
                op: 'setAccess',
                path: 'Folder C Renamed/Subfolder A1',
                access: {
                  inherit: false,
                  grants: [
                    {
                      principalType: 'group',
                      principalId: 'grp-partner-only',
                      level: 'edit',
                    },
                  ],
                },
              },
            ],
          },
        },
      };

      const resolved = resolveMatterFolderTemplate({
        templatesConfig: config,
        workTypeId: 'wt.ops',
      });
      expect(resolved.flatRelativePaths).toEqual([
        'Folder A',
        'Folder C Renamed',
        'Folder C Renamed/Subfolder A1',
      ]);
      expect(resolved.accessOverrideScopeCount).toBe(1);
      expect(resolved.scaleWarnings.length).toBe(1);
      expect(resolved.scaleWarnings[0]).toContain('5,000');
    });

    it('rejects invalid templates: duplicate sibling names, invalid characters, unknown tokens, missing operation paths, and excessive depth', () => {
      const badConfig: MatterFolderTemplatesConfig = {
        default: {
          templateId: 'tpl-bad',
          version: 1,
          mode: 'replaces',
          nodes: [
            { name: 'Valid Folder' },
            { name: 'valid folder' }, // Duplicate sibling (case-insensitive)
            { name: 'Invalid*Char:Folder' }, // Forbidden SharePoint characters
            { name: 'Unknown {nonExistentToken} Folder' }, // Unknown token
          ],
        },
        byWorkType: {
          'wt.bad_op': {
            templateId: 'tpl-bad-op',
            version: 1,
            mode: 'extends',
            operations: [
              {
                op: 'remove',
                path: 'Does Not Exist',
              },
            ],
          },
        },
      };

      const validation = validateMatterFolderTemplatesConfig(badConfig);
      expect(validation.valid).toBe(false);
      const messages = validation.errors.map((e) => e.message).join(' | ');
      expect(messages).toContain('Duplicate sibling');
      expect(messages).toContain('characters forbidden');
      expect(messages).toContain('unknown token');
      expect(messages).toContain('non-existent folder path');
    });

    it('matches routing rules in order, renders tokens, and sanitises forbidden SharePoint characters and path lengths', () => {
      expect(ALLOWED_PATH_TOKENS.has('matterNumber')).toBe(true);
      expect(findUnknownPathTokens('{departmentCode}/{fooToken}')).toEqual([
        'fooToken',
      ]);
      expect(validateRawFolderNameSegment('CON').valid).toBe(false);
      expect(validateRawFolderNameSegment('.leadingdot').valid).toBe(false);
      expect(sanitiseFolderNameSegment('Sale: "Plot 4" <Phase 1>?')).toBe(
        'Sale- -Plot 4- -Phase 1-',
      );

      const stores = makeGenericStores();
      const rules = makeGenericRoutingRules();

      // Dispute matter matches rule 0 ('lib-disputes')
      const litSubject = makeMatterSubject({
        departmentId: 'DEPT-LIT',
        departmentCode: 'LIT',
        teamId: 'TEAM-LIT-A',
        teamCode: 'LITA',
        matterDescription: 'Claim: Alpha / Beta *Urgent*',
      });
      const litRoute = resolveMatterDocumentRoute({
        subject: litSubject,
        stores,
        routingRules: rules,
        matterFolderNameTemplate: '{matterNumber} - {matterDescription}',
      });
      expect(litRoute.libraryId).toBe('lib-disputes');
      expect(litRoute.renderedBasePath).toBe('LIT/LITA');
      expect(litRoute.matterFolderName).toBe(
        'MAT-2026-0001 - Claim- Alpha - Beta -Urgent-',
      );

      // Property matter falls through to default rule ('lib-matters')
      const propRoute = resolveMatterDocumentRoute({
        subject: makeMatterSubject(),
        stores,
        routingRules: rules,
        matterFolderNameTemplate: '{matterNumber} - {matterDescription}',
      });
      expect(propRoute.libraryId).toBe('lib-matters');
      expect(propRoute.matterRelativePath).toBe(
        'PROP/RES/MAT-2026-0001 - Purchase of 10 High Street',
      );
      expect( renderBasePath('{departmentCode}/{teamCode}', makeMatterSubject()).segments ).toEqual(['PROP', 'RES']);
      expect( renderFolderNameTemplate('{clientNumber}_{matterNumber}', makeMatterSubject()) ).toBe('CLI-001_MAT-2026-0001');
    });

    it('compiles permissions for standard, cross-team outsider, restricted, and closed matters', () => {
      const accessConfig = makeGenericAccessConfig();
      const storeId = 'alpha-sp-primary';
      const resolveUser = (userId: string) => ({
        entraObjectId: `oid-${userId}`,
        upn: `${userId}@firm-alpha.example`,
        displayName: `User ${userId}`,
      });

      const deptPerms = compileDepartmentFolderPermissions({
        accessConfig,
        storeId,
        departmentId: 'DEPT-PROP',
      });
      expect(deptPerms.inherit).toBe(false);
      expect(
        deptPerms.grants.some(
          (g) => g.principal.entraObjectId === 'grp-dept-prop' && g.level === 'read',
        ),
      ).toBe(true);

      const teamPerms = compileTeamFolderPermissions({
        accessConfig,
        storeId,
        departmentId: 'DEPT-PROP',
        teamId: 'TEAM-RES',
      });
      expect(teamPerms.inherit).toBe(false);
      expect(
        teamPerms.grants.some(
          (g) => g.principal.entraObjectId === 'grp-team-res' && g.level === 'edit',
        ),
      ).toBe(true);

      // 1. Standard matter -> inherits from team folder (0 unique scopes!)
      const standardPlan = compileMatterFolderPermissions({
        accessConfig,
        storeId,
        subject: makeMatterSubject(),
        resolveUserEntraObjectId: resolveUser,
      });
      expect(standardPlan.inherit).toBe(true);
      expect(standardPlan.reason).toBe('inherited_standard');
      expect(standardPlan.consumesUniqueScope).toBe(false);

      // 2. Cross-team outsider on matter team -> breaks inheritance, keeps dept & team groups, adds outsider
      const outsiderPlan = compileMatterFolderPermissions({
        accessConfig,
        storeId,
        subject: makeMatterSubject({
          matterTeamMemberIds: ['user-1', 'user-2', 'user-outsider-9'],
        }),
        resolveUserEntraObjectId: resolveUser,
      });
      expect(outsiderPlan.inherit).toBe(false);
      expect(outsiderPlan.reason).toBe('matter_team_outsiders');
      expect(outsiderPlan.consumesUniqueScope).toBe(true);
      expect(outsiderPlan.outsiderUserIds).toEqual(['user-outsider-9']);
      expect(
        outsiderPlan.grants.some(
          (g) => g.principal.entraObjectId === 'grp-team-res',
        ),
      ).toBe(true);
      expect(
        outsiderPlan.grants.some(
          (g) =>
            g.principal.entraObjectId === 'oid-user-outsider-9' &&
            g.level === 'edit',
        ),
      ).toBe(true);

      // 3. Restricted matter -> breaks inheritance, REMOVES department and team groups, grants only allowed users + oversight group
      const restrictedPlan = compileMatterFolderPermissions({
        accessConfig,
        storeId,
        subject: makeMatterSubject({
          isRestricted: true,
          restrictedAccessUserIds: ['user-1'],
          matterTeamMemberIds: ['user-1'],
        }),
        resolveUserEntraObjectId: resolveUser,
      });
      expect(restrictedPlan.inherit).toBe(false);
      expect(restrictedPlan.reason).toBe('restricted_matter');
      expect(
        restrictedPlan.grants.some(
          (g) => g.principal.entraObjectId === 'grp-dept-prop',
        ),
      ).toBe(false);
      expect(
        restrictedPlan.grants.some(
          (g) => g.principal.entraObjectId === 'grp-team-res',
        ),
      ).toBe(false);
      expect(
        restrictedPlan.grants.some(
          (g) => g.principal.entraObjectId === 'oid-user-1' && g.level === 'edit',
        ),
      ).toBe(true);
      expect(
        restrictedPlan.grants.some(
          (g) =>
            g.principal.entraObjectId === 'grp-risk-oversight' &&
            g.level === 'read',
        ),
      ).toBe(true);

      // 4. Closed matter -> downgrades write access to 'read'
      const closedPlan = compileMatterFolderPermissions({
        accessConfig,
        storeId,
        subject: makeMatterSubject({ isClosed: true }),
        resolveUserEntraObjectId: resolveUser,
      });
      expect(closedPlan.inherit).toBe(false);
      expect(closedPlan.reason).toBe('closed_matter_readonly');
      const teamGrantOnClosed = closedPlan.grants.find(
        (g) => g.principal.entraObjectId === 'grp-team-res',
      );
      expect(teamGrantOnClosed?.level).toBe('read');
    });

    it('parses SharePoint URLs including encoded spaces, /Forms/AllItems.aspx, ?id= query parameters, subfolders, and rejects invalid URLs', () => {
      // Standard library URL with encoded spaces
      const libParsed = parseSharePointLocationUrl(
        'https://contoso.sharepoint.com/sites/PracticeDMS/Matter%20Repository',
      );
      expect(libParsed.valid).toBe(true);
      expect(libParsed.hostname).toBe('contoso.sharepoint.com');
      expect(libParsed.siteRelativePath).toBe('/sites/PracticeDMS');
      expect(libParsed.libraryUrlSegment).toBe('Matter Repository');
      expect(libParsed.folderRelativePath).toBe('');

      // View URL with /Forms/AllItems.aspx and ?id= deep folder path
      const viewParsed = parseSharePointLocationUrl(
        'https://contoso.sharepoint.com/sites/PracticeDMS/Matter%20Repository/Forms/AllItems.aspx?id=%2Fsites%2FPracticeDMS%2FMatter%20Repository%2FPROP%2FRES%2FMAT-2026-0001&viewid=1234',
      );
      expect(viewParsed.valid).toBe(true);
      expect(viewParsed.libraryUrlSegment).toBe('Matter Repository');
      expect(viewParsed.folderRelativePath).toBe('PROP/RES/MAT-2026-0001');

      // Direct subfolder path
      const subParsed = parseSharePointLocationUrl(
        'https://contoso.sharepoint.com/sites/PracticeDMS/Matter%20Repository/PROP/RES',
      );
      expect(subParsed.valid).toBe(true);
      expect(subParsed.folderRelativePath).toBe('PROP/RES');

      // Invalid URLs
      expect(parseSharePointLocationUrl('http://contoso.sharepoint.com/sites/A/B').valid).toBe(false);
      expect(parseSharePointLocationUrl('https://contoso.sharepoint.com/sites/OnlySite').valid).toBe(false);
      expect(parseSharePointLocationUrl('not-a-url').valid).toBe(false);
    });

    it('maps roles in one place, normalises errors, and warns on library scope scale limits', () => {
      expect(SHAREPOINT_ROLE_MAPPING.read.sharePointRoleDefinitionName).toBe('Read');
      expect(SHAREPOINT_ROLE_MAPPING.contribute.sharePointRoleDefinitionName).toBe('Contribute');
      expect(SHAREPOINT_ROLE_MAPPING.edit.sharePointRoleDefinitionName).toBe('Edit');
      expect(SHAREPOINT_ROLE_MAPPING.manage.sharePointRoleDefinitionName).toBe('Full Control');

      expect(normaliseDocumentStoreError(new Error('HTTP 404 Not Found')).code).toBe('not_found');
      expect(normaliseDocumentStoreError(new Error('HTTP 403 Access Denied')).code).toBe('access_denied');
      expect(normaliseDocumentStoreError(new Error('HTTP 409 Conflict')).code).toBe('conflict');
      expect(normaliseDocumentStoreError(new Error('HTTP 429 Throttled')).code).toBe('throttled');
      expect(normaliseDocumentStoreError(new Error('AADSTS50076 interaction_required')).code).toBe(
        'reauthentication_required',
      );

      const scaleStatus = evaluateLibraryScopeScaleStatus({
        storeId: 'alpha-sp-primary',
        libraryId: 'lib-matters',
        warningThreshold: 4000,
        departmentScopes: 10,
        teamScopes: 30,
        matterExceptionScopes: 4100,
        templateOverrideScopes: 0,
      });
      expect(scaleStatus.exceedsWarningThreshold).toBe(true);
      expect(scaleStatus.warningMessage).toContain('4140');
    });
  });

  // ============================================================================
  // 2. Contract Tests: DocumentStoreProvider against SharePointProvider
  // ============================================================================
  describe('2. Contract Tests: SharePointDocumentStoreProvider', () => {
    it('implements all user-context and provisioning-context operations, chunked uploads, conflict modes, paging, and 429 retry', async () => {
      const ctx = makeTenantContext({ tenantId: 'firm-alpha' });
      const stores = makeGenericStores('alpha');
      const registry = new DocumentStoreProviderRegistry();
      const provider = registry.createProvider(ctx, stores[0]!);

      const provCtx: ProvisioningAccessContext = {
        kind: 'provisioning',
        tenantContext: ctx,
        triggeredByUserId: ctx.actorId,
        triggerEvent: 'contract.test',
      };
      const userCtx: UserAccessContext = {
        kind: 'user',
        tenantContext: ctx,
        actorUserId: ctx.actorId,
        entraObjectId: ctx.entraObjectId!,
        userUpn: ctx.actorUpn,
        userAssertionToken: 'valid-user-jwt',
      };

      // 1. testConnection
      const conn = await provider.testConnection(provCtx);
      expect(conn.ok).toBe(true);
      expect(conn.checks.permissionManagementSupported).toBe(true);

      // 2. ensureFolderTree & resolveLocation
      const containerRef = {
        storeId: 'alpha-sp-primary',
        libraryId: 'lib-matters',
        siteId: 'site-alpha-001',
        driveId: 'drive-alpha-matters',
        folderItemId: 'root',
      };
      const ensured = await provider.ensureFolderTree(provCtx, containerRef, [
        {
          name: 'PROP',
          relativePath: 'PROP',
          children: [
            {
              name: 'RES',
              relativePath: 'PROP/RES',
            },
          ],
        },
      ]);
      expect(ensured.folderItemMap['PROP/RES']).toBeDefined();

      const resolvedLoc = await provider.resolveLocation(provCtx, {
        storeId: 'alpha-sp-primary',
        rawUrlOrPath:
          'https://alpha.sharepoint.com/sites/PracticeDMS/Matter%20Repository/PROP/RES',
      });
      expect(resolvedLoc.resolved).toBe(true);
      expect(resolvedLoc.folderItemId).toBe(ensured.folderItemMap['PROP/RES']);

      // 3. setPermissions & getPermissions
      const resFolderId = ensured.folderItemMap['PROP/RES']!;
      await provider.setPermissions(
        provCtx,
        {
          storeId: 'alpha-sp-primary',
          siteId: 'site-alpha-001',
          driveId: 'drive-alpha-matters',
          itemId: resFolderId,
        },
        [
          {
            principal: {
              principalType: 'group',
              entraObjectId: 'grp-team-res',
              displayName: 'Residential Team',
            },
            level: 'edit',
          },
        ],
        { inherit: false },
      );

      const perms = await provider.getPermissions(provCtx, {
        storeId: 'alpha-sp-primary',
        siteId: 'site-alpha-001',
        driveId: 'drive-alpha-matters',
        itemId: resFolderId,
      });
      expect(perms.inheritsFromParent).toBe(false);
      expect(perms.grants).toHaveLength(1);

      // 4. getEffectiveAccess for user in 'grp-team-res'
      const effAccess = await provider.getEffectiveAccess(userCtx, {
        storeId: 'alpha-sp-primary',
        siteId: 'site-alpha-001',
        driveId: 'drive-alpha-matters',
        itemId: resFolderId,
      });
      expect(effAccess.level).toBe('edit');
      expect(effAccess.canUpload).toBe(true);
      expect(effAccess.canDelete).toBe(true);

      // 5. Small file upload, conflict modes ('fail', 'rename', 'replace'), and large file chunked upload (>= 4 MiB)
      const resContainer = {
        ...containerRef,
        folderItemId: resFolderId,
      };
      const smallBytes = new TextEncoder().encode('Contract Draft v1');
      const uploaded1 = await provider.uploadContent(
        userCtx,
        resContainer,
        'Contract.docx',
        smallBytes,
        smallBytes.byteLength,
        { conflictBehavior: 'fail', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      );
      expect(uploaded1.name).toBe('Contract.docx');

      // Conflict 'fail' throws 'conflict'
      await expect(
        provider.uploadContent(
          userCtx,
          resContainer,
          'Contract.docx',
          smallBytes,
          smallBytes.byteLength,
          { conflictBehavior: 'fail' },
        ),
      ).rejects.toMatchObject({ code: 'conflict' });

      // Conflict 'rename' creates 'Contract (1).docx'
      const uploadedRenamed = await provider.uploadContent(
        userCtx,
        resContainer,
        'Contract.docx',
        smallBytes,
        smallBytes.byteLength,
        { conflictBehavior: 'rename' },
      );
      expect(uploadedRenamed.name).toBe('Contract (1).docx');

      // Conflict 'replace' increments version
      const replacedBytes = new TextEncoder().encode('Contract Draft v2 Updated');
      const uploadedReplaced = await provider.uploadContent(
        userCtx,
        resContainer,
        'Contract.docx',
        replacedBytes,
        replacedBytes.byteLength,
        { conflictBehavior: 'replace' },
      );
      expect(uploadedReplaced.versionLabel).toBe('2.0');

      // Large file upload (>= 4 MiB) uses createUploadSession + uploadChunk
      const largeBytes = new Uint8Array(GRAPH_RESUMABLE_UPLOAD_THRESHOLD_BYTES + 1024);
      largeBytes.fill(65);
      const uploadedLarge = await provider.uploadContent(
        userCtx,
        resContainer,
        'Bundle.pdf',
        largeBytes,
        largeBytes.byteLength,
      );
      expect(uploadedLarge.sizeBytes).toBe(largeBytes.byteLength);
      const operationsCalled = registry
        .getMockBackend()
        .getCallLog()
        .map((c) => c.operation);
      expect(operationsCalled).toContain('createUploadSession');
      expect(operationsCalled).toContain('uploadChunk');

      // 6. downloadContent, getWebUrl, createFolder, renameItem, moveItem, listItems with paging, deleteItem
      const downloaded = await provider.downloadContent(userCtx, {
        storeId: 'alpha-sp-primary',
        siteId: 'site-alpha-001',
        driveId: 'drive-alpha-matters',
        itemId: uploaded1.itemId,
      });
      const reader = downloaded.stream.getReader();
      const { value: dlChunk } = await reader.read();
      expect(new TextDecoder().decode(dlChunk)).toBe('Contract Draft v2 Updated');

      const webUrlRes = await provider.getWebUrl(userCtx, {
        storeId: 'alpha-sp-primary',
        siteId: 'site-alpha-001',
        driveId: 'drive-alpha-matters',
        itemId: uploaded1.itemId,
      });
      expect(webUrlRes.openInAppUrl).toContain('ms-word:ofe|u|');

      const subFolder = await provider.createFolder(
        userCtx,
        resContainer,
        '01 Subfolder',
      );
      const renamedSub = await provider.renameItem(
        userCtx,
        {
          storeId: 'alpha-sp-primary',
          siteId: 'site-alpha-001',
          driveId: 'drive-alpha-matters',
          itemId: subFolder.itemId,
        },
        '01 Enquiries',
      );
      expect(renamedSub.name).toBe('01 Enquiries');

      // Move 'Contract (1).docx' into '01 Enquiries'
      const movedFile = await provider.moveItem(
        userCtx,
        {
          storeId: 'alpha-sp-primary',
          siteId: 'site-alpha-001',
          driveId: 'drive-alpha-matters',
          itemId: uploadedRenamed.itemId,
        },
        {
          ...resContainer,
          folderItemId: renamedSub.itemId,
        },
      );
      expect(movedFile.parentItemId).toBe(renamedSub.itemId);

      // Paging test on listItems
      const page1 = await provider.listItems(resContainer !== undefined ? userCtx : userCtx, resContainer, {
        pageSize: 2,
      });
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toBe('2');
      const page2 = await provider.listItems(userCtx, resContainer, {
        pageSize: 2,
        cursor: page1.nextCursor!,
      });
      expect(page2.items.length).toBeGreaterThanOrEqual(1);

      // 7. HTTP 429 throttling retry test
      registry.getMockBackend().simulateThrottling(2, 5);
      const itemAfterThrottle = await provider.getItem(userCtx, {
        storeId: 'alpha-sp-primary',
        siteId: 'site-alpha-001',
        driveId: 'drive-alpha-matters',
        itemId: uploaded1.itemId,
      });
      expect(itemAfterThrottle.itemId).toBe(uploaded1.itemId);

      // Delete file
      await provider.deleteItem(userCtx, {
        storeId: 'alpha-sp-primary',
        siteId: 'site-alpha-001',
        driveId: 'drive-alpha-matters',
        itemId: movedFile.itemId,
      });
    });

    it('rejects reserved Phase 2 providers (azure_blob, imanage, netdocuments) with a clear "not yet supported" message', () => {
      const ctx = makeTenantContext({ tenantId: 'firm-alpha' });
      const registry = new DocumentStoreProviderRegistry();
      const baseStore = makeGenericStores('alpha')[0]!;

      for (const reserved of ['azure_blob', 'imanage', 'netdocuments'] as const) {
        expect(() =>
          registry.createProvider(ctx, {
            ...baseStore,
            providerType: reserved,
          }),
        ).toThrow(/not yet supported/i);
      }
    });
  });

  // ============================================================================
  // 3. Security Tests: Dual-Identity Separation, Store Denial Finding, Token Cache
  // ============================================================================
  describe('3. Security Tests: Dual-Identity Enforcement, Access Gating & Encrypted Token Cache', () => {
    it('ensures user-facing operations NEVER use the provisioning identity and blocks users without 1Squared matter access before any Graph call', async () => {
      const ctx = makeTenantContext({ tenantId: 'firm-alpha' });
      const stores = makeGenericStores('alpha');
      const registry = new DocumentStoreProviderRegistry();
      const provider = registry.createProvider(ctx, stores[0]!);
      const repo = new TenantDocumentStoreRepository();

      // Passing a ProvisioningAccessContext to a user-only provider method is rejected immediately
      const provCtx: ProvisioningAccessContext = {
        kind: 'provisioning',
        tenantContext: ctx,
        triggerEvent: 'illegal.attempt',
      };
      await expect(
        provider.downloadContent(provCtx as unknown as UserAccessContext, {
          storeId: 'alpha-sp-primary',
          siteId: 'site-alpha-001',
          driveId: 'drive-alpha-matters',
          itemId: 'root',
        }),
      ).rejects.toMatchObject({ code: 'access_denied' });

      // User without 1Squared matter access is blocked BEFORE any Graph call is made
      registry.getMockBackend().clearCallLog();
      await expect(
        executeUserMatterDocumentOperation(
          {
            ctx,
            requiredPermission: 'document:view',
            grantedPermissions: ['document:view'],
            matterId: 'M-1001',
            canAccessMatterIn1Squared: false,
            storeId: 'alpha-sp-primary',
            libraryId: 'lib-matters',
            location: {
              id: 'loc-m1001',
              tenantId: 'firm-alpha',
              matterId: 'M-1001',
              storeId: 'alpha-sp-primary',
              libraryId: 'lib-matters',
              providerSiteId: 'site-alpha-001',
              providerDriveId: 'drive-alpha-matters',
              providerFolderItemId: 'root',
              relativePath: 'PROP/RES/NALF-2026-1001',
              webUrl: 'https://contoso.sharepoint.com',
              provisioningStatus: 'provisioned',
              linkMode: 'provisioned',
              routingMismatchNote: null,
              hasUniquePermissions: false,
              uniqueScopeCount: 0,
              intendedGrants: [],
              folderItemMap: {},
              templateId: 'default',
              templateVersion: 1,
              lastJobId: null,
              lastErrorCode: null,
              lastErrorMessage: null,
              provisionedAt: '2026-11-01T00:00:00Z',
              updatedAt: '2026-11-01T00:00:00Z',
            } satisfies MatterDocumentLocationRecord,
            verifyItemInMatterTree: async () => true,
            auditAction: 'document:listed',
            repository: repo,
          },
          async (userCtx) =>
            provider.listItems(userCtx, {
              storeId: 'alpha-sp-primary',
              libraryId: 'lib-matters',
              siteId: 'site-alpha-001',
              driveId: 'drive-alpha-matters',
              folderItemId: 'root',
            }),
        ),
      ).rejects.toMatchObject({ code: 'access_denied' });

      expect(registry.getMockBackend().getCallLog()).toHaveLength(0);
    });

    it('records a reconciliation finding when 1Squared allows an action on a matter but SharePoint denies the user', async () => {
      // User belongs to 'grp-other-team', which has no SharePoint grant on the 'TEAM-RES' matter
      const ctx = makeTenantContext({
        tenantId: 'firm-alpha',
        actorId: 'user-mismatch',
        actorGroups: ['grp-other-team'],
        entraObjectId: 'oid-user-mismatch',
      });
      const stores = makeGenericStores('alpha');
      const registry = new DocumentStoreProviderRegistry();
      const repo = new TenantDocumentStoreRepository();

      const deps = {
        repository: repo,
        getProvider: (storeId: string) => {
          const st = stores.find((s) => s.storeId === storeId)!;
          return registry.createProvider(ctx, st);
        },
        stores,
        routingRules: makeGenericRoutingRules('alpha'),
        accessConfig: makeGenericAccessConfig(),
        templatesConfig: makeGenericTemplatesConfig(),
        matterFolderNameTemplate: '{matterNumber} - {matterDescription}',
        resolveUserEntraObjectId: (_c: TenantContext, uid: string) => ({
          entraObjectId: `oid-${uid}`,
        }),
      };

      const { location } = await provisionMatterDocumentsJob({
        ctx,
        deps,
        subject: makeMatterSubject(),
      });

      const provider = deps.getProvider(location.storeId);

      // 1Squared allows access (canAccessMatterIn1Squared: true), but SharePoint denies 'oid-user-mismatch'
      await expect(
        executeUserMatterDocumentOperation(
          {
            ctx,
            requiredPermission: 'document:view',
            grantedPermissions: ['document:view'],
            matterId: 'M-1001',
            canAccessMatterIn1Squared: true,
            storeId: location.storeId,
            libraryId: location.libraryId,
            providerItemId: location.providerFolderItemId,
            location,
            verifyItemInMatterTree: async () => true,
            auditAction: 'document:listed',
            repository: repo,
          },
          async (userCtx) =>
            provider.listItems(userCtx, {
              storeId: location.storeId,
              libraryId: location.libraryId,
              siteId: location.providerSiteId,
              driveId: location.providerDriveId,
              folderItemId: location.providerFolderItemId,
            }),
        ),
      ).rejects.toMatchObject({ code: 'access_denied' });

      // Verify all user-context Graph calls used 'user' identity and OBO token
      const userCalls = registry
        .getMockBackend()
        .getCallLog()
        .filter((c) => c.operation === 'listItems');
      expect(userCalls).toHaveLength(1);
      expect(userCalls[0]!.identityKind).toBe('user');
      expect(userCalls[0]!.accessTokenPrefix).toContain('obo_tok_');

      // Verify a permission_mismatch_store_denied reconciliation finding was automatically created
      const findings = repo.listReconciliationFindings(ctx);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.findingType).toBe('permission_mismatch_store_denied');
      expect(findings[0]!.matterId).toBe('M-1001');
    });

    it('isolates encrypted OBO token cache by tenant and user and surfaces Conditional Access claims challenges', async () => {
      const cache = new TenantScopedEncryptedTokenCache();
      const tokenService = new DocumentStoreTokenService({ cache });
      const ctxTenantAUser1 = makeTenantContext({
        tenantId: 'firm-alpha',
        actorId: 'u1',
        entraObjectId: 'oid-u1',
      });
      const ctxTenantAUser2 = makeTenantContext({
        tenantId: 'firm-alpha',
        actorId: 'u2',
        entraObjectId: 'oid-u2',
      });
      const ctxTenantBUser1 = makeTenantContext({
        tenantId: 'firm-beta',
        actorId: 'u1',
        entraObjectId: 'oid-u1',
      });

      const keyA1 = cache.putUserToken({
        ctx: ctxTenantAUser1,
        entraObjectId: 'oid-u1',
        storeId: 'store-1',
        scope: 'Files.ReadWrite.All',
        accessToken: 'secret-obo-token-alpha-u1',
        expiresInSeconds: 3600,
      });

      // Encrypted at rest in memory/persistence (raw token never appears in ciphertextHex)
      const rawEntry = cache.inspectEncryptedEntry(keyA1);
      expect(rawEntry).not.toBeNull();
      expect(rawEntry!.ciphertextHex).not.toContain('secret-obo-token');

      // User 1 in Tenant A retrieves their own token
      expect(
        cache.getUserToken({
          ctx: ctxTenantAUser1,
          entraObjectId: 'oid-u1',
          storeId: 'store-1',
          scope: 'Files.ReadWrite.All',
        }),
      ).toBe('secret-obo-token-alpha-u1');

      // User 2 in Tenant A gets null (isolated per user)
      expect(
        cache.getUserToken({
          ctx: ctxTenantAUser2,
          entraObjectId: 'oid-u2',
          storeId: 'store-1',
          scope: 'Files.ReadWrite.All',
        }),
      ).toBeNull();

      // User 1 in Tenant B gets null (isolated per tenant)
      expect(
        cache.getUserToken({
          ctx: ctxTenantBUser1,
          entraObjectId: 'oid-u1',
          storeId: 'store-1',
          scope: 'Files.ReadWrite.All',
        }),
      ).toBeNull();

      // Conditional Access MFA claims challenge returns 'reauthentication_required'
      await expect(
        tokenService.acquireDelegatedUserToken({
          accessContext: {
            kind: 'user',
            tenantContext: ctxTenantAUser2,
            actorUserId: 'u2',
            entraObjectId: 'oid-u2',
            userAssertionToken: 'jwt_with_claims_challenge_required',
          },
          storeId: 'store-1',
          authConfig: makeGenericStores('alpha')[0]!.auth,
        }),
      ).rejects.toMatchObject({
        code: 'reauthentication_required',
      });
    });

    it('redacts any file names, folder names, paths, URLs, or tokens from audit events', () => {
      const ctx = makeTenantContext({ tenantId: 'firm-alpha' });
      const audit = buildDocumentStoreAuditEvent({
        context: ctx,
        identityUsed: 'user',
        triggerEvent: 'test.redaction',
        action: 'document:uploaded',
        matterId: 'M-1001',
        storeId: 'alpha-sp-primary',
        libraryId: 'lib-matters',
        providerItemId: 'sp-item-123',
        outcome: 'succeeded',
        metadata: {
          fileName: 'Secret Acquisition Bid.docx',
          folderName: '01 Confidential',
          relativePath: 'CORP/MA/Secret Acquisition Bid.docx',
          accessToken: 'Bearer eyJ...',
          sizeBytes: 4096,
        },
      });

      expect(audit.metadata).toEqual({ sizeBytes: 4096 });
      expect(JSON.stringify(audit)).not.toContain('Secret Acquisition Bid');
      expect(JSON.stringify(audit)).not.toContain('eyJ');
    });
  });

  // ============================================================================
  // 4. Two-Tenant Isolation Tests (Section 8 & Section 11)
  // ============================================================================
  describe('4. Two-Tenant Isolation Tests', () => {
    it('prevents Tenant A from reading, listing, uploading to, or provisioning into Tenant B store or repository, including tampered IDs and forged tenant claims', async () => {
      // 1. Forged tenant claim on request is rejected immediately
      expect(() =>
        resolveTenantFromVerifiedToken({
          verifiedToken: {
            __verifiedByOidcMiddleware: true,
            sub: 'attacker-1',
            tenantId: 'firm-alpha',
            name: 'Attacker',
            email: 'attacker@firm-alpha.example',
            roles: ['admin'],
            mfaVerified: false,
          },
          hostingMode: 'multi_tenant',
          environment: 'test',
          correlationId: 'corr-forged',
          untrustedRequestTenantOverride: 'firm-beta',
        }),
      ).toThrow(/TENANCY_FORGERY_DETECTED/);

      const ctxA = makeTenantContext({
        tenantId: 'firm-alpha',
        actorId: 'user-a',
        entraObjectId: 'oid-a',
      });
      const ctxB = makeTenantContext({
        tenantId: 'firm-beta',
        actorId: 'user-b',
        entraObjectId: 'oid-b',
      });

      const sharedRepo = new TenantDocumentStoreRepository();
      const sharedRegistry = new DocumentStoreProviderRegistry();
      const storesA = makeGenericStores('alpha');
      const storesB = makeGenericStores('beta');

      const depsB = {
        repository: sharedRepo,
        getProvider: (storeId: string) => {
          const st = storesB.find((s) => s.storeId === storeId)!;
          return sharedRegistry.createProvider(ctxB, st);
        },
        stores: storesB,
        routingRules: makeGenericRoutingRules('beta'),
        accessConfig: makeGenericAccessConfig(),
        templatesConfig: makeGenericTemplatesConfig(),
        matterFolderNameTemplate: '{matterNumber} - {matterDescription}',
        resolveUserEntraObjectId: (_c: TenantContext, uid: string) => ({
          entraObjectId: `oid-${uid}`,
        }),
      };

      // Provision a matter in Tenant B
      const { location: locB } = await provisionMatterDocumentsJob({
        ctx: ctxB,
        deps: depsB,
        subject: makeMatterSubject({ matterId: 'M-BETA-999' }),
      });

      // 2. Tenant A cannot read Tenant B's location record by tampered location ID or matter ID
      expect(sharedRepo.getMatterLocationById(ctxA, locB.id)).toBeNull();
      expect(
        sharedRepo.listMatterLocationsByMatterId(ctxA, 'M-BETA-999'),
      ).toHaveLength(0);

      // 3. Tenant A cannot write a record claiming Tenant B's tenantId
      expect(() =>
        sharedRepo.putMatterLocation(ctxA, locB),
      ).toThrow(/TENANCY_ISOLATION_ERROR/);

      // 4. Tenant A provider cannot list, read, upload to, or setPermissions on Tenant B's driveId or folderItemId
      const providerA = sharedRegistry.createProvider(ctxA, storesA[0]!);
      const userCtxA: UserAccessContext = {
        kind: 'user',
        tenantContext: ctxA,
        actorUserId: ctxA.actorId,
        entraObjectId: 'oid-a',
        userAssertionToken: 'token-a',
      };
      const provCtxA: ProvisioningAccessContext = {
        kind: 'provisioning',
        tenantContext: ctxA,
        triggerEvent: 'cross-tenant-test',
      };

      await expect(
        providerA.listItems(userCtxA, {
          storeId: locB.storeId,
          libraryId: locB.libraryId,
          siteId: locB.providerSiteId,
          driveId: locB.providerDriveId,
          folderItemId: locB.providerFolderItemId,
        }),
      ).rejects.toMatchObject({ code: 'access_denied' });

      await expect(
        providerA.getItem(userCtxA, {
          storeId: locB.storeId,
          siteId: locB.providerSiteId,
          driveId: locB.providerDriveId,
          itemId: locB.providerFolderItemId,
        }),
      ).rejects.toMatchObject({ code: 'access_denied' });

      await expect(
        providerA.uploadContent(
          userCtxA,
          {
            storeId: locB.storeId,
            libraryId: locB.libraryId,
            siteId: locB.providerSiteId,
            driveId: locB.providerDriveId,
            folderItemId: locB.providerFolderItemId,
          },
          'tampered.txt',
          new Uint8Array([1, 2, 3]),
          3,
        ),
      ).rejects.toMatchObject({ code: 'access_denied' });

      await expect(
        providerA.setPermissions(
          provCtxA,
          {
            storeId: locB.storeId,
            siteId: locB.providerSiteId,
            driveId: locB.providerDriveId,
            itemId: locB.providerFolderItemId,
          },
          [],
          { inherit: true },
        ),
      ).rejects.toMatchObject({ code: 'access_denied' });
    });
  });

  // ============================================================================
  // 5. Lifecycle & Reconciliation Tests (Sections 6 & 7)
  // ============================================================================
  describe('5. Lifecycle & Reconciliation Tests', () => {
    it('handles idempotent provisioning retry, partial failure recovery, team/restriction/department changes, closure/reopening, additive template updates, and drift reconciliation', async () => {
      const ctx = makeTenantContext({ tenantId: 'firm-alpha' });
      const stores = makeGenericStores('alpha');
      const registry = new DocumentStoreProviderRegistry();
      const repo = new TenantDocumentStoreRepository();
      const templatesConfig = makeGenericTemplatesConfig();

      const deps = {
        repository: repo,
        getProvider: (storeId: string) => {
          const st = stores.find((s) => s.storeId === storeId)!;
          return registry.createProvider(ctx, st);
        },
        stores,
        routingRules: makeGenericRoutingRules('alpha'),
        accessConfig: makeGenericAccessConfig(),
        templatesConfig,
        matterFolderNameTemplate: '{matterNumber} - {matterDescription}',
        resolveUserEntraObjectId: (_c: TenantContext, uid: string) => ({
          entraObjectId: `oid-${uid}`,
          upn: `${uid}@firm-alpha.example`,
          displayName: `Person ${uid}`,
        }),
      };

      const subject = makeMatterSubject();

      // 1. Simulate failure on first provisioning attempt -> status is 'failed', matter still has pending/failed location record
      registry
        .getMockBackend()
        .setSimulateMissingSiteGrant('alpha-sp-primary', true);
      const failedAttempt = await provisionMatterDocumentsJob({
        ctx,
        deps,
        subject,
      });
      expect(failedAttempt.job.status).toBe('failed');
      expect(failedAttempt.location.provisioningStatus).toBe('failed');

      // 2. Recover from failure and retry idempotently -> succeeds without duplicating folders
      registry
        .getMockBackend()
        .setSimulateMissingSiteGrant('alpha-sp-primary', false);
      const retryAttempt = await provisionMatterDocumentsJob({
        ctx,
        deps,
        subject,
        existingJobId: failedAttempt.job.id,
      });
      expect(retryAttempt.job.status).toBe('succeeded');
      expect(retryAttempt.job.attemptCount).toBe(2);
      expect(retryAttempt.location.provisioningStatus).toBe('provisioned');
      expect(retryAttempt.location.hasUniquePermissions).toBe(false);

      // Re-running a third time is idempotent and returns identical folderItemIds
      const secondRun = await provisionMatterDocumentsJob({
        ctx,
        deps,
        subject,
      });
      expect(secondRun.location.providerFolderItemId).toBe(
        retryAttempt.location.providerFolderItemId,
      );
      expect(secondRun.location.folderItemMap).toEqual(
        retryAttempt.location.folderItemMap,
      );

      // 3. Team change / restriction change: make matter restricted -> breaks inheritance & removes group grants
      const restrictedSubject = makeMatterSubject({
        isRestricted: true,
        restrictedAccessUserIds: ['user-1'],
        matterTeamMemberIds: ['user-1'],
      });
      const recalcRestricted = await recalculateMatterPermissionsJob({
        ctx,
        deps,
        subject: restrictedSubject,
      });
      expect(recalcRestricted.locations[0]!.hasUniquePermissions).toBe(true);

      // Lift restriction -> restores inheritance (hasUniquePermissions === false)!
      const recalcRestored = await recalculateMatterPermissionsJob({
        ctx,
        deps,
        subject,
      });
      expect(recalcRestored.locations[0]!.hasUniquePermissions).toBe(false);

      // 4. Department/team change with 'move_folder' moves folder to new path
      const movedSubject = makeMatterSubject({
        teamId: 'TEAM-COMM',
        teamCode: 'COMM',
      });
      const movedRes = await recalculateMatterPermissionsJob({
        ctx,
        deps,
        subject: movedSubject,
        departmentChangeStrategy: 'move_folder',
      });
      expect(movedRes.locations[0]!.relativePath).toContain('PROP/COMM/');

      // 5. Close matter -> sets read-only; Reopen matter -> restores inheritance
      const closedRes = await closeMatterFolderJob({
        ctx,
        deps: {
          ...deps,
          onBeforeMatterDocumentsClose: () => ({
            retentionLabelId: 'ret-label-7yr',
          }),
        },
        subject: movedSubject,
      });
      expect(closedRes.locations[0]!.hasUniquePermissions).toBe(true);
      expect(closedRes.locations[0]!.retentionLabelId).toBe('ret-label-7yr');

      const reopenedRes = await reopenMatterFolderJob({
        ctx,
        deps,
        subject: movedSubject,
      });
      expect(reopenedRes.locations[0]!.hasUniquePermissions).toBe(false);

      // 6. Apply template additions to open matters (adds new folder without deleting/renaming existing)
      templatesConfig.byWorkType!['wt.residential_conveyancing'] = {
        templateId: 'tpl-wt-conveyancing',
        version: 3,
        mode: 'extends',
        operations: [
          ...(templatesConfig.byWorkType!['wt.residential_conveyancing']!
            .operations ?? []),
          {
            op: 'add',
            parentPath: '/',
            node: { name: '06 Post-Completion Archive' },
          },
        ],
      };

      const diffPreview = computeAdditiveTemplateDiff(
        resolveMatterFolderTemplate({
          templatesConfig,
          departmentId: movedSubject.departmentId,
          workTypeId: movedSubject.workTypeId,
        }),
        reopenedRes.locations[0]!.folderItemMap,
      );
      expect(diffPreview.missingRelativePaths).toEqual([
        '06 Post-Completion Archive',
      ]);

      const additionsRes = await applyTemplateAdditionsToOpenMattersJob({
        ctx,
        deps,
        openMatterSubjects: [movedSubject],
      });
      expect(additionsRes.addedFoldersByMatterId['M-1001']).toEqual([
        '06 Post-Completion Archive',
      ]);
      expect(
        additionsRes.updatedLocations[0]!.folderItemMap[
          '06 Post-Completion Archive'
        ],
      ).toBeDefined();

      // 7. Link existing folder job
      const linkedSubject = makeMatterSubject({
        matterId: 'M-1002',
        matterNumber: 'MAT-2026-0002',
      });
      await deps.getProvider('alpha-sp-primary').ensureFolderTree(
        {
          kind: 'provisioning',
          tenantContext: ctx,
          triggerEvent: 'test.seed_existing_folder',
        },
        {
          storeId: 'alpha-sp-primary',
          libraryId: 'lib-matters',
          siteId: 'site-alpha-001',
          driveId: 'drive-alpha-matters',
          folderItemId: 'root',
        },
        [
          {
            name: 'PROP',
            relativePath: 'PROP',
            children: [
              {
                name: 'RES',
                relativePath: 'PROP/RES',
                children: [
                  {
                    name: 'MAT-2026-0002 - Legacy Folder',
                    relativePath: 'PROP/RES/MAT-2026-0002 - Legacy Folder',
                  },
                ],
              },
            ],
          },
        ],
      );
      const linkedRes = await linkExistingMatterFolderJob({
        ctx,
        deps,
        subject: linkedSubject,
        storeId: 'alpha-sp-primary',
        libraryId: 'lib-matters',
        folderUrlOrPath:
          'https://alpha.sharepoint.com/sites/PracticeDMS/Matter%20Repository/PROP/RES/MAT-2026-0002%20-%20Legacy%20Folder',
      });
      expect(linkedRes.location.linkMode).toBe('linked_existing');

      // 8. Permission drift detection & remediation
      // Inject an unexpected sharing link onto the matter folder in SharePoint
      registry.getMockBackend().injectSharingLinkForTesting({
        tenantId: ctx.tenantId,
        siteId: 'site-alpha-001',
        driveId: 'drive-alpha-matters',
        itemId: reopenedRes.locations[0]!.providerFolderItemId,
        link: {
          linkId: 'lnk-rogue-1',
          scope: 'anonymous',
          type: 'view',
          webUrl: 'https://alpha.sharepoint.com/:b:/g/rogue',
        },
      });

      const reconScan = await reconcileDocumentStorePermissionsJob({
        ctx,
        deps: {
          repository: repo,
          getProvider: deps.getProvider,
          stores,
          autoRemediate: false,
        },
      });
      const sharingFinding = reconScan.findings.find(
        (f) => f.findingType === 'unexpected_sharing_link',
      );
      expect(sharingFinding).toBeDefined();
      expect(sharingFinding!.status).toBe('open');

      const remediated = await remediateReconciliationFinding({
        ctx,
        deps: {
          repository: repo,
          getProvider: deps.getProvider,
          stores,
        },
        findingId: sharingFinding!.id,
      });
      expect(remediated.status).toBe('remediated');
    });

    it('verifies reversible migration 0002 up, rollback, and re-apply', () => {
      const ctx = makeTenantContext({ tenantId: 'firm-alpha' });
      const runner = new TenantMigrationRunner();
      runner.applyUp(ctx);
      expect(runner.getActiveTables(ctx)).toContain(
        'matter_document_locations',
      );
      expect(runner.getActiveTables(ctx)).toContain(
        'document_reconciliation_findings',
      );

      const rolledBack = runner.rollbackVersion(ctx, '0002');
      expect(rolledBack).toBe(true);
      expect(runner.getActiveTables(ctx)).not.toContain(
        'matter_document_locations',
      );
      expect(runner.getActiveTables(ctx)).toContain('key_dates');
      expect(runner.getActiveTables(ctx)).toContain('key_date_reminder_states');

      runner.applyUp(ctx);
      expect(runner.getActiveTables(ctx)).toContain(
        'matter_document_locations',
      );
    });
  });

  // ============================================================================
  // 6. Demo Tenant Config Validation & Static No-Client-Names-In-Core Check
  // ============================================================================
  describe('6. Client Configuration Validation & Architecture Boundary Check', () => {
    it('validates the demo tenant configuration (Section 13) cleanly against the core schema and org structure', () => {
      const baseJsonPath = path.resolve(
        __dirname,
        '../../client-not-a-law-firm/config/base.json',
      );
      const rawBase = JSON.parse(fs.readFileSync(baseJsonPath, 'utf8'));
      const validated = loadAndValidateTenantConfig(rawBase);

      expect(validated.documentStores).toHaveLength(1);
      expect(validated.documentStores![0]!.isDefault).toBe(true);
      expect(validated.documentRouting).toHaveLength(1);
      expect(
        Object.keys(validated.documentAccess?.departmentEntraGroups ?? {}),
      ).toHaveLength(11);
      expect(
        Object.keys(validated.documentAccess?.teamEntraGroups ?? {}),
      ).toHaveLength(16);

      // Verify Conveyancing and Litigation templates compile cleanly via inheritance
      const conveyancingResolved = resolveMatterFolderTemplate({
        templatesConfig: validated.matterFolderTemplates!,
        workTypeId: 'work_type.real_estate_and_property_residential_conveyancing',
      });
      expect(conveyancingResolved.flatRelativePaths).toContain(
        '01 Client Care',
      );
      expect(conveyancingResolved.flatRelativePaths).toContain(
        '03a Searches and Enquiries',
      );

      const litigationResolved = resolveMatterFolderTemplate({
        templatesConfig: validated.matterFolderTemplates!,
        workTypeId: 'work_type.dispute_resolution_court_pleadings',
      });
      expect(litigationResolved.flatRelativePaths).toContain('03a Pleadings');
      expect(litigationResolved.flatRelativePaths).toContain(
        '03e Settlement and ADR',
      );

      // Verify cross-reference helper against tenant catalog
      const catalogCheck = validateDocumentConfigAgainstTenantData(validated, {
        departmentIds: Object.keys(
          validated.documentAccess!.departmentEntraGroups,
        ),
        teamIds: Object.keys(validated.documentAccess!.teamEntraGroups),
        workTypeIds: Object.keys(
          validated.matterFolderTemplates!.byWorkType ?? {},
        ),
      });
      expect(catalogCheck.valid).toBe(true);
    });

    it('enforces Platform Architecture Standard Section 4: zero client names, client SharePoint URLs, or client library names in core/', () => {
      const baseJsonPath = path.resolve(
        __dirname,
        '../../client-not-a-law-firm/config/base.json',
      );
      const rawClientConfig = JSON.parse(fs.readFileSync(baseJsonPath, 'utf8'));
      const clientDisplayName: string = rawClientConfig.displayName;
      const clientHostname: string =
        rawClientConfig.documentStores[0].sharepoint.hostname;
      const clientSitePath: string =
        rawClientConfig.documentStores[0].sharepoint.siteRelativePath;

      const forbiddenTerms = [
        clientDisplayName,
        clientHostname,
        clientSitePath,
      ];

      function collectCoreFiles(dir: string): string[] {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const files: string[] = [];
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            files.push(...collectCoreFiles(full));
          } else if (
            entry.name.endsWith('.ts') ||
            entry.name.endsWith('.json') ||
            entry.name.endsWith('.md')
          ) {
            files.push(full);
          }
        }
        return files;
      }

      const coreRoot = path.resolve(__dirname, '..');
      const allCoreFiles = collectCoreFiles(coreRoot);
      const violations: string[] = [];

      for (const filePath of allCoreFiles) {
        const content = fs.readFileSync(filePath, 'utf8');
        for (const term of forbiddenTerms) {
          if (content.toLowerCase().includes(term.toLowerCase())) {
            violations.push(
              `${path.relative(coreRoot, filePath)} contains forbidden client-specific term "${term}"`,
            );
          }
        }
      }

      expect(violations).toEqual([]);
    });

    function registerStoreEmployeeSessionsForTest(store: ReturnType<typeof getStore>) {
      const cfg = getActiveTenantConfiguration();
      const sessions = new Map<string, VerifiedEntraSessionPayload>();
      for (const emp of store.people) {
        if (!emp.isEmployee && !emp.employment) continue;
        if (!emp.entraObjectId) {
          emp.entraObjectId = `00000000-0000-4000-8000-${emp.id.replace(/\D/g, '').padStart(12, '0')}`;
        }
        if (
          emp.id === 'P-000010' &&
          emp.employment &&
          !emp.employment.teamOrPracticeGroupId
        ) {
          emp.employment.teamOrPracticeGroupId = 'TPG-RE-COM';
        }
        const workEmail =
          emp.emails?.[0]?.address ??
          `${emp.id.toLowerCase()}@notalawfirm.example`;
        const { departmentId, teamId } = resolvePersonOrgAssignment(emp, store);
        const testGroups: string[] = [];
        const deptGroup = departmentId
          ? cfg.documentAccess?.departmentEntraGroups?.[departmentId]
          : undefined;
        if (deptGroup) testGroups.push(deptGroup);
        const teamGroup = teamId
          ? cfg.documentAccess?.teamEntraGroups?.[teamId]
          : undefined;
        if (teamGroup) testGroups.push(teamGroup);
        const roleSet = new Set<string>(emp.roles ?? []);
        if (emp.appRole === 'admin') roleSet.add('admin');
        for (const [groupId, roleKeys] of Object.entries(
          cfg.rbac?.identityMapping?.entraGroupToRoleKey ?? {},
        )) {
          const keys = Array.isArray(roleKeys) ? roleKeys : [roleKeys];
          if (keys.some((rk) => roleSet.has(rk))) {
            testGroups.push(groupId);
          }
        }
        if (roleSet.has('admin')) {
          for (const rootGrant of cfg.documentAccess?.defaultPolicy?.libraryRoot ?? []) {
            if (rootGrant.level === 'manage') testGroups.push(rootGrant.groupId);
          }
        }
        if (roleSet.has('risk_compliance')) {
          for (const rootGrant of cfg.documentAccess?.defaultPolicy?.libraryRoot ?? []) {
            if (rootGrant.level === 'read') testGroups.push(rootGrant.groupId);
          }
        }
        const verifiedSession = verifySignedEntraSessionCookie(
          createSignedEntraSessionCookie({
            personId: emp.id,
            tenantId: 'not-a-law-firm',
            oid: emp.entraObjectId,
            tid: '11111111-2222-3333-4444-000000000000',
            sub: emp.id,
            email: workEmail,
            displayName: `${emp.firstName} ${emp.surname}`,
            entraRoles: emp.roles ?? [],
            mappedRoles: emp.roles ?? [],
            entraGroups: Array.from(new Set(testGroups)),
            mfaVerified: true,
            amr: ['pwd', 'mfa'],
            authenticatedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          }),
        )!;
        sessions.set(emp.id, verifiedSession);
      }
      function asEmployee<T>(personId: string, fn: () => T): T {
        const verifiedSession = sessions.get(personId);
        if (!verifiedSession) return fn();
        return runWithActiveActorSession(
          {
            personId,
            tenantId: 'not-a-law-firm',
            tokenRoles: verifiedSession.mappedRoles,
            expiresAtMs: Date.parse(verifiedSession.expiresAt),
            verifiedSession,
          },
          fn,
        );
      }
      return { sessions, asEmployee };
    }

    it('enforces R2: all 8 admin document store functions reject non-admin and non-MFA callers with access_denied', async () => {
      const { asEmployee } = registerStoreEmployeeSessionsForTest(getStore());
      try {
        await asEmployee('P-000002', async () => {
          // P-000002 is a fee earner without admin permissions
          expect(() =>
            getDocumentStoresAdminDashboard('P-000002', { mfaVerified: true }),
          ).toThrow(/PERMISSION_DENIED/);
          await expect(
            testAdminDocumentStoreConnection({
              storeId: 'nalf-sharepoint-primary',
              userId: 'P-000002',
              mfaVerified: true,
            }),
          ).rejects.toMatchObject({ code: 'access_denied' });
          await expect(
            resolveAdminSharePointLocationUrl({
              rawUrlOrPath: 'https://contoso.sharepoint.com/sites/Test/Documents',
              userId: 'P-000002',
              mfaVerified: true,
            }),
          ).rejects.toMatchObject({ code: 'access_denied' });
          expect(() =>
            saveAdminDocumentStoreConfiguration({
              section: 'stores',
              userId: 'P-000002',
              mfaVerified: true,
            }),
          ).toThrow(/PERMISSION_DENIED/);
          expect(() =>
            previewAdminMatterFolderTemplate({
              userId: 'P-000002',
              mfaVerified: true,
            }),
          ).toThrow(/PERMISSION_DENIED/);
          await expect(
            applyAdminTemplateAdditionsToOpenMatters('P-000002', {
              mfaVerified: true,
            }),
          ).rejects.toMatchObject({ code: 'access_denied' });
          await expect(
            runAdminDocumentReconciliationScan({
              userId: 'P-000002',
              mfaVerified: true,
            }),
          ).rejects.toMatchObject({ code: 'access_denied' });
          await expect(
            remediateAdminReconciliationFinding({
              findingId: 'finding-1',
              userId: 'P-000002',
              mfaVerified: true,
            }),
          ).rejects.toMatchObject({ code: 'access_denied' });
        });

        await asEmployee('P-000001', async () => {
          // P-000001 (admin) with mfaVerified: false is rejected with access_denied
          expect(() =>
            getDocumentStoresAdminDashboard('P-000001', { mfaVerified: false }),
          ).toThrow(/MFA_REQUIRED/);
          await expect(
            testAdminDocumentStoreConnection({
              storeId: 'nalf-sharepoint-primary',
              userId: 'P-000001',
              mfaVerified: false,
            }),
          ).rejects.toMatchObject({ code: 'access_denied' });
          await expect(
            resolveAdminSharePointLocationUrl({
              rawUrlOrPath: 'https://contoso.sharepoint.com/sites/Test/Documents',
              userId: 'P-000001',
              mfaVerified: false,
            }),
          ).rejects.toMatchObject({ code: 'access_denied' });
          expect(() =>
            saveAdminDocumentStoreConfiguration({
              section: 'stores',
              userId: 'P-000001',
              mfaVerified: false,
            }),
          ).toThrow(/MFA_REQUIRED/);
          expect(() =>
            previewAdminMatterFolderTemplate({
              userId: 'P-000001',
              mfaVerified: false,
            }),
          ).toThrow(/MFA_REQUIRED/);
          await expect(
            applyAdminTemplateAdditionsToOpenMatters('P-000001', {
              mfaVerified: false,
            }),
          ).rejects.toMatchObject({ code: 'access_denied' });
          await expect(
            runAdminDocumentReconciliationScan({
              userId: 'P-000001',
              mfaVerified: false,
            }),
          ).rejects.toMatchObject({ code: 'access_denied' });
          await expect(
            remediateAdminReconciliationFinding({
              findingId: 'finding-1',
              userId: 'P-000001',
              mfaVerified: false,
            }),
          ).rejects.toMatchObject({ code: 'access_denied' });
        });
      } finally {
        resetDocumentStoreSingletonsForTesting();
      }
    });

    it('enforces R3, R4, R5, R8, R9, R12, R13, R14, R19, R21: cross-matter isolation, pre-provisioning RBAC, lifecycle sync on matter update, append-only audit persistence, and per-tenant hydration', async () => {
      const store = getStore();
      const snapshotMatters = structuredClone(store.matters);
      const snapshotPeople = structuredClone(store.people);
      const snapshotNotifications = structuredClone(store.notifications ?? []);
      const snapshotLocations = structuredClone(
        store.matterDocumentLocations ?? [],
      );
      const snapshotScopes = structuredClone(
        store.documentStoreFolderScopes ?? [],
      );
      const snapshotJobs = structuredClone(store.documentLifecycleJobs ?? []);
      const snapshotFindings = structuredClone(
        store.documentReconciliationFindings ?? [],
      );
      const snapshotAudits = structuredClone(
        store.documentStoreAuditEvents ?? [],
      );

      try {
        resetDocumentStoreSingletonsForTesting();
        const { sessions, asEmployee } = registerStoreEmployeeSessionsForTest(store);

        // R19: Unknown userId throws UNAUTHENTICATED rather than falling back to P-000001
        expect(() =>
          buildTenantContextForUser('P-NON-EXISTENT', store),
        ).toThrow(/UNAUTHENTICATED/);

        // R5: Employee excluded from a restricted matter calling browseMatterDocumentStoreFolder gets no locations/jobs and does not trigger provisioning
        const restrictedMatter = store.matters.find((m) => m.id === 'M-000002')!;
        restrictedMatter.isStaffMatter = true;
        restrictedMatter.restrictedAccessUserIds = ['P-000001'];
        restrictedMatter.leadFeeEarnerId = 'P-000001';
        restrictedMatter.supervisingPartnerId = 'P-000001';
        restrictedMatter.responsiblePartnerId = 'P-000001';
        restrictedMatter.teamMemberIds = ['P-000001'];

        // P-000007 is a fee earner in Corporate without matter:restricted:access
        const jobsOnRestrictedBefore = (store.documentLifecycleJobs ?? []).filter(
          (j) => j.matterId === 'M-000002',
        ).length;
        const excludedBrowse = await asEmployee('P-000007', () =>
          browseMatterDocumentStoreFolder({
            matterId: 'M-000002',
            userId: 'P-000007',
          }),
        );
        expect(excludedBrowse.errorCode).toBe('access_denied');
        expect(excludedBrowse.locations).toEqual([]);
        expect(excludedBrowse.activeLocation).toBeNull();
        expect(excludedBrowse.jobs).toEqual([]);
        expect(
          (store.documentLifecycleJobs ?? []).filter(
            (j) => j.matterId === 'M-000002',
          ),
        ).toHaveLength(jobsOnRestrictedBefore);

        // R3: Excluded fee earner cannot retry provisioning on restricted Matter B
        await expect(
          asEmployee('P-000007', () =>
            retryMatterDocumentProvisioning('M-000002', 'P-000007'),
          ),
        ).rejects.toMatchObject({ code: 'access_denied' });

        // Provision Matter A (M-000001, accessible to P-000002, with P-000010 NOT named on the matter) and Matter B (M-000002, restricted to P-000001)
        const matterABeforeProv = store.matters.find((m) => m.id === 'M-000001')!;
        matterABeforeProv.teamMemberIds = ['P-000002'];
        const provA = await asEmployee('P-000002', () =>
          ensureMatterDocumentStoreProvisioned('M-000001', 'P-000002'),
        );
        const locA = provA.locations[0]!;
        const provB = await asEmployee('P-000001', () =>
          ensureMatterDocumentStoreProvisioned('M-000002', 'P-000001'),
        );
        const locB = provB.locations[0]!;

        // R3: Fee earner on Matter A cannot link Matter A to Matter B's folder path or the department/team folder; non-admin linking on a staff matter gets access_denied; mock setPermissions is never called
        const mockBackend = getRegistrySingleton().getMockBackend();
        const setPermSpy = vi.spyOn(
          SharePointDocumentStoreProvider.prototype,
          'setPermissions',
        );
        try {
          await expect(
            asEmployee('P-000002', () =>
              linkExistingMatterDocumentFolder({
                matterId: 'M-000001',
                storeId: locB.storeId,
                libraryId: locB.libraryId,
                folderUrlOrPath: locB.webUrl,
                userId: 'P-000002',
              }),
            ),
          ).rejects.toMatchObject({ code: 'access_denied' });

          await expect(
            asEmployee('P-000002', () =>
              linkExistingMatterDocumentFolder({
                matterId: 'M-000001',
                storeId: locA.storeId,
                libraryId: locA.libraryId,
                folderUrlOrPath: 'RE/RE-COM',
                userId: 'P-000002',
              }),
            ),
          ).rejects.toMatchObject({ code: 'access_denied' });

          await expect(
            asEmployee('P-000007', () =>
              linkExistingMatterDocumentFolder({
                matterId: 'M-000002',
                storeId: locB.storeId,
                libraryId: locB.libraryId,
                folderUrlOrPath: locB.webUrl,
                userId: 'P-000007',
              }),
            ),
          ).rejects.toMatchObject({ code: 'access_denied' });

          // Even an admin with MFA cannot link the department or team container folder itself, or a sibling team container (R92)
          const { partition: partContainers, item: rootContainers } =
            mockBackend.getItemOrThrow(
              locA.tenantId,
              locA.providerSiteId,
              locA.providerDriveId,
              'root',
            );
          const reDeptFolder = mockBackend.createChildFolder({
            partition: partContainers,
            parent: rootContainers,
            name: 'RE',
            actorDisplayName: 'Admin',
            conflictBehavior: 'replace',
          });
          mockBackend.createChildFolder({
            partition: partContainers,
            parent: reDeptFolder,
            name: 'RE-RES',
            actorDisplayName: 'Admin',
            conflictBehavior: 'replace',
          });
          mockBackend.createChildFolder({
            partition: partContainers,
            parent: rootContainers,
            name: 'CORP',
            actorDisplayName: 'Admin',
            conflictBehavior: 'replace',
          });

          await expect(
            asEmployee('P-000004', () =>
              linkExistingMatterDocumentFolder({
                matterId: 'M-000001',
                storeId: locA.storeId,
                libraryId: locA.libraryId,
                folderUrlOrPath: 'RE/RE-COM',
                userId: 'P-000004',
                mfaVerified: true,
                allowRoutingMismatchOverride: true,
              }),
            ),
          ).rejects.toMatchObject({ code: 'access_denied' });

          await expect(
            asEmployee('P-000004', () =>
              linkExistingMatterDocumentFolder({
                matterId: 'M-000001',
                storeId: locA.storeId,
                libraryId: locA.libraryId,
                folderUrlOrPath: 'RE/RE-RES',
                userId: 'P-000004',
                mfaVerified: true,
                allowRoutingMismatchOverride: true,
              }),
            ),
          ).rejects.toMatchObject({ code: 'access_denied' });

          await expect(
            asEmployee('P-000004', () =>
              linkExistingMatterDocumentFolder({
                matterId: 'M-000001',
                storeId: locA.storeId,
                libraryId: locA.libraryId,
                folderUrlOrPath: 'RE',
                userId: 'P-000004',
                mfaVerified: true,
                allowRoutingMismatchOverride: true,
              }),
            ),
          ).rejects.toMatchObject({ code: 'access_denied' });

          await expect(
            asEmployee('P-000004', () =>
              linkExistingMatterDocumentFolder({
                matterId: 'M-000001',
                storeId: locA.storeId,
                libraryId: locA.libraryId,
                folderUrlOrPath: 'CORP',
                userId: 'P-000004',
                mfaVerified: true,
                allowRoutingMismatchOverride: true,
              }),
            ),
          ).rejects.toMatchObject({ code: 'access_denied' });

          expect(setPermSpy).not.toHaveBeenCalled();
        } finally {
          setPermSpy.mockRestore();
        }

        // R114: Admin with MFA and allowRoutingMismatchOverride CAN link a legacy folder at depth 2 ('Legacy/M-123') while 'RE/RE-RES' remains refused
        const m5ForLegacy = store.matters.find((m) => m.id === 'M-000005')!;
        m5ForLegacy.owningDepartmentId = matterABeforeProv.owningDepartmentId;
        m5ForLegacy.owningTeamId = matterABeforeProv.owningTeamId;
        const { partition: partA, item: rootItemA } = mockBackend.getItemOrThrow(
          locA.tenantId,
          locA.providerSiteId,
          locA.providerDriveId,
          'root',
        );
        const legacyFolder = mockBackend.createChildFolder({
          partition: partA,
          parent: rootItemA,
          name: 'Legacy',
          actorDisplayName: 'Admin',
          conflictBehavior: 'replace',
        });
        mockBackend.createChildFolder({
          partition: partA,
          parent: legacyFolder,
          name: 'M-123',
          actorDisplayName: 'Admin',
          conflictBehavior: 'replace',
        });
        const linkedLegacy = await asEmployee('P-000004', () =>
          linkExistingMatterDocumentFolder({
            matterId: m5ForLegacy.id,
            storeId: locA.storeId,
            libraryId: locA.libraryId,
            folderUrlOrPath: 'Legacy/M-123',
            userId: 'P-000004',
            mfaVerified: true,
            allowRoutingMismatchOverride: true,
          }),
        );
        expect(linkedLegacy.location.relativePath).toBe('Legacy/M-123');
        expect(linkedLegacy.location.routingMismatchNote).toContain('Legacy/M-123');

        // R4: User on Matter A calling download, upload, browse, or mutate with Matter A's matterId and Matter B's locationId or itemId is rejected with access_denied
        await expect(
          asEmployee('P-000002', () =>
            downloadMatterStoreDocument({
              matterId: 'M-000001',
              locationId: locB.id,
              itemId: locB.providerFolderItemId,
              userId: 'P-000002',
            }),
          ),
        ).rejects.toMatchObject({ code: 'access_denied' });

        await expect(
          asEmployee('P-000002', () =>
            downloadMatterStoreDocument({
              matterId: 'M-000001',
              locationId: locA.id,
              itemId: locB.providerFolderItemId,
              userId: 'P-000002',
            }),
          ),
        ).rejects.toMatchObject({ code: 'access_denied' });

        await expect(
          asEmployee('P-000002', () =>
            uploadMatterStoreDocument({
              matterId: 'M-000001',
              locationId: locB.id,
              folderItemId: locB.providerFolderItemId,
              fileName: 'cross-matter.txt',
              bytes: new Uint8Array([1, 2, 3]),
              userId: 'P-000002',
            }),
          ),
        ).rejects.toMatchObject({ code: 'access_denied' });

        await expect(
          asEmployee('P-000002', () =>
            uploadMatterStoreDocument({
              matterId: 'M-000001',
              locationId: locA.id,
              folderItemId: locB.providerFolderItemId,
              fileName: 'cross-matter.txt',
              bytes: new Uint8Array([1, 2, 3]),
              userId: 'P-000002',
            }),
          ),
        ).rejects.toMatchObject({ code: 'access_denied' });

        await expect(
          asEmployee('P-000002', () =>
            mutateMatterStoreItem({
              matterId: 'M-000001',
              locationId: locA.id,
              action: 'rename',
              itemId: locB.providerFolderItemId,
              name: 'Hijacked',
              userId: 'P-000002',
            }),
          ),
        ).rejects.toMatchObject({ code: 'access_denied' });

        const crossBrowse = await asEmployee('P-000002', () =>
          browseMatterDocumentStoreFolder({
            matterId: 'M-000001',
            locationId: locB.id,
            userId: 'P-000002',
          }),
        );
        expect(crossBrowse.errorCode).toBe('access_denied');
        expect(crossBrowse.locations).toEqual([]);
        expect(
          (store.documentStoreAuditEvents ?? []).some(
            (e) =>
              e.matterId === 'M-000001' &&
              e.outcome === 'denied' &&
              (e.errorCode === 'location_matter_mismatch' ||
                e.errorCode === 'item_outside_matter_folder'),
          ),
        ).toBe(true);

        // R12: Colleague in Real Estate who is NOT named on Matter A and does NOT hold matter:restricted:access can browse non-restricted Matter A via inherited department/team folder grant
        const reColleague = store.people.find((p) => p.id === 'P-000010')!;
        expect(
          hasPersonPermission(reColleague, 'matter:restricted:access', {
            allPeople: store.people,
            teams: store.teams,
          }),
        ).toBe(false);
        const targetMatterA = store.matters.find((m) => m.id === 'M-000001')!;
        expect(targetMatterA.leadFeeEarnerId).not.toBe('P-000010');
        expect(targetMatterA.supervisingPartnerId).not.toBe('P-000010');
        expect(targetMatterA.responsiblePartnerId).not.toBe('P-000010');
        expect(targetMatterA.teamMemberIds ?? []).not.toContain('P-000010');

        const colleagueBrowse = await asEmployee('P-000010', () =>
          browseMatterDocumentStoreFolder({
            matterId: 'M-000001',
            userId: 'P-000010',
          }),
        );
        expect(colleagueBrowse.errorCode).toBeUndefined();
        expect(colleagueBrowse.activeLocation?.id).toBe(locA.id);
        expect(colleagueBrowse.activeLocation?.hasUniquePermissions).toBe(false);

        // R8: Custom field validation runs before conflict-on-hire in savePersonRecord so a rejected save never mutates matters or folder permissions
        const clientIdOnMatterA = 'P-000030';
        targetMatterA.clientId = clientIdOnMatterA;
        targetMatterA.teamMemberIds = ['P-000002', 'P-000003'];
        const clientPerson = store.people.find((p) => p.id === clientIdOnMatterA)!;
        const snapshotCustomFields = structuredClone(store.customFields);
        store.customFields.push({
          id: 'CF-REQ-PERSON-TEST',
          recordType: 'person',
          label: 'Required Onboarding Code',
          fieldType: 'text',
          section: 'additional',
          required: true,
          active: true,
          sortOrder: 999,
        });
        try {
          const rejectedHire = asEmployee('P-000001', () =>
            savePersonRecord(
              {
                ...clientPerson,
                isEmployee: true,
                employeeRoleId: 'employee_role.solicitor',
                departmentId: 'DEPT-RE',
                customFields: {},
              },
              { id: clientIdOnMatterA, byId: 'P-000001' },
            ),
          );
          expect(rejectedHire.errors?.['CF-REQ-PERSON-TEST']).toBeDefined();
          expect(
            Boolean(store.matters.find((m) => m.id === 'M-000001')?.isStaffMatter),
          ).toBe(false);
          const { item: mockItemBeforeValidHire } = mockBackend.getItemOrThrow(
            locA.tenantId,
            locA.providerSiteId,
            locA.providerDriveId,
            locA.providerFolderItemId,
          );
          expect(mockItemBeforeValidHire.inheritsFromParent).toBe(true);
        } finally {
          store.customFields = snapshotCustomFields;
        }

        // R8 & R80: Making Matter A a staff matter through conflict-on-hire (savePersonRecord) updates the mock backend's folder permissions as well as intendedGrants
        const hireRes = asEmployee('P-000001', () =>
          savePersonRecord(
            {
              ...clientPerson,
              isEmployee: true,
              employeeRoleId: 'employee_role.solicitor',
              departmentId: 'DEPT-RE',
            },
            { id: clientIdOnMatterA, byId: 'P-000001' },
          ),
        );
        expect(hireRes.errors).toBeUndefined();
        await flushDocumentLifecycleSyncForTesting();

        const updatedLocA = (store.matterDocumentLocations ?? []).find(
          (l) => l.id === locA.id,
        )!;
        expect(updatedLocA.hasUniquePermissions).toBe(true);
        const hasDeptOrTeamGroupGrant = updatedLocA.intendedGrants.some(
          (g) =>
            g.principal.principalType === 'group' &&
            (g.principal.internalId?.startsWith('DEPT-') ||
              g.principal.internalId?.startsWith('TPG-')),
        );
        expect(hasDeptOrTeamGroupGrant).toBe(false);

        const { item: mockItemAfterHire } = mockBackend.getItemOrThrow(
          locA.tenantId,
          locA.providerSiteId,
          locA.providerDriveId,
          locA.providerFolderItemId,
        );
        expect(mockItemAfterHire.inheritsFromParent).toBe(false);
        expect(
          mockItemAfterHire.directGrants.some(
            (g) =>
              g.principal.principalType === 'group' &&
              (g.principal.internalId?.startsWith('DEPT-') ||
                g.principal.internalId?.startsWith('TPG-')),
          ),
        ).toBe(false);
        expect(
          mockItemAfterHire.directGrants.some(
            (g) => g.principal.internalId === 'P-000003',
          ),
        ).toBe(true);

        // R8: Removing a team member from restricted Matter A removes their grant on the mock backend
        await asEmployee('P-000001', () =>
          saveMatterRecord(
            {
              ...targetMatterA,
              isStaffMatter: true,
              hasEthicalWall: true,
              teamMemberIds: ['P-000002'],
              restrictedAccessUserIds: ['P-000001', 'P-000002'],
            },
            { id: 'M-000001', byId: 'P-000001' },
          ),
        );
        await flushDocumentLifecycleSyncForTesting();
        const { item: mockItemAfterTeamRemoval } = mockBackend.getItemOrThrow(
          locA.tenantId,
          locA.providerSiteId,
          locA.providerDriveId,
          locA.providerFolderItemId,
        );
        expect(
          mockItemAfterTeamRemoval.directGrants.some(
            (g) => g.principal.internalId === 'P-000003',
          ),
        ).toBe(false);

        // R121: (1) A fee earner (P-000007) not on restrictedAccessUserIds gets "not found or restricted" from saveMatterRecord, and the matter + folder permissions are unchanged
        const grantsBeforeUnauthorizedSave = structuredClone(
          mockItemAfterTeamRemoval.directGrants,
        );
        const unauthorizedSaveRes = await asEmployee('P-000007', () =>
          saveMatterRecord(
            {
              ...targetMatterA,
              title: 'Unauthorized Tampered Title',
              isStaffMatter: false,
              hasEthicalWall: false,
              restrictedAccessUserIds: [],
            },
            { id: 'M-000001', byId: 'P-000007' },
          ),
        );
        expect(unauthorizedSaveRes.errors?.access).toMatch(
          /not found or restricted/i,
        );
        await flushDocumentLifecycleSyncForTesting();
        const matterAfterUnauthorizedSave = getStore().matters.find(
          (m) => m.id === 'M-000001',
        )!;
        expect(matterAfterUnauthorizedSave.isStaffMatter).toBe(true);
        expect(matterAfterUnauthorizedSave.title).not.toBe(
          'Unauthorized Tampered Title',
        );
        const { item: mockItemAfterUnauthorizedSave } =
          mockBackend.getItemOrThrow(
            locA.tenantId,
            locA.providerSiteId,
            locA.providerDriveId,
            locA.providerFolderItemId,
          );
        expect(mockItemAfterUnauthorizedSave.inheritsFromParent).toBe(false);
        expect(mockItemAfterUnauthorizedSave.directGrants).toEqual(
          grantsBeforeUnauthorizedSave,
        );

        // R121: (2) An authorised participant (P-000001) sending isStaffMatter: false and restrictedAccessUserIds: [] keeps the matter as a restricted staff matter
        const authorisedAttemptToStripRes = await asEmployee('P-000001', () =>
          saveMatterRecord(
            {
              ...matterAfterUnauthorizedSave,
              isStaffMatter: false,
              hasEthicalWall: false,
              restrictedAccessUserIds: [],
            },
            { id: 'M-000001', byId: 'P-000001' },
          ),
        );
        await flushDocumentLifecycleSyncForTesting();
        expect(authorisedAttemptToStripRes.errors).toBeUndefined();
        expect(authorisedAttemptToStripRes.matter?.isStaffMatter).toBe(true);
        expect(
          authorisedAttemptToStripRes.matter?.restrictedAccessUserIds,
        ).toContain('P-000001');
        expect(
          authorisedAttemptToStripRes.matter?.restrictedAccessUserIds,
        ).toContain('P-000002');

        // R121: (3) A user without matter:create (e.g. finance role P-000009) cannot create a matter
        const countBeforeUnauthorisedCreate = getStore().matters.length;
        const unauthorisedCreateRes = await asEmployee('P-000009', () =>
          saveMatterRecord(
            {
              title: 'Finance Unauthorised Matter',
              clientId: targetMatterA.clientId,
              practiceAreaId: targetMatterA.practiceAreaId,
              workTypeSubcategoryId: targetMatterA.workTypeSubcategoryId,
            },
            { byId: 'P-000009' },
          ),
        );
        expect(unauthorisedCreateRes.errors?.permission).toMatch(
          /matter:create/i,
        );
        expect(getStore().matters.length).toBe(countBeforeUnauthorisedCreate);

        // R88: Closing a matter via saveMatterRecord runs closeMatterFolderJob (invoking onBeforeMatterDocumentsClose hook and writing lifecycle:matter:closed audit event), and reopening writes lifecycle:matter:reopened
        const closeHookCalls: string[] = [];
        setBeforeMatterDocumentsCloseHookForTesting(async ({ matterId }) => {
          closeHookCalls.push(matterId);
        });
        const snapshotKeyDates = structuredClone(store.keyDates ?? []);
        for (const kd of store.keyDates ?? []) {
          if (kd.matterId === 'M-000001') {
            kd.status = 'met';
          }
        }
        try {
          const closedStatusId =
            store.values.find(
              (v) =>
                v.listKey === 'matter_status' &&
                v.label.toLowerCase().includes('closed'),
            )?.id ?? 'matter_status.closed';
          const openStatusId = targetMatterA.matterStatusId;

          const closeSaveRes = await asEmployee('P-000001', () =>
            saveMatterRecord(
              {
                ...targetMatterA,
                isStaffMatter: true,
                hasEthicalWall: true,
                matterStatusId: closedStatusId,
                closedAt: '2026-11-01',
                teamMemberIds: ['P-000002'],
                restrictedAccessUserIds: ['P-000001', 'P-000002'],
              },
              { id: 'M-000001', byId: 'P-000001' },
            ),
          );
          expect(closeSaveRes.errors).toBeUndefined();
          await flushDocumentLifecycleSyncForTesting();

          expect(closeHookCalls).toContain('M-000001');
          expect(
            (store.documentStoreAuditEvents ?? []).some(
              (e) =>
                e.matterId === 'M-000001' &&
                e.action === 'lifecycle:matter:closed' &&
                e.outcome === 'succeeded',
            ),
          ).toBe(true);

          const reopenSaveRes = await asEmployee('P-000001', () =>
            saveMatterRecord(
              {
                ...targetMatterA,
                isStaffMatter: true,
                hasEthicalWall: true,
                matterStatusId: openStatusId,
                closedAt: null,
                teamMemberIds: ['P-000002'],
                restrictedAccessUserIds: ['P-000001', 'P-000002'],
              },
              { id: 'M-000001', byId: 'P-000001' },
            ),
          );
          expect(reopenSaveRes.errors).toBeUndefined();
          await flushDocumentLifecycleSyncForTesting();

          expect(
            (store.documentStoreAuditEvents ?? []).some(
              (e) =>
                e.matterId === 'M-000001' &&
                e.action === 'lifecycle:matter:reopened' &&
                e.outcome === 'succeeded',
            ),
          ).toBe(true);

          // R109: When a beforeMatterDocumentsClose hook throws, syncMatterLifecycleOnSaveSync logs structured error with correlationId & tenantId and records a failed job
          const hookErrSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});
          setBeforeMatterDocumentsCloseHookForTesting(async () => {
            throw new Error('Hook rejected matter close');
          });
          const jobsBeforeHookThrow = new Set(
            (store.documentLifecycleJobs ?? []).map((j) => j.id),
          );
          try {
            await asEmployee('P-000001', () =>
              syncMatterLifecycleOnSaveSync({
                matter: {
                  ...targetMatterA,
                  isStaffMatter: true,
                  hasEthicalWall: true,
                  matterStatusId: closedStatusId,
                  closedAt: '2026-11-02',
                  teamMemberIds: ['P-000002'],
                  restrictedAccessUserIds: ['P-000001', 'P-000002'],
                },
                previousMatter: {
                  ...targetMatterA,
                  isStaffMatter: true,
                  hasEthicalWall: true,
                  matterStatusId: openStatusId,
                  closedAt: null,
                },
                userId: 'P-000001',
                correlationId: 'corr-r109-hook-fail',
                store,
              }),
            );
            expect(
              hookErrSpy.mock.calls.some((args) => {
                const payload = String(args[0] ?? '');
                return (
                  payload.includes('corr-r109-hook-fail') &&
                  payload.includes('not-a-law-firm')
                );
              }),
            ).toBe(true);
            const hookFailJobs = (store.documentLifecycleJobs ?? []).filter(
              (j) =>
                j.matterId === 'M-000001' &&
                !jobsBeforeHookThrow.has(j.id) &&
                j.status === 'failed',
            );
            expect(hookFailJobs.length).toBeGreaterThanOrEqual(1);
          } finally {
            hookErrSpy.mockRestore();
          }
        } finally {
          store.keyDates = snapshotKeyDates;
          setBeforeMatterDocumentsCloseHookForTesting(undefined);
        }

        // R80 & R88: syncMatterLifecycleOnSaveSync fails closed with UNAUTHENTICATED for an unknown user, and when the provider fails there is ONLY a failed job (no premature succeeded job), intendedGrants is not updated, and console.error does not leak folder paths or matter codes
        expect(() =>
          syncMatterLifecycleOnSaveSync({
            matter: targetMatterA,
            userId: 'P-UNKNOWN-ACTOR',
            store,
          }),
        ).toThrow(/UNAUTHENTICATED/);

        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const failPermSpy = vi
          .spyOn(SharePointDocumentStoreProvider.prototype, 'setPermissions')
          .mockRejectedValue(
            new Error('Simulated Graph 503 failure on /RE/RE-COM/PEN001-0004'),
          );
        try {
          const existingJobIds = new Set(
            (store.documentLifecycleJobs ?? []).map((j) => j.id),
          );
          const intendedBeforeFail = structuredClone(
            (store.matterDocumentLocations ?? []).find((l) => l.id === locA.id)!
              .intendedGrants,
          );

          // Change teamMemberIds so grants would differ if prematurely persisted
          const modifiedMatterForFail = {
            ...targetMatterA,
            isStaffMatter: true,
            hasEthicalWall: true,
            teamMemberIds: ['P-000002', 'P-000006'],
            restrictedAccessUserIds: ['P-000001', 'P-000002', 'P-000006'],
          };
          asEmployee('P-000001', () =>
            syncMatterLifecycleOnSaveSync({
              matter: modifiedMatterForFail,
              userId: 'P-000001',
              store,
            }),
          );
          await flushDocumentLifecycleSyncForTesting();

          expect(errSpy).toHaveBeenCalled();
          for (const call of errSpy.mock.calls) {
            const loggedPayload = String(call[0] ?? '');
            expect(loggedPayload).toContain('correlationId');
            expect(loggedPayload).toContain('tenantId');
            expect(loggedPayload).not.toContain('PEN001-0004');
            expect(loggedPayload).not.toContain('/RE/RE-COM');
          }

          const newJobs = (store.documentLifecycleJobs ?? []).filter(
            (j) => j.matterId === 'M-000001' && !existingJobIds.has(j.id),
          );
          expect(newJobs).toHaveLength(1);
          expect(newJobs[0]?.status).toBe('failed');
          expect(newJobs[0]?.lastErrorMessage).toBe(newJobs[0]?.lastErrorCode);
          expect(newJobs[0]?.lastErrorMessage).not.toContain('/RE/RE-COM');
          expect(newJobs.some((j) => j.status === 'succeeded')).toBe(false);

          const intendedAfterFail = (store.matterDocumentLocations ?? []).find(
            (l) => l.id === locA.id,
          )!.intendedGrants;
          expect(intendedAfterFail).toEqual(intendedBeforeFail);
        } finally {
          failPermSpy.mockRestore();
          errSpy.mockRestore();
        }

        // R89: SharePointDocumentStoreProvider.setPermissions never mutates mock state before authentication succeeds
        const { item: itemBeforeUnauth } = mockBackend.getItemOrThrow(
          locA.tenantId,
          locA.providerSiteId,
          locA.providerDriveId,
          locA.providerFolderItemId,
        );
        const grantsSnapshotBeforeUnauth = structuredClone(
          itemBeforeUnauth.directGrants,
        );
        const inheritsSnapshotBeforeUnauth =
          itemBeforeUnauth.inheritsFromParent;
        const r89Ctx = makeTenantContext({ tenantId: locA.tenantId });
        let stateUntouchedDuringTokenAcquisition = false;
        const spProvider = new SharePointDocumentStoreProvider({
          tenantContext: r89Ctx,
          storeConfig: makeGenericStores('alpha')[0]!,
          tokenService: new DocumentStoreTokenService({
            cache: new TenantScopedEncryptedTokenCache(),
            appTokenHandler: async () => {
              // Record flag while token acquisition is in flight without throwing inside expect
              const { item: itemDuringInFlight } = mockBackend.getItemOrThrow(
                locA.tenantId,
                locA.providerSiteId,
                locA.providerDriveId,
                locA.providerFolderItemId,
              );
              stateUntouchedDuringTokenAcquisition =
                JSON.stringify(itemDuringInFlight.directGrants) ===
                  JSON.stringify(grantsSnapshotBeforeUnauth) &&
                itemDuringInFlight.inheritsFromParent ===
                  inheritsSnapshotBeforeUnauth;
              throw new Error('Authentication failed');
            },
          }),
          backend: mockBackend,
        });
        const unauthPromise = spProvider.setPermissions(
          {
            kind: 'provisioning',
            tenantContext: r89Ctx,
            triggeredByUserId: 'P-000001',
            triggerEvent: 'r89.test',
          },
          {
            storeId: locA.storeId,
            libraryId: locA.libraryId,
            siteId: locA.providerSiteId,
            driveId: locA.providerDriveId,
            itemId: locA.providerFolderItemId,
          },
          [],
          { inherit: !inheritsSnapshotBeforeUnauth },
        );
        await expect(unauthPromise).rejects.toThrow(/Authentication failed/);
        expect(stateUntouchedDuringTokenAcquisition).toBe(true);
        expect(itemBeforeUnauth.directGrants).toEqual(
          grantsSnapshotBeforeUnauth,
        );
        expect(itemBeforeUnauth.inheritsFromParent).toBe(
          inheritsSnapshotBeforeUnauth,
        );

        // R90: DocumentStoreTokenService refuses default mock OBO and app-only token handlers unless environment is 'dev' or 'test' (including 'live', 'training', and unset)
        const liveTokenService = new DocumentStoreTokenService({
          cache: new TenantScopedEncryptedTokenCache(),
        });
        const liveAuthCfg = makeGenericStores('alpha')[0]!.auth;
        for (const nonDevEnv of ['live', 'training', undefined] as const) {
          const baseNonDevCtx = resolveTenantFromVerifiedToken({
            verifiedToken: {
              __verifiedByOidcMiddleware: true,
              sub: 'P-000001',
              email: 'admin@firm-live.example',
              name: 'Live Admin',
              tenantId: 'firm-live-test',
              roles: ['admin'],
              mfaVerified: true,
            },
            hostingMode: 'multi_tenant',
            correlationId: `corr-r90-${nonDevEnv ?? 'unset'}`,
            environment: nonDevEnv ?? 'live',
          });
          const nonDevCtx: TenantContext =
            nonDevEnv === undefined
              ? ({ ...baseNonDevCtx, environment: undefined } as unknown as TenantContext)
              : baseNonDevCtx;
          await expect(
            liveTokenService.acquireDelegatedUserToken({
              accessContext: {
                kind: 'user',
                tenantContext: nonDevCtx,
                actorUserId: 'P-000001',
                entraObjectId: 'oid-live-001',
                userUpn: 'rhian@firm-alpha.example',
                userAssertionToken: 'live-assertion',
              },
              storeId: 'sp-live',
              authConfig: liveAuthCfg,
            }),
          ).rejects.toMatchObject({ code: 'misconfigured' });
          await expect(
            liveTokenService.acquireProvisioningToken({
              accessContext: {
                kind: 'provisioning',
                tenantContext: nonDevCtx,
                triggeredByUserId: 'P-000001',
                triggerEvent: 'r90.test',
              },
              storeId: 'sp-live',
              authConfig: liveAuthCfg,
            }),
          ).rejects.toMatchObject({ code: 'misconfigured' });
        }

        // R9, R91 & R107: Matter with unset owningTeamId (undefined) stays undefined after store load and after a save by another user, fails provisioning as misconfigured, and succeeds once owningDepartmentId + owningTeamId are saved
        const rawUnsetTeamMatter = {
          ...targetMatterA,
          matterNumber: 'NT001-0001',
          title: 'Matter Without Owning Team',
          owningDepartmentId: 'DEPT-RE',
          leadFeeEarnerId: 'P-000002',
        };
        delete (rawUnsetTeamMatter as { id?: string }).id;
        delete (rawUnsetTeamMatter as { owningTeamId?: string | null }).owningTeamId;
        const savedNoTeamMatterRes = await asEmployee('P-000002', () =>
          saveMatterRecord(rawUnsetTeamMatter, {
            byId: 'P-000002',
          }),
        );
        expect(savedNoTeamMatterRes.errors).toBeUndefined();
        const noTeamMatterId = savedNoTeamMatterRes.matter!.id;
        expect(savedNoTeamMatterRes.matter?.owningTeamId).toBeUndefined();
        expect(
          getStore().matters.find((m) => m.id === noTeamMatterId)?.owningTeamId,
        ).toBeUndefined();

        // Save again by another user without setting owningTeamId: still undefined
        const resavedByOtherUser = await asEmployee('P-000001', () =>
          saveMatterRecord(
            {
              ...savedNoTeamMatterRes.matter!,
              title: 'Matter Without Owning Team (Updated)',
            },
            { id: noTeamMatterId, byId: 'P-000001' },
          ),
        );
        expect(resavedByOtherUser.errors).toBeUndefined();
        expect(resavedByOtherUser.matter?.owningTeamId).toBeUndefined();

        await expect(
          asEmployee('P-000002', () =>
            ensureMatterDocumentStoreProvisioned(
              noTeamMatterId,
              'P-000002',
            ),
          ),
        ).rejects.toMatchObject({ code: 'misconfigured' });

        // R107: (1) A save with an unknown team or a team from another department returns a field error and changes nothing
        const badUnknownTeamRes = await asEmployee('P-000001', () =>
          saveMatterRecord(
            {
              ...resavedByOtherUser.matter!,
              owningDepartmentId: 'DEPT-RE',
              owningTeamId: 'TPG-DOES-NOT-EXIST',
            },
            { id: noTeamMatterId, byId: 'P-000001' },
          ),
        );
        expect(badUnknownTeamRes.errors?.owningTeamId).toMatch(
          /does not exist or is inactive/i,
        );
        expect(
          getStore().matters.find((m) => m.id === noTeamMatterId)?.owningTeamId,
        ).toBeUndefined();

        const badCrossDeptTeamRes = await asEmployee('P-000001', () =>
          saveMatterRecord(
            {
              ...resavedByOtherUser.matter!,
              owningDepartmentId: 'DEPT-RE',
              owningTeamId: 'TPG-CORP-MA',
            },
            { id: noTeamMatterId, byId: 'P-000001' },
          ),
        );
        expect(badCrossDeptTeamRes.errors?.owningTeamId).toMatch(
          /does not belong to the selected owning department/i,
        );
        expect(
          getStore().matters.find((m) => m.id === noTeamMatterId)?.owningTeamId,
        ).toBeUndefined();

        // R107: (2) A fee earner without matter:reassign_ownership (P-000002) cannot change an existing matter's owning team
        const feeEarnerReassignRes = await asEmployee('P-000002', () =>
          saveMatterRecord(
            {
              ...resavedByOtherUser.matter!,
              owningDepartmentId: targetMatterA.owningDepartmentId,
              owningTeamId: targetMatterA.owningTeamId,
            },
            { id: noTeamMatterId, byId: 'P-000002' },
          ),
        );
        expect(feeEarnerReassignRes.errors?.owningTeamId).toMatch(
          /matter:reassign_ownership/i,
        );
        expect(
          getStore().matters.find((m) => m.id === noTeamMatterId)?.owningTeamId,
        ).toBeUndefined();

        // R107: Setting owningDepartmentId and owningTeamId via saveMatterRecord by a partner (with matter:reassign_ownership) persists both and allows provisioning to succeed
        const savedWithTeamMatterRes = await asEmployee('P-000001', () =>
          saveMatterRecord(
            {
              ...resavedByOtherUser.matter!,
              owningDepartmentId: targetMatterA.owningDepartmentId,
              owningTeamId: targetMatterA.owningTeamId,
            },
            { id: noTeamMatterId, byId: 'P-000001' },
          ),
        );
        expect(savedWithTeamMatterRes.errors).toBeUndefined();
        expect(savedWithTeamMatterRes.matter?.owningDepartmentId).toBe(
          targetMatterA.owningDepartmentId,
        );
        expect(savedWithTeamMatterRes.matter?.owningTeamId).toBe(
          targetMatterA.owningTeamId,
        );
        const provWithTeam = await asEmployee('P-000002', () =>
          ensureMatterDocumentStoreProvisioned(
            noTeamMatterId,
            'P-000002',
          ),
        );
        expect(provWithTeam.locations[0]?.provisioningStatus).toBe('provisioned');

        const unmappedSubject = buildMatterRoutingSubject(
          {
            ...targetMatterA,
            id: 'M-UNMAPPED',
            owningDepartmentId: 'DEPT-NON-EXISTENT-999',
          },
          store,
        );
        expect(unmappedSubject.departmentId).toBe('');
        expect(() =>
          resolveMatterDocumentRoute({
            subject: unmappedSubject,
            stores: makeGenericStores('alpha'),
            routingRules: makeGenericRoutingRules('alpha'),
            matterFolderNameTemplate: '{matterNumber} - {matterDescription}',
          }),
        ).toThrow(/no owning department configured/i);

        const missingTeamSubject = buildMatterRoutingSubject(
          {
            ...targetMatterA,
            id: 'M-NO-TEAM',
            owningDepartmentId: 'DEPT-RE',
            owningTeamId: null,
          },
          store,
        );
        expect(missingTeamSubject.departmentId).toBe('DEPT-RE');
        expect(missingTeamSubject.teamId).toBe('');
        expect(() =>
          resolveMatterDocumentRoute({
            subject: missingTeamSubject,
            stores: makeGenericStores('alpha'),
            routingRules: makeGenericRoutingRules('alpha'),
            matterFolderNameTemplate: '{matterNumber} - {matterDescription}',
          }),
        ).toThrow(/no owning team configured/i);

        // R91: Department-only routing rule (basePath: '{departmentCode}', no team match or team tokens) succeeds when teamId is empty
        const deptOnlyRoute = resolveMatterDocumentRoute({
          subject: missingTeamSubject,
          stores: makeGenericStores('alpha'),
          routingRules: [
            {
              ruleId: 'rule-dept-only',
              match: { departmentId: 'DEPT-RE' },
              storeId: 'alpha-sp-primary',
              libraryId: 'lib-matters',
              basePath: '{departmentCode}',
            },
          ],
          matterFolderNameTemplate: '{matterNumber} - {matterDescription}',
        });
        expect(deptOnlyRoute.renderedBasePath).toBe('RE');

        // R20: Sample document seeding runs when enableDemoMode is true in non-live, and is skipped when enableDemoMode is false
        const cfgSnapshot = store.documentStoreConfigOverride;
        const tenantRuntime = await import('@/platform/tenantRuntime');
        try {
          tenantRuntime.setActiveTenantConfigForTesting(null, {
            featureFlags: { enableDemoMode: true },
          });
          const m4 = store.matters.find((m) => m.id === 'M-000004')!;
          m4.owningDepartmentId = targetMatterA.owningDepartmentId;
          m4.owningTeamId = targetMatterA.owningTeamId;
          const provM4 = await asEmployee('P-000001', () =>
            ensureMatterDocumentStoreProvisioned(
              m4.id,
              'P-000001',
            ),
          );
          const locM4 = provM4.locations[0]!;
          const partM4 = mockBackend.getDrivePartitionOrThrow(
            locM4.tenantId,
            locM4.providerSiteId,
            locM4.providerDriveId,
          );
          const m4FolderIds = new Set<string>([
            locM4.providerFolderItemId,
            ...Object.values(locM4.folderItemMap ?? {}),
          ]);
          const filesInM4 = Array.from(partM4.items.values()).filter(
            (item) =>
              item.itemType === 'file' &&
              item.parentItemId !== null &&
              m4FolderIds.has(item.parentItemId),
          );
          expect(filesInM4.length).toBeGreaterThan(0);

          tenantRuntime.setActiveTenantConfigForTesting(null, {
            featureFlags: { enableDemoMode: false },
          });
          const m3 = store.matters.find((m) => m.id === 'M-000003')!;
          const provM3 = await asEmployee('P-000001', () =>
            ensureMatterDocumentStoreProvisioned(
              m3.id,
              'P-000001',
            ),
          );
          const locM3 = provM3.locations[0]!;
          const partM3 = mockBackend.getDrivePartitionOrThrow(
            locM3.tenantId,
            locM3.providerSiteId,
            locM3.providerDriveId,
          );
          const m3FolderIds = new Set<string>([
            locM3.providerFolderItemId,
            ...Object.values(locM3.folderItemMap ?? {}),
          ]);
          const filesInM3 = Array.from(partM3.items.values()).filter(
            (item) =>
              item.itemType === 'file' &&
              item.parentItemId !== null &&
              m3FolderIds.has(item.parentItemId),
          );
          expect(filesInM3).toHaveLength(0);
        } finally {
          tenantRuntime.setActiveTenantConfigForTesting(null, undefined);
          store.documentStoreConfigOverride = cfgSnapshot;
        }

        // R13 & R14: 600 audit events persisted without truncation, and two-tenant hydration/persistence isolation
        resetDocumentStoreSingletonsForTesting();
        const ctxAlpha = makeTenantContext({ tenantId: 'firm-alpha' });
        const ctxBeta = makeTenantContext({ tenantId: 'firm-beta' });
        const repo = ensureRepositorySyncedWithStore(ctxAlpha, store);
        ensureRepositorySyncedWithStore(ctxBeta, store);

        for (let i = 0; i < 600; i++) {
          repo.appendAuditEvent(
            ctxAlpha,
            buildDocumentStoreAuditEvent({
              context: ctxAlpha,
              identityUsed: 'user',
              triggerEvent: 'test.bulk',
              action: 'document:listed',
              matterId: 'M-BULK',
              storeId: 'alpha-store',
              outcome: 'succeeded',
            }),
          );
        }
        repo.appendAuditEvent(
          ctxBeta,
          buildDocumentStoreAuditEvent({
            context: ctxBeta,
            identityUsed: 'user',
            triggerEvent: 'test.beta',
            action: 'document:listed',
            matterId: 'M-BETA',
            storeId: 'beta-store',
            outcome: 'succeeded',
          }),
        );

        persistRepositoryToStore(ctxAlpha, repo, store, { skipDiskSave: true });
        persistRepositoryToStore(ctxBeta, repo, store, { skipDiskSave: true });

        resetDocumentStoreSingletonsForTesting();
        const reloadedRepo = ensureRepositorySyncedWithStore(ctxAlpha, store);
        ensureRepositorySyncedWithStore(ctxBeta, store);

        expect(reloadedRepo.listAuditEvents(ctxAlpha)).toHaveLength(600);
        expect(reloadedRepo.listAuditEvents(ctxBeta)).toHaveLength(1);

        // R18 & R93: Route handlers log structured error with correlationId and tenantId while returning generic message, and audit events share the exact same correlationId
        const routeErrSpy = vi
          .spyOn(console, 'error')
          .mockImplementation(() => {});
        try {
          setTestEntraSessionOverride(sessions.get('P-000004'));
          const badStoreReq = new NextRequest(
            'http://localhost:3000/api/document-stores',
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-correlation-id': 'corr-r18-docstore-test',
              },
              body: JSON.stringify({
                action: 'test_connection',
                storeId: 'non-existent-store-id',
              }),
            },
          );
          const badStoreResp = await postDocumentStoresRoute(badStoreReq);
          expect(badStoreResp.status).toBe(400);
          const badStoreJson = (await badStoreResp.json()) as {
            ok: boolean;
            error: string;
          };
          expect(badStoreJson.ok).toBe(false);
          expect(badStoreJson.error).not.toContain('non-existent-store-id');
          expect(
            routeErrSpy.mock.calls.some((args) => {
              const str = String(args[0] ?? '');
              return (
                str.includes('corr-r18-docstore-test') &&
                str.includes('not-a-law-firm')
              );
            }),
          ).toBe(true);

          const sharedCorrelationId = 'corr-r93-matter-docs-shared';
          // R93: Browse on an unprovisioned matter passes correlationId through to provisioning job and audit event
          const m4 = store.matters.find((m) => m.id === 'M-000004')!;
          m4.owningDepartmentId = targetMatterA.owningDepartmentId;
          m4.owningTeamId = targetMatterA.owningTeamId;
          const browseCorrId = 'corr-r93-browse-provision';
          const browseProvRes = await asEmployee('P-000001', () =>
            browseMatterDocumentStoreFolder({
              matterId: m4.id,
              userId: 'P-000001',
              correlationId: browseCorrId,
            }),
          );
          expect(browseProvRes.activeLocation).not.toBeNull();
          expect(
            (store.documentLifecycleJobs ?? []).some(
              (j) =>
                j.matterId === m4.id &&
                j.jobType === 'provision_matter' &&
                j.correlationId === browseCorrId,
            ),
          ).toBe(true);
          expect(
            (store.documentStoreAuditEvents ?? []).some(
              (e) =>
                e.matterId === m4.id &&
                e.action === 'lifecycle:matter:provisioned' &&
                e.correlationId === browseCorrId,
            ),
          ).toBe(true);

          await expect(
            asEmployee('P-000002', () =>
              downloadMatterStoreDocument({
                matterId: 'M-000001',
                locationId: 'bad-loc',
                itemId: 'bad-item',
                userId: 'P-000002',
                correlationId: sharedCorrelationId,
              }),
            ),
          ).rejects.toMatchObject({ code: 'access_denied' });
          expect(
            (store.documentStoreAuditEvents ?? []).some(
              (e) => e.correlationId === sharedCorrelationId,
            ),
          ).toBe(true);

          setTestEntraSessionOverride(sessions.get('P-000002'));
          const matterRouteReq = new NextRequest(
            'http://localhost:3000/api/matters/M-000001/documents?action=download&locationId=bad-loc&itemId=bad-item',
            {
              method: 'GET',
              headers: {
                'x-correlation-id': sharedCorrelationId,
              },
            },
          );
          const matterRouteResp = await getMatterDocumentsRoute(matterRouteReq, {
            params: Promise.resolve({ id: 'M-000001' }),
          });
          expect([400, 403]).toContain(matterRouteResp.status);
          const matterRouteJson = (await matterRouteResp.json()) as {
            ok: boolean;
            error: string;
          };
          expect(matterRouteJson.ok).toBe(false);
          expect(
            routeErrSpy.mock.calls.some((args) => {
              const str = String(args[0] ?? '');
              return (
                str.includes(sharedCorrelationId) &&
                str.includes('not-a-law-firm')
              );
            }),
          ).toBe(true);
        } finally {
          setTestEntraSessionOverride(undefined);
          routeErrSpy.mockRestore();
        }

        // R21 & R86: No SHAREPOINT_LIVE_ references in core/src; SharePointDocumentStoreProvider is mock-backed for Phase 1
        const tokenCacheSource = fs.readFileSync(
          path.resolve(
            __dirname,
            '../src/integrations/document-stores/tokenCache.ts',
          ),
          'utf8',
        );
        expect(tokenCacheSource).not.toContain('SHAREPOINT_LIVE_');

        // R23: MockSharePointGraphBackend is exported from @platform/core/testing, not @platform/core
        expect('MockSharePointGraphBackend' in CoreBarrel).toBe(false);
        expect(typeof MockSharePointGraphBackend).toBe('function');
      } finally {
        setTestEntraSessionOverride(undefined);
        store.matters = snapshotMatters;
        store.people = snapshotPeople;
        store.notifications = snapshotNotifications;
        store.matterDocumentLocations = snapshotLocations;
        store.documentStoreFolderScopes = snapshotScopes;
        store.documentLifecycleJobs = snapshotJobs;
        store.documentReconciliationFindings = snapshotFindings;
        store.documentStoreAuditEvents = snapshotAudits;
        saveStore(store);
        resetDocumentStoreSingletonsForTesting();
      }
    });

    it('enforces R7, R10, R20, R23: static architecture & documentation permission key checks', () => {
      // R7: __verifiedByOidcMiddleware: true in src/ appears only in src/platform/tenantRuntime.ts
      const srcRoot = path.resolve(__dirname, '../../src');
      function walkTsFiles(dir: string): string[] {
        const out: string[] = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            out.push(...walkTsFiles(full));
          } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
            out.push(full);
          }
        }
        return out;
      }

      const srcFiles = walkTsFiles(srcRoot);
      const oidcBypassFiles: string[] = [];
      const deepCoreDomainImports: string[] = [];
      for (const file of srcFiles) {
        const rel = path.relative(srcRoot, file).replace(/\\/g, '/');
        const content = fs.readFileSync(file, 'utf8');
        if (
          content.includes('__verifiedByOidcMiddleware: true') &&
          rel !== 'platform/tenantRuntime.ts'
        ) {
          oidcBypassFiles.push(rel);
        }
        if (content.includes('core/src/domain/')) {
          deepCoreDomainImports.push(rel);
        }
      }
      expect(oidcBypassFiles).toEqual([]);
      expect(deepCoreDomainImports).toEqual([]);

      // R9 & R20: zero hardcoded DEPT-/TPG- or 00000000-0000-0000-0000-000000000101 in src/server/documentStoreServices.ts
      const docStoreServiceContent = fs.readFileSync(
        path.join(srcRoot, 'server/documentStoreServices.ts'),
        'utf8',
      );
      expect(docStoreServiceContent).not.toMatch(/DEPT-|TPG-/);
      expect(docStoreServiceContent).not.toContain(
        '00000000-0000-0000-0000-000000000101',
      );
      expect(docStoreServiceContent).not.toContain(
        '00000000-0000-0000-0000-000000000104',
      );

      // R10: every permission key mentioned in src/docs/articles/*.ts exists in PERMISSION_REGISTRY
      const articlesDir = path.join(srcRoot, 'docs/articles');
      const unknownDocPermKeys: string[] = [];
      for (const file of fs.readdirSync(articlesDir)) {
        if (!file.endsWith('.ts')) continue;
        const content = fs.readFileSync(path.join(articlesDir, file), 'utf8');
        const matches = content.match(/`([a-z_]+:[a-z_:-]+)`/g) ?? [];
        for (const raw of matches) {
          const key = raw.slice(1, -1);
          if (!(key in PERMISSION_REGISTRY)) {
            unknownDocPermKeys.push(`${file}: ${key}`);
          }
        }
      }
      expect(unknownDocPermKeys).toEqual([]);
    });

    it('enforces R77, R112, R125, R126, R127, R128: token-derived actorGroups, synchronous lifecycle throw persistence, multi-team org assignment, basePath prefix protection, multi-library resolution, and test hook guard', async () => {
      const store = getStore();
      const snapshotMatters = structuredClone(store.matters);
      const snapshotPeople = structuredClone(store.people);
      try {
        resetDocumentStoreSingletonsForTesting();
        const cfg = getActiveTenantConfiguration();
        const { sessions, asEmployee } = registerStoreEmployeeSessionsForTest(store);

        // R77 (1): For an employee whose stored roles map to a library-root group, with entraGroups: [] in their verified token, buildTenantContextForUser returns ctx.actorGroups equal to []
        const empWithStoredAdmin = store.people.find((p) => p.id === 'P-000004')!;
        const emptyGroupsSession = verifySignedEntraSessionCookie(
          createSignedEntraSessionCookie({
            personId: empWithStoredAdmin.id,
            tenantId: 'not-a-law-firm',
            oid: empWithStoredAdmin.entraObjectId ?? '00000000-0000-4000-8000-000000000004',
            tid: '11111111-2222-3333-4444-000000000000',
            sub: empWithStoredAdmin.id,
            email: empWithStoredAdmin.emails?.[0]?.address ?? 'huw.pritchard@notalawfirm.example',
            displayName: 'Huw Pritchard',
            entraRoles: ['admin'],
            mappedRoles: ['admin'],
            entraGroups: [],
            mfaVerified: true,
            amr: ['pwd', 'mfa'],
            authenticatedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          }),
        )!;
        const { ctx: emptyGroupsCtx } = buildTenantContextForUser(
          empWithStoredAdmin.id,
          store,
          cfg,
          { session: emptyGroupsSession },
        );
        expect(emptyGroupsCtx.actorGroups).toEqual([]);

        // R77 (2): Calling buildTenantContextForUser('P-000002', store, cfg, { session: verifiedSessionForP000001 }) throws TENANCY_ACTOR_MISMATCH
        expect(() =>
          buildTenantContextForUser('P-000002', store, cfg, {
            session: sessions.get('P-000001'),
          }),
        ).toThrow(/TENANCY_ACTOR_MISMATCH/);

        // R77 (3): Calling buildEntraSessionPayload without rawClaims.oid throws ENTRA_CLAIM_ERROR
        expect(() =>
          buildEntraSessionPayload({
            personId: 'P-000001',
            rawClaims: {
              tid: '11111111-2222-3333-4444-000000000000',
              sub: 'P-000001',
              email: 'rhian.morgan@notalawfirm.example',
              name: 'Rhian Morgan',
              roles: ['partner'],
              groups: [],
            },
            verifiedToken: {
              __verifiedByOidcMiddleware: true,
              sub: 'P-000001',
              email: 'rhian.morgan@notalawfirm.example',
              name: 'Rhian Morgan',
              tenantId: 'not-a-law-firm',
              roles: ['partner'],
              mfaVerified: true,
            },
            rbacConfig: cfg.rbac!,
          }),
        ).toThrow(/ENTRA_CLAIM_ERROR/);

        // R112: Calling saveMatterRecord when syncMatterLifecycleOnSaveSync throws synchronously still returns normally without error, persists the updated matter to data/runtime-store.json matching getStore(), and logs a JSON error containing both tenantId and correlationId
        const syncErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const runtimeStorePath = path.resolve(
          __dirname,
          '../../data/runtime-store.json',
        );
        const runtimeExistedBefore = fs.existsSync(runtimeStorePath);
        const runtimeContentBefore = runtimeExistedBefore
          ? fs.readFileSync(runtimeStorePath, 'utf8')
          : null;
        const prevVitest = process.env.VITEST;
        const prevNodeEnvForR112 = process.env.NODE_ENV;
        const prevTenantPkgDir = process.env.PLATFORM_TENANT_PACKAGE_DIR;
        try {
          // Ensure Matter M-000001 has a location and set a mismatched documentStoreConfigOverride.tenantId so syncMatterLifecycleOnSaveSync throws synchronously inside saveMatterRecord
          await asEmployee('P-000001', () =>
            ensureMatterDocumentStoreProvisioned('M-000001', 'P-000001'),
          );
          const m1 = store.matters.find((m) => m.id === 'M-000001')!;
          const updatedTitle = `R112 Persisted Title ${Date.now()}`;
          const prevDocStoreOverride = store.documentStoreConfigOverride;
          store.documentStoreConfigOverride = {
            ...(store.documentStoreConfigOverride ?? {}),
            documentStores: 'invalid-override-to-force-sync-throw' as never,
          } as never;
          delete (process.env as Record<string, string | undefined>).VITEST;
          (process.env as Record<string, string | undefined>).NODE_ENV =
            'development';
          (process.env as Record<string, string | undefined>).PLATFORM_TENANT_PACKAGE_DIR =
            'client-not-a-law-firm';
          saveStore(store);
          let saveRes: Awaited<ReturnType<typeof saveMatterRecord>>;
          try {
            saveRes = await asEmployee('P-000001', () =>
              saveMatterRecord(
                {
                  title: updatedTitle,
                  clientId: m1.clientId,
                  practiceAreaId: m1.practiceAreaId,
                  workTypeSubcategoryId: m1.workTypeSubcategoryId,
                },
                { id: 'M-000001', byId: 'P-000001' },
              ),
            );
          } finally {
            store.documentStoreConfigOverride = prevDocStoreOverride;
          }
          expect(saveRes.errors).toBeUndefined();
          expect(saveRes.matter).not.toBeNull();
          expect(saveRes.matter!.title).toBe(updatedTitle);
          expect(
            getStore().matters.find((m) => m.id === 'M-000001')?.title,
          ).toBe(updatedTitle);

          const diskStore = JSON.parse(
            fs.readFileSync(runtimeStorePath, 'utf8'),
          ) as { matters: Array<{ id: string; title: string }> };
          expect(
            diskStore.matters.find((m) => m.id === 'M-000001')?.title,
          ).toBe(updatedTitle);

          expect(
            syncErrSpy.mock.calls.some((args) => {
              const str = String(args[0] ?? '');
              return (
                str.includes('"tenantId":"not-a-law-firm"') &&
                str.includes('"correlationId":')
              );
            }),
          ).toBe(true);
        } finally {
          (process.env as Record<string, string | undefined>).VITEST =
            prevVitest;
          (process.env as Record<string, string | undefined>).NODE_ENV =
            prevNodeEnvForR112;
          if (prevTenantPkgDir === undefined) {
            delete (process.env as Record<string, string | undefined>)
              .PLATFORM_TENANT_PACKAGE_DIR;
          } else {
            (process.env as Record<string, string | undefined>).PLATFORM_TENANT_PACKAGE_DIR =
              prevTenantPkgDir;
          }
          if (runtimeExistedBefore && runtimeContentBefore !== null) {
            fs.writeFileSync(runtimeStorePath, runtimeContentBefore, 'utf8');
          } else if (!runtimeExistedBefore && fs.existsSync(runtimeStorePath)) {
            fs.unlinkSync(runtimeStorePath);
          }
          syncErrSpy.mockRestore();
        }

        // R125: For an employee with departmentId: 'DEPT-RE' (which has multiple active teams) and teamOrPracticeGroupId: undefined, resolvePersonOrgAssignment returns { departmentId: 'DEPT-RE', teamId: '' }
        const empNoTeam = structuredClone(
          store.people.find((p) => p.id === 'P-000002')!,
        );
        empNoTeam.departmentId = 'DEPT-RE';
        if (empNoTeam.employment) {
          empNoTeam.employment.departmentId = 'DEPT-RE';
          (
            empNoTeam.employment as { teamOrPracticeGroupId?: string }
          ).teamOrPracticeGroupId = undefined;
        }
        expect(resolvePersonOrgAssignment(empNoTeam, store)).toEqual({
          departmentId: 'DEPT-RE',
          teamId: '',
        });

        // R126: With a routing rule basePath: 'Archive/{departmentCode}', linkExistingMatterFolderJob with allowRoutingMismatchOverride: true and folderUrlOrPath: 'Archive' rejects with code: 'access_denied'
        const ctxAlpha = makeTenantContext({ tenantId: 'firm-alpha' });
        const multiLibStores: DocumentStoreConfig[] = [
          {
            ...makeGenericStores('alpha')[0]!,
            sharepoint: {
              hostname: 'alpha.sharepoint.com',
              siteRelativePath: '/sites/PracticeDMS',
              siteId: 'site-alpha-001',
              libraries: [
                {
                  libraryId: 'lib-secondary',
                  displayName: 'Secondary Library',
                  libraryUrlSegment: 'Secondary',
                  driveId: 'drive-alpha-secondary-001',
                },
                {
                  libraryId: 'lib-matters',
                  displayName: 'Matters',
                  libraryUrlSegment: 'Matters',
                  driveId: 'drive-alpha-matters-001',
                },
              ],
            },
          },
        ];
        const registryAlpha = new DocumentStoreProviderRegistry();
        const repoAlpha = new TenantDocumentStoreRepository();
        const archiveRoutingRules: DocumentRoutingRule[] = [
          {
            ruleId: 'rule-archive-re',
            match: { departmentId: 'DEPT-PROP' },
            storeId: 'alpha-sp-primary',
            libraryId: 'lib-matters',
            basePath: 'Archive/{departmentCode}',
          },
          {
            ruleId: 'rule-shared-re',
            match: { departmentId: 'DEPT-PROP' },
            storeId: 'alpha-sp-primary',
            libraryId: 'lib-matters',
            basePath: 'Shared/{departmentCode}',
          },
        ];
        const depsAlpha = {
          repository: repoAlpha,
          getProvider: (storeId: string) => {
            const st = multiLibStores.find((s) => s.storeId === storeId)!;
            return registryAlpha.createProvider(ctxAlpha, st);
          },
          stores: multiLibStores,
          routingRules: archiveRoutingRules,
          accessConfig: makeGenericAccessConfig(),
          templatesConfig: makeGenericTemplatesConfig(),
          matterFolderNameTemplate: '{matterNumber} - {matterDescription}',
          resolveUserEntraObjectId: (_c: TenantContext, uid: string) => ({
            entraObjectId: `oid-${uid}`,
            displayName: `User ${uid}`,
          }),
        };

        const providerAlpha = depsAlpha.getProvider('alpha-sp-primary');
        const provCtxAlpha: ProvisioningAccessContext = {
          kind: 'provisioning',
          tenantContext: ctxAlpha,
          triggeredByUserId: 'user-admin',
          triggerEvent: 'r126-r127.test',
        };
        await provisionMatterDocumentsJob({
          ctx: ctxAlpha,
          deps: depsAlpha,
          subject: makeMatterSubject({
            matterDescription: '14 High Street Purchase',
          }),
        });
        await providerAlpha.ensureFolderTree(
          provCtxAlpha,
          {
            storeId: 'alpha-sp-primary',
            libraryId: 'lib-matters',
            siteId: 'site-alpha-001',
            driveId: 'drive-alpha-matters-001',
          },
          [{ name: 'Shared', relativePath: 'Shared', children: [] }],
        );

        await expect(
          linkExistingMatterFolderJob({
            ctx: ctxAlpha,
            deps: depsAlpha,
            subject: makeMatterSubject({ matterId: 'M-1002' }),
            storeId: 'alpha-sp-primary',
            libraryId: 'lib-matters',
            folderUrlOrPath: 'Archive',
            allowRoutingMismatchOverride: true,
          }),
        ).rejects.toMatchObject({ code: 'access_denied' });

        await expect(
          linkExistingMatterFolderJob({
            ctx: ctxAlpha,
            deps: depsAlpha,
            subject: makeMatterSubject({ matterId: 'M-1002B' }),
            storeId: 'alpha-sp-primary',
            libraryId: 'lib-matters',
            folderUrlOrPath: 'Shared',
            allowRoutingMismatchOverride: true,
          }),
        ).rejects.toMatchObject({ code: 'access_denied' });

        // R127: On a store with two libraries (lib-secondary first, lib-matters second), resolveLocation with a relative path and libraryId: 'lib-matters' resolves against lib-matters, and linkExistingMatterFolderJob refuses a full URL pointing to lib-secondary when the matter routes to lib-matters
        const resolvedMattersLib = await providerAlpha.resolveLocation(
          provCtxAlpha,
          {
            storeId: 'alpha-sp-primary',
            libraryId: 'lib-matters',
            rawUrlOrPath: 'Archive/PROP/MAT-2026-0001 - 14 High Street Purchase',
          },
        );
        expect(resolvedMattersLib.libraryId).toBe('lib-matters');
        expect(resolvedMattersLib.driveId).toBe('drive-alpha-matters-001');

        await expect(
          linkExistingMatterFolderJob({
            ctx: ctxAlpha,
            deps: depsAlpha,
            subject: makeMatterSubject({ matterId: 'M-1003' }),
            storeId: 'alpha-sp-primary',
            libraryId: 'lib-matters',
            folderUrlOrPath:
              'https://alpha.sharepoint.com/sites/PracticeDMS/Secondary/Archive/PROP/MAT-2026-0001',
            allowRoutingMismatchOverride: true,
          }),
        ).rejects.toMatchObject({ code: 'invalid_path' });

        // R128: With NODE_ENV = 'production', setBeforeMatterDocumentsCloseHookForTesting and setTestEntraSessionOverride throw SECURITY_ERROR
        const prevNodeEnv = process.env.NODE_ENV;
        try {
          (process.env as Record<string, string | undefined>).NODE_ENV =
            'production';
          expect(() =>
            setBeforeMatterDocumentsCloseHookForTesting(async () => {}),
          ).toThrow(/SECURITY_ERROR/);
          expect(() => setTestEntraSessionOverride(null)).toThrow(
            /SECURITY_ERROR/,
          );
        } finally {
          (process.env as Record<string, string | undefined>).NODE_ENV =
            prevNodeEnv;
        }

        // R137: Session signed for 'tenant-a' passed to buildTenantContextForUser when config.tenantId is 'not-a-law-firm' throws TENANCY_FORGERY_DETECTED
        const carysUser = store.people.find((p) => p.id === 'P-000001')!;
        const forgedTenantCookie = createSignedEntraSessionCookie({
          personId: carysUser.id,
          tenantId: 'tenant-a',
          oid:
            carysUser.entraObjectId ??
            '00000000-0000-4000-8000-000000000001',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: carysUser.id,
          email:
            carysUser.emails[0]?.address ??
            'carys.hughes@notalawfirm.example',
          displayName: `${carysUser.firstName} ${carysUser.surname}`,
          entraRoles: ['partner'],
          mappedRoles: ['partner'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
        const verifiedForgedSession =
          verifySignedEntraSessionCookie(forgedTenantCookie)!;
        expect(() =>
          buildTenantContextForUser(
            carysUser.id,
            store,
            getActiveTenantConfiguration(),
            { session: verifiedForgedSession },
          ),
        ).toThrow(/TENANCY_FORGERY_DETECTED/);

        // Helper for authenticated request sessions on store employees
        const runAsStoreEmployee = <T>(
          personId: string,
          fn: () => T,
          opts?: { mfaVerified?: boolean; rolesOverride?: string[] },
        ): T => {
          const emp = store.people.find((p) => p.id === personId)!;
          const expiresAt = new Date(Date.now() + 3600_000).toISOString();
          const roles = opts?.rolesOverride ?? emp.roles ?? ['fee_earner'];
          const verified = verifySignedEntraSessionCookie(
            createSignedEntraSessionCookie({
              personId: emp.id,
              tenantId: 'not-a-law-firm',
              oid:
                emp.entraObjectId ??
                `00000000-0000-4000-8000-${emp.id.replace(/\D/g, '').padStart(12, '0')}`,
              tid: '11111111-2222-3333-4444-000000000000',
              sub: emp.id,
              email:
                emp.emails[0]?.address ??
                `${emp.id.toLowerCase()}@notalawfirm.example`,
              displayName: `${emp.firstName} ${emp.surname}`,
              entraRoles: roles,
              mappedRoles: roles,
              entraGroups: [],
              mfaVerified: opts?.mfaVerified ?? true,
              amr: (opts?.mfaVerified ?? true) ? ['pwd', 'mfa'] : ['pwd'],
              authenticatedAt: new Date().toISOString(),
              expiresAt,
            }),
          )!;
          return runWithActiveActorSession(
            {
              personId: emp.id,
              tenantId: 'not-a-law-firm',
              tokenRoles: roles,
              expiresAtMs: Date.parse(expiresAt),
              verifiedSession: verified,
            },
            fn,
          );
        };

        const openMatter = store.matters.find(
          (m) => !m.isStaffMatter && !m.hasEthicalWall,
        )!;

        // R143 (1) & R133: User who can access the matter (P-000009 finance) but lacks matter:edit gets { matter: null, errors: { permission: ... } }
        const noEditPermRes = await runAsStoreEmployee('P-000009', () =>
          saveMatterRecord(
            { ...openMatter, title: 'Finance Cannot Edit' },
            { id: openMatter.id, byId: 'P-000009' },
          ),
        );
        expect(noEditPermRes.matter).toBeNull();
        expect(noEditPermRes.errors?.permission).toMatch(/matter:edit/i);

        // R138: Passing an existing matter object with `id` into saveMatterRecord without `opts.id` returns errors.id and matter: null without creating a duplicate
        const matterCountBeforeMissingId = store.matters.length;
        const missingIdOptsRes = await runAsStoreEmployee('P-000001', () =>
          saveMatterRecord(
            { ...openMatter, title: 'Missing opts.id' },
            { byId: 'P-000001' },
          ),
        );
        expect(missingIdOptsRes.matter).toBeNull();
        expect(missingIdOptsRes.errors?.id).toMatch(/opts\.id/i);
        expect(store.matters.length).toBe(matterCountBeforeMissingId);

        // R138 (b): markEngagementLetterDrafted updates only engagementLetterStatus: 'Drafted' on the existing matter
        const draftedRes = runAsStoreEmployee('P-000001', () =>
          markEngagementLetterDrafted(openMatter.id, 'P-000001'),
        );
        expect(draftedRes.errors).toBeUndefined();
        expect(draftedRes.matter?.id).toBe(openMatter.id);
        expect(draftedRes.matter?.engagementLetterStatus).toBe('Drafted');

        // R134: Editing title on an existing matter whose owningDepartmentId/owningTeamId was archived succeeds; changing to an archived department/team fails
        const targetDept = store.orgStructure!.departments.find(
          (d) => d.id === openMatter.owningDepartmentId,
        )!;
        const targetTeam = store.orgStructure!.teamsOrPracticeGroups.find(
          (g) => g.id === openMatter.owningTeamId,
        )!;
        const otherInactiveDept = store.orgStructure!.departments.find(
          (d) => d.id !== openMatter.owningDepartmentId,
        )!;
        const prevDeptActive = targetDept.active;
        const prevTeamActive = targetTeam.active;
        const prevOtherDeptActive = otherInactiveDept.active;
        try {
          targetDept.active = false;
          targetTeam.active = false;
          otherInactiveDept.active = false;

          const legacyDeptTitleSave = await runAsStoreEmployee('P-000001', () =>
            saveMatterRecord(
              {
                ...openMatter,
                title: `${openMatter.title} (Updated on Legacy Archived Dept)`,
              },
              { id: openMatter.id, byId: 'P-000001' },
            ),
          );
          expect(legacyDeptTitleSave.errors).toBeUndefined();
          expect(legacyDeptTitleSave.matter?.title).toContain(
            '(Updated on Legacy Archived Dept)',
          );

          const changeToArchivedDeptSave = await runAsStoreEmployee(
            'P-000001',
            () =>
              saveMatterRecord(
                {
                  ...openMatter,
                  owningDepartmentId: otherInactiveDept.id,
                },
                { id: openMatter.id, byId: 'P-000001' },
              ),
          );
          expect(changeToArchivedDeptSave.matter).toBeNull();
          expect(
            changeToArchivedDeptSave.errors?.owningDepartmentId,
          ).toBeDefined();
        } finally {
          targetDept.active = prevDeptActive;
          targetTeam.active = prevTeamActive;
          otherInactiveDept.active = prevOtherDeptActive;
        }

        // R136 (a1): updateMatterConflictRecord requires matter:edit even when the user IS on the matter (canPersonAccessMatter === true) and holds risk:view
        const onMatterFeeEarner = store.people.find((p) => p.id === 'P-000002')!;
        const prevTeamMemberIds = [...(openMatter.teamMemberIds ?? [])];
        const prevOverrides = onMatterFeeEarner.permissionOverrides;
        try {
          if (!openMatter.teamMemberIds.includes('P-000002')) {
            openMatter.teamMemberIds = [...openMatter.teamMemberIds, 'P-000002'];
          }
          onMatterFeeEarner.permissionOverrides = {
            grant: ['risk:view'],
            revoke: ['matter:edit'],
          };
          const riskViewOnlyOnMatterRes = runAsStoreEmployee('P-000002', () =>
            updateMatterConflictRecord(
              openMatter.id,
              {
                status: 'Cleared',
                outcomeLabel: 'Cleared by fee earner',
                declarationConfirmed: true,
                reviewerMessage: '',
                lastRunAtDisplay: '2026-11-01',
                lastRunById: 'P-000002',
                lastRunByName: 'Owain Pritchard',
                parties: [],
                matches: [],
                runs: [],
                comments: [],
              },
              'P-000002',
            ),
          );
          expect(riskViewOnlyOnMatterRes.matter).toBeNull();
        } finally {
          openMatter.teamMemberIds = prevTeamMemberIds;
          onMatterFeeEarner.permissionOverrides = prevOverrides;
        }

        // R136 (b) & R135: Permitted user saves an information_barrier match -> hasEthicalWall becomes true; liftMatterRestriction enforces matter:restriction:lift (refusing partner), MFA, and reason, writes matter-restriction-lift audit, and persists across subsequent saves until a new barrier match is added
        const barrierRes = runAsStoreEmployee(
          'P-000001',
          () =>
            updateMatterConflictRecord(
              openMatter.id,
              {
                status: 'Approved',
                outcomeLabel: 'Approved with conditions',
                declarationConfirmed: true,
                reviewerMessage: '',
                lastRunAtDisplay: '2026-11-01',
                lastRunById: 'P-000001',
                lastRunByName: 'Carys Hughes',
                parties: [],
                matches: [
                  {
                    id: 'CM-BARRIER-1',
                    partyId: 'pt-1',
                    partyName: 'Barrier Party',
                    matchedRecordId: openMatter.clientId,
                    matchedRecordName: 'Barrier Party',
                    matchedRecordType: 'organisation',
                    strength: 'Exact',
                    whereFound: 'Matter',
                    responsiblePartnerId: 'P-000001',
                    responsiblePartnerName: 'Carys Hughes',
                    dateLabel: '2026-11-01',
                    disposition: 'potential_conflict',
                    note: 'Prior instruction',
                    reviewerDecision: 'approve_with_conditions',
                    reviewerConditionType: 'information_barrier',
                    reviewerNote: 'Ethical wall established',
                  },
                ],
                runs: [],
                comments: [],
              },
              'P-000001',
            ),
          { rolesOverride: ['partner', 'risk_compliance'] },
        );
        expect(barrierRes.matter?.hasEthicalWall).toBe(true);

        // R136 (a2): updateMatterConflictRecord also requires canPersonAccessMatter even when the user holds matter:edit (P-000006 is a fee earner with matter:edit who is outside openMatter's ethical wall)
        expect(openMatter.restrictedAccessUserIds).not.toContain('P-000006');
        const matterEditButNotOnRestrictedMatterRes = runAsStoreEmployee(
          'P-000006',
          () =>
            updateMatterConflictRecord(
              openMatter.id,
              {
                status: 'Cleared',
                outcomeLabel: 'Cleared by fee earner',
                declarationConfirmed: true,
                reviewerMessage: '',
                lastRunAtDisplay: '2026-11-01',
                lastRunById: 'P-000006',
                lastRunByName: 'Outside Fee Earner',
                parties: [],
                matches: [],
                runs: [],
                comments: [],
              },
              'P-000006',
            ),
          { rolesOverride: ['fee_earner'] },
        );
        expect(matterEditButNotOnRestrictedMatterRes.matter).toBeNull();

        // Lifting by a fee earner (P-000002) or a standard partner (P-000001 with ['partner'] only) is refused because matter:restriction:lift is granted only to managing_partner, risk_compliance, and admin
        const liftFeeEarner = runAsStoreEmployee('P-000002', () =>
          liftMatterRestriction(
            openMatter.id,
            'ethical_wall',
            'Attempt by fee earner',
            'P-000002',
          ),
        );
        expect(liftFeeEarner.matter).toBeNull();
        expect(liftFeeEarner.errors?.permission).toMatch(
          /matter:restriction:lift/,
        );

        const carysEmp = store.people.find((p) => p.id === 'P-000001')!;
        const prevCarysRoles = [...(carysEmp.roles ?? [])];
        try {
          carysEmp.roles = ['partner'];
          const liftPartnerOnly = runAsStoreEmployee(
            'P-000001',
            () =>
              liftMatterRestriction(
                openMatter.id,
                'ethical_wall',
                'Attempt by standard partner without managing_partner/risk_compliance',
                'P-000001',
              ),
            { rolesOverride: ['partner'], mfaVerified: true },
          );
          expect(liftPartnerOnly.matter).toBeNull();
          expect(liftPartnerOnly.errors?.permission).toMatch(
            /matter:restriction:lift/,
          );
        } finally {
          carysEmp.roles = prevCarysRoles;
        }

        // Lifting without MFA (P-000003 risk_compliance with mfaVerified: false) is refused
        const liftNoMfa = runAsStoreEmployee(
          'P-000003',
          () =>
            liftMatterRestriction(
              openMatter.id,
              'ethical_wall',
              'Attempt without MFA',
              'P-000003',
            ),
          { rolesOverride: ['risk_compliance'], mfaVerified: false },
        );
        expect(liftNoMfa.matter).toBeNull();
        expect(liftNoMfa.errors?.mfa).toMatch(/MFA_REQUIRED/);

        // Lifting with matter:restriction:lift (P-000003 risk_compliance), MFA, and non-empty reason clears hasEthicalWall and records matter-restriction-lift audit
        const liftOk = runAsStoreEmployee(
          'P-000003',
          () =>
            liftMatterRestriction(
              openMatter.id,
              'ethical_wall',
              'Counterparty instruction concluded and COLP approved lifting barrier',
              'P-000003',
            ),
          { rolesOverride: ['risk_compliance'], mfaVerified: true },
        );
        expect(liftOk.errors).toBeUndefined();
        expect(liftOk.matter?.hasEthicalWall).toBe(false);
        expect(
          liftOk.matter?.restrictionLift?.ethicalWall?.liftedBarrierMatchIds,
        ).toContain('CM-BARRIER-1');
        expect(
          store.audit.some(
            (a) =>
              a.recordId === openMatter.id &&
              a.action === 'matter-restriction-lift',
          ),
        ).toBe(true);

        // Subsequent saveMatterRecord editing the matter's title preserves hasEthicalWall === false
        const postLiftSave = await runAsStoreEmployee('P-000001', () =>
          saveMatterRecord(
            {
              ...openMatter,
              title: `${openMatter.title} (Title edited after lift)`,
            },
            { id: openMatter.id, byId: 'P-000001' },
          ),
        );
        expect(postLiftSave.errors).toBeUndefined();
        expect(postLiftSave.matter?.hasEthicalWall).toBe(false);

        // Adding a NEW information_barrier match ID (CM-BARRIER-2) reinstates hasEthicalWall === true
        const newBarrierRes = runAsStoreEmployee(
          'P-000001',
          () =>
            updateMatterConflictRecord(
              openMatter.id,
              {
                ...(openMatter.conflictCheckRecord!),
                matches: [
                  ...(openMatter.conflictCheckRecord?.matches ?? []),
                  {
                    id: 'CM-BARRIER-2',
                    partyId: 'pt-2',
                    partyName: 'Second Barrier Party',
                    matchedRecordId: openMatter.clientId,
                    matchedRecordName: 'Second Barrier Party',
                    matchedRecordType: 'organisation',
                    strength: 'Exact',
                    whereFound: 'Matter',
                    responsiblePartnerId: 'P-000001',
                    responsiblePartnerName: 'Carys Hughes',
                    dateLabel: '2026-11-04',
                    disposition: 'potential_conflict',
                    note: 'New conflicting instruction',
                    reviewerDecision: 'approve_with_conditions',
                    reviewerConditionType: 'information_barrier',
                    reviewerNote: 'New ethical wall required',
                  },
                ],
              },
              'P-000001',
            ),
          { rolesOverride: ['partner', 'risk_compliance'] },
        );
        expect(newBarrierRes.matter?.hasEthicalWall).toBe(true);
      } finally {
        store.matters = snapshotMatters;
        store.people = snapshotPeople;
        saveStore(store);
        resetDocumentStoreSingletonsForTesting();
      }
    });
  });

  describe('7. Least-Privilege Sites.Selected, Health Check, and Scope Guard (R190–R203)', () => {
    it('R190 & R191: validates the §3.1 DocumentStoreConfig example unchanged, preserves v1.x Files.ReadWrite.All fallback with deprecation warning, and leaves siteId optional', () => {
      // R190: Exact §3.1 DocumentStoreConfig example passes validateTenantConfig unchanged
      const section31ExampleConfig = {
        storeId: 'primary-sharepoint',
        displayName: 'Primary Matter Document Store',
        providerType: 'sharepoint',
        isDefault: true,
        enabled: true,
        auth: {
          entraTenantId: '11111111-2222-3333-4444-555555555555',
          credentialMode: 'client_certificate',
          clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          certificateKeyVaultSecretRef:
            'kv://kv-tenant-prod/sp-provisioning-cert',
          delegatedPermissionScope: 'Sites.Selected',
        },
        sharepoint: {
          hostname: 'contoso.sharepoint.com',
          siteRelativePath: '/sites/LegalMatters',
          siteId:
            'contoso.sharepoint.com,22222222-3333-4444-5555-666666666666,77777777-8888-9999-aaaa-bbbbbbbbbbbb',
          libraries: [
            {
              libraryId: 'matters-active',
              displayName: 'Active Matters',
              libraryUrlSegment: 'Active Matters',
              driveId: 'b!exampleDriveId001',
            },
          ],
        },
      };
      const validation = validateDocumentStoreConfig(section31ExampleConfig);
      expect(validation.store.storeId).toBe('primary-sharepoint');
      expect(validation.store.auth.delegatedPermissionScope).toBe(
        'Sites.Selected',
      );
      expect(validation.deprecationWarnings).toEqual([]);

      // Store omitting delegatedPermissionScope returns Files.ReadWrite.All default and 1 deprecation warning
      const storeWithoutScopeValidation = validateDocumentStoreConfig({
        ...section31ExampleConfig,
        auth: {
          entraTenantId: section31ExampleConfig.auth.entraTenantId,
          credentialMode: section31ExampleConfig.auth.credentialMode,
          clientId: section31ExampleConfig.auth.clientId,
          certificateKeyVaultSecretRef:
            section31ExampleConfig.auth.certificateKeyVaultSecretRef,
        },
      });
      expect(
        storeWithoutScopeValidation.store.auth.delegatedPermissionScope,
      ).toBe('Files.ReadWrite.All');
      expect(storeWithoutScopeValidation.deprecationWarnings).toHaveLength(1);

      // Store with an unknown key (e.g. auth.permissionMode) throws
      expect(() =>
        validateDocumentStoreConfig({
          ...section31ExampleConfig,
          auth: {
            ...section31ExampleConfig.auth,
            permissionMode: 'Sites.Selected',
          },
        }),
      ).toThrow();

      // R191: Config omitting delegatedPermissionScope and sharepoint.siteId loads with v1.x default "Files.ReadWrite.All" and emits a ConfigDeprecationWarning
      const rawBase = JSON.parse(
        fs.readFileSync(
          path.resolve(
            __dirname,
            '../../client-not-a-law-firm/config/base.json',
          ),
          'utf-8',
        ),
      ) as Record<string, unknown>;

      // R202: client-not-a-law-firm/config/base.json explicitly sets Sites.Selected and emits zero delegatedPermissionScope warnings
      const baseWarnings = collectStructuredConfigDeprecationWarnings(rawBase);
      expect(
        baseWarnings.filter((w) =>
          w.path.includes('delegatedPermissionScope'),
        ),
      ).toEqual([]);

      const legacyConfigWithoutScope: Record<string, unknown> = structuredClone(
        rawBase,
      );
      const stores = legacyConfigWithoutScope.documentStores as Array<
        Record<string, unknown>
      >;
      const firstAuth = { ...(stores[0]!.auth as Record<string, unknown>) };
      delete firstAuth.delegatedPermissionScope;
      const firstSp = { ...(stores[0]!.sharepoint as Record<string, unknown>) };
      delete firstSp.siteId;
      stores[0] = { ...stores[0]!, auth: firstAuth, sharepoint: firstSp };

      const loadedLegacy = loadAndValidateTenantConfig(legacyConfigWithoutScope);
      expect(
        loadedLegacy.documentStores?.[0]?.auth.delegatedPermissionScope,
      ).toBe('Files.ReadWrite.All');
      expect(loadedLegacy.documentStores?.[0]?.sharepoint?.siteId).toBeUndefined();

      const structuredWarnings = collectStructuredConfigDeprecationWarnings(
        legacyConfigWithoutScope,
      );
      const scopeWarning = structuredWarnings.find((w) =>
        w.path.includes('delegatedPermissionScope'),
      );
      expect(scopeWarning).toBeDefined();
      expect(scopeWarning?.path).toBe(
        'documentStores[0].auth.delegatedPermissionScope',
      );
      expect(scopeWarning?.replacementPath).toContain('Sites.Selected');

      const withWarnings = validateTenantConfigWithWarnings(
        legacyConfigWithoutScope,
      );
      expect(
        withWarnings.config.documentStores?.[0]?.auth.delegatedPermissionScope,
      ).toBe('Files.ReadWrite.All');
      expect(
        withWarnings.deprecationWarnings.some((w: string) =>
          w.includes('Files.ReadWrite.All'),
        ),
      ).toBe(true);
    });

    it('R192: fails closed when any broad SharePoint/Files permission is present in roles or scp under Sites.Selected and never logs token values', async () => {
      const logSpy = vi.spyOn(console, 'log');
      const warnSpy = vi.spyOn(console, 'warn');
      const errorSpy = vi.spyOn(console, 'error');
      try {
        const ctxA = makeTenantContext({ tenantId: 'firm-alpha' });
        const storeConfig: DocumentStoreConfig = {
          ...makeGenericStores('alpha')[0]!,
          auth: {
            ...makeGenericStores('alpha')[0]!.auth,
            delegatedPermissionScope: 'Sites.Selected',
          },
        };

        const backend = new MockSharePointGraphBackend();
        const makeTokenService = (
          appRoles: readonly string[],
          delegatedScopes: readonly string[],
        ) =>
          new DocumentStoreTokenService({
            cache: new TenantScopedEncryptedTokenCache(),
            appTokenHandler: async (input) => ({
              accessToken: encodeMockTokenWithClaims(
                `app_tok_${input.tenantId}_${input.storeId}_graph`,
                {
                  roles: [...appRoles],
                },
              ),
              expiresInSeconds: 3600,
            }),
            oboExchangeHandler: async (input) => ({
              accessToken: encodeMockTokenWithClaims(
                `obo_tok_${input.tenantId}_${input.storeId}_${input.entraObjectId}_${input.scope}`,
                {
                  scp: delegatedScopes.join(' '),
                },
              ),
              expiresInSeconds: 3600,
            }),
          });

        const provCtx: ProvisioningAccessContext = {
          kind: 'provisioning',
          tenantContext: ctxA,
          triggerEvent: 'test.r192',
        };
        const userCtx: UserAccessContext = {
          kind: 'user',
          tenantContext: ctxA,
          actorUserId: ctxA.actorId,
          entraObjectId: ctxA.entraObjectId!,
          userUpn: ctxA.actorUpn,
          userAssertionToken: 'secret-user-jwt-assertion-do-not-log',
        };

        // 1. Sites.Selected alone succeeds
        const okProvider = new SharePointDocumentStoreProvider({
          tenantContext: ctxA,
          storeConfig,
          tokenService: makeTokenService(['Sites.Selected'], ['Sites.Selected']),
          backend,
        });
        const okHealth = await okProvider.testConnection(provCtx);
        expect(okHealth.ok).toBe(true);
        expect(okHealth.roleVerificationStatus).toBe('verified');

        // 2. Each forbidden broad permission in app roles or delegated scp fails closed with excess_permissions_consented
        for (const broadPerm of FORBIDDEN_BROAD_SHAREPOINT_PERMISSIONS) {
          backend.clearStoreHealthResults();
          const badAppProvider = new SharePointDocumentStoreProvider({
            tenantContext: ctxA,
            storeConfig,
            tokenService: makeTokenService(
              ['Sites.Selected', broadPerm],
              ['Sites.Selected'],
            ),
            backend,
          });

          const badAppHealth = await badAppProvider.testConnection(provCtx);
          expect(badAppHealth.ok).toBe(false);
          expect(badAppHealth.errorCode).toBe('misconfigured');
          expect(badAppHealth.errorReasonCode).toBe(
            'excess_permissions_consented',
          );
          expect(badAppHealth.errorReason).toContain(broadPerm);

          backend.clearStoreHealthResults();
          const badOboProvider = new SharePointDocumentStoreProvider({
            tenantContext: ctxA,
            storeConfig,
            tokenService: makeTokenService(
              ['Sites.Selected'],
              ['Sites.Selected', broadPerm],
            ),
            backend,
          });

          let caughtUserError: unknown;
          try {
            await badOboProvider.listItems(userCtx, {
              storeId: storeConfig.storeId,
              libraryId: 'lib-matters',
              siteId: 'site-alpha-001',
              driveId: 'drive-alpha-matters',
            });
          } catch (err) {
            caughtUserError = err;
          }
          expect(caughtUserError).toMatchObject({
            code: 'misconfigured',
            reason: 'excess_permissions_consented',
          });
          expect(normaliseDocumentStoreError(caughtUserError).userMessage).toBe(
            GENERIC_USER_DOCUMENT_STORE_UNAVAILABLE_MESSAGE,
          );
        }

        // 3. Cached OBO token path: verify both repeated acquisition and pre-cached excess-scope tokens fail closed on every call
        const excessOboService = makeTokenService(
          ['Sites.Selected'],
          ['Sites.Selected', 'Files.ReadWrite.All'],
        );
        for (let attempt = 0; attempt < 2; attempt++) {
          await expect(
            excessOboService.acquireDelegatedUserToken({
              accessContext: userCtx,
              storeId: storeConfig.storeId,
              authConfig: storeConfig.auth,
            }),
          ).rejects.toMatchObject({
            code: 'misconfigured',
            reason: 'excess_permissions_consented',
          });
        }

        const preCachedTokenCache = new TenantScopedEncryptedTokenCache();
        preCachedTokenCache.putUserToken({
          ctx: ctxA,
          entraObjectId: userCtx.entraObjectId,
          storeId: storeConfig.storeId,
          scope: 'Sites.Selected',
          accessToken: encodeMockTokenWithClaims('obo_tok_precached_excess', {
            scp: 'Sites.Selected Files.ReadWrite.All',
          }),
          expiresInSeconds: 3600,
        });
        const preCachedService = new DocumentStoreTokenService({
          cache: preCachedTokenCache,
        });
        for (let attempt = 0; attempt < 2; attempt++) {
          await expect(
            preCachedService.acquireDelegatedUserToken({
              accessContext: userCtx,
              storeId: storeConfig.storeId,
              authConfig: storeConfig.auth,
            }),
          ).rejects.toMatchObject({
            code: 'misconfigured',
            reason: 'excess_permissions_consented',
          });
        }

        // Verify no token values were logged
        const allLogged = [
          ...logSpy.mock.calls.flat(),
          ...warnSpy.mock.calls.flat(),
          ...errorSpy.mock.calls.flat(),
        ]
          .map(String)
          .join(' ');
        expect(allLogged).not.toContain('secret-user-jwt-assertion-do-not-log');
        expect(allLogged).not.toContain('obo_tok_');
        expect(allLogged).not.toContain('app_tok_');
      } finally {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it('R194, R195, R197, R198: enforces tri-state role verification (403 -> not_verified warning), tenant-scoped health caching, and generic British English user error message', async () => {
      const ctxA = makeTenantContext({ tenantId: 'firm-alpha' });
      const ctxB = makeTenantContext({
        tenantId: 'firm-beta',
        entraTenantId: 'entra-beta-001',
        entraObjectId: 'oid-beta-001',
      });
      const storeA: DocumentStoreConfig = {
        ...makeGenericStores('alpha')[0]!,
        auth: {
          ...makeGenericStores('alpha')[0]!.auth,
          delegatedPermissionScope: 'Sites.Selected',
        },
      };
      const storeB: DocumentStoreConfig = {
        ...makeGenericStores('beta')[0]!,
        auth: {
          ...makeGenericStores('beta')[0]!.auth,
          delegatedPermissionScope: 'Sites.Selected',
        },
      };

      const backend = new MockSharePointGraphBackend();
      const tokenService = new DocumentStoreTokenService({
        cache: new TenantScopedEncryptedTokenCache(),
      });
      const providerA = new SharePointDocumentStoreProvider({
        tenantContext: ctxA,
        storeConfig: storeA,
        tokenService,
        backend,
      });
      const providerB = new SharePointDocumentStoreProvider({
        tenantContext: ctxB,
        storeConfig: storeB,
        tokenService,
        backend,
      });

      const provCtxA: ProvisioningAccessContext = {
        kind: 'provisioning',
        tenantContext: ctxA,
        triggerEvent: 'test.r194',
      };
      const userCtxA: UserAccessContext = {
        kind: 'user',
        tenantContext: ctxA,
        actorUserId: ctxA.actorId,
        entraObjectId: ctxA.entraObjectId!,
        userUpn: ctxA.actorUpn,
        userAssertionToken: 'assertion-alpha',
      };

      // R194: When GET /sites/{siteId}/permissions returns 403, report roleVerificationStatus: 'not_verified' with warning and permissionManagementSupported: false
      backend.setSimulateSitePermissionsReadForbidden({
        tenantId: ctxA.tenantId,
        storeId: storeA.storeId,
        siteId: 'site-alpha-001',
        forbidden: true,
      });
      const unverifiedRes = await providerA.testConnection(provCtxA);
      expect(unverifiedRes.ok).toBe(true);
      expect(unverifiedRes.roleVerificationStatus).toBe('not_verified');
      expect(unverifiedRes.checks.permissionManagementSupported).toBe(false);
      expect(unverifiedRes.warnings?.length).toBeGreaterThan(0);

      // Reset 403 simulation and test insufficient grant role ('write' instead of 'fullcontrol')
      backend.setSimulateSitePermissionsReadForbidden({
        tenantId: ctxA.tenantId,
        storeId: storeA.storeId,
        siteId: 'site-alpha-001',
        forbidden: false,
      });
      backend.setSitePermissionGrant({
        tenantId: ctxA.tenantId,
        storeId: storeA.storeId,
        siteId: 'site-alpha-001',
        role: 'write',
      });
      const insufficientRes = await providerA.testConnection(provCtxA);
      expect(insufficientRes.ok).toBe(false);
      expect(insufficientRes.errorCode).toBe('access_denied');
      expect(insufficientRes.errorReasonCode).toBe(
        'site_grant_role_insufficient',
      );
      expect(insufficientRes.roleVerificationStatus).toBe('insufficient');

      // R195: Cached failed health check causes subsequent user and provisioning operations on Tenant A to fail closed
      await expect(
        providerA.listItems(userCtxA, {
          storeId: storeA.storeId,
          libraryId: 'lib-matters',
          siteId: 'site-alpha-001',
          driveId: 'drive-alpha-matters',
        }),
      ).rejects.toMatchObject({
        code: 'access_denied',
        reason: 'site_grant_role_insufficient',
        message: GENERIC_USER_DOCUMENT_STORE_UNAVAILABLE_MESSAGE,
      });

      // R195: Tenant A's failed health cache never affects Tenant B
      const provCtxB: ProvisioningAccessContext = {
        kind: 'provisioning',
        tenantContext: ctxB,
        triggerEvent: 'test.r195.b',
      };
      const bHealth = await providerB.testConnection(provCtxB);
      expect(bHealth.ok).toBe(true);

      // R195: Scheduled health check job refuses to run without a valid tenantId
      await expect(
        runTenantSharePointHealthCheckJob({
          tenantId: '',
          tenantContext: ctxA,
          stores: [storeA],
          tokenService,
          backend,
        }),
      ).rejects.toThrow(/TENANCY_JOB_ERROR/);

      // R198: When site grant is 'none', admin sees diagnostic siteId, while non-admin user sees only generic British English message with zero GUIDs or hostnames
      backend.setSitePermissionGrant({
        tenantId: ctxA.tenantId,
        storeId: storeA.storeId,
        siteId: 'site-alpha-001',
        role: 'none',
      });
      const noGrantHealth = await runTenantSharePointHealthCheckJob({
        tenantId: ctxA.tenantId,
        tenantContext: ctxA,
        stores: [storeA],
        tokenService,
        backend,
      });
      expect(noGrantHealth[0]?.ok).toBe(false);
      expect(noGrantHealth[0]?.errorCode).toBe('access_denied');
      expect(noGrantHealth[0]?.errorReasonCode).toBe('site_access_not_granted');
      expect(noGrantHealth[0]?.errorReason).toContain(
        'SharePoint access not granted for site "site-alpha-001"',
      );

      try {
        await providerA.listItems(userCtxA, {
          storeId: storeA.storeId,
          libraryId: 'lib-matters',
          siteId: 'site-alpha-001',
          driveId: 'drive-alpha-matters',
        });
        expect.unreachable('Expected listItems to fail closed');
      } catch (err) {
        const normalised = normaliseDocumentStoreError(err);
        expect(normalised.code).toBe('access_denied');
        expect(normalised.reason).toBe('site_access_not_granted');
        expect(normalised.userMessage).toBe(
          'Documents for this matter are unavailable. Please contact your administrator.',
        );
        expect(normalised.userMessage).not.toContain('site-alpha-001');
        expect(normalised.userMessage).not.toContain('alpha.sharepoint.com');
        expect(normalised.userMessage).not.toContain('app-alpha-001');
      }
    });

    it('R196 & R201: rejects tampered siteId, tampered driveId, and cross-tenant siteId before backend.recordCall, and enforces the /search/query ban', async () => {
      const ctxA = makeTenantContext({ tenantId: 'firm-alpha' });
      const storeA: DocumentStoreConfig = {
        ...makeGenericStores('alpha')[0]!,
        auth: {
          ...makeGenericStores('alpha')[0]!.auth,
          delegatedPermissionScope: 'Sites.Selected',
        },
      };
      const backend = new MockSharePointGraphBackend();
      const tokenService = new DocumentStoreTokenService({
        cache: new TenantScopedEncryptedTokenCache(),
      });
      const providerA = new SharePointDocumentStoreProvider({
        tenantContext: ctxA,
        storeConfig: storeA,
        tokenService,
        backend,
      });
      const provCtxA: ProvisioningAccessContext = {
        kind: 'provisioning',
        tenantContext: ctxA,
        triggerEvent: 'test.r196',
      };
      const userCtxA: UserAccessContext = {
        kind: 'user',
        tenantContext: ctxA,
        actorUserId: ctxA.actorId,
        entraObjectId: ctxA.entraObjectId!,
        userUpn: ctxA.actorUpn,
        userAssertionToken: 'assertion-alpha',
      };

      backend.clearCallLog();

      // (a) Tampered siteId rejected before backend.recordCall
      await expect(
        providerA.listItems(userCtxA, {
          storeId: storeA.storeId,
          libraryId: 'lib-matters',
          siteId: 'site-tampered-999',
          driveId: 'drive-alpha-matters',
        }),
      ).rejects.toMatchObject({
        code: 'access_denied',
        reason: 'site_or_drive_mismatch',
      });
      expect(backend.getCallLog()).toHaveLength(0);

      // (b) Tampered driveId rejected before backend.recordCall
      await expect(
        providerA.getItem(userCtxA, {
          storeId: storeA.storeId,
          siteId: 'site-alpha-001',
          driveId: 'drive-tampered-999',
          itemId: 'root',
        }),
      ).rejects.toMatchObject({
        code: 'access_denied',
        reason: 'site_or_drive_mismatch',
      });
      expect(backend.getCallLog()).toHaveLength(0);

      // (c) Tenant B's real siteId ('site-beta-001') sent from Tenant A rejected before backend.recordCall
      await expect(
        providerA.ensureFolderTree(
          provCtxA,
          {
            storeId: storeA.storeId,
            libraryId: 'lib-matters',
            siteId: 'site-beta-001',
            driveId: 'drive-alpha-matters',
          },
          [{ name: '01 Client Care', relativePath: '01 Client Care' }],
        ),
      ).rejects.toMatchObject({
        code: 'access_denied',
        reason: 'site_or_drive_mismatch',
      });
      expect(backend.getCallLog()).toHaveLength(0);

      // R201: Static check that sharepointProvider.ts never uses /search/query
      const providerSource = fs.readFileSync(
        path.resolve(
          __dirname,
          '../src/integrations/document-stores/sharepointProvider.ts',
        ),
        'utf-8',
      );
      expect(providerSource).not.toContain('/search/query');
    });

    it('R203: requires mfaVerified === true and writes a config:stores:updated audit entry when changing delegatedPermissionScope', () => {
      const store = getStore();
      const prevOverride = store.documentStoreConfigOverride;
      try {
        const cfg = getActiveTenantConfiguration();
        const adminEmp = store.people.find((p) => p.id === 'P-000001')!;
        if (!adminEmp.entraObjectId) {
          adminEmp.entraObjectId = '00000000-0000-4000-8000-000000000001';
        }
        const adminSessionMfa = verifySignedEntraSessionCookie(
          createSignedEntraSessionCookie({
            personId: adminEmp.id,
            tenantId: cfg.tenantId,
            oid: adminEmp.entraObjectId,
            tid: '00000000-0000-4000-8000-000000000000',
            sub: adminEmp.id,
            email:
              adminEmp.emails?.[0]?.address ?? 'carys@notalawfirm.example',
            displayName: `${adminEmp.firstName} ${adminEmp.surname}`,
            entraRoles: ['managing_partner', 'admin'],
            mappedRoles: ['managing_partner', 'admin'],
            entraGroups: [],
            mfaVerified: true,
            amr: ['pwd', 'mfa'],
            authenticatedAt: '2026-11-05T10:00:00Z',
            expiresAt: '2099-11-05T18:00:00Z',
          }),
        )!;
        const adminSessionNoMfa = verifySignedEntraSessionCookie(
          createSignedEntraSessionCookie({
            personId: adminEmp.id,
            tenantId: cfg.tenantId,
            oid: adminEmp.entraObjectId,
            tid: '00000000-0000-4000-8000-000000000000',
            sub: adminEmp.id,
            email:
              adminEmp.emails?.[0]?.address ?? 'carys@notalawfirm.example',
            displayName: `${adminEmp.firstName} ${adminEmp.surname}`,
            entraRoles: ['managing_partner', 'admin'],
            mappedRoles: ['managing_partner', 'admin'],
            entraGroups: [],
            mfaVerified: false,
            amr: ['pwd'],
            authenticatedAt: '2026-11-05T10:00:00Z',
            expiresAt: '2099-11-05T18:00:00Z',
          }),
        )!;

        const dash = runWithActiveActorSession(
          {
            personId: adminEmp.id,
            tenantId: cfg.tenantId,
            tokenRoles: adminSessionMfa.mappedRoles,
            expiresAtMs: Date.parse(adminSessionMfa.expiresAt),
            verifiedSession: adminSessionMfa,
          },
          () =>
            getDocumentStoresAdminDashboard('P-000001', {
              session: adminSessionMfa,
              mfaVerified: true,
            }),
        );
        const updatedStores = dash.config.documentStores.map((ds) => ({
          ...ds,
          auth: {
            ...ds.auth,
            delegatedPermissionScope: 'Sites.Selected' as const,
          },
        }));

        // Without MFA, saving store config is rejected
        expect(() =>
          runWithActiveActorSession(
            {
              personId: adminEmp.id,
              tenantId: cfg.tenantId,
              tokenRoles: adminSessionNoMfa.mappedRoles,
              expiresAtMs: Date.parse(adminSessionNoMfa.expiresAt),
              verifiedSession: adminSessionNoMfa,
            },
            () =>
              saveAdminDocumentStoreConfiguration({
                section: 'stores',
                documentStores: updatedStores,
                userId: 'P-000001',
                session: adminSessionNoMfa,
                mfaVerified: false,
              }),
          ),
        ).toThrow(/MFA_REQUIRED/);

        // With MFA, saving store config succeeds and records config:stores:updated with delegatedPermissionScopes metadata
        const afterDash = runWithActiveActorSession(
          {
            personId: adminEmp.id,
            tenantId: cfg.tenantId,
            tokenRoles: adminSessionMfa.mappedRoles,
            expiresAtMs: Date.parse(adminSessionMfa.expiresAt),
            verifiedSession: adminSessionMfa,
          },
          () =>
            saveAdminDocumentStoreConfiguration({
              section: 'stores',
              documentStores: updatedStores,
              userId: 'P-000001',
              session: adminSessionMfa,
              mfaVerified: true,
            }),
        );
        const latestAudit = afterDash.recentAuditEvents.find(
          (e) => e.action === 'config:stores:updated',
        );
        expect(latestAudit).toBeDefined();
        expect(latestAudit?.outcome).toBe('succeeded');
        expect(latestAudit?.metadata?.delegatedPermissionScopes).toEqual(
          Object.fromEntries(
            updatedStores.map((ds) => [ds.storeId, 'Sites.Selected']),
          ),
        );
      } finally {
        store.documentStoreConfigOverride = prevOverride;
        saveStore(store);
        resetDocumentStoreSingletonsForTesting();
      }
    });
  });
});
