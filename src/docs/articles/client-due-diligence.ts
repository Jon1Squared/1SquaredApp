import type { DocArticle } from '../registry';

export const clientDueDiligenceArticle: DocArticle = {
  slug: 'client-due-diligence',
  title: 'Client Due Diligence (CDD) workflow and evidence',
  section: 'people-organisations',
  summary:
    'How to open, review and maintain a client’s due diligence checklist, upload verification documents safely, log manual checks honestly, and respond to scheduled re-check reminders.',
  updated: '2026-11-26',
  body: `
Client Due Diligence (CDD) is held at **client level** on each individual Person or Organisation profile rather than starting from scratch on every new file. Once a client’s CDD record is up to date, every new matter for that client reuses it automatically unless the risk level rises or a re-check date falls due.

## 1. Where to find Client Due Diligence

Open any external **Person** or **Organisation** profile and scroll to the **Client Due Diligence** panel. Authorised staff can also review active records in **Registers → Client Due Diligence** and monitor pending or overdue checks from the **AML & CDD queue** panel on the Risk & Compliance Home screen.

- **Who can view CDD:** Fee earners, legal secretaries, supervisors, partners, managing partner, and risk & compliance (for clients they are permitted to see).
- **Who can update CDD and upload documents:** Fee earners, legal secretaries, supervisors, partners, managing partner, and risk & compliance.
- **Who cannot view or edit CDD:** Administration and Finance roles have no access to client CDD checklists or downloaded identity documents.
- **Staff members who instruct the firm personally:** When an employee or leaver also instructs the firm as a private client, their CDD details are hidden from colleagues across profiles, Registers, downloads, Home queues, and re-check alerts unless the viewer works on an active matter for that person or holds risk/restricted access.

## 2. Starting and completing a CDD checklist

1. On a client profile with **CDD not started**, click **Start CDD** to create the checklist (for existing records in **In progress** or **Recorded**, open the checklist items directly on the profile card).
2. The checklist chooses items automatically based on the **client type** (for example Individual, Company or LLP, or Trust, charity or partnership) and the **risk tier**:
   - **Standard CDD (Low or Medium risk):** 36-month (3-year) re-check interval, covering core identity, proof of address, or entity registration checks.
   - **Enhanced CDD (High, Critical, or Sensitive risk):** 12-month (1-year) re-check interval, adding source of funds, source of wealth, beneficial ownership, and enhanced due diligence checks.
3. Items start as **Pending**. For each item, add any supporting reference notes or evidence files and choose one of the three item actions:
   - **Mark recorded** — confirms the check or document has been received and verified.
   - **Not applicable** — records why the item does not apply (a written explanation is mandatory).
   - **Flag issue** — records a problem or discrepancy requiring follow-up (a written explanation is mandatory).
4. Once every required checklist item is marked **Recorded** or **Not applicable**, click **Complete CDD**. Only clicking **Complete CDD** moves the record to **Recorded** and schedules the next re-check due date automatically (**36 months** ahead for Standard CDD, or **12 months** ahead for Enhanced CDD). No separate second approver sign-off is required on client CDD itself; any high-risk matter opening requires separate two-person sign-off under the **High-risk matter opening** workflow.

> **When a client later requires High risk CDD:** If a client holds a Standard CDD record and is later rated **High risk (based on the client’s matters)** or entity rating, upgrading is a manual step: click **Upgrade to High Risk** on the CDD panel. Trying to click **Complete CDD** at Standard tier for a High-risk client is refused until you carry out that upgrade. Upgrading preserves every already completed Standard item and attached file, adds the additional Enhanced CDD items as **Pending**, returns the record to **In progress**, and schedules the next re-check **12 months** ahead once you complete the remaining items and click **Complete CDD**.

## 3. Uploading and downloading CDD evidence

- Documents such as passports, driving licences, utility bills, certificates of incorporation, and source-of-funds statements can be attached directly inside the checklist item before clicking **Mark recorded**.
- Uploads accept PDF, JPEG, PNG, HEIC or HEIF images, and Word, Excel, or PowerPoint Office documents within the firm’s configured file-size limit (default 10 MB per file), verified by server file-signature checks. Executable files, scripts, unpermitted formats, and macro-enabled files are blocked before storage.
- Evidence files stay stored in the firm’s tenant-isolated file store and are served through short-lived scoped downloads only to users permitted to view that client’s CDD record.

## 4. Manual verification and watchlist screening notices

Until the firm enables a live electronic ID or automated screening provider in a later release:

- Every completed check displays **Recorded manually by [name] on [date]** alongside the profile’s **ID Verification** summary.
- The **Sanctions & PEP** indicator displays **Not checked** (or **Not yet checked** on the checklist panel) until either an external screening service runs or an authorised user logs a manual watchlist check using **Record watchlist check**, choosing **No match recorded (manual check)**, **Potential match flagged**, or **Pending review** together with scope, reference code, and notes.
- For regulatory audit retention, completed CDD records and uploaded evidence files are kept even when expired enquiries are anonymised.

## 5. Scheduled re-check reminders

Daily register reminder checks inspect **Recorded** CDD records as they approach or pass their re-check due date according to your firm’s reminder schedule (defaulting in demo configuration to **30 days before**, **7 days before**, **on the due date**, **7 days after**, and **30 days after** when overdue), alerting the assigned client owner, or falling back to the most recent active matter fee earner, or the Risk & Compliance team where no fee earner is assigned.
`,
};
