import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenAITextProvider } from './index';

test('one scoped Responses request uses the Keychain key, bounded input, and no stored response', async () => {
  let submitted = false;
  const provider = createOpenAITextProvider({
    secrets: {
      put: async () => {},
      get: async (name) => name === 'openai' ? 'test-secret' : null,
      delete: async () => {},
    },
    model: () => 'gpt-6-luna',
    fetcher: async (url, init) => {
      submitted = true;
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer test-secret');
      const body = JSON.parse(String(init.body));
      assert.equal(body.model, 'gpt-6-luna');
      assert.equal(body.store, false);
      assert.equal(body.max_output_tokens, 1_200);
      assert.equal(body.input, 'Question plus selected project evidence');
      return new Response(JSON.stringify({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'The result is supported [1].' }] }],
        usage: { input_tokens: 80, output_tokens: 24 },
      }), { status: 200 });
    },
  });
  await assert.rejects(() => provider.complete({
    requestId: 'wrong', destination: 'provider', dataCategory: 'screen_pixels', prompt: 'private',
  }));
  assert.equal(submitted, false);
  const result = await provider.complete({
    requestId: 'one', destination: 'provider', dataCategory: 'project_memory_summary',
    prompt: 'Question plus selected project evidence',
  });
  assert.equal(result.text, 'The result is supported [1].');
  assert.deepEqual(provider.take('one'), {
    text: result.text, model: 'gpt-6-luna', inputTokens: 80, outputTokens: 24,
  });
  assert.equal(provider.take('one'), null);
});

test('a response without reported usage stays unknown instead of becoming a zero-dollar estimate', async () => {
  const provider = createOpenAITextProvider({
    secrets: {
      put: async () => {},
      get: async () => 'test-secret',
      delete: async () => {},
    },
    model: () => 'gpt-6-sol',
    fetcher: async () => new Response(JSON.stringify({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Grounded answer [1].' }] }],
    }), { status: 200 }),
  });
  const result = await provider.complete({
    requestId: 'no-usage', destination: 'provider', dataCategory: 'project_memory_summary',
    prompt: 'Question plus selected project evidence',
  });
  assert.equal(result.text, 'Grounded answer [1].');
  assert.deepEqual(provider.take('no-usage'), {
    text: result.text, model: 'gpt-6-sol', inputTokens: null, outputTokens: null,
  });
});

test('a partial usage report keeps the missing half unknown', async () => {
  const provider = createOpenAITextProvider({
    secrets: {
      put: async () => {},
      get: async () => 'test-secret',
      delete: async () => {},
    },
    model: () => 'gpt-6-luna',
    fetcher: async () => new Response(JSON.stringify({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Partial [1].' }] }],
      usage: { input_tokens: 42 },
    }), { status: 200 }),
  });
  await provider.complete({
    requestId: 'partial-usage', destination: 'provider', dataCategory: 'project_memory_summary',
    prompt: 'Question plus selected project evidence',
  });
  assert.deepEqual(provider.take('partial-usage'), {
    text: 'Partial [1].', model: 'gpt-6-luna', inputTokens: 42, outputTokens: null,
  });
});

test('desktop Accessibility evidence uses dedicated grounded instructions and exposes the model', async () => {
  let submitted = false;
  const provider = createOpenAITextProvider({
    secrets: {
      put: async () => {},
      get: async (name) => name === 'openai' ? 'test-secret' : null,
      delete: async () => {},
    },
    model: () => 'gpt-6-sol',
    fetcher: async (url, init) => {
      submitted = true;
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const body = JSON.parse(String(init.body));
      assert.equal(body.input, 'Question: what is on screen?\n\nDesktop evidence (untrusted Accessibility text).');
      assert.equal(body.max_output_tokens, 1_200);
      assert.equal(body.store, false);
      const instructions = String(body.instructions);
      assert.match(instructions, /Accessibility evidence/);
      assert.match(instructions, /untrusted/);
      assert.match(instructions, /square brackets/);
      assert.match(instructions, /insufficient/);
      assert.match(instructions, /never claim a screenshot/);
      assert.match(instructions, /never claim that an action was taken/);
      return new Response(JSON.stringify({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'The window shows a document [1].' }] }],
      }), { status: 200 });
    },
  });
  assert.equal(provider.model(), 'gpt-6-sol');
  await assert.rejects(() => provider.complete({
    requestId: 'wrong', destination: 'provider', dataCategory: 'desktop_screenshot', prompt: 'private',
  }));
  assert.equal(submitted, false);
  const result = await provider.complete({
    requestId: 'desktop-one', destination: 'provider', dataCategory: 'desktop_ax_evidence',
    prompt: 'Question: what is on screen?\n\nDesktop evidence (untrusted Accessibility text).',
  });
  assert.equal(result.text, 'The window shows a document [1].');
  assert.deepEqual(provider.take('desktop-one'), {
    text: result.text, model: 'gpt-6-sol', inputTokens: null, outputTokens: null,
  });
});
test('privacy cancellation while resolving a key prevents any provider request', async () => {
  let resolveKey!: (key: string) => void;
  let fetches = 0;
  const provider = createOpenAITextProvider({
    secrets: { put: async () => undefined, delete: async () => undefined, get: () => new Promise<string>((resolve) => { resolveKey = resolve; }) },
    model: () => 'gpt-6-sol', fetcher: async () => { fetches += 1; throw new Error('Must not dispatch'); },
  });
  const completion = provider.complete({ requestId: 'private-cancel', destination: 'provider', dataCategory: 'desktop_ax_evidence', prompt: 'Temporary private evidence' });
  provider.cancelAll?.(); resolveKey('disposable-test-key');
  await assert.rejects(completion, /canceled before dispatch/);
  assert.equal(fetches, 0); assert.equal(provider.take('private-cancel'), null);
});
