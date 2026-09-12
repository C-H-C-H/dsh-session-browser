/**
 * dsh-session-browser host half: HTTP routes for session browsing.
 *
 * - `/session-browser/api/list-sessions` — all stored session headers
 *   (`{ archived?: boolean }`: true → only archived, absent/false → only unarchived;
 *   every item carries `archived: boolean`; items sorted by `createdAt` desc)
 * - `/session-browser/api/list-rounds` — user messages in a session
 * - `/session-browser/api/archive` — `{ sessionId }` → `{ ok: true }`
 * - `/session-browser/api/unarchive` — `{ sessionId }` → `{ ok: true }`
 * - `/session-browser/api/delete` — `{ sessionId }` → `{ ok: true }`
 */
import type { Context } from 'cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Stable plugin name. */
export const name = 'dsh-session-browser'

/** Services required before mounting. */
export const inject = ['webServer', 'sessionPersistence', 'workspaceRegistry']

/** ------------------------------------------------------------------ helpers */

const MAX_BODY_BYTES = 1 << 20

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try { return JSON.parse(text) } catch { throw new Error('malformed JSON body') }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
  })
  res.end(text)
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

function isTrustedApiRequest(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (host === undefined) return false
  let hostUrl: URL
  try { hostUrl = new URL(`http://${host}`) } catch { return false }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  const fetchSite = req.headers['sec-fetch-site']
  if (typeof fetchSite === 'string' && fetchSite === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

/** ------------------------------------------------------------------ helpers */

function shortPath(cwd: string): string {
  if (!cwd) return ''
  const parts = cwd.replace(/[\\\/]+$/, '').split(/[\\\/]/)
  const last = parts[parts.length - 1] || ''
  return last.length > 26 ? last.slice(0, 24) + '…' : last
}

// Canonical source: src/persistence-compat.mjs
function normalizeHeaders(entries: any): any[] {
  if (!Array.isArray(entries)) return []
  const out: any[] = []
  for (const e of entries) {
    const h = e && typeof e === 'object' && e.header ? e.header : e
    if (h && typeof h.id === 'string') out.push(h)
  }
  return out
}

const READ_CHUNK = 500

async function readStoredEvents(persistence: any, sessionId: string): Promise<any[] | undefined> {
  if (!persistence) return undefined
  // DSH >= 0.1.5: SessionHandle.read() returns { eventState, events } (SessionHandleReadResult).
  if (typeof persistence.open === 'function') {
    const handle = await persistence.open(sessionId, 'read')
    try {
      const events: any[] = []
      for (let offset = 0; ; offset += READ_CHUNK) {
        const result = await handle.read(offset, READ_CHUNK)
        // SessionHandleReadResult: { eventState, events }
        const slice = Array.isArray(result) ? result : result?.events
        if (!slice || slice.length === 0) break
        for (const ev of slice) events.push(ev)
      }
      return events
    } finally {
      if (typeof handle.close === 'function') await handle.close()
    }
  }
  return undefined
}

/** ------------------------------------------------------------------ route handlers */

/**
 * Add one id to the registry-global archive set (durable, serialized).
 * Symmetric mirror of session-manager `unarchiveSession`: idempotent, writes
 * go through `enqueueOperation` + `setState` so a restart keeps the state.
 */
async function archiveSession(ctx: Context, sessionId: string): Promise<void> {
  const registry: any = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof registry.enqueueOperation !== 'function') throw new Error('workspaceRegistry 服务不可用')
  await registry.enqueueOperation(async () => {
    const state = registry.requireState()
    if (state.archivedSessionIds.includes(sessionId)) return
    await registry.setState({
      ...state,
      archivedSessionIds: [...state.archivedSessionIds, sessionId],
    })
  })
}

/**
 * Remove one id from the registry-global archive set (durable, serialized).
 * Ported from session-manager `unarchiveSession` (ctx.get replaces ctx property).
 */
async function unarchiveSession(ctx: Context, sessionId: string): Promise<void> {
  const registry: any = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof registry.enqueueOperation !== 'function') throw new Error('workspaceRegistry 服务不可用')
  await registry.enqueueOperation(async () => {
    const state = registry.requireState()
    if (!state.archivedSessionIds.includes(sessionId)) return
    await registry.setState({
      ...state,
      archivedSessionIds: state.archivedSessionIds.filter((id: string) => id !== sessionId),
    })
  })
}

/**
 * Detach one session from every workspace's ordered accounting.
 * Ported from session-manager `detachFromWorkspaces` (ctx.get replaces ctx
 * property; tolerates function-shaped sessionIds like listSessions does).
 */
async function detachFromWorkspaces(ctx: Context, sessionId: string): Promise<void> {
  const registry: any = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function') throw new Error('workspaceRegistry 服务不可用')
  for (const entity of registry.list()) {
    const ids = typeof entity.sessionIds === 'function' ? entity.sessionIds() : entity.sessionIds
    if (Array.isArray(ids) && ids.includes(sessionId)) {
      await entity.detachSession(sessionId)
    }
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Resolve the on-disk session directory (parent of its artifact), if any. Ported from session-manager. */
async function sessionDirOf(ctx: Context, sessionId: string): Promise<string | undefined> {
  const persistence: any = ctx.get('sessionPersistence')
  if (persistence === undefined) return undefined
  const headers = normalizeHeaders(await persistence.list())
  const meta = headers.find((header: any) => header.id === sessionId)
  if (meta === undefined) return undefined
  const location = persistence.locate(meta)
  if (location === undefined) return undefined
  return dirname(location.path)
}

/**
 * Delete one session end to end: live session teardown → `entry.detach()` →
 * flush/remove JSONL artifact dir → remove workspace accounting → remove
 * archive-set membership. Ported from session-manager `deleteSession`
 * (unrelated move/preset branches dropped; `sessions`/`agents` are optional
 * here until Task 3 extends `inject`, so absent services skip live teardown).
 */
async function deleteSession(ctx: Context, sessionId: string): Promise<void> {
  const liveSessions: any = ctx.get('sessions')
  const liveAgents: any = ctx.get('agents')
  const session = liveSessions?.get?.(sessionId)
  const agent = liveAgents?.get?.(sessionId)

  if (agent !== undefined) {
    // Stop any running turn (disposed-kind suppresses re-wake).
    agent.cancel({ kind: 'disposed' })
    // Quiesce the agent's own fiber (idempotent; bounded in case teardown stalls).
    if (typeof agent.scope?.dispose === 'function') {
      await Promise.race([agent.scope.dispose(), sleep(3000)])
    }
    // Drop the zombie from the registry so a later session.create/open with
    // the same id cannot resurrect it.
    try {
      liveAgents.store?.delete?.(sessionId)
    } catch { /* best-effort */ }
  }

  let detached = false
  if (session !== undefined) {
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
  // Sessions with a stored artifact but no live store row never fire
  // entry.detach() — emit session/disposed explicitly so every connected
  // client drops the row.
  if (!detached) {
    try {
      if (typeof (ctx as any).emit === 'function') (ctx as any).emit('session/disposed', { id: sessionId })
    } catch { /* best-effort */ }
  }

  // Workspace accounting + archive-set membership.
  await detachFromWorkspaces(ctx, sessionId)
  await unarchiveSession(ctx, sessionId)

  // Physical artifact (session.jsonl / session.jsonl.zstd) + any extras.
  const dir = await sessionDirOf(ctx, sessionId)
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true })
  }
}

function requireSessionId(payload: Record<string, unknown>): string {
  const sessionId = payload?.sessionId
  if (typeof sessionId !== 'string' || sessionId.trim() === '') throw new Error('sessionId 必填')
  return sessionId.trim()
}

async function handleArchive(ctx: Context, payload: Record<string, unknown>) {
  try {
    await archiveSession(ctx, requireSessionId(payload))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  }
}

async function handleUnarchive(ctx: Context, payload: Record<string, unknown>) {
  try {
    await unarchiveSession(ctx, requireSessionId(payload))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  }
}

async function handleDelete(ctx: Context, payload: Record<string, unknown>) {
  try {
    await deleteSession(ctx, requireSessionId(payload))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  }
}

/**
 * Read-only archive set: `registry.requireState()` → `state.archivedSessionIds`
 * (same source as session-manager `unarchiveSession`; reads need no `enqueueOperation`).
 */
function readArchivedIds(ctx: Context): Set<string> {
  try {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined || typeof registry.requireState !== 'function') return new Set()
    const ids = registry.requireState()?.archivedSessionIds
    if (!Array.isArray(ids)) return new Set()
    return new Set(ids.filter((id: unknown): id is string => typeof id === 'string'))
  } catch {
    return new Set()
  }
}

async function listSessions(ctx: Context, payload?: Record<string, unknown>) {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return { ok: false, error: 'sessionPersistence 服务不可用' }
  try {
    const archivedOnly = payload?.archived === true
    const archivedIds = readArchivedIds(ctx)
    const allHeaders = normalizeHeaders(await persistence.list())
    // Collect session IDs from all workspaces (current workspace scope)
    const registry = ctx.get('workspaceRegistry')
    let allowedIds: Set<string> | null = null
    if (registry !== undefined && typeof registry.list === 'function') {
      allowedIds = new Set()
      for (const entity of registry.list()) {
        const ids = typeof entity.sessionIds === 'function' ? entity.sessionIds() : entity.sessionIds
        if (Array.isArray(ids)) for (const id of ids) allowedIds.add(id)
      }
    }
    const headers = allHeaders.filter((h: any) => {
      if (h.origin === 'subagent') return false
      if (allowedIds !== null && !allowedIds.has(h.id)) return false
      // 归档分流：已归档页只取交集，未归档页排除已归档 id
      if (archivedOnly) { if (!archivedIds.has(h.id)) return false }
      else if (archivedIds.has(h.id)) return false
      return true
    })
    // Derive title from session/title event or first user message
    const items: unknown[] = []
    for (const h of headers) {
      let title = ''
      try {
        const events = await readStoredEvents(persistence, h.id)
        if (events) {
          // First: look for session/title event (renamed title)
          for (const event of events) {
            if (event.type === 'session/title') {
              const t = event.data?.title || event.data || ''
              if (typeof t === 'string' && t.trim()) {
                title = t.trim().length > 40 ? t.trim().slice(0, 40) + '…' : t.trim()
                break
              }
            }
          }
          // Fallback: first user message
          if (!title) {
            for (const event of events) {
              if (event.type === 'user/message' && event.surfaceOp === 'append') {
                const data = event.data || {}
                const content = typeof data.content === 'string'
                  ? data.content
                  : Array.isArray(data.content)
                    ? data.content.map((c: any) => c.text || '').join('')
                    : ''
                if (content.trim()) {
                  title = content.trim().length > 40 ? content.trim().slice(0, 40) + '…' : content.trim()
                  break
                }
              }
            }
          }
        }
      } catch { /* ignore */ }
      items.push({
        sessionId: h.id,
        title: title || shortPath(h.cwd) || '未命名',
        cwd: h.cwd || '',
        createdAt: h.createdAt,
        updatedAt: h.updatedAt || h.createdAt,
        archived: archivedIds.has(h.id),
      })
    }
    items.sort((a: any, b: any) => b.createdAt - a.createdAt)
    return { ok: true, items }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  }
}

async function listRounds(ctx: Context, payload: Record<string, unknown>) {
  const sessionId = payload?.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, error: '缺少 sessionId' }
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return { ok: false, error: 'sessionPersistence 服务不可用' }
  try {
    const events = await readStoredEvents(persistence, sessionId)
    if (!events) return { ok: false, error: '会话不存在或无事件数据' }
    const rounds: unknown[] = []
    let turnIndex = 0
    for (const event of events) {
      if (event.type !== 'user/message') continue
      // source.kind === "user" means truly user-typed; "plugin"/"system" are injected context
      const source = event.data?.source
      if (source && source.kind !== 'user') continue
      const data = event.data || {}
        const content = typeof data.content === 'string'
          ? data.content
          : Array.isArray(data.content)
            ? data.content.map((c: any) => c.text || '').join('')
            : JSON.stringify(data.content || '')
        rounds.push({
          seq: event.seq,
          eventId: data.id ?? event.seq,
          content: content.length > 200 ? content.slice(0, 200) + '…' : content,
          time: event.time,
          turnIndex: turnIndex++,
        })
      }
    }
    return { ok: true, items: rounds }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  }
}

/** ------------------------------------------------------------------ plugin body */

export function apply(ctx: Context) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/session-browser/api',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!isTrustedApiRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith('/session-browser/api/')
        ? pathname.slice(21)
        : undefined
      if (method === undefined || method.includes('/')) {
        writeJson(res, 404, { ok: false, error: 'unknown method' })
        return
      }
      try {
        const payload = await readJsonBody(req)
        if (method === 'list-sessions') {
          writeJson(res, 200, await listSessions(ctx, payload))
          return
        }
        if (method === 'list-rounds') {
          writeJson(res, 200, await listRounds(ctx, payload))
          return
        }
        if (method === 'archive') {
          writeJson(res, 200, await handleArchive(ctx, payload))
          return
        }
        if (method === 'unarchive') {
          writeJson(res, 200, await handleUnarchive(ctx, payload))
          return
        }
        if (method === 'delete') {
          writeJson(res, 200, await handleDelete(ctx, payload))
          return
        }
        writeJson(res, 404, { ok: false, error: `unknown method "${method}"` })
      } catch (err) {
        writeJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }), 'dsh-session-browser: /session-browser/api route')
}
