import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PAGES } from '../registry';

/* The Bible's project pitch quotes how many pages the lab has. It is written by hand, so this fails once it drifts
   more than ten from the registry, the one list of pages. */

describe("the Bible's page count", () => {
  it('stays close to the number of pages in the registry', () => {
    const text = readFileSync(fileURLToPath(new URL('./content/essentials.md', import.meta.url)), 'utf8');
    const stated = Number(/about (\d+) interactive pages/.exec(text)?.[1]);
    expect(stated, 'essentials.md should say "about N interactive pages"').toBeGreaterThan(0);
    expect(Math.abs(stated - PAGES.length)).toBeLessThanOrEqual(10);
  });
});
