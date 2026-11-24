import { describe, expect, it } from 'vitest';
import {
  BLOCKS,
  CLOUDS,
  DEFAULT_DRIVERS,
  SERVICES,
  USE_CASES,
  decide,
  secondCloudVerdict,
  type BlockId,
  type Drivers,
} from './architecture';

const area = (d: Drivers, name: string) => decide(d).find((x) => x.area === name);

describe('service map', () => {
  it('names every block on every platform, short enough for a diagram box', () => {
    for (const b of BLOCKS) {
      for (const c of CLOUDS) {
        const s = SERVICES[b.id][c.id];
        expect(s.short.length, `${b.id}/${c.id}`).toBeGreaterThan(0);
        expect(s.short.length, `${b.id}/${c.id} short label`).toBeLessThanOrEqual(22);
        expect(s.service.length).toBeGreaterThan(0);
        expect(s.note.length).toBeGreaterThan(0);
      }
    }
  });

  it('puts Claude on each hyperscaler’s model block', () => {
    for (const c of ['azure', 'gcp', 'aws'] as const) expect(SERVICES.models[c].service).toMatch(/Claude/);
  });
});

describe('use cases', () => {
  const ids = new Set<BlockId>(BLOCKS.map((b) => b.id));
  it('use only known blocks, and every one has the cross-cutting blocks and a gateway', () => {
    for (const u of USE_CASES) {
      for (const k of Object.keys(u.roles)) expect(ids.has(k as BlockId), `${u.id}: ${k}`).toBe(true);
      for (const k of ['gateway', 'identity', 'monitoring', 'secrets', 'cicd', 'models'] as const) {
        expect(u.roles[k], `${u.id} needs ${k}`).toBeTruthy();
      }
    }
  });

  it('only the agentic and voice cases need an agent runtime; classic ML has no retrieval', () => {
    const uses = (id: string, b: BlockId) => Boolean(USE_CASES.find((u) => u.id === id)?.roles[b]);
    expect(uses('agent', 'orchestration')).toBe(true);
    expect(uses('voice', 'orchestration')).toBe(true);
    expect(uses('rag', 'orchestration')).toBe(false);
    expect(uses('ml', 'retrieval')).toBe(false);
  });
});

describe('decide', () => {
  it('builds on the existing estate', () => {
    expect(area(DEFAULT_DRIVERS, 'Platform')?.decision).toBe('Build on Azure.');
    expect(area({ ...DEFAULT_DRIVERS, estate: 'aws' }, 'Platform')?.decision).toBe('Build on AWS.');
    expect(area({ ...DEFAULT_DRIVERS, estate: 'none' }, 'Platform')?.decision).toMatch(/Shortlist/);
  });

  it('maps residency to the deployment type', () => {
    expect(area({ ...DEFAULT_DRIVERS, residency: 'country' }, 'Model deployment')?.decision).toMatch(/regional/i);
    expect(area({ ...DEFAULT_DRIVERS, residency: 'zone' }, 'Model deployment')?.decision).toMatch(/data-zone/);
    expect(area({ ...DEFAULT_DRIVERS, residency: 'none' }, 'Model deployment')?.decision).toMatch(/global/i);
  });

  it('buys provisioned throughput only for steady load with a commitment', () => {
    const cap = (peak: Drivers['peak'], budget: Drivers['budget']) =>
      area({ ...DEFAULT_DRIVERS, peak, budget }, 'Capacity')?.decision ?? '';
    expect(cap('steady', 'committed')).toMatch(/provisioned throughput/);
    expect(cap('spiky', 'committed')).toMatch(/pay-as-you-go/);
    expect(cap('low', 'committed')).toMatch(/before buying/);
    expect(cap('steady', 'payg')).not.toMatch(/Buy provisioned/);
  });

  it('chooses Databricks for a data-platform team and serverless for a small one', () => {
    expect(area({ ...DEFAULT_DRIVERS, skills: 'data' }, 'Data')?.decision).toMatch(/Databricks/);
    expect(area({ ...DEFAULT_DRIVERS, skills: 'small' }, 'Compute')?.decision).toMatch(/Serverless/);
    expect(area({ ...DEFAULT_DRIVERS, openModels: true, skills: 'cloud' }, 'Compute')?.decision).toMatch(/Kubernetes/);
  });

  it('adds private endpoints for regulated data, and an open-models line only when asked', () => {
    expect(area({ ...DEFAULT_DRIVERS, sensitivity: 'regulated' }, 'Security')?.decision).toMatch(/Private endpoints/);
    expect(area(DEFAULT_DRIVERS, 'Models')).toBeUndefined();
    expect(area({ ...DEFAULT_DRIVERS, openModels: true }, 'Models')).toBeDefined();
  });

  it('always gives a reason, and always ends with portability', () => {
    const out = decide(DEFAULT_DRIVERS);
    for (const d of out) expect(d.because.length).toBeGreaterThan(10);
    expect(out[out.length - 1].area).toBe('Portability');
  });
});

describe('secondCloudVerdict', () => {
  it('says no for price alone, yes for a mandate, maybe for a model gap', () => {
    expect(secondCloudVerdict([]).verdict).toBe('no');
    expect(secondCloudVerdict(['price']).verdict).toBe('no');
    expect(secondCloudVerdict(['resilience']).verdict).toBe('no');
    expect(secondCloudVerdict(['mandate']).verdict).toBe('yes');
    expect(secondCloudVerdict(['model']).verdict).toBe('maybe');
    expect(secondCloudVerdict(['model', 'data']).verdict).toBe('yes');
  });
});
