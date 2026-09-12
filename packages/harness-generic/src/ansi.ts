/**
 * Terminal-output normalization for imported display text.
 *
 * ANSI CSI/OSC sequences are stripped, a lone '\r' rewrites the line in place (so repeated progress
 * redraws collapse to the final frame), backspace moves the write head, and remaining C0 control
 * bytes are dropped. The result is display-only text: it is never interpreted.
 */

const ESC = 0x1b;
const BEL = 0x07;
const BACKSLASH = 0x5c;

export function normalizeDisplayText(raw: string): string {
  const out: string[] = [];
  let head = 0;
  let index = 0;

  while (index < raw.length) {
    const code = raw.charCodeAt(index);
    if (code === ESC) {
      index = skipEscape(raw, index);
      continue;
    }
    if (code === 0x0d) {
      head = 0;
      index += 1;
      continue;
    }
    if (code === 0x08) {
      head = Math.max(0, head - 1);
      index += 1;
      continue;
    }
    if (code < 0x20 && code !== 0x0a && code !== 0x09) {
      index += 1;
      continue;
    }
    out[head] = raw[index] as string;
    head += 1;
    index += 1;
  }

  return out.join('');
}

/** Returns the index just past the escape sequence that starts at `index`. */
function skipEscape(raw: string, index: number): number {
  let cursor = index + 1;
  if (cursor >= raw.length) return cursor;
  const kind = raw.charCodeAt(cursor);

  if (kind === 0x5b) {
    // CSI: ESC '[' <params/intermediates> <final 0x40-0x7e>
    cursor += 1;
    while (cursor < raw.length) {
      const code = raw.charCodeAt(cursor);
      cursor += 1;
      if (code >= 0x40 && code <= 0x7e) break;
    }
    return cursor;
  }

  if (kind === 0x5d) {
    // OSC: ESC ']' ... BEL  or  ESC ']' ... ST (ESC '\')
    cursor += 1;
    while (cursor < raw.length) {
      const code = raw.charCodeAt(cursor);
      if (code === BEL) {
        cursor += 1;
        break;
      }
      if (code === ESC && raw.charCodeAt(cursor + 1) === BACKSLASH) {
        cursor += 2;
        break;
      }
      cursor += 1;
    }
    return cursor;
  }

  // Two-byte escape (e.g. ESC '7'): the escape and its single selector are dropped.
  return cursor + 1;
}
