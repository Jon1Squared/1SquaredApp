import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');

const TARGET_WHOLE_TENANT_CALLEES = new Set([
  'listAllMattersUnfiltered',
  'listAllEnquiriesUnfiltered',
  'listAllQuotesUnfiltered',
  'listAllTasksUnfiltered',
  'listAllSignOffsUnfiltered',
  'listAllPeople',
  'listAllOrganisations',
  'listAllLinks',
  'listAllNotes',
  'listAllMergeHistory',
  'loadTenantPmsSnapshot',
  'getTenantPmsSource',
  'hydrateTenantPmsSource',
  'listMatters',
  'listClients',
  'getFirmFinanceRollupsSql',
  'listAllVisibleKeyDates',
  'loadFullConflictSearchGraph',
]);

const TARGET_PAGE_CALLEES = new Set(['getAppSnapshot', 'getAppSnapshotInScope']);

const TARGET_CLIENT_SCAN_CALLEES = new Set([
  'findPersonDuplicates',
  'findOrganisationDuplicates',
  'findCandidateDuplicates',
  'searchMatterConflicts',
  'runEnquiryConflictSearch',
]);

interface AllowListEntry {
  readonly file: string;
  readonly fn: string;
  readonly callees: readonly [string, ...string[]];
  readonly reason: string;
}

/**
 * Intentionally whole-tenant batch jobs, admin bulk actions, seed/demo utilities,
 * firm-wide SQL aggregate reports, and legacy PMS wrappers (S1-02a B15 guard).
 */
export const PERMANENT_ALLOW_LIST: readonly AllowListEntry[] = [
  {
    file: 'src/server/services.ts',
    fn: 'rerunAutomaticPmsMatching',
    callees: [
      'listAllPeople',
      'listAllOrganisations',
      'listAllMattersUnfiltered',
      'getTenantPmsSource',
      'listClients',
      'listMatters',
    ],
    reason: 'Explicit admin bulk PMS auto-matching batch operation across firm matters/entities.',
  },
  {
    file: 'src/server/services.ts',
    fn: 'executeKeyDateRemindersForTenant',
    callees: [
      'listAllPeople',
      'listAllMattersUnfiltered',
      'listAllTasksUnfiltered',
    ],
    reason: 'Scheduled background job (guardedJob key-date-reminders) iterating due tenant reminders.',
  },
  {
    file: 'src/server/services.ts',
    fn: 'executeRegisterRemindersForTenant',
    callees: ['listAllPeople', 'listAllMattersUnfiltered'],
    reason: 'Scheduled background job (guardedJob register-reminders) scanning open tenant registers.',
  },
  {
    file: 'src/server/services.ts',
    fn: 'executeNotificationDigestsForTenant',
    callees: [
      'listAllPeople',
      'listAllMattersUnfiltered',
      'listAllEnquiriesUnfiltered',
      'listAllQuotesUnfiltered',
      'listAllTasksUnfiltered',
    ],
    reason: 'Scheduled background job (guardedJob notification-digests) building undigested notification emails.',
  },
  {
    file: 'src/server/services.ts',
    fn: 'resetAllDemoData',
    callees: ['listAllPeople'],
    reason: 'Non-live test/demo seed reset helper.',
  },
  {
    file: 'src/server/services.ts',
    fn: 'runEnquiryRetentionAnonymisationForTenant',
    callees: ['listAllEnquiriesUnfiltered'],
    reason:
      'Scheduled bulk enquiry-retention sweep when specificEnquiryId is omitted (single-enquiry manual mode uses getEnquiryById; actor RBAC uses employeesAndLeaversOnly).',
  },
  {
    file: 'src/server/documentStoreServices.ts',
    fn: 'applyAdminTemplateAdditionsToOpenMatters',
    callees: ['listAllMattersUnfiltered'],
    reason: 'Explicit admin bulk SharePoint folder-provisioning batch across open matters.',
  },
  {
    file: 'src/server/storePostgresImport.ts',
    fn: 'importFirmStoreModulesToPostgres',
    callees: ['listAllMattersUnfiltered', 'listAllEnquiriesUnfiltered'],
    reason: 'Seed/migration store import verification utility across all tenant records.',
  },
  {
    file: 'src/pms/pmsSource.ts',
    fn: 'getTenantPmsSource',
    callees: ['loadTenantPmsSnapshot'],
    reason: 'Legacy batch/seed PMS hydrator wrapper (disallowed in request-path server services).',
  },
  {
    file: 'src/pms/pmsSource.ts',
    fn: 'hydrateTenantPmsSource',
    callees: ['getTenantPmsSource'],
    reason: 'Legacy batch/seed PMS hydrator wrapper delegating to getTenantPmsSource.',
  },
  {
    file: 'src/server/financeServices.ts',
    fn: 'getFirmFinance',
    callees: ['getFirmFinanceRollupsSql'],
    reason: 'Firm-wide SQL finance roll-up summary across visible firm matters.',
  },
  {
    file: 'src/server/services.ts',
    fn: 'queryKeyDatesTeamDiaryRecord',
    callees: ['listAllVisibleKeyDates'],
    reason: 'Firm/team diary query using PostgreSQL visibility-filtered key dates repository reader.',
  },
];

export const MAX_PERMANENT_ALLOW_LIST_COUNT = 12;

export interface TemporaryConflictGraphAllowListEntry extends AllowListEntry {
  readonly backlogItem: 'B22';
}

/**
 * Temporary allow-list confining `loadFullConflictSearchGraph` and its 7 named
 * live conflict callers (including `previewIntakeDuplicatesAndConflictsRecord`) strictly to
 * backlog item `B22` (removed once scoped candidate pre-filter parity is proven equivalent in production, `R677`).
 */
export const TEMPORARY_CONFLICT_GRAPH_ALLOW_LIST: readonly TemporaryConflictGraphAllowListEntry[] =
  [
    {
      file: 'src/server/services.ts',
      fn: 'loadFullConflictSearchGraph',
      callees: [
        'listAllPeople',
        'listAllOrganisations',
        'listAllLinks',
        'listAllMattersUnfiltered',
        'listAllEnquiriesUnfiltered',
      ],
      reason: 'conflict completeness: candidate pre-filter not yet proven equivalent',
      backlogItem: 'B22',
    },
    {
      file: 'src/server/services.ts',
      fn: 'saveMatterRecord',
      callees: ['loadFullConflictSearchGraph'],
      reason: 'conflict completeness: candidate pre-filter not yet proven equivalent',
      backlogItem: 'B22',
    },
    {
      file: 'src/server/services.ts',
      fn: 'runMatterConflictSearchRecord',
      callees: ['loadFullConflictSearchGraph'],
      reason: 'conflict completeness: candidate pre-filter not yet proven equivalent',
      backlogItem: 'B22',
    },
    {
      file: 'src/server/services.ts',
      fn: 'updateMatterConflictRecord',
      callees: ['loadFullConflictSearchGraph'],
      reason: 'conflict completeness: candidate pre-filter not yet proven equivalent',
      backlogItem: 'B22',
    },
    {
      file: 'src/server/services.ts',
      fn: 'saveEnquiryRecord',
      callees: ['loadFullConflictSearchGraph'],
      reason: 'conflict completeness: candidate pre-filter not yet proven equivalent',
      backlogItem: 'B22',
    },
    {
      file: 'src/server/services.ts',
      fn: 'prepareEnquiryConversion',
      callees: ['loadFullConflictSearchGraph'],
      reason: 'conflict completeness: candidate pre-filter not yet proven equivalent',
      backlogItem: 'B22',
    },
    {
      file: 'src/server/services.ts',
      fn: 'prepareQuoteConversionRecord',
      callees: ['loadFullConflictSearchGraph'],
      reason: 'conflict completeness: candidate pre-filter not yet proven equivalent',
      backlogItem: 'B22',
    },
    {
      file: 'src/server/services.ts',
      fn: 'previewIntakeDuplicatesAndConflictsRecord',
      callees: ['loadFullConflictSearchGraph'],
      reason: 'conflict completeness: candidate pre-filter not yet proven equivalent',
      backlogItem: 'B22',
    },
  ];

export const MAX_TEMPORARY_CONFLICT_GRAPH_ALLOW_LIST_COUNT = 8;

/**
 * Snapshot & client-form baseline deferred strictly to WP1b (S1-02b)
 * (ratchets down to 0 in S1-02b; must never grow or include matters/enquiries/quotes/tasks/signOffs/pms).
 */
export const DEFERRED_S1_02B_ALLOW_LIST: readonly AllowListEntry[] = [
  {
    file: 'src/server/services.ts',
    fn: 'getAppSnapshot',
    callees: ['getAppSnapshotInScope'],
    reason: 'Legacy whole-shell loader deferred to WP1b (S1-02b).',
  },
  {
    file: 'src/server/services.ts',
    fn: 'getAppSnapshotInScope',
    callees: [
      'listAllPeople',
      'listAllOrganisations',
      'listAllLinks',
      'listAllNotes',
      'listAllMergeHistory',
      'listAllVisibleKeyDates',
    ],
    reason:
      'Temporary people/org/links/notes/mergeHistory/visibleKeyDates hydration inside getAppSnapshotInScope deferred to WP1b (matters/enquiries/quotes/tasks/signOffs/PMS converted in S1-02a).',
  },
];

// Exact S1-02b baseline: 25 app layout/page getAppSnapshot calls + 6 component client-scan calls + 7 getAppSnapshot/InScope calls = 38
export const MAX_DEFERRED_S1_02B_BASELINE_COUNT = 38;

interface AstCallFinding {
  readonly file: string;
  readonly line: number;
  readonly fn: string;
  readonly callee: string;
}

function walkSourceFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === '__tests__' ||
        entry.name === '.next' ||
        entry.name === 'node_modules'
      ) {
        continue;
      }
      results.push(...walkSourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) continue;
    results.push(full);
  }
  return results;
}

function getMemberAccessName(expr: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (
    ts.isElementAccessExpression(expr) &&
    ts.isStringLiteralLike(expr.argumentExpression)
  ) {
    return expr.argumentExpression.text;
  }
  return null;
}

function getCalleeName(
  expr: ts.LeftHandSideExpression,
  aliasMap?: ReadonlyMap<string, string>,
): string | null {
  if (ts.isIdentifier(expr)) {
    return aliasMap?.get(expr.text) ?? expr.text;
  }
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (
    ts.isElementAccessExpression(expr) &&
    ts.isStringLiteralLike(expr.argumentExpression)
  ) {
    return expr.argumentExpression.text;
  }
  return null;
}

function collectWholeTenantAliases(
  sourceFile: ts.SourceFile,
): Map<string, string> {
  const aliasMap = new Map<string, string>();
  const allMonitored = new Set([
    ...TARGET_WHOLE_TENANT_CALLEES,
    ...TARGET_PAGE_CALLEES,
    ...TARGET_CLIENT_SCAN_CALLEES,
  ]);
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        const rhsName = ts.isIdentifier(node.initializer)
          ? aliasMap.get(node.initializer.text) ?? node.initializer.text
          : getMemberAccessName(node.initializer);
        if (rhsName && allMonitored.has(rhsName)) {
          aliasMap.set(node.name.text, rhsName);
        }
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) continue;
          const propName = el.propertyName
            ? ts.isIdentifier(el.propertyName) ||
              ts.isStringLiteralLike(el.propertyName)
              ? el.propertyName.text
              : null
            : el.name.text;
          if (propName && allMonitored.has(propName)) {
            aliasMap.set(el.name.text, propName);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return aliasMap;
}

function hasEmployeesAndLeaversOnlyOption(node: ts.CallExpression): boolean {
  const optArg = node.arguments[1];
  if (!optArg || !ts.isObjectLiteralExpression(optArg)) return false;
  return optArg.properties.some((prop) => {
    if (!ts.isPropertyAssignment(prop)) return false;
    const keyName = ts.isIdentifier(prop.name)
      ? prop.name.text
      : ts.isStringLiteral(prop.name)
        ? prop.name.text
        : null;
    return (
      keyName === 'employeesAndLeaversOnly' &&
      prop.initializer.kind === ts.SyntaxKind.TrueKeyword
    );
  });
}

function getEnclosingFunctionName(node: ts.Node): string {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) {
      return cur.name.text;
    }
    if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) {
      return cur.name.text;
    }
    if (
      (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
      cur.parent &&
      ts.isVariableDeclaration(cur.parent) &&
      ts.isIdentifier(cur.parent.name)
    ) {
      return cur.parent.name.text;
    }
    if (
      (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
      cur.parent &&
      ts.isPropertyAssignment(cur.parent) &&
      ts.isIdentifier(cur.parent.name) &&
      cur.parent.name.text === 'GET'
    ) {
      return 'GET';
    }
    cur = cur.parent;
  }
  return '<module>';
}

function matchesAllowList(
  finding: AstCallFinding,
  allowList: readonly AllowListEntry[],
): boolean {
  return allowList.some(
    (entry) =>
      entry.file === finding.file &&
      entry.fn === finding.fn &&
      (!entry.callees || entry.callees.includes(finding.callee)),
  );
}

export function scanSourceTextForWholeTenantCalls(
  relPath: string,
  sourceText: string,
): {
  unexpected: AstCallFinding[];
  deferred: AstCallFinding[];
  permanentAllowMatched: AstCallFinding[];
  temporaryConflictMatched: AstCallFinding[];
} {
  const unexpected: AstCallFinding[] = [];
  const deferred: AstCallFinding[] = [];
  const permanentAllowMatched: AstCallFinding[] = [];
  const temporaryConflictMatched: AstCallFinding[] = [];

  const sourceFile = ts.createSourceFile(
    relPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    relPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const aliasMap = collectWholeTenantAliases(sourceFile);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = getCalleeName(node.expression, aliasMap);
      if (callee) {
        const isPageFile = relPath.startsWith('src/app/');
        const isComponentFile = relPath.startsWith('src/components/');
        let flagged = false;

        if (TARGET_WHOLE_TENANT_CALLEES.has(callee)) {
          if (
            callee === 'listAllPeople' &&
            hasEmployeesAndLeaversOnlyOption(node)
          ) {
            flagged = false;
          } else {
            flagged = true;
          }
        } else if (TARGET_PAGE_CALLEES.has(callee)) {
          flagged = true;
        } else if (isComponentFile && TARGET_CLIENT_SCAN_CALLEES.has(callee)) {
          flagged = true;
        }

        if (flagged) {
          const line =
            sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
              .line + 1;
          const finding: AstCallFinding = {
            file: relPath,
            line,
            fn: getEnclosingFunctionName(node),
            callee,
          };

          if (matchesAllowList(finding, PERMANENT_ALLOW_LIST)) {
            permanentAllowMatched.push(finding);
          } else if (
            matchesAllowList(finding, TEMPORARY_CONFLICT_GRAPH_ALLOW_LIST)
          ) {
            temporaryConflictMatched.push(finding);
          } else if (
            matchesAllowList(finding, DEFERRED_S1_02B_ALLOW_LIST) ||
            (isPageFile && callee === 'getAppSnapshot') ||
            (isComponentFile && TARGET_CLIENT_SCAN_CALLEES.has(callee))
          ) {
            deferred.push(finding);
          } else {
            unexpected.push(finding);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return {
    unexpected,
    deferred,
    permanentAllowMatched,
    temporaryConflictMatched,
  };
}

function scanWholeTenantCalls(): {
  unexpected: AstCallFinding[];
  deferred: AstCallFinding[];
  permanentAllowMatched: AstCallFinding[];
  temporaryConflictMatched: AstCallFinding[];
} {
  const scanDirs = [
    path.join(REPO_ROOT, 'src', 'server'),
    path.join(REPO_ROOT, 'src', 'pms'),
    path.join(REPO_ROOT, 'src', 'app'),
    path.join(REPO_ROOT, 'src', 'components'),
  ];
  const files = scanDirs.flatMap((d) => walkSourceFiles(d));
  const unexpected: AstCallFinding[] = [];
  const deferred: AstCallFinding[] = [];
  const permanentAllowMatched: AstCallFinding[] = [];
  const temporaryConflictMatched: AstCallFinding[] = [];

  for (const absPath of files) {
    const relPath = path.relative(REPO_ROOT, absPath).replace(/\\/g, '/');
    const sourceText = fs.readFileSync(absPath, 'utf8');
    const fileRes = scanSourceTextForWholeTenantCalls(relPath, sourceText);
    unexpected.push(...fileRes.unexpected);
    deferred.push(...fileRes.deferred);
    permanentAllowMatched.push(...fileRes.permanentAllowMatched);
    temporaryConflictMatched.push(...fileRes.temporaryConflictMatched);
  }

  return {
    unexpected,
    deferred,
    permanentAllowMatched,
    temporaryConflictMatched,
  };
}

describe('S1-02a B15 AST guard: no whole-tenant loads in server request paths', () => {
  it('enforces 0 non-allow-listed whole-tenant repository or snapshot calls across src/server, src/app, src/components, and src/pms', () => {
    const { unexpected, deferred } = scanWholeTenantCalls();

    if (unexpected.length > 0) {
      const formatted = unexpected
        .map((f) => `  - ${f.file}:${f.line} [${f.fn}] calls ${f.callee}()`)
        .join('\n');
      expect(
        unexpected,
        `Found ${unexpected.length} non-scoped whole-tenant call sites outside PERMANENT_ALLOW_LIST & S1-02b baseline:\n${formatted}`,
      ).toEqual([]);
    }

    expect(deferred.length).toBeLessThanOrEqual(
      MAX_DEFERRED_S1_02B_BASELINE_COUNT,
    );
  });

  it('R671: requires callees + ratchet on PERMANENT_ALLOW_LIST, monitors PMS/rollup/keydate loaders, and catches element-access and alias calls', () => {
    for (const expectedCallee of [
      'listMatters',
      'listClients',
      'getFirmFinanceRollupsSql',
      'listAllVisibleKeyDates',
    ]) {
      expect(TARGET_WHOLE_TENANT_CALLEES.has(expectedCallee)).toBe(true);
    }

    for (const entry of PERMANENT_ALLOW_LIST) {
      expect(
        Array.isArray(entry.callees) && entry.callees.length > 0,
        `PERMANENT_ALLOW_LIST entry ${entry.file}:${entry.fn} must declare explicit non-empty callees`,
      ).toBe(true);
    }

    expect(typeof MAX_PERMANENT_ALLOW_LIST_COUNT).toBe('number');
    expect(PERMANENT_ALLOW_LIST.length).toBeLessThanOrEqual(
      MAX_PERMANENT_ALLOW_LIST_COUNT,
    );

    const elementRes = scanSourceTextForWholeTenantCalls(
      'src/server/syntheticGuardCheck.ts',
      `async function handler(matterRepo: any, ctx: any) { return matterRepo['listAllMattersUnfiltered'](ctx); }`,
    );
    expect(elementRes.unexpected.some((f) => f.callee === 'listAllMattersUnfiltered')).toBe(true);

    const destructuredRes = scanSourceTextForWholeTenantCalls(
      'src/server/syntheticGuardCheck.ts',
      `async function handler(matterRepo: any, ctx: any) { const { listAllMattersUnfiltered: fetchAllM } = matterRepo; return fetchAllM(ctx); }`,
    );
    expect(destructuredRes.unexpected.some((f) => f.callee === 'listAllMattersUnfiltered')).toBe(true);

    const aliasRes = scanSourceTextForWholeTenantCalls(
      'src/server/syntheticGuardCheck.ts',
      `async function handler(partyRepo: any, ctx: any) { const getAllOrgs = partyRepo.listAllOrganisations; return getAllOrgs(ctx); }`,
    );
    expect(aliasRes.unexpected.some((f) => f.callee === 'listAllOrganisations')).toBe(true);
  });

  it('R677: flags unapproved loadFullConflictSearchGraph callers and confines the 8 conflict-graph entries to TEMPORARY_CONFLICT_GRAPH_ALLOW_LIST (B22)', () => {
    expect(TARGET_WHOLE_TENANT_CALLEES.has('loadFullConflictSearchGraph')).toBe(
      true,
    );
    expect(
      PERMANENT_ALLOW_LIST.some((e) => e.fn === 'loadFullConflictSearchGraph'),
    ).toBe(false);
    expect(TEMPORARY_CONFLICT_GRAPH_ALLOW_LIST.length).toBeLessThanOrEqual(
      MAX_TEMPORARY_CONFLICT_GRAPH_ALLOW_LIST_COUNT,
    );
    for (const entry of TEMPORARY_CONFLICT_GRAPH_ALLOW_LIST) {
      expect(entry.backlogItem).toBe('B22');
      expect(entry.callees.length).toBeGreaterThan(0);
    }

    const r677Synthetic = scanSourceTextForWholeTenantCalls(
      'src/server/syntheticR677.ts',
      `export async function sneakyCaller(ctx: unknown) { return loadFullConflictSearchGraph(ctx); }`,
    );
    expect(
      r677Synthetic.unexpected.some(
        (f) => f.fn === 'sneakyCaller' && f.callee === 'loadFullConflictSearchGraph',
      ),
    ).toBe(true);

    const r677AliasSynthetic = scanSourceTextForWholeTenantCalls(
      'src/server/syntheticR677Alias.ts',
      `export async function sneakyAliasCaller(svc: any, ctx: unknown) { const { loadFullConflictSearchGraph: loadAll } = svc; return loadAll(ctx); }`,
    );
    expect(
      r677AliasSynthetic.unexpected.some(
        (f) =>
          f.fn === 'sneakyAliasCaller' &&
          f.callee === 'loadFullConflictSearchGraph',
      ),
    ).toBe(true);
  });
});
