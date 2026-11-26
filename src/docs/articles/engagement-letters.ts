import type { DocArticle } from '../registry';

export const engagementLettersArticle: DocArticle = {
  slug: 'engagement-letters',
  title: 'Engagement letters, follow-ups & Email Outbox',
  section: 'documents-dms',
  summary:
    'How to send Client Care letters with PDFs attached, review queued emails and attachments in Administration, manage automatic reminders, upload signed copies to unlock the opening gate, and send Non-Engagement letters.',
  updated: '2026-11-26',
  body: `
This guide explains how **Client Care & engagement letters**, automated follow-up reminders, signed-copy uploads, **Non-Engagement letters**, and **Administration → Email Outbox** work across matters and enquiries.

## 1. Sending a Client Care letter from a matter

On any **Prospective** or **Active** matter (**Overview** tab), the **Client Care & engagement letter** panel lets an authorised user generate and queue a Client Care letter email with its PDF attached:

1. Check or update the **Recipient email** and **Recipient name** (pre-filled automatically from the instructing contact, client record, or originating enquiry).
2. Add an optional **Covering note** if you wish to include extra context for the client.
3. Click **Send Client Care letter**.
4. 1Squared generates a Client Care PDF using your firm’s configured standard terms, scope of work, fee information, and complaints procedure (including escalation to the Legal Ombudsman), attaches the PDF to an outbound email, records the dispatch history on the matter, and moves the matter’s engagement letter status to **Sent** with a server-stamped sent date.

- **Attachment size limit:** Outbound PDF attachments are capped at **3 MB** total per email so client mail servers accept them reliably.
- **No backwards movement:** Engagement letter status only moves forwards (from **Drafting** to **Drafted**, **Sent**, and **Signed & returned**). Once a letter is **Sent** or **Signed & returned**, editing the matter cannot move the status backwards.

## 2. Reviewing queued and sent emails in Email Outbox

Administrators with multi-factor authentication verified can open **Administration → Email Outbox** to inspect queued, sent, and blocked outbound emails across the firm:

- **Safe demonstration mode:** When outbound email delivery is paused on an environment (such as a demonstration deployment without an active sending mailbox), sent letters are still generated cleanly as PDFs and remain visible here in **Pending** status so reviewers can confirm recipient addresses, wording, and attached files without sending external email.
- **Strict matter and enquiry visibility:** Administrators only see emails linked to matters, quotes, and enquiries they are permitted to access. Restricted or ethically walled matters hidden from that administrator never appear in Email Outbox lists, message inspections, or attachment downloads.
- **Audit trail:** Opening a message with **Inspect** and downloading an attached PDF each write an entry to the firm’s audit log without changing the message’s delivery state.
- **Configuration summary:** Below the Email Outbox table, a read-only **Engagement & automated chasing settings** summary shows your firm’s active reminder timing and whether standard Client Care and Non-Engagement wording is configured.

## 3. Automated follow-ups and stopping reminders

Unless your firm disables engagement reminders in tenant configuration, sending a Client Care letter starts an automated follow-up schedule:

1. **First reminder (7 days after sending by default):** Queues a polite reminder email to the recipient asking them to return a signed copy.
2. **Second reminder (14 days after sending by default):** Queues a second reminder email if the letter is still unsigned.
3. **Fee-earner escalation task (21 days after sending by default):** Creates an open follow-up task assigned to the matter’s active fee earner (or supervisor/partner with matter access) so the team can contact the client directly.

- **Automatic stop:** As soon as a signed engagement copy is uploaded and recorded, active reminders stop automatically.
- **Manual stop:** While reminders remain active, authorised users can click **Stop chasing** on the **Client Care & engagement letter** panel to halt further reminders at any time.
- **Re-sending starts a fresh schedule:** Sending a fresh Client Care letter later starts a clean reminder cycle for the new dispatch without colliding with earlier stopped reminders.

## 4. Uploading a signed copy to unlock the opening gate

Marking an engagement letter as signed requires attaching proof of the client’s acceptance:

1. On the **Client Care & engagement letter** panel, go to **Record signed Client Care letter**.
2. Choose a clean **PDF, JPEG, or PNG** copy of the client’s signed letter (or photograph of the signed page), add an optional **Verification note**, and click **Upload signed copy & mark signed**.
3. The uploaded file goes through a basic security screen (which does not replace your firm’s antivirus tools), locks the signed status to **Signed & returned**, stamps the signed date, stops any active reminders, and satisfies the **Signed engagement letter** check on the **Matter opening checklist & gate**.
4. Once recorded, a **Download signed copy** link appears in the panel header for users permitted to view matter documents (including Finance staff for accessible matters, whilst Client Due Diligence identity documents remain strictly restricted to Client Due Diligence viewers).

## 5. Sending a Non-Engagement letter from an enquiry

When an active enquiry is closed as **Declined** (for any reason other than *Client went elsewhere*) or **Referred out**, 1Squared raises a **Send non-engagement letter** follow-up task automatically:

1. Open the closed enquiry and scroll to the **Non-Engagement letter** card.
2. Confirm or enter the enquirer’s **Recipient email** and **Recipient name**, then click **Send Non-Engagement letter**.
3. 1Squared selects wording tailored to the close reason (conflict of interest, outside our expertise, not viable, referred out, or general close), explicitly confirms that no solicitor–client relationship has been formed and warns about statutory time limits without revealing confidential conflict details when declined for conflict, generates a PDF attachment in Email Outbox, and closes any open **Send non-engagement letter** task as **Done** automatically.
`.trim(),
};
