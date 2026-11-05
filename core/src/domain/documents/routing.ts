/**
 * Storage Routing, Path Token Rendering & Folder Name Sanitisation (`core/src/domain/documents/routing.ts`).
 *
 * Implements Section 4 of the specification:
 * - Ordered routing rules matching on `departmentId`, `teamId`, and `workTypeId` (or `practiceAreaId`).
 * - First match wins; a `match: "default"` rule is required.
 * - Renders `basePath` and `matterFolderNameTemplate` using allowed tokens.
 * - Sanitises characters rejected by SharePoint / DMS providers, trims to configurable segment length,
 *   and validates the full path against the provider's maximum path length.
 */

import type {
  DocumentRoutingRule,
  DocumentStoreCapabilities,
  DocumentStoreConfig,
  DocumentStoreErrorCode,
} from '../../api/index';
import type { MatterRoutingSubject } from './types';

export const ALLOWED_PATH_TOKENS = new Set<string>([
  'departmentCode',
  'departmentId',
  'teamCode',
  'teamId',
  'clientNumber',
  'matterNumber',
  'matterDescription',
  'workTypeCode',
  'workTypeId',
]);

export const DEFAULT_MAX_FOLDER_SEGMENT_LENGTH = 120;
export const DEFAULT_SHAREPOINT_MAX_PATH_LENGTH = 400;

const FORBIDDEN_SHAREPOINT_CHARS_REGEX = /["*:<>?/\\|\x00-\x1f]/g;
const RESERVED_DEVICE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM0',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT0',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
  'FORMS',
]);

/**
 * Extracts all `{tokenName}` placeholders from a template string and returns any unknown token names.
 */
export function findUnknownPathTokens(
  template: string,
  allowedTokens: ReadonlySet<string> = ALLOWED_PATH_TOKENS,
): string[] {
  const unknown: string[] = [];
  const regex = /\{([^{}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(template)) !== null) {
    const tokenName = (match[1] ?? '').trim();
    if (!tokenName || !allowedTokens.has(tokenName)) {
      unknown.push(tokenName || '{}');
    }
  }
  return unknown;
}

/**
 * Checks whether a single un-interpolated folder name contains characters or reserved names
 * rejected by the document store (ignoring `{token}` placeholders).
 */
export function validateRawFolderNameSegment(
  name: string,
  maxSegmentLength = DEFAULT_MAX_FOLDER_SEGMENT_LENGTH,
): { valid: boolean; reason?: string } {
  const trimmed = name.trim();
  if (!trimmed) {
    return { valid: false, reason: 'Folder name cannot be empty.' };
  }
  const strippedTokens = trimmed.replace(/\{[^{}]+\}/g, 'TOKEN');
  if (FORBIDDEN_SHAREPOINT_CHARS_REGEX.test(strippedTokens)) {
    FORBIDDEN_SHAREPOINT_CHARS_REGEX.lastIndex = 0;
    return {
      valid: false,
      reason: `Folder name "${name}" contains characters forbidden by the document store (" * : < > ? / \\ |).`,
    };
  }
  if (trimmed.startsWith('.') || trimmed.endsWith('.')) {
    return {
      valid: false,
      reason: `Folder name "${name}" cannot start or end with a period.`,
    };
  }
  if (trimmed.toLowerCase().includes('_vti_')) {
    return {
      valid: false,
      reason: `Folder name "${name}" cannot contain reserved substring "_vti_".`,
    };
  }
  if (RESERVED_DEVICE_NAMES.has(strippedTokens.toUpperCase())) {
    return {
      valid: false,
      reason: `Folder name "${name}" is a reserved system name.`,
    };
  }
  if (strippedTokens.length > maxSegmentLength) {
    return {
      valid: false,
      reason: `Folder name "${name}" exceeds the maximum segment length of ${maxSegmentLength} characters.`,
    };
  }
  return { valid: true };
}

/**
 * Sanitises a rendered folder name segment for safe creation in SharePoint / DMS stores:
 * - Replaces forbidden characters (`" * : < > ? / \ |` and control chars) with `-` or space.
 * - Collapses repeated whitespace.
 * - Strips leading/trailing dots and spaces.
 * - Prefixes reserved names (`CON`, `Forms`, `_vti_`, etc.).
 * - Trims cleanly to `maxSegmentLength` without leaving trailing dots or spaces.
 */
export function sanitiseFolderNameSegment(
  rawSegment: string,
  maxSegmentLength = DEFAULT_MAX_FOLDER_SEGMENT_LENGTH,
): string {
  let cleaned = rawSegment
    .replace(FORBIDDEN_SHAREPOINT_CHARS_REGEX, '-')
    .replace(/-{2,}/g, '-')
    .replace(/_vti_/gi, '_vti-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');

  if (!cleaned) {
    cleaned = 'Unnamed';
  }

  if (RESERVED_DEVICE_NAMES.has(cleaned.toUpperCase())) {
    cleaned = `Folder-${cleaned}`;
  }

  if (cleaned.length > maxSegmentLength) {
    cleaned = cleaned
      .slice(0, maxSegmentLength)
      .replace(/[.\s-]+$/g, '');
  }

  return cleaned || 'Unnamed';
}

/**
 * Interpolates `{token}` placeholders in a folder name or path template and sanitises each segment.
 */
export function renderFolderNameTemplate(
  template: string,
  subject: Pick<
    MatterRoutingSubject,
    | 'matterNumber'
    | 'clientNumber'
    | 'matterDescription'
    | 'departmentCode'
    | 'departmentId'
    | 'teamCode'
    | 'teamId'
    | 'workTypeId'
    | 'workTypeCode'
  >,
  maxSegmentLength = DEFAULT_MAX_FOLDER_SEGMENT_LENGTH,
): string {
  const tokenValues: Record<string, string> = {
    departmentCode: subject.departmentCode || subject.departmentId || 'DEPT',
    departmentId: subject.departmentId || 'DEPT',
    teamCode: subject.teamCode || subject.teamId || 'TEAM',
    teamId: subject.teamId || 'TEAM',
    clientNumber: subject.clientNumber || 'CLIENT',
    matterNumber: subject.matterNumber || 'MATTER',
    matterDescription: subject.matterDescription || 'Matter',
    workTypeCode: subject.workTypeCode || subject.workTypeId || 'WORK',
    workTypeId: subject.workTypeId || 'WORK',
  };

  const interpolated = template.replace(/\{([^{}]+)\}/g, (full, key: string) => {
    const trimmedKey = key.trim();
    return tokenValues[trimmedKey] ?? full;
  });

  return sanitiseFolderNameSegment(interpolated, maxSegmentLength);
}

/**
 * Interpolates a multi-segment `basePath` (e.g. `{departmentCode}/{teamCode}`) and sanitises each path segment.
 */
export function renderBasePath(
  basePathTemplate: string,
  subject: Pick<
    MatterRoutingSubject,
    | 'matterNumber'
    | 'clientNumber'
    | 'matterDescription'
    | 'departmentCode'
    | 'departmentId'
    | 'teamCode'
    | 'teamId'
    | 'workTypeId'
    | 'workTypeCode'
  >,
  maxSegmentLength = DEFAULT_MAX_FOLDER_SEGMENT_LENGTH,
): { renderedBasePath: string; segments: string[] } {
  const rawSegments = basePathTemplate
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);

  const segments = rawSegments.map((seg) =>
    renderFolderNameTemplate(seg, subject, maxSegmentLength),
  );

  return {
    renderedBasePath: segments.join('/'),
    segments,
  };
}

export interface ResolvedMatterRoute {
  ruleIndex: number;
  matchedRule: DocumentRoutingRule;
  store: DocumentStoreConfig;
  libraryId: string;
  libraryUrlSegment: string;
  basePathSegments: string[];
  renderedBasePath: string;
  matterFolderName: string;
  matterRelativePath: string;
  fullLibraryRelativePath: string;
}

/**
 * Matches a matter against ordered `documentRouting` rules (first match wins, falling back to `match: "default"`),
 * renders the base path and matter folder name, and validates total path length against the provider's capability limit.
 */
export function resolveMatterDocumentRoute(params: {
  subject: MatterRoutingSubject;
  stores: readonly DocumentStoreConfig[];
  routingRules: readonly DocumentRoutingRule[];
  matterFolderNameTemplate: string;
  deepestTemplateSubpath?: string;
  capabilities?: Pick<
    DocumentStoreCapabilities,
    'maxPathLengthChars' | 'maxSegmentLengthChars'
  >;
}): ResolvedMatterRoute {
  const {
    subject,
    stores,
    routingRules,
    matterFolderNameTemplate,
    deepestTemplateSubpath = '',
    capabilities,
  } = params;

  const maxSegmentLength =
    capabilities?.maxSegmentLengthChars ?? DEFAULT_MAX_FOLDER_SEGMENT_LENGTH;
  const maxPathLength =
    capabilities?.maxPathLengthChars ?? DEFAULT_SHAREPOINT_MAX_PATH_LENGTH;

  if (!subject.departmentId || !subject.departmentId.trim()) {
    const err = new Error(
      `DOCUMENT_ROUTING_ERROR: Matter "${subject.matterNumber || subject.matterId}" has no owning department configured for document routing.`,
    ) as Error & { code: DocumentStoreErrorCode };
    err.code = 'misconfigured';
    throw err;
  }

  let matchedIndex = -1;
  let matchedRule: DocumentRoutingRule | undefined;

  for (let i = 0; i < routingRules.length; i++) {
    const rule = routingRules[i]!;
    if (rule.match === 'default') {
      matchedIndex = i;
      matchedRule = rule;
      break;
    }

    const criteria = rule.match;
    const deptMatches =
      !criteria.departmentId || criteria.departmentId === subject.departmentId;
    const teamMatches =
      !criteria.teamId ||
      (Boolean(subject.teamId) && criteria.teamId === subject.teamId);
    const workTypeMatches =
      !criteria.workTypeId ||
      criteria.workTypeId === subject.workTypeId ||
      (Boolean(subject.practiceAreaId) &&
        criteria.workTypeId === subject.practiceAreaId);

    if (deptMatches && teamMatches && workTypeMatches) {
      matchedIndex = i;
      matchedRule = rule;
      break;
    }
  }

  if (!matchedRule) {
    throw new Error(
      'DOCUMENT_ROUTING_ERROR: No matching routing rule found and no default rule is configured.',
    );
  }

  const ruleRequiresTeam =
    /\{(teamCode|teamId)\}/.test(matchedRule.basePath) ||
    /\{(teamCode|teamId)\}/.test(matterFolderNameTemplate) ||
    (matchedRule.match !== 'default' && Boolean(matchedRule.match.teamId));

  if (ruleRequiresTeam && (!subject.teamId || !subject.teamId.trim())) {
    const err = new Error(
      `DOCUMENT_ROUTING_ERROR: Matter "${subject.matterNumber || subject.matterId}" has no owning team configured for document routing.`,
    ) as Error & { code: DocumentStoreErrorCode };
    err.code = 'misconfigured';
    throw err;
  }

  const store = stores.find((s) => s.storeId === matchedRule.storeId);
  if (!store) {
    throw new Error(
      `DOCUMENT_ROUTING_ERROR: Routing rule references unknown storeId "${matchedRule.storeId}".`,
    );
  }

  const library = store.sharepoint?.libraries.find(
    (l) => l.libraryId === matchedRule.libraryId,
  );
  const libraryUrlSegment = library?.libraryUrlSegment ?? matchedRule.libraryId;

  const { renderedBasePath, segments: basePathSegments } = renderBasePath(
    matchedRule.basePath,
    subject,
    maxSegmentLength,
  );

  // Reserve room in the matter folder name if the full path with deepest template subfolder would exceed maxPathLength
  const fixedPrefix = [libraryUrlSegment, renderedBasePath]
    .filter(Boolean)
    .join('/');
  const suffixLength = deepestTemplateSubpath
    ? deepestTemplateSubpath.length + 1
    : 0;
  const availableForMatterFolder = Math.max(
    24,
    Math.min(
      maxSegmentLength,
      maxPathLength - fixedPrefix.length - 1 - suffixLength,
    ),
  );

  const matterFolderName = renderFolderNameTemplate(
    matterFolderNameTemplate,
    subject,
    availableForMatterFolder,
  );

  const matterRelativePath = [renderedBasePath, matterFolderName]
    .filter(Boolean)
    .join('/');
  const fullLibraryRelativePath = [
    libraryUrlSegment,
    matterRelativePath,
    deepestTemplateSubpath,
  ]
    .filter(Boolean)
    .join('/');

  if (fullLibraryRelativePath.length > maxPathLength) {
    throw new Error(
      `DOCUMENT_PATH_LENGTH_EXCEEDED: Rendered path length (${fullLibraryRelativePath.length}) exceeds provider maximum of ${maxPathLength} characters.`,
    );
  }

  return {
    ruleIndex: matchedIndex,
    matchedRule,
    store,
    libraryId: matchedRule.libraryId,
    libraryUrlSegment,
    basePathSegments,
    renderedBasePath,
    matterFolderName,
    matterRelativePath,
    fullLibraryRelativePath,
  };
}
