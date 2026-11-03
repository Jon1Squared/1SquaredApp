/**
 * Template Usage Recording, Aggregation, Privacy Gate & Retention Service
 * (`core/src/domain/document-generation/usageService.ts`).
 *
 * Rules enforced (ADR-0006 & Functional Scope):
 * 1. Never stores field values, prompted field inputs, or document content in usage events.
 * 2. Requires `document_template:view_usage` to view template/practice-area/team reports.
 * 3. User-level breakdown requires BOTH `document_template:view_usage_by_user` AND
 *    `config.documentGeneration.usage.showUserLevelDetail === true`.
 * 4. Identifies retirement candidates (`generatedCount < lowUseThreshold`) and blocked-attempt
 *    missing field diagnostics.
 * 5. Retention purge job runs via `runTenantBackgroundJob` and refuses to run without `tenantId`.
 */

import type {
  DocumentOutputFormat,
  TemplateUsageEventRecord,
  TemplateUsageEventType,
  TenantConfiguration,
  TenantContext,
} from '../../api/index';
import {
  runTenantBackgroundJob,
  type TenantBackgroundJob,
} from '../../tenancy/index';
import type { TenantDocumentRepository } from '../../tenancy/documentRepository';
import {
  hasDocumentPermission,
  normaliseActorHomeRoles,
  type DocumentPermissionActor,
} from './permissions';

export function canActorViewUserLevelUsage(
  actor: DocumentPermissionActor,
  config: TenantConfiguration,
): boolean {
  return (
    config.documentGeneration.usage.showUserLevelDetail === true &&
    hasDocumentPermission(actor, 'document_template:view_usage_by_user', config)
  );
}

export interface RecordUsageEventInput {
  templateId: string;
  templateVersionId: string;
  versionNumber: number;
  eventType: TemplateUsageEventType;
  actor: DocumentPermissionActor;
  teamId?: string | null;
  practiceAreaId?: string | null;
  matterTypeId?: string | null;
  sourceEntityType: 'matter' | 'client' | 'template_builder';
  outputFormat: DocumentOutputFormat;
  missingFieldKeys?: string[];
  durationMs?: number;
  occurredAt?: string;
}

export function recordTemplateUsageEvent(
  ctx: TenantContext,
  repo: TenantDocumentRepository,
  input: RecordUsageEventInput,
): TemplateUsageEventRecord {
  const roles = normaliseActorHomeRoles(input.actor);
  const primaryRoleKey = roles[0] ?? 'fee_earner';

  const event: TemplateUsageEventRecord = {
    id: `USE-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
    tenantId: ctx.tenantId,
    templateId: input.templateId,
    templateVersionId: input.templateVersionId,
    versionNumber: input.versionNumber,
    eventType: input.eventType,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    actorUserId: input.actor.id,
    actorRoleKey: primaryRoleKey,
    teamId: input.teamId ?? null,
    practiceAreaId: input.practiceAreaId ?? null,
    matterTypeId: input.matterTypeId ?? null,
    sourceEntityType: input.sourceEntityType,
    outputFormat: input.outputFormat,
    missingFieldKeys: input.missingFieldKeys ? [...input.missingFieldKeys] : [],
    durationMs: input.durationMs ?? 0,
    correlationId: ctx.correlationId,
  };

  return repo.putUsageEvent(ctx, event);
}

export interface TemplateUsageReportFilter {
  fromDate?: string; // YYYY-MM-DD
  toDate?: string;   // YYYY-MM-DD
  practiceAreaId?: string;
  matterTypeId?: string;
  teamId?: string;
  templateId?: string;
}

export interface TemplateUsageRow {
  templateId: string;
  templateCode: string;
  templateName: string;
  category: string;
  status: string;
  activeVersionNumber: number | null;
  generatedCount: number;
  previewedCount: number;
  blockedMissingRequiredCount: number;
  blockedPermissionCount: number;
  lastGeneratedAt: string | null;
  last30DaysGeneratedCount: number;
  last90DaysGeneratedCount: number;
  isRetirementCandidate: boolean;
  topMissingFieldKeys: Array<{ fieldKey: string; count: number }>;
}

export interface DimensionUsageBreakdownRow {
  dimensionKey: string;
  generatedCount: number;
  previewedCount: number;
  blockedCount: number;
}

export interface UserUsageBreakdownRow {
  userId: string;
  roleKey: string;
  generatedCount: number;
  previewedCount: number;
  blockedCount: number;
  lastActiveAt: string;
}

export interface TemplateUsageReportResult {
  generatedAt: string;
  totalGeneratedCount: number;
  totalPreviewedCount: number;
  totalBlockedMissingRequiredCount: number;
  totalBlockedPermissionCount: number;
  lowUseThreshold: number;
  userLevelDetailPermitted: boolean;
  templates: TemplateUsageRow[];
  mostUsedTemplates: TemplateUsageRow[];
  leastUsedTemplates: TemplateUsageRow[];
  retirementCandidates: TemplateUsageRow[];
  byPracticeArea: DimensionUsageBreakdownRow[];
  byMatterType: DimensionUsageBreakdownRow[];
  byTeam: DimensionUsageBreakdownRow[];
  byUser?: UserUsageBreakdownRow[];
}

export function queryTemplateUsageReport(params: {
  ctx: TenantContext;
  repo: TenantDocumentRepository;
  actor: DocumentPermissionActor;
  config: TenantConfiguration;
  filter?: TemplateUsageReportFilter;
  nowIso?: string;
}): TemplateUsageReportResult {
  const { ctx, repo, actor, config, filter } = params;

  if (!hasDocumentPermission(actor, 'document_template:view_usage', config)) {
    throw new Error(
      'DOCUMENT_PERMISSION_DENIED: Viewing template usage reports requires "document_template:view_usage".',
    );
  }

  const now = params.nowIso ? new Date(params.nowIso) : new Date();
  const cutoff30Iso = new Date(
    now.getTime() - 30 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const cutoff90Iso = new Date(
    now.getTime() - 90 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const allTemplates = repo.listTemplates(ctx);
  const allVersions = repo.listAllTemplateVersions(ctx);
  const versionMap = new Map(allVersions.map((v) => [v.id, v]));
  const rawEvents = repo.listUsageEvents(ctx);

  // Filter events by optional date/taxonomy criteria
  const filteredEvents = rawEvents.filter((ev) => {
    const datePart = ev.occurredAt.slice(0, 10);
    if (filter?.fromDate && datePart < filter.fromDate) return false;
    if (filter?.toDate && datePart > filter.toDate) return false;
    if (filter?.practiceAreaId && ev.practiceAreaId !== filter.practiceAreaId) {
      return false;
    }
    if (filter?.matterTypeId && ev.matterTypeId !== filter.matterTypeId) {
      return false;
    }
    if (filter?.teamId && ev.teamId !== filter.teamId) {
      return false;
    }
    if (filter?.templateId && ev.templateId !== filter.templateId) {
      return false;
    }
    return true;
  });

  const lowUseThreshold = config.documentGeneration.usage.lowUseThreshold;

  const templateRows: TemplateUsageRow[] = allTemplates
    .filter((t) => (filter?.templateId ? t.id === filter.templateId : true))
    .map((t) => {
      const eventsForTemplate = filteredEvents.filter(
        (e) => e.templateId === t.id,
      );
      const allTimeEventsForTemplate = rawEvents.filter(
        (e) => e.templateId === t.id,
      );

      let generatedCount = 0;
      let previewedCount = 0;
      let blockedMissingRequiredCount = 0;
      let blockedPermissionCount = 0;
      let lastGeneratedAt: string | null = null;
      const missingFieldCounts = new Map<string, number>();

      for (const ev of eventsForTemplate) {
        if (ev.eventType === 'generated') {
          generatedCount += 1;
          if (!lastGeneratedAt || ev.occurredAt > lastGeneratedAt) {
            lastGeneratedAt = ev.occurredAt;
          }
        } else if (ev.eventType === 'previewed') {
          previewedCount += 1;
        } else if (ev.eventType === 'blocked_missing_required') {
          blockedMissingRequiredCount += 1;
          for (const key of ev.missingFieldKeys) {
            missingFieldCounts.set(key, (missingFieldCounts.get(key) ?? 0) + 1);
          }
        } else if (ev.eventType === 'blocked_permission') {
          blockedPermissionCount += 1;
        }
      }

      const last30DaysGeneratedCount = allTimeEventsForTemplate.filter(
        (e) => e.eventType === 'generated' && e.occurredAt >= cutoff30Iso,
      ).length;
      const last90DaysGeneratedCount = allTimeEventsForTemplate.filter(
        (e) => e.eventType === 'generated' && e.occurredAt >= cutoff90Iso,
      ).length;

      const activeVer = t.activeVersionId
        ? versionMap.get(t.activeVersionId)
        : undefined;

      const isRetirementCandidate =
        t.status === 'Active' && generatedCount < lowUseThreshold;

      const topMissingFieldKeys = Array.from(missingFieldCounts.entries())
        .map(([fieldKey, count]) => ({ fieldKey, count }))
        .sort((a, b) => b.count - a.count);

      return {
        templateId: t.id,
        templateCode: t.code,
        templateName: t.name,
        category: t.category,
        status: t.status,
        activeVersionNumber: activeVer?.versionNumber ?? null,
        generatedCount,
        previewedCount,
        blockedMissingRequiredCount,
        blockedPermissionCount,
        lastGeneratedAt,
        last30DaysGeneratedCount,
        last90DaysGeneratedCount,
        isRetirementCandidate,
        topMissingFieldKeys,
      };
    });

  const mostUsedTemplates = [...templateRows].sort(
    (a, b) => b.generatedCount - a.generatedCount,
  );
  const leastUsedTemplates = [...templateRows].sort(
    (a, b) => a.generatedCount - b.generatedCount,
  );
  const retirementCandidates = templateRows.filter(
    (r) => r.isRetirementCandidate,
  );

  const aggregateByDimension = (
    selector: (ev: TemplateUsageEventRecord) => string,
  ): DimensionUsageBreakdownRow[] => {
    const map = new Map<string, DimensionUsageBreakdownRow>();
    for (const ev of filteredEvents) {
      const key = selector(ev) || 'Unassigned';
      const row = map.get(key) ?? {
        dimensionKey: key,
        generatedCount: 0,
        previewedCount: 0,
        blockedCount: 0,
      };
      if (ev.eventType === 'generated') row.generatedCount += 1;
      else if (ev.eventType === 'previewed') row.previewedCount += 1;
      else row.blockedCount += 1;
      map.set(key, row);
    }
    return Array.from(map.values()).sort(
      (a, b) => b.generatedCount - a.generatedCount,
    );
  };

  const userLevelDetailPermitted = canActorViewUserLevelUsage(actor, config);
  let byUser: UserUsageBreakdownRow[] | undefined;

  if (userLevelDetailPermitted) {
    const userMap = new Map<string, UserUsageBreakdownRow>();
    for (const ev of filteredEvents) {
      const existing = userMap.get(ev.actorUserId) ?? {
        userId: ev.actorUserId,
        roleKey: ev.actorRoleKey,
        generatedCount: 0,
        previewedCount: 0,
        blockedCount: 0,
        lastActiveAt: ev.occurredAt,
      };
      if (ev.eventType === 'generated') existing.generatedCount += 1;
      else if (ev.eventType === 'previewed') existing.previewedCount += 1;
      else existing.blockedCount += 1;
      if (ev.occurredAt > existing.lastActiveAt) {
        existing.lastActiveAt = ev.occurredAt;
      }
      userMap.set(ev.actorUserId, existing);
    }
    byUser = Array.from(userMap.values()).sort(
      (a, b) => b.generatedCount - a.generatedCount,
    );
  }

  return {
    generatedAt: now.toISOString(),
    totalGeneratedCount: templateRows.reduce(
      (sum, r) => sum + r.generatedCount,
      0,
    ),
    totalPreviewedCount: templateRows.reduce(
      (sum, r) => sum + r.previewedCount,
      0,
    ),
    totalBlockedMissingRequiredCount: templateRows.reduce(
      (sum, r) => sum + r.blockedMissingRequiredCount,
      0,
    ),
    totalBlockedPermissionCount: templateRows.reduce(
      (sum, r) => sum + r.blockedPermissionCount,
      0,
    ),
    lowUseThreshold,
    userLevelDetailPermitted,
    templates: templateRows,
    mostUsedTemplates,
    leastUsedTemplates,
    retirementCandidates,
    byPracticeArea: aggregateByDimension((ev) => ev.practiceAreaId ?? ''),
    byMatterType: aggregateByDimension((ev) => ev.matterTypeId ?? ''),
    byTeam: aggregateByDimension((ev) => ev.teamId ?? ''),
    byUser,
  };
}

function escapeCsvCell(val: string | number | boolean | null | undefined): string {
  const s = val === null || val === undefined ? '' : String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function exportTemplateUsageReportCsv(
  report: TemplateUsageReportResult,
  includeUserSection = false,
): string {
  const lines: string[] = [];
  lines.push(
    [
      'Template ID',
      'Template Code',
      'Template Name',
      'Category',
      'Status',
      'Active Version',
      'Generated Count',
      'Previewed Count',
      'Blocked (Missing Required)',
      'Last 30d Generations',
      'Last 90d Generations',
      'Last Generated At',
      'Retirement Candidate',
    ]
      .map(escapeCsvCell)
      .join(','),
  );

  for (const row of report.templates) {
    lines.push(
      [
        row.templateId,
        row.templateCode,
        row.templateName,
        row.category,
        row.status,
        row.activeVersionNumber ?? '',
        row.generatedCount,
        row.previewedCount,
        row.blockedMissingRequiredCount,
        row.last30DaysGeneratedCount,
        row.last90DaysGeneratedCount,
        row.lastGeneratedAt ?? '',
        row.isRetirementCandidate ? 'Yes' : 'No',
      ]
        .map(escapeCsvCell)
        .join(','),
    );
  }

  if (includeUserSection && report.userLevelDetailPermitted && report.byUser) {
    lines.push('');
    lines.push(
      ['User ID', 'Role Key', 'Generated Count', 'Previewed Count', 'Blocked Count', 'Last Active At']
        .map(escapeCsvCell)
        .join(','),
    );
    for (const u of report.byUser) {
      lines.push(
        [
          u.userId,
          u.roleKey,
          u.generatedCount,
          u.previewedCount,
          u.blockedCount,
          u.lastActiveAt,
        ]
          .map(escapeCsvCell)
          .join(','),
      );
    }
  }

  return lines.join('\n');
}

export interface UsageRetentionJobPayload {
  retentionMonths: number;
  nowIso?: string;
}

export function executeUsageRetentionPurgeJob(
  ctx: TenantContext,
  repo: TenantDocumentRepository,
  job: TenantBackgroundJob<UsageRetentionJobPayload>,
): { purgedEventsCount: number; purgedSummaryBucketsCount: number } {
  return runTenantBackgroundJob(job, (verifiedJob) => {
    if (verifiedJob.tenantId !== ctx.tenantId) {
      throw new Error(
        'TENANCY_JOB_ERROR: Background job tenantId does not match TenantContext.',
      );
    }
    const baseDate = verifiedJob.payload.nowIso
      ? new Date(verifiedJob.payload.nowIso)
      : new Date();
    const cutoff = new Date(baseDate.getTime());
    cutoff.setUTCMonth(
      cutoff.getUTCMonth() - Math.max(1, verifiedJob.payload.retentionMonths),
    );
    return repo.purgeUsageOlderThan(ctx, cutoff.toISOString());
  });
}
