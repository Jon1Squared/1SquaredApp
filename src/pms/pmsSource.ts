/**
 * Tenant-Scoped Practice Management System (PMS) Adapter (`src/pms/pmsSource.ts`).
 *
 * Enforces Slice S0-18, Slice S0-20 & ADR 0028 (`R401`, `R402`, `R403`, `R319`, `R358`):
 * - Provides `TenantPmsSource` and `getTenantPmsSource(ctx: TenantContext)` backed by per-tenant PostgreSQL.
 * - Refuses to execute without a verified `TenantContext` (`assertValidPostgresTenantContext`).
 * - Reads exclusively from the tenant's PostgreSQL-backed `TenantPmsRepository` snapshot
 *   keyed by `(postgresDatabaseName, tenantId)`, failing closed with `PMS_AS_AT_UNAVAILABLE_LABEL`
 *   when `pms_extract_metadata.as_at_date` is missing or invalid (`R319`, `R358`).
 */
import {
  assertValidPostgresTenantContext,
  computeDerivedMatterWipBreakdown,
  TenantPmsRepository,
  type HydratedTenantPmsSnapshot,
  type TenantContext,
} from '@platform/core';
import { isValidPmsAsAtDate, PMS_AS_AT_UNAVAILABLE_LABEL } from '../domain/pms';
import type {
  PmsClient,
  PmsClientAccountEntry,
  PmsDisbursement,
  PmsExtractInfo,
  PmsFeeEarner,
  PmsFeeEstimate,
  PmsInvoiceBalance,
  PmsInvoiceDetail,
  PmsMatter,
  PmsMatterFinancials,
  PmsMatterFullBundle,
  PmsMatterWipBreakdown,
  PmsPayment,
  PmsSource,
  PmsTimeEntry,
  PmsTimeEntryFilters,
} from './types';

function createEmptyTenantPmsSnapshot(
  ctx: TenantContext,
): HydratedTenantPmsSnapshot {
  return {
    tenantId: ctx.tenantId,
    databaseName: ctx.postgresDatabaseName,
    extractInfo: {
      asAtDate: '',
      importedAt: '',
      sourceFile: PMS_AS_AT_UNAVAILABLE_LABEL,
    },
    pmsLinks: [],
    feeEarners: [],
    clients: [],
    matters: [],
    matterFinancials: [],
    feeEstimates: [],
    invoices: [],
    invoiceBalances: [],
    payments: [],
    timeEntries: [],
    disbursements: [],
    clientAccount: [],
    creditControlLog: [],
  };
}

export class TenantPmsSource implements PmsSource {
  private readonly ctx: TenantContext;
  private readonly snapshot: HydratedTenantPmsSnapshot;

  public constructor(
    ctx: TenantContext,
    snapshot?: HydratedTenantPmsSnapshot,
  ) {
    if (!ctx) {
      throw new Error(
        'TENANCY_ISOLATION_ERROR: getTenantPmsSource requires a verified TenantContext.',
      );
    }
    assertValidPostgresTenantContext(ctx);
    this.ctx = ctx;
    this.snapshot = snapshot ?? createEmptyTenantPmsSnapshot(ctx);
  }

  private getSnapshot(): HydratedTenantPmsSnapshot {
    const snap = this.snapshot;
    if (
      snap.tenantId !== this.ctx.tenantId ||
      snap.databaseName !== this.ctx.postgresDatabaseName
    ) {
      throw new Error(
        `TENANCY_ISOLATION_ERROR: PMS snapshot tenant "${snap.tenantId}" does not match context "${this.ctx.tenantId}".`,
      );
    }
    return snap;
  }

  public getExtractInfo(): PmsExtractInfo {
    const snap = this.getSnapshot();
    const rawAsAt = snap.extractInfo?.asAtDate
      ? String(snap.extractInfo.asAtDate).trim()
      : '';
    if (!isValidPmsAsAtDate(rawAsAt)) {
      return {
        asAtDate: '',
        importedAt: snap.extractInfo?.importedAt ?? '',
        sourceFile: PMS_AS_AT_UNAVAILABLE_LABEL,
      };
    }
    return {
      asAtDate: rawAsAt,
      importedAt: snap.extractInfo.importedAt,
      sourceFile:
        snap.extractInfo.sourceFile || '1Squared_PMS_Demo_Data.xlsx',
    };
  }

  public getMatterFinancials(matterCode: string): PmsMatterFinancials | null {
    const snap = this.getSnapshot();
    const found = snap.matterFinancials.find(
      (m) => m.matter_code === matterCode,
    );
    return found ? structuredClone(found) : null;
  }

  public getAllMatterFinancials(): PmsMatterFinancials[] {
    const snap = this.getSnapshot();
    return structuredClone(snap.matterFinancials);
  }

  public getTimeEntries(
    matterCode: string,
    filters?: PmsTimeEntryFilters,
  ): PmsTimeEntry[] {
    const snap = this.getSnapshot();
    return structuredClone(
      snap.timeEntries.filter((te) => {
        if (te.matter_code !== matterCode) return false;
        if (
          filters?.feeEarnerId &&
          filters.feeEarnerId !== 'all' &&
          te.fee_earner_id !== filters.feeEarnerId
        ) {
          return false;
        }
        if (
          filters?.billedStatus &&
          filters.billedStatus !== 'all' &&
          te.billed_status !== filters.billedStatus
        ) {
          return false;
        }
        if (filters?.dateFrom && te.date < filters.dateFrom) return false;
        if (filters?.dateTo && te.date > filters.dateTo) return false;
        return true;
      }),
    );
  }

  public listAllTimeEntries(): PmsTimeEntry[] {
    const snap = this.getSnapshot();
    return structuredClone(snap.timeEntries);
  }

  public getMatterWipBreakdown(matterCode: string): PmsMatterWipBreakdown {
    const snap = this.getSnapshot();
    return computeDerivedMatterWipBreakdown({
      matterCode,
      asAtDate: snap.extractInfo.asAtDate,
      feeEarners: snap.feeEarners,
      timeEntries: snap.timeEntries,
    });
  }

  public getFeeEstimates(matterCode: string): PmsFeeEstimate[] {
    const snap = this.getSnapshot();
    return structuredClone(
      snap.feeEstimates.filter((e) => e.matter_code === matterCode),
    );
  }

  public getInvoices(filter?: {
    matterCode?: string;
    clientCode?: string;
  }): PmsInvoiceDetail[] {
    const snap = this.getSnapshot();
    const filteredBalances = snap.invoiceBalances.filter((inv) => {
      if (filter?.matterCode && inv.matter_code !== filter.matterCode) {
        return false;
      }
      if (filter?.clientCode && inv.client_code !== filter.clientCode) {
        return false;
      }
      return true;
    });

    return structuredClone(
      filteredBalances.map((inv) => ({
        ...inv,
        payments: snap.payments.filter(
          (p) => p.invoice_number === inv.invoice_number,
        ),
        timeEntries: [...snap.timeEntries]
          .filter((t) => t.invoice_number === inv.invoice_number)
          .sort((a, b) => {
            const cmp = a.date.localeCompare(b.date);
            if (cmp !== 0) return cmp;
            return a.time_id.localeCompare(b.time_id);
          }),
        disbursements: [...snap.disbursements]
          .filter((d) => d.invoice_number === inv.invoice_number)
          .sort((a, b) => {
            const cmp = a.date.localeCompare(b.date);
            if (cmp !== 0) return cmp;
            return a.disbursement_id.localeCompare(b.disbursement_id);
          }),
        appliedCreditNotes: filteredBalances.filter(
          (other) => other.credit_note_for === inv.invoice_number,
        ),
      })),
    );
  }

  public getInvoiceBalance(invoiceNumber: string): PmsInvoiceBalance | null {
    const snap = this.getSnapshot();
    const found = snap.invoiceBalances.find(
      (i) => i.invoice_number === invoiceNumber,
    );
    return found ? structuredClone(found) : null;
  }

  public listAllInvoiceBalances(): PmsInvoiceBalance[] {
    const snap = this.getSnapshot();
    return structuredClone(snap.invoiceBalances);
  }

  public getAgedDebt(clientCode?: string): PmsInvoiceBalance[] {
    const snap = this.getSnapshot();
    return structuredClone(
      snap.invoiceBalances
        .filter(
          (i) =>
            i.invoice_type !== 'Credit note' &&
            (!clientCode || i.client_code === clientCode),
        )
        .sort((a, b) => a.invoice_number.localeCompare(b.invoice_number)),
    );
  }

  public getDisbursements(matterCode: string): PmsDisbursement[] {
    const snap = this.getSnapshot();
    return structuredClone(
      snap.disbursements.filter((d) => d.matter_code === matterCode),
    );
  }

  public getClientAccountLedger(matterCode: string): PmsClientAccountEntry[] {
    const snap = this.getSnapshot();
    return structuredClone(
      snap.clientAccount.filter((ca) => ca.matter_code === matterCode),
    );
  }

  public listAllPayments(): PmsPayment[] {
    const snap = this.getSnapshot();
    return structuredClone(snap.payments);
  }

  public getMatterFullBundle(matterCode: string): PmsMatterFullBundle | null {
    const summary = this.getMatterFinancials(matterCode);
    if (!summary) return null;
    return {
      extractInfo: this.getExtractInfo(),
      summary,
      estimates: this.getFeeEstimates(matterCode),
      timeEntries: this.getTimeEntries(matterCode),
      wipBreakdown: this.getMatterWipBreakdown(matterCode),
      invoices: this.getInvoices({ matterCode }),
      disbursements: this.getDisbursements(matterCode),
      clientAccount: this.getClientAccountLedger(matterCode),
    };
  }

  public listFeeEarners(): PmsFeeEarner[] {
    const snap = this.getSnapshot();
    return structuredClone(snap.feeEarners);
  }

  public listClients(): PmsClient[] {
    const snap = this.getSnapshot();
    return structuredClone(snap.clients);
  }

  public listMatters(): PmsMatter[] {
    const snap = this.getSnapshot();
    return structuredClone(snap.matters);
  }
}

export async function getTenantPmsSource(
  ctx: TenantContext,
): Promise<PmsSource> {
  if (!ctx) {
    throw new Error(
      'TENANCY_ISOLATION_ERROR: getTenantPmsSource requires a verified TenantContext.',
    );
  }
  assertValidPostgresTenantContext(ctx);
  const repo = new TenantPmsRepository();
  const snapshot = await repo.loadTenantPmsSnapshot(ctx);
  return new TenantPmsSource(ctx, snapshot);
}

export async function hydrateTenantPmsSource(
  ctx: TenantContext,
): Promise<PmsSource> {
  if (!ctx) {
    throw new Error(
      'TENANCY_ISOLATION_ERROR: hydrateTenantPmsSource requires a verified TenantContext.',
    );
  }
  return getTenantPmsSource(ctx);
}
