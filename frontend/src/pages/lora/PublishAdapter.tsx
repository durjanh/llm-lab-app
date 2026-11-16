import { useEffect, useState } from 'react';
import {
  loraService,
  type AdapterCard,
  type HubAccount,
  type LoraAdapter,
  type Published,
} from '@/services/loraService';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Publishes one adapter to Hugging Face: who is signed in, the repo, the model card (written from the adapter's own
 * scores, editable), private or public, and an explicit confirmation before anything is sent.
 */
export default function PublishAdapter({ adapter, onClose }: { adapter: LoraAdapter; onClose: () => void }) {
  const [account, setAccount] = useState<HubAccount | null>(null);
  const [repo, setRepo] = useState('');
  const [card, setCard] = useState<AdapterCard | null>(null);
  const [text, setText] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<Published | null>(null);

  useEffect(() => {
    loraService
      .account(adapter.model_id)
      .then((a) => {
        setAccount(a);
        if (a.signed_in && a.suggested) setRepo(a.suggested);
      })
      .catch((e) => setError(errorText(e)));
  }, [adapter.id, adapter.model_id]);

  useEffect(() => setConfirmed(false), [repo, text, isPrivate, replace]); // a change needs a fresh yes

  async function preview() {
    setError('');
    setBusy(true);
    try {
      const c = await loraService.card(adapter.id, repo.trim());
      setCard(c);
      setText(c.card);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!card || !confirmed) return;
    setError('');
    setBusy(true);
    try {
      setDone(await loraService.publish(adapter.id, card.repo_id, isPrivate, text, replace));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lr-publish">
      <div className="lr-publish-head">
        <h3>
          Publish adapter <span className="mono">{adapter.id.slice(0, 6)}</span> to Hugging Face
        </h3>
        <button className="lr-link small" onClick={onClose}>
          close
        </button>
      </div>
      <p className="small muted">
        What goes up: the adapter's weights, its config (naming the base model, {adapter.model_id}, by its Hugging Face
        id) and a model card. Not the base model, which people download from its own page, and nothing else from this
        machine.
      </p>

      {!account && !error && <p className="small muted">Asking Hugging Face who is signed in…</p>}
      {account && !account.signed_in && (
        <div className="lr-setup small">
          The LoRA environment is not signed in to Hugging Face. Make a token with write access at{' '}
          <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noreferrer">
            huggingface.co/settings/tokens
          </a>
          , then run <code>{account.sign_in}</code> and paste it. The token stays in that environment; the lab never
          sees it. Then close this and open it again.
          {account.reason && <span className="lr-publish-reason">What Hugging Face said: {account.reason}</span>}
        </div>
      )}

      {account?.signed_in && !done && (
        <>
          <p className="small">
            Signed in as <b>{account.name}</b>
            {account.orgs && account.orgs.length > 0 && ` (you can also publish to ${account.orgs.join(', ')})`}.
          </p>
          <label className="lr-publish-field small">
            Repo
            <input
              value={repo}
              onChange={(e) => {
                setRepo(e.target.value);
                setCard(null);
              }}
              spellCheck={false}
              disabled={busy}
            />
          </label>
          {!card && (
            <button className="btn" onClick={() => void preview()} disabled={busy || !repo.includes('/')}>
              Write the model card
            </button>
          )}
          {card && (
            <>
              <label className="lr-publish-field small">
                Model card (README.md). Written from this adapter's own scores; edit anything before it goes up.
                <textarea value={text} onChange={(e) => setText(e.target.value)} rows={18} spellCheck disabled={busy} />
              </label>
              <label className="small lr-publish-check">
                <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} /> Private:
                only you can see it (and your organisation's members, for an organisation repo). Untick to make it
                public.
              </label>
              {card.existing && (
                <div className="lr-setup small">
                  <b>{card.repo_id} already exists</b> and is {card.existing.private ? 'private' : 'public'}. Publishing
                  adds a new version that replaces its README and adapter files (earlier versions stay in its history).
                  {isPrivate &&
                    !card.existing.private &&
                    ' It is public, and an upload would not make it private: publishing will be refused. Make it private on its settings page first, or choose another name.'}
                  <label className="lr-publish-check">
                    <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace
                    what is there
                  </label>
                </div>
              )}
              <label className="small lr-publish-check">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> Upload{' '}
                {card.files.join(', ')} to <span className="mono">huggingface.co/{card.repo_id}</span>, owned by{' '}
                <b>{card.repo_id.split('/')[0]}</b>, as{' '}
                <b>{(card.existing ? card.existing.private : isPrivate) ? 'a private' : 'a public'}</b> repo. A public
                repo can be copied by anyone, even after it is deleted.
              </label>
              <button
                className="btn primary"
                onClick={() => void publish()}
                disabled={busy || !confirmed || (!!card.existing && !replace)}
              >
                {busy ? 'Publishing…' : 'Publish'}
              </button>
            </>
          )}
        </>
      )}

      {done && (
        <p className="lr-publish-done">
          Published to{' '}
          <a href={done.url} target="_blank" rel="noreferrer">
            {done.url.replace('https://', '')}
          </a>{' '}
          as a <b>{done.private ? 'private' : 'public'}</b> repo
          {done.private !== isPrivate &&
            ` (it already existed as ${done.private ? 'private' : 'public'}, and an upload does not change that)`}
          .
        </p>
      )}
      {error && <p className="lr-publish-error small">{error}</p>}
    </div>
  );
}
