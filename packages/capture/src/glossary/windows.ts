/**
 * A03 rolling-window commit — how overlapping ASR windows become one committed transcript.
 *
 * Each window is checked against the §4.4 budget before anything is believed about it:
 *
 *   - a window longer than `windowMs` (and `windowMs` may never exceed `MAX_DICTATION_WINDOW_MS`)
 *     is reported as `audio_window_exceeded`;
 *   - a window overlapping the previous committed window by more than `overlapMs` (never more than
 *     `MAX_DICTATION_OVERLAP_MS`) is reported as `audio_overlap_exceeded`, which is what catches a
 *     window that was already heard — an exact re-send, a transcript that repeats, or overlapping
 *     audio the recorder was not supposed to produce.
 *
 * A reported window is never truncated and never committed: it appears in `rejected` with the
 * reason a user can act on, and the committed text is exactly what the accepted windows said.
 * Accepted windows are concatenated by dropping the longest prefix of the window that is already
 * the suffix of everything committed so far, so the rolling overlap is heard once, not twice.
 */
import {
  MAX_DICTATION_OVERLAP_MS,
  MAX_DICTATION_WINDOW_MS,
  type DictationCommitResult,
  type CommittedDictationWindow,
  type DictationRejectionReason,
  type RejectedDictationWindow,
} from './model.js';
import { wordSpans } from './correction.js';

export interface DictationWindow {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface CommitDictationWindowsInput {
  readonly windows: readonly DictationWindow[];
  readonly windowMs: number;
  readonly overlapMs: number;
}

function requireBudgetMs(value: unknown, max: number, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`commitDictationWindows requires a finite, non-negative ${what}`);
  }
  if (value > max) {
    throw new RangeError(`commitDictationWindows refuses ${what} ${value}: the frozen budget allows at most ${max} ms`);
  }
  return value;
}

function requireWindow(candidate: unknown, index: number): DictationWindow {
  const window = candidate as Partial<DictationWindow> | null | undefined;
  const startMs = window?.startMs;
  const endMs = window?.endMs;
  if (typeof startMs !== 'number' || !Number.isFinite(startMs) || startMs < 0) {
    throw new TypeError(`commitDictationWindows requires window ${index} to declare a finite startMs`);
  }
  if (typeof endMs !== 'number' || !Number.isFinite(endMs) || endMs < startMs) {
    throw new TypeError(`commitDictationWindows requires window ${index} to declare an endMs at or after its startMs`);
  }
  if (typeof window?.text !== 'string') {
    throw new TypeError(`commitDictationWindows requires window ${index} to carry the transcribed text`);
  }
  return { startMs, endMs, text: window.text };
}

/**
 * The longest prefix of `words` that is already the suffix of `committed`: the exact number of
 * words the overlap duplicated, measured on the text rather than estimated from the timestamps.
 */
function overlapWordCount(committed: readonly string[], words: readonly string[]): number {
  const most = Math.min(committed.length, words.length);
  for (let count = most; count > 0; count -= 1) {
    let matches = true;
    for (let offset = 0; offset < count; offset += 1) {
      if (committed[committed.length - count + offset] !== words[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return count;
  }
  return 0;
}

export function commitDictationWindows(input: CommitDictationWindowsInput): DictationCommitResult {
  const candidate = input as Partial<CommitDictationWindowsInput> | null | undefined;
  if (!Array.isArray(candidate?.windows)) {
    throw new TypeError('commitDictationWindows requires { windows, windowMs, overlapMs }');
  }
  const windowMs = requireBudgetMs(candidate.windowMs, MAX_DICTATION_WINDOW_MS, 'windowMs');
  if (windowMs === 0) throw new RangeError('commitDictationWindows requires a positive windowMs');
  const overlapMs = requireBudgetMs(candidate.overlapMs, MAX_DICTATION_OVERLAP_MS, 'overlapMs');

  const committed: CommittedDictationWindow[] = [];
  const rejected: RejectedDictationWindow[] = [];
  const words: string[] = [];
  let previousEndMs: number | null = null;

  candidate.windows.forEach((raw, index) => {
    const window = requireWindow(raw, index);
    const reject = (reason: DictationRejectionReason): void => {
      rejected.push({ index, startMs: window.startMs, endMs: window.endMs, reason });
    };
    if (window.endMs - window.startMs > windowMs) {
      reject('audio_window_exceeded');
      return;
    }
    const overlap = previousEndMs === null ? 0 : Math.max(0, previousEndMs - window.startMs);
    if (overlap > overlapMs) {
      reject('audio_overlap_exceeded');
      return;
    }

    const windowWords = wordSpans(window.text).map((span) => span.text);
    words.push(...windowWords.slice(overlapWordCount(words, windowWords)));
    committed.push({
      index,
      startMs: window.startMs,
      endMs: window.endMs,
      text: windowWords.join(' '),
      overlapMs: overlap,
    });
    previousEndMs = window.endMs;
  });

  return { committed, rejected, text: words.join(' ') };
}
