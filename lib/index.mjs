//#region src/index.ts
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
const name = "dsh-session-browser";
const inject = ["webServer", "sessionPersistence", "workspaceRegistry"];
const MAX_BODY_BYTES = 1 << 20;
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
function readArchivedIds(ctx) {
	const registry = ctx.get("workspaceRegistry");
	try {
		if (registry === void 0 || typeof registry.requireState !== "function") return new Set();
		const ids = registry.requireState()?.archivedSessionIds;
		if (!Array.isArray(ids)) return new Set();
		return new Set(ids.filter((id) => typeof id === "string"));
	} catch { return new Set(); }
}
async function listSessions(ctx, payload) {
	const persistence = ctx.get("sessionPersistence");
	if (persistence === void 0) return { ok: false, error: "sessionPersistence \u670D\u52A1\u4E0D\u53EF\u7528" };
	try {
		const archivedOnly = payload?.archived === true;
		const archivedIds = readArchivedIds(ctx);
		const allHeaders = normalizeHeaders(await persistence.list());
		// Collect session IDs from all workspaces (current workspace scope)
		const registry = ctx.get("workspaceRegistry");
		let allowedIds = null;
		if (registry !== void 0 && typeof registry.list === "function") {
			allowedIds = new Set();
			for (const entity of registry.list()) {
				const ids = typeof entity.sessionIds === "function" ? entity.sessionIds() : entity.sessionIds;
				if (Array.isArray(ids)) for (const id of ids) allowedIds.add(id);
			}
		}
		const headers = allHeaders.filter((h) => {
			if (h.origin === "subagent") return false;
			if (allowedIds !== null && !allowedIds.has(h.id)) return false;
			// 归档分流：已归档页只取交集，未归档页排除已归档 id
			if (archivedOnly) { if (!archivedIds.has(h.id)) return false; }
			else if (archivedIds.has(h.id)) return false;
			return true;
		});
		// Derive title from session/title event or first user message
		const items = [];
		for (const h of headers) {
			let title = "";
			try {
				const events = await readStoredEvents(persistence, h.id);
				if (events) {
					// First: look for session/title event (renamed title)
					for (const event of events) {
						if (event !== null && event !== void 0 && event.type === "session/title") {
							const t = event.data?.title || "";
							if (typeof t === "string" && t.trim()) {
								title = t.trim().length > 40 ? t.trim().slice(0, 40) + "\u2026" : t.trim();
								break;
							}
						}
					}
					// Fallback: first user message
					if (!title) {
						for (const event of events) {
							if (event !== null && event !== void 0 && event.type === "user/message") {
								const data = event.data || {};
								const content = typeof data.content === "string" ? data.content : Array.isArray(data.content) ? data.content.map((c) => c.text || "").join("") : "";
								if (content.trim()) {
									title = content.trim().length > 40 ? content.trim().slice(0, 40) + "\u2026" : content.trim();
									break;
								}
							}
						}
					}
				}
			} catch { /* ignore */ }
			items.push({
				sessionId: h.id,
				title: title || shortPath(h.cwd) || "\u672A\u547D\u540D",
				cwd: h.cwd || "",
				createdAt: h.createdAt,
				updatedAt: h.updatedAt || h.createdAt,
				archived: archivedIds.has(h.id)
			});
		}
		items.sort((a, b) => b.createdAt - a.createdAt);
		return { ok: true, items };
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
	if (registry === void 0 || typeof registry.enqueueOperation !== "function") throw new Error("workspaceRegistry 服务不可用");
	await registry.enqueueOperation(async () => {
		const state = registry.requireState();
		if (state.archivedSessionIds.includes(sessionId)) return;
		await registry.setState({
			...state,
			archivedSessionIds: [...state.archivedSessionIds, sessionId]
		});
	});
}
async function unarchiveSession(ctx, sessionId) {
	const registry = ctx.get("workspaceRegistry");
	if (registry === void 0 || typeof registry.enqueueOperation !== "function") throw new Error("workspaceRegistry 服务不可用");
	await registry.enqueueOperation(async () => {
		const state = registry.requireState();
		if (!state.archivedSessionIds.includes(sessionId)) return;
		await registry.setState({
			...state,
			archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId)
		});
	});
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
async function sessionDirOf(ctx, sessionId) {
	const persistence = ctx.get("sessionPersistence");
	if (persistence === void 0) return void 0;
	const headers = normalizeHeaders(await persistence.list());
	const meta = headers.find((header) => header.id === sessionId);
	if (meta === void 0) return void 0;
	const location = persistence.locate(meta);
	if (location === void 0) return void 0;
	return dirname(location.path);
}
async function deleteSession(ctx, sessionId) {
	const liveSessions = ctx.get("sessions");
	const liveAgents = ctx.get("agents");
	const session = liveSessions?.get?.(sessionId);
	const agent = liveAgents?.get?.(sessionId);
	if (agent !== void 0) {
		agent.cancel({ kind: "disposed" });
		if (typeof agent.scope?.dispose === "function") {
			await Promise.race([agent.scope.dispose(), sleep(3e3)]);
		}
		try {
			liveAgents.store?.delete?.(sessionId);
		} catch { /* best-effort */ }
	}
	let detached = false;
	if (session !== void 0) {
		try {
			await liveSessions.flush(session);
		} catch { /* best-effort */ }
		try {
			const entry = liveSessions.store?.get?.(sessionId);
			if (entry !== void 0 && typeof entry.detach === "function") {
				entry.detach();
				await sleep(200);
				detached = true;
			}
		} catch { /* best-effort */ }
	}
	if (!detached) {
		try {
			if (typeof ctx.emit === "function") ctx.emit("session/disposed", { id: sessionId });
		} catch { /* best-effort */ }
	}
	await detachFromWorkspaces(ctx, sessionId);
	await unarchiveSession(ctx, sessionId);
	const dir = await sessionDirOf(ctx, sessionId);
	if (dir !== void 0) {
		await rm(dir, { recursive: true, force: true });
	}
}
function requireSessionId(payload) {
	const sessionId = payload?.sessionId;
	if (typeof sessionId !== "string" || sessionId.trim() === "") throw new Error("sessionId 必填");
	return sessionId.trim();
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
		await deleteSession(ctx, requireSessionId(payload));
		return { ok: true };
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
				writeJson(res, 404, { ok: false, error: `unknown method "${method}"` });
			} catch (err) {
				writeJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
			}
		}
	}), "dsh-session-browser: /session-browser/api route");
}
//#endregion
export { name, apply, inject };
