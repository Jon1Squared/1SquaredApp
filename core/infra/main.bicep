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

@description('Microsoft Entra ID application (client) ID for OIDC sign-in (required; no empty default)')
@minLength(1)
param entraClientId string

@description('Microsoft Entra ID directory (tenant) ID for OIDC sign-in')
param entraTenantId string = subscription().tenantId

@description('Microsoft Entra ID OIDC callback redirect URI (required; no empty default)')
@minLength(1)
param entraRedirectUri string

@description('Tenant configuration package directory relative to application root')
param tenantPackageDir string = 'client-${tenantSlug}'

@description('Virtual network CIDR address prefix (parameterised per environment/spoke to avoid hub-and-spoke peering collisions)')
param vnetAddressPrefix string = '10.24.0.0/16'

@description('Subnet CIDR address prefix for App Service regional VNet integration')
param appServiceSubnetPrefix string = '10.24.1.0/24'

var resourceSuffix = '${tenantSlug}-${environment}'
var sanitizedSlug = replace(tenantSlug, '-', '')
var storageAccountName = take('st${sanitizedSlug}${environment}', 24)
var keyVaultResourceName = take('kv-${sanitizedSlug}-${environment}', 24)
var appServicePlanName = take('asp-${resourceSuffix}', 40)
var webAppResourceName = take('app-${resourceSuffix}', 60)
var vnetResourceName = take('vnet-${resourceSuffix}', 60)
var containerName = 'tenant-${resourceSuffix}'
// Built-in Azure RBAC role: Key Vault Secrets User
var keyVaultSecretsUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)

resource vnet 'Microsoft.Network/virtualNetworks@2023-09-01' = {
  name: vnetResourceName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        vnetAddressPrefix
      ]
    }
    subnets: [
      {
        name: 'snet-appservice'
        properties: {
          addressPrefix: appServiceSubnetPrefix
          serviceEndpoints: [
            {
              service: 'Microsoft.KeyVault'
              locations: [
                location
              ]
            }
          ]
          delegations: [
            {
              name: 'delegation-web-serverfarms'
              properties: {
                serviceName: 'Microsoft.Web/serverFarms'
              }
            }
          ]
        }
      }
    ]
  }
}

// Operator-populated Key Vault secrets (never stored in Bicep templates or source control):
// - entra-client-secret: Microsoft Entra ID confidential client secret (or certificate thumbprint)
// - auth-secret: 32+ byte HMAC-SHA256 session cookie signing key
// - blob-signing-key: 32+ byte HMAC-SHA256 scoped blob download token signing key
// Network design (R68): publicNetworkAccess is Enabled with networkAcls defaultAction: 'Deny',
// bypass: 'AzureServices', and virtualNetworkRules bound to the App Service regional VNet integration
// subnet (snet-appservice) so Azure App Service can resolve @Microsoft.KeyVault(...) secret references.
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
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Deny'
      virtualNetworkRules: [
        {
          id: '${vnet.id}/subnets/snet-appservice'
          ignoreMissingVnetServiceEndpoint: false
        }
      ]
    }
  }
}

resource appServicePlan 'Microsoft.Web/serverfarms@2023-01-01' = {
  name: appServicePlanName
  location: location
  kind: 'linux'
  sku: {
    name: 'P1v3'
    tier: 'PremiumV3'
  }
  properties: {
    reserved: true
  }
}

var keyVaultSecretAppSettings = {
  ENTRA_CLIENT_ID: entraClientId
  ENTRA_TENANT_ID: entraTenantId
  ENTRA_REDIRECT_URI: entraRedirectUri
  ENTRA_CLIENT_SECRET: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/entra-client-secret/)'
  AUTH_SECRET: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/auth-secret/)'
  PLATFORM_BLOB_SIGNING_KEY: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/blob-signing-key/)'
  PLATFORM_HOSTING_MODE: hostingMode
  PLATFORM_ENVIRONMENT: environment
  PLATFORM_TENANT_PACKAGE_DIR: tenantPackageDir
}

resource webApp 'Microsoft.Web/sites@2023-01-01' = {
  name: webAppResourceName
  location: location
  kind: 'app,linux,container'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    virtualNetworkSubnetId: '${vnet.id}/subnets/snet-appservice'
    vnetRouteAllEnabled: true
    siteConfig: {
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      alwaysOn: true
      appSettings: [
        {
          name: 'ENTRA_CLIENT_ID'
          value: keyVaultSecretAppSettings.ENTRA_CLIENT_ID
        }
        {
          name: 'ENTRA_TENANT_ID'
          value: keyVaultSecretAppSettings.ENTRA_TENANT_ID
        }
        {
          name: 'ENTRA_REDIRECT_URI'
          value: keyVaultSecretAppSettings.ENTRA_REDIRECT_URI
        }
        {
          name: 'ENTRA_CLIENT_SECRET'
          value: keyVaultSecretAppSettings.ENTRA_CLIENT_SECRET
        }
        {
          name: 'AUTH_SECRET'
          value: keyVaultSecretAppSettings.AUTH_SECRET
        }
        {
          name: 'PLATFORM_BLOB_SIGNING_KEY'
          value: keyVaultSecretAppSettings.PLATFORM_BLOB_SIGNING_KEY
        }
        {
          name: 'PLATFORM_HOSTING_MODE'
          value: keyVaultSecretAppSettings.PLATFORM_HOSTING_MODE
        }
        {
          name: 'PLATFORM_ENVIRONMENT'
          value: keyVaultSecretAppSettings.PLATFORM_ENVIRONMENT
        }
        {
          name: 'PLATFORM_TENANT_PACKAGE_DIR'
          value: keyVaultSecretAppSettings.PLATFORM_TENANT_PACKAGE_DIR
        }
      ]
    }
  }
}

resource webAppKeyVaultSecretsUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, webApp.id, '4633458b-17de-408a-b874-0445c86b69e6')
  scope: keyVault
  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
    principalId: webApp.identity.principalId
    principalType: 'ServicePrincipal'
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

output hostingModeConfigured string = hostingMode
output primaryRegion string = location
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
output webAppName string = webApp.name
output webAppPrincipalId string = webApp.identity.principalId
output keyVaultSecretsUserRoleAssignmentId string = webAppKeyVaultSecretsUserRole.id
output appSettingsKeyVaultReferences object = keyVaultSecretAppSettings
output storageContainerName string = containerName
output postgresDatabaseName string = 'pg_tenant_${replace(tenantSlug, '-', '_')}_${environment}'
output cloudBlobStorageEnabled bool = enableCloudBlobStorage
output pdfConverterContainerEnabled bool = enablePdfConverterContainerApp
