/**
 * Document Store Provider Registry & Error Normalisation (`core/src/integrations/document-stores/index.ts`).
 *
 * Implements Section 1:
 * - Provider registry keyed by `DocumentStoreProviderType`:
 *   - `'sharepoint'` implemented (`SharePointDocumentStoreProvider`).
 *   - `'azure_blob'`, `'imanage'`, and `'netdocuments'` reserved in the schema enum and rejected
 *     with a clear "not yet supported" message.
 * - Normalises provider errors into the 7 domain error codes (`not_found`, `access_denied`,
 *   `conflict`, `throttled`, `unavailable`, `misconfigured`, `reauthentication_required`).
 */

import type {
  DocumentStoreConfig,
  DocumentStoreErrorCode,
  DocumentStoreErrorReason,
  DocumentStoreProvider,
  DocumentStoreProviderType,
  TenantContext,
} from '../../api/index';
import { MockSharePointGraphBackend } from './mockSharePointGraph';
import { SharePointDocumentStoreProvider } from './sharepointProvider';
import { DocumentStoreTokenService } from './tokenCache';

export * from './sharepointUrlParser';
export * from './tokenCache';
export * from './sharepointProvider';

export const RESERVED_UNSUPPORTED_DOCUMENT_STORE_PROVIDERS = new Set<DocumentStoreProviderType>([
  'azure_blob',
  'imanage',
  'netdocuments',
]);

export const GENERIC_USER_DOCUMENT_STORE_UNAVAILABLE_MESSAGE =
  'Documents for this matter are unavailable. Please contact your administrator.';

export interface NormalisedDocumentStoreError extends Error {
  code: DocumentStoreErrorCode;
  reason?: DocumentStoreErrorReason;
  userMessage: string;
  claimsChallenge?: string;
  retryAfterMs?: number;
}

const USER_FRIENDLY_ERROR_MESSAGES: Record<DocumentStoreErrorCode, string> = {
  not_found:
    'The requested folder or document could not be found in the document store.',
  access_denied:
    'You do not have permission in the document store to perform this action.',
  conflict:
    'A file or folder with that name already exists or was modified by another user.',
  throttled:
    'The document store is temporarily busy processing requests. Please try again in a moment.',
  unavailable:
    'The external document store is temporarily unavailable. Please try again shortly.',
  misconfigured: GENERIC_USER_DOCUMENT_STORE_UNAVAILABLE_MESSAGE,
  invalid_path:
    'The specified document store path or library does not match the routed matter configuration.',
  reauthentication_required:
    'Your document store session requires re-authentication or multi-factor verification. Please sign in again.',
};

/**
 * Normalises any provider or transport error into a structured `NormalisedDocumentStoreError`
 * with one of the 7 canonical domain error codes and a clear, non-technical `userMessage`.
 */
export function normaliseDocumentStoreError(
  err: unknown,
): NormalisedDocumentStoreError {
  const existingCode = (err as { code?: DocumentStoreErrorCode })?.code;
  const existingReason = (err as { reason?: DocumentStoreErrorReason })?.reason;
  const rawMessage =
    err instanceof Error
      ? err.message
      : typeof (err as { message?: unknown })?.message === 'string'
        ? (err as { message: string }).message
        : String(err ?? 'Unknown error');

  let code: DocumentStoreErrorCode = 'unavailable';
  if (existingCode && existingCode in USER_FRIENDLY_ERROR_MESSAGES) {
    code = existingCode;
  } else if (
    rawMessage.includes('404') ||
    rawMessage.toLowerCase().includes('not found')
  ) {
    code = 'not_found';
  } else if (
    rawMessage.includes('403') ||
    rawMessage.toLowerCase().includes('access denied') ||
    rawMessage.toLowerCase().includes('permission')
  ) {
    code = 'access_denied';
  } else if (
    rawMessage.includes('409') ||
    rawMessage.includes('412') ||
    rawMessage.toLowerCase().includes('already exists') ||
    rawMessage.toLowerCase().includes('conflict')
  ) {
    code = 'conflict';
  } else if (
    rawMessage.includes('429') ||
    rawMessage.toLowerCase().includes('throttl')
  ) {
    code = 'throttled';
  } else if (
    rawMessage.includes('AADSTS50076') ||
    rawMessage.toLowerCase().includes('reauthentication') ||
    rawMessage.toLowerCase().includes('interaction_required')
  ) {
    code = 'reauthentication_required';
  } else if (rawMessage.toLowerCase().includes('misconfigured')) {
    code = 'misconfigured';
  }

  const normalised = new Error(rawMessage) as NormalisedDocumentStoreError;
  normalised.code = code;
  if (existingReason) {
    normalised.reason = existingReason;
  }
  normalised.userMessage =
    existingReason === 'site_access_not_granted' ||
    existingReason === 'site_grant_role_insufficient' ||
    existingReason === 'excess_permissions_consented' ||
    existingReason === 'site_or_drive_mismatch' ||
    code === 'misconfigured'
      ? GENERIC_USER_DOCUMENT_STORE_UNAVAILABLE_MESSAGE
      : USER_FRIENDLY_ERROR_MESSAGES[code];
  const claimsChallenge = (err as { claimsChallenge?: string })
    ?.claimsChallenge;
  if (claimsChallenge) {
    normalised.claimsChallenge = claimsChallenge;
  }
  const retryAfterMs = (err as { retryAfterMs?: number })?.retryAfterMs;
  if (retryAfterMs !== undefined) {
    normalised.retryAfterMs = retryAfterMs;
  }
  return normalised;
}

export type DocumentStoreProviderFactory = (params: {
  tenantContext: TenantContext;
  storeConfig: DocumentStoreConfig;
  tokenService: DocumentStoreTokenService;
  backend: MockSharePointGraphBackend;
}) => DocumentStoreProvider;

/**
 * Registry of document store providers keyed by `DocumentStoreProviderType`.
 * Rejects reserved Phase 2 providers (`azure_blob`, `imanage`, `netdocuments`) with a clear
 * "not yet supported" error.
 */
export class DocumentStoreProviderRegistry {
  private readonly factories = new Map<
    DocumentStoreProviderType,
    DocumentStoreProviderFactory
  >();
  private readonly tokenService: DocumentStoreTokenService;
  private readonly backend: MockSharePointGraphBackend;

  public constructor(options?: {
    tokenService?: DocumentStoreTokenService;
    backend?: MockSharePointGraphBackend;
  }) {
    this.tokenService =
      options?.tokenService ?? new DocumentStoreTokenService();
    this.backend = options?.backend ?? new MockSharePointGraphBackend();

    this.register(
      'sharepoint',
      (params) => new SharePointDocumentStoreProvider(params),
    );
  }

  public getTokenService(): DocumentStoreTokenService {
    return this.tokenService;
  }

  public getMockBackend(): MockSharePointGraphBackend {
    return this.backend;
  }

  public register(
    providerType: DocumentStoreProviderType,
    factory: DocumentStoreProviderFactory,
  ): void {
    this.factories.set(providerType, factory);
  }

  public createProvider(
    tenantContext: TenantContext,
    storeConfig: DocumentStoreConfig,
  ): DocumentStoreProvider {
    if (!tenantContext?.tenantId) {
      throw normaliseDocumentStoreError({
        code: 'misconfigured',
        message:
          'TENANCY_ISOLATION_ERROR: Cannot instantiate DocumentStoreProvider without a TenantContext.',
      });
    }

    if (
      RESERVED_UNSUPPORTED_DOCUMENT_STORE_PROVIDERS.has(
        storeConfig.providerType,
      ) &&
      !this.factories.has(storeConfig.providerType)
    ) {
      throw normaliseDocumentStoreError({
        code: 'misconfigured',
        message: `Document store provider "${storeConfig.providerType}" is reserved in the configuration schema and is not yet supported in Phase 1.`,
      });
    }

    const factory = this.factories.get(storeConfig.providerType);
    if (!factory) {
      throw normaliseDocumentStoreError({
        code: 'misconfigured',
        message: `Unknown document store provider "${storeConfig.providerType}".`,
      });
    }

    return factory({
      tenantContext,
      storeConfig,
      tokenService: this.tokenService,
      backend: this.backend,
    });
  }
}
