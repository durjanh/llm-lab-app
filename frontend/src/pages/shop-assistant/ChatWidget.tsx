import { useEffect, useRef, useState } from 'react';
import { ChatComposer, type ComposerFile, type ComposerModel, type Uploading } from '@/components/chat/ChatComposer';
import type { Product } from '@/services/shopService';
import { ComparisonTable, ConfirmationCard, LogoMark, Markdown, OrderCard, ProductCard } from './parts';
import type { BotMessage, ChatState, Message } from './state';

/* The assistant as a chat panel docked on the right of the shop (full screen on phones): a header with a menu, a
   dismissible note on how chats are kept, the conversation with product cards, comparisons, quick-reply questions
   and confirmation cards, and the shared composer with the model pill and picture attachments. */

const ASSISTANT = 'Wren';

const time = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export interface ChatWidgetProps {
  open: boolean;
  onClose: () => void;
  chat: ChatState;
  onSend: (text: string) => Promise<boolean> | boolean;
  onStop: () => void;
  onChip: (questionId: string, choice: string) => void;
  onConfirm: (confirmationId: string, accept: boolean) => void;
  confirming: string | null;
  onView: (p: Product) => void;
  onAdd: (p: Product) => void;
  adding: string | null;
  onNewChat: () => void;
  onClear: () => void;
  shopperName: string | null;
  blocked: string | null;
  notice: string | null;
  text: string;
  onText: (t: string) => void;
  attachments: ComposerFile[];
  uploading: Uploading[];
  problems: string[];
  onPick: (files: File[]) => void;
  onRemove: (id: string) => void;
  models: ComposerModel[];
  model: string;
  effort: string;
  onModel: (model: string, effort: string) => void;
  onEffort: (effort: string) => void;
  auto: boolean;
  onAuto: (on: boolean) => void;
  lastAuto: string | null;
}

function BotReply({ m, props, showWork }: { m: BotMessage; props: ChatWidgetProps; showWork: boolean }) {
  const empty = m.blocks.length === 0;
  return (
    <div className="sh-msg bot">
      <span className="sh-avatar" aria-hidden="true">
        <LogoMark size={26} />
      </span>
      <div className="sh-msg-body">
        <div className="sh-bubble">
          {empty && m.live && (
            <span className="sh-typing" aria-label={`${ASSISTANT} is typing`}>
              <i />
              <i />
              <i />
            </span>
          )}
          {m.blocks.map((b, i) => {
            switch (b.kind) {
              case 'text':
                return <Markdown key={i} text={b.text} />;
              case 'products':
                return (
                  <div key={i} className="sh-chat-products">
                    {b.items.map((p) => (
                      <ProductCard
                        key={p.id}
                        product={p}
                        compact
                        onView={props.onView}
                        onAdd={props.onAdd}
                        busy={props.adding === p.id}
                      />
                    ))}
                  </div>
                );
              case 'comparison':
                return <ComparisonTable key={i} comparison={b.comparison} />;
              case 'question':
                return (
                  <div key={i} className="sh-question">
                    <p>{b.question}</p>
                    <div className="sh-chips" role="group" aria-label="Quick replies">
                      {b.options.map((o) => (
                        <button
                          key={o}
                          type="button"
                          className={`sh-chip${b.answered === o ? ' on' : ''}`}
                          disabled={b.answered !== null || props.chat.running}
                          onClick={() => props.onChip(b.questionId, o)}
                        >
                          {o}
                        </button>
                      ))}
                    </div>
                    {b.answered === null && <p className="sh-fine">Tap an answer, or type your own.</p>}
                  </div>
                );
              case 'confirmation':
                return (
                  <ConfirmationCard
                    key={i}
                    confirmation={b.confirmation}
                    state={b.state}
                    busy={props.confirming === b.confirmation.confirmation_id}
                    onAnswer={(accept) => props.onConfirm(b.confirmation.confirmation_id, accept)}
                  />
                );
              case 'order':
                return <OrderCard key={i} order={b.order} />;
              default:
                return null;
            }
          })}
          {m.error && <p className="sh-error">{m.error}</p>}
          {!m.live && m.stopped === 'stopped' && <p className="sh-fine">Stopped.</p>}
        </div>
        <span className="sh-meta">
          {ASSISTANT} · {time(m.time)}
          {m.cached && (
            <span className="sh-cached" title="The same question with the same data gets the same answer">
              {' '}
              · saved answer
            </span>
          )}
          {m.model && <span title={m.routeReason ?? undefined}> · {m.model}</span>}
        </span>
        {showWork && m.activity.length > 0 && (
          <ol className="sh-work" aria-label="What the assistant did">
            {m.activity.map((a, i) => (
              <li key={i} className={`sh-work-${a.tone}`}>
                <span className="sh-work-time">{time(a.time)}</span> {a.title}
                {a.detail && <span className="sh-work-detail">{a.detail}</span>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function Bubble({ m, props, showWork }: { m: Message; props: ChatWidgetProps; showWork: boolean }) {
  if (m.role === 'bot') return <BotReply m={m} props={props} showWork={showWork} />;
  return (
    <div className="sh-msg user">
      <div className="sh-msg-body">
        <div className="sh-bubble">
          {m.attachments.length > 0 && (
            <span className="sh-fine">
              {m.attachments.length} picture{m.attachments.length === 1 ? '' : 's'} attached
            </span>
          )}
          <p>{m.text}</p>
        </div>
        <span className="sh-meta">{time(m.time)}</span>
      </div>
    </div>
  );
}

export function ChatWidget(props: ChatWidgetProps) {
  const { open, onClose, chat } = props;
  const [menu, setMenu] = useState(false);
  const [note, setNote] = useState(true);
  const [showWork, setShowWork] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const pinned = useRef(true); // follow new messages unless the shopper has scrolled up to read

  useEffect(() => {
    const el = list.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (menu) setMenu(false);
        else onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, menu, onClose]);

  return (
    <aside
      ref={panel}
      className={`sh-chat${open ? ' open' : ''}`}
      aria-label={`${ASSISTANT}, the shop's AI assistant`}
      aria-hidden={!open}
      inert={!open}
    >
      <header className="sh-chat-head">
        <button type="button" className="sh-iconbtn light" onClick={onClose} aria-label="Close the chat">
          ←
        </button>
        <LogoMark size={30} />
        <div className="sh-chat-title">
          <strong>{ASSISTANT}</strong>
          <span>AI assistant{props.shopperName ? ` · helping ${props.shopperName}` : ''}</span>
        </div>
        <div className="sh-menu-wrap">
          <button
            type="button"
            className="sh-iconbtn light"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}
            aria-label="Chat options"
          >
            ⋮
          </button>
          {menu && (
            <div className="sh-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  props.onNewChat();
                }}
              >
                New chat
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  props.onClear();
                }}
              >
                Clear this conversation
              </button>
              <label className="sh-menu-toggle">
                <input type="checkbox" checked={showWork} onChange={(e) => setShowWork(e.target.checked)} /> Show work
              </label>
            </div>
          )}
        </div>
      </header>

      <div
        className="sh-chat-list"
        ref={list}
        aria-live="polite"
        aria-relevant="additions"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        <div className="sh-msg bot">
          <span className="sh-avatar" aria-hidden="true">
            <LogoMark size={26} />
          </span>
          <div className="sh-msg-body">
            <div className="sh-bubble">
              <p>
                Hello{props.shopperName ? `, ${props.shopperName.split(' ')[0]}` : ''}. I'm {ASSISTANT}. I can find and
                compare products, suggest things you'll like, look after your basket, and help with orders and returns.
                What are you looking for today?
              </p>
            </div>
          </div>
        </div>
        {chat.messages.map((m) => (
          <Bubble key={m.id} m={m} props={props} showWork={showWork} />
        ))}
      </div>

      {note && (
        <div className="sh-note" role="note">
          <p>
            {ASSISTANT} is an AI assistant in an invented lab shop. Chats are kept on this machine so the assistant can
            remember the conversation; nothing is sold or charged.
          </p>
          <button type="button" className="sh-iconbtn" onClick={() => setNote(false)} aria-label="Dismiss this note">
            ×
          </button>
        </div>
      )}

      <div className="sh-chat-composer">
        <ChatComposer
          idBase="shop"
          text={props.text}
          onText={props.onText}
          onSend={props.onSend}
          onStop={props.onStop}
          running={chat.running}
          blocked={props.blocked}
          notice={props.notice}
          attachments={props.attachments}
          uploading={props.uploading}
          problems={props.problems}
          onPick={props.onPick}
          onRemove={props.onRemove}
          accept="image/png,image/jpeg,image/webp,image/gif"
          maxFiles={4}
          models={props.models}
          model={props.model}
          effort={props.effort}
          onModel={props.onModel}
          onEffort={props.onEffort}
          auto={{ on: props.auto, onToggle: props.onAuto, last: props.lastAuto }}
          placeholder="Ask about a product, or paste a picture to find something like it"
        />
      </div>
    </aside>
  );
}
