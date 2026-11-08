import type { DocArticle } from '../registry';

export const quickConflictCheck: DocArticle = {
  slug: 'quick-conflict-check',
  title: 'How the quick conflict check works',
  section: 'enquiries',
  summary:
    'What the live check on the New enquiry screen compares, when it runs, how results are graded, and its limits.',
  updated: '2026-11-07',
  body: `
The quick conflict check runs on the **New enquiry** screen while you take the caller's details. It compares what you type with existing People, Organisations and matters so you can spot a likely conflict, or an existing contact, before the enquiry is saved.

> It's indicative only. It doesn't replace the full conflict check, which runs before a matter is opened. Don't share results with the caller.

## When it runs

Each field starts checking once there is enough to search on, so half-typed values don't produce noise:

| Field | Starts checking when |
| --- | --- |
| First name, last name | At least one word of 3 or more letters |
| Calling on behalf of | At least one word of 3 or more letters |
| Other parties named | Each comma-separated name with a word of 3 or more letters |
| Email | It is a complete, valid email address |
| Phone | It has at least 9 digits |
| Postcode | It is a complete, valid UK postcode |
| Address | Address line 1 plus a valid postcode |

Until one of these is met, the card shows **Waiting**.

## What it compares

| What you enter | Compared with | Result if it matches |
| --- | --- | --- |
| Caller's name | People recorded as an opposing or opposite party | Possible conflict |
| Caller's name | All other People | Already known to us |
| Calling on behalf of | Opposite party Organisations and People | Possible conflict |
| Calling on behalf of | All other Organisations | Already known to us |
| Each other party | Existing clients and opposite parties | Possible conflict |
| Each other party | Parties recorded on matters | Matter / party match |
| Email | Opposite party People and Organisations (exact address) | Possible conflict |
| Email domain | Opposite party Organisations' email or website domain | Check (amber) |
| Email | Other People (exact) and Organisations (exact or domain) | Already known to us |
| Phone | Opposite party People and Organisations | Possible conflict |
| Phone | Other People and Organisations | Already known to us |
| Address | Opposite party People and Organisations | Check (amber) |
| Address or postcode | Other People and Organisations | Already known to us |
| Caller or organisation | Opposing, counterparty, claimant, defendant or adjoining parties on matters | Possible conflict |
| Caller, organisation or other party | Matter instructing contacts and billing contacts | Possible conflict (when adverse) or Already known to us |
| Caller, organisation or other party | Person–organisation links (linked people and linked organisations) | Possible conflict (when linked to an opposite party) or Already known to us |
| Caller, organisation or other party | Primary and additional clients on matters | Possible conflict (when named as an other party) or Already known to us |

## What the conflict snapshot stores

When an enquiry is saved or converted, the server records an immutable **Enquiry conflict snapshot** (\`conflictSnapshot\`) containing:

- **Timestamp and actor** (\`recordedAt\`, \`recordedById\`): when the check ran and who triggered it.
- **Searched inputs and sources** (\`searchedInput\`): the exact caller name, organisation, other parties named, email, phone, postcode, address lines, and the \`searchedSources\` list (\`matter clients\`, \`additional clients\`, \`parties\`, \`instructing contacts\`, \`billing contacts\`, \`person–organisation links\`, \`enquiries\`, \`directory\`).
- **Matched records and redaction**: the conflict hits, known people, and known organisations visible to the actor. Any match against a restricted or ethical-wall matter the actor is not permitted to view is redacted as **a restricted matter** so matter numbers and titles are never leaked.

## How results are shown

Results are split into two groups:

- **Possible conflicts**: things that may stop the firm acting. Red rows are strong matches, such as the same name, email or phone as a known opposite party. Amber rows need checking, such as a similar name, a sound-alike name or a shared address.
- **Already known to us**: existing records that look like the caller or their organisation. Use **Link** to attach the enquiry to the existing record so a duplicate isn't created later.

Each record appears once, even if it matched on several fields. The row lists everything it matched on, for example "Matched on: caller name, email".

The badge at the top of the card shows:

- **Waiting**: nothing to check yet.
- **No matches**: checked and nothing found. If no other party has been named yet, you'll be prompted to ask who the other party is.
- **N matches**: the number of different records found.
- **Possible conflict** (red): at least one strong conflict was found.

## How names are compared

Before comparing, names are tidied so that formatting differences don't matter:

- Upper and lower case are treated the same.
- Accents are ignored, so "Siân" matches "Sian" and "Tŷ" matches "Ty".
- "&" and "and" are treated the same.
- Titles are ignored (Mr, Mrs, Ms, Miss, Dr and similar).
- Company endings are ignored (Ltd, Limited, LLP, PLC, Co and similar).
- Hyphens and extra spaces are ignored.

### Misspellings

A name that is only a letter or two different is shown as **Similar name, check**. For example, "Lisa Kendal" finds "Lisa Kendall". A letter added, missed, changed or two letters swapped each count as one difference. How many differences are allowed depends on the length of the word:

| Word length | Differences allowed |
| --- | --- |
| 1 to 3 letters | None |
| 4 to 7 letters | 1 |
| 8 or more letters | 2 |

For people, both the first name and the surname must be close, with no more than 2 differences in total.

### Names that sound alike

Names spelt differently but pronounced the same are also shown as **Similar name, check**. For example: Davies and Davis, Smith and Smyth, Rhys and Reece, Catherine and Kathryn, Thompson and Thomson, Jon and John.

This uses a phonetic code based on the Metaphone method, adjusted for British and Welsh names. Short names (3 letters or fewer) only match if the difference is a silent letter, so Tim and Tom don't match.

### Safeguards against noise

- A surname on its own is never enough. "Jones" with no first name won't produce a result.
- Similar and sound-alike names are only ever amber, never red.
- For other parties, similar or sound-alike names are only shown when they point at an existing client or opposite party.

## How contact details are compared

- **Email**: compared after trimming spaces and ignoring case. A shared email domain (for example everyone at castellhomes.co.uk) is a weaker signal. Free email providers such as gmail.com, outlook.com, hotmail.co.uk, yahoo.co.uk, icloud.com and btinternet.com are never treated as a shared domain.
- **Phone**: spaces, brackets, dashes and a leading +44 or 0 are removed, and the last 9 digits are compared. So "+44 29 2010 4400" matches "029 2010 4400".
- **Address**: the postcode must match exactly (ignoring spaces and case), and address line 1 must match the start of the other address. "3 Bute Dock Chambers" matches "3 Bute Dock Chambers, Mount Stuart Square", but "1 High Street" doesn't match "12 High Street". Common abbreviations such as Rd, St, Ave and Cres are expanded first.
- **Postcode on its own** is a weak signal. It's shown under Already known to us as "same postcode" but is never treated as a conflict.

## What it doesn't do

- It doesn't check employees of the firm.
- It doesn't search documents, emails or matter notes.
- It doesn't confirm whether the firm can act. That decision is made at the full conflict check.
- It only knows what has been recorded. A party that hasn't been entered in 1Squared won't be found.

## Related

- [Duplicate checks on People and Organisations](/docs/duplicate-checks)
`,
};
