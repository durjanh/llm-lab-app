// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cognitiveCoreService, type CoreEvent, type CoreInfo } from '@/services/cognitiveCoreService';
import { statusService, type LiveStatus } from '@/services/statusService';
import CognitiveCorePage from './CognitiveCorePage';

const INFO: CoreInfo = {
  core_model: 'ai/small',
  default_big_model: 'ai/big',
  setups: [
    { id: 'core_closed', name: 'Small core, closed book' },
    { id: 'core_tools', name: 'Small core, its own tools' },
  ],
  questions: [
    { id: 'q1', kind: 'Invented fact', text: 'When did the bridge open?', expected: '1912' },
    { id: 'q2', kind: 'Reasoning only', text: 'Who is second youngest?', expected: 'Cara' },
  ],
  library: [{ title: 'Tollan Bridge', text: 'Opened in 1912.' }],
  tools: [{ name: 'search_library', description: 'Searches.' }],
  prompts: { closed: 'From memory.', rag: 'From the entries.', tools: 'Search first.' },
  max_steps: 6,
};

const EVENTS: CoreEvent[] = [
  {
    type: 'started',
    questions: ['q1'],
    setups: ['core_closed', 'core_tools'],
    core_model: 'ai/small',
    big_model: 'ai/big',
    budget_usd: 0.25,
  },
  {
    type: 'step',
    question: 'q1',
    setup: 'core_tools',
    kind: 'tool',
    tool: 'search_library',
    input: { query: 'bridge' },
  },
  { type: 'step', question: 'q2', setup: 'core_closed', kind: 'call', calls: 1 },
  {
    type: 'answer',
    question: 'q1',
    setup: 'core_tools',
    model: 'ai/small',
    answer: 'It opened in 1912.',
    correct: true,
    stopped: null,
    model_calls: 2,
    tool_calls: 1,
    input_tokens: 50,
    output_tokens: 8,
    seconds: 1.5,
    cost_usd: 0,
  },
  {
    type: 'answer',
    question: 'q1',
    setup: 'core_closed',
    model: 'ai/small',
    answer: '',
    correct: false,
    stopped: 'Stopped at the step cap.',
    model_calls: 6,
    tool_calls: 0,
    input_tokens: 9,
    output_tokens: 2,
    seconds: 0.4,
    cost_usd: 0,
  },
  {
    type: 'done',
    spent_usd: 0.0123,
    summary: [
      { setup: 'core_closed', answered: 1, correct: 0, tool_calls: 0, tokens: 11, seconds: 0.4, cost_usd: 0 },
      { setup: 'core_tools', answered: 1, correct: 1, tool_calls: 1, tokens: 58, seconds: 1.5, cost_usd: 0 },
    ],
  },
];

const status = { models: ['ai/big', 'claude-haiku-5-5'], default_model: 'ai/big' } as unknown as LiveStatus;

function page() {
  return render(
    <MemoryRouter>
      <CognitiveCorePage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the cognitive core page', () => {
  it('runs the chosen questions and setups, and shows each answer, its steps and the totals', async () => {
    vi.spyOn(cognitiveCoreService, 'info').mockResolvedValue(INFO);
    vi.spyOn(statusService, 'status').mockResolvedValue(status);
    const run = vi.spyOn(cognitiveCoreService, 'run').mockImplementation(async (_q, _s, _m, _b, onEvent) => {
      EVENTS.forEach(onEvent);
    });
    page();
    expect(screen.getByText('Loading the questions…')).toBeTruthy();
    await screen.findByText(/The small core is/);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'claude-haiku-5-5' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Who is second youngest/ })); // untick q2
    fireEvent.click(screen.getByRole('button', { name: 'Run 1 question' }));
    await screen.findByText(/most right: Small core, its own tools/);
    expect(run).toHaveBeenCalledWith(
      ['q1'],
      ['core_closed', 'core_tools'],
      'claude-haiku-5-5',
      0.25,
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(screen.getByText('It opened in 1912.')).toBeTruthy();
    expect(screen.getByText('Stopped at the step cap.')).toBeTruthy();
    expect(screen.getByText(/Spent \$0\.0123/)).toBeTruthy();
    expect(screen.getByText('working…')).toBeTruthy(); // q2 had a step but no answer
    fireEvent.click(screen.getAllByRole('button', { name: /^Steps/ })[0]);
    expect(screen.getByText('search_library({"query":"bridge"})')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide steps' }));
    expect(screen.queryByText('search_library({"query":"bridge"})')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Small core, closed book' })); // a setup off, then on again
    expect(screen.queryByRole('columnheader', { name: 'Small core, closed book' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Small core, closed book' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /When did the bridge open/ })); // no question left
    expect(screen.getByText('Tick at least one question to run.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Run 0 questions' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Search first\./)).toBeTruthy(); // the prompts are shown
  });

  it('can be stopped, says why a run failed, and says when the questions cannot load', async () => {
    vi.spyOn(cognitiveCoreService, 'info').mockResolvedValue(INFO);
    vi.spyOn(statusService, 'status').mockRejectedValue(new Error('no status')); // the picker stays empty
    let calls = 0;
    vi.spyOn(cognitiveCoreService, 'run').mockImplementation(async (_q, _s, _m, _b, onEvent, signal) => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      } else if (calls === 2) {
        throw new Error('The backend is not running.');
      } else {
        onEvent({ type: 'error', message: 'Stopped: the run reached its budget.' });
      }
    });
    page();
    await screen.findByText(/The small core is/);
    fireEvent.click(screen.getByRole('button', { name: 'Run 2 questions' }));
    await screen.findByRole('button', { name: 'Stop' });
    expect(screen.getByRole('button', { name: 'Running…' })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stop' })));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
    expect(document.querySelector('.error')).toBeNull(); // a stop is not an error
    fireEvent.click(screen.getByRole('button', { name: 'Run 2 questions' }));
    await screen.findByText('The backend is not running.');
    fireEvent.click(screen.getByRole('button', { name: 'Run 2 questions' }));
    await screen.findByText('Stopped: the run reached its budget.');
    cleanup();

    vi.spyOn(cognitiveCoreService, 'info').mockRejectedValue('backend down');
    page();
    await screen.findByText('backend down');
  });

  it('redraws the distillation demo as the sliders move', async () => {
    vi.spyOn(cognitiveCoreService, 'info').mockResolvedValue(INFO);
    vi.spyOn(statusService, 'status').mockResolvedValue(status);
    page();
    const [points, temperature] = screen.getAllByRole('slider');
    const softBefore = screen.getByRole('img', { name: /soft targets/ }).getAttribute('aria-label');
    fireEvent.change(points, { target: { value: '6' } });
    fireEvent.change(temperature, { target: { value: '4' } });
    expect(screen.getByText('6')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByRole('img', { name: /soft targets/ }).getAttribute('aria-label')).not.toBe(softBefore);
    expect(screen.getByRole('img', { name: 'Teacher' }).querySelectorAll('circle')).toHaveLength(0);
    expect(screen.getByRole('img', { name: /bare labels/ }).querySelectorAll('circle')).toHaveLength(6);
    await screen.findByText(/The small core is/);
  });
});
