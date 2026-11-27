import type { DocArticle } from '../registry';

export const moneyOnAccountArticle: DocArticle = {
  slug: 'money-on-account',
  title: 'Money on Account requests, receipts & opening checks',
  section: 'getting-started',
  summary:
    'How to send Payment on Account transfer instructions, follow automated payment reminders, record or match client account receipts, reverse receipts safely, and unlock the Funds on account opening check.',
  updated: '2026-11-27',
  body: `
This guide explains how **Money on Account** works on matters — from sending transfer instructions to the client, through recording or matching cleared funds, to satisfying the **Funds on account** opening check before work begins.

> **Important:** If your firm has turned on Money on Account and configured your client account bank details, requests and transfer instructions appear on the matter **Overview** tab. In demonstration environments without live email sending enabled, sent payment requests are safely queued in **Administration → Email Outbox** with their PDF attached for review.

## 1. Sending a Payment on Account request

Authorised matter staff (fee earners, supervisors, partners, legal secretaries, finance staff, and administrators who can access the matter) can request funds on account from the **Money on Account** panel on the matter’s **Overview** tab:

1. **Check the requested amount:** If the matter was converted from an accepted quote carrying a Payment on Account (or has a retainer amount entered on the matter), that agreed amount is pre-filled automatically in pounds and pence.
2. **Confirm the recipient:** The client’s email address and name are pre-filled from the instructing contact, client record, or originating enquiry.
3. **Click Send payment request:** 1Squared generates a Payment on Account PDF showing your firm’s client account details, the requested amount, and a unique short transfer reference (for example \`MOA-MAT0010004-01\`, formatted to fit UK Faster Payments and CHAPS reference limits without exposing personal names).
4. **Frozen bank details snapshot:** Each request freezes the client account bank details in force at the moment it was sent, queues the PDF email (within the 3 MB total email attachment limit), and records an immutable audit entry.

- **Cancelling an unpaid request:** While a request has no unreversed receipts, authorised staff can cancel it with a written reason. Cancelling a request stops its automated payment reminders straight away, and cancelled requests do not count towards cleared funds.

## 2. Automated payment reminders

If your firm has turned on automated Money on Account reminders, sending a payment request begins a follow-up schedule:

1. **First reminder (7 days after sending by default):** Queues a polite reminder email repeating the transfer reference and requested amount.
2. **Second reminder (14 days after sending by default):** Queues a second reminder email if funds are still awaited.
3. **Fee-earner follow-up task (21 days after sending by default):** Raises an open follow-up task for an authorised member of the matter team (without disclosing restricted matters to anyone outside them).

- **Automatic stop:** Automated reminders stop immediately whenever cleared receipts cover the request amount in full, the request is cancelled, or the matter is closed, archived, or deleted.
- **Manual controls:** Authorised staff can click **Stop chasing** at any time, or use **Retry follow-up** if an escalation task needed an eligible team owner or recovered from a delivery issue.

## 3. Recording and matching client account receipts

To protect client money segregation, **recording, matching, and reversing Money on Account receipts is restricted exclusively to Finance, Partner, and Managing Partner roles**. Fee earners, legal secretaries, risk and compliance officers, and administrators cannot record, match, or reverse receipts.

### Recording a receipt manually

1. Open the matter’s **Overview** tab and scroll to **Money on Account**.
2. In **Record Money on Account receipt**, select the open payment request, confirm the exact **Amount received (£)** and **Date received**, and optionally enter the bank transfer reference and a Finance note.
3. **Optional payment proof:** You may attach a PDF, JPEG, or PNG bank transfer advice or remittance notice. Attached files pass a basic security check (which does not replace your firm’s antivirus tools), remain strictly linked to Money on Account proof, and stay completely separate from Client Due Diligence identity documents.
4. Click **Record receipt**.

### Matching an entry from the Practice Management System client ledger

When a matter is linked to your firm’s Practice Management System and positive client-account receipts exist that have not yet been allocated:

1. In **Match unmatched PMS client account receipt**, choose the incoming client ledger receipt and the target Money on Account request, then click **Match PMS receipt**.
2. Matched ledger amounts are read in exact pennies. Outgoing payments, transfers to office, and negative adjustments cannot be matched as incoming client funds, and each Practice Management System receipt transaction can only be linked to one active receipt at a time.

### Reversing a receipt

If a payment bounces, was entered against the wrong matter, or was recorded in error, Finance, Partners, or Managing Partners can click **Reverse** next to that receipt and enter a written reason (minimum 5 characters):

- Reversing a receipt reduces the cleared balance on the request, reopens a matched Practice Management System ledger entry so it can be matched accurately elsewhere, and updates the **Money on Account** summary.
- **Important — after a matter has opened:** Reversing a receipt **after** a matter has already moved to **Open** updates the financial record and audit trail cleanly, **but does not reopen or rewind the matter opening gate**. Once a matter is **Open**, it remains open unless closed through the normal closure workflow.

## 4. The Funds on account opening check

Work types configured by your firm to require cleared funds upfront (such as **Residential Conveyancing** and **Dispute Resolution** matters) display **Funds on account** inside **Matter opening checklist & gate**:

- **How the check is satisfied:** Cleared unreversed receipts across non-cancelled Money on Account requests must cover the required agreed amount (taken from the accepted quote’s Payment on Account or the matter’s agreed payment on account, defaulting to the requested amount if no upfront figure was set). Partial payments or smaller requests than the agreed amount keep the gate **Blocked**.
- **Client privacy for Finance staff:** While Finance users can inspect **Funds on account**, **Conflict check**, and **Signed engagement letter** progress on the opening checklist for accessible matters, confidential **Client Due Diligence** verdicts and identity documents remain hidden as **Not available to you**.
- **Partner override:** Partners and Managing Partners can record an audited override for **Funds on account** with a written reason of at least 10 characters where firm policy permits opening ahead of cleared funds.

## 5. Client account bank details and audit controls

Your firm’s Money on Account configuration (including whether the feature is turned on, payment reference prefix, and masked client account bank details) is displayed read-only under **Administration → Email Outbox**.

- **Multi-factor authentication & audit logging:** Any change to your firm’s client account bank details requires verified administrator multi-factor authentication and writes an immutable entry to the firm audit log showing who made the change, when, the reason, and the old and new values with all but the last two digits of the sort code and account number masked.
- **Live protection:** Demonstration placeholder bank details are automatically rejected in live client deployments so clients can never be sent invalid test bank details.
`.trim(),
};
