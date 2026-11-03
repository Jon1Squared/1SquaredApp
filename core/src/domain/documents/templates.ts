/**
 * Matter Folder Template Engine (`core/src/domain/documents/templates.ts`).
 *
 * Implements Section 5 & ADR-0021:
 * - Resolution chain: workType template -> department template -> default template.
 * - Inheritance modes: `replaces` (full replacement) vs `extends` (ordered operations:
 *   `add`, `remove`, `rename`, `move`, `setAccess`).
 * - Validation: duplicate sibling names, invalid SharePoint characters, unknown tokens,
 *   missing operation target paths, max depth, and path length limits.
 * - Scale warnings whenever any template node defines an `access` override (breaking
 *   inheritance on every matter).
 * - Additive diffing for "apply additions to open matters" (never deletes, renames, or moves).
 */

import type {
  DocumentStoreFolderTreeNode,
  MatterFolderTemplateDefinition,
  MatterFolderTemplateNode,
  MatterFolderTemplateOperation,
  MatterFolderTemplatesConfig,
} from '../../api/index';
import {
  DEFAULT_MAX_FOLDER_SEGMENT_LENGTH,
  DEFAULT_SHAREPOINT_MAX_PATH_LENGTH,
  findUnknownPathTokens,
  renderFolderNameTemplate,
  validateRawFolderNameSegment,
} from './routing';
import type {
  CompiledFolderTemplateNode,
  MatterRoutingSubject,
  ResolvedMatterFolderTemplate,
} from './types';

export const DEFAULT_MAX_TEMPLATE_DEPTH = 6;

interface MutableTemplateNode {
  name: string;
  description?: string;
  orderPrefix: 'none' | 'two_digit';
  accessOverride: MatterFolderTemplateNode['access'] | null;
  filingAliases: string[];
  inheritedFrom: 'default' | 'department' | 'work_type';
  children: MutableTemplateNode[];
}

function cloneToMutableNodes(
  nodes: readonly MatterFolderTemplateNode[],
  source: 'default' | 'department' | 'work_type',
): MutableTemplateNode[] {
  return nodes.map((node) => ({
    name: node.name,
    description: node.description,
    orderPrefix: node.orderPrefix ?? 'none',
    accessOverride: node.access ?? null,
    filingAliases: [...(node.filingAliases ?? [])],
    inheritedFrom: source,
    children: cloneToMutableNodes(node.children ?? [], source),
  }));
}

function splitTemplatePath(pathStr: string): string[] {
  return pathStr
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
}

function findNodeAndParentByPath(
  rootChildren: MutableTemplateNode[],
  pathStr: string,
): {
  parentList: MutableTemplateNode[];
  index: number;
  node: MutableTemplateNode;
} | null {
  const segments = splitTemplatePath(pathStr);
  if (segments.length === 0) return null;

  let currentList = rootChildren;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const idx = currentList.findIndex(
      (n) => n.name.toLowerCase() === seg.toLowerCase(),
    );
    if (idx === -1) return null;
    const found = currentList[idx]!;
    if (i === segments.length - 1) {
      return { parentList: currentList, index: idx, node: found };
    }
    currentList = found.children;
  }
  return null;
}

function applyTemplateOperation(
  rootChildren: MutableTemplateNode[],
  op: MatterFolderTemplateOperation,
  source: 'department' | 'work_type',
): void {
  switch (op.op) {
    case 'add': {
      const parentPath = (op.parentPath ?? '').trim();
      let targetList: MutableTemplateNode[];
      if (!parentPath || parentPath === '/') {
        targetList = rootChildren;
      } else {
        const parentMatch = findNodeAndParentByPath(rootChildren, parentPath);
        if (!parentMatch) {
          throw new Error(
            `TEMPLATE_OPERATION_ERROR: Cannot add node under non-existent parentPath "${parentPath}".`,
          );
        }
        targetList = parentMatch.node.children;
      }

      if (!op.node) {
        throw new Error(
          `TEMPLATE_OPERATION_ERROR: Operation "add" requires a "node" definition.`,
        );
      }

      const duplicate = targetList.some(
        (existing) => existing.name.toLowerCase() === op.node!.name.toLowerCase(),
      );
      if (duplicate) {
        throw new Error(
          `TEMPLATE_OPERATION_ERROR: Duplicate sibling folder "${op.node.name}" under "${parentPath || '/'}".`,
        );
      }

      const [mutableNode] = cloneToMutableNodes([op.node], source);
      if (mutableNode) {
        targetList.push(mutableNode);
      }
      break;
    }

    case 'remove': {
      const pathStr = (op.path ?? '').trim();
      const match = findNodeAndParentByPath(rootChildren, pathStr);
      if (!match) {
        throw new Error(
          `TEMPLATE_OPERATION_ERROR: Cannot remove non-existent folder path "${pathStr}".`,
        );
      }
      match.parentList.splice(match.index, 1);
      break;
    }

    case 'rename': {
      const pathStr = (op.path ?? '').trim();
      const newName = (op.newName ?? '').trim();
      if (!newName) {
        throw new Error(
          `TEMPLATE_OPERATION_ERROR: Operation "rename" on "${pathStr}" requires a non-empty "newName".`,
        );
      }
      const match = findNodeAndParentByPath(rootChildren, pathStr);
      if (!match) {
        throw new Error(
          `TEMPLATE_OPERATION_ERROR: Cannot rename non-existent folder path "${pathStr}".`,
        );
      }
      const duplicate = match.parentList.some(
        (sib, idx) =>
          idx !== match.index && sib.name.toLowerCase() === newName.toLowerCase(),
      );
      if (duplicate) {
        throw new Error(
          `TEMPLATE_OPERATION_ERROR: Renaming "${pathStr}" to "${newName}" creates a duplicate sibling folder.`,
        );
      }
      match.node.name = newName;
      match.node.inheritedFrom = source;
      break;
    }

    case 'move': {
      const pathStr = (op.path ?? '').trim();
      const newParentPath = (op.newParentPath ?? '').trim();
      const match = findNodeAndParentByPath(rootChildren, pathStr);
      if (!match) {
        throw new Error(
          `TEMPLATE_OPERATION_ERROR: Cannot move non-existent folder path "${pathStr}".`,
        );
      }

      let destList: MutableTemplateNode[];
      if (!newParentPath || newParentPath === '/') {
        destList = rootChildren;
      } else {
        if (
          newParentPath.toLowerCase() === pathStr.toLowerCase() ||
          newParentPath.toLowerCase().startsWith(`${pathStr.toLowerCase()}/`)
        ) {
          throw new Error(
            `TEMPLATE_OPERATION_ERROR: Cannot move folder "${pathStr}" into itself or one of its descendants ("${newParentPath}").`,
          );
        }
        const destParent = findNodeAndParentByPath(rootChildren, newParentPath);
        if (!destParent) {
          throw new Error(
            `TEMPLATE_OPERATION_ERROR: Cannot move "${pathStr}" to non-existent newParentPath "${newParentPath}".`,
          );
        }
        destList = destParent.node.children;
      }

      const duplicate = destList.some(
        (sib) => sib.name.toLowerCase() === match.node.name.toLowerCase(),
      );
      if (duplicate) {
        throw new Error(
          `TEMPLATE_OPERATION_ERROR: Moving "${pathStr}" to "${newParentPath || '/'}" creates a duplicate sibling folder.`,
        );
      }

      match.parentList.splice(match.index, 1);
      match.node.inheritedFrom = source;
      destList.push(match.node);
      break;
    }

    case 'setAccess': {
      const pathStr = (op.path ?? '').trim();
      const match = findNodeAndParentByPath(rootChildren, pathStr);
      if (!match) {
        throw new Error(
          `TEMPLATE_OPERATION_ERROR: Cannot setAccess on non-existent folder path "${pathStr}".`,
        );
      }
      match.node.accessOverride = op.access ?? null;
      match.node.inheritedFrom = source;
      break;
    }
  }
}

function formatNodeRenderedName(
  rawName: string,
  orderPrefix: 'none' | 'two_digit',
  siblingIndex: number,
  subject?: Pick<
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
): string {
  const baseName = subject
    ? renderFolderNameTemplate(rawName, subject)
    : rawName.trim();

  if (orderPrefix === 'two_digit') {
    const prefix = String(siblingIndex + 1).padStart(2, '0');
    if (/^\d{2}\s+/.test(baseName)) {
      return baseName;
    }
    return `${prefix} ${baseName}`;
  }

  return baseName;
}

function compileMutableTree(
  nodes: MutableTemplateNode[],
  parentRelativePath: string,
  subject?: Pick<
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
): {
  compiledNodes: CompiledFolderTemplateNode[];
  flatRelativePaths: string[];
  accessOverridePaths: string[];
} {
  const compiledNodes: CompiledFolderTemplateNode[] = [];
  const flatRelativePaths: string[] = [];
  const accessOverridePaths: string[] = [];

  nodes.forEach((node, idx) => {
    const renderedName = formatNodeRenderedName(
      node.name,
      node.orderPrefix,
      idx,
      subject,
    );
    const relativePath = parentRelativePath
      ? `${parentRelativePath}/${renderedName}`
      : renderedName;

    flatRelativePaths.push(relativePath);
    if (node.accessOverride) {
      accessOverridePaths.push(relativePath);
    }

    const childResult = compileMutableTree(
      node.children,
      relativePath,
      subject,
    );

    flatRelativePaths.push(...childResult.flatRelativePaths);
    accessOverridePaths.push(...childResult.accessOverridePaths);

    compiledNodes.push({
      name: node.name,
      renderedName,
      relativePath,
      description: node.description,
      orderPrefix: node.orderPrefix,
      accessOverride: node.accessOverride ?? null,
      filingAliases: node.filingAliases,
      inheritedFrom: node.inheritedFrom,
      children: childResult.compiledNodes,
    });
  });

  return { compiledNodes, flatRelativePaths, accessOverridePaths };
}

/**
 * Resolves and compiles the effective folder template for a given department and work type.
 * Resolution order:
 * 1. Work-type template (matching `workTypeId` or `practiceAreaId`)
 * 2. Department template (matching `departmentId`)
 * 3. Default template (`default`)
 */
export function resolveMatterFolderTemplate(params: {
  templatesConfig: MatterFolderTemplatesConfig;
  departmentId?: string;
  workTypeId?: string;
  practiceAreaId?: string;
  subject?: Pick<
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
  >;
}): ResolvedMatterFolderTemplate {
  const {
    templatesConfig,
    departmentId,
    workTypeId,
    practiceAreaId,
    subject,
  } = params;

  const defaultDef = templatesConfig.default;
  const deptDef = departmentId
    ? templatesConfig.byDepartment?.[departmentId]
    : undefined;
  const workTypeDef =
    (workTypeId ? templatesConfig.byWorkType?.[workTypeId] : undefined) ??
    (practiceAreaId ? templatesConfig.byWorkType?.[practiceAreaId] : undefined);

  // Build ordered layers from base to most specific
  const layers: Array<{
    def: MatterFolderTemplateDefinition;
    source: 'default' | 'department' | 'work_type';
  }> = [{ def: defaultDef, source: 'default' }];

  if (deptDef) {
    layers.push({ def: deptDef, source: 'department' });
  }
  if (workTypeDef) {
    layers.push({ def: workTypeDef, source: 'work_type' });
  }

  let workingTree: MutableTemplateNode[] = [];
  let effectiveTemplateId = defaultDef.templateId;
  let effectiveVersion = defaultDef.version;
  const resolutionChain: string[] = [];

  for (const layer of layers) {
    effectiveTemplateId = layer.def.templateId;
    effectiveVersion = layer.def.version;

    if (layer.source === 'default' || layer.def.mode === 'replaces') {
      resolutionChain.length = 0;
      resolutionChain.push(layer.def.templateId);
      workingTree = cloneToMutableNodes(layer.def.nodes ?? [], layer.source);
    } else {
      resolutionChain.push(layer.def.templateId);
      for (const op of layer.def.operations ?? []) {
        applyTemplateOperation(workingTree, op, layer.source);
      }
      if (layer.def.nodes && layer.def.nodes.length > 0 && !(layer.def.operations?.length)) {
        for (const extraNode of layer.def.nodes) {
          applyTemplateOperation(
            workingTree,
            { op: 'add', parentPath: '/', node: extraNode },
            layer.source,
          );
        }
      }
    }
  }

  const { compiledNodes, flatRelativePaths, accessOverridePaths } =
    compileMutableTree(workingTree, '', subject);

  const scaleWarnings: string[] = [];
  if (accessOverridePaths.length > 0) {
    scaleWarnings.push(
      `Template "${effectiveTemplateId}" defines ${accessOverridePaths.length} subfolder access override(s) (${accessOverridePaths.join(', ')}). Every matter provisioned with this template will consume ${accessOverridePaths.length} unique permission scope(s) in the document library, which counts against SharePoint's 5,000-scope recommended limit.`,
    );
  }

  return {
    templateId: effectiveTemplateId,
    version: effectiveVersion,
    resolutionChain,
    nodes: compiledNodes,
    flatRelativePaths,
    accessOverrideScopeCount: accessOverridePaths.length,
    scaleWarnings,
  };
}

/**
 * Converts compiled template nodes into provider-consumable `DocumentStoreFolderTreeNode[]`.
 */
export function toProviderFolderTreeNodes(
  compiledNodes: readonly CompiledFolderTemplateNode[],
): DocumentStoreFolderTreeNode[] {
  return compiledNodes.map((n) => ({
    name: n.renderedName,
    relativePath: n.relativePath,
    children: toProviderFolderTreeNodes(n.children),
  }));
}

/**
 * Computes strictly additive folder nodes that exist in `resolvedTemplate` but are missing
 * from an open matter's `existingFolderItemMap`. Never removes, renames, or moves existing folders.
 */
export function computeAdditiveTemplateDiff(
  resolvedTemplate: ResolvedMatterFolderTemplate,
  existingFolderItemMap: Readonly<Record<string, string>>,
): {
  missingRelativePaths: string[];
  additiveTree: DocumentStoreFolderTreeNode[];
} {
  const existingKeysLower = new Set(
    Object.keys(existingFolderItemMap).map((k) => k.toLowerCase()),
  );

  const missingRelativePaths = resolvedTemplate.flatRelativePaths.filter(
    (relPath) => !existingKeysLower.has(relPath.toLowerCase()),
  );

  function filterTreeForAdditions(
    nodes: readonly CompiledFolderTemplateNode[],
  ): DocumentStoreFolderTreeNode[] {
    const result: DocumentStoreFolderTreeNode[] = [];
    for (const node of nodes) {
      const childAdditions = filterTreeForAdditions(node.children);
      const isSelfMissing = !existingKeysLower.has(
        node.relativePath.toLowerCase(),
      );
      if (isSelfMissing || childAdditions.length > 0) {
        result.push({
          name: node.renderedName,
          relativePath: node.relativePath,
          children: childAdditions,
        });
      }
    }
    return result;
  }

  return {
    missingRelativePaths,
    additiveTree: filterTreeForAdditions(resolvedTemplate.nodes),
  };
}

export interface TemplateValidationIssue {
  templateId: string;
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

function validateCompiledNodeTree(
  templateId: string,
  nodes: readonly CompiledFolderTemplateNode[],
  depth: number,
  maxDepth: number,
  maxSegmentLength: number,
  maxPathLength: number,
  issues: TemplateValidationIssue[],
): void {
  if (depth > maxDepth) {
    issues.push({
      templateId,
      path: nodes[0]?.relativePath ?? '/',
      message: `Folder template exceeds maximum nesting depth of ${maxDepth}.`,
      severity: 'error',
    });
    return;
  }

  const seenSiblingNames = new Set<string>();
  for (const node of nodes) {
    const segCheck = validateRawFolderNameSegment(node.name, maxSegmentLength);
    if (!segCheck.valid) {
      issues.push({
        templateId,
        path: node.relativePath,
        message: segCheck.reason ?? `Invalid folder name "${node.name}".`,
        severity: 'error',
      });
    }

    const unknownTokens = findUnknownPathTokens(node.name);
    if (unknownTokens.length > 0) {
      issues.push({
        templateId,
        path: node.relativePath,
        message: `Folder name "${node.name}" contains unknown token(s): ${unknownTokens.join(', ')}.`,
        severity: 'error',
      });
    }

    const lowerRendered = node.renderedName.toLowerCase();
    if (seenSiblingNames.has(lowerRendered)) {
      issues.push({
        templateId,
        path: node.relativePath,
        message: `Duplicate sibling folder name "${node.renderedName}".`,
        severity: 'error',
      });
    }
    seenSiblingNames.add(lowerRendered);

    if (node.relativePath.length > maxPathLength) {
      issues.push({
        templateId,
        path: node.relativePath,
        message: `Template relative path "${node.relativePath}" exceeds maximum path length (${maxPathLength}).`,
        severity: 'error',
      });
    }

    if (node.accessOverride) {
      issues.push({
        templateId,
        path: node.relativePath,
        message: `Subfolder "${node.relativePath}" defines a unique access override, which breaks permission inheritance on every matter and consumes a library unique scope.`,
        severity: 'warning',
      });
    }

    if (node.children.length > 0) {
      validateCompiledNodeTree(
        templateId,
        node.children,
        depth + 1,
        maxDepth,
        maxSegmentLength,
        maxPathLength,
        issues,
      );
    }
  }
}

/**
 * Validates the entire `matterFolderTemplates` configuration section, including inheritance operations,
 * sibling name uniqueness, SharePoint forbidden characters, token validity, max depth, and scale warnings.
 */
export function validateMatterFolderTemplatesConfig(
  config: MatterFolderTemplatesConfig,
  options?: {
    maxDepth?: number;
    maxSegmentLength?: number;
    maxPathLength?: number;
  },
): {
  valid: boolean;
  errors: TemplateValidationIssue[];
  warnings: TemplateValidationIssue[];
} {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_TEMPLATE_DEPTH;
  const maxSegmentLength =
    options?.maxSegmentLength ?? DEFAULT_MAX_FOLDER_SEGMENT_LENGTH;
  const maxPathLength =
    options?.maxPathLength ?? DEFAULT_SHAREPOINT_MAX_PATH_LENGTH;

  const issues: TemplateValidationIssue[] = [];

  // 1. Validate default template
  try {
    const resolvedDefault = resolveMatterFolderTemplate({
      templatesConfig: config,
    });
    validateCompiledNodeTree(
      config.default.templateId,
      resolvedDefault.nodes,
      1,
      maxDepth,
      maxSegmentLength,
      maxPathLength,
      issues,
    );
  } catch (err) {
    issues.push({
      templateId: config.default.templateId,
      path: '/',
      message: err instanceof Error ? err.message : String(err),
      severity: 'error',
    });
  }

  // 2. Validate each department template
  for (const [deptId, deptDef] of Object.entries(config.byDepartment ?? {})) {
    try {
      const resolvedDept = resolveMatterFolderTemplate({
        templatesConfig: config,
        departmentId: deptId,
      });
      validateCompiledNodeTree(
        deptDef.templateId,
        resolvedDept.nodes,
        1,
        maxDepth,
        maxSegmentLength,
        maxPathLength,
        issues,
      );
    } catch (err) {
      issues.push({
        templateId: deptDef.templateId,
        path: `byDepartment.${deptId}`,
        message: err instanceof Error ? err.message : String(err),
        severity: 'error',
      });
    }
  }

  // 3. Validate each workType template (both standalone against default and combined with each department)
  for (const [workTypeId, wtDef] of Object.entries(config.byWorkType ?? {})) {
    try {
      const resolvedWt = resolveMatterFolderTemplate({
        templatesConfig: config,
        workTypeId,
      });
      validateCompiledNodeTree(
        wtDef.templateId,
        resolvedWt.nodes,
        1,
        maxDepth,
        maxSegmentLength,
        maxPathLength,
        issues,
      );
    } catch (err) {
      issues.push({
        templateId: wtDef.templateId,
        path: `byWorkType.${workTypeId}`,
        message: err instanceof Error ? err.message : String(err),
        severity: 'error',
      });
    }
  }

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
