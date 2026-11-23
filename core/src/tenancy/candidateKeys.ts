/**
 * Shared candidate-key normalisation helpers (`core/src/tenancy/candidateKeys.ts`).
 *
 * Kept strictly in sync with `src/domain/normalise.ts` so migration `0024`
 * indexed lookup columns (`phone_last9_keys`, `postcode_keys`, `phonetic_keys`,
 * `email_domains`, `norm_company_number`) maintain 100% candidate recall against
 * `findPersonDuplicates`, `findOrganisationDuplicates`, `searchMatterConflicts`,
 * and `runEnquiryConflictSearch` without importing Host domain files into `core/`.
 */

const NAME_TITLES = new Set([
  'mr',
  'mrs',
  'ms',
  'miss',
  'mx',
  'dr',
  'prof',
  'rev',
  'sir',
  'dame',
  'lord',
  'lady',
]);

const NAME_ORG_SUFFIXES = new Set([
  'ltd',
  'limited',
  'llp',
  'plc',
  'lp',
  'inc',
  'cyf',
  'cyfyngedig',
  'ccc',
  'company',
  'co',
]);

export const FREE_EMAIL_DOMAINS_SET = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.co.uk',
  'live.com',
  'yahoo.com',
  'yahoo.co.uk',
  'icloud.com',
  'me.com',
  'btinternet.com',
  'aol.com',
  'sky.com',
  'virginmedia.com',
  'talktalk.net',
]);

export function normaliseComparableNameKey(
  input: string | null | undefined,
): string {
  if (!input) return '';
  const cleaned = input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[-]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned
    .split(' ')
    .filter((t) => t && !NAME_TITLES.has(t) && !NAME_ORG_SUFFIXES.has(t))
    .join(' ');
}

export function normalisePhoneLast9Key(
  input: string | null | undefined,
): string {
  let digits = (input ?? '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+44')) digits = '0' + digits.slice(3);
  else if (digits.startsWith('0044')) digits = '0' + digits.slice(4);
  digits = digits.replace(/\D/g, '').replace(/^0+/, '');
  if (digits.length < 9) return '';
  return digits.slice(-9);
}

export function normalisePostcodeKey(input: string | null | undefined): string {
  return (input ?? '').replace(/\s+/g, '').toUpperCase();
}

export function isValidUkPostcodeKey(
  input: string | null | undefined,
): boolean {
  const pc = normalisePostcodeKey(input);
  return /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(pc);
}

export function normaliseRegNumberKey(input: string | null | undefined): string {
  return (input ?? '')
    .replace(/[^a-z0-9]/gi, '')
    .toUpperCase()
    .replace(/^GB/, '');
}

export function extractEmailDomainKey(
  input: string | null | undefined,
): string {
  const email = (input ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z0-9]{2,}$/i.test(email)) return '';
  const atIdx = email.lastIndexOf('@');
  return atIdx >= 0 ? email.slice(atIdx + 1) : '';
}

export function extractWebsiteDomainKey(
  input: string | null | undefined,
): string {
  const cleaned = (input ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
  if (!cleaned || !cleaned.includes('.') || FREE_EMAIL_DOMAINS_SET.has(cleaned)) {
    return '';
  }
  return cleaned;
}

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);
const isVowel = (ch: string | undefined) => Boolean(ch && VOWELS.has(ch));

export function computePhoneticKey(input: string | null | undefined): string {
  let w = (input ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (!w) return '';

  if (/^(kn|gn|pn|wr|ps)/.test(w)) w = w.slice(1);
  if (w.startsWith('x')) w = `s${w.slice(1)}`;
  if (w.startsWith('wh')) w = `w${w.slice(2)}`;
  if (w.startsWith('mc')) w = `mac${w.slice(2)}`;

  let out = '';
  for (let i = 0; i < w.length; i++) {
    const c = w[i]!;
    const prev = w[i - 1];
    const next = w[i + 1];
    const next2 = w[i + 2];
    if (c === prev && c !== 'c') continue;
    if (isVowel(c)) {
      if (i === 0) out += c.toUpperCase();
      continue;
    }
    switch (c) {
      case 'b':
        if (!(prev === 'm' && i === w.length - 1)) out += 'B';
        break;
      case 'c':
        if (next === 'i' && next2 === 'a') out += 'X';
        else if (next === 'h') out += prev === 's' ? 'K' : 'X';
        else if (next === 'i' || next === 'e' || next === 'y') {
          if (prev !== 's') out += 'S';
        } else out += 'K';
        break;
      case 'd':
        if (next === 'g' && (next2 === 'e' || next2 === 'i' || next2 === 'y')) {
          out += 'J';
        } else out += 'T';
        break;
      case 'g':
        if (next === 'h' && !(i + 2 >= w.length || isVowel(next2))) break;
        if (
          next === 'n' &&
          (i + 2 === w.length || (next2 === 'e' && w[i + 3] === 'd'))
        ) {
          break;
        }
        if (prev === 'g') break;
        if (next === 'e' || next === 'i' || next === 'y') out += 'J';
        else out += 'K';
        break;
      case 'h':
        if (prev && 'cgpstrw'.includes(prev)) break;
        if (!isVowel(next) && next !== 'y') break;
        if (isVowel(prev) && !isVowel(next)) break;
        out += 'H';
        break;
      case 'k':
        if (prev !== 'c') out += 'K';
        break;
      case 'p':
        if (next === 'h') out += 'F';
        else if (prev === 'm' && (next === 's' || next === 't')) break;
        else out += 'P';
        break;
      case 'q':
        out += 'K';
        break;
      case 's':
        if (next === 'h' || (next === 'i' && (next2 === 'o' || next2 === 'a'))) {
          out += 'X';
        } else out += 'S';
        break;
      case 't':
        if (next === 'i' && (next2 === 'o' || next2 === 'a')) out += 'X';
        else if (next === 'h') out += '0';
        else if (!(next === 'c' && next2 === 'h')) out += 'T';
        break;
      case 'v':
        out += 'F';
        break;
      case 'w':
      case 'y':
        if (isVowel(next)) out += c.toUpperCase();
        break;
      case 'x':
        out += 'KS';
        break;
      case 'z':
        out += 'S';
        break;
      default:
        out += c.toUpperCase();
    }
  }
  return out.replace(/(.)\1+/g, '$1');
}

export function extractTokenPhoneticKeys(
  texts: readonly (string | null | undefined)[],
): string[] {
  const keys = new Set<string>();
  for (const raw of texts) {
    const norm = normaliseComparableNameKey(raw);
    if (!norm) continue;
    for (const tok of norm.split(' ')) {
      if (!tok) continue;
      if (tok.length >= 4) {
        const pk = computePhoneticKey(tok);
        if (pk.length >= 2) keys.add(`P:${pk}`);
      } else {
        const sk = tok.replace(/[hwy]/g, '').replace(/(.)\1+/g, '$1');
        if (sk) keys.add(`S:${sk}`);
      }
      // Include bare first-initial marker for nickname/initial lookups (first_name vs firstName)
      if (tok.length >= 1) {
        keys.add(`I:${tok[0]}`);
      }
    }
  }
  return Array.from(keys).sort();
}

export function computePersonLookupKeys(person: {
  readonly firstName?: string;
  readonly preferredName?: string;
  readonly surname?: string;
  readonly otherNames?: readonly { readonly name?: string }[];
  readonly phones?: readonly { readonly number?: string }[];
  readonly addresses?: readonly { readonly postcode?: string }[];
}): {
  readonly phoneLast9Keys: string[];
  readonly postcodeKeys: string[];
  readonly phoneticKeys: string[];
} {
  const phoneLast9Set = new Set<string>();
  for (const ph of person.phones ?? []) {
    const l9 = normalisePhoneLast9Key(ph.number);
    if (l9) phoneLast9Set.add(l9);
  }
  const postcodeSet = new Set<string>();
  for (const addr of person.addresses ?? []) {
    const pc = normalisePostcodeKey(addr.postcode);
    if (pc.length >= 2) {
      postcodeSet.add(pc);
    }
  }
  const phoneticKeys = extractTokenPhoneticKeys([
    person.firstName,
    person.preferredName,
    person.surname,
    ...(person.otherNames ?? []).map((n) => n.name),
  ]);
  return {
    phoneLast9Keys: Array.from(phoneLast9Set).sort(),
    postcodeKeys: Array.from(postcodeSet).sort(),
    phoneticKeys,
  };
}

export function computeOrganisationLookupKeys(org: {
  readonly legalName?: string;
  readonly companyNumber?: string;
  readonly generalEmail?: string;
  readonly mainPhone?: string;
  readonly website?: string;
  readonly registeredAddress?: { readonly postcode?: string } | null;
  readonly correspondenceAddress?: { readonly postcode?: string } | null;
  readonly billingAddress?: { readonly postcode?: string } | null;
  readonly otherNames?: readonly { readonly name?: string }[];
}): {
  readonly normCompanyNumber: string;
  readonly emailDomains: string[];
  readonly phoneLast9Keys: string[];
  readonly postcodeKeys: string[];
  readonly phoneticKeys: string[];
} {
  const normCompanyNumber = normaliseRegNumberKey(org.companyNumber);
  const domainSet = new Set<string>();
  const emailDom = extractEmailDomainKey(org.generalEmail);
  if (emailDom && !FREE_EMAIL_DOMAINS_SET.has(emailDom)) {
    domainSet.add(emailDom);
  }
  const webDom = extractWebsiteDomainKey(org.website);
  if (webDom) {
    domainSet.add(webDom);
  }
  const phoneSet = new Set<string>();
  const phoneL9 = normalisePhoneLast9Key(org.mainPhone);
  if (phoneL9) phoneSet.add(phoneL9);

  const postcodeSet = new Set<string>();
  for (const addr of [
    org.registeredAddress,
    org.correspondenceAddress,
    org.billingAddress,
  ]) {
    const pc = addr ? normalisePostcodeKey(addr.postcode) : '';
    if (pc.length >= 2) {
      postcodeSet.add(pc);
    }
  }
  const phoneticKeys = extractTokenPhoneticKeys([
    org.legalName,
    ...(org.otherNames ?? []).map((n) => n.name),
  ]);

  return {
    normCompanyNumber,
    emailDomains: Array.from(domainSet).sort(),
    phoneLast9Keys: Array.from(phoneSet).sort(),
    postcodeKeys: Array.from(postcodeSet).sort(),
    phoneticKeys,
  };
}
