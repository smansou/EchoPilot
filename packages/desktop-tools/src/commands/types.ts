/**
 * S04 tool surface — the `run_command` tool the model is offered and what a call reports
 * (IMPLEMENTATION_PLAN.md §7.2 S04; §5.9).
 *
 * The surface is deliberately narrow: `executor`, `argv` (an array of strings, never one shell
 * string), `workdir`, `grantId`, and the optional `networkAllow` / `timeoutMs`. Mounts, the
 * network profile, the host authority, and the scope are *not* arguments — they are what the
 * executor's proposal derives from the grant, and the tool only surfaces them in its result.
 */
import type { Scope } from '../../../contracts/src/index.js';
import type {
  CommandExecution,
  ExecutionState,
  HostAuthority,
  Mount,
  NetworkProfile,
  UncertainChild,
} from '../../../security/src/execution/types.js';

/** The one tool name the frozen surface answers to. */
export const COMMAND_TOOL_NAME = 'run_command';

/** The only two reasons a tool *argument* is refused before the executor is ever asked. */
export type CommandToolDenialReason = 'argv_required' | 'invalid_tool_call';

export type CommandToolArgumentSchema = Readonly<{
  type: 'string' | 'array' | 'integer';
  description: string;
  enum?: readonly string[];
  items?: Readonly<{ type: 'string' }>;
  minItems?: number;
  minimum?: number;
}>;

export type CommandToolParameters = Readonly<{
  type: 'object';
  additionalProperties: false;
  properties: Readonly<{
    executor: CommandToolArgumentSchema;
    argv: CommandToolArgumentSchema;
    workdir: CommandToolArgumentSchema;
    grantId: CommandToolArgumentSchema;
    networkAllow: CommandToolArgumentSchema;
    timeoutMs: CommandToolArgumentSchema;
  }>;
  required: readonly string[];
}>;

export type CommandToolDescription = Readonly<{
  name: string;
  description: string;
  parameters: CommandToolParameters;
}>;

export type CommandToolInput = Readonly<{
  callId: string;
  utterance: string;
  toolCall: Readonly<{ name: string; arguments: unknown }>;
}>;

/** The proposal's containment, surfaced verbatim; `null` when the call never became a request. */
export type CommandContainment = Readonly<{
  mounts: readonly Mount[];
  network: NetworkProfile | null;
  hostAuthority: HostAuthority | null;
}>;

export type CommandToolResult = Readonly<{
  callId: string;
  toolName: string;
  state: ExecutionState;
  reason?: string;
  requestId: string | null;
  proposalId: string | null;
  executionLabel: string | null;
  containment: CommandContainment | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stopped: boolean;
  uncertainChildren: readonly UncertainChild[];
  observedAt: string | null;
}>;

export type CommandTool = Readonly<{
  describe(): CommandToolDescription;
  run(input: CommandToolInput): Promise<CommandToolResult>;
}>;

export type CommandToolOptions = Readonly<{
  /** The S04 executor port: propose is inert, dispatch runs, and the verdict is reported as-is. */
  execution: CommandExecution;
  /** The explicit project association: a tool call never chooses its own scope. */
  scope: Scope;
}>;
