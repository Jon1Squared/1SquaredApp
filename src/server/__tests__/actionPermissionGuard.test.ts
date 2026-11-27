import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOCUMENT_GENERATION_CONFIG,
  isRegisteredPermissionKey,
  PERMISSION_REGISTRY,
} from '@platform/core';
import {
  getInitializedDocGenContext,
  updateDocumentGenerationConfigService,
} from '@/server/documentGenerationServices';
import {
  createSignedEntraSessionCookie,
  verifySignedEntraSessionCookie,
} from '@/server/entraAuth';
import { getPartyRepository } from '@/server/services';
import type { Person } from '@/domain/types';
import {
  ACTION_PERMISSIONS,
  JOB_PERMISSIONS,
  MAX_KNOWN_GAPS,
  ROUTE_PERMISSIONS,
  type ActionPolicy,
} from '../actionPermissions';
import { REGISTERED_CLI_JOBS } from '../../../scripts/run-job';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const ACTIONS_FILE = path.join(REPO_ROOT, 'src', 'app', 'actions.ts');
const API_DIR = path.join(REPO_ROOT, 'src', 'app', 'api');

const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
] as const;

export interface ActionSourceEntry {
  name: string;
  body: string;
}

export interface ActionSourceFileEntry {
  fileLabel: string;
  source: string;
}

function stripLeadingCommentsAndWhitespace(source: string): string {
  let rest = source.replace(/^\uFEFF/, '');
  let changed = true;
  while (changed) {
    changed = false;
    const ws = rest.match(/^\s+/);
    if (ws) {
      rest = rest.slice(ws[0].length);
      changed = true;
    }
    const lineComment = rest.match(/^\/\/[^\r\n]*/);
    if (lineComment) {
      rest = rest.slice(lineComment[0].length);
      changed = true;
    }
    const blockComment = rest.match(/^\/\*[\s\S]*?\*\//);
    if (blockComment) {
      rest = rest.slice(blockComment[0].length);
      changed = true;
    }
  }
  return rest;
}

export function findUseServerActionFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.next' ||
        entry.name === '.git' ||
        entry.name === '__tests__'
      ) {
        continue;
      }
      files.push(...findUseServerActionFiles(fullPath));
    } else if (
      entry.isFile() &&
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.test\.(ts|tsx)$/.test(entry.name)
    ) {
      const content = fs.readFileSync(fullPath, 'utf8');
      const stripped = stripLeadingCommentsAndWhitespace(content);
      if (/^(['"])use server\1\s*(?:;|$)/m.test(stripped.split(/\r?\n/, 1)[0] ?? '')) {
        files.push(fullPath);
      }
    }
  }
  return files.sort();
}

export function parseExportedActionsFromSource(
  source: string,
): ActionSourceEntry[] {
  const normalized = source.replace(/\r\n/g, '\n');
  const blocks = normalized.split(
    /(?=^export\s+(?:async\s+function\b|function\b|const\b|\{))/m,
  );
  const results: ActionSourceEntry[] = [];
  const seenNames = new Set<string>();

  const pushUnique = (entry: ActionSourceEntry) => {
    if (seenNames.has(entry.name)) return;
    seenNames.add(entry.name);
    results.push(entry);
  };

  for (const block of blocks) {
    const fnMatch = block.match(
      /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/,
    );
    if (fnMatch) {
      pushUnique({ name: fnMatch[1], body: block });
      continue;
    }

    const constMatch = block.match(
      /^export\s+const\s+([A-Za-z0-9_]+)\b\s*(?::[^=]+)?=/,
    );
    if (constMatch) {
      pushUnique({ name: constMatch[1], body: block });
      continue;
    }

    const reexportMatch = block.match(/^export\s*\{([^}]+)\}(?!\s*from\b)/);
    if (reexportMatch) {
      const specs = reexportMatch[1].split(',');
      for (const rawSpec of specs) {
        const spec = rawSpec.trim();
        if (!spec || spec.startsWith('type ')) continue;
        const specMatch = spec.match(
          /^([A-Za-z0-9_]+)(?:\s+as\s+([A-Za-z0-9_]+))?$/,
        );
        if (!specMatch) continue;
        const localName = specMatch[1];
        const exportedName = specMatch[2] ?? localName;
        const escapedLocal = localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const localDeclPattern = new RegExp(
          `^(?:async\\s+)?(?:function\\s+${escapedLocal}\\b|const\\s+${escapedLocal}\\b)[\\s\\S]*?(?=^(?:export\\s|(?:async\\s+)?function\\s|const\\s|$))`,
          'm',
        );
        const localDeclMatch = normalized.match(localDeclPattern);
        pushUnique({
          name: exportedName,
          body: localDeclMatch?.[0] ?? '',
        });
      }
    }
  }
  return results;
}

export interface RouteHandlerSourceEntry {
  routeKey: string;
  method: string;
  routePath: string;
  fileContent: string;
  forbiddenModuleReexport?: string;
}

export interface ForbiddenModuleReexport {
  kind: 'star' | 'named';
  exportedNames: string[];
  moduleSpecifier: string;
  line: number;
}

export function findForbiddenModuleReexports(
  source: string,
  fileName: string = 'source.ts',
): ForbiddenModuleReexport[] {
  const scriptKind = fileName.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const reexports: ForbiddenModuleReexport[] = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isExportDeclaration(stmt) || !stmt.moduleSpecifier || stmt.isTypeOnly) {
      continue;
    }
    const moduleSpecifier = ts.isStringLiteral(stmt.moduleSpecifier)
      ? stmt.moduleSpecifier.text
      : stmt.moduleSpecifier.getText(sourceFile);
    const line =
      sourceFile.getLineAndCharacterOfPosition(stmt.getStart(sourceFile)).line +
      1;
    if (!stmt.exportClause) {
      reexports.push({
        kind: 'star',
        exportedNames: [],
        moduleSpecifier,
        line,
      });
      continue;
    }
    if (ts.isNamespaceExport(stmt.exportClause)) {
      reexports.push({
        kind: 'star',
        exportedNames: [stmt.exportClause.name.text],
        moduleSpecifier,
        line,
      });
      continue;
    }
    if (ts.isNamedExports(stmt.exportClause)) {
      const exportedNames = stmt.exportClause.elements
        .filter((el) => !el.isTypeOnly)
        .map((el) => el.name.text);
      if (exportedNames.length > 0) {
        reexports.push({
          kind: 'named',
          exportedNames,
          moduleSpecifier,
          line,
        });
      }
    }
  }
  return reexports;
}

function isDirectiveStringLiteralStatement(
  stmt: ts.Statement,
): stmt is ts.ExpressionStatement & { expression: ts.StringLiteral } {
  return (
    ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression)
  );
}

export function findInlineUseServerDirectives(
  files: ActionSourceFileEntry[],
): string[] {
  const findings: string[] = [];
  for (const file of files) {
    const scriptKind = file.fileLabel.endsWith('.tsx')
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(
      file.fileLabel,
      file.source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    );
    const allowedPrologueStatements = new Set<ts.Statement>();
    for (const stmt of sourceFile.statements) {
      if (!isDirectiveStringLiteralStatement(stmt)) {
        break;
      }
      allowedPrologueStatements.add(stmt);
    }

    const visit = (node: ts.Node) => {
      if (
        ts.isExpressionStatement(node) &&
        ts.isStringLiteral(node.expression) &&
        node.expression.text === 'use server' &&
        !allowedPrologueStatements.has(node)
      ) {
        const line =
          sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
            .line + 1;
        findings.push(
          `Inline or non-prologue 'use server' directive in ${file.fileLabel}:${line}. All Server Actions must be exported directly from src/app/actions.ts and wrapped with guardedAction().`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return findings;
}

export function findNonTestSrcFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.next' ||
        entry.name === '.git' ||
        entry.name === '__tests__'
      ) {
        continue;
      }
      files.push(...findNonTestSrcFiles(fullPath));
    } else if (
      entry.isFile() &&
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.test\.(ts|tsx)$/.test(entry.name)
    ) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function walkRouteFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkRouteFiles(fullPath));
    } else if (entry.isFile() && entry.name === 'route.ts') {
      files.push(fullPath);
    }
  }
  return files.sort();
}

export function parseExportedRoutesFromFiles(
  routeFiles: string[],
  apiParentDir: string = path.join(REPO_ROOT, 'src', 'app'),
): RouteHandlerSourceEntry[] {
  const handlers: RouteHandlerSourceEntry[] = [];
  for (const filePath of routeFiles) {
    const relFromApp = path
      .relative(apiParentDir, path.dirname(filePath))
      .split(path.sep)
      .join('/');
    const routePath = relFromApp.startsWith('/') ? relFromApp : `/${relFromApp}`;
    const content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

    const reexportedMethods = new Set<string>();
    const reexportRegex = /^export\s*\{([^}]+)\}(?!\s*from\b)/gm;
    for (const m of content.matchAll(reexportRegex)) {
      for (const rawSpec of m[1].split(',')) {
        const spec = rawSpec.trim();
        if (!spec || spec.startsWith('type ')) continue;
        const specMatch = spec.match(
          /^([A-Za-z0-9_]+)(?:\s+as\s+([A-Za-z0-9_]+))?$/,
        );
        if (specMatch) {
          reexportedMethods.add(specMatch[2] ?? specMatch[1]);
        }
      }
    }

    for (const method of HTTP_METHODS) {
      const exportPattern = new RegExp(
        `^export\\s+(?:const|async\\s+function|function)\\s+${method}\\b`,
        'm',
      );
      if (exportPattern.test(content) || reexportedMethods.has(method)) {
        handlers.push({
          routeKey: `${method} ${routePath}`,
          method,
          routePath,
          fileContent: content,
        });
      }
    }

    const moduleReexports = findForbiddenModuleReexports(content, filePath);
    for (const reexport of moduleReexports) {
      if (reexport.kind === 'star') {
        const starLabel =
          reexport.exportedNames.length > 0
            ? `export * as ${reexport.exportedNames[0]} from '${reexport.moduleSpecifier}'`
            : `export * from '${reexport.moduleSpecifier}'`;
        handlers.push({
          routeKey: `* ${routePath}`,
          method: '*',
          routePath,
          fileContent: content,
          forbiddenModuleReexport: starLabel,
        });
      } else {
        for (const exportedName of reexport.exportedNames) {
          handlers.push({
            routeKey: `${exportedName} ${routePath}`,
            method: exportedName,
            routePath,
            fileContent: content,
            forbiddenModuleReexport: `export { ${exportedName} } from '${reexport.moduleSpecifier}'`,
          });
        }
      }
    }
  }
  return handlers;
}

export function countWrapperCallArguments(
  source: string,
  wrapperName: 'guardedAction' | 'guardedRoute',
  expectedName: string,
): number | null {
  const escaped = expectedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const callRegex = new RegExp(
    `\\b${wrapperName}\\s*\\(\\s*['"]${escaped}['"]`,
  );
  const match = callRegex.exec(source);
  if (!match) {
    return null;
  }

  const openParenOffset = match[0].indexOf('(');
  const startIdx = match.index + openParenOffset + 1;

  let parenDepth = 1;
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString: "'" | '"' | '`' | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  const topLevelCommaIndices: number[] = [];
  let closeParenIdx = -1;

  for (let i = startIdx; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }

    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        closeParenIdx = i;
        break;
      }
    } else if (ch === '{') {
      braceDepth += 1;
    } else if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
    } else if (ch === '[') {
      bracketDepth += 1;
    } else if (ch === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (
      ch === ',' &&
      parenDepth === 1 &&
      braceDepth === 0 &&
      bracketDepth === 0
    ) {
      topLevelCommaIndices.push(i);
    }
  }

  if (closeParenIdx === -1) {
    return null;
  }

  const splitPoints = [startIdx, ...topLevelCommaIndices, closeParenIdx];
  const segments: string[] = [];
  for (let i = 0; i < splitPoints.length - 1; i += 1) {
    const segStart = i === 0 ? splitPoints[i] : splitPoints[i] + 1;
    const segEnd = splitPoints[i + 1];
    segments.push(source.slice(segStart, segEnd).trim());
  }

  if (segments.length > 0 && segments[segments.length - 1] === '') {
    segments.pop();
  }

  return segments.filter((s) => s.length > 0).length;
}

export function validateActionAndRouteGuard(params: {
  actionsSource?: string;
  actionFiles?: ActionSourceFileEntry[];
  routeHandlers: RouteHandlerSourceEntry[];
  actionPolicies: Record<string, ActionPolicy>;
  routePolicies: Record<string, ActionPolicy>;
  maxKnownGaps: number;
}): string[] {
  const errors: string[] = [];
  const sourceFiles: ActionSourceFileEntry[] = params.actionFiles ?? [
    { fileLabel: 'src/app/actions.ts', source: params.actionsSource ?? '' },
  ];

  // 1. Every exported action has a policy and calls guardedAction('<ownName>', fn) with at most 2 arguments
  const seenActionNames = new Set<string>();
  for (const actionFile of sourceFiles) {
    const reexports = findForbiddenModuleReexports(
      actionFile.source,
      actionFile.fileLabel,
    );
    for (const reexport of reexports) {
      const desc =
        reexport.kind === 'star'
          ? `export * from "${reexport.moduleSpecifier}"`
          : `export { ${reexport.exportedNames.join(', ')} } from "${reexport.moduleSpecifier}"`;
      errors.push(
        `Action file "${actionFile.fileLabel}" line ${reexport.line} contains forbidden module re-export (${desc}). Export server actions directly and wrap them with guardedAction().`,
      );
    }

    const actions = parseExportedActionsFromSource(actionFile.source);
    for (const act of actions) {
      seenActionNames.add(act.name);
      if (!(act.name in params.actionPolicies)) {
        errors.push(
          `Action "${act.name}" in ${actionFile.fileLabel} has no policy in ACTION_PERMISSIONS.`,
        );
      }
      const callPattern = new RegExp(
        `\\bguardedAction\\s*\\(\\s*['"]${act.name}['"]`,
      );
      if (!callPattern.test(act.body)) {
        errors.push(
          `Action "${act.name}" in ${actionFile.fileLabel} does not call guardedAction('${act.name}', ...).`,
        );
      } else {
        const argCount = countWrapperCallArguments(
          act.body,
          'guardedAction',
          act.name,
        );
        if (argCount !== null && argCount > 2) {
          errors.push(
            `Action "${act.name}" in ${actionFile.fileLabel} passes ${argCount} arguments to guardedAction; only (name, fn) are allowed.`,
          );
        }
      }
    }
  }

  // 2. No stale action policy names a non-existent action
  for (const policyName of Object.keys(params.actionPolicies)) {
    if (!seenActionNames.has(policyName)) {
      errors.push(
        `ACTION_PERMISSIONS contains "${policyName}", which is not exported from src/app/actions.ts.`,
      );
    }
  }

  // 3. Every route handler has a policy and calls guardedRoute('<METHOD> /api/...', handler) with at most 2 arguments
  const seenRouteKeys = new Set<string>();
  for (const rte of params.routeHandlers) {
    if (rte.forbiddenModuleReexport) {
      errors.push(
        `Route file "${rte.routeKey}" contains forbidden module re-export (${rte.forbiddenModuleReexport}). Export route handlers directly with guardedRoute('${rte.routeKey}', ...).`,
      );
      continue;
    }
    seenRouteKeys.add(rte.routeKey);
    if (!(rte.routeKey in params.routePolicies)) {
      errors.push(
        `Route handler "${rte.routeKey}" has no policy in ROUTE_PERMISSIONS.`,
      );
    }
    const escapedKey = rte.routeKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const directWrapPattern = new RegExp(
      `export\\s+const\\s+${rte.method}\\s*=\\s*guardedRoute\\s*\\(\\s*['"]${escapedKey}['"]`,
    );
    let aliasWrapped = false;
    const aliasReexportMatch = rte.fileContent.match(
      new RegExp(
        `^export\\s*\\{[^}]*\\b([A-Za-z0-9_]+)\\s+as\\s+${rte.method}\\b[^}]*\\}`,
        'm',
      ),
    );
    if (aliasReexportMatch) {
      const escapedAlias = aliasReexportMatch[1].replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&',
      );
      const aliasWrapPattern = new RegExp(
        `const\\s+${escapedAlias}\\s*=\\s*guardedRoute\\s*\\(\\s*['"]${escapedKey}['"]`,
      );
      aliasWrapped = aliasWrapPattern.test(rte.fileContent);
    }
    if (!directWrapPattern.test(rte.fileContent) && !aliasWrapped) {
      errors.push(
        `Route handler "${rte.routeKey}" does not wrap export const ${rte.method} = guardedRoute('${rte.routeKey}', ...).`,
      );
    } else {
      const argCount = countWrapperCallArguments(
        rte.fileContent,
        'guardedRoute',
        rte.routeKey,
      );
      if (argCount !== null && argCount > 2) {
        errors.push(
          `Route handler "${rte.routeKey}" passes ${argCount} arguments to guardedRoute; only (name, handler) are allowed.`,
        );
      }
    }
  }

  // 4. No stale route policy names a non-existent route
  for (const routePolicyKey of Object.keys(params.routePolicies)) {
    if (!seenRouteKeys.has(routePolicyKey)) {
      errors.push(
        `ROUTE_PERMISSIONS contains "${routePolicyKey}", which does not match any exported route handler under src/app/api/.`,
      );
    }
  }

  // 5. Validate policy contents (registered permission keys, non-empty reasons, gap count)
  let gapCount = 0;
  const allPolicies: Array<[string, ActionPolicy]> = [
    ...Object.entries(params.actionPolicies),
    ...Object.entries(params.routePolicies),
  ];

  for (const [entryName, policy] of allPolicies) {
    if (policy.kind === 'permission') {
      const keys =
        typeof policy.key === 'string'
          ? [policy.key]
          : 'allOf' in policy.key
            ? policy.key.allOf
            : policy.key.anyOf;
      if (keys.length === 0) {
        errors.push(`Policy "${entryName}" has an empty permission key list.`);
      }
      for (const k of keys) {
        if (!isRegisteredPermissionKey(k)) {
          errors.push(
            `Policy "${entryName}" references unregistered permission key "${k}".`,
          );
        }
      }
    } else if (policy.kind === 'authenticated' || policy.kind === 'public') {
      if (!policy.reason || policy.reason.trim().length === 0) {
        errors.push(
          `Policy "${entryName}" (${policy.kind}) must provide a non-empty reason.`,
        );
      }
    } else if (policy.kind === 'gap') {
      gapCount += 1;
      if (!policy.slice || !/^S0-\d{2}$/.test(policy.slice)) {
        errors.push(
          `Gap policy "${entryName}" must specify a valid Stage 0 slice ID.`,
        );
      }
    }
  }

  if (gapCount > params.maxKnownGaps) {
    errors.push(
      `Total gap count (${gapCount}) exceeds MAX_KNOWN_GAPS (${params.maxKnownGaps}).`,
    );
  }

  return errors;
}

describe('S0-02: server action and API route permission guard (ADR 0025)', () => {
  const useServerFiles = findUseServerActionFiles(path.join(REPO_ROOT, 'src'));
  const actionFiles: ActionSourceFileEntry[] = useServerFiles.map((file) => ({
    fileLabel: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
    source: fs.readFileSync(file, 'utf8'),
  }));
  const actionsSource = fs.readFileSync(ACTIONS_FILE, 'utf8');
  const routeFiles = walkRouteFiles(API_DIR);
  const routeHandlers = parseExportedRoutesFromFiles(routeFiles);

  it('discovers all 155 exported server actions and all 18 API route handlers, and validates their policies and wrappers', () => {
    expect(useServerFiles).toEqual([ACTIONS_FILE]);
    const actions = actionFiles.flatMap((entry) =>
      parseExportedActionsFromSource(entry.source),
    );
    expect(actions.length).toBe(155);
    expect(routeHandlers.length).toBe(18);

    const validationErrors = validateActionAndRouteGuard({
      actionsSource,
      actionFiles,
      routeHandlers,
      actionPolicies: ACTION_PERMISSIONS,
      routePolicies: ROUTE_PERMISSIONS,
      maxKnownGaps: MAX_KNOWN_GAPS,
    });

    expect(validationErrors).toEqual([]);
  });

  it('locks MAX_KNOWN_GAPS to the exact S0-02 gap count so the gap count can only decrease', () => {
    const gapEntries = [
      ...Object.entries(ACTION_PERMISSIONS),
      ...Object.entries(ROUTE_PERMISSIONS),
    ].filter(([, policy]) => (policy as { kind: string }).kind === 'gap');

    expect(gapEntries.length).toBe(MAX_KNOWN_GAPS);
    expect(MAX_KNOWN_GAPS).toBe(0);
  });

  it('validates that every registered CLI job in scripts/run-job.ts has a jobOnly policy in JOB_PERMISSIONS and guardedJob is never called in src/app/ or src/components/ (ADR 0030 §3 / S0-19)', () => {
    const cliJobNames = REGISTERED_CLI_JOBS.map((j) => j.name).sort();
    const policyJobNames = Object.keys(JOB_PERMISSIONS).sort();
    expect(cliJobNames).toEqual(policyJobNames);

    for (const [jobName, policy] of Object.entries(JOB_PERMISSIONS)) {
      expect(policy.kind, `job ${jobName} kind`).toBe('job');
      expect(policy.jobOnly, `job ${jobName} jobOnly`).toBe(true);
      expect(
        isRegisteredPermissionKey(policy.permission),
        `job ${jobName} permission ${policy.permission} registered`,
      ).toBe(true);
      expect(
        PERMISSION_REGISTRY[policy.permission].jobOnly,
        `job ${jobName} permission ${policy.permission} marked jobOnly in PERMISSION_REGISTRY`,
      ).toBe(true);
    }

    const collectSourceFiles = (dir: string): string[] => {
      if (!fs.existsSync(dir)) return [];
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          out.push(...collectSourceFiles(full));
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          out.push(full);
        }
      }
      return out;
    };

    const webUiAndRouteFiles = [
      ...collectSourceFiles(path.join(REPO_ROOT, 'src', 'app')),
      ...collectSourceFiles(path.join(REPO_ROOT, 'src', 'components')),
    ];
    for (const file of webUiAndRouteFiles) {
      const src = fs.readFileSync(file, 'utf8');
      expect(src, `${path.relative(REPO_ROOT, file)} must not reference guardedJob`).not.toMatch(
        /\bguardedJob\b/,
      );
    }
  });

  it('catches an unlisted action, a mismatched guardedAction name, a 3rd policyOverride argument, an unregistered permission key, a missing reason, or a gap count breach on fixture strings', () => {
    const fixtureActionsSource = `
export async function listedAction() {
  return guardedAction('listedAction', () => ({ ok: true }));
}

export async function unlistedSecretAction() {
  return { ok: true };
}

export async function wrongWrapperNameAction() {
  return guardedAction('listedAction', () => ({ ok: true }));
}

export async function overriddenPolicyAction() {
  return guardedAction('overriddenPolicyAction', () => ({ ok: true }), { kind: 'public', reason: 'bypass' });
}
`;

    const fixturePolicies: Record<string, ActionPolicy> = {
      listedAction: {
        kind: 'permission',
        key: 'not_a_real_permission' as never,
        enforcedBy: 'action',
      },
      wrongWrapperNameAction: {
        kind: 'authenticated',
        reason: '   ',
      },
      overriddenPolicyAction: {
        kind: 'authenticated',
        reason: 'Valid reason in table.',
      },
      staleDeletedAction: {
        kind: 'gap',
        slice: 'S0-03',
      },
    };

    const errors = validateActionAndRouteGuard({
      actionsSource: fixtureActionsSource,
      routeHandlers: [
        {
          routeKey: 'GET /api/test-override',
          method: 'GET',
          routePath: '/api/test-override',
          fileContent: `export const GET = guardedRoute('GET /api/test-override', async () => new Response(), { kind: 'public', reason: 'bypass' });`,
        },
      ],
      actionPolicies: fixturePolicies,
      routePolicies: {
        'GET /api/test-override': {
          kind: 'authenticated',
          reason: 'Valid route reason in table.',
        },
      },
      maxKnownGaps: 0,
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'Action "unlistedSecretAction" in src/app/actions.ts has no policy',
        ),
        expect.stringContaining(
          'Action "unlistedSecretAction" in src/app/actions.ts does not call guardedAction',
        ),
        expect.stringContaining(
          'Action "wrongWrapperNameAction" in src/app/actions.ts does not call guardedAction(\'wrongWrapperNameAction\'',
        ),
        expect.stringContaining(
          'Action "overriddenPolicyAction" in src/app/actions.ts passes 3 arguments to guardedAction; only (name, fn) are allowed.',
        ),
        expect.stringContaining(
          'Route handler "GET /api/test-override" passes 3 arguments to guardedRoute; only (name, handler) are allowed.',
        ),
        expect.stringContaining(
          'ACTION_PERMISSIONS contains "staleDeletedAction", which is not exported',
        ),
        expect.stringContaining(
          'Policy "listedAction" references unregistered permission key "not_a_real_permission"',
        ),
        expect.stringContaining(
          'Policy "wrongWrapperNameAction" (authenticated) must provide a non-empty reason',
        ),
        expect.stringContaining(
          'Total gap count (1) exceeds MAX_KNOWN_GAPS (0)',
        ),
      ]),
    );
  });

  it('R530 (B16): runs updateDocumentGenerationConfigService for each declared key in anyOf and confines admin:access to security-sensitive settings', async () => {
    const policy = ACTION_PERMISSIONS.updateDocumentGenerationConfigAction;
    expect(policy.kind).toBe('permission');
    if (policy.kind !== 'permission' || typeof policy.key === 'string') {
      throw new Error('Expected updateDocumentGenerationConfigAction to use anyOf policy keys.');
    }
    const declaredKeys = [...policy.key.anyOf];
    expect(declaredKeys).toEqual([
      'document_template:build',
      'rbac:manage_config',
      'admin:access',
    ]);
    // Note: R518's generic enforcedBy: 'service' wrapper check in guardedAction also enforces these anyOf keys at action entry.

    const makeSession = (
      personId: string,
      roles: string[],
    ) => {
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      const cookie = createSignedEntraSessionCookie({
        personId,
        oid: `00000000-0000-4000-8000-${personId.replace(/\D/g, '').padStart(12, '0')}`,
        tid: '00000000-0000-4000-8000-000000000099',
        tenantId: 'not-a-law-firm',
        sub: personId,
        email: `${personId.toLowerCase()}@notalawfirm.example`,
        displayName: `Actor ${personId}`,
        entraRoles: roles,
        mappedRoles: roles,
        entraGroups: [],
        mfaVerified: true,
        amr: ['pwd', 'mfa'],
        authenticatedAt: nowIso,
        expiresAt,
      });
      return verifySignedEntraSessionCookie(cookie)!;
    };

    const bootstrapSession = makeSession('P-000004', ['admin']);
    const { ctx, repo } = await getInitializedDocGenContext(
      'P-000004',
      bootstrapSession,
    );
    const partyRepo = getPartyRepository();
    const origP2 = await partyRepo.getPersonById<Person>(ctx, 'P-000002');
    const originalDocGenOverride = await repo.getDocumentGenerationTenantConfig(
      ctx,
    );
    expect(origP2).not.toBeNull();

    try {
      for (const permKey of declaredKeys) {
        if (permKey === 'document_template:build') {
          await partyRepo.putPerson(ctx, {
            ...origP2!,
            roles: ['fee_earner'],
            permissionOverrides: { grant: ['document_template:build'], revoke: [] },
          });
          const res = await updateDocumentGenerationConfigService(
            { maxTemplateSizeMb: 19 },
            'P-000002',
            makeSession('P-000002', ['fee_earner']),
          );
          expect(res.maxTemplateSizeMb).toBe(19);
        } else if (permKey === 'rbac:manage_config') {
          await partyRepo.putPerson(ctx, {
            ...origP2!,
            roles: ['fee_earner'],
            permissionOverrides: { grant: ['rbac:manage_config'], revoke: [] },
          });
          const res = await updateDocumentGenerationConfigService(
            {
              permissions: {
                roleDefaults:
                  DEFAULT_DOCUMENT_GENERATION_CONFIG.permissions!.roleDefaults,
              },
            },
            'P-000002',
            makeSession('P-000002', ['fee_earner']),
          );
          expect(res.permissions?.roleDefaults).toBeDefined();
        } else if (permKey === 'admin:access') {
          // admin:access applies only to security-sensitive changes (permissions / approval),
          // not non-security config updates such as maxTemplateSizeMb without document_template:build / rbac:manage_config.
          await partyRepo.putPerson(ctx, {
            ...origP2!,
            roles: ['fee_earner'],
            permissionOverrides: { grant: ['admin:access'], revoke: [] },
          });
          const secSession = makeSession('P-000002', ['fee_earner']);
          const savedApproval = await updateDocumentGenerationConfigService(
            {
              approval: {
                requireApproval: true,
                allowSelfApproval: false,
              },
            },
            'P-000002',
            secSession,
          );
          expect(savedApproval.approval.requireApproval).toBe(true);
          await expect(
            updateDocumentGenerationConfigService(
              { maxTemplateSizeMb: 21 },
              'P-000002',
              secSession,
            ),
          ).rejects.toThrow(/DOCUMENT_PERMISSION_DENIED/);
        }
      }
    } finally {
      if (origP2) {
        await partyRepo.putPerson(ctx, origP2);
      }
      await repo.putDocumentGenerationTenantConfig(
        ctx,
        originalDocGenOverride,
        'P-000004',
      );
    }
  });

  it('R518: catches export const actions, re-exported actions, second use-server files, and HEAD/OPTIONS/re-exported API route handlers', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r518-guard-'));
    try {
      const actionsFileA = path.join(tmpDir, 'actions.ts');
      const actionsFileB = path.join(tmpDir, 'features', 'extraActions.ts');
      fs.mkdirSync(path.dirname(actionsFileB), { recursive: true });
      fs.writeFileSync(
        actionsFileA,
        `'use server';
export async function listedAction() {
  return guardedAction('listedAction', () => ({ ok: true }));
}
`,
        'utf8',
      );
      const multiActionsSrc = `'use server';
export const constSecretAction = async () => ({ ok: true });
async function helperAction() { return { ok: true }; }
export { helperAction as aliasedSecretAction };
`;
      fs.writeFileSync(actionsFileB, multiActionsSrc, 'utf8');

      const discoveredFiles = findUseServerActionFiles(tmpDir);
      expect(discoveredFiles).toEqual([actionsFileA, actionsFileB].sort());

      const parsedActions = parseExportedActionsFromSource(multiActionsSrc);
      expect(parsedActions.map((a) => a.name)).toEqual(
        expect.arrayContaining(['constSecretAction', 'aliasedSecretAction']),
      );

      const routeDir = path.join(tmpDir, 'api', 'probe');
      fs.mkdirSync(routeDir, { recursive: true });
      const routeFile = path.join(routeDir, 'route.ts');
      fs.writeFileSync(
        routeFile,
        `export const HEAD = async () => new Response(null, { status: 204 });
async function optionsImpl() { return new Response(null, { status: 204 }); }
export { optionsImpl as OPTIONS };
`,
        'utf8',
      );
      const parsedRoutes = parseExportedRoutesFromFiles([routeFile], tmpDir);
      expect(parsedRoutes.some((r) => r.method === 'HEAD')).toBe(true);
      expect(parsedRoutes.some((r) => r.method === 'OPTIONS')).toBe(true);

      const guardErrors = validateActionAndRouteGuard({
        actionFiles: discoveredFiles.map((file) => ({
          fileLabel: path.relative(tmpDir, file).split(path.sep).join('/'),
          source: fs.readFileSync(file, 'utf8'),
        })),
        routeHandlers: parsedRoutes,
        actionPolicies: {
          listedAction: {
            kind: 'authenticated',
            reason: 'Fixture listed action',
          },
        },
        routePolicies: {},
        maxKnownGaps: 0,
      });

      expect(guardErrors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Action "constSecretAction"'),
          expect.stringContaining('Action "aliasedSecretAction"'),
          expect.stringContaining('Route handler "HEAD /api/probe"'),
          expect.stringContaining('Route handler "OPTIONS /api/probe"'),
        ]),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('R560: aligns updateMatterConflictRecordAction policy to matter:edit', () => {
    expect(ACTION_PERMISSIONS.updateMatterConflictRecordAction).toEqual({
      kind: 'permission',
      key: 'matter:edit',
      enforcedBy: 'service',
    });
  });

  it('R548: rejects module re-exports (export ... from / export *) in use-server and route files', () => {

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r548-guard-'));
    try {
      const reexportActionFile = path.join(tmpDir, 'reexportActions.ts');
      const starActionFile = path.join(tmpDir, 'starActions.ts');
      const reexportRouteDir = path.join(tmpDir, 'api', 'reexport-route');
      const starRouteDir = path.join(tmpDir, 'api', 'star-route');
      fs.mkdirSync(reexportRouteDir, { recursive: true });
      fs.mkdirSync(starRouteDir, { recursive: true });

      const reexportActionSrc = `'use server';
export { sneakyAction } from './helperActions';
`;
      const starActionSrc = `'use server';
export * from './helperActions';
`;
      const reexportRouteFile = path.join(reexportRouteDir, 'route.ts');
      const starRouteFile = path.join(starRouteDir, 'route.ts');
      fs.writeFileSync(reexportActionFile, reexportActionSrc, 'utf8');
      fs.writeFileSync(starActionFile, starActionSrc, 'utf8');
      fs.writeFileSync(
        reexportRouteFile,
        `export { GET } from './handler';\n`,
        'utf8',
      );
      fs.writeFileSync(
        starRouteFile,
        `export * from './handler';\n`,
        'utf8',
      );

      const guardErrors = validateActionAndRouteGuard({
        actionFiles: [
          { fileLabel: 'reexportActions.ts', source: reexportActionSrc },
          { fileLabel: 'starActions.ts', source: starActionSrc },
        ],
        routeHandlers: parseExportedRoutesFromFiles(
          [reexportRouteFile, starRouteFile],
          tmpDir,
        ),
        actionPolicies: {},
        routePolicies: {},
        maxKnownGaps: 0,
      });

      expect(guardErrors).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /Action file "reexportActions\.ts" line \d+ contains forbidden module re-export/,
          ),
          expect.stringMatching(
            /Action file "starActions\.ts" line \d+ contains forbidden module re-export/,
          ),
          expect.stringMatching(
            /Route file "GET \/api\/reexport-route" contains forbidden module re-export/,
          ),
          expect.stringMatching(
            /Route file ".*\/api\/star-route" contains forbidden module re-export/,
          ),
        ]),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('R563: rejects inline "use server" directives inside function bodies across src/ and fixtures', () => {
    const repoSrcFiles: ActionSourceFileEntry[] = findNonTestSrcFiles(
      path.join(REPO_ROOT, 'src'),
    ).map((file) => ({
      fileLabel: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
      source: fs.readFileSync(file, 'utf8'),
    }));
    expect(findInlineUseServerDirectives(repoSrcFiles)).toEqual([]);

    const fixtureFindings = findInlineUseServerDirectives([
      {
        fileLabel: 'inlineFn.tsx',
        source: `export function Panel() {
  async function sneakyInlineAction() {
    'use server';
    return 'ok';
  }
  return sneakyInlineAction;
}
`,
      },
      {
        fileLabel: 'inlineArrow.ts',
        source: `export const sneakyArrow = async () => {
  "use server";
  return 42;
};
`,
      },
      {
        fileLabel: 'validTopLevel.ts',
        source: `'use server';
export async function validAction() {
  return 'ok';
}
`,
      },
      {
        fileLabel: 'safeString.ts',
        source: `export function renderHelp() {
  const hint = "'use server'";
  return hint;
}
`,
      },
    ]);

    expect(fixtureFindings).toHaveLength(2);
    expect(fixtureFindings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('inlineFn.tsx:3'),
        expect.stringContaining('inlineArrow.ts:2'),
      ]),
    );
  });
});
