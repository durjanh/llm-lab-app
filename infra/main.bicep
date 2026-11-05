// Everything the lab needs in Azure, for `azd up`: a resource group with the AI, speech, search and media
// resources, the coding agent's sandbox, and the roles the person running it needs. Keyless throughout: every
// resource has local (key) sign-in switched off, and the lab signs in with your Azure login.
// `azd down --purge` removes it all again.
targetScope = 'subscription'

@minLength(1)
@maxLength(40)
@description('The azd environment name; it names the resource group and the resources.')
param environmentName string

@description('Region for everything except image generation.')
param location string = 'uksouth'

@description('Region for the media account: gpt-image-2 is offered in fewer regions.')
param mediaLocation string = 'swedencentral'

@description('Who runs the lab: given the roles it needs. The preprovision hook fills it with your signed-in account; the pipeline passes yours too.')
param principalId string

@allowed(['User', 'ServicePrincipal'])
param principalType string = 'User'

@description('The GitHub Actions pipeline\'s service principal (infra/pipeline.sh), given OpenAI User for the evaluation gate.')
param pipelinePrincipalId string = ''

@description('The coding sandbox app registration, made by the preprovision hook.')
param sandboxAppId string = ''

@description('The coding sandbox image. Public, so it is pulled with no credentials.')
param sandboxImage string = 'ghcr.io/durjanh/coding-sandbox:1'

@allowed(['free', 'basic'])
@description('Azure AI Search tier. A subscription has one free search service; basic costs money.')
param searchSku string = 'free'

@allowed(['F0', 'S0'])
@description('Speech tier. F0 is free but limited to one per region in a subscription; S0 is pay per use.')
param speechSku string = 'S0'

var tags = { 'azd-env-name': environmentName }

resource group 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

module lab 'resources.bicep' = {
  name: 'lab'
  scope: group
  params: {
    environmentName: environmentName
    location: location
    mediaLocation: mediaLocation
    principalId: principalId
    principalType: principalType
    pipelinePrincipalId: pipelinePrincipalId
    sandboxAppId: sandboxAppId
    sandboxImage: sandboxImage
    searchSku: searchSku
    speechSku: speechSku
    tags: tags
  }
}

// Each output becomes an azd environment value; the postprovision hook writes them to the lab's .env.
output AZURE_RESOURCE_GROUP string = group.name
output AZURE_OPENAI_ENDPOINT string = lab.outputs.openAiEndpoint
output AZURE_OPENAI_DEPLOYMENTS string = lab.outputs.chatDeployments
output AZURE_OPENAI_EMBEDDING_DEPLOYMENT string = lab.outputs.embeddingDeployment
output AZURE_SEARCH_ENDPOINT string = lab.outputs.searchEndpoint
output FOUNDRY_PROJECT_ENDPOINT string = lab.outputs.projectEndpoint
output FOUNDRY_MODEL string = lab.outputs.foundryModel
output AZURE_LANGUAGE_ENDPOINT string = lab.outputs.languageEndpoint
output AZURE_MEDIA_ENDPOINT string = lab.outputs.mediaEndpoint
output AZURE_AI_RESOURCE_ID string = lab.outputs.aiResourceId
output AZURE_MEDIA_RESOURCE_ID string = lab.outputs.mediaResourceId
output AZURE_SPEECH_REGION string = location
output AZURE_SPEECH_RESOURCE_ID string = lab.outputs.speechResourceId
output AZURE_SPEECH_FALLBACK_RESOURCE_ID string = lab.outputs.aiResourceId
output LLM_LAB_SANDBOX string = empty(sandboxAppId) ? 'auto' : 'sessions'
output LLM_LAB_SESSIONS_ENDPOINT string = lab.outputs.sandboxEndpoint
output LLM_LAB_SESSIONS_SCOPE string = empty(sandboxAppId) ? '' : 'api://${sandboxAppId}/.default'
