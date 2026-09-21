/**
 * Widget-side desktop answer reader (C01).
 *
 * The C01 desktop service (`packages/desktop-tools/src/context/`) answers a "what is this?"
 * question in the widget conversation with the `DesktopAnswer` data below — no Mission Control
 * round trip is needed. The widget renders the capture/evidence indicator from exactly that data:
 * the capture state the service reached, the reason it stopped at limited context, and the evidence
 * ids that grounded the answer.
 *
 * The indicator never upgrades an answer: a `limited` answer is shown as limited (the answer text is
 * the service's deterministic sentence, which asserts no control state), an `excluded` answer is
 * shown as excluded, and a muted answer is shown as visible-only while keeping its text and
 * evidence. Nothing here adds a capture state the answer does not carry.
 */
import type {
  DesktopAnswer,
  DesktopCaptureReason,
  DesktopCaptureState,
} from '../../../../../packages/desktop-tools/src/context/index.js';

export type { DesktopAnswer, DesktopCaptureReason, DesktopCaptureState };

const CAPTURE_STATES: ReadonlySet<string> = new Set(['captured', 'limited', 'excluded']);
const CAPTURE_REASONS: ReadonlySet<string> = new Set([
  'accessibility_denied',
  'screen_recording_denied',
  'no_window',
  'empty_context',
]);

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`Invalid ${field} in desktop answer`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`Invalid ${field} in desktop answer`);
  }
  return value;
}

/** Strict reader for the route payload: a malformed answer is rejected, never partially rendered. */
export function parseDesktopAnswer(value: unknown): DesktopAnswer {
  const input = record(value, 'answer');
  const captureInput = record(input.capture, 'capture');
  const state = captureInput.state;
  if (typeof state !== 'string' || !CAPTURE_STATES.has(state)) {
    throw new TypeError('Invalid capture state in desktop answer');
  }
  const reason = captureInput.reason;
  if (reason !== undefined && (typeof reason !== 'string' || !CAPTURE_REASONS.has(reason))) {
    throw new TypeError('Invalid capture reason in desktop answer');
  }
  if (!Array.isArray(input.evidenceIds)) {
    throw new TypeError('Invalid evidenceIds in desktop answer');
  }
  const surface = input.surface;
  if (surface !== 'widget') throw new TypeError('Invalid surface in desktop answer');
  return {
    question: requiredString(input.question, 'question'),
    surface,
    text: requiredString(input.text, 'text'),
    evidenceIds: input.evidenceIds.map((entry, index) => requiredString(entry, `evidenceIds[${index}]`)),
    capture: {
      state: state as DesktopCaptureState,
      app: requiredString(captureInput.app, 'capture.app'),
      ...(reason === undefined ? {} : { reason: reason as DesktopCaptureReason }),
    },
    spoken: input.spoken === true,
  };
}

export const CAPTURE_STATE_LABELS: Readonly<Record<DesktopCaptureState, string>> = {
  captured: 'Captured foreground window',
  limited: 'Limited context',
  excluded: 'Excluded from capture',
};

export const CAPTURE_REASON_DETAILS: Readonly<Record<DesktopCaptureReason, string>> = {
  accessibility_denied: 'Accessibility access is missing, so the window could not be read.',
  screen_recording_denied: 'Screen Recording access is missing, so the window could not be seen.',
  no_window: 'No window was available to read.',
  empty_context: 'No Accessibility text, OCR text, or screenshot was available.',
};

export type CaptureIndicator = Readonly<{
  state: DesktopCaptureState;
  app: string;
  label: string;
  detail: string | null;
}>;

/** The capture half of the indicator: what was captured and, for a limited answer, why it stopped. */
export function captureIndicator(answer: DesktopAnswer): CaptureIndicator {
  const reason = answer.capture.reason;
  return {
    state: answer.capture.state,
    app: answer.capture.app,
    label: CAPTURE_STATE_LABELS[answer.capture.state],
    detail: reason === undefined ? null : CAPTURE_REASON_DETAILS[reason],
  };
}

export type EvidenceIndicator = Readonly<{
  count: number;
  label: string;
  ids: ReadonlyArray<string>;
}>;

/** The evidence half of the indicator: the ids behind the answer, never a count the answer cannot back. */
export function evidenceIndicator(answer: DesktopAnswer): EvidenceIndicator {
  const ids = [...answer.evidenceIds];
  const label = ids.length === 0
    ? 'No evidence cited'
    : `${ids.length} ${ids.length === 1 ? 'evidence item' : 'evidence items'}`;
  return { count: ids.length, label, ids };
}

export type SpeechIndicator = Readonly<{ spoken: boolean; label: string }>;

export function speechIndicator(answer: DesktopAnswer): SpeechIndicator {
  return answer.spoken
    ? { spoken: true, label: 'Spoken' }
    : { spoken: false, label: 'Shown, not spoken' };
}
