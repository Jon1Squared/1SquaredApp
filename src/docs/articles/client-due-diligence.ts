import type { DocArticle } from '../registry';

export const clientDueDiligenceArticle: DocArticle = {
  slug: 'client-due-diligence',
  title: 'Client Due Diligence (CDD) workflow and evidence',
  section: 'people-organisations',
  summary:
    'How to open, review and maintain a client’s due diligence checklist, upload verification documents safely, log manual checks honestly, and respond to scheduled re-check reminders.',
  updated: '2026-11-25',
  body: `
Client Due Diligence (CDD) is held at **client level** on each individual Person or Organisation profile rather than starting from scratch on every new file. Once a client’s CDD record is up to date, every new matter for that client reuses it automatically unless the risk level rises or a re-check date falls due.

## 1. Where to find Client Due Diligence

Open any external **Person** or **Organisation** profile and scroll to the **Client Due Diligence** panel. Authorised staff can also review active records in **Registers → Client Due Diligence** and monitor pending or overdue checks from the **AML & CDD queue** panel on the Risk & Compliance Home screen.

- **Who can view CDD:** Fee earners, legal secretaries, supervisors, partners, managing partner, risk & compliance, intake, and enquiries coordinators (for clients they are permitted to see).
- **Who can update CDD and upload documents:** Fee earners, legal secretaries, supervisors, partners, managing partner, and risk & compliance.
- **Who cannot view or edit CDD:** Administration and Finance roles have no access to client CDD checklists or downloaded identity documents.
- **Staff members who instruct the firm personally:** When an employee or leaver also instructs the firm as a private client, their CDD details are hidden from colleagues across profiles, Registers, downloads, Home queues, and re-check alerts unless the viewer works on an active matter for that person or holds risk/restricted access.

## 2. Starting and completing a CDD checklist

1. On a client profile with **CDD not started**, click **Start CDD** (or use **Save / Complete checklist items** when updating an existing record).
2. The checklist automatically chooses items based on the **client type** (for example Individual, Private Limited Company, LLP, Charity, Trust, or Public Body) and the **risk tier**:
   - **Standard CDD (Low or Medium risk):** 3-year re-check interval, covering core identity, proof of address, or entity registration checks.
   - **Enhanced CDD (High, Critical, or Sensitive risk):** 1-year re-check interval, adding source of funds, source of wealth, beneficial ownership, and senior review checks.
3. For each item, choose one of three statuses:
   - **Verified / received** — record any supporting notes and attach evidence files where required.
   - **Pending** — still awaiting documents or review from the client.
   - **Not applicable** — explain why the item does not apply (mandatory explanation required).
4. Once every required checklist item is marked **Verified / received** or **Not applicable**, the CDD record moves immediately to **Recorded** and schedules the next re-check due date automatically (**36 months** ahead for Standard CDD, or **12 months** ahead for Enhanced CDD). No separate second approver sign-off is required on standard client CDD itself; any high-risk matter opening requires separate two-person sign-off under the **High-risk matter opening** workflow.

> **When a client later opens a High-risk matter:** Standard completed items already verified are preserved rather than wiped, any additional Enhanced CDD items are added as **Pending**, the status returns to **In progress**, and the re-check schedule tightens to **12 months**.

## 3. Uploading and downloading CDD evidence

- Documents such as passports, driving licences, utility bills, certificates of incorporation, and source-of-funds statements can be attached directly inside the checklist item.
- Uploads accept PDF, JPEG, PNG, WebP, or TIFF files within the firm’s configured file-size limit (default 10 MB per file). Executable files, scripts, and macro-enabled files are blocked before storage.
- Evidence files stay stored in the firm’s tenant-isolated file store and are served through short-lived scoped downloads only to users permitted to view that client’s CDD record.

## 4. Manual verification and screening notices

Until the firm enables a live electronic ID (e-ID) or automated screening provider in a later release:

- Every check completed by a fee earner or compliance officer displays **Recorded manually by [name] on [date]** alongside the profile’s **ID Verification** line.
- The **Sanctions & PEP** indicator continues to display **Not checked** by default until either an external screening service runs or an authorised user logs a manual watchlist review using **Record manual sanctions & PEP check** (which records **Manual check logged — no match found** or **Escalated for compliance review**, together with the reviewer and date).
- For regulatory audit retention, completed CDD records and uploaded evidence files are retained when enquiries or non-client data are anonymised.

## 5. Scheduled re-check reminders

Daily register reminder checks inspect **Recorded** CDD records as they approach or pass their re-check due date (**30 days**, **7 days**, on the **due date**, and **overdue**), alerting the assigned CDD owner, or falling back to the most recent active matter fee earner, or the Risk & Compliance team where no fee earner is assigned.
`,
};
