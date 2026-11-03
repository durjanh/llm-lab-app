import { api, type ApiClient } from './apiClient';

export type Engine = 'claude' | 'agent-framework';
export type Urgency = 'emergency' | 'urgent' | 'routine';

/** The LACE readmission index: Length of stay, Acuity, Comorbidity, Emergency visits. */
export interface Risk {
  score: number;
  band: 'low' | 'moderate' | 'high';
  parts: { L: number; A: number; C: number; E: number };
}

export interface WorkItem {
  id: string;
  name: string;
  age: number;
  language: string;
  channel: 'voice' | 'sms';
  diagnosis: string;
  discharged_on: string;
  days_since: number;
  wave_due: 1 | 2;
  risk: Risk;
  status: string;
  open_tasks: Record<Urgency, number>;
}

export interface CareTask {
  id: number;
  patient_id: string;
  name?: string;
  outreach_id: number;
  created_at: string;
  queue: string;
  urgency: Urgency;
  reason: string;
  source: 'rule' | 'agent' | 'screen';
  status: 'open' | 'closed';
  closed_at: string | null;
  closed_note: string | null;
}

export interface AftercareStep {
  tool: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
}

/** What the hospital record holds for one patient, as the care team would see it. */
export interface HospitalRecord {
  patient: {
    id: string;
    name: string;
    date_of_birth: string;
    phone: string;
    age: number;
    language: string;
    channel: 'voice' | 'sms';
    diagnosis: string;
    discharged_on: string;
    follow_up: string;
    risk: Risk;
  };
  medications: { name: string; dose: string; change: string; high_risk: number; note: string }[];
  warning_signs: { code: string; ask_about: string; level: Urgency }[];
  outreach: {
    id: number;
    wave: number;
    engine: Engine;
    channel: string;
    language: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    summary: string | null;
  }[];
  checks: { item: string; subject: string; value: string; detail: string; at: string }[];
  tasks: CareTask[];
  appointments: { id: string; clinic: string; starts_at: string; mode: string; when: string }[];
  texts: { sent_at: string; sent_to: string; body: string }[];
  transcript: { at: string; speaker: 'agent' | 'patient'; text: string }[];
  audit: { at: string; actor: string; action: string; detail: string }[];
}

export interface Board {
  worklist: WorkItem[];
  queue: CareTask[];
}

export interface AftercareInfo extends Board {
  hospital: string;
  engines: Record<Engine, { available: boolean; model: string | null }>;
  voice_from_age: number;
  wave_2_from_day: number;
  hints: Record<string, string>;
  tools: { name: string; description: string }[];
  instructions: string;
}

export interface TurnResult {
  reply: string;
  steps: AftercareStep[];
  patient?: string;
  done: boolean;
  cost_usd: number;
  total_usd: number;
  spent_usd: number;
  checklist_left: string[];
  record: HospitalRecord;
}

export interface StartResult extends TurnResult {
  call_id: string;
  engine: Engine;
  model: string;
  wave: number;
  channel: 'voice' | 'sms';
}

export interface Check {
  check: string;
  passed: boolean;
}

export type AftercareEvalEvent =
  | { type: 'run'; run_id: string }
  | { type: 'patient'; patient_id: string; name: string; wave: number; channel: string }
  | { type: 'turn'; patient_id: string; speaker: 'agent' | 'patient'; text: string; steps?: AftercareStep[] }
  | { type: 'result'; patient_id: string; checks: Check[]; status: string; turns: number; cost_usd: number }
  | { type: 'done'; passed: number; total: number; cost_usd: number; engine: Engine; model: string; spent_usd: number }
  | { type: 'error'; message: string };

/** Aftercare: post-discharge follow-up calls by a Claude or Microsoft Agent Framework agent, written back to a dummy record. */
export class AftercareService {
  constructor(private readonly client: ApiClient) {}

  info(): Promise<AftercareInfo> {
    return this.client.get('/api/aftercare/info');
  }

  board(): Promise<Board> {
    return this.client.get('/api/aftercare/board');
  }

  record(patientId: string): Promise<HospitalRecord> {
    return this.client.get(`/api/aftercare/patients/${encodeURIComponent(patientId)}`);
  }

  start(patientId: string, engine: Engine, model?: string): Promise<StartResult> {
    return this.client.post('/api/aftercare/calls', { patient_id: patientId, engine, model });
  }

  send(callId: string, message: string): Promise<TurnResult> {
    return this.client.post(`/api/aftercare/calls/${encodeURIComponent(callId)}/messages`, { message });
  }

  /** The simulated patient answers, then the agent replies. */
  simulate(callId: string): Promise<TurnResult> {
    return this.client.post(`/api/aftercare/calls/${encodeURIComponent(callId)}/simulate`, {});
  }

  end(callId: string): Promise<{ ended: boolean }> {
    return this.client.delete(`/api/aftercare/calls/${encodeURIComponent(callId)}`);
  }

  closeTask(taskId: number, note: string): Promise<Board> {
    return this.client.post(`/api/aftercare/tasks/${taskId}/close`, { note });
  }

  reset(): Promise<Board> {
    return this.client.post('/api/aftercare/reset', {});
  }

  evaluate(
    body: { engine: Engine; model?: string; patients?: string[] },
    onEvent: (e: AftercareEvalEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.client.stream('/api/aftercare/evaluate', body, onEvent, signal);
  }
}

export const aftercareService = new AftercareService(api);
