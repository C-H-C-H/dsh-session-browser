/**
 * dsh-session-browser host half: HTTP routes for session browsing.
 *
 * - `/session-browser/api/list-sessions` — all stored session headers
 *   (`{ archived?: boolean }`: true → only archived, absent/false → only unarchived;
 *   every item carries `archived: boolean`; items sorted by `createdAt` desc)
 * - `/session-browser/api/list-rounds` — user messages in a session
 */
import type { Context } from 'cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'

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
        writeJson(res, 404, { ok: false, error: `unknown method "${method}"` })
      } catch (err) {
        writeJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }), 'dsh-session-browser: /session-browser/api route')
}
