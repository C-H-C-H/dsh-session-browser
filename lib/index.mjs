//#region src/index.ts
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
async function listSessions(ctx) {
	const persistence = ctx.get("sessionPersistence");
	if (persistence === void 0) return { ok: false, error: "sessionPersistence \u670D\u52A1\u4E0D\u53EF\u7528" };
	try {
		const allHeaders = await persistence.list();
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
			return true;
		});
		// Derive title from session/title event or first user message
		const items = [];
		for (const h of headers) {
			let title = "";
			try {
				const stored = await persistence.loadStored(h.id);
				if (stored && stored.events) {
					// First: look for session/title event (renamed title)
					for (const event of stored.events) {
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
						for (const event of stored.events) {
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
				updatedAt: h.updatedAt || h.createdAt
			});
		}
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
		const stored = await persistence.loadStored(sessionId);
		if (!stored || !stored.events) return { ok: false, error: "\u4F1A\u8BDD\u4E0D\u5B58\u5728\u6216\u65E0\u4E8B\u4EF6\u6570\u636E" };
		const rounds = [];
		let turnIndex = 0;
		for (const event of stored.events) {
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
					writeJson(res, 200, await listSessions(ctx));
					return;
				}
				if (method === "list-rounds") {
					writeJson(res, 200, await listRounds(ctx, payload));
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
