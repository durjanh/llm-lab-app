import { describe, expect, it } from 'vitest';
import { SitesService, type ModelCaps } from '@/services/sitesService';
import { blockedFor, checkFiles, kindOf, noticeFor, pickerModels } from './attachments';

const file = (name: string, bytes: number, type = 'application/octet-stream') =>
  new File([new Uint8Array(bytes)], name, { type });
const CLAUDE: ModelCaps = { images: true, pdf: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] };
const GPT: ModelCaps = { images: true, pdf: false, efforts: ['low', 'medium', 'high'] };
const LOCAL: ModelCaps = { images: null, pdf: false, efforts: [] };
const BLIND: ModelCaps = { images: false, pdf: false, efforts: [] };

describe('what can be attached', () => {
  it('knows pictures, data files and PDFs by name', () => {
    expect(kindOf('shot.PNG')).toBe('image');
    expect(kindOf('tides.csv')).toBe('data');
    expect(kindOf('brief.pdf')).toBe('pdf');
    expect(kindOf('run.exe')).toBeNull();
  });

  it('refuses the wrong kind, empty files, files over the limit and more than six', () => {
    const { ok, problems } = checkFiles(
      [
        file('run.exe', 10),
        file('empty.png', 0),
        file('huge.png', 6 * 2 ** 20),
        file('big.csv', 400_000),
        file('a.png', 10),
      ],
      0,
    );
    expect(ok.map((f) => f.name)).toEqual(['a.png']);
    expect(problems).toHaveLength(4);
    expect(checkFiles([file('b.png', 10)], 6).problems[0]).toContain('at most 6');
  });

  it('blocks a PDF for a model other than Claude and a picture for a model that cannot read them', () => {
    expect(blockedFor([{ kind: 'pdf', name: 'brief.pdf' }], GPT, 'gpt-5.4-mini')).toContain('cannot read PDFs');
    expect(blockedFor([{ kind: 'pdf', name: 'brief.pdf' }], CLAUDE, 'claude-haiku-5-5')).toBeNull();
    expect(blockedFor([{ kind: 'image', name: 'a.png' }], BLIND, 'ai/x')).toContain('cannot read pictures');
    expect(blockedFor([{ kind: 'image', name: 'a.png' }], LOCAL, 'ai/x')).toBeNull();
    expect(noticeFor([{ kind: 'image' }], LOCAL, 'ai/x')).toContain('may not read pictures');
    expect(noticeFor([{ kind: 'image' }], GPT, 'gpt-5.4-mini')).toBeNull();
  });

  it('lists the models grouped, with the efforts each takes', () => {
    const models = pickerModels(['claude-haiku-5-5', 'gpt-5.4-mini'], {
      'claude-haiku-5-5': CLAUDE,
      'gpt-5.4-mini': GPT,
    });
    expect(models.map((m) => [m.group, m.efforts.length])).toEqual([
      ['Claude', 5],
      ['GPT on Azure', 3],
    ]);
  });
});

describe('sending a message', () => {
  it('sends the attachment ids and the effort with the prompt', async () => {
    const sent: { path: string; body: unknown }[] = [];
    const client = { stream: async (path: string, body: unknown) => void sent.push({ path, body }) };
    const svc = new SitesService(client as never);
    await svc.turn(
      {
        siteId: 'abcdef123456',
        prompt: 'Like this',
        model: 'claude-haiku-5-5',
        attachments: ['a'.repeat(32)],
        effort: 'high',
      },
      () => {},
    );
    await svc.turn({ prompt: 'Plain', model: 'ai/local', effort: '' }, () => {});
    expect(sent[0]).toEqual({
      path: '/api/sites/turn',
      body: {
        prompt: 'Like this',
        site_id: 'abcdef123456',
        model: 'claude-haiku-5-5',
        attachments: ['a'.repeat(32)],
        effort: 'high',
      },
    });
    expect(sent[1].body).toEqual({ prompt: 'Plain', model: 'ai/local', effort: '' });
  });
});

describe('model names in the picker', () => {
  it('shows each model by its full name, not just its family', async () => {
    const { modelLabel } = await import('@/lib/models');
    const { pickerModels } = await import('./attachments');
    expect(modelLabel('claude-haiku-5-5')).toBe('Claude Haiku 5.5');
    expect(modelLabel('claude-sonnet-5-5')).toBe('Claude Sonnet 5.5');
    expect(modelLabel('claude-opus-5-5')).toBe('Claude Opus 5.5');
    expect(modelLabel('gpt-5.4-mini')).toBe('GPT-5.4 mini');
    const names = pickerModels(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'gpt-5.4-mini'], {}).map(
      (m) => m.name,
    );
    expect(new Set(names).size).toBe(4);
  });
});
