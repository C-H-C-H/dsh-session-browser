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
 * - `/session-browser/api/move` — `{ sessionId, targetWorkspaceId }` → `{ ok: true, result }`
 * - `/session-browser/api/preset-migrate` — `{ sessionId, toPreset }` → `{ ok: true, result }`
 * - `/session-browser/api/workspaces` — `{}` → `{ ok: true, result: { workspaces } }`
 */
import type { Context } from 'cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

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

/** ------------------------------------------------------------------ Task 3: move / preset-migrate / workspaces.
 * Ported from dsh-session-manager lib/index.js (move flow with artifact
 * migration + accounting swap; migratePreset effective-preset rewrite;
 * listWorkspaces ordered projection). Dropped as unrelated: preset-scan route
 * (+ its scan helpers), the post-boot reconcile effect, legacy commented move.
 * Live registries use ctx.sessions / ctx.agents property access like the
 * original (hence the inject entries); persistence/presets stay ctx.get.
 */

/** User-facing error string that never throws and never leaks internals. Ported from session-manager. */
function safeErrorMessage(error: unknown): string {
  if (error === null || error === undefined) return `<nullish:${typeof error}>`
  if (typeof error === 'string') return error
  if (typeof error === 'object') {
    const obj = error as { message?: unknown; code?: unknown }
    if (typeof obj.message === 'string' && obj.message.length > 0) return obj.message
    if (typeof obj.code === 'string' && obj.code.length > 0) return `[code=${obj.code}]`
  }
  try { return JSON.stringify(error) } catch { return String(error) }
}

/**
 * Hex nonce for temp-file names. session-manager uses node:crypto randomBytes;
 * this host keeps the waived node:* surface to fs/promises + path (R5), so a
 * Math.random nonce is used instead — uniqueness is best-effort either way
 * because writeTempFile opens with 'wx' (exclusive) and rename failures roll back.
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
 * Quiet a live session + agent so the artifact is quiesced WITHOUT removing it
 * from the live store. Ported from session-manager `quietLive` verbatim (see
 * original comments): use before any operation that might still fail, so a
 * failed migration never fires `session/disposed` while durable state is unchanged.
 */
async function quietLive(ctx: Context, sessionId: string): Promise<boolean> {
  const liveSessions: any = (ctx as any).sessions
  const liveAgents: any = (ctx as any).agents
  const session = liveSessions?.get?.(sessionId)
  const agent = liveAgents?.get?.(sessionId)
  const wasLive = session !== undefined || agent !== undefined

  if (agent !== undefined) {
    // Complete cancellation before the session is detached (see original: the
    // old timeout-based scope disposal could leave the write path owning this
    // Session while the artifact had already been moved).
    agent.cancel({ kind: 'disposed' })
    if (typeof agent.whenIdle === 'function') await agent.whenIdle()
    if (typeof agent.scope?.dispose === 'function') await agent.scope.dispose()
    // Drop the stale registry entry only after the driver has quiesced.
    try { liveAgents.store?.delete?.(sessionId) } catch { /* best-effort */ }
  }

  if (session !== undefined) {
    // Flush buffered events to disk (final drain) — the persistence write-path
    // turns this into a settled retirement, so the upcoming readRaw() sees a
    // quiesced artifact. The store entry itself is NOT touched.
    try { await liveSessions.flush(session) } catch { /* best-effort */ }
  }
  return wasLive
}

/**
 * Detach the live store entry — the only call site that fires
 * `session/disposed` (relayed as `host/session-removed`). Ported from
 * session-manager `releaseLiveSession`: call only AFTER every durable
 * side-effect of the migration is committed.
 */
async function releaseLiveSession(ctx: Context, sessionId: string): Promise<void> {
  const liveSessions: any = (ctx as any).sessions
  try {
    const entry = liveSessions?.store?.get?.(sessionId)
    if (entry !== undefined && typeof entry.detach === 'function') {
      entry.detach()
      await sleep(250) // let the write-behind retirement settle
    }
  } catch { /* best-effort */ }
}

/**
 * Durable temp-file write next to its final target. Ported from session-manager
 * `writeTempFile` (randomBytes → randomHex, see above). Returns the temp path;
 * the caller publishes it with a rename once the coast is clear.
 */
async function writeTempFile(finalPath: string, data: Buffer): Promise<string> {
  const temp = `${finalPath}.${randomHex(6)}.tmp`
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return temp
}

/**
 * Encode the moved artifact in the backend's own physical layout: plain JSONL,
 * or zstd frames whose FIRST frame is exactly the header line (the reader's
 * assertZstdHeaderFrame / readFirstZstdLine contract). Ported verbatim.
 */
async function encodeArtifact(headerLine: string, rest: string, isZstd: boolean): Promise<Buffer> {
  if (!isZstd) return Buffer.from(`${headerLine}\n${rest}`, 'utf8')
  const { zstdCompress } = await import('node:zlib')
  if (typeof zstdCompress !== 'function') {
    throw new Error('当前 Node 运行时没有 zstd 支持，无法迁移 zstd 编码的会话工件')
  }
  const compress = (buffer: Buffer): Promise<Buffer> => new Promise((resolve, reject) => {
    zstdCompress(buffer, (error: unknown, output: Buffer) => error == null ? resolve(output) : reject(error))
  })
  const headerFrame = await compress(Buffer.from(`${headerLine}\n`, 'utf8'))
  if (rest === '') return headerFrame
  const bodyFrame = await compress(Buffer.from(rest, 'utf8'))
  return Buffer.concat([headerFrame, bodyFrame])
}

/**
 * TRUE cross-workspace move: re-home the stored cwd, migrate the artifact, then
 * swap accounting. Ported from session-manager `moveSession` — history, titles,
 * archive-set membership and lineage are preserved; only the working directory
 * the session belongs to changes. Throws an Error with a readable (verbatim
 * Chinese) message on every failure path; the artifact is restored (or its
 * location reported) whenever a mid-move step fails.
 */
async function moveSession(ctx: Context, sessionId: string, targetWorkspaceId: string): Promise<Record<string, unknown>> {
  const registry: any = (ctx as any).workspaceRegistry
  const logger: any = (ctx as any).logger
  const persistence: any = ctx.get('sessionPersistence')
  if (persistence === undefined) throw new Error('sessionPersistence 服务不可用')
  if (typeof persistence.readRaw !== 'function' || typeof persistence.loadStored !== 'function') {
    throw new Error('当前持久化后端不支持 readRaw/loadStored，无法跨工作区移动')
  }

  const target = registry.list().find((entity: any) => entity.id === targetWorkspaceId)
  if (target === undefined) {
    const error = new Error(`目标工作区不存在: ${targetWorkspaceId}`) as Error & { code?: string }
    error.code = 'workspace-not-found'
    throw error
  }
  const targetPath = target.path // canonical (realpath) workspace directory

  // ---- 0. pre-flight: the session must exist on disk -------------------
  const storedHeaders = await persistence.list()
  const storedHeader = storedHeaders.find((header: any) => header.id === sessionId)
  if (storedHeader === undefined) {
    const error = new Error(
      `会话 ${sessionId} 没有磁盘记录（不存在，或是一个尚未发送任何消息的空白会话），无法移动`
    ) as Error & { code?: string }
    error.code = 'session-not-found'
    throw error
  }
  if (storedHeader.origin === 'subagent') {
    const error = new Error('子代理（subagent）会话不支持跨工作区移动') as Error & { code?: string }
    error.code = 'subagent-unsupported'
    throw error
  }

  // No-op when the header's cwd already resolves to the target directory.
  if (storedHeader.cwd !== undefined) {
    let currentCanonical: string | undefined
    try {
      currentCanonical = await realpath(storedHeader.cwd)
    } catch { /* old directory gone — the move below re-homes it */ }
    if (currentCanonical === targetPath) {
      return { ok: true, sessionId, moved: false, message: '会话已属于目标工作区' }
    }
  }

  // ---- 1. quiet the live session WITHOUT removing it from store ----
  const wasLive = await quietLive(ctx, sessionId)

  // ---- 2. read the artifact verbatim and rewrite the header cwd --------
  const raw = await persistence.readRaw(sessionId)
  if (raw === undefined) {
    throw new Error('读取会话工件失败：readRaw 未找到会话文件')
  }
  const meta = raw.meta
  const newlineAt = raw.content.indexOf('\n')
  if (newlineAt === -1) throw new Error('会话工件缺少头行，数据可能损坏')
  const headerText = raw.content.slice(0, newlineAt)
  const rest = raw.content.slice(newlineAt + 1)

  let headerObject: any
  try {
    headerObject = JSON.parse(headerText)
  } catch (error) {
    throw new Error(`会话工件头行无法解析: ${String(error)}`)
  }
  if (headerObject.id !== sessionId) throw new Error('会话工件头行 id 与请求不符，拒绝移动')
  headerObject.cwd = targetPath
  const newHeaderLine = JSON.stringify(headerObject)

  const newLocation = persistence.locate({ ...meta, cwd: targetPath })
  const oldLocation = persistence.locate(meta) // === the file readRaw just read
  if (newLocation === undefined || oldLocation === undefined) {
    throw new Error('持久化后端无法定位会话工件路径')
  }
  const bytes = await encodeArtifact(
    newHeaderLine,
    rest,
    newLocation.path.endsWith('.zstd')
  )

  // ---- 3. publish the new artifact; never leave a duplicate id ---------
  await mkdir(dirname(newLocation.path), { recursive: true })
  const tempNew = await writeTempFile(newLocation.path, bytes)

  let oldHidden: string | undefined
  try {
    // Hide the old artifact first (rename inside its own directory):
    // scans only see exact `session.jsonl[.zstd]` names, so between the
    // two renames exactly one log is visible instead of a duplicate id
    // (a duplicate would make the backend's list()/findLog() throw).
    oldHidden = `${oldLocation.path}.${randomHex(6)}.tmp`
    await rename(oldLocation.path, oldHidden)
  } catch (error) {
    await rm(tempNew, { force: true })
    throw new Error(`移动失败（无法隐藏旧会话工件，已取消，会话保持原状）: ${String(error)}`)
  }

  try {
    await rename(tempNew, newLocation.path)
  } catch (error) {
    let restored = false
    try {
      await rename(oldHidden as string, oldLocation.path)
      restored = true
    } catch { /* reported below */ }
    await rm(tempNew, { force: true })
    if (!restored) {
      throw new Error(
        `移动失败且旧工件回滚失败——原数据保留在 ${oldHidden}，请手动恢复: ${String(error)}`
      )
    }
    throw new Error(`移动失败（已回滚，会话保持原状）: ${String(error)}`)
  }

  // Cleanup of the old artifact and its parent directory is DEFERRED to the
  // very end of moveSession (right before success-return) — see original: any
  // error thrown before that point must still find oldHidden alive for restore.

  // ---- 4. swap workspace accounting through the registry's own path ----
  let stored: any
  try {
    stored = await persistence.loadStored(sessionId)
    if (stored === undefined || stored.meta.cwd !== targetPath) {
      throw new Error('迁移后的会话日志读取校验失败')
    }
  } catch (error) {
    throw new Error(`工件已迁移至 ${newLocation.path}，但记账前校验失败: ${String(error)}`)
  }

  // Remove the live entry from the store BEFORE constructing the placeholder
  // so prepare() does not throw "session already exists" — silently (the
  // original flips the announce latch; here detach() is best-effort silent in
  // the same spirit: no row flicker while the disk migration commits).
  const liveSessions: any = (ctx as any).sessions
  const originalEntry = liveSessions?.store?.get?.(sessionId)
  if (originalEntry !== undefined && typeof originalEntry.detach === 'function') {
    try {
      originalEntry.detach()
    } catch (error) {
      logger.warn(`session-manager: pre-move detach of original entry failed for "${sessionId}": ${String(error)}`)
    }
  }
  let detachPlaceholder: (() => void) | null = null
  try {
    const placeholder = liveSessions.prepare(sessionId, {
      seedSource: 'persistence',
      seed: stored.events,
      meta: stored.meta
    })
    detachPlaceholder = liveSessions.enter(placeholder)
  } catch (error) {
    // Disk state at this point: newLocation holds the new artifact, oldHidden
    // holds the original. Undo both (new first, so the same id never exists
    // twice on disk during the swap).
    let newRemoved = true
    try { await rm(newLocation.path, { force: true }) }
    catch { newRemoved = false }
    try { await rm(dirname(newLocation.path), { recursive: true, force: true }) }
    catch { /* best-effort */ }
    let restored = false
    try { await rename(oldHidden as string, oldLocation.path); restored = true }
    catch { /* reported below */ }
    if (!restored) {
      throw new Error(
        `构造校验失败且旧工件回滚失败——原数据保留在 ${oldHidden}，请手动恢复: ${safeErrorMessage(error)}`
      )
    }
    try { await rm(dirname(oldLocation.path), { recursive: true, force: true }) }
    catch { /* best-effort */ }
    if (!newRemoved) {
      throw new Error(
        `旧工件已回滚但新工件 ${newLocation.path} 仍未清理，请手动删除: ${safeErrorMessage(error)}`
      )
    }
    throw new Error(
      `工件已迁移至 ${newLocation.path}，但构造校验会话失败（已回滚磁盘，会话保持原状）: ${safeErrorMessage(error)}`
    )
  }

  const fromWorkspaceIds: string[] = []
  // Set by the enqueueOperation callback only when target.attachSession has
  // durably accepted the new accounting — the broadcast below is gated on this.
  let attachSucceeded = false
  try {
    await registry.enqueueOperation(async () => {
      for (const entity of registry.list()) {
        if (entity.id === target.id) continue
        // Raw-record membership: the index-filtered getter would hide stale
        // accounting exactly where a move must clean it up.
        const rawIds = Array.isArray(entity.record?.sessionIds)
          ? entity.record.sessionIds
          : entity.sessionIds
        if (rawIds.includes(sessionId)) {
          fromWorkspaceIds.push(entity.id)
          await entity.detachSession(sessionId)
        }
      }
      await target.attachSession(sessionId)
      attachSucceeded = true
    })
  } finally {
    try {
      // Push a synthetic session/created so the apiproxy broadcast path
      // forwards host/session-added to every connected mux consumer (see
      // original: a one-shot fake session object, never detached, so the push
      // is purely additive). Title projection is re-folded by replaying the
      // title-relevant events in order.
      if (attachSucceeded) {
        const fakeSession = {
          id: sessionId,
          header: { ...stored.meta, cwd: targetPath },
          events: stored.events,
        }
        if (Array.isArray(stored.events)) {
          for (const event of stored.events) {
            if (event === undefined || event === null) continue
            if (event.type !== 'session/title' && event.type !== 'user/message') continue
            try { (ctx as any).emit('session/event', fakeSession, event) }
            catch (driveError) {
              logger.warn(`session-manager: post-move session/event drive failed for "${sessionId}" (title may render from fallback until next list pull): ${String(driveError)}`)
            }
          }
        }
      }
    } catch { /* best-effort */ }
    try {
      if (detachPlaceholder !== null) detachPlaceholder()
    } catch { /* best-effort */ }
  }

  // Replay the projection-relevant events BEFORE the live entry is detached, so
  // every connected client's title cell picks up the new value without the
  // session/created + session/disposed flicker (see original).
  try {
    const reread = await persistence.loadStored(sessionId)
    if (reread !== undefined && Array.isArray(reread.events)) {
      const fresh = {
        id: sessionId,
        header: { ...reread.meta, cwd: targetPath },
        events: reread.events
      }
      for (const event of reread.events) {
        if (event === undefined || event === null) continue
        if (event.type !== 'session/title' && event.type !== 'user/message') continue
        try { (ctx as any).emit('session/event', fresh, event) } catch { /* best-effort */ }
      }
    }
  } catch (error) {
    logger.warn(`session-manager: post-move event replay failed for "${sessionId}": ${String(error)}`)
  }

  // Fire the final `session/disposed` ONLY here — every other migration step
  // above has succeeded, so the row's home in the target workspace is durable.
  await releaseLiveSession(ctx, sessionId)

  // `session/disposed` retires persistence asynchronously. Recover only an
  // orphaned owner left by older move implementations (see original).
  try {
    if (typeof persistence.inspect === 'function') await persistence.inspect(sessionId)
    const states = persistence.states
    const state = states?.get?.(sessionId)
    if (state?.owner !== undefined && liveSessions?.get?.(sessionId) === undefined && (ctx as any).agents?.get?.(sessionId) === undefined) {
      states.delete(sessionId)
      logger.warn(`session-manager: cleared stale persistence owner after move for "${sessionId}"`)
    }
  } catch (error) {
    logger.warn(`session-manager: post-move persistence retirement check failed for "${sessionId}": ${String(error)}`)
  }

  logger.info(
    `session-manager: moved "${sessionId}" ` +
    `${fromWorkspaceIds.length > 0 ? fromWorkspaceIds.join(',') + ' -> ' : ''}${target.id} ` +
    `(${oldLocation.path} -> ${newLocation.path})`
  )

  // Success is durable: drop the renamed original artifact and its (possibly
  // empty) parent directory — any earlier error would have restored from it.
  try {
    await rm(oldHidden as string, { force: true })
  } catch { /* best-effort */ }
  try {
    await rm(dirname(oldLocation.path), { recursive: true, force: true })
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
  }
}

/* === preset-migration (session-manager v0.3.0) === */
const NL = String.fromCharCode(10)

/**
 * Fully retire a live agent/session before rewriting its durable preset.
 * Ported from session-manager `retireForPresetMigration` verbatim (see
 * original): waiting through persistence.load()/inspect() is the ownership
 * barrier, and only a proven-orphaned persistence owner is cleared.
 */
async function retireForPresetMigration(ctx: Context, sessionId: string, persistence: any): Promise<void> {
  const liveAgents: any = (ctx as any).agents
  const liveSessions: any = (ctx as any).sessions
  const logger: any = (ctx as any).logger
  const agent = liveAgents?.get?.(sessionId)
  if (agent !== undefined) {
    try { agent.cancel({ kind: 'disposed' }) } catch { /* best-effort */ }
    if (typeof agent.whenIdle === 'function') await agent.whenIdle()
    if (typeof agent.scope?.dispose === 'function') await agent.scope.dispose()
    try { liveAgents.store?.delete?.(sessionId) } catch { /* best-effort */ }
  }

  const entry = liveSessions?.store?.get?.(sessionId)
  if (entry !== undefined && typeof entry.detach === 'function') entry.detach()

  // Do not mutate the artifact until both registries have released it.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (liveAgents?.get?.(sessionId) === undefined && liveSessions?.get?.(sessionId) === undefined) break
    await sleep(25)
  }
  if (liveAgents?.get?.(sessionId) !== undefined || liveSessions?.get?.(sessionId) !== undefined) {
    throw new Error(`会话 "${sessionId}" 无法安全关闭，已取消预设迁移`)
  }

  if (typeof persistence.inspect === 'function') {
    await persistence.inspect(sessionId)
  } else if (typeof persistence.load === 'function') {
    await persistence.load(sessionId)
  }

  // Recovery for sessions affected by the older move/preset code (see original).
  const states = persistence.states
  const state = states?.get?.(sessionId)
  if (state?.owner !== undefined) {
    states.delete(sessionId)
    logger.warn(`session-manager: cleared stale persistence owner for "${sessionId}" during preset migration`)
  }
}

/**
 * Rewrite exactly one conversation's effective Agent preset. Ported from
 * session-manager `migratePreset`: sessions with an agent-preset/selected event
 * derive their preset from the LAST such event (rewrite that event); older
 * sessions derive it from the header (rewrite only the header field).
 */
async function migratePreset(ctx: Context, opts: { sessionId: string; toPreset: string }): Promise<Record<string, unknown>> {
  const logger: any = (ctx as any).logger
  const sessionId = typeof opts.sessionId === 'string' ? opts.sessionId.trim() : ''
  const toPreset = typeof opts.toPreset === 'string' ? opts.toPreset.trim() : ''
  if (sessionId === '') { const e = new Error('sessionId required') as Error & { code?: string }; e.code = 'bad-request'; throw e }
  if (toPreset === '') { const e = new Error('toPreset required') as Error & { code?: string }; e.code = 'bad-request'; throw e }

  const presets = ctx.get('agentPresets')
  if (presets === undefined || typeof (presets as any).list !== 'function') {
    throw new Error('agentPresets service unavailable')
  }
  const roster = await (presets as any).list()
  const target = (roster || []).find((preset: any) => preset && preset.id === toPreset)
  if (target === undefined) {
    const available = (roster || []).map((preset: any) => preset?.id).filter(Boolean)
    throw new Error(`Agent 预设 "${toPreset}" 不存在（可用：${available.join(', ')}）`)
  }
  if (target.broken !== undefined) throw new Error(`Agent 预设 "${toPreset}" 不可用：${target.broken}`)

  const persistence: any = ctx.get('sessionPersistence')
  if (persistence === undefined) throw new Error('sessionPersistence service unavailable')
  if (typeof persistence.readRaw !== 'function') throw new Error('current persistence backend does not support readRaw')

  // Build the replacement before touching the live lifecycle (Plan B rule).
  const raw = await persistence.readRaw(sessionId)
  if (raw === undefined) throw new Error(`session "${sessionId}" has no artifact`)
  const lines = raw.content.split(NL)
  if (lines.length < 2) throw new Error('session artifact has no header line')
  let headerObj: any
  try { headerObj = JSON.parse(lines[0]) } catch { throw new Error('session header parse failed') }
  if (headerObj.id !== sessionId) throw new Error('session header id mismatch')

  let selectedIndex = -1
  let selectedPreset: string | undefined
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '') continue
    let event: any
    try { event = JSON.parse(lines[index]) } catch { continue }
    if (event && event.type === 'agent-preset/selected' && event.data && typeof event.data.agentPreset === 'string') {
      selectedIndex = index
      selectedPreset = event.data.agentPreset
    }
  }
  const oldPreset = selectedIndex >= 0 ? selectedPreset : headerObj.agentPreset
  if (oldPreset === toPreset) {
    return { sessionId, migrated: false, oldPreset, newPreset: toPreset }
  }

  if (selectedIndex >= 0) {
    const event = JSON.parse(lines[selectedIndex])
    event.data = { ...event.data, agentPreset: toPreset }
    lines[selectedIndex] = JSON.stringify(event)
  } else {
    headerObj.agentPreset = toPreset
    lines[0] = JSON.stringify(headerObj)
  }

  await retireForPresetMigration(ctx, sessionId, persistence)

  // Re-read after retirement so a final buffered append cannot be lost (same
  // Plan-B rule applied to the final durable text).
  const settledRaw = await persistence.readRaw(sessionId)
  if (settledRaw === undefined) throw new Error(`session "${sessionId}" disappeared during retirement`)
  const settledLines = settledRaw.content.split(NL)
  let settledHeader: any
  try { settledHeader = JSON.parse(settledLines[0]) } catch { throw new Error('settled session header parse failed') }
  let settledSelectedIndex = -1
  for (let index = 1; index < settledLines.length; index += 1) {
    if (settledLines[index] === '') continue
    let event: any
    try { event = JSON.parse(settledLines[index]) } catch { continue }
    if (event && event.type === 'agent-preset/selected' && event.data && typeof event.data.agentPreset === 'string') {
      settledSelectedIndex = index
    }
  }
  if (settledSelectedIndex >= 0) {
    const event = JSON.parse(settledLines[settledSelectedIndex])
    event.data = { ...event.data, agentPreset: toPreset }
    settledLines[settledSelectedIndex] = JSON.stringify(event)
  } else {
    settledHeader.agentPreset = toPreset
    settledLines[0] = JSON.stringify(settledHeader)
  }

  const location = persistence.locate(settledRaw.meta)
  if (location === undefined) throw new Error('locate returned undefined')
  const replacementContent = settledLines.join(NL)
  const firstNewline = replacementContent.indexOf(NL)
  const headerLine = replacementContent.slice(0, firstNewline)
  const rest = replacementContent.slice(firstNewline + 1)
  const bytes = await encodeArtifact(headerLine, rest, location.path.endsWith('.zstd'))
  await mkdir(dirname(location.path), { recursive: true })
  const tempPath = await writeTempFile(location.path, bytes)
  try {
    await rename(tempPath, location.path)
  } catch (error) {
    try { await rm(tempPath, { force: true }) } catch { /* ignore */ }
    throw new Error('preset migration rename failed: ' + String(error))
  }

  // Same public notification as the built-in blank-session preset switch (see
  // original): updates the displayed preset without fabricating a live Session.
  try { (ctx as any).emit('agent-preset/selected', sessionId, toPreset) } catch { /* best-effort */ }
  logger.info(`session-manager: migrated preset for "${sessionId}" from "${String(oldPreset)}" to "${toPreset}"`)
  return { sessionId, migrated: true, oldPreset, newPreset: toPreset }
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
