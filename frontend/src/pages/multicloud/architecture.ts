/* The data and rules behind the multi-cloud page: the building blocks of an AI system, what each one is on Azure,
   Google Cloud, AWS and Databricks, five reference use cases, and simple tested rules that turn a set of
   requirements into architecture decisions with a reason for each. No React here, so the rules can be tested alone. */

export type Cloud = 'azure' | 'gcp' | 'aws' | 'databricks';

export const CLOUDS: { id: Cloud; name: string }[] = [
  { id: 'azure', name: 'Azure' },
  { id: 'gcp', name: 'Google Cloud' },
  { id: 'aws', name: 'AWS' },
  { id: 'databricks', name: 'Databricks' },
];

export type BlockId =
  | 'gateway'
  | 'identity'
  | 'compute'
  | 'orchestration'
  | 'models'
  | 'specialist'
  | 'retrieval'
  | 'storage'
  | 'pipelines'
  | 'safety'
  | 'monitoring'
  | 'secrets'
  | 'cicd';

export interface Block {
  id: BlockId;
  name: string;
  /** What the block is for, whatever the cloud. */
  what: string;
  /** Cross-cutting blocks sit in the band under the request path in the diagram. */
  cross: boolean;
}

export const BLOCKS: Block[] = [
  {
    id: 'gateway',
    name: 'Channel and API gateway',
    what: 'One front door: authentication, rate and token limits per caller, routing across model deployments, logging.',
    cross: false,
  },
  {
    id: 'compute',
    name: 'App compute',
    what: 'Runs your API and workers: containers or functions that scale with load.',
    cross: false,
  },
  {
    id: 'orchestration',
    name: 'Orchestration and agent runtime',
    what: 'The loop that calls the model, runs tools, waits for approvals and keeps state between steps.',
    cross: false,
  },
  {
    id: 'models',
    name: 'Model hosting',
    what: 'Where the LLM runs: a managed catalogue of first- and third-party models, or your own endpoint.',
    cross: false,
  },
  {
    id: 'specialist',
    name: 'Specialist AI services',
    what: 'Prebuilt models for documents and speech, cheaper and steadier than an LLM for those jobs.',
    cross: false,
  },
  {
    id: 'retrieval',
    name: 'Retrieval (search and vectors)',
    what: 'Hybrid keyword and vector search with filters and reranking, so answers are grounded in your data.',
    cross: false,
  },
  {
    id: 'storage',
    name: 'Storage and lakehouse',
    what: 'Raw files, cleaned tables and features in open formats, with lineage and access control.',
    cross: false,
  },
  {
    id: 'pipelines',
    name: 'Data and ML pipelines',
    what: 'Scheduled jobs that ingest, chunk, embed, train and score, re-runnable from a known data version.',
    cross: false,
  },
  {
    id: 'identity',
    name: 'Identity',
    what: 'Who the user is, and the workload identity each service uses to call the others without keys.',
    cross: true,
  },
  {
    id: 'safety',
    name: 'Evaluation and safety',
    what: 'Content filters and prompt-attack detection on the way in and out, and offline and online evaluations.',
    cross: true,
  },
  {
    id: 'monitoring',
    name: 'Monitoring and tracing',
    what: 'Traces of every model and tool call, token cost per feature, latency and error alerts.',
    cross: true,
  },
  {
    id: 'secrets',
    name: 'Secrets and keys',
    what: 'The few secrets that remain (third-party keys) and customer-managed encryption keys.',
    cross: true,
  },
  {
    id: 'cicd',
    name: 'CI/CD',
    what: 'Builds, tests, evaluation gates and deploys, signing in to the cloud by federation rather than stored keys.',
    cross: true,
  },
];

export interface Service {
  /** Fits a box in the diagram. */
  short: string;
  /** The services, named in full. */
  service: string;
  /** What differs from the other clouds. */
  note: string;
}

export const SERVICES: Record<BlockId, Record<Cloud, Service>> = {
  gateway: {
    azure: {
      short: 'API Management',
      service: 'Azure Front Door, Azure API Management (AI gateway)',
      note: 'The AI gateway policies count tokens per caller, balance across deployments and can sit inside Foundry.',
    },
    gcp: {
      short: 'Apigee',
      service: 'Cloud Load Balancing, Apigee or API Gateway',
      note: 'Apigee carries the richer policies (quotas, token counting with custom policies); API Gateway is lighter.',
    },
    aws: {
      short: 'API Gateway',
      service: 'Amazon CloudFront, Amazon API Gateway',
      note: 'Usage plans limit requests, not tokens; token limits need your own code or a gateway in front.',
    },
    databricks: {
      short: 'AI Gateway',
      service: 'Mosaic AI Gateway on serving endpoints',
      note: 'Rate limits, usage tracking and guardrails per endpoint, for models served in or through Databricks.',
    },
  },
  identity: {
    azure: {
      short: 'Entra ID',
      service: 'Microsoft Entra ID, managed identities, RBAC',
      note: 'A managed identity gets a token for Foundry, Search and Storage; no keys to rotate.',
    },
    gcp: {
      short: 'Cloud IAM',
      service: 'Cloud IAM, service accounts, Workload Identity Federation',
      note: 'Each workload runs as a service account; outside callers federate rather than hold key files.',
    },
    aws: {
      short: 'IAM roles',
      service: 'AWS IAM roles and policies, IAM Identity Center, Amazon Cognito for app users',
      note: 'Workloads assume a role and sign each request (SigV4); policies are written per action and resource.',
    },
    databricks: {
      short: 'Unity Catalog',
      service: 'Unity Catalog permissions, service principals, the host cloud’s identity provider',
      note: 'Users come from your IdP; Unity Catalog grants decide which tables, models and functions they reach.',
    },
  },
  compute: {
    azure: {
      short: 'Container Apps',
      service: 'Azure Container Apps, Azure Functions, AKS',
      note: 'Container Apps for most APIs and workers; AKS when you need GPU nodes or already run Kubernetes.',
    },
    gcp: {
      short: 'Cloud Run',
      service: 'Cloud Run, Cloud Run functions, GKE',
      note: 'Cloud Run scales to zero per request; GKE for GPUs and long-running custom serving.',
    },
    aws: {
      short: 'ECS on Fargate',
      service: 'Amazon ECS on AWS Fargate, AWS Lambda, Amazon EKS',
      note: 'Fargate runs containers without servers; Lambda suits short event handlers, not long streaming replies.',
    },
    databricks: {
      short: 'Databricks Apps',
      service: 'Databricks Apps, jobs compute, serverless compute',
      note: 'Good for internal apps next to the data; customer-facing APIs usually stay on the host cloud.',
    },
  },
  orchestration: {
    azure: {
      short: 'Foundry Agent Service',
      service: 'Foundry Agent Service, Microsoft Agent Framework, Durable Functions, Logic Apps',
      note: 'Prompt agents run in Foundry; hosted agents package your own Agent Framework, LangGraph or other code.',
    },
    gcp: {
      short: 'Agent Engine + ADK',
      service: 'Vertex AI Agent Engine, Agent Development Kit (ADK), Workflows',
      note: 'ADK is Google’s open agent framework; Agent Engine hosts it (or LangGraph, LlamaIndex) with sessions.',
    },
    aws: {
      short: 'AgentCore',
      service: 'Amazon Bedrock AgentCore, Bedrock Agents, Strands Agents, AWS Step Functions',
      note: 'AgentCore runs agents written in any framework; Step Functions suits fixed workflows with approvals.',
    },
    databricks: {
      short: 'Mosaic AI agents',
      service: 'Mosaic AI Agent Framework, MLflow (LangGraph, LlamaIndex and others logged as models)',
      note: 'Agents are logged and versioned as MLflow models and served like any other endpoint.',
    },
  },
  models: {
    azure: {
      short: 'Foundry Models',
      service: 'Microsoft Foundry Models (Azure OpenAI, Claude, open models), Azure ML online endpoints',
      note: 'Global, Data Zone and Regional deployments; Claude runs hosted on Azure or hosted on Anthropic.',
    },
    gcp: {
      short: 'Vertex AI',
      service: 'Vertex AI (Gemini, Claude and open models in Model Garden), Vertex AI endpoints',
      note: 'Claude is enabled per project in Model Garden; region can be global, a multi-region or one region.',
    },
    aws: {
      short: 'Bedrock',
      service: 'Amazon Bedrock (Claude, Nova, open models), SageMaker AI endpoints',
      note: 'Model access is granted per model; regional endpoints keep data in one region at a price premium.',
    },
    databricks: {
      short: 'Model Serving',
      service: 'Mosaic AI Model Serving (foundation model APIs, external models, custom models)',
      note: 'Serves hosted foundation models, proxies external providers and serves your own MLflow models.',
    },
  },
  specialist: {
    azure: {
      short: 'Content Understanding',
      service: 'Azure Content Understanding, Document Intelligence, Azure Speech (Voice Live API)',
      note: 'Voice Live is one speech-to-speech socket with noise suppression and end-of-turn detection.',
    },
    gcp: {
      short: 'Document AI',
      service: 'Document AI, Speech-to-Text, Text-to-Speech, Gemini Live API',
      note: 'Document AI has prebuilt and custom processors; Gemini handles mixed documents directly too.',
    },
    aws: {
      short: 'Textract',
      service: 'Amazon Textract, Amazon Transcribe, Amazon Polly, Nova Sonic',
      note: 'Textract for forms and tables; Nova Sonic is a speech-to-speech model in Bedrock.',
    },
    databricks: {
      short: 'AI Functions',
      service: 'AI Functions in SQL (such as ai_parse_document, ai_extract), host cloud speech services',
      note: 'Runs extraction over whole tables in SQL; speech still comes from the host cloud.',
    },
  },
  retrieval: {
    azure: {
      short: 'Azure AI Search',
      service: 'Azure AI Search (hybrid, semantic ranker, agentic retrieval)',
      note: 'Hybrid search and reranking in one service; indexers pull from Blob, SQL and Cosmos DB.',
    },
    gcp: {
      short: 'Vertex AI Search',
      service: 'Vertex AI Search, Vertex AI Vector Search, AlloyDB or BigQuery vector search',
      note: 'Vertex AI Search is managed RAG; Vector Search is the raw index when you control the pipeline.',
    },
    aws: {
      short: 'Knowledge Bases',
      service: 'Bedrock Knowledge Bases, Amazon OpenSearch Serverless, Amazon S3 Vectors, Aurora pgvector',
      note: 'Knowledge Bases manages chunking and embedding; the store underneath is your choice.',
    },
    databricks: {
      short: 'Vector Search',
      service: 'Mosaic AI Vector Search (synced from Delta tables)',
      note: 'The index follows a Delta table, so access rules and lineage come from Unity Catalog.',
    },
  },
  storage: {
    azure: {
      short: 'OneLake / ADLS',
      service: 'Azure Data Lake Storage Gen2, Microsoft Fabric OneLake, Azure SQL, Cosmos DB',
      note: 'Fabric puts Delta tables over OneLake; Cosmos DB for chat history and agent state.',
    },
    gcp: {
      short: 'BigQuery + GCS',
      service: 'Cloud Storage, BigQuery (with BigLake and Iceberg tables), Firestore, AlloyDB',
      note: 'BigQuery is warehouse and lakehouse in one, billed by data scanned or by reserved slots.',
    },
    aws: {
      short: 'S3 + Iceberg',
      service: 'Amazon S3 (with S3 Tables for Iceberg), AWS Glue Data Catalog, Lake Formation, DynamoDB',
      note: 'Lake Formation adds fine-grained grants over the Glue catalogue; DynamoDB for session state.',
    },
    databricks: {
      short: 'Delta + Unity Catalog',
      service: 'Delta Lake tables governed by Unity Catalog, on the host cloud’s object storage',
      note: 'One catalogue for tables, files, features, models and functions, with lineage across them.',
    },
  },
  pipelines: {
    azure: {
      short: 'Data Factory, Azure ML',
      service: 'Azure Data Factory or Fabric pipelines, Azure Machine Learning pipelines',
      note: 'Data Factory moves and transforms; Azure ML pipelines train, register and deploy models.',
    },
    gcp: {
      short: 'Vertex AI Pipelines',
      service: 'Dataflow, Cloud Composer (Airflow), Vertex AI Pipelines (Kubeflow)',
      note: 'Vertex AI Pipelines runs Kubeflow pipeline definitions without a cluster to manage.',
    },
    aws: {
      short: 'SageMaker Pipelines',
      service: 'AWS Glue, Amazon MWAA (Airflow), Amazon SageMaker Pipelines',
      note: 'Glue for Spark ETL; SageMaker Pipelines for train, evaluate, register.',
    },
    databricks: {
      short: 'Lakeflow Jobs',
      service: 'Lakeflow Jobs and Declarative Pipelines, MLflow',
      note: 'Data and ML steps in one scheduler, with every run tracked in MLflow.',
    },
  },
  safety: {
    azure: {
      short: 'Content Safety + evals',
      service: 'Azure AI Content Safety (Prompt Shields, groundedness), Foundry guardrails and evaluations',
      note: 'Filters are set per deployment; Foundry evaluations score quality and safety offline and on traffic.',
    },
    gcp: {
      short: 'Model Armor + eval',
      service: 'Model Armor, Gemini safety settings, Gen AI evaluation service',
      note: 'Model Armor screens prompts and responses whichever model you call.',
    },
    aws: {
      short: 'Bedrock Guardrails',
      service: 'Amazon Bedrock Guardrails, Bedrock model and knowledge base evaluations',
      note: 'A guardrail can be applied to any text through its own API, not only Bedrock models.',
    },
    databricks: {
      short: 'Agent evaluation',
      service: 'MLflow evaluation with LLM judges, AI Gateway guardrails, Lakehouse Monitoring',
      note: 'Evaluation runs and their traces live next to the model versions they judged.',
    },
  },
  monitoring: {
    azure: {
      short: 'Azure Monitor',
      service: 'Azure Monitor, Application Insights, Foundry tracing (OpenTelemetry)',
      note: 'Foundry traces agent runs into Application Insights; cost comes from Cost Management.',
    },
    gcp: {
      short: 'Cloud Monitoring',
      service: 'Cloud Monitoring, Cloud Logging, Cloud Trace',
      note: 'Billing export to BigQuery gives cost per label; tag every resource by feature.',
    },
    aws: {
      short: 'CloudWatch',
      service: 'Amazon CloudWatch, AWS X-Ray, Bedrock model invocation logging',
      note: 'Invocation logging must be switched on; Cost Explorer splits by tag and by inference profile.',
    },
    databricks: {
      short: 'MLflow tracing',
      service: 'MLflow tracing, inference tables, system tables for usage and cost',
      note: 'Inference tables log every request and reply to Delta, so you query quality with SQL.',
    },
  },
  secrets: {
    azure: {
      short: 'Key Vault',
      service: 'Azure Key Vault (secrets and customer-managed keys)',
      note: 'Read with a managed identity; most Azure-to-Azure calls need no secret at all.',
    },
    gcp: {
      short: 'Secret Manager',
      service: 'Secret Manager, Cloud KMS',
      note: 'CMEK through Cloud KMS on Vertex AI, BigQuery and Cloud Storage.',
    },
    aws: {
      short: 'Secrets Manager',
      service: 'AWS Secrets Manager, AWS KMS',
      note: 'KMS keys encrypt Bedrock custom models, knowledge bases and S3.',
    },
    databricks: {
      short: 'Secret scopes',
      service: 'Databricks secret scopes (backed by the host cloud’s vault), customer-managed keys',
      note: 'Scopes can read from Key Vault; Unity Catalog service credentials avoid secrets for cloud access.',
    },
  },
  cicd: {
    azure: {
      short: 'GitHub / Azure DevOps',
      service: 'GitHub Actions or Azure Pipelines, Bicep, azd',
      note: 'Workload identity federation: the pipeline gets an Entra token by OIDC, with no stored secret.',
    },
    gcp: {
      short: 'Cloud Build',
      service: 'Cloud Build, Cloud Deploy, Terraform, GitHub Actions',
      note: 'GitHub Actions signs in through Workload Identity Federation, not a key file.',
    },
    aws: {
      short: 'CodePipeline',
      service: 'AWS CodePipeline and CodeBuild, CloudFormation or CDK, GitHub Actions',
      note: 'GitHub Actions assumes an IAM role through the OIDC provider.',
    },
    databricks: {
      short: 'Asset Bundles',
      service: 'Databricks Asset Bundles, run from any CI with OAuth federation',
      note: 'A bundle declares jobs, pipelines and serving endpoints as code, per environment.',
    },
  },
};

export interface UseCase {
  id: string;
  name: string;
  summary: string;
  /** The role each block plays here; blocks left out are not needed. */
  roles: Partial<Record<BlockId, string>>;
  /** The lab page that shows this kind of system working. */
  page: { path: string; name: string };
}

const CROSS_ROLES = {
  identity: 'Users sign in; each service calls the next with its workload identity.',
  monitoring: 'Trace each request through gateway, model and tools; cost per feature.',
  secrets: 'Only third-party keys and customer-managed keys.',
  cicd: 'Deploy code, prompts and infrastructure together, behind an evaluation gate.',
} as const;

export const USE_CASES: UseCase[] = [
  {
    id: 'rag',
    name: 'RAG assistant over documents',
    summary: 'Staff ask questions and get answers quoted from policies and manuals, with links to the source.',
    roles: {
      gateway: 'Signs in staff, limits tokens per team, routes to the model deployment.',
      compute: 'The chat API: query rewriting, retrieval call, prompt assembly, streaming.',
      models: 'A mid-size model for answers; a small one to rewrite the question.',
      retrieval: 'Hybrid search over chunks with security filters, then reranking.',
      storage: 'Source documents and their cleaned, chunked versions.',
      pipelines: 'Ingest, chunk, embed and re-index when documents change.',
      safety: 'Prompt-attack and groundedness checks; a golden question set run on every change.',
      ...CROSS_ROLES,
    },
    page: { path: '/search-pipeline', name: 'Search ingestion and relevance' },
  },
  {
    id: 'agent',
    name: 'Agentic workflow with tools and approvals',
    summary: 'An agent reads a case, calls internal systems through tools and pauses for a person before it acts.',
    roles: {
      gateway: 'Front door for the app and for the tool APIs the agent may call.',
      compute: 'Hosts the tool endpoints (or MCP servers) and the approval screen.',
      orchestration: 'Runs the tool loop, holds state across the pause and resumes after approval.',
      models: 'A capable model for planning; cheaper ones for routine steps.',
      retrieval: 'Looks up policy and past cases for the agent to cite.',
      storage: 'Case records, the audit log and the agent’s saved state.',
      safety: 'Allow-list of tools per step, prompt-attack screening of tool output, human approval.',
      ...CROSS_ROLES,
    },
    page: { path: '/casework', name: 'Case handling on Azure' },
  },
  {
    id: 'documents',
    name: 'Document processing and extraction',
    summary: 'Invoices and forms arrive in bulk; fields are extracted, checked and posted to a finance system.',
    roles: {
      gateway: 'Receives uploads and the callbacks from the finance system.',
      compute: 'Workers that pull from a queue so a burst of files never overloads the model.',
      models: 'An LLM for the awkward fields and for checks the prebuilt model cannot do.',
      specialist: 'Prebuilt layout and invoice models for the common fields.',
      storage: 'Original files, extracted JSON and the corrections people make.',
      pipelines: 'Batch runs, retries and reprocessing when the schema changes.',
      safety: 'Field-level accuracy against a labelled set; low-confidence fields go to a person.',
      ...CROSS_ROLES,
    },
    page: { path: '/extraction', name: 'Structured extraction' },
  },
  {
    id: 'ml',
    name: 'Classic ML scoring',
    summary: 'A churn or risk model scores customers nightly and on demand; no LLM in the scoring path.',
    roles: {
      gateway: 'Protects the online scoring endpoint and meters callers.',
      compute: 'Calls the endpoint from the business app; batch scoring runs as a job.',
      models: 'The trained model, served from the registry by version or alias.',
      storage: 'Feature tables and the training snapshots each model was built from.',
      pipelines: 'Feature engineering, training, evaluation, registration, batch scoring.',
      safety: 'Fairness and drift checks; a promotion gate on the evaluation metric.',
      ...CROSS_ROLES,
    },
    page: { path: '/mlops', name: 'MLOps' },
  },
  {
    id: 'voice',
    name: 'Real-time voice or chat channel',
    summary: 'Customers call or chat; the agent answers in under a second and hands over to a person when needed.',
    roles: {
      gateway: 'Telephony or web socket entry; per-session limits.',
      compute: 'The session server that holds the audio stream and calls tools.',
      orchestration: 'Short tool loop with strict time limits; hand-over to a person.',
      models: 'A small, fast model; a larger one only off the critical path.',
      specialist: 'Speech in and out, or one speech-to-speech service.',
      retrieval: 'Fast lookup of the caller’s record and short FAQ answers.',
      safety: 'Emergency wording screened first; every call transcribed for review.',
      ...CROSS_ROLES,
    },
    page: { path: '/voice-agent', name: 'Voice agent' },
  },
];

export function blockById(id: BlockId): Block {
  const b = BLOCKS.find((x) => x.id === id);
  if (!b) throw new Error(`Unknown block ${id}`);
  return b;
}

/* ---------- Requirements to architecture ---------- */

export interface Drivers {
  residency: 'none' | 'zone' | 'country';
  estate: 'azure' | 'gcp' | 'aws' | 'none';
  latency: 'batch' | 'interactive' | 'realtime';
  peak: 'low' | 'steady' | 'spiky';
  sensitivity: 'public' | 'internal' | 'regulated';
  openModels: boolean;
  skills: 'cloud' | 'data' | 'small';
  budget: 'payg' | 'committed';
}

export const DEFAULT_DRIVERS: Drivers = {
  residency: 'zone',
  estate: 'azure',
  latency: 'interactive',
  peak: 'steady',
  sensitivity: 'internal',
  openModels: false,
  skills: 'cloud',
  budget: 'payg',
};

export interface Decision {
  area: string;
  decision: string;
  because: string;
}

const ESTATE_NAME = { azure: 'Azure', gcp: 'Google Cloud', aws: 'AWS' } as const;

/** Turns the drivers into decisions, each with its reason, in the order an ADR would list them. */
export function decide(d: Drivers): Decision[] {
  const out: Decision[] = [];
  const cloud = d.estate === 'none' ? null : ESTATE_NAME[d.estate];

  // Platform
  if (cloud) {
    out.push({
      area: 'Platform',
      decision: `Build on ${cloud}.`,
      because:
        'Identity, networking, billing, security reviews and the team’s skills are already there. Add a second cloud only for a named gap.',
    });
  } else {
    out.push({
      area: 'Platform',
      decision:
        'Shortlist the clouds whose model catalogue serves the needed models in the required region, then spike.',
      because:
        'With no existing estate the deciding facts are model availability, region and data location; a two-week spike tests them.',
    });
  }

  // Data layer
  if (d.skills === 'data') {
    out.push({
      area: 'Data',
      decision: `Use Databricks (Delta tables in Unity Catalog)${cloud ? ` on ${cloud}` : ''} for the lakehouse, features and model registry.`,
      because:
        'The team already works in Spark and SQL; one catalogue gives lineage from source table to served model on any cloud.',
    });
  } else {
    out.push({
      area: 'Data',
      decision: 'Use the cloud’s own lakehouse, with tables in an open format (Delta or Iceberg).',
      because: 'Fewer moving parts for the team; the open format keeps a later move or a second engine possible.',
    });
  }

  // Residency
  if (d.residency === 'country') {
    out.push({
      area: 'Model deployment',
      decision:
        'Use regional deployments in an in-country region, and check each model is served there before committing.',
      because:
        'Global and multi-region endpoints may process data elsewhere. Newer models often reach single regions later, and regional processing can cost more.',
    });
  } else if (d.residency === 'zone') {
    out.push({
      area: 'Model deployment',
      decision:
        'Use data-zone deployments (for example Azure Data Zone, a Vertex multi-region, Bedrock geographic inference).',
      because: 'Data stays within the zone (such as the EU) while the provider still balances load across its regions.',
    });
  } else {
    out.push({
      area: 'Model deployment',
      decision: 'Use global deployments.',
      because: 'They have the most capacity, get new models first and are usually the cheapest per token.',
    });
  }

  // Capacity
  if (d.budget === 'committed' && d.peak === 'steady') {
    out.push({
      area: 'Capacity',
      decision:
        'Buy provisioned throughput for the steady base, and spill the excess to pay-as-you-go through the gateway.',
      because:
        'Steady, predictable load keeps reserved capacity busy, which is when it is cheaper and gives stable latency.',
    });
  } else if (d.peak === 'spiky') {
    out.push({
      area: 'Capacity',
      decision:
        'Stay on pay-as-you-go, with token limits per caller at the gateway and failover across deployments or regions.',
      because:
        'Reserved capacity sized for the peak would sit idle most of the day; sized for the average it would still throttle at the peak.',
    });
  } else {
    out.push({
      area: 'Capacity',
      decision:
        'Stay on pay-as-you-go and measure tokens per minute in production before buying any reserved capacity.',
      because:
        d.budget === 'committed'
          ? 'Commitment pays only once the load is known and steady; this load is too low to keep it busy.'
          : 'No commitment and modest load: the meter is the simplest and cheapest model.',
    });
  }

  // Latency
  if (d.latency === 'realtime') {
    out.push({
      area: 'Latency',
      decision:
        'Use a speech-to-speech service or a small streaming model in the region nearest the users, and keep tools and retrieval on a tight time budget.',
      because: 'A spoken reply needs to start within about a second; every network hop and large model adds to it.',
    });
  } else if (d.latency === 'batch') {
    out.push({
      area: 'Latency',
      decision:
        'Run through a queue with workers and a concurrency cap; use the platform’s batch inference where the model supports it.',
      because: 'Nobody is waiting, so throughput and price matter more than speed, and a queue absorbs bursts.',
    });
  } else {
    out.push({
      area: 'Latency',
      decision: 'Stream replies, and route simple requests to a smaller model.',
      because: 'People judge speed by the first words; most requests do not need the largest model.',
    });
  }

  // Sensitivity
  if (d.sensitivity === 'regulated') {
    out.push({
      area: 'Security',
      decision:
        'Private endpoints with public access off for models, search and storage; customer-managed keys; content filters on; a person approves actions; full audit log.',
      because:
        'Regulated data needs to stay off the internet, be encrypted under your control, and leave a record of who saw and did what.',
    });
  } else if (d.sensitivity === 'internal') {
    out.push({
      area: 'Security',
      decision:
        'Private networking for data stores, sign-in through the company identity provider, personal data masked in logs.',
      because:
        'Internal data must not leak through a public store or a log; the model endpoint can stay behind the gateway.',
    });
  } else {
    out.push({
      area: 'Security',
      decision: 'Public endpoints behind the gateway with a web application firewall and per-caller limits.',
      because: 'Public data does not justify private networking, but abuse and cost still need limits.',
    });
  }

  // Open models
  if (d.openModels) {
    out.push({
      area: 'Models',
      decision:
        'Serve open models from the managed catalogue first; own GPUs on Kubernetes only if you need custom serving or fine-tuned weights at scale.',
      because:
        'Managed endpoints remove GPU capacity planning; Kubernetes gives control but needs people who run GPU clusters.',
    });
  }

  // Compute
  if (d.skills === 'small' || d.peak === 'low') {
    out.push({
      area: 'Compute',
      decision: 'Serverless containers (Container Apps, Cloud Run or ECS on Fargate).',
      because: 'No cluster to patch or scale, and they scale to near zero when idle.',
    });
  } else if (d.openModels && d.skills === 'cloud') {
    out.push({
      area: 'Compute',
      decision: 'Kubernetes (AKS, GKE or EKS) for model serving; serverless containers for the API.',
      because: 'GPU node pools and custom serving need Kubernetes; the stateless API does not.',
    });
  } else {
    out.push({
      area: 'Compute',
      decision: 'Serverless containers for the API and workers; revisit Kubernetes only if a named need appears.',
      because: 'Kubernetes is a platform to run, not a default; most AI apps are stateless calls to managed models.',
    });
  }

  // Always
  out.push({
    area: 'Portability',
    decision:
      'One model interface in the code, OpenTelemetry traces, containers and infrastructure as code from the first day.',
    because: 'These cost little now and are what make a later change of model, region or cloud a configuration change.',
  });

  return out;
}

/* ---------- Is a second cloud worth it? ---------- */

export const SECOND_CLOUD_REASONS = [
  { id: 'model', label: 'A model we need is not served on our cloud in our region', weight: 2 },
  { id: 'mandate', label: 'The client or regulator requires their own cloud', weight: 3 },
  { id: 'data', label: 'The data already lives on the other cloud and is too large to move', weight: 2 },
  { id: 'resilience', label: 'We need to survive a whole-provider outage', weight: 1 },
  { id: 'price', label: 'The other cloud is cheaper for this workload', weight: 0 },
] as const;

export const SECOND_CLOUD_COSTS = [
  { id: 'identity', label: 'A second identity model, network and policy set to secure' },
  { id: 'egress', label: 'Egress charges for data that crosses between clouds' },
  { id: 'skills', label: 'People who know both platforms, on call for both' },
  { id: 'tooling', label: 'Two sets of monitoring, cost reports and deployment pipelines' },
] as const;

export interface Verdict {
  score: number;
  verdict: 'yes' | 'maybe' | 'no';
  text: string;
}

/** Weighs the reasons ticked against the four standing costs of running on two clouds. */
export function secondCloudVerdict(reasons: string[]): Verdict {
  const score = SECOND_CLOUD_REASONS.filter((r) => reasons.includes(r.id)).reduce((n, r) => n + r.weight, 0);
  if (reasons.includes('mandate') || score >= 4) {
    return {
      score,
      verdict: 'yes',
      text: 'Justified. Keep the second cloud to the part that needs it, and share one model interface, one trace format and one deployment process across both.',
    };
  }
  if (score >= 2) {
    return {
      score,
      verdict: 'maybe',
      text: 'Possibly. First check whether a different region, deployment type or model on your own cloud closes the gap; if not, put only that call on the other cloud behind your gateway.',
    };
  }
  return {
    score,
    verdict: 'no',
    text: 'Not justified. One cloud done well beats two done partly. Price differences rarely outlast the cost of a second identity model, egress and a second on-call skill set; resilience is usually met with a second region.',
  };
}
