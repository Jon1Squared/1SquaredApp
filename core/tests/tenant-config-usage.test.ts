import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthorisationError,
  BasicMergeEngine,
  buildValidDocxArchive,
  collectConfigReservedSettings,
  collectStructuredConfigReservedSettings,
  CORE_FIELD_CATALOGUE,
  createDocumentStorageProvider,
  createOrUploadDraftTemplateVersion,
  loadAndValidateTenantConfig,
  RESERVED_TENANT_CONFIG_SETTINGS,
  resolveTenantFromVerifiedToken,
  submitTemplateVersionForApproval,
  TenantConfigurationSchema,
  TenantDocumentRepository,
  validateTenantConfigWithWarnings,
  type PlatformEnvironment,
} from '@platform/core';
import tenantConfigJsonSchema from '../schemas/tenant-config.schema.json';
import notALawFirmBaseConfig from '../../client-not-a-law-firm/config/base.json';
import {
  getActiveTenantConfiguration,
  setActiveTenantConfigForTesting,
} from '../../src/platform/tenantRuntime';
import {
  createOrProposeKeyDateRecord,
  getKeyDatesConfig,
  saveKeyDatesConfigRecord,
  saveMatterCostsConfig,
  signOffMatterCostsRecord,
  supersedeConfirmedKeyDateRecord,
  syncMatterCostsRatesFromPms,
} from '../../src/server/services';
import {
  uploadTemplateDraftService,
  submitTemplateVersionService,
} from '../../src/server/documentGenerationServices';
import {
  createSignedEntraSessionCookie,
  verifySignedEntraSessionCookie,
} from '../../src/server/entraAuth';
import { validateKeyDateManualEntry } from '../../src/domain/keyDates';
import { isActionDenied } from '../../src/domain/actionResult';
import { getStore, saveStore } from '../../src/server/store';
import {
  auditEntriesForRecord,
  getKeyDateRepository,
  markAuditPosition,
  runAsTestActor,
  testTenantCtx,
} from '../../src/server/testSupport/auditTestSupport';
import { runWithActiveActorSession } from '../../src/server/rbacRuntime';
import { createDefaultMatterCostsConfig } from '../../src/domain/matterCosts';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCHEMA_DIR = path.join(REPO_ROOT, 'core', 'schemas');

interface SchemaLeafEntry {
  path: string;
  key: string;
  deprecated: boolean;
  reserved?: {
    for: string;
    reason: string;
  };
}

function walkTenantSchemaProperties(
  node: Record<string, unknown>,
  prefix = '',
  rootSchema: Record<string, unknown> = tenantConfigJsonSchema as unknown as Record<
    string,
    unknown
  >,
  inheritedReserved?: { for: string; reason: string },
  inheritedDeprecated = false,
): SchemaLeafEntry[] {
  const results: SchemaLeafEntry[] = [];
  if (!node || typeof node !== 'object') {
    return results;
  }

  if (typeof node.$ref === 'string') {
    const ref = node.$ref;
    if (ref.startsWith('#/$defs/')) {
      const defName = ref.slice('#/$defs/'.length);
      const defs = rootSchema.$defs as
        | Record<string, Record<string, unknown>>
        | undefined;
      const target = defs?.[defName];
      if (target) {
        const rest = { ...node };
        delete rest.$ref;
        return walkTenantSchemaProperties(
          { ...target, ...rest },
          prefix,
          rootSchema,
          inheritedReserved,
          inheritedDeprecated,
        );
      }
    } else if (ref.startsWith('./')) {
      const extSchema = JSON.parse(
        fs.readFileSync(path.join(SCHEMA_DIR, ref), 'utf8'),
      ) as Record<string, unknown>;
      const rest = { ...node };
      delete rest.$ref;
      return walkTenantSchemaProperties(
        { ...extSchema, ...rest },
        prefix,
        extSchema,
        inheritedReserved,
        inheritedDeprecated,
      );
    }
  }

  const ownReserved = node['x-reserved'] as
    | { for: string; reason: string }
    | undefined;
  if (ownReserved && prefix) {
    const segments = prefix.split('.');
    const rawLast = segments[segments.length - 1]!.replace(/\[\]$/, '');
    results.push({
      path: prefix,
      key: rawLast,
      deprecated: Boolean(node.deprecated) || inheritedDeprecated,
      reserved: ownReserved,
    });
    return results;
  }

  const nodeReserved = ownReserved ?? inheritedReserved;
  const nodeDeprecated = Boolean(node.deprecated) || inheritedDeprecated;

  if (node.properties && typeof node.properties === 'object') {
    for (const [key, child] of Object.entries(
      node.properties as Record<string, Record<string, unknown>>,
    )) {
      const childPath = prefix ? `${prefix}.${key}` : key;
      const children = walkTenantSchemaProperties(
        child,
        childPath,
        rootSchema,
        nodeReserved,
        nodeDeprecated,
      );
      if (children.length === 0) {
        const leafReserved =
          (child['x-reserved'] as
            | { for: string; reason: string }
            | undefined) ?? nodeReserved;
        results.push({
          path: childPath,
          key,
          deprecated: Boolean(child.deprecated) || nodeDeprecated,
          reserved: leafReserved,
        });
      } else {
        results.push(...children);
      }
    }
    return results;
  }

  if (node.items && typeof node.items === 'object') {
    const children = walkTenantSchemaProperties(
      node.items as Record<string, unknown>,
      `${prefix}[]`,
      rootSchema,
      nodeReserved,
      nodeDeprecated,
    );
    if (children.length > 0) {
      results.push(...children);
      return results;
    }
  }

  if (
    node.additionalProperties &&
    typeof node.additionalProperties === 'object'
  ) {
    const children = walkTenantSchemaProperties(
      node.additionalProperties as Record<string, unknown>,
      `${prefix}.*`,
      rootSchema,
      nodeReserved,
      nodeDeprecated,
    );
    if (children.length > 0) {
      results.push(...children);
      return results;
    }
  }

  if (Array.isArray(node.oneOf)) {
    for (const variant of node.oneOf as Record<string, unknown>[]) {
      results.push(
        ...walkTenantSchemaProperties(
          variant,
          prefix,
          rootSchema,
          nodeReserved,
          nodeDeprecated,
        ),
      );
    }
  }

  return results;
}

function collectRuntimeSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === '__tests__' ||
        entry.name === 'tests' ||
        entry.name === 'docs' ||
        entry.name === 'seed'
      ) {
        continue;
      }
      files.push(...collectRuntimeSourceFiles(fullPath));
    } else if (
      entry.isFile() &&
      /\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.types.ts') &&
      entry.name !== 'types.ts' &&
      !fullPath.endsWith(path.join('core', 'src', 'api', 'index.ts')) &&
      !fullPath.endsWith(path.join('core', 'src', 'config-engine', 'index.ts'))
    ) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

const CONFIG_RECEIVER_NAMES =
  '(?:config|tenantConfig|tenantCfg|cfg|baseCfg|activeTenantConfig|effectiveConfig|rawConfig|validated)';

function extractFunctionScopes(
  content: string,
  fileName = 'source.tsx',
): string[] {
  const scriptKind = fileName.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const scopes: string[] = [];

  const isScopeNode = (node: ts.Node): boolean =>
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node);

  const visit = (node: ts.Node): void => {
    if (isScopeNode(node)) {
      const text = node.getText(sourceFile).trim();
      if (text.length > 0) {
        scopes.push(text);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  if (scopes.length === 0 && content.trim().length > 0) {
    scopes.push(content);
  }
  return scopes;
}

const SUBTREE_ALIASES_BY_PARENT_PATH: Readonly<
  Record<string, { aliases: readonly string[]; scopeAnchor: RegExp }>
> = {
  'documentStores[]': {
    aliases: ['storeConfig'],
    scopeAnchor:
      /\b(?:documentStores|DocumentStoreConfig|SharePointDocumentStoreProvider)\b/,
  },
  'documentStores[].auth': {
    aliases: ['authConfig'],
    scopeAnchor: /\b(?:DocumentStoreAuthConfig|storeConfig\??\.auth)\b/,
  },
  documentAccess: {
    aliases: ['accessConfig'],
    scopeAnchor: /\b(?:documentAccess|DocumentAccessConfig)\b/,
  },
  matterFolderTemplates: {
    aliases: ['templatesConfig'],
    scopeAnchor: /\b(?:matterFolderTemplates|MatterFolderTemplatesConfig)\b/,
  },
  'documentRouting[].match': {
    aliases: ['criteria'],
    scopeAnchor: /\b(?:DocumentRoutingRule|routingRule\??\.match)\b/,
  },
  'keyDates.keyDateTypes[]': {
    aliases: ['kdType'],
    scopeAnchor: /\b(?:keyDateTypes|findKeyDateTypeConfig)\b/,
  },
  'keyDates.matterTypes[]': {
    aliases: ['mtConfig'],
    scopeAnchor: /\b(?:matterTypes|findMatterTypeKeyDateConfig)\b/,
  },
  'keyDates.limitationRuleSets[].rules[]': {
    aliases: ['limitationRule'],
    scopeAnchor:
      /\b(?:limitationRuleSets|LimitationRuleConfig|CalculateLimitationDateOptions|findLimitationRule)\b/,
  },
  'keyDates.businessCalendars[]': {
    aliases: ['calendar'],
    scopeAnchor:
      /\b(?:businessCalendars|BusinessCalendarConfig|findBusinessCalendar)\b/,
  },
};

function isLeafReferencedInRuntime(
  leaf: SchemaLeafEntry,
  runtimeCorpus: string,
  runtimeFunctionScopes: readonly string[],
): boolean {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rawSegments = leaf.path.split('.');
  const topKey = rawSegments[0]!.replace(/\[\]$/, '');

  // 1. Top-level TenantConfiguration property must be accessed on a config receiver (never e.g. store.customFields)
  const topReceiverPattern = new RegExp(
    `\\b${CONFIG_RECEIVER_NAMES}\\??\\.${esc(topKey)}\\b`,
  );
  if (!topReceiverPattern.test(runtimeCorpus)) {
    return false;
  }

  if (rawSegments.length === 1) {
    return true;
  }

  const lastSegment = rawSegments[rawSegments.length - 1]!.replace(/\[\]$/, '');
  const prevSegment = rawSegments[rawSegments.length - 2]!;
  const parentPath = rawSegments.slice(0, -1).join('.');
  const subtreeSpec = SUBTREE_ALIASES_BY_PARENT_PATH[parentPath];

  // Deprecated roleDefaults permission keys contain colons and are indexed by string key
  if (lastSegment.includes(':')) {
    const colonKeyPattern = new RegExp(`['"]${esc(lastSegment)}['"]`);
    const parentClean = prevSegment.replace(/\[\]$/, '');
    const parentAccessPattern = new RegExp(
      `(?:\\.|\\?\\.)\\b${esc(parentClean)}\\b`,
    );
    return (
      colonKeyPattern.test(runtimeCorpus) &&
      parentAccessPattern.test(runtimeCorpus)
    );
  }

  // If the immediate parent is a named object (not an array `[]` or wildcard `*`),
  // require `<parentKey>.<leafKey>` or `<subtreeAlias>.<leafKey>` for that exact subtree only.
  if (!prevSegment.endsWith('[]') && prevSegment !== '*') {
    const parentIsNestedUnderArray = Boolean(
      rawSegments[rawSegments.length - 3]?.endsWith('[]'),
    );
    const directParentDotted = parentIsNestedUnderArray
      ? new RegExp(
          `(?:\\.|\\?\\.)\\b${esc(prevSegment)}\\??\\.${esc(lastSegment)}\\b`,
        )
      : new RegExp(
          `(?<!patch\\.|patch\\?\\.)\\b${esc(prevSegment)}\\??\\.${esc(lastSegment)}\\b`,
        );
    if (directParentDotted.test(runtimeCorpus)) {
      return true;
    }
    if (subtreeSpec) {
      const aliasAlt = subtreeSpec.aliases.map(esc).join('|');
      const aliasDotted = new RegExp(
        `(?<!patch\\.|patch\\?\\.)\\b(?:${aliasAlt})\\??\\.${esc(lastSegment)}\\b`,
      );
      return runtimeFunctionScopes.some(
        (scope) =>
          subtreeSpec.scopeAnchor.test(scope) && aliasDotted.test(scope),
      );
    }
    return false;
  }

  // For array (`[]`) or wildcard (`*`) elements, require the leaf to be accessed in the same
  // function scope as its parent accessor or on that exact subtree's typed element variable.
  if (subtreeSpec) {
    const aliasAlt = subtreeSpec.aliases.map(esc).join('|');
    const typedElementAccessor = new RegExp(
      `(?<!patch\\.|patch\\?\\.)\\b(?:${aliasAlt})\\??\\.${esc(lastSegment)}\\b`,
    );
    if (
      runtimeFunctionScopes.some(
        (scope) =>
          subtreeSpec.scopeAnchor.test(scope) &&
          typedElementAccessor.test(scope),
      )
    ) {
      return true;
    }
  }

  const cleanSegments = rawSegments
    .map((s) => s.replace(/\[\]$/, ''))
    .filter((s) => s !== '*');
  const parentSeg = cleanSegments[cleanSegments.length - 2]!;
  const parentPattern = new RegExp(`(?:\\.|\\?\\.)\\b${esc(parentSeg)}\\b`);
  const leafPattern = new RegExp(
    `(?<!patch)(?:\\.|\\?\\.)\\b${esc(lastSegment)}\\b|\\['${esc(lastSegment)}'\\]|\\["${esc(lastSegment)}"\\]`,
  );

  return runtimeFunctionScopes.some(
    (scope) => parentPattern.test(scope) && leafPattern.test(scope),
  );
}

describe('S0-12: tenant configuration schema usage, reserved markers, and feature flag gates', () => {
  afterEach(() => {
    setActiveTenantConfigForTesting(null);
    vi.restoreAllMocks();
  });

  it('walks tenantConfigJsonSchema.properties (including $ref schemas) recursively and asserts every leaf key is either referenced in runtime code via a dotted/typed accessor or marked x-reserved', () => {
    const leaves = walkTenantSchemaProperties(
      tenantConfigJsonSchema as unknown as Record<string, unknown>,
    );
    expect(leaves.length).toBeGreaterThan(170);
    expect(
      leaves.some((l) => l.path === 'keyDates.defaults.verification.required'),
    ).toBe(true);

    const runtimeFiles = [
      ...collectRuntimeSourceFiles(path.join(REPO_ROOT, 'src')),
      ...collectRuntimeSourceFiles(path.join(REPO_ROOT, 'core', 'src')),
    ];
    const runtimeFileContents = runtimeFiles.map((filePath) =>
      fs.readFileSync(filePath, 'utf8'),
    );
    const runtimeCorpus = runtimeFileContents.join('\n');
    const runtimeFunctionScopes = runtimeFiles.flatMap((filePath, idx) =>
      extractFunctionScopes(runtimeFileContents[idx]!, filePath),
    );

    const unreferencedNonReserved: string[] = [];
    for (const leaf of leaves) {
      if (leaf.reserved) {
        expect(leaf.reserved.for).toMatch(/^(?:S0-\d+[a-z]?|backlog)$/);
        expect(leaf.reserved.reason.trim().length).toBeGreaterThan(10);
        continue;
      }

      if (
        !isLeafReferencedInRuntime(leaf, runtimeCorpus, runtimeFunctionScopes)
      ) {
        unreferencedNonReserved.push(leaf.path);
      }
    }

    expect(unreferencedNonReserved).toEqual([]);
  });

  it('rejects decoy references in isLeafReferencedInRuntime (unrelated subtree aliases and separate-function array leaves fail)', () => {
    // 1. An alias from another subtree (storeConfig.enabled for documentStores[]) must NOT pass keyDates.enabled or integrations.pmsSync.enabled
    const decoyCorpusAlias = `
      export function checkStore(config: TenantConfiguration, storeConfig: DocumentStoreConfig) {
        const kd = config.keyDates;
        const integ = config.integrations;
        const stores = config.documentStores;
        return storeConfig.enabled && Boolean(kd) && Boolean(integ) && Boolean(stores);
      }
    `;
    const decoyScopesAlias = extractFunctionScopes(decoyCorpusAlias);
    expect(
      isLeafReferencedInRuntime(
        { path: 'keyDates.enabled', key: 'enabled', deprecated: false },
        decoyCorpusAlias,
        decoyScopesAlias,
      ),
    ).toBe(false);
    expect(
      isLeafReferencedInRuntime(
        {
          path: 'integrations.pmsSync.enabled',
          key: 'enabled',
          deprecated: false,
        },
        decoyCorpusAlias,
        decoyScopesAlias,
      ),
    ).toBe(false);
    expect(
      isLeafReferencedInRuntime(
        {
          path: 'documentStores[].enabled',
          key: 'enabled',
          deprecated: false,
        },
        decoyCorpusAlias,
        decoyScopesAlias,
      ),
    ).toBe(true);

    // 2. An array leaf where .parent and .leaf appear in different functions of the same file must fail
    const decoySeparateFunctions = `
      export function fnOne(config: TenantConfiguration) {
        return config.documentStores?.length ?? 0;
      }
      export function fnTwo(other: { displayName: string }) {
        return other.displayName;
      }
    `;
    const decoySeparateScopes = extractFunctionScopes(decoySeparateFunctions);
    expect(decoySeparateScopes).toHaveLength(2);
    expect(
      isLeafReferencedInRuntime(
        {
          path: 'documentStores[].displayName',
          key: 'displayName',
          deprecated: false,
        },
        decoySeparateFunctions,
        decoySeparateScopes,
      ),
    ).toBe(false);

    // 3. A non-array leaf where .parent and .leaf appear on unrelated objects in the same function (not parent.leaf) must fail
    const decoyNonArray = `
      export function fnThree(config: TenantConfiguration, other: { defaults: string; teamAssignment: string }) {
        return Boolean(config.keyDates) && other.defaults === other.teamAssignment;
      }
    `;
    const decoyNonArrayScopes = extractFunctionScopes(decoyNonArray);
    expect(
      isLeafReferencedInRuntime(
        {
          path: 'keyDates.defaults.teamAssignment',
          key: 'teamAssignment',
          deprecated: false,
        },
        decoyNonArray,
        decoyNonArrayScopes,
      ),
    ).toBe(false);

    // 4. R303: A function that calls 'x'.match(/y/) and touches a local `criteria` variable must NOT satisfy documentRouting[].match.*
    const decoyStringMatch = `
      export function fnStringMatch(config: TenantConfiguration, criteria: { departmentId?: string }) {
        const routing = config.documentRouting;
        const m = 'x'.match(/y/);
        return Boolean(routing) && Boolean(m) && criteria.departmentId === 'DEPT-1';
      }
    `;
    const decoyStringMatchScopes = extractFunctionScopes(decoyStringMatch);
    expect(
      isLeafReferencedInRuntime(
        {
          path: 'documentRouting[].match.departmentId',
          key: 'departmentId',
          deprecated: false,
        },
        decoyStringMatch,
        decoyStringMatchScopes,
      ),
    ).toBe(false);

    // 5. R303: A function with a local variable named `auth` must NOT satisfy documentStores[].auth.*
    const decoyLocalAuth = `
      export const fnLocalAuth = (config: TenantConfiguration, authConfig: { clientId?: string }) => {
        const stores = config.documentStores;
        const auth = { clientId: 'decoy-client' };
        return Boolean(stores) && auth.clientId === authConfig.clientId;
      };
    `;
    const decoyLocalAuthScopes = extractFunctionScopes(decoyLocalAuth);
    expect(
      isLeafReferencedInRuntime(
        {
          path: 'documentStores[].auth.clientId',
          key: 'clientId',
          deprecated: false,
        },
        decoyLocalAuth,
        decoyLocalAuthScopes,
      ),
    ).toBe(false);
  });

  it('marks all unused settings as x-reserved with their target slice in JSON schema and Zod descriptions, including $ref keyDates settings', () => {
    const expectedReservedByPath: Record<string, string> = {
      'branding.accentColorHex': 'backlog',
      'branding.logoAssetKey': 'backlog',
      'matterCosts.rateSourceMode': 'S0-23',
      'matterCosts.allowMatterRateOverrides': 'S0-23',
      'matterCosts.partnerSignOffThresholdGbp': 'S0-23',
      'matterCosts.rateCards': 'S0-23',
      'matterCosts.disbursementPresets': 'S0-23',
      'integrations.pmsConnectionSecretVaultRef': 'S0-18',
      'integrations.companiesHouseApiKeyVaultRef': 'S0-18',
      'integrations.pmsSync.enabled': 'S0-18',
      'integrations.pmsSync.providerKey': 'S0-18',
      'integrations.pmsSync.syncMode': 'S0-18',
      'integrations.pmsSync.matterCodeAllocation': 'S0-18',
      'integrations.pmsSync.clientCodeAllocation': 'S0-18',
      'integrations.pmsSync.pollIntervalMinutes': 'S0-18',
      'integrations.pmsSync.fieldMappings': 'S0-18',
      'documentGeneration.usage.retentionMonths': 'S0-19',
      'documentGeneration.customDocumentTypes': 'backlog',
      'documentAccess.autoRemediateDrift': 'S0-25',
      'keyDates.defaults.teamAssignment': 'backlog',
      'keyDates.matterTypes[].defaultRuleSetIds': 'backlog',
      'keyDates.limitationRuleSets[].rules[].claimType': 'backlog',
      'keyDates.calendarSync.provider': 'backlog',
    };

    const leaves = walkTenantSchemaProperties(
      tenantConfigJsonSchema as unknown as Record<string, unknown>,
    );

    for (const [expectedPath, expectedSlice] of Object.entries(
      expectedReservedByPath,
    )) {
      const matchingLeaves = leaves.filter((l) => l.path === expectedPath);
      expect(matchingLeaves).toHaveLength(1);
      expect(matchingLeaves[0]!.reserved?.for).toBe(expectedSlice);
    }

    const reservedLeaves = leaves.filter((l) => Boolean(l.reserved));
    expect(RESERVED_TENANT_CONFIG_SETTINGS).toEqual(
      reservedLeaves.map((l) => ({
        path: l.path,
        forSlice: l.reserved!.for,
        reason: l.reserved!.reason,
      })),
    );
    expect(
      RESERVED_TENANT_CONFIG_SETTINGS.some(
        (s) =>
          s.path === 'keyDates.defaults.teamAssignment' &&
          s.forSlice === 'backlog',
      ),
    ).toBe(true);
    expect(
      RESERVED_TENANT_CONFIG_SETTINGS.some(
        (s) =>
          s.path === 'keyDates.matterTypes[].defaultRuleSetIds' &&
          s.forSlice === 'backlog',
      ),
    ).toBe(true);
    expect(
      RESERVED_TENANT_CONFIG_SETTINGS.some(
        (s) =>
          s.path === 'keyDates.limitationRuleSets[].rules[].claimType' &&
          s.forSlice === 'backlog',
      ),
    ).toBe(true);
    expect(
      RESERVED_TENANT_CONFIG_SETTINGS.some(
        (s) =>
          s.path === 'keyDates.calendarSync.provider' &&
          s.forSlice === 'backlog',
      ),
    ).toBe(true);
    // R302: Reserved array settings are recorded once by their setting path, never per child field
    expect(
      RESERVED_TENANT_CONFIG_SETTINGS.some((s) =>
        s.path.startsWith('documentGeneration.customDocumentTypes[].'),
      ),
    ).toBe(false);
    expect(
      RESERVED_TENANT_CONFIG_SETTINGS.some((s) =>
        s.path.startsWith('customFields[].'),
      ),
    ).toBe(false);
    expect(
      RESERVED_TENANT_CONFIG_SETTINGS.some((s) =>
        s.path.startsWith('integrations.pmsSync.fieldMappings[].'),
      ),
    ).toBe(false);

    // R301: Verify Zod .describe() [x-reserved:...] tag parity across all 24 reserved settings
    interface ZodInspectable {
      description?: string;
      shape?: Record<string, ZodInspectable>;
      element?: ZodInspectable;
      unwrap?: () => ZodInspectable;
      _def?: {
        description?: string;
        shape?: () => Record<string, ZodInspectable>;
        innerType?: ZodInspectable;
        schema?: ZodInspectable;
        in?: ZodInspectable;
        type?: ZodInspectable;
      };
    }

    const getZodDescriptionByPath = (
      rootSchema: unknown,
      dottedPath: string,
    ): string | undefined => {
      let current: ZodInspectable | undefined = rootSchema as ZodInspectable;
      const unwrap = (node: ZodInspectable | undefined): ZodInspectable | undefined => {
        let cur = node;
        while (cur && !cur.shape && !cur.element) {
          const next =
            typeof cur.unwrap === 'function'
              ? cur.unwrap()
              : (cur._def?.innerType ?? cur._def?.schema ?? cur._def?.in);
          if (!next || next === cur) break;
          cur = next;
        }
        return cur;
      };
      const findDescription = (node: ZodInspectable | undefined): string | undefined => {
        let cur = node;
        while (cur) {
          if (typeof cur.description === 'string' && cur.description.length > 0) {
            return cur.description;
          }
          if (
            typeof cur._def?.description === 'string' &&
            cur._def.description.length > 0
          ) {
            return cur._def.description;
          }
          const next =
            typeof cur.unwrap === 'function'
              ? cur.unwrap()
              : (cur._def?.innerType ?? cur._def?.schema ?? cur._def?.in);
          if (!next || next === cur) break;
          cur = next;
        }
        return undefined;
      };
      for (const rawPart of dottedPath.split('.')) {
        const isArrayHop = rawPart.endsWith('[]');
        const key = isArrayHop ? rawPart.slice(0, -2) : rawPart;
        const objNode = unwrap(current);
        const shape =
          typeof objNode?._def?.shape === 'function'
            ? objNode._def.shape()
            : objNode?.shape;
        if (!shape || !(key in shape)) {
          return undefined;
        }
        current = shape[key];
        if (isArrayHop) {
          const arrNode = unwrap(current);
          current = arrNode?.element ?? arrNode?._def?.type;
        }
      }
      return findDescription(current);
    };

    for (const [expectedPath, expectedSlice] of Object.entries(
      expectedReservedByPath,
    )) {
      expect(
        getZodDescriptionByPath(TenantConfigurationSchema, expectedPath),
      ).toContain(`[x-reserved:${expectedSlice}]`);
    }
  });

  it('applies documentGeneration.approval.requireApproval when submitting a template version', async () => {
    const ctx = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'P-0001',
        tenantId: 'not-a-law-firm',
        email: 'admin@notalawfirm.example',
        name: 'Aldous Vane',
        roles: ['admin', 'partner'],
        mfaVerified: true,
      },
      hostingMode: 'multi_tenant',
      environment: 'dev',
      correlationId: 'corr-s0-12-docgen',
    });
    const repo = new TenantDocumentRepository();
    const storage = createDocumentStorageProvider('local-fs', {
      inMemoryOnly: true,
      tokenSigningKey: 'test-signing-key-32-chars-minimum-12345',
    });
    const engine = new BasicMergeEngine();
    const docxBytes = buildValidDocxArchive({
      paragraphs: [{ text: 'Dear {{client.name}}, ref {{matter.reference}}.' }],
    });
    const actor = {
      id: 'P-0001',
      tenantId: 'not-a-law-firm',
      roles: ['admin', 'partner'] as const,
    };

    const configRequireApproval = loadAndValidateTenantConfig(
      notALawFirmBaseConfig as unknown as Record<string, unknown>,
    );
    const created1 = await createOrUploadDraftTemplateVersion({
      ctx,
      repo,
      storage,
      engine,
      catalogue: CORE_FIELD_CATALOGUE,
      actor,
      config: configRequireApproval,
      input: {
        code: 'TPL-REQ-APPROVAL',
        name: 'Requires Approval Template',
        description: 'Test template',
        category: 'General',
        outputDocumentType: 'Letter',
        filenamePattern: '{matter.reference}-letter',
        availabilityRules: { sourceContexts: ['matter'] },
        fileName: 'test.docx',
        docxBytes,
      },
    });
    const submitted = await submitTemplateVersionForApproval({
      ctx,
      repo,
      catalogue: CORE_FIELD_CATALOGUE,
      actor,
      config: configRequireApproval,
      versionId: created1.version.id,
    });
    expect(submitted.version.status).toBe('Submitted');

    const configNoApproval = loadAndValidateTenantConfig({
      ...(notALawFirmBaseConfig as unknown as Record<string, unknown>),
      documentGeneration: {
        approval: {
          requireApproval: false,
          allowSelfApproval: false,
        },
      },
    });
    const created2 = await createOrUploadDraftTemplateVersion({
      ctx,
      repo,
      storage,
      engine,
      catalogue: CORE_FIELD_CATALOGUE,
      actor,
      config: configNoApproval,
      input: {
        code: 'TPL-NO-APPROVAL',
        name: 'Auto-Active Template',
        description: 'Test template without approval step',
        category: 'General',
        outputDocumentType: 'Letter',
        filenamePattern: '{matter.reference}-auto',
        availabilityRules: { sourceContexts: ['matter'] },
        fileName: 'auto.docx',
        docxBytes,
      },
    });
    const autoActivated = await submitTemplateVersionForApproval({
      ctx,
      repo,
      catalogue: CORE_FIELD_CATALOGUE,
      actor,
      config: configNoApproval,
      versionId: created2.version.id,
    });
    expect(autoActivated.version.status).toBe('Active');
    expect(autoActivated.template.activeVersionId).toBe(created2.version.id);
    expect(autoActivated.template.status).toBe('Active');
  });

  it('validates client-not-a-law-firm/config/base.json and all environment overlays unchanged (Rule 7 backward compatibility)', () => {
    const configDir = path.join(REPO_ROOT, 'client-not-a-law-firm', 'config');
    const baseRaw = JSON.parse(
      fs.readFileSync(path.join(configDir, 'base.json'), 'utf8'),
    ) as Record<string, unknown>;

    const environmentsDir = path.join(configDir, 'environments');
    const overlayFiles = fs
      .readdirSync(environmentsDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    expect(overlayFiles).toEqual(['demo.json', 'dev.json', 'test.json']);

    const environments: PlatformEnvironment[] = [
      'dev',
      'test',
      'training',
      'demo',
      'live',
    ];
    for (const env of environments) {
      const overlayPath = path.join(environmentsDir, `${env}.json`);
      const overlayRaw = fs.existsSync(overlayPath)
        ? (JSON.parse(
            fs.readFileSync(overlayPath, 'utf8'),
          ) as Record<string, unknown>)
        : {};

      const validated = loadAndValidateTenantConfig(baseRaw, overlayRaw, env);
      expect(validated.tenantId).toBe('not-a-law-firm');
      expect(validated.environment).toBe(env);

      const withNotices = validateTenantConfigWithWarnings(
        baseRaw,
        overlayRaw,
        env,
      );
      expect(withNotices.deprecationWarnings).toEqual([]);
      expect(withNotices.reservedSettings.length).toBeGreaterThan(0);
      expect(
        withNotices.structuredReservedSettings.some(
          (n) =>
            n.path === 'integrations.pmsConnectionSecretVaultRef' &&
            n.forSlice === 'S0-18',
        ),
      ).toBe(true);
    }

    expect(
      collectConfigReservedSettings(baseRaw).some((msg) =>
        msg.includes('[RESERVED_CONFIG_KEY] matterCosts.rateSourceMode'),
      ),
    ).toBe(true);
    expect(collectStructuredConfigReservedSettings({})).toEqual([]);
  });

  it('logs reserved settings once as info at startup when loading tenant configuration', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    setActiveTenantConfigForTesting(
      notALawFirmBaseConfig as unknown as Record<string, unknown>,
    );

    const first = getActiveTenantConfiguration();
    const second = getActiveTenantConfiguration();
    expect(first.tenantId).toBe('not-a-law-firm');
    expect(second.tenantId).toBe('not-a-law-firm');

    const reservedLogs = infoSpy.mock.calls
      .map((call) => {
        try {
          return JSON.parse(String(call[0])) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((entry) => entry?.event === 'tenant_config.reserved_settings');

    expect(reservedLogs).toHaveLength(1);
    expect(reservedLogs[0]?.level).toBe('info');
    expect(reservedLogs[0]?.tenantId).toBe('not-a-law-firm');
    expect(String(reservedLogs[0]?.correlationId)).toMatch(
      /^cfg-startup-not-a-law-firm-/,
    );
  });

  it('gates saveMatterCostsConfig, signOffMatterCostsRecord, and syncMatterCostsRatesFromPms on featureFlags', async () => {
    const store = getStore();
    const snapshot = structuredClone(store);
    try {
      const sampleConfig = createDefaultMatterCostsConfig(store.values, {
        clientProfileCode: notALawFirmBaseConfig.tenantId,
        displayName: notALawFirmBaseConfig.displayName,
        primaryDomain: notALawFirmBaseConfig.branding.primaryDomain,
      });

      setActiveTenantConfigForTesting({
        ...(notALawFirmBaseConfig as unknown as Record<string, unknown>),
        featureFlags: {
          ...notALawFirmBaseConfig.featureFlags,
          enableMatterCostsGovernance: false,
          enablePmsLiveRateSync: false,
        },
      });

      await expect(saveMatterCostsConfig(sampleConfig, 'P-0001')).rejects.toThrow(
        AuthorisationError,
      );
      await expect(syncMatterCostsRatesFromPms('P-0001')).rejects.toThrow(
        AuthorisationError,
      );

      const targetMatter = store.matters[0]!;
      const signOffDenied = await runWithActiveActorSession(
        {
          tenantId: 'not-a-law-firm',
          personId: 'P-0001',
          tokenRoles: ['managing_partner', 'admin'],
          mfaVerified: true,
          expiresAtMs: Date.now() + 60_000,
          verifiedSession: {
            __verifiedEntraSession: true,
            tenantId: 'not-a-law-firm',
            personId: 'P-0001',
            entraObjectId: '00000000-0000-4000-8000-000000000001',
            email: 'aldous.vane@notalawfirm.example',
            displayName: 'Aldous Vane',
            mappedRoles: ['managing_partner', 'admin'],
            mfaVerified: true,
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        },
        async () =>
          signOffMatterCostsRecord(
            targetMatter.id,
            'P-0001',
            'Attempted sign-off while feature disabled',
          ),
      );
      expect(isActionDenied(signOffDenied)).toBe(true);
      expect(signOffDenied.code).toBe('FORBIDDEN');
      expect(signOffDenied.matter).toBeNull();
      expect(signOffDenied.errors).toBeUndefined();
      expect(signOffDenied.message).toContain(
        'enableMatterCostsGovernance is false',
      );
    } finally {
      saveStore(snapshot);
    }
  });

  it('audits submitTemplateVersionService accurately under requireApproval true vs false (R287)', async () => {
    const store = getStore();
    const snapshot = structuredClone(store);
    const templateAuditMark = await markAuditPosition();
    try {
      const docxBase64 = Buffer.from(
        buildValidDocxArchive({
          paragraphs: [
            { text: 'Dear {{client.name}}, ref {{matter.reference}}.' },
          ],
        }),
      ).toString('base64');

      const adminPerson = store.people.find((p) => p.id === 'P-000001')!;
      const sessionPayload = verifySignedEntraSessionCookie(
        createSignedEntraSessionCookie({
          personId: adminPerson.id,
          tenantId: 'not-a-law-firm',
          oid:
            adminPerson.entraObjectId ?? '00000000-0000-4000-8000-000000000001',
          tid: '11111111-2222-3333-4444-000000000000',
          sub: adminPerson.id,
          email:
            adminPerson.emails[0]?.address ?? 'aldous.vane@notalawfirm.example',
          displayName: `${adminPerson.firstName} ${adminPerson.surname}`,
          entraRoles: ['managing_partner', 'admin'],
          mappedRoles: ['managing_partner', 'admin'],
          entraGroups: [],
          mfaVerified: true,
          amr: ['pwd', 'mfa'],
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      )!;

      // 1. requireApproval: true -> audits "Document Template Submitted for Approval ..." with newValue: "Submitted"
      setActiveTenantConfigForTesting({
        ...(notALawFirmBaseConfig as unknown as Record<string, unknown>),
        documentGeneration: {
          approval: {
            requireApproval: true,
            allowSelfApproval: false,
          },
        },
      });

      const draftReq = await uploadTemplateDraftService(
        {
          code: 'TPL-SVC-REQ',
          name: 'Service Submitted Template',
          description: 'Template requiring approval',
          category: 'General',
          outputDocumentType: 'Letter',
          filenamePattern: '{matter.reference}-svc-req',
          availabilityRules: { sourceContexts: ['matter'] },
          fileName: 'svc-req.docx',
          docxBase64,
        },
        'P-000001',
        sessionPayload,
      );
      const submitReq = await submitTemplateVersionService(
        draftReq.version.id,
        'Ready for review',
        'P-000001',
        sessionPayload,
      );
      expect(submitReq.version.status).toBe('Submitted');
      const submittedAudit = (
        await auditEntriesForRecord('matter', draftReq.template.id, templateAuditMark)
      ).find(
        (a) =>
          a.recordId === draftReq.template.id &&
          a.field === 'Document Template Submitted for Approval (TPL-SVC-REQ v1)',
      );
      expect(submittedAudit).toBeDefined();
      expect(submittedAudit?.oldValue).toBe('Draft');
      expect(submittedAudit?.newValue).toBe('Submitted');

      // 2. requireApproval: false -> audits "Document Template Activated (approval not required) ..." with newValue: "Active"
      setActiveTenantConfigForTesting({
        ...(notALawFirmBaseConfig as unknown as Record<string, unknown>),
        documentGeneration: {
          approval: {
            requireApproval: false,
            allowSelfApproval: false,
          },
        },
      });

      const draftAuto = await uploadTemplateDraftService(
        {
          code: 'TPL-SVC-AUTO',
          name: 'Service Auto-Activated Template',
          description: 'Template activated directly on submit',
          category: 'General',
          outputDocumentType: 'Letter',
          filenamePattern: '{matter.reference}-svc-auto',
          availabilityRules: { sourceContexts: ['matter'] },
          fileName: 'svc-auto.docx',
          docxBase64,
        },
        'P-000001',
        sessionPayload,
      );
      const submitAuto = await submitTemplateVersionService(
        draftAuto.version.id,
        'Activate directly',
        'P-000001',
        sessionPayload,
      );
      expect(submitAuto.version.status).toBe('Active');
      const activatedAudit = (
        await auditEntriesForRecord('matter', draftAuto.template.id, templateAuditMark)
      ).find(
        (a) =>
          a.recordId === draftAuto.template.id &&
          a.field ===
            'Document Template Activated (approval not required) (TPL-SVC-AUTO v1)',
      );
      expect(activatedAudit).toBeDefined();
      expect(activatedAudit?.oldValue).toBe('Draft');
      expect(activatedAudit?.newValue).toBe('Active');
    } finally {
      saveStore(snapshot);
    }
  });

  it('enforces server-side reviewedBy and reviewedOn from the authenticated actor and rejects invalid reviewStatus in saveKeyDatesConfigRecord (R284, R295)', async () => {
    const store = getStore();
    const snapshot = structuredClone(store);
    const kdRepo = getKeyDateRepository();
    const originalOverride = await kdRepo.getKeyDatesTenantConfig(testTenantCtx('P-000004'));
    try {
      await runAsTestActor('P-000004', async () => {
        const current = structuredClone(await getKeyDatesConfig(store));
        expect((current.limitationRuleSets ?? []).length).toBeGreaterThan(0);
        // Prepare rule set 0 as newly reviewed, attempting to spoof reviewedBy as P-000001 and backdate reviewedOn to 2020-01-01 while saving as P-000004 (admin)
        const firstRuleSet = current.limitationRuleSets![0]!;
        const todayIso = new Date().toISOString().slice(0, 10);
        const nextForReview = structuredClone(current);
        nextForReview.limitationRuleSets![0] = {
          ...firstRuleSet,
          version: firstRuleSet.version + 1,
          reviewStatus: 'reviewed',
          reviewedBy: 'P-000001',
          reviewedOn: '2020-01-01',
        };

        const savedReviewed = await saveKeyDatesConfigRecord(
          nextForReview,
          'Mark rule set reviewed in test',
          'P-000004',
          { mfaVerified: true },
        );
        expect(savedReviewed.ok).toBe(true);
        expect(
          savedReviewed.config?.limitationRuleSets?.[0]?.reviewStatus,
        ).toBe('reviewed');
        expect(savedReviewed.config?.limitationRuleSets?.[0]?.reviewedBy).toBe(
          'P-000004',
        );
        expect(savedReviewed.config?.limitationRuleSets?.[0]?.reviewedOn).toBe(
          todayIso,
        );

        // R310: An unchanged reviewed rule set (same version) keeps its stored reviewedOn as well as reviewedBy
        const storedWithPastReview = structuredClone(savedReviewed.config!);
        storedWithPastReview.limitationRuleSets![0] = {
          ...storedWithPastReview.limitationRuleSets![0]!,
          reviewedBy: 'P-000001',
          reviewedOn: '2025-05-10',
        };
        await kdRepo.putKeyDatesTenantConfig(testTenantCtx('P-000004'), storedWithPastReview);

        const unchangedReviewedPayload = structuredClone(storedWithPastReview);
        unchangedReviewedPayload.limitationRuleSets![0] = {
          ...unchangedReviewedPayload.limitationRuleSets![0]!,
          // Same version and reviewStatus: 'reviewed', attempting to spoof reviewedBy and reviewedOn
          reviewedBy: 'P-000004',
          reviewedOn: '2020-01-01',
        };
        const savedUnchangedReviewed = await saveKeyDatesConfigRecord(
          unchangedReviewedPayload,
          'Save config without changing reviewed rule set version',
          'P-000004',
          { mfaVerified: true },
        );
        expect(savedUnchangedReviewed.ok).toBe(true);
        expect(
          savedUnchangedReviewed.config?.limitationRuleSets?.[0]?.reviewedBy,
        ).toBe('P-000001');
        expect(
          savedUnchangedReviewed.config?.limitationRuleSets?.[0]?.reviewedOn,
        ).toBe('2025-05-10');

        // R295: Reject unknown reviewStatus values rather than coercing them to 'unreviewed'
        const invalidStatusConfig = structuredClone(savedReviewed.config!);
        (
          invalidStatusConfig.limitationRuleSets![0] as unknown as {
            reviewStatus: string;
          }
        ).reviewStatus = 'invalid_status';
        const rejectedInvalidStatus = await saveKeyDatesConfigRecord(
          invalidStatusConfig,
          'Attempt invalid reviewStatus',
          'P-000004',
          { mfaVerified: true },
        );
        expect(rejectedInvalidStatus.ok).toBe(false);
        expect(rejectedInvalidStatus.error).toMatch(/Invalid reviewStatus/i);

        // Unmarking reviewStatus clears both reviewedBy and reviewedOn even if the client sends them
        const nextUnreviewed = structuredClone(savedReviewed.config!);
        nextUnreviewed.limitationRuleSets![0] = {
          ...nextUnreviewed.limitationRuleSets![0]!,
          reviewStatus: 'unreviewed',
          reviewedBy: 'P-000004',
          reviewedOn: '2020-01-01',
        };

        const savedUnreviewed = await saveKeyDatesConfigRecord(
          nextUnreviewed,
          'Unmark rule set review status in test',
          'P-000004',
          { mfaVerified: true },
        );
        expect(savedUnreviewed.ok).toBe(true);
        expect(
          savedUnreviewed.config?.limitationRuleSets?.[0]?.reviewStatus,
        ).toBe('unreviewed');
        expect(
          savedUnreviewed.config?.limitationRuleSets?.[0]?.reviewedBy,
        ).toBeUndefined();
        expect(
          savedUnreviewed.config?.limitationRuleSets?.[0]?.reviewedOn,
        ).toBeUndefined();
      });
    } finally {
      saveStore(snapshot);
      await kdRepo.putKeyDatesTenantConfig(testTenantCtx('P-000004'), originalOverride);
    }
  });

  it('returns structured ActionDenied (without throwing) when allowManualEntry is false on manual creation, supersede, or spoofed system source (R285, R294)', async () => {
    const store = getStore();
    const snapshot = structuredClone(store);
    const kdRepo = getKeyDateRepository();
    const originalOverride = await kdRepo.getKeyDatesTenantConfig(testTenantCtx('P-000001'));
    try {
      await runAsTestActor('P-000001', async () => {
        const current = structuredClone(await getKeyDatesConfig(store));
        const targetType = current.keyDateTypes![0]!;
        current.keyDateTypes![0] = {
          ...targetType,
          allowManualEntry: false,
        };
        await kdRepo.putKeyDatesTenantConfig(testTenantCtx('P-000001'), current);

        const directDenied = validateKeyDateManualEntry(
          current,
          targetType.id,
          'manual',
        );
        expect(directDenied.ok).toBe(false);
        if (!directDenied.ok) {
          expect(directDenied.error).toContain('Manual entry is disabled');
        }

        const directCalculated = validateKeyDateManualEntry(
          current,
          targetType.id,
          'calculated',
        );
        expect(directCalculated).toEqual({ ok: true });

        const matter = store.matters[0]!;
        const manualAttempt = await createOrProposeKeyDateRecord(
          {
            matterId: matter.id,
            keyDateTypeId: targetType.id,
            title: 'Manual attempt on calculator-only type',
            dueDate: '2027-06-01',
            source: 'manual',
            intent: 'propose',
          },
          'P-000001',
        );
        expect(manualAttempt.ok).toBe(false);
        expect(isActionDenied(manualAttempt)).toBe(true);
        if (isActionDenied(manualAttempt)) {
          expect(manualAttempt.code).toBe('FORBIDDEN');
          expect(manualAttempt.message).toContain('Manual entry is disabled');
        }

        // R294: A client-sent source: 'document_extraction' is rejected with ActionDenied
        const spoofedDocExtraction = await createOrProposeKeyDateRecord(
          {
            matterId: matter.id,
            keyDateTypeId: targetType.id,
            title: 'Spoofed document_extraction attempt',
            dueDate: '2027-06-01',
            source: 'document_extraction',
            intent: 'propose',
          },
          'P-000001',
        );
        expect(spoofedDocExtraction.ok).toBe(false);
        expect(isActionDenied(spoofedDocExtraction)).toBe(true);
        if (isActionDenied(spoofedDocExtraction)) {
          expect(spoofedDocExtraction.code).toBe('FORBIDDEN');
          expect(spoofedDocExtraction.message).toMatch(
            /cannot be set by a client request|Manual entry is disabled/i,
          );
        }

        const firstRuleSet = current.limitationRuleSets![0]!;
        const firstRule = firstRuleSet.rules[0]!;
        const triggers = {
          accrualDate: '2021-06-01',
          dateOfKnowledge: '2021-06-01',
        };
        const calculatedAttempt = await createOrProposeKeyDateRecord(
          {
            matterId: matter.id,
            keyDateTypeId: targetType.id,
            title: 'Calculated attempt on calculator-only type',
            dueDate: '2027-06-01',
            source: 'calculated',
            calculation: {
              ruleSetId: firstRuleSet.id,
              ruleSetVersion: firstRuleSet.version,
              ruleSetReviewStatus: firstRuleSet.reviewStatus,
              ruleId: firstRule.id,
              triggers,
              calculatedDate: '2027-06-01',
              explanation: ['Calculated from rule'],
              overridden: false,
              overrideReason: 'Rule test date',
            },
            intent: 'propose',
          },
          'P-000001',
        );
        expect(calculatedAttempt.ok).toBe(true);
        expect(calculatedAttempt.keyDate?.source).toBe('calculated');

        const createdKd = calculatedAttempt.keyDate!;
        createdKd.status = 'confirmed';
        await kdRepo.putKeyDate(testTenantCtx('P-000001'), createdKd);

        // R294: Superseding into a manual date on a type with allowManualEntry: false is denied with ActionDenied
        const configWithoutRuleSets = structuredClone(await getKeyDatesConfig(getStore()));
        configWithoutRuleSets.limitationRuleSets = [];
        await kdRepo.putKeyDatesTenantConfig(testTenantCtx('P-000001'), configWithoutRuleSets);

        const supersedeToManualAttempt = await supersedeConfirmedKeyDateRecord(
          createdKd.id,
          {
            dueDate: '2027-07-01',
            notes: 'Attempted supersede to manual when rule removed and allowManualEntry is false',
          },
          'Rule removed supersede test',
          'P-000001',
        );
        expect(supersedeToManualAttempt.ok).toBe(false);
        expect(isActionDenied(supersedeToManualAttempt)).toBe(true);
        if (isActionDenied(supersedeToManualAttempt)) {
          expect(supersedeToManualAttempt.code).toBe('FORBIDDEN');
          expect(supersedeToManualAttempt.message).toContain(
            'Manual entry is disabled',
          );
        }

        // R306: Superseding a carried_from_enquiry key date with a new due date on a type with allowManualEntry: false is denied with ActionDenied (FORBIDDEN)
        const carriedKd = structuredClone(createdKd);
        carriedKd.id = 'KD-R306-CARRIED';
        carriedKd.source = 'carried_from_enquiry';
        carriedKd.calculation = undefined;
        carriedKd.dueDate = '2027-06-01';
        carriedKd.status = 'confirmed';
        await kdRepo.putKeyDate(testTenantCtx('P-000001'), carriedKd);

        const supersedeCarriedDenied = await supersedeConfirmedKeyDateRecord(
          carriedKd.id,
          {
            dueDate: '2027-08-15',
            notes: 'Attempted manual date change on carried_from_enquiry key date',
          },
          'Manual date change on carried_from_enquiry test',
          'P-000001',
        );
        expect(supersedeCarriedDenied.ok).toBe(false);
        expect(isActionDenied(supersedeCarriedDenied)).toBe(true);
        if (isActionDenied(supersedeCarriedDenied)) {
          expect(supersedeCarriedDenied.code).toBe('FORBIDDEN');
          expect(supersedeCarriedDenied.message).toContain(
            'Manual entry is disabled',
          );
        }

        // R306: The same supersede on a type that allows manual entry succeeds and stores source: 'manual'
        const configAllowingManual = structuredClone(await getKeyDatesConfig(getStore()));
        configAllowingManual.keyDateTypes![0] = {
          ...configAllowingManual.keyDateTypes![0]!,
          allowManualEntry: true,
        };
        await kdRepo.putKeyDatesTenantConfig(testTenantCtx('P-000001'), configAllowingManual);

        const supersedeCarriedAllowed = await supersedeConfirmedKeyDateRecord(
          carriedKd.id,
          {
            dueDate: '2027-08-15',
            notes: 'Allowed manual date change on carried_from_enquiry key date',
          },
          'Manual date change allowed test',
          'P-000001',
        );
        expect(supersedeCarriedAllowed.ok).toBe(true);
        expect(supersedeCarriedAllowed.replacementKeyDate?.source).toBe('manual');
        expect(supersedeCarriedAllowed.replacementKeyDate?.dueDate).toBe(
          '2027-08-15',
        );
      });
    } finally {
      saveStore(snapshot);
      await kdRepo.putKeyDatesTenantConfig(testTenantCtx('P-000001'), originalOverride);
    }
  });
  it('validates optional keyVault.vaultName and keyVault.vaultUri deployment outputs including 24-character truncated vault names and rejects cross-tenant kv:// references (S0-13b, R413)', () => {
    const longSlugConfig = loadAndValidateTenantConfig(
      {
        ...notALawFirmBaseConfig,
        tenantId: 'fictional-chambers-uk-chancery',
        environment: 'test',
        keyVault: {
          vaultName: 'kv-fictionalchambersuk-t',
          vaultUri: 'https://kv-fictionalchambersuk-t.vault.azure.net/',
        },
        integrations: {
          ...notALawFirmBaseConfig.integrations,
          pmsConnectionSecretVaultRef:
            'kv://kv-fictionalchambersuk-t/pms-connection-string',
          companiesHouseApiKeyVaultRef:
            'kv://kv-fictionalchambersuk-t/companies-house-api-key',
        },
        documentStores: [
          {
            ...notALawFirmBaseConfig.documentStores[0]!,
            auth: {
              ...notALawFirmBaseConfig.documentStores[0]!.auth,
              certificateKeyVaultSecretRef:
                'kv://kv-fictionalchambersuk-t/sp-provisioning-cert',
            },
          },
        ],
      },
      {},
      'test',
      'multi_tenant',
    );
    expect(longSlugConfig.keyVault?.vaultName).toBe('kv-fictionalchambersuk-t');
    expect(longSlugConfig.keyVault?.vaultUri).toBe(
      'https://kv-fictionalchambersuk-t.vault.azure.net/',
    );

    expect(() =>
      loadAndValidateTenantConfig(
        {
          ...notALawFirmBaseConfig,
          keyVault: {
            vaultName: 'kv-notalawfirm-test',
            vaultUri: 'https://kv-notalawfirm-test.vault.azure.net/',
          },
          documentStores: [
            {
              ...notALawFirmBaseConfig.documentStores[0]!,
              auth: {
                ...notALawFirmBaseConfig.documentStores[0]!.auth,
                certificateKeyVaultSecretRef:
                  'kv://kv-fictionalchambersuk-t/sp-provisioning-cert',
              },
            },
          ],
        },
        {},
        'test',
        'multi_tenant',
      ),
    ).toThrow(/TENANCY_CROSS_TENANT_VAULT_ACCESS_DENIED/);
  });
  it('validates optional database.dedicatedServerHost for tenants requiring a dedicated PostgreSQL server / CMK (S0-14, ADR 0028 Decision 1)', () => {
    const dedicatedCfg = loadAndValidateTenantConfig(
      {
        ...notALawFirmBaseConfig,
        database: {
          dedicatedServerHost: 'psql-notalawfirm-cmk-test.postgres.database.azure.com',
        },
      },
      {},
      'test',
      'multi_tenant',
    );
    expect(dedicatedCfg.database?.dedicatedServerHost).toBe(
      'psql-notalawfirm-cmk-test.postgres.database.azure.com',
    );
  });
});