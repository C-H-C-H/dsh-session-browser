window.__ModuleLoader__.load({
	id: "dsh-session-browser",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const reactDom = require("react-dom");
		const { useState, useEffect, useRef } = react;

		//#region styles
		const CSS = `
/* sidebar.footer.action layout: ensures all plugin buttons are visible in compatibility mode.
   In extended/advanced mode the Desktop's own CSS (with !important) overrides this. */
[data-slot="sidebar.footer.action"]{display:flex!important;flex-direction:column;gap:6px;min-width:0;width:100%;max-height:min(40vh,240px);overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
[data-slot="sidebar.footer.action"]>*{flex:none;min-width:0}
.ssb_root{box-sizing:border-box;position:relative;display:flex;align-items:center;justify-content:flex-start;flex:none;width:100%}
.ssb_button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:flex-start;gap:6px;height:28px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0 10px;font-size:12px;line-height:18px;white-space:nowrap}
.ssb_button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ssb_button svg{flex:none}
.ssb_panel{position:fixed;z-index:2147483000;width:1120px;height:960px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);box-sizing:border-box;background:var(--dsw-specific-tip);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.16);overflow:hidden;display:flex;flex-direction:column;font-family:Inter,var(--dsw-font-family)}
.ssb_header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}
.ssb_headerTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ssb_closeBtn{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:4px;border-radius:6px;display:flex;align-items:center;justify-content:center}
.ssb_closeBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ssb_body{display:flex;flex:1;min-height:0}
.ssb_sessionList{width:220px;border-right:1px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;flex:none}
.ssb_roundList{flex:1;display:flex;flex-direction:column;min-width:0}
.ssb_search{border:none;outline:none;padding:8px 12px;font-size:12px;background:transparent;color:var(--dsw-alias-label-primary);border-bottom:1px solid var(--dsw-alias-border-l2)}
.ssb_search::placeholder{color:var(--dsw-alias-label-caption)}
.ssb_scroll{flex:1;overflow-y:auto;padding:4px 0}
.ssb_sessionItem{padding:8px 12px;cursor:pointer;border-left:2px solid transparent}
.ssb_sessionItem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ssb_sessionItemActive{background:var(--dsw-alias-interactive-bg-hover);border-left-color:var(--dsw-alias-state-business-primary)}
.ssb_sessionTitle{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ssb_sessionMeta{font-size:10px;color:var(--dsw-alias-label-caption);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ssb_roundTitle{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary);padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ssb_roundItem{padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--dsw-alias-border-l2)}
.ssb_roundItem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ssb_roundContent{font-size:12px;line-height:17px;color:var(--dsw-alias-label-primary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.ssb_roundMeta{font-size:10px;color:var(--dsw-alias-label-caption);margin-top:2px}
.ssb_empty{color:var(--dsw-alias-label-tertiary);padding:16px 12px;font-size:12px;text-align:center}
.ssb_status{color:var(--dsw-alias-label-tertiary);padding:16px 12px;font-size:12px;text-align:center}
.ssb_backdrop{position:fixed;inset:0;z-index:2147482999;background:transparent}
`;

		function injectStyles() {
			if (typeof document === "undefined") return () => {};
			if (document.querySelector('style[data-plugin-css="ssb/styles"]') !== null) return () => {};
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-session-browser";
			tag.dataset.pluginCss = "ssb/styles";
			tag.textContent = CSS;
			document.head.appendChild(tag);
			return () => { if (tag.parentNode !== null) tag.parentNode.removeChild(tag); };
		}

		//#endregion

		//#region data
		const API = "/session-browser/api";
		const FETCH_TIMEOUT = 10000;

		function callApi(method, body) {
			const controller = typeof AbortController === "undefined" ? undefined : new AbortController();
			const timer = controller !== undefined ? setTimeout(() => { controller.abort(); }, FETCH_TIMEOUT) : undefined;
			return fetch(`${API}/${method}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: controller?.signal,
			})
				.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
				.catch((err) => ({ ok: false, error: String(err instanceof Error ? err.message : err) }))
				.finally(() => { if (timer !== undefined) clearTimeout(timer); });
		}

		//#endregion

		//#region helpers
		function fmtTime(ms) {
			if (!ms || typeof ms !== "number") return "";
			try {
				const d = new Date(ms);
				const now = new Date();
				const pad = (n) => String(n).padStart(2, "0");
				const sameDay = d.getFullYear() === now.getFullYear()
					&& d.getMonth() === now.getMonth()
					&& d.getDate() === now.getDate();
				const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
				if (sameDay) return time;
				return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
			} catch { return ""; }
		}

		function shortPath(cwd) {
			if (!cwd) return "";
			const parts = cwd.replace(/[\\\/]+$/, "").split(/[\\\/]/);
			const last = parts[parts.length - 1] || "";
			return last.length > 26 ? last.slice(0, 24) + "\u2026" : last;
		}

		function closeIcon() {
			return react.createElement("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
				react.createElement("path", { d: "M4 4l8 8M12 4l-8 8", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" })
			);
		}

		function browseIcon() {
			return react.createElement("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
				react.createElement("rect", { x: 2, y: 2, width: 12, height: 12, rx: 2, stroke: "currentColor", strokeWidth: 1.5 }),
				react.createElement("line", { x1: 6, y1: 2, x2: 6, y2: 14, stroke: "currentColor", strokeWidth: 1.5 })
			);
		}

		//#endregion

		//#region Task 5: row actions (logic mirror of src/client/index.ts)
		// Read of the currently-open session id. Primary is the production shape:
		// scan `ctx.sessions.list.getSnapshot().byId` and return the id whose
		// `sessions.retainInfo(id).getSnapshot().retainedBy.mainView` count is > 0
		// (0.1.7 retain 语义：mainView 持有即当前打开会话）. The older accessor
		// shapes are kept only as best-effort fallback for host-version variance;
		// unknown shapes yield undefined (callers treat that as "not current").
		function currentOpenSessionId(ctx) {
			try {
				const svc = ctx && ctx.sessions;
				if (!svc) return undefined;
				// Production primary: mainView retain count scan over list snapshot byId.
				try {
					const byId = svc && svc.list && svc.list.getSnapshot && svc.list.getSnapshot().byId;
					if (byId && typeof byId === "object" && typeof svc.retainInfo === "function") {
						for (const id of Object.keys(byId)) {
							try {
								const info = svc.retainInfo(id);
								const cnt = info && info.getSnapshot && info.getSnapshot().retainedBy
									&& info.getSnapshot().retainedBy.mainView;
								if (typeof cnt === "number" && cnt > 0) return id;
							} catch { /* ignore per-id */ }
						}
					}
				} catch { /* ignore */ }
				// Production primary: list snapshot .current is the plain SessionId
				// string (SessionListSnapshot.current: SessionId|undefined).
				try {
					const snapCur = svc && svc.list && svc.list.getSnapshot && svc.list.getSnapshot().current;
					if (typeof snapCur === "string" && snapCur !== "") return snapCur;
				} catch { /* ignore */ }
				const fields = [svc.currentSessionId, svc.currentId, svc.current];
				for (const f of fields) {
					if (typeof f === "string" && f !== "") return f;
					if (f && typeof f === "object") {
						if (typeof f.sessionId === "string" && f.sessionId !== "") return f.sessionId;
						if (typeof f.id === "string" && f.id !== "") return f.id;
					}
				}
				if (typeof svc.getCurrent === "function") {
					const cur = svc.getCurrent();
					if (typeof cur === "string" && cur !== "") return cur;
					if (cur && typeof cur === "object") {
						if (typeof cur.sessionId === "string" && cur.sessionId !== "") return cur.sessionId;
						if (typeof cur.id === "string" && cur.id !== "") return cur.id;
					}
				}
			} catch { /* ignore */ }
			return undefined;
		}
		function sessionsStoreById(ctx) {
			try {
				const snap = ctx && ctx.sessions && ctx.sessions.list && ctx.sessions.list.getSnapshot && ctx.sessions.list.getSnapshot();
				if (snap && typeof snap.byId === "object" && snap.byId !== null) return snap.byId;
			} catch { /* ignore */ }
			return {};
		}
		function refreshSessionsStore(ctx) {
			try {
				const p = ctx && ctx.sessions && ctx.sessions.refresh && ctx.sessions.refresh();
				if (p && typeof p.then === "function") return p.catch(() => undefined);
			} catch { /* ignore */ }
			return Promise.resolve(undefined);
		}
		function refreshWorkspacesStore(ctx) {
			try {
				const svc = (ctx && ctx.workspaces) || (ctx && ctx.get && ctx.get("workspaces"));
				const p = svc && svc.refresh && svc.refresh();
				if (p && typeof p.then === "function") return p.catch(() => undefined);
			} catch { /* ignore */ }
			return Promise.resolve(undefined);
		}
		function apiError(res, fallback) {
			return (res && typeof res.error === "string" && res.error !== "") ? res.error : fallback;
		}
		function mapWorkspaceList(list) {
			if (!Array.isArray(list)) return [];
			return list
				.map((w) => ({ id: String(w.id ?? w.workspaceId ?? ""), name: w.name, title: w.title, path: w.path }))
				.filter((w) => w.id !== "");
		}
		// Open a session in the main view (0.1.7 retain 语义）. Preferred path is
		// `uiWorkspace.openSession` (= retain with source 'mainView'); fallback is a
		// direct `sessions.retain(sessionId, { source: 'mainView' })` whose reference
		// is released immediately (retain+release = open without leaking a hold).
		async function openSessionById(ctx, sessionId) {
			try {
				const opener = ctx && ctx.uiWorkspace && ctx.uiWorkspace.openSession;
				if (typeof opener === "function") {
					await opener.call(ctx.uiWorkspace, sessionId);
					return;
				}
			} catch { /* fall through to retain */ }
			try {
				const retain = ctx && ctx.sessions && ctx.sessions.retain;
				if (typeof retain === "function") {
					const ref = await retain.call(ctx.sessions, sessionId, { source: "mainView" });
					try { ref && ref.release && ref.release(); } catch { /* ignore */ }
				}
			} catch { /* ignore */ }
		}
		// Dual-refresh for move: immediate workspaces.refresh + sessions.refresh
		// with reopen-if-current. Shared by the Panel row action (Task 5) and the
		// header action (Task 6); each caller schedules the 250/900ms delayed legs
		// itself (Task 3 record).
		async function refreshMovedSession(ctx, sessionId, wasCurrent) {
			try { await Promise.allSettled([refreshWorkspacesStore(ctx), refreshSessionsStore(ctx)]); } catch { /* ignore */ }
			if (wasCurrent) {
				try { if (sessionsStoreById(ctx)[sessionId] !== undefined) await openSessionById(ctx, sessionId); } catch { /* ignore */ }
			}
		}

		//#endregion

		//#region view
		// Find setGroupExpanded from workspace view store via React fiber tree
		let _cachedSetGroupExpanded = null;
		function findSetGroupExpanded() {
			if (_cachedSetGroupExpanded) return _cachedSetGroupExpanded;
			try {
				const sidebar = document.querySelector("[class*=sidebar]") || document.querySelector("[class*=Sidebar]");
				if (!sidebar) return null;
				const fiberKey = Object.keys(sidebar).find((k) => k.startsWith("__reactFiber$"));
				if (!fiberKey) return null;
				let fiber = sidebar[fiberKey];
				for (let i = 0; i < 80 && fiber; i++) {
					const props = fiber.memoizedProps || fiber.pendingProps;
					if (props && typeof props.setGroupExpanded === "function") {
						_cachedSetGroupExpanded = props.setGroupExpanded;
						return _cachedSetGroupExpanded;
					}
					fiber = fiber.return;
				}
			} catch { /* ignore */ }
			return null;
		}
		function expandGroupForKey(groupKey) {
			const fn = findSetGroupExpanded();
			if (fn && groupKey) {
				try { fn(groupKey, true); } catch { /* ignore */ }
			}
		}
		function listClientWorkspaceItems(ctx) {
			try {
				const snap = ctx && ctx.get && ctx.get("workspaces") && ctx.get("workspaces").list && ctx.get("workspaces").list.getSnapshot
					&& ctx.get("workspaces").list.getSnapshot();
				const items = (snap && snap.items) ?? snap ?? [];
				return Array.isArray(items) ? items : [];
			} catch { return []; }
		}
		// Click all collapsed overflow buttons ("展开其余N个会话") in the sidebar
		function expandAllSessionOverflows() {
			try {
				const btns = document.querySelectorAll('button[aria-expanded="false"]');
				for (const btn of btns) {
					// Only click session overflow buttons (they contain text like "展开其余")
					const text = btn.textContent || "";
					if (text.includes("\u5C55\u5F00") || text.includes("expand") || btn.className.includes("Overflow") || btn.className.includes("overflow")) {
						btn.click();
					}
				}
			} catch { /* ignore */ }
		}
		// Canonical source: src/jump-loader.mjs (plain-JS twin for node tests).
		function jumpWithTimeout(promise, ms) {
			let timer;
			const timeout = new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("jump loader timeout")), ms);
			});
			return Promise.race([promise, timeout]).then(
				(value) => { clearTimeout(timer); return value; },
				(err) => { clearTimeout(timer); throw err; }
			);
		}
		async function ensureWindowCovers(sessions, sessionId, seq, timeoutMs = 15000) {
			if (!sessions || typeof sessions.scope !== "function") return false;
			const deadline = Date.now() + timeoutMs;
			for (let attempt = 1; ; attempt++) {
				let face;
				try {
					const scoped = sessions.scope(sessionId);
					face = scoped && typeof sessions.sessionOf === "function" ? sessions.sessionOf(scoped) : undefined;
				} catch { face = undefined; }
				if (face && typeof face.loadThrough === "function") {
					try {
						await jumpWithTimeout(face.loadThrough(seq), Math.max(1, deadline - Date.now()));
						return true;
					} catch { return false; }
				}
				if (attempt >= 4 || Date.now() >= deadline) return false;
				try { await new Promise((resolve) => setTimeout(resolve, 300)); } catch { return false; }
			}
		}
		async function jumpToMessage(ctx, sessionId, eventSeq, eventId, messageId, anchorKey) {
			// Open the target session in the main view. NOTE: uiWorkspace.openSession is
			// synchronous void in 0.1.7 (navigation.ts:199) — do NOT await it. Fall back
			// to a direct retain (also scoped through try/catch).
			try { ctx && ctx.uiWorkspace && ctx.uiWorkspace.openSession && ctx.uiWorkspace.openSession(sessionId); } catch { /* ignore: fall through to retain */ }
			if (typeof (ctx && ctx.uiWorkspace && ctx.uiWorkspace.openSession) !== "function") {
				try {
					const retain = ctx && ctx.sessions && ctx.sessions.retain;
					if (typeof retain === "function") {
						const ref = await retain.call(ctx.sessions, sessionId, { source: "mainView" });
						try { ref && ref.release && ref.release(); } catch { /* ignore */ }
					}
				} catch { /* ignore */ }
			}
			// Wait for the target session to become the active one in the main view.
			// 30s budget here; the subsequent anchor-scroll loop retries on its own
			// if we time out.
			const waitForActiveSession = async () => {
				const deadline = Date.now() + 30000;
				while (Date.now() < deadline) {
					try {
						if (currentOpenSessionId(ctx) === sessionId) return true;
					} catch { /* ignore */ }
					try { await new Promise((resolve) => setTimeout(resolve, 150)); } catch { return false; }
				}
				return false;
			};
			await waitForActiveSession();
			// Phase 1: page the virtualized event window backwards until it covers the
			// target seq, so the anchor element actually renders. No-op fallback on
			// hosts without SessionFace.loadThrough (e.g. desktop 2.0.4).
			try { await ensureWindowCovers(ctx && ctx.sessions, sessionId, eventSeq, 15000); } catch { /* ignore */ }
			// Phase 2: anchor scroll. Use the host-provided engine anchorKey verbatim
			// (conversationContextKey('input-message', id)); fall back to the legacy
			// locally-derived shape only when the host did not provide one.
			const resolvedAnchorKey = anchorKey ?? `13:input-message${messageId ?? eventId}`;
			let attempts = 0;
			const tryScroll = () => {
				const el = document.querySelector(`[data-chat-anchor-key="${resolvedAnchorKey}"]`);
				if (el) {
					el.scrollIntoView({ behavior: "smooth", block: "center" });
					return;
				}
				if (attempts < 50) {
					attempts++;
					setTimeout(tryScroll, 200);
				}
			};
			setTimeout(tryScroll, 600);
		}

		// Task 3.0.1: resizable list column + toolbar. Left column width is
		// listWidth state (default 220, clamp 160-480), persisted to
		// localStorage key "ssb-list-width" (try/catch for privacy modes).
		// A 6px col-resize handle between the columns drives window
		// mousemove/mouseup updates. The toolbar below the header
		// consolidates the old per-row buttons, all acting on selected with
		// the disabled matrix (no selection -> all disabled; archived ->
		// 归档 disabled / 移出归档 enabled; unarchived -> 归档 enabled /
		// 移出归档 disabled; 删除/移动/迁移 enabled iff selected). Dialogs,
		// dual-refresh, and notice states are Task 5's, rewired.
		const LIST_WIDTH_KEY = "ssb-list-width";
		const LIST_WIDTH_DEFAULT = 220;
		const LIST_WIDTH_MIN = 160;
		const LIST_WIDTH_MAX = 480;
		function clampListWidth(w) {
			if (typeof w !== "number" || Number.isNaN(w)) return LIST_WIDTH_DEFAULT;
			return Math.max(LIST_WIDTH_MIN, Math.min(LIST_WIDTH_MAX, w));
		}
		function readListWidth() {
			try {
				const raw = localStorage.getItem(LIST_WIDTH_KEY);
				if (raw === null) return LIST_WIDTH_DEFAULT;
				return clampListWidth(Number(raw));
			} catch { return LIST_WIDTH_DEFAULT; }
		}

		function Panel({ onClose, ctx }) {
			const [sessions, setSessions] = useState([]);
			const [selected, setSelected] = useState(null);
			const [rounds, setRounds] = useState([]);
			const [filter, setFilter] = useState("");
			const [tab, setTab] = useState("active");
			const [loading, setLoading] = useState(false);
			const [notice, setNotice] = useState("");
			const [noticeOk, setNoticeOk] = useState(false);
			const [moveTarget, setMoveTarget] = useState(null);
			const [moveWs, setMoveWs] = useState("");
			const [wsList, setWsList] = useState([]);
			const [migrateTarget, setMigrateTarget] = useState(null);
			const [migratePreset, setMigratePreset] = useState("");
			const [listWidth, setListWidth] = useState(readListWidth());
			const inputRef = useRef(null);

			useEffect(() => { inputRef.current?.focus(); }, []);

		// The deleted tab is the only place a trashed session appears; every registry
		// has forgotten it, so actions other than restore are meaningless there.
		// Declared BEFORE reloadSessions: the render body below uses it, and a
		// later declaration would be a temporal-dead-zone ReferenceError that
		// takes the whole plugin fiber down (the sidebar button silently vanishes).
		const inTrash = tab === "deleted";

		// Load sessions + merge live displayTitle from sidebar
		const reloadSessions = (forTab) => {
			// The deleted tab reads the plugin's own trash, not the session store:
			// those sessions are still on disk but no longer accounted for anywhere.
			if (forTab === "deleted") {
				// Clear first: on failure the previous tab's rows would otherwise linger
				// under the new tab and read as if they belonged to it.
				setSessions([]);
				callApi("list-deleted", {}).then((res) => {
					if (!res?.ok) { setNotice(apiError(res, "加载回收站失败")); setNoticeOk(false); return; }
					setSessions(res.result?.items ?? []);
				});
				return;
			}
			setSessions([]);
			callApi("list-sessions", { archived: forTab === "archived" }).then((res) => {
				if (!res.ok) { setNotice(apiError(res, "加载会话列表失败")); setNoticeOk(false); return; }
				const items = res.items || [];
				// Get live display titles from sessions store (same source as sidebar)
				let liveById = {};
				try {
					const snap = ctx.sessions?.list?.getSnapshot?.();
					if (snap && snap.byId) liveById = snap.byId;
				} catch { /* ignore */ }
				const merged = items.map((item) => {
					const live = liveById[item.sessionId];
					const displayTitle = live?.displayTitle;
					return {
						...item,
						title: displayTitle || item.title || shortPath(item.cwd) || "\u672A\u547D\u540D",
					};
				});
				setSessions(merged);
			});
		};
		useEffect(() => {
			reloadSessions(tab);
		}, [tab]);

		useEffect(() => {
			if (!selected) { setRounds([]); setLoading(false); return; }
			// A trashed session shows metadata, not rounds: skip the read entirely.
			if (tab === "deleted") { setRounds([]); setLoading(false); return; }
			setLoading(true);
			callApi("list-rounds", { sessionId: selected.sessionId }).then((res) => {
				setRounds(res.ok ? res.items : []);
				setLoading(false);
			});
}, [selected, tab]);

		useEffect(() => {
			const onKey = (e) => { if (e.key === "Escape") onClose(); };
			document.addEventListener("keydown", onKey);
			return () => { document.removeEventListener("keydown", onKey); };
		}, [onClose]);

			const filtered = sessions.filter((s) =>
				s.title.toLowerCase().includes(filter.toLowerCase())
				|| s.cwd.toLowerCase().includes(filter.toLowerCase())
			);

			const panelStyle = {
				left: `${Math.max(8, Math.min((window.innerWidth - 1120) / 2, window.innerWidth - 1128))}px`,
				top: `${Math.max(8, Math.min((window.innerHeight - 960) / 2, window.innerHeight - 968))}px`,
			};

			const switchTab = (next) => {
				setTab(next);
				setSelected(null);
				setRounds([]);
				setLoading(false);
				setNotice(""); setNoticeOk(false);
			};

			// Shared module-scope refreshMovedSession (Task 6 region) covers the
			// dual-refresh; the 250/900ms delayed legs stay at each call site.
			const onArchive = async (s) => {
				setNotice(""); setNoticeOk(false);
				const res = await callApi("archive", { sessionId: s.sessionId });
				if (!res?.ok) { setNotice(apiError(res, "归档失败")); setNoticeOk(false); return; }
				if (selected?.sessionId === s.sessionId) { setSelected(null); setRounds([]); setLoading(false); }
				reloadSessions(tab);
			};

			const onUnarchive = async (s) => {
				setNotice(""); setNoticeOk(false);
				const res = await callApi("unarchive", { sessionId: s.sessionId });
				if (!res?.ok) { setNotice(apiError(res, "移出归档失败")); setNoticeOk(false); return; }
				if (selected?.sessionId === s.sessionId) { setSelected(null); setRounds([]); setLoading(false); }
				reloadSessions(tab);
			};

			const onRemove = async (s) => {
				setNotice(""); setNoticeOk(false);
				const wasCurrent = currentOpenSessionId(ctx) === s.sessionId;
				const res = await callApi("delete", { sessionId: s.sessionId });
				if (!res?.ok) { setNotice(apiError(res, "删除会话失败")); setNoticeOk(false); return; }
				// Same rule as session-manager: deleting the open session converges via
				// sessions store refresh (0.1.7 ISessions has no clear) so the main UI
				// does not show a removed session.
				if (wasCurrent) {
					try { await refreshSessionsStore(ctx); } catch { /* ignore */ }
				}
				if (selected?.sessionId === s.sessionId) { setSelected(null); setRounds([]); setLoading(false); }
				reloadSessions(tab);
			};

			const onMove = async (sessionId, targetWorkspaceId) => {
				setNotice(""); setNoticeOk(false);
				const wasCurrent = currentOpenSessionId(ctx) === sessionId;
				const res = await callApi("move", { sessionId, targetWorkspaceId });
				if (!res?.ok) { setNotice(apiError(res, "移动会话失败")); setNoticeOk(false); return; }
				setNotice("移动成功"); setNoticeOk(true);
				reloadSessions(tab);
				await refreshMovedSession(ctx, sessionId, wasCurrent);
				setTimeout(() => { refreshMovedSession(ctx, sessionId, wasCurrent); }, 250);
				setTimeout(() => { refreshMovedSession(ctx, sessionId, wasCurrent); }, 900);
			};

		const onRestore = async (s) => {
			setNotice(""); setNoticeOk(false);
			const res = await callApi("restore", { sessionId: s.sessionId });
			if (!res?.ok) {
				// The host reports the precise reason (artifacts-missing / attach-failed
				// / not-in-trash); surface it instead of a generic failure.
				const detail = typeof res?.detail === "string" && res.detail !== "" ? res.detail : apiError(res, "恢复失败");
				setNotice(detail); setNoticeOk(false); return;
			}
			setNotice(res.result?.archived ? "已恢复（回到已归档）" : "已恢复");
			setNoticeOk(true);
			if (selected?.sessionId === s.sessionId) { setSelected(null); setRounds([]); setLoading(false); }
			reloadSessions(tab);
		};

			const onMigrate = async (sessionId, toPreset) => {
				setNotice(""); setNoticeOk(false);
				const res = await callApi("preset-migrate", { sessionId, toPreset });
				if (!res?.ok) { setNotice(apiError(res, "迁移预设失败")); setNoticeOk(false); return; }
				setNotice("迁移成功"); setNoticeOk(true);
				try { await refreshSessionsStore(ctx); } catch { /* ignore */ }
				reloadSessions(tab);
				// Single 250ms delayed baseline (no 900ms leg — Task 3 record).
				setTimeout(() => {
					refreshSessionsStore(ctx);
				}, 250);
			};

			const openMoveDialog = (s) => {
				setNotice(""); setNoticeOk(false);
				setMigrateTarget(null);
				setMoveTarget(s);
				setMoveWs("");
				setWsList([]);
				callApi("workspaces", {}).then((res) => {
					const list = res?.ok ? res?.result?.workspaces : undefined;
					if (!res?.ok || !Array.isArray(list)) { setNotice(apiError(res, "加载工作区列表失败")); setNoticeOk(false); return; }
					const mapped = mapWorkspaceList(list);
					setWsList(mapped);
					if (mapped.length > 0) setMoveWs(mapped[0].id);
				});
			};

			const openMigrateDialog = (s) => {
				setNotice(""); setNoticeOk(false);
				setMoveTarget(null);
				setMigrateTarget(s);
				setMigratePreset("");
			};

			const onColResizeStart = (e) => {
				if (e.button !== 0) return;
				try { e.preventDefault(); } catch { /* ignore */ }
				const startX = e.clientX;
				const startW = listWidth;
				const onMove = (ev) => {
					const next = clampListWidth(startW + (ev.clientX - startX));
					setListWidth(next);
					try { localStorage.setItem(LIST_WIDTH_KEY, String(next)); } catch { /* ignore */ }
				};
				const onUp = () => {
					window.removeEventListener("mousemove", onMove);
					window.removeEventListener("mouseup", onUp);
				};
				window.addEventListener("mousemove", onMove);
				window.addEventListener("mouseup", onUp);
			};

			const onWinResizeStart = (e) => {
				if (e.button !== 0) return;
				try { e.preventDefault(); } catch { /* ignore */ }
				const startX = e.clientX;
				const startY = e.clientY;
				const panelEl = document.querySelector(".ssb_panel");
				if (!panelEl) return;
				const startW = panelEl.offsetWidth;
				const startH = panelEl.offsetHeight;
				const minW = 400;
				const minH = 300;
				const maxW = window.innerWidth - 16;
				const maxH = window.innerHeight - 16;
				const onMove = (ev) => {
					const nextW = Math.max(minW, Math.min(maxW, startW + (ev.clientX - startX)));
					const nextH = Math.max(minH, Math.min(maxH, startH + (ev.clientY - startY)));
					panelEl.style.width = nextW + "px";
					panelEl.style.height = nextH + "px";
				};
				const onUp = () => {
					window.removeEventListener("mousemove", onMove);
					window.removeEventListener("mouseup", onUp);
				};
				window.addEventListener("mousemove", onMove);
				window.addEventListener("mouseup", onUp);
			};

			const onHeaderMouseDown = (e) => {
				if (e.button !== 0) return;
				if (e.target && e.target.closest && e.target.closest("button, select, input")) return;
				try { e.preventDefault(); } catch { /* ignore */ }
				const panelEl = document.querySelector(".ssb_panel");
				if (!panelEl) return;
				const startX = e.clientX;
				const startY = e.clientY;
				const rect = panelEl.getBoundingClientRect();
				const startLeft = rect.left;
				const startTop = rect.top;
				const onMove = (ev) => {
					const nextLeft = Math.max(8, Math.min(window.innerWidth - panelEl.offsetWidth - 8, startLeft + (ev.clientX - startX)));
					const nextTop = Math.max(8, Math.min(window.innerHeight - panelEl.offsetHeight - 8, startTop + (ev.clientY - startY)));
					panelEl.style.left = nextLeft + "px";
					panelEl.style.top = nextTop + "px";
				};
				const onUp = () => {
					window.removeEventListener("mousemove", onMove);
					window.removeEventListener("mouseup", onUp);
				};
				window.addEventListener("mousemove", onMove);
				window.addEventListener("mouseup", onUp);
			};

			const toolBtn = (label, disabled, onPress) =>
				react.createElement("button", {
					key: label,
					type: "button",
					disabled,
					onClick: onPress,
					style: {
						border: "1px solid var(--dsw-alias-border-l2)",
						background: "transparent",
						color: "var(--dsw-alias-label-secondary)",
						fontSize: "11px",
						lineHeight: "16px",
						padding: "1px 8px",
						borderRadius: "6px",
						cursor: disabled ? "default" : "pointer",
						opacity: disabled ? 0.45 : 1,
						whiteSpace: "nowrap",
					},
				}, label);

			const tabBtn = (id, label) =>
				react.createElement("button", {
					key: id,
					type: "button",
					role: "tab",
					"aria-selected": tab === id,
					onClick: () => switchTab(id),
					style: {
						border: "none",
						background: tab === id ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
						color: tab === id ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)",
						fontWeight: tab === id ? 600 : 400,
						fontSize: "12px",
						lineHeight: "18px",
						padding: "2px 10px",
						borderRadius: "6px",
						cursor: "pointer",
					},
				}, label);

			const sessionListItems = filtered.length === 0
				? react.createElement("div", { className: "ssb_empty" },
					sessions.length === 0
						? (inTrash ? "回收站是空的" : "暂无会话")
						: "没有匹配的会话")
				: filtered.map((s) =>
					react.createElement("div", {
						key: s.sessionId,
						className: `ssb_sessionItem${selected?.sessionId === s.sessionId ? " ssb_sessionItemActive" : ""}`,
						onClick: () => {
							setSelected(s);
							// Trashed sessions are detached from every registry: there
							// is nothing to expand or open, and the right column shows
							// its metadata instead of rounds.
							if (s.archived || inTrash) return;
							// Expand collapsed workspace group before opening
							try {
								if (s.cwd) {
									const workspaces = listClientWorkspaceItems(ctx);
									for (const ws of workspaces) {
										const wsPath = ws.path || "";
										if (s.cwd === wsPath || s.cwd.startsWith(wsPath + "/") || s.cwd.startsWith(wsPath + "\\")) {
											expandGroupForKey(ws.workspaceId || ws.id || wsPath);
											break;
										}
									}
								}
							} catch { /* ignore */ }
							// Expand all collapsed session overflow buttons in sidebar
							expandAllSessionOverflows();
							void openSessionById(ctx, s.sessionId);
						}
					},
						react.createElement("div", { className: "ssb_sessionTitle" }, s.title || "(未命名)"),
						react.createElement("div", { className: "ssb_sessionMeta" }, fmtTime(s.updatedAt) || fmtTime(s.createdAt))
					)
				);

			const roundListContent = loading
				? react.createElement("div", { className: "ssb_status" }, "加载中…")
				: !selected
					? react.createElement("div", { className: "ssb_empty" }, "← 点击左侧会话查看轮次")
					: rounds.length === 0
						? react.createElement("div", { className: "ssb_empty" }, "该会话无用户提问")
						: rounds.map((r) => {
							const __props = { key: r.seq, className: "ssb_roundItem" };
							if (!selected.archived) __props.onClick = () => jumpToMessage(ctx, selected.sessionId, r.seq, r.eventId, r.messageId, r.anchorKey);
							else __props.style = { cursor: "default" };
							return react.createElement("div", __props,
								react.createElement("div", { className: "ssb_roundContent" }, `Q${r.turnIndex + 1}: ${r.content}`),
								react.createElement("div", { className: "ssb_roundMeta" }, fmtTime(r.time))
							);
						});

			const hasSel = selected !== null;
			const selArchived = selected?.archived === true;

			return reactDom.createPortal(react.createElement("div", { key: "ssb-root" },
				react.createElement("div", { key: "backdrop", className: "ssb_backdrop", onClick: onClose }),
				react.createElement("div", {
					key: "panel",
					className: "ssb_panel",
					style: panelStyle,
					role: "dialog",
					"aria-label": "会话浏览",
				},
					react.createElement("div", { key: "header", className: "ssb_header", onMouseDown: onHeaderMouseDown },
						react.createElement("div", {
							key: "titleGroup",
							style: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0, flex: 1, cursor: "move" },
						},
							react.createElement("span", { className: "ssb_headerTitle" }, "会话浏览"),
							react.createElement("div", {
								key: "tabs",
								role: "tablist",
								"aria-label": "归档筛选",
								style: { display: "inline-flex", gap: "2px", padding: "2px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px" },
							}, [tabBtn("active", "未归档"), tabBtn("archived", "已归档"), tabBtn("deleted", "已删除")])
						),
						react.createElement("button", { className: "ssb_closeBtn", onClick: onClose, title: "关闭" }, closeIcon())
					),
					react.createElement("div", {
						key: "toolbar",
						style: {
							display: "flex",
							flexWrap: "wrap",
							gap: "6px",
							padding: "6px 12px",
							borderBottom: "1px solid var(--dsw-alias-border-l2)",
							flex: "none",
						},
					},
					// Six actions, one row. The disabled matrix is tab-driven: a trashed
					// session has left every registry, so only "恢复删除" applies to it.
					toolBtn("归档", !hasSel || selArchived || inTrash, () => { if (selected) onArchive(selected); }),
					toolBtn("移出归档", !hasSel || !selArchived || inTrash, () => { if (selected) onUnarchive(selected); }),
					toolBtn("删除", !hasSel || inTrash, () => { if (selected) onRemove(selected); }),
					toolBtn("恢复删除", !hasSel || !inTrash, () => { if (selected) onRestore(selected); }),
					toolBtn("移动", !hasSel || inTrash, () => { if (selected) openMoveDialog(selected); }),
					toolBtn("迁移", !hasSel || inTrash, () => { if (selected) openMigrateDialog(selected); })
				),
					notice
						? react.createElement("div", {
							key: "notice",
							style: {
								flex: "none",
								fontSize: "11px",
								lineHeight: "16px",
								color: noticeOk ? "var(--dsw-alias-state-success, #1a7f37)" : "var(--dsw-alias-state-danger, #c53b3b)",
								padding: "6px 12px",
								borderBottom: "1px solid var(--dsw-alias-border-l2)",
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
							},
						}, notice)
						: null,
					react.createElement("div", { key: "body", className: "ssb_body" },
						react.createElement("div", { key: "sessions", className: "ssb_sessionList", style: { width: listWidth + "px" } },
							react.createElement("input", {
								ref: inputRef,
								className: "ssb_search",
								type: "text",
								placeholder: "搜索会话…",
								value: filter,
								onChange: (e) => setFilter(e.target.value),
							}),
							react.createElement("div", { className: "ssb_scroll" }, sessionListItems)
						),
						// Column resize handle (Task 3.0.1): 6px, col-resize, inline style only
						react.createElement("div", {
							key: "colResize",
							role: "separator",
							"aria-orientation": "vertical",
							"aria-label": "调整列表宽度",
							title: "拖动调整列表宽度",
							onMouseDown: onColResizeStart,
							style: { width: "6px", flex: "none", cursor: "col-resize" },
						}),
						react.createElement("div", { key: "rounds", className: "ssb_roundList" },
							selected
								? react.createElement("div", { className: "ssb_roundTitle" }, selected.title || "(未命名)")
								: react.createElement("div", { className: "ssb_roundTitle" }, "选择一个会话"),
							// A trashed session is off every registry, so "rounds" and
							// "jump to message" do not apply; show what a restore needs instead.
							inTrash && selected
								? react.createElement("div", { className: "ssb_scroll" },
									react.createElement("div", { className: "ssb_status", style: { padding: "8px 12px" } },
										react.createElement("div", null, `项目目录：${selected.cwd || "(未知)"}`),
										react.createElement("div", null, `删除时间：${fmtTime(selected.deletedAt ?? selected.updatedAt) || "未知"}`),
										react.createElement("div", null, `删除前状态：${selected.archived ? "已归档" : "未归档"}`),
										react.createElement("div", { style: { marginTop: "6px", color: "var(--dsw-alias-label-tertiary)" } },
											"会话文件仍保留在磁盘上，点「恢复删除」可放回原项目工作区。")
									)
								)
								: null,
							selected?.archived && !inTrash
								? react.createElement("div", {
									key: "archivedNote",
									style: { flex: "none", fontSize: "11px", color: "var(--dsw-alias-label-tertiary)", padding: "6px 12px 2px" },
								}, "已归档会话仅浏览，不跳转")
								: null,
							!inTrash ? react.createElement("div", { className: "ssb_scroll" }, roundListContent) : null
						),
						// 右下角标：拖动调整窗口大小
						react.createElement("div", {
							key: "winResize",
							role: "separator",
							"aria-orientation": "both",
							"aria-label": "调整窗口大小",
							title: "拖动调整窗口大小",
							onMouseDown: onWinResizeStart,
							style: {
								position: "absolute",
								right: 0,
								bottom: 0,
								width: "16px",
								height: "16px",
								cursor: "se-resize",
								background: "linear-gradient(-45deg, transparent 50%, var(--dsw-alias-border-l2) 50%, var(--dsw-alias-border-l2) 60%, transparent 60%)",
								zIndex: 10,
							},
						})
					),
					moveTarget
						? react.createElement("div", {
							key: "moveDlg",
							onClick: (e) => { try { e.stopPropagation(); } catch { /* ignore */ } },
							style: {
								position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
								background: "rgba(0,0,0,0.25)", zIndex: 1,
							},
						},
							react.createElement("div", {
								style: {
									width: "300px", maxWidth: "calc(100% - 32px)", background: "var(--dsw-specific-tip)",
									border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px", padding: "12px",
									boxShadow: "0 8px 28px rgba(0,0,0,.16)",
								},
							},
								react.createElement("div", { style: { fontSize: "13px", fontWeight: 600, marginBottom: "4px" } }, "移动会话"),
								react.createElement("div", {
									style: { fontSize: "11px", color: "var(--dsw-alias-label-secondary)", marginBottom: "8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
								}, moveTarget.title || "(未命名)"),
								react.createElement("select", {
									value: moveWs,
									onChange: (e) => setMoveWs(e.target.value),
									style: { width: "100%", fontSize: "12px", padding: "4px 6px", marginBottom: "10px" },
								}, wsList.map((w) => react.createElement("option", { key: w.id, value: w.id }, w.title || w.name || w.path || w.id))),
								react.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px" } },
									react.createElement("button", { type: "button", onClick: () => setMoveTarget(null) }, "取消"),
									react.createElement("button", {
										type: "button",
										onClick: () => {
											const t = moveTarget;
											const ws = moveWs;
											if (!t) return;
											if (!ws) { setNotice("请选择目标工作区"); setNoticeOk(false); return; }
											setMoveTarget(null);
											onMove(t.sessionId, ws);
										},
									}, "确认")
								)
							)
						)
						: null,
					migrateTarget
						? react.createElement("div", {
							key: "migrateDlg",
							onClick: (e) => { try { e.stopPropagation(); } catch { /* ignore */ } },
							style: {
								position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
								background: "rgba(0,0,0,0.25)", zIndex: 1,
							},
						},
							react.createElement("div", {
								style: {
									width: "300px", maxWidth: "calc(100% - 32px)", background: "var(--dsw-specific-tip)",
									border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px", padding: "12px",
									boxShadow: "0 8px 28px rgba(0,0,0,.16)",
								},
							},
								react.createElement("div", { style: { fontSize: "13px", fontWeight: 600, marginBottom: "4px" } }, "迁移预设"),
								react.createElement("div", {
									style: { fontSize: "11px", color: "var(--dsw-alias-label-secondary)", marginBottom: "8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
								}, migrateTarget.title || "(未命名)"),
								react.createElement("input", {
									type: "text",
									placeholder: "目标预设",
									value: migratePreset,
									onChange: (e) => setMigratePreset(e.target.value),
									style: { width: "100%", boxSizing: "border-box", fontSize: "12px", padding: "4px 6px", marginBottom: "10px" },
								}),
								react.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px" } },
									react.createElement("button", { type: "button", onClick: () => setMigrateTarget(null) }, "取消"),
									react.createElement("button", {
										type: "button",
										onClick: () => {
											const t = migrateTarget;
											const p = migratePreset.trim();
											if (!t) return;
											if (!p) { setNotice("目标预设不能为空"); setNoticeOk(false); return; }
											setMigrateTarget(null);
											onMigrate(t.sessionId, p);
										},
									}, "确认")
								)
							)
						)
						: null
				)
			), document.body);
		}

		function SidebarButton({ ctx }) {
			const [open, setOpen] = useState(false);
			const buttonRef = useRef(null);

			return react.createElement("div", { className: "ssb_root" },
				react.createElement("button", {
					ref: buttonRef,
					type: "button",
					className: "ssb_button",
					title: "会话浏览",
					"aria-label": "会话浏览",
					"aria-expanded": open,
					onClick: () => setOpen(true),
				}, [browseIcon(), react.createElement("span", null, "会话浏览")]),
				open && react.createElement(Panel, { key: "panel", onClose: () => setOpen(false), ctx })
			);
		}

		//#endregion

		//#region Task 6: header actions (logic mirror of src/client/index.ts)
		// Port of dsh-session-manager HeaderAction (+ ConfirmDialog + MoveDialog)
		// with ZERO behavior change. Deliberate adaptations, all per brief:
		// - NO locale service: the Chinese copy below is the old
		//   session-manager zh dictionary verbatim (归档/移出归档/移动至工作区/
		//   删除会话/删除会话…不可撤销/移动会话到工作区…/
		//   没有可移动到的其他工作区/选择目标工作区/确认删除/
		//   确认移动/取消/操作失败：{message}).
		// - API base is this plugin's callApi ('archive' / 'unarchive' /
		//   'delete' / 'move' / 'workspaces' routes) instead of
		//   session-manager's paths.
		// - Archived state comes from `list-sessions { archived: true }` (this
		//   client has no useWorkspaces hook; inject stays ['slots','sessions'],
		//   workspaces is reached lazily only for refresh, like
		//   listClientWorkspaceItems).
		// - Dialogs render via createPortal + inline styles (CSS block untouched).
		function headerAnchorFor(el) {
			if (!el || typeof el.getBoundingClientRect !== "function") return null;
			const r = el.getBoundingClientRect();
			return {
				top: Math.round(r.top + r.height + 6),
				left: Math.max(8, Math.round(r.right - 320)),
			};
		}
		function headerCardStyle(anchor) {
			const base = {
				width: "300px",
				maxWidth: "calc(100% - 32px)",
				background: "var(--dsw-specific-tip)",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: "10px",
				padding: "12px",
				boxShadow: "0 8px 28px rgba(0,0,0,.16)",
			};
			if (anchor) {
				base.position = "fixed";
				base.top = anchor.top + "px";
				base.left = anchor.left + "px";
				base.zIndex = "2147483001";
			}
			return base;
		}
		function HeaderConfirmDialog({ open, title, description, confirmLabel, cancelLabel, anchor, onCancel, onConfirm }) {
			if (!open) return null;
			const centered = anchor === null;
			return reactDom.createPortal(react.createElement("div", {
				role: "presentation",
				tabIndex: -1,
				onKeyDown: (e) => {
					if (e.key === "Escape") { e.preventDefault(); onCancel(); }
					else if (e.key === "Enter") { e.preventDefault(); onConfirm(); }
				},
				style: centered
					? { position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.25)", zIndex: 2147483001 }
					: { position: "fixed", inset: 0, zIndex: 2147483001, background: "transparent" },
			},
				centered ? null : react.createElement("div", {
					onMouseDown: (e) => { if (e.target === e.currentTarget) onCancel(); },
					style: { position: "fixed", inset: 0, background: "transparent" },
				}),
				react.createElement("section", {
					role: "dialog", "aria-modal": "true",
					ref: (el) => { if (el && typeof el.focus === "function") el.focus(); },
					style: headerCardStyle(anchor),
				},
					react.createElement("div", { style: { fontSize: "13px", fontWeight: 600, marginBottom: "4px" } }, title),
					description
						? react.createElement("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)", marginBottom: "10px", wordBreak: "break-word" } }, description)
						: null,
					react.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px" } },
						react.createElement("button", { type: "button", onClick: onCancel }, cancelLabel),
						react.createElement("button", { type: "button", onClick: onConfirm }, confirmLabel)
					)
				)
			), document.body);
		}
		function HeaderMoveDialog({ open, title, description, workspaces, currentWorkspaceId, confirmLabel, cancelLabel, anchor, onCancel, onConfirm }) {
			const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
			if (!open) return null;
			const list = (Array.isArray(workspaces) ? workspaces : [])
				.filter((ws) => ws && typeof ws === "object" && typeof ws.id === "string" && ws.id !== currentWorkspaceId);
			const centered = anchor === null;
			return reactDom.createPortal(react.createElement("div", {
				role: "presentation",
				tabIndex: -1,
				onKeyDown: (e) => {
					if (e.key === "Escape") { e.preventDefault(); onCancel(); }
					else if (e.key === "Enter" && selectedWorkspaceId !== "" && list.length > 0) { e.preventDefault(); onConfirm(selectedWorkspaceId); }
				},
				style: centered
					? { position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.25)", zIndex: 2147483001 }
					: { position: "fixed", inset: 0, zIndex: 2147483001, background: "transparent" },
			},
				centered ? null : react.createElement("div", {
					onMouseDown: (e) => { if (e.target === e.currentTarget) onCancel(); },
					style: { position: "fixed", inset: 0, background: "transparent" },
				}),
				react.createElement("section", {
					role: "dialog", "aria-modal": "true",
					ref: (el) => { if (el && typeof el.focus === "function") el.focus(); },
					style: headerCardStyle(anchor),
				},
					react.createElement("div", { style: { fontSize: "13px", fontWeight: 600, marginBottom: "4px" } }, title),
					react.createElement("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)", marginBottom: "8px", wordBreak: "break-word" } }, description),
					list.length === 0
						? react.createElement("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)", marginBottom: "10px" } }, "没有可移动到的其他工作区。")
						: react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "8px", marginBottom: "10px" } },
							react.createElement("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" } }, "选择目标工作区"),
							react.createElement("div", { role: "listbox", "aria-label": "选择目标工作区", style: { display: "flex", flexDirection: "column", gap: "4px", maxHeight: "200px", overflow: "auto" } },
								list.map((ws) => react.createElement("button", {
									key: ws.id,
									type: "button",
									role: "option",
									"aria-selected": selectedWorkspaceId === ws.id,
									onClick: () => setSelectedWorkspaceId(ws.id),
									style: {
										display: "flex", alignItems: "center", justifyContent: "space-between",
										padding: "8px 12px", cursor: "pointer", textAlign: "left",
										border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px",
										background: selectedWorkspaceId === ws.id ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
										borderColor: selectedWorkspaceId === ws.id ? "var(--dsw-alias-state-business-primary)" : "var(--dsw-alias-border-l2)",
									},
								},
									react.createElement("span", { style: { fontSize: "13px", color: "var(--dsw-alias-label-primary)" } }, String(ws.title || ws.name || ws.id)),
									react.createElement("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" } }, ws.path ? String(ws.path) : "")
								))
							)
						),
					react.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px" } },
						react.createElement("button", { type: "button", onClick: onCancel }, cancelLabel),
						react.createElement("button", {
							type: "button",
							disabled: selectedWorkspaceId === "" || list.length === 0,
							onClick: () => { if (selectedWorkspaceId !== "") onConfirm(selectedWorkspaceId); },
						}, confirmLabel)
					)
				)
			), document.body);
		}
		function HeaderAction({ ctx, sessionId }) {
			const [archived, setArchived] = useState(false);
			const [confirmFor, setConfirmFor] = useState(null);
			const [confirmAnchor, setConfirmAnchor] = useState(null);
			const [moveFor, setMoveFor] = useState(null);
			const [moveAnchor, setMoveAnchor] = useState(null);
			const [workspaces, setWorkspaces] = useState([]);

			// Archived state: this client has no useWorkspaces hook, so read the
			// host-authoritative set via list-sessions (same archivedSessionIds
			// source the host filters by). Re-read per session + after our own
			// toggles below.
			useEffect(() => {
				let alive = true;
				setArchived(false);
				if (typeof sessionId === "string" && sessionId !== "") {
					callApi("list-sessions", { archived: true }).then((res) => {
						if (!alive) return;
						const items = res?.ok ? res?.items : undefined;
						if (Array.isArray(items) && items.some((i) => i?.sessionId === sessionId)) setArchived(true);
					});
				}
				return () => { alive = false; };
			}, [sessionId]);

			// Mirror of the session-manager HeaderAction workspaces effect.
			useEffect(() => {
				if (!moveFor) { setWorkspaces([]); return; }
				let alive = true;
				callApi("workspaces", {}).then((res) => {
					if (!alive) return;
					if (res?.ok) setWorkspaces(mapWorkspaceList(res?.result?.workspaces));
				});
				return () => { alive = false; };
			}, [moveFor ? moveFor.id : null]);

			// Mirror of session-manager runWithAlert: errors surface via
			// window.alert with the hardcoded Chinese template (host error
			// strings only, no secrets).
			const runWithAlert = (fn) => {
				return Promise.resolve()
					.then(() => fn())
					.catch((e) => {
						try {
							const msg = e instanceof Error ? e.message : String(e);
							window.alert("操作失败：{message}".replace("{message}", msg));
						} catch { /* ignore */ }
					});
			};

			const doArchive = () => runWithAlert(async () => {
				const res = await callApi("archive", { sessionId });
				if (!res?.ok) throw new Error(apiError(res, "归档失败"));
				setArchived(true);
				try { await Promise.allSettled([refreshWorkspacesStore(ctx), refreshSessionsStore(ctx)]); } catch { /* ignore */ }
			});

			const doUnarchive = () => runWithAlert(async () => {
				const res = await callApi("unarchive", { sessionId });
				if (!res?.ok) throw new Error(apiError(res, "移出归档失败"));
				setArchived(false);
				try { await Promise.allSettled([refreshWorkspacesStore(ctx), refreshSessionsStore(ctx)]); } catch { /* ignore */ }
			});

			const doRemove = (id) => runWithAlert(async () => {
				const wasCurrent = currentOpenSessionId(ctx) === id;
				const res = await callApi("delete", { sessionId: id });
				if (!res?.ok) throw new Error(apiError(res, "删除会话失败"));
				// Same rule as session-manager: deleting the open session converges via
				// sessions store refresh (0.1.7 ISessions has no clear) so the main UI
				// does not show a removed session.
				if (wasCurrent) {
					try { await refreshSessionsStore(ctx); } catch { /* ignore */ }
				}
				try { await Promise.allSettled([refreshWorkspacesStore(ctx), refreshSessionsStore(ctx)]); } catch { /* ignore */ }
			});

			const doMove = (id, targetWorkspaceId) => runWithAlert(async () => {
				const wasCurrent = currentOpenSessionId(ctx) === id;
				const res = await callApi("move", { sessionId: id, targetWorkspaceId });
				if (!res?.ok) throw new Error(apiError(res, "移动会话失败"));
				await refreshMovedSession(ctx, id, wasCurrent);
				setTimeout(() => { refreshMovedSession(ctx, id, wasCurrent); }, 250);
				setTimeout(() => { refreshMovedSession(ctx, id, wasCurrent); }, 900);
			});

			if (typeof sessionId !== "string" || sessionId === "") return null;

			const headerBtn = (label, active, props) =>
				react.createElement("button", {
					type: "button",
					"aria-label": label,
					...props,
					style: {
						boxSizing: "border-box",
						minHeight: "28px",
						display: "inline-flex",
						alignItems: "center",
						gap: "4px",
						padding: "3px 10px",
						fontSize: "12px",
						lineHeight: "18px",
						whiteSpace: "nowrap",
						color: "var(--dsw-alias-label-secondary)",
						background: active ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
						border: "1px solid var(--dsw-alias-border-l2)",
						borderRadius: "999px",
						cursor: "pointer",
					},
				}, label);

			return react.createElement("div", { style: { display: "flex", alignItems: "center", gap: "6px" } },
				headerBtn(archived ? "移出归档" : "归档", archived, {
					key: "archive",
					onClick: () => { if (archived) void doUnarchive(); else void doArchive(); },
				}),
				headerBtn("移动至工作区", moveFor !== null, {
					key: "move",
					onClick: (e) => {
						try { e.stopPropagation(); } catch { /* ignore */ }
						setConfirmFor(null);
						setConfirmAnchor(null);
						if (moveFor && moveFor.id === sessionId) {
							setMoveFor(null);
							setMoveAnchor(null);
						} else {
							setMoveAnchor(headerAnchorFor(e.currentTarget));
							setMoveFor({ id: sessionId, displayTitle: sessionId, workspaceId: "" });
						}
					},
				}),
				headerBtn("删除会话", confirmFor !== null, {
					key: "delete",
					onClick: (e) => {
						try { e.stopPropagation(); } catch { /* ignore */ }
						setMoveFor(null);
						setMoveAnchor(null);
						if (confirmFor && confirmFor.id === sessionId) {
							setConfirmFor(null);
							setConfirmAnchor(null);
						} else {
							setConfirmAnchor(headerAnchorFor(e.currentTarget));
							setConfirmFor({ id: sessionId, displayTitle: sessionId });
						}
					},
				}),
				confirmFor
					? react.createElement(HeaderConfirmDialog, {
						key: "deleteConfirm",
						open: true,
						anchor: confirmAnchor,
						onCancel: () => { setConfirmFor(null); setConfirmAnchor(null); },
						onConfirm: () => {
							const target = confirmFor;
							setConfirmFor(null);
							setConfirmAnchor(null);
							void doRemove(target.id);
						},
						title: "删除会话",
						description: "会话「{title}」将被永久删除，包括其全部消息记录与磁盘文件，此操作不可撤销。"
							.replace("{title}", confirmFor.displayTitle || confirmFor.id),
						confirmLabel: "确认删除",
						cancelLabel: "取消",
					})
					: null,
				moveFor
					? react.createElement(HeaderMoveDialog, {
						key: "moveDialog",
						open: true,
						anchor: moveAnchor,
						workspaces,
						currentWorkspaceId: moveFor.workspaceId || "",
						onCancel: () => { setMoveFor(null); setMoveAnchor(null); },
						onConfirm: (targetWorkspaceId) => {
							const target = moveFor;
							setMoveFor(null);
							setMoveAnchor(null);
							void doMove(target.id, targetWorkspaceId);
						},
						title: "移动会话到工作区",
						description: "将会话「{title}」移动到目标工作区。"
							.replace("{title}", moveFor.displayTitle || moveFor.id),
						confirmLabel: "确认移动",
						cancelLabel: "取消",
					})
					: null
			);
		}

		//#endregion

		//#region plugin
		const inject = ["slots", "sessions", "uiWorkspace"];

		function apply(ctx) {
			ctx.effect(() => injectStyles(), "dsh-session-browser: stylesheet");
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			slots.inject("sidebar.footer.action", () => slots.register(
				{ name: "sidebar.footer.action", id: "dsh-session-browser", order: 20 },
				() => react.createElement(SidebarButton, { ctx })
			));
			slots.inject("conversation.session.header.actions", () => slots.register(
				{ name: "conversation.session.header.actions", id: "session-manager-header", order: 40 },
				(slotProps) => react.createElement(HeaderAction, { ctx, ...slotProps })
			));
		}

		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
