/**
 * meow-memory 记忆查看器 — 星图拓扑计算（host 侧）。
 *
 * 边分三类，UI 上必须可分辨（用户拍板：能画就画，但要说清哪些是"猜的"）：
 *  - 结构边 project / sourceSession：字段直出，确定；
 *  - 相似边 similar：关键词倒排取候选 + bigram Jaccard，需阈值 + 每节点 topK 剪枝（概率性）；
 *  - 会话边 read / write：sessions/<id>.json 的注入/检索/查阅/写过痕迹，确定（但只覆盖痕迹文件还在的窗口）；
 *  - 取代边 supersede：同 level + 高相似 + 一新一旧（旧条目已被新条目取代）。
 *
 * 上限与降采样：节点 ≤ limit、边 ≤ MAX_EDGES；超限先丢 archived / degree=1 / 低 importance
 * 的节点，并在 stats.truncated 标记（前端提示"已降采样"，不是静默丢数据）。
 */

import { isGlobalProject, projectList } from '../db.js'
import type { MemoryDto, SessionsDto } from './types.js'
import type { GraphDto, GraphEdge, GraphEdgeType, GraphNode } from './types.js'

/** 相似边默认阈值（bigram Jaccard）。 */
export const GRAPH_DEFAULT_THRESHOLD = 0.35
/** 每个节点的相似边上限。 */
export const GRAPH_DEFAULT_TOPK = 3
/** 取代边判定阈值（更高：只认几乎重复的旧版本）。 */
const SUPERSEDE_THRESHOLD = 0.8
const MAX_EDGES = 8000

export interface GraphInput {
  workspace: string
  title: string
  memories: MemoryDto[]
  footprints?: SessionsDto['sessions']
  /** 项目映射表 id→display_name（v0.30.1 星图项目枢纽显示短名）。 */
  displays?: ReadonlyMap<string, string>
}

export interface GraphOptions {
  scope: 'all' | 'workspace' | 'project'
  project?: string
  levels?: readonly string[]
  edges?: readonly GraphEdgeType[]
  threshold: number
  topK: number
  limit: number
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a)
  const sb = new Set(b)
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  return inter / (sa.size + sb.size - inter)
}

const shortSession = (id: string): string => (id.startsWith('session-') ? id.slice(8) : id).slice(0, 8)

/** 项目归属键：全局/未标记归到 '' 桶。 */
function projectKey(m: MemoryDto): string {
  if (m.project === null || m.project === '') return ''
  if (isGlobalProject(m.project)) return ''
  return projectList(m.project)[0] ?? ''
}

/**
 * 计算星图。
 * @param inputs 每个工作区一份（记忆 + 会话足迹）
 * @param opts 过滤与剪枝参数
 */
export function buildGraph(inputs: readonly GraphInput[], opts: GraphOptions): GraphDto {
  const edgeFilter = (t: GraphEdgeType): boolean => opts.edges === undefined || opts.edges.includes(t)
  const levelSet = opts.levels !== undefined && opts.levels.length > 0 ? new Set(opts.levels) : null
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const revisionParts: string[] = []
  const droppedSessions = new Set<string>()

  const memoryOf = new Map<string, MemoryDto>()
  const clusterOf = new Map<string, string>()

  // ── 节点：记忆 ────────────────────────────────────────────────────────────
  for (const input of inputs) {
    for (const m of input.memories) {
      if (levelSet !== null && !levelSet.has(m.level)) continue
      if (opts.scope === 'project' && opts.project !== undefined && projectKey(m) !== opts.project && !isGlobalProject(m.project)) continue
      const key = projectKey(m)
      clusterOf.set(m.id, key)
      if (!memoryOf.has(m.id)) memoryOf.set(m.id, m)
    }
  }

  // ── 节点：项目枢纽 ────────────────────────────────────────────────────────
  const projectCount = new Map<string, number>()
  for (const m of memoryOf.values()) {
    const key = projectKey(m)
    if (key === '') continue
    projectCount.set(key, (projectCount.get(key) ?? 0) + 1)
  }
  const displays = inputs[0]?.displays
  for (const [name, count] of projectCount) {
    nodes.set(`p:${name}`, {
      id: `p:${name}`,
      type: 'project',
      level: 'project',
      label: displays?.get(name) ?? name,
      content: `${count} 条记忆`,
      degree: 0,
      cluster: name,
    })
  }

  // ── 节点：会话 ────────────────────────────────────────────────────────────
  const sessionNode = (sessionId: string, workspace: string): string => {
    const id = `s:${sessionId}`
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        type: 'session',
        level: 'session',
        label: shortSession(sessionId),
        content: workspace,
        degree: 0,
        cluster: null,
      })
    }
    return id
  }

  // ── 边：结构（记忆 → 项目 / 来源会话） ────────────────────────────────────
  for (const m of memoryOf.values()) {
    if (edgeFilter('project')) {
      for (const name of projectList(m.project)) {
        const hub = `p:${name}`
        if (!nodes.has(hub)) continue
        edges.push({ source: hub, target: `m:${m.id}`, type: 'project', weight: 1 })
      }
      // 全局/未标记条目：挂在 scope 内的第一个项目枢纽上，避免成为孤岛。
      if (projectKey(m) === '' && projectCount.size > 0) {
        const fallback = [...projectCount.keys()][0]!
        edges.push({ source: `p:${fallback}`, target: `m:${m.id}`, type: 'project', weight: 0.4 })
      }
    }
    if (edgeFilter('write') && m.sourceSession !== null && m.sourceSession !== '') {
      edges.push({ source: sessionNode(m.sourceSession, m.workspace), target: `m:${m.id}`, type: 'write', weight: 1 })
    }
  }

  // ── 边：相似（同工作区同项目桶内，关键词倒排取候选 + topK） ────────────────
  if (edgeFilter('similar')) {
    const buckets = new Map<string, MemoryDto[]>()
    for (const m of memoryOf.values()) {
      if (m.keywords.length === 0) continue
      const key = `${m.workspace}\u0000${projectKey(m)}`
      const list = buckets.get(key) ?? []
      list.push(m)
      buckets.set(key, list)
    }
    for (const list of buckets.values()) {
      if (list.length < 2) continue
      const index = new Map<string, number[]>()
      list.forEach((m, i) => {
        for (const k of m.keywords) {
          const arr = index.get(k) ?? []
          arr.push(i)
          index.set(k, arr)
        }
      })
      const best = new Map<number, Array<{ j: number; sim: number }>>()
      for (const arr of index.values()) {
        if (arr.length > 40) continue
        for (let a = 0; a < arr.length; a++) {
          for (let b = a + 1; b < arr.length; b++) {
            const i = arr[a]!
            const j = arr[b]!
            const sim = jaccard(list[i]!.keywords, list[j]!.keywords)
            if (sim < opts.threshold) continue
            for (const [from, to] of [[i, j], [j, i]] as const) {
              const arr2 = best.get(from) ?? []
              arr2.push({ j: to, sim })
              best.set(from, arr2)
            }
          }
        }
      }
      for (const [i, cands] of best) {
        cands.sort((x, y) => y.sim - x.sim)
        for (const c of cands.slice(0, opts.topK)) {
          // 无向边只存一次（小 id 在前）
          const a = list[i]!.id
          const b = list[c.j]!.id
          if (a === b) continue
          const source = a < b ? a : b
          const target = a < b ? b : a
          edges.push({ source: `m:${source}`, target: `m:${target}`, type: 'similar', weight: Math.round(c.sim * 100) / 100 })
        }
      }
    }
  }

  // ── 边：取代（同 level + 高相似 + 一新一旧） ──────────────────────────────
  if (edgeFilter('supersede')) {
    const byLevel = new Map<string, MemoryDto[]>()
    for (const m of memoryOf.values()) {
      if (m.keywords.length === 0) continue
      const list = byLevel.get(m.level) ?? []
      list.push(m)
      byLevel.set(m.level, list)
    }
    for (const list of byLevel.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i]!
          const b = list[j]!
          const oldOne = a.updatedAt <= b.updatedAt ? a : b
          const newOne = a.updatedAt <= b.updatedAt ? b : a
          if (oldOne.status === 'active') continue
          if (newOne.status !== 'active') continue
          if (jaccard(a.keywords, b.keywords) < SUPERSEDE_THRESHOLD) continue
          edges.push({ source: `m:${newOne.id}`, target: `m:${oldOne.id}`, type: 'supersede', weight: 1 })
        }
      }
    }
  }

  // ── 边：会话读写（sessions/<id>.json 痕迹） ───────────────────────────────
  if (edgeFilter('read') || edgeFilter('write')) {
    for (const input of inputs) {
      for (const fp of input.footprints ?? []) {
        const ids = (fp as unknown as { ids?: { read?: string[]; write?: string[] } }).ids
        if (ids === undefined) continue
        const node = sessionNode(fp.sessionId, input.workspace)
        if (edgeFilter('read')) {
          for (const id of ids.read ?? []) {
            if (!memoryOf.has(id)) continue
            edges.push({ source: node, target: `m:${id}`, type: 'read', weight: 1 })
          }
        }
      }
    }
  }

  // ── 收尾：度、节点集、降采样 ──────────────────────────────────────────────
  const referenced = new Set<string>()
  for (const e of edges) {
    referenced.add(e.source)
    referenced.add(e.target)
  }
  for (const id of [...nodes.keys()]) if (!referenced.has(id)) nodes.delete(id)
  for (const m of memoryOf.values()) {
    const id = `m:${m.id}`
    if (!referenced.has(id)) continue
    nodes.set(id, {
      id,
      type: 'memory',
      level: m.level,
      label: m.content.slice(0, 40),
      content: m.content,
      keywords: m.keywords,
      importance: m.importance,
      status: m.status,
      workspace: m.workspace,
      project: m.project,
      updatedAt: m.updatedAt,
      degree: 0,
      cluster: clusterOf.get(m.id) ?? null,
    })
  }
  for (const e of edges) {
    const a = nodes.get(e.source)
    const b = nodes.get(e.target)
    if (a === undefined || b === undefined) continue
    a.degree++
    b.degree++
  }

  let dropped = 0
  let keptEdges = edges.filter((e) => nodes.has(e.source) && nodes.has(e.target))
  // 节点超限：先丢 archived，再丢 degree=1 的低 importance，再丢剩余里更新时间最旧的。
  if (nodes.size > opts.limit) {
    const victims = [...nodes.values()]
      .filter((n) => n.type === 'memory')
      .sort((a, b) => {
        const score = (n: GraphNode): number =>
          (n.status === 'archived' ? -1000 : n.status === 'stale' ? -100 : 0) +
          (n.degree <= 1 ? -50 : 0) +
          (n.importance ?? 1) * 10 +
          Math.min(20, (n.degree ?? 0) * 2)
        return score(a) - score(b)
      })
    for (const v of victims) {
      if (nodes.size <= opts.limit) break
      nodes.delete(v.id)
      dropped++
    }
    keptEdges = keptEdges.filter((e) => nodes.has(e.source) && nodes.has(e.target))
  }
  let truncated = dropped > 0
  if (keptEdges.length > MAX_EDGES) {
    keptEdges = keptEdges.slice(0, MAX_EDGES)
    truncated = true
  }
  // 再次清理孤立节点
  const referenced2 = new Set<string>()
  for (const e of keptEdges) {
    referenced2.add(e.source)
    referenced2.add(e.target)
  }
  for (const id of [...nodes.keys()]) {
    if (referenced2.has(id)) continue
    if (nodes.get(id)?.type === 'project') continue // 项目枢纽即使暂时孤立也保留（用户点得开）
    nodes.delete(id)
  }
  // 重算度
  for (const n of nodes.values()) n.degree = 0
  for (const e of keptEdges) {
    const a = nodes.get(e.source)
    const b = nodes.get(e.target)
    if (a !== undefined) a.degree++
    if (b !== undefined) b.degree++
  }

  const byType: Record<GraphEdgeType, number> = { project: 0, similar: 0, read: 0, write: 0, supersede: 0 }
  for (const e of keptEdges) byType[e.type]++
  for (const input of inputs) revisionParts.push(`${input.workspace}:${input.memories.length}`)
  void droppedSessions
  return {
    scope: { kind: opts.scope, ...(opts.scope === 'project' && opts.project !== undefined ? { project: opts.project } : {}) },
    nodes: [...nodes.values()],
    edges: keptEdges,
    stats: {
      nodes: nodes.size,
      edges: keptEdges.length,
      byType,
      dropped,
      truncated,
      revision: `g-${revisionParts.join('|')}`,
    },
  }
}

export type { GraphDto, GraphEdge, GraphEdgeType, GraphNode }
