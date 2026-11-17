/**
 * Domain Errors for Tenant Outbound Email & Notification Integrations
 * (`core/src/integrations/email/errors.ts`).
 */

export class EmailIntegrationError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message.startsWith(`${code}:`) ? message : `${code}: ${message}`);
    this.name = 'EmailIntegrationError';
    this.code = code;
  }
}
