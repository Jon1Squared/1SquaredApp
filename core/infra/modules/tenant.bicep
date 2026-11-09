// Per-Tenant Infrastructure Module (ADR 0024 §2, ADR 0028 §1, Standard §§7, 8 & 13)
// Provisioned once per tenant in both Model A (single_tenant) and Model B (multi_tenant):
// - Tenant Key Vault (24-char truncated name exported via keyVaultName/keyVaultUri, Private Endpoint only)
// - Optional dedicated PostgreSQL Flexible Server (own/CMK encryption key, explicit PgBouncer TRANSACTION mode)
// - Per-tenant PostgreSQL database (pg_tenant_<slug>_<environment>)
// - Optional per-tenant Azure Blob Storage + Defender for Storage malware scanning (Private Endpoint)
// - Mandatory per-tenant cost & governance tags on every resource (Standard §13)

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

@description('Tenant identifier slug')
@minLength(2)
param tenantSlug string

@description('Cost centre code for per-tenant Azure billing attribution (Standard §13)')
@minLength(1)
param costCentre string

@description('Optional operational owner tag value')
param ownerTag string = ''

@description('Resource ID of the Private Endpoints subnet in the platform VNet')
param privateEndpointsSubnetId string

@description('Resource ID of the PostgreSQL delegated subnet in the platform VNet')
param postgresSubnetId string

@description('Resource ID of the Key Vault Private DNS zone (privatelink.vaultcore.azure.net)')
param keyVaultPrivateDnsZoneId string

@description('Resource ID of the PostgreSQL Private DNS zone (privatelink.postgres.database.azure.com)')
param postgresPrivateDnsZoneId string

@description('Resource ID of the Blob Storage Private DNS zone')
param blobPrivateDnsZoneId string

@description('Principal ID of the shared/platform runtime User-Assigned Managed Identity (granted Key Vault Secrets User & Blob roles)')
param runtimeIdentityPrincipalId string

@description('Principal ID of the migrate User-Assigned Managed Identity (Entra admin on dedicated PostgreSQL servers)')
param migrateIdentityPrincipalId string

@description('Name of the migrate User-Assigned Managed Identity')
param migrateIdentityName string

@description('Name of the shared PostgreSQL Flexible Server (used when deployDedicatedPostgresServer is false)')
param sharedPostgresServerName string

@description('FQDN of the shared PostgreSQL Flexible Server (used when deployDedicatedPostgresServer is false)')
param sharedPostgresServerFqdn string

@description('Deploy a dedicated PostgreSQL Flexible Server for this tenant (for tenants requiring own or customer-managed encryption keys; ADR 0028 Decision 1)')
param deployDedicatedPostgresServer bool = false

@description('Compute tier for a dedicated PostgreSQL Flexible Server')
@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
param dedicatedPostgresSkuTier string = (environment == 'live' || environment == 'training') ? 'GeneralPurpose' : 'Burstable'

@description('Compute SKU name for a dedicated PostgreSQL Flexible Server')
param dedicatedPostgresSkuName string = (environment == 'live' || environment == 'training') ? 'Standard_D2ds_v5' : 'Standard_B1ms'

@description('Storage size in GB for a dedicated PostgreSQL Flexible Server')
param dedicatedPostgresStorageSizeGb int = environment == 'live' ? 128 : 32

@description('Backup retention days for a dedicated PostgreSQL Flexible Server')
@minValue(7)
@maxValue(35)
param dedicatedPostgresBackupRetentionDays int = environment == 'live' ? 35 : 7

@description('Geo-redundant backup setting for a dedicated PostgreSQL Flexible Server')
@allowed([
  'Enabled'
  'Disabled'
])
param dedicatedPostgresGeoRedundantBackup string = environment == 'live' ? 'Enabled' : 'Disabled'

@description('Optional Key Vault key URI for Customer-Managed Key (CMK) encryption on a dedicated PostgreSQL Flexible Server')
param dedicatedPostgresCmkKeyUri string = ''

@description('Optional User-Assigned Managed Identity resource ID holding Key Vault Crypto Service Encryption User for dedicated PostgreSQL CMK')
param dedicatedPostgresCmkIdentityId string = ''

@description('Whether to provision Azure Blob Storage & Defender for Storage malware scanning (false when using local-fs)')
param enableCloudBlobStorage bool = false

@description('Monthly GB cap for Microsoft Defender for Storage on-upload malware scanning')
param defenderMalwareScanCapGbPerMonth int = 500

var sanitizedSlug = replace(tenantSlug, '-', '')
var underscoredSlug = replace(tenantSlug, '-', '_')
var resourceSuffix = '${tenantSlug}-${environment}'
var keyVaultResourceName = take('kv-${sanitizedSlug}-${environment}', 24)
var keyVaultPeName = take('pe-${keyVaultResourceName}', 60)
var storageAccountName = take('st${sanitizedSlug}${environment}', 24)
var storagePeName = take('pe-${storageAccountName}', 60)
var containerName = 'tenant-${resourceSuffix}'
var dedicatedPostgresServerName = take('psql-${resourceSuffix}', 63)
var postgresDatabaseName = 'pg_tenant_${underscoredSlug}_${environment}'

var tenantTags = union(
  {
    tenant: tenantSlug
    environment: environment
    hostingMode: hostingMode
    costCentre: costCentre
  },
  !empty(ownerTag)
    ? {
        owner: ownerTag
      }
    : {}
)

var keyVaultSecretsUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)
var storageBlobDataContributorRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
)
var storageBlobDataDelegatorRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'db58b8e5-c6ad-4a2a-8342-4190687cbf4a'
)

// ---------------------------------------------------------------------------
// 1. Per-Tenant Key Vault + Private Endpoint (ADR 0024 §2 & AG3, R413)
// ---------------------------------------------------------------------------

resource keyVault 'Microsoft.KeyVault/vaults@2025-05-01' = {
  name: keyVaultResourceName
  location: location
  tags: tenantTags
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

resource keyVaultPrivateEndpoint 'Microsoft.Network/privateEndpoints@2025-05-01' = {
  name: keyVaultPeName
  location: location
  tags: tenantTags
  properties: {
    subnet: {
      id: privateEndpointsSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${keyVaultPeName}-conn'
        properties: {
          privateLinkServiceId: keyVault.id
          groupIds: [
            'vault'
          ]
        }
      }
    ]
  }
}

resource keyVaultDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2025-05-01' = {
  parent: keyVaultPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'privatelink-vaultcore'
        properties: {
          privateDnsZoneId: keyVaultPrivateDnsZoneId
        }
      }
    ]
  }
}

resource runtimeTenantKeyVaultSecretsUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, runtimeIdentityPrincipalId, '4633458b-17de-408a-b874-0445c86b69e6')
  scope: keyVault
  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
    principalId: runtimeIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------------------------------------------------------------------
// 2. Optional Dedicated PostgreSQL Flexible Server & Per-Tenant Database
//    (ADR 0028 Decision 1, R401, R402)
// ---------------------------------------------------------------------------

resource sharedPostgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' existing = if (!deployDedicatedPostgresServer) {
  name: sharedPostgresServerName
}

var useDedicatedCmk = deployDedicatedPostgresServer && !empty(dedicatedPostgresCmkKeyUri) && !empty(dedicatedPostgresCmkIdentityId)

resource dedicatedPostgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' = if (deployDedicatedPostgresServer) {
  name: dedicatedPostgresServerName
  location: location
  tags: tenantTags
  identity: useDedicatedCmk
    ? {
        type: 'UserAssigned'
        userAssignedIdentities: {
          '${dedicatedPostgresCmkIdentityId}': {}
        }
      }
    : {
        type: 'None'
      }
  sku: {
    name: dedicatedPostgresSkuName
    tier: dedicatedPostgresSkuTier
  }
  properties: {
    version: '16'
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Disabled'
      tenantId: subscription().tenantId
    }
    network: {
      delegatedSubnetResourceId: postgresSubnetId
      privateDnsZoneArmResourceId: postgresPrivateDnsZoneId
      publicNetworkAccess: 'Disabled'
    }
    storage: {
      storageSizeGB: dedicatedPostgresStorageSizeGb
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: dedicatedPostgresBackupRetentionDays
      geoRedundantBackup: dedicatedPostgresGeoRedundantBackup
    }
    dataEncryption: useDedicatedCmk
      ? {
          type: 'AzureKeyVault'
          primaryKeyURI: dedicatedPostgresCmkKeyUri
          primaryUserAssignedIdentityId: dedicatedPostgresCmkIdentityId
        }
      : {
          type: 'SystemManaged'
        }
    highAvailability: {
      mode: environment == 'live' ? 'ZoneRedundant' : 'Disabled'
    }
  }
}

resource dedicatedPostgresEntraAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2025-08-01' = if (deployDedicatedPostgresServer) {
  parent: dedicatedPostgresServer
  name: migrateIdentityPrincipalId
  properties: {
    principalName: migrateIdentityName
    principalType: 'ServicePrincipal'
    tenantId: subscription().tenantId
  }
}

resource dedicatedPgRequireSecureTransport 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = if (deployDedicatedPostgresServer) {
  parent: dedicatedPostgresServer
  name: 'require_secure_transport'
  properties: {
    value: 'ON'
    source: 'user-override'
  }
}

resource dedicatedPgMinTlsVersion 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = if (deployDedicatedPostgresServer) {
  parent: dedicatedPostgresServer
  name: 'ssl_min_protocol_version'
  properties: {
    value: 'TLSv1.2'
    source: 'user-override'
  }
  dependsOn: [
    dedicatedPgRequireSecureTransport
  ]
}

resource dedicatedPgBouncerEnabled 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = if (deployDedicatedPostgresServer) {
  parent: dedicatedPostgresServer
  name: 'pgbouncer.enabled'
  properties: {
    value: 'true'
    source: 'user-override'
  }
  dependsOn: [
    dedicatedPgMinTlsVersion
  ]
}

resource dedicatedPgBouncerPoolMode 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = if (deployDedicatedPostgresServer) {
  parent: dedicatedPostgresServer
  name: 'pgbouncer.pool_mode'
  properties: {
    value: 'TRANSACTION'
    source: 'user-override'
  }
  dependsOn: [
    dedicatedPgBouncerEnabled
  ]
}

resource sharedTenantDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2025-08-01' = if (!deployDedicatedPostgresServer) {
  parent: sharedPostgresServer
  name: postgresDatabaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

resource dedicatedTenantDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2025-08-01' = if (deployDedicatedPostgresServer) {
  parent: dedicatedPostgresServer
  name: postgresDatabaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
  dependsOn: [
    dedicatedPostgresEntraAdmin
    dedicatedPgBouncerPoolMode
  ]
}

// ---------------------------------------------------------------------------
// 3. Optional Per-Tenant Azure Blob Storage + Defender for Storage
// ---------------------------------------------------------------------------

resource storageAccount 'Microsoft.Storage/storageAccounts@2025-06-01' = if (enableCloudBlobStorage) {
  name: storageAccountName
  location: location
  tags: tenantTags
  sku: {
    name: 'Standard_ZRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      bypass: 'None'
      defaultAction: 'Deny'
    }
    encryption: {
      keySource: 'Microsoft.Storage'
      services: {
        blob: {
          enabled: true
          keyType: 'Account'
        }
      }
    }
  }
}

resource blobServices 'Microsoft.Storage/storageAccounts/blobServices@2025-06-01' = if (enableCloudBlobStorage) {
  parent: storageAccount
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: 30
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 30
    }
  }
}

resource tenantBlobContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01' = if (enableCloudBlobStorage) {
  parent: blobServices
  name: containerName
  properties: {
    publicAccess: 'None'
    metadata: {
      tenantSlug: tenantSlug
      environment: environment
      hostingMode: hostingMode
      costCentre: costCentre
    }
  }
}

resource storagePrivateEndpoint 'Microsoft.Network/privateEndpoints@2025-05-01' = if (enableCloudBlobStorage) {
  name: storagePeName
  location: location
  tags: tenantTags
  properties: {
    subnet: {
      id: privateEndpointsSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${storagePeName}-conn'
        properties: {
          privateLinkServiceId: storageAccount.id
          groupIds: [
            'blob'
          ]
        }
      }
    ]
  }
}

resource storageDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2025-05-01' = if (enableCloudBlobStorage) {
  parent: storagePrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'privatelink-blob'
        properties: {
          privateDnsZoneId: blobPrivateDnsZoneId
        }
      }
    ]
  }
}

resource runtimeStorageDelegatorRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableCloudBlobStorage) {
  name: guid(storageAccount.id, runtimeIdentityPrincipalId, 'db58b8e5-c6ad-4a2a-8342-4190687cbf4a')
  scope: storageAccount
  properties: {
    roleDefinitionId: storageBlobDataDelegatorRoleDefinitionId
    principalId: runtimeIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource runtimeContainerContributorRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableCloudBlobStorage) {
  name: guid(tenantBlobContainer.id, runtimeIdentityPrincipalId, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  scope: tenantBlobContainer
  properties: {
    roleDefinitionId: storageBlobDataContributorRoleDefinitionId
    principalId: runtimeIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource defenderForStorage 'Microsoft.Security/defenderForStorageSettings@2025-06-01' = if (enableCloudBlobStorage) {
  name: 'current'
  scope: storageAccount
  properties: {
    isEnabled: true
    malwareScanning: {
      onUpload: {
        isEnabled: true
        capGBPerMonth: defenderMalwareScanCapGbPerMonth
      }
    }
    sensitiveDataDiscovery: {
      isEnabled: false
    }
    overrideSubscriptionLevelSettings: true
  }
}

output tenantSlug string = tenantSlug
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
output keyVaultSecretsUserRoleAssignmentId string = runtimeTenantKeyVaultSecretsUserRole.id
output postgresDatabaseName string = postgresDatabaseName
output postgresHost string = deployDedicatedPostgresServer ? dedicatedPostgresServer!.properties.fullyQualifiedDomainName : sharedPostgresServerFqdn
output dedicatedPostgresDeployed bool = deployDedicatedPostgresServer
output storageContainerName string = containerName
output cloudBlobStorageEnabled bool = enableCloudBlobStorage
