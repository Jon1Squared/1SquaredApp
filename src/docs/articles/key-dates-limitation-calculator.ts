import type { DocArticle } from '../registry';

export const keyDatesLimitationCalculatorArticle: DocArticle = {
  slug: 'key-dates-limitation-calculator',
  title: 'Using the limitation calculator',
  section: 'key-dates-limitation',
  summary:
    'How the rule-driven limitation calculator computes dates from triggers, periods, business calendars, minority adjustments, standstill agreements, and longstops—and how overrides work.',
  updated: '2026-11-03',
  body: `
The **Limitation Calculator** helps fee earners compute limitation and procedural dates using firm-configured rule sets and business calendars, producing a full step-by-step audit explanation.

> **Important notice:** This calculation is a guide. A solicitor must confirm the date. Each rule also displays its configured \`guidanceNote\` directly in the calculator panel.

## No hardcoded statutory periods in core code

The platform never hardcodes statutory limitation periods. Every rule set lives in your firm's tenant configuration (\`keyDates.limitationRuleSets\`), versioned by jurisdiction (\`england_and_wales\`, \`scotland\`, \`northern_ireland\`, \`other\`) and signed off by a reviewing solicitor.

- **Reviewed rule sets (\`reviewStatus: "reviewed"\`)** — Follow the matter type's standard verification policy.
- **Unreviewed rule sets (\`reviewStatus: "unreviewed"\`)** — Display a prominent warning in the calculator and on the key date, and **always require two-step verification** by a second person holding \`keydate:verify\`, even if the matter type normally does not require verification.

## How the calculation engine works

The calculator runs six deterministic steps in order, recording every step in \`calculation.explanation\`:

1. **Trigger resolution (\`single\` or \`later_of\`)**
   - **Single trigger:** Starts from the configured trigger field (such as \`accrualDate\`, \`dateOfKnowledge\`, \`dateOfDeath\`, or a custom trigger \`custom.<name>\`).
   - **Later-of trigger:** Compares two or more trigger fields (for example \`accrualDate\` and \`dateOfKnowledge\`) and starts from whichever date is later.
2. **Minority adjustment (optional)**
   - Where \`minorityAdjustment.enabled\` is \`true\` and the claimant was under the configured \`ageOfMajority\` (default 18) on the trigger date, time runs from the claimant's 18th birthday instead of the trigger date.
   - **Data minimisation:** Claimant date of birth (\`claimantDateOfBirth\`) is personal data. It is only captured and stored when the selected rule has \`minorityAdjustment.enabled: true\`.
3. **Period addition (\`years\`, \`months\`, \`days\`, including negative days)**
   - Adds calendar years and months first (clamping leap-year and end-of-month dates such as 29 February to 28 February in non-leap years).
   - Counts \`days\` (positive or negative, e.g. \`-14\` days before a hearing or \`-1\` for "less one day") using the rule's \`countMethod\`:
     - \`calendar\` — Calendar days.
     - \`business_days\` — Skips weekends (\`weekendDays\`) and bank holidays (\`nonWorkingDates\`) in the rule's configured business calendar.
     - \`clear_days\` — Excludes both the trigger day and the target event day.
4. **Standstill periods**
   - Where \`applyStandstillPeriods\` is enabled (default \`true\`), each recorded standstill agreement (\`from\`, \`to\`, \`reference\`) adds its paused calendar days to the calculated date.
5. **Longstop cap**
   - Where a rule defines a \`longstop\` (for example 15 years from \`accrualDate\`), the calculator compares the calculated date (including any date-of-knowledge or standstill extension) against the longstop date. **The earlier of the calculated date and the longstop date wins.**
6. **Non-working-day adjustment**
   - Where \`nonWorkingDayAdjustment\` is set to \`next_working_day\` or \`previous_working_day\`, any date landing on a weekend or configured bank holiday is rolled forward or backward to the nearest working day.

## Overriding a calculated date

A user holding \`keydate:override_calculation\` (by default Partners and Managing Partners) may override the calculator's result:

- A **reason is mandatory** whenever an override is used.
- Both the engine's original \`calculatedDate\` and the overridden \`dueDate\` (along with \`overrideReason\`) are preserved permanently on the key date and recorded in the immutable audit log (\`keydate-override-calculation\`).
`.trim(),
};
