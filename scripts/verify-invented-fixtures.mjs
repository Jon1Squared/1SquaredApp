import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const files = execFileSync(
  'git',
  [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    'data/',
    'src/seed/',
    'client-*/config/',
  ],
  {
    encoding: 'utf8',
  },
)
  .split(/\r?\n/)
  .filter((f) => f && /\.(json|sql|csv|txt|md|ts)$/i.test(f));

const allowedDomain =
  /^(example\.(com|org|net)|[a-z0-9.-]+\.(example|test))$/i;
const emailRe = /[a-zA-Z0-9._%+-]+@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
const ofcomDramaRe =
  /^(01632\s?960\d{3}|020\s?7946\s?0\d{3}|029\s?2018\s?0\d{3}|0117\s?496\s?0\d{3}|07700\s?900\d{3}|08081\s?570\d{3}|0909\s?8790\d{3})$/;
const phoneFieldRe =
  /(?:["']?(?:phone|mobile|directPhone|mainPhone|prospectPhone|number)["']?\s*:\s*["']([^"']+)["']|\bphone\(\s*["']([^"']+)["'])/g;

const bad = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(emailRe)) {
    if (!allowedDomain.test(m[1])) {
      bad.push(`${file}: non-RFC2606 email ${m[0]}`);
    }
  }
  for (const m of text.matchAll(phoneFieldRe)) {
    const ph = (m[1] ?? m[2] ?? '').trim();
    if (ph && !ph.includes('${') && !ofcomDramaRe.test(ph)) {
      bad.push(`${file}: non-Ofcom-drama phone ${ph}`);
    }
  }
}

if (bad.length > 0) {
  console.error('ERROR: Non-invented fixture data found:\n' + bad.join('\n'));
  process.exit(1);
}
