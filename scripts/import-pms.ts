import '../core/src/tenancy/pgNodePreload';
import { getGlobalTenantPostgresPoolManager } from '@platform/core';
import { getActiveTenantConfiguration } from '../src/platform/tenantRuntime';
import {
  buildPmsDatabaseFromWorkbook,
  importPmsWorkbookToPostgres,
  parseImportPmsCliArgs,
} from '../src/pms/importPms';
import { buildSystemJobTenantContext } from './lib/systemJobTenantContext';

async function main(): Promise<void> {
  const cliOptions = parseImportPmsCliArgs(process.argv.slice(2));
  const baseTenantCfg = getActiveTenantConfiguration();
  const targetTenantId =
    cliOptions.tenant?.trim().replace(/_/g, '-') || baseTenantCfg.tenantId;
  const tenantConfig = {
    ...baseTenantCfg,
    tenantId: targetTenantId,
  };
  const ctx = buildSystemJobTenantContext({
    tenantConfig,
    jobKey: 'pms-import',
  });

  try {
    const pgResult = await importPmsWorkbookToPostgres(ctx, {
      asAtDate: cliOptions.asAtDate,
    });
    buildPmsDatabaseFromWorkbook({
      asAtDate: cliOptions.asAtDate,
    });
    console.log('PMS extract imported into tenant PostgreSQL database successfully:');
    console.log(`  Tenant ID:     ${ctx.tenantId}`);
    console.log(`  Database:      ${ctx.postgresDatabaseName}`);
    console.log(`  As-at date:    ${pgResult.asAtDate}`);
    console.log(`  Imported at:   ${pgResult.importedAt}`);
    console.log('  Row counts:', pgResult.counts);
  } finally {
    await getGlobalTenantPostgresPoolManager().closeAllPools();
  }
}

void main();
