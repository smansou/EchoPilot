/**
 * N02 stages 4–5 — messy stream → typed claims: every claim is derived from observed output, keeps
 * the durable event ids it came from, and carries the verbosity band at which it may be spoken.
 *
 * The rules that decide the acceptance criteria live here:
 *
 * - `tool_completed` is the only place an observed outcome comes from; a nonzero exit code is
 *   spoken as a failure, never smoothed into a success sentence;
 * - log lines are classified by what they carry: failures and retries are problems, `@@`/diff lines
 *   are changes, summaries are verification, milestones are progress and lines that still carry raw
 *   detail stay details. Everything is rendered through `formatForSpeech`, so no claim text can
 *   recite a raw path, URL or code token;
 * - repeated identical stream lines (progress redraws) collapse into one claim that cites every
 *   copy, so a redraw storm can never become one utterance per redraw;
 * - `agent_message` prose becomes an explicitly unsupported, agent-reported claim that no spoken
 *   segment may cite, so a sentence contradicting the observed exit code can never become verified;
 * - every claim cites events of its own run only — there is no path to hallucinated evidence.
 */
import type { EventEnvelope } from '../../../contracts/src/index.js';
import { spokenArtifactName } from '../format.js';
import { formatForSpeech } from '../formatting/index.js';

export type NarrationClaimKind = 'result' | 'decision' | 'change' | 'problem' | 'progress' | 'verification';
/** Verbosity band at which a claim enters the spoken digest; 0 means it is never spoken. */
export type ClaimBand = 0 | 1 | 2 | 3 | 4;
export type NarrationChapterId = 'outcome' | 'problems' | 'decisions' | 'changes' | 'progress' | 'details';

export type DerivedClaim = Readonly<{
  id: string;
  kind: NarrationClaimKind;
  text: string;
  evidenceIds: ReadonlyArray<string>;
  supported: boolean;
  agentReported: boolean;
  band: ClaimBand;
  chapter: NarrationChapterId;
}>;

/** One normalized run: the §5.3 envelopes plus the payload each `payloadRef` resolves to. */
export type NarrationRun = Readonly<{
  runId: string;
  sessionId: string;
  taskId: string;
  events: ReadonlyArray<EventEnvelope>;
  payloads: Readonly<Record<string, unknown>>;
}>;

export type DerivedStream = Readonly<{
  claims: ReadonlyArray<DerivedClaim>;
  suppressed: Readonly<{ duplicateRedraws: number; unsupportedClaims: number; duplicateClaims: number }>;
}>;

const WHITESPACE = /\s+/gu;
/** A leading stream tag such as `N02-LOG` describes the producer, not the meaning. */
const STREAM_TAG = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\s+/u;
/** A redrawn progress bar or percentage is an update of one logical progress, not new meaning. */
const PROGRESS_BAR = /\[[=\-#>.\s]*\]/u;
const PERCENT = /\b(\d{1,3})\s*%/u;

type LineClass = 'problem' | 'change' | 'verification' | 'progress' | 'detail' | 'note';

const LINE_RULES: Readonly<Record<LineClass, Readonly<{
  kind: NarrationClaimKind;
  band: ClaimBand;
  chapter: NarrationChapterId;
  prefix: string;
}>>> = {
  problem: { kind: 'problem', band: 2, chapter: 'problems', prefix: 'Problem: ' },
  change: { kind: 'change', band: 3, chapter: 'changes', prefix: 'Change: ' },
  verification: { kind: 'verification', band: 4, chapter: 'details', prefix: 'Verification: ' },
  progress: { kind: 'progress', band: 4, chapter: 'progress', prefix: 'Progress: ' },
  detail: { kind: 'progress', band: 4, chapter: 'details', prefix: 'Detail: ' },
  note: { kind: 'progress', band: 4, chapter: 'details', prefix: 'Stream note: ' },
};

function objectPayload(run: NarrationRun, event: EventEnvelope): Record<string, unknown> {
  const value: unknown = run.payloads[event.payloadRef];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function exitCodeField(payload: Record<string, unknown>): number | null {
  const value = payload.exitCode;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/u.test(value.trim())) return Number.parseInt(value, 10);
  return null;
}

function normalizeLine(line: string): string {
  return line.replace(WHITESPACE, ' ').trim();
}

/** Drops a leading producer tag so the spoken sentence leads with the meaning. */
export function stripStreamTag(line: string): string {
  return line.replace(STREAM_TAG, '');
}

/** Upper-case severities, counted failures and nonzero exit codes — never a `0 failed` summary. */
function isFailureLine(line: string): boolean {
  if (/\b(?:FAIL|FAILED|ERROR|ERRORS|FATAL|EXCEPTION|ABORTED)\b/u.test(line)) return true;
  if (/\b[1-9]\d*\s+(?:checks?\s+)?(?:failed|failures?|errors?)\b/iu.test(line)) return true;
  if (/\bfailed\s*:/iu.test(line)) return true;
  if (/\bexit\s+(?:code|status)\s+[1-9]\d*/iu.test(line)) return true;
  return false;
}

/** True when a line still carries raw path, URL or code detail the ordinary digest must not recite. */
function carriesRawDetail(line: string): boolean {
  if (/:\/\//u.test(line)) return true;
  if (/(?:[A-Za-z0-9_.@+%-]+\/)+[A-Za-z0-9_.@+%-]*/u.test(line)) return true;
  if (/[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*\(/u.test(line)) return true;
  return false;
}

function classifyLine(line: string): LineClass {
  if (PROGRESS_BAR.test(line) || PERCENT.test(line)) return 'note';
  if (isFailureLine(line)) return 'problem';
  if (/\bretr(?:y|ying|ies)|attempt\s+\d+\s+of\s+\d+/iu.test(line)) return 'problem';
  if (/\bdiff\b|@@/iu.test(line)) return 'change';
  if (/\b(?:verified|verification|passed|summary|checks?\s+passed)\b/iu.test(line)) return 'verification';
  if (/\b(?:milestone|progress)\b/iu.test(line)) return 'progress';
  if (carriesRawDetail(line)) return 'detail';
  return 'note';
}

/** True when a line is a redrawn progress bar or percentage update rather than new meaning. */
export function isRedrawLine(line: string): boolean {
  return PROGRESS_BAR.test(line) || PERCENT.test(line);
}

function sentence(text: string): string {
  return /[.!?]$/u.test(text) ? text : `${text}.`;
}

/** The one outcome sentence per receipt: an observed nonzero exit is spoken as a failure. */
function resultText(command: string | null, exitCode: number | null): string {
  const artifact = command === null ? null : spokenArtifactName(command);
  const subject = artifact === null ? 'The managed command' : formatForSpeech(artifact);
  if (exitCode === null) return `${subject} finished without an exit status.`;
  if (exitCode === 0) return `${subject} finished with exit status zero.`;
  return `${subject} reported a failure: exit status ${exitCode}.`;
}

/** The digest of a collapsed redraw storm: counts, never one spoken line per redraw. */
function redrawText(count: number, lines: ReadonlyArray<string>): string {
  let latest: string | null = null;
  for (const line of lines) {
    const percent = PERCENT.exec(line)?.[1];
    if (percent !== undefined) latest = percent;
  }
  const suffix = latest === null ? '' : `, latest at ${latest} percent`;
  return `Progress redraws: ${count} repeated updates collapsed into this digest${suffix}.`;
}

type Candidate = {
  kind: NarrationClaimKind;
  band: ClaimBand;
  chapter: NarrationChapterId;
  text: string;
  evidenceIds: string[];
  supported: boolean;
  agentReported: boolean;
};

/**
 * Reduces one run to typed claims in stream order. Nothing here reads fixture labels: the only
 * inputs are the envelopes and the payloads their `payloadRef` resolves to.
 */
export function deriveClaims(run: NarrationRun): DerivedStream {
  const events = [...run.events].sort((left, right) => left.sourceSequence - right.sourceSequence);
  const candidates: Candidate[] = [];
  const lineClaimIndex = new Map<string, Candidate>();
  const lineOccurrences = new Map<string, number>();
  const redrawLines: string[] = [];
  let redrawClaim: Candidate | null = null;
  let duplicateRedraws = 0;
  let duplicateClaims = 0;
  let unsupportedClaims = 0;

  for (const event of events) {
    const payload = objectPayload(run, event);
    switch (event.kind) {
      case 'tool_completed': {
        const exitCode = exitCodeField(payload);
        const command = textField(payload, 'command');
        candidates.push({
          kind: 'result',
          band: 1,
          chapter: 'outcome',
          text: resultText(command, exitCode),
          evidenceIds: [event.eventId],
          supported: true,
          agentReported: false,
        });
        break;
      }
      case 'decision': {
        const summary = textField(payload, 'summary') ?? textField(payload, 'rationale');
        if (summary === null) break;
        candidates.push({
          kind: 'decision',
          band: 3,
          chapter: 'decisions',
          text: sentence(`Decision: ${formatForSpeech(summary)}`),
          evidenceIds: [event.eventId],
          supported: true,
          agentReported: false,
        });
        break;
      }
      case 'approval_requested': {
        const title = textField(payload, 'title') ?? textField(payload, 'detail');
        if (title === null) break;
        candidates.push({
          kind: 'decision',
          band: 3,
          chapter: 'decisions',
          text: sentence(`Approval requested: ${formatForSpeech(title)}`),
          evidenceIds: [event.eventId],
          supported: true,
          agentReported: false,
        });
        break;
      }
      case 'permission_changed': {
        const decision = textField(payload, 'decision') ?? 'recorded';
        const detail = textField(payload, 'detail') ?? 'the permission decision was recorded';
        candidates.push({
          kind: 'decision',
          band: 3,
          chapter: 'decisions',
          text: sentence(`Permission ${formatForSpeech(decision)}: ${formatForSpeech(detail)}`),
          evidenceIds: [event.eventId],
          supported: true,
          agentReported: false,
        });
        break;
      }
      case 'artifact_changed': {
        const path = textField(payload, 'path');
        const change = textField(payload, 'change') ?? 'changed';
        const text = path === null
          ? sentence(`The stream recorded a ${change} artifact`)
          : sentence(`${formatForSpeech(path)} was ${change}`);
        candidates.push({
          kind: 'change',
          band: 3,
          chapter: 'changes',
          text,
          evidenceIds: [event.eventId],
          supported: true,
          agentReported: false,
        });
        break;
      }
      case 'agent_message': {
        const text = textField(payload, 'text');
        if (text === null) break;
        unsupportedClaims += 1;
        candidates.push({
          kind: 'result',
          band: 0,
          chapter: 'details',
          text: sentence(formatForSpeech(text)),
          evidenceIds: [event.eventId],
          supported: false,
          agentReported: true,
        });
        break;
      }
      case 'unsupported': {
        if (event.unsupportedKind !== 'log_line') break;
        const line = textField(payload, 'line');
        if (line === null) break;
        const normalized = normalizeLine(line);
        if (normalized.length === 0) break;
        const occurrences = (lineOccurrences.get(normalized) ?? 0) + 1;
        lineOccurrences.set(normalized, occurrences);
        if (occurrences > 1) duplicateRedraws += 1;
        if (isRedrawLine(normalized)) {
          redrawLines.push(normalized);
          if (redrawClaim === null) {
            redrawClaim = {
              kind: 'progress',
              band: 2,
              chapter: 'progress',
              text: '',
              evidenceIds: [event.eventId],
              supported: true,
              agentReported: false,
            };
            candidates.push(redrawClaim);
          } else {
            redrawClaim.evidenceIds.push(event.eventId);
            duplicateClaims += 1;
          }
          break;
        }
        const existing = lineClaimIndex.get(normalized);
        if (existing !== undefined) {
          existing.evidenceIds.push(event.eventId);
          duplicateClaims += 1;
          break;
        }
        const rule = LINE_RULES[classifyLine(normalized)];
        const claim: Candidate = {
          kind: rule.kind,
          band: rule.band,
          chapter: rule.chapter,
          text: sentence(`${rule.prefix}${formatForSpeech(stripStreamTag(normalized))}`),
          evidenceIds: [event.eventId],
          supported: true,
          agentReported: false,
        };
        lineClaimIndex.set(normalized, claim);
        candidates.push(claim);
        break;
      }
      default:
        break;
    }
  }

  if (redrawClaim !== null) {
    redrawClaim.text = redrawText(redrawClaim.evidenceIds.length, redrawLines);
  }

  const claims = candidates.map((candidate, index) => ({
    id: `claim-${run.runId}-${String(index + 1).padStart(2, '0')}`,
    kind: candidate.kind,
    text: candidate.text,
    evidenceIds: [...candidate.evidenceIds],
    supported: candidate.supported,
    agentReported: candidate.agentReported,
    band: candidate.band,
    chapter: candidate.chapter,
  }));

  return { claims, suppressed: { duplicateRedraws, unsupportedClaims, duplicateClaims } };
}
