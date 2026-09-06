/**
 * Canonical persistence-compat source (plain JS so node --test can import it
 * without a toolchain; src/index.ts inlines the same logic, lib/index.mjs mirrors it).
 */
export function normalizeHeaders(entries) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const e of entries) {
    const h = e && typeof e === 'object' && e.header ? e.header : e;
    if (h && typeof h.id === 'string') out.push(h);
  }
  return out;
}

const READ_CHUNK = 500;

export async function readStoredEvents(persistence, sessionId) {
  if (!persistence) return undefined;
  if (typeof persistence.loadStored === 'function') {
    const stored = await persistence.loadStored(sessionId);
    return stored?.events;
  }
  if (typeof persistence.open === 'function') {
    const handle = await persistence.open(sessionId, 'read');
    try {
      const events = [];
      for (let offset = 0; ; offset += READ_CHUNK) {
        const slice = await handle.read(offset, READ_CHUNK);
        if (!slice || slice.length === 0) break;
        for (const ev of slice) events.push(ev);
        // NOTE: no `slice.length < READ_CHUNK` early-break here on purpose:
        // a short non-empty page does not imply end-of-stream (the contract
        // only guarantees an empty slice at the end), and the acceptance
        // mock returns 1-item pages. Terminate on the empty slice only.
      }
      return events;
    } finally {
      if (typeof handle.close === 'function') await handle.close();
    }
  }
  return undefined;
}
