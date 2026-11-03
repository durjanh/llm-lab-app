import { api, type ApiClient } from './apiClient';

export interface MedAssistPatient {
  id: string;
  name: string;
}

export interface MedAssistInfo {
  ready: boolean;
  configured: boolean;
  model: string | null;
  agent: string;
  version: string | null;
  problem: string;
  patients: MedAssistPatient[];
}

export interface Appointment {
  appointment_id: string;
  with: string;
  when: string;
  kind: string;
  reason: string | null;
}

/** What the practice's systems hold for one patient, as staff would see it. */
export interface PracticeState {
  patient: {
    id: string;
    name: string;
    date_of_birth: string;
    phone: string;
    registered_gp: string;
    allergies: string;
    conditions: string;
    medications: string;
  };
  upcoming: Appointment[];
  texts: { sent_at: string; sent_to: string; body: string }[];
  audit: { at: string; actor: string; action: string; detail: string }[];
}

/** One thing the agent did on the way to its reply: a hosted tool Foundry ran, or a function tool the backend ran. */
export type MedAssistStep =
  | { tool: 'file_search'; queries: string[] }
  | { tool: 'code_interpreter'; code: string }
  | { tool: string; args: Record<string, unknown> | string; result: Record<string, unknown> };

export interface MedAssistReply {
  reply: string;
  steps: MedAssistStep[];
  cost_usd: number;
  total_usd: number;
  state: PracticeState;
}

/** MedAssist: a patient portal chat with a Microsoft Foundry prompt agent that books into a dummy practice database. */
export class MedAssistService {
  constructor(private readonly client: ApiClient) {}

  info(): Promise<MedAssistInfo> {
    return this.client.get('/api/medassist/info');
  }

  start(patientId: string): Promise<{ chat_id: string; state: PracticeState }> {
    return this.client.post('/api/medassist/chats', { patient_id: patientId });
  }

  send(chatId: string, message: string): Promise<MedAssistReply> {
    return this.client.post(`/api/medassist/chats/${encodeURIComponent(chatId)}/messages`, { message });
  }

  end(chatId: string): Promise<{ ended: boolean }> {
    return this.client.delete(`/api/medassist/chats/${encodeURIComponent(chatId)}`);
  }

  state(patientId: string): Promise<PracticeState> {
    return this.client.get(`/api/medassist/patients/${encodeURIComponent(patientId)}`);
  }

  reset(): Promise<{ reset: boolean; weeks: number }> {
    return this.client.post('/api/medassist/reset', {});
  }
}

export const medassistService = new MedAssistService(api);
