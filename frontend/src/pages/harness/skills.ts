import { Site } from '@/lib/site';
import type { Life } from '@/lib/lifecycle';
import { skillsService, statusService, type SkillFile, type SkillsEvent } from '@/services';

/**
 * Section 6: a live Agent Skills run (python/12_agent_skills.py through the lab backend).
 * Claude uses one of Anthropic's skills in the code-execution container, and the file it
 * makes can be downloaded here.
 */

type Kind = 'user' | 'request' | 'says' | 'step' | 'output' | 'error' | 'files';
const ICON: Record<Kind, string> = { user: 'U', request: 'C', says: 'M', step: 'W', output: 'T', error: '✗', files: '★' };
const COLOUR: Record<Kind, string> = { user: 'gate', request: 'say', says: 'say', step: 'compact', output: 'tool', error: 'error', files: 'done' };

export function mountSkills(life: Life): void {
  const { $, esc, fmtInt } = Site;
  let controller: AbortController | null = null;
  let rows: { kind: Kind; title: string; detail: string }[] = [];
  let files: SkillFile[] = [];

  function render(): void {
    $('#skSteps').innerHTML = rows.map(r => `<li><span class="ic k-${COLOUR[r.kind]}">${ICON[r.kind]}</span><span><b>${esc(r.title)}</b><div class="detail">${esc(r.detail)}</div></span><span class="meta"></span></li>`).join('');
    const last = $('#skSteps li:last-child');
    last?.scrollIntoView({ block: 'nearest' });
    $('#skFiles').innerHTML = files.length
      ? files.map(f => `<button class="btn" data-id="${esc(f.id)}" data-name="${esc(f.name)}">Download ${esc(f.name)}${f.size_bytes ? ` (${fmtInt(f.size_bytes / 1024)} KB)` : ''}</button>`).join(' ')
      : '<span class="small muted">Files Claude makes appear here.</span>';
  }

  function onEvent(ev: SkillsEvent): void {
    const add = (kind: Kind, title: string, detail = '') => rows.push({ kind, title, detail });
    switch (ev.type) {
      case 'task': add('user', `You ask for a file, with the ${ev.skills.join(', ')} skill`, ev.task); break;
      case 'request': add('request', `Request ${ev.turn} to Claude · stop_reason ${ev.stop_reason}`, ev.stop_reason === 'pause_turn' ? `A long run paused. The backend sends the turn back in the same container. ${ev.usage}` : ev.usage); break;
      case 'says': add('says', 'Claude', ev.text); break;
      case 'step': add('step', `In the container: ${ev.name}`, ev.detail); break;
      case 'output': add('output', `Exit code ${ev.return_code}`, ev.first_line); break;
      case 'paused': add('error', 'Still paused', ev.text); break;
      case 'error': add('error', 'Error', ev.message ?? ev.text ?? ''); break;
      case 'files':
        files = ev.files;
        add('files', ev.files.length ? `Claude made ${ev.files.length} file${ev.files.length > 1 ? 's' : ''}` : 'Claude made no files this time', `About $${ev.cost.toFixed(4)} in tokens; container time is billed separately.`);
        break;
      default: return;
    }
    render();
  }

  async function start(): Promise<void> {
    controller?.abort();
    const c = (controller = new AbortController());
    rows = []; files = [];
    $('#skRun').disabled = true; $('#skStop').disabled = false;
    $('#skStatus').textContent = 'Running. A document usually takes one to three minutes.';
    render();
    try {
      const upto = Math.max(2, Math.min(200, Math.round(Number($('#skUpto').value) || 20)));
      await skillsService.run({ skill: $('#skSkill').value, upto, model: $('#skModel').value }, onEvent, c.signal);
      $('#skStatus').textContent = 'Finished.';
    } catch (err) {
      const e = err as Error;
      $('#skStatus').textContent = e.name === 'AbortError' ? 'Stopped.' : `Error: ${e.message}`;
    }
    if (controller === c) { $('#skRun').disabled = false; $('#skStop').disabled = true; }
  }

  $('#skRun').addEventListener('click', start);
  $('#skStop').addEventListener('click', () => controller?.abort());
  life.signal.addEventListener('abort', () => controller?.abort());
  $('#skFiles').addEventListener('click', async (ev: MouseEvent) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-id]');
    if (!b) return;
    try {
      await skillsService.download({ id: b.dataset.id ?? '', name: b.dataset.name ?? 'file' });
    } catch (err) {
      $('#skStatus').textContent = `Download failed: ${(err as Error).message}`;
    }
  });
  statusService.status().then(s => {
    if (!life.alive) return;
    const ok = !!(s.available && s.has_credentials);
    $('#skRun').disabled = !ok;
    $('#skStatus').textContent = ok ? 'Live: this spends real credit, and code-execution container time is billed separately.' : s.reason;
    // Skills run in Anthropic's code-execution container, so only Claude models are offered.
    $('#skModel').innerHTML = (s.claude_models ?? []).map(m => `<option ${m === s.claude_model ? 'selected' : ''}>${esc(m)}</option>`).join('');
  });
  render();
}
