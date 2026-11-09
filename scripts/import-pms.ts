import { buildPmsDatabaseFromWorkbook } from '../src/pms/importPms';

const args = process.argv.slice(2);
let asAtDate: string | undefined;
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === '--as-at') {
    asAtDate = args[i + 1];
    i++;
  } else if (arg.startsWith('--as-at=')) {
    asAtDate = arg.slice('--as-at='.length);
  }
}

const result = buildPmsDatabaseFromWorkbook(asAtDate ? { asAtDate } : undefined);
console.log('PMS demo database built successfully:');
console.log(`  Database path: ${result.dbPath}`);
console.log(`  As-at date:    ${result.asAtDate}`);
console.log(`  Imported at:   ${result.importedAt}`);
console.log('  Row counts:', result.counts);
