export const DEFAULT_PREVIEW_LIMIT = 200;

/**
 * `limit` caps the number of returned events. Bytes after the last returned event stay
 * uncommitted, so the next preview re-reads them from the committed cursor.
 */
export function normalizePreviewLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PREVIEW_LIMIT;
  return Math.max(0, Math.floor(limit));
}
