import type { DocArticle } from '../registry';

export const duplicateChecks: DocArticle = {
  slug: 'duplicate-checks',
  title: 'Duplicate checks on People and Organisations',
  section: 'people-organisations',
  summary:
    'How the People and Organisation forms warn you about records that may already exist, and how merging duplicate records repoints every reference.',
  updated: '2026-11-24',
  body: `
When you add or edit a person or organisation, 1Squared checks for existing records in the per-tenant directory (\`TenantPartyRepository\`, \`S0-16\`) that might be the same. Matches appear in a warning above the form, so you can open the existing record instead of creating a duplicate.

## Live checks, saving and error messages

- **Automatic duplicate check when you save:** Even if you save quickly before the live warning appears, or if the live lookup was unavailable while you typed, 1Squared checks the firm directory on the server when you save a new or edited person or organisation. If a likely match is found, the record is flagged as a possible duplicate automatically so it can be reviewed and merged cleanly.
- **What "Couldn't check for duplicates. Try again." means:** This banner appears if the live background check could not complete while you were typing (for example because your session expired or the server was temporarily unreachable). Select **Try again** to re-run the live check. Saving the form will still run the full server-side duplicate check.

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

- **It's the same record**: open the existing record and update it, or merge the duplicate into the surviving record.
- **It's a different record**: continue saving. Users with \`record:merge\` can mark records as "Not a duplicate" so they aren't suggested again.

> A shared address on its own isn't shown as a possible duplicate, because family members and colleagues often share one. It's listed as extra evidence when something else also matches, such as a similar name.

## Merging duplicate records

Users holding \`record:merge\` (Admin, Managing Partner, and Risk & Compliance) can merge a duplicate contact or organisation into a surviving record of the same type.

### Employee and leaver records cannot be merged

Firm employees, staff who work at the firm, and leavers (anyone with employment data) can never be merged—neither as the surviving record nor as the merged record. The **Merge into…** button is hidden on employee and leaver profiles, and the server refuses any merge request involving an employee or leaver. Organisation \`relationshipPartnerId\` values always hold an employee ID and are never altered by a merge.

### What moves to the surviving record

In a single operation, the merge copies missing profile fields, emails, phone numbers, addresses, alternative names, tags, and custom fields to the survivor, and repoints every reference across the application:

- **Matters:** \`clientId\`, \`additionalClientIds\` (de-duplicated and excluding \`clientId\`), \`instructingContactId\`, \`billingContactId\`, \`referrerContactId\`, \`parties[]\` (preserving distinct \`(matterId, relationshipCode, capacityCodes)\` roles on the same matter whilst removing exact duplicate collisions and remapping \`connectedToPartyId\`), and the built-in conflict check record's \`parties[].linkedRecordId\` and \`matches[].matchedRecordId\`.
- **Enquiries:** \`linkedOrganisationId\`, \`referrerPersonId\`, \`linkedPersonId\`, \`referredToOrganisationId\`, and the stored conflict snapshot JSONB hits (\`recordId\`, \`knownPeople\`, and \`knownOrganisations\`).
- **Quotes:** \`linkedOrganisationId\`, \`linkedPersonId\`, \`profile_json\`, and \`conflict_decision_json\`.
- **Tasks:** \`linkedRecords[]\` across both \`task_linked_records\` and JSONB \`linked_records_json\` / \`profile_json\` (de-duplicated if the survivor is already linked to the same task).
- **PMS links:** \`onesquaredId\`. If the surviving record already has a PMS link, the survivor's PMS link is kept, no duplicate is created, and the collision is recorded in the merge history and audit trail.
- **Person–organisation links:** moved to the survivor and de-duplicated—when the survivor is already linked to the same counterpart, the duplicate link on the merged record is deleted rather than left pointing at the merged record.
- **Person emails:** \`person_emails\` rows moved to the survivor and de-duplicated by normalised email address.
- **Organisations:** subsidiary \`parentOrganisationId\` links (guarding against self-parenting or tombstone cycles on the surviving organisation).
- **Generated documents:** \`primaryClientId\`, \`recipientPartyId\`, and \`document_links\` (preserving distinct \`link_role\` links whilst deduplicating exact same-role collisions).
- **Registers:** register records (party fields and flat or nested \`{ id }\` party ID references, incrementing optimistic version inside the merge transaction, \`R515\`, \`R551\`, \`R565\`).
- **Notes and activity:** notes (recording \`mergedFromId\`), \`createdFromEnquiryId\` (inherited by both \`Person\` and \`Organisation\` survivors when blank), recently viewed lists, and notification \`recordId\` / metadata / boundary-safe \`href\` links (so merging \`P-1\` never corrupts \`/people/P-10\`).

### Tombstone redirect and audit trail

The merged record is not deleted: it is marked as **Merged** with \`mergedIntoId\` pointing to the surviving record, and all directory, matter, register (incrementing optimistic versions), PMS link, client rate override, document, document-link, intake, workflow, and firm audit entries commit atomically inside a single tenant transaction via \`TenantPartyRepository.executeMergeInTransaction\` (\`S0-16\`, \`S0-17a\`, \`S0-21\`, \`R552\`). Opening the old record's profile or edit URL automatically redirects to the surviving record, and existing audit entries keep their original \`recordId\` so the historical audit trail remains intact.
`,
};
