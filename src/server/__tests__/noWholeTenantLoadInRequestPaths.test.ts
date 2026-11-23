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
  readonly callees?: readonly string[];
  readonly reason: string;
}

/**
 * Intentionally whole-tenant batch jobs, admin bulk actions, seed/demo utilities,
 * and low-level legacy PMS compatibility wrappers (S1-02a B15 guard).
 */
export const PERMANENT_ALLOW_LIST: readonly AllowListEntry[] = [
  {
    file: 'src/server/services.ts',
    fn: 'rerunAutomaticPmsMatching',
    reason: 'Explicit admin bulk PMS auto-matching batch operation across firm matters/entities.',
  },
  {
    file: 'src/server/services.ts',
    fn: 'executeKeyDateRemindersForTenant',
    reason: 'Scheduled background job (guardedJob key-date-reminders) iterating due tenant reminders.',
  },
  {
    file: 'src/server/services.ts',
    fn: 'executeRegisterRemindersForTenant',
    reason: 'Scheduled background job (guardedJob register-reminders) scanning open tenant registers.',
  },
  {
    file: 'src/server/services.ts',
    fn: 'executeNotificationDigestsForTenant',
    reason: 'Scheduled background job (guardedJob notification-digests) building undigested notification emails.',
  },
  {
    file: 'src/server/services.ts',
    fn: 'resetAllDemoData',
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
    reason: 'Explicit admin bulk SharePoint folder-provisioning batch across open matters.',
  },
  {
    file: 'src/server/storePostgresImport.ts',
    fn: 'importFirmStoreModulesToPostgres',
    reason: 'Seed/migration store import verification utility across all tenant records.',
  },
  {
    file: 'src/pms/pmsSource.ts',
    fn: 'getTenantPmsSource',
    reason: 'Legacy batch/seed PMS hydrator wrapper (disallowed in request-path server services).',
  },
  {
    file: 'src/pms/pmsSource.ts',
    fn: 'hydrateTenantPmsSource',
    reason: 'Legacy batch/seed PMS hydrator wrapper delegating to getTenantPmsSource.',
  },
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
  },
];

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
    ],
    reason:
      'Temporary people/org/links/notes/mergeHistory hydration inside getAppSnapshotInScope deferred to WP1b (matters/enquiries/quotes/tasks/signOffs/PMS converted in S1-02a).',
  },
];

// Exact S1-02b baseline: 25 app layout/page getAppSnapshot calls + 6 component client-scan calls + 6 getAppSnapshot/InScope calls = 37
export const MAX_DEFERRED_S1_02B_BASELINE_COUNT = 37;

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

function getCalleeName(expr: ts.LeftHandSideExpression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
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

function scanWholeTenantCalls(): {
  unexpected: AstCallFinding[];
  deferred: AstCallFinding[];
  permanentAllowMatched: AstCallFinding[];
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

  for (const absPath of files) {
    const relPath = path.relative(REPO_ROOT, absPath).replace(/\\/g, '/');
    const sourceText = fs.readFileSync(absPath, 'utf8');
    const sourceFile = ts.createSourceFile(
      absPath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = getCalleeName(node.expression);
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
  }

  return { unexpected, deferred, permanentAllowMatched };
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
});
