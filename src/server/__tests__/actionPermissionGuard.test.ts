import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isRegisteredPermissionKey } from '@platform/core';
import {
  ACTION_PERMISSIONS,
  MAX_KNOWN_GAPS,
  ROUTE_PERMISSIONS,
  type ActionPolicy,
} from '../actionPermissions';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const ACTIONS_FILE = path.join(REPO_ROOT, 'src', 'app', 'actions.ts');
const API_DIR = path.join(REPO_ROOT, 'src', 'app', 'api');

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export interface ActionSourceEntry {
  name: string;
  body: string;
}

export function parseExportedActionsFromSource(
  source: string,
): ActionSourceEntry[] {
  const normalized = source.replace(/\r\n/g, '\n');
  const blocks = normalized.split(/(?=^export\s+(?:async\s+)?function\s+)/m);
  const results: ActionSourceEntry[] = [];

  for (const block of blocks) {
    const match = block.match(
      /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/,
    );
    if (match) {
      results.push({
        name: match[1],
        body: block,
      });
    }
  }
  return results;
}

export interface RouteHandlerSourceEntry {
  routeKey: string;
  method: string;
  routePath: string;
  fileContent: string;
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
): RouteHandlerSourceEntry[] {
  const handlers: RouteHandlerSourceEntry[] = [];
  for (const filePath of routeFiles) {
    const relFromApp = path
      .relative(path.join(REPO_ROOT, 'src', 'app'), path.dirname(filePath))
      .split(path.sep)
      .join('/');
    const routePath = `/${relFromApp}`;
    const content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

    for (const method of HTTP_METHODS) {
      const exportPattern = new RegExp(
        `^export\\s+(?:const|async\\s+function|function)\\s+${method}\\b`,
        'm',
      );
      if (exportPattern.test(content)) {
        handlers.push({
          routeKey: `${method} ${routePath}`,
          method,
          routePath,
          fileContent: content,
        });
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
  actionsSource: string;
  routeHandlers: RouteHandlerSourceEntry[];
  actionPolicies: Record<string, ActionPolicy>;
  routePolicies: Record<string, ActionPolicy>;
  maxKnownGaps: number;
}): string[] {
  const errors: string[] = [];
  const actions = parseExportedActionsFromSource(params.actionsSource);

  // 1. Every exported action has a policy and calls guardedAction('<ownName>', fn) with at most 2 arguments
  const seenActionNames = new Set<string>();
  for (const act of actions) {
    seenActionNames.add(act.name);
    if (!(act.name in params.actionPolicies)) {
      errors.push(
        `Action "${act.name}" in src/app/actions.ts has no policy in ACTION_PERMISSIONS.`,
      );
    }
    const callPattern = new RegExp(
      `\\bguardedAction\\s*\\(\\s*['"]${act.name}['"]`,
    );
    if (!callPattern.test(act.body)) {
      errors.push(
        `Action "${act.name}" in src/app/actions.ts does not call guardedAction('${act.name}', ...).`,
      );
    } else {
      const argCount = countWrapperCallArguments(
        act.body,
        'guardedAction',
        act.name,
      );
      if (argCount !== null && argCount > 2) {
        errors.push(
          `Action "${act.name}" in src/app/actions.ts passes ${argCount} arguments to guardedAction; only (name, fn) are allowed.`,
        );
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
    seenRouteKeys.add(rte.routeKey);
    if (!(rte.routeKey in params.routePolicies)) {
      errors.push(
        `Route handler "${rte.routeKey}" has no policy in ROUTE_PERMISSIONS.`,
      );
    }
    const escapedKey = rte.routeKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const routeCallPattern = new RegExp(
      `export\\s+const\\s+${rte.method}\\s*=\\s*guardedRoute\\s*\\(\\s*['"]${escapedKey}['"]`,
    );
    if (!routeCallPattern.test(rte.fileContent)) {
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
        typeof policy.key === 'string' ? [policy.key] : policy.key.anyOf;
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
  const actionsSource = fs.readFileSync(ACTIONS_FILE, 'utf8');
  const routeFiles = walkRouteFiles(API_DIR);
  const routeHandlers = parseExportedRoutesFromFiles(routeFiles);

  it('discovers all 106 exported server actions and all 11 API route handlers, and validates their policies and wrappers', () => {
    const actions = parseExportedActionsFromSource(actionsSource);
    expect(actions.length).toBe(106);
    expect(routeHandlers.length).toBe(11);

    const validationErrors = validateActionAndRouteGuard({
      actionsSource,
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
    ].filter(([, policy]) => policy.kind === 'gap');

    expect(gapEntries.length).toBe(MAX_KNOWN_GAPS);
    expect(MAX_KNOWN_GAPS).toBe(26);
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
});
