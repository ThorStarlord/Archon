import { afterEach, describe, expect, test } from 'bun:test';

import {
  ModelNotAllowedError,
  assertModelAllowed,
  getAllowedModels,
  setAllowedModels,
  withModelPolicy,
} from './model-policy';
import type { IAgentProvider, MessageChunk } from './types';

const FLASH = 'opencode-go/deepseek-v4.1-flash';

afterEach(() => setAllowedModels(undefined));

function recordingProvider(calls: string[]): IAgentProvider {
  return {
    // eslint-disable-next-line require-yield
    async *sendQuery(prompt: string): AsyncGenerator<MessageChunk> {
      calls.push(prompt);
      yield { type: 'result', sessionId: 's' };
    },
    getType: () => 'opencode',
    getCapabilities: () => ({}) as never,
  };
}

async function drain(gen: AsyncGenerator<MessageChunk>): Promise<void> {
  for await (const _ of gen) void _;
}

describe('allowedModels policy', () => {
  test('no policy means no restriction', () => {
    expect(getAllowedModels()).toBeUndefined();
    expect(() => assertModelAllowed('claude', 'sonnet')).not.toThrow();
  });

  test('an empty policy list is treated as unset, not as "allow nothing"', () => {
    setAllowedModels([]);
    expect(getAllowedModels()).toBeUndefined();
  });

  test('permits exactly the listed provider/model pair', () => {
    setAllowedModels([`opencode/${FLASH}`]);
    expect(() => assertModelAllowed('opencode', FLASH)).not.toThrow();
  });

  test.each([
    ['opencode', 'opencode-go/deepseek-v4-pro'],
    ['opencode', 'opencode-go/glm-5.3'],
    ['claude', FLASH],
    ['opencode', undefined],
    ['opencode', ''],
  ])('rejects %s / %s', (provider, model) => {
    setAllowedModels([`opencode/${FLASH}`]);
    expect(() => assertModelAllowed(provider, model)).toThrow(ModelNotAllowedError);
  });

  test('the wrapped provider rejects before making any call', async () => {
    setAllowedModels([`opencode/${FLASH}`]);
    const calls: string[] = [];
    const guarded = withModelPolicy('opencode', recordingProvider(calls));

    await expect(
      drain(guarded.sendQuery('p', '/tmp', undefined, { model: 'opencode-go/glm-5.3' }))
    ).rejects.toThrow(/not permitted/);
    expect(calls).toEqual([]);

    await drain(guarded.sendQuery('ok', '/tmp', undefined, { model: FLASH }));
    expect(calls).toEqual(['ok']);
  });
});
