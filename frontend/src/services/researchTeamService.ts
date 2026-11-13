import { api, type ApiClient } from './apiClient';

export interface TeamQuestion {
  id: string;
  label: string;
  question: string;
}

export interface AgentDefinition {
  name: AgentName;
  description: string;
  prompt: string;
  tools: string[];
  submit_tool: string;
}

export type AgentName = 'search' | 'analysis' | 'synthesis' | 'report';

export interface TeamSource {
  id: string;
  title: string;
  publisher: string;
  date: string;
  abstract: string;
}

export interface TeamInfo {
  questions: TeamQuestion[];
  agents: AgentDefinition[];
  coordinator: { system: string; tools: string[] };
  tools: Record<string, string>;
  sources: TeamSource[];
  limits: { coordinator_turns: number; subagent_turns: number; refinements: number; fetch_retries: number };
  transient_id: string;
  blocked_id: string;
}

export interface Finding {
  claim: string;
  evidence: string;
  source_id: string;
  title: string;
  publisher: string;
  date: string;
  sub_question: string;
}

/** What a subagent sends up when it cannot resolve a failure itself. */
export interface StructuredError {
  failure_type: string;
  attempted_query: string;
  partial_results: { source_id: string; title: string }[];
  alternatives: { source_id: string; title: string }[];
  message: string;
  source_id?: string;
}

export interface Figure {
  measure: string;
  value: number;
  unit: string;
  source_id: string;
  year: number;
  date: string;
}

export interface Comparison {
  measure: string;
  relation: 'agree' | 'time_difference' | 'conflict';
  sides: { source_id: string; value: number; unit: string; year: number }[];
}

export interface SynthesisClaim {
  sub_question_id: string;
  claim: string;
  source_ids: string[];
  status: 'established' | 'contested' | 'single_source';
}

export interface AgentResult {
  agent: AgentName;
  status: 'ok' | 'partial' | 'failed';
  summary: string;
  errors: StructuredError[];
  empty_queries: string[];
  retries: { tool: string; source_id: string; failure_type: string; attempt: number }[];
  findings?: Finding[];
  rejected?: { source_id: string; reason: string }[];
  figures?: Figure[];
  comparisons?: Comparison[];
  claims?: SynthesisClaim[];
  conflicts?: { measure: string; sides: { source_id: string; value: string }[]; explanation?: string }[];
  gaps?: { sub_question_id: string; reason: string }[];
  issues?: { kind: string; claim: string; detail: string }[];
}

export interface CoverageRow {
  id: string;
  text: string;
  status: 'supported' | 'contested' | 'partial' | 'gap';
  claims: number;
  note: string;
}

export interface ReportSection {
  heading: string;
  kind: 'prose' | 'table';
  status?: 'established' | 'contested' | 'gap';
  text?: string;
  columns?: string[];
  rows?: string[][];
  source_ids: string[];
}

export interface ManifestStep {
  id: string;
  agent: AgentName;
  task: string;
  status: 'running' | 'done' | 'failed' | 'pending';
  findings_file: string | null;
  seconds?: number;
}

export interface ManifestView {
  run_id: string;
  question: string;
  status: string;
  steps: ManifestStep[];
  interrupted: ManifestStep[];
  folder: string;
}

export interface TeamRunSummary {
  run_id: string;
  question: string;
  status: string;
  done: number;
  unfinished: number;
}

export type TeamEvent =
  | { type: 'run'; run_id: string }
  | { type: 'started'; run_id: string; question: string; model: string; budget_usd: number; resumed: boolean }
  | { type: 'subquestions'; items: { id: string; text: string }[]; revision: number; added: string[] }
  | {
      type: 'turn';
      agent: 'coordinator' | AgentName;
      call_id: string;
      turn: number;
      seconds: number;
      cost_usd: number;
      input_tokens: number;
      output_tokens: number;
      text: string;
      tools: string[];
    }
  | { type: 'delegating'; agents: string[]; parallel: boolean }
  | { type: 'parallel'; agents: string[]; wall_s: number; sum_s: number; saved_s: number }
  | {
      type: 'agent_start';
      agent: AgentName;
      step: string;
      call_id: string;
      task: string;
      system: string;
      prompt: string;
      tools: string[];
      included: string[];
    }
  | {
      type: 'tool';
      agent: AgentName;
      call_id: string;
      tool: string;
      input: Record<string, unknown>;
      ok: boolean;
      attempt: number;
      result: Record<string, unknown>;
      seconds?: number;
    }
  | { type: 'retry'; agent: AgentName; call_id: string; tool: string; failure_type: string; attempt: number }
  | {
      type: 'agent_done';
      agent: AgentName;
      step: string;
      call_id: string;
      status: string;
      cached: boolean;
      task: string;
      seconds: number;
      cost_usd: number;
      result: AgentResult;
    }
  | {
      type: 'coverage';
      step: string;
      coverage: CoverageRow[];
      refinements_used: number;
      refinements_cap: number;
      unavailable: StructuredError[];
    }
  | ({ type: 'manifest' } & ManifestView)
  | {
      type: 'report';
      title: string;
      summary: string;
      sections: ReportSection[];
      cited_sources: { id: string; title: string; publisher: string; date: string }[];
      unknown_citations: string[];
      coverage: CoverageRow[];
      unavailable: StructuredError[];
      issues: { kind: string; claim: string; detail: string }[];
    }
  | { type: 'crashed'; message: string; run_id: string }
  | { type: 'note'; message: string }
  | {
      type: 'done';
      status: string;
      final: { answer: string; stopped?: string } | null;
      spent_usd: number;
      model_calls: number;
      seconds: number;
      run_id: string;
    }
  | { type: 'error'; message: string };

/** The research team: a coordinator and subagents, streamed. */
export class ResearchTeamService {
  constructor(private readonly client: ApiClient = api) {}

  info(): Promise<TeamInfo> {
    return this.client.get('/api/research-team/info');
  }

  async runs(): Promise<TeamRunSummary[]> {
    const body = await this.client.get<{ runs: TeamRunSummary[] }>('/api/research-team/runs');
    return body.runs;
  }

  run(
    question: string,
    model: string,
    budgetUsd: number,
    stopAfter: number | null,
    onEvent: (e: TeamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.client.stream(
      '/api/research-team/run',
      { question, model, budget_usd: budgetUsd, stop_after: stopAfter },
      onEvent,
      signal,
    );
  }

  resume(
    runId: string,
    model: string,
    budgetUsd: number,
    onEvent: (e: TeamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.client.stream(
      '/api/research-team/resume',
      { run_id: runId, model, budget_usd: budgetUsd },
      onEvent,
      signal,
    );
  }
}

export const researchTeamService = new ResearchTeamService();
