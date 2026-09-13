/**
 * meow-memory 记忆查看器 — 聚合层：全局总览 / 记忆检索 / 项目分组 / 健康检查。
 *
 * 全部为纯函数（输入 = 只读 reader + 白名单，输出 = 传输 DTO），便于单测：
 * 造几个临时工作区库即可验证 KPI、过滤、检索排序与健康检查。
 */

import { isGlobalProject, projectCovers, projectList, type Level as DbLevel } from '../db.js'
import { search, tokenize } from '../bm25.js'
import type { AllowedWorkspace, ViewerReader, ViewerRepository } from './repository.js'
import type {
  GlobalEntry,
  HealthItem,
  MemoriesDto,
  MemoryDto,
  OverviewDto,
  ProjectSummary,
  ViewerLevel,
  ViewerStatus,
  ViewerSubcategory,
} from './types.js'
import { VIEWER_LEVELS } from './types.js'

const WEEK_MS = 7 * 86_400_000
/** rules 超过该天数未更新算「超期」（dream 的规则复看默认 2 天，这里放宽到 30 天）。 */
const STALE_RULES_MS = 30 * 86_400_000
/** 健康检查的时间预算（单工作区），超时停止继续算（保持 API 响应稳定）。 */
const HEALTH_BUDGET_MS = 25

// ── 通用 ────────────────────────────────────────────────────────────────────

/** 状态过滤：默认 active；`all` = 不过滤；project.todo 的 stale 视为已完成也参与。 */
function statusAllowed(m: MemoryDto, statuses: readonly string[]): boolean {
  if (statuses.length === 0) return true
  if (statuses.includes('all')) return true
  if (statuses.includes(m.status)) return true
  return m.status === 'stale' && m.level === 'project' && m.subcategory === 'todo'
}

/** project 过滤：多选 OR；全局/未标记条目天然命中任何项目过滤（与命中链路同口径）。 */
function projectAllowed(m: MemoryDto, projects: readonly string[]): boolean {
  if (projects.length === 0) return true
  return projects.some((p) => projectCovers(m.project, p))
}

export interface MemoryQuery {
  levels?: readonly ViewerLevel[]
  statuses?: readonly string[]
  projects?: readonly string[]
  days?: number | null
  minImportance?: number | null
  q?: string | null
  sort?: 'updated' | 'created' | 'importance' | 'level'
  limit?: number
  offset?: number
}

/** 过滤 + 排序 + 分页；带 q 时用 bm25 相关度排序（与 memory_search 同算法）。 */
export function queryMemories(reader: ViewerReader, rows: readonly MemoryDto[], query: MemoryQuery): MemoriesDto {
  const levels = query.levels && query.levels.length > 0 ? new Set(query.levels) : null
  const statuses = query.statuses ?? ['active']
  const projects = query.projects ?? []
  const now = Date.now()
  let filtered = rows.filter((m) => {
    if (levels !== null && !levels.has(m.level)) return false
    if (!statusAllowed(m, statuses)) return false
    if (!projectAllowed(m, projects)) return false
    if (query.days != null && now - m.createdAt > query.days * 86_400_000) return false
    if (query.minImportance != null && m.importance < query.minImportance) return false
    return true
  })
  const total = filtered.length
  const q = query.q?.trim()
  let scored = false
  if (q !== undefined && q.length > 0) {
    scored = true
    const docs = filtered.map((m) => ({
      id: m.id,
      level: m.level,
      title: m.title,
      content: m.content,
      keywords: m.keywords,
      importance: m.importance,
      created_at: m.createdAt,
      updated_at: m.updatedAt,
    }))
    const ranked = search(q, docs, { k: filtered.length })
    const byId = new Map(filtered.map((m) => [m.id, m]))
    filtered = ranked.map((h) => byId.get(h.id)).filter((m): m is MemoryDto => m !== undefined)
  } else {
    const sort = query.sort ?? 'updated'
    filtered = [...filtered].sort((a, b) => {
      if (sort === 'created') return b.createdAt - a.createdAt
      if (sort === 'importance') return b.importance - a.importance || b.updatedAt - a.updatedAt
      if (sort === 'level') return VIEWER_LEVELS.indexOf(a.level) - VIEWER_LEVELS.indexOf(b.level) || b.updatedAt - a.updatedAt
      return b.updatedAt - a.updatedAt
    })
  }
  const offset = Math.max(0, query.offset ?? 0)
  const limit = Math.max(1, Math.min(1000, query.limit ?? 200))
  return { workspace: reader.path, total, offset, limit, memories: filtered.slice(offset, offset + limit), scored }
}

/** 项目分组摘要（memory_project 的数据面）。 */
export function projectSummaries(reader: ViewerReader): ProjectSummary[] {
  const rows = reader.listAll()
  const byProject = new Map<string, MemoryDto[]>()
  for (const m of rows) {
    if (m.project === null || isGlobalProject(m.project)) continue
    for (const name of projectList(m.project)) {
      const list = byProject.get(name) ?? []
      list.push(m)
      byProject.set(name, list)
    }
  }
  const out: ProjectSummary[] = []
  for (const [name, list] of byProject) {
    const counts = { soul: 0, user: 0, project: 0, fact: 0, lesson: 0, topic: 0, rules: 0 } as Record<ViewerLevel, number>
    const bySubcategory = { overview: 0, structure: 0, decisions: 0, quotes: 0, ops: 0, todo: 0 } as Record<ViewerSubcategory, number>
    let active = 0
    let stale = 0
    let archived = 0
    let lastUpdatedAt: number | null = null
    for (const m of list) {
      counts[m.level]++
      if (m.level === 'project' && m.subcategory !== null) bySubcategory[m.subcategory]++
      if (m.status === 'active') active++
      else if (m.status === 'stale') stale++
      else archived++
      lastUpdatedAt = Math.max(lastUpdatedAt ?? 0, m.updatedAt)
    }
    out.push({ name, total: list.length, active, stale, archived, counts, lastUpdatedAt, bySubcategory })
  }
  return out.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
}

/** 未标记 + 全局桶（前端项目树的"全局 / 未标记"两项）。 */
export function unlabeledCounts(reader: ViewerReader): { global: number; unlabeled: number } {
  let global = 0
  let unlabeled = 0
  for (const m of reader.listAll()) {
    if (m.project === null || m.project === '') unlabeled++
    else if (isGlobalProject(m.project)) global++
  }
  return { global, unlabeled }
}

// ── 健康检查 ────────────────────────────────────────────────────────────────

/** bigram Jaccard（与 tools.ts 的 similarity 同口径，这里本地实现以免盘活工具层）。 */
function jaccard(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a)
  const sb = new Set(b)
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  return inter / (sa.size + sb.size - inter)
}

function healthOf(reader: ViewerReader, workspace: string): HealthItem[] {
  const started = Date.now()
  const rows = reader.listAll()
  const noKeywords: MemoryDto[] = []
  const staleRules: MemoryDto[] = []
  const openTodos: MemoryDto[] = []
  const now = Date.now()
  for (const m of rows) {
    if (m.status !== 'active') continue
    if (m.keywords.length === 0 && m.level !== 'soul' && m.level !== 'user') noKeywords.push(m)
    if (m.level === 'rules' && now - m.updatedAt > STALE_RULES_MS) staleRules.push(m)
    if (m.level === 'project' && m.subcategory === 'todo') openTodos.push(m)
  }
  // 疑似重复：关键词倒排索引（同关键词才比），跳过超大桶 + 时间预算。
  const dup: MemoryDto[] = []
  const seen = new Set<string>()
  const index = new Map<string, MemoryDto[]>()
  for (const m of rows) {
    if (m.status !== 'active' || m.keywords.length === 0) continue
    for (const k of m.keywords) {
      const list = index.get(k) ?? []
      list.push(m)
      index.set(k, list)
    }
  }
  outer: for (const [, list] of index) {
    if (list.length > 60) continue
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!
        const b = list[j]!
        if (a.id === b.id || a.level !== b.level) continue
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`
        if (seen.has(key)) continue
        if (jaccard(a.keywords, b.keywords) >= 0.8) {
          seen.add(key)
          dup.push(a)
        }
      }
      if (Date.now() - started > HEALTH_BUDGET_MS) break outer
    }
  }
  const toSample = (list: MemoryDto[]): HealthItem['sample'] =>
    list.slice(0, 8).map((m) => ({ workspace, id: m.id, content: m.content.slice(0, 120) }))
  return [
    { key: 'noKeywords', count: noKeywords.length, sample: toSample(noKeywords) },
    { key: 'staleRules', count: staleRules.length, sample: toSample(staleRules) },
    { key: 'possibleDuplicates', count: dup.length, sample: toSample(dup) },
    { key: 'openTodos', count: openTodos.length, sample: toSample(openTodos) },
  ]
}

// ── 全局总览 ────────────────────────────────────────────────────────────────

export interface OverviewOptions {
  recent: number
  dreamLog: number
  health: boolean
}

/** 跨工作区总览：KPI / 层级分布 / 工作区卡片 / 跨库最近更新 / 全局条目 / 健康检查。 */
export function buildOverview(repository: ViewerRepository, allowed: readonly AllowedWorkspace[], opts: OverviewOptions): OverviewDto {
  const workspaces = allowed.map((ws) => repository.summary(ws))
  const byLevel = { soul: 0, user: 0, project: 0, fact: 0, lesson: 0, topic: 0, rules: 0 } as Record<ViewerLevel, number>
  let total = 0
  let stale = 0
  let archived = 0
  let pendingDream = 0
  const projectNames = new Set<string>()
  for (const ws of workspaces) {
    for (const level of VIEWER_LEVELS) byLevel[level] += ws.counts[level] ?? 0
    total += ws.total
    for (const p of ws.projects) projectNames.add(p)
    if (ws.dream.lastEventAt !== null && (ws.dream.lastDreamAt ?? 0) < ws.dream.lastEventAt && Date.now() - ws.dream.lastEventAt < 86_400_000 && !ws.dream.skipped) {
      pendingDream++
    }
  }

  const recent: GlobalEntry[] = []
  const globalEntries: GlobalEntry[] = []
  const dreamLog: OverviewDto['dreamLog'] = []
  const health: HealthItem[] = []
  let newThisWeek = 0
  const weekAgo = Date.now() - WEEK_MS

  for (const ws of allowed) {
    const reader = repository.reader(ws)
    if (reader === undefined) continue
    for (const m of reader.listAll()) {
      if (m.status === 'stale') stale++
      else if (m.status === 'archived') archived++
      if (m.createdAt >= weekAgo) newThisWeek++
      if (m.project !== null && isGlobalProject(m.project)) globalEntries.push({ workspace: ws.path, workspaceTitle: ws.title, memory: m })
    }
    for (const m of reader.recent(opts.recent)) recent.push({ workspace: ws.path, workspaceTitle: ws.title, memory: m })
    for (const entry of reader.dreamLog(opts.dreamLog)) dreamLog.push({ workspace: ws.title, ...entry })
    if (opts.health) health.push(...healthOf(reader, ws.title))
  }

  recent.sort((a, b) => b.memory.updatedAt - a.memory.updatedAt)
  globalEntries.sort((a, b) => b.memory.updatedAt - a.memory.updatedAt)
  dreamLog.sort((a, b) => b.runAt - a.runAt)
  const healthMerged: HealthItem[] = (['noKeywords', 'staleRules', 'possibleDuplicates', 'openTodos'] as const).map((key) => {
    const items = health.filter((h) => h.key === key)
    return {
      key,
      count: items.reduce((a, b) => a + b.count, 0),
      sample: items.flatMap((h) => h.sample).slice(0, 8),
    }
  })

  return {
    kpi: {
      workspaces: workspaces.length,
      withDb: workspaces.filter((w) => w.hasDb).length,
      total,
      newThisWeek,
      projects: projectNames.size,
      stale,
      archived,
      pendingDream,
    },
    byLevel,
    workspaces,
    recent: recent.slice(0, opts.recent),
    globalEntries: globalEntries.slice(0, 30),
    health: healthMerged,
    dreamLog: dreamLog.slice(0, opts.dreamLog),
  }
}

/** 关键词命中词（供前端高亮，复用 bm25 分词，保证与检索口径一致）。 */
export function tokenizeForHighlight(text: string): string[] {
  return tokenize(text)
}

export type { DbLevel, ViewerStatus }
