import type { Board, Booking, HotelInfo, OutboxItem } from '@/services/hotelService';

export const pounds = (v: number) => `£${v.toFixed(2)}`;

/** 2026-11-21 -> Sat 21 Nov */
const shortDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

/** 2026-11-21 -> Sat 21 */
function dayLabel(iso: string): { day: string; date: string } {
  const d = new Date(`${iso}T12:00:00Z`);
  return {
    day: d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }),
    date: String(d.getUTCDate()),
  };
}

/** 2026-11-10T14:03:22 -> 10 Nov 14:03 */
export function when(at: string | null): string {
  if (!at) return '';
  const d = new Date(at.includes('T') ? at : at.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return at;
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

export function Calendar({ board }: { board: Board }) {
  return (
    <div className="card ho-card">
      <h3>Room calendar</h3>
      <p className="small muted">
        One row per room, one column per night. The database keeps one row for each room and night, so a night can only
        ever belong to one booking.
      </p>
      <div className="ho-legend small">
        <span>
          <i className="ho-cell held" /> held, waiting for the deposit
        </span>
        <span>
          <i className="ho-cell confirmed" /> confirmed
        </span>
        <span>
          <i className="ho-cell" /> free
        </span>
      </div>
      <div className="table-wrap">
        <table className="ho-cal">
          <thead>
            <tr>
              <th>Room</th>
              {board.nights.map((n) => {
                const l = dayLabel(n);
                return (
                  <th key={n} title={n}>
                    <span>{l.day}</span>
                    <span>{l.date}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {board.rooms.map((room) => (
              <tr key={room.number}>
                <th title={room.type_name}>
                  {room.number} <span className="muted">{room.type_code}</span>
                </th>
                {board.nights.map((n) => {
                  const cell = room.nights[n];
                  return (
                    <td key={n}>
                      <i
                        className={`ho-cell ${cell ? cell.status : ''}`}
                        title={
                          cell ? `${cell.ref} · ${cell.guest} · ${cell.status}` : `Room ${room.number}, ${n}: free`
                        }
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const STATUS_WORDS: Record<Booking['payment_status'], string> = {
  pending: 'deposit due',
  paid: 'deposit paid',
  refunded: 'deposit refunded',
  kept: 'deposit kept',
  released: 'hold released',
};

export function Bookings({ board }: { board: Board }) {
  return (
    <div className="card ho-card">
      <h3>Bookings</h3>
      {board.bookings.length === 0 ? (
        <p className="small muted">No bookings yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="t ho-bookings">
            <thead>
              <tr>
                <th>Ref</th>
                <th>Guest</th>
                <th>Room</th>
                <th>Dates</th>
                <th className="num">Total</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {board.bookings.map((b) => (
                <tr key={b.ref}>
                  <td>
                    <b>{b.ref}</b>
                  </td>
                  <td>
                    {b.guest_name}
                    <div className="small muted">{b.email}</div>
                  </td>
                  <td>
                    {b.room_number}
                    <div className="small muted">{b.type_name}</div>
                  </td>
                  <td>
                    <span className="ho-dates">
                      {shortDate(b.check_in)} →
                      <br />
                      {shortDate(b.check_out)}
                    </span>
                    <div className="small muted">
                      {b.nights} night{b.nights === 1 ? '' : 's'}, {b.adults} adult{b.adults === 1 ? '' : 's'}
                    </div>
                  </td>
                  <td className="num">
                    {pounds(b.total)}
                    <div className="small muted">deposit {pounds(b.deposit)}</div>
                  </td>
                  <td>
                    <span className={`ho-badge ${b.status}`}>{b.status}</span>
                    <div className="small muted">
                      {STATUS_WORDS[b.payment_status] ?? b.payment_status}
                      {b.refund !== null && b.refund > 0 ? ` (${pounds(b.refund)})` : ''}
                    </div>
                    {b.status === 'held' && b.hold_expires_at && (
                      <div className="small muted">hold ends {when(b.hold_expires_at)}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const DELIVERY_WORDS: Record<OutboxItem['delivery'], string> = {
  outbox: 'kept in the outbox, not sent',
  sent: 'sent',
  failed: 'failed',
};

function DeliveryBadge({ item }: { item: OutboxItem }) {
  return (
    <span className={`ho-badge ${item.delivery}`} title={item.detail || undefined}>
      {DELIVERY_WORDS[item.delivery]}
      {item.delivery === 'failed' && item.detail ? `: ${item.detail}` : ''}
    </span>
  );
}

export function Outbox({ board, info }: { board: Board; info: HotelInfo | null }) {
  const texts = board.outbox.filter((o) => o.channel === 'sms');
  const emails = board.outbox.filter((o) => o.channel === 'email');
  const real = (v?: string) => (v === 'real' ? 'sent for real' : 'kept in the outbox only');
  return (
    <div className="card ho-card">
      <h3>The guest&apos;s phone and inbox</h3>
      <p className="small muted">
        Confirmations are sent by the code when a booking is confirmed, changed or cancelled, not when the agent decides
        to. Emails are {real(info?.delivery.email)}; texts are {real(info?.delivery.sms)}.
      </p>
      <div className="ho-devices">
        <div className="ho-phone" aria-label="Text messages">
          <div className="ho-phone-bar">Messages</div>
          {texts.length === 0 ? (
            <p className="small muted ho-empty">No texts yet.</p>
          ) : (
            [...texts].reverse().map((t) => (
              <div className="ho-sms" key={t.id}>
                <div className="ho-sms-meta small muted">
                  To {t.to} · {when(t.at)}
                </div>
                <div className="ho-sms-bubble">{t.body}</div>
                <DeliveryBadge item={t} />
              </div>
            ))
          )}
        </div>
        <div className="ho-inbox" aria-label="Emails">
          <div className="ho-phone-bar">Inbox</div>
          {emails.length === 0 ? (
            <p className="small muted ho-empty">No emails yet.</p>
          ) : (
            emails.map((e) => (
              <details className="ho-mail" key={e.id}>
                <summary>
                  <b>{e.subject}</b>
                  <span className="small muted">
                    {' '}
                    · to {e.to} · {when(e.at)}
                  </span>
                </summary>
                <pre className="ho-mail-body">{e.body}</pre>
                <DeliveryBadge item={e} />
              </details>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export function Audit({ board }: { board: Board }) {
  const first = board.audit.slice(0, 20);
  const rest = board.audit.slice(20);
  const row = (a: Board['audit'][number], i: number) => (
    <li key={i}>
      <span className="muted">{when(a.at)}</span> <b>{a.actor}</b> {a.action}
      {a.detail ? <span className="muted"> · {a.detail}</span> : null}
    </li>
  );
  return (
    <div className="card ho-card">
      <h3>Audit log</h3>
      {board.audit.length === 0 ? (
        <p className="small muted">Nothing yet.</p>
      ) : (
        <>
          <ul className="ho-audit small">{first.map(row)}</ul>
          {rest.length > 0 && (
            <details className="small">
              <summary>{rest.length} older entries</summary>
              <ul className="ho-audit">{rest.map((a, i) => row(a, i + 20))}</ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
