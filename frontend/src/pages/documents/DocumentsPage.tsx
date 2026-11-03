import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  documentsService,
  statusService,
  type Answers,
  type AssembledDoc,
  type DocTemplate,
  type LiveStatus,
  type ProposedAnswer,
  type Review,
  type TemplateField,
} from '@/services';
import { LivePreview } from './LivePreview';
import { TalkToFill } from './TalkToFill';
import './documents.css';

type Busy = '' | 'template' | 'assemble' | 'review';

// Notes to paste into the interview's box, one per sample template.
const SAMPLE_NOTES = {
  letter: `Call notes, 29 October: spoke to Tom Hughes, Finance Director at Northgate Builders Ltd, 7 Canal Street, Birmingham B1 2JX. They want Harlow & Reed LLP to advise on the sale of their plant hire division. Work to start on 17 November 2026.
Fees: hourly rate of £250 plus VAT, estimate £12,000 to £15,000.
We will deliver: a due diligence report; a review of the draft sale agreement; a completion checklist. They asked for a confidentiality section.
English law. James Carter will sign as partner.`,
  nda: `New NDA needed, dated 10 November 2026, between Fabrikam Robotics Ltd (company number 09876543, registered in England and Wales, 3 Science Park, Cambridge CB4 0WS, "Fabrikam") and Contoso Analytics Limited (company number 11987654, registered in England and Wales, 5 Riverside Way, Bristol BS1 6HG, "Contoso"). Purpose: sharing designs for a warehouse picking robot pilot. Agreement lasts 2 years; confidentiality continues for 3 years after. No non-solicitation clause this time. Governed by the law of England and Wales.
Signed by Hannah Lee, CEO of Fabrikam, and Daniel Okafor, Chief Executive of Contoso.`,
};

/** Shows a template's text with its fields and conditions picked out. */
function TemplateText({ text }: { text: string }) {
  const parts = text.split(/({{[^}]*}}|{%[^%]*%})/g);
  return (
    <pre className="dc-paper">
      {parts.map((part, i) =>
        part.startsWith('{{') ? (
          <mark key={i} className="dc-var">
            {part}
          </mark>
        ) : part.startsWith('{%') ? (
          <mark key={i} className="dc-tag">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </pre>
  );
}

function FieldInput({ field, value, onChange }: { field: TemplateField; value: string | boolean | undefined; onChange: (v: string | boolean) => void }) {
  const text = typeof value === 'string' ? value : '';
  switch (field.type) {
    case 'boolean':
      return (
        <label className="dc-toggle">
          <input type="checkbox" checked={value === true || value === 'true'} onChange={(e) => onChange(e.target.checked)} /> Yes
        </label>
      );
    case 'longtext':
      return <textarea rows={3} value={text} onChange={(e) => onChange(e.target.value)} />;
    case 'list':
      return <textarea rows={3} value={text} placeholder="One per line" onChange={(e) => onChange(e.target.value)} />;
    case 'date':
      return <input type="date" value={text} onChange={(e) => onChange(e.target.value)} />;
    case 'number':
      return <input type="number" value={text} onChange={(e) => onChange(e.target.value)} />;
    case 'choice':
      return (
        <select value={text} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {field.options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      );
    default:
      return <input type="text" value={text} onChange={(e) => onChange(e.target.value)} />;
  }
}

function Step({ n, title, children, done }: { n: number; title: string; children: ReactNode; done?: boolean }) {
  return (
    <section className={`card dc-step ${done ? 'done' : ''}`}>
      <h2>
        <span className="dc-n">{n}</span> {title}
      </h2>
      {children}
    </section>
  );
}

export default function DocumentsPage() {
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState<Busy>('');
  const [problem, setProblem] = useState('');
  const [template, setTemplate] = useState<DocTemplate | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [proposed, setProposed] = useState<Record<string, ProposedAnswer>>({});
  const [doc, setDoc] = useState<AssembledDoc | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [spent, setSpent] = useState(0);
  const templateInput = useRef<HTMLInputElement>(null);
  const finishedInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    statusService.status().then((s) => {
      setStatus(s);
      setModel(s.default_model ?? '');
    });
  }, []);

  const ready = !!(status?.available && status.has_credentials);
  const groups = useMemo(() => {
    const out = new Map<string, TemplateField[]>();
    for (const f of template?.fields ?? []) out.set(f.group || 'Other', [...(out.get(f.group || 'Other') ?? []), f]);
    return [...out.entries()];
  }, [template]);

  async function run<T>(what: Busy, work: () => Promise<T>): Promise<T | undefined> {
    setBusy(what);
    setProblem('');
    try {
      return await work();
    } catch (err) {
      setProblem((err as Error).message);
      return undefined;
    } finally {
      setBusy('');
    }
  }

  async function loadTemplate(file: File | Promise<File>, mode: 'template' | 'author') {
    const t = await run('template', async () => documentsService.addTemplate(await file, mode, model));
    if (!t) return;
    setTemplate(t);
    setAnswers({});
    setProposed({});
    setDoc(null);
    setReview(null);
    setSpent((s) => s + t.cost);
  }

  /** Puts proposed answers into the form, keeping the quote and confidence to show beside each. */
  function apply(list: ProposedAnswer[]) {
    if (!template) return;
    setProposed((cur) => ({ ...cur, ...Object.fromEntries(list.map((a) => [a.field, a])) }));
    setAnswers((cur) => {
      const next = { ...cur };
      for (const a of list) {
        const field = template.fields.find((f) => f.name === a.field);
        next[a.field] = field?.type === 'boolean' ? a.value.trim().toLowerCase() === 'true' : a.value;
      }
      return next;
    });
  }

  async function assemble() {
    if (!template) return;
    const d = await run('assemble', () => documentsService.assemble(template.id, answers));
    if (d) {
      setDoc(d);
      setReview(null);
    }
  }

  async function check() {
    if (!doc) return;
    const r = await run('review', () => documentsService.review(doc.id, model));
    if (r) {
      setReview(r);
      setSpent((s) => s + r.cost);
    }
  }

  const answered = template?.fields.filter((f) => answers[f.name] !== undefined && answers[f.name] !== '').length ?? 0;

  return (
    <main className="page-documents">
      <div className="kicker">Lab 22 · Document automation</div>
      <h1>Templates, an interview, and a finished document</h1>
      <p className="lede">
        Document assembly as legal document tools do it: a Word template with fields, optional clauses and repeated sections is
        filled from the answers to an interview. Assembly is deterministic, so the same answers always give the same
        document. Claude works around it, never inside it: it turns a finished document into a template, fills the
        interview from your source documents with a quote for every answer, and checks the result. You confirm everything.
      </p>

      <div className="row dc-bar">
        <label>
          Model for the AI steps{' '}
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!ready || !!busy}>
            <optgroup label="Claude (Anthropic)">
              {(status?.models ?? []).map((m) => (
                <option key={m}>{m}</option>
              ))}
            </optgroup>
            {/* GPT deployments in the lab's Azure AI Foundry resource, for comparing on the same tasks. */}
            {!!status?.gpt_models?.length && (
              <optgroup label="GPT (Azure AI Foundry)">
                {status.gpt_models.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <span className="small muted">
          {status === null ? 'Checking the lab backend…' : ready ? `AI steps this session: about $${spent.toFixed(4)}` : status.reason}
        </span>
      </div>
      {problem && <p className="dc-problem">{problem}</p>}

      <Step n={1} title="Template" done={!!template}>
        <div className="dc-choices">
          <div>
            <b>Use a template</b>
            <p className="small muted">A Word file with fields such as {'{{ client_name }}'}, {'{%p if fixed_fee %}'} and {'{%p for item in deliverables %}'}. Claude writes the interview's questions.</p>
            <div className="row">
              <button className="btn" disabled={!ready || !!busy} onClick={() => loadTemplate(documentsService.sample('engagement-letter-template.docx'), 'template')}>
                Sample engagement letter
              </button>
              <button className="btn" disabled={!ready || !!busy} onClick={() => templateInput.current?.click()}>
                Upload a template
              </button>
            </div>
          </div>
          <div>
            <b>Make a template with AI</b>
            <p className="small muted">A finished document: Claude finds what changes from one document to the next and which clauses should be optional.</p>
            <div className="row">
              <button className="btn" disabled={!ready || !!busy} onClick={() => loadTemplate(documentsService.sample('mutual-nda.docx'), 'author')}>
                Sample NDA
              </button>
              <button className="btn" disabled={!ready || !!busy} onClick={() => finishedInput.current?.click()}>
                Upload a finished document
              </button>
            </div>
          </div>
        </div>
        <input ref={templateInput} type="file" accept=".docx" hidden onChange={(e) => e.target.files?.[0] && (void loadTemplate(e.target.files[0], 'template'), (e.target.value = ''))} />
        <input ref={finishedInput} type="file" accept=".docx" hidden onChange={(e) => e.target.files?.[0] && (void loadTemplate(e.target.files[0], 'author'), (e.target.value = ''))} />
        {busy === 'template' && <p className="small"><span className="spinner" /> Reading the document and designing the interview…</p>}
        {template && (
          <div className="dc-result">
            <p>
              <b>{template.title}</b>: {template.fields.length} fields
              {template.made_by_ai && template.optional_clauses && `, ${template.optional_clauses.length} optional clause${template.optional_clauses.length === 1 ? '' : 's'}`}
              {template.cost > 0 && <span className="small muted"> · about ${template.cost.toFixed(4)}</span>}{' '}
              <button className="link-btn small" onClick={() => documentsService.downloadTemplate(template)}>
                Download the template
              </button>
            </p>
            {template.not_found && template.not_found.length > 0 && (
              <p className="small dc-warn">Not found in the document, so not made into fields: {template.not_found.map((m) => `“${m.text}”`).join(', ')}</p>
            )}
            <details>
              <summary className="small">The template, with its fields and conditions</summary>
              <TemplateText text={template.text} />
            </details>
          </div>
        )}
      </Step>

      {template && (
        <Step n={2} title="Interview" done={answered > 0}>
          <div className="dc-interview">
          <div className="dc-answers">
          <TalkToFill
            templateId={template.id}
            title={template.title}
            fields={template.fields}
            answers={answers}
            model={model}
            disabled={!ready || !!busy}
            sampleNotes={/disclosure|nda/i.test(template.title) ? SAMPLE_NOTES.nda : SAMPLE_NOTES.letter}
            onAnswers={apply}
            onCost={(c) => setSpent((s) => s + c)}
          />
          {groups.map(([group, fields]) => (
            <fieldset key={group} className="dc-group">
              <legend>{group}</legend>
              {fields.map((f) => {
                const p = proposed[f.name];
                return (
                  <div key={f.name} className={`dc-field ${p ? `ai ${p.confidence}` : ''}`}>
                    <label>
                      {f.question}
                      {f.required && f.type !== 'boolean' && <span className="dc-req"> *</span>}
                      <code>{f.name}</code>
                    </label>
                    <FieldInput field={f} value={answers[f.name]} onChange={(v) => setAnswers((cur) => ({ ...cur, [f.name]: v }))} />
                    {p ? (
                      <div className="dc-source small">
                        <span className={`dc-badge ${p.confidence}`}>AI · {p.confidence}</span> “{p.quote}”
                      </div>
                    ) : (
                      f.help && <div className="small muted">{f.help}</div>
                    )}
                  </div>
                );
              })}
            </fieldset>
          ))}
                  </div>
          <LivePreview templateId={template.id} answers={answers} />
          </div>
        </Step>
      )}

      {template && (
        <Step n={3} title="Assemble and check" done={!!review}>
          <div className="row">
            <button className="btn primary" disabled={!!busy} onClick={assemble}>
              Assemble the document
            </button>
            {doc && (
              <>
                <button className="btn" onClick={() => documentsService.download(doc)}>
                  Download {doc.name}
                </button>
                <button className="btn" disabled={!ready || !!busy} onClick={check}>
                  {busy === 'review' ? 'Checking…' : 'Check it with AI'}
                </button>
              </>
            )}
            <span className="small muted">Assembly uses no AI: the template is filled in exactly as answered.</span>
          </div>
          {doc && doc.missing.length > 0 && (
            <p className="small dc-warn">Not answered yet: {doc.missing.join(' · ')}</p>
          )}
          {review && (
            <div className="dc-review">
              <p>
                <b>Review:</b> {review.summary} <span className="small muted">· about ${review.cost.toFixed(4)}</span>
              </p>
              {review.issues.map((i, n) => (
                <div key={n} className={`dc-issue ${i.severity}`}>
                  <span className={`dc-badge sev-${i.severity}`}>{i.severity}</span> {i.issue}
                  {i.quote && <div className="small muted">“{i.quote}”</div>}
                  {i.suggestion && <div className="small">Fix: {i.suggestion}</div>}
                </div>
              ))}
            </div>
          )}
          {doc && <pre className="dc-paper dc-doc">{doc.text}</pre>}
        </Step>
      )}

      <section className="card dc-how">
        <h2>How it fits together</h2>
        <ul className="small">
          <li>
            <b>The engine is deterministic.</b> docxtpl fills a Word template: {'{{ fields }}'}, {'{%p if %}'} clauses and{' '}
            {'{%p for %}'} repeats, like a document automation tool's variables, IF and REPEAT. Lawyers can trust it and audit it.
          </li>
          <li>
            <b>AI proposes; people decide.</b> Every AI step returns structured data checked against a schema: fields, answers
            with the quote they came from and a confidence, or review issues. Nothing goes into a document without being shown.
          </li>
          <li>
            <b>Each step has its own model and cost.</b> Template authoring is rare and benefits from a stronger model; filling
            in and checking run on every document and suit a fast, cheap one.
          </li>
          <li>
            <b>Measure it.</b> Extraction accuracy per field, review precision and the time saved per document are what to
            evaluate before trusting it at scale.
          </li>
        </ul>
      </section>
    </main>
  );
}
