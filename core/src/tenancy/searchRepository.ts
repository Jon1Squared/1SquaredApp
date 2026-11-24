/**
 * Tenant-scoped server-side hybrid search repository (`core/src/tenancy/searchRepository.ts`).
 *
 * Security invariant:
 * - Every query executes inside `withTenantReadTransaction` scoped to `ctx.tenantId`.
 * - Every entity CTE enforces RBAC permissions, record-level visibility (`is_staff_matter`,
 *   `has_ethical_wall`, `restrictedAccessUserIdsFallback`, named participants, personal Draft
 *   enquiries, `document:view` + `document_links`, `quote:view` + quote visibility,
 *   `keydate:view` + `permittedDiaryTeamIds`, `register:view`/`undertaking:manage` + matter
 *   visibility), and merge tombstones INSIDE SQL `WHERE` clauses BEFORE ranking, counting,
 *   limiting, or offsetting results.
 */

import type { TenantContext } from '../api/index';
import type { TenantPostgresPoolManager } from './postgresPoolManager';
import { buildRegisterEmployeeClientVisibleSqlPredicate } from './registerRepository';
import { TenantScopedRepository } from './tenantScopedRepository';

export type GlobalSearchEntityType =
  | 'person'
  | 'organisation'
  | 'matter'
  | 'enquiry'
  | 'task'
  | 'document'
  | 'quote'
  | 'key_date'
  | 'register_record';

export const GLOBAL_SEARCH_ENTITY_TYPES: readonly GlobalSearchEntityType[] = [
  'person',
  'organisation',
  'matter',
  'enquiry',
  'task',
  'document',
  'quote',
  'key_date',
  'register_record',
] as const;

export type GlobalSearchCountsByType = Record<GlobalSearchEntityType, number>;

export type GlobalSearchBadgeTone = 'warning' | 'alert' | 'positive' | 'neutral';

export interface SearchActorPermissions {
  readonly actorId: string;
  readonly hasRestrictedMatterAccess: boolean;
  readonly canViewDocuments: boolean;
  readonly canViewQuotes: boolean;
  readonly canViewFinance: boolean;
  readonly canViewKeyDates: boolean;
  readonly permittedDiaryTeamIds: readonly string[];
  readonly canViewRegisters: boolean;
  readonly canManageUndertakings: boolean;
  readonly canViewCdd?: boolean;
  readonly canViewRisk?: boolean;
}

export interface GlobalSearchQueryInput {
  readonly query: string;
  readonly entityTypes?: readonly GlobalSearchEntityType[];
  readonly limit?: number;
  readonly offset?: number;
  readonly actor: SearchActorPermissions;
}

export interface GlobalSearchHit {
  readonly id: string;
  readonly entityType: GlobalSearchEntityType;
  readonly title: string;
  readonly subtitle: string;
  readonly statusLabel: string | null;
  readonly badgeTone: GlobalSearchBadgeTone;
  readonly href: string;
  readonly secondaryLabel: string | null;
  readonly rank: number;
}

export interface GlobalSearchResponse {
  readonly query: string;
  readonly normalizedQuery: string;
  readonly hits: GlobalSearchHit[];
  readonly totalCount: number;
  readonly countsByType: GlobalSearchCountsByType;
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
}

export function createZeroGlobalSearchCounts(): GlobalSearchCountsByType {
  return {
    person: 0,
    organisation: 0,
    matter: 0,
    enquiry: 0,
    task: 0,
    document: 0,
    quote: 0,
    key_date: 0,
    register_record: 0,
  };
}

function normalizeSearchQuery(rawQuery: string): {
  trimmed: string;
  ilikePattern: string;
  prefixPattern: string;
  prefixTsQuery: string | null;
} {
  const trimmed = rawQuery.trim().replace(/\s+/g, ' ');
  const escapedForLike = trimmed.replace(/[\\%_]/g, '\\$&');
  const ilikePattern = `%${escapedForLike}%`;
  const prefixPattern = `${escapedForLike}%`;

  const tokens = trimmed
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}]+/gu, ''))
    .filter((token) => token.length > 0)
    .slice(0, 8);

  const prefixTsQuery =
    tokens.length > 0 ? tokens.map((tok) => `${tok}:*`).join(' & ') : null;

  return {
    trimmed,
    ilikePattern,
    prefixPattern,
    prefixTsQuery,
  };
}

/**
 * Resolves explicit allowlist JSONB for matter `alias` consistent with
 * `mattersRepository.buildMatterDbParameters`: if `opening_record_json->'restrictedAccessUserIdsFallback'`
 * is an array, use it instead of `restricted_access_user_ids_json` so revoked `matter:restricted:access`
 * permissions never linger in cached allowlist arrays.
 */
function buildExplicitAllowJsonSql(alias: string): string {
  return `(
    CASE
      WHEN jsonb_typeof(${alias}.opening_record_json->'restrictedAccessUserIdsFallback') = 'array'
      THEN ${alias}.opening_record_json->'restrictedAccessUserIdsFallback'
      ELSE COALESCE(${alias}.restricted_access_user_ids_json, '[]'::jsonb)
    END
  )`;
}

/**
 * Matches `canAccessMatter` semantics in `core/src/domain/rbac/resolver.ts` directly inside SQL.
 */
function buildMatterAccessibleSql(alias: string): string {
  const explicitAllowJson = buildExplicitAllowJsonSql(alias);
  return `(
    (
      ${alias}.is_staff_matter = FALSE
      AND ${alias}.has_ethical_wall = FALSE
      AND jsonb_array_length(${explicitAllowJson}) = 0
    )
    OR ($3::boolean = TRUE)
    OR COALESCE(${alias}.responsible_partner_id, '') = $2
    OR COALESCE(${alias}.supervisor_id, '') = $2
    OR COALESCE(${alias}.responsible_fee_earner_id, '') = $2
    OR (
      jsonb_typeof(${alias}.opening_record_json->'teamMemberIds') = 'array'
      AND (${alias}.opening_record_json->'teamMemberIds') ? $2
    )
    OR (${explicitAllowJson} ? $2)
  )`;
}

function buildEnquiryAccessibleSql(alias: string): string {
  return `(
    (
      ${alias}.status <> 'Draft'
      OR COALESCE(${alias}.created_by_id, '') = $2
      OR COALESCE(${alias}.taken_by_id, '') = $2
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.matters m_enq
      WHERE m_enq.tenant_id = ${alias}.tenant_id
        AND (m_enq.id = ${alias}.converted_matter_id OR m_enq.source_enquiry_id = ${alias}.id)
        AND NOT ${buildMatterAccessibleSql('m_enq')}
    )
  )`;
}

function buildQuoteAccessibleSql(alias: string): string {
  return `(
    $9::boolean = TRUE
    AND NOT EXISTS (
      SELECT 1 FROM public.matters m_q
      WHERE m_q.tenant_id = ${alias}.tenant_id
        AND (m_q.id = ${alias}.converted_matter_id OR m_q.source_quote_id = ${alias}.id)
        AND NOT ${buildMatterAccessibleSql('m_q')}
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.enquiries e_q
      WHERE e_q.tenant_id = ${alias}.tenant_id
        AND e_q.id = ${alias}.source_enquiry_id
        AND NOT ${buildEnquiryAccessibleSql('e_q')}
    )
  )`;
}

function buildLinkedKeyDateInaccessibleSql(
  matterAlias: string,
  enqAlias: string,
): string {
  return `(
    (${matterAlias}.id IS NOT NULL AND NOT ${buildMatterAccessibleSql(matterAlias)})
    OR (${enqAlias}.id IS NOT NULL AND NOT ${buildEnquiryAccessibleSql(enqAlias)})
  )`;
}

function buildTaskAccessibleSql(alias: string): string {
  return `(
    (
      ${alias}.linked_key_date_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM public.key_dates kd_t
        LEFT JOIN public.matters km_t
          ON km_t.tenant_id = kd_t.tenant_id AND km_t.id = kd_t.matter_id
        LEFT JOIN public.enquiries ke_t
          ON ke_t.tenant_id = kd_t.tenant_id AND ke_t.id = kd_t.enquiry_id
        WHERE kd_t.tenant_id = ${alias}.tenant_id
          AND kd_t.id = ${alias}.linked_key_date_id
          AND ${buildLinkedKeyDateInaccessibleSql('km_t', 'ke_t')}
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.task_linked_records tlr_kd
      JOIN public.key_dates kd_tlr
        ON kd_tlr.tenant_id = tlr_kd.tenant_id AND kd_tlr.id = tlr_kd.record_id
      LEFT JOIN public.matters km_tlr
        ON km_tlr.tenant_id = kd_tlr.tenant_id AND km_tlr.id = kd_tlr.matter_id
      LEFT JOIN public.enquiries ke_tlr
        ON ke_tlr.tenant_id = kd_tlr.tenant_id AND ke_tlr.id = kd_tlr.enquiry_id
      WHERE tlr_kd.tenant_id = ${alias}.tenant_id
        AND tlr_kd.task_id = ${alias}.id
        AND tlr_kd.record_type = 'key_date'
        AND ${buildLinkedKeyDateInaccessibleSql('km_tlr', 'ke_tlr')}
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.task_linked_records tlr_m
      JOIN public.matters tm_m
        ON tm_m.tenant_id = tlr_m.tenant_id AND tm_m.id = tlr_m.record_id
      WHERE tlr_m.tenant_id = ${alias}.tenant_id
        AND tlr_m.task_id = ${alias}.id
        AND tlr_m.record_type = 'matter'
        AND NOT ${buildMatterAccessibleSql('tm_m')}
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.task_linked_records tlr_e
      JOIN public.enquiries te_e
        ON te_e.tenant_id = tlr_e.tenant_id AND te_e.id = tlr_e.record_id
      WHERE tlr_e.tenant_id = ${alias}.tenant_id
        AND tlr_e.task_id = ${alias}.id
        AND tlr_e.record_type = 'enquiry'
        AND NOT ${buildEnquiryAccessibleSql('te_e')}
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.task_linked_records tlr_q
      JOIN public.quotes tq_q
        ON tq_q.tenant_id = tlr_q.tenant_id AND tq_q.id = tlr_q.record_id
      WHERE tlr_q.tenant_id = ${alias}.tenant_id
        AND tlr_q.task_id = ${alias}.id
        AND tlr_q.record_type = 'quote'
        AND (
          EXISTS (
            SELECT 1 FROM public.matters m_tq
            WHERE m_tq.tenant_id = tq_q.tenant_id
              AND (m_tq.id = tq_q.converted_matter_id OR m_tq.source_quote_id = tq_q.id)
              AND NOT ${buildMatterAccessibleSql('m_tq')}
          )
          OR EXISTS (
            SELECT 1 FROM public.enquiries e_tq
            WHERE e_tq.tenant_id = tq_q.tenant_id
              AND e_tq.id = tq_q.source_enquiry_id
              AND NOT ${buildEnquiryAccessibleSql('e_tq')}
          )
        )
    )
  )`;
}

function buildDocumentAccessibleSql(alias: string): string {
  return `(
    $8::boolean = TRUE
    AND ${alias}.is_deleted = FALSE
    AND (
      ${alias}.primary_matter_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM public.matters dm_p
        WHERE dm_p.tenant_id = ${alias}.tenant_id
          AND dm_p.id = ${alias}.primary_matter_id
          AND NOT ${buildMatterAccessibleSql('dm_p')}
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.document_links dl_m
      JOIN public.matters dm_l
        ON dm_l.tenant_id = dl_m.tenant_id AND dm_l.id = dl_m.entity_id
      WHERE dl_m.tenant_id = ${alias}.tenant_id
        AND dl_m.document_id = ${alias}.id
        AND dl_m.entity_type = 'matter'
        AND NOT ${buildMatterAccessibleSql('dm_l')}
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.document_links dl_e
      JOIN public.enquiries de_l
        ON de_l.tenant_id = dl_e.tenant_id AND de_l.id = dl_e.entity_id
      WHERE dl_e.tenant_id = ${alias}.tenant_id
        AND dl_e.document_id = ${alias}.id
        AND dl_e.entity_type = 'enquiry'
        AND NOT ${buildEnquiryAccessibleSql('de_l')}
    )
  )`;
}

function buildKeyDateAccessibleSql(alias: string): string {
  return `(
    $11::boolean = TRUE
    AND ${alias}.team_id = ANY($12::text[])
    AND (
      ${alias}.matter_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM public.matters kdm
        WHERE kdm.tenant_id = ${alias}.tenant_id
          AND kdm.id = ${alias}.matter_id
          AND NOT ${buildMatterAccessibleSql('kdm')}
      )
    )
    AND (
      ${alias}.enquiry_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM public.enquiries kde
        WHERE kde.tenant_id = ${alias}.tenant_id
          AND kde.id = ${alias}.enquiry_id
          AND NOT ${buildEnquiryAccessibleSql('kde')}
      )
    )
  )`;
}

function buildRegisterAccessibleSql(alias: string): string {
  return `(
    (
      (
        ${alias}.register_type_key = 'cdd'
        AND ${buildRegisterEmployeeClientVisibleSqlPredicate({
          viewerParamIndex: 2,
          canViewCddParamIndex: 18,
          canBypassEmployeeCddParamIndex: 19,
        })}
      )
      OR (
        ${alias}.register_type_key <> 'cdd'
        AND ($13::boolean = TRUE OR $14::boolean = TRUE)
        AND ($13::boolean = TRUE OR ${alias}.register_type_key = 'undertaking')
      )
    )
    AND (
      ${alias}.matter_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM public.matters rm
        WHERE rm.tenant_id = ${alias}.tenant_id
          AND rm.id = ${alias}.matter_id
          AND NOT ${buildMatterAccessibleSql('rm')}
      )
    )
    AND (
      ${alias}.enquiry_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM public.enquiries re
        WHERE re.tenant_id = ${alias}.tenant_id
          AND re.id = ${alias}.enquiry_id
          AND NOT ${buildEnquiryAccessibleSql('re')}
      )
    )
  )`;
}

/**
 * Repeats the identical indexed expressions from Migration 0018 (`to_tsvector('simple', expr)`
 * and `expr gin_trgm_ops`) so PostgreSQL can utilise GIN indexes directly.
 */
const ENTITY_EXPR = {
  person: `(
    COALESCE(p.first_name, '') || ' ' ||
    COALESCE(p.preferred_name, '') || ' ' ||
    COALESCE(p.other_names, '') || ' ' ||
    COALESCE(p.surname, '') || ' ' ||
    COALESCE(p.job_title, '') || ' ' ||
    COALESCE(p.primary_email_lower, '') || ' ' ||
    COALESCE(p.id, '')
  )`,
  organisation: `(
    COALESCE(o.legal_name, '') || ' ' ||
    COALESCE(o.trading_name, '') || ' ' ||
    COALESCE(o.company_number, '') || ' ' ||
    COALESCE(o.vat_number, '') || ' ' ||
    COALESCE(o.client_reference, '') || ' ' ||
    COALESCE(o.general_email, '') || ' ' ||
    COALESCE(o.main_phone, '') || ' ' ||
    COALESCE(o.website, '') || ' ' ||
    COALESCE(o.id, '')
  )`,
  matter: `(
    COALESCE(m.matter_number, '') || ' ' ||
    COALESCE(m.title, '') || ' ' ||
    COALESCE(m.practice_area_id, '') || ' ' ||
    COALESCE(m.work_type_subcategory_id, '') || ' ' ||
    COALESCE(m.status_id, '') || ' ' ||
    COALESCE(m.current_stage_id, '') || ' ' ||
    COALESCE(m.id, '')
  )`,
  enquiry: `(
    COALESCE(e.reference, '') || ' ' ||
    COALESCE(e.first_name, '') || ' ' ||
    COALESCE(e.last_name, '') || ' ' ||
    COALESCE(e.email, '') || ' ' ||
    COALESCE(e.phone, '') || ' ' ||
    COALESCE(e.postcode, '') || ' ' ||
    COALESCE(e.calling_on_behalf_of, '') || ' ' ||
    COALESCE(e.organisation_name, '') || ' ' ||
    COALESCE(e.practice_area_id, '') || ' ' ||
    COALESCE(e.summary_and_notes_json->>'matterSummary', '') || ' ' ||
    COALESCE(e.id, '')
  )`,
  quote: `(
    COALESCE(q.quote_reference, '') || ' ' ||
    COALESCE(q.prospect_name, '') || ' ' ||
    COALESCE(q.status, '') || ' ' ||
    COALESCE(q.fee_basis, '') || ' ' ||
    COALESCE(q.practice_area_id, '') || ' ' ||
    COALESCE(q.id, '')
  )`,
  task: `(
    COALESCE(t.reference, '') || ' ' ||
    COALESCE(t.title, '') || ' ' ||
    COALESCE(t.description, '') || ' ' ||
    COALESCE(t.status, '') || ' ' ||
    COALESCE(t.id, '')
  )`,
  document: `(
    COALESCE(d.title, '') || ' ' ||
    COALESCE(d.file_name, '') || ' ' ||
    COALESCE(d.document_type, '') || ' ' ||
    COALESCE(d.output_format, '') || ' ' ||
    COALESCE(d.template_name, '') || ' ' ||
    COALESCE(d.generated_by_name, '') || ' ' ||
    COALESCE(d.id, '')
  )`,
  key_date: `(
    COALESCE(kd.title, '') || ' ' ||
    COALESCE(kd.category, '') || ' ' ||
    COALESCE(kd.key_date_type_id, '') || ' ' ||
    COALESCE(kd.status, '') || ' ' ||
    COALESCE(kd.notes, '') || ' ' ||
    COALESCE(kd.id, '')
  )`,
  register_record: `(
    COALESCE(r.reference, '') || ' ' ||
    COALESCE(r.title, '') || ' ' ||
    COALESCE(r.register_type_key, '') || ' ' ||
    COALESCE(r.status, '') || ' ' ||
    COALESCE(r.id, '')
  )`,
} as const;

function buildHybridMatchSql(exprSql: string): string {
  return `(
    (${exprSql}) ILIKE $5
    OR ($7::text IS NOT NULL AND to_tsvector('simple', ${exprSql}) @@ to_tsquery('simple', $7))
    OR ($4::text <> '' AND to_tsvector('simple', ${exprSql}) @@ websearch_to_tsquery('simple', $4))
    OR (char_length($4::text) >= 3 AND $4::text <% (${exprSql}))
  )`;
}

function buildHybridRankSql(
  exprSql: string,
  exactKeySql: string,
  prefixKeySql: string,
): string {
  return `(
    CASE WHEN lower(${exactKeySql}) = lower($4::text) THEN 100.0 ELSE 0.0 END
    + CASE WHEN lower(${prefixKeySql}) LIKE lower($6) THEN 40.0 ELSE 0.0 END
    + CASE WHEN (${exprSql}) ILIKE $5 THEN 10.0 ELSE 0.0 END
    + COALESCE(
        CASE WHEN $7::text IS NOT NULL
          THEN ts_rank_cd(to_tsvector('simple', ${exprSql}), to_tsquery('simple', $7)) * 18.0
          ELSE 0.0
        END,
        0.0
      )
    + COALESCE(ts_rank_cd(to_tsvector('simple', ${exprSql}), websearch_to_tsquery('simple', $4)) * 12.0, 0.0)
    + COALESCE(word_similarity($4::text, ${exprSql}) * 15.0, 0.0)
    + COALESCE(similarity(${exprSql}, $4::text) * 6.0, 0.0)
  )::double precision`;
}

interface DbSearchHitRow {
  id: string;
  entity_type: GlobalSearchEntityType;
  title: string;
  subtitle: string;
  status_label: string | null;
  badge_tone: GlobalSearchBadgeTone;
  href: string;
  secondary_label: string | null;
  rank: number;
}

interface DbSearchCountRow {
  entity_type: GlobalSearchEntityType;
  hit_count: string | number;
}

const VALID_ENTITY_TYPE_SET = new Set<GlobalSearchEntityType>(GLOBAL_SEARCH_ENTITY_TYPES);

export class TenantSearchRepository extends TenantScopedRepository {
  public constructor(options?: {
    poolManager?: TenantPostgresPoolManager;
    requiredSchemaVersion?: string;
    statementTimeoutMs?: number;
  }) {
    super(options);
  }

  public async searchRecords(
    ctx: TenantContext,
    input: GlobalSearchQueryInput,
  ): Promise<GlobalSearchResponse> {
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), 50);
    const offset = Math.max(Math.trunc(input.offset ?? 0), 0);
    const { trimmed, ilikePattern, prefixPattern, prefixTsQuery } = normalizeSearchQuery(
      input.query,
    );

    const requestedTypes = (input.entityTypes ?? []).filter((t): t is GlobalSearchEntityType =>
      VALID_ENTITY_TYPE_SET.has(t),
    );
    const activeTypes =
      requestedTypes.length > 0 ? Array.from(new Set(requestedTypes)) : [...GLOBAL_SEARCH_ENTITY_TYPES];

    if (!trimmed || !input.actor.actorId.trim()) {
      return {
        query: input.query,
        normalizedQuery: trimmed,
        hits: [],
        totalCount: 0,
        countsByType: createZeroGlobalSearchCounts(),
        limit,
        offset,
        hasMore: false,
      };
    }

    const searchSql = `
      WITH
      person_hits AS (
        SELECT
          p.id AS id,
          'person'::text AS entity_type,
          COALESCE(
            NULLIF(
              TRIM(
                COALESCE(NULLIF(p.preferred_name, ''), p.first_name) || ' ' || COALESCE(p.surname, '')
              ),
              ''
            ),
            p.id
          ) AS title,
          COALESCE(
            NULLIF(
              CONCAT_WS(
                ' · ',
                CASE WHEN p.is_employee THEN NULLIF(p.job_title, '') ELSE NULL END,
                NULLIF(p.primary_email_lower, ''),
                CASE WHEN NOT p.is_employee THEN NULLIF(p.job_title, '') ELSE NULL END
              ),
              ''
            ),
            CASE WHEN p.is_employee THEN 'Employee' ELSE 'Person' END
          ) AS subtitle,
          CASE
            WHEN p.is_employee THEN 'Employee'
            ELSE NULLIF(p.client_status_id, '')
          END AS status_label,
          CASE
            WHEN p.is_employee THEN 'neutral'
            WHEN COALESCE(p.aml_status_id, '') ILIKE '%verified%' OR COALESCE(p.aml_status_id, '') ILIKE '%pass%' THEN 'positive'
            ELSE 'neutral'
          END AS badge_tone,
          '/people/' || p.id AS href,
          NULLIF(p.id, '') AS secondary_label,
          GREATEST(
            ${buildHybridRankSql(
              ENTITY_EXPR.person,
              `COALESCE(NULLIF(p.primary_email_lower, ''), p.id)`,
              `TRIM(COALESCE(NULLIF(p.preferred_name, ''), p.first_name) || ' ' || COALESCE(p.surname, ''))`,
            )},
            COALESCE(
              (
                SELECT MAX(
                  CASE WHEN lower(pe.email_lower) = lower($4::text) THEN 100.0
                       WHEN lower(pe.email_lower) LIKE lower($6) THEN 40.0
                       WHEN pe.email_lower ILIKE $5 THEN 14.0
                       ELSE COALESCE(word_similarity($4::text, pe.email_lower) * 14.0, 0.0)
                  END
                )
                FROM public.person_emails pe
                WHERE pe.tenant_id = p.tenant_id
                  AND pe.person_id = p.id
                  AND pe.active = TRUE
              ),
              0.0
            )
          ) AS rank
        FROM public.people p
        WHERE p.tenant_id = $1
          AND p.merged_into_id IS NULL
          AND (
            ${buildHybridMatchSql(ENTITY_EXPR.person)}
            OR EXISTS (
              SELECT 1 FROM public.person_emails pe
              WHERE pe.tenant_id = p.tenant_id
                AND pe.person_id = p.id
                AND pe.active = TRUE
                AND (
                  pe.email_lower ILIKE $5
                  OR (char_length($4::text) >= 3 AND $4::text <% pe.email_lower)
                )
            )
          )
      ),
      organisation_hits AS (
        SELECT
          o.id AS id,
          'organisation'::text AS entity_type,
          COALESCE(NULLIF(o.trading_name, ''), NULLIF(o.legal_name, ''), o.id) AS title,
          COALESCE(
            NULLIF(
              CONCAT_WS(
                ' · ',
                CASE
                  WHEN NULLIF(o.trading_name, '') IS NOT NULL
                   AND NULLIF(o.legal_name, '') IS NOT NULL
                   AND o.trading_name <> o.legal_name
                  THEN o.legal_name
                  ELSE NULL
                END,
                NULLIF(o.company_number, ''),
                NULLIF(o.client_reference, ''),
                NULLIF(o.general_email, '')
              ),
              ''
            ),
            'Organisation'
          ) AS subtitle,
          NULLIF(o.conflict_status, '') AS status_label,
          CASE
            WHEN o.conflict_status = 'Potential conflict' THEN 'warning'
            WHEN o.conflict_status = 'Conflict' THEN 'alert'
            WHEN o.conflict_status = 'Cleared' THEN 'positive'
            ELSE 'neutral'
          END AS badge_tone,
          '/organisations/' || o.id AS href,
          NULLIF(o.company_number, '') AS secondary_label,
          ${buildHybridRankSql(
            ENTITY_EXPR.organisation,
            `COALESCE(NULLIF(o.company_number, ''), NULLIF(o.client_reference, ''), o.id)`,
            `COALESCE(NULLIF(o.trading_name, ''), o.legal_name)`,
          )} AS rank
        FROM public.organisations o
        WHERE o.tenant_id = $1
          AND o.merged_into_id IS NULL
          AND ${buildHybridMatchSql(ENTITY_EXPR.organisation)}
      ),
      matter_hits AS (
        SELECT
          m.id AS id,
          'matter'::text AS entity_type,
          COALESCE(NULLIF(m.matter_number || ' — ' || NULLIF(m.title, ''), ''), NULLIF(m.title, ''), m.id) AS title,
          COALESCE(
            NULLIF(
              CONCAT_WS(
                ' · ',
                NULLIF(m.practice_area_id, ''),
                NULLIF(m.current_stage_id, ''),
                CASE WHEN m.is_staff_matter THEN 'Staff matter' ELSE NULL END,
                CASE WHEN m.has_ethical_wall THEN 'Ethical wall' ELSE NULL END
              ),
              ''
            ),
            'Matter'
          ) AS subtitle,
          NULLIF(m.status_id, '') AS status_label,
          CASE
            WHEN m.conflict_check_status = 'Conflict' THEN 'alert'
            WHEN m.conflict_check_status = 'Pending' THEN 'warning'
            ELSE 'neutral'
          END AS badge_tone,
          '/matters/' || m.id AS href,
          NULLIF(m.matter_number, '') AS secondary_label,
          ${buildHybridRankSql(
            ENTITY_EXPR.matter,
            `COALESCE(NULLIF(m.matter_number, ''), m.id)`,
            `COALESCE(NULLIF(m.title, ''), m.matter_number)`,
          )} AS rank
        FROM public.matters m
        WHERE m.tenant_id = $1
          AND m.client_id <> 'O-KEYDATE-STUB'
          AND ${buildMatterAccessibleSql('m')}
          AND ${buildHybridMatchSql(ENTITY_EXPR.matter)}
      ),
      enquiry_hits AS (
        SELECT
          e.id AS id,
          'enquiry'::text AS entity_type,
          COALESCE(
            NULLIF(
              CONCAT_WS(
                ' — ',
                NULLIF(e.reference, ''),
                NULLIF(TRIM(e.first_name || ' ' || e.last_name), '')
              ),
              ''
            ),
            e.id
          ) AS title,
          COALESCE(
            NULLIF(
              CONCAT_WS(
                ' · ',
                NULLIF(e.organisation_name, ''),
                NULLIF(e.practice_area_id, ''),
                NULLIF(e.email, '')
              ),
              ''
            ),
            'Enquiry'
          ) AS subtitle,
          NULLIF(e.status, '') AS status_label,
          CASE
            WHEN e.status = 'New' THEN 'warning'
            WHEN e.status = 'Converted' THEN 'positive'
            WHEN e.status = 'Closed' THEN 'neutral'
            ELSE 'neutral'
          END AS badge_tone,
          '/enquiries/' || e.id AS href,
          NULLIF(e.reference, '') AS secondary_label,
          ${buildHybridRankSql(
            ENTITY_EXPR.enquiry,
            `COALESCE(NULLIF(e.reference, ''), e.id)`,
            `TRIM(e.first_name || ' ' || e.last_name)`,
          )} AS rank
        FROM public.enquiries e
        WHERE e.tenant_id = $1
          AND ${buildEnquiryAccessibleSql('e')}
          AND ${buildHybridMatchSql(ENTITY_EXPR.enquiry)}
      ),
      quote_hits AS (
        SELECT
          q.id AS id,
          'quote'::text AS entity_type,
          COALESCE(
            NULLIF(
              CONCAT_WS(
                ' — ',
                NULLIF(q.quote_reference, ''),
                NULLIF(q.prospect_name, '')
              ),
              ''
            ),
            q.id
          ) AS title,
          COALESCE(
            NULLIF(
              CONCAT_WS(
                ' · ',
                NULLIF(q.fee_basis, ''),
                NULLIF(q.practice_area_id, ''),
                CASE
                  WHEN $10::boolean = TRUE
                  THEN '£' || TRIM(TO_CHAR(q.total_inc_vat_gbp, 'FM999999990.00'))
                  ELSE NULL
                END
              ),
              ''
            ),
            'Quote'
          ) AS subtitle,
          NULLIF(q.status, '') AS status_label,
          CASE
            WHEN q.status = 'Accepted' THEN 'positive'
            WHEN q.status IN ('Declined', 'Expired') THEN 'alert'
            WHEN q.status IN ('Pending approval', 'Sent') THEN 'warning'
            ELSE 'neutral'
          END AS badge_tone,
          '/quotes/' || q.id AS href,
          NULLIF(q.quote_reference, '') AS secondary_label,
          ${buildHybridRankSql(
            ENTITY_EXPR.quote,
            `COALESCE(NULLIF(q.quote_reference, ''), q.id)`,
            `COALESCE(NULLIF(q.prospect_name, ''), q.quote_reference)`,
          )} AS rank
        FROM public.quotes q
        WHERE q.tenant_id = $1
          AND ${buildQuoteAccessibleSql('q')}
          AND ${buildHybridMatchSql(ENTITY_EXPR.quote)}
      ),
      task_hits AS (
        SELECT
          t.id AS id,
          'task'::text AS entity_type,
          COALESCE(
            NULLIF(
              CONCAT_WS(' — ', NULLIF(t.reference, ''), NULLIF(t.title, '')),
              ''
            ),
            t.id
          ) AS title,
          COALESCE(
            NULLIF(LEFT(NULLIF(t.description, ''), 120), ''),
            CASE WHEN t.due_at IS NOT NULL THEN 'Due ' || t.due_at ELSE 'Task' END
          ) AS subtitle,
          NULLIF(t.status, '') AS status_label,
          CASE
            WHEN t.status IN ('Blocked', 'Overdue') THEN 'alert'
            WHEN t.status = 'Done' THEN 'positive'
            ELSE 'neutral'
          END AS badge_tone,
          '/tasks/' || t.id AS href,
          NULLIF(t.reference, '') AS secondary_label,
          ${buildHybridRankSql(
            ENTITY_EXPR.task,
            `COALESCE(NULLIF(t.reference, ''), t.id)`,
            `t.title`,
          )} AS rank
        FROM public.tasks t
        WHERE t.tenant_id = $1
          AND ${buildTaskAccessibleSql('t')}
          AND ${buildHybridMatchSql(ENTITY_EXPR.task)}
      ),
      document_hits AS (
        SELECT
          d.id AS id,
          'document'::text AS entity_type,
          COALESCE(NULLIF(d.title, ''), NULLIF(d.file_name, ''), d.id) AS title,
          COALESCE(
            NULLIF(
              CONCAT_WS(
                ' · ',
                NULLIF(d.file_name, ''),
                NULLIF(d.template_name, ''),
                NULLIF(d.generated_by_name, '')
              ),
              ''
            ),
            'Document'
          ) AS subtitle,
          NULLIF(UPPER(d.output_format), '') AS status_label,
          'neutral'::text AS badge_tone,
          COALESCE(
            CASE WHEN d.primary_matter_id IS NOT NULL THEN '/matters/' || d.primary_matter_id || '?tab=documents' ELSE NULL END,
            CASE WHEN d.primary_client_id LIKE 'P-%' THEN '/people/' || d.primary_client_id || '?tab=documents' ELSE NULL END,
            CASE WHEN d.primary_client_id LIKE 'O-%' THEN '/organisations/' || d.primary_client_id || '?tab=documents' ELSE NULL END,
            (
              SELECT
                CASE
                  WHEN dl.entity_type = 'matter' THEN '/matters/' || dl.entity_id || '?tab=documents'
                  WHEN dl.entity_type = 'person' THEN '/people/' || dl.entity_id || '?tab=documents'
                  WHEN dl.entity_type = 'organisation' THEN '/organisations/' || dl.entity_id || '?tab=documents'
                  WHEN dl.entity_type = 'enquiry' THEN '/enquiries/' || dl.entity_id
                  WHEN dl.entity_type = 'quote' THEN '/quotes/' || dl.entity_id
                  ELSE '/'
                END
              FROM public.document_links dl
              WHERE dl.tenant_id = d.tenant_id
                AND dl.document_id = d.id
              ORDER BY dl.created_at ASC, dl.id ASC
              LIMIT 1
            ),
            '/'
          ) AS href,
          NULLIF(d.document_type, '') AS secondary_label,
          ${buildHybridRankSql(
            ENTITY_EXPR.document,
            `COALESCE(NULLIF(d.file_name, ''), d.id)`,
            `d.title`,
          )} AS rank
        FROM public.documents d
        WHERE d.tenant_id = $1
          AND ${buildDocumentAccessibleSql('d')}
          AND ${buildHybridMatchSql(ENTITY_EXPR.document)}
      ),
      key_date_hits AS (
        SELECT
          kd.id AS id,
          'key_date'::text AS entity_type,
          COALESCE(NULLIF(kd.title, ''), kd.id) AS title,
          COALESCE(
            NULLIF(
              CONCAT_WS(
                ' · ',
                'Due ' || TO_CHAR(kd.due_date, 'YYYY-MM-DD'),
                NULLIF(kd.category, ''),
                CASE WHEN kd.is_critical THEN 'Critical' ELSE NULL END
              ),
              ''
            ),
            'Key date'
          ) AS subtitle,
          NULLIF(kd.status, '') AS status_label,
          CASE
            WHEN kd.is_critical OR kd.status = 'overdue' THEN 'alert'
            WHEN kd.status IN ('completed', 'verified') THEN 'positive'
            ELSE 'warning'
          END AS badge_tone,
          CASE
            WHEN kd.matter_id IS NOT NULL THEN '/matters/' || kd.matter_id || '?tab=tasks'
            WHEN kd.enquiry_id IS NOT NULL THEN '/enquiries/' || kd.enquiry_id
            ELSE '/key-dates'
          END AS href,
          NULLIF(kd.key_date_type_id, '') AS secondary_label,
          ${buildHybridRankSql(
            ENTITY_EXPR.key_date,
            `kd.id`,
            `kd.title`,
          )} AS rank
        FROM public.key_dates kd
        WHERE kd.tenant_id = $1
          AND ${buildKeyDateAccessibleSql('kd')}
          AND ${buildHybridMatchSql(ENTITY_EXPR.key_date)}
      ),
      register_hits AS (
        SELECT
          r.id AS id,
          'register_record'::text AS entity_type,
          COALESCE(
            NULLIF(
              CONCAT_WS(' — ', NULLIF(r.reference, ''), NULLIF(r.title, '')),
              ''
            ),
            r.id
          ) AS title,
          COALESCE(
            NULLIF(
              CONCAT_WS(' · ', NULLIF(r.register_type_key, ''), NULLIF(r.matter_id, '')),
              ''
            ),
            'Register record'
          ) AS subtitle,
          NULLIF(r.status, '') AS status_label,
          CASE
            WHEN r.status IN ('breached', 'escalated', 'rejected', 'overdue') THEN 'alert'
            WHEN r.status IN ('discharged', 'approved', 'closed', 'accepted') THEN 'positive'
            ELSE 'neutral'
          END AS badge_tone,
          '/registers?record=' || r.id AS href,
          NULLIF(r.reference, '') AS secondary_label,
          ${buildHybridRankSql(
            ENTITY_EXPR.register_record,
            `COALESCE(NULLIF(r.reference, ''), r.id)`,
            `r.title`,
          )} AS rank
        FROM public.register_records r
        WHERE r.tenant_id = $1
          AND ${buildRegisterAccessibleSql('r')}
          AND ${buildHybridMatchSql(ENTITY_EXPR.register_record)}
      ),
      all_visible_hits AS (
        SELECT * FROM person_hits
        UNION ALL SELECT * FROM organisation_hits
        UNION ALL SELECT * FROM matter_hits
        UNION ALL SELECT * FROM enquiry_hits
        UNION ALL SELECT * FROM quote_hits
        UNION ALL SELECT * FROM task_hits
        UNION ALL SELECT * FROM document_hits
        UNION ALL SELECT * FROM key_date_hits
        UNION ALL SELECT * FROM register_hits
      )
      SELECT
        (
          SELECT json_agg(json_build_object('entity_type', c.entity_type, 'hit_count', c.hit_count))
          FROM (
            SELECT entity_type, COUNT(*)::bigint AS hit_count
            FROM all_visible_hits
            GROUP BY entity_type
          ) c
        ) AS counts_json,
        (
          SELECT COUNT(*)::bigint
          FROM all_visible_hits
          WHERE entity_type = ANY($15::text[])
        ) AS total_count,
        (
          SELECT COALESCE(
            json_agg(p_row ORDER BY p_row.rank DESC, p_row.title ASC, p_row.entity_type ASC, p_row.id ASC),
            '[]'::json
          )
          FROM (
            SELECT id, entity_type, title, subtitle, status_label, badge_tone, href, secondary_label, rank
            FROM all_visible_hits
            WHERE entity_type = ANY($15::text[])
            ORDER BY rank DESC, title ASC, entity_type ASC, id ASC
            LIMIT $16
            OFFSET $17
          ) p_row
        ) AS page_hits_json
    `;

    const params: unknown[] = [
      ctx.tenantId,                                     // $1
      input.actor.actorId,                              // $2
      Boolean(input.actor.hasRestrictedMatterAccess),   // $3
      trimmed,                                          // $4
      ilikePattern,                                     // $5
      prefixPattern,                                    // $6
      prefixTsQuery,                                    // $7
      Boolean(input.actor.canViewDocuments),            // $8
      Boolean(input.actor.canViewQuotes),               // $9
      Boolean(input.actor.canViewFinance),              // $10
      Boolean(input.actor.canViewKeyDates),             // $11
      [...input.actor.permittedDiaryTeamIds],           // $12
      Boolean(input.actor.canViewRegisters),            // $13
      Boolean(input.actor.canManageUndertakings),       // $14
      activeTypes,                                      // $15
      limit,                                            // $16
      offset,                                           // $17
      Boolean(input.actor.canViewCdd),                  // $18
      Boolean(
        input.actor.canViewRisk ||
          input.actor.hasRestrictedMatterAccess,
      ),                                                // $19
    ];

    return this.withTenantReadTransaction(ctx, async (tx) => {
      await tx.query(
        `SELECT
           set_config('pg_trgm.similarity_threshold', '0.25', true),
           set_config('pg_trgm.word_similarity_threshold', '0.32', true)`,
      );

      const res = await tx.query<{
        counts_json: DbSearchCountRow[] | null;
        total_count: string | number;
        page_hits_json: DbSearchHitRow[];
      }>(searchSql, params);

      const row = res.rows[0];
      const countsByType = createZeroGlobalSearchCounts();
      for (const item of row?.counts_json ?? []) {
        if (VALID_ENTITY_TYPE_SET.has(item.entity_type)) {
          countsByType[item.entity_type] = Number(item.hit_count) || 0;
        }
      }

      const totalCount = Number(row?.total_count ?? 0) || 0;
      const rawHits = Array.isArray(row?.page_hits_json) ? row.page_hits_json : [];
      const hits: GlobalSearchHit[] = rawHits.map((h) => ({
        id: h.id,
        entityType: h.entity_type,
        title: h.title,
        subtitle: h.subtitle,
        statusLabel: h.status_label,
        badgeTone: h.badge_tone,
        href: h.href,
        secondaryLabel: h.secondary_label,
        rank: Number(h.rank) || 0,
      }));

      return {
        query: input.query,
        normalizedQuery: trimmed,
        hits,
        totalCount,
        countsByType,
        limit,
        offset,
        hasMore: offset + hits.length < totalCount,
      };
    });
  }
}
