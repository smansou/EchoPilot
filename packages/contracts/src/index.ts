/** The narrow, version-one renderer boundary. No arbitrary channel or tool execution. */
export type Command =
  | { type: 'get-state' }
  | { type: 'set-muted'; muted: boolean }
  | { type: 'replay' }
  | { type: 'open-dashboard' };

export type FixtureEvent = {
  id: string;
  sessionId: string;
  text: string;
  createdAt: string;
};

export type State = { muted: boolean; event: FixtureEvent | null };

export const IPC_CHANNEL = 'echo:command';
export const STATE_CHANNEL = 'echo:state';

export interface CompanionAPI {
  command(command: Command): Promise<State>;
  onState(listener: (state: State) => void): () => void;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected an object');
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError('Unexpected property');
  }
}

function string(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > limit) {
    throw new TypeError(`Invalid ${field}`);
  }
  return value;
}

export function parseCommand(value: unknown): Command {
  const input = object(value);
  switch (input.type) {
    case 'get-state':
    case 'replay':
    case 'open-dashboard':
      keys(input, ['type']);
      return { type: input.type };
    case 'set-muted':
      keys(input, ['type', 'muted']);
      if (typeof input.muted !== 'boolean') throw new TypeError('Invalid muted flag');
      return { type: input.type, muted: input.muted };
    default:
      throw new TypeError('Unsupported command');
  }
}

export function parseFixtureEvent(value: unknown): FixtureEvent {
  const input = object(value);
  keys(input, ['id', 'sessionId', 'text', 'createdAt']);
  const createdAt = string(input.createdAt, 'createdAt', 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt)
    || !Number.isFinite(Date.parse(createdAt))
    || new Date(createdAt).toISOString() !== createdAt) {
    throw new TypeError('Expected a valid UTC ISO timestamp');
  }
  return {
    id: string(input.id, 'id', 128),
    sessionId: string(input.sessionId, 'sessionId', 128),
    text: string(input.text, 'text', 8_192),
    createdAt,
  };
}

export function parseState(value: unknown): State {
  const input = object(value);
  keys(input, ['muted', 'event']);
  if (typeof input.muted !== 'boolean') throw new TypeError('Invalid muted flag');
  return { muted: input.muted, event: input.event === null ? null : parseFixtureEvent(input.event) };
}
