// MedAssist's real texts (examples/medassist/sms.py): Communication Services sends them, and a Function on the Flex
// Consumption plan sends each reminder 24 hours ahead from a row in a Storage table. Nothing here costs anything while
// idle: texts are paid per message, the Function per run (inside the monthly free grant), the storage by the byte.
// Used by the full lab (infra/resources.bicep) and on its own by examples/medassist/azure.yaml, in its own group.
param environmentName string
param location string
param principalId string
param principalType string = 'User'
param tags object = {}
@description('The AI Services account in this group that speaks and listens on Aftercare\'s real calls; empty for texts only.')
param aiServicesName string = ''

var token = take(uniqueString(subscription().id, environmentName, location), 6)
var commsName = 'acs-${environmentName}-${token}'
var remindersStorageName = toLower(take('st${replace(environmentName, '-', '')}${token}', 24)) // letters and digits only
var storageBlobDataOwner = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b' // the Function's code and its host's leases
var storageBlobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe' // azd uploading the Function's code
var storageTableDataContributor = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3' // the reminders table
var communicationServiceOwner = '09976791-48a7-449e-bb21-39d1a415f350' // Communication and Email Service Owner
var cognitiveServicesUser = 'a97b65f3-24c7-4388-baec-2e87135dc908' // calls: text to speech and speech to text

resource comms 'Microsoft.Communication/communicationServices@2025-05-01' = {
  name: commsName
  location: 'global' // the only location Communication Services takes; dataLocation is where its data stays
  tags: tags
  identity: { type: 'SystemAssigned' } // to reach AI Services for speech on calls, without a key
  properties: { dataLocation: 'UK' }
}

resource aiServices 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = if (!empty(aiServicesName)) {
  name: aiServicesName
}

// Aftercare's real calls: Communication Services speaks the agent's replies and hears the answers through AI Services.
resource commsSpeechRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(aiServicesName)) {
  name: guid(resourceGroup().id, aiServicesName, commsName, cognitiveServicesUser)
  scope: aiServices
  properties: { principalId: comms.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesUser) }
}

resource remindersStorage 'Microsoft.Storage/storageAccounts@2026-04-01' = {
  name: remindersStorageName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowSharedKeyAccess: false // Entra only: the Function and you sign in, nobody holds a key
    allowBlobPublicAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
  }
}

resource remindersBlobs 'Microsoft.Storage/storageAccounts/blobServices@2026-04-01' = {
  parent: remindersStorage
  name: 'default'
}

resource deploymentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2026-04-01' = {
  parent: remindersBlobs
  name: 'deploymentpackage' // where azd puts the Function's code
}

resource remindersTables 'Microsoft.Storage/storageAccounts/tableServices@2026-04-01' = {
  parent: remindersStorage
  name: 'default'
}

resource remindersTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2026-04-01' = {
  parent: remindersTables
  name: 'reminders'
}

resource remindersPlan 'Microsoft.Web/serverfarms@2025-03-01' = {
  name: 'plan-${environmentName}-reminders-${token}'
  location: location
  tags: tags
  kind: 'functionapp'
  sku: { name: 'FC1', tier: 'FlexConsumption' }
  properties: { reserved: true }
}

resource reminders 'Microsoft.Web/sites@2025-03-01' = {
  name: 'func-${environmentName}-reminders-${token}'
  location: location
  tags: union(tags, { 'azd-service-name': 'reminders' })
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: remindersPlan.id
    httpsOnly: true
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${remindersStorage.properties.primaryEndpoints.blob}deploymentpackage'
          authentication: { type: 'SystemAssignedIdentity' }
        }
      }
      scaleAndConcurrency: { maximumInstanceCount: 40, instanceMemoryMB: 512 } // one timer: the smallest instances
      runtime: { name: 'python', version: '3.12' }
    }
    siteConfig: {
      appSettings: [
        { name: 'AzureWebJobsStorage__accountName', value: remindersStorage.name } // the host's own storage, by identity
        { name: 'SMS_ENDPOINT', value: 'https://${comms.properties.hostName}' }
        { name: 'REMINDERS_TABLE_URL', value: remindersStorage.properties.primaryEndpoints.table }
      ]
    }
  }
}

// MedAssist's texts: the Function sends reminders as itself; you send confirmations from the backend and keep the
// reminder rows. Communication Services has one built-in role, scoped here to this one resource.
resource remindersStorageRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for r in [storageBlobDataOwner, storageTableDataContributor]: {
  name: guid(remindersStorage.id, reminders.id, r)
  scope: remindersStorage
  properties: { principalId: reminders.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', r) }
}]

resource remindersCommsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(comms.id, reminders.id, communicationServiceOwner)
  scope: comms
  properties: { principalId: reminders.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', communicationServiceOwner) }
}

resource yourStorageRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for r in [storageTableDataContributor, storageBlobDataContributor]: {
  name: guid(remindersStorage.id, principalId, r)
  scope: remindersStorage
  properties: { principalId: principalId, principalType: principalType, roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', r) }
}]

resource yourCommsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(comms.id, principalId, communicationServiceOwner)
  scope: comms
  properties: { principalId: principalId, principalType: principalType, roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', communicationServiceOwner) }
}

output smsEndpoint string = 'https://${comms.properties.hostName}'
output remindersTableUrl string = remindersStorage.properties.primaryEndpoints.table
output functionAppName string = reminders.name
