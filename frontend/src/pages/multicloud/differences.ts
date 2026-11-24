/* The differences between the three hyperscalers that change a design, one row per topic. Kept general where the
   details move quickly (quotas, regions); check each provider's documentation before relying on a number. */

export interface Difference {
  id: string;
  name: string;
  /** Why this topic changes the design. */
  why: string;
  azure: string;
  gcp: string;
  aws: string;
}

export const DIFFERENCES: Difference[] = [
  {
    id: 'identity',
    name: 'Identity and keyless access',
    why: 'Keys leak and need rotating. All three let a workload prove who it is without one; the mechanism differs.',
    azure:
      'Give the app a managed identity and an RBAC role (such as Cognitive Services User) on the Foundry resource, then turn local key auth off. DefaultAzureCredential gets tokens. Pipelines use workload identity federation.',
    gcp: 'Run the workload as a service account with roles/aiplatform.user; Application Default Credentials pick it up. Block service account key creation by organisation policy. Callers outside Google Cloud use Workload Identity Federation.',
    aws: 'Attach an IAM role to the task, function or pod (ECS task role, Lambda execution role, EKS Pod Identity). Requests are signed with SigV4. Scope bedrock:InvokeModel to the model ARNs you use; no long-lived access keys.',
  },
  {
    id: 'capacity',
    name: 'Capacity models',
    why: 'Pay-as-you-go shares capacity and can throttle at busy times; reserved capacity is steady but you pay whether you use it or not.',
    azure:
      'Standard deployments bill per token against a tokens-per-minute quota. Provisioned throughput units (PTUs) reserve capacity; PTU quota is per region and not tied to one model. Spill excess to a standard deployment through the gateway.',
    gcp: 'Pay-as-you-go draws on shared capacity. Provisioned Throughput is bought for a term in generative AI scale units; requests over it fall back to pay-as-you-go by default.',
    aws: 'On-demand has per-model request and token quotas; cross-region inference profiles spread the load. Provisioned Throughput is bought in model units, usually with a term, and not for every model.',
  },
  {
    id: 'regions',
    name: 'Where the model runs',
    why: 'Residency rules decide the deployment type, and new models reach the strictest options last.',
    azure:
      'Global, Data Zone (such as EU or US) and Regional deployment types. Claude on Foundry can be hosted on Azure or hosted on Anthropic, with different features and data paths.',
    gcp: 'A global endpoint, multi-regions (such as eu) or a single region, chosen per request through the location in the endpoint.',
    aws: 'A single region, a geographic cross-region inference profile (such as EU), or global cross-region inference. Regional endpoints for Claude cost more than global ones.',
  },
  {
    id: 'network',
    name: 'Private networking',
    why: 'Regulated data should not cross the public internet, and a private path stops data leaving through a misconfigured service.',
    azure:
      'Private endpoints for Foundry, AI Search and Storage, with public network access disabled. The Foundry Agent Service standard setup can run in your virtual network.',
    gcp: 'Private Service Connect to reach Vertex AI privately, and a VPC Service Controls perimeter so data cannot be copied to a project outside it.',
    aws: 'VPC interface endpoints (PrivateLink) for the Bedrock runtime and gateway endpoints for S3; service control policies to forbid public access across accounts.',
  },
  {
    id: 'safety',
    name: 'Content safety',
    why: 'What is filtered by default, and whether the filter works for any model or only the provider’s own, decides how much you build.',
    azure:
      'Content filters run on every deployment by default, with severity levels you can change; Prompt Shields catch prompt attacks; groundedness detection checks answers against sources.',
    gcp: 'Safety settings per Gemini request. Model Armor screens prompts and replies for any model; Sensitive Data Protection finds personal data.',
    aws: 'Bedrock Guardrails: content filters, denied topics, personal data masking, contextual grounding checks. The ApplyGuardrail API checks any text, whichever model wrote it.',
  },
  {
    id: 'cost',
    name: 'Cost observability',
    why: 'Model spend grows by feature and by team; without attribution nobody can say which feature to optimise.',
    azure:
      'Cost Management by resource and tag; token metrics per deployment in Azure Monitor; the API Management AI gateway records tokens per consumer.',
    gcp: 'Billing export to BigQuery, with labels on resources and on Vertex AI requests, so spend splits by feature in SQL.',
    aws: 'Cost Explorer with cost allocation tags; application inference profiles tag model usage per application; CloudWatch has invocation and token metrics.',
  },
];
