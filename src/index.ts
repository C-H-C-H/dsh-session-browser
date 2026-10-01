/**
 * dsh-session-browser host half: HTTP routes for session browsing.
 *
 * - `/session-browser/api/list-sessions` — all stored session headers
 *   (`{ archived?: boolean; ungrouped?: boolean }`: archived → only archived;
 *   ungrouped → only sessions with no workspace membership (DSH's「未分组」);
 *   neither → only sessions that DO belong to a workspace; every item carries
 *   `archived: boolean`; items sorted by `createdAt` desc)
 * - `/session-browser/api/list-rounds` — user messages in a session
 * - `/session-browser/api/archive` — `{ sessionId }` → `{ ok: true }`
 * - `/session-browser/api/unarchive` — `{ sessionId }` → `{ ok: true }`
 * - `/session-browser/api/delete` — `{ sessionId }` → `{ ok: true, result }`
 *   (logical delete: records a trash entry first so a restore can put the
 *   archive flag and workspace membership back)
 * - `/session-browser/api/list-deleted` — `{}` → `{ ok: true, result: { items } }`
 * - `/session-browser/api/restore` — `{ sessionId }` → `{ ok: true, result }`
 * - `/session-browser/api/move` — `{ sessionId, targetWorkspaceId }` → `{ ok: true, result }`
 * - `/session-browser/api/preset-migrate` — `{ sessionId, toPreset }` → `{ ok: true, result }`
 * - `/session-browser/api/workspaces` — `{}` → `{ ok: true, result: { workspaces } }`
 */
import type { Context } from 'cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { realpath } from 'node:fs/promises'
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

/** Stable plugin name. */
export const name = 'dsh-session-browser'

/**
 * Services required before mounting.
 * `sessions` + `agents` serve the Task 3 ported code, which touches them via
 * `ctx.sessions` / `ctx.agents` property access (mirroring session-manager's own
 * `inject`, where they are declared the same way). `sessionPersistence` /
 * `agentPresets` stay lazy `ctx.get` accesses and are intentionally NOT listed.
 */
export const inject = ['webServer', 'sessionPersistence', 'workspaceRegistry', 'sessions', 'agents']

/** ------------------------------------------------------------------ helpers */

const MAX_BODY_BYTES = 1 << 20

/**
 * Trash metadata store.
 *
 * `delete` is a logical delete: the session leaves the live store, the
 * workspace accounting and the archive set, but its event log stays on disk.
 * That erases two facts a restore cannot re-derive — whether the session was
 * archived, and which workspaces accounted for it — so record them here first.
 *
 * Storage is a single JSON file under `~/.dsh/`, deliberately NOT inside the
 * session artifact tree: a trash record that dies with the session directory
 * could never be used to restore it.
 */
export interface TrashEntry {
  sessionId: string
  /** Archive state at delete time; a restore must put it back exactly. */
  archived: boolean
  /** Workspaces that accounted for it at delete time, in order. */
  workspaceIds: string[]
  /** Header cwd — the target a restore re-attaches to. */
  cwd: string
  createdAt: number
  updatedAt: number
  deletedAt: number
}

const TRASH_MAX = 200

/** Resolved lazily so tests can override before first use. */
let trashPathOverride: string | undefined

function trashPath(): string {
  if (trashPathOverride !== undefined) return trashPathOverride
  return join(homedir(), '.dsh', 'dsh-session-browser-trash.json')
}

/** Test seam: point the store at a temp file (or `undefined` to restore default). */
export function __setTrashPath(path: string | undefined): void {
  trashPathOverride = path
}

/** Drop entries whose id already appears, keeping the newest `list` order. */
function normalizeEntries(raw: unknown): TrashEntry[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: TrashEntry[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const e = item as Record<string, unknown>
    const sessionId = typeof e.sessionId === 'string' ? e.sessionId.trim() : ''
    if (!sessionId || seen.has(sessionId)) continue
    seen.add(sessionId)
    out.push({
      sessionId,
      archived: e.archived === true,
      workspaceIds: Array.isArray(e.workspaceIds) ? e.workspaceIds.filter((x): x is string => typeof x === 'string') : [],
      cwd: typeof e.cwd === 'string' ? e.cwd : '',
      createdAt: typeof e.createdAt === 'number' ? e.createdAt : 0,
      updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0,
      deletedAt: typeof e.deletedAt === 'number' ? e.deletedAt : 0,
    })
  }
  return out.slice(0, TRASH_MAX)
}

/** Read the whole trash. A missing or corrupt file reads as empty, never throws. */
export async function readTrash(): Promise<TrashEntry[]> {
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
export async function writeTrash(entries: TrashEntry[]): Promise<void> {
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
export async function recordTrash(entry: TrashEntry): Promise<void> {
  const rest = (await readTrash()).filter(e => e.sessionId !== entry.sessionId)
  await writeTrash([entry, ...rest])
}

/** Remove one record. Returns whether it was present. */
export async function dropTrash(sessionId: string): Promise<boolean> {
  const all = await readTrash()
  const next = all.filter(e => e.sessionId !== sessionId)
  if (next.length === all.length) return false
  await writeTrash(next)
  return true
}

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

/**
 * Title cache. Key = `${sessionId}@${updatedAt}` so any append (or a
 * `session/title` rename, which bumps updatedAt) invalidates it automatically —
 * no manual invalidation path, and two page tabs sharing a session hit the cache.
 */
const titleCache = new Map<string, string>()
const TITLE_CACHE_MAX = 512

/** Concurrency cap for persistence opens; IO-bound, so a small window suffices. */
const TITLE_READ_CONCURRENCY = 8

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

/**
 * Read a session's events, stopping as soon as `pick` returns a value.
 * Titles live at the head of the log (a `session/title` rename or the first user
 * message), so a long conversation no longer costs a full multi-chunk read.
 * Falls back to reading everything when the head does not yield a title.
 */
async function readEventsUntil(
  persistence: any,
  sessionId: string,
  pick: (events: any[]) => string | undefined,
): Promise<any[] | undefined> {
  if (!persistence || typeof persistence.open !== 'function') return undefined
  const handle = await persistence.open(sessionId, 'read')
  try {
    const events: any[] = []
    for (let offset = 0; ; offset += READ_CHUNK) {
      const result = await handle.read(offset, READ_CHUNK)
      const slice = Array.isArray(result) ? result : result?.events
      if (!slice || slice.length === 0) break
      for (const ev of slice) events.push(ev)
      const hit = pick(events)
      if (hit !== undefined) return events
    }
    return events
  } finally {
    if (typeof handle.close === 'function') await handle.close()
  }
}

/** Extract a display title from loaded events: renamed title, else first user message. */
function titleFromEvents(events: any[]): string | undefined {
  for (const event of events) {
    if (event.type === 'session/title') {
      const t = event.data?.title || event.data || ''
      if (typeof t === 'string' && t.trim()) {
        return t.trim().length > 40 ? t.trim().slice(0, 40) + '…' : t.trim()
      }
    }
  }
  for (const event of events) {
    if (event.type === 'user/message' && event.surfaceOp === 'append') {
      const data = event.data || {}
      const content = typeof data.content === 'string'
        ? data.content
        : Array.isArray(data.content)
          ? data.content.map((c: any) => c.text || '').join('')
          : ''
      if (content.trim()) {
        return content.trim().length > 40 ? content.trim().slice(0, 40) + '…' : content.trim()
      }
    }
  }
  return undefined
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      out[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return out
}

/** ------------------------------------------------------------------ route handlers */

/**
 * Archive via the workspaceRegistry official method (durable, serialized
 * inside the registry; idempotent for already-archived ids).
 */
async function archiveSession(ctx: Context, sessionId: string): Promise<void> {
  const registry: any = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof registry.archiveSession !== 'function') throw new Error('workspaceRegistry 服务不可用')
  await registry.archiveSession(sessionId)
}

/**
 * Unarchive via the workspaceRegistry official method (idempotent, also for
 * ids whose session is already gone).
 */
async function unarchiveSession(ctx: Context, sessionId: string): Promise<void> {
  const registry: any = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof registry.unarchiveSession !== 'function') throw new Error('workspaceRegistry 服务不可用')
  await registry.unarchiveSession(sessionId)
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

/**
 * Delete one session (logical delete): stop the live agent → `entry.detach()`
 * (or an explicit `session/disposed` emit when no live row exists) → remove
 * workspace accounting → remove archive-set membership via the official
 * `unarchiveSession` → `persistence.stat` existence check (best-effort).
 * Physical artifacts stay with the backend: no `persistence.locate`
 * (removed in 0.1.7), no filesystem removal.
 */
async function deleteSession(ctx: Context, sessionId: string): Promise<Record<string, unknown>> {
  const liveSessions: any = ctx.get('sessions')
  const liveAgents: any = ctx.get('agents')
  const session = liveSessions?.get?.(sessionId)
  const agent = liveAgents?.get?.(sessionId)
  const wasLive = session != null || agent != null

  // Capture what the cleanup below is about to erase, so restore can put it back.
  // Read BEFORE detaching: after this, both facts are gone for good.
  let trash: TrashEntry | null = null
  try {
    const registry: any = ctx.get('workspaceRegistry')
    const workspaceIds: string[] = []
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
    const persistence: any = ctx.get('sessionPersistence')
    if (typeof persistence?.stat === 'function') {
      const header = await persistence.stat(sessionId)
      if (header && typeof header === 'object') {
        cwd = typeof (header as any).cwd === 'string' ? (header as any).cwd : ''
        createdAt = typeof (header as any).createdAt === 'number' ? (header as any).createdAt : 0
        updatedAt = typeof (header as any).updatedAt === 'number' ? (header as any).updatedAt : 0
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
      if (typeof (ctx as any).emit === 'function') (ctx as any).emit('session/disposed', { id: sessionId })
    } catch { /* best-effort */ }
  }

  // Workspace accounting + archive-set membership.
  await detachFromWorkspaces(ctx, sessionId)
  await unarchiveSession(ctx, sessionId)

  // Existence confirmation only (best-effort) — physical artifacts stay
  // with the backend, nothing is removed from disk here.
  try {
    const persistence: any = ctx.get('sessionPersistence')
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

function requireSessionId(payload: Record<string, unknown>): string {
  const sessionId = payload?.sessionId
  if (typeof sessionId !== 'string' || sessionId.trim() === '') throw new Error('sessionId 必填')
  return sessionId.trim()
}

/**
 * Restore one logically deleted session.
 *
 * The re-attach target is the session's OWN cwd, never a synthetic container:
 * `WorkspaceEntity.attachSession` validates `header.cwd` against the workspace
 * path and `get sessionIds()` filters by that same match, so a session can only
 * ever be accounted for by a workspace whose path IS its cwd.
 *
 * Original workspace ids are reused when they still exist; otherwise the cwd's
 * workspace is created. A cwd that no longer resolves is reported rather than
 * silently redirected — attaching it elsewhere would produce accounting DSH
 * itself considers invalid.
 */
async function restoreSession(ctx: Context, sessionId: string): Promise<Record<string, unknown>> {
  const entry = (await readTrash()).find(e => e.sessionId === sessionId)
  if (entry === undefined) return { ok: false, error: 'not-in-trash' as const }

  const registry: any = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function') {
    return { ok: false, error: 'workspaceRegistry 服务不可用' as const }
  }

  // The event log must still be there: everything below reads the header from it.
  const persistence: any = ctx.get('sessionPersistence')
  let header: any = undefined
  try {
    if (typeof persistence?.stat === 'function') header = await persistence.stat(sessionId)
  } catch { /* handled below */ }
  if (header === undefined) {
    return { ok: false, error: 'artifacts-missing' as const, detail: '会话文件已不存在，无法恢复' }
  }

  const cwd = typeof entry.cwd === 'string' && entry.cwd !== '' ? entry.cwd : String(header.cwd ?? '')
  if (cwd === '') return { ok: false, error: 'no-cwd' as const }

  // Workspace the session used to belong to, if that entity is still around.
  const entities = registry.list()
  const original = entry.workspaceIds
    .map(id => entities.find((e: any) => e?.id === id))
    .filter((e: any): e is any => e !== undefined)

  let attachedTo: string[] = []
  const targets: any[] = original.length > 0
    ? original
    : [typeof registry.resolveByPath === 'function' ? await registry.resolveByPath(cwd) : undefined]
        .filter((e: any): e is any => e !== undefined)

  if (targets.length === 0) {
    if (typeof registry.create !== 'function') return { ok: false, error: 'workspaceRegistry 服务不可用' as const }
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
        error: 'attach-failed' as const,
        detail: String(err instanceof Error ? err.message : err),
      }
    }
  }

  if (attachedTo.length === 0) return { ok: false, error: 'attach-failed' as const }

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

async function listDeleted(ctx: Context): Promise<Record<string, unknown>> {
  const entries = await readTrash()
  const persistence: any = ctx.get('sessionPersistence')
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
    const result = await deleteSession(ctx, requireSessionId(payload))
    return { ok: true, result }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  }
}

/** ------------------------------------------------------------------ Task 3/4: move / preset-migrate / workspaces.
 * move 是 fork 式迁移（0.1.7 公开 API）：observeSession 读源会话 →
 * agents.create（回退 sessions.create）按目标 cwd 建新会话并复制事件种子 →
 * registry 记账切换 → 旧会话 archiveSession(stopActivity:true) 归档保留。
 * migratePreset 是官方语义（Task 4）：list 校验 → agents.get 取 live agent →
 * 旧 preset 经 composedPreset/agent ctx 读（回退 sessions.get 的 header）→
 * 相同则 no-op → presets.select 切换；select 抛 agent-preset/locked（非空白）
 * 转中文错。listWorkspaces 仍是 session-manager 移植实现（Task 8 的活）。
 * Live registries use ctx.sessions / ctx.agents property access like the
 * original (hence the inject entries); sessionQuery/persistence/presets stay
 * ctx.get lazy accesses and are intentionally NOT listed.
 */

/**
 * Hex nonce for fork-style move child ids. session-manager uses node:crypto
 * randomBytes; this host keeps the waived node:* surface to fs/promises + path
 * (R5), so a Math.random nonce is used instead — uniqueness is best-effort.
 */
function randomHex(bytes: number): string {
  let out = ''
  for (let i = 0; i < bytes; i += 1) out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  return out
}

/**
 * Ordered workspace projection for the client (move-target picker).
 * Ported from session-manager `listWorkspaces`; tolerates function-shaped
 * sessionIds like listSessions/detachFromWorkspaces do (real WorkspaceEntity
 * exposes an array, so production behavior is identical).
 */
function listWorkspaces(ctx: Context): unknown[] {
  const registry: any = (ctx as any).workspaceRegistry
  return registry.list().map((entity: any) => {
    const raw = entity.record?.sessionIds
    const ids = Array.isArray(raw)
      ? [...raw]
      : (typeof entity.sessionIds === 'function' ? entity.sessionIds() : entity.sessionIds)
    const rawIds = Array.isArray(ids) ? [...ids] : []
    return {
      id: entity.id,
      name: entity.title || entity.id,
      title: entity.title || entity.id,
      path: entity.path,
      sessionCount: rawIds.length,
      sessionIds: rawIds,
    }
  })
}

/**
 * Fork-style cross-workspace move using only 0.1.7 public APIs.
 * Confirmed semantics: move = keep the source session archived + create a new
 * session at the target cwd + copy the event seed + switch workspace
 * accounting; the session id changes.
 * Steps: validate target → observeSession (failure → session-not-found 中文错)
 * → subagent refuse → same-dir no-op → stop live agent (cancel + whenIdle +
 * flush; internal store / prepare / enter are never touched) → agents.create
 * the new session (meta.cwd = target path, seed = source events; falls back
 * to sessions.create) → accounting switch (detach old / attach new) →
 * archive the source (stopActivity:true) → return { ok, sessionId:<newId>,
 * moved, fromWorkspaceIds, toWorkspaceId, toWorkspaceTitle, archivedSourceId,
 * wasLive }.
 */
async function moveSession(ctx: Context, sessionId: string, targetWorkspaceId: string): Promise<Record<string, unknown>> {
  const registry: any = (ctx as any).workspaceRegistry
  const logger: any = (ctx as any).logger
  const sessionQuery: any = ctx.get('sessionQuery')

  const target = registry.list().find((entity: any) => entity.id === targetWorkspaceId)
  if (target === undefined) {
    const error = new Error(`目标工作区不存在: ${targetWorkspaceId}`) as Error & { code?: string }
    error.code = 'workspace-not-found'
    throw error
  }
  const targetPath = target.path // canonical (realpath) workspace directory

  // ---- 0. observe the source session via the public query face ----
  if (sessionQuery === undefined || typeof sessionQuery.observeSession !== 'function') {
    throw new Error('sessionQuery 服务不可用')
  }
  let observed: any
  try {
    observed = await sessionQuery.observeSession(sessionId)
  } catch {
    const error = new Error(`会话 ${sessionId} 不存在，无法移动`) as Error & { code?: string }
    error.code = 'session-not-found'
    throw error
  }
  const sourceHeader = observed?.header
  const sourceEvents: any[] = Array.isArray(observed?.events) ? [...observed.events] : []
  try {
    if (typeof observed?.[Symbol.dispose] === 'function') observed[Symbol.dispose]()
  } catch { /* best-effort: the observation lease is caller-owned */ }

  if (sourceHeader?.origin === 'subagent') {
    const error = new Error('子代理（subagent）会话不支持跨工作区移动') as Error & { code?: string }
    error.code = 'subagent-unsupported'
    throw error
  }

  // No-op when the source cwd already resolves to the target directory.
  if (typeof sourceHeader?.cwd === 'string') {
    let currentCanonical: string | undefined
    try {
      currentCanonical = await realpath(sourceHeader.cwd)
    } catch { /* old directory gone — the fork below re-homes it */ }
    if (currentCanonical === targetPath) {
      return { ok: true, sessionId, moved: false, message: '会话已属于目标工作区' }
    }
  }

  // ---- 1. stop the live agent/session WITHOUT touching internal store ----
  const liveSessions: any = (ctx as any).sessions
  const liveAgents: any = (ctx as any).agents
  const liveSession = liveSessions?.get?.(sessionId)
  const liveAgent = liveAgents?.get?.(sessionId)
  const wasLive = liveSession !== undefined || liveAgent !== undefined
  if (liveAgent !== undefined) {
    try { liveAgent.cancel({ kind: 'disposed' }) } catch { /* best-effort */ }
    if (typeof liveAgent.whenIdle === 'function') await liveAgent.whenIdle()
  }
  if (liveSession !== undefined) {
    try { await liveSessions.flush(liveSession) } catch { /* best-effort */ }
  }

  // ---- 2. fork: create the new session at the target cwd with the copied seed ----
  // Preserve the source preset attribution: without it the forked session
  // loses its preset (falls back to the default).
  const newSessionId = `session-${randomHex(8)}`
  const seed = sourceEvents
  const newMeta: Record<string, unknown> = { cwd: targetPath }
  if (typeof sourceHeader?.agentPreset === 'string') newMeta.agentPreset = sourceHeader.agentPreset
  if (liveAgents !== undefined && typeof liveAgents.create === 'function') {
    await liveAgents.create({
      sessionId: newSessionId,
      meta: newMeta,
      seed,
    })
  } else if (liveSessions !== undefined && typeof liveSessions.create === 'function') {
    await liveSessions.create({
      sessionId: newSessionId,
      meta: newMeta,
      seed,
    })
  } else {
    throw new Error('agents/sessions 服务不可用，无法创建新会话')
  }

  // ---- 3. switch workspace accounting: detach old, attach new ----
  const fromWorkspaceIds: string[] = []
  try {
    await registry.enqueueOperation(async () => {
      for (const entity of registry.list()) {
        if (entity.id === target.id) continue
        const rawIds = Array.isArray(entity.record?.sessionIds)
          ? entity.record.sessionIds
          : entity.sessionIds
        const ids = typeof rawIds === 'function' ? rawIds() : rawIds
        if (Array.isArray(ids) && ids.includes(sessionId)) {
          fromWorkspaceIds.push(entity.id)
          await entity.detachSession(sessionId)
        }
      }
      await target.attachSession(newSessionId)
    })
  } catch (error) {
    throw new Error(`新会话已创建（${newSessionId}），但工作区记账切换失败: ${String(error)}`)
  }

  // ---- 4. archive the source session (kept; stop its activity) ----
  try {
    await registry.archiveSession(sessionId, { stopActivity: true })
  } catch (error) {
    try { logger?.warn?.(`session-browser: archiving move source "${sessionId}" failed: ${String(error)}`) } catch { /* best-effort */ }
  }

  try { logger?.info?.(`session-browser: moved "${sessionId}" to "${newSessionId}" in ${target.id}`) } catch { /* best-effort */ }

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
  }
}
/* === preset-migration (official 0.1.7 semantics) === */

/**
 * Switch the Agent preset of a blank session via the official face.
 * Confirmed semantics: preset-migrate = `agentPresets.select` on a blank
 * session; non-blank sessions are refused (select throws agent-preset/locked).
 * Steps: validate args → list roster + find target (+broken check) →
 * agents.get(sessionId) for the live agent (missing → 中文错) →
 * read the old preset (composedPreset(agent.ctx) first, live session header
 * fallback) → same preset is a no-op → presets.select(agent, toPreset) →
 * locked errors become the 中文 "已开始" refusal.
 */
async function migratePreset(ctx: Context, opts: { sessionId: string; toPreset: string }): Promise<Record<string, unknown>> {
  const sessionId = typeof opts.sessionId === 'string' ? opts.sessionId.trim() : ''
  const toPreset = typeof opts.toPreset === 'string' ? opts.toPreset.trim() : ''
  if (sessionId === '') { const e = new Error('sessionId required') as Error & { code?: string }; e.code = 'bad-request'; throw e }
  if (toPreset === '') { const e = new Error('toPreset required') as Error & { code?: string }; e.code = 'bad-request'; throw e }

  const presets: any = ctx.get('agentPresets')
  if (presets === undefined || typeof presets.list !== 'function') {
    throw new Error('agentPresets service unavailable')
  }
  const roster = await presets.list()
  const target = (roster || []).find((preset: any) => preset && preset.id === toPreset)
  if (target === undefined) {
    const available = (roster || []).map((preset: any) => preset?.id).filter(Boolean)
    throw new Error(`Agent 预设 "${toPreset}" 不存在（可用：${available.join(', ')}）`)
  }
  if (target.broken) throw new Error(`Agent 预设 "${toPreset}" 不可用：${target.broken}`)

  const liveAgents: any = (ctx as any).agents
  const liveSessions: any = (ctx as any).sessions
  const agent = liveAgents?.get?.(sessionId)
  if (agent == null) throw new Error(`会话 "${sessionId}" 没有 live agent，无法切换预设（仅空白会话支持在线切换）`)

  let oldPreset: string | undefined
  try {
    if (typeof presets.composedPreset === 'function') oldPreset = presets.composedPreset(agent.ctx)
  } catch { /* best-effort: fall back to the live session header */ }
  if (oldPreset === undefined) {
    const liveSession = liveSessions?.get?.(sessionId)
    const headerPreset = liveSession?.header?.agentPreset
    if (typeof headerPreset === 'string') oldPreset = headerPreset
  }
  if (oldPreset === toPreset) {
    return { sessionId, migrated: false, oldPreset, newPreset: toPreset }
  }

  let committed: string
  try {
    committed = await presets.select(agent, toPreset)
  } catch (err) {
    const code = (err as unknown as { code?: unknown })?.code
    const message = String(err instanceof Error ? err.message : err)
    if (code === 'agent-preset/locked' || /already started|locked/i.test(message)) {
      throw new Error(`会话 "${sessionId}" 已开始，无法切换预设（可 fork 该会话后再选预设）`)
    }
    throw err
  }
  return { sessionId, migrated: true, oldPreset, newPreset: committed }
}

function requireTargetWorkspaceId(payload: Record<string, unknown>): string {
  const targetWorkspaceId = payload?.targetWorkspaceId
  if (typeof targetWorkspaceId !== 'string' || targetWorkspaceId.trim() === '') throw new Error('targetWorkspaceId 必填')
  return targetWorkspaceId.trim()
}

async function handleMove(ctx: Context, payload: Record<string, unknown>) {
  try {
    const result = await moveSession(ctx, requireSessionId(payload), requireTargetWorkspaceId(payload))
    return { ok: true, result }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  }
}

async function handlePresetMigrate(ctx: Context, payload: Record<string, unknown>) {
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
  const toPreset = typeof payload?.toPreset === 'string' ? payload.toPreset.trim() : ''
  if (sessionId === '' || toPreset === '') return { ok: false, error: 'sessionId and toPreset required' }
  try {
    const result = await migratePreset(ctx, { sessionId, toPreset })
    return { ok: true, result }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  }
}

async function handleWorkspaces(ctx: Context) {
  try {
    return { ok: true, result: { workspaces: listWorkspaces(ctx) } }
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
    const ungroupedOnly = payload?.ungrouped === true
    const archivedOnly = payload?.archived === true
    const archivedIds = readArchivedIds(ctx)
    const allHeaders = normalizeHeaders(await persistence.list())
    // DSH 的 WorkspaceEntity.get sessionIds()（entity.ts:102）会用
    // `host.sessionPath(id) === record.path` 再过滤一遍，而 sessionPaths 的 key
    // 是 header.id（裸 UUID）。实测记账里 id 格式并不统一——同一个工作区的 81 条
    // 里有 19 条带 `session-` 前缀（entity.ts:652 之外的遗留写法），这些查不到
    // 路径，会被 getter 整条丢弃。插件若直接用 getter，未分组页就会把"明明有
    // 工作区归属"的会话错算成无归属。故改读原始 record.sessionIds，并对前缀做
    // 双向兼容，两种格式都能匹配上 header.id。
    const registry = ctx.get('workspaceRegistry')
    const groupedIds = new Set<string>()
    const addId = (raw: unknown) => {
      if (typeof raw !== 'string' || raw === '') return
      groupedIds.add(raw)
      if (raw.startsWith('session-')) groupedIds.add(raw.slice('session-'.length))
    }
    if (registry !== undefined && typeof registry.list === 'function') {
      for (const entity of registry.list()) {
        const ids = entity?.record?.sessionIds ?? (typeof entity?.sessionIds === 'function' ? entity.sessionIds() : entity?.sessionIds)
        if (Array.isArray(ids)) for (const id of ids) addId(id)
      }
    }
    const headers = allHeaders.filter((h: any) => {
      if (h.origin === 'subagent') return false
      if (ungroupedOnly) { if (groupedIds.has(h.id)) return false }
      else if (!groupedIds.has(h.id)) return false
      // 归档分流：已归档页只取交集，未归档页排除已归档 id
      if (archivedOnly) { if (!archivedIds.has(h.id)) return false }
      else if (archivedIds.has(h.id)) return false
      return true
    })
    // Derive title from session/title event or first user message.
    // Parallel with a bounded window, cache-keyed on (id, updatedAt): a page-tab
    // switch used to re-read every conversation's full event log serially, which
    // is where the visible stall came from.
    const items = await mapWithConcurrency(headers, TITLE_READ_CONCURRENCY, async (h: any) => {
      const key = `${h.id}@${h.updatedAt ?? h.createdAt ?? ''}`
      let title = titleCache.get(key)
      if (title === undefined) {
        title = ''
        try {
          const events = await readEventsUntil(persistence, h.id, titleFromEvents)
          title = (events ? titleFromEvents(events) : undefined) || ''
        } catch { /* ignore */ }
        if (titleCache.size >= TITLE_CACHE_MAX) {
          const oldest = titleCache.keys().next()
          if (!oldest.done) titleCache.delete(oldest.value)
        }
        titleCache.set(key, title)
      }
      return {
        sessionId: h.id,
        title: title || shortPath(h.cwd) || '未命名',
        cwd: h.cwd || '',
        createdAt: h.createdAt,
        updatedAt: h.updatedAt || h.createdAt,
        archived: archivedIds.has(h.id),
      }
    })
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
          messageId: typeof data.id === 'string' ? data.id : undefined,
          // Engine-owned anchor key (conversationContextKey('input-message', id)
          // = `13:input-message${id}`); the client uses it verbatim instead of
          // re-deriving the format. Absent when the event has no string id —
          // the client then falls back to the legacy seq shape (best-effort).
          anchorKey: typeof data.id === 'string' ? `13:input-message${data.id}` : undefined,
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
        if (method === 'list-deleted') {
          writeJson(res, 200, await listDeleted(ctx))
          return
        }
        if (method === 'restore') {
          // Failure is reported in-band ({ ok:false, error }) so the client can
          // show the precise reason (artifacts-missing / attach-failed / …).
          writeJson(res, 200, await restoreSession(ctx, requireSessionId(payload)))
          return
        }
        if (method === 'move') {
          writeJson(res, 200, await handleMove(ctx, payload))
          return
        }
        if (method === 'preset-migrate') {
          writeJson(res, 200, await handlePresetMigrate(ctx, payload))
          return
        }
        if (method === 'workspaces') {
          writeJson(res, 200, await handleWorkspaces(ctx))
          return
        }
        writeJson(res, 404, { ok: false, error: `unknown method "${method}"` })
      } catch (err) {
        writeJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }), 'dsh-session-browser: /session-browser/api route')
}
