// The lab's model deployments as code: one source of truth for capacity, version policy and guardrail.
// Deploy with: az deployment group create -g rg-llm-lab -f deployments.bicep -p accountName=ai-llm-lab-0eevth
param accountName string

resource account 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: accountName
}

resource chat 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: account
  name: 'gpt-5.4-mini'
  sku: { name: 'GlobalStandard', capacity: 100 }   // capacity 100 = 100,000 tokens and 100 requests a minute
  properties: {
    model: { format: 'OpenAI', name: 'gpt-5.4-mini', version: '2026-03-17' }
    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
    raiPolicyName: 'Microsoft.DefaultV2'           // the guardrail (content filter) attached to this deployment
  }
}

resource embeddings 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: account
  name: 'text-embedding-3-small'
  dependsOn: [chat]                                // deployments on one account are created one at a time
  sku: { name: 'GlobalStandard', capacity: 50 }
  properties: {
    model: { format: 'OpenAI', name: 'text-embedding-3-small', version: '1' }
  }
}
