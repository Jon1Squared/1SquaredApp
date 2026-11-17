/**
 * Domain Errors for Tenant Microsoft Teams Activity Feed Integrations
 * (`core/src/integrations/teams/errors.ts`).
 */

export class TeamsIntegrationError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message.startsWith(`${code}:`) ? message : `${code}: ${message}`);
    this.name = 'TeamsIntegrationError';
    this.code = code;
  }
}
