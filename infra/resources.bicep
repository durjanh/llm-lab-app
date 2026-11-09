// The lab's resources, in one resource group. Names carry a short token from the subscription and environment, so
// two environments, or two people, do not collide.
param environmentName string
param location string
param mediaLocation string
param principalId string
param principalType string
param pipelinePrincipalId string
param sandboxAppId string
param sandboxImage string
param searchSku string
param speechSku string
param tags object

var token = take(uniqueString(subscription().id, environmentName, location), 6)
var aiName = 'ai-${environmentName}-${token}'
var mediaName = 'ai-${environmentName}-media-${token}'
var speechName = 'speech-${environmentName}-${token}'
var searchName = 'srch-${environmentName}-${token}'

// The models the labs use, in the main account. Deployed one at a time: an account takes one change at a time.
var models = [
  { name: 'gpt-5.4-mini', model: 'gpt-5.4-mini', version: '2026-03-17', capacity: 100 }
  { name: 'gpt-4.1-mini', model: 'gpt-4.1-mini', version: '2025-04-14', capacity: 50 }
  { name: 'text-embedding-3-small', model: 'text-embedding-3-small', version: '1', capacity: 50 }
  { name: 'text-embedding-3-large', model: 'text-embedding-3-large', version: '1', capacity: 50 }
]

// --- Azure AI Services with a Foundry project: GPT, embeddings, Language, Content Safety, Translator, agents ---

resource ai 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: aiName
  location: location
  tags: tags
  kind: 'AIServices'
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  properties: {
    customSubDomainName: aiName
    disableLocalAuth: true
    allowProjectManagement: true
    publicNetworkAccess: 'Enabled'
  }
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  parent: ai
  name: 'llm-lab'
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    displayName: 'llm-lab'
    description: 'Prompt agents for the LLM Lab (MedAssist, Aftercare).'
  }
}

@batchSize(1)
resource deployments 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = [for m in models: {
  parent: ai
  name: m.name
  sku: { name: 'GlobalStandard', capacity: m.capacity }
  properties: {
    model: { format: 'OpenAI', name: m.model, version: m.version }
    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
    raiPolicyName: 'Microsoft.DefaultV2' // the guardrail (content filter) on every call to this deployment
  }
  dependsOn: [project]
}]

// --- A second account where image generation is offered ---

resource media 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: mediaName
  location: mediaLocation
  tags: tags
  kind: 'AIServices'
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  properties: {
    customSubDomainName: mediaName
    disableLocalAuth: true
    allowProjectManagement: true
    publicNetworkAccess: 'Enabled'
  }
}

resource imageModel 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: media
  name: 'gpt-image-2'
  sku: { name: 'GlobalStandard', capacity: 1 }
  properties: { model: { format: 'OpenAI', name: 'gpt-image-2', version: '2026-04-21' } }
}

// --- Speech for the tutor's voice (the main account is its fallback) ---

resource speech 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: speechName
  location: location
  tags: tags
  kind: 'SpeechServices'
  sku: { name: speechSku }
  properties: {
    customSubDomainName: speechName
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

// --- Azure AI Search for the case-handling lab; the lab makes its index on first use ---

resource search 'Microsoft.Search/searchServices@2025-05-01' = {
  name: searchName
  location: location
  tags: tags
  sku: { name: searchSku }
  properties: {
    disableLocalAuth: true
    semanticSearch: 'free'
    publicNetworkAccess: 'enabled'
  }
}

// --- The coding agent's sandbox: one container app, scaled to zero, signed in with Entra ---

resource containerEnv 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: 'cae-${environmentName}-${token}'
  location: location
  tags: tags
  properties: {
    // Workload profiles, so a dynamic session pool (option A) can be added later; the app runs on Consumption.
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  }
}

resource sandbox 'Microsoft.App/containerApps@2025-01-01' = if (!empty(sandboxAppId)) {
  name: 'coding-sandbox'
  location: location
  tags: tags
  properties: {
    environmentId: containerEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      ingress: { external: true, targetPort: 8080, transport: 'auto' }
    }
    template: {
      containers: [{
        name: 'coding-sandbox'
        image: sandboxImage
        resources: { cpu: json('2.0'), memory: '4Gi' }
      }]
      // One replica: every agent session keeps its folder in it.
      scale: { minReplicas: 0, maxReplicas: 1 }
    }
  }
}

// Calls need a token for the sandbox's app registration, from the person on the allowed list; anything else is 401.
resource sandboxAuth 'Microsoft.App/containerApps/authConfigs@2025-01-01' = if (!empty(sandboxAppId)) {
  parent: sandbox
  name: 'current'
  properties: {
    platform: { enabled: true }
    globalValidation: { unauthenticatedClientAction: 'Return401' }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: sandboxAppId
          openIdIssuer: '${environment().authentication.loginEndpoint}${tenant().tenantId}/v2.0'
        }
        validation: {
          allowedAudiences: ['api://${sandboxAppId}', sandboxAppId]
          defaultAuthorizationPolicy: { allowedPrincipals: { identities: [principalId] } }
        }
      }
    }
  }
}

// --- The support agent (examples/support-agent): a search connection for its Azure AI Search tool, and the
// order-status API its OpenAPI tool calls. Foundry calls tools from the cloud, so the API runs here, not locally.

resource searchConnection 'Microsoft.CognitiveServices/accounts/projects/connections@2025-06-01' = {
  parent: project
  name: 'support-search'
  properties: {
    category: 'CognitiveSearch'
    target: 'https://${searchName}.search.windows.net'
    authType: 'AAD' // the project's managed identity; the search service has key sign-in off
    isSharedToAll: true
    metadata: { ApiType: 'Azure', ResourceId: search.id }
  }
}

resource orderApi 'Microsoft.App/containerApps@2025-01-01' = {
  name: 'order-status-api'
  location: location
  tags: tags
  properties: {
    environmentId: containerEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      ingress: { external: true, targetPort: 8080, transport: 'auto' }
    }
    template: {
      containers: [{
        name: 'order-status-api'
        // No image to build: a plain python image runs the script, embedded in base64 when the template compiles.
        image: 'docker.io/library/python:3.12-slim'
        command: ['sh']
        args: ['-c', 'echo ${loadFileAsBase64('../examples/support-agent/order_api.py')} | base64 -d > /tmp/order_api.py && HOST=0.0.0.0 PORT=8080 exec python /tmp/order_api.py']
        resources: { cpu: json('0.25'), memory: '0.5Gi' }
      }]
      scale: { minReplicas: 0, maxReplicas: 1 }
    }
  }
}

// --- MedAssist's real texts and reminders: a module, also deployed on its own by examples/medassist/azure.yaml ---
module medassistTexts 'modules/medassist-texts.bicep' = {
  name: 'medassist-texts'
  params: { environmentName: environmentName, location: location, principalId: principalId, principalType: principalType, tags: tags, aiServicesName: ai.name }
}

// --- The roles the labs need, for the person running them (data-plane roles: Owner alone is not enough) ---

var role = {
  openAiUser: '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
  speechUser: 'f2dc8367-1007-4938-bd23-fe263f013447'
  speechContributor: '0e75ca1e-0464-4b4d-8b93-68208a576181' // custom speech: datasets, models, endpoints
  cognitiveServicesUser: 'a97b65f3-24c7-4388-baec-2e87135dc908'
  foundryUser: '53ca6127-db72-4b80-b1b0-d745d6d5456d'
  searchIndexDataContributor: '8ebe5a00-799e-43f5-93ac-243d3dce84a7'
  searchServiceContributor: '7ca78c08-252a-4471-8644-bb5ff32d4ba0'
  reader: 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
  searchIndexDataReader: '1407120a-92aa-4202-b7e9-c0e197c71c8f'
}

resource aiRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for r in [role.openAiUser, role.speechUser, role.cognitiveServicesUser, role.foundryUser]: {
  name: guid(ai.id, principalId, r)
  scope: ai
  properties: { principalId: principalId, principalType: principalType, roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', r) }
}]

resource mediaRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for r in [role.openAiUser, role.cognitiveServicesUser]: {
  name: guid(media.id, principalId, r)
  scope: media
  properties: { principalId: principalId, principalType: principalType, roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', r) }
}]

resource speechRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for r in [role.speechUser, role.speechContributor]: {
  name: guid(speech.id, principalId, r)
  scope: speech
  properties: { principalId: principalId, principalType: principalType, roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', r) }
}]

resource searchRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for r in [role.searchIndexDataContributor, role.searchServiceContributor]: {
  name: guid(search.id, principalId, r)
  scope: search
  properties: { principalId: principalId, principalType: principalType, roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', r) }
}]

// The GitHub Actions pipeline (infra/pipeline.sh) runs the evaluation gate against gpt-5.4-mini after it provisions.
resource pipelineRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(pipelinePrincipalId)) {
  name: guid(ai.id, pipelinePrincipalId, role.openAiUser)
  scope: ai
  properties: { principalId: pipelinePrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', role.openAiUser) }
}

// The project's managed identity: the agent's Azure AI Search tool queries the index as the project.
resource projectSearchRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for r in [role.searchIndexDataReader, role.searchServiceContributor]: {
  name: guid(search.id, project.id, r)
  scope: search
  properties: { principalId: project.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', r) }
}]

// The Foundry operations lab reads deployments, quotas and metrics through Resource Manager.
resource readerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, principalId, role.reader)
  properties: { principalId: principalId, principalType: principalType, roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', role.reader) }
}

output openAiEndpoint string = 'https://${aiName}.openai.azure.com'
output languageEndpoint string = 'https://${aiName}.cognitiveservices.azure.com'
output projectEndpoint string = 'https://${aiName}.services.ai.azure.com/api/projects/${project.name}'
output mediaEndpoint string = 'https://${mediaName}.cognitiveservices.azure.com'
output searchEndpoint string = 'https://${searchName}.search.windows.net'
output chatDeployments string = 'gpt-5.4-mini'
output embeddingDeployment string = 'text-embedding-3-small'
output foundryModel string = 'gpt-5.4-mini'
output aiResourceId string = ai.id
output mediaResourceId string = media.id
output speechResourceId string = speech.id
output projectPrincipalId string = project.identity.principalId
output orderApiUrl string = 'https://${orderApi.properties.configuration.ingress.fqdn}'
output sandboxEndpoint string = empty(sandboxAppId) ? '' : 'https://${sandbox.?properties.?configuration.?ingress.?fqdn ?? ''}'
output smsEndpoint string = medassistTexts.outputs.smsEndpoint
output remindersTableUrl string = medassistTexts.outputs.remindersTableUrl
