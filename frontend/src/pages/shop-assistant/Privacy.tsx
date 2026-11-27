import { useEffect, useState } from 'react';
import type { Customer, ShopProfile, ShopService } from '@/services/shopService';
import type { ActivitySummary, Consent } from './activity';
import { message } from './errors';
import { money } from './state';

/* Choices about browsing data: the consent banner a guest sees first, the "Why am I seeing this?" panel that shows
   what the shop has worked out (and a button to forget it), and the account dialog for signing in as a demo shopper
   or making a new one. The wording is our own, in plain English. */

export function ConsentBanner({ onChoose }: { onChoose: (c: 'personalise' | 'essential') => void }) {
  return (
    <section className="sh-consent" role="region" aria-label="Your choice about browsing data">
      <div>
        <h2>Can we remember what you browse?</h2>
        <p>
          If you allow it, this browser keeps a note of the products and departments you look at, so the shop and its
          assistant can suggest things that suit you. It stays on this device until you sign in, and you can wipe it at
          any time. Essential storage only keeps the shop working: your sign-in for this tab and this choice.
        </p>
      </div>
      <div className="sh-row">
        <button type="button" className="sh-btn ghost" onClick={() => onChoose('essential')}>
          Essential only
        </button>
        <button type="button" className="sh-btn" onClick={() => onChoose('personalise')}>
          Allow personalisation
        </button>
      </div>
    </section>
  );
}

const list = (xs: (string | undefined)[] | undefined) => (xs ?? []).filter(Boolean).join(', ');

/** What the shop knows about the shopper's tastes, where it came from, and the way to wipe it. */
export function ProfilePanel({
  service,
  signedIn,
  consent,
  onConsent,
  guestSummary,
  onForget,
  changes,
}: {
  service: ShopService;
  signedIn: boolean;
  consent: Consent;
  onConsent: (c: 'personalise' | 'essential') => void;
  guestSummary: ActivitySummary | undefined;
  onForget: () => Promise<void>;
  changes: number;
}) {
  const [profile, setProfile] = useState<ShopProfile | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');

  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    setProblem('');
    service
      .profile()
      .then((p) => live && setProfile(p))
      .catch((e) => live && setProblem(message(e)));
    return () => {
      live = false;
    };
  }, [service, signedIn, changes]);

  const forget = async () => {
    if (busy) return;
    setBusy(true);
    setDone('');
    setProblem('');
    try {
      await onForget();
      setProfile(null);
      setDone('Your browsing history has been wiped.');
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(false);
    }
  };

  const band = profile?.price_band;
  return (
    <div className="sh-profile">
      <p>
        Suggestions and the assistant's ideas are based only on what you have looked at, searched for, saved and bought
        here. No other shopper's data is used, and nothing is shared outside this lab.
      </p>
      <label className="sh-check">
        <input
          type="checkbox"
          checked={consent === 'personalise'}
          onChange={(e) => onConsent(e.target.checked ? 'personalise' : 'essential')}
        />
        Remember what I browse to personalise the shop
      </label>

      {signedIn ? (
        profile ? (
          <dl className="sh-attrs">
            {!!profile.top_categories?.length && (
              <div>
                <dt>Departments you look at most</dt>
                <dd>{list(profile.top_categories.map((c) => c.category))}</dd>
              </div>
            )}
            {!!profile.subcategories?.length && (
              <div>
                <dt>Kinds of thing</dt>
                <dd>{list(profile.subcategories.map((c) => c.subcategory))}</dd>
              </div>
            )}
            {band?.median_pence !== undefined && (
              <div>
                <dt>Your usual price</dt>
                <dd>
                  around {money(band.median_pence)}
                  {band.low_pence !== undefined && band.high_pence !== undefined
                    ? ` (${money(band.low_pence)} to ${money(band.high_pence)})`
                    : ''}
                </dd>
              </div>
            )}
            {!!profile.brands?.length && (
              <div>
                <dt>Brands</dt>
                <dd>{list(profile.brands)}</dd>
              </div>
            )}
            {!!profile.sizes?.length && (
              <div>
                <dt>Sizes</dt>
                <dd>{list(profile.sizes)}</dd>
              </div>
            )}
            {!!profile.colours?.length && (
              <div>
                <dt>Colours</dt>
                <dd>{list(profile.colours)}</dd>
              </div>
            )}
            {!!profile.recently_viewed?.length && (
              <div>
                <dt>Recently viewed</dt>
                <dd>
                  {list(
                    profile.recently_viewed
                      .slice(0, 6)
                      .map((v) => `${v.title ?? v.product_id}${v.seconds ? ` (${v.seconds}s)` : ''}`),
                  )}
                </dd>
              </div>
            )}
            {!!profile.recent_searches?.length && (
              <div>
                <dt>Recent searches</dt>
                <dd>{list(profile.recent_searches.slice(0, 6))}</dd>
              </div>
            )}
            <div>
              <dt>Events recorded</dt>
              <dd>{(profile.events ?? 0).toLocaleString('en-GB')}</dd>
            </div>
          </dl>
        ) : (
          !problem && <p className="sh-fine">Loading what we know…</p>
        )
      ) : guestSummary ? (
        <dl className="sh-attrs">
          <div>
            <dt>Kept on this device</dt>
            <dd>{guestSummary.events.toLocaleString('en-GB')} events</dd>
          </div>
          {guestSummary.categories.length > 0 && (
            <div>
              <dt>Departments</dt>
              <dd>{list(guestSummary.categories.map((c) => c.category))}</dd>
            </div>
          )}
          {guestSummary.searches.length > 0 && (
            <div>
              <dt>Searches</dt>
              <dd>{list(guestSummary.searches)}</dd>
            </div>
          )}
          {guestSummary.viewed.length > 0 && (
            <div>
              <dt>Products viewed</dt>
              <dd>{guestSummary.viewed.length}</dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="sh-fine">
          {consent === 'personalise' ? 'Nothing recorded yet on this device.' : 'Nothing is being recorded.'}
        </p>
      )}

      <div className="sh-row">
        <button type="button" className="sh-btn ghost" disabled={busy} onClick={forget}>
          {busy ? 'Forgetting…' : 'Forget my browsing'}
        </button>
      </div>
      {done && (
        <p className="sh-fine" role="status">
          {done}
        </p>
      )}
      {problem && <p className="sh-error">{problem}</p>}
    </div>
  );
}

/** Signing in as one of the demo shoppers, or making a new one. There are no passwords: this is a lab. */
export function AccountDialog({
  open,
  mode,
  onMode,
  service,
  onClose,
  onSignIn,
  onCreate,
  reason,
}: {
  open: boolean;
  mode: 'sign-in' | 'create';
  onMode: (m: 'sign-in' | 'create') => void;
  service: ShopService;
  onClose: () => void;
  onSignIn: (c: Customer) => Promise<void>;
  onCreate: (name: string, email: string) => Promise<void>;
  /** Why the dialog opened, such as "Sign in to use a basket". */
  reason: string | null;
}) {
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');

  useEffect(() => {
    if (!open || mode !== 'sign-in' || customers) return;
    let live = true;
    service
      .customers(50)
      .then((c) => live && setCustomers(Array.isArray(c) ? c : []))
      .catch((e) => live && setProblem(message(e)));
    return () => {
      live = false;
    };
  }, [open, mode, customers, service]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setProblem('');
    try {
      await fn();
      onClose();
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(false);
    }
  };
  const validEmail = /^[^@\s]{1,64}@[^@\s]{1,120}\.[a-z]{2,}$/i.test(email.trim());
  return (
    <div className="sh-modal-scrim" onClick={onClose}>
      <div
        className="sh-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sh-account-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sh-row spread">
          <h2 id="sh-account-title">{mode === 'create' ? 'Create an account' : 'Sign in'}</h2>
          <button type="button" className="sh-iconbtn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {reason && <p>{reason}</p>}
        <div className="sh-tabs" role="tablist" aria-label="Account">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'sign-in'}
            className={mode === 'sign-in' ? 'on' : ''}
            onClick={() => onMode('sign-in')}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'create'}
            className={mode === 'create' ? 'on' : ''}
            onClick={() => onMode('create')}
          >
            Create account
          </button>
        </div>
        <p className="sh-fine">
          This is a lab stand-in for real sign-in: there are no passwords, and every shopper is invented. Anything you
          browsed as a guest moves into the account.
        </p>
        {mode === 'sign-in' ? (
          customers === null ? (
            !problem && <p className="sh-fine">Loading the demo shoppers…</p>
          ) : customers.length === 0 ? (
            <p>There are no demo shoppers yet. Generate the shop's data in the Lab tab first.</p>
          ) : (
            <ul className="sh-shoppers">
              {customers.map((c) => (
                <li key={c.id}>
                  <button type="button" disabled={busy} onClick={() => run(() => onSignIn(c))}>
                    <span className="sh-initial" aria-hidden="true">
                      {c.display_name.slice(0, 1)}
                    </span>
                    {c.display_name}
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <form
            className="sh-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && validEmail) void run(() => onCreate(name.trim(), email.trim()));
            }}
          >
            <label>
              Your name
              <input
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
                autoComplete="off"
                required
              />
            </label>
            <label>
              A made-up email
              <input
                type="email"
                value={email}
                maxLength={190}
                placeholder="you@example.test"
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="off"
                required
              />
            </label>
            <button type="submit" className="sh-btn" disabled={busy || !name.trim() || !validEmail}>
              {busy ? 'Creating…' : 'Create account'}
            </button>
          </form>
        )}
        {problem && <p className="sh-error">{problem}</p>}
      </div>
    </div>
  );
}
