/**
 * meow-memory 记忆查看器 — /meow-memory/api 路由分发（host 侧）。
 *
 * 一条 `kind: 'prefix'` 路由接住所有查看器请求（避免为每个端点各注册一条，
 * 也避开与既有精确路由的注册冲突），内部按 method + pathname 分发。
 *
 * 安全：workspace 参数一律过白名单（registry.path ∪ 会话窗口索引），只读打开，
 * 绝不接受任意路径；记忆正文不进日志。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildGraph, GRAPH_DEFAULT_THRESHOLD, GRAPH_DEFAULT_TOPK } from './graph.js'
import { findSimilar } from '../bm25.js'
import { buildOverview, projectSummaries, queryMemories, unlabeledCounts } from './aggregate.js'
import { etagOf, metaOf, readJsonBody, writeError, writeOk } from './http.js'
import { ViewerRepository, type AllowedWorkspace } from './repository.js'
import { migrateLegacyPath } from '../migrate-central.js'
import { getCentralDbPath, getCentralSessionsDir } from '../db.js'
import { archiveMemory, openCentralWritable, purgeMemory, restoreMemory, updateMemory, type WriteOutcome } from './write.js'
import type {
  DreamsDto,
  GraphEdgeType,
  MemoriesDto,
  MemoryDto,
  MemoryPatchDto,
  OverviewDto,
  ProjectsDto,
  SessionsDto,
  ViewerLevel,
  ViewerLogDto,
} from './types.js'
import { VIEWER_LEVELS } from './types.js'

export interface ViewerApiDeps {
  /** cordis 上下文（取 workspaceRegistry）。 */
  ctx: unknown
  /** 记忆目录名（projectDir）。 */
  dir: string
  /** 会话窗口索引（sessionId → workspace）：白名单兜底来源。 */
  windowWorkspaces: () => Iterable<string>
  /** 会话 → 工作区（index.ts 的 resolveWorkspaceForSession；可选）。 */
  resolveSessionWorkspace?: (sessionId: string) => Promise<string | null>
}

const LEVEL_SET = new Set<string>(VIEWER_LEVELS)
const EDGE_SET = new Set<GraphEdgeType>(['project', 'similar', 'read', 'write', 'supersede'])

function csv(value: string | null): string[] {
  if (value === null) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function num(value: string | null, fallback: number): number {
  if (value === null || value.trim() === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 面板编辑补丁白名单：只允许已知字段，类型不符一律丢弃（绝不把 body 原样透传进 SQL）。 */
function sanitizePatch(raw: unknown): MemoryPatchDto {
  const patch: MemoryPatchDto = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return patch
  const o = raw as Record<string, unknown>
  if (typeof o.content === 'string' && o.content.trim().length > 0) patch.content = o.content.trim()
  if (typeof o.title === 'string') patch.title = o.title.trim()
  if (typeof o.importance === 'number' && Number.isFinite(o.importance)) patch.importance = Math.round(o.importance)
  if (Array.isArray(o.keywords)) {
    const kw = o.keywords.map((k) => (typeof k === 'string' ? k.trim() : '')).filter((k) => k.length > 0)
    patch.keywords = kw // 空数组 = 不更新（write.ts 内部按此语义处理）
  }
  if (typeof o.status === 'string' && ['active', 'archived', 'stale'].includes(o.status)) patch.status = o.status as MemoryPatchDto['status']
  if (o.project === null || typeof o.project === 'string') patch.project = typeof o.project === 'string' ? o.project.trim() : null
  if (typeof o.subcategory === 'string' && ['overview', 'structure', 'decisions', 'quotes', 'ops', 'todo'].includes(o.subcategory)) {
    patch.subcategory = o.subcategory as MemoryPatchDto['subcategory']
  }
  if (typeof o.goal === 'string') patch.goal = o.goal.trim()
  if (typeof o.corrected === 'boolean') patch.corrected = o.corrected
  return patch
}

/** 只读某会话的痕迹文件（/api/context 用；v3 中央存储：sessions 在中央目录）。 */
function readSessionFootprint(dir: string, workspace: string, sessionId: string): SessionsDto['sessions'][number] | null {
  try {
    const raw = JSON.parse(readFileSync(join(getCentralSessionsDir(dir), `${sessionId}.json`), 'utf8')) as Record<string, unknown>
    const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0)
    return {
      sessionId,
      shortId: (sessionId.startsWith('session-') ? sessionId.slice(8) : sessionId).slice(0, 8),
      injected: len(raw.injected),
      searched: len(raw.searched),
      accessed: len(raw.accessed),
      written: len(raw.written),
      projectsQueried: Array.isArray(raw.projectsQueried) ? (raw.projectsQueried as string[]).filter((x) => typeof x === 'string') : [],
      currentProject: typeof raw.currentProject === 'string' ? raw.currentProject : null,
      reinjectPending: raw.reinjectPending === true,
      updatedAt: null,
    }
  } catch {
    return null
  }
}

/** 去掉内部字段（graph 用的 ids）后的会话足迹。 */
function publicFootprints(list: SessionsDto['sessions']): SessionsDto['sessions'] {
  return list.map((s) => ({ ...s }))
}

export interface ViewerApi {
  handler: (req: IncomingMessage, res: ServerResponse) => void
  dispose: () => void
}

export function createViewerApi(deps: ViewerApiDeps): ViewerApi {
  const repo = new ViewerRepository(deps.dir)

  const allowedNow = (): AllowedWorkspace[] => repo.allowed(deps.ctx, deps.windowWorkspaces())

  const missingWorkspaceMeta = (partial: string[]): ReturnType<typeof metaOf> => metaOf(etagOf(['empty', Date.now()]), partial)

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase()
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.replace(/^\/meow-memory\/api/, '') || '/'
    const q = url.searchParams
    const allowed = allowedNow()

    // 白名单解析公共逻辑
    const pick = (): { ws: AllowedWorkspace } | { error: 'bad-request' | 'not-allowlisted' } => {
      const requested = q.get('workspace')
      if (requested === null || requested.trim() === '') return { error: 'bad-request' }
      const ws = repo.resolve(allowed, requested)
      if (ws === undefined) return { error: 'not-allowlisted' }
      return { ws }
    }
    const fail = (status: number, code: Parameters<typeof writeError>[2], message: string, partial: string[] = []): void =>
      writeError(res, status, code, message, missingWorkspaceMeta(partial))

    /** 写端点（POST-only）统一方法校验。 */
    const POST_ONLY = new Set(['/migrate-old', '/projects/rename', '/memory/update', '/memory/archive', '/memory/restore', '/memory/purge'])
    if (POST_ONLY.has(path) && method !== 'POST') {
      return fail(405, 'method-not-allowed', `该端点仅支持 POST：${path}`)
    }

    /** 白名单解析公共逻辑（POST body 版）。 */
    const pickWs = (wsPathRaw: unknown): AllowedWorkspace | { error: 'bad-request' | 'not-allowlisted' } => {
      const wsPath = typeof wsPathRaw === 'string' ? wsPathRaw.trim() : ''
      if (wsPath === '') return { error: 'bad-request' }
      const ws = repo.resolve(allowed, wsPath)
      if (ws === undefined) return { error: 'not-allowlisted' }
      return ws
    }
    const failWs = (p: ReturnType<typeof pickWs>): void => {
      if ('error' in p) {
        if (p.error === 'bad-request') fail(400, 'bad-request', 'workspace 必填')
        else fail(403, 'not-allowlisted', '该工作区不在白名单内')
      }
    }

    /** 面板记忆写操作（update/archive/restore/purge 共用流水线）。 */
    const postMemory = async (req: IncomingMessage, res: ServerResponse, kind: 'update' | 'archive' | 'restore' | 'purge'): Promise<void> => {
      let body: Record<string, unknown> = {}
      try {
        body = (await readJsonBody(req)) as Record<string, unknown>
      } catch {
        return fail(400, 'bad-request', '请求体必须是 JSON')
      }
      const wsP = pickWs(body.workspace)
      if ('error' in wsP) return failWs(wsP)
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (id === '') return fail(400, 'bad-request', 'id 必填')
      let db: ReturnType<typeof openCentralWritable>
      try {
        db = openCentralWritable(deps.dir)
      } catch (e) {
        return fail(500, 'internal-error', `无法打开中央库写入: ${e instanceof Error ? e.message : String(e)}`)
      }
      try {
        let outcome: WriteOutcome
        if (kind === 'update') {
          const patch = sanitizePatch(body.patch)
          const expect = typeof body.expectUpdatedAt === 'number' ? body.expectUpdatedAt : undefined
          outcome = updateMemory(db, wsP.path, id, patch, expect)
        } else if (kind === 'archive') {
          outcome = archiveMemory(db, wsP.path, id)
        } else if (kind === 'restore') {
          outcome = restoreMemory(db, wsP.path, id)
        } else {
          outcome = purgeMemory(db, wsP.path, id)
        }
        if (outcome.status === 'not-found') return fail(404, 'not-found', `未找到记忆 ${id}`)
        if (outcome.status === 'conflict') {
          return writeError(res, 409, 'conflict', `该记忆刚被其他会话/模型更新（updated_at=${outcome.currentUpdatedAt}），请刷新后重试`, missingWorkspaceMeta([]))
        }
        return writeOk(res, outcome.result, metaOf(`write-${kind}-${Date.now()}-${id.length}`), req)
      } finally {
        db.close()
      }
    }

    try {
      // 只读端点仅 GET/HEAD；唯一写端点 /migrate-old 仅 POST（面板「迁移旧库」手动触发）。
      if (path === '/migrate-old' && method !== 'POST') {
        return fail(405, 'method-not-allowed', '迁移端点仅支持 POST')
      }
      if (path === '/projects/rename' && method !== 'POST') {
        return fail(405, 'method-not-allowed', '改名端点仅支持 POST')
      }
      if (method !== 'GET' && method !== 'HEAD') {
        if (path === '/migrate-old') {
          let body: { path?: unknown } = {}
          try {
            body = (await readJsonBody(req)) as { path?: unknown }
          } catch {
            return fail(400, 'bad-request', '请求体必须是 JSON')
          }
          const p = typeof body?.path === 'string' ? body.path.trim() : ''
          if (p === '') return fail(400, 'bad-request', 'path 必填：旧库文件夹或 memory.db 文件路径')
          try {
            const result = migrateLegacyPath(deps.dir, p)
            return writeOk(res, result, metaOf(`migrate-${Date.now()}-${p.length}`), req)
          } catch (e) {
            return fail(500, 'internal-error', `迁移失败: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        if (path === '/projects/rename') {
          let body: { workspace?: unknown; id?: unknown; display?: unknown } = {}
          try {
            body = (await readJsonBody(req)) as { workspace?: unknown; id?: unknown; display?: unknown }
          } catch {
            return fail(400, 'bad-request', '请求体必须是 JSON')
          }
          const wsPath = typeof body.workspace === 'string' ? body.workspace.trim() : ''
          if (wsPath === '') return fail(400, 'bad-request', 'workspace 必填')
          const ws = repo.resolve(allowed, wsPath)
          if (ws === undefined) return fail(403, 'not-allowlisted', '该工作区不在白名单内')
          const id = typeof body.id === 'string' ? body.id.trim() : ''
          const display = typeof body.display === 'string' ? body.display.trim() : ''
          if (id === '' || display === '') return fail(400, 'bad-request', 'id 与 display 必填')
          // 写操作（v0.30.1 项目别名）：只改 projects 表的 display_name，不碰记忆表；
          // 不复用 getDb（防建表/迁移），直接可写打开中央库；老库无 projects 表 → 404。
          try {
            const w = new DatabaseSync(getCentralDbPath(ws.path), { readOnly: false })
            try {
              w.exec('PRAGMA busy_timeout = 5000')
              const has = (w.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'`).get() as { name: string } | undefined) !== undefined
              if (!has) return fail(404, 'not-found', '该库尚无项目映射表（旧库未升级）')
              const clash = w.prepare('SELECT id FROM projects WHERE display_name = ? AND id != ?').get(display, id) as { id: string } | undefined
              if (clash) return fail(409, 'conflict', `展示名「${display}」已被 ${clash.id} 占用`)
              const res = w.prepare('UPDATE projects SET display_name = ?, updated_at = ? WHERE id = ?').run(display, Date.now(), id)
              if (res.changes === 0) return fail(404, 'not-found', `项目不存在：${id}`)
              return writeOk(res, { id, display }, metaOf(`rename-${Date.now()}-${id.length}`), req)
            } finally {
              w.close()
            }
          } catch (e) {
            return fail(500, 'internal-error', `改名失败: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        if (path === '/memory/update' || path === '/memory/archive' || path === '/memory/restore' || path === '/memory/purge') {
          return postMemory(req, res, path.slice('/memory/'.length) as 'update' | 'archive' | 'restore' | 'purge')
        }
        return fail(405, 'method-not-allowed', `不支持的请求方法：${method}`)
      }

      // ── /context：会话 → 工作区 + 该会话足迹 ──────────────────────────────
      if (path === '/context') {
        const sessionId = q.get('sessionId') ?? ''
        if (sessionId === '') return fail(400, 'bad-request', 'sessionId 必填')
        const resolved = deps.resolveSessionWorkspace === undefined ? null : await deps.resolveSessionWorkspace(sessionId)
        if (resolved === null) return fail(404, 'not-found', `无法解析会话所属工作区：${sessionId}`)
        const ws = repo.resolve(allowed, resolved)
        const footprint = readSessionFootprint(deps.dir, resolved, sessionId)
        return writeOk(
          res,
          {
            sessionId,
            workspace: resolved,
            workspaceTitle: ws?.title ?? resolved,
            allowed: ws !== undefined,
            footprint,
          },
          metaOf(`ctx-${sessionId}-${footprint?.injected ?? 0}-${footprint?.written ?? 0}`),
          req,
        )
      }

      // ── /workspaces：工作区列表 + 摘要 ────────────────────────────────────
      if (path === '/workspaces') {
        const summaries = allowed.map((ws) => repo.summary(ws))
        const partial = summaries.filter((s) => s.error !== undefined).map((s) => s.path)
        return writeOk(res, { workspaces: summaries }, metaOf(etagOf(summaries.map((s) => `${s.path}:${s.total}:${s.lastUpdatedAt ?? 0}`)), partial), req)
      }

      // ── /overview：跨工作区总览 ───────────────────────────────────────────
      if (path === '/overview') {
        const recent = Math.max(1, Math.min(100, num(q.get('recent'), 20)))
        const dreamLog = Math.max(0, Math.min(100, num(q.get('dreamLog'), 20)))
        const wantHealth = q.get('health') !== '0'
        const data: OverviewDto = buildOverview(repo, allowed, { recent, dreamLog, health: wantHealth })
        const partial = data.workspaces.filter((w) => w.error !== undefined).map((w) => w.path)
        const etag = etagOf([
          ...allowed.map((ws) => {
            const r = repo.reader(ws)
            return r === undefined ? `nodb:${ws.path}` : `${ws.path}:${r.revision()}`
          }),
          wantHealth ? 'h1' : 'h0',
        ])
        return writeOk(res, data, metaOf(etag, partial), req)
      }

      // ── /memories：列表 / 关键词检索 ──────────────────────────────────────
      if (path === '/memories') {
        const p = pick()
        if ('error' in p) return p.error === 'bad-request' ? fail(400, 'bad-request', 'workspace 必填') : fail(403, 'not-allowlisted', '该工作区不在白名单内')
        const reader = repo.reader(p.ws)
        if (reader === undefined) return fail(404, 'no-db', `该工作区没有记忆库：${p.ws.path}`)
        const levels = csv(q.get('level')).filter((l) => LEVEL_SET.has(l)) as ViewerLevel[]
        const statuses = csv(q.get('status'))
        const projects = csv(q.get('project'))
        const data: MemoriesDto = queryMemories(reader, reader.listAll(), {
          levels,
          statuses: statuses.length > 0 ? statuses : ['active'],
          projects,
          days: q.get('days') === null ? null : num(q.get('days'), 0) || null,
          minImportance: q.get('importance') === null ? null : num(q.get('importance'), 0),
          q: q.get('q'),
          sort: (q.get('sort') as 'updated' | 'created' | 'importance' | 'level' | null) ?? 'updated',
          limit: num(q.get('limit'), 200),
          offset: num(q.get('offset'), 0),
        })
        return writeOk(res, data, metaOf(etagOf([p.ws.path, reader.revision(), JSON.stringify([levels, statuses, projects, q.get('q') ?? ''])])), req)
      }

      // ── /memory：单条 ────────────────────────────────────────────────────
      if (path === '/memory') {
        const id = q.get('id') ?? ''
        if (id === '') return fail(400, 'bad-request', 'id 必填')
        const p = pick()
        if ('error' in p) return p.error === 'bad-request' ? fail(400, 'bad-request', 'workspace 必填') : fail(403, 'not-allowlisted', '该工作区不在白名单内')
        const reader = repo.reader(p.ws)
        if (reader === undefined) return fail(404, 'no-db', `该工作区没有记忆库：${p.ws.path}`)
        const found: MemoryDto | undefined = reader.findById(id)
        if (found === undefined) return fail(404, 'not-found', `未找到记忆 ${id}`)
        return writeOk(res, { memory: found }, metaOf(etagOf([found.id, found.updatedAt])), req)
      }

      // ── /projects：项目清单 + 分组摘要 ───────────────────────────────────
      if (path === '/projects') {
        const p = pick()
        if ('error' in p) return p.error === 'bad-request' ? fail(400, 'bad-request', 'workspace 必填') : fail(403, 'not-allowlisted', '该工作区不在白名单内')
        const reader = repo.reader(p.ws)
        if (reader === undefined) return fail(404, 'no-db', `该工作区没有记忆库：${p.ws.path}`)
        const data: ProjectsDto = {
          workspace: p.ws.path,
          projects: projectSummaries(reader),
          buckets: unlabeledCounts(reader),
        }
        return writeOk(res, data, metaOf(etagOf([p.ws.path, reader.revision()])), req)
      }

      // ── /timeline：时间线（按 updated_at） ────────────────────────────────
      if (path === '/timeline') {
        const p = pick()
        if ('error' in p) return p.error === 'bad-request' ? fail(400, 'bad-request', 'workspace 必填') : fail(403, 'not-allowlisted', '该工作区不在白名单内')
        const reader = repo.reader(p.ws)
        if (reader === undefined) return fail(404, 'no-db', `该工作区没有记忆库：${p.ws.path}`)
        const days = q.get('days') === null ? null : num(q.get('days'), 0) || null
        const data = queryMemories(reader, reader.listAll(), {
          statuses: ['all'],
          days,
          sort: 'updated',
          limit: num(q.get('limit'), 300),
        })
        return writeOk(res, data, metaOf(etagOf([p.ws.path, reader.revision(), days ?? 0])), req)
      }

      // ── /dreams：整理留痕 + 窗口状态 + 跳过表 ────────────────────────────
      if (path === '/dreams') {
        const limit = Math.max(1, Math.min(200, num(q.get('limit'), 50)))
        const requested = q.get('workspace')
        const targets = requested === null || requested.trim() === '' ? allowed : (() => {
          const ws = repo.resolve(allowed, requested)
          return ws === undefined ? [] : [ws]
        })()
        if (requested !== null && requested.trim() !== '' && targets.length === 0) return fail(403, 'not-allowlisted', '该工作区不在白名单内')
        const log: DreamsDto['log'] = []
        const windows: DreamsDto['windows'] = []
        const skipped: string[] = []
        const partial: string[] = []
        for (const ws of targets) {
          const reader = repo.reader(ws)
          if (reader === undefined) continue
          for (const e of reader.dreamLog(limit)) log.push(e)
          for (const w of reader.windows(limit)) windows.push(w) // windows 表自带真实 workspace（v3 保留）
          skipped.push(...reader.dreamSkips())
        }
        log.sort((a, b) => b.runAt - a.runAt)
        return writeOk(res, { log: log.slice(0, limit), windows, skipped }, metaOf(etagOf([...targets.map((t) => t.path), log[0]?.runAt ?? 0])), req)
      }

      // ── /sessions：会话足迹（读/写痕迹） ─────────────────────────────────
      if (path === '/sessions') {
        const p = pick()
        if ('error' in p) return p.error === 'bad-request' ? fail(400, 'bad-request', 'workspace 必填') : fail(403, 'not-allowlisted', '该工作区不在白名单内')
        const reader = repo.reader(p.ws)
        if (reader === undefined) return fail(404, 'no-db', `该工作区没有记忆库：${p.ws.path}`)
        const data: SessionsDto = { sessions: publicFootprints(reader.sessionsFootprint(deps.dir)) }
        return writeOk(res, data, metaOf(etagOf([p.ws.path, data.sessions.length, data.sessions[0]?.updatedAt ?? 0])), req)
      }

      // ── /audit：面板写操作留痕（viewer_log；v0.31.0 面板可编辑/删除记忆） ──────
      if (path === '/audit') {
        const p = pick()
        if ('error' in p) return p.error === 'bad-request' ? fail(400, 'bad-request', 'workspace 必填') : fail(403, 'not-allowlisted', '该工作区不在白名单内')
        const reader = repo.reader(p.ws)
        if (reader === undefined) return fail(404, 'no-db', `该工作区没有记忆库：${p.ws.path}`)
        const limit = Math.max(1, Math.min(200, num(q.get('limit'), 50)))
        const data: ViewerLogDto = { log: reader.auditLog(limit) }
        return writeOk(res, data, metaOf(etagOf([p.ws.path, data.log.length, data.log[0]?.at ?? 0])), req)
      }

      // ── /similar：相关记忆（复用 bm25.findSimilar，与 memory_find_similar 同算法）
      if (path === '/similar') {
        const id = q.get('id') ?? ''
        if (id === '') return fail(400, 'bad-request', 'id 必填')
        const p = pick()
        if ('error' in p) return p.error === 'bad-request' ? fail(400, 'bad-request', 'workspace 必填') : fail(403, 'not-allowlisted', '该工作区不在白名单内')
        const reader = repo.reader(p.ws)
        if (reader === undefined) return fail(404, 'no-db', `该工作区没有记忆库：${p.ws.path}`)
        const target = reader.findById(id)
        if (target === undefined) return fail(404, 'not-found', `未找到记忆 ${id}`)
        const k = Math.max(1, Math.min(20, num(q.get('k'), 5)))
        const rows = reader
          .listAll()
          .filter((m) => m.id !== target.id)
          .map((m) => ({
            id: m.id,
            level: m.level,
            title: m.title,
            content: m.content,
            keywords: m.keywords,
            importance: m.importance,
            created_at: m.createdAt,
            updated_at: m.updatedAt,
          }))
        const hits = findSimilar(target.content + ' ' + target.keywords.join(' '), rows, k)
        const byId = new Map(reader.listAll().map((m) => [m.id, m]))
        return writeOk(
          res,
          {
            id: target.id,
            similar: hits.map((hit) => ({ similarity: hit.similarity, memory: byId.get(hit.id) })),
          },
          metaOf(etagOf([target.id, k])),
          req,
        )
      }

      // ── /search：跨工作区快速检索（全局视图搜索框） ──────────────────────
      if (path === '/search') {
        const query = (q.get('q') ?? '').trim()
        if (query === '') return fail(400, 'bad-request', 'q 必填')
        const limit = Math.max(1, Math.min(100, num(q.get('limit'), 30)))
        const hits: Array<{ workspace: string; workspaceTitle: string; memory: MemoryDto; score: number }> = []
        for (const ws of allowed) {
          const reader = repo.reader(ws)
          if (reader === undefined) continue
          const res1 = queryMemories(reader, reader.listAll(), { statuses: ['active'], q: query, limit })
          for (const m of res1.memories.slice(0, limit)) hits.push({ workspace: ws.path, workspaceTitle: ws.title, memory: m, score: 0 })
        }
        return writeOk(res, { query, hits: hits.slice(0, limit) }, metaOf(etagOf([query, hits.length])), req)
      }

      // ── /graph：星图拓扑 ────────────────────────────────────────────────
      if (path === '/graph') {
        const scopeParam = q.get('scope') ?? 'all'
        const scope: 'all' | 'workspace' | 'project' = scopeParam === 'workspace' ? 'workspace' : scopeParam === 'project' ? 'project' : 'all'
        const requested = q.get('workspace')
        let targets = allowed
        if (scope === 'workspace') {
          if (requested === null || requested.trim() === '') return fail(400, 'bad-request', 'scope=workspace 时 workspace 必填')
          const ws = repo.resolve(allowed, requested)
          if (ws === undefined) return fail(403, 'not-allowlisted', '该工作区不在白名单内')
          targets = [ws]
        }
        const levels = csv(q.get('level')).filter((l) => LEVEL_SET.has(l))
        const edgesParam = csv(q.get('edges')).filter((e) => EDGE_SET.has(e as GraphEdgeType)) as GraphEdgeType[]
        const inputs = []
        for (const ws of targets) {
          const reader = repo.reader(ws)
          if (reader === undefined) continue
          inputs.push({
            workspace: ws.path,
            title: ws.title,
            memories: reader.listAll().filter((m) => m.status !== 'archived' || m.importance >= 3),
            footprints: reader.sessionsFootprint(deps.dir),
            displays: reader.projectDisplays(),
          })
        }
        const data = buildGraph(inputs, {
          scope,
          project: q.get('project') ?? undefined,
          levels,
          edges: edgesParam.length > 0 ? edgesParam : undefined,
          threshold: Math.max(0, Math.min(1, num(q.get('threshold'), GRAPH_DEFAULT_THRESHOLD))),
          topK: Math.max(1, Math.min(10, num(q.get('topK'), GRAPH_DEFAULT_TOPK))),
          limit: Math.max(50, Math.min(3000, num(q.get('limit'), 2000))),
        })
        return writeOk(res, data, metaOf(etagOf([data.stats.revision, data.stats.nodes, data.stats.edges])), req)
      }

      // ── 未知端点 ─────────────────────────────────────────────────────────
      return fail(404, 'not-found', `未知端点：${path}`)
    } catch (e) {
      try {
        return writeError(res, 500, 'internal', e instanceof Error ? e.message : String(e), missingWorkspaceMeta([]))
      } catch {
        return undefined
      }
    }
  }

  return {
    handler: (req, res) => {
      void handle(req, res)
    },
    dispose: () => repo.closeAll(),
  }
}

export { readJsonBody }
