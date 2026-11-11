import 'server-only';

/**
 * Gated server-side finance loaders (`src/server/financeServices.ts`, ADR 0029 / Slice S0-10).
 *
 * Every function resolves the actor's permissions against the active tenant and
 * filters PMS rows by `canPersonAccessMatter` (`buildRecordVisibility`) before
 * computing any summary or roll-up.
 */

import type { PermissionKey } from '@platform/core';
import { buildActionDenied, type ActionDenied } from '@/domain/actionResult';
import { createDefaultHomePagesConfig } from '@/domain/homeConfig';
import {
  buildFeeEarnerWeeklyTime,
  buildFirmFinanceRollups,
  findPmsCodeForRecord,
  isValidPmsAsAtDate,
  PMS_AS_AT_UNAVAILABLE_LABEL,
} from '@/domain/pms';
import { getActiveActorSession } from '@/domain/rbac';
import type { Person, PmsLink } from '@/domain/types';
import {
  getActiveTenantConfiguration,
  resolveCurrentTenantContext,
} from '@/platform/tenantRuntime';
import { getPmsSource } from '@/pms/pmsSource';
import type {
  PmsCashReceivedSummary,
  PmsClientAccountEntry,
  PmsClientFinancials,
  PmsDepartmentFinancials,
  PmsDisbursement,
  PmsExtractInfo,
  PmsFeeEarnerPerformance,
  PmsFeeEarnerWeeklyTime,
  PmsInvoiceBalance,
  PmsInvoiceDetail,
  PmsMatterFinancials,
  PmsMonthlyFeesBilled,
} from '@/pms/types';
import {
  createVerifiedSessionActorFromEntraSession,
  type VerifiedEntraSessionPayload,
} from './entraAuth';
import { canPersonAccessMatter, resolvePersonPermissionSet } from './rbacRuntime';
import { getStore, type FirmStore } from './store';
import { buildRecordVisibility, EMPTY_HIDDEN_KEY_DATE_IDS } from './visibility';

export type FinanceActorInput =
  | string
  | { readonly personId: string }
  | { readonly id: string }
  | null
  | undefined;

export interface MatterFinanceRowsResult {
  pmsExtractInfo: PmsExtractInfo;
  pmsLinks: PmsLink[];
  pmsSummaryByMatterId: Record<string, PmsMatterFinancials>;
  allMatterFins: PmsMatterFinancials[];
  pmsAgedDebt: PmsInvoiceBalance[];
  pmsInvoices: PmsInvoiceDetail[];
  pmsAllDisbursements: PmsDisbursement[];
  pmsClientAccountByMatterCode: Record<string, PmsClientAccountEntry[]>;
}

export interface MyFinanceFiguresResult {
  myFeeEarnerFigures: PmsFeeEarnerPerformance | null;
  myWeeklyTime: PmsFeeEarnerWeeklyTime | null;
}

export interface FirmFinanceResult {
  pmsExtractInfo: PmsExtractInfo;
  allFeeEarnerPerformance: PmsFeeEarnerPerformance[];
  pmsMonthlyFeesBilled: { months: PmsMonthlyFeesBilled[]; yearToDateTotal: number };
  pmsCashReceived: PmsCashReceivedSummary;
  pmsDepartmentFinancials: {
    departments: PmsDepartmentFinancials[];
    firmTotal: PmsDepartmentFinancials;
  };
  allClientFins: PmsClientFinancials[];
  pmsSummaryByClientId: Record<string, PmsClientFinancials>;
}

function extractExplicitActorId(actor: FinanceActorInput): string | null {
  if (typeof actor === 'string') {
    return actor.trim() || null;
  }
  if (actor && typeof actor === 'object') {
    if ('personId' in actor && typeof actor.personId === 'string') {
      return actor.personId.trim() || null;
    }
    if ('id' in actor && typeof actor.id === 'string') {
      return actor.id.trim() || null;
    }
  }
  return null;
}

function extractActorId(actor: FinanceActorInput): string | null {
  const explicitId = extractExplicitActorId(actor);
  if (explicitId) return explicitId;
  const sessionPersonId = getActiveActorSession()?.personId;
  return sessionPersonId ? sessionPersonId.trim() : null;
}

export function verifyFinanceActorAndPermission(
  actorInput: FinanceActorInput,
  requiredPermission: PermissionKey,
):
  | {
      ok: true;
      store: FirmStore;
      actor: Person;
      effectiveWorkPerson: Person;
      permSet: ReturnType<typeof resolvePersonPermissionSet>;
      tokenRoles: readonly string[] | undefined;
      hiddenMatterIds: ReadonlySet<string>;
      hiddenPmsMatterCodes: Set<string>;
      accessibleLinkedPmsMatterCodes: Set<string>;
      visiblePmsLinks: PmsLink[];
    }
  | ActionDenied {
  const tenantCfg = getActiveTenantConfiguration();
  const activeSession = getActiveActorSession();
  const activeVerifiedSession = activeSession?.verifiedSession as
    | VerifiedEntraSessionPayload
    | undefined;
  if (activeVerifiedSession) {
    resolveCurrentTenantContext(
      createVerifiedSessionActorFromEntraSession(activeVerifiedSession),
      tenantCfg,
    );
  } else if (
    activeSession?.tenantId &&
    activeSession.tenantId.trim() !== tenantCfg.tenantId
  ) {
    throw new Error(
      `TENANCY_FORGERY_DETECTED: Session tenant "${activeSession.tenantId}" does not match active tenant "${tenantCfg.tenantId}".`,
    );
  }

  const explicitActorId = extractExplicitActorId(actorInput);
  if (
    activeSession?.personId &&
    explicitActorId &&
    explicitActorId !== activeSession.personId.trim()
  ) {
    return buildActionDenied(
      'FORBIDDEN',
      'Actor identity does not match the active authenticated session.',
    );
  }

  const actorId = extractActorId(actorInput);
  if (!actorId) {
    return buildActionDenied(
      'UNAUTHENTICATED',
      'Authentication is required to view finance data.',
    );
  }

  const store = getStore();
  const actor = store.people.find((p) => p.id === actorId && !p.mergedIntoId) ?? null;
  if (!actor) {
    return buildActionDenied(
      'FORBIDDEN',
      'Authenticated user record was not found or access is denied.',
    );
  }

  const tokenRoles =
    activeSession?.personId === actor.id ? activeSession.tokenRoles : undefined;
  const permSet = resolvePersonPermissionSet(actor, {
    allPeople: store.people,
    teams: store.teams,
    tokenRoles,
  });
  if (!permSet.permissions.has(requiredPermission)) {
    return buildActionDenied(
      'FORBIDDEN',
      `You do not have permission (${requiredPermission}) to view this finance data.`,
    );
  }

  const visibility = buildRecordVisibility(store, actor, {
    tokenRoles,
    hiddenMatterKeyDateIds: EMPTY_HIDDEN_KEY_DATE_IDS,
  });
  const hiddenMatterIds = visibility.hiddenMatterIds;
  const hiddenPmsMatterCodes = new Set(
    store.pmsLinks
      .filter((l) => l.entityType === 'matter' && hiddenMatterIds.has(l.onesquaredId))
      .map((l) => l.pmsCode),
  );
  const accessibleMatterIds = new Set(
    store.matters.filter((m) => !hiddenMatterIds.has(m.id)).map((m) => m.id),
  );
  const accessibleLinkedPmsMatterCodes = new Set(
    store.pmsLinks
      .filter(
        (l) => l.entityType === 'matter' && accessibleMatterIds.has(l.onesquaredId),
      )
      .map((l) => l.pmsCode),
  );
  const visiblePmsLinks = store.pmsLinks.filter(
    (l) => !(l.entityType === 'matter' && hiddenMatterIds.has(l.onesquaredId)),
  );
  const effectiveWorkPerson: Person =
    actor.demo && actor.showsWorkOfId
      ? (store.people.find((p) => p.id === actor.showsWorkOfId) ?? actor)
      : actor;

  return {
    ok: true,
    store,
    actor,
    effectiveWorkPerson,
    permSet,
    tokenRoles,
    hiddenMatterIds,
    hiddenPmsMatterCodes,
    accessibleLinkedPmsMatterCodes,
    visiblePmsLinks,
  };
}

/**
 * Loads per-matter PMS summaries, aged debt, invoices, disbursements, and client
 * account entries for linked 1Squared matters the actor can access.
 *
 * Requires `finance:view_matter` and fails closed on unlinked PMS matters.
 */
export function getMatterFinanceRows(
  actorInput: FinanceActorInput,
  matterIds?: readonly string[],
): MatterFinanceRowsResult | ActionDenied {
  const auth = verifyFinanceActorAndPermission(actorInput, 'finance:view_matter');
  if (!auth.ok) return auth;

  const {
    store,
    actor,
    tokenRoles,
    accessibleLinkedPmsMatterCodes,
    visiblePmsLinks,
  } = auth;

  let allowedPmsCodesFilter: Set<string> | null = null;
  let allowedMatterIdsFilter: Set<string> | null = null;

  if (matterIds !== undefined) {
    allowedMatterIdsFilter = new Set<string>();
    allowedPmsCodesFilter = new Set<string>();
    for (const matterId of matterIds) {
      const matter = store.matters.find((m) => m.id === matterId && !m.mergedIntoId);
      if (
        !matter ||
        !canPersonAccessMatter(matter, actor.id, actor, {
          allPeople: store.people,
          teams: store.teams,
          tokenRoles,
        })
      ) {
        return buildActionDenied(
          'FORBIDDEN',
          'Matter not found or access denied.',
        );
      }
      allowedMatterIdsFilter.add(matter.id);
      const code = findPmsCodeForRecord(visiblePmsLinks, 'matter', matter.id);
      if (code) {
        allowedPmsCodesFilter.add(code);
      }
    }
  }

  const now = new Date();
  const pms = getPmsSource();
  const isCleanEmpty = Boolean(store.isCleanDeployment) && store.pmsLinks.length === 0;

  if (isCleanEmpty) {
    return {
      pmsExtractInfo: {
        asAtDate: '',
        sourceFile: 'No PMS linked (Clean Client Deployment)',
        importedAt: now.toISOString(),
      },
      pmsLinks: visiblePmsLinks,
      pmsSummaryByMatterId: {},
      allMatterFins: [],
      pmsAgedDebt: [],
      pmsInvoices: [],
      pmsAllDisbursements: [],
      pmsClientAccountByMatterCode: {},
    };
  }

  const pmsExtractInfo = pms.getExtractInfo();
  if (!isValidPmsAsAtDate(pmsExtractInfo.asAtDate)) {
    return {
      pmsExtractInfo: {
        asAtDate: '',
        sourceFile: PMS_AS_AT_UNAVAILABLE_LABEL,
        importedAt: pmsExtractInfo.importedAt,
      },
      pmsLinks: visiblePmsLinks,
      pmsSummaryByMatterId: {},
      allMatterFins: [],
      pmsAgedDebt: [],
      pmsInvoices: [],
      pmsAllDisbursements: [],
      pmsClientAccountByMatterCode: {},
    };
  }

  const isCodeAllowed = (matterCode: string): boolean => {
    if (!accessibleLinkedPmsMatterCodes.has(matterCode)) return false;
    if (allowedPmsCodesFilter && !allowedPmsCodesFilter.has(matterCode)) return false;
    return true;
  };

  const rawMatterFins = pms.getAllMatterFinancials();
  const allMatterFins = rawMatterFins.filter((f) => isCodeAllowed(f.matter_code));
  const finByMatterCode = new Map(allMatterFins.map((f) => [f.matter_code, f]));

  const pmsSummaryByMatterId: Record<string, PmsMatterFinancials> = {};
  for (const link of visiblePmsLinks) {
    if (link.entityType !== 'matter') continue;
    if (allowedMatterIdsFilter && !allowedMatterIdsFilter.has(link.onesquaredId)) {
      continue;
    }
    const fin = finByMatterCode.get(link.pmsCode);
    if (fin) {
      pmsSummaryByMatterId[link.onesquaredId] = fin;
    }
  }

  const pmsAgedDebt: PmsInvoiceBalance[] = pms
    .getAgedDebt()
    .filter((inv) => isCodeAllowed(inv.matter_code));
  const pmsInvoices: PmsInvoiceDetail[] = pms
    .getInvoices()
    .filter((inv) => isCodeAllowed(inv.matter_code));

  const pmsAllDisbursements: PmsDisbursement[] = [];
  const pmsClientAccountByMatterCode: Record<string, PmsClientAccountEntry[]> = {};
  for (const mf of allMatterFins) {
    if (mf.unbilled_disbursements > 0) {
      pmsAllDisbursements.push(...pms.getDisbursements(mf.matter_code));
    }
    const ledgerEntries = pms.getClientAccountLedger(mf.matter_code);
    if (mf.client_account_balance > 0 || ledgerEntries.length > 0) {
      pmsClientAccountByMatterCode[mf.matter_code] = ledgerEntries;
    }
  }

  return {
    pmsExtractInfo,
    pmsLinks: visiblePmsLinks,
    pmsSummaryByMatterId,
    allMatterFins,
    pmsAgedDebt,
    pmsInvoices,
    pmsAllDisbursements,
    pmsClientAccountByMatterCode,
  };
}

/**
 * Loads the signed-in actor's own fee-earner hours and WIP (`myFeeEarnerFigures`,
 * `myWeeklyTime`), counting only linked 1Squared matters the actor can access.
 *
 * Requires `finance:view_matter` and fails closed on unlinked PMS matters.
 */
export function getMyFinanceFigures(
  actorInput: FinanceActorInput,
): MyFinanceFiguresResult | ActionDenied {
  const auth = verifyFinanceActorAndPermission(actorInput, 'finance:view_matter');
  if (!auth.ok) return auth;

  const {
    store,
    actor,
    effectiveWorkPerson,
    accessibleLinkedPmsMatterCodes,
    visiblePmsLinks,
  } = auth;
  const isCleanEmpty = Boolean(store.isCleanDeployment) && store.pmsLinks.length === 0;
  if (isCleanEmpty) {
    return { myFeeEarnerFigures: null, myWeeklyTime: null };
  }

  const myFeCode =
    findPmsCodeForRecord(visiblePmsLinks, 'employee', effectiveWorkPerson.id) ??
    findPmsCodeForRecord(visiblePmsLinks, 'employee', actor.id);
  if (!myFeCode) {
    return { myFeeEarnerFigures: null, myWeeklyTime: null };
  }

  const pms = getPmsSource();
  const extractInfo = pms.getExtractInfo();
  if (!isValidPmsAsAtDate(extractInfo.asAtDate)) {
    return { myFeeEarnerFigures: null, myWeeklyTime: null };
  }
  const feeEarners = pms.listFeeEarners();
  const myFe = feeEarners.find((fe) => fe.fee_earner_id === myFeCode) ?? null;
  if (!myFe) {
    return { myFeeEarnerFigures: null, myWeeklyTime: null };
  }

  const timeEntries = pms
    .listAllTimeEntries()
    .filter((t) => accessibleLinkedPmsMatterCodes.has(t.matter_code));
  const rollups = buildFirmFinanceRollups(
    {
      asAtDate: extractInfo.asAtDate,
      feeEarners: [myFe],
      clients: [],
      matterFinancials: [],
      invoices: [],
      timeEntries,
      payments: [],
    },
    new Set(),
  );
  const myFeeEarnerFigures = rollups.allFeeEarnerPerformance[0] ?? null;

  const activeTenantCfg = getActiveTenantConfiguration();
  const rawHomePagesConfig =
    store.homePagesConfig ??
    createDefaultHomePagesConfig(
      new Date().toISOString(),
      activeTenantCfg.branding.primaryDomain,
    );
  const myWeeklyTime = buildFeeEarnerWeeklyTime({
    feeEarner: myFe,
    timeEntries,
    asAtDate: extractInfo.asAtDate,
    customDailyPace: rawHomePagesConfig.firmSettings.workingDayPaceHours,
  });

  return {
    myFeeEarnerFigures,
    myWeeklyTime,
  };
}

/**
 * Loads firm-wide financial roll-ups (`allFeeEarnerPerformance`, `pmsMonthlyFeesBilled`,
 * `pmsCashReceived`, `pmsDepartmentFinancials`, `allClientFins`, `pmsSummaryByClientId`),
 * calculated strictly from matter-filtered rows via `buildFirmFinanceRollups`.
 *
 * Requires `finance:view`.
 */
export function getFirmFinance(
  actorInput: FinanceActorInput,
): FirmFinanceResult | ActionDenied {
  const auth = verifyFinanceActorAndPermission(actorInput, 'finance:view');
  if (!auth.ok) return auth;

  const { store, hiddenPmsMatterCodes, visiblePmsLinks } = auth;
  const now = new Date();
  const isCleanEmpty = Boolean(store.isCleanDeployment) && store.pmsLinks.length === 0;
  if (isCleanEmpty) {
    return {
      pmsExtractInfo: {
        asAtDate: '',
        sourceFile: 'No PMS linked (Clean Client Deployment)',
        importedAt: now.toISOString(),
      },
      allFeeEarnerPerformance: [],
      pmsMonthlyFeesBilled: { months: [], yearToDateTotal: 0 },
      pmsCashReceived: {
        currentMonthTotal: 0,
        currentMonthReceiptCount: 0,
        previousMonthTotal: 0,
        previousMonthReceiptCount: 0,
      },
      pmsDepartmentFinancials: {
        departments: [],
        firmTotal: {
          practiceArea: 'Firm total',
          openMatters: 0,
          billedThisYear: 0,
          unbilledWip: 0,
          outstandingDebt: 0,
          overdueDebt: 0,
          currentMonthHours: 0,
        },
      },
      allClientFins: [],
      pmsSummaryByClientId: {},
    };
  }

  const pms = getPmsSource();
  const extractInfo = pms.getExtractInfo();
  if (!isValidPmsAsAtDate(extractInfo.asAtDate)) {
    return {
      pmsExtractInfo: {
        asAtDate: '',
        sourceFile: PMS_AS_AT_UNAVAILABLE_LABEL,
        importedAt: extractInfo.importedAt,
      },
      allFeeEarnerPerformance: [],
      pmsMonthlyFeesBilled: { months: [], yearToDateTotal: 0 },
      pmsCashReceived: {
        currentMonthTotal: 0,
        currentMonthReceiptCount: 0,
        previousMonthTotal: 0,
        previousMonthReceiptCount: 0,
      },
      pmsDepartmentFinancials: {
        departments: [],
        firmTotal: {
          practiceArea: 'Firm total',
          openMatters: 0,
          billedThisYear: 0,
          unbilledWip: 0,
          outstandingDebt: 0,
          overdueDebt: 0,
          currentMonthHours: 0,
        },
      },
      allClientFins: [],
      pmsSummaryByClientId: {},
    };
  }
  const rollups = buildFirmFinanceRollups(
    {
      asAtDate: extractInfo.asAtDate,
      feeEarners: pms.listFeeEarners(),
      clients: pms.listClients(),
      matterFinancials: pms.getAllMatterFinancials(),
      invoices: pms.listAllInvoiceBalances(),
      timeEntries: pms.listAllTimeEntries(),
      payments: pms.listAllPayments(),
    },
    hiddenPmsMatterCodes,
  );

  const finByClientCode = new Map(
    rollups.allClientFins.map((f) => [f.client_code, f]),
  );
  const pmsSummaryByClientId: Record<string, PmsClientFinancials> = {};
  for (const link of visiblePmsLinks) {
    if (link.entityType === 'organisation' || link.entityType === 'person') {
      const fin = finByClientCode.get(link.pmsCode);
      if (fin) {
        pmsSummaryByClientId[link.onesquaredId] = fin;
      }
    }
  }

  return {
    pmsExtractInfo: extractInfo,
    allFeeEarnerPerformance: rollups.allFeeEarnerPerformance,
    pmsMonthlyFeesBilled: rollups.pmsMonthlyFeesBilled,
    pmsCashReceived: rollups.pmsCashReceived,
    pmsDepartmentFinancials: rollups.pmsDepartmentFinancials,
    allClientFins: rollups.allClientFins,
    pmsSummaryByClientId,
  };
}
