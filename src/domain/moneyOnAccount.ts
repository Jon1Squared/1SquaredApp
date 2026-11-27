import {
  resolveMoneyOnAccountConfiguration,
  type BankAccountDetailsConfig,
  type MoneyOnAccountConfiguration,
  type MoneyOnAccountRequestWordingsConfig,
  type TenantConfiguration,
} from '@platform/core';

/**
 * Resolves the effective firm Money on Account configuration by layering any
 * per-tenant `tenant_module_configs['money_on_account']` override onto validated
 * `TenantConfiguration.moneyOnAccount` defaults.
 */
export function resolveEffectiveMoneyOnAccountConfig(
  tenantConfig: Pick<TenantConfiguration, 'moneyOnAccount'> | null | undefined,
  override?: Partial<MoneyOnAccountConfiguration> | null,
): MoneyOnAccountConfiguration {
  const moneyOnAccount = tenantConfig?.moneyOnAccount;
  const clientAccount = moneyOnAccount?.clientAccount;
  const requestWordings = moneyOnAccount?.requestWordings;
  const normalizedBase: Partial<MoneyOnAccountConfiguration> | undefined =
    moneyOnAccount
      ? {
          enabled: moneyOnAccount.enabled,
          clientAccount: clientAccount
            ? ({
                accountName: clientAccount.accountName,
                bankName: clientAccount.bankName,
                sortCode: clientAccount.sortCode,
                accountNumber: clientAccount.accountNumber,
                iban: clientAccount.iban,
                bic: clientAccount.bic,
                allowDemoPlaceholderDetails:
                  clientAccount.allowDemoPlaceholderDetails,
              } satisfies BankAccountDetailsConfig)
            : undefined,
          requestEmailSubjectTemplate:
            moneyOnAccount.requestEmailSubjectTemplate,
          requestWordings: requestWordings
            ? ({
                introductoryParagraph: requestWordings.introductoryParagraph,
                bankTransferInstruction:
                  requestWordings.bankTransferInstruction,
                clientMoneyComplianceNote:
                  requestWordings.clientMoneyComplianceNote,
              } satisfies MoneyOnAccountRequestWordingsConfig)
            : undefined,
          paymentReferencePrefix: moneyOnAccount.paymentReferencePrefix,
        }
      : undefined;

  return resolveMoneyOnAccountConfiguration(
    normalizedBase
      ? { moneyOnAccount: normalizedBase as MoneyOnAccountConfiguration }
      : undefined,
    override,
  );
}
