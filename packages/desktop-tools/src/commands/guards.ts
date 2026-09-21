/**
 * S04 tool-call validation. Validation happens before anything is planned: a refused call has
 * never reached `propose` or `dispatch`, so it cannot start a process, and it is reported with
 * `requestId: null` and `observedAt: null` because nothing was ever requested or observed.
 *
 * Two refusals are distinguished on purpose:
 *
 * - `argv_required` — `argv` is missing, not an array, empty, or holds a non-string element. A
 *   single-string `command` is a shell string and there is no representable way here to ask for
 *   one, so a call that looks like a shell string is told what it is missing. This check runs
 *   before unknown-argument detection, so `{ command: 'touch x' }` is refused as a shell string
 *   rather than merely as an unexpected key.
 * - `invalid_tool_call` — the wrong tool name, arguments that are not an object, an argument the
 *   caller may not choose (`mounts`, `network`, `hostAuthority`, `scope`, `requestId`, …), or a
 *   malformed required field (an executor other than `vm`|`host`, an empty workdir or grantId, a
 *   non-positive timeoutMs, a networkAllow that is not an array of strings).
 */
import type { ExecutionExecutor } from '../../../security/src/execution/types.js';
import { COMMAND_TOOL_NAME, type CommandToolDenialReason } from './types.js';

/** The validated arguments of one accepted call; every field rides into the command request. */
export type ValidatedCommandArguments = Readonly<{
  executor: ExecutionExecutor;
  argv: readonly string[];
  workdir: string;
  networkAllow: readonly string[];
  grantId: string;
  timeoutMs?: number;
}>;

export type CommandArgumentVerdict =
  | Readonly<{ ok: true; arguments: ValidatedCommandArguments }>
  | Readonly<{ ok: false; reason: CommandToolDenialReason }>;

const INVALID: Readonly<{ ok: false; reason: 'invalid_tool_call' }> = { ok: false, reason: 'invalid_tool_call' };
const ARGV_REQUIRED: Readonly<{ ok: false; reason: 'argv_required' }> = { ok: false, reason: 'argv_required' };

/** The only argument names the model may send; everything else is a containment claim. */
const ALLOWED_ARGUMENTS: ReadonlySet<string> = new Set([
  'executor',
  'argv',
  'workdir',
  'grantId',
  'networkAllow',
  'timeoutMs',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** The call id a refusal is reported under; `null` when the call carries no usable id. */
export function callIdOf(input: unknown): string | null {
  const callId = isPlainObject(input) ? input.callId : undefined;
  return typeof callId === 'string' ? callId : null;
}

/** The invoking request text rides through verbatim; a missing utterance is an empty one. */
export function utteranceOf(input: unknown): string {
  const utterance = isPlainObject(input) ? input.utterance : undefined;
  return typeof utterance === 'string' ? utterance : '';
}

export function validateCommandArguments(input: unknown): CommandArgumentVerdict {
  if (!isPlainObject(input)) return INVALID;
  const toolCall = input.toolCall;
  if (!isPlainObject(toolCall) || toolCall.name !== COMMAND_TOOL_NAME) return INVALID;
  const args = toolCall.arguments;
  if (!isPlainObject(args)) return INVALID;

  // `argv` first: a call that offered a shell string is told it needs an argv array, whatever
  // else it carried.
  const argv = args.argv;
  if (!isStringArray(argv) || argv.length === 0) return ARGV_REQUIRED;
  for (const key of Object.keys(args)) if (!ALLOWED_ARGUMENTS.has(key)) return INVALID;

  if (!isNonEmptyText(input.callId)) return INVALID;
  const executor = args.executor;
  if (executor !== 'vm' && executor !== 'host') return INVALID;
  if (!isNonEmptyText(args.workdir)) return INVALID;
  if (!isNonEmptyText(args.grantId)) return INVALID;

  const networkAllow = args.networkAllow;
  if (networkAllow !== undefined && !isStringArray(networkAllow)) return INVALID;
  const timeoutMs = args.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    return INVALID;
  }

  return {
    ok: true,
    arguments: {
      executor,
      argv: [...argv],
      workdir: args.workdir,
      networkAllow: networkAllow === undefined ? [] : [...networkAllow],
      grantId: args.grantId,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
  };
}
