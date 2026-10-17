import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createDesktopObserveHost, type DesktopObserveChild } from './desktop-observe';

const PROJECT = 'gaze-regions-test';
const FRAME = { x: -1200, y: -80, width: 1000, height: 600 };
const REGION = { kind: 'sentence', text: 'Hello 😀.', frame: { x: -1100, y: 10, width: 180, height: 24 }, rangeStart: 42, rangeLength: 9 };
const NODE = { depth: 1, role: 'AXTextArea', subrole: null, label: 'Document', value: 'Hello 😀.',
  labelTruncated: false, valueTruncated: false, redacted: false, roleTruncated: false, subroleTruncated: false };
const WINDOW = { role: 'AXWindow', roleTruncated: false, title: 'Fixture', titleTruncated: false };

function fixture(window: Record<string, unknown> = WINDOW, node: Record<string, unknown> = NODE) {
  return { kind: 'desktop_observe', observedAtMs: 1_759_000_000_000, projectId: PROJECT,
    application: { pid: 501, bundleId: 'com.example.fixture', name: 'Fixture', bundleIdTruncated: false, nameTruncated: false },
    window, nodes: [node], quality: 'full', truncated: false, truncations: [],
    stats: { visitedNodes: 1, emittedNodes: 1, maxDepthReached: 1, estimatedBytes: 180 } };
}

function harness(payload: unknown) {
  const writes: string[] = [];
  let onData: ((chunk: string | Buffer) => void) | undefined;
  const child: DesktopObserveChild = {
    stdin: { write(data) { writes.push(data); onData?.(`${JSON.stringify({ ok: true,
      result: { type: 'json', payload: JSON.stringify(payload) } })}\n`); return true; } },
    stdout: { setEncoding() { return undefined; }, on(_event, listener) { onData = listener; return undefined; } },
    kill() { return true; },
    on() { return this; },
  };
  const host = createDesktopObserveHost({ bundleDir: '/fixture/dist/main', helperPath: '/fixture/helper',
    exists: () => true, spawn: () => child, timeoutMs: 250 });
  return { host, writes };
}

test('observation preserves logical geometry, native window identity and UTF16 text ranges', async () => {
  const { host } = harness(fixture({ ...WINDOW, id: 'ax-12345678', frame: FRAME }, { ...NODE, frame: FRAME, textRegions: [REGION] }));
  const result = await host.observe({ projectId: PROJECT });
  assert.equal(result.outcome, 'observed');
  if (result.outcome !== 'observed') return;
  assert.equal(result.evidence.window.id, 'ax-12345678');
  assert.deepEqual(result.evidence.window.frame, FRAME);
  assert.deepEqual(result.evidence.nodes[0]?.frame, FRAME);
  assert.deepEqual(result.evidence.nodes[0]?.textRegions, [REGION]);
});

test('legacy observations without optional geometry remain supported', async () => {
  const { host } = harness(fixture());
  const result = await host.observe({ projectId: PROJECT });
  assert.equal(result.outcome, 'observed');
  if (result.outcome !== 'observed') return;
  assert.equal(result.evidence.window.frame, undefined);
  assert.equal(result.evidence.window.id, undefined);
  assert.equal(result.evidence.nodes[0]?.textRegions, undefined);
});

test('local OCR is forwarded only for an explicit true opt in', async () => {
  for (const setting of [undefined, false, true, 'true', 1, null]) {
    const { host, writes } = harness(fixture());
    const result = await host.observe({ projectId: PROJECT, ...(setting === undefined ? {} : { allowLocalOCR: setting as boolean }) });
    assert.equal(result.outcome, 'observed');
    const request = JSON.parse(writes[0]!);
    if (setting === true) assert.equal(request.allowLocalOCR, true);
    else assert.equal(Object.hasOwn(request, 'allowLocalOCR'), false);
  }
});

test('invalid element or window geometry is refused before overlay use', async () => {
  const badFrames = [null, {}, { ...FRAME, width: 0 }, { ...FRAME, height: -1 }, { ...FRAME, x: 100001 },
    { ...FRAME, y: '0' }, { ...FRAME, width: Infinity }, { ...FRAME, x: NaN }];
  for (const frame of badFrames) {
    for (const payload of [fixture({ ...WINDOW, frame }), fixture(WINDOW, { ...NODE, frame })]) {
      const { host } = harness(payload);
      assert.equal((await host.observe({ projectId: PROJECT })).outcome, 'malformed_response');
    }
  }
  for (const id of [42, null, 'x'.repeat(129)]) {
    const { host } = harness(fixture({ ...WINDOW, id }));
    assert.equal((await host.observe({ projectId: PROJECT })).outcome, 'malformed_response');
  }
});

test('text region bounds and UTF16 ranges cannot escape native limits', async () => {
  const malformed = [null, {}, [null], Array(13).fill(REGION), [{ ...REGION, kind: 'word' }],
    [{ ...REGION, frame: { ...FRAME, width: 0 } }], [{ ...REGION, rangeStart: -1 }],
    [{ ...REGION, rangeStart: 10000001 }], [{ ...REGION, rangeLength: 0 }],
    [{ ...REGION, rangeLength: 2049 }], [{ ...REGION, rangeLength: 2.5 }], [{ ...REGION, text: 42 }]];
  for (const textRegions of malformed) {
    const { host } = harness(fixture(WINDOW, { ...NODE, textRegions }));
    assert.equal((await host.observe({ projectId: PROJECT })).outcome, 'malformed_response');
  }
});

test('redacted native nodes cannot carry text or overlay geometry into the host', async () => {
  const { host } = harness(fixture(WINDOW, { ...NODE, role: 'AXSecureTextField', redacted: true,
    label: 'fixture secret', value: 'fixture secret', frame: FRAME, textRegions: [REGION] }));
  const result = await host.observe({ projectId: PROJECT });
  assert.equal(result.outcome, 'observed');
  if (result.outcome !== 'observed') return;
  const node = result.evidence.nodes[0]!;
  assert.equal(node.label, null);
  assert.equal(node.value, null);
  assert.equal(node.frame, undefined);
  assert.equal(node.textRegions, undefined);
  assert.equal(JSON.stringify(node).includes('fixture secret'), false);
});

test('interactive region reads explicitly request the bounded native traversal budget',async()=>{
  for(const interactive of [true,false,undefined]){
    const {host,writes}=harness(fixture());
    await host.observe({projectId:PROJECT,...(interactive===undefined?{}:{interactive})});
    assert.equal(JSON.parse(writes[0]!).interactive,interactive===true?true:undefined);
  }
});
