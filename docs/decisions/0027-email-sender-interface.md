# ADR 0027: One EmailSender Interface with Per-Tenant Adapters

- **Date:** 2026-11-06
- **Status:** Accepted
- **Roadmap:** Stage 0 decision D9, slice S0-26 (`docs/roadmap/stage-0-plan.md`); backlog item 32

## Context

No email is ever sent today:
- The enquiry "Send email" action and the quote "Mark as sent" action only write audit entries.
- Credit-control reminders only write a note.
- Notifications are in-app only.

Demos need real email now. Hosted and client-hosted installations need different sending routes, and non-live environments must never email real people by accident.

## Decision

1. **A core interface.** `EmailSender` is exported from `@platform/core-api`:

   ```ts
   send(ctx: TenantContext, message: OutgoingEmail): Promise<EmailSendResult>
   ```

   `OutgoingEmail` carries the recipients, subject, HTML and text bodies, optional attachments by document reference, a correlation ID and a template key.
   - Sending is queued as a tenant-scoped background job. The job carries the tenant ID and refuses to run without it.
   - Logs and audit entries record the message ID, template key, recipient count and outcome. They never record message bodies or email addresses.

2. **Adapters, chosen per tenant in configuration.**

   | Adapter | Used for |
   |---|---|
   | `dev_catcher` (SMTP to Mailpit or similar) | dev and test |
   | `graph` (app-only `POST /users/{mailbox}/sendMail`) | Now: the demo tenant and pilots, sending from a 1Squared.co.uk shared mailbox. Later: client-hosted installations, sending from the firm's own mailbox. |
   | `acs` (Azure Communication Services Email) | The hosted service, later. A placeholder adapter for now. |
   | `disabled` | The default |

3. **Configuration.** This is an additive schema change, so it stays backward compatible within the major version (architecture rule 7):

   ```text
   integrations.email = {
     provider: 'disabled' | 'dev_catcher' | 'graph' | 'acs',
     senderAddress,
     replyTo?,
     graph?: { tenantId, clientId, certificateVaultRef },
     acs?: { connectionVaultRef },
     recipientAllowList: string[]
   }
   ```

   - Credentials are Key Vault references only.
   - When `environment !== 'live'`, `recipientAllowList` must not be empty. The sender drops any recipient that isn't on it, and audits the drop.

4. **Least privilege for Graph.**
   - The Entra app registration for email is separate from the sign-in and SharePoint registrations ([ADR 0018](./0018-two-identity-authentication-model.md)).
   - It is granted Mail.Send **only** through Exchange Online RBAC for Applications, scoped to the sending mailbox.
   - It has no tenant-wide Microsoft Graph Mail.Send consent.
   - It authenticates with a certificate held in Key Vault, not a client secret.

5. **Teams delivery comes later,** through the same notification service rather than through `EmailSender`.

## Alternatives Considered

- **SMTP AUTH to Exchange Online.** Rejected: Microsoft is retiring it, and it relies on passwords.
- **A third-party email provider now.** Not now: it adds another data processor before one is needed. Revisit it for the hosted service.
- **Tenant-wide Graph Mail.Send.** Rejected: it would allow sending as any mailbox in the tenant.

## Consequences

- Demo and pilot email passes through 1Squared's Microsoft 365 tenant. Before this is turned on for a pilot holding real firm data, the data processing terms must cover it.
- Some setup must be done by hand: the shared mailbox, the app registration, the Exchange RBAC scope, and SPF, DKIM and DMARC. That blocks the live Graph adapter, but not the interface or the dev catcher.
- Enquiry email, quote sending and credit-control reminders are connected to the interface in stage 1.
