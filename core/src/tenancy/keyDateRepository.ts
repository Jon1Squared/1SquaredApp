/**
 * Tenant-Scoped Key Dates Repository (`core/src/tenancy/keyDateRepository.ts`).
 *
 * Rules enforced (Platform Architecture Standard §8 & §9):
 * 1. All reads and writes require a verified `TenantContext`.
 * 2. Data is isolated per tenant database (`ctx.postgresDatabaseName`) and verified by `tenantId`.
 * 3. Key dates are never deleted (updates increment `version`; edits to confirmed dates create a superseding record).
 * 4. Restricted (staff) matters: entries are returned ONLY if `matter.restrictedAccessUserIds.includes(viewerId)`.
 *    Otherwise they are omitted completely at the data layer with no placeholder.
 */

import type {
  KeyDate,
  KeyDateAuditAction,
  KeyDateCalendarSync,
  KeyDateId,
  KeyDateNotApplicable,
  KeyDateReminderState,
  KeyDateTypeId,
  PersonId,
  TeamDiaryQuery,
  TenantContext,
} from '../api/index';

export interface MatterRestrictionMetadata {
  matterId: string;
  isRestricted: boolean;
  restrictedAccessUserIds: readonly string[];
}

export interface KeyDateAuditEventRecord {
  id: string;
  action: KeyDateAuditAction;
  keyDateId?: KeyDateId;
  matterId?: string;
  enquiryId?: string;
  actorId: PersonId;
  occurredAt: string;
  reason?: string;
  before?: unknown;
  after?: unknown;
  correlationId: string;
}

interface StoredRow<T> {
  tenantId: string;
  record: T;
}

interface TenantKeyDateDatabase {
  keyDates: Map<KeyDateId, StoredRow<KeyDate>>;
  notApplicable: Map<string, StoredRow<KeyDateNotApplicable>>; // key: `${matterId}:${keyDateTypeId}`
  reminderStates: Map<KeyDateId, StoredRow<KeyDateReminderState>>;
  calendarSyncs: Map<KeyDateId, StoredRow<KeyDateCalendarSync>>;
  auditEvents: StoredRow<KeyDateAuditEventRecord>[];
  matterRestrictions: Map<string, StoredRow<MatterRestrictionMetadata>>;
}

function cloneKeyDate(kd: KeyDate): KeyDate {
  return {
    ...kd,
    responsiblePersonIds: [...kd.responsiblePersonIds],
    calculation: kd.calculation
      ? {
          ...kd.calculation,
          triggers: {
            ...kd.calculation.triggers,
            standstillPeriods: kd.calculation.triggers.standstillPeriods
              ? kd.calculation.triggers.standstillPeriods.map((s) => ({ ...s }))
              : undefined,
            custom: kd.calculation.triggers.custom
              ? { ...kd.calculation.triggers.custom }
              : undefined,
          },
          explanation: [...kd.calculation.explanation],
        }
      : undefined,
    verification: { ...kd.verification },
    outcome: kd.outcome ? { ...kd.outcome } : undefined,
  };
}

export class TenantKeyDateRepository {
  private readonly databases = new Map<string, TenantKeyDateDatabase>();

  private getDb(ctx: TenantContext): TenantKeyDateDatabase {
    if (!ctx?.tenantId || !ctx?.postgresDatabaseName) {
      throw new Error(
        'TENANCY_ISOLATION_ERROR: Key date repository operation requires a valid TenantContext.',
      );
    }
    let db = this.databases.get(ctx.postgresDatabaseName);
    if (!db) {
      db = {
        keyDates: new Map(),
        notApplicable: new Map(),
        reminderStates: new Map(),
        calendarSyncs: new Map(),
        auditEvents: [],
        matterRestrictions: new Map(),
      };
      this.databases.set(ctx.postgresDatabaseName, db);
    }
    return db;
  }

  private assertRowTenant(
    ctx: TenantContext,
    rowTenantId: string,
    entityLabel: string,
  ): void {
    if (rowTenantId !== ctx.tenantId) {
      throw new Error(
        `TENANCY_ISOLATION_ERROR: Cross-tenant access blocked for ${entityLabel} (row tenant "${rowTenantId}" vs context tenant "${ctx.tenantId}").`,
      );
    }
  }

  /**
   * Registers or updates restriction metadata for a matter in this tenant database
   * so the data layer can enforce restricted/staff matter omission without UI involvement.
   */
  public setMatterRestriction(
    ctx: TenantContext,
    metadata: MatterRestrictionMetadata,
  ): void {
    const db = this.getDb(ctx);
    const existing = db.matterRestrictions.get(metadata.matterId);
    if (existing) {
      this.assertRowTenant(ctx, existing.tenantId, 'MatterRestrictionMetadata');
    }
    db.matterRestrictions.set(metadata.matterId, {
      tenantId: ctx.tenantId,
      record: {
        matterId: metadata.matterId,
        isRestricted: metadata.isRestricted,
        restrictedAccessUserIds: [...metadata.restrictedAccessUserIds],
      },
    });
  }

  /**
   * Data-layer check for restricted (staff) matters:
   * Returns false if no restriction metadata row has been registered for the matter.
   * Returns true if the matter is NOT restricted, or if `viewerId` is explicitly in `matter.restrictedAccessUserIds`.
   */
  public isMatterVisibleToViewer(
    ctx: TenantContext,
    matterId: string | undefined,
    viewerId: string = ctx.actorId,
  ): boolean {
    if (!matterId) return true;
    const db = this.getDb(ctx);
    const row = db.matterRestrictions.get(matterId);
    if (!row) return false;
    this.assertRowTenant(ctx, row.tenantId, 'MatterRestrictionMetadata');
    if (!row.record.isRestricted) return true;
    return row.record.restrictedAccessUserIds.includes(viewerId);
  }

  public isMatterRestricted(
    ctx: TenantContext,
    matterId: string | undefined,
  ): boolean {
    if (!matterId) return false;
    const db = this.getDb(ctx);
    const row = db.matterRestrictions.get(matterId);
    if (!row) return false;
    this.assertRowTenant(ctx, row.tenantId, 'MatterRestrictionMetadata');
    return row.record.isRestricted;
  }

  // ============================================================================
  // Key Dates (Never deleted)
  // ============================================================================

  public putKeyDate(ctx: TenantContext, keyDate: KeyDate): KeyDate {
    const db = this.getDb(ctx);
    if (
      (keyDate.matterId && keyDate.enquiryId) ||
      (!keyDate.matterId && !keyDate.enquiryId)
    ) {
      throw new Error(
        'KEY_DATE_ENTITY_ERROR: Exactly one of matterId or enquiryId must be set on a KeyDate.',
      );
    }
    if (!keyDate.teamId) {
      throw new Error('KEY_DATE_VALIDATION_ERROR: teamId is required.');
    }
    if (
      !Array.isArray(keyDate.responsiblePersonIds) ||
      keyDate.responsiblePersonIds.length === 0
    ) {
      throw new Error(
        'KEY_DATE_VALIDATION_ERROR: responsiblePersonIds must contain at least one person.',
      );
    }

    const existing = db.keyDates.get(keyDate.id);
    if (existing) {
      this.assertRowTenant(ctx, existing.tenantId, 'KeyDate');
      if (
        (existing.record.matterId ?? undefined) !==
          (keyDate.matterId ?? undefined) ||
        (existing.record.enquiryId ?? undefined) !==
          (keyDate.enquiryId ?? undefined)
      ) {
        throw new Error(
          'KEY_DATE_ENTITY_IMMUTABLE: Cannot change matterId or enquiryId on an existing KeyDate.',
        );
      }
    }

    if (
      keyDate.matterId &&
      !this.isMatterVisibleToViewer(ctx, keyDate.matterId, ctx.actorId)
    ) {
      throw new Error(
        `KEY_DATE_ACCESS_DENIED: Viewer "${ctx.actorId}" is not permitted to write key dates for matter "${keyDate.matterId}".`,
      );
    }

    const copy = cloneKeyDate(keyDate);
    db.keyDates.set(copy.id, {
      tenantId: ctx.tenantId,
      record: copy,
    });
    return cloneKeyDate(copy);
  }

  public getKeyDateById(
    ctx: TenantContext,
    id: KeyDateId,
    viewerId: string = ctx.actorId,
  ): KeyDate | null {
    const db = this.getDb(ctx);
    const row = db.keyDates.get(id);
    if (!row) return null;
    if (row.tenantId !== ctx.tenantId) {
      return null;
    }
    if (!this.isMatterVisibleToViewer(ctx, row.record.matterId, viewerId)) {
      return null;
    }
    return cloneKeyDate(row.record);
  }

  public listKeyDatesForMatter(
    ctx: TenantContext,
    matterId: string,
    viewerId: string = ctx.actorId,
  ): KeyDate[] {
    if (!this.isMatterVisibleToViewer(ctx, matterId, viewerId)) {
      return [];
    }
    const db = this.getDb(ctx);
    const results: KeyDate[] = [];
    for (const row of db.keyDates.values()) {
      if (row.tenantId === ctx.tenantId && row.record.matterId === matterId) {
        results.push(cloneKeyDate(row.record));
      }
    }
    return results.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }

  public listKeyDatesForEnquiry(
    ctx: TenantContext,
    enquiryId: string,
  ): KeyDate[] {
    const db = this.getDb(ctx);
    const results: KeyDate[] = [];
    for (const row of db.keyDates.values()) {
      if (row.tenantId === ctx.tenantId && row.record.enquiryId === enquiryId) {
        results.push(cloneKeyDate(row.record));
      }
    }
    return results.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }

  public listAllVisibleKeyDates(
    ctx: TenantContext,
    viewerId: string = ctx.actorId,
  ): KeyDate[] {
    const db = this.getDb(ctx);
    const results: KeyDate[] = [];
    for (const row of db.keyDates.values()) {
      if (
        row.tenantId === ctx.tenantId &&
        this.isMatterVisibleToViewer(ctx, row.record.matterId, viewerId)
      ) {
        results.push(cloneKeyDate(row.record));
      }
    }
    return results.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }

  public queryKeyDatesForDiary(
    ctx: TenantContext,
    query: TeamDiaryQuery,
    viewerId: string = ctx.actorId,
  ): KeyDate[] {
    const db = this.getDb(ctx);
    const teamSet = new Set(query.teamIds);
    const categorySet = query.categories?.length
      ? new Set(query.categories)
      : null;
    const statusSet = query.statuses?.length ? new Set(query.statuses) : null;

    const results: KeyDate[] = [];
    for (const row of db.keyDates.values()) {
      if (row.tenantId !== ctx.tenantId) continue;
      const kd = row.record;
      // Enforce restricted (staff) matter omission at the data layer
      if (!this.isMatterVisibleToViewer(ctx, kd.matterId, viewerId)) {
        continue;
      }
      if (teamSet.size > 0 && !teamSet.has(kd.teamId)) continue;
      if ((query.from && kd.dueDate < query.from) || (query.to && kd.dueDate > query.to)) continue;
      if (categorySet && !categorySet.has(kd.category)) continue;
      if (statusSet && !statusSet.has(kd.status)) continue;
      if (query.criticalOnly && !kd.isCritical) continue;
      if (
        query.awaitingVerificationOnly &&
        kd.status !== 'awaiting_verification'
      ) {
        continue;
      }
      results.push(cloneKeyDate(kd));
    }
    return results.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }

  // ============================================================================
  // Not Applicable Records
  // ============================================================================

  public putNotApplicable(
    ctx: TenantContext,
    record: KeyDateNotApplicable,
  ): KeyDateNotApplicable {
    const db = this.getDb(ctx);
    if (!this.isMatterVisibleToViewer(ctx, record.matterId, ctx.actorId)) {
      throw new Error(
        `KEY_DATE_ACCESS_DENIED: Viewer "${ctx.actorId}" is not permitted to write not-applicable records for matter "${record.matterId}".`,
      );
    }
    const compositeKey = `${record.matterId}:${record.keyDateTypeId}`;
    const existing = db.notApplicable.get(compositeKey);
    if (existing) {
      this.assertRowTenant(ctx, existing.tenantId, 'KeyDateNotApplicable');
    }
    const copy: KeyDateNotApplicable = { ...record };
    db.notApplicable.set(compositeKey, {
      tenantId: ctx.tenantId,
      record: copy,
    });
    return { ...copy };
  }

  public removeNotApplicable(
    ctx: TenantContext,
    matterId: string,
    keyDateTypeId: KeyDateTypeId,
  ): boolean {
    const db = this.getDb(ctx);
    if (!this.isMatterVisibleToViewer(ctx, matterId, ctx.actorId)) {
      throw new Error(
        `KEY_DATE_ACCESS_DENIED: Viewer "${ctx.actorId}" is not permitted to remove not-applicable records for matter "${matterId}".`,
      );
    }
    const compositeKey = `${matterId}:${keyDateTypeId}`;
    const existing = db.notApplicable.get(compositeKey);
    if (!existing || existing.tenantId !== ctx.tenantId) {
      return false;
    }
    return db.notApplicable.delete(compositeKey);
  }

  public listNotApplicableForMatter(
    ctx: TenantContext,
    matterId: string,
    viewerId: string = ctx.actorId,
  ): KeyDateNotApplicable[] {
    if (!this.isMatterVisibleToViewer(ctx, matterId, viewerId)) {
      return [];
    }
    const db = this.getDb(ctx);
    const results: KeyDateNotApplicable[] = [];
    for (const row of db.notApplicable.values()) {
      if (row.tenantId === ctx.tenantId && row.record.matterId === matterId) {
        results.push({ ...row.record });
      }
    }
    return results;
  }

  // ============================================================================
  // Reminder States (1 per confirmed key date)
  // ============================================================================

  public putReminderState(
    ctx: TenantContext,
    state: KeyDateReminderState,
  ): KeyDateReminderState {
    const db = this.getDb(ctx);
    const kdRow = db.keyDates.get(state.keyDateId);
    if (!kdRow || kdRow.tenantId !== ctx.tenantId) {
      throw new Error(
        `KEY_DATE_NOT_FOUND: KeyDate "${state.keyDateId}" was not found in tenant "${ctx.tenantId}".`,
      );
    }
    this.assertRowTenant(ctx, kdRow.tenantId, 'KeyDate');
    if (
      kdRow.record.matterId &&
      !this.isMatterVisibleToViewer(ctx, kdRow.record.matterId, ctx.actorId)
    ) {
      throw new Error(
        `KEY_DATE_ACCESS_DENIED: Viewer "${ctx.actorId}" is not permitted to write reminder state for matter "${kdRow.record.matterId}".`,
      );
    }
    const existing = db.reminderStates.get(state.keyDateId);
    if (existing) {
      this.assertRowTenant(ctx, existing.tenantId, 'KeyDateReminderState');
    }
    if (
      state.lastSkippedReason !== undefined &&
      state.lastSkippedReason !== 'no_permitted_assignees' &&
      state.lastSkippedReason !== 'missing_matter'
    ) {
      throw new Error(
        `KEY_DATE_VALIDATION_ERROR: Invalid lastSkippedReason "${String(state.lastSkippedReason)}"; expected 'no_permitted_assignees' or 'missing_matter'.`,
      );
    }
    const copy: KeyDateReminderState = {
      keyDateId: state.keyDateId,
      taskId: state.taskId,
      idempotencyKey: state.idempotencyKey,
      reminderScheduleId: state.reminderScheduleId,
      currentStageDaysBefore: state.currentStageDaysBefore,
      stageEnteredAt: state.stageEnteredAt,
      ...(state.acknowledgedById !== undefined
        ? { acknowledgedById: state.acknowledgedById }
        : {}),
      ...(state.acknowledgedAt !== undefined
        ? { acknowledgedAt: state.acknowledgedAt }
        : {}),
      escalationLevel: state.escalationLevel,
      ...(state.lastNotifiedAt !== undefined
        ? { lastNotifiedAt: state.lastNotifiedAt }
        : {}),
      ...(state.lastSkippedReason !== undefined
        ? { lastSkippedReason: state.lastSkippedReason }
        : {}),
    };
    db.reminderStates.set(copy.keyDateId, {
      tenantId: ctx.tenantId,
      record: copy,
    });
    return { ...copy };
  }

  public getReminderState(
    ctx: TenantContext,
    keyDateId: KeyDateId,
    viewerId: string = ctx.actorId,
  ): KeyDateReminderState | null {
    const kd = this.getKeyDateById(ctx, keyDateId, viewerId);
    if (!kd) return null;
    const db = this.getDb(ctx);
    const row = db.reminderStates.get(keyDateId);
    if (!row || row.tenantId !== ctx.tenantId) return null;
    return { ...row.record };
  }

  public listReminderStates(
    ctx: TenantContext,
    viewerId: string = ctx.actorId,
  ): KeyDateReminderState[] {
    const db = this.getDb(ctx);
    const results: KeyDateReminderState[] = [];
    for (const row of db.reminderStates.values()) {
      if (row.tenantId !== ctx.tenantId) continue;
      const kd = this.getKeyDateById(ctx, row.record.keyDateId, viewerId);
      if (!kd) continue;
      results.push({ ...row.record });
    }
    return results;
  }

  // ============================================================================
  // Calendar Sync State
  // ============================================================================

  public putCalendarSync(
    ctx: TenantContext,
    sync: KeyDateCalendarSync,
  ): KeyDateCalendarSync {
    const db = this.getDb(ctx);
    const kdRow = db.keyDates.get(sync.keyDateId);
    if (!kdRow || kdRow.tenantId !== ctx.tenantId) {
      throw new Error(
        `KEY_DATE_NOT_FOUND: KeyDate "${sync.keyDateId}" was not found in tenant "${ctx.tenantId}".`,
      );
    }
    this.assertRowTenant(ctx, kdRow.tenantId, 'KeyDate');
    if (
      kdRow.record.matterId &&
      !this.isMatterVisibleToViewer(ctx, kdRow.record.matterId, ctx.actorId)
    ) {
      throw new Error(
        `KEY_DATE_ACCESS_DENIED: Viewer "${ctx.actorId}" is not permitted to write calendar sync state for matter "${kdRow.record.matterId}".`,
      );
    }
    const existing = db.calendarSyncs.get(sync.keyDateId);
    if (existing) {
      this.assertRowTenant(ctx, existing.tenantId, 'KeyDateCalendarSync');
    }
    const copy: KeyDateCalendarSync = {
      ...sync,
      externalEvents: sync.externalEvents.map((e) => ({ ...e })),
    };
    db.calendarSyncs.set(copy.keyDateId, {
      tenantId: ctx.tenantId,
      record: copy,
    });
    return {
      ...copy,
      externalEvents: copy.externalEvents.map((e) => ({ ...e })),
    };
  }

  public getCalendarSync(
    ctx: TenantContext,
    keyDateId: KeyDateId,
    viewerId: string = ctx.actorId,
  ): KeyDateCalendarSync | null {
    const kd = this.getKeyDateById(ctx, keyDateId, viewerId);
    if (!kd) return null;
    const db = this.getDb(ctx);
    const row = db.calendarSyncs.get(keyDateId);
    if (!row || row.tenantId !== ctx.tenantId) return null;
    return {
      ...row.record,
      externalEvents: row.record.externalEvents.map((e) => ({ ...e })),
    };
  }

  // ============================================================================
  // Immutable Audit Events
  // ============================================================================

  public appendAuditEvent(
    ctx: TenantContext,
    event: KeyDateAuditEventRecord,
  ): KeyDateAuditEventRecord {
    const db = this.getDb(ctx);
    const copy: KeyDateAuditEventRecord = Object.freeze({ ...event });
    db.auditEvents.push({
      tenantId: ctx.tenantId,
      record: copy,
    });
    return copy;
  }

  public listAuditEvents(
    ctx: TenantContext,
    filter?: { keyDateId?: KeyDateId; matterId?: string; enquiryId?: string },
    viewerId: string = ctx.actorId,
  ): KeyDateAuditEventRecord[] {
    const db = this.getDb(ctx);
    return db.auditEvents
      .filter((row) => {
        if (row.tenantId !== ctx.tenantId) return false;
        const ev = row.record;
        if (
          ev.matterId &&
          !this.isMatterVisibleToViewer(ctx, ev.matterId, viewerId)
        ) {
          return false;
        }
        if (filter?.keyDateId && ev.keyDateId !== filter.keyDateId) return false;
        if (filter?.matterId && ev.matterId !== filter.matterId) return false;
        if (filter?.enquiryId && ev.enquiryId !== filter.enquiryId) return false;
        return true;
      })
      .map((row) => ({ ...row.record }));
  }
}
