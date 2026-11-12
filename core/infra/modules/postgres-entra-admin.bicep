// Registers a Microsoft Entra ID Service Principal (migrateIdentity ONLY) as the administrator
// of an Azure Database for PostgreSQL Flexible Server (ADR 0028 §2, R402).
// Separated into a child module so `principalId` is a deployment-start module parameter (BCP120).

@description('Name of the target PostgreSQL Flexible Server')
param serverName string

@description('Object (principal) ID of the migrate User-Assigned Managed Identity')
param principalId string

@description('Resource name of the migrate User-Assigned Managed Identity')
param principalName string

@description('Microsoft Entra tenant ID')
param tenantId string = subscription().tenantId

resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' existing = {
  name: serverName
}

resource postgresEntraAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2025-08-01' = {
  parent: postgresServer
  name: principalId
  properties: {
    principalName: principalName
    principalType: 'ServicePrincipal'
    tenantId: tenantId
  }
}

output administratorResourceId string = postgresEntraAdmin.id
