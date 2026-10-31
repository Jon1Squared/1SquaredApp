// Platform Infrastructure as Code (Bicep)
// Supports both Model A (single_tenant in client Azure) and Model B (multi_tenant hosted in UK South/UK West).

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

var resourceSuffix = '${tenantSlug}-${environment}'

output hostingModeConfigured string = hostingMode
output primaryRegion string = location
output keyVaultName string = 'kv-${resourceSuffix}'
output storageContainerName string = 'tenant-${resourceSuffix}'
output postgresDatabaseName string = 'pg_tenant_${replace(tenantSlug, '-', '_')}_${environment}'
