//#region src/index.ts
import { realpath, mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
const name = "dsh-session-browser";
const inject = ["webServer", "sessionPersistence", "workspaceRegistry", "sessions", "agents"];
const MAX_BODY_BYTES = 1 << 20;

const TRASH_MAX = 200

/** Resolved lazily so tests can override before first use. */
let trashPathOverride

function trashPath() {
  if (trashPathOverride !== undefined) return trashPathOverride
  return join(homedir(), '.dsh', 'dsh-session-browser-trash.json')
}

/** Test seam: point the store at a temp file (or `undefined` to restore default). */
function __setTrashPath(path) {
	trashPathOverride = path;
}

/** Drop entries whose id already appears, keeping the newest `list` order. */
function normalizeEntries(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const e = item;
    const sessionId = typeof e.sessionId === 'string' ? e.sessionId.trim() : '';
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    out.push({
      sessionId,
      archived: e.archived === true,
      workspaceIds: Array.isArray(e.workspaceIds) ? e.workspaceIds.filter((x) => typeof x === 'string') : [],
      cwd: typeof e.cwd === 'string' ? e.cwd : '',
      createdAt: typeof e.createdAt === 'number' ? e.createdAt : 0,
      updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0,
      deletedAt: typeof e.deletedAt === 'number' ? e.deletedAt : 0,
    })
  }
  return out.slice(0, TRASH_MAX)
}

/** Read the whole trash. A missing or corrupt file reads as empty, never throws. */
async function readTrash() {
  try {
    const text = await readFile(trashPath(), 'utf8')
    return normalizeEntries(JSON.parse(text))
  } catch {
    return []
  }
}

/**
 * Persist the whole trash. Write-then-rename so a crash mid-write cannot leave
 * a truncated file that would silently drop every record.
 */
async function writeTrash(entries) {
  const path = trashPath()
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(normalizeEntries(entries), null, 2), 'utf8')
  try {
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => { /* best-effort */ })
    throw err
  }
}

/** Upsert one record, newest delete first, capped at TRASH_MAX. */
async function recordTrash(entry) {
  const rest = (await readTrash()).filter(e => e.sessionId !== entry.sessionId)
  await writeTrash([entry, ...rest])
}

/** Remove one record. Returns whether it was present. */
async function dropTrash(sessionId) {
  const all = await readTrash()
  const next = all.filter(e => e.sessionId !== sessionId)
  if (next.length === all.length) return false
  await writeTrash(next)
  return true
}
async function readJsonBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES) throw new Error("request body too large");
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.trim() === "") return {};
	try { return JSON.parse(text); } catch { throw new Error("malformed JSON body"); }
}
function writeJson(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-cache"
	});
	res.end(text);
}
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
function isTrustedApiRequest(req) {
	const host = req.headers.host;
	if (host === void 0) return false;
	let hostUrl;
	try { hostUrl = new URL(`http://${host}`); } catch { return false; }
	if (!isLoopbackHostname(hostUrl.hostname)) return false;
	const fetchSite = req.headers["sec-fetch-site"];
	if (typeof fetchSite === "string" && fetchSite === "cross-site") return false;
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	try { return new URL(origin).host === hostUrl.host; } catch { return false; }
}
function shortPath(cwd) {
	if (!cwd) return "";
	const parts = cwd.replace(/[\\\/]+$/, "").split(/[\\\/]/);
	const last = parts[parts.length - 1] || "";
	return last.length > 26 ? last.slice(0, 24) + "\u2026" : last;
}
// Canonical source: src/persistence-compat.mjs
function normalizeHeaders(entries) {
	if (!Array.isArray(entries)) return [];
	const out = [];
	for (const e of entries) {
		const h = e && typeof e === "object" && e.header ? e.header : e;
		if (h && typeof h.id === "string") out.push(h);
	}
	return out;
}
const READ_CHUNK = 500;

/**
 * Title cache. Key = `${sessionId}@${updatedAt}` so any append (or a
 * `session/title` rename, which bumps updatedAt) invalidates it automatically —
 * no manual invalidation path, and two page tabs sharing a session hit the cache.
 */
const titleCache = new Map();
const TITLE_CACHE_MAX = 512;

/** Concurrency cap for persistence opens; IO-bound, so a small window suffices. */
const TITLE_READ_CONCURRENCY = 8;

async function readStoredEvents(persistence, sessionId) {
	if (!persistence) return void 0;
	// DSH >= 0.1.5: SessionHandle.read() returns { eventState, events } (SessionHandleReadResult).
	if (typeof persistence.open === "function") {
		const handle = await persistence.open(sessionId, "read");
		try {
			const events = [];
			for (let offset = 0; ; offset += READ_CHUNK) {
				const result = await handle.read(offset, READ_CHUNK);
				const slice = Array.isArray(result) ? result : result?.events;
				if (!slice || slice.length === 0) break;
				for (const ev of slice) events.push(ev);
			}
			return events;
		} finally {
			if (typeof handle.close === "function") await handle.close();
		}
	}
	return void 0;
}

/**
 * Read a session's events, stopping as soon as `pick` returns a value.
 * Titles live at the head of the log (a `session/title` rename or the first user
 * message), so a long conversation no longer costs a full multi-chunk read.
 * Falls back to reading everything when the head does not yield a title.
 */
async function readEventsUntil(persistence, sessionId, pick) {
	if (!persistence || typeof persistence.open !== "function") return void 0;
	const handle = await persistence.open(sessionId, "read");
	try {
		const events = [];
		for (let offset = 0; ; offset += READ_CHUNK) {
			const result = await handle.read(offset, READ_CHUNK);
			const slice = Array.isArray(result) ? result : result?.events;
			if (!slice || slice.length === 0) break;
			for (const ev of slice) events.push(ev);
			const hit = pick(events);
			if (hit !== void 0) return events;
		}
		return events;
	} finally {
		if (typeof handle.close === "function") await handle.close();
	}
}

/** Extract a display title from loaded events: renamed title, else first user message. */
function titleFromEvents(events) {
	for (const event of events) {
		if (event.type === "session/title") {
			const t = event.data?.title || event.data || "";
			if (typeof t === "string" && t.trim()) {
				return t.trim().length > 40 ? t.trim().slice(0, 40) + "…" : t.trim();
			}
		}
	}
	for (const event of events) {
		if (event.type === "user/message" && event.surfaceOp === "append") {
			const data = event.data || {};
			const content = typeof data.content === "string"
				? data.content
				: Array.isArray(data.content)
					? data.content.map((c) => c.text || "").join("")
					: "";
			if (content.trim()) {
				return content.trim().length > 40 ? content.trim().slice(0, 40) + "…" : content.trim();
			}
		}
	}
	return void 0;
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function mapWithConcurrency(items, limit, worker) {
	const out = new Array(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const index = next++;
			if (index >= items.length) return;
			out[index] = await worker(items[index], index);
		}
	});
	await Promise.all(runners);
	return out;
}

function readArchivedIds(ctx) {
	const registry = ctx.get("workspaceRegistry");
	try {
		if (registry === void 0 || typeof registry.requireState !== "function") return new Set();
		const ids = registry.requireState()?.archivedSessionIds;
		if (!Array.isArray(ids)) return new Set();
		return new Set(ids.filter((id) => typeof id === "string"));
	} catch { return new Set(); }
}
/**
 * Host capability marker.
 *
 * lib/index.mjs is imported by the DSH MAIN process at startup, so editing it
 * has NO effect until DSH fully restarts. The symptom is not an error — the
 * client just gets answers from an older host (e.g. `ungrouped` silently ignored,
 * so two tabs render identical lists), which is indistinguishable from a real bug.
 * The client compares this against what it expects and prompts for a restart.
 */
const HOST_API = { trash: 1, ungrouped: 1 };

async function listSessions(ctx, payload) {
	const persistence = ctx.get("sessionPersistence");
	if (persistence === void 0) return { ok: false, error: "sessionPersistence \u670D\u52A1\u4E0D\u53EF\u7528" };
	try {
		const ungroupedOnly = payload?.ungrouped === true;
		const archivedOnly = payload?.archived === true;
		const archivedIds = readArchivedIds(ctx);
		const allHeaders = normalizeHeaders(await persistence.list());
		// DSH 的 WorkspaceEntity.get sessionIds()（entity.ts:102）会用
		// `host.sessionPath(id) === record.path` 再过滤一遍，而 sessionPaths 的 key
		// 是 header.id（裸 UUID）。实测记账里 id 格式并不统一——同一个工作区的 81 条
		// 里有 19 条带 `session-` 前缀，这些查不到路径，会被 getter 整条丢弃。
		// 插件若直接用 getter，未分组页就会把"明明有工作区归属"的会话错算成无归属。
		// 故改读原始 record.sessionIds，并对前缀做双向兼容。
		const registry = ctx.get("workspaceRegistry");
		const groupedIds = new Set();
		const addId = (raw) => {
			if (typeof raw !== "string" || raw === "") return;
			groupedIds.add(raw);
			if (raw.startsWith("session-")) groupedIds.add(raw.slice("session-".length));
		};
		if (registry !== void 0 && typeof registry.list === "function") {
			for (const entity of registry.list()) {
				// 取并集而非二选一：record 是原始记账（含前缀形式），sessionIds 是被
				// cwd 过滤过的视图。并集保证无论 record 是否可访问，都不会比原来更少。
				const raw = entity?.record?.sessionIds;
				if (Array.isArray(raw)) for (const id of raw) addId(id);
				const viaGetter = entity?.sessionIds;
				if (Array.isArray(viaGetter)) for (const id of viaGetter) addId(id);
			}
		}
		const headers = allHeaders.filter((h) => {
			if (h.origin === "subagent") return false;
			if (ungroupedOnly) { if (groupedIds.has(h.id)) return false; }
			else if (!groupedIds.has(h.id)) return false;
			// 归档分流：已归档页只取交集，未归档页排除已归档 id
			if (archivedOnly) { if (!archivedIds.has(h.id)) return false; }
			else if (archivedIds.has(h.id)) return false;
			return true;
		});
		// Derive title from session/title event or first user message.
		// Parallel with a bounded window, cache-keyed on (id, updatedAt): a page-tab
		// switch used to re-read every conversation's full event log serially, which
		// is where the visible stall came from.
		const items = await mapWithConcurrency(headers, TITLE_READ_CONCURRENCY, async (h) => {
			const key = `${h.id}@${h.updatedAt ?? h.createdAt ?? ""}`;
			let title = titleCache.get(key);
			if (title === undefined) {
				title = "";
				try {
					const events = await readEventsUntil(persistence, h.id, titleFromEvents);
					title = (events ? titleFromEvents(events) : undefined) || "";
				} catch { /* ignore */ }
				if (titleCache.size >= TITLE_CACHE_MAX) {
					const oldest = titleCache.keys().next();
					if (!oldest.done) titleCache.delete(oldest.value);
				}
				titleCache.set(key, title);
			}
			return {
				sessionId: h.id,
				title: title || shortPath(h.cwd) || "未命名",
				cwd: h.cwd || "",
				createdAt: h.createdAt,
				updatedAt: h.updatedAt || h.createdAt,
				archived: archivedIds.has(h.id)
			};
		});
		items.sort((a, b) => b.createdAt - a.createdAt);
		return { ok: true, items, hostApi: HOST_API };
	} catch (err) {
		return { ok: false, error: String(err instanceof Error ? err.message : err) };
	}
}
async function listRounds(ctx, payload) {
	const sessionId = payload?.sessionId;
	if (typeof sessionId !== "string" || sessionId === "") return { ok: false, error: "\u7F3A\u5C11 sessionId" };
	const persistence = ctx.get("sessionPersistence");
	if (persistence === void 0) return { ok: false, error: "sessionPersistence \u670D\u52A1\u4E0D\u53EF\u7528" };
	try {
		const events = await readStoredEvents(persistence, sessionId);
		if (!events) return { ok: false, error: "\u4F1A\u8BDD\u4E0D\u5B58\u5728\u6216\u65E0\u4E8B\u4EF6\u6570\u636E" };
		const rounds = [];
		let turnIndex = 0;
		for (const event of events) {
			if (event.type !== "user/message") continue;
			// source.kind === "user" means truly user-typed; "plugin"/"system" are injected context
			const source = event.data?.source;
			if (source && source.kind !== "user") continue;
			const data = event.data || {};
			const content = typeof data.content === "string" ? data.content : Array.isArray(data.content) ? data.content.map((c) => c.text || "").join("") : JSON.stringify(data.content || "");
			rounds.push({
				seq: event.seq,
				eventId: data.id ?? event.seq,
				messageId: typeof data.id === "string" ? data.id : void 0,
				anchorKey: typeof data.id === "string" ? `13:input-message${data.id}` : void 0,
				content: content.length > 200 ? content.slice(0, 200) + "\u2026" : content,
				time: event.time,
				turnIndex: turnIndex++
			});
		}
		return { ok: true, items: rounds };
	} catch (err) {
		return { ok: false, error: String(err instanceof Error ? err.message : err) };
	}
}
async function archiveSession(ctx, sessionId) {
	const registry = ctx.get("workspaceRegistry");
	if (registry === void 0 || typeof registry.archiveSession !== "function") throw new Error("workspaceRegistry 服务不可用");
	await registry.archiveSession(sessionId);
}
async function unarchiveSession(ctx, sessionId) {
	const registry = ctx.get("workspaceRegistry");
	if (registry === void 0 || typeof registry.unarchiveSession !== "function") throw new Error("workspaceRegistry 服务不可用");
	await registry.unarchiveSession(sessionId);
}
async function detachFromWorkspaces(ctx, sessionId) {
	const registry = ctx.get("workspaceRegistry");
	if (registry === void 0 || typeof registry.list !== "function") throw new Error("workspaceRegistry 服务不可用");
	for (const entity of registry.list()) {
		const ids = typeof entity.sessionIds === "function" ? entity.sessionIds() : entity.sessionIds;
		if (Array.isArray(ids) && ids.includes(sessionId)) {
			await entity.detachSession(sessionId);
		}
	}
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function deleteSession(ctx, sessionId) {
  const liveSessions = ctx.get('sessions')
  const liveAgents = ctx.get('agents')
  const session = liveSessions?.get?.(sessionId)
  const agent = liveAgents?.get?.(sessionId)
  const wasLive = session != null || agent != null

  // Capture what the cleanup below is about to erase, so restore can put it back.
  // Read BEFORE detaching: after this, both facts are gone for good.
  let trash = null
  try {
    const registry = ctx.get('workspaceRegistry')
    const workspaceIds = []
    let cwd = ''
    let createdAt = 0
    let updatedAt = 0
    if (registry !== undefined && typeof registry.list === 'function') {
      for (const entity of registry.list()) {
        const ids = typeof entity.sessionIds === 'function' ? entity.sessionIds() : entity.sessionIds
        if (Array.isArray(ids) && ids.includes(sessionId) && typeof entity.id === 'string') {
          workspaceIds.push(entity.id)
        }
      }
    }
    const persistence = ctx.get('sessionPersistence')
    if (typeof persistence?.stat === 'function') {
      const header = await persistence.stat(sessionId)
      if (header && typeof header === 'object') {
        cwd = typeof header.cwd === 'string' ? header.cwd : ''
        createdAt = typeof header.createdAt === 'number' ? header.createdAt : 0
        updatedAt = typeof header.updatedAt === 'number' ? header.updatedAt : 0
      }
    }
    trash = {
      sessionId,
      archived: readArchivedIds(ctx).has(sessionId),
      workspaceIds,
      cwd,
      createdAt,
      updatedAt,
      deletedAt: Date.now(),
    }
  } catch { /* best-effort: a missing record only costs a less precise restore */ }

  if (agent != null) {
    // Stop any running turn (disposed-kind suppresses re-wake).
    try {
      agent.cancel({ kind: 'disposed' })
    } catch { /* best-effort */ }
    // Quiesce the agent's own fiber.
    // NOTE: whenIdle() is an Agent INSTANCE method (dsh-agent runtime-types);
    // it is NOT a method of the `agents` service. The old `liveAgents.whenIdle`
    // guard therefore never passed and this quiesce silently never ran.
    try {
      if (typeof agent.whenIdle === 'function') await agent.whenIdle()
    } catch { /* best-effort */ }
  }

  let detached = false
  if (session != null) {
    // Flush buffered events to disk first so the retirement drain is a no-op.
    try {
      await liveSessions.flush(session)
    } catch { /* best-effort */ }
    // Detach the session store entry: emits session/disposed, which the
    // persistence write-path answers with a final drain, and the API proxy
    // relays as host/session-removed so every connected client drops the row.
    try {
      const entry = liveSessions.store?.get?.(sessionId)
      if (entry !== undefined && typeof entry.detach === 'function') {
        entry.detach()
        await sleep(200) // let the write-behind retirement settle
        detached = true
      }
    } catch { /* best-effort */ }
  }
  // Sessions with no live store row never fire entry.detach() — emit
  // session/disposed explicitly so every connected client drops the row.
  if (!detached) {
    try {
      if (typeof ctx.emit === 'function') ctx.emit('session/disposed', { id: sessionId })
    } catch { /* best-effort */ }
  }

  // Workspace accounting + archive-set membership.
  await detachFromWorkspaces(ctx, sessionId)
  await unarchiveSession(ctx, sessionId)

  // Existence confirmation only (best-effort) — physical artifacts stay
  // with the backend, nothing is removed from disk here.
  try {
    const persistence = ctx.get('sessionPersistence')
    if (typeof persistence?.stat === 'function') await persistence.stat(sessionId)
  } catch { /* best-effort */ }

  // Written last so a half-finished delete never leaves a restorable record.
  let trashRecorded = false
  if (trash !== null) {
    try {
      await recordTrash(trash)
      trashRecorded = true
    } catch { /* best-effort */ }
  }

  return {
    deleted: true,
    wasLive,
    detached,
    trashRecorded,
    artifactRemoved: false,
    note: '逻辑记录已清理；物理工件由后端持有，未做物理删除',
  }
}

function requireSessionId(payload) {
	const sessionId = payload?.sessionId;
	if (typeof sessionId !== "string" || sessionId.trim() === "") throw new Error("sessionId 必填");
	return sessionId.trim();
}
async function restoreSession(ctx, sessionId) {
  const entry = (await readTrash()).find(e => e.sessionId === sessionId)
  if (entry === undefined) return { ok: false, error: 'not-in-trash' }

  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function') {
    return { ok: false, error: 'workspaceRegistry 服务不可用' }
  }

  // The event log must still be there: everything below reads the header from it.
  const persistence = ctx.get('sessionPersistence')
  let header = undefined
  try {
    if (typeof persistence?.stat === 'function') header = await persistence.stat(sessionId)
  } catch { /* handled below */ }
  if (header === undefined) {
    return { ok: false, error: 'artifacts-missing', detail: '会话文件已不存在，无法恢复' }
  }

  const cwd = typeof entry.cwd === 'string' && entry.cwd !== '' ? entry.cwd : String(header.cwd ?? '')
  if (cwd === '') return { ok: false, error: 'no-cwd' }

  // Workspace the session used to belong to, if that entity is still around.
  const entities = registry.list()
  const original = entry.workspaceIds
    .map(id => entities.find((e) => e?.id === id))
    .filter((e) => e !== undefined)

  const attachedTo = []
  const targets = original.length > 0
    ? original
    : [typeof registry.resolveByPath === 'function' ? await registry.resolveByPath(cwd) : undefined]
        .filter((e) => e !== undefined)

  if (targets.length === 0) {
    if (typeof registry.create !== 'function') return { ok: false, error: 'workspaceRegistry 服务不可用' }
    const created = await registry.create(cwd)
    if (created !== undefined) targets.push(created)
  }

  for (const entity of targets) {
    try {
      await entity.attachSession(sessionId)
      attachedTo.push(typeof entity.id === 'string' ? entity.id : String(entity.path ?? ''))
    } catch (err) {
      return {
        ok: false,
        error: 'attach-failed',
        detail: String(err instanceof Error ? err.message : err),
      }
    }
  }

  if (attachedTo.length === 0) return { ok: false, error: 'attach-failed' }

  // Put the archive state back exactly as it was before the delete.
  if (entry.archived) {
    try {
      await archiveSession(ctx, sessionId)
    } catch { /* best-effort: session is back, archive flag may lag */ }
  }

  await dropTrash(sessionId)

  return {
    ok: true,
    result: {
      restored: true,
      sessionId,
      archived: entry.archived === true,
      workspaces: attachedTo,
      cwd,
    },
  }
}

async function listDeleted(ctx) {
  const entries = await readTrash()
  const persistence = ctx.get('sessionPersistence')
  // Titles come from the same event head the session list uses; a restored-log
  // read is bounded by readEventsUntil and cached by (id, updatedAt).
  const titles = await mapWithConcurrency(entries, TITLE_READ_CONCURRENCY, async (e) => {
    const key = `${e.sessionId}@${e.updatedAt || e.createdAt || ''}`
    let title = titleCache.get(key)
    if (title === undefined) {
      title = ''
      try {
        const events = await readEventsUntil(persistence, e.sessionId, titleFromEvents)
        title = (events ? titleFromEvents(events) : undefined) || ''
      } catch { /* ignore */ }
      titleCache.set(key, title)
    }
    return title
  })
  return {
    ok: true,
    result: {
      items: entries.map((e, i) => ({
        sessionId: e.sessionId,
        title: titles[i] || shortPath(e.cwd) || '未命名',
        cwd: e.cwd,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        deletedAt: e.deletedAt,
        archived: e.archived,
      })),
    },
  }
}

async function handleArchive(ctx, payload) {
	try {
		await archiveSession(ctx, requireSessionId(payload));
		return { ok: true };
	} catch (err) {
		return { ok: false, error: String(err instanceof Error ? err.message : err) };
	}
}
async function handleUnarchive(ctx, payload) {
	try {
		await unarchiveSession(ctx, requireSessionId(payload));
		return { ok: true };
	} catch (err) {
		return { ok: false, error: String(err instanceof Error ? err.message : err) };
	}
}
async function handleDelete(ctx, payload) {
	try {
		const result = await deleteSession(ctx, requireSessionId(payload));
		return { ok: true, result };
	} catch (err) {
		return { ok: false, error: String(err instanceof Error ? err.message : err) };
	}
}
function randomHex(bytes) {
	let out = "";
	for (let i = 0; i < bytes; i += 1) out += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
	return out;
}
function listWorkspaces(ctx) {
	const registry = ctx.workspaceRegistry;
	return registry.list().map((entity) => {
		const raw = entity.record?.sessionIds;
		const ids = Array.isArray(raw) ? [...raw] : typeof entity.sessionIds === "function" ? entity.sessionIds() : entity.sessionIds;
		const rawIds = Array.isArray(ids) ? [...ids] : [];
		return {
			id: entity.id,
			name: entity.title || entity.id,
			title: entity.title || entity.id,
			path: entity.path,
			sessionCount: rawIds.length,
			sessionIds: rawIds
		};
	});
}
async function moveSession(ctx, sessionId, targetWorkspaceId) {
	const registry = ctx.workspaceRegistry;
	const logger = ctx.logger;
	const sessionQuery = ctx.get("sessionQuery");
	const target = registry.list().find((entity) => entity.id === targetWorkspaceId);
	if (target === void 0) {
		const error = new Error(`目标工作区不存在: ${targetWorkspaceId}`);
		error.code = "workspace-not-found";
		throw error;
	}
	const targetPath = target.path;
	if (sessionQuery === void 0 || typeof sessionQuery.observeSession !== "function") {
		throw new Error("sessionQuery 服务不可用");
	}
	let observed;
	try {
		observed = await sessionQuery.observeSession(sessionId);
	} catch {
		const error = new Error(`会话 ${sessionId} 不存在，无法移动`);
		error.code = "session-not-found";
		throw error;
	}
	const sourceHeader = observed?.header;
	const sourceEvents = Array.isArray(observed?.events) ? [...observed.events] : [];
	try { if (typeof observed?.[Symbol.dispose] === "function") observed[Symbol.dispose](); }
	catch { /* best-effort: the observation lease is caller-owned */ }
	if (sourceHeader?.origin === "subagent") {
		const error = new Error("子代理（subagent）会话不支持跨工作区移动");
		error.code = "subagent-unsupported";
		throw error;
	}
	if (typeof sourceHeader?.cwd === "string") {
		let currentCanonical;
		try { currentCanonical = await realpath(sourceHeader.cwd); }
		catch { /* old directory gone — the fork below re-homes it */ }
		if (currentCanonical === targetPath) {
			return { ok: true, sessionId, moved: false, message: "会话已属于目标工作区" };
		}
	}
	const liveSessions = ctx.sessions;
	const liveAgents = ctx.agents;
	const liveSession = liveSessions?.get?.(sessionId);
	const liveAgent = liveAgents?.get?.(sessionId);
	const wasLive = liveSession !== void 0 || liveAgent !== void 0;
	if (liveAgent !== void 0) {
		try { liveAgent.cancel({ kind: "disposed" }); } catch { /* best-effort */ }
		if (typeof liveAgent.whenIdle === "function") await liveAgent.whenIdle();
	}
	if (liveSession !== void 0) {
		try { await liveSessions.flush(liveSession); } catch { /* best-effort */ }
	}
	const newSessionId = `session-${randomHex(8)}`;
	const seed = sourceEvents;
	const newMeta = { cwd: targetPath };
	if (typeof sourceHeader?.agentPreset === "string") newMeta.agentPreset = sourceHeader.agentPreset;
	if (liveAgents !== void 0 && typeof liveAgents.create === "function") {
		await liveAgents.create({ sessionId: newSessionId, meta: newMeta, seed });
	} else if (liveSessions !== void 0 && typeof liveSessions.create === "function") {
		await liveSessions.create({ sessionId: newSessionId, meta: newMeta, seed });
	} else {
		throw new Error("agents/sessions 服务不可用，无法创建新会话");
	}
	const fromWorkspaceIds = [];
	try {
		await registry.enqueueOperation(async () => {
			for (const entity of registry.list()) {
				if (entity.id === target.id) continue;
				const rawIds = Array.isArray(entity.record?.sessionIds) ? entity.record.sessionIds : entity.sessionIds;
				const ids = typeof rawIds === "function" ? rawIds() : rawIds;
				if (Array.isArray(ids) && ids.includes(sessionId)) {
					fromWorkspaceIds.push(entity.id);
					await entity.detachSession(sessionId);
				}
			}
			await target.attachSession(newSessionId);
		});
	} catch (error) {
		throw new Error(`新会话已创建（${newSessionId}），但工作区记账切换失败: ${String(error)}`);
	}
	try {
		await registry.archiveSession(sessionId, { stopActivity: true });
	} catch (error) {
		try { logger?.warn?.(`session-browser: archiving move source "${sessionId}" failed: ${String(error)}`); }
		catch { /* best-effort */ }
	}
	try { logger?.info?.(`session-browser: moved "${sessionId}" to "${newSessionId}" in ${target.id}`); }
	catch { /* best-effort */ }
	return {
		ok: true,
		sessionId: newSessionId,
		newSessionId,
		moved: true,
		fromWorkspaceIds,
		toWorkspaceId: target.id,
		toWorkspaceTitle: target.title || target.id,
		archivedSourceId: sessionId,
		wasLive
	};
}
async function migratePreset(ctx, opts) {
	const sessionId = typeof opts.sessionId === "string" ? opts.sessionId.trim() : "";
	const toPreset = typeof opts.toPreset === "string" ? opts.toPreset.trim() : "";
	if (sessionId === "") { const e = new Error("sessionId required"); e.code = "bad-request"; throw e; }
	if (toPreset === "") { const e = new Error("toPreset required"); e.code = "bad-request"; throw e; }
	const presets = ctx.get("agentPresets");
	if (presets === void 0 || typeof presets.list !== "function") {
		throw new Error("agentPresets service unavailable");
	}
	const roster = await presets.list();
	const target = (roster || []).find((preset) => preset && preset.id === toPreset);
	if (target === void 0) {
		const available = (roster || []).map((preset) => preset?.id).filter(Boolean);
		throw new Error(`Agent 预设 "${toPreset}" 不存在（可用：${available.join(", ")}）`);
	}
	if (target.broken) throw new Error(`Agent 预设 "${toPreset}" 不可用：${target.broken}`);
	const liveAgents = ctx.agents;
	const liveSessions = ctx.sessions;
	const agent = liveAgents?.get?.(sessionId);
	if (agent == null) throw new Error(`会话 "${sessionId}" 没有 live agent，无法切换预设（仅空白会话支持在线切换）`);
	let oldPreset;
	try {
		if (typeof presets.composedPreset === "function") oldPreset = presets.composedPreset(agent.ctx);
	} catch { /* best-effort: fall back to the live session header */ }
	if (oldPreset === void 0) {
		const liveSession = liveSessions?.get?.(sessionId);
		const headerPreset = liveSession?.header?.agentPreset;
		if (typeof headerPreset === "string") oldPreset = headerPreset;
	}
	if (oldPreset === toPreset) {
		return { sessionId, migrated: false, oldPreset, newPreset: toPreset };
	}
	let committed;
	try {
		committed = await presets.select(agent, toPreset);
	} catch (err) {
		const code = err?.code;
		const message = String(err instanceof Error ? err.message : err);
		if (code === "agent-preset/locked" || /already started|locked/i.test(message)) {
			throw new Error(`会话 "${sessionId}" 已开始，无法切换预设（可 fork 该会话后再选预设）`);
		}
		throw err;
	}
	return { sessionId, migrated: true, oldPreset, newPreset: committed };
}
function requireTargetWorkspaceId(payload) {
	const targetWorkspaceId = payload?.targetWorkspaceId;
	if (typeof targetWorkspaceId !== "string" || targetWorkspaceId.trim() === "") throw new Error("targetWorkspaceId 必填");
	return targetWorkspaceId.trim();
}
async function handleMove(ctx, payload) {
	try {
		const result = await moveSession(ctx, requireSessionId(payload), requireTargetWorkspaceId(payload));
		return { ok: true, result };
	} catch (err) {
		return { ok: false, error: String(err instanceof Error ? err.message : err) };
	}
}
async function handlePresetMigrate(ctx, payload) {
	const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
	const toPreset = typeof payload?.toPreset === "string" ? payload.toPreset.trim() : "";
	if (sessionId === "" || toPreset === "") return { ok: false, error: "sessionId and toPreset required" };
	try {
		const result = await migratePreset(ctx, { sessionId, toPreset });
		return { ok: true, result };
	} catch (err) {
		return { ok: false, error: String(err instanceof Error ? err.message : err) };
	}
}
async function handleWorkspaces(ctx) {
	try {
		return { ok: true, result: { workspaces: listWorkspaces(ctx) } };
	} catch (err) {
		return { ok: false, error: String(err instanceof Error ? err.message : err) };
	}
}
function apply(ctx) {
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/session-browser/api",
		handler: async (req, res) => {
			if (!isTrustedApiRequest(req)) {
				writeJson(res, 403, { ok: false, error: "forbidden" });
				return;
			}
			if (req.method !== "POST") {
				writeJson(res, 405, { ok: false, error: "method not allowed" });
				return;
			}
			const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
			const method = pathname.startsWith("/session-browser/api/") ? pathname.slice(21) : void 0;
			if (method === void 0 || method.includes("/")) {
				writeJson(res, 404, { ok: false, error: "unknown method" });
				return;
			}
			try {
				const payload = await readJsonBody(req);
				if (method === "list-sessions") {
					writeJson(res, 200, await listSessions(ctx, payload));
					return;
				}
				if (method === "list-rounds") {
					writeJson(res, 200, await listRounds(ctx, payload));
					return;
				}
				if (method === "archive") {
					writeJson(res, 200, await handleArchive(ctx, payload));
					return;
				}
				if (method === "unarchive") {
					writeJson(res, 200, await handleUnarchive(ctx, payload));
					return;
				}
				if (method === "delete") {
					writeJson(res, 200, await handleDelete(ctx, payload));
					return;
				}
				if (method === "list-deleted") {
					writeJson(res, 200, await listDeleted(ctx));
					return;
				}
				if (method === "restore") {
					// Failure is reported in-band ({ ok:false, error }) so the client can
					// show the precise reason (artifacts-missing / attach-failed / …).
					writeJson(res, 200, await restoreSession(ctx, requireSessionId(payload)));
					return;
				}
		if (method === "move") {
					writeJson(res, 200, await handleMove(ctx, payload));
					return;
				}
				if (method === "preset-migrate") {
					writeJson(res, 200, await handlePresetMigrate(ctx, payload));
					return;
				}
				if (method === "workspaces") {
					writeJson(res, 200, await handleWorkspaces(ctx));
					return;
				}
				writeJson(res, 404, { ok: false, error: `unknown method "${method}"` });
			} catch (err) {
				writeJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
			}
		}
	}), "dsh-session-browser: /session-browser/api route");
}
//#endregion
export { name, apply, inject, __setTrashPath, readTrash, recordTrash, dropTrash, normalizeEntries };
