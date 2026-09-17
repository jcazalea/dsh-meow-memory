/**
 * meow-memory 记忆查看器 — 客户端 API 封装。
 *
 * 只跟 /meow-memory/api/* 打交道（同源 fetch，loopback）。所有错误都收敛成
 * ViewerApiError，由视图层渲染成错误态——绝不把异常抛进宿主 UI。
 */

import type {
  ApiResponse,
  DreamsDto,
  GraphDto,
  MemoriesDto,
  MemoryDto,
  OverviewDto,
  ProjectsDto,
  SessionsDto,
  WorkspaceSummary,
} from '../viewer/types.js'

const BASE = '/meow-memory/api'

export class ViewerApiError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ViewerApiError'
    this.code = code
  }
}

type Params = Record<string, string | number | boolean | undefined | null>

function url(path: string, params?: Params): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null || v === '') continue
    qs.set(k, String(v))
  }
  const suffix = qs.toString()
  return `${BASE}${path}${suffix.length > 0 ? `?${suffix}` : ''}`
}

async function get<T>(path: string, params?: Params, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(url(path, params), { signal, headers: { accept: 'application/json' } })
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') throw e
    throw new ViewerApiError('network', '无法连接宿主（记忆查看器数据面未就绪？）')
  }
  let body: ApiResponse<T>
  try {
    body = (await res.json()) as ApiResponse<T>
  } catch {
    throw new ViewerApiError('bad-response', `宿主返回了非 JSON 响应（HTTP ${res.status}）`)
  }
  if (body.ok !== true) throw new ViewerApiError(body.error.code, body.error.message)
  return body.data
}

async function post<T>(path: string, payload: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(url(path), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    throw new ViewerApiError('network', '无法连接宿主（记忆查看器数据面未就绪？）')
  }
  let body: ApiResponse<T>
  try {
    body = (await res.json()) as ApiResponse<T>
  } catch {
    throw new ViewerApiError('bad-response', `宿主返回了非 JSON 响应（HTTP ${res.status}）`)
  }
  if (body.ok !== true) throw new ViewerApiError(body.error.code, body.error.message)
  return body.data
}

/** POST /migrate-old 的返回体（面板「迁移旧库」）。 */
export interface LegacyMigrateDto {
  migrated: number
  sessionsMoved: number
  dbPath: string | null
  backup: string | null
  status: 'success' | 'no-old-db' | 'read-error'
  error?: string
}

export interface ContextDto {
  sessionId: string
  workspace: string
  workspaceTitle: string
  allowed: boolean
  footprint: SessionsDto['sessions'][number] | null
}

export const viewerApi = {
  context: (sessionId: string, signal?: AbortSignal) => get<ContextDto>('/context', { sessionId }, signal),
  workspaces: (signal?: AbortSignal) => get<{ workspaces: WorkspaceSummary[] }>('/workspaces', undefined, signal),
  overview: (opts: { recent?: number; dreamLog?: number } = {}, signal?: AbortSignal) =>
    get<OverviewDto>('/overview', { recent: opts.recent ?? 20, dreamLog: opts.dreamLog ?? 20 }, signal),
  memories: (
    params: {
      workspace: string
      level?: string
      status?: string
      project?: string
      q?: string
      days?: number
      importance?: number
      sort?: string
      limit?: number
      offset?: number
    },
    signal?: AbortSignal,
  ) => get<MemoriesDto>('/memories', params, signal),
  memory: (workspace: string, id: string, signal?: AbortSignal) =>
    get<{ memory: MemoryDto }>('/memory', { workspace, id }, signal),
  similar: (workspace: string, id: string, k = 5, signal?: AbortSignal) =>
    get<{ id: string; similar: Array<{ similarity: number; memory?: MemoryDto }> }>('/similar', { workspace, id, k }, signal),
  projects: (workspace: string, signal?: AbortSignal) => get<ProjectsDto>('/projects', { workspace }, signal),
  timeline: (workspace: string, days?: number, signal?: AbortSignal) =>
    get<MemoriesDto>('/timeline', { workspace, days, limit: 300 }, signal),
  dreams: (workspace?: string, signal?: AbortSignal) => get<DreamsDto>('/dreams', { workspace, limit: 50 }, signal),
  sessions: (workspace: string, signal?: AbortSignal) => get<SessionsDto>('/sessions', { workspace }, signal),
  search: (q: string, limit = 30, signal?: AbortSignal) =>
    get<{ query: string; hits: Array<{ workspace: string; workspaceTitle: string; memory: MemoryDto }> }>('/search', { q, limit }, signal),
  graph: (
    params: { scope: 'all' | 'workspace' | 'project'; workspace?: string; project?: string; level?: string; edges?: string; threshold?: number; topK?: number; limit?: number },
    signal?: AbortSignal,
  ) => get<GraphDto>('/graph', params, signal),
  /** 面板「迁移旧库」：手动把任意旧库（memory.db/库目录/项目根）并入中央库。 */
  migrateLegacy: (path: string) => post<LegacyMigrateDto>('/migrate-old', { path }),
  /** 项目别名（v0.30.1）：改映射表 display_name，记忆条目不搬。 */
  renameProject: (workspace: string, id: string, display: string) => post<{ id: string; display: string }>('/projects/rename', { workspace, id, display }),
}
