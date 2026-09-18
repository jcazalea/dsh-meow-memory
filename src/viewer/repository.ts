/**
 * meow-memory 记忆查看器 — 只读跨工作区仓储。
 *
 * 为什么不能复用 db.ts 的 getDb()：那个入口会 mkdirSync + CREATE TABLE + 跑
 * upgrade()，全是写操作。查看器要读的是**别人的**工作区库，必须只读：
 * `new DatabaseSync(path, { readOnly: true })`（实测：拒绝写、且拒绝打开不存在的
 * 文件 → 天然不会给别的工作区误建记忆库）。
 *
 * 白名单：任何 workspace 参数都必须命中「workspaceRegistry.list() 的 path ∪ 会话
 * 窗口索引（windowIndex）里的 cwd」，绝不接受任意路径。
 *
 * 句柄缓存：readOnly 连接在 WAL 下每次查询都看到最新已提交快照，所以可以长期持有
 * （不需要按 mtime 重开）；容量上限 + dispose 全关。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  GLOBAL_PROJECT_CANON,
  getCentralDbPath,
  getCentralSessionsDir,
  isGlobalProject,
  LEVELS,
  projectList,
  type Level,
  type MemoryRow,
  type Status,
} from '../db.js'
import type {
  DreamsDto,
  MemoryDto,
  SessionsDto,
  ViewerLevel,
  ViewerLogEntry,
  ViewerStatus,
  ViewerSubcategory,
  WorkspaceSummary,
} from './types.js'

/** 一个被允许访问的工作区。 */
export interface AllowedWorkspace {
  path: string
  title: string
  id?: string
  fromRegistry: boolean
}

/** 平台无关的路径比较键（Windows 大小写/分隔符差异）。 */
export function normKey(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? p.toLowerCase() : p
}

function baseName(path: string): string {
  const p = path.replace(/[\\/]+$/, '')
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

function emptyCounts(): Record<ViewerLevel, number> {
  return { soul: 0, user: 0, project: 0, fact: 0, lesson: 0, topic: 0, rules: 0 }
}

/** sessions/<id>.json 的最小形状（inject.ts 写的已见记账）。 */
interface SessionSeenFile {
  injected?: unknown
  searched?: unknown
  accessed?: unknown
  written?: unknown
  projectsQueried?: unknown
  reinjectPending?: unknown
  currentProject?: unknown
}

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** 把一个表行映射成传输 DTO（列缺失时按缺省处理——旧库可能没有 subcategory/goal）。 */
function toDto(workspace: string, level: Level, r: Record<string, unknown>): MemoryDto {
  let keywords: string[] = []
  try {
    keywords = JSON.parse(String(r.keywords ?? '[]')) as string[]
    if (!Array.isArray(keywords)) keywords = []
  } catch {
    keywords = []
  }
  return {
    id: String(r.id),
    workspace,
    level: level as ViewerLevel,
    title: r.title == null ? null : String(r.title),
    content: String(r.content ?? ''),
    importance: Number(r.importance ?? 1),
    keywords,
    status: (String(r.status ?? 'active') as ViewerStatus),
    project: r.project == null ? null : String(r.project),
    subcategory: (r.subcategory == null ? null : String(r.subcategory)) as ViewerSubcategory | null,
    goal: r.goal == null ? null : String(r.goal),
    corrected: Number(r.corrected ?? 0) === 1,
    sourceSession: r.source_session == null ? null : String(r.source_session),
    hitCount: Number(r.hit_count ?? 0),
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
    lastAccessedAt: r.last_accessed_at == null ? null : Number(r.last_accessed_at),
  }
}

/**
 * 一个工作区的只读句柄。所有查询都在 try/catch 内降级：旧库缺表/缺列、库文件损坏
 * 都只让对应查询返回空，不让整条 API 挂掉（fail-open，与插件其余路径同风格）。
 */
export class ViewerReader {
  readonly path: string
  readonly title: string
  private readonly db: DatabaseSync
  /** 打开时探测到的可用表层集合（缺表的工作区只影响对应层）。 */
  private readonly tables: Set<string>
  /** 最近一次 revision 计算值（同一请求内多次读取复用）。 */
  private revisionCache: { at: number; value: string } | null = null

  constructor(path: string, title: string, dir: string) {
    this.path = path
    this.title = title
    // v3 中央存储：所有工作区共用 ~/.dsh-meow/memory.db，只读打开（拒绝写、拒绝误建）。
    this.db = new DatabaseSync(getCentralDbPath(dir), { readOnly: true })
    try {
      this.db.exec('PRAGMA busy_timeout = 2000')
    } catch {
      /* 只读连接上的 pragma 失败不影响读取 */
    }
    this.tables = new Set(
      (this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((r) => r.name),
    )
  }

  private has(table: string): boolean {
    return this.tables.has(table)
  }

  private all<T = Record<string, unknown>>(sql: string, ...args: unknown[]): T[] {
    try {
      return this.db.prepare(sql).all(...(args as never[])) as T[]
    } catch {
      return []
    }
  }

  private get<T = Record<string, unknown>>(sql: string, ...args: unknown[]): T | undefined {
    try {
      return this.db.prepare(sql).get(...(args as never[])) as T | undefined
    } catch {
      return undefined
    }
  }

  /** 各层条目数（含非 active）。 */
  counts(): Record<ViewerLevel, number> {
    const out = emptyCounts()
    for (const level of LEVELS) {
      if (!this.has(level)) continue
      const row = this.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${level}`)
      out[level as ViewerLevel] = Number(row?.n ?? 0)
    }
    return out
  }

  /** 各层 active 数（KPI 用）。 */
  activeCounts(): Record<ViewerLevel, number> {
    const out = emptyCounts()
    for (const level of LEVELS) {
      if (!this.has(level)) continue
      const row = this.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${level} WHERE status = 'active'`)
      out[level as ViewerLevel] = Number(row?.n ?? 0)
    }
    return out
  }

  statusCount(status: Status): number {
    let n = 0
    for (const level of LEVELS) {
      if (!this.has(level)) continue
      const row = this.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${level} WHERE status = ?`, status)
      n += Number(row?.n ?? 0)
    }
    return n
  }

  /** 全部条目（跨七层，含非 active）。查看器一次取全量再在内存里切分：单库规模可控。 */
  listAll(): MemoryDto[] {
    const out: MemoryDto[] = []
    for (const level of LEVELS) {
      if (!this.has(level)) continue
      for (const r of this.all(`SELECT * FROM ${level}`)) out.push(toDto(this.path, level, r))
    }
    return out
  }

  /**
   * 按 id 取单条。
   * 先全表精确匹配，再做前缀匹配：id 是「base36 毫秒 + 随机」，同一毫秒内创建的
   * 多条共享前 8~9 位 —— 只按前缀扫表会命中"时间戳相同但另一层"的邻居条目
   * （查看器从检索结果拿到的可能是截断 id，必须稳）。
   */
  findById(id: string): MemoryDto | undefined {
    for (const level of LEVELS) {
      if (!this.has(level)) continue
      const row = this.get(`SELECT * FROM ${level} WHERE id = ?`, id)
      if (row) return toDto(this.path, level, row)
    }
    if (id.length >= 36) return undefined
    for (const level of LEVELS) {
      if (!this.has(level)) continue
      const row = this.get(`SELECT * FROM ${level} WHERE id LIKE ?`, `${id}%`)
      if (row) return toDto(this.path, level, row)
    }
    return undefined
  }

  /** 最近更新的 n 条（跨层，按 updated_at 降序）。 */
  recent(n: number): MemoryDto[] {
    const rows: MemoryDto[] = []
    for (const level of LEVELS) {
      if (!this.has(level)) continue
      for (const r of this.all(`SELECT * FROM ${level} ORDER BY updated_at DESC LIMIT ?`, n)) {
        rows.push(toDto(this.path, level, r))
      }
    }
    return rows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, n)
  }

  /** 项目清单（{name,count}；全局标记与未标记不进清单）。 */
  projects(): Array<{ name: string; count: number }> {
    const counts = new Map<string, number>()
    for (const m of this.listAll()) {
      if (m.project === null || isGlobalProject(m.project)) continue
      for (const name of projectList(m.project)) counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }

  /** 项目映射表（v0.30.1）：id → display_name；老库无 projects 表时返回空映射（展示回退原值）。 */
  projectDisplays(): Map<string, string> {
    const out = new Map<string, string>()
    if (!this.has('projects')) return out
    for (const r of this.all<{ id: string; display_name: string }>('SELECT id, display_name FROM projects')) out.set(r.id, r.display_name)
    return out
  }

  /** 该工作区是否含「全局」标记条目（全局视图的"全局条目"区）。 */
  globalEntries(): MemoryDto[] {
    return this.listAll().filter((m) => m.project !== null && isGlobalProject(m.project))
  }

  /** 整理留痕（dream_log）。 */
  dreamLog(limit: number): Array<{ runAt: number; summary: string; note: string }> {
    if (!this.has('dream_log')) return []
    return this.all<{ run_at: number; summary: string | null; note: string | null }>(
      `SELECT run_at, summary, note FROM dream_log ORDER BY run_at DESC LIMIT ?`,
      limit,
    ).map((r) => ({ runAt: Number(r.run_at ?? 0), summary: String(r.summary ?? ''), note: String(r.note ?? '') }))
  }

  /** 窗口表（dream 判定状态）。 */
  windows(limit = 200): DreamsDto['windows'] {
    if (!this.has('windows')) return []
    return this.all<{ session_id: string; workspace: string | null; last_event_time: number | null; last_dream_time: number | null; dream_owner: string | null; dream_progress_at: number | null; dream_group_idx: number | null }>(
      `SELECT session_id, workspace, last_event_time, last_dream_time, dream_owner, dream_progress_at, dream_group_idx
         FROM windows ORDER BY COALESCE(last_event_time, 0) DESC LIMIT ?`,
      limit,
    ).map((r) => ({
      sessionId: String(r.session_id),
      workspace: r.workspace == null ? this.path : String(r.workspace),
      lastEventTime: r.last_event_time == null ? null : Number(r.last_event_time),
      lastDreamTime: r.last_dream_time == null ? null : Number(r.last_dream_time),
      lease:
        r.dream_owner == null
          ? null
          : { owner: String(r.dream_owner), groupIdx: Number(r.dream_group_idx ?? 0), progressAt: Number(r.dream_progress_at ?? 0) },
    }))
  }

  /** 被用户跳过自动 dream 的会话 id。 */
  dreamSkips(): string[] {
    if (!this.has('dream_skip')) return []
    return this.all<{ session_id: string }>(`SELECT session_id FROM dream_skip`).map((r) => String(r.session_id))
  }

  /** 会话足迹（中央 sessions 目录 <central>/sessions/<id>.json：注入/检索/查阅/写过；v3 中央存储）。 */
  sessionsFootprint(dir: string): SessionsDto['sessions'] {
    const out: SessionsDto['sessions'] = []
    const dirPath = getCentralSessionsDir(dir)
    if (!existsSync(dirPath)) return out
    let files: string[] = []
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith('.json'))
    } catch {
      return out
    }
    for (const file of files) {
      const full = join(dirPath, file)
      let parsed: SessionSeenFile
      let mtime: number | null = null
      try {
        parsed = JSON.parse(readFileSync(full, 'utf8')) as SessionSeenFile
        mtime = statSync(full).mtimeMs
      } catch {
        continue
      }
      const id = file.slice(0, -5)
      out.push({
        sessionId: id,
        shortId: (id.startsWith('session-') ? id.slice(8) : id).slice(0, 8),
        injected: strArr(parsed.injected).length,
        searched: strArr(parsed.searched).length,
        accessed: strArr(parsed.accessed).length,
        written: strArr(parsed.written).length,
        projectsQueried: strArr(parsed.projectsQueried),
        currentProject: typeof parsed.currentProject === 'string' ? parsed.currentProject : null,
        reinjectPending: parsed.reinjectPending === true,
        updatedAt: mtime,
      })
      // 痕迹文件里的记忆 id（星图会话边用）。
      ;(out[out.length - 1] as unknown as { ids: { read: string[]; write: string[] } }).ids = {
        read: [...new Set([...strArr(parsed.injected), ...strArr(parsed.searched), ...strArr(parsed.accessed)])],
        write: [...new Set(strArr(parsed.written))],
      }
    }
    return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

  /** 面板写操作留痕（viewer_log；v0.31.0 起面板可编辑/删除记忆）。
   *  注意：不能靠 this.tables 快照守卫——viewer_log 是面板首次写时才惰性建表，
   *  打开时快照里没有它；直接查询 + 私有 all() 的 try/catch fail-open（老库无表返回空）。 */
  auditLog(limit: number): ViewerLogEntry[] {
    return this.all<{ at: number; workspace: string; action: string; memory_id: string; level: string; summary: string | null }>(
      `SELECT at, workspace, action, memory_id, level, summary FROM viewer_log ORDER BY at DESC LIMIT ?`,
      Math.max(1, Math.min(500, limit)),
    ).map((r) => ({
      at: Number(r.at ?? 0),
      workspace: String(r.workspace ?? ''),
      action: r.action as ViewerLogEntry['action'],
      id: String(r.memory_id ?? ''),
      level: r.level as ViewerLogEntry['level'],
      summary: String(r.summary ?? ''),
    }))
  }

  /** 数据版本（跨库 ETag 的组成部分）：data_version + 各层计数 + 最大 updated_at。 */
  revision(): string {
    const now = Date.now()
    if (this.revisionCache !== null && now - this.revisionCache.at < 1000) return this.revisionCache.value
    const dv = Number(this.get<{ data_version: number }>('PRAGMA data_version')?.data_version ?? 0)
    let count = 0
    let maxUpdated = 0
    for (const level of LEVELS) {
      if (!this.has(level)) continue
      const row = this.get<{ n: number; m: number | null }>(`SELECT COUNT(*) AS n, MAX(updated_at) AS m FROM ${level}`)
      count += Number(row?.n ?? 0)
      maxUpdated = Math.max(maxUpdated, Number(row?.m ?? 0))
    }
    const value = `${dv}:${count}:${maxUpdated}`
    this.revisionCache = { at: now, value }
    return value
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }
}

/**
 * 跨工作区只读仓储（v3 中央存储：底层只有一个中央库，白名单仍按工作区校验——
 * workspace 参数不再指向库路径，但保留"该会话属于允许的工作区"语义）。
 */
export class ViewerRepository {
  private readonly readers = new Map<string, ViewerReader>()
  private readonly failures = new Map<string, string>()

  constructor(
    private readonly dir: string,
    /** 容量上限：超出按插入序淘汰最旧的句柄。 */
    private readonly maxReaders = 16,
  ) {}

  /** 允许的工作区（registry 优先，windowIndex 兜底补全；v3 后仅作白名单校验）。 */
  allowed(ctx: unknown, extraWorkspaces: Iterable<string> = []): AllowedWorkspace[] {
    const out = new Map<string, AllowedWorkspace>()
    const reg = (ctx as { get?: (name: string) => unknown } | undefined)?.get?.('workspaceRegistry') as
      | { list?: () => ReadonlyArray<{ id?: unknown; path?: unknown; title?: unknown }> }
      | undefined
    try {
      for (const w of reg?.list?.() ?? []) {
        if (typeof w?.path !== 'string' || w.path.length === 0) continue
        out.set(normKey(w.path), {
          path: w.path,
          title: typeof w.title === 'string' && w.title.length > 0 ? w.title : baseName(w.path),
          id: typeof w.id === 'string' ? w.id : undefined,
          fromRegistry: true,
        })
      }
    } catch {
      /* registry 不可用：只用 windowIndex 兜底 */
    }
    for (const p of extraWorkspaces) {
      if (typeof p !== 'string' || p.length === 0) continue
      const key = normKey(p)
      if (out.has(key)) continue
      out.set(key, { path: p, title: baseName(p), fromRegistry: false })
    }
    return [...out.values()].sort((a, b) => a.title.localeCompare(b.title))
  }

  /** 把请求参数里的 workspace 解析成白名单条目；不合法返回 undefined。 */
  resolve(allowed: readonly AllowedWorkspace[], requested: string): AllowedWorkspace | undefined {
    const key = normKey(requested)
    return allowed.find((w) => normKey(w.path) === key)
  }

  /** 打开（或复用）中央库只读句柄（v3：所有工作区共享一个库）；无库文件返回 undefined。 */
  reader(_ws: AllowedWorkspace): ViewerReader | undefined {
    const key = 'central\u0000' + this.dir
    const cached = this.readers.get(key)
    if (cached !== undefined) return cached
    if (!existsSync(getCentralDbPath(this.dir))) return undefined
    try {
      const central = getCentralDbPath(this.dir)
      const reader = new ViewerReader(central, '记忆库', this.dir)
      this.readers.set(key, reader)
      this.failures.delete(key)
      if (this.readers.size > this.maxReaders) {
        const oldest = this.readers.keys().next().value
        if (oldest !== undefined && oldest !== key) {
          this.readers.get(oldest)?.close()
          this.readers.delete(oldest)
        }
      }
      return reader
    } catch (e) {
      this.failures.set(key, e instanceof Error ? e.message : String(e))
      return undefined
    }
  }

  /** 上次打开失败的原因（诊断用）。 */
  failureOf(ws: AllowedWorkspace): string | undefined {
    return this.failures.get(normKey(ws.path) + '\u0000' + this.dir)
  }

  /** 单工作区摘要（全局视图的工作区卡片 / KPI）。 */
  summary(ws: AllowedWorkspace): WorkspaceSummary {
    const summary: WorkspaceSummary = {
      path: ws.path,
      title: ws.title,
      ...(ws.id === undefined ? {} : { id: ws.id }),
      hasDb: false,
      total: 0,
      counts: emptyCounts(),
      projects: [],
      lastUpdatedAt: null,
      dream: { lastDreamAt: null, lastEventAt: null, skipped: false, hasLease: false },
    }
    const reader = this.reader(ws)
    if (reader === undefined) {
      const err = this.failureOf(ws)
      if (err !== undefined) summary.error = err
      return summary
    }
    summary.hasDb = true
    try {
      summary.counts = reader.counts()
      summary.total = Object.values(summary.counts).reduce((a, b) => a + b, 0)
      summary.projects = reader.projects().map((p) => p.name)
      const windows = reader.windows(500)
      let lastEvent: number | null = null
      let lastDream: number | null = null
      let hasLease = false
      for (const w of windows) {
        if (w.lastEventTime !== null) lastEvent = Math.max(lastEvent ?? 0, w.lastEventTime)
        if (w.lastDreamTime !== null) lastDream = Math.max(lastDream ?? 0, w.lastDreamTime)
        if (w.lease !== null) hasLease = true
      }
      summary.dream = { lastDreamAt: lastDream, lastEventAt: lastEvent, skipped: reader.dreamSkips().length > 0, hasLease }
      summary.lastUpdatedAt = reader.recent(1)[0]?.updatedAt ?? null
    } catch (e) {
      summary.error = e instanceof Error ? e.message : String(e)
    }
    return summary
  }

  closeAll(): void {
    for (const r of this.readers.values()) r.close()
    this.readers.clear()
  }
}

export { GLOBAL_PROJECT_CANON }
export type { Level, MemoryRow }
