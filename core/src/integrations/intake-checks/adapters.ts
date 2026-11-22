/**
 * Intake Check Configuration Resolver & Provider Factory (`core/src/integrations/intake-checks/adapters.ts`).
 *
 * Reads every `integrations.intakeChecks.*` configuration leaf explicitly and fails closed
 * on unknown provider values (ADR 0038, S1-D1).
 */

import type {
  DocumentStorageProvider,
  ESignatureProvider,
  IdentityVerificationProvider,
  IntakeCheckProviderMode,
  PaymentRequestProvider,
  SanctionsPepScreeningProvider,
  TenantConfiguration,
  TenantIntakeChecksIntegrationConfig,
} from '../../api/index';
import { TenantIntakeCheckRepository } from '../../tenancy/intakeCheckRepository';
import {
  IntakeCheckIntegrationError,
  ManualESignatureProvider,
  ManualIdentityVerificationProvider,
  ManualPaymentRequestProvider,
  ManualSanctionsPepScreeningProvider,
} from './manualProviders';

function assertManualProvider(
  checkName: string,
  value: unknown,
): IntakeCheckProviderMode {
  if (value === undefined || value === null || value === 'manual') {
    return 'manual';
  }
  throw new IntakeCheckIntegrationError(
    'INTAKE_CHECK_PROVIDER_NOT_SUPPORTED',
    `Unsupported provider "${String(value)}" for integrations.intakeChecks.${checkName}. Only "manual" is permitted in Stage 1.`,
  );
}

/**
 * Resolves `integrations.intakeChecks` from validated tenant configuration.
 * Reads every schema leaf directly so unused-configuration CI guards verify runtime coverage.
 */
export function resolveIntakeChecksIntegrationConfig(
  tenantConfig: TenantConfiguration,
): TenantIntakeChecksIntegrationConfig {
  const idVerificationProvider = assertManualProvider(
    'idVerification.provider',
    tenantConfig.integrations?.intakeChecks?.idVerification?.provider,
  );
  const sanctionsPepProvider = assertManualProvider(
    'sanctionsPep.provider',
    tenantConfig.integrations?.intakeChecks?.sanctionsPep?.provider,
  );
  const eSignatureProvider = assertManualProvider(
    'eSignature.provider',
    tenantConfig.integrations?.intakeChecks?.eSignature?.provider,
  );
  const paymentsProvider = assertManualProvider(
    'payments.provider',
    tenantConfig.integrations?.intakeChecks?.payments?.provider,
  );

  return {
    idVerification: { provider: idVerificationProvider },
    sanctionsPep: { provider: sanctionsPepProvider },
    eSignature: { provider: eSignatureProvider },
    payments: { provider: paymentsProvider },
  };
}

export interface TenantIntakeCheckProviders {
  readonly idVerification: IdentityVerificationProvider;
  readonly sanctionsPep: SanctionsPepScreeningProvider;
  readonly eSignature: ESignatureProvider;
  readonly payments: PaymentRequestProvider;
}

export function createTenantIntakeCheckProviders(params: {
  readonly tenantConfig: TenantConfiguration;
  readonly repository: TenantIntakeCheckRepository;
  readonly storageProvider: DocumentStorageProvider;
}): TenantIntakeCheckProviders {
  const cfg = resolveIntakeChecksIntegrationConfig(params.tenantConfig);
  const deps = {
    repository: params.repository,
    storageProvider: params.storageProvider,
  };

  if (
    cfg.idVerification.provider !== 'manual' ||
    cfg.sanctionsPep.provider !== 'manual' ||
    cfg.eSignature.provider !== 'manual' ||
    cfg.payments.provider !== 'manual'
  ) {
    throw new IntakeCheckIntegrationError(
      'INTAKE_CHECK_PROVIDER_NOT_SUPPORTED',
      'Only "manual" intake check providers are supported in Stage 1.',
    );
  }

  return {
    idVerification: new ManualIdentityVerificationProvider(deps),
    sanctionsPep: new ManualSanctionsPepScreeningProvider(deps),
    eSignature: new ManualESignatureProvider(deps),
    payments: new ManualPaymentRequestProvider(deps),
  };
}
