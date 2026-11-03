import { useRef, useState, type KeyboardEvent } from 'react';
import { MAX_FILE_MB, MAX_FILES, SOURCE_EXTENSIONS } from '@/services';

interface Props {
  disabled: boolean;
  running: boolean;
  hasTurns: boolean;
  suggestion: string;
  onSend: (prompt: string, files: File[], template: File | null) => void;
  onStop: () => void;
}

const extension = (name: string) => name.slice(name.lastIndexOf('.')).toLowerCase();

/** The message box: a request, files to build from, and an optional template. */
export function Composer({ disabled, running, hasTurns, suggestion, onSend, onStop }: Props) {
  const [prompt, setPrompt] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [template, setTemplate] = useState<File | null>(null);
  const [problem, setProblem] = useState('');
  const filesInput = useRef<HTMLInputElement>(null);
  const templateInput = useRef<HTMLInputElement>(null);
  const text = prompt || suggestion;

  function addFiles(list: FileList | null) {
    const picked = [...(list ?? [])];
    const bad = picked.find((f) => !SOURCE_EXTENSIONS.includes(extension(f.name)) || f.size > MAX_FILE_MB * 2 ** 20);
    if (bad) setProblem(`${bad.name}: attach ${SOURCE_EXTENSIONS.join(' ')} files of up to ${MAX_FILE_MB} MB.`);
    const next = [...files, ...picked.filter((f) => f !== bad)].slice(0, MAX_FILES - (template ? 1 : 0));
    if (!bad) setProblem(next.length < files.length + picked.length ? `At most ${MAX_FILES} files in one message.` : '');
    setFiles(next);
  }

  function pickTemplate(list: FileList | null) {
    const file = list?.[0] ?? null;
    if (file && extension(file.name) !== '.pptx') return setProblem('The template must be a .pptx file.');
    setProblem('');
    setTemplate(file);
  }

  function send() {
    if (disabled || running || !text.trim()) return;
    onSend(text.trim(), files, template);
    setPrompt('');
    setFiles([]);
    setTemplate(null);
    setProblem('');
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
  }

  return (
    <div className="card dk-composer">
      <textarea
        rows={3}
        value={prompt}
        placeholder={hasTurns ? 'Ask for a change, such as "Make slide 3 a bar chart"' : suggestion}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={onKey}
        aria-label="Your request"
      />
      {(files.length > 0 || template) && (
        <div className="chips dk-attached">
          {files.map((f, i) => (
            <span className="dk-chip" key={`${f.name}-${i}`}>
              {f.name}
              <button aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
          {template && (
            <span className="dk-chip template">
              Template: {template.name}
              <button aria-label="Remove the template" onClick={() => setTemplate(null)}>×</button>
            </span>
          )}
        </div>
      )}
      {problem && <div className="small dk-problem">{problem}</div>}
      <div className="row">
        <input ref={filesInput} type="file" multiple hidden accept={SOURCE_EXTENSIONS.join(',')} onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        <input ref={templateInput} type="file" hidden accept=".pptx" onChange={(e) => { pickTemplate(e.target.files); e.target.value = ''; }} />
        <button className="btn" disabled={disabled || running} onClick={() => filesInput.current?.click()}>
          Attach files
        </button>
        <button className="btn" disabled={disabled || running} onClick={() => templateInput.current?.click()}>
          {template ? 'Change template' : 'Use a template (.pptx)'}
        </button>
        <span className="spacer" />
        <span className="small muted">Ctrl or ⌘ + Enter to send</span>
        {running ? (
          <button className="btn" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button className="btn primary" disabled={disabled || !text.trim()} onClick={send}>
            {hasTurns ? 'Send' : 'Make the deck'}
          </button>
        )}
      </div>
    </div>
  );
}
