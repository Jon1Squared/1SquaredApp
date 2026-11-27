import type { DocArticle } from '../registry';

export const quotesAndPricingArticle: DocArticle = {
  slug: 'quotes-and-pricing',
  title: 'Quotes, Price Transparency & automated follow-ups',
  section: 'enquiries',
  summary:
    'How to include Price Transparency wording and an upfront Payment on Account on quotes, download or email quote PDFs, record quotes sent offline, and manage automated quote follow-ups.',
  updated: '2026-11-27',
  body: `
This guide explains how **fee quotes**, **Price Transparency disclosures**, **Payment on Account requests**, **quote PDFs**, and **automated quote follow-ups** work from initial draft through to matter conversion.

## 1. Price Transparency wording in Administration

Administrators with multi-factor authentication verified can configure default and work-type-specific **Price Transparency & Service Information** under **Administration → Work types**:

1. Set firm default wording for your headline pricing summary, service scope, key stages, typical timescales, disbursements guidance, and exclusions or VAT notes, and choose whether Price Transparency disclosures are included by default.
2. Select any practice area or individual work type to override specific sections where specialist guidance applies. Badges next to each field show whether wording comes from the work type, the parent practice area, or the firm default, and **Use inherited** clears a field override back to the inherited wording.
3. When a quote is sent, its Price Transparency wording (together with any matter-specific note added by the fee earner) is frozen onto that quote version so later administration updates never rewrite historical quotes sent to clients.

## 2. Creating a quote with Payment on Account and disclosures

When creating or revising a quote from **New Quote** or **Revise quote**:

1. Complete the client or prospect details, work type, scope, professional fees, and any disbursements. If you plan to send the quote by email, include a valid email address for the client or prospect.
2. Tick **Request a Payment on Account before work begins** and enter the amount required on instruction if your firm needs funds on account before opening the matter.
3. Review the **Price Transparency disclosures** preview drawn automatically from your firm’s settings for the chosen work type, and add an optional **matter-specific pricing note** if extra context should appear on the quote PDF.

## 3. Downloading, emailing, or recording a quote as sent offline

From any quote page, or directly when saving a quote, you have three options:

- **Download PDF:** Generates an up-to-date PDF quote document containing the firm’s contact details, scope, assumptions, minor-unit fee and disbursement breakdown, any requested Payment on Account, and Price Transparency disclosures. Client due diligence outcomes are never included in quote PDFs.
- **Send Quote by Email:** Queues an email with the quote PDF attached (within the 3 MB total email attachment limit), freezes the Price Transparency snapshot onto the sent version, stamps the sent date and recipient address, and begins automated follow-up reminders when turned on. If live email delivery is paused on your environment, a banner confirms the email is safely queued in **Administration → Email Outbox** without sending external email.
- **Record as Sent Offline:** Use this when a quote is posted, handed over in person, or sent outside the system. The quote moves to **Sent** without queuing an email or starting automated follow-up reminders.

## 4. Automated quote follow-ups and stopping reminders

If your firm has turned on automated quote reminders, emailing a quote starts a follow-up schedule:

1. **First reminder (7 days after sending by default):** Queues a polite reminder email referring to the quote reference, version, and total.
2. **Second reminder (14 days after sending by default):** Queues a second reminder email if no outcome has been recorded.
3. **Fee-earner escalation task (21 days after sending by default):** Creates an open follow-up task for the quote’s fee earner or an eligible team lead permitted to see the quote.

- **Automatic stop:** Automated follow-ups stop immediately whenever the quote is marked **Accepted** or **Declined**, converted to a matter, revised into a new version, or expires past its valid-until date.
- **Manual stop & retries:** Authorised staff can click **Stop chasing** on the quote page at any time, or **Retry follow-up** if an escalation task needed an eligible owner or recovered from a delivery error.
- **Re-sending a revised quote:** Revising and emailing a new version stops reminders for the superseded version and begins a clean reminder schedule for the new version.

## 5. Carrying Payment on Account into a new matter

When an accepted quote is converted into a new matter, the requested Payment on Account amount carries over automatically into the **Costs & billing** section of the new matter form so finance and fee earners do not need to re-enter it.
`.trim(),
};
