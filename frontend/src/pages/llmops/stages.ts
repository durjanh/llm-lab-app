/* The release pipeline's stages: what each runs, where the lab does it, and what the team sees when it fails. */
import type { StageId } from './llmops';

export interface Stage {
  id: StageId;
  name: string;
  /** What runs at this stage. */
  runs: string;
  /** Where this lab does the same thing, if it does. */
  inLab: string;
  /** The message the team gets when the stage fails. */
  failure: string;
  /** Who is told, and what happens next. */
  then: string;
}

export const STAGES: Stage[] = [
  {
    id: 'pr',
    name: 'Pull request',
    runs: 'A change to code, a prompt, a tool schema, the eval set or the infrastructure opens a pull request. Checks start; the branch gets no cloud sign-in, so a branch cannot reach production resources.',
    inLab: 'The lab’s infra workflow runs a check job on pull requests with no Azure login at all.',
    failure: 'Review requested changes: the prompt edit has no linked eval result.',
    then: 'The author is asked to run the eval set locally and attach the comparison. Nothing is built.',
  },
  {
    id: 'unit',
    name: 'Lint and unit tests',
    runs: 'Formatting, type checks and unit tests against a fake model: no key, no cost, the same answer every run. They test the code around the model: parsing, tool dispatch, refusals, empty replies, timeouts.',
    inLab: '`pytest backend` runs every backend test on a fake Claude client.',
    failure:
      'test_cut_off_reply_is_not_saved failed: a reply that stopped at max_tokens was stored as a finished answer.',
    then: 'The pull request shows a red check. No model was called, so the run cost nothing.',
  },
  {
    id: 'evals',
    name: 'Offline eval gate',
    runs: 'A fixed, versioned eval set scored by code checks and an LLM judge. The gate fails on a quality threshold, and also on a cost or latency budget, so a better but twice-as-dear prompt does not slip through.',
    inLab: '`examples/foundry-cicd/eval_gate.py` exits 1 when groundedness or relevance falls under 4.0.',
    failure:
      'Groundedness 3.6 (minimum 4.0) on 40 cases; cost per task £0.021 (budget £0.015). 7 cases now quote a policy the context does not contain.',
    then: 'The release stops before anything is built. The failing cases are attached to the run so the author can read them.',
  },
  {
    id: 'build',
    name: 'Container build',
    runs: 'A multi-stage image built once and tagged with the commit SHA. The same image goes to staging and production: rebuilding per environment means testing one thing and shipping another.',
    inLab: 'The coding sandbox image is built from `examples/coding-sandbox/` and pulled by the cloud deployment.',
    failure: 'pip could not resolve: the new SDK version needs a newer httpx than the pinned one.',
    then: 'The build log points at the lock file. Nothing was pushed to the registry.',
  },
  {
    id: 'scan',
    name: 'Image scan and SBOM',
    runs: 'A vulnerability scan of the image and a software bill of materials (every package and version in it), kept with the release so a later CVE can be traced to the images that carry it.',
    inLab: 'Not in the lab’s pipeline; the YAML below shows where it goes.',
    failure: '1 critical vulnerability in the base image’s OpenSSL; a fixed base image is available.',
    then: 'The image is marked as not deployable. Bumping the base image tag and rebuilding clears it.',
  },
  {
    id: 'staging',
    name: 'Deploy to staging',
    runs: 'The image goes to a staging environment with its own model deployments, index and identity. The pipeline signs in with workload identity federation; the app reaches the model with its managed identity.',
    inLab:
      '`azd provision` creates the lab’s resources from `infra/`; `infra/pipeline.sh` sets up the federated sign-in.',
    failure:
      'Readiness probe failing: /healthz returns 503, model deployment "chat-v2" not found in the staging account.',
    then: 'The old staging version keeps serving. The deployment name lives in configuration, which the release forgot to change.',
  },
  {
    id: 'smoke',
    name: 'Smoke and online evals',
    runs: 'A handful of scripted conversations against staging, end to end: sign-in, retrieval, tools, the real model. Then the eval set again, on the deployed system rather than on the code.',
    inLab: 'The /foundry-operations page runs evaluators against live deployments.',
    failure: '5 of 20 smoke conversations got 429: staging’s model quota is 10% of production’s.',
    then: 'The team raises staging quota or adds a retry budget. A smoke test that only passes with luck is a failed smoke test.',
  },
  {
    id: 'canary',
    name: 'Canary',
    runs: 'A small share of real traffic (say 5%) goes to the new version for a set time while its error rate, p95 latency, refusal rate, cost per task and user feedback are compared with the old version on the same traffic.',
    inLab: '/model-failover shows live routing between models; the same router could split traffic by share.',
    failure: 'Canary p95 11.2 s against 6.1 s for the old version; refusal rate 4.1% against 0.9%.',
    then: 'Traffic returns to the old version automatically. The on-call channel gets the comparison and the release is marked failed.',
  },
  {
    id: 'promote',
    name: 'Promote or roll back',
    runs: 'With the canary healthy and an approval on the production environment, traffic moves to 100% in steps. The old version stays deployed, warm, until the new one has run a full day.',
    inLab: 'GitHub environments and Azure DevOps environments both hold approvals as a check on the deployment.',
    failure: 'The approver rejected the release: the change log does not mention the model version change.',
    then: 'The canary is drained back to the old version. Nothing was lost: the release can be resubmitted.',
  },
];
