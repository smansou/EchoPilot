import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const output = resolve(import.meta.dirname, '../generated/echopilot-v1.schema.json');
const document = {
  '$schema': 'https://json-schema.org/draft/2020-12/schema',
  '$id': 'https://echopilot.local/contracts/v1',
  title: 'EchoPilot version 1 contracts',
  type: 'object',
  '$defs': {
    Scope: {
      type: 'object', additionalProperties: false,
      required: ['profileId', 'sensitivity'],
      properties: {
        profileId: { type: 'string', minLength: 1, maxLength: 128 },
        projectId: { type: 'string', minLength: 1, maxLength: 512 },
        worktreeId: { type: 'string', minLength: 1, maxLength: 512 },
        sessionId: { type: 'string', minLength: 1, maxLength: 512 },
        sensitivity: { enum: ['normal', 'private', 'secret'] },
      },
    },
    FixtureEvent: {
      type: 'object', additionalProperties: false,
      required: ['id', 'sessionId', 'text', 'createdAt'],
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 128 },
        sessionId: { type: 'string', minLength: 1, maxLength: 128 },
        text: { type: 'string', minLength: 1, maxLength: 8192 },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    EventEnvelope: {
      type: 'object', additionalProperties: true,
      required: ['schemaVersion', 'eventId', 'sourceId', 'sourceEventId', 'sourceSequence', 'ingestSequence', 'occurredAt', 'observedAt', 'scope', 'kind', 'payloadRef', 'contentHash', 'trust'],
      properties: {
        schemaVersion: { const: 1 }, eventId: { type: 'string' }, sourceId: { type: 'string' }, sourceEventId: { type: 'string' },
        sourceSequence: { type: 'integer', minimum: 0 }, ingestSequence: { type: 'integer', minimum: 0 },
        occurredAt: { type: 'string', format: 'date-time' }, observedAt: { type: 'string', format: 'date-time' }, monotonicNs: { type: 'string' },
        scope: { '$ref': '#/$defs/Scope' }, turnId: { type: 'string' }, parentEventId: { type: 'string' }, kind: { type: 'string' },
        payloadRef: { type: 'string' }, contentHash: { type: 'string' }, trust: { enum: ['user_explicit', 'tool_observed', 'agent_reported', 'imported'] },
      },
    },
    SpeechPlan: {
      type: 'object', additionalProperties: false,
      required: ['planId', 'epoch', 'priority', 'expiresAt', 'dedupeKey', 'segments', 'resume'],
      properties: {
        planId: { type: 'string' }, sessionId: { type: 'string' }, epoch: { type: 'integer', minimum: 0 },
        priority: { enum: ['critical', 'blocking', 'completion', 'progress'] }, expiresAt: { type: 'string', format: 'date-time' }, dedupeKey: { type: 'string' },
        segments: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'text', 'evidenceIds', 'exact', 'maxSeconds'], properties: { id: { type: 'string' }, text: { type: 'string' }, evidenceIds: { type: 'array', items: { type: 'string' } }, exact: { type: 'boolean' }, maxSeconds: { type: 'number', exclusiveMinimum: 0 } } } },
        resume: { enum: ['automatic', 'offer', 'discard'] },
      },
    },
    ActionRequest: {
      type: 'object', additionalProperties: false,
      required: ['actionId', 'idempotencyKey', 'scope', 'tool', 'arguments', 'evidenceIds', 'effect', 'targetFromGaze'],
      properties: { actionId: { type: 'string' }, idempotencyKey: { type: 'string' }, scope: { '$ref': '#/$defs/Scope' }, tool: { type: 'string' }, arguments: { type: 'object' }, evidenceIds: { type: 'array', items: { type: 'string' } }, targetFingerprint: { type: 'string' }, effect: { enum: ['read', 'local_write', 'external', 'destructive'] }, targetFromGaze: { type: 'boolean' }, grantId: { type: 'string' }, confirmationId: { type: 'string' } },
    },
  },
  'x-echopilot-subsystems': {
    NativeHost: ['capture', 'observeForeground', 'insertText', 'audio.start/stop/duck/flush', 'gaze.start/stop', 'execute'],
    Memory: ['ingest', 'query', 'consolidate', 'forget'],
    HarnessAdapter: ['capabilities', 'start', 'observe', 'send', 'interrupt', 'respondApproval', 'resume', 'close'],
    VoiceSession: ['start', 'pushInput', 'submitSpeech(plan, lease)', 'interrupt', 'mute', 'replay', 'close'],
    Attention: ['requestSpeech', 'canSpeak', 'revokeSpeech'],
    Reasoner: ['run'],
  },
};

const generated = `${JSON.stringify(document, null, 2)}\n`;
if (process.argv.includes('--check')) {
  let current = '';
  try { current = await readFile(output, 'utf8'); } catch { /* reported below */ }
  if (current !== generated) throw new Error(`Generated contract is stale: ${output}`);
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, generated, 'utf8');
}

