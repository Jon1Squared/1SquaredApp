import { buildPmsDatabaseFromWorkbook } from '../src/pms/importPms';

const result = buildPmsDatabaseFromWorkbook();
console.log('PMS demo database built successfully:');
console.log(`  Database path: ${result.dbPath}`);
console.log(`  As-at date:    ${result.asAtDate}`);
console.log(`  Imported at:   ${result.importedAt}`);
console.log('  Row counts:', result.counts);
