import { api, type ApiClient } from './apiClient';

export interface Alert {
  id: number;
  person: string;
  what: string;
  score: number;
  truth?: string;
  frames?: string[];
  has_face?: boolean;
  status: 'pending' | 'confirmed' | 'rejected' | 'expired';
  reviewer: string | null;
  note: string | null;
}

export interface Entry {
  id: number;
  alert_id: number;
  person: string;
  status: 'held' | 'active';
  reason: string;
  added_by: string | null;
  expires: string;
  thumbnail: string | null;
}

export interface Match {
  id: number;
  person: string;
  visitor?: string | null;
  score: number;
  high: number;
  status: 'open' | 'same' | 'not_same';
  staff: string | null;
  correct?: number | null;
  thumbnail: string | null;
}

export interface DeskState {
  compliance: { controller: string; lawful_basis: string; dpia_reference: string } | null;
  camera_consent: { by: string } | null;
  camera_available: boolean;
  camera_visit: { log: string[]; carrying: boolean } | null;
  default_layout: string;
  alerts: Alert[];
  watchlist: Entry[];
  matches: Match[];
  notices: { id: number; level: string; text: string; at: string }[];
  audit: { id: number; at: string; actor: string; action: string }[];
  visitors_discarded: number;
  high_score_rejected: number;
  more_alerts: boolean;
  more_visitors: boolean;
  days_ahead: number;
  high_score: number;
  hold_hours: number;
  retention_days: number;
  default_threshold: number;
}

/** The shoplifting alert desk. Every call returns the desk's whole state. */
export class StoreWatchService {
  constructor(private readonly client: ApiClient) {}

  private act(path: string, body: unknown = {}): Promise<DeskState> {
    return this.client.post<DeskState>(`/api/storewatch/${path}`, body);
  }

  state = () => this.client.get<DeskState>('/api/storewatch/state');
  compliance = (body: { controller: string; lawful_basis: string; dpia_reference: string; signage: boolean }) =>
    this.act('compliance', body);
  cameraConsent = (by: string) => this.act('camera/consent', { by, agreed: true });
  cameraAnalyse = (frames: string[], descriptor: number[] | null, thumbnail: string | null, layout: string) =>
    this.client.post<
      DeskState & {
        last_camera: { score: number; what: string; alerted: boolean; left_unpaid: boolean; carrying: boolean };
      }
    >('/api/storewatch/camera/analyse', { frames, descriptor, thumbnail, layout });
  cameraDoor = (descriptor: number[], threshold: number) => this.act('camera/door', { descriptor, threshold });
  nextAlert = () => this.act('alerts/next');
  review = (id: number, body: { reviewer: string; theft: boolean; note: string; watched_footage: boolean }) =>
    this.act(`alerts/${id}/review`, body);
  nextVisitor = (threshold: number) => this.act('door/next', { threshold });
  decide = (id: number, staff: string, same_person: boolean) =>
    this.act(`matches/${id}/decide`, { staff, same_person });
  remove = (id: number, by: string, reason: string) => this.act(`watchlist/${id}/remove`, { by, reason });
  advance = (days: number) => this.act(`advance/${days}`);
  reset = () => this.act('reset');
}

export const storeWatchService = new StoreWatchService(api);
