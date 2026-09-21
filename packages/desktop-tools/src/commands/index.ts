/**
 * S04 — a raw `run_command` tool call → scoped command request → isolated or explicit host
 * executor → observed outcome (IMPLEMENTATION_PLAN.md §7.2 S04; §5.9 "Default command execution
 * uses the coding harness's supported sandbox. For companion-owned generic commands, provide a
 * Linux VM executor using a managed VM backend with an explicitly mounted workspace and controlled
 * network policy. Native macOS host execution remains available with an explicit Host Autonomy
 * grant").
 *
 * `createCommandTool({ execution, scope })` is the seam between what the model asked for and the
 * executor that decides what it is allowed to run:
 *
 * - the surface offers an argv *array*, never a single shell-string `command`, and the only
 *   containment-shaped arguments are absent by construction: mounts, the network profile, host
 *   authority, and the scope are not call arguments, because they are what the executor derives
 *   from the grant. A call that tries to choose one is refused before anything is planned;
 * - validation is first and refuses inertly (`argv_required`, `invalid_tool_call`): the executor
 *   is never asked to propose or dispatch, nothing starts, and the refusal carries no request,
 *   proposal, label, exit code, output, or observation;
 * - a valid call becomes exactly one scoped `CommandRequest` whose `requestId` and
 *   `idempotencyKey` are derived from the call id, so a replayed call is the same request and can
 *   never address a different one;
 * - the tool holds no grant source: it asks the executor for the inert proposal — that is where
 *   the canonical mount, the controlled network profile, and the host authority come from — and
 *   dispatches the same request. The executor re-reads the grant immediately before execution and
 *   its verdict is what the tool reports, never upgraded: `denied`, `timed_out`, and `cancelled`
 *   are reported as such, `stopped: false` stays `stopped: false`, and the surviving children are
 *   carried through with their evidence. There is no cancel leg on this surface: a model call
 *   cannot silently turn into a stop of somebody else's run.
 *
 * The clock is the executor's: `observedAt` is copied from the outcome, so the tool adds no
 * timestamp of its own and a rejected call has nothing to date.
 */
import type { CommandRequest } from '../../../security/src/execution/types.js';
import { commandRequestBinding } from './binding.js';
import { callIdOf, utteranceOf, validateCommandArguments } from './guards.js';
import { COMMAND_TOOL_NAME, type CommandTool, type CommandToolDescription, type CommandToolOptions, type CommandToolResult } from './types.js';

export type {
  CommandContainment,
  CommandTool,
  CommandToolArgumentSchema,
  CommandToolDenialReason,
  CommandToolDescription,
  CommandToolInput,
  CommandToolOptions,
  CommandToolParameters,
  CommandToolResult,
} from './types.js';
export { COMMAND_TOOL_NAME } from './types.js';
export { callIdOf, utteranceOf, validateCommandArguments, type CommandArgumentVerdict, type ValidatedCommandArguments } from './guards.js';
export { canonicalJson, commandRequestBinding, sha256Hex, type CommandRequestBinding } from './binding.js';

/** The inert refusal every rejected call is reported as: nothing was proposed, started, or seen. */
function refusedResult(callId: string, reason: NonNullable<CommandToolResult['reason']>): CommandToolResult {
  return {
    callId,
    toolName: COMMAND_TOOL_NAME,
    state: 'denied',
    reason,
    requestId: null,
    proposalId: null,
    executionLabel: null,
    containment: null,
    exitCode: null,
    stdout: '',
    stderr: '',
    stopped: true,
    uncertainChildren: [],
    observedAt: null,
  };
}

export function commandToolDescription(): CommandToolDescription {
  return {
    name: COMMAND_TOOL_NAME,
    description:
      'Run one command through the companion executor. The command is an argv array, never a shell '
      + 'string. It runs in the isolated VM by default; native macOS host execution needs an '
      + 'explicit Host Autonomy grant. The workspace mount, the network profile, and the authority '
      + 'are derived from the grant by the executor and reported back with the observed outcome; '
      + 'they are not chosen here. A run that cannot be stopped is reported as uncertain rather '
      + 'than claimed stopped.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        executor: {
          type: 'string',
          enum: ['vm', 'host'],
          description: 'vm for the isolated managed VM; host for macOS-specific native execution '
            + 'under an execution.host_autonomy grant.',
        },
        argv: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'The program and its arguments as separate elements, e.g. ["/usr/bin/touch", "probe.txt"]. '
            + 'A shell string is not a representable call.',
        },
        workdir: {
          type: 'string',
          description: 'The working directory: the mounted workspace path for a VM call, the granted '
            + 'host directory for a host call.',
        },
        grantId: {
          type: 'string',
          description: 'The grant this command rides on. The executor re-reads it and refuses if it '
            + 'is unknown, revoked, or does not authorize this executor, network, or shell.',
        },
        networkAllow: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional hosts to narrow the granted network allowlist to. It can only '
            + 'narrow: a host outside the grant is refused as network_not_granted.',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          description: 'Optional wall-clock budget in milliseconds; a timeout stops the managed '
            + 'process group rather than leaving it running.',
        },
      },
      required: ['executor', 'argv', 'workdir', 'grantId'],
    },
  };
}

export function createCommandTool(options: CommandToolOptions): CommandTool {
  const { execution, scope } = options;
  return {
    describe: () => commandToolDescription(),

    async run(input) {
      const callId = callIdOf(input) ?? '';
      const verdict = validateCommandArguments(input);
      if (!verdict.ok) return refusedResult(callId, verdict.reason);

      const args = verdict.arguments;
      const { requestId, idempotencyKey } = await commandRequestBinding(callId, scope, args);
      const request: CommandRequest = {
        requestId,
        idempotencyKey,
        scope,
        utterance: utteranceOf(input),
        executor: args.executor,
        argv: [...args.argv],
        workdir: args.workdir,
        networkAllow: [...args.networkAllow],
        grantId: args.grantId,
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      };

      // The proposal is inert and is what the containment in the result comes from; dispatch is
      // the run itself. The executor's verdict is carried through verbatim.
      const proposal = await execution.propose(request);
      const outcome = await execution.dispatch(request);
      const reason = outcome.reason;
      return {
        callId,
        toolName: COMMAND_TOOL_NAME,
        state: outcome.state,
        requestId: outcome.requestId,
        proposalId: outcome.proposalId,
        executionLabel: outcome.executionLabel,
        containment: {
          mounts: [...proposal.mounts],
          network: proposal.network,
          hostAuthority: proposal.hostAuthority,
        },
        exitCode: outcome.exitCode,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        stopped: outcome.stopped,
        uncertainChildren: [...outcome.uncertainChildren],
        observedAt: outcome.observedAt,
        ...(reason === undefined ? {} : { reason }),
      };
    },
  };
}
