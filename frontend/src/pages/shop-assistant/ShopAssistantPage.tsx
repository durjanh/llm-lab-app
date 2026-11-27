import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fitEffortFor, type ComposerFile, type ComposerModel, type Uploading } from '@/components/chat/ChatComposer';
import {
  shopService,
  type Basket,
  type ChatRequest,
  type Confirmation,
  type Customer,
  type Effort,
  type Product,
  type Recommendation,
  type Session,
  type ShopInfo,
} from '@/services/shopService';
import { ApiError } from '@/services/apiClient';
import { ActivityTracker, browserStorage, signInWithHistory, type Consent } from './activity';
import { ChatWidget } from './ChatWidget';
import { isExpired, message } from './errors';
import { LabPanel } from './LabPanel';
import { ConfirmationCard, LogoMark } from './parts';
import { AccountDialog, ConsentBanner, ProfilePanel } from './Privacy';
import {
  basketCount,
  chatContext,
  chipReply,
  EMPTY_CHAT,
  endTurn,
  money,
  pageName,
  reduce,
  settleConfirmation,
  startTurn,
  type AccountTab,
  type ChatState,
  type View,
} from './state';
import { Account, BasketDrawer, DEPARTMENTS, Home, ProductView, SearchView } from './Storefront';
import './shop.css';

/* Shopping Assistant: an invented shop, Larkfield & Co., with its AI assistant in a chat panel. The shop's own
   screens and the assistant work on the same basket, orders and wish list, and the chat is told where the shopper
   is. Guests browse freely; what they browse is kept only with their consent and moves into an account on sign-in. */

const PROVIDER: Record<string, string> = {
  anthropic: 'Claude',
  'azure-openai': 'GPT on Azure',
  local: 'On this machine',
};
const PICTURES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_PICTURE = 10 * 1024 * 1024;
const RETURN_REASONS = ["It doesn't fit", 'Not as described', 'Arrived damaged', 'Changed my mind'];

export default function ShopAssistantPage() {
  const service = shopService;
  const tracker = useMemo(
    () => new ActivityTracker({ storage: browserStorage(), send: (events) => service.sendEvents(events) }),
    [service],
  );

  const [info, setInfo] = useState<ShopInfo | null>(null);
  const [infoProblem, setInfoProblem] = useState('');
  const [session, setSession] = useState<Session | null>(service.session);
  const [consent, setConsentState] = useState<Consent>(tracker.consent);
  const [view, setViewState] = useState<View>({ kind: 'home' });
  const history = useRef<View[]>([]);
  const [query, setQuery] = useState('');
  const [navOpen, setNavOpen] = useState(false);
  const [accountMenu, setAccountMenu] = useState(false);
  const [dialog, setDialog] = useState<{ mode: 'sign-in' | 'create'; reason: string | null } | null>(null);
  const [toast, setToast] = useState('');
  const [localChanges, setLocalChanges] = useState(0);

  const [basket, setBasket] = useState<Basket | null>(null);
  const [basketOpen, setBasketOpen] = useState(false);
  const [basketBusy, setBasketBusy] = useState(false);
  const [basketProblem, setBasketProblem] = useState('');
  const [checkout, setCheckout] = useState<{
    c: Confirmation;
    state: 'pending' | 'accepted' | 'cancelled' | 'failed';
  } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [recommended, setRecommended] = useState<Recommendation[]>([]);
  const [returning, setReturning] = useState<{
    itemId: string;
    title: string;
    reason: string;
    c: Confirmation | null;
    state: 'pending' | 'accepted' | 'cancelled' | 'failed';
    problem: string;
  } | null>(null);

  const [chat, setChat] = useState<ChatState>(EMPTY_CHAT);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const [chatOpen, setChatOpen] = useState(false);
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;
  const [unread, setUnread] = useState(false);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<ComposerFile[]>([]);
  const [uploading, setUploading] = useState<Uploading[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('medium');
  const [auto, setAuto] = useState(false);
  const [lastAuto, setLastAuto] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const signedIn = !!session;
  useEffect(() => tracker.setSignedIn(signedIn), [tracker, signedIn]);

  const say = useCallback((t: string) => setToast(t), []);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(''), 3500);
    return () => window.clearTimeout(id);
  }, [toast]);

  // ----- loading -----
  const loadInfo = useCallback(() => {
    service
      .info()
      .then((i) => {
        setInfo(i);
        setInfoProblem('');
        setModel((m) => m || i.default_model);
      })
      .catch((e) => setInfoProblem(message(e)));
  }, [service]);
  useEffect(loadInfo, [loadInfo]);

  /** The session has gone (expired, or the backend restarted): back to guest, keeping nothing of the old shopper. */
  const expire = useCallback(() => {
    service.signOut();
    tracker.setSignedIn(false);
    setSession(null);
    setBasket(null);
    say('Your session ended, so you are browsing as a guest. Sign in again to see your basket.');
  }, [service, tracker, say]);

  const refreshBasket = useCallback(() => {
    if (!service.session) return setBasket(null);
    service
      .basket()
      .then(setBasket)
      .catch((e) => (isExpired(e) ? expire() : setBasketProblem(message(e))));
  }, [service, expire]);
  useEffect(refreshBasket, [refreshBasket, session]);

  // The agent's basket events update the shop at once; other changes (orders, wish list) reload the panels.
  useEffect(() => {
    if (chat.basket) setBasket(chat.basket);
  }, [chat.basket]);
  const changes = chat.changes + localChanges;

  useEffect(() => {
    if (view.kind !== 'home') return;
    const summary = tracker.summary();
    if (!signedIn && !summary) {
      setRecommended([]); // a guest without consent, or with nothing browsed: nothing is sent
      return;
    }
    let live = true;
    service
      .recommendations(signedIn ? undefined : summary, 8)
      .then((r) => live && setRecommended(Array.isArray(r?.items) ? r.items.filter((x) => x?.product?.id) : []))
      .catch(() => live && setRecommended([]));
    return () => {
      live = false;
    };
  }, [service, tracker, view.kind, signedIn, consent, changes]);

  // ----- moving around the shop -----
  const go = useCallback((next: View) => {
    setViewState((cur) => {
      history.current = [...history.current.slice(-20), cur];
      return next;
    });
    setNavOpen(false);
    setAccountMenu(false);
    window.scrollTo?.({ top: 0 });
  }, []);
  const back = () => setViewState(history.current.pop() ?? { kind: 'home' });

  const page = pageName(basketOpen ? { kind: 'basket' } : view);

  // Seconds on a product page, recorded when the shopper leaves it.
  const viewingId = view.kind === 'product' ? view.id : null;
  useEffect(() => {
    if (!viewingId) return;
    const start = Date.now();
    return () => {
      tracker.record('view_product', { product_id: viewingId, seconds: (Date.now() - start) / 1000 }, 'product');
    };
  }, [viewingId, tracker]);

  const searchFor = (q: string, category?: string) => {
    const clean = q.trim().slice(0, 200);
    if (!clean && !category) return;
    if (clean) tracker.record('search', { query: clean, filters: category ? { category } : {} }, page);
    go({ kind: 'search', query: clean, category });
  };
  const department = (d: string) => {
    tracker.record('view_category', { category: d }, page);
    go({ kind: 'search', query: '', category: d });
  };
  const viewProduct = (p: Product) => {
    go({ kind: 'product', id: p.id });
    if (window.matchMedia?.('(max-width: 720px)').matches) setChatOpen(false);
  };

  const needAccount = (reason: string) => setDialog({ mode: 'sign-in', reason });

  // ----- the shopper's own things -----
  const addToBasket = async (p: Product, size?: string) => {
    if (!signedIn) return needAccount('Sign in or create an account to use a basket.');
    if (adding) return;
    setAdding(p.id);
    try {
      setBasket(await service.addToBasket(p.id, 1, size));
      tracker.record('add_to_basket', { product_id: p.id, qty: 1 }, page);
      say(`Added ${p.title} to your basket.`);
    } catch (e) {
      if (isExpired(e)) expire();
      else say(message(e));
    } finally {
      setAdding(null);
    }
  };

  const saveForLater = async (p: Product) => {
    if (!signedIn) return needAccount('Sign in or create an account to save things for later.');
    try {
      await service.addToWishlist(p.id);
      tracker.record('add_to_wishlist', { product_id: p.id }, page);
      setLocalChanges((n) => n + 1);
      say(`Saved ${p.title} for later.`);
    } catch (e) {
      if (isExpired(e)) expire();
      else say(message(e));
    }
  };

  const basketCall = async (fn: () => Promise<Basket>) => {
    if (basketBusy) return;
    setBasketBusy(true);
    setBasketProblem('');
    try {
      setBasket(await fn());
      setCheckout(null); // the basket changed, so an earlier checkout summary is out of date
    } catch (e) {
      if (isExpired(e)) expire();
      else setBasketProblem(message(e));
    } finally {
      setBasketBusy(false);
    }
  };

  const startCheckout = async (delivery: 'standard' | 'next_day') => {
    if (basketBusy) return;
    setBasketBusy(true);
    setBasketProblem('');
    try {
      tracker.record('checkout_started', {}, 'basket');
      setCheckout({ c: await service.checkout(delivery), state: 'pending' });
    } catch (e) {
      if (isExpired(e)) expire();
      else setBasketProblem(message(e));
    } finally {
      setBasketBusy(false);
    }
  };

  /** Confirm or Cancel on any confirmation card: the order or return happens only here, never from the model. */
  const answerConfirmation = async (
    id: string,
    accept: boolean,
  ): Promise<'accepted' | 'cancelled' | 'failed' | null> => {
    if (confirming) return null;
    setConfirming(id);
    try {
      const r = await service.confirm(id, accept);
      const outcome = accept && !r?.cancelled ? 'accepted' : 'cancelled';
      setChat((s) => settleConfirmation(s, id, outcome));
      if (r?.basket) setBasket(r.basket);
      else refreshBasket();
      setLocalChanges((n) => n + 1);
      if (outcome === 'accepted') say(r?.return ? 'Your return has been started.' : 'Your order has been placed.');
      return outcome;
    } catch (e) {
      if (isExpired(e)) expire();
      // A confirmation the server no longer has cannot be retried; anything else leaves the buttons for another go.
      if (e instanceof ApiError && (e.status === 404 || e.status === 409 || e.status === 410)) {
        setChat((s) => settleConfirmation(s, id, 'failed'));
        return 'failed';
      }
      say(message(e));
      return null;
    } finally {
      setConfirming(null);
    }
  };

  const startReturn = async () => {
    if (!returning || returning.c) return;
    try {
      const c = await service.startReturn(returning.itemId, returning.reason);
      setReturning((r) => r && { ...r, c, problem: '' });
    } catch (e) {
      if (isExpired(e)) expire();
      setReturning((r) => r && { ...r, problem: message(e) });
    }
  };

  // ----- accounts -----
  const afterSignIn = (s: Session) => {
    setSession(s);
    setChat(EMPTY_CHAT); // a different shopper must not see the last one's conversation
    setLocalChanges((n) => n + 1);
    say(`Signed in as ${s.customer.display_name}.`);
  };
  const signIn = async (c: Customer) => {
    abort.current?.abort();
    afterSignIn(await signInWithHistory(tracker, (events) => service.signIn(c.id, events)));
  };
  const createAccount = async (name: string, email: string) => {
    abort.current?.abort();
    afterSignIn(await signInWithHistory(tracker, (events) => service.createAccount(name, email, events)));
  };
  const signOut = async () => {
    abort.current?.abort();
    await tracker.flush().catch(() => undefined);
    service.signOut();
    tracker.setSignedIn(false);
    tracker.clearLocal(); // back to a guest with an empty history
    setSession(null);
    setBasket(null);
    setChat(EMPTY_CHAT);
    setCheckout(null);
    setAccountMenu(false);
    go({ kind: 'home' });
    say('Signed out. You are browsing as a guest.');
  };
  const chooseConsent = (c: 'personalise' | 'essential') => {
    tracker.setConsent(c);
    setConsentState(c);
    setLocalChanges((n) => n + 1);
  };
  const forget = async () => {
    if (signedIn) await service.forgetActivity();
    tracker.clearLocal();
    setRecommended([]);
    setLocalChanges((n) => n + 1);
  };

  // ----- the chat -----
  const models: ComposerModel[] = useMemo(
    () =>
      (info?.models ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        group: PROVIDER[m.provider] ?? m.provider,
        efforts: m.efforts,
        meta: m.context_window ? `${Math.round(m.context_window / 1000)}k` : undefined,
      })),
    [info],
  );
  const chosen = info?.models.find((m) => m.id === model);
  const dbDown = !!info && !info.db.available;
  const pictureBlock =
    attachments.length > 0 && !auto && chosen?.images === false
      ? `${chosen.name} cannot read pictures. Choose another model, or remove the picture.`
      : null;
  const blocked = infoProblem
    ? 'The shop server cannot be reached.'
    : dbDown
      ? 'The shop database is not running, so the assistant is switched off.'
      : info && info.data.products === 0
        ? 'There are no products yet. Make the data in the Lab tab first.'
        : uploading.length
          ? 'Waiting for the pictures to upload.'
          : pictureBlock;
  const notice =
    attachments.length > 0 && !auto && chosen && chosen.images === undefined && chosen.provider === 'local'
      ? 'This model may not read pictures.'
      : null;

  /** Sends a message; `begin` lets a quick-reply chip mark its question answered in the same step. */
  const send = async (raw: string, begin?: (s: ChatState) => ChatState): Promise<boolean> => {
    const t = raw.trim();
    if (!t || abort.current || chatRef.current.running || blocked || !model) return false;
    const ctl = new AbortController();
    abort.current = ctl;
    const files = attachments;
    setAttachments([]);
    setProblems([]);
    setChat((s) =>
      begin
        ? begin(s)
        : startTurn(
            s,
            t,
            files.map((f) => f.name),
          ),
    );
    const body: ChatRequest = {
      session_id: chatRef.current.sessionId ?? undefined,
      text: t.slice(0, 4000),
      model,
      effort: auto ? '' : (fitEffortFor(chosen?.efforts ?? [], effort) as Effort | ''),
      auto,
      context: chatContext(basketOpen ? { kind: 'basket' } : view, tracker.summary()),
      attachments: files.map((f) => f.id),
    };
    service
      .chat(
        body,
        (e) => {
          if (ctl.signal.aborted) return;
          setChat((s) => reduce(s, e));
          if (e.type === 'route') setLastAuto(e.model);
          if ((e.type === 'done' || e.type === 'question' || e.type === 'confirmation') && !chatOpenRef.current)
            setUnread(true);
        },
        ctl.signal,
      )
      .then(() => {
        if (!ctl.signal.aborted) setChat((s) => (s.running ? endTurn(s, 'error') : s));
      })
      .catch((e) => {
        if (ctl.signal.aborted) return;
        if (isExpired(e) && signedIn) expire();
        const why =
          isExpired(e) && !signedIn ? 'Sign in from the account menu to chat with the assistant.' : message(e);
        setChat((s) => endTurn(s, 'error', why));
      })
      .finally(() => {
        if (abort.current === ctl) abort.current = null;
      });
    return true;
  };

  const stop = () => {
    const ctl = abort.current;
    if (!ctl) return;
    ctl.abort();
    abort.current = null;
    setChat((s) => endTurn(s, 'stopped'));
  };

  const chip = (questionId: string, choice: string) => {
    if (chipReply(chatRef.current, questionId, choice) === null) return;
    void send(choice, (s) => chipReply(s, questionId, choice) ?? s);
  };

  const pick = async (files: File[]) => {
    const bad: string[] = [];
    const room = Math.max(0, 4 - attachments.length - uploading.length);
    const ok = files.filter((f) => {
      if (!PICTURES.includes(f.type)) bad.push(`${f.name}: only pictures (PNG, JPEG, WebP or GIF) can be attached.`);
      else if (f.size > MAX_PICTURE) bad.push(`${f.name}: pictures can be up to 10 MB.`);
      else return true;
      return false;
    });
    if (ok.length > room) bad.push(`Up to 4 pictures at a time.`);
    const take = ok.slice(0, room);
    setProblems(bad);
    if (!take.length) return;
    if (!signedIn) return setProblems([...bad, 'Sign in to attach pictures.']);
    setUploading(take.map((f) => ({ name: f.name, progress: 0 })));
    try {
      const done = await service.upload(take, (p) => setUploading(take.map((f) => ({ name: f.name, progress: p }))));
      setAttachments((a) => [...a, ...(done ?? []).map((u) => ({ id: u.id, name: u.name, size: u.size }))]);
    } catch (e) {
      if (isExpired(e)) expire();
      setProblems([...bad, message(e)]);
    } finally {
      setUploading([]);
    }
  };

  const openChat = (prefill?: string) => {
    setChatOpen(true);
    setUnread(false);
    if (prefill && !chatRef.current.running) setText(prefill);
  };

  useEffect(() => {
    if (!basketOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setBasketOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [basketOpen]);

  const name = session?.customer.display_name ?? null;
  const count = basketCount(basket);
  const accountTab = (tab: AccountTab) => go({ kind: 'account', tab });

  return (
    <main className={`page-shop-assistant${chatOpen ? ' chat-open' : ''}`}>
      <a className="sh-skip" href="#sh-content">
        Skip to the shop
      </a>
      <header className="sh-header">
        <div className="sh-header-row">
          <button
            type="button"
            className="sh-iconbtn sh-burger"
            aria-label="Departments"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((o) => !o)}
          >
            ☰
          </button>
          <button type="button" className="sh-brand" onClick={() => go({ kind: 'home' })}>
            <LogoMark size={34} />
            <span>
              Larkfield <em>&amp;</em> Co.
            </span>
          </button>
          <form
            className="sh-searchbox"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              searchFor(query);
            }}
          >
            <label htmlFor="sh-q" className="sh-hidden">
              Search the shop
            </label>
            <input
              id="sh-q"
              type="search"
              value={query}
              maxLength={200}
              placeholder="Search for boots, lamps, headphones…"
              onChange={(e) => setQuery(e.target.value)}
            />
            <button type="submit" aria-label="Search">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="6" />
                <path d="M16 16l4 4" />
              </svg>
            </button>
          </form>
          <div className="sh-menu-wrap">
            <button
              type="button"
              className="sh-account-btn"
              aria-haspopup="menu"
              aria-expanded={accountMenu}
              onClick={() => setAccountMenu((o) => !o)}
            >
              <span className="sh-initial" aria-hidden="true">
                {name ? name.slice(0, 1) : '?'}
              </span>
              <span className="sh-account-label">{name ? name.split(' ')[0] : 'Sign in'}</span>
            </button>
            {accountMenu && (
              <div className="sh-menu" role="menu">
                {signedIn ? (
                  <>
                    <p className="sh-menu-note">Signed in as {name}</p>
                    <button type="button" role="menuitem" onClick={() => accountTab('orders')}>
                      Your orders
                    </button>
                    <button type="button" role="menuitem" onClick={() => accountTab('wishlist')}>
                      Saved for later
                    </button>
                    <button type="button" role="menuitem" onClick={() => accountTab('profile')}>
                      Why am I seeing this?
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setAccountMenu(false);
                        setDialog({ mode: 'sign-in', reason: null });
                      }}
                    >
                      Switch demo shopper
                    </button>
                    <button type="button" role="menuitem" onClick={signOut}>
                      Sign out
                    </button>
                  </>
                ) : (
                  <>
                    <p className="sh-menu-note">You are browsing as a guest.</p>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setAccountMenu(false);
                        setDialog({ mode: 'sign-in', reason: null });
                      }}
                    >
                      Sign in
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setAccountMenu(false);
                        setDialog({ mode: 'create', reason: null });
                      }}
                    >
                      Create account
                    </button>
                    <button type="button" role="menuitem" onClick={() => accountTab('profile')}>
                      Why am I seeing this?
                    </button>
                  </>
                )}
                <button type="button" role="menuitem" onClick={() => go({ kind: 'lab' })}>
                  Lab: data and checks
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className="sh-basket-btn"
            onClick={() =>
              signedIn ? setBasketOpen(true) : needAccount('Sign in or create an account to use a basket.')
            }
            aria-label={`Basket, ${count} item${count === 1 ? '' : 's'}, ${money(basket?.total_pence ?? 0)}`}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 8h14l-1.5 11h-11z" />
              <path d="M9 8a3 3 0 0 1 6 0" />
            </svg>
            {count > 0 && <span className="sh-count">{count}</span>}
            <span className="sh-basket-total">{money(basket?.total_pence ?? 0)}</span>
          </button>
        </div>
        <nav className={`sh-nav${navOpen ? ' open' : ''}`} aria-label="Departments">
          {DEPARTMENTS.map((d) => (
            <button
              key={d}
              type="button"
              className={view.kind === 'search' && view.category === d ? 'on' : ''}
              onClick={() => department(d)}
            >
              {d}
            </button>
          ))}
          <span className="sh-grow" />
          <button type="button" className={view.kind === 'lab' ? 'on' : ''} onClick={() => go({ kind: 'lab' })}>
            Lab
          </button>
        </nav>
      </header>
      <p className="sh-delivery-bar">
        Free standard delivery on orders over £50 · Next-day delivery if you order by 8pm · 30 days to change your mind
      </p>

      {(dbDown || infoProblem) && (
        <div className="sh-banner" role="alert">
          <strong>{infoProblem ? 'The shop server cannot be reached.' : 'The shop database is not running.'}</strong>
          <p>
            {infoProblem ||
              info?.db.message ||
              'The catalogue, baskets and orders live in the lab’s PostgreSQL with pgvector.'}{' '}
            Run <code>./tools/shop-data.sh</code>: it starts the database and the local embedding model (
            <code>LLM_LAB_LOCAL_EMBED_MODEL</code>, for search by meaning) and creates the shop&rsquo;s tables. The
            assistant is switched off until then.
          </p>
          <button type="button" className="sh-btn ghost small" onClick={loadInfo}>
            Check again
          </button>
        </div>
      )}

      {consent === null && <ConsentBanner onChoose={chooseConsent} />}

      <div id="sh-content" className="sh-content">
        {view.kind === 'home' && (
          <Home
            service={service}
            onView={viewProduct}
            onAdd={addToBasket}
            adding={adding}
            onDepartment={department}
            onAsk={(t) => openChat(t)}
            offers={info?.offers}
            recommended={recommended}
          />
        )}
        {view.kind === 'search' && (
          <SearchView
            key={`${view.query}|${view.category ?? ''}`} // a new search starts with no filters set
            service={service}
            query={view.query}
            category={view.category}
            onView={viewProduct}
            onAdd={addToBasket}
            adding={adding}
            onFilter={(name, value) => tracker.record('filter', { name, value }, 'search')}
          />
        )}
        {view.kind === 'product' && (
          <ProductView
            service={service}
            id={view.id}
            onAdd={addToBasket}
            adding={adding}
            onWish={saveForLater}
            onAsk={(t) => openChat(t)}
            onBack={back}
          />
        )}
        {view.kind === 'account' &&
          (signedIn || view.tab === 'profile' ? (
            signedIn ? (
              <Account
                service={service}
                tab={view.tab}
                onTab={(t) => setViewState({ kind: 'account', tab: t })}
                onView={viewProduct}
                onAdd={addToBasket}
                adding={adding}
                changes={changes}
                onReturn={(itemId, title) =>
                  setReturning({ itemId, title, reason: RETURN_REASONS[0], c: null, state: 'pending', problem: '' })
                }
                profile={
                  <ProfilePanel
                    service={service}
                    signedIn
                    consent={consent}
                    onConsent={chooseConsent}
                    guestSummary={undefined}
                    onForget={forget}
                    changes={changes}
                  />
                }
              />
            ) : (
              <section className="sh-account">
                <h1>Why am I seeing this?</h1>
                <ProfilePanel
                  service={service}
                  signedIn={false}
                  consent={consent}
                  onConsent={chooseConsent}
                  guestSummary={consent === 'personalise' ? tracker.summary() : undefined}
                  onForget={forget}
                  changes={changes}
                />
              </section>
            )
          ) : (
            <section className="sh-account">
              <h1>Your account</h1>
              <p>Sign in or create an account to see your orders, returns and saved items.</p>
              <div className="sh-row">
                <button type="button" className="sh-btn" onClick={() => setDialog({ mode: 'sign-in', reason: null })}>
                  Sign in
                </button>
                <button
                  type="button"
                  className="sh-btn ghost"
                  onClick={() => setDialog({ mode: 'create', reason: null })}
                >
                  Create account
                </button>
              </div>
            </section>
          ))}
        {view.kind === 'lab' && (
          <LabPanel service={service} info={info} onRefresh={loadInfo} onAsk={(t) => openChat(t)} />
        )}
      </div>

      <footer className="sh-footer">
        <LogoMark size={22} />
        <p>
          Larkfield &amp; Co. is an invented shop in LLM Lab. Every product, shopper and order is made up, and nothing
          is sold or charged.
        </p>
      </footer>

      <BasketDrawer
        open={basketOpen}
        basket={basket}
        onClose={() => setBasketOpen(false)}
        onQuantity={(id, q) => void basketCall(() => service.updateBasketItem(id, q))}
        onRemove={(id) => {
          const item = basket?.items.find((i) => i.id === id);
          if (item) tracker.record('remove_from_basket', { product_id: item.product_id }, 'basket');
          void basketCall(() => service.removeBasketItem(id));
        }}
        onCheckout={startCheckout}
        busy={basketBusy}
        problem={basketProblem}
        confirmation={
          checkout && (
            <ConfirmationCard
              confirmation={checkout.c}
              state={checkout.state}
              busy={confirming === checkout.c.confirmation_id}
              onAnswer={async (accept) => {
                const outcome = await answerConfirmation(checkout.c.confirmation_id, accept);
                if (outcome) setCheckout((c) => c && { ...c, state: outcome });
              }}
            />
          )
        }
      />

      {returning && (
        <div className="sh-modal-scrim" onClick={() => setReturning(null)}>
          <div
            className="sh-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="sh-return-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sh-row spread">
              <h2 id="sh-return-title">Return {returning.title}</h2>
              <button type="button" className="sh-iconbtn" onClick={() => setReturning(null)} aria-label="Close">
                ×
              </button>
            </div>
            {!returning.c ? (
              <>
                <label className="sh-form">
                  Why are you sending it back?
                  <select
                    value={returning.reason}
                    onChange={(e) => setReturning((r) => r && { ...r, reason: e.target.value })}
                  >
                    {RETURN_REASONS.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </label>
                <button type="button" className="sh-btn" onClick={startReturn}>
                  Continue
                </button>
              </>
            ) : (
              <ConfirmationCard
                confirmation={returning.c}
                state={returning.state}
                busy={confirming === returning.c.confirmation_id}
                onAnswer={async (accept) => {
                  const id = returning.c?.confirmation_id;
                  if (!id) return;
                  const outcome = await answerConfirmation(id, accept);
                  if (outcome) setReturning((r) => r && { ...r, state: outcome });
                }}
              />
            )}
            {returning.problem && <p className="sh-error">{returning.problem}</p>}
          </div>
        </div>
      )}

      <AccountDialog
        open={!!dialog}
        mode={dialog?.mode ?? 'sign-in'}
        onMode={(mode) => setDialog((d) => ({ mode, reason: d?.reason ?? null }))}
        service={service}
        onClose={() => setDialog(null)}
        onSignIn={signIn}
        onCreate={createAccount}
        reason={dialog?.reason ?? null}
      />

      <button
        type="button"
        className={`sh-launcher${chatOpen ? ' hidden' : ''}`}
        onClick={() => openChat()}
        aria-label={`Chat with Wren, the shop's AI assistant${unread ? ' (new reply)' : ''}`}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 5h16v11H9l-5 4z" />
        </svg>
        {unread && <span className="sh-unread" aria-hidden="true" />}
      </button>

      <ChatWidget
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        chat={chat}
        onSend={(t) => send(t)}
        onStop={stop}
        onChip={chip}
        onConfirm={(id, accept) => void answerConfirmation(id, accept)}
        confirming={confirming}
        onView={viewProduct}
        onAdd={addToBasket}
        adding={adding}
        onNewChat={() => {
          stop();
          setChat((s) => ({ ...EMPTY_CHAT, basket: s.basket, changes: s.changes }));
        }}
        onClear={() => {
          stop();
          setChat((s) => ({ ...s, messages: [] }));
        }}
        shopperName={name}
        blocked={blocked}
        notice={notice}
        text={text}
        onText={setText}
        attachments={attachments}
        uploading={uploading}
        problems={problems}
        onPick={(f) => void pick(f)}
        onRemove={(id) => setAttachments((a) => a.filter((x) => x.id !== id))}
        models={models}
        model={model}
        effort={fitEffortFor(chosen?.efforts ?? [], effort)}
        onModel={(m, e) => {
          setModel(m);
          setEffort(e);
        }}
        onEffort={setEffort}
        auto={auto}
        onAuto={setAuto}
        lastAuto={lastAuto}
      />

      <div className="sh-toast" role="status" aria-live="polite">
        {toast}
      </div>
    </main>
  );
}
