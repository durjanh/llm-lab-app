/* Code samples for the LLMOps page, as plain text; the page highlights them. */

export const githubActions = `# One pipeline for an AI service: test, gate on evals, build once, staging, canary, production.
# Azure sign-in is OpenID Connect (workload identity federation): no secret is stored anywhere.
name: release
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: pip install -r requirements.txt
      - run: pytest backend          # a fake model: no key, no cost

  eval-gate:
    needs: test
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write                # lets the job ask GitHub for its OIDC token
    steps:
      - uses: actions/checkout@v4
      - uses: azure/login@v2
        with:
          client-id: \${{ vars.AZURE_CLIENT_ID }}
          tenant-id: \${{ vars.AZURE_TENANT_ID }}
          subscription-id: \${{ vars.AZURE_SUBSCRIPTION_ID }}
      - run: pip install httpx azure-identity
      - name: Evaluation gate        # exits 1 under the thresholds, which stops the run
        run: |
          python examples/foundry-cicd/eval_gate.py --endpoint "\${{ vars.EVAL_ENDPOINT }}" \\
            --min-groundedness 4.0 --min-relevance 4.0

  build:
    needs: eval-gate
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: azure/login@v2
        with:
          client-id: \${{ vars.AZURE_CLIENT_ID }}
          tenant-id: \${{ vars.AZURE_TENANT_ID }}
          subscription-id: \${{ vars.AZURE_SUBSCRIPTION_ID }}
      - name: Build once, tag with the commit
        run: az acr build -r "\${{ vars.ACR_NAME }}" -t "api:\${{ github.sha }}" .
      - name: Scan and record an SBOM  # trivy and syft installed in an earlier step
        run: |
          IMAGE="\${{ vars.ACR_NAME }}.azurecr.io/api:\${{ github.sha }}"
          trivy image --severity CRITICAL --exit-code 1 "$IMAGE"
          syft "$IMAGE" -o spdx-json > sbom.json

  staging:
    needs: build
    runs-on: ubuntu-latest
    environment: staging
    permissions:
      id-token: write
    steps:
      - uses: azure/login@v2
        with:
          client-id: \${{ vars.AZURE_CLIENT_ID }}
          tenant-id: \${{ vars.AZURE_TENANT_ID }}
          subscription-id: \${{ vars.AZURE_SUBSCRIPTION_ID }}
      - run: |
          az containerapp update -n api -g rg-ai-staging \\
            --image "\${{ vars.ACR_NAME }}.azurecr.io/api:\${{ github.sha }}"
      - run: python scripts/smoke.py --base-url "\${{ vars.STAGING_URL }}"   # your own smoke test

  production:
    needs: staging
    runs-on: ubuntu-latest
    environment: production          # required reviewers approve here, before the job starts
    permissions:
      id-token: write
    steps:
      - uses: azure/login@v2
        with:
          client-id: \${{ vars.AZURE_CLIENT_ID }}
          tenant-id: \${{ vars.AZURE_TENANT_ID }}
          subscription-id: \${{ vars.AZURE_SUBSCRIPTION_ID }}
      - name: Canary at 5%, then watch the comparison (your own script) before going further
        run: |
          az containerapp update -n api -g rg-ai-prod \\
            --image "\${{ vars.ACR_NAME }}.azurecr.io/api:\${{ github.sha }}"
          python scripts/canary.py --share 5 --watch-minutes 30 --compare p95,refusals,cost
`;

export const azureDevOps = `# The same pipeline in Azure DevOps. The service connection uses workload identity
# federation, so it holds no secret; approvals are checks on the environments.
trigger:
  branches:
    include: [main]
pr:
  branches:
    include: [main]

pool:
  vmImage: ubuntu-latest

stages:
- stage: Test
  jobs:
  - job: unit
    steps:
    - script: pip install -r requirements.txt && pytest backend

- stage: EvalGate
  dependsOn: Test
  jobs:
  - job: gate
    steps:
    - task: AzureCLI@2
      inputs:
        azureSubscription: ai-release-wif     # workload identity federation
        scriptType: bash
        scriptLocation: inlineScript
        inlineScript: |
          pip install httpx azure-identity
          python examples/foundry-cicd/eval_gate.py --endpoint "$(EVAL_ENDPOINT)"

- stage: Build
  dependsOn: EvalGate
  condition: and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/main'))
  jobs:
  - job: image
    steps:
    - task: AzureCLI@2
      inputs:
        azureSubscription: ai-release-wif
        scriptType: bash
        scriptLocation: inlineScript
        inlineScript: az acr build -r $(ACR_NAME) -t api:$(Build.SourceVersion) .

- stage: Staging
  dependsOn: Build
  jobs:
  - deployment: staging
    environment: staging
    strategy:
      runOnce:
        deploy:
          steps:
          - task: AzureCLI@2
            inputs:
              azureSubscription: ai-release-wif
              scriptType: bash
              scriptLocation: inlineScript
              inlineScript: >
                az containerapp update -n api -g rg-ai-staging
                --image $(ACR_NAME).azurecr.io/api:$(Build.SourceVersion)

- stage: Production
  dependsOn: Staging
  jobs:
  - deployment: production
    environment: production                 # approvals and checks are set on this environment
    strategy:
      runOnce:
        deploy:
          steps:
          - script: echo "canary, watch, then promote, as in the GitHub version"
`;

export const dockerfile = `# Build stage: compilers and build tools stay here, out of the image that runs.
FROM python:3.12-slim AS build
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# Run stage: the installed packages and the code, nothing else.
FROM python:3.12-slim
RUN useradd --create-home --uid 10001 app
WORKDIR /app
COPY --from=build /install /usr/local
COPY backend/ backend/
COPY python/ python/
USER 10001
EXPOSE 8000
# No keys in the image: at run time the container signs in with its managed identity.
CMD ["uvicorn", "--factory", "backend.app.main:create_app", "--host", "0.0.0.0", "--port", "8000"]
`;

export const dockerignore = `# .dockerignore: what never goes into the build context
.env
.venv/
.git/
generated/
models/
**/*.pem
**/__pycache__/
`;

export const kubernetes = `apiVersion: v1
kind: ServiceAccount
metadata:
  name: ai-api
  annotations:
    azure.workload.identity/client-id: "<managed identity client id>"   # not a secret
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ai-api
spec:
  replicas: 3
  selector:
    matchLabels: { app: ai-api }
  template:
    metadata:
      labels:
        app: ai-api
        azure.workload.identity/use: "true"   # the pod gets a token for the identity above
    spec:
      serviceAccountName: ai-api
      containers:
      - name: api
        image: myregistry.azurecr.io/api:3f2c1ab   # the commit SHA, never latest
        ports: [{ containerPort: 8000 }]
        resources:
          requests: { cpu: 250m, memory: 512Mi }
          limits: { memory: 1Gi }
        readinessProbe:                     # no traffic until config and the model are reachable
          httpGet: { path: /healthz, port: 8000 }
          periodSeconds: 5
        livenessProbe:                      # restart a stuck process; do not call the model here
          httpGet: { path: /livez, port: 8000 }
          periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: ai-api
spec:
  selector: { app: ai-api }
  ports: [{ port: 80, targetPort: 8000 }]
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ai-api
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: ai-api }
  minReplicas: 3
  maxReplicas: 20
  metrics:
  - type: Pods                     # requests in progress, from a metrics adapter (or KEDA)
    pods:
      metric: { name: http_requests_in_flight }
      target: { type: AverageValue, averageValue: "10" }
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300   # wait five minutes before removing pods
`;
