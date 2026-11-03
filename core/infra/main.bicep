// Platform Infrastructure as Code (Bicep)
// Supports both Model A (single_tenant in client Azure) and Model B (multi_tenant hosted in UK South/UK West).
// Note: Local / early-stage environments use the tenant-isolated `local-fs` storage provider by default;
// Azure Blob Storage, Microsoft Defender for Storage malware scanning, Key Vault, and optional PDF converter resources
// are defined here so cloud deployments are 100% IaC-driven when enabled.

@description('Deployment environment')
@allowed([
  'dev'
  'test'
  'training'
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

@description('Tenant identifier slug for isolated database, storage container, and Key Vault prefix')
param tenantSlug string

@description('Whether to provision Azure Blob Storage & Defender for Storage malware scanning (false when using local-fs)')
param enableCloudBlobStorage bool = false

@description('Monthly GB cap for Microsoft Defender for Storage on-upload malware scanning')
param defenderMalwareScanCapGbPerMonth int = 500

@description('Whether to deploy the optional headless LibreOffice PDF converter internal Container App')
param enablePdfConverterContainerApp bool = false

var resourceSuffix = '${tenantSlug}-${environment}'
var sanitizedSlug = replace(tenantSlug, '-', '')
var storageAccountName = take('st${sanitizedSlug}${environment}', 24)
var keyVaultResourceName = take('kv-${sanitizedSlug}-${environment}', 24)
var containerName = 'tenant-${resourceSuffix}'

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultResourceName
  location: location
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
    publicNetworkAccess: 'Enabled'
  }
}

resource entraClientSecretPlaceholder 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'entra-client-secret'
  properties: {
    contentType: 'text/plain'
    attributes: {
      enabled: true
    }
  }
}

resource authSecretPlaceholder 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'auth-secret'
  properties: {
    contentType: 'text/plain'
    attributes: {
      enabled: true
    }
  }
}

resource blobSigningKeyPlaceholder 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'blob-signing-key'
  properties: {
    contentType: 'text/plain'
    attributes: {
      enabled: true
    }
  }
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = if (enableCloudBlobStorage) {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_ZRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    supportsHttpsTrafficOnly: true
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

resource blobServices 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = if (enableCloudBlobStorage) {
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

resource tenantBlobContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = if (enableCloudBlobStorage) {
  parent: blobServices
  name: containerName
  properties: {
    publicAccess: 'None'
    metadata: {
      tenantSlug: tenantSlug
      environment: environment
      hostingMode: hostingMode
    }
  }
}

resource defenderForStorage 'Microsoft.Security/defenderForStorageSettings@2022-12-01-preview' = if (enableCloudBlobStorage) {
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

var keyVaultSecretAppSettings = {
  ENTRA_CLIENT_SECRET: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/entra-client-secret/)'
  AUTH_SECRET: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/auth-secret/)'
  PLATFORM_BLOB_SIGNING_KEY: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/blob-signing-key/)'
  PLATFORM_HOSTING_MODE: hostingMode
}

output hostingModeConfigured string = hostingMode
output primaryRegion string = location
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
output appSettingsKeyVaultReferences object = keyVaultSecretAppSettings
output storageContainerName string = containerName
output postgresDatabaseName string = 'pg_tenant_${replace(tenantSlug, '-', '_')}_${environment}'
output cloudBlobStorageEnabled bool = enableCloudBlobStorage
output pdfConverterContainerEnabled bool = enablePdfConverterContainerApp
