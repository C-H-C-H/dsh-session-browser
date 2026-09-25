//#region src/index.ts
import { mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
const name = "dsh-session-browser";
const inject = ["webServer", "sessionPersistence", "workspaceRegistry", "sessions", "agents"];
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
				messageId: typeof data.id === "string" ? data.id : void 0,
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
function safeErrorMessage(error) {
	if (error === null || error === void 0) return `<nullish:${typeof error}>`;
	if (typeof error === "string") return error;
	if (typeof error === "object") {
		if (typeof error.message === "string" && error.message.length > 0) return error.message;
		if (typeof error.code === "string" && error.code.length > 0) return `[code=${error.code}]`;
	}
	try { return JSON.stringify(error); } catch { return String(error); }
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
async function quietLive(ctx, sessionId) {
	const liveSessions = ctx.sessions;
	const liveAgents = ctx.agents;
	const session = liveSessions?.get?.(sessionId);
	const agent = liveAgents?.get?.(sessionId);
	const wasLive = session !== void 0 || agent !== void 0;
	if (agent !== void 0) {
		agent.cancel({ kind: "disposed" });
		if (typeof agent.whenIdle === "function") await agent.whenIdle();
		if (typeof agent.scope?.dispose === "function") await agent.scope.dispose();
		try { liveAgents.store?.delete?.(sessionId); } catch { /* best-effort */ }
	}
	if (session !== void 0) {
		try { await liveSessions.flush(session); } catch { /* best-effort */ }
	}
	return wasLive;
}
async function releaseLiveSession(ctx, sessionId) {
	const liveSessions = ctx.sessions;
	try {
		const entry = liveSessions?.store?.get?.(sessionId);
		if (entry !== void 0 && typeof entry.detach === "function") {
			entry.detach();
			await sleep(250);
		}
	} catch { /* best-effort */ }
}
async function writeTempFile(finalPath, data) {
	const temp = `${finalPath}.${randomHex(6)}.tmp`;
	const handle = await open(temp, "wx", 0o600);
	try {
		await handle.writeFile(data);
		await handle.sync();
	} finally {
		await handle.close();
	}
	return temp;
}
async function encodeArtifact(headerLine, rest, isZstd) {
	if (!isZstd) return Buffer.from(`${headerLine}\n${rest}`, "utf8");
	const { zstdCompress } = await import("node:zlib");
	if (typeof zstdCompress !== "function") {
		throw new Error("当前 Node 运行时没有 zstd 支持，无法迁移 zstd 编码的会话工件");
	}
	const compress = (buffer) => new Promise((resolve, reject) => {
		zstdCompress(buffer, (error, output) => error == null ? resolve(output) : reject(error));
	});
	const headerFrame = await compress(Buffer.from(`${headerLine}\n`, "utf8"));
	if (rest === "") return headerFrame;
	const bodyFrame = await compress(Buffer.from(rest, "utf8"));
	return Buffer.concat([headerFrame, bodyFrame]);
}
async function moveSession(ctx, sessionId, targetWorkspaceId) {
	const registry = ctx.workspaceRegistry;
	const logger = ctx.logger;
	const persistence = ctx.get("sessionPersistence");
	if (persistence === void 0) throw new Error("sessionPersistence 服务不可用");
	if (typeof persistence.readRaw !== "function" || typeof persistence.loadStored !== "function") {
		throw new Error("当前持久化后端不支持 readRaw/loadStored，无法跨工作区移动");
	}
	const target = registry.list().find((entity) => entity.id === targetWorkspaceId);
	if (target === void 0) {
		const error = new Error(`目标工作区不存在: ${targetWorkspaceId}`);
		error.code = "workspace-not-found";
		throw error;
	}
	const targetPath = target.path;
	const storedHeaders = await persistence.list();
	const storedHeader = storedHeaders.find((header) => header.id === sessionId);
	if (storedHeader === void 0) {
		const error = new Error(`会话 ${sessionId} 没有磁盘记录（不存在，或是一个尚未发送任何消息的空白会话），无法移动`);
		error.code = "session-not-found";
		throw error;
	}
	if (storedHeader.origin === "subagent") {
		const error = new Error("子代理（subagent）会话不支持跨工作区移动");
		error.code = "subagent-unsupported";
		throw error;
	}
	if (storedHeader.cwd !== void 0) {
		let currentCanonical;
		try {
			currentCanonical = await realpath(storedHeader.cwd);
		} catch { /* old directory gone — the move below re-homes it */ }
		if (currentCanonical === targetPath) {
			return { ok: true, sessionId, moved: false, message: "会话已属于目标工作区" };
		}
	}
	const wasLive = await quietLive(ctx, sessionId);
	const raw = await persistence.readRaw(sessionId);
	if (raw === void 0) {
		throw new Error("读取会话工件失败：readRaw 未找到会话文件");
	}
	const meta = raw.meta;
	const newlineAt = raw.content.indexOf("\n");
	if (newlineAt === -1) throw new Error("会话工件缺少头行，数据可能损坏");
	const headerText = raw.content.slice(0, newlineAt);
	const rest = raw.content.slice(newlineAt + 1);
	let headerObject;
	try {
		headerObject = JSON.parse(headerText);
	} catch (error) {
		throw new Error(`会话工件头行无法解析: ${String(error)}`);
	}
	if (headerObject.id !== sessionId) throw new Error("会话工件头行 id 与请求不符，拒绝移动");
	headerObject.cwd = targetPath;
	const newHeaderLine = JSON.stringify(headerObject);
	const newLocation = persistence.locate({ ...meta, cwd: targetPath });
	const oldLocation = persistence.locate(meta);
	if (newLocation === void 0 || oldLocation === void 0) {
		throw new Error("持久化后端无法定位会话工件路径");
	}
	const bytes = await encodeArtifact(newHeaderLine, rest, newLocation.path.endsWith(".zstd"));
	await mkdir(dirname(newLocation.path), { recursive: true });
	const tempNew = await writeTempFile(newLocation.path, bytes);
	let oldHidden;
	try {
		oldHidden = `${oldLocation.path}.${randomHex(6)}.tmp`;
		await rename(oldLocation.path, oldHidden);
	} catch (error) {
		await rm(tempNew, { force: true });
		throw new Error(`移动失败（无法隐藏旧会话工件，已取消，会话保持原状）: ${String(error)}`);
	}
	try {
		await rename(tempNew, newLocation.path);
	} catch (error) {
		let restored = false;
		try {
			await rename(oldHidden, oldLocation.path);
			restored = true;
		} catch { /* reported below */ }
		await rm(tempNew, { force: true });
		if (!restored) {
			throw new Error(`移动失败且旧工件回滚失败——原数据保留在 ${oldHidden}，请手动恢复: ${String(error)}`);
		}
		throw new Error(`移动失败（已回滚，会话保持原状）: ${String(error)}`);
	}
	let stored;
	try {
		stored = await persistence.loadStored(sessionId);
		if (stored === void 0 || stored.meta.cwd !== targetPath) {
			throw new Error("迁移后的会话日志读取校验失败");
		}
	} catch (error) {
		throw new Error(`工件已迁移至 ${newLocation.path}，但记账前校验失败: ${String(error)}`);
	}
	const liveSessions = ctx.sessions;
	const originalEntry = liveSessions?.store?.get?.(sessionId);
	if (originalEntry !== void 0 && typeof originalEntry.detach === "function") {
		try {
			originalEntry.detach();
		} catch (error) {
			logger.warn(`session-manager: pre-move detach of original entry failed for "${sessionId}": ${String(error)}`);
		}
	}
	let detachPlaceholder = null;
	try {
		const placeholder = liveSessions.prepare(sessionId, {
			seedSource: "persistence",
			seed: stored.events,
			meta: stored.meta
		});
		detachPlaceholder = liveSessions.enter(placeholder);
	} catch (error) {
		let newRemoved = true;
		try { await rm(newLocation.path, { force: true }); }
		catch { newRemoved = false; }
		try { await rm(dirname(newLocation.path), { recursive: true, force: true }); }
		catch { /* best-effort */ }
		let restored = false;
		try { await rename(oldHidden, oldLocation.path); restored = true; }
		catch { /* reported below */ }
		if (!restored) {
			throw new Error(`构造校验失败且旧工件回滚失败——原数据保留在 ${oldHidden}，请手动恢复: ${safeErrorMessage(error)}`);
		}
		try { await rm(dirname(oldLocation.path), { recursive: true, force: true }); }
		catch { /* best-effort */ }
		if (!newRemoved) {
			throw new Error(`旧工件已回滚但新工件 ${newLocation.path} 仍未清理，请手动删除: ${safeErrorMessage(error)}`);
		}
		throw new Error(`工件已迁移至 ${newLocation.path}，但构造校验会话失败（已回滚磁盘，会话保持原状）: ${safeErrorMessage(error)}`);
	}
	const fromWorkspaceIds = [];
	let attachSucceeded = false;
	try {
		await registry.enqueueOperation(async () => {
			for (const entity of registry.list()) {
				if (entity.id === target.id) continue;
				const rawIds = Array.isArray(entity.record?.sessionIds) ? entity.record.sessionIds : entity.sessionIds;
				if (rawIds.includes(sessionId)) {
					fromWorkspaceIds.push(entity.id);
					await entity.detachSession(sessionId);
				}
			}
			await target.attachSession(sessionId);
			attachSucceeded = true;
		});
	} finally {
		try {
			if (attachSucceeded) {
				const fakeSession = {
					id: sessionId,
					header: { ...stored.meta, cwd: targetPath },
					events: stored.events
				};
				if (Array.isArray(stored.events)) {
					for (const event of stored.events) {
						if (event === void 0 || event === null) continue;
						if (event.type !== "session/title" && event.type !== "user/message") continue;
						try { ctx.emit("session/event", fakeSession, event); }
						catch (driveError) {
							logger.warn(`session-manager: post-move session/event drive failed for "${sessionId}" (title may render from fallback until next list pull): ${String(driveError)}`);
						}
					}
				}
			}
		} catch { /* best-effort */ }
		try {
			if (detachPlaceholder !== null) detachPlaceholder();
		} catch { /* best-effort */ }
	}
	try {
		const reread = await persistence.loadStored(sessionId);
		if (reread !== void 0 && Array.isArray(reread.events)) {
			const fresh = {
				id: sessionId,
				header: { ...reread.meta, cwd: targetPath },
				events: reread.events
			};
			for (const event of reread.events) {
				if (event === void 0 || event === null) continue;
				if (event.type !== "session/title" && event.type !== "user/message") continue;
				try { ctx.emit("session/event", fresh, event); } catch (_) {}
			}
		}
	} catch (error) {
		logger.warn(`session-manager: post-move event replay failed for "${sessionId}": ${String(error)}`);
	}
	await releaseLiveSession(ctx, sessionId);
	try {
		if (typeof persistence.inspect === "function") await persistence.inspect(sessionId);
		const states = persistence.states;
		const state = states?.get?.(sessionId);
		if (state?.owner !== void 0 && liveSessions?.get?.(sessionId) === void 0 && ctx.agents?.get?.(sessionId) === void 0) {
			states.delete(sessionId);
			logger.warn(`session-manager: cleared stale persistence owner after move for "${sessionId}"`);
		}
	} catch (error) {
		logger.warn(`session-manager: post-move persistence retirement check failed for "${sessionId}": ${String(error)}`);
	}
	logger.info(`session-manager: moved "${sessionId}" ${fromWorkspaceIds.length > 0 ? fromWorkspaceIds.join(",") + " -> " : ""}${target.id} (${oldLocation.path} -> ${newLocation.path})`);
	try {
		await rm(oldHidden, { force: true });
	} catch { /* best-effort */ }
	try {
		await rm(dirname(oldLocation.path), { recursive: true, force: true });
	} catch { /* best-effort */ }
	return {
		ok: true,
		sessionId,
		moved: true,
		fromWorkspaceIds,
		toWorkspaceId: target.id,
		toWorkspaceTitle: target.title || target.id,
		artifactFrom: oldLocation.path,
		artifactTo: newLocation.path,
		wasLive
	};
}
const NL = String.fromCharCode(10);
async function retireForPresetMigration(ctx, sessionId, persistence) {
	const liveAgents = ctx.agents;
	const liveSessions = ctx.sessions;
	const logger = ctx.logger;
	const agent = liveAgents?.get?.(sessionId);
	if (agent !== void 0) {
		try { agent.cancel({ kind: "disposed" }); } catch { /* best-effort */ }
		if (typeof agent.whenIdle === "function") await agent.whenIdle();
		if (typeof agent.scope?.dispose === "function") await agent.scope.dispose();
		try { liveAgents.store?.delete?.(sessionId); } catch { /* best-effort */ }
	}
	const entry = liveSessions?.store?.get?.(sessionId);
	if (entry !== void 0 && typeof entry.detach === "function") entry.detach();
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (liveAgents?.get?.(sessionId) === void 0 && liveSessions?.get?.(sessionId) === void 0) break;
		await sleep(25);
	}
	if (liveAgents?.get?.(sessionId) !== void 0 || liveSessions?.get?.(sessionId) !== void 0) {
		throw new Error(`会话 "${sessionId}" 无法安全关闭，已取消预设迁移`);
	}
	if (typeof persistence.inspect === "function") {
		await persistence.inspect(sessionId);
	} else if (typeof persistence.load === "function") {
		await persistence.load(sessionId);
	}
	const states = persistence.states;
	const state = states?.get?.(sessionId);
	if (state?.owner !== void 0) {
		states.delete(sessionId);
		logger.warn(`session-manager: cleared stale persistence owner for "${sessionId}" during preset migration`);
	}
}
async function migratePreset(ctx, opts) {
	const logger = ctx.logger;
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
	if (target.broken !== void 0) throw new Error(`Agent 预设 "${toPreset}" 不可用：${target.broken}`);
	const persistence = ctx.get("sessionPersistence");
	if (persistence === void 0) throw new Error("sessionPersistence service unavailable");
	if (typeof persistence.readRaw !== "function") throw new Error("current persistence backend does not support readRaw");
	const raw = await persistence.readRaw(sessionId);
	if (raw === void 0) throw new Error(`session "${sessionId}" has no artifact`);
	const lines = raw.content.split(NL);
	if (lines.length < 2) throw new Error("session artifact has no header line");
	let headerObj;
	try { headerObj = JSON.parse(lines[0]); } catch { throw new Error("session header parse failed"); }
	if (headerObj.id !== sessionId) throw new Error("session header id mismatch");
	let selectedIndex = -1;
	let selectedPreset;
	for (let index = 1; index < lines.length; index += 1) {
		if (lines[index] === "") continue;
		let event;
		try { event = JSON.parse(lines[index]); } catch { continue; }
		if (event && event.type === "agent-preset/selected" && event.data && typeof event.data.agentPreset === "string") {
			selectedIndex = index;
			selectedPreset = event.data.agentPreset;
		}
	}
	const oldPreset = selectedIndex >= 0 ? selectedPreset : headerObj.agentPreset;
	if (oldPreset === toPreset) {
		return { sessionId, migrated: false, oldPreset, newPreset: toPreset };
	}
	if (selectedIndex >= 0) {
		const event = JSON.parse(lines[selectedIndex]);
		event.data = { ...event.data, agentPreset: toPreset };
		lines[selectedIndex] = JSON.stringify(event);
	} else {
		headerObj.agentPreset = toPreset;
		lines[0] = JSON.stringify(headerObj);
	}
	await retireForPresetMigration(ctx, sessionId, persistence);
	const settledRaw = await persistence.readRaw(sessionId);
	if (settledRaw === void 0) throw new Error(`session "${sessionId}" disappeared during retirement`);
	const settledLines = settledRaw.content.split(NL);
	let settledHeader;
	try { settledHeader = JSON.parse(settledLines[0]); } catch { throw new Error("settled session header parse failed"); }
	let settledSelectedIndex = -1;
	for (let index = 1; index < settledLines.length; index += 1) {
		if (settledLines[index] === "") continue;
		let event;
		try { event = JSON.parse(settledLines[index]); } catch { continue; }
		if (event && event.type === "agent-preset/selected" && event.data && typeof event.data.agentPreset === "string") {
			settledSelectedIndex = index;
		}
	}
	if (settledSelectedIndex >= 0) {
		const event = JSON.parse(settledLines[settledSelectedIndex]);
		event.data = { ...event.data, agentPreset: toPreset };
		settledLines[settledSelectedIndex] = JSON.stringify(event);
	} else {
		settledHeader.agentPreset = toPreset;
		settledLines[0] = JSON.stringify(settledHeader);
	}
	const location = persistence.locate(settledRaw.meta);
	if (location === void 0) throw new Error("locate returned undefined");
	const replacementContent = settledLines.join(NL);
	const firstNewline = replacementContent.indexOf(NL);
	const headerLine = replacementContent.slice(0, firstNewline);
	const rest = replacementContent.slice(firstNewline + 1);
	const bytes = await encodeArtifact(headerLine, rest, location.path.endsWith(".zstd"));
	await mkdir(dirname(location.path), { recursive: true });
	const tempPath = await writeTempFile(location.path, bytes);
	try {
		await rename(tempPath, location.path);
	} catch (error) {
		try { await rm(tempPath, { force: true }); } catch { /* ignore */ }
		throw new Error("preset migration rename failed: " + String(error));
	}
	try { ctx.emit("agent-preset/selected", sessionId, toPreset); } catch { /* best-effort */ }
	logger.info(`session-manager: migrated preset for "${sessionId}" from "${String(oldPreset)}" to "${toPreset}"`);
	return { sessionId, migrated: true, oldPreset, newPreset: toPreset };
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
export { name, apply, inject };
