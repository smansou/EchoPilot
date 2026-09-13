/**
 * Transactional clipboard fallback for surfaces that reject an Accessibility write.
 *
 * The pasteboard is borrowed, never consumed: the previous contents are read once so they can be
 * put back, and they are restored only when the pasteboard change count still proves the user has
 * not replaced the clipboard in the meantime. If the user copied something new, the user's copy
 * wins and is left untouched.
 */
import type { CaptureBridge } from './types.js';

/** The only keystroke the fallback may synthesize: no Return, no Enter, no text entry. */
export const PASTE_KEYSTROKE = 'command+v';

export type ClipboardTransaction = Readonly<{
  previousText: string;
  changeCountAfterWrite: number;
  restored: boolean;
}>;

export async function pasteWithClipboardTransaction(
  bridge: Pick<CaptureBridge, 'clipboard' | 'sendKey'>,
  text: string,
): Promise<ClipboardTransaction> {
  const previousText = bridge.clipboard.readText();
  bridge.clipboard.writeText(text);
  const changeCountAfterWrite = bridge.clipboard.changeCount();
  let restored = false;
  try {
    await bridge.sendKey(PASTE_KEYSTROKE);
  } finally {
    if (bridge.clipboard.changeCount() === changeCountAfterWrite) {
      bridge.clipboard.writeText(previousText);
      restored = true;
    }
  }
  return { previousText, changeCountAfterWrite, restored };
}
