/**
 * Canonical jump-loader source (plain JS so node can import it without a
 * toolchain; src/client/index.ts and lib/client.js inline the same logic).
 *
 * Root cause it addresses: the conversation list is virtualized — it only
 * renders the loaded event window. When the target message's seq is outside
 * that window, its [data-chat-anchor-key] element never renders and a pure
 * anchor-polling jump fails. The official UI solves this with
 * SessionFace.loadThrough(seq) ("page backwards until the window covers
 * seq"); this helper drives the same loader from a plugin client context.
 */
export function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('jump loader timeout')), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).then(
    (value) => { clearTimeout(timer); return value; },
    (err) => { clearTimeout(timer); throw err; }
  );
}

const SCOPE_ATTEMPTS = 4;
const SCOPE_RETRY_MS = 300;

export async function ensureWindowCovers(sessions, sessionId, seq, options = {}) {
  const {
    timeoutMs = 15000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;
  if (!sessions || typeof sessions.scope !== 'function') return false;
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    let face;
    try {
      const scoped = sessions.scope(sessionId);
      face = scoped && typeof sessions.sessionOf === 'function' ? sessions.sessionOf(scoped) : undefined;
    } catch { face = undefined; }
    if (face && typeof face.loadThrough === 'function') {
      try {
        await withTimeout(face.loadThrough(seq), Math.max(1, deadline - Date.now()));
        return true;
      } catch { return false; }
    }
    if (attempt >= SCOPE_ATTEMPTS || Date.now() >= deadline) return false;
    try { await sleep(SCOPE_RETRY_MS); } catch { return false; }
  }
}
