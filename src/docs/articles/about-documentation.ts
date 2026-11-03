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

- **Getting started**: this page, general guidance, and [how matters, enquiries, tasks & navigation work together](/docs/matters-enquiries-tasks-and-navigation).
- **Architecture, Deployment & Security**: how 1Squared isolates every firm’s data, supports custom code via sandboxed extensions, deploys in either 1Squared UK Cloud or your firm’s own Azure subscription, and governs releases — see [Deployment models, customisation & security architecture](/docs/deployment-and-security) and [Engineering process, quality assurance & release governance](/docs/development-process).
- **Key dates and limitation**: capturing, calculating, verifying, reminding on, and reporting on limitation and other critical dates across matters and enquiries — start with [Overview: what key dates are, and why the system suggests while people confirm](/docs/key-dates-overview).
- **Documents & SharePoint DMS**: how 1Squared connects to Microsoft SharePoint Online, provisions matter folder trees by work type, enforces per-user permissions and ethical walls, and detects permission drift — see [SharePoint document store, matter folder templates & permissions](/docs/sharepoint-document-store).
- **Enquiries**: taking and handling new enquiries, including the [quick conflict check](/docs/quick-conflict-check) and carrying key dates onto matters on conversion.
- **People & Organisations**: contact records, including [duplicate checks](/docs/duplicate-checks).

## Finding help on a screen

Where a screen has an **i** button next to a heading, select it for a short summary. The summary links to the full article here.

## Keeping it up to date

Each article shows when it was last reviewed. If something on screen doesn't match what you read here, tell your system administrator so the article can be corrected.
`,
};
