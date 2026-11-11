// Shared Platform Infrastructure Module (ADR 0024, ADR 0028, ADR 0030)
// Provisions the VNet, Private DNS zones, Log Analytics + Application Insights + job failure alert,
// least-privilege runtime vs migrate User-Assigned Managed Identities, platform Key Vault (Private Endpoint),
// shared PostgreSQL Flexible Server (Entra ID auth only, explicit PgBouncer TRANSACTION pooling),
// Azure Container Apps environment, web app, optional internal PDF converter, and Container Apps jobs.

@description('Deployment environment')
@allowed([
  'dev'
  'test'
  'training'
  'demo'
  'live'
])
param environment string

@description('Tenancy mode: single_tenant (Model A) or multi_tenant (Model B)')
@allowed([
  'single_tenant'
  'multi_tenant'
])
param hostingMode string

@description('Primary Azure region')
param location string

@description('Short naming stem for platform-scoped resources (for example "platform" in Model B or tenant slug in Model A)')
@minLength(2)
param platformSlug string

@description('Virtual network CIDR address prefix (parameterised per environment/spoke to avoid hub-and-spoke peering collisions)')
param vnetAddressPrefix string = '10.24.0.0/16'

@description('Subnet CIDR prefix (/27 or larger) delegated to Azure Container Apps workload-profiles environment')
param containerAppsSubnetPrefix string = '10.24.0.0/27'

@description('Subnet CIDR prefix (/28 or larger) delegated to Azure Database for PostgreSQL Flexible Server')
param postgresSubnetPrefix string = '10.24.1.0/28'

@description('Subnet CIDR prefix for Private Endpoints (Key Vault and Blob Storage)')
param privateEndpointsSubnetPrefix string = '10.24.2.0/27'

@description('Name of the Azure Container Registry hosting the immutable application image')
@minLength(5)
@maxLength(50)
param containerRegistryName string

@description('Immutable container image reference (registry/repository@sha256:... or tag) for the web app and jobs')
@minLength(1)
param appContainerImage string

@description('Whether to deploy the optional headless LibreOffice PDF converter internal Container App')
param enablePdfConverterContainerApp bool = false

@description('Container image reference for the internal PDF converter Container App (used when enablePdfConverterContainerApp is true)')
param pdfConverterContainerImage string = ''

@description('Whether to deploy the manual store-import Container Apps job used during S0-14..S0-18 cut-overs (retired in S0-20)')
param enableStoreImportJob bool = true

@description('Master toggle for scheduled Container Apps jobs (enabled in S0-19)')
param enableSchedulerJobs bool = false

@description('Enable the hourly key-date-reminders scheduled Container Apps job (S0-19)')
param enableKeyDateRemindersJob bool = false

@description('Enable the hourly usage-retention-purge scheduled Container Apps job (S0-19)')
param enableUsageRetentionPurgeJob bool = false

@description('Enable the hourly enquiry-retention-anonymise scheduled Container Apps job (S0-19b)')
param enableEnquiryAnonymisationJob bool = false

@description('Microsoft Entra ID application (client) ID for OIDC sign-in (required; no empty default)')
@minLength(1)
param entraClientId string

@description('Microsoft Entra ID directory (tenant) ID for OIDC sign-in')
param entraTenantId string = subscription().tenantId

@description('Microsoft Entra ID OIDC callback redirect URI (required; no empty default)')
@minLength(1)
param entraRedirectUri string

@description('Tenant configuration package directory relative to application root')
@minLength(1)
param tenantPackageDir string

@description('Log Analytics retention period in days')
@minValue(30)
@maxValue(730)
param logAnalyticsRetentionDays int = environment == 'live' ? 90 : 30

@description('Daily ingestion cap in GB for Log Analytics (-1 for unlimited in live)')
param logAnalyticsDailyQuotaGb int = environment == 'live' ? -1 : 2

@description('Optional Azure Monitor Action Group resource ID to notify on Container Apps job failures or timeouts')
param alertActionGroupId string = ''

@description('PostgreSQL Flexible Server compute tier (Burstable for dev/test/demo, GeneralPurpose for training/live)')
@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
param postgresSkuTier string = (environment == 'live' || environment == 'training') ? 'GeneralPurpose' : 'Burstable'

@description('PostgreSQL Flexible Server compute SKU name')
param postgresSkuName string = (environment == 'live' || environment == 'training') ? 'Standard_D2ds_v5' : 'Standard_B1ms'

@description('PostgreSQL Flexible Server storage size in GB')
param postgresStorageSizeGb int = environment == 'live' ? 128 : 32

@description('PostgreSQL point-in-time backup retention in days')
@minValue(7)
@maxValue(35)
param postgresBackupRetentionDays int = environment == 'live' ? 35 : 7

@description('Geo-redundant backup mode for PostgreSQL Flexible Server')
@allowed([
  'Enabled'
  'Disabled'
])
param postgresGeoRedundantBackup string = environment == 'live' ? 'Enabled' : 'Disabled'

@description('Minimum running replicas for the web Container App (at least 1 per ADR 0024)')
@minValue(1)
param webMinReplicas int = 1

@description('Maximum replicas for the web Container App')
@minValue(1)
param webMaxReplicas int = 10

@description('Optional additional dedicated Container Apps workload profiles beyond Consumption')
param dedicatedWorkloadProfiles array = []

var sanitizedPlatformSlug = replace(platformSlug, '-', '')
var resourceSuffix = '${platformSlug}-${environment}'
var vnetResourceName = take('vnet-${resourceSuffix}', 60)
var logAnalyticsName = take('law-${resourceSuffix}', 63)
var appInsightsName = take('appi-${resourceSuffix}', 60)
var runtimeIdentityName = take('id-runtime-${resourceSuffix}', 60)
var migrateIdentityName = take('id-migrate-${resourceSuffix}', 60)
var platformKeyVaultName = take('kv-plat-${sanitizedPlatformSlug}-${environment}', 24)
var platformKvPeName = take('pe-${platformKeyVaultName}', 60)
var sharedPostgresServerName = take('psql-${resourceSuffix}', 63)
var containerAppsEnvName = take('cae-${resourceSuffix}', 60)
var webContainerAppName = take('ca-web-${resourceSuffix}', 32)
var pdfConverterAppName = take('ca-pdf-${resourceSuffix}', 32)
var migrateJobName = take('caj-migrate-${environment}', 32)
var storeImportJobName = take('caj-import-${environment}', 32)
var keyDateRemindersJobName = take('caj-kd-rem-${environment}', 32)
var usagePurgeJobName = take('caj-doc-prg-${environment}', 32)
var enquiryAnonymiseJobName = take('caj-enq-anon-${environment}', 32)
var jobFailureAlertRuleName = take('alrt-jobs-${resourceSuffix}', 60)

var keyVaultDnsSuffix = az.environment().suffixes.keyvaultDns
var keyVaultPrivateDnsZoneName = 'privatelink${replace(keyVaultDnsSuffix, '.vault.', '.vaultcore.')}'
var postgresPrivateDnsZoneName = 'privatelink.postgres.database.azure.com'
var blobPrivateDnsZoneName = 'privatelink.blob.${az.environment().suffixes.storage}'
var acrLoginServer = '${containerRegistryName}.${az.environment().suffixes.acrLoginServer}'

// Built-in Azure RBAC role definitions
var keyVaultSecretsUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)
var acrPullRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)
var monitoringMetricsPublisherRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '3913510d-42f4-4f42-8a64-420c390055eb'
)

var platformTags = {
  scope: 'platform'
  environment: environment
  hostingMode: hostingMode
}

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2025-04-01' existing = {
  name: containerRegistryName
}

// ---------------------------------------------------------------------------
// 1. Virtual Network & Private DNS Zones
// ---------------------------------------------------------------------------

resource vnet 'Microsoft.Network/virtualNetworks@2025-05-01' = {
  name: vnetResourceName
  location: location
  tags: platformTags
  properties: {
    addressSpace: {
      addressPrefixes: [
        vnetAddressPrefix
      ]
    }
    subnets: [
      {
        name: 'snet-aca'
        properties: {
          addressPrefix: containerAppsSubnetPrefix
          delegations: [
            {
              name: 'delegation-app-environments'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: 'snet-postgres'
        properties: {
          addressPrefix: postgresSubnetPrefix
          delegations: [
            {
              name: 'delegation-postgres-flexible'
              properties: {
                serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
              }
            }
          ]
        }
      }
      {
        name: 'snet-private-endpoints'
        properties: {
          addressPrefix: privateEndpointsSubnetPrefix
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource acaSubnet 'Microsoft.Network/virtualNetworks/subnets@2025-05-01' existing = {
  parent: vnet
  name: 'snet-aca'
}

resource postgresSubnet 'Microsoft.Network/virtualNetworks/subnets@2025-05-01' existing = {
  parent: vnet
  name: 'snet-postgres'
}

resource privateEndpointsSubnet 'Microsoft.Network/virtualNetworks/subnets@2025-05-01' existing = {
  parent: vnet
  name: 'snet-private-endpoints'
}

resource keyVaultPrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: keyVaultPrivateDnsZoneName
  location: 'global'
  tags: platformTags
}

resource keyVaultPrivateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: keyVaultPrivateDnsZone
  name: take('link-kv-${vnet.name}', 80)
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource postgresPrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: postgresPrivateDnsZoneName
  location: 'global'
  tags: platformTags
}

resource postgresPrivateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: postgresPrivateDnsZone
  name: take('link-pg-${vnet.name}', 80)
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource blobPrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: blobPrivateDnsZoneName
  location: 'global'
  tags: platformTags
}

resource blobPrivateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: blobPrivateDnsZone
  name: take('link-blob-${vnet.name}', 80)
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Two Least-Privilege User-Assigned Managed Identities (R402, ADR 0024 §3)
//    - runtimeIdentity: web, store-import & scheduled jobs (NOINHERIT login, never DB admin)
//    - migrateIdentity: PostgreSQL Entra administrator, attached ONLY to migrate job
// ---------------------------------------------------------------------------

resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: runtimeIdentityName
  location: location
  tags: platformTags
}

resource migrateIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: migrateIdentityName
  location: location
  tags: platformTags
}

resource runtimeAcrPullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(containerRegistry.id, runtimeIdentity.id, '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  scope: containerRegistry
  properties: {
    roleDefinitionId: acrPullRoleDefinitionId
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource migrateAcrPullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(containerRegistry.id, migrateIdentity.id, '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  scope: containerRegistry
  properties: {
    roleDefinitionId: acrPullRoleDefinitionId
    principalId: migrateIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------------------------------------------------------------------
// 3. Platform Key Vault (platform-wide secrets only; Private Endpoint only)
// ---------------------------------------------------------------------------

resource platformKeyVault 'Microsoft.KeyVault/vaults@2025-05-01' = {
  name: platformKeyVaultName
  location: location
  tags: platformTags
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      bypass: 'None'
      defaultAction: 'Deny'
    }
  }
}

resource platformKeyVaultPrivateEndpoint 'Microsoft.Network/privateEndpoints@2025-05-01' = {
  name: platformKvPeName
  location: location
  tags: platformTags
  properties: {
    subnet: {
      id: privateEndpointsSubnet.id
    }
    privateLinkServiceConnections: [
      {
        name: '${platformKvPeName}-conn'
        properties: {
          privateLinkServiceId: platformKeyVault.id
          groupIds: [
            'vault'
          ]
        }
      }
    ]
  }
}

resource platformKeyVaultDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2025-05-01' = {
  parent: platformKeyVaultPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'privatelink-vaultcore'
        properties: {
          privateDnsZoneId: keyVaultPrivateDnsZone.id
        }
      }
    ]
  }
  dependsOn: [
    keyVaultPrivateDnsLink
  ]
}

resource runtimePlatformKvSecretsUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(platformKeyVault.id, runtimeIdentity.id, '4633458b-17de-408a-b874-0445c86b69e6')
  scope: platformKeyVault
  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------------------------------------------------------------------
// 4. Observability: Log Analytics, Application Insights & Job Failure Alert (R412)
// ---------------------------------------------------------------------------

resource logAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2025-07-01' = {
  name: logAnalyticsName
  location: location
  tags: platformTags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: logAnalyticsRetentionDays
    workspaceCapping: {
      dailyQuotaGb: logAnalyticsDailyQuotaGb
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  tags: platformTags
  properties: {
    Application_Type: 'web'
    IngestionMode: 'LogAnalytics'
    WorkspaceResourceId: logAnalyticsWorkspace.id
    DisableLocalAuth: true
  }
}

// Local (instrumentation-key) auth is disabled, so telemetry must authenticate with
// Entra ID: each identity that emits telemetry needs Monitoring Metrics Publisher (R422).
resource runtimeAppInsightsMetricsPublisherRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(appInsights.id, runtimeIdentity.id, '3913510d-42f4-4f42-8a64-420c390055eb')
  scope: appInsights
  properties: {
    roleDefinitionId: monitoringMetricsPublisherRoleDefinitionId
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource migrateAppInsightsMetricsPublisherRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(appInsights.id, migrateIdentity.id, '3913510d-42f4-4f42-8a64-420c390055eb')
  scope: appInsights
  properties: {
    roleDefinitionId: monitoringMetricsPublisherRoleDefinitionId
    principalId: migrateIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource jobFailureAlertRule 'Microsoft.Insights/scheduledQueryRules@2026-03-01' = {
  name: jobFailureAlertRuleName
  location: location
  tags: platformTags
  properties: {
    description: 'Raises an alert whenever a 1Squared Container Apps job (migrate, store-import, key-date-reminders, usage-retention-purge, enquiry-retention-anonymise) fails or times out (ADR 0030 §7).'
    enabled: true
    evaluationFrequency: 'PT5M'
    scopes: [
      logAnalyticsWorkspace.id
    ]
    severity: 2
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '''
union
  (ContainerAppSystemLogs_CL
    | where JobName_s startswith "caj-"
    | where Reason_s in ("BackOffLimitExceeded", "DeadlineExceeded", "Failed") or Log_s has_any ("Job execution failed", "DeadlineExceeded")),
  (AppTraces
    | where Properties has "job.tenant.failed"),
  (AppExceptions
    | where Properties has "jobKey")
'''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: !empty(alertActionGroupId)
        ? [
            alertActionGroupId
          ]
        : []
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Shared PostgreSQL Flexible Server (ADR 0028 §1, R401, R402)
//    - Entra ID sign-in only (passwordAuth Disabled), migrateIdentity ONLY as admin
//    - Explicit PgBouncer TRANSACTION pooling on port 6432; TLS 1.2+ enforced
//    - Platform-managed encryption key (recorded exception to Standard §8.5;
//      tenants needing own/CMK keys set deployDedicatedPostgresServer: true)
// ---------------------------------------------------------------------------

resource sharedPostgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' = {
  name: sharedPostgresServerName
  location: location
  tags: platformTags
  sku: {
    name: postgresSkuName
    tier: postgresSkuTier
  }
  properties: {
    version: '16'
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Disabled'
      tenantId: subscription().tenantId
    }
    network: {
      delegatedSubnetResourceId: postgresSubnet.id
      privateDnsZoneArmResourceId: postgresPrivateDnsZone.id
      publicNetworkAccess: 'Disabled'
    }
    storage: {
      storageSizeGB: postgresStorageSizeGb
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: postgresBackupRetentionDays
      geoRedundantBackup: postgresGeoRedundantBackup
    }
    highAvailability: {
      mode: environment == 'live' ? 'ZoneRedundant' : 'Disabled'
    }
  }
  dependsOn: [
    postgresPrivateDnsLink
  ]
}

module sharedPostgresEntraAdmin 'postgres-entra-admin.bicep' = {
  name: take('deploy-pg-admin-${sharedPostgresServer.name}', 64)
  params: {
    serverName: sharedPostgresServer.name
    principalId: migrateIdentity.properties.principalId
    principalName: migrateIdentity.name
    tenantId: subscription().tenantId
  }
}

resource pgRequireSecureTransport 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: sharedPostgresServer
  name: 'require_secure_transport'
  properties: {
    value: 'ON'
    source: 'user-override'
  }
}

resource pgMinTlsVersion 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: sharedPostgresServer
  name: 'ssl_min_protocol_version'
  properties: {
    value: 'TLSv1.2'
    source: 'user-override'
  }
  dependsOn: [
    pgRequireSecureTransport
  ]
}

resource pgBouncerEnabled 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: sharedPostgresServer
  name: 'pgbouncer.enabled'
  properties: {
    value: 'true'
    source: 'user-override'
  }
  dependsOn: [
    pgMinTlsVersion
  ]
}

resource pgBouncerPoolMode 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: sharedPostgresServer
  name: 'pgbouncer.pool_mode'
  properties: {
    value: 'TRANSACTION'
    source: 'user-override'
  }
  dependsOn: [
    pgBouncerEnabled
  ]
}

// ---------------------------------------------------------------------------
// 6. Azure Container Apps Environment, Web App, Internal PDF Converter & Jobs
// ---------------------------------------------------------------------------

resource containerAppsEnv 'Microsoft.App/managedEnvironments@2025-07-01' = {
  name: containerAppsEnvName
  location: location
  tags: platformTags
  properties: {
    vnetConfiguration: {
      infrastructureSubnetId: acaSubnet.id
      internal: false
    }
    workloadProfiles: concat(
      [
        {
          name: 'Consumption'
          workloadProfileType: 'Consumption'
        }
      ],
      dedicatedWorkloadProfiles
    )
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsWorkspace.properties.customerId
        sharedKey: logAnalyticsWorkspace.listKeys().primarySharedKey
      }
    }
  }
}

var platformVaultUri = platformKeyVault.properties.vaultUri

var runtimeKeyVaultSecrets = [
  {
    name: 'entra-client-secret'
    keyVaultUrl: '${platformVaultUri}secrets/entra-client-secret'
    identity: runtimeIdentity.id
  }
  {
    name: 'auth-secret'
    keyVaultUrl: '${platformVaultUri}secrets/auth-secret'
    identity: runtimeIdentity.id
  }
  {
    name: 'blob-signing-key'
    keyVaultUrl: '${platformVaultUri}secrets/blob-signing-key'
    identity: runtimeIdentity.id
  }
  {
    name: 'ideal-postcodes-api-key'
    keyVaultUrl: '${platformVaultUri}secrets/ideal-postcodes-api-key'
    identity: runtimeIdentity.id
  }
  {
    name: 'anthropic-api-key'
    keyVaultUrl: '${platformVaultUri}secrets/anthropic-api-key'
    identity: runtimeIdentity.id
  }
]

var runtimeCommonEnv = [
  {
    name: 'NODE_ENV'
    value: 'production'
  }
  {
    name: 'PLATFORM_HOSTING_MODE'
    value: hostingMode
  }
  {
    name: 'PLATFORM_ENVIRONMENT'
    value: environment
  }
  {
    name: 'PLATFORM_TENANT_PACKAGE_DIR'
    value: tenantPackageDir
  }
  {
    name: 'PLATFORM_POSTGRES_HOST'
    value: sharedPostgresServer.properties.fullyQualifiedDomainName
  }
  {
    name: 'PLATFORM_POSTGRES_PORT'
    value: '6432'
  }
  {
    name: 'PLATFORM_POSTGRES_AUTH_MODE'
    value: 'entra_managed_identity'
  }
  {
    name: 'PLATFORM_POSTGRES_CLIENT_ID'
    value: runtimeIdentity.properties.clientId
  }
  {
    name: 'PLATFORM_POSTGRES_USER'
    value: runtimeIdentity.name
  }
  {
    name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
    value: appInsights.properties.ConnectionString
  }
  {
    name: 'AZURE_CLIENT_ID'
    value: runtimeIdentity.properties.clientId
  }
]

var webSecretEnv = [
  {
    name: 'ENTRA_CLIENT_ID'
    value: entraClientId
  }
  {
    name: 'ENTRA_TENANT_ID'
    value: entraTenantId
  }
  {
    name: 'ENTRA_REDIRECT_URI'
    value: entraRedirectUri
  }
  {
    name: 'ENTRA_CLIENT_SECRET'
    secretRef: 'entra-client-secret'
  }
  {
    name: 'AUTH_SECRET'
    secretRef: 'auth-secret'
  }
  {
    name: 'PLATFORM_BLOB_SIGNING_KEY'
    secretRef: 'blob-signing-key'
  }
  {
    name: 'IDEAL_POSTCODES_API_KEY'
    secretRef: 'ideal-postcodes-api-key'
  }
  {
    name: 'ANTHROPIC_API_KEY'
    secretRef: 'anthropic-api-key'
  }
]

var pdfConverterEnv = enablePdfConverterContainerApp
  ? [
      {
        name: 'DOC_CONVERTER_URL'
        value: 'https://${pdfConverterAppName}.internal.${containerAppsEnv.properties.defaultDomain}'
      }
    ]
  : []

resource pdfConverterContainerApp 'Microsoft.App/containerApps@2025-07-01' = if (enablePdfConverterContainerApp) {
  name: pdfConverterAppName
  location: location
  tags: platformTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${runtimeIdentity.id}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: false
        allowInsecure: false
        targetPort: 8080
        transport: 'auto'
      }
      registries: [
        {
          server: acrLoginServer
          identity: runtimeIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'pdf-converter'
          image: pdfConverterContainerImage
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 4
      }
    }
  }
  dependsOn: [
    runtimeAcrPullRole
  ]
}

resource webContainerApp 'Microsoft.App/containerApps@2025-07-01' = {
  name: webContainerAppName
  location: location
  tags: platformTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${runtimeIdentity.id}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 3000
        transport: 'auto'
      }
      registries: [
        {
          server: acrLoginServer
          identity: runtimeIdentity.id
        }
      ]
      secrets: runtimeKeyVaultSecrets
    }
    template: {
      containers: [
        {
          name: 'web'
          image: appContainerImage
          env: concat(runtimeCommonEnv, webSecretEnv, pdfConverterEnv)
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/login'
                port: 3000
              }
              initialDelaySeconds: 15
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/login'
                port: 3000
              }
              initialDelaySeconds: 10
              periodSeconds: 15
            }
          ]
        }
      ]
      scale: {
        minReplicas: webMinReplicas
        maxReplicas: webMaxReplicas
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ]
      }
    }
  }
  dependsOn: [
    runtimePlatformKvSecretsUserRole
    runtimeAcrPullRole
    runtimeAppInsightsMetricsPublisherRole
    platformKeyVaultDnsZoneGroup
    pgBouncerPoolMode
  ]
}

// Manual pre-traffic schema migration job: uses migrateIdentity and direct port 5432 (R401, R402, R403, R404)
resource migrateJob 'Microsoft.App/jobs@2025-07-01' = {
  name: migrateJobName
  location: location
  tags: platformTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${migrateIdentity.id}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 1800
      replicaRetryLimit: 0
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acrLoginServer
          identity: migrateIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: appContainerImage
          command: [
            'node'
            'dist/jobs/run-job.mjs'
            'migrate'
          ]
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'PLATFORM_HOSTING_MODE'
              value: hostingMode
            }
            {
              name: 'PLATFORM_ENVIRONMENT'
              value: environment
            }
            {
              name: 'PLATFORM_TENANT_PACKAGE_DIR'
              value: tenantPackageDir
            }
            {
              name: 'PLATFORM_POSTGRES_HOST'
              value: sharedPostgresServer.properties.fullyQualifiedDomainName
            }
            {
              name: 'PLATFORM_POSTGRES_PORT'
              value: '5432'
            }
            {
              name: 'PLATFORM_POSTGRES_MIGRATE_PORT'
              value: '5432'
            }
            {
              name: 'PLATFORM_POSTGRES_AUTH_MODE'
              value: 'entra_managed_identity'
            }
            {
              name: 'PLATFORM_POSTGRES_CLIENT_ID'
              value: migrateIdentity.properties.clientId
            }
            {
              name: 'PLATFORM_POSTGRES_USER'
              value: migrateIdentity.name
            }
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              value: appInsights.properties.ConnectionString
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: migrateIdentity.properties.clientId
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
    }
  }
  dependsOn: [
    migrateAcrPullRole
    migrateAppInsightsMetricsPublisherRole
    sharedPostgresEntraAdmin
  ]
}

// Manual cut-over store-import job: uses runtimeIdentity on PgBouncer port 6432 (R404, R407; retired in S0-20)
resource storeImportJob 'Microsoft.App/jobs@2025-07-01' = if (enableStoreImportJob) {
  name: storeImportJobName
  location: location
  tags: platformTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${runtimeIdentity.id}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 1800
      replicaRetryLimit: 0
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acrLoginServer
          identity: runtimeIdentity.id
        }
      ]
      secrets: runtimeKeyVaultSecrets
    }
    template: {
      containers: [
        {
          name: 'store-import'
          image: appContainerImage
          command: [
            'node'
            'dist/jobs/import-store.mjs'
          ]
          env: runtimeCommonEnv
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
    }
  }
  dependsOn: [
    runtimePlatformKvSecretsUserRole
    runtimeAcrPullRole
    runtimeAppInsightsMetricsPublisherRole
    pgBouncerPoolMode
  ]
}

// Hourly scheduled Container Apps jobs (disabled by default until S0-19 and S0-19b; ADR 0030, R404)
resource keyDateRemindersJob 'Microsoft.App/jobs@2025-07-01' = if (enableSchedulerJobs && enableKeyDateRemindersJob) {
  name: keyDateRemindersJobName
  location: location
  tags: platformTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${runtimeIdentity.id}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 1800
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: '0 * * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acrLoginServer
          identity: runtimeIdentity.id
        }
      ]
      secrets: runtimeKeyVaultSecrets
    }
    template: {
      containers: [
        {
          name: 'key-date-reminders'
          image: appContainerImage
          command: [
            'node'
            'dist/jobs/run-job.mjs'
            'key-date-reminders'
          ]
          env: runtimeCommonEnv
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
    }
  }
  dependsOn: [
    runtimePlatformKvSecretsUserRole
    runtimeAcrPullRole
    runtimeAppInsightsMetricsPublisherRole
    pgBouncerPoolMode
  ]
}

resource usageRetentionPurgeJob 'Microsoft.App/jobs@2025-07-01' = if (enableSchedulerJobs && enableUsageRetentionPurgeJob) {
  name: usagePurgeJobName
  location: location
  tags: platformTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${runtimeIdentity.id}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 1800
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: '0 * * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acrLoginServer
          identity: runtimeIdentity.id
        }
      ]
      secrets: runtimeKeyVaultSecrets
    }
    template: {
      containers: [
        {
          name: 'usage-retention-purge'
          image: appContainerImage
          command: [
            'node'
            'dist/jobs/run-job.mjs'
            'usage-retention-purge'
          ]
          env: runtimeCommonEnv
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
    }
  }
  dependsOn: [
    runtimePlatformKvSecretsUserRole
    runtimeAcrPullRole
    runtimeAppInsightsMetricsPublisherRole
    pgBouncerPoolMode
  ]
}

resource enquiryAnonymisationJob 'Microsoft.App/jobs@2025-07-01' = if (enableSchedulerJobs && enableEnquiryAnonymisationJob) {
  name: enquiryAnonymiseJobName
  location: location
  tags: platformTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${runtimeIdentity.id}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 1800
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: '0 * * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acrLoginServer
          identity: runtimeIdentity.id
        }
      ]
      secrets: runtimeKeyVaultSecrets
    }
    template: {
      containers: [
        {
          name: 'enquiry-retention-anonymise'
          image: appContainerImage
          command: [
            'node'
            'dist/jobs/run-job.mjs'
            'enquiry-retention-anonymise'
          ]
          env: runtimeCommonEnv
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
    }
  }
  dependsOn: [
    runtimePlatformKvSecretsUserRole
    runtimeAcrPullRole
    runtimeAppInsightsMetricsPublisherRole
    pgBouncerPoolMode
  ]
}

output vnetId string = vnet.id
output postgresSubnetId string = postgresSubnet.id
output privateEndpointsSubnetId string = privateEndpointsSubnet.id
output keyVaultPrivateDnsZoneId string = keyVaultPrivateDnsZone.id
output postgresPrivateDnsZoneId string = postgresPrivateDnsZone.id
output blobPrivateDnsZoneId string = blobPrivateDnsZone.id
output containerAppsEnvironmentId string = containerAppsEnv.id
output webContainerAppName string = webContainerApp.name
output webContainerAppFqdn string = webContainerApp.properties.configuration.ingress.fqdn
output pdfConverterContainerEnabled bool = enablePdfConverterContainerApp
output runtimeIdentityId string = runtimeIdentity.id
output runtimeIdentityPrincipalId string = runtimeIdentity.properties.principalId
output runtimeIdentityClientId string = runtimeIdentity.properties.clientId
output migrateIdentityId string = migrateIdentity.id
output migrateIdentityName string = migrateIdentity.name
output migrateIdentityPrincipalId string = migrateIdentity.properties.principalId
output migrateIdentityClientId string = migrateIdentity.properties.clientId
output platformKeyVaultName string = platformKeyVault.name
output platformKeyVaultUri string = platformKeyVault.properties.vaultUri
output applicationInsightsName string = appInsights.name
output jobFailureAlertRuleName string = jobFailureAlertRule.name
output sharedPostgresServerName string = sharedPostgresServer.name
output sharedPostgresServerFqdn string = sharedPostgresServer.properties.fullyQualifiedDomainName
output migrateJobName string = migrateJob.name
output storeImportJobName string = enableStoreImportJob ? storeImportJob.name : ''
