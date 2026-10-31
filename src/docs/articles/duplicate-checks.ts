import type { DocArticle } from '../registry';

export const duplicateChecks: DocArticle = {
  slug: 'duplicate-checks',
  title: 'Duplicate checks on People and Organisations',
  section: 'people-organisations',
  summary:
    'How the People and Organisation forms warn you about records that may already exist, including misspelt and sound-alike names.',
  updated: '2026-10-18',
  body: `
When you add or edit a person or organisation, 1Squared checks for existing records that might be the same. Matches appear in a warning above the form, so you can open the existing record instead of creating a duplicate.

## What is compared

| Form | Compared on |
| --- | --- |
| Person | Name (including preferred and other names), email, phone, address |
| Organisation | Legal and other names, company number, email, email domain, phone, registered and correspondence address |

## How matches are described

| Shown as | Meaning |
| --- | --- |
| name | Same name after tidying (case, accents, titles, company endings) |
| similar name | Spelt slightly differently, for example Kendal and Kendall |
| name sounds alike | Spelt differently but pronounced the same, for example Davies and Davis |
| email | Same email address |
| email domain | Organisation shares a (non-free) email or website domain |
| phone | Same phone number (last 9 digits) |
| same address | Same postcode and the same first line of the address |
| company number | Same Companies House number |

Names are compared in the same way as the quick conflict check. See [How the quick conflict check works](/docs/quick-conflict-check#how-names-are-compared) for the full rules on misspellings and sound-alike names.

## What to do with a match

- **It's the same record**: open the existing record and update it.
- **It's a different record**: continue saving. You can mark records as "not a duplicate" so they aren't suggested again.

> A shared address on its own isn't shown as a possible duplicate, because family members and colleagues often share one. It's listed as extra evidence when something else also matches, such as a similar name.
`,
};
