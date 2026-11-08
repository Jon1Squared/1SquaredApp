import type { DocArticle } from '../registry';

export const matterOpeningAndRiskArticle: DocArticle = {
  slug: 'matter-opening-and-risk',
  title: 'Matter opening wizard & risk assessment',
  section: 'getting-started',
  summary:
    'How the five-step Matter Opening wizard works, how the seven-section risk questionnaire is scored, and how the server validates answers and derives the matter risk rating.',
  updated: '2026-11-07',
  body: `
This guide explains the **Matter Opening wizard** (\`/matters/new\` and \`/matters/[id]/edit\`), how the **Matter Risk Assessment** questionnaire is structured and completed, and how the server validates answers, calculates the risk snapshot, and sets the matter's risk rating.

## 1. The Matter Opening wizard steps

Opening a new matter (requires \`matter:create\`) or editing a matter in progress (requires \`matter:edit\`) walks through five structured cards:

1. **Mandatory details**: Client selection (individual or organisation), instructing contact (where required for an organisation or a client under 18), matter description, department (\`practiceAreaId\`), work type (\`workTypeSubcategoryId\`), owning department and team, and supervising/responsible partner and lead fee earner.
2. **Matter costs**: Fee basis (fixed fee, hourly, conditional/damages-based, or other), fee estimate, agreed fee cap, disbursements, and retainer monies on account. Matters whose estimate exceeds the tenant's governance threshold require partner cost sign-off (\`matter:costs:sign_off\`) before opening.
3. **Matter risk assessment**: Seven-section risk questionnaire covering instruction rationale, Money Laundering Regulations (MLR) scope, client relationship and due diligence, geography, funds and payments, delivery and resourcing, fees and liability, and reputation, regulation, and data.
4. **Parties & conflict check**: Structured party capture (with relationship and capacity codes) and a server-side conflict search across all tenant matters and enquiries. Matches must be reviewed with a disposition and explanation before submission; potential conflicts or matches on restricted records are referred to Risk & Compliance (\`risk:view\`).
5. **Declaration & submission**: Confirmation that all known parties have been searched and recorded, allowing the fee earner to **Save draft**, **Open matter** (\`submit_cleared\`), or **Refer to Risk** (\`submit_referred\`).

## 2. How the risk assessment questionnaire works

The questionnaire is defined in \`MATTER_RISK_SECTIONS\` (\`src/domain/matterOpeningRecord.ts\`) across seven sections:

| Section | Scope | Purpose |
| :--- | :--- | :--- |
| **1. About this instruction** | All matters (Q1.3 AML-only) | Determines whether the work is in scope of the Money Laundering Regulations (\`inScopeMlr\`), whether the instruction makes sense for the client, and whether money is being moved without an underlying transaction. |
| **2. Client and relationship** | All matters | Checks whether the client is new or existing (and whether CDD is current), how the client has been met, ownership structure complexity, and third-party instructions. |
| **3. Geography** | All matters (Q3.2 AML-only) | Screens links to high-risk third countries or sanctioned jurisdictions, and cross-border movement of funds or assets. |
| **4. Funds and payments** | AML in-scope only | Covers holding client money, third-party funding, source-of-funds understanding, and unusual payment requests. |
| **5. Delivery and resourcing** | All matters | Checks whether the work is routine for the team, whether supervision and capacity are in place, and whether imminent deadlines or court dates apply (\`customKeyDates\`). |
| **6. Fees and liability** | All matters | Reviews fee basis, money on account, value or exposure at stake, and any proposed limitation of liability. |
| **7. Reputation, regulation and data** | All matters | Screens reputational or ethical concerns, sensitive sectors or media attention, and special category data or unusual confidentiality requirements. |

### MLR scope and completion rules

- **Money Laundering Regulations scope**: When Q1.1 (\`inScopeMlr\`) is answered **No, out of scope**, AML-only sections (Section 4) and AML-only questions (Q1.3 and Q3.2) are excluded from the required question count (reducing the total from 23 questions to 17).
- **Mandatory follow-ups**: Options flagged with \`triggersFollowUp: true\` (such as *Not sure*, *No*, or *Yes* on a risk indicator) require a non-empty follow-up explanation — or at least one date entry in \`customKeyDates\` for Q5.3 (\`imminentDeadlines\`) — before that question is counted as completed.
- **Shared completion calculation**: Both the browser form (\`summarizeMatterRiskAssessment\`) and the server (\`buildMatterRiskAssessmentSnapshot\`) use the same builder so the completed question count, remaining count, and section risk badges always match.

## 3. Server-side validation, scoring, and risk rating derivation

\`riskAssessment\` remains a server-owned field in \`SERVER_OWNED_MATTER_FIELD_KEYS\` (\`src/domain/matterFieldValues.ts\`). The server never trusts a pre-computed snapshot or risk rating from the browser:

- **Answers only from the client**: When saving a draft, opening a matter, or editing an existing matter, the client sends only the raw questionnaire inputs (\`answers\`, \`followUps\`, and \`customKeyDates\`). Any client-supplied \`sections\`, \`overallRisk\`, or completion counts are discarded.
- **Strict schema validation**: \`validateMatterRiskAssessmentInput\` verifies every question ID in \`answers\` and \`followUps\` against \`MATTER_RISK_SECTIONS\`, checks that every non-empty answer matches one of that question's permitted option labels, and enforces a maximum length of 2,000 characters on follow-up explanations (\`MAX_RISK_FOLLOW_UP_LENGTH\`). Any unknown question ID, invalid answer value, or over-length follow-up is rejected with a field error under \`errors.riskAssessment\`.
- **Server-side scoring and attribution**: Each answered question carries an option risk level (\`Low\`, \`Medium\`, or \`High\`). \`buildMatterRiskAssessmentSnapshot\` calculates each section's highest risk level and the matter's \`overallRisk\` (the highest risk level across all answered questions), records the signed-in user who submitted the answers in \`completedById\` / \`completedByName\` alongside the matter's \`leadFeeEarnerId\` / \`leadFeeEarnerName\`, and stores the resulting snapshot in \`matter.fieldValues.riskAssessment\`.
- **Derived \`riskRatingId\` and empty state**: \`saveMatterRecord\` derives \`matter.riskRatingId\` directly from the server's \`overallRisk\` via \`resolveRiskRatingIdForLevel\` (\`Low\` → \`risk_rating.low\`, \`Medium\` → \`risk_rating.medium\`, \`High\` → \`risk_rating.high\`), ignoring any \`riskRatingId\` sent by the client. When a new matter or enquiry conversion is saved without questionnaire answers, \`resolveMatterRiskAssessment\` records an empty \`not_started\` assessment (\`answers: {}\`, \`completedQuestions: 0\`, \`completedAt: null\`, \`completedById: null\`, \`overallRisk: null\`) and leaves \`matter.riskRatingId\` empty (\`''\`) rather than inventing default answers.
- **Preserving and updating answers on edit**: Saving an existing matter with updated questionnaire answers replaces the stored \`fieldValues.riskAssessment\` snapshot and updates \`matter.riskRatingId\`. Saving an existing matter without questionnaire answers keeps its existing stored snapshot and rating intact.

## 4. Conflict checks on matter opening, enquiry conversion, and quote conversion

- **Full conflict search coverage**: Both \`searchMatterConflicts\` (matter opening and quote conversion) and \`runEnquiryConflictSearch\` (enquiry intake and enquiry conversion) search across matter primary clients, additional clients (\`additionalClientIds\`), matter parties, matter instructing contacts (\`instructingContactId\`), matter billing contacts (\`billingContactId\`), person–organisation links (\`store.links\`), enquiries, and the People and Organisations directory. \`buildEffectiveConflictParties\` automatically includes both the instructing contact and the billing contact alongside the client and named parties.
- **Enquiry and quote conversion gates**: Converting an enquiry (\`prepareEnquiryConversionAction\`) or a fee quote (\`prepareQuoteConversionAction\`) into a matter requires \`matter:create\` before any conflict search runs or any Person, Organisation, or link record is created. Both conversions run the server-side conflict check first and block conversion when a high-severity conflict is found, redacting any match on a restricted matter the caller cannot access as **a restricted matter**.
- **Organisation conflict status and decision record**: When conversion creates a new prospective client organisation, its conflict status is derived from the search outcome (\`Cleared\` when no hits are found, or \`Potential conflict\` when amber warnings remain for Risk & Compliance review) rather than hard-coded as \`Cleared\`. New organisations store a structured \`conflictDecision\` (\`outcome\`, \`decidedById\`, \`decidedByName\`, \`decidedAt\`, \`sourceRecordId\`, \`matchesCount\`, \`searchedSources\`, and \`summary\`) and write a \`conflict-decision\` audit entry, and the pre-conversion \`conflictDecision\` is carried onto the converted matter (\`matter.conflictDecision\`). Existing organisations keep their stored conflict status untouched; a linked organisation with status \`Conflict – declined\` hard-blocks conversion (and records a \`conflict-decision\` audit entry on the enquiry or quote), whereas an unlinked name match against an organisation with status \`Conflict – declined\` (or any other non-blocking amber match) raises a non-blocking warning in \`conflictWarnings\` that is shown in a toast notification (\`Conflict warning: ...\`) on conversion and carried as an amber notice onto the new matter form so the fee earner can confirm whether it is the same client via the matter conflict workflow.
- **What the matter conflict record stores**: Each matter's \`conflictCheckRecord\` stores the searched party list, every matched record with its disposition and reviewer rationale, the overall status and decision metadata, and \`runHistory\` (\`ConflictCheckRunAudit[]\`), where each run records \`runId\`, \`ranAt\`, \`ranById\`, \`ranByName\`, \`searchedPartyLabels\`, \`searchedSources\`, \`matchCount\`, and \`highSeverityCount\`.
`,
};
