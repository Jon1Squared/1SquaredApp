import { describe, expect, it, vi } from 'vitest';
import {
  CORE_API_VERSION,
  ExtensionHost,
  isCoreApiRangeCompatible,
  loadAndValidateTenantConfig,
  resolveTenantFromVerifiedToken,
  type ExtensionExecutionContext,
  type PlatformExtension,
} from '@platform/core';
import notALawFirmBaseConfig from '../../client-not-a-law-firm/config/base.json';
import notALawFirmDevOverlay from '../../client-not-a-law-firm/config/environments/dev.json';
import nalfManifestJson from '../../client-not-a-law-firm/extensions/nalf-matter-costs-governance/manifest.json';

describe('ExtensionHost manifest config:read & hooks enforcement (R593)', () => {
  const tenantConfig = loadAndValidateTenantConfig(
    notALawFirmBaseConfig,
    notALawFirmDevOverlay,
    'dev',
    'multi_tenant',
  );
  const ctx = resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: 'P-000001',
      name: 'Extension Test User',
      email: 'ext-user@notalawfirm.example',
      tenantId: tenantConfig.tenantId,
      roles: ['partner'],
      mfaVerified: true,
    },
    hostingMode: tenantConfig.hostingMode,
    environment: tenantConfig.environment,
    correlationId: 'corr-r593',
  });

  it('R593: passes config to extensions with config:read and passes undefined config to extensions without config:read across all hook runners', async () => {
    const observedNoConfigRead: Record<string, ExtensionExecutionContext> = {};
    const observedWithConfigRead: Record<string, ExtensionExecutionContext> =
      {};

    const extWithoutConfigRead: PlatformExtension = {
      manifest: {
        id: 'ext-no-config-read',
        name: 'Ext Without Config Read',
        version: '1.0.0',
        description: 'Does not declare config:read permission',
        supportedCoreApiRange: '^2.0.0',
        permissions: [
          'matter:costs:validate',
          'matter:open:gate',
          'pms:sync',
          'document:fields:provide',
          'matter:read',
          'document:read',
          'keydate:write',
          'keydate:read',
          'register:write',
          'register:read',
        ],
        hooks: [
          'beforeMatterCostsCalculate',
          'beforeMatterOpen',
          'onPmsOutboundCommand',
          'provideDocumentFields',
          'afterMatterDocumentsProvisioned',
          'keyDate.beforeCreate',
          'keyDate.afterStatusChange',
          'keyDate.calculateCustomRule',
          'register.beforeCreate',
          'register.beforeTransition',
          'register.afterTransition',
        ],
      },
      hooks: {
        beforeMatterCostsCalculate(execCtx) {
          observedNoConfigRead.beforeMatterCostsCalculate = execCtx;
          return {
            requiresPartnerSignOff: false,
            governanceWarnings: [],
            allowProceed: true,
          };
        },
        beforeMatterOpen(execCtx) {
          observedNoConfigRead.beforeMatterOpen = execCtx;
          return {
            requiresPartnerSignOff: false,
            governanceWarnings: [],
            allowProceed: true,
          };
        },
        onPmsOutboundCommand(execCtx, command) {
          observedNoConfigRead.onPmsOutboundCommand = execCtx;
          return {
            commandId: command.id,
            status: 'Synced',
            syncedAt: '2026-11-20T00:00:00.000Z',
            errorMessage: null,
          };
        },
        provideDocumentFields(execCtx) {
          observedNoConfigRead.provideDocumentFields = execCtx;
          return { definitions: [], values: {} };
        },
        afterMatterDocumentsProvisioned(execCtx) {
          observedNoConfigRead.afterMatterDocumentsProvisioned = execCtx;
        },
        'keyDate.beforeCreate'(execCtx) {
          observedNoConfigRead['keyDate.beforeCreate'] = execCtx;
          return { allowProceed: true };
        },
        'keyDate.afterStatusChange'(execCtx) {
          observedNoConfigRead['keyDate.afterStatusChange'] = execCtx;
        },
        'keyDate.calculateCustomRule'(execCtx) {
          observedNoConfigRead['keyDate.calculateCustomRule'] = execCtx;
          return {
            date: '2027-01-01',
            explanation: ['stub'],
          };
        },
        'register.beforeCreate'(execCtx) {
          observedNoConfigRead['register.beforeCreate'] = execCtx;
          return {};
        },
        'register.beforeTransition'(execCtx) {
          observedNoConfigRead['register.beforeTransition'] = execCtx;
          return {};
        },
        'register.afterTransition'(execCtx) {
          observedNoConfigRead['register.afterTransition'] = execCtx;
        },
      },
    };

    const extWithConfigRead: PlatformExtension = {
      manifest: {
        id: 'ext-with-config-read',
        name: 'Ext With Config Read',
        version: '1.0.0',
        description: 'Declares config:read permission',
        supportedCoreApiRange: '^2.0.0',
        permissions: [
          'config:read',
          'matter:costs:validate',
          'matter:open:gate',
          'pms:sync',
          'document:fields:provide',
          'matter:read',
          'document:read',
          'keydate:write',
          'keydate:read',
          'register:write',
          'register:read',
        ],
        hooks: [
          'beforeMatterCostsCalculate',
          'beforeMatterOpen',
          'onPmsOutboundCommand',
          'provideDocumentFields',
          'afterMatterDocumentsProvisioned',
          'keyDate.beforeCreate',
          'keyDate.afterStatusChange',
          'keyDate.calculateCustomRule',
          'register.beforeCreate',
          'register.beforeTransition',
          'register.afterTransition',
        ],
      },
      hooks: {
        beforeMatterCostsCalculate(execCtx) {
          observedWithConfigRead.beforeMatterCostsCalculate = execCtx;
          return {
            requiresPartnerSignOff: false,
            governanceWarnings: [],
            allowProceed: true,
          };
        },
        beforeMatterOpen(execCtx) {
          observedWithConfigRead.beforeMatterOpen = execCtx;
          return {
            requiresPartnerSignOff: false,
            governanceWarnings: [],
            allowProceed: true,
          };
        },
        onPmsOutboundCommand(execCtx, command) {
          observedWithConfigRead.onPmsOutboundCommand = execCtx;
          return {
            commandId: command.id,
            status: 'Synced',
            syncedAt: '2026-11-20T00:00:00.000Z',
            errorMessage: null,
          };
        },
        provideDocumentFields(execCtx) {
          observedWithConfigRead.provideDocumentFields = execCtx;
          return { definitions: [], values: {} };
        },
        afterMatterDocumentsProvisioned(execCtx) {
          observedWithConfigRead.afterMatterDocumentsProvisioned = execCtx;
        },
        'keyDate.beforeCreate'(execCtx) {
          observedWithConfigRead['keyDate.beforeCreate'] = execCtx;
          return { allowProceed: true };
        },
        'keyDate.afterStatusChange'(execCtx) {
          observedWithConfigRead['keyDate.afterStatusChange'] = execCtx;
        },
        'keyDate.calculateCustomRule'(execCtx) {
          observedWithConfigRead['keyDate.calculateCustomRule'] = execCtx;
          return {
            date: '2027-01-01',
            explanation: ['stub'],
          };
        },
        'register.beforeCreate'(execCtx) {
          observedWithConfigRead['register.beforeCreate'] = execCtx;
          return {};
        },
        'register.beforeTransition'(execCtx) {
          observedWithConfigRead['register.beforeTransition'] = execCtx;
          return {};
        },
        'register.afterTransition'(execCtx) {
          observedWithConfigRead['register.afterTransition'] = execCtx;
        },
      },
    };

    const host = new ExtensionHost({ coreApiVersion: CORE_API_VERSION });
    host.registerExtension(extWithoutConfigRead);
    host.registerExtension(extWithConfigRead);

    const activeConfig = {
      ...tenantConfig,
      enabledExtensions: ['ext-no-config-read', 'ext-with-config-read'],
    };

    const costsInput = {
      matterId: 'M-R593',
      workBasis: 'hourly_rates' as const,
      estimatedFeeGbp: 1000,
      disbursementsTotalGbp: 0,
      partnerSignOffCompleted: true,
    };

    await host.executeMatterCostsHook(
      'beforeMatterCostsCalculate',
      ctx,
      activeConfig,
      costsInput,
    );
    host.executeMatterCostsHookSync('beforeMatterOpen', ctx, activeConfig, costsInput);
    await host.executePmsOutboundCommandHook(
      ctx,
      { ...activeConfig, enabledExtensions: ['ext-no-config-read'] },
      {
        id: 'CMD-1',
        tenantId: ctx.tenantId,
        correlationId: 'corr-r593',
        commandType: 'open_matter',
        entityType: 'matter',
        onesquaredId: 'M-R593',
        externalPmsCode: null,
        payload: {},
        mappedFields: {},
        createdAt: '2026-11-20T00:00:00.000Z',
        createdById: 'P-000001',
      },
    );
    await host.executePmsOutboundCommandHook(
      ctx,
      { ...activeConfig, enabledExtensions: ['ext-with-config-read'] },
      {
        id: 'CMD-2',
        tenantId: ctx.tenantId,
        correlationId: 'corr-r593',
        commandType: 'open_matter',
        entityType: 'matter',
        onesquaredId: 'M-R593',
        externalPmsCode: null,
        payload: {},
        mappedFields: {},
        createdAt: '2026-11-20T00:00:00.000Z',
        createdById: 'P-000001',
      },
    );
    await host.executeFieldProviders(ctx, activeConfig, {
      sourceEntityType: 'matter',
      matterId: 'M-R593',
      matter: { id: 'M-R593' },
    });
    await host.executeMatterDocumentsLifecycleHook(
      'afterMatterDocumentsProvisioned',
      ctx,
      activeConfig,
      {
        matterId: 'M-R593',
        storeId: 'store-1',
        libraryId: 'lib-1',
        rootFolderItemId: 'item-1',
      },
    );
    await host.executeKeyDateBeforeCreateHook(ctx, activeConfig, {
      matterId: 'M-R593',
      keyDateTypeId: 'limitation',
      category: 'limitation',
      title: 'Limitation',
      dueDate: '2027-01-01',
      isCritical: true,
      teamId: 'TM-000001',
      responsiblePersonIds: ['P-000001'],
    });
    await host.executeKeyDateAfterStatusChangeHook(ctx, activeConfig, {
      keyDateId: 'KD-R593',
      matterId: 'M-R593',
      keyDateTypeId: 'limitation',
      previousStatus: 'provisional',
      newStatus: 'confirmed',
      dueDate: '2027-01-01',
      changedById: 'P-000001',
      changedAt: '2026-11-20T00:00:00.000Z',
    });
    await host.executeKeyDateCalculateCustomRuleHook(
      ctx,
      { ...activeConfig, enabledExtensions: ['ext-no-config-read'] },
      {
        ruleSetId: 'RS-1',
        ruleId: 'R-CUSTOM',
        triggers: { accrualDate: '2026-01-01' },
      },
    );
    await host.executeKeyDateCalculateCustomRuleHook(
      ctx,
      { ...activeConfig, enabledExtensions: ['ext-with-config-read'] },
      {
        ruleSetId: 'RS-1',
        ruleId: 'R-CUSTOM',
        triggers: { accrualDate: '2026-01-01' },
      },
    );
    await host.executeRegisterBeforeCreateHook(ctx, activeConfig, {
      tenantId: ctx.tenantId,
      actorId: 'P-000001',
      correlationId: 'corr-r593',
      registerType: { key: 'undertaking' },
      draft: {
        registerTypeKey: 'undertaking',
        title: 'Undertaking R593',
        matterId: 'M-R593',
        enquiryId: null,
        personId: null,
        organisationId: null,
        ownerId: 'P-000001',
        assignedApproverId: null,
        dueAt: '2027-01-01',
        reviewAt: null,
        fieldValues: {},
      },
    } as unknown as Parameters<typeof host.executeRegisterBeforeCreateHook>[2]);
    await host.executeRegisterBeforeTransitionHook(ctx, activeConfig, {
      tenantId: ctx.tenantId,
      actorId: 'P-000001',
      correlationId: 'corr-r593',
      registerType: { key: 'undertaking' },
      record: { id: 'REG-R593', registerTypeKey: 'undertaking', status: 'open' },
      transition: { key: 'discharge', fromStatus: 'open', toStatus: 'discharged' },
      comment: null,
    } as unknown as Parameters<typeof host.executeRegisterBeforeTransitionHook>[2]);
    await host.executeRegisterAfterTransitionHook(ctx, activeConfig, {
      tenantId: ctx.tenantId,
      actorId: 'P-000001',
      correlationId: 'corr-r593',
      registerType: { key: 'undertaking' },
      previousRecord: { id: 'REG-R593', registerTypeKey: 'undertaking', status: 'open' },
      updatedRecord: { id: 'REG-R593', registerTypeKey: 'undertaking', status: 'discharged' },
      transition: { key: 'discharge', fromStatus: 'open', toStatus: 'discharged' },
    } as unknown as Parameters<typeof host.executeRegisterAfterTransitionHook>[2]);

    const hookNames = [
      'beforeMatterCostsCalculate',
      'beforeMatterOpen',
      'onPmsOutboundCommand',
      'provideDocumentFields',
      'afterMatterDocumentsProvisioned',
      'keyDate.beforeCreate',
      'keyDate.afterStatusChange',
      'keyDate.calculateCustomRule',
      'register.beforeCreate',
      'register.beforeTransition',
      'register.afterTransition',
    ];

    for (const hookName of hookNames) {
      expect(
        observedNoConfigRead[hookName],
        `${hookName} ran for ext-no-config-read`,
      ).toBeDefined();
      expect(
        observedNoConfigRead[hookName]!.config,
        `${hookName} must NOT pass tenant config when config:read is missing`,
      ).toBeUndefined();
      expect(
        observedWithConfigRead[hookName]?.config?.tenantId,
        `${hookName} must pass tenant config when config:read is granted`,
      ).toBe(tenantConfig.tenantId);
    }
  });

  it('R593: ExtensionHost refuses hooks omitted from manifest.hooks across all hook runners and never invokes undeclared functions', async () => {
    const spy = vi.fn(() => {
      throw new Error('UNDECLARED_HOOK_SHOULD_NOT_RUN');
    });

    const undeclaredHooksExt: PlatformExtension = {
      manifest: {
        id: 'ext-undeclared-hooks',
        name: 'Ext With Undeclared Hooks',
        version: '1.0.0',
        description: 'Has full permissions but empty manifest.hooks',
        supportedCoreApiRange: '^2.0.0',
        permissions: [
          'config:read',
          'matter:costs:validate',
          'matter:open:gate',
          'pms:sync',
          'document:fields:provide',
          'matter:read',
          'document:read',
          'keydate:write',
          'keydate:read',
          'register:write',
          'register:read',
        ],
        hooks: [],
      },
      hooks: {
        beforeMatterCostsCalculate: spy as never,
        beforeMatterOpen: spy as never,
        onPmsOutboundCommand: spy as never,
        provideDocumentFields: spy as never,
        afterMatterDocumentsProvisioned: spy as never,
        'keyDate.beforeCreate': spy as never,
        'keyDate.afterStatusChange': spy as never,
        'keyDate.calculateCustomRule': spy as never,
        'register.beforeCreate': spy as never,
        'register.beforeTransition': spy as never,
        'register.afterTransition': spy as never,
      },
    };

    const host = new ExtensionHost({ coreApiVersion: CORE_API_VERSION });
    host.registerExtension(undeclaredHooksExt);
    const activeConfig = {
      ...tenantConfig,
      enabledExtensions: ['ext-undeclared-hooks'],
    };
    const costsInput = {
      matterId: 'M-R593',
      workBasis: 'hourly_rates' as const,
      estimatedFeeGbp: 1000,
      disbursementsTotalGbp: 0,
      partnerSignOffCompleted: true,
    };

    const costsRes = await host.executeMatterCostsHook(
      'beforeMatterCostsCalculate',
      ctx,
      activeConfig,
      costsInput,
    );
    expect(costsRes.governanceWarnings.join(' ')).toMatch(/manifest\.hooks/i);

    const openGateRes = host.executeMatterCostsHookSync(
      'beforeMatterOpen',
      ctx,
      activeConfig,
      costsInput,
    );
    expect(openGateRes.allowProceed).toBe(false);
    expect(openGateRes.governanceWarnings.join(' ')).toMatch(/manifest\.hooks/i);

    const pmsRes = await host.executePmsOutboundCommandHook(ctx, activeConfig, {
      id: 'CMD-1',
      tenantId: ctx.tenantId,
      correlationId: 'corr-r593',
      commandType: 'open_matter',
      entityType: 'matter',
      onesquaredId: 'M-R593',
      externalPmsCode: null,
      payload: {},
      mappedFields: {},
      createdAt: '2026-11-20T00:00:00.000Z',
      createdById: 'P-000001',
    });
    expect(pmsRes.status).toBe('Failed');
    expect(pmsRes.errorMessage).toMatch(/manifest\.hooks/i);

    const fieldRes = await host.executeFieldProviders(ctx, activeConfig, {
      sourceEntityType: 'matter',
      matterId: 'M-R593',
      matter: { id: 'M-R593' },
    });
    expect(fieldRes.isolatedErrors.join(' ')).toMatch(/manifest\.hooks/i);

    const docLifecycleRes = await host.executeMatterDocumentsLifecycleHook(
      'afterMatterDocumentsProvisioned',
      ctx,
      activeConfig,
      {
        matterId: 'M-R593',
        storeId: 'store-1',
        libraryId: 'lib-1',
        rootFolderItemId: 'item-1',
      },
    );
    expect(docLifecycleRes.isolatedErrors.join(' ')).toMatch(/manifest\.hooks/i);

    const kdBeforeRes = await host.executeKeyDateBeforeCreateHook(ctx, activeConfig, {
      matterId: 'M-R593',
      keyDateTypeId: 'limitation',
      category: 'limitation',
      title: 'Limitation',
      dueDate: '2027-01-01',
      isCritical: true,
      teamId: 'TM-000001',
      responsiblePersonIds: ['P-000001'],
    });
    expect(kdBeforeRes.allowProceed).toBe(false);
    expect(kdBeforeRes.isolatedErrors.join(' ')).toMatch(/manifest\.hooks/i);

    const kdAfterRes = await host.executeKeyDateAfterStatusChangeHook(
      ctx,
      activeConfig,
      {
        keyDateId: 'KD-R593',
        matterId: 'M-R593',
        keyDateTypeId: 'limitation',
        previousStatus: 'provisional',
        newStatus: 'confirmed',
        dueDate: '2027-01-01',
        changedById: 'P-000001',
        changedAt: '2026-11-20T00:00:00.000Z',
      },
    );
    expect(kdAfterRes.isolatedErrors.join(' ')).toMatch(/manifest\.hooks/i);

    const kdRuleRes = await host.executeKeyDateCalculateCustomRuleHook(
      ctx,
      activeConfig,
      {
        ruleSetId: 'RS-1',
        ruleId: 'R-CUSTOM',
        triggers: { accrualDate: '2026-01-01' },
      },
    );
    expect(kdRuleRes.result).toBeNull();
    expect(kdRuleRes.isolatedErrors.join(' ')).toMatch(/manifest\.hooks/i);

    const regBeforeCreateRes = await host.executeRegisterBeforeCreateHook(
      ctx,
      activeConfig,
      {
        tenantId: ctx.tenantId,
        actorId: 'P-000001',
        correlationId: 'corr-r593',
        registerType: { key: 'undertaking' },
        draft: {
          registerTypeKey: 'undertaking',
          title: 'Undertaking R593',
          matterId: 'M-R593',
          enquiryId: null,
          personId: null,
          organisationId: null,
          ownerId: 'P-000001',
          assignedApproverId: null,
          dueAt: '2027-01-01',
          reviewAt: null,
          fieldValues: {},
        },
      } as unknown as Parameters<typeof host.executeRegisterBeforeCreateHook>[2],
    );
    expect(regBeforeCreateRes.allowProceed).toBe(false);
    expect(regBeforeCreateRes.isolatedErrors.join(' ')).toMatch(
      /manifest\.hooks/i,
    );

    const regBeforeTransitionRes = await host.executeRegisterBeforeTransitionHook(
      ctx,
      activeConfig,
      {
        tenantId: ctx.tenantId,
        actorId: 'P-000001',
        correlationId: 'corr-r593',
        registerType: { key: 'undertaking' },
        record: { id: 'REG-R593', registerTypeKey: 'undertaking', status: 'open' },
        transition: { key: 'discharge', fromStatus: 'open', toStatus: 'discharged' },
        comment: null,
      } as unknown as Parameters<typeof host.executeRegisterBeforeTransitionHook>[2],
    );
    expect(regBeforeTransitionRes.allowProceed).toBe(false);
    expect(regBeforeTransitionRes.isolatedErrors.join(' ')).toMatch(
      /manifest\.hooks/i,
    );

    const regAfterTransitionRes = await host.executeRegisterAfterTransitionHook(
      ctx,
      activeConfig,
      {
        tenantId: ctx.tenantId,
        actorId: 'P-000001',
        correlationId: 'corr-r593',
        registerType: { key: 'undertaking' },
        previousRecord: { id: 'REG-R593', registerTypeKey: 'undertaking', status: 'open' },
        updatedRecord: { id: 'REG-R593', registerTypeKey: 'undertaking', status: 'discharged' },
        transition: { key: 'discharge', fromStatus: 'open', toStatus: 'discharged' },
      } as unknown as Parameters<typeof host.executeRegisterAfterTransitionHook>[2],
    );
    expect(regAfterTransitionRes.isolatedErrors.join(' ')).toMatch(
      /manifest\.hooks/i,
    );

    expect(spy).not.toHaveBeenCalled();
  });

  it('R599: CORE_API_VERSION is 2.0.0, bundled nalf-matter-costs-governance declares ^2.0.0, and legacy ^1.0.0 manifests fail closed with EXTENSION_COMPATIBILITY_ERROR', () => {
    expect(CORE_API_VERSION).toBe('2.0.0');
    expect(nalfManifestJson.supportedCoreApiRange).toBe('^2.0.0');
    expect(nalfManifestJson.permissions).toContain('config:read');

    const host = new ExtensionHost({ coreApiVersion: CORE_API_VERSION });
    const legacyV1Ext: PlatformExtension = {
      manifest: {
        id: 'ext-legacy-v1-compat',
        name: 'Legacy v1 Extension',
        version: '1.0.0',
        description: 'Requires v1 core API',
        supportedCoreApiRange: '^1.0.0',
        permissions: ['matter:read'],
        hooks: [],
      },
      hooks: {},
    };
    expect(() => host.registerExtension(legacyV1Ext)).toThrow(
      /EXTENSION_COMPATIBILITY_ERROR/,
    );
  });

  it('R634: isCoreApiRangeCompatible and ExtensionHost.registerExtension enforce full semver range satisfaction via semver.satisfies', () => {
    expect(isCoreApiRangeCompatible('2.1.0', '^2.2.0')).toBe(false);
    expect(isCoreApiRangeCompatible('2.2.0', '^2.2.0')).toBe(true);
    expect(isCoreApiRangeCompatible('2.0.0', '>=2.0.0 <3.0.0')).toBe(true);
    expect(isCoreApiRangeCompatible('2.0.0', '~2.0.0')).toBe(true);
    expect(isCoreApiRangeCompatible('2.1.0', '~2.0.0')).toBe(false);
    expect(isCoreApiRangeCompatible('2.0.0', '^1.0.0')).toBe(false);
    expect(isCoreApiRangeCompatible('2.0.0', '')).toBe(false);
    expect(isCoreApiRangeCompatible('2.0.0', '*')).toBe(false);
    expect(isCoreApiRangeCompatible('2.0.0-alpha.1', '^2.0.0')).toBe(false);

    const host = new ExtensionHost({ coreApiVersion: '2.1.0' });
    const higherMinorExt: PlatformExtension = {
      manifest: {
        id: 'ext-requires-2-2',
        name: 'Requires 2.2 Extension',
        version: '1.0.0',
        description: 'Requires core API ^2.2.0',
        supportedCoreApiRange: '^2.2.0',
        permissions: ['matter:read'],
        hooks: [],
      },
      hooks: {},
    };
    expect(() => host.registerExtension(higherMinorExt)).toThrow(
      /EXTENSION_COMPATIBILITY_ERROR/,
    );
  });
});
