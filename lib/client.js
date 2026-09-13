window.__ModuleLoader__.load({
	id: "dsh-session-browser",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const reactDom = require("react-dom");
		const { useState, useEffect, useRef, useCallback } = react;

		//#region styles
		const CSS = `
/* sidebar.footer.action layout: ensures all plugin buttons are visible in compatibility mode.
   In extended/advanced mode the Desktop's own CSS (with !important) overrides this. */
[data-slot="sidebar.footer.action"]{display:flex!important;flex-direction:column;gap:6px;min-width:0;width:100%;max-height:min(40vh,240px);overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
[data-slot="sidebar.footer.action"]>*{flex:none;min-width:0}
.ssb_root{box-sizing:border-box;position:relative;display:flex;align-items:center;flex:none;width:100%}
.ssb_footerBtn{min-height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:6px;padding:3px 8px;font-size:12px;line-height:18px;display:inline-flex}
.ssb_footerBtn:hover,.ssb_footerBtn:focus-visible{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}
.ssb_footerBtn svg{flex:none}
.ssb_backdrop{position:fixed;inset:0;z-index:2147482999;background:transparent}
.ssb_dialog{position:fixed;z-index:2147483000;display:flex;flex-direction:column;background:var(--dsw-alias-surface-l1,#fff);color:var(--dsw-alias-label-primary,#111);border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.25);overflow:hidden;font-family:Inter,var(--dsw-font-family)}
.ssb_header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;cursor:move;user-select:none}
.ssb_headerTitle{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ssb_closeBtn{border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:2px 9px;font-size:12px;line-height:18px}
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
.ssb_resize{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;z-index:1}
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
		async function jumpToMessage(ctx, sessionId, eventSeq, eventId) {
			try { ctx.sessions?.open?.(sessionId); } catch { /* ignore */ }
			// Phase 1: page the virtualized event window backwards until it covers the
			// target seq, so the anchor element actually renders. The previous
			// ".F-sbyG_older" button hack is dead: that CSS-module hash no longer
			// exists in the 2.05 frontend build. No-op fallback on hosts without
			// SessionFace.loadThrough (e.g. desktop 2.0.4).
			try { await ensureWindowCovers(ctx.sessions, sessionId, eventSeq, 15000); } catch { /* ignore */ }
			// Phase 2: anchor scroll (unchanged behavior).
			const anchorKey = `13:input-message${eventId}`;
			let attempts = 0;
			const tryScroll = () => {
				const el = document.querySelector(`[data-chat-anchor-key="${anchorKey}"]`);
				if (el) {
					el.scrollIntoView({ behavior: "smooth", block: "center" });
					return;
				}
				if (attempts < 50) {
					attempts++;
					setTimeout(tryScroll, 200);
				}
			};
			setTimeout(tryScroll, 800);
		}

		function Panel({ onClose, ctx }) {
			const [sessions, setSessions] = useState([]);
			const [selected, setSelected] = useState(null);
			const [rounds, setRounds] = useState([]);
			const [filter, setFilter] = useState("");
			const [tab, setTab] = useState("active");
			const [loading, setLoading] = useState(false);
			const inputRef = useRef(null);
			const dialogRef = useRef(null);
			const headerRef = useRef(null);
			const [pos, setPos] = useState({ x: 0, y: 0 });
			const [size, setSize] = useState({ w: 760, h: 520 });
			const dragging = useRef(null);
			const resizing = useRef(null);

			// Center on mount
			useEffect(() => {
				const w = Math.min(760, window.innerWidth - 32);
				const h = Math.min(520, window.innerHeight - 32);
				setSize({ w, h });
				setPos({ x: Math.round((window.innerWidth - w) / 2), y: Math.round((window.innerHeight - h) / 2) });
			}, []);

			useEffect(() => { inputRef.current?.focus(); }, []);

		// Load sessions + merge live displayTitle from sidebar
		useEffect(() => {
			callApi("list-sessions", { archived: tab === "archived" }).then((res) => {
				if (!res.ok) return;
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
		}, [tab]);

			useEffect(() => {
				if (!selected) { setRounds([]); setLoading(false); return; }
				setLoading(true);
				callApi("list-rounds", { sessionId: selected.sessionId }).then((res) => {
					setRounds(res.ok ? res.items : []);
					setLoading(false);
				});
			}, [selected]);

			useEffect(() => {
				const onKey = (e) => { if (e.key === "Escape") onClose(); };
				document.addEventListener("keydown", onKey);
				return () => { document.removeEventListener("keydown", onKey); };
			}, [onClose]);

			// Drag handlers
			const onMouseDownDrag = useCallback((e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				dragging.current = { startX: e.clientX - pos.x, startY: e.clientY - pos.y };
				const onMove = (ev) => {
					if (!dragging.current) return;
					setPos({
						x: Math.max(0, Math.min(window.innerWidth - 40, ev.clientX - dragging.current.startX)),
						y: Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dragging.current.startY)),
					});
				};
				const onUp = () => {
					dragging.current = null;
					document.removeEventListener("mousemove", onMove);
					document.removeEventListener("mouseup", onUp);
				};
				document.addEventListener("mousemove", onMove);
				document.addEventListener("mouseup", onUp);
			}, [pos]);

			// Resize handlers
			const onMouseDownResize = useCallback((e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				e.stopPropagation();
				resizing.current = { startX: e.clientX, startY: e.clientY, startW: size.w, startH: size.h };
				const onMove = (ev) => {
					if (!resizing.current) return;
					const r = resizing.current;
					setSize({
						w: Math.max(480, Math.min(window.innerWidth - 16, r.startW + (ev.clientX - r.startX))),
						h: Math.max(280, Math.min(window.innerHeight - 16, r.startH + (ev.clientY - r.startY))),
					});
				};
				const onUp = () => {
					resizing.current = null;
					document.removeEventListener("mousemove", onMove);
					document.removeEventListener("mouseup", onUp);
				};
				document.addEventListener("mousemove", onMove);
				document.addEventListener("mouseup", onUp);
			}, [size]);

			const filtered = sessions.filter((s) =>
				s.title.toLowerCase().includes(filter.toLowerCase())
				|| s.cwd.toLowerCase().includes(filter.toLowerCase())
			);

			const switchTab = (next) => {
				setTab(next);
				setSelected(null);
				setRounds([]);
				setLoading(false);
			};

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
				? react.createElement("div", { className: "ssb_empty" }, sessions.length === 0 ? "暂无会话" : "没有匹配的会话")
				: filtered.map((s) =>
					react.createElement("div", {
						key: s.sessionId,
						className: `ssb_sessionItem${selected?.sessionId === s.sessionId ? " ssb_sessionItemActive" : ""}`,
						onClick: () => {
							setSelected(s);
							if (s.archived) return;
							try {
								if (s.cwd) {
									const __wsSnap = ctx.get?.("workspaces")?.list?.getSnapshot?.();
									const workspaces = (__wsSnap && __wsSnap.items) || __wsSnap || [];
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
							try { ctx.sessions.open(s.sessionId); } catch { /* ignore */ }
						}
					},
						react.createElement("div", { className: "ssb_sessionTitle" }, s.title),
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
							if (!selected.archived) __props.onClick = () => jumpToMessage(ctx, selected.sessionId, r.seq, r.eventId);
							else __props.style = { cursor: "default" };
							return react.createElement("div", __props,
								react.createElement("div", { className: "ssb_roundContent" }, `Q${r.turnIndex + 1}: ${r.content}`),
								react.createElement("div", { className: "ssb_roundMeta" }, fmtTime(r.time))
							);
						});

			return reactDom.createPortal(react.createElement("div", { key: "ssb-root" },
				react.createElement("div", { key: "backdrop", className: "ssb_backdrop", onClick: onClose }),
				react.createElement("div", {
					key: "dialog",
					ref: dialogRef,
					className: "ssb_dialog",
					style: { left: pos.x + "px", top: pos.y + "px", width: size.w + "px", height: size.h + "px" },
					role: "dialog",
					"aria-label": "会话浏览",
				},
					react.createElement("div", {
						ref: headerRef,
						className: "ssb_header",
						onMouseDown: onMouseDownDrag,
					},
						react.createElement("div", {
							key: "titleGroup",
							style: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0 },
						},
							react.createElement("span", { className: "ssb_headerTitle" }, "会话浏览"),
							react.createElement("div", {
								key: "tabs",
								role: "tablist",
								"aria-label": "归档筛选",
								style: { display: "inline-flex", gap: "2px", padding: "2px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px" },
							}, [tabBtn("active", "未归档"), tabBtn("archived", "已归档")])
						),
						react.createElement("button", { className: "ssb_closeBtn", onClick: onClose, title: "关闭" }, "关闭")
					),
					react.createElement("div", { key: "body", className: "ssb_body" },
						react.createElement("div", { key: "sessions", className: "ssb_sessionList" },
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
						react.createElement("div", { key: "rounds", className: "ssb_roundList" },
							react.createElement("div", { className: "ssb_roundTitle" }, selected ? selected.title : "选择一个会话"),
							selected?.archived
								? react.createElement("div", {
									key: "archivedNote",
									style: { flex: "none", fontSize: "11px", color: "var(--dsw-alias-label-tertiary)", padding: "6px 12px 2px" },
								}, "已归档会话仅浏览，不跳转")
								: null,
							react.createElement("div", { className: "ssb_scroll" }, roundListContent)
						)
					),
					react.createElement("div", {
						key: "resize",
						className: "ssb_resize",
						onMouseDown: onMouseDownResize,
					})
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
					className: "ssb_footerBtn",
					title: "会话浏览",
					"aria-label": "会话浏览",
					"aria-expanded": open,
					onClick: () => setOpen(true),
				}, browseIcon(), react.createElement("span", null, "会话浏览")),
				open && react.createElement(Panel, { key: "panel", onClose: () => setOpen(false), ctx })
			);
		}

		//#endregion

		//#region plugin
		const inject = ["slots", "sessions"];

		function apply(ctx) {
			ctx.effect(() => injectStyles(), "dsh-session-browser: stylesheet");
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			slots.inject("sidebar.footer.action", () => slots.register(
				{ name: "sidebar.footer.action", id: "dsh-session-browser", order: 20 },
				() => react.createElement(SidebarButton, { ctx })
			));
		}

		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
