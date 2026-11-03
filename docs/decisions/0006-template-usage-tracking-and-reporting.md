# ADR-0006: Template Usage Tracking, Aggregation, Privacy, and Retention

- **Date:** 2026-04-20
- **Status:** Proposed

## Context

Template managers and firm leadership need visibility into how templates are used across the firm: which templates are actively generated, which are only previewed, which are unused retirement candidates, which fail generation due to missing required fields, and how usage breaks down by practice area, matter type, team, and (where permitted) user.

Under Section 8 (*Multi-tenancy and data isolation*) and the project brief, usage tracking must meet five requirements:

1. Usage data is **tenant data** stored in the tenant's own database, separate from the immutable security audit log.
2. Usage events must **never** store merged field values, prompted field inputs, or document content.
3. Aggregation queries (last 30/90 days, top/bottom templates, practice area breakdowns, retirement candidates) must stay fast at high document volumes without scanning millions of raw rows on every page load.
4. User-level breakdown must require **both** the `document_template:view_usage_by_user` permission **and** the tenant configuration flag `documentGeneration.usage.showUserLevelDetail === true`.
5. Usage events must respect `documentGeneration.usage.retentionMonths` and be purged completely on tenant offboarding.

## Decision

### 1. Dual-Table Storage in the Tenant Database (Raw Events + Daily Summary Rollups)

Usage data lives in the tenant's database in two dedicated tables, separate from `audit_entries`:

1. **`template_usage_events` (Raw Append-Only Event Stream, Retention-Bounded):**
   - Columns: `id`, `tenant_id`, `template_id`, `template_version_id`, `version_number`, `event_type` (`'generated' | 'previewed' | 'blocked_missing_required' | 'blocked_permission'`), `occurred_at`, `actor_user_id`, `actor_role_key`, `team_id`, `practice_area_id`, `matter_type_id`, `source_entity_type` (`'matter' | 'client' | 'template_builder'`), `output_format` (`'docx' | 'pdf'`), `missing_field_keys` (array of canonical field keys only, never values), `duration_ms`, `correlation_id`.
   - **Privacy constraint:** No `matter_id`, `client_id`, client name, field value, or document text is stored in `template_usage_events`. Storing only non-sensitive taxonomy IDs (`practice_area_id`, `matter_type_id`, `team_id`) and field keys ensures usage reports never leak restricted staff-matter existence or client confidential data.
   - Indexed on `(tenant_id, occurred_at DESC)`, `(tenant_id, template_id, occurred_at DESC)`, and `(tenant_id, actor_user_id, occurred_at DESC)`.

2. **`template_usage_daily_summaries` (Pre-Aggregated Rollup Table for Fast Reporting):**
   - Keyed by `(tenant_id, bucket_date, template_id, template_version_id, practice_area_id, matter_type_id, team_id)`.
   - Counters: `generated_count`, `previewed_count`, `blocked_missing_required_count`, `blocked_permission_count`, `last_generated_at`.
   - Updated synchronously within the usage recording unit of work (via `INSERT ... ON CONFLICT DO UPDATE`).
   - Allows the Usage Reporting dashboard, the Template Detail 30/90-day counters, and the Retirement Candidates query (`generated_count < lowUseThreshold`) to execute in milliseconds regardless of raw event volume.

### 2. Separation from the Immutable Audit Log

- The security audit log (`AuditEntry`) records security-relevant lifecycle actions (template creation, submission, approval, rejection, retirement, rollback, document generation, and document deletion) for compliance forensics and is immutable.
- `template_usage_events` and `template_usage_daily_summaries` are operational analytics tables subject to `documentGeneration.usage.retentionMonths`.

### 3. User-Level Breakdown Gate (Dual Check)

Any query or CSV export that groups or filters usage by `actor_user_id` enforces a two-factor check in the core service layer:

```ts
const canSeeUserLevel =
  config.documentGeneration.usage.showUserLevelDetail === true &&
  hasDocumentPermission(actor, 'document_template:view_usage_by_user', config);
```

When either condition is false, `actor_user_id` and user display names are stripped at the repository/service boundary before returning data to the caller or CSV exporter.

### 4. Retention Job and Tenant Offboarding

- A tenant-scoped background job (`purgeExpiredTemplateUsageJob`, executed via `runTenantBackgroundJob` from `core/src/tenancy/`) deletes rows from `template_usage_events` and `template_usage_daily_summaries` where `occurred_at` / `bucket_date` is older than `documentGeneration.usage.retentionMonths` (default: `24` months).
- During tenant offboarding, the tenant's database (Model A) or all `tenant_id`-scoped rows across `template_usage_events`, `template_usage_daily_summaries`, `documents`, `document_links`, `document_template_versions`, and `document_templates` plus the tenant's Blob container (Model B) are permanently deleted.

## Alternatives Considered

1. **Derive usage reports by querying `AuditEntry` directly.**
   - *Rejected:* Audit logs are immutable compliance records with different retention policies and lack structured columns for `practice_area_id`, `matter_type_id`, `missing_field_keys`, and daily rollup counters.
2. **Query only raw `template_usage_events` without a rollup table.**
   - *Rejected:* At tens of thousands of generations per month, scanning raw events for 90-day dashboard charts and low-use retirement thresholds degrades query performance.

## Consequences

- Usage dashboards, 30/90-day template summaries, blocked-field diagnostics, and CSV exports run in constant time relative to daily buckets.
- Restricted matter confidentiality and employee privacy (`showUserLevelDetail`) are enforced by design.
