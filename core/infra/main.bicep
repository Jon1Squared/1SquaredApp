// Platform Infrastructure as Code Orchestrator (ADR 0024, ADR 0028, ADR 0030)
// Supports both Model A (single_tenant in client Azure) and Model B (multi_tenant hosted in UK South/UK West)
// from a single Bicep entry point composing:
// - modules/platform.bicep (shared compute, VNet, Private DNS, observability, alerts, PostgreSQL, jobs)
// - modules/tenant.bicep (per-tenant Key Vault Private Endpoint, database, optional dedicated server, Blob storage & cost tags)

type TenantDeploymentInput = {
  @description('Tenant identifier slug')
  @minLength(2)
  slug: string

  @description('Cost centre code for Azure billing attribution')
  @minLength(1)
  costCentre: string

  @description('Optional operational owner tag value')
  ownerTag: string?

  @description('Whether to provision a dedicated PostgreSQL Flexible Server for own/CMK encryption keys')
  deployDedicatedPostgresServer: bool?

  @description('Optional Key Vault key URI for CMK encryption on a dedicated PostgreSQL server')
  dedicatedPostgresCmkKeyUri: string?

  @description('Optional User-Assigned Managed Identity resource ID for dedicated PostgreSQL CMK')
  dedicatedPostgresCmkIdentityId: string?

  @description('Whether to provision per-tenant Azure Blob Storage and Defender for Storage')
  enableCloudBlobStorage: bool?
}

@description('Deployment environment')
@allowed([
  'dev'
  'test'
  'training'
  'demo'
  'live'
])
param environment string = 'dev'

@description('Tenancy mode: single_tenant (Model A) or multi_tenant (Model B)')
@allowed([
  'single_tenant'
  'multi_tenant'
])
param hostingMode string = 'multi_tenant'

@description('Primary Azure UK region')
param location string = 'uksouth'

@description('Primary tenant slug (used directly in Model A or as default single-entry fallback when tenants is empty)')
@minLength(2)
param tenantSlug string

@description('Default cost centre code when tenants array is omitted')
@minLength(1)
param defaultCostCentre string = 'CC-PLATFORM'

@description('Per-tenant deployment entries for Model B hosted multi-tenant environments (defaults to [tenantSlug] when empty)')
param tenants TenantDeploymentInput[] = []

@description('Two-stage deployment toggle: false deploys foundation (VNet, DNS, ACR, Key Vaults, Identities, PostgreSQL, Storage); true also deploys Container Apps Environment, web app, and jobs')
param deployApps bool = true

@description('Name of the Azure Container Registry hosting the immutable application image (defaults to a globally unique name per resource group and environment)')
@minLength(5)
@maxLength(50)
param containerRegistryName string = 'acronesquared${environment}${take(uniqueString(resourceGroup().id), 6)}'

@description('Immutable container image reference for the web Container App and jobs (required when deployApps is true)')
param appContainerImage string = ''

@description('Whether to provision Azure Blob Storage & Defender for Storage malware scanning by default')
param enableCloudBlobStorage bool = false

@description('Monthly GB cap for Microsoft Defender for Storage on-upload malware scanning')
param defenderMalwareScanCapGbPerMonth int = 500

@description('Whether to deploy the internal headless LibreOffice PDF converter Container App (ca-pdf, Stage 1 item 46; disabled by default until image is pushed to ACR)')
param enablePdfConverterContainerApp bool = false

@description('Container image reference for the internal headless LibreOffice PDF converter Container App (required non-empty if enablePdfConverterContainerApp is true)')
param pdfConverterContainerImage string = ''

@description('Minimum running replicas for the internal PDF converter Container App (0 scales to zero; set 1+ in busy environments to eliminate cold starts)')
@minValue(0)
@maxValue(4)
param pdfConverterMinReplicas int = 0

@description('Runtime document storage provider configured for the web app (ADR 0008, ADR 0024)')
@allowed([
  'local-fs'
  'azure-blob'
])
param documentStorageProvider string = environment == 'live' ? 'azure-blob' : 'local-fs'

@description('Minimum running replicas for the web Container App (at least 1 per ADR 0024)')
@minValue(1)
param webMinReplicas int = 1

@description('Maximum replicas for the web Container App (pinned to 1 across all environments while documentStorageProvider is local-fs per ADR 0008)')
@minValue(1)
param webMaxReplicas int = documentStorageProvider == 'local-fs' ? 1 : 10

@description('Master toggle for scheduled Container Apps jobs (enabled in S0-19)')
param enableSchedulerJobs bool = true

@description('Enable the hourly key-date-reminders scheduled Container Apps job (S0-19)')
param enableKeyDateRemindersJob bool = true

@description('Enable the hourly usage-retention-purge scheduled Container Apps job (S0-19)')
param enableUsageRetentionPurgeJob bool = true

@description('Enable the hourly enquiry-retention-anonymise scheduled Container Apps job (S0-19b)')
param enableEnquiryAnonymisationJob bool = true

@description('Enable the hourly register-reminders scheduled Container Apps job (S0-24)')
param enableRegisterRemindersJob bool = true

@description('Enable the 5-minute outbox-drain scheduled Container Apps job (S0-26)')
param enableOutboxDrainJob bool = true

@description('Enable the hourly notification-digests scheduled Container Apps job (ADR 0035, S0-29)')
param enableNotificationDigestsJob bool = true

@description('Enable the hourly quote-expiry scheduled Container Apps job (S1-02a, R663)')
param enableQuoteExpiryJob bool = true

@description('Enable the hourly communication-chases scheduled Container Apps job (ADR 0042, S1-06)')
param enableCommunicationChasesJob bool = true

@description('Enable the manual seed-demo Container Apps job (non-live environments only; forbidden in live)')
param enableSeedDemoJob bool = environment != 'live'

@description('Whether the optional ideal-postcodes-api-key secret exists in the Platform Key Vault and should be mounted into the web Container App')
param enableIdealPostcodesSecret bool = false

@description('Whether the optional anthropic-api-key secret exists in the Platform Key Vault and should be mounted into the web Container App')
param enableAnthropicSecret bool = false

@description('Microsoft Entra ID application (client) ID for OIDC sign-in (required; no empty default)')
@minLength(1)
param entraClientId string

@description('Microsoft Entra ID directory (tenant) ID for OIDC sign-in')
param entraTenantId string = subscription().tenantId

@description('Microsoft Entra ID OIDC callback redirect URI (updated to https://<fqdn>/api/auth/callback/microsoft-entra-id once the web Container App FQDN is known)')
@minLength(1)
param entraRedirectUri string = 'https://placeholder.invalid/api/auth/callback/microsoft-entra-id'

@description('Tenant configuration package directory relative to application root')
param tenantPackageDir string = 'client-${tenantSlug}'

@description('Virtual network CIDR address prefix')
param vnetAddressPrefix string = '10.24.0.0/16'

@description('Subnet CIDR prefix (/27 or larger) delegated to Azure Container Apps')
param containerAppsSubnetPrefix string = '10.24.0.0/27'

@description('Subnet CIDR prefix (/28 or larger) delegated to PostgreSQL Flexible Server')
param postgresSubnetPrefix string = '10.24.1.0/28'

@description('Subnet CIDR prefix for Private Endpoints')
param privateEndpointsSubnetPrefix string = '10.24.2.0/27'

@description('Optional Azure Monitor Action Group resource ID to notify on Container Apps job failures or timeouts')
param alertActionGroupId string = ''

@description('Email address for the provisioned Azure Monitor Action Group receiving job-failure alerts (required in demo and live unless alertActionGroupId is supplied)')
param alertRecipientEmail string = ''

var platformSlug = hostingMode == 'single_tenant' ? tenantSlug : 'platform'

var effectiveTenants TenantDeploymentInput[] = !empty(tenants)
  ? tenants
  : [
      {
        slug: tenantSlug
        costCentre: defaultCostCentre
        deployDedicatedPostgresServer: false
        enableCloudBlobStorage: enableCloudBlobStorage
      }
    ]

module platform 'modules/platform.bicep' = {
  name: 'deploy-platform-${platformSlug}-${environment}'
  params: {
    environment: environment
    hostingMode: hostingMode
    location: location
    platformSlug: platformSlug
    deployApps: deployApps
    vnetAddressPrefix: vnetAddressPrefix
    containerAppsSubnetPrefix: containerAppsSubnetPrefix
    postgresSubnetPrefix: postgresSubnetPrefix
    privateEndpointsSubnetPrefix: privateEndpointsSubnetPrefix
    containerRegistryName: containerRegistryName
    appContainerImage: appContainerImage
    enablePdfConverterContainerApp: enablePdfConverterContainerApp
    pdfConverterContainerImage: pdfConverterContainerImage
    pdfConverterMinReplicas: pdfConverterMinReplicas
    enableSchedulerJobs: enableSchedulerJobs
    enableKeyDateRemindersJob: enableKeyDateRemindersJob
    enableUsageRetentionPurgeJob: enableUsageRetentionPurgeJob
    enableEnquiryAnonymisationJob: enableEnquiryAnonymisationJob
    enableRegisterRemindersJob: enableRegisterRemindersJob
    enableOutboxDrainJob: enableOutboxDrainJob
    enableNotificationDigestsJob: enableNotificationDigestsJob
    enableQuoteExpiryJob: enableQuoteExpiryJob
    enableCommunicationChasesJob: enableCommunicationChasesJob
    enableSeedDemoJob: enableSeedDemoJob
    enableIdealPostcodesSecret: enableIdealPostcodesSecret
    enableAnthropicSecret: enableAnthropicSecret
    entraClientId: entraClientId
    entraTenantId: entraTenantId
    entraRedirectUri: entraRedirectUri
    tenantPackageDir: tenantPackageDir
    documentStorageProvider: documentStorageProvider
    webMinReplicas: webMinReplicas
    webMaxReplicas: webMaxReplicas
    alertActionGroupId: alertActionGroupId
    alertRecipientEmail: alertRecipientEmail
  }
}

module tenantDeployments 'modules/tenant.bicep' = [
  for tenant in effectiveTenants: {
    name: take('deploy-tenant-${tenant.slug}-${environment}', 64)
    params: {
      environment: environment
      hostingMode: hostingMode
      location: location
      tenantSlug: tenant.slug
      costCentre: tenant.costCentre
      ownerTag: tenant.?ownerTag ?? ''
      privateEndpointsSubnetId: platform.outputs.privateEndpointsSubnetId
      postgresSubnetId: platform.outputs.postgresSubnetId
      keyVaultPrivateDnsZoneId: platform.outputs.keyVaultPrivateDnsZoneId
      postgresPrivateDnsZoneId: platform.outputs.postgresPrivateDnsZoneId
      blobPrivateDnsZoneId: platform.outputs.blobPrivateDnsZoneId
      runtimeIdentityPrincipalId: platform.outputs.runtimeIdentityPrincipalId
      migrateIdentityPrincipalId: platform.outputs.migrateIdentityPrincipalId
      migrateIdentityName: platform.outputs.migrateIdentityName
      sharedPostgresServerName: platform.outputs.sharedPostgresServerName
      sharedPostgresServerFqdn: platform.outputs.sharedPostgresServerFqdn
      deployDedicatedPostgresServer: tenant.?deployDedicatedPostgresServer ?? false
      dedicatedPostgresCmkKeyUri: tenant.?dedicatedPostgresCmkKeyUri ?? ''
      dedicatedPostgresCmkIdentityId: tenant.?dedicatedPostgresCmkIdentityId ?? ''
      enableCloudBlobStorage: tenant.?enableCloudBlobStorage ?? enableCloudBlobStorage
      defenderMalwareScanCapGbPerMonth: defenderMalwareScanCapGbPerMonth
    }
  }
]

output hostingModeConfigured string = hostingMode
output primaryRegion string = location
output containerRegistryName string = platform.outputs.containerRegistryName
output containerRegistryLoginServer string = platform.outputs.containerRegistryLoginServer
output containerAppsEnvironmentId string = platform.outputs.containerAppsEnvironmentId
output webContainerAppName string = platform.outputs.webContainerAppName
output webContainerAppFqdn string = platform.outputs.webContainerAppFqdn
output pdfConverterContainerEnabled bool = platform.outputs.pdfConverterContainerEnabled
output runtimeIdentityClientId string = platform.outputs.runtimeIdentityClientId
output runtimeIdentityPrincipalId string = platform.outputs.runtimeIdentityPrincipalId
output migrateIdentityClientId string = platform.outputs.migrateIdentityClientId
output migrateIdentityPrincipalId string = platform.outputs.migrateIdentityPrincipalId
output platformKeyVaultName string = platform.outputs.platformKeyVaultName
output platformKeyVaultUri string = platform.outputs.platformKeyVaultUri
output applicationInsightsName string = platform.outputs.applicationInsightsName
output jobFailureAlertRuleName string = platform.outputs.jobFailureAlertRuleName
output sharedPostgresServerFqdn string = platform.outputs.sharedPostgresServerFqdn
output provisionJobName string = platform.outputs.provisionJobName
output migrateJobName string = platform.outputs.migrateJobName
output seedDemoJobName string = platform.outputs.seedDemoJobName
output tenantOutputs array = [
  for (tenant, idx) in effectiveTenants: {
    tenantSlug: tenantDeployments[idx].outputs.tenantSlug
    keyVaultName: tenantDeployments[idx].outputs.keyVaultName
    keyVaultUri: tenantDeployments[idx].outputs.keyVaultUri
    postgresDatabaseName: tenantDeployments[idx].outputs.postgresDatabaseName
    postgresHost: tenantDeployments[idx].outputs.postgresHost
    dedicatedPostgresDeployed: tenantDeployments[idx].outputs.dedicatedPostgresDeployed
    storageContainerName: tenantDeployments[idx].outputs.storageContainerName
    cloudBlobStorageEnabled: tenantDeployments[idx].outputs.cloudBlobStorageEnabled
  }
]
