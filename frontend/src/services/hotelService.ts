import { api, type ApiClient } from './apiClient';

export type BookingStatus = 'held' | 'confirmed' | 'cancelled' | 'expired';
export type PaymentStatus = 'pending' | 'paid' | 'refunded' | 'kept' | 'released';
export type Delivery = 'outbox' | 'sent' | 'failed';

export interface RoomType {
  code: string;
  name: string;
  sleeps: number;
  rate: number;
  description: string;
}

export interface HotelInfo {
  hotel: { name: string; town: string; check_in_time: string; check_out_time: string; policies: string[] };
  room_types: RoomType[];
  tools: { name: string; description: string }[];
  instructions: string;
  samples: { label: string; text: string }[];
  today: string;
  model: string;
  delivery: { email: 'outbox' | 'real'; sms: 'outbox' | 'real' };
}

export interface NightCell {
  ref: string;
  status: 'held' | 'confirmed';
  guest: string;
}

export interface CalendarRoom {
  number: string;
  type_code: string;
  type_name: string;
  nights: Record<string, NightCell | null>;
}

export interface Booking {
  ref: string;
  guest_name: string;
  email: string;
  phone: string;
  room_number: string;
  type_code: string;
  type_name: string;
  check_in: string;
  check_out: string;
  nights: number;
  adults: number;
  total: number;
  deposit: number;
  status: BookingStatus;
  payment_status: PaymentStatus;
  refund: number | null;
  pay_token: string | null;
  hold_expires_at: string | null;
  created_at: string;
}

export interface OutboxItem {
  id: number;
  ref: string;
  channel: 'email' | 'sms';
  to: string;
  subject: string;
  body: string;
  at: string;
  delivery: Delivery;
  detail: string;
}

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  detail: string;
}

/** The back office: the room calendar for the next 14 nights, bookings, what was sent, and the audit log. */
export interface Board {
  today: string;
  nights: string[];
  rooms: CalendarRoom[];
  bookings: Booking[];
  outbox: OutboxItem[];
  audit: AuditEntry[];
}

export interface HotelStep {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface PaymentLink {
  ref: string;
  token: string;
  amount: number;
}

export interface TurnResult {
  reply: string;
  steps: HotelStep[];
  screened: { text: string; redactions: string[] };
  cost_usd: number;
  payment_links: PaymentLink[];
  board: Board;
}

export interface ActionResult {
  ok: boolean;
  ref: string | null;
  message: string;
  board: Board;
  chat_id?: string | null; // after a payment: the conversation whose agent has been told
}

/** The agent's turn after the hotel's systems told it something, with no guest message. */
export interface UpdateResult extends Omit<TurnResult, 'screened'> {
  event?: string;
}

/** The hotel booking agent: a guest's chat, the mock payment provider, the front desk and the back office. */
export class HotelService {
  constructor(private readonly client: ApiClient) {}

  info(): Promise<HotelInfo> {
    return this.client.get('/api/hotel/info');
  }

  board(): Promise<Board> {
    return this.client.get('/api/hotel/board', { headers: { 'Cache-Control': 'no-store' } });
  }

  newChat(model?: string): Promise<{ chat_id: string; model: string }> {
    return this.client.post('/api/hotel/chats', model ? { model } : {});
  }

  send(chatId: string, message: string): Promise<TurnResult> {
    return this.client.post(`/api/hotel/chats/${encodeURIComponent(chatId)}/messages`, { message });
  }

  /** The agent's reply to what the hotel's systems told it (a deposit paid). */
  update(chatId: string): Promise<UpdateResult> {
    return this.client.post(`/api/hotel/chats/${encodeURIComponent(chatId)}/update`, {});
  }

  /** The mock payment provider. No card data is sent: paying is a button press. */
  pay(token: string): Promise<ActionResult> {
    return this.client.post(`/api/hotel/pay/${encodeURIComponent(token)}`, {});
  }

  /** Another guest books the last room of a type at the front desk, for the double-booking demo. */
  frontDesk(typeCode: string, checkIn: string, checkOut: string): Promise<ActionResult> {
    return this.client.post('/api/hotel/front-desk', { type_code: typeCode, check_in: checkIn, check_out: checkOut });
  }

  reset(): Promise<{ board: Board }> {
    return this.client.post('/api/hotel/reset', {});
  }
}

export const hotelService = new HotelService(api);
