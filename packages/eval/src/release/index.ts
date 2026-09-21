#!/usr/bin/env node
/**
 * Q04 shared-layer evidence — the A–D day driven through one voice layer and one context budgeter.
 *
 * The release gate set carries this file as the cross-pillar gate's evidence, and executes it
 * (`node --import tsx packages/eval/src/release/index.ts [--measure <name>]`). It proves the two
 * "one shared service" claims the gate set makes for all four pillars:
 *
 *   1. every pillar's spoken turn is committed by the one voice layer
 *      (`packages/voice/src/index.ts`, `createLocalVoiceSession`) — there is no second session
 *      factory anywhere in first-party source, and the harnesses that drive pillars C/D import the
 *      canonical modules;
 *   2. every pillar's turn is admitted (or explicitly shed, with `coverage: partial`) by the one
 *      context budgeter (`packages/memory/src/context/index.ts`, `CONTEXT_CEILING_TOKENS` /
 *      `boundedBudget` / `createContextAssembler`) — no pillar can leave the shared budget, because
 *      the assembler refuses a request past it.
 *
 * The `--measure` switches publish the §5.11 gaze numbers as their own pillar-D gates:
 *   `gaze-read-only-precision`, `gaze-deictic-improvement`,
 *   `gaze-unconfirmed-consequential-actions`. Without a switch the whole cross-pillar day runs.
 *
 * Every check prints `<name> ok: <detail>`; a failed check prints `problem: <name>: <detail>` and
 * the process exits 1, so the gate cannot pass by printing.
 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCommandTool } from '../../../desktop-tools/src/commands/index.js';
import type { CommandToolInput, CommandToolOptions } from '../../../desktop-tools/src/commands/index.js';
import { CONTEXT_CEILING_TOKENS, boundedBudget, createContextAssembler } from '../../../memory/src/context/index.js';
import type { CommandExecution, CommandOutcome, CommandProposal, CommandRequest } from '../../../security/src/execution/types.js';
import {
  GAZE_WORD_AT,
  buildCaseFixture,
  createHarnessSession,
  measureDeicticImprovement,
  measureReadOnlyTargetPrecision,
  measureUnconfirmedConsequentialActions,
} from './gaze-harness.js';
import { createVoiceHarness } from './voice-harness.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const EVAL_DIRECTORY = 'packages/eval/src/release';
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.build', 'dist', 'generated', 'coverage']);

/** Plan §5.11 published gaze gates, mirrored here so the evidence pins the same targets. */
export const PUBLISHED_GAZE_TARGETS = Object.freeze({
  readOnlyTargetPrecision: 0.9,
  deicticImprovement: 0.1,
  unconfirmedConsequentialActions: 0,
});

/** One scripted pillar turn; the same four strings run through the voice layer and the budgeter. */
export const PILLAR_TURNS = Object.freeze([
  Object.freeze({ pillar: 'A', kind: 'dictation', text: 'Take dictation for the atlas release notes.' }),
  Object.freeze({ pillar: 'B', kind: 'narration', text: 'Summarise what changed in the atlas build overnight.' }),
  Object.freeze({ pillar: 'C', kind: 'desktop', text: 'Run the release checklist in the atlas workspace.' }),
  Object.freeze({ pillar: 'D', kind: 'gaze', text: 'Set this one to approve build' }),
]);

/**
 * First-party source modules whose declarations must stay unique: the shared services and the
 * shipped desktop/gaze gates the probes drive. A pillar that forks one of these is caught here.
 */
const SHARED_DECLARATIONS = Object.freeze([
  Object.freeze({ pattern: /export\s+(?:async\s+)?function\s+createLocalVoiceSession\b/g, canonical: 'packages/voice/src/index.ts' }),
  Object.freeze({ pattern: /export\s+(?:async\s+)?function\s+createContextAssembler\b/g, canonical: 'packages/memory/src/context/index.ts' }),
  Object.freeze({ pattern: /export\s+const\s+CONTEXT_CEILING_TOKENS\b/g, canonical: 'packages/memory/src/context/index.ts' }),
]);

export type ProbeCheck = Readonly<{ name: string; detail: string }>;

function record(checks: ProbeCheck[], name: string, detail: string): void {
  checks.push({ name, detail });
  console.log(`${name} ok: ${detail}`);
}

function fail(name: string, detail: string): never {
  console.error(`problem: ${name}: ${detail}`);
  process.exit(1);
}

function expect(condition: boolean, name: string, detail: string): void {
  if (!condition) fail(name, detail);
}

function pick<T>(name: string, value: T | undefined | null): T {
  if (value === undefined || value === null) fail(`missing-${name}`, `${name} is required`);
  return value;
}

function at<T>(name: string, values: readonly T[], index: number): T {
  return pick(`${name}[${index}]`, values[index]);
}

async function listTsModules(root: string): Promise<string[]> {
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) stack.push(absolute);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      if (/\.(test|spec)\.ts$/.test(entry.name)) continue;
      found.push(absolute);
    }
  }
  return found.sort();
}

/** Fails when any pillar could reach a forked shared service instead of the canonical module. */
async function checkOneSharedService(checks: ProbeCheck[]): Promise<void> {
  const packagesRoot = join(REPO_ROOT, 'packages');
  const files = await listTsModules(packagesRoot);
  for (const declaration of SHARED_DECLARATIONS) {
    const declaring: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      const matches = text.match(declaration.pattern);
      if ((matches?.length ?? 0) > 0) declaring.push(relative(REPO_ROOT, file));
    }
    expect(
      declaring.length === 1 && declaring[0] === declaration.canonical,
      `one-shared-service:${declaration.canonical}`,
      `expected exactly one declaration in ${declaration.canonical}; found ${declaring.length} `
        + `across ${declaring.join(', ') || 'none'}`,
    );
  }
  record(
    checks,
    'one-shared-service',
    'first-party source declares createLocalVoiceSession, createContextAssembler and '
      + 'CONTEXT_CEILING_TOKENS exactly once each, in the canonical modules',
  );

  for (const harness of ['voice-harness.ts', 'gaze-harness.ts', 'index.ts']) {
    const text = await readFile(join(REPO_ROOT, EVAL_DIRECTORY, harness), 'utf8');
    expect(
      text.includes('createLocalVoiceSession') || text.includes('createGazeActionCoordinator') || harness === 'index.ts',
      `harness-wiring:${harness}`,
      `${harness} must drive the shipped shared services`,
    );
  }
  const voiceHarnessText = await readFile(join(REPO_ROOT, EVAL_DIRECTORY, 'voice-harness.ts'), 'utf8');
  expect(
    voiceHarnessText.includes("'../../../voice/src/index.js'"),
    'voice-harness-canonical-module',
    'voice-harness.ts must import the canonical voice layer',
  );
  const gazeHarnessText = await readFile(join(REPO_ROOT, EVAL_DIRECTORY, 'gaze-harness.ts'), 'utf8');
  expect(
    gazeHarnessText.includes("'../../../desktop-tools/src/gaze-actions/index.js'"),
    'gaze-harness-canonical-gate',
    'gaze-harness.ts must import the shipped gaze confirmation gate',
  );
  record(checks, 'harness-wiring', 'the release harnesses import the canonical voice layer and gaze gate');
}

function scriptedExecution(): { execution: CommandExecution; requests: CommandRequest[] } {
  const requests: CommandRequest[] = [];
  const execution: CommandExecution = {
    async propose(request: CommandRequest): Promise<CommandProposal> {
      return {
        proposalId: `q04-proposal-${request.requestId}`,
        requestId: request.requestId,
        executor: request.executor,
        executionLabel: 'q04-scripted-executor',
        argv: [...request.argv],
        workdir: request.workdir,
        mounts: [{ source: '/repo', target: '/work', writable: false }],
        network: { mode: 'deny', hosts: [] },
        hostAuthority: null,
        grantId: request.grantId,
        grantVersion: 3,
      };
    },
    async dispatch(request: CommandRequest): Promise<CommandOutcome> {
      requests.push(request);
      return {
        requestId: request.requestId,
        proposalId: `q04-proposal-${request.requestId}`,
        executor: request.executor,
        executionLabel: 'q04-scripted-executor',
        state: 'completed',
        exitCode: 0,
        stdout: 'released\n',
        stderr: '',
        processGroupId: 4242,
        stopped: true,
        uncertainChildren: [],
        observedAt: '2026-09-22T09:00:00.000Z',
      };
    },
    async cancel(requestId: string): Promise<CommandOutcome> {
      throw new Error(`q04 probe: unexpected cancel(${requestId})`);
    },
  };
  return { execution, requests };
}

function commandInput(callId: string, utterance: string, args: Record<string, unknown>): CommandToolInput {
  return { callId, utterance, toolCall: { name: 'run_command', arguments: args } };
}

/** Direction: the scripted day, run end to end. Returns the recorded checks. */
export async function runCrossPillarProbe(): Promise<ProbeCheck[]> {
  const checks: ProbeCheck[] = [];

  await checkOneSharedService(checks);

  // 1. The one voice layer commits one turn per pillar.
  const voice = createVoiceHarness({ utterances: PILLAR_TURNS.map((turn) => turn.text), permission: 'granted' });
  await voice.session.start();
  await voice.pushFrames(96);
  await voice.waitForCommitted(PILLAR_TURNS.length);
  const turns = voice.transcriptTexts().slice(0, PILLAR_TURNS.length);
  expect(
    turns.length === PILLAR_TURNS.length
      && turns.every((text, index) => text === at('pillar-turn', PILLAR_TURNS, index).text),
    'voice-layer-commits-four-pillar-turns',
    `expected the four scripted pillar turns from the shared session; saw ${JSON.stringify(turns)}`,
  );
  expect(voice.captureActive(), 'voice-layer-capture-active', 'the shared voice session must be capturing');
  record(
    checks,
    'voice-layer-commits-four-pillar-turns',
    `one createLocalVoiceSession committed ${turns.length} pillar turns (A–D) verbatim`,
  );

  // 2. Pillar C: the desktop scoped-action seam, driven from the voice-committed turn.
  const { execution, requests } = scriptedExecution();
  const toolOptions: CommandToolOptions = {
    execution,
    scope: { profileId: 'q04-profile', projectId: 'atlas', sensitivity: 'normal' },
  };
  const tool = createCommandTool(toolOptions);
  const desktopTurn = at('pillar-turn', turns, 2);
  const shellString = await tool.run(commandInput('q04-call-shell', desktopTurn, { command: 'rm -rf /' }));
  expect(
    shellString.state === 'denied' && shellString.reason === 'argv_required' && requests.length === 0,
    'desktop-shell-string-refused',
    `a shell-string call must be refused before the executor: ${JSON.stringify(shellString.reason)}`,
  );
  record(
    checks,
    'desktop-shell-string-refused',
    'a single-string command was refused as argv_required with the executor never asked',
  );
  const smuggling = await tool.run(commandInput('q04-call-mounts', desktopTurn, {
    executor: 'vm',
    argv: ['echo', 'released'],
    workdir: '/work',
    grantId: 'grant-atlas',
    mounts: [{ source: '/etc', target: '/etc', writable: true }],
  }));
  expect(
    smuggling.state === 'denied' && smuggling.reason === 'invalid_tool_call' && requests.length === 0,
    'desktop-containment-smuggling-refused',
    `a call choosing its own containment must be refused inertly: ${JSON.stringify(smuggling.reason)}`,
  );
  record(
    checks,
    'desktop-containment-smuggling-refused',
    'a call that tried to choose its own mounts was refused as invalid_tool_call, inertly',
  );
  const acceptedInput = commandInput('q04-call-atlas', desktopTurn, {
    executor: 'vm',
    argv: ['echo', 'released'],
    workdir: '/work',
    grantId: 'grant-atlas',
  });
  const accepted = await tool.run(acceptedInput);
  const replay = await tool.run(acceptedInput);
  expect(
    accepted.state === 'completed'
      && requests.length === 2
      && requests[0]?.scope.projectId === 'atlas'
      && requests[0]?.utterance === desktopTurn
      && requests[0]?.requestId === requests[1]?.requestId,
    'desktop-scoped-action-accepted',
    'the scoped action must reach the executor exactly once per call id, bound to the shared scope '
      + 'and the voice-committed utterance, with a replay-stable request id',
  );
  record(
    checks,
    'desktop-scoped-action-accepted',
    `run_command completed in scope atlas from the voice turn; requestId ${accepted.requestId} stable across replay`,
  );

  // 3. Pillar D: the gaze confirmation gate and the three published §5.11 measurements.
  const fixture = buildCaseFixture('Message body', 'approve build');
  const gazeSession = createHarnessSession(fixture);
  const deictic = await gazeSession.coordinator.propose({
    requestId: 'q04-voice-deictic',
    utterance: { text: at('pillar-turn', turns, 3), wordAt: GAZE_WORD_AT },
    candidates: fixture.candidates,
    gaze: fixture.gazeAtTarget,
    effect: 'read',
    step: null,
  });
  expect(
    deictic.kind === 'proposal'
      && deictic.proposal.candidateId === fixture.target.candidateId
      && deictic.proposal.basis === 'gaze',
    'gaze-resolves-the-voice-turn',
    `the deictic turn committed by the voice layer must resolve through gaze; got ${JSON.stringify(deictic.kind)}`,
  );

  const precision = await measureReadOnlyTargetPrecision();
  expect(
    precision.precision >= PUBLISHED_GAZE_TARGETS.readOnlyTargetPrecision,
    'gaze-read-only-precision',
    `read-only target precision ${precision.precision.toFixed(3)} is below the published target `
      + `${PUBLISHED_GAZE_TARGETS.readOnlyTargetPrecision}`,
  );
  record(
    checks,
    'gaze-read-only-precision',
    `${precision.correct}/${precision.resolved} gaze-resolved read-only targets were the intended control `
      + `(precision ${precision.precision.toFixed(3)} >= ${PUBLISHED_GAZE_TARGETS.readOnlyTargetPrecision})`,
  );

  const deicticImprovement = await measureDeicticImprovement();
  expect(
    deicticImprovement.improvement >= PUBLISHED_GAZE_TARGETS.deicticImprovement,
    'gaze-deictic-improvement',
    `deictic improvement ${deicticImprovement.improvement.toFixed(3)} is below the published target `
      + `${PUBLISHED_GAZE_TARGETS.deicticImprovement}`,
  );
  record(
    checks,
    'gaze-deictic-improvement',
    `same resolver: ${deicticImprovement.withGaze.toFixed(2)} with gaze vs ${deicticImprovement.withoutGaze.toFixed(2)} `
      + `without (improvement ${deicticImprovement.improvement.toFixed(2)} >= ${PUBLISHED_GAZE_TARGETS.deicticImprovement})`,
  );

  const unconfirmed = await measureUnconfirmedConsequentialActions();
  expect(
    unconfirmed.executed === PUBLISHED_GAZE_TARGETS.unconfirmedConsequentialActions,
    'gaze-unconfirmed-consequential-actions',
    `${unconfirmed.executed} consequential gaze action(s) executed without a fresh confirmation; the `
      + 'published target is zero',
  );
  record(
    checks,
    'gaze-unconfirmed-consequential-actions',
    `${unconfirmed.cases.length} confirmation-bypass attacks attempted, ${unconfirmed.executed} executed`,
  );

  // 4. The one context budgeter admits every pillar turn inside the shared ceiling.
  const model = { modelId: 'echopilot-shared-8k', contextCapacity: 32_768 };
  const budget = boundedBudget(model);
  expect(
    budget.ceiling === CONTEXT_CEILING_TOKENS,
    'shared-budget-is-the-published-ceiling',
    `boundedBudget produced ceiling ${budget.ceiling}, not the published ${CONTEXT_CEILING_TOKENS}`,
  );
  const assembler = createContextAssembler({
    tokenizer: { count: (text: string) => (text.match(/[\p{L}\p{N}]+/gu) ?? []).length },
    imageTokens: (image) => Math.ceil((image.width * image.height) / 750),
  });
  const baseRequest = {
    model,
    instruction: 'You are EchoPilot. Answer from the day just recorded for the atlas project.',
    request: 'What did the atlas project do today, and what is waiting for confirmation?',
    card: 'Project atlas · session 2026-09-22 · local-only',
    dialogue: PILLAR_TURNS.map((turn) => ({ id: `turn-${turn.pillar}`, text: `${turn.pillar}: ${turn.text}` })),
    evidence: [
      { id: 'gaze-resolution', text: `D resolved ${fixture.target.label} from "${turns[3]}".` },
      { id: 'desktop-action', text: `C ran ${accepted.requestId} in scope atlas and reported ${accepted.state}.` },
      { id: 'memory-recall', text: 'B recalled the overnight build summary with source support.' },
    ],
    images: [{ id: 'atlas-window', width: 100, height: 100 }],
    tools: [{ name: tool.describe().name, schema: tool.describe().parameters }],
  };
  const assembled = await assembler.assemble(baseRequest);
  const admitted = PILLAR_TURNS.every((turn) => assembled.prompt.includes(turn.text));
  const accountedTotal = Object.values(assembled.accounting).reduce((total, value) => total + value, 0);
  expect(
    assembled.maxTokens === CONTEXT_CEILING_TOKENS
      && assembled.inputTokens <= budget.input
      && assembled.totalTokens <= assembled.maxTokens
      && accountedTotal === assembled.totalTokens
      && assembled.accounting.output === budget.outputReservation
      && assembled.coverage === 'complete'
      && admitted,
    'one-context-budgeter-admits-all-pillars',
    `assembled ${assembled.totalTokens}/${assembled.maxTokens} tokens (coverage ${assembled.coverage}, `
      + `all pillars admitted: ${admitted}); the shared budget must admit every pillar turn`,
  );
  record(
    checks,
    'one-context-budgeter-admits-all-pillars',
    `${PILLAR_TURNS.length} pillar turns + tool/evidence/image charges assembled to ${assembled.totalTokens}/`
      + `${assembled.maxTokens} tokens under one createContextAssembler`,
  );

  const overflow = await assembler.assemble({ ...baseRequest, card: 'oversized atlas session '.repeat(5_000) });
  expect(
    overflow.maxTokens === CONTEXT_CEILING_TOKENS
      && overflow.totalTokens <= overflow.maxTokens
      && overflow.coverage === 'partial',
    'shared-budget-cannot-be-exceeded',
    `an oversized pillar must be shed with coverage partial inside the ceiling; got `
      + `${overflow.totalTokens}/${overflow.maxTokens} (${overflow.coverage})`,
  );
  record(
    checks,
    'shared-budget-cannot-be-exceeded',
    `an oversized day still assembled to ${overflow.totalTokens}/${overflow.maxTokens} tokens with coverage `
      + `"${overflow.coverage}" (shed, never past the ceiling)`,
  );

  await voice.session.close();
  return checks;
}

/** Runs one published pillar-D measurement as its own gate. */
export async function runMeasure(name: string): Promise<void> {
  switch (name) {
    case 'gaze-read-only-precision': {
      const precision = await measureReadOnlyTargetPrecision();
      expect(
        precision.precision >= PUBLISHED_GAZE_TARGETS.readOnlyTargetPrecision,
        'gaze-read-only-precision',
        `precision ${precision.precision.toFixed(3)} is below ${PUBLISHED_GAZE_TARGETS.readOnlyTargetPrecision}`,
      );
      console.log(
        `gaze-read-only-precision ok: ${precision.correct}/${precision.resolved} resolved targets correct `
          + `(precision ${precision.precision.toFixed(3)} >= ${PUBLISHED_GAZE_TARGETS.readOnlyTargetPrecision}, `
          + `${precision.clarified} clarified)`,
      );
      return;
    }
    case 'gaze-deictic-improvement': {
      const measured = await measureDeicticImprovement();
      expect(
        measured.improvement >= PUBLISHED_GAZE_TARGETS.deicticImprovement,
        'gaze-deictic-improvement',
        `improvement ${measured.improvement.toFixed(3)} is below ${PUBLISHED_GAZE_TARGETS.deicticImprovement}`,
      );
      console.log(
        `gaze-deictic-improvement ok: ${measured.withGaze.toFixed(2)} with gaze vs `
          + `${measured.withoutGaze.toFixed(2)} without (improvement ${measured.improvement.toFixed(2)} >= `
          + `${PUBLISHED_GAZE_TARGETS.deicticImprovement}, ${measured.cases} cases)`,
      );
      return;
    }
    case 'gaze-unconfirmed-consequential-actions': {
      const measured = await measureUnconfirmedConsequentialActions();
      expect(
        measured.executed === PUBLISHED_GAZE_TARGETS.unconfirmedConsequentialActions,
        'gaze-unconfirmed-consequential-actions',
        `${measured.executed} unconfirmed consequential action(s) executed; the published target is zero`,
      );
      console.log(
        `gaze-unconfirmed-consequential-actions ok: ${measured.cases.length} attacks attempted, `
          + `${measured.executed} executed (target ${PUBLISHED_GAZE_TARGETS.unconfirmedConsequentialActions})`,
      );
      return;
    }
    default:
      fail('unknown-measure', `unknown --measure ${JSON.stringify(name)}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const measureIndex = args.indexOf('--measure');
  const measure = measureIndex >= 0 ? args[measureIndex + 1] : undefined;
  if (measureIndex >= 0 && measure === undefined) fail('missing-measure', '--measure needs a name');
  if (measure !== undefined) {
    await runMeasure(measure);
    return;
  }
  const unknown = args.filter((arg) => arg !== '--cross-pillar');
  if (unknown.length > 0) fail('unknown-arguments', `unexpected argument(s): ${unknown.join(' ')}`);
  const checks = await runCrossPillarProbe();
  console.log(
    `cross-pillar: ${checks.length} checks passed for pillars A–D through one voice layer and one context budgeter`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`problem: cross-pillar-evidence: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
