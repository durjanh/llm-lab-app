import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from './apiClient';
import { CognitiveCoreService } from './cognitiveCoreService';

describe('the cognitive core service', () => {
  it('reads the info and streams a run with what the page chose', async () => {
    const get = vi.fn().mockResolvedValue({ core_model: 'ai/small' });
    const stream = vi.fn().mockResolvedValue(undefined);
    const service = new CognitiveCoreService({ get, stream } as unknown as ApiClient);
    expect(await service.info()).toEqual({ core_model: 'ai/small' });
    expect(get).toHaveBeenCalledWith('/api/cognitive-core/info');
    const onEvent = vi.fn();
    const signal = new AbortController().signal;
    await service.run(['q1'], ['core_rag'], 'ai/big', 0.25, onEvent, signal);
    expect(stream).toHaveBeenCalledWith(
      '/api/cognitive-core/run',
      { questions: ['q1'], setups: ['core_rag'], model: 'ai/big', budget_usd: 0.25 },
      onEvent,
      signal,
    );
  });
});
