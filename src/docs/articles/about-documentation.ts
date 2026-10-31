import type { DocArticle } from '../registry';

export const aboutDocs: DocArticle = {
  slug: 'about',
  title: 'About this documentation',
  section: 'getting-started',
  summary: 'What the System documentation covers, how it is organised, and how it is kept up to date.',
  updated: '2026-10-18',
  body: `
This section explains how 1Squared works: what each screen does, the rules behind automatic checks, and why the system behaves the way it does. It grows as features are added and changed.

## How it is organised

- **Getting started**: this page and general guidance.
- **Enquiries**: taking and handling new enquiries, including the [quick conflict check](/docs/quick-conflict-check).
- **People & Organisations**: contact records, including [duplicate checks](/docs/duplicate-checks).

## Finding help on a screen

Where a screen has an **i** button next to a heading, select it for a short summary. The summary links to the full article here.

## Keeping it up to date

Each article shows when it was last reviewed. If something on screen doesn't match what you read here, tell your system administrator so the article can be corrected.
`,
};
