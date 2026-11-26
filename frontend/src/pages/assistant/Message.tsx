import { useState } from 'react';
import type { AssistantFile, PlanStep } from '@/services/assistantService';
import { Activity } from './Activity';
import { dollars } from './helpers';
import { Chips, CopyButton, FileCard, Markdown, Mark, PlanView } from './parts';
import { STOPPED_TEXT, type Lane, type ToolApproval, type TurnState } from './state';

/* One exchange: the person's message as a bubble, then the assistant's reply with its plan, any approvals it is
   waiting for, the files it made, notes, an action row and a "Show work" disclosure with every step it took. */

const json = (v: unknown) => {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};

/** A plan waiting for the person: approve as it is, edit the steps first, or reject with a note. */
function PlanApproval({
  steps,
  onAnswer,
}: {
  steps: PlanStep[];
  onAnswer: (decision: 'approve' | 'reject', steps?: PlanStep[], note?: string) => Promise<void>;
}) {
  const [edit, setEdit] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const answer = async (d: 'approve' | 'reject', s?: PlanStep[], n?: string) => {
    setBusy(true);
    try {
      await onAnswer(d, s, n);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="as-ask" role="group" aria-label="Approve the plan">
      <div className="as-ask-head">
        <span className="as-ask-dot" />
        <b>Waiting for you: approve the plan</b>
      </div>
      {edit === null ? (
        <ol className="as-ask-list">
          {steps.map((s, i) => (
            <li key={i}>{s.text}</li>
          ))}
        </ol>
      ) : (
        <label className="as-ask-field">
          <span>One step per line</span>
          <textarea rows={Math.max(4, steps.length + 1)} value={edit} onChange={(e) => setEdit(e.target.value)} />
        </label>
      )}
      <label className="as-ask-field">
        <span>Note for the agent (optional; needed to reject)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="as-ask-actions">
        {edit === null ? (
          <>
            <button
              type="button"
              className="as-btn primary"
              disabled={busy}
              onClick={() => void answer('approve', undefined, note || undefined)}
            >
              Approve
            </button>
            <button
              type="button"
              className="as-btn"
              disabled={busy}
              onClick={() => setEdit(steps.map((s) => s.text).join('\n'))}
            >
              Edit steps
            </button>
          </>
        ) : (
          <button
            type="button"
            className="as-btn primary"
            disabled={busy || !edit.trim()}
            onClick={() =>
              void answer(
                'approve',
                edit
                  .split('\n')
                  .map((t) => t.trim())
                  .filter(Boolean)
                  .map((text) => ({ text, status: 'todo' as const })),
                note || undefined,
              )
            }
          >
            Approve edited plan
          </button>
        )}
        <button
          type="button"
          className="as-btn"
          disabled={busy || !note.trim()}
          onClick={() => void answer('reject', undefined, note)}
        >
          Reject
        </button>
      </div>
    </div>
  );
}

/** An MCP tool call waiting for the person's yes or no. */
function ToolAsk({
  a,
  onAnswer,
}: {
  a: ToolApproval;
  onAnswer: (approvalId: string, decision: 'approve' | 'reject') => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const answer = async (d: 'approve' | 'reject') => {
    setBusy(true);
    try {
      await onAnswer(a.approvalId, d);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="as-ask" role="group" aria-label={`Allow ${a.server} ${a.tool}?`}>
      <div className="as-ask-head">
        <span className="as-ask-dot" />
        <b>
          Allow {a.agent === 'main' ? 'the agent' : a.agent} to call {a.server} › {a.tool}?
        </b>
      </div>
      <pre className="as-ask-input">{json(a.input)}</pre>
      <div className="as-ask-actions">
        <button type="button" className="as-btn primary" disabled={busy} onClick={() => void answer('approve')}>
          Allow
        </button>
        <button type="button" className="as-btn" disabled={busy} onClick={() => void answer('reject')}>
          Deny
        </button>
      </div>
    </div>
  );
}

export function Message({
  t,
  live,
  openFile,
  onOpenFile,
  onApprove,
  onTool,
  work,
  onWork,
}: {
  t: TurnState;
  live: boolean;
  /** The id of the file open in the viewer, to mark its card. */
  openFile: string | null;
  onOpenFile: (f: AssistantFile, all: AssistantFile[]) => void;
  onApprove: (decision: 'approve' | 'reject', steps?: PlanStep[], note?: string) => Promise<void>;
  onTool: (approvalId: string, decision: 'approve' | 'reject') => Promise<void>;
  /** The turn's activity when "Show work" is open: live lanes, or the saved log once loaded. */
  work: { lanes: Lane[]; loading?: boolean; error?: string | null } | undefined;
  onWork: (open: boolean) => void;
}) {
  const [showWork, setShowWork] = useState(false);
  const working = live && t.stopped === null;
  const steps = t.lanes.reduce((n, l) => n + l.events.filter((e) => e.type === 'tool_call').length, 0);
  const agents = t.lanes.filter((l) => l.agent !== 'main').length;
  const lastActivity = working
    ? (() => {
        const ev = t.lanes.flatMap((l) => l.events).sort((a, b) => b.ts - a.ts)[0];
        if (!ev) return 'Starting…';
        if (ev.type === 'tool_call') return ev.mcp ? `Using ${ev.mcp.server}` : `Running ${ev.name}`;
        if (ev.type === 'model_call') return 'Thinking…';
        if (ev.type === 'agent_start') return 'Starting a sub-agent…';
        if (ev.type === 'plan') return 'Planning…';
        if (ev.type === 'file') return `Made ${ev.file.name}`;
        return 'Working…';
      })()
    : null;

  return (
    <article className="as-turn">
      <div className="as-user">
        <div className="as-bubble">
          <Chips files={t.user.attachments} />
          <p>{t.user.text}</p>
        </div>
      </div>
      <div className="as-reply">
        <div className="as-reply-mark">
          <Mark size={26} busy={working} />
        </div>
        <div className="as-reply-body">
          {t.plan && <PlanView plan={t.plan} reason={t.planReason} working={working} />}
          {t.approval && <PlanApproval steps={t.approval.plan.steps} onAnswer={onApprove} />}
          {t.toolApprovals.map((a) => (
            <ToolAsk key={a.approvalId} a={a} onAnswer={onTool} />
          ))}
          <div aria-live={working ? 'polite' : undefined} aria-busy={working}>
            {t.text ? (
              <Markdown text={t.text} streaming={working} />
            ) : (
              working && (
                <p className="as-status">
                  <span className="as-pulse" />
                  {lastActivity}
                </p>
              )
            )}
            {t.text && working && lastActivity && (
              <p className="as-status small">
                <span className="as-pulse" />
                {lastActivity}
              </p>
            )}
          </div>
          {t.files.length > 0 && (
            <div className="as-files">
              {t.files.map((f) => (
                <FileCard key={f.id} file={f} active={openFile === f.id} onOpen={() => onOpenFile(f, t.files)} />
              ))}
            </div>
          )}
          {t.notes.map((n, i) => (
            <p key={i} className="as-note">
              {n}
            </p>
          ))}
          {t.error && <p className="as-error">{t.error}</p>}
          {t.stopped && t.stopped !== 'finished' && !t.error && (
            <p className={t.stopped === 'running' ? 'as-note' : 'as-error'}>{STOPPED_TEXT[t.stopped]}</p>
          )}
          {(t.stopped || t.lanes.length > 0) && (
            <div className="as-actions">
              {t.text && <CopyButton text={() => t.text} />}
              <button
                type="button"
                className="as-ghost"
                aria-expanded={showWork}
                onClick={() => {
                  setShowWork((s) => !s);
                  onWork(!showWork);
                }}
              >
                {showWork ? 'Hide work' : 'Show work'}
                {steps > 0 && ` · ${steps} step${steps === 1 ? '' : 's'}`}
                {agents > 0 && ` · ${agents} sub-agent${agents === 1 ? '' : 's'}`}
              </button>
              <span className="as-actions-meta">
                {t.route && (
                  <span
                    className="as-route"
                    title={`Auto chose ${t.route.model} (${t.route.tier}) because: ${t.route.reason}${
                      t.route.escalated_to ? `. Moved up to ${t.route.escalated_to} part-way.` : ''
                    }`}
                  >
                    Auto · {t.route.escalated_to ?? t.route.model}
                  </span>
                )}
                {t.modelsUsed.length > 0 && !t.route && <span>{t.modelsUsed.join(' → ')}</span>}
                <span>{dollars(t.costUsd)}</span>
                {t.stopped === 'finished' && <span>Finished</span>}
              </span>
            </div>
          )}
          {showWork && (
            <div className="as-work">
              <Activity
                lanes={work?.lanes ?? []}
                loading={work?.loading}
                error={work?.error}
                empty="No steps were recorded for this turn."
              />
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
