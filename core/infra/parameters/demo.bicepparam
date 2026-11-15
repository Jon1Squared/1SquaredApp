// Demo Environment Parameters (`core/infra/parameters/demo.bicepparam`)
// Non-secret parameters for the hosted `not-a-law-firm` demo deployment in UK South (`rg-onesquared-demo-uksouth`).
// Secrets are stored exclusively in Azure Key Vault (`platformKeyVault`) and never in this file (Rule 5).
//
// Stage 1 (foundation): pass `--parameters deployApps=false`
// Stage 2 (apps & jobs): pass `--parameters deployApps=true appContainerImage=<acrLoginServer>/onesquared-web:<tag>`

using '../main.bicep'

param environment = 'demo'
param hostingMode = 'multi_tenant'
param location = 'uksouth'
param tenantSlug = 'not-a-law-firm'
param defaultCostCentre = 'CC-DEMO'
param enableCloudBlobStorage = true
param enablePdfConverterContainerApp = false
param enableSchedulerJobs = true
param enableKeyDateRemindersJob = true
param enableUsageRetentionPurgeJob = true
param enableEnquiryAnonymisationJob = true
param enableSeedDemoJob = true
param enableIdealPostcodesSecret = false
param enableAnthropicSecret = false
param entraClientId = '0a1a7a83-367f-426b-aaa3-70c288541d1d'
param entraTenantId = 'f8218d9a-e055-463f-add2-f03679aad7f2'
param entraRedirectUri = 'https://ca-web-platform-demo.wittymushroom-20869958.uksouth.azurecontainerapps.io/api/auth/callback/microsoft-entra-id'
param vnetAddressPrefix = '10.26.0.0/16'
param containerAppsSubnetPrefix = '10.26.0.0/27'
param postgresSubnetPrefix = '10.26.1.0/28'
param privateEndpointsSubnetPrefix = '10.26.2.0/27'
