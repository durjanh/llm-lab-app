import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ChatComposer, MenuItem, MenuTitle, type ChatComposerProps } from './ChatComposer';
import { filesFromClipboard, fitEffortFor, groupModels } from './composerLogic';

const MODELS = [
  { id: 'claude-haiku-5-5', name: 'Haiku', group: 'Claude', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-5.4-mini', name: 'GPT mini', group: 'GPT on Azure', efforts: ['low', 'medium', 'high'] },
  { id: 'ai/local', name: 'Local', group: 'On this machine', efforts: [] },
];

const base = (over: Partial<ChatComposerProps> = {}): ChatComposerProps => ({
  text: '',
  onText: () => {},
  onSend: () => true,
  onStop: () => {},
  running: false,
  attachments: [],
  uploading: [],
  problems: [],
  onPick: () => {},
  onRemove: () => {},
  accept: '.png',
  models: MODELS,
  model: 'claude-haiku-5-5',
  effort: 'high',
  onModel: () => {},
  onEffort: () => {},
  ...over,
});

describe('pasting', () => {
  it('turns a pasted screenshot into a named attachment, and leaves text alone', () => {
    const shot = new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' });
    const files = filesFromClipboard(
      { files: [], items: [{ kind: 'file', type: 'image/png', getAsFile: () => shot }] },
      new Date('2026-11-26T10:20:30Z'),
    );
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('pasted-20261126102030.png');
    expect(files[0].type).toBe('image/png');
    expect(
      filesFromClipboard({ files: [], items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] }),
    ).toEqual([]);
    expect(filesFromClipboard(null)).toEqual([]);
  });

  it('keeps the name of a pasted file that has one', () => {
    const named = new File(['a,b'], 'tides.csv', { type: 'text/csv' });
    expect(filesFromClipboard({ files: [named] })[0].name).toBe('tides.csv');
  });
});

describe('model and effort', () => {
  it('keeps an effort the model takes, falls back to medium, and gives none for a model without', () => {
    expect(fitEffortFor(['low', 'medium', 'high'], 'high')).toBe('high');
    expect(fitEffortFor(['low', 'medium', 'high'], 'max')).toBe('medium');
    expect(fitEffortFor(['low', 'high'], 'max')).toBe('low');
    expect(fitEffortFor([], 'high')).toBe('');
  });

  it('groups models in the order their groups first appear', () => {
    expect(groupModels(MODELS).map((g) => g.group)).toEqual(['Claude', 'GPT on Azure', 'On this machine']);
  });

  it('shows the effort in the pill and the menu only for a model that takes it', () => {
    const claude = renderToString(<ChatComposer {...base({ initialMenu: 'model' })} />);
    expect(claude).toContain('class="cc-pill-effort"');
    expect(claude).toContain('aria-label="Effort"');
    expect(claude).toContain('Extra high');
    const local = renderToString(<ChatComposer {...base({ model: 'ai/local', effort: '', initialMenu: 'model' })} />);
    expect(local).not.toContain('cc-pill-effort');
    expect(local).not.toContain('aria-label="Effort"');
  });
});

describe('the + menu', () => {
  it('offers Attach files first, then the page’s own items', () => {
    const html = renderToString(
      <ChatComposer
        {...base({ initialMenu: 'plus', maxFiles: 6 })}
        menu={() => (
          <>
            <MenuTitle>Deck style</MenuTitle>
            <MenuItem checked onClick={() => {}}>
              House style
            </MenuItem>
          </>
        )}
      />,
    );
    expect(html.indexOf('Attach files')).toBeLessThan(html.indexOf('Deck style'));
    expect(html).toContain('up to 6');
    expect(html).toContain('role="menuitemradio"');
    expect(html).toContain('House style');
  });

  it('turns Send into Stop while running, and shows why sending is blocked', () => {
    expect(renderToString(<ChatComposer {...base({ running: true })} />)).toContain('aria-label="Stop"');
    const blocked = renderToString(<ChatComposer {...base({ text: 'hi', blocked: 'The backend is not running.' })} />);
    expect(blocked).toContain('The backend is not running.');
    expect(blocked).toMatch(/<button type="submit" class="cc-send" disabled=""/);
  });
});
