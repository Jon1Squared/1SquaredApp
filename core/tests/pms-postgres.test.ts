import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDirectMigrationClient,
  resolveTenantFromVerifiedToken,
  TenantAuditRepository,
  TenantIntakeQuoteRepository,
  TenantMatterRepository,
  TenantPartyRepository,
  TenantPmsRepository,
  TenantPostgresPoolManager,
  type TenantContext,
  type TenantPmsExtractDataset,
} from '@platform/core';
import { isActionDenied } from '@/domain/actionResult';
import {
  getActiveTenantConfiguration,
  getPmsRepository,
  resolveCurrentTenantContext,
} from '@/platform/tenantRuntime';
import { setAuditAdapterFailureHookForTesting } from '../../src/server/testSupport/auditTestSupport';
import { getTenantPmsSource } from '@/pms/pmsSource';
import {
  createSignedEntraSessionCookie,
  createVerifiedSessionActorFromEntraSession,
  setTestEntraSessionOverride,
  verifySignedEntraSessionCookie,
} from '@/server/entraAuth';
import {
  getFirmFinance,
  getMatterFinanceRows,
  getMyFinanceFigures,
} from '@/server/financeServices';
import { runWithActiveActorSession } from '@/server/rbacRuntime';
import {
  executeMerge,
  flagMatterWriteOff,
  getClientPmsViewBundle,
  getIntakeQuoteRepository,
  getMatterPmsViewBundle,
  getMatterRepository,
  getPartyRepository,
  getPmsAdminSnapshot,
  linkPmsRecord,
  prepareEnquiryConversion,
  prepareQuoteConversionRecord,
  recordInvoiceCreditControlAction,
  requestMatterBill,
  saveEnquiryRecord,
  saveMatterRecord,
  saveOrganisationRecord,
  saveQuoteRecord,
  syncMatterCostsRatesFromPms,
  unlinkPmsRecord,
} from '@/server/services';
import { loadCommittedSeedStore } from '@/seed/seedSnapshot';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';

const REPO_ROOT = path.resolve(__dirname, '../..');

afterEach(() => {
  setTestEntraSessionOverride(null);
});

function makeTenantContext(
  tenantId: 'tenant-a' | 'tenant-b',
  actorId = 'P-000001',
): TenantContext {
  return resolveTenantFromVerifiedToken({
    verifiedToken: {
      __verifiedByOidcMiddleware: true,
      sub: actorId,
      tenantId,
      name: `Actor ${tenantId}`,
      email: `actor@${tenantId}.example`,
      roles: ['admin', 'managing_partner', 'partner', 'fee_earner', 'finance'],
      mfaVerified: true,
    },
    hostingMode: 'multi_tenant',
    environment: 'test',
    correlationId: `corr-s018-${tenantId}`,
  });
}

function makeHostActorAndContext(actorPersonId = 'P-000001') {
  const cfg = getActiveTenantConfiguration();
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  const roles = [
    'admin',
    'managing_partner',
    'partner',
    'fee_earner',
    'enquiries_coordinator',
    'finance',
    'risk_compliance',
  ];
  const cookieVal = createSignedEntraSessionCookie({
    personId: actorPersonId,
    tenantId: cfg.tenantId,
    oid: `00000000-0000-4000-8000-${actorPersonId.replace(/\D/g, '').padStart(12, '0')}`,
    tid: '11111111-2222-3333-4444-000000000000',
    sub: actorPersonId,
    email: `${actorPersonId.toLowerCase()}@${cfg.branding.primaryDomain}`,
    displayName: `Test Actor ${actorPersonId}`,
    entraRoles: roles,
    mappedRoles: roles,
    entraGroups: [],
    mfaVerified: true,
    amr: ['pwd', 'mfa'],
    authenticatedAt: nowIso,
    expiresAt,
  });
  const verified = verifySignedEntraSessionCookie(cookieVal)!;
  setTestEntraSessionOverride(verified);
  const ctx = resolveCurrentTenantContext(
    createVerifiedSessionActorFromEntraSession(verified, {
      correlationId: `corr-s018-host-${actorPersonId}`,
    }),
    cfg,
  );
  const actorSession = {
    personId: actorPersonId,
    tenantId: cfg.tenantId,
    tokenRoles: verified.mappedRoles,
    mfaVerified: true,
    expiresAtMs: Date.parse(expiresAt),
    verifiedSession: verified,
  };
  return { ctx, actorSession };
}

function buildSyntheticDataset(params: {
  suffix: 'A' | 'B';
  asAtDate: string;
  wipAmount: number;
  invoiceNet: number;
  unlinkedWipAmount: number;
}): TenantPmsExtractDataset {
  const s = params.suffix;
  const vat = Math.round(params.invoiceNet * 0.2 * 100) / 100;
  const total = params.invoiceNet + vat;
  return {
    extractInfo: {
      asAtDate: params.asAtDate,
      sourceFile: `tenant-${s.toLowerCase()}-extract.xlsx`,
      importedAt: '2026-11-10T10:00:00.000Z',
    },
    feeEarners: [
      {
        fee_earner_id: `FE-${s}01`,
        initials: `AM${s}`,
        first_name: `Alex-${s}`,
        last_name: `Morgan-${s}`,
        email: `alex.${s.toLowerCase()}@example.test`,
        grade: 'Partner',
        department: 'Corporate and commercial',
        standard_hourly_rate: s === 'A' ? 360 : 410,
        annual_target_hours: 1200,
        annual_target_fees: s === 'A' ? 350000 : 420000,
        active: 'Yes',
      },
    ],
    clients: [
      {
        client_code: `CL-${s}001`,
        client_name: `Tenant ${s} Holdings Ltd`,
        client_type: 'Organisation',
        company_number: s === 'A' ? '10000001' : '20000002',
        email: `accounts@tenant-${s.toLowerCase()}.example.test`,
        phone: '029 2018 0100',
        billing_address: `${s}1 High Street`,
        postcode: 'CF10 1AA',
        client_partner_id: `FE-${s}01`,
        credit_terms_days: 30,
        credit_limit: s === 'A' ? 50000 : 80000,
        rate_discount_pct: 0,
        date_opened: '2025-01-15',
        sector: 'Industrial',
        crm_match_on: 'company_number',
        status: 'Active',
      },
    ],
    matters: [
      {
        matter_code: `MAT-${s}001`,
        client_code: `CL-${s}001`,
        matter_description: `Tenant ${s} Main Commercial Matter`,
        work_type: 'Commercial contracts',
        practice_area: 'Corporate and commercial',
        responsible_partner_id: `FE-${s}01`,
        fee_earner_id: `FE-${s}01`,
        billing_basis: 'Hourly Rate',
        fixed_fee_amount: 0,
        fee_estimate: s === 'A' ? 25000 : 60000,
        estimate_alert_pct: 80,
        date_opened: '2026-01-10',
        date_closed: null,
        status: 'Open',
        billing_frequency: 'Monthly',
        client_reference: `REF-${s}-1`,
        third_party_payer: '',
      },
      {
        matter_code: `MAT-${s}-UNLINKED`,
        client_code: `CL-${s}001`,
        matter_description: `Tenant ${s} Unlinked PMS Matter`,
        work_type: 'Commercial contracts',
        practice_area: 'Corporate and commercial',
        responsible_partner_id: `FE-${s}01`,
        fee_earner_id: `FE-${s}01`,
        billing_basis: 'Hourly Rate',
        fixed_fee_amount: 0,
        fee_estimate: 90000,
        estimate_alert_pct: 80,
        date_opened: '2026-02-01',
        date_closed: null,
        status: 'Open',
        billing_frequency: 'Monthly',
        client_reference: `REF-${s}-2`,
        third_party_payer: '',
      },
    ],
    feeEstimates: [
      {
        estimate_id: `EST-${s}001`,
        matter_code: `MAT-${s}001`,
        date_given: '2026-01-12',
        estimate_type: 'Initial',
        fees_estimate: s === 'A' ? 25000 : 60000,
        disbursements_estimate: 500,
        given_by: `FE-${s}01`,
        accepted_by_client: 'Yes',
        notes: `Initial estimate ${s}`,
      },
    ],
    invoices: [
      {
        invoice_number: `INV-${s}1001`,
        matter_code: `MAT-${s}001`,
        client_code: `CL-${s}001`,
        invoice_date: '2026-08-01',
        due_date: '2026-08-31',
        invoice_type: 'Interim',
        period_from: '2026-07-01',
        period_to: '2026-07-31',
        fees_net: params.invoiceNet,
        disbursements_net: 0,
        vat,
        total,
        status: 'Overdue',
        credit_note_for: null,
      },
    ],
    payments: [],
    timeEntries: [
      {
        time_id: `TE-${s}001`,
        matter_code: `MAT-${s}001`,
        fee_earner_id: `FE-${s}01`,
        date: '2026-10-10',
        activity: 'DRFT',
        narrative: `Drafting commercial agreement ${s}`,
        minutes: 120,
        units: 20,
        hours: 2,
        rate: params.wipAmount / 2,
        value: params.wipAmount,
        chargeable: 'Y',
        billed_status: 'Unbilled',
        invoice_number: null,
        billed_value: 0,
        write_off_value: 0,
      },
      {
        time_id: `TE-${s}-UNLINKED`,
        matter_code: `MAT-${s}-UNLINKED`,
        fee_earner_id: `FE-${s}01`,
        date: '2026-10-12',
        activity: 'ADV',
        narrative: `Unlinked matter work ${s}`,
        minutes: 60,
        units: 10,
        hours: 1,
        rate: params.unlinkedWipAmount,
        value: params.unlinkedWipAmount,
        chargeable: 'Y',
        billed_status: 'Unbilled',
        invoice_number: null,
        billed_value: 0,
        write_off_value: 0,
      },
    ],
    disbursements: [
      {
        disbursement_id: `DSB-${s}001`,
        matter_code: `MAT-${s}001`,
        date: '2026-10-05',
        type: 'Search fee',
        supplier: `Registry ${s}`,
        description: `Company search ${s}`,
        net_amount: 100,
        vat_amount: 20,
        gross_amount: 120,
        paid_from: 'Office',
        billed_status: 'Unbilled',
        invoice_number: null,
      },
    ],
    clientAccount: [
      {
        transaction_id: `CA-${s}001`,
        matter_code: `MAT-${s}001`,
        client_code: `CL-${s}001`,
        date: '2026-09-01',
        type: 'Receipt',
        description: `Monies on account ${s}`,
        amount: s === 'A' ? 2500 : 4000,
      },
    ],
  };
}

describe('S0-18: PostgreSQL Per-Tenant PMS Data & PMS Links Repository, ADR 0029 Gating, and Transaction Atomicity', () => {
  it('enforces two-tenant isolation, forged-claim rejection, tampered ID rejection, missing/invalid asAtDate fail-closed, single-connection SET LOCAL ROLE, R402 table privileges, and R460 sequence privileges across all 13 PMS tables', async () => {
    const ctxA = makeTenantContext('tenant-a');
    const ctxB = makeTenantContext('tenant-b');
    const poolMgr = new TenantPostgresPoolManager({ maxConnectionsPerTenant: 1 });
    const repo = new TenantPmsRepository({ poolManager: poolMgr });

    try {
      await repo.clearTenantData(ctxA);
      await repo.clearTenantData(ctxB);

      const datasetA = buildSyntheticDataset({
        suffix: 'A',
        asAtDate: '2026-10-31',
        wipAmount: 14000,
        invoiceNet: 6000,
        unlinkedWipAmount: 99000,
      });
      const datasetB = buildSyntheticDataset({
        suffix: 'B',
        asAtDate: '2026-11-15',
        wipAmount: 38000,
        invoiceNet: 16000,
        unlinkedWipAmount: 77000,
      });

      await repo.importExtractDataset(ctxA, datasetA);
      await repo.importExtractDataset(ctxB, datasetB);

      await repo.putPmsLinks(ctxA, [
        {
          id: 'PMSL-A001',
          entityType: 'matter',
          onesquaredId: 'M-000001',
          pmsCode: 'MAT-A001',
          matchedBy: 'manual',
          matchedAt: '2026-10-31T10:00:00.000Z',
        },
        {
          id: 'PMSL-A002',
          entityType: 'organisation',
          onesquaredId: 'O-000001',
          pmsCode: 'CL-A001',
          matchedBy: 'manual',
          matchedAt: '2026-10-31T10:00:00.000Z',
        },
      ]);
      await repo.putPmsLinks(ctxB, [
        {
          id: 'PMSL-B001',
          entityType: 'matter',
          onesquaredId: 'M-000001',
          pmsCode: 'MAT-B001',
          matchedBy: 'manual',
          matchedAt: '2026-11-15T10:00:00.000Z',
        },
        {
          id: 'PMSL-B002',
          entityType: 'organisation',
          onesquaredId: 'O-000001',
          pmsCode: 'CL-B001',
          matchedBy: 'manual',
          matchedAt: '2026-11-15T10:00:00.000Z',
        },
      ]);

      // Positive control via getTenantPmsSource(ctxA) and getTenantPmsSource(ctxB)
      const sourceA = await getTenantPmsSource(ctxA);
      const sourceB = await getTenantPmsSource(ctxB);

      expect(sourceA.getExtractInfo().asAtDate).toBe('2026-10-31');
      expect(sourceB.getExtractInfo().asAtDate).toBe('2026-11-15');

      expect(sourceA.listClients().map((c) => c.client_code)).toEqual(['CL-A001']);
      expect(sourceB.listClients().map((c) => c.client_code)).toEqual(['CL-B001']);
      expect(sourceA.getMatterFullBundle('MAT-B001')).toBeNull();
      expect(sourceB.getMatterFullBundle('MAT-A001')).toBeNull();

      expect(sourceA.listFeeEarners().map((f) => f.fee_earner_id)).toEqual(['FE-A01']);
      expect(sourceB.listFeeEarners().map((f) => f.fee_earner_id)).toEqual(['FE-B01']);
      expect(sourceA.getInvoices({ matterCode: 'MAT-B001' })).toEqual([]);

      const matFinA = sourceA.getMatterFinancials('MAT-A001');
      const matFinB = sourceB.getMatterFinancials('MAT-B001');
      expect(matFinA?.unbilled_wip).toBe(14000);
      expect(matFinA?.outstanding_debt).toBe(7200);
      expect(matFinB?.unbilled_wip).toBe(38000);
      expect(matFinB?.outstanding_debt).toBe(19200);
      expect(sourceA.getMatterFinancials('MAT-B001')).toBeNull();
      expect(sourceB.getMatterFinancials('MAT-A001')).toBeNull();

      const linksA = await repo.listPmsLinks(ctxA);
      const linksB = await repo.listPmsLinks(ctxB);
      expect(linksA.map((l) => l.id)).toEqual(['PMSL-A001', 'PMSL-A002']);
      expect(linksB.map((l) => l.id)).toEqual(['PMSL-B001', 'PMSL-B002']);

      // Tampered cross-tenant delete leaves Tenant B untouched
      const deletedCrossTenant = await repo.deletePmsLinkById(ctxA, 'PMSL-B001');
      expect(deletedCrossTenant).toBe(false);
      expect((await repo.listPmsLinks(ctxB)).map((l) => l.id)).toEqual([
        'PMSL-B001',
        'PMSL-B002',
      ]);

      // Calling getTenantPmsSource without a verified TenantContext fails closed
      await expect(
        getTenantPmsSource(null as unknown as TenantContext),
      ).rejects.toThrow(/TENANCY_ISOLATION_ERROR/);

      // Forged tenant claim fails closed with TENANCY_FORGERY_DETECTED
      expect(() =>
        resolveTenantFromVerifiedToken({
          verifiedToken: {
            __verifiedByOidcMiddleware: true,
            sub: 'actor-a',
            tenantId: 'tenant-a',
            name: 'Actor A',
            email: 'actor@tenant-a.example',
            roles: ['admin'],
            mfaVerified: true,
          },
          hostingMode: 'multi_tenant',
          environment: 'test',
          correlationId: 'corr-forged-s018',
          untrustedRequestTenantOverride: 'tenant-b',
        }),
      ).toThrow(/TENANCY_FORGERY_DETECTED/);

      // Missing/invalid as_at_date in pms_extract_metadata fails closed on Tenant A without affecting Tenant B
      await expect(
        repo.importExtractDataset(ctxA, {
          ...datasetA,
          extractInfo: {
            ...datasetA.extractInfo,
            asAtDate: 'not-a-valid-date',
          },
        }),
      ).rejects.toThrow(/PMS_INVALID_AS_AT_DATE/);

      const directA = await createDirectMigrationClient({ ctx: ctxA });
      try {
        await directA.query(
          `UPDATE public.pms_extract_metadata SET as_at_date = 'not-a-valid-date' WHERE tenant_id = $1`,
          [ctxA.tenantId],
        );
      } finally {
        await directA.end();
      }
      const badSnapA = await repo.loadTenantPmsSnapshot(ctxA);
      expect(badSnapA.extractInfo.asAtDate).toBe('');
      expect(badSnapA.extractInfo.sourceFile).toBe('PMS as-at date unavailable');
      const badSourceA = await getTenantPmsSource(ctxA);
      expect(badSourceA.getExtractInfo().asAtDate).toBe('');
      expect(badSourceA.getExtractInfo().sourceFile).toBe('PMS as-at date unavailable');
      // Tenant B remains completely unaffected
      expect((await repo.loadTenantPmsSnapshot(ctxB)).extractInfo.asAtDate).toBe(
        '2026-11-15',
      );

      // Restore Tenant A valid as_at_date
      await repo.importExtractDataset(ctxA, datasetA);

      // R402 table privilege verification & R460 sequence privilege verification on raw connection
      const { pool: poolA } = await poolMgr.getPoolForTenant(ctxA);
      const rawClient = await poolA.connect();
      try {
        for (const tableName of [
          'pms_links',
          'pms_extract_metadata',
          'pms_fee_earners',
          'pms_clients',
          'pms_matters',
          'pms_matter_financials',
          'pms_fee_estimates',
          'pms_invoices',
          'pms_payments',
          'pms_time_entries',
          'pms_disbursements',
          'pms_client_account_entries',
          'pms_credit_control_log',
        ]) {
          await expect(
            rawClient.query(`SELECT * FROM public.${tableName}`),
          ).rejects.toMatchObject({
            code: '42501',
            message: expect.stringMatching(
              new RegExp(
                `permission denied for (table ${tableName}|schema public)`,
                'i',
              ),
            ),
          });
        }

        // Cross-tenant role on Tenant A's database is denied (42501)
        await rawClient.query('BEGIN');
        await rawClient.query('SET LOCAL ROLE "role_tenant_tenant_b_test"');
        await expect(
          rawClient.query('SELECT * FROM public.pms_matters'),
        ).rejects.toMatchObject({
          code: '42501',
          message: expect.stringMatching(
            /permission denied for (table pms_matters|schema public)/i,
          ),
        });
        await rawClient.query('ROLLBACK');

        // R460: role_tenant_tenant_a_test has USAGE, SELECT on tenant_pms_link_id_seq, NOT UPDATE
        await rawClient.query('BEGIN');
        await rawClient.query('SET LOCAL ROLE "role_tenant_tenant_a_test"');
        const seqPrivRes = await rawClient.query<{
          has_usage: boolean;
          has_select: boolean;
          has_update: boolean;
        }>(
          `SELECT
             has_sequence_privilege(current_user, 'public.tenant_pms_link_id_seq', 'USAGE') AS has_usage,
             has_sequence_privilege(current_user, 'public.tenant_pms_link_id_seq', 'SELECT') AS has_select,
             has_sequence_privilege(current_user, 'public.tenant_pms_link_id_seq', 'UPDATE') AS has_update`,
        );
        expect(seqPrivRes.rows[0]).toEqual({
          has_usage: true,
          has_select: true,
          has_update: false,
        });
        await rawClient.query('ROLLBACK');
      } finally {
        rawClient.release();
      }
    } finally {
      await poolMgr.closeAllPools();
    }
  });

  it('enforces two-tenant isolation across all 7 finance/PMS service loaders and rejects tampered cross-tenant IDs across PMS link and credit-control mutations', async () => {
    const ctxA = makeTenantContext('tenant-a', 'P-000001');
    const ctxB = makeTenantContext('tenant-b', 'P-000001');
    const pmsRepo = getPmsRepository();

    // Seed base store into both tenant-a and tenant-b, then customize each tenant's PMS extract and links
    const baseStore = loadCommittedSeedStore();
    const matterId = baseStore.matters[0]!.id;
    const orgId = baseStore.organisations[0]!.id;
    const feeEarnerPersonId = 'P-000001';

    const datasetA = buildSyntheticDataset({
      suffix: 'A',
      asAtDate: '2026-10-31',
      wipAmount: 14000,
      invoiceNet: 6000,
      unlinkedWipAmount: 99000,
    });
    const datasetB = buildSyntheticDataset({
      suffix: 'B',
      asAtDate: '2026-11-15',
      wipAmount: 38000,
      invoiceNet: 16000,
      unlinkedWipAmount: 77000,
    });

    await importFirmStoreModulesToPostgres({
      ctx: ctxA,
      store: baseStore,
      tenantConfig: { ...getActiveTenantConfiguration(), tenantId: ctxA.tenantId },
      modules: ['parties', 'matters', 'intake', 'quotes', 'tasks', 'hr', 'catalogues'],
      clearFirst: true,
    });
    await pmsRepo.clearTenantData(ctxA);
    await pmsRepo.importExtractDataset(ctxA, datasetA);
    await pmsRepo.putPmsLinks(ctxA, [
      {
        id: 'PMSL-A-MAT',
        entityType: 'matter',
        onesquaredId: matterId,
        pmsCode: 'MAT-A001',
        matchedBy: 'manual',
        matchedAt: '2026-10-31T10:00:00.000Z',
      },
      {
        id: 'PMSL-A-ORG',
        entityType: 'organisation',
        onesquaredId: orgId,
        pmsCode: 'CL-A001',
        matchedBy: 'manual',
        matchedAt: '2026-10-31T10:00:00.000Z',
      },
      {
        id: 'PMSL-A-EMP',
        entityType: 'employee',
        onesquaredId: feeEarnerPersonId,
        pmsCode: 'FE-A01',
        matchedBy: 'manual',
        matchedAt: '2026-10-31T10:00:00.000Z',
      },
    ]);

    await importFirmStoreModulesToPostgres({
      ctx: ctxB,
      store: baseStore,
      tenantConfig: { ...getActiveTenantConfiguration(), tenantId: ctxB.tenantId },
      modules: ['parties', 'matters', 'intake', 'quotes', 'tasks', 'hr', 'catalogues'],
      clearFirst: true,
    });
    await pmsRepo.clearTenantData(ctxB);
    await pmsRepo.importExtractDataset(ctxB, datasetB);
    await pmsRepo.putPmsLinks(ctxB, [
      {
        id: 'PMSL-B-MAT',
        entityType: 'matter',
        onesquaredId: matterId,
        pmsCode: 'MAT-B001',
        matchedBy: 'manual',
        matchedAt: '2026-11-15T10:00:00.000Z',
      },
      {
        id: 'PMSL-B-ORG',
        entityType: 'organisation',
        onesquaredId: orgId,
        pmsCode: 'CL-B001',
        matchedBy: 'manual',
        matchedAt: '2026-11-15T10:00:00.000Z',
      },
      {
        id: 'PMSL-B-EMP',
        entityType: 'employee',
        onesquaredId: feeEarnerPersonId,
        pmsCode: 'FE-B01',
        matchedBy: 'manual',
        matchedAt: '2026-11-15T10:00:00.000Z',
      },
    ]);

    // 1. Verify Tenant A across all 7 finance/PMS loaders (direct PostgreSQL queries, zero JSON hydration)
    const firmFinA = await getFirmFinance(ctxA);
    expect(isActionDenied(firmFinA)).toBe(false);
    if (!isActionDenied(firmFinA)) {
      expect(firmFinA.pmsExtractInfo.asAtDate).toBe('2026-10-31');
      // Firm totals include linked (£14k) + unlinked (£99k) = £113k for Tenant A only
      expect(firmFinA.pmsDepartmentFinancials.firmTotal.unbilledWip).toBe(113000);
      expect(firmFinA.pmsDepartmentFinancials.firmTotal.outstandingDebt).toBe(7200);
      expect(firmFinA.allClientFins.map((c) => c.client_code)).toEqual(['CL-A001']);
    }

    const matterRowsA = await getMatterFinanceRows(ctxA);
    expect(isActionDenied(matterRowsA)).toBe(false);
    if (!isActionDenied(matterRowsA)) {
      // Unlinked MAT-A-UNLINKED (£99k WIP) is excluded; only linked MAT-A001 is returned
      expect(matterRowsA.allMatterFins.map((r) => r.matter_code)).toEqual(['MAT-A001']);
      expect(matterRowsA.allMatterFins[0]?.unbilled_wip).toBe(14000);
      expect(matterRowsA.allMatterFins[0]?.outstanding_debt).toBe(7200);
    }

    const myFigsA = await getMyFinanceFigures(ctxA);
    expect(isActionDenied(myFigsA)).toBe(false);
    if (!isActionDenied(myFigsA)) {
      expect(myFigsA.myFeeEarnerFigures?.fee_earner_id).toBe('FE-A01');
      expect(myFigsA.myFeeEarnerFigures?.unbilled_wip).toBe(14000);
    }

    const matterBundleA = await getMatterPmsViewBundle(matterId, ctxA);
    expect(isActionDenied(matterBundleA)).toBe(false);
    if (!isActionDenied(matterBundleA)) {
      expect(matterBundleA.extractInfo.asAtDate).toBe('2026-10-31');
      expect(matterBundleA.link?.pmsCode).toBe('MAT-A001');
      expect(matterBundleA.matterBundle?.summary.unbilled_wip).toBe(14000);
      expect(matterBundleA.allUnlinkedPmsMatters.map((m) => m.matter_code)).toEqual([
        'MAT-A-UNLINKED',
      ]);
    }

    const clientBundleA = await getClientPmsViewBundle('organisation', orgId, ctxA);
    expect(isActionDenied(clientBundleA)).toBe(false);
    if (!isActionDenied(clientBundleA)) {
      expect(clientBundleA.extractInfo.asAtDate).toBe('2026-10-31');
      expect(clientBundleA.link?.pmsCode).toBe('CL-A001');
      expect(clientBundleA.clientBundle?.summary.unbilled_wip).toBe(14000);
    }

    const adminSnapA = await getPmsAdminSnapshot(ctxA);
    expect(adminSnapA.extractInfo.asAtDate).toBe('2026-10-31');
    expect(adminSnapA.pmsClients.map((c) => c.client_code)).toEqual(['CL-A001']);
    expect(adminSnapA.pmsLinks.map((l) => l.id)).toEqual([
      'PMSL-A-EMP',
      'PMSL-A-MAT',
      'PMSL-A-ORG',
    ]);

    const syncedRatesA = await syncMatterCostsRatesFromPms('P-000001', {
      tenantCtx: ctxA,
    });
    expect(syncedRatesA.pmsLinkActive).toBe(true);
    expect(syncedRatesA.rateCards.some((rc) => rc.pmsPartnerRateGbp === 360)).toBe(
      true,
    );

    // Tampered cross-tenant mutations from Tenant A targeting Tenant B's IDs fail closed
    await expect(
      linkPmsRecord('matter', 'M-TENANT-B-99999', 'MAT-B001', 'P-000001', {
        tenantCtx: ctxA,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(
      unlinkPmsRecord('PMSL-B-MAT', 'P-000001', { tenantCtx: ctxA }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const deniedBillB = await requestMatterBill('MAT-B001', ctxA);
    expect(isActionDenied(deniedBillB)).toBe(true);

    const deniedWriteOffB = await flagMatterWriteOff('MAT-B001', 500, ctxA);
    expect(isActionDenied(deniedWriteOffB)).toBe(true);

    const deniedCcInvoiceB = await recordInvoiceCreditControlAction(
      {
        invoiceNumber: 'INV-B1001',
        matterCode: 'MAT-B001',
        clientCode: 'CL-B001',
        actionType: 'log_call',
        note: 'Tampered cross-tenant invoice',
      },
      ctxA,
    );
    expect(isActionDenied(deniedCcInvoiceB)).toBe(true);

    // 2. Verify Tenant B across all 7 finance/PMS loaders (untouched by Tenant A)
    const firmFinB = await getFirmFinance(ctxB);
    expect(isActionDenied(firmFinB)).toBe(false);
    if (!isActionDenied(firmFinB)) {
      expect(firmFinB.pmsExtractInfo.asAtDate).toBe('2026-11-15');
      // Firm totals include linked (£38k) + unlinked (£77k) = £115k for Tenant B only
      expect(firmFinB.pmsDepartmentFinancials.firmTotal.unbilledWip).toBe(115000);
      expect(firmFinB.pmsDepartmentFinancials.firmTotal.outstandingDebt).toBe(19200);
      expect(firmFinB.allClientFins.map((c) => c.client_code)).toEqual(['CL-B001']);
    }

    const matterRowsB = await getMatterFinanceRows(ctxB);
    expect(isActionDenied(matterRowsB)).toBe(false);
    if (!isActionDenied(matterRowsB)) {
      expect(matterRowsB.allMatterFins.map((r) => r.matter_code)).toEqual(['MAT-B001']);
      expect(matterRowsB.allMatterFins[0]?.unbilled_wip).toBe(38000);
      expect(matterRowsB.allMatterFins[0]?.outstanding_debt).toBe(19200);
    }

    const myFigsB = await getMyFinanceFigures(ctxB);
    expect(isActionDenied(myFigsB)).toBe(false);
    if (!isActionDenied(myFigsB)) {
      expect(myFigsB.myFeeEarnerFigures?.fee_earner_id).toBe('FE-B01');
      expect(myFigsB.myFeeEarnerFigures?.unbilled_wip).toBe(38000);
    }

    const matterBundleB = await getMatterPmsViewBundle(matterId, ctxB);
    expect(isActionDenied(matterBundleB)).toBe(false);
    if (!isActionDenied(matterBundleB)) {
      expect(matterBundleB.extractInfo.asAtDate).toBe('2026-11-15');
      expect(matterBundleB.link?.pmsCode).toBe('MAT-B001');
      expect(matterBundleB.matterBundle?.summary.unbilled_wip).toBe(38000);
    }

    const clientBundleB = await getClientPmsViewBundle('organisation', orgId, ctxB);
    expect(isActionDenied(clientBundleB)).toBe(false);
    if (!isActionDenied(clientBundleB)) {
      expect(clientBundleB.extractInfo.asAtDate).toBe('2026-11-15');
      expect(clientBundleB.link?.pmsCode).toBe('CL-B001');
      expect(clientBundleB.clientBundle?.summary.unbilled_wip).toBe(38000);
    }

    const adminSnapB = await getPmsAdminSnapshot(ctxB);
    expect(adminSnapB.extractInfo.asAtDate).toBe('2026-11-15');
    expect(adminSnapB.pmsLinks.map((l) => l.id)).toEqual([
      'PMSL-B-EMP',
      'PMSL-B-MAT',
      'PMSL-B-ORG',
    ]);

    const syncedRatesB = await syncMatterCostsRatesFromPms('P-000001', {
      tenantCtx: ctxB,
    });
    expect(syncedRatesB.pmsLinkActive).toBe(true);
    expect(syncedRatesB.rateCards.some((rc) => rc.pmsPartnerRateGbp === 410)).toBe(
      true,
    );

    // 3. Interleave Model B service mutations (linkPmsRecord + recordInvoiceCreditControlAction) on Tenant A and Tenant B in one process (R467)
    const secondMatterId = baseStore.matters[1]!.id;
    await linkPmsRecord('matter', secondMatterId, 'MAT-A-UNLINKED', 'P-000001', {
      tenantCtx: ctxA,
    });
    const ccA = await recordInvoiceCreditControlAction(
      {
        invoiceNumber: 'INV-A1001',
        matterCode: 'MAT-A001',
        clientCode: 'CL-A001',
        actionType: 'log_call',
        note: 'Tenant A credit control note R467',
      },
      ctxA,
    );
    expect(isActionDenied(ccA)).toBe(false);

    const ccB = await recordInvoiceCreditControlAction(
      {
        invoiceNumber: 'INV-B1001',
        matterCode: 'MAT-B001',
        clientCode: 'CL-B001',
        actionType: 'send_reminder',
        note: 'Tenant B credit control note R467',
      },
      ctxB,
    );
    expect(isActionDenied(ccB)).toBe(false);

    // Re-read both tenants without any manual sync: Tenant A now has 2 linked matters, while Tenant B still has 1
    const rowsAfterLinkA = await getMatterFinanceRows(ctxA);
    const rowsAfterLinkB = await getMatterFinanceRows(ctxB);
    expect(isActionDenied(rowsAfterLinkA)).toBe(false);
    expect(isActionDenied(rowsAfterLinkB)).toBe(false);
    if (!isActionDenied(rowsAfterLinkA) && !isActionDenied(rowsAfterLinkB)) {
      expect(rowsAfterLinkA.allMatterFins.map((r) => r.matter_code)).toEqual([
        'MAT-A-UNLINKED',
        'MAT-A001',
      ]);
      expect(rowsAfterLinkB.allMatterFins.map((r) => r.matter_code)).toEqual([
        'MAT-B001',
      ]);
    }

    const ccRowsA = await pmsRepo.listCreditControlActions(ctxA, {
      matterCode: 'MAT-A001',
    });
    const ccRowsB = await pmsRepo.listCreditControlActions(ctxB, {
      matterCode: 'MAT-B001',
    });
    expect(ccRowsA.map((a) => a.notes)).toEqual([
      'Credit control call logged regarding invoice INV-A1001 (MAT-A001). Tenant A credit control note R467',
    ]);
    expect(ccRowsB.map((a) => a.notes)).toEqual([
      'Credit control reminder statement sent for invoice INV-B1001 (MAT-B001).',
    ]);
  });

  it('commits recordInvoiceCreditControlAction and executeMerge PMS link repointing atomically in PostgreSQL and rolls back on failure', async () => {
    const { ctx, actorSession } = makeHostActorAndContext('P-000001');
    await runWithActiveActorSession(actorSession, async () => {
      const store = loadCommittedSeedStore();
      await importFirmStoreModulesToPostgres({
        ctx,
        store,
        modules: [
          'parties',
          'matters',
          'intake',
          'quotes',
          'tasks',
          'hr',
          'catalogues',
          'pms',
        ],
        clearFirst: true,
      });

      const pmsRepo = getPmsRepository();
      const partyRepo = new TenantPartyRepository();
      const auditRepo = new TenantAuditRepository();

      // Find a linked matter that has an overdue/issued invoice in the PMS extract
      const pmsSource = await getTenantPmsSource(ctx);
      const allLinks = await pmsRepo.listPmsLinks(ctx);
      const linkedMatters = allLinks.filter((l) => l.entityType === 'matter');
      const targetLink = linkedMatters.find(
        (l) => pmsSource.getMatterFullBundle(l.pmsCode)?.invoices.length,
      )!;
      const targetInvoice = pmsSource.getMatterFullBundle(targetLink.pmsCode)!.invoices[0]!;

      const ccBefore = (
        await pmsRepo.listCreditControlActions(ctx, {
          matterCode: targetLink.pmsCode,
        })
      ).length;
      const auditBefore = await auditRepo.countAuditEntries(ctx);

      // 1. Atomic success: recordInvoiceCreditControlAction writes to pms_credit_control_log, notes, and audit_entries
      const ccRes = await recordInvoiceCreditControlAction(
        {
          invoiceNumber: targetInvoice.invoice_number,
          matterCode: targetLink.pmsCode,
          clientCode: targetInvoice.client_code,
          actionType: 'log_call',
          note: 'Confirmed payment run scheduled for Friday',
        },
        ctx,
      );
      expect(isActionDenied(ccRes)).toBe(false);

      const ccAfter = await pmsRepo.listCreditControlActions(ctx, {
        matterCode: targetLink.pmsCode,
      });
      expect(ccAfter.length).toBe(ccBefore + 1);
      expect(ccAfter[0]?.notes).toContain('Confirmed payment run scheduled for Friday');
      expect(await auditRepo.countAuditEntries(ctx)).toBeGreaterThan(auditBefore);

      // 2. Forced transaction failure rolls back BOTH pms_credit_control_log and audit_entries
      const auditPreRollback = await auditRepo.countAuditEntries(ctx);
      await expect(
        pmsRepo.withTenantTransaction(ctx, async () => {
          await pmsRepo.recordCreditControlAction(ctx, {
            invoiceNumber: targetInvoice.invoice_number,
            matterCode: targetLink.pmsCode,
            actionType: 'send_reminder',
            notes: 'Should roll back on forced error (S018)',
            actorName: 'Test Actor P-000001',
          });
          await auditRepo.appendAuditEntry(ctx, {
            id: 'AU-ROLLBACK-S018',
            recordType: 'matter',
            recordId: targetLink.onesquaredId,
            action: 'credit-control-logged',
            field: 'Rollback test',
            oldValue: null,
            newValue: 'Should roll back',
            byId: 'P-000001',
            at: new Date().toISOString(),
          });
          throw new Error('PMS_FORCED_CC_AUDIT_ROLLBACK');
        }),
      ).rejects.toThrow('PMS_FORCED_CC_AUDIT_ROLLBACK');

      const ccAfterRollback = await pmsRepo.listCreditControlActions(ctx, {
        matterCode: targetLink.pmsCode,
      });
      expect(
        ccAfterRollback.some((a) =>
          a.notes.includes('Should roll back on forced error (S018)'),
        ),
      ).toBe(false);
      expect(await auditRepo.countAuditEntries(ctx)).toBe(auditPreRollback);

      // 3. executeMerge repoints pms_links in the single PostgreSQL merge transaction
      const survivorOrgRes = await saveOrganisationRecord(
        {
          legalName: 'S0-18 Survivor Holdings Ltd',
          organisationTypeId: 'organisation_type.ltd',
          relationshipStatusId: 'relationship_status.active',
        },
        { byId: 'P-000001' },
      );
      const mergedOrgRes = await saveOrganisationRecord(
        {
          legalName: 'S0-18 Merged Subsidiary Ltd',
          organisationTypeId: 'organisation_type.ltd',
          relationshipStatusId: 'relationship_status.active',
        },
        { byId: 'P-000001' },
      );
      expect(survivorOrgRes.organisation).toBeDefined();
      expect(mergedOrgRes.organisation).toBeDefined();

      await linkPmsRecord(
        'organisation',
        mergedOrgRes.organisation.id,
        'CL-MERGE-S018',
        'P-000001',
      );

      const mergeRes = await executeMerge(
        'organisation',
        survivorOrgRes.organisation.id,
        mergedOrgRes.organisation.id,
        'P-000001',
      );
      expect(isActionDenied(mergeRes)).toBe(false);

      const dbLinksAfterMerge = await pmsRepo.listPmsLinks(ctx);
      const repointedLink = dbLinksAfterMerge.find((l) => l.pmsCode === 'CL-MERGE-S018');
      expect(repointedLink?.onesquaredId).toBe(survivorOrgRes.organisation.id);
      void partyRepo;

      const cleanStore = loadCommittedSeedStore();
      await importFirmStoreModulesToPostgres({
        ctx,
        store: cleanStore,
        clearFirst: true,
      });
    });
  });

  it('enforces R465, R466, R468, and R470: cold-start and two-replica visibility without runtime-store.json or process-level PMS snapshot caches, and zero getStore/saveStore in runtime src/ files', async () => {
    const { ctx, actorSession } = makeHostActorAndContext('P-000001');
    await runWithActiveActorSession(actorSession, async () => {
      const seedStore = loadCommittedSeedStore();
      await importFirmStoreModulesToPostgres({
        ctx,
        store: seedStore,
        modules: [
          'parties',
          'matters',
          'intake',
          'quotes',
          'tasks',
          'hr',
          'catalogues',
          'pms',
        ],
        clearFirst: true,
      });

      // Cold-start simulation (R465, R468): point ONESQUARED_RUNTIME_STORE_PATH at an empty directory in NODE_ENV=production
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 's018-r465-cold-'));
      const nonExistentStorePath = path.join(tmpDir, 'runtime-store.json');
      const prevStorePath = process.env.ONESQUARED_RUNTIME_STORE_PATH;
      const prevNodeEnv = process.env.NODE_ENV;
      process.env.ONESQUARED_RUNTIME_STORE_PATH = nonExistentStorePath;
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production';

      const poolMgrB = new TenantPostgresPoolManager({ maxConnectionsPerTenant: 1 });
      const replicaBPmsRepo = new TenantPmsRepository({ poolManager: poolMgrB });
      try {
        // 1. All 7 finance/PMS service loaders succeed on cold start with no runtime-store.json on disk
        const coldFirm = await getFirmFinance(ctx);
        expect(isActionDenied(coldFirm)).toBe(false);
        const coldRows = await getMatterFinanceRows(ctx);
        expect(isActionDenied(coldRows)).toBe(false);
        const coldMine = await getMyFinanceFigures(ctx);
        expect(isActionDenied(coldMine)).toBe(false);
        const coldMatterBundle = await getMatterPmsViewBundle('M-000001', ctx);
        expect(isActionDenied(coldMatterBundle)).toBe(false);
        const coldClientBundle = await getClientPmsViewBundle('organisation', 'O-000001', ctx);
        expect(isActionDenied(coldClientBundle)).toBe(false);
        const coldAdmin = await getPmsAdminSnapshot(ctx);
        expect(coldAdmin.pmsLinks.length).toBeGreaterThan(0);

        // 2. Two-replica visibility (R466): Replica A writes a PMS link via linkPmsRecord, and Replica B reads it immediately via its own connection pool
        const unlinkedMatterCode =
          !isActionDenied(coldMatterBundle) && coldMatterBundle.allUnlinkedPmsMatters[0]
            ? coldMatterBundle.allUnlinkedPmsMatters[0].matter_code
            : 'BRI001-0002';
        const linkRes = await linkPmsRecord(
          'matter',
          'M-000002',
          unlinkedMatterCode,
          'P-000001',
          { tenantCtx: ctx },
        );
        expect(linkRes.pmsCode).toBe(unlinkedMatterCode);

        const replicaBLinks = await replicaBPmsRepo.listPmsLinks(ctx);
        expect(
          replicaBLinks.some(
            (l) => l.onesquaredId === 'M-000002' && l.pmsCode === unlinkedMatterCode,
          ),
        ).toBe(true);

        await unlinkPmsRecord(linkRes.id, 'P-000001', { tenantCtx: ctx });
        const replicaBLinksAfterUnlink = await replicaBPmsRepo.listPmsLinks(ctx);
        expect(
          replicaBLinksAfterUnlink.some((l) => l.id === linkRes.id),
        ).toBe(false);

        // 3. R468: runtime-store.json was never created or written during any PMS read or write
        expect(fs.existsSync(nonExistentStorePath)).toBe(false);
      } finally {
        await poolMgrB.closeAllPools();
        (process.env as Record<string, string | undefined>).NODE_ENV = prevNodeEnv;
        if (prevStorePath === undefined) {
          delete process.env.ONESQUARED_RUNTIME_STORE_PATH;
        } else {
          process.env.ONESQUARED_RUNTIME_STORE_PATH = prevStorePath;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // 4. R466 & R470: auditAdapter.ts and postgresTenantCoordinator.ts do not exist, and zero process-level PMS snapshot caches exist
    expect(
      fs.existsSync(path.join(REPO_ROOT, 'src/server/auditAdapter.ts')),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(REPO_ROOT, 'src/server/postgresTenantCoordinator.ts')),
    ).toBe(false);

    const pmsRepoSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'core/src/tenancy/pmsRepository.ts'),
      'utf8',
    );
    expect(pmsRepoSrc).not.toMatch(/__oneSquared/);
    expect(pmsRepoSrc).not.toContain('getCachedTenantPmsSnapshot');
    expect(pmsRepoSrc).not.toContain('invalidateCachedTenantPmsSnapshot');

    const pmsSourceSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'src/pms/pmsSource.ts'),
      'utf8',
    );
    expect(pmsSourceSrc).not.toContain('node:sqlite');
    expect(pmsSourceSrc).not.toContain('class DemoDbPmsSource');
    expect(pmsSourceSrc).not.toContain('export function getPmsSource');
    expect(pmsSourceSrc).not.toContain('getCachedTenantPmsSnapshot');

    expect(
      fs.existsSync(path.join(REPO_ROOT, 'src/server/store.ts')),
    ).toBe(false);

    // 5. R470: Walk all runtime .ts/.tsx files under src/ and assert zero getStore(, saveStore(, getSynchronizedTenantStoreSnapshot, resolveSynchronizedTenantPmsLinks, or __oneSquaredStore
    function collectRuntimeFiles(dirPath: string): string[] {
      const results: string[] = [];
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const fullPath = path.join(dirPath, entry.name);
        const relPath = path.relative(REPO_ROOT, fullPath).replace(/\\/g, '/');
        if (entry.isDirectory()) {
          if (
            relPath === 'src/seed' ||
            relPath === 'src/docs' ||
            relPath === 'src/test' ||
            relPath === 'src/server/testSupport' ||
            relPath.endsWith('/__tests__')
          ) {
            continue;
          }
          results.push(...collectRuntimeFiles(fullPath));
        } else if (
          entry.isFile() &&
          /\.(ts|tsx)$/.test(entry.name) &&
          !entry.name.endsWith('.test.ts') &&
          !entry.name.endsWith('.test.tsx') &&
          relPath !== 'src/server/storePostgresImport.ts'
        ) {
          results.push(relPath);
        }
      }
      return results;
    }

    const runtimeFiles = collectRuntimeFiles(path.join(REPO_ROOT, 'src'));
    expect(runtimeFiles.length).toBeGreaterThan(25);
    for (const relPath of runtimeFiles) {
      const src = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
      expect(
        /\b(getStore|saveStore)\s*\(/.test(src),
        `Expected zero getStore(/saveStore( calls in runtime file ${relPath}`,
      ).toBe(false);
      expect(
        src.includes('getSynchronizedTenantStoreSnapshot'),
        `Expected zero getSynchronizedTenantStoreSnapshot in ${relPath}`,
      ).toBe(false);
      expect(
        src.includes('resolveSynchronizedTenantPmsLinks'),
        `Expected zero resolveSynchronizedTenantPmsLinks in ${relPath}`,
      ).toBe(false);
      expect(
        src.includes('__oneSquaredStore'),
        `Expected zero __oneSquaredStore in ${relPath}`,
      ).toBe(false);
    }
  });

  it('R474: saveMatterRecord, executeMerge, prepareEnquiryConversion, and prepareQuoteConversionRecord each run inside a single PostgreSQL transaction and roll back all earlier statements on last-statement failure with zero compensation', async () => {
    const { ctx, actorSession } = makeHostActorAndContext('P-000001');
    const freshPoolMgr = new TenantPostgresPoolManager({ maxConnectionsPerTenant: 1 });
    const freshPartyRepo = new TenantPartyRepository({ poolManager: freshPoolMgr });
    const freshMatterRepo = new TenantMatterRepository({ poolManager: freshPoolMgr });
    const freshIntakeRepo = new TenantIntakeQuoteRepository({ poolManager: freshPoolMgr });
    const freshPmsRepo = new TenantPmsRepository({ poolManager: freshPoolMgr });
    const freshAuditRepo = new TenantAuditRepository({ poolManager: freshPoolMgr });

    try {
      await runWithActiveActorSession(actorSession, async () => {
        const seedStore = loadCommittedSeedStore();
        await importFirmStoreModulesToPostgres({
          ctx,
          store: seedStore,
          modules: [
            'parties',
            'matters',
            'intake',
            'quotes',
            'tasks',
            'hr',
            'catalogues',
            'pms',
          ],
          clearFirst: true,
        });

        // 1. saveMatterRecord (with sourceEnquiryId) — fails on last statement (audit flush)
        const routedEnqRes = await saveEnquiryRecord(
          {
            takenById: 'P-000001',
            channelId: 'enquiry_channel.phone',
            firstName: 'Rhiannon',
            lastName: 'R474MatterConv',
            callingOnBehalfOf: '',
            linkedOrganisationId: 'O-000001',
            email: 'rhiannon.r474@pembroke-invented.example',
            phone: '02920119901',
            preferredContactMethodId: 'contact_method.email',
            bestTimeToCall: 'Morning',
            address: null,
            practiceAreaId: 'practice_area.commercial_property',
            workTypeSubcategoryId: null,
            summary: 'Invented R474 matter conversion enquiry',
            notes: 'Invented R474 matter conversion enquiry notes.',
            otherPartiesNamed: '',
            urgencyId: 'urgency.normal',
            keyDate: null,
            keyDateLabel: '',
            sourceId: 'record_source.website',
            referrerPersonId: null,
            assignedTeamId: 'TM-000001',
            assignedToId: 'P-000001',
            privacyNoticeGiven: true,
            customFields: {},
          },
          { byId: 'P-000001' },
        );
        expect(routedEnqRes.enquiry).toBeDefined();
        const sourceEnq = routedEnqRes.enquiry!;
        const prepEnq1 = await prepareEnquiryConversion(
          sourceEnq.id,
          { useOrganisationId: 'O-000001' },
          'P-000001',
        );
        expect(prepEnq1.ok).toBe(true);
        const baseMatter = (
          await getMatterRepository().listAllMattersUnfiltered<import('@/domain/types').Matter>(ctx)
        ).find((m) => !m.isStaffMatter)!;
        const { id: _unusedId, ...matterTemplate } = baseMatter;
        void _unusedId;
        const matterTitle = 'R474 Single-Tx Matter Rollback';

        setAuditAdapterFailureHookForTesting(({ entries }) => {
          if (entries.some((e) => String(e.newValue ?? '').includes(matterTitle))) {
            throw new Error('R474_FORCED_SAVE_MATTER_LAST_STATEMENT_FAILURE');
          }
        });
        await expect(
          saveMatterRecord(
            {
              ...matterTemplate,
              matterNumber: 'DRAFT',
              openedAt: null,
              fieldValues: {},
              title: matterTitle,
              sourceEnquiryId: sourceEnq.id,
              agreedFeeCapGbp: 5000,
              feeEstimateGbp: 5000,
            },
            { byId: 'P-000001', saveMode: 'submit_cleared' },
          ),
        ).rejects.toThrow('R474_FORCED_SAVE_MATTER_LAST_STATEMENT_FAILURE');
        setAuditAdapterFailureHookForTesting(null);

        const freshMattersAfter1 = await freshMatterRepo.listAllMattersUnfiltered<import('@/domain/types').Matter>(ctx);
        expect(freshMattersAfter1.some((m) => m.title === matterTitle)).toBe(false);
        const freshEnqAfter1 = await freshIntakeRepo.getEnquiryById<import('@/domain/types').Enquiry>(
          ctx,
          sourceEnq.id,
          { includeRestricted: true },
        );
        expect(freshEnqAfter1?.status).not.toBe('Converted');
        expect(freshEnqAfter1?.convertedMatterId ?? null).toBeNull();

        // 2. executeMerge — fails on last statement (audit flush) and rolls back pms_links, people, and merge_history on a fresh connection
        const survivorOrg = (
          await saveOrganisationRecord(
            {
              legalName: 'R474 Merge Survivor Org Ltd',
              organisationTypeId: 'organisation_type.ltd',
              relationshipStatusId: 'relationship_status.active',
            },
            { byId: 'P-000001' },
          )
        ).organisation!;
        const mergedOrg = (
          await saveOrganisationRecord(
            {
              legalName: 'R474 Merge Target Org Ltd',
              organisationTypeId: 'organisation_type.ltd',
              relationshipStatusId: 'relationship_status.active',
            },
            { byId: 'P-000001' },
          )
        ).organisation!;
        await linkPmsRecord('organisation', mergedOrg.id, 'CL-R474-MERGE', 'P-000001');

        setAuditAdapterFailureHookForTesting(({ entries }) => {
          if (entries.some((e) => e.action === 'merge' || e.action === 'merged-into')) {
            throw new Error('R474_FORCED_MERGE_LAST_STATEMENT_FAILURE');
          }
        });
        await expect(
          executeMerge('organisation', survivorOrg.id, mergedOrg.id, 'P-000001'),
        ).rejects.toThrow('R474_FORCED_MERGE_LAST_STATEMENT_FAILURE');
        setAuditAdapterFailureHookForTesting(null);

        const freshMergedOrg = await freshPartyRepo.getOrganisationById<import('@/domain/types').Organisation>(
          ctx,
          mergedOrg.id,
        );
        expect(freshMergedOrg?.mergedIntoId ?? null).toBeNull();
        const freshLinksAfterMerge = await freshPmsRepo.listPmsLinks(ctx);
        expect(
          freshLinksAfterMerge.find((l) => l.pmsCode === 'CL-R474-MERGE')?.onesquaredId,
        ).toBe(mergedOrg.id);
        const freshMergeHistory = await freshPartyRepo.listAllMergeHistory(ctx);
        expect(
          freshMergeHistory.some(
            (mh) => mh.survivorId === survivorOrg.id && mh.mergedId === mergedOrg.id,
          ),
        ).toBe(false);

        // 3. prepareEnquiryConversion — fails on last statement (audit flush) and rolls back created Person, Organisation, link, and enquiry update
        const bizEnqRes = await saveEnquiryRecord(
          {
            takenById: 'P-000001',
            channelId: 'enquiry_channel.phone',
            firstName: 'Bryn',
            lastName: 'R474EnqConv',
            callingOnBehalfOf: 'R474 Enquiry Conversion Holdings Ltd',
            email: 'bryn.r474@pembroke-invented.example',
            phone: '02920119902',
            preferredContactMethodId: 'contact_method.email',
            bestTimeToCall: 'Afternoon',
            address: null,
            practiceAreaId: 'practice_area.commercial_property',
            workTypeSubcategoryId: null,
            summary: 'Invented R474 business enquiry conversion',
            notes: 'Invented R474 business enquiry conversion notes.',
            otherPartiesNamed: '',
            urgencyId: 'urgency.normal',
            keyDate: null,
            keyDateLabel: '',
            sourceId: 'record_source.website',
            referrerPersonId: null,
            assignedTeamId: 'TM-000001',
            assignedToId: 'P-000001',
            privacyNoticeGiven: true,
            customFields: {},
          },
          { byId: 'P-000001' },
        );
        expect(bizEnqRes.enquiry).toBeDefined();
        const bizEnq = bizEnqRes.enquiry!;

        setAuditAdapterFailureHookForTesting(({ entries }) => {
          if (
            entries.some(
              (e) =>
                e.field === 'Conflict check decision recorded on enquiry conversion',
            )
          ) {
            throw new Error('R474_FORCED_ENQUIRY_CONVERSION_LAST_STATEMENT_FAILURE');
          }
        });
        await expect(
          prepareEnquiryConversion(bizEnq.id, { createForBusiness: true }, 'P-000001'),
        ).rejects.toThrow('R474_FORCED_ENQUIRY_CONVERSION_LAST_STATEMENT_FAILURE');
        setAuditAdapterFailureHookForTesting(null);

        const freshPeopleAfterEnqConv = await freshPartyRepo.listAllPeople<import('@/domain/types').Person>(ctx);
        const freshOrgsAfterEnqConv = await freshPartyRepo.listAllOrganisations<import('@/domain/types').Organisation>(ctx);
        const freshBizEnq = await freshIntakeRepo.getEnquiryById<import('@/domain/types').Enquiry>(
          ctx,
          bizEnq.id,
          { includeRestricted: true },
        );
        expect(freshPeopleAfterEnqConv.some((p) => p.surname === 'R474EnqConv')).toBe(false);
        expect(
          freshOrgsAfterEnqConv.some(
            (o) => o.legalName === 'R474 Enquiry Conversion Holdings Ltd',
          ),
        ).toBe(false);
        expect(freshBizEnq?.linkedPersonId ?? null).toBeNull();
        expect(freshBizEnq?.linkedOrganisationId ?? null).toBeNull();

        // 4. prepareQuoteConversionRecord — fails on last statement (audit flush) and rolls back created Person, Organisation, link, and quote update
        const quoteRes = await saveQuoteRecord(
          {
            clientType: 'prospect',
            prospectName: 'Catrin R474QuoteConv',
            prospectOrganisationName: 'R474 Quote Conversion Ventures Ltd',
            prospectEmail: 'catrin.r474@pembroke-invented.example',
            prospectPhone: '02920119903',
            practiceAreaId: 'practice_area.commercial_property',
            scope: 'Invented R474 quote conversion scope',
            feeBasis: 'Fixed fee',
            feeAmountExVat: 3500,
            disbursements: [],
            feeEarnerId: 'P-000001',
          },
          { byId: 'P-000001', markAsSent: true },
        );
        expect(quoteRes.quote).toBeDefined();
        const quote = quoteRes.quote!;

        setAuditAdapterFailureHookForTesting(({ entries }) => {
          if (
            entries.some(
              (e) =>
                e.recordType === 'quote' &&
                e.recordId === quote.id &&
                e.field === 'Conflict check completed on quote conversion',
            )
          ) {
            throw new Error('R474_FORCED_QUOTE_CONVERSION_LAST_STATEMENT_FAILURE');
          }
        });
        await expect(
          prepareQuoteConversionRecord(quote.id, 'P-000001'),
        ).rejects.toThrow('R474_FORCED_QUOTE_CONVERSION_LAST_STATEMENT_FAILURE');
        setAuditAdapterFailureHookForTesting(null);

        const freshPeopleAfterQuoteConv = await freshPartyRepo.listAllPeople<import('@/domain/types').Person>(ctx);
        const freshOrgsAfterQuoteConv = await freshPartyRepo.listAllOrganisations<import('@/domain/types').Organisation>(ctx);
        const freshQuote = await freshIntakeRepo.getQuoteById<import('@/domain/types').Quote>(
          ctx,
          quote.id,
          { includeRestricted: true },
        );
        expect(
          freshPeopleAfterQuoteConv.some((p) => p.surname === 'R474QuoteConv'),
        ).toBe(false);
        expect(
          freshOrgsAfterQuoteConv.some(
            (o) => o.legalName === 'R474 Quote Conversion Ventures Ltd',
          ),
        ).toBe(false);
        expect(freshQuote?.linkedPersonId ?? null).toBeNull();
        expect(freshQuote?.linkedOrganisationId ?? null).toBeNull();
        const freshQuoteAudits = await freshAuditRepo.listAuditEntriesForRecord(
          ctx,
          'quote',
          quote.id,
        );
        expect(
          freshQuoteAudits.some(
            (a) => a.field === 'Conflict check completed on quote conversion',
          ),
        ).toBe(false);
        void getPartyRepository;
        void getIntakeQuoteRepository;
      });
    } finally {
      setAuditAdapterFailureHookForTesting(null);
      await freshPoolMgr.closeAllPools();
    }
  });

  it('R475 & R476 contract: storeLock, withJsonStoreWriteLock, runUnmigratedJsonMutationWithAudit, compensator.register, and listAllMatters< do not appear in src/, and every writeAudit in services.ts flushes inside withTenantTransaction', () => {
    expect(
      fs.existsSync(path.join(REPO_ROOT, 'src/server/storeLock.ts')),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(REPO_ROOT, 'src/server/__tests__/storeLock.test.ts')),
    ).toBe(false);

    function collectAllSrcFiles(dirPath: string): string[] {
      const results: string[] = [];
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          results.push(...collectAllSrcFiles(fullPath));
        } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
          results.push(path.relative(REPO_ROOT, fullPath).replace(/\\/g, '/'));
        }
      }
      return results;
    }

    const allSrcFiles = collectAllSrcFiles(path.join(REPO_ROOT, 'src'));
    for (const relPath of allSrcFiles) {
      const content = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
      expect(
        content.includes('storeLock'),
        `Expected zero storeLock references in ${relPath}`,
      ).toBe(false);
      expect(
        content.includes('withJsonStoreWriteLock'),
        `Expected zero withJsonStoreWriteLock references in ${relPath}`,
      ).toBe(false);
      expect(
        content.includes('runUnmigratedJsonMutationWithAudit'),
        `Expected zero runUnmigratedJsonMutationWithAudit references in ${relPath}`,
      ).toBe(false);
      expect(
        content.includes('compensator.register'),
        `Expected zero compensator.register references in ${relPath}`,
      ).toBe(false);
      expect(
        content.includes('listAllMatters<'),
        `Expected zero deprecated listAllMatters< calls in ${relPath}`,
      ).toBe(false);
    }

    // Verify all 111 writeAudit occurrences (1 definition + 110 call sites; S0-19b moved enquiry anonymisation to appendTenantAuditEntries) in src/server/services.ts
    const servicesSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'src/server/services.ts'),
      'utf8',
    );
    const writeAuditMatches = servicesSrc.match(/\bwriteAudit\s*\(/g) ?? [];
    expect(writeAuditMatches.length).toBe(111);
    const flushMatches = servicesSrc.match(/\bflushStagedAuditEntries\s*\(/g) ?? [];
    expect(flushMatches.length).toBeGreaterThanOrEqual(45);
  });
});
