/**
 * dsh-session-browser client half: sidebar button + floating panel with
 * two-column layout (session list → round list) and scroll-to-message.
 */
import { createElement, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from 'cordis'

/** ------------------------------------------------------------------ types */

interface SessionItem {
  sessionId: string
  title: string
  cwd: string
  createdAt: number
  updatedAt: number
  archived: boolean
}

interface RoundItem {
  seq: number
  eventId: number | string
  content: string
  time: number
  turnIndex: number
}

/** ------------------------------------------------------------------ styles */

const CSS = `
/* sidebar.footer.action layout: ensures all plugin buttons are visible in compatibility mode.
   In extended/advanced mode the Desktop's own CSS (with !important) overrides this. */
[data-slot="sidebar.footer.action"]{display:flex!important;flex-direction:column;gap:6px;min-width:0;width:100%;max-height:min(40vh,240px);overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
[data-slot="sidebar.footer.action"]>*{flex:none;min-width:0}
.ssb_root{box-sizing:border-box;position:relative;display:flex;align-items:center;justify-content:center;flex:none;width:100%}
.ssb_button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0 10px;font-size:12px;line-height:18px;white-space:nowrap}
.ssb_button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ssb_button svg{flex:none}
.ssb_panel{position:fixed;z-index:2147483000;width:560px;height:480px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);box-sizing:border-box;background:var(--dsw-specific-tip);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.16);overflow:hidden;display:flex;flex-direction:column;font-family:Inter,var(--dsw-font-family)}
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
`

function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector('style[data-plugin-css="ssb/styles"]') !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-session-browser'
  tag.dataset.pluginCss = 'ssb/styles'
  tag.textContent = CSS
  document.head.appendChild(tag)
  return () => { if (tag.parentNode !== null) tag.parentNode.removeChild(tag) }
}

/** ------------------------------------------------------------------ data */

const API = '/session-browser/api'
const FETCH_TIMEOUT = 10000

function callApi(method: string, body: unknown): Promise<any> {
  const controller = typeof AbortController === 'undefined' ? undefined : new AbortController()
  const timer = controller !== undefined ? setTimeout(() => { controller.abort() }, FETCH_TIMEOUT) : undefined
  return fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller?.signal,
  })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .catch(err => ({ ok: false, error: String(err instanceof Error ? err.message : err) }))
    .finally(() => { if (timer !== undefined) clearTimeout(timer) })
}

/** ------------------------------------------------------------------ helpers */

function fmtTime(ms: number): string {
  if (!ms || typeof ms !== 'number') return ''
  try {
    const d = new Date(ms)
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
    if (sameDay) return time
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`
  } catch { return '' }
}

function shortPath(cwd?: string): string {
  if (!cwd) return ''
  const parts = cwd.replace(/[\\\/]+$/, '').split(/[\\\/]/)
  const last = parts[parts.length - 1] || ''
  return last.length > 26 ? last.slice(0, 24) + '…' : last
}

function closeIcon(): ReturnType<typeof createElement> {
  return createElement('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    createElement('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round' })
  )
}

// Find setGroupExpanded from workspace view store via React fiber tree
let _cachedSetGroupExpanded: ((key: string, expanded: boolean) => void) | null = null
function findSetGroupExpanded() {
  if (_cachedSetGroupExpanded) return _cachedSetGroupExpanded
  try {
    const sidebar = document.querySelector('[class*=sidebar]') || document.querySelector('[class*=Sidebar]')
    if (!sidebar) return null
    const fiberKey = Object.keys(sidebar).find((k) => k.startsWith('__reactFiber$'))
    if (!fiberKey) return null
    let fiber = (sidebar as any)[fiberKey]
    for (let i = 0; i < 80 && fiber; i++) {
      const props = fiber.memoizedProps || fiber.pendingProps
      if (props && typeof props.setGroupExpanded === 'function') {
        _cachedSetGroupExpanded = props.setGroupExpanded
        return _cachedSetGroupExpanded
      }
      fiber = fiber.return
    }
  } catch { /* ignore */ }
  return null
}
function expandGroupForKey(groupKey: string) {
  const fn = findSetGroupExpanded()
  if (fn && groupKey) {
    try { fn(groupKey, true) } catch { /* ignore */ }
  }
}
function listClientWorkspaceItems(ctx: Context): Array<{ path: string; workspaceId?: string; id?: string }> {
  try {
    const snap = (ctx as any).get?.('workspaces')?.list?.getSnapshot?.()
    const items = snap?.items ?? snap ?? []
    return Array.isArray(items) ? items : []
  } catch { return [] }
}

// Click all collapsed overflow buttons ("展开其余N个会话") in the sidebar
function expandAllSessionOverflows() {
  try {
    const btns = document.querySelectorAll('button[aria-expanded="false"]')
    for (const btn of btns) {
      const text = btn.textContent || ''
      if (text.includes('展开') || text.includes('expand') || btn.className.includes('Overflow') || btn.className.includes('overflow')) {
        (btn as HTMLButtonElement).click()
      }
    }
  } catch { /* ignore */ }
}

/** ------------------------------------------------------------------ Task 5: row actions.
 * Read of the currently-open session id. Primary is the production shape
 * `ctx.sessions.list.getSnapshot().current` (SessionListSnapshot.current:
 * SessionId|undefined, plain string); the older accessor shapes are kept only
 * as best-effort fallback for host-version variance; unknown shapes yield
 * undefined (callers treat that as "not current").
 */
function currentOpenSessionId(ctx: Context): string | undefined {
  try {
    const svc = (ctx as any).sessions
    if (!svc) return undefined
    // Production primary: list snapshot .current is the plain SessionId string
    // (SessionListSnapshot.current: SessionId|undefined).
    try {
      const snapCur = svc?.list?.getSnapshot?.()?.current
      if (typeof snapCur === 'string' && snapCur !== '') return snapCur
    } catch { /* ignore */ }
    const fields = [svc.currentSessionId, svc.currentId, svc.current]
    for (const f of fields) {
      if (typeof f === 'string' && f !== '') return f
      if (f && typeof f === 'object') {
        if (typeof f.sessionId === 'string' && f.sessionId !== '') return f.sessionId
        if (typeof f.id === 'string' && f.id !== '') return f.id
      }
    }
    if (typeof svc.getCurrent === 'function') {
      const cur = svc.getCurrent()
      if (typeof cur === 'string' && cur !== '') return cur
      if (cur && typeof cur === 'object') {
        if (typeof cur.sessionId === 'string' && cur.sessionId !== '') return cur.sessionId
        if (typeof cur.id === 'string' && cur.id !== '') return cur.id
      }
    }
  } catch { /* ignore */ }
  return undefined
}

function sessionsStoreById(ctx: Context): Record<string, any> {
  try {
    const snap = (ctx as any).sessions?.list?.getSnapshot?.()
    if (snap && typeof snap.byId === 'object' && snap.byId !== null) return snap.byId
  } catch { /* ignore */ }
  return {}
}

function refreshSessionsStore(ctx: Context): Promise<unknown> {
  try {
    const p = (ctx as any).sessions?.refresh?.()
    if (p && typeof p.then === 'function') return p.catch(() => undefined)
  } catch { /* ignore */ }
  return Promise.resolve(undefined)
}

function refreshWorkspacesStore(ctx: Context): Promise<unknown> {
  try {
    const svc = (ctx as any).workspaces ?? (ctx as any).get?.('workspaces')
    const p = svc?.refresh?.()
    if (p && typeof p.then === 'function') return p.catch(() => undefined)
  } catch { /* ignore */ }
  return Promise.resolve(undefined)
}

function apiError(res: any, fallback: string): string {
  return (res && typeof res.error === 'string' && res.error !== '') ? res.error : fallback
}

function browseIcon(): ReturnType<typeof createElement> {
  return createElement('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    createElement('rect', { x: 2, y: 2, width: 12, height: 12, rx: 2, stroke: 'currentColor', strokeWidth: 1.5 }),
    createElement('line', { x1: 6, y1: 2, x2: 6, y2: 14, stroke: 'currentColor', strokeWidth: 1.5 }),
  )
}

/** ------------------------------------------------------------------ view */

const { useState: _useState, useEffect: _useEffect, useRef: _useRef } = React

// Canonical source: src/jump-loader.mjs (plain-JS twin for node tests;
// inlined here because the ModuleLoader client bundle has no relative imports).
function jumpWithTimeout(promise: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('jump loader timeout')), ms)
  })
  return Promise.race([promise, timeout]).then(
    (value) => { clearTimeout(timer); return value },
    (err) => { clearTimeout(timer); throw err }
  )
}

async function ensureWindowCovers(sessions: any, sessionId: string, seq: number, timeoutMs = 15000): Promise<boolean> {
  if (!sessions || typeof sessions.scope !== 'function') return false
  const deadline = Date.now() + timeoutMs
  for (let attempt = 1; ; attempt++) {
    let face: any
    try {
      const scoped = sessions.scope(sessionId)
      face = scoped && typeof sessions.sessionOf === 'function' ? sessions.sessionOf(scoped) : undefined
    } catch { face = undefined }
    if (face && typeof face.loadThrough === 'function') {
      try {
        await jumpWithTimeout(face.loadThrough(seq), Math.max(1, deadline - Date.now()))
        return true
      } catch { return false }
    }
    if (attempt >= 4 || Date.now() >= deadline) return false
    try { await new Promise((resolve) => setTimeout(resolve, 300)) } catch { return false }
  }
}

async function jumpToMessage(ctx: Context, sessionId: string, eventSeq: number, eventId: number | string): Promise<void> {
  try { (ctx as any).sessions?.open?.(sessionId) } catch { /* ignore */ }
  // Phase 1: page the virtualized event window backwards until it covers the
  // target seq, so the anchor element actually renders. No-op fallback on
  // hosts without SessionFace.loadThrough (e.g. desktop 2.0.4).
  try { await ensureWindowCovers((ctx as any).sessions, sessionId, eventSeq, 15000) } catch { /* ignore */ }
  // Phase 2: anchor scroll (unchanged behavior).
  const anchorKey = `13:input-message${eventId}`
  let attempts = 0
  const tryScroll = () => {
    const el = document.querySelector(`[data-chat-anchor-key="${anchorKey}"]`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    if (attempts < 50) {
      attempts++
      setTimeout(tryScroll, 200)
    }
  }
  setTimeout(tryScroll, 600)
}

function Panel({ onClose, ctx }: { onClose: () => void; ctx: Context }) {
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [selected, setSelected] = useState<SessionItem | null>(null)
  const [rounds, setRounds] = useState<RoundItem[]>([])
  const [filter, setFilter] = useState('')
  const [tab, setTab] = useState<'active' | 'archived'>('active')
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [noticeOk, setNoticeOk] = useState(false)
  const [moveTarget, setMoveTarget] = useState<SessionItem | null>(null)
  const [moveWs, setMoveWs] = useState('')
  const [wsList, setWsList] = useState<Array<{ id: string; name?: string; title?: string; path?: string }>>([])
  const [migrateTarget, setMigrateTarget] = useState<SessionItem | null>(null)
  const [migratePreset, setMigratePreset] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const reloadSessions = (forTab: 'active' | 'archived') => {
    callApi('list-sessions', { archived: forTab === 'archived' }).then((res: any) => {
      if (!res.ok) { setNotice(apiError(res, '加载会话列表失败')); setNoticeOk(false); return }
      const items = res.items || []
      // Get live display titles from sessions store (same source as sidebar)
      let liveById: Record<string, any> = {}
      try {
        const snap = ctx.sessions?.list?.getSnapshot?.()
        if (snap && snap.byId) liveById = snap.byId
      } catch { /* ignore */ }
      const merged = items.map((item: any) => {
        const live = liveById[item.sessionId]
        const displayTitle = live?.displayTitle
        return {
          ...item,
          title: displayTitle || item.title || shortPath(item.cwd) || '未命名',
        }
      })
      setSessions(merged)
    })
  }

  useEffect(() => {
    reloadSessions(tab)
  }, [tab])

  useEffect(() => {
    if (!selected) { setRounds([]); setLoading(false); return }
    setLoading(true)
    callApi('list-rounds', { sessionId: selected.sessionId }).then((res: any) => {
      setRounds(res.ok ? res.items : [])
      setLoading(false)
    })
  }, [selected])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [onClose])

  const filtered = sessions.filter(s =>
    s.title.toLowerCase().includes(filter.toLowerCase()) ||
    s.cwd.toLowerCase().includes(filter.toLowerCase())
  )

  const panelStyle = {
    left: `${Math.max(8, Math.min((window.innerWidth - 560) / 2, window.innerWidth - 568))}px`,
    top: `${Math.max(8, Math.min((window.innerHeight - 480) / 2, window.innerHeight - 488))}px`,
  }

  const switchTab = (next: 'active' | 'archived') => {
    setTab(next)
    setSelected(null)
    setRounds([])
    setLoading(false)
    setNotice(''); setNoticeOk(false)
  }

  // Dual-refresh for move: immediate workspaces.refresh + sessions.refresh with
  // reopen-if-current, plus the 250/900ms delayed re-refreshes (Task 3 record).
  const refreshMovedSession = async (sessionId: string, wasCurrent: boolean): Promise<void> => {
    try { await Promise.allSettled([refreshWorkspacesStore(ctx), refreshSessionsStore(ctx)]) } catch { /* ignore */ }
    if (wasCurrent) {
      try { if (sessionsStoreById(ctx)[sessionId] !== undefined) (ctx as any).sessions?.open?.(sessionId) } catch { /* ignore */ }
    }
  }

  const onArchive = async (s: SessionItem): Promise<void> => {
    setNotice(''); setNoticeOk(false)
    const res: any = await callApi('archive', { sessionId: s.sessionId })
    if (!res?.ok) { setNotice(apiError(res, '归档失败')); setNoticeOk(false); return }
    if (selected?.sessionId === s.sessionId) { setSelected(null); setRounds([]); setLoading(false) }
    reloadSessions(tab)
  }

  const onUnarchive = async (s: SessionItem): Promise<void> => {
    setNotice(''); setNoticeOk(false)
    const res: any = await callApi('unarchive', { sessionId: s.sessionId })
    if (!res?.ok) { setNotice(apiError(res, '移出归档失败')); setNoticeOk(false); return }
    if (selected?.sessionId === s.sessionId) { setSelected(null); setRounds([]); setLoading(false) }
    reloadSessions(tab)
  }

  const onRemove = async (s: SessionItem): Promise<void> => {
    setNotice(''); setNoticeOk(false)
    const wasCurrent = currentOpenSessionId(ctx) === s.sessionId
    const res: any = await callApi('delete', { sessionId: s.sessionId })
    if (!res?.ok) { setNotice(apiError(res, '删除会话失败')); setNoticeOk(false); return }
    // Same rule as session-manager: deleting the open session clears it so the
    // main UI does not show a removed session.
    if (wasCurrent) {
      try { (ctx as any).sessions?.clear?.() } catch { /* ignore */ }
    }
    if (selected?.sessionId === s.sessionId) { setSelected(null); setRounds([]); setLoading(false) }
    reloadSessions(tab)
  }

  const onMove = async (sessionId: string, targetWorkspaceId: string): Promise<void> => {
    setNotice(''); setNoticeOk(false)
    const wasCurrent = currentOpenSessionId(ctx) === sessionId
    const res: any = await callApi('move', { sessionId, targetWorkspaceId })
    if (!res?.ok) { setNotice(apiError(res, '移动会话失败')); setNoticeOk(false); return }
    setNotice('移动成功'); setNoticeOk(true)
    reloadSessions(tab)
    await refreshMovedSession(sessionId, wasCurrent)
    setTimeout(() => { refreshMovedSession(sessionId, wasCurrent) }, 250)
    setTimeout(() => { refreshMovedSession(sessionId, wasCurrent) }, 900)
  }

  const onMigrate = async (sessionId: string, toPreset: string): Promise<void> => {
    setNotice(''); setNoticeOk(false)
    const wasCurrent = currentOpenSessionId(ctx) === sessionId
    const res: any = await callApi('preset-migrate', { sessionId, toPreset })
    if (!res?.ok) { setNotice(apiError(res, '迁移预设失败')); setNoticeOk(false); return }
    setNotice('迁移成功'); setNoticeOk(true)
    try { (ctx as any).sessions?.noteAgentPreset?.(sessionId, toPreset) } catch { /* ignore */ }
    try { await refreshSessionsStore(ctx) } catch { /* ignore */ }
    if (wasCurrent) {
      try { (ctx as any).sessions?.open?.(sessionId) } catch { /* ignore */ }
    }
    reloadSessions(tab)
    // Single 250ms delayed baseline (no 900ms leg — Task 3 record).
    setTimeout(() => {
      refreshSessionsStore(ctx).then(() => {
        try { (ctx as any).sessions?.noteAgentPreset?.(sessionId, toPreset) } catch { /* ignore */ }
        if (wasCurrent) {
          try { (ctx as any).sessions?.open?.(sessionId) } catch { /* ignore */ }
        }
      })
    }, 250)
  }

  const openMoveDialog = (s: SessionItem) => {
    setNotice(''); setNoticeOk(false)
    setMigrateTarget(null)
    setMoveTarget(s)
    setMoveWs('')
    setWsList([])
    callApi('workspaces', {}).then((res: any) => {
      const list = res?.ok ? res?.result?.workspaces : undefined
      if (!res?.ok || !Array.isArray(list)) { setNotice(apiError(res, '加载工作区列表失败')); setNoticeOk(false); return }
      const mapped = list
        .map((w: any) => ({ id: String(w.id ?? w.workspaceId ?? ''), name: w.name, title: w.title, path: w.path }))
        .filter((w: { id: string }) => w.id !== '')
      setWsList(mapped)
      if (mapped.length > 0) setMoveWs(mapped[0].id)
    })
  }

  const openMigrateDialog = (s: SessionItem) => {
    setNotice(''); setNoticeOk(false)
    setMoveTarget(null)
    setMigrateTarget(s)
    setMigratePreset('')
  }

  const rowBtn = (label: string, s: SessionItem, onPress: (row: SessionItem) => void) =>
    createElement('button', {
      key: label,
      type: 'button',
      onClick: (e: any) => { try { e.stopPropagation() } catch { /* ignore */ } onPress(s) },
      style: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '11px',
        lineHeight: '16px',
        padding: '1px 8px',
        borderRadius: '6px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
    }, label)

  const tabBtn = (id: 'active' | 'archived', label: string) =>
    createElement('button', {
      key: id,
      type: 'button',
      role: 'tab',
      'aria-selected': tab === id,
      onClick: () => switchTab(id),
      style: {
        border: 'none',
        background: tab === id ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        color: tab === id ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        fontWeight: tab === id ? 600 : 400,
        fontSize: '12px',
        lineHeight: '18px',
        padding: '2px 10px',
        borderRadius: '6px',
        cursor: 'pointer',
      },
    }, label)

  return createPortal(createElement('div', { key: 'ssb-root' },
    createElement('div', { key: 'backdrop', className: 'ssb_backdrop', onClick: onClose }),
    createElement('div', { key: 'panel', className: 'ssb_panel', style: panelStyle, role: 'dialog', 'aria-label': '会话浏览' },
      createElement('div', { key: 'header', className: 'ssb_header' },
        createElement('div', { key: 'titleGroup', style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
          createElement('span', { className: 'ssb_headerTitle' }, '会话浏览'),
          createElement('div', {
            key: 'tabs',
            role: 'tablist',
            'aria-label': '归档筛选',
            style: { display: 'inline-flex', gap: '2px', padding: '2px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px' },
          }, [tabBtn('active', '未归档'), tabBtn('archived', '已归档')])
        ),
        createElement('button', { className: 'ssb_closeBtn', onClick: onClose, title: '关闭' }, closeIcon())
      ),
      notice
        ? createElement('div', {
            key: 'notice',
            style: {
              flex: 'none',
              fontSize: '11px',
              lineHeight: '16px',
              color: noticeOk ? 'var(--dsw-alias-state-success, #1a7f37)' : 'var(--dsw-alias-state-danger, #c53b3b)',
              padding: '6px 12px',
              borderBottom: '1px solid var(--dsw-alias-border-l2)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          }, notice)
        : null,
      createElement('div', { key: 'body', className: 'ssb_body' },
        // Left: session list
        createElement('div', { key: 'sessions', className: 'ssb_sessionList' },
          createElement('input', {
            ref: inputRef,
            className: 'ssb_search',
            type: 'text',
            placeholder: '搜索会话…',
            value: filter,
            onChange: (e: any) => setFilter(e.target.value),
          }),
          createElement('div', { className: 'ssb_scroll' },
            filtered.length === 0
              ? createElement('div', { className: 'ssb_empty' }, sessions.length === 0 ? '暂无会话' : '没有匹配的会话')
              : filtered.map(s =>
                  createElement('div', {
                    key: s.sessionId,
                    className: `ssb_sessionItem${selected?.sessionId === s.sessionId ? ' ssb_sessionItemActive' : ''}`,
                    onClick: () => {
                      setSelected(s)
                      if (s.archived) return
                      // Expand collapsed workspace group before opening
                      try {
                        if (s.cwd) {
                          const workspaces = listClientWorkspaceItems(ctx)
                          for (const ws of workspaces) {
                            const wsPath = ws.path || ''
                            if (s.cwd === wsPath || s.cwd.startsWith(wsPath + '/') || s.cwd.startsWith(wsPath + '\\')) {
                              expandGroupForKey(ws.workspaceId || (ws as any).id || wsPath)
                              break
                            }
                          }
                        }
                      } catch { /* ignore */ }
                      // Expand all collapsed session overflow buttons in sidebar
                      expandAllSessionOverflows()
                      try { ctx.sessions.open(s.sessionId) } catch { /* ignore */ }
                    },
                  },
                    createElement('div', { className: 'ssb_sessionTitle' }, s.title || '(未命名)'),
                    createElement('div', { className: 'ssb_sessionMeta' }, fmtTime(s.updatedAt) || fmtTime(s.createdAt)),
                    createElement('div', {
                      key: 'actions',
                      onClick: (e: any) => { try { e.stopPropagation() } catch { /* ignore */ } },
                      style: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' },
                    },
                      s.archived ? rowBtn('移出归档', s, onUnarchive) : rowBtn('归档', s, onArchive),
                      rowBtn('删除', s, onRemove),
                      rowBtn('移动', s, openMoveDialog),
                      rowBtn('迁移', s, openMigrateDialog)
                    )
                  )
                )
          )
        ),
        // Right: round list
        createElement('div', { key: 'rounds', className: 'ssb_roundList' },
          selected
            ? createElement('div', { className: 'ssb_roundTitle' }, selected.title || '(未命名)')
            : createElement('div', { className: 'ssb_roundTitle' }, '选择一个会话'),
          selected?.archived
            ? createElement('div', {
                key: 'archivedNote',
                style: { flex: 'none', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', padding: '6px 12px 2px' },
              }, '已归档会话仅浏览，不跳转')
            : null,
          createElement('div', { className: 'ssb_scroll' },
            loading
              ? createElement('div', { className: 'ssb_status' }, '加载中…')
              : !selected
                ? createElement('div', { className: 'ssb_empty' }, '← 点击左侧会话查看轮次')
                : rounds.length === 0
                  ? createElement('div', { className: 'ssb_empty' }, '该会话无用户提问')
                  : rounds.map(r => {
                      const itemProps: any = { key: r.seq, className: 'ssb_roundItem' }
                      if (!selected.archived) itemProps.onClick = () => jumpToMessage(ctx, selected.sessionId, r.seq, r.eventId)
                      else itemProps.style = { cursor: 'default' }
                      return createElement('div', itemProps,
                        createElement('div', { className: 'ssb_roundContent' }, `Q${r.turnIndex + 1}: ${r.content}`),
                        createElement('div', { className: 'ssb_roundMeta' }, fmtTime(r.time))
                      )
                    })
          )
        ),
        moveTarget
          ? createElement('div', {
              key: 'moveDlg',
              onClick: (e: any) => { try { e.stopPropagation() } catch { /* ignore */ } },
              style: {
                position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(0,0,0,0.25)', zIndex: 1,
              },
            },
              createElement('div', {
                style: {
                  width: '300px', maxWidth: 'calc(100% - 32px)', background: 'var(--dsw-specific-tip)',
                  border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px', padding: '12px',
                  boxShadow: '0 8px 28px rgba(0,0,0,.16)',
                },
              },
                createElement('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '4px' } }, '移动会话'),
                createElement('div', {
                  style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                }, moveTarget.title || '(未命名)'),
                createElement('select', {
                  value: moveWs,
                  onChange: (e: any) => setMoveWs(e.target.value),
                  style: { width: '100%', fontSize: '12px', padding: '4px 6px', marginBottom: '10px' },
                }, wsList.map(w => createElement('option', { key: w.id, value: w.id }, w.title || w.name || w.path || w.id))),
                createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
                  createElement('button', { type: 'button', onClick: () => setMoveTarget(null) }, '取消'),
                  createElement('button', {
                    type: 'button',
                    onClick: () => {
                      const t = moveTarget
                      const ws = moveWs
                      if (!t) return
                      if (!ws) { setNotice('请选择目标工作区'); setNoticeOk(false); return }
                      setMoveTarget(null)
                      onMove(t.sessionId, ws)
                    },
                  }, '确认')
                )
              )
            )
          : null,
        migrateTarget
          ? createElement('div', {
              key: 'migrateDlg',
              onClick: (e: any) => { try { e.stopPropagation() } catch { /* ignore */ } },
              style: {
                position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(0,0,0,0.25)', zIndex: 1,
              },
            },
              createElement('div', {
                style: {
                  width: '300px', maxWidth: 'calc(100% - 32px)', background: 'var(--dsw-specific-tip)',
                  border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px', padding: '12px',
                  boxShadow: '0 8px 28px rgba(0,0,0,.16)',
                },
              },
                createElement('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '4px' } }, '迁移预设'),
                createElement('div', {
                  style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                }, migrateTarget.title || '(未命名)'),
                createElement('input', {
                  type: 'text',
                  placeholder: '目标预设',
                  value: migratePreset,
                  onChange: (e: any) => setMigratePreset(e.target.value),
                  style: { width: '100%', boxSizing: 'border-box', fontSize: '12px', padding: '4px 6px', marginBottom: '10px' },
                }),
                createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
                  createElement('button', { type: 'button', onClick: () => setMigrateTarget(null) }, '取消'),
                  createElement('button', {
                    type: 'button',
                    onClick: () => {
                      const t = migrateTarget
                      const p = migratePreset.trim()
                      if (!t) return
                      if (!p) { setNotice('目标预设不能为空'); setNoticeOk(false); return }
                      setMigrateTarget(null)
                      onMigrate(t.sessionId, p)
                    },
                  }, '确认')
                )
              )
            )
          : null
      )
    )
  ), document.body)
}

function SidebarButton({ ctx }: { ctx: Context }) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement | null>(null)

  return createElement('div', { className: 'ssb_root' },
    createElement('button', {
      ref: buttonRef,
      type: 'button',
      className: 'ssb_button',
      title: '会话浏览',
      'aria-label': '会话浏览',
      'aria-expanded': open,
      onClick: () => setOpen(true),
    }, [browseIcon()]),
    open && createElement(Panel, { key: 'panel', onClose: () => setOpen(false), ctx })
  )
}

/** ------------------------------------------------------------------ plugin */

export const inject = ['slots', 'sessions']

export function apply(ctx: Context) {
  ctx.effect(() => injectStyles(), 'dsh-session-browser: stylesheet')
  const slots = ctx.get('slots')
  if (slots === undefined) return
  slots.inject('sidebar.footer.action', () => slots.register(
    { name: 'sidebar.footer.action', id: 'dsh-session-browser', order: 20 },
    () => createElement(SidebarButton, { ctx })
  ))
}
