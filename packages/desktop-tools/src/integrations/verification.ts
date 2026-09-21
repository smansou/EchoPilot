/**
 * C03 structured-write verification. The extension API returning is not proof that the application
 * applied the write, so every write is judged against its read-back with the rule the capability
 * promises: `dom.set_value` must read back exactly the requested value, and `editor.insert_text`
 * must read back the preflight buffer with the text inserted at the caret (never a replacement and
 * never a submit). A read capability performs one structured read and has no read-back rule.
 */
import type { IntegrationCapability } from './types.js';

const READ_CAPABILITIES: ReadonlyArray<IntegrationCapability> = ['dom.read_controls', 'editor.read_state'];

/** Whether the capability only reads (and therefore has no post-action state). */
export function isReadCapability(capability: IntegrationCapability): boolean {
  return READ_CAPABILITIES.includes(capability);
}

/** The value the read-back must show for the write to count as verified. */
export function expectedValueAfterWrite(
  capability: IntegrationCapability,
  before: string,
  value: string,
): string {
  return capability === 'editor.insert_text' ? `${before}${value}` : value;
}

/** A write is verified only by a read-back that shows the expected value; `null` never verifies. */
export function writeVerified(
  capability: IntegrationCapability,
  before: string,
  value: string,
  after: string | null,
): boolean {
  return after !== null && after === expectedValueAfterWrite(capability, before, value);
}
