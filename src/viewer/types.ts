/**
 * meow-memory 记忆查看器 — 传输契约（host / client 共用，纯类型）。
 *
 * 这一层只描述 /meow-memory/api 的线格式：host 侧 routes/aggregate/graph 按它
 * 产出，client 侧 api.ts 按它消费。因为要被打进 client bundle，本文件不得 import
 * 任何 node / DB / prompt 依赖（只允许 type import）。
 */

/** 七层 + 状态（与 db.ts 同口径，这里重新声明以免 client 侧拖入 host 依赖）。 */
export type ViewerLevel = 'soul' | 'user' | 'project' | 'fact' | 'lesson' | 'topic' | 'rules'
export type ViewerStatus = 'active' | 'archived' | 'stale'
export type ViewerSubcategory = 'overview' | 'structure' | 'decisions' | 'quotes' | 'ops' | 'todo'

export const VIEWER_LEVELS: readonly ViewerLevel[] = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']

/** 统一响应外壳：partial 列出读取失败的工作区（单库坏了不拖垮全局视图）。 */
export interface ApiMeta {
  generatedAt: number
  etag: string
  /** 本次聚合中跳过/失败的工作区路径。 */
  partial: string[]
}

export interface ApiOk<T> {
  ok: true
  data: T
  meta: ApiMeta
}

export interface ApiErr {
  ok: false
  error: { code: ApiErrorCode; message: string }
  meta: ApiMeta
}

export type ApiErrorCode =
  | 'bad-request'
  | 'not-allowlisted'
  | 'no-db'
  | 'not-found'
  | 'method-not-allowed'
  | 'internal'

export type ApiResponse<T> = ApiOk<T> | ApiErr

/** 单条记忆（原文视图 + 全量元数据）。 */
export interface MemoryDto {
  id: string
  workspace: string
  level: ViewerLevel
  title: string | null
  content: string
  importance: number
  keywords: string[]
  status: ViewerStatus
  project: string | null
  subcategory: ViewerSubcategory | null
  goal: string | null
  corrected: boolean
  sourceSession: string | null
  hitCount: number
  createdAt: number
  updatedAt: number
  lastAccessedAt: number | null
}

/** 一个工作区的摘要（全局视图的工作区卡片）。 */
export interface WorkspaceSummary {
  path: string
  title: string
  /** workspaceRegistry 的稳定 id（无则缺席）。 */
  id?: string
  hasDb: boolean
  total: number
  counts: Record<ViewerLevel, number>
  projects: string[]
  lastUpdatedAt: number | null
  dream: {
    lastDreamAt: number | null
    lastEventAt: number | null
    skipped: boolean
    hasLease: boolean
  }
  /** 读取失败原因（有值 = 本次 partial）。 */
  error?: string
}

export interface OverviewKpi {
  workspaces: number
  withDb: number
  total: number
  newThisWeek: number
  projects: number
  stale: number
  archived: number
  pendingDream: number
}

export interface GlobalEntry {
  workspace: string
  workspaceTitle: string
  memory: MemoryDto
}

export interface HealthItem {
  key: 'noKeywords' | 'staleRules' | 'possibleDuplicates' | 'openTodos'
  count: number
  /** 该检查项的样本（前端点开即可看到）。 */
  sample: Array<{ workspace: string; id: string; content: string }>
}

export interface OverviewDto {
  kpi: OverviewKpi
  byLevel: Record<ViewerLevel, number>
  workspaces: WorkspaceSummary[]
  recent: GlobalEntry[]
  globalEntries: GlobalEntry[]
  health: HealthItem[]
  dreamLog: Array<{ workspace: string; runAt: number; summary: string; note: string }>
}

export interface MemoriesDto {
  workspace: string
  total: number
  offset: number
  limit: number
  memories: MemoryDto[]
  /** 有关键词检索（q）时：命中按相关度排序，并给出分数。 */
  scored: boolean
}

export interface ProjectSummary {
  name: string
  total: number
  active: number
  stale: number
  archived: number
  counts: Record<ViewerLevel, number>
  lastUpdatedAt: number | null
  bySubcategory: Record<ViewerSubcategory, number>
}

/** 项目清单响应（含"全局 / 未标记"两个桶）。 */
export interface ProjectsDto {
  workspace: string
  projects: ProjectSummary[]
  buckets: { global: number; unlabeled: number }
}

export interface SessionsDto {
  /** 会话 → 记忆痕迹（sessions/<id>.json）。 */
  sessions: Array<{
    sessionId: string
    shortId: string
    injected: number
    searched: number
    accessed: number
    written: number
    projectsQueried: string[]
    currentProject: string | null
    reinjectPending: boolean
    updatedAt: number | null
  }>
}

export interface DreamsDto {
  log: Array<{ runAt: number; summary: string; note: string }>
  windows: Array<{ sessionId: string; workspace: string; lastEventTime: number | null; lastDreamTime: number | null; lease: { owner: string; groupIdx: number; progressAt: number } | null }>
  skipped: string[]
}

// ── 星图 ────────────────────────────────────────────────────────────────────

export type GraphNodeType = 'memory' | 'project' | 'session'
export type GraphEdgeType = 'project' | 'similar' | 'read' | 'write' | 'supersede'

export interface GraphNode {
  id: string
  type: GraphNodeType
  level: ViewerLevel | 'session'
  /** memory 节点承载的最小信息（原文另取 /api/memory）。 */
  label: string
  content?: string
  keywords?: string[]
  importance?: number
  status?: ViewerStatus
  workspace?: string
  project?: string | null
  updatedAt?: number
  /** 邻接度（渲染半径用）。 */
  degree: number
  cluster: string | null
}

export interface GraphEdge {
  source: string
  target: string
  type: GraphEdgeType
  weight: number
}

export interface GraphDto {
  scope: { kind: 'all' | 'workspace' | 'project'; workspace?: string; project?: string }
  nodes: GraphNode[]
  edges: GraphEdge[]
  stats: {
    nodes: number
    edges: number
    byType: Record<GraphEdgeType, number>
    /** 超上限被丢掉的节点数（前端据此提示"已降采样"）。 */
    dropped: number
    truncated: boolean
    revision: string
  }
}
