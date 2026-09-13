/**
 * meow-memory 记忆查看器 — 纯计算层（无 DOM、无 React，可直接单测）。
 *
 * 三块：
 *  ① 展示映射：level → 颜色/文案、时间格式化、计数格式化；
 *  ② 星图布局：星座布局（确定性）+ 力导向迭代 + 命中测试；
 *  ③ 列表侧过滤/排序/统计（客户端本地筛选，服务端已有权威检索）。
 */

import type { GraphEdge, GraphNode, MemoryDto, ViewerLevel, ViewerStatus, WorkspaceSummary } from '../viewer/types.js'
import { VIEWER_LEVELS } from '../viewer/types.js'

// ── ① 展示映射 ──────────────────────────────────────────────────────────────

/** level → 颜色（暗色主题友好；与设计稿 docs/mockups 一致）。 */
export const LEVEL_COLORS: Record<string, string> = {
  project: '#7aa2f7',
  fact: '#9ece6a',
  lesson: '#f7768e',
  topic: '#e0af68',
  rules: '#bb9af7',
  soul: '#7dcfff',
  user: '#c0caf5',
  session: '#7dcfff',
  none: '#565f89',
}

export const LEVEL_LABELS: Record<string, string> = {
  project: '项目',
  fact: '事实',
  lesson: '教训',
  topic: '话题',
  rules: '准则',
  soul: 'AI 自身',
  user: '用户',
  session: '会话',
}

export const STATUS_LABELS: Record<ViewerStatus, string> = {
  active: 'active',
  stale: 'stale（完结）',
  archived: 'archived（删除）',
}

export function levelColor(level: string | undefined): string {
  return LEVEL_COLORS[level ?? 'none'] ?? LEVEL_COLORS.none!
}

export function levelLabel(level: string | undefined): string {
  return LEVEL_LABELS[level ?? 'none'] ?? (level ?? '—')
}

export function relativeTime(ms: number | null | undefined, now = Date.now()): string {
  if (ms === null || ms === undefined || ms === 0) return '—'
  const diff = now - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return absoluteTime(ms).slice(0, 10)
}

export function absoluteTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms === 0) return '—'
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function humanCount(n: number): string {
  return n.toLocaleString('zh-CN')
}

/** 工作区显示名（优先 title，退化到路径末段）。 */
export function workspaceLabel(w: Pick<WorkspaceSummary, 'title' | 'path'>): string {
  if (w.title && w.title.length > 0) return w.title
  const p = w.path.replace(/[\\/]+$/, '')
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

// ── ② 星图布局 ──────────────────────────────────────────────────────────────

export interface Pt {
  x: number
  y: number
}

/** level → 星系内分层半径系数（0=核心，1=外缘）。 */
const LAYER_FRACTION: Record<string, number> = {
  project: 0.34,
  fact: 0.6,
  lesson: 0.62,
  topic: 0.86,
  rules: 0.88,
  soul: 1,
  user: 1,
}

export interface LayoutOptions {
  width: number
  height: number
  padding?: number
}

/**
 * 星座布局：项目 = 星系核心，记忆按 level 分层环绕，角度按稳定序（updatedAt, id）
 * 展开；会话节点排在外环"时间带"；全局/未标记条目聚成中心星云。
 * 确定性：同输入必得同坐标（力导向每次不同，所以它只是备选）。
 */
export function constellationLayout(nodes: readonly GraphNode[], opts: LayoutOptions): Map<string, Pt> {
  const out = new Map<string, Pt>()
  const pad = opts.padding ?? 90
  const cx = opts.width / 2
  const cy = opts.height / 2
  const projects = nodes.filter((n) => n.type === 'project').sort((a, b) => a.label.localeCompare(b.label))
  const sessions = nodes.filter((n) => n.type === 'session').sort((a, b) => a.label.localeCompare(b.label))
  const memories = nodes.filter((n) => n.type === 'memory')
  const byCluster = new Map<string, GraphNode[]>()
  for (const m of memories) {
    const key = m.cluster ?? ''
    const list = byCluster.get(key) ?? []
    list.push(m)
    byCluster.set(key, list)
  }
  for (const list of byCluster.values()) {
    list.sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0) || a.id.localeCompare(b.id))
  }

  // 星系中心：按项目规模排序后绕中心一圈（规模大的靠内圈）。
  const clusters = projects.map((p) => ({ name: p.label, count: (byCluster.get(p.label) ?? []).length }))
  const maxCount = Math.max(1, ...clusters.map((c) => c.count))
  const ringR = Math.max(150, Math.min(opts.width, opts.height) * 0.5 - pad)
  clusters.forEach((c, i) => {
    if (clusters.length === 1) {
      out.set(`p:${c.name}`, { x: cx, y: cy })
      return
    }
    const angle = (i / clusters.length) * Math.PI * 2 - Math.PI / 2
    const dist = clusters.length <= 2 ? ringR * 0.55 : ringR * (0.55 + 0.45 * (1 - c.count / maxCount))
    out.set(`p:${c.name}`, { x: cx + Math.cos(angle) * dist, y: cy + Math.sin(angle) * dist * 0.78 })
  })

  // 星系内：分层 + 时间序角度
  const clusterRadius = (count: number): number => 46 + Math.min(120, Math.sqrt(count) * 16)
  for (const c of clusters) {
    const center = out.get(`p:${c.name}`)!
    const list = byCluster.get(c.name) ?? []
    const r = clusterRadius(list.length)
    const byLevel = new Map<string, GraphNode[]>()
    for (const m of list) {
      const arr = byLevel.get(m.level) ?? []
      arr.push(m)
      byLevel.set(m.level, arr)
    }
    let li = 0
    for (const level of VIEWER_LEVELS) {
      const arr = byLevel.get(level)
      if (arr === undefined) continue
      const frac = LAYER_FRACTION[level] ?? 0.7
      arr.forEach((m, i) => {
        const angle = (i / Math.max(1, arr.length)) * Math.PI * 2 + li * 0.7 - Math.PI / 2
        out.set(m.id, {
          x: center.x + Math.cos(angle) * r * frac,
          y: center.y + Math.sin(angle) * r * frac * 0.86,
        })
      })
      li++
    }
  }

  // 全局/未标记星云（左下，离星系远一点）
  const loose = byCluster.get('') ?? []
  const nebula = { x: cx - opts.width * 0.3, y: cy + opts.height * 0.26 }
  loose.forEach((m, i) => {
    const angle = i * 2.399
    const r = 18 + i * 5.5
    out.set(m.id, { x: nebula.x + Math.cos(angle) * r, y: nebula.y + Math.sin(angle) * r * 0.7 })
  })

  // 会话：外环时间带（底部半圈，按 id 排序稳定）
  sessions.forEach((s, i) => {
    const t = sessions.length === 1 ? 0.5 : i / (sessions.length - 1)
    const angle = Math.PI * (0.15 + 0.7 * t)
    const dist = Math.min(opts.width, opts.height) * 0.46
    out.set(s.id, { x: cx + Math.cos(angle) * dist, y: cy + Math.sin(angle) * dist * 0.82 })
  })

  return out
}

/** 力导向单步（Fruchterman–Reingold 简化版；调用方负责降温与迭代次数）。 */
export function forceStep(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  pos: Map<string, Pt>,
  alpha: number,
  opts: { repulsion?: number; linkDistance?: number; center?: Pt } = {},
): void {
  const repulsion = opts.repulsion ?? 2200
  const linkDistance = opts.linkDistance ?? 70
  const center = opts.center
  const n = nodes.length
  // 斥力：距离平方衰减，超过 cutoff 直接忽略（避免长尾计算无效）
  const cutoff = 260
  for (let i = 0; i < n; i++) {
    const a = pos.get(nodes[i]!.id)
    if (a === undefined) continue
    for (let j = i + 1; j < n; j++) {
      const b = pos.get(nodes[j]!.id)
      if (b === undefined) continue
      let dx = a.x - b.x
      let dy = a.y - b.y
      const d2 = dx * dx + dy * dy
      if (d2 > cutoff * cutoff) continue
      const d = Math.sqrt(d2) || 0.01
      const f = (repulsion / (d2 || 1)) * alpha
      dx /= d
      dy /= d
      a.x += dx * f
      a.y += dy * f
      b.x -= dx * f
      b.y -= dy * f
    }
  }
  // 引力：沿边收敛到目标边长
  for (const e of edges) {
    const a = pos.get(e.source)
    const b = pos.get(e.target)
    if (a === undefined || b === undefined) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const d = Math.hypot(dx, dy) || 0.01
    const f = ((d - linkDistance) / d) * 0.02 * alpha
    a.x += dx * f
    a.y += dy * f
    b.x -= dx * f
    b.y -= dy * f
  }
  // 向心力：防飘走
  if (center !== undefined) {
    for (const node of nodes) {
      const p = pos.get(node.id)
      if (p === undefined) continue
      p.x += (center.x - p.x) * 0.002 * alpha
      p.y += (center.y - p.y) * 0.002 * alpha
    }
  }
}

/** 力导向迭代次数上限：节点越多迭代越少（保持交互流畅）。 */
export function forceTicks(nodeCount: number): number {
  if (nodeCount <= 200) return 300
  if (nodeCount <= 600) return 180
  return 90
}

export interface ViewTransform {
  tx: number
  ty: number
  k: number
}

export function toWorld(t: ViewTransform, sx: number, sy: number): Pt {
  return { x: (sx - t.tx) / t.k, y: (sy - t.ty) / t.k }
}

/** 命中测试：按类型给不同容差（项目/会话更好点，记忆点小）。 */
export function hitTest(
  nodes: readonly GraphNode[],
  pos: Map<string, Pt>,
  t: ViewTransform,
  screenX: number,
  screenY: number,
  visible: (n: GraphNode) => boolean = () => true,
): GraphNode | null {
  const w = toWorld(t, screenX, screenY)
  let best: GraphNode | null = null
  let bestD = Infinity
  for (const n of nodes) {
    if (!visible(n)) continue
    const p = pos.get(n.id)
    if (p === undefined) continue
    const d = Math.hypot(p.x - w.x, p.y - w.y)
    const tolerance = (n.type === 'memory' ? 9 : 14) / t.k
    if (d <= tolerance && d < bestD) {
      bestD = d
      best = n
    }
  }
  return best
}

/** 节点半径（视觉：项目 > 会话 > 记忆；记忆随 importance 与度微调）。 */
export function nodeRadius(n: GraphNode): number {
  if (n.type === 'project') return 9 + Math.min(6, Math.sqrt(n.degree) * 1.6)
  if (n.type === 'session') return 6.5
  return 2.6 + Math.min(3.4, (n.importance ?? 1) * 0.7 + n.degree * 0.25)
}

/** 过滤后需要变暗的节点判定（层级开关 → 记忆节点变暗，枢纽保留）。 */
export function makeDimPredicate(activeLevels: ReadonlySet<string>): (n: GraphNode) => boolean {
  return (n: GraphNode): boolean => n.type === 'memory' && !activeLevels.has(n.level)
}

/** 边的可见性（类型开关 + 端点是否被层级过滤掉）。 */
export function makeEdgePredicate(
  edgesOn: Readonly<Record<string, boolean>>,
  dim: (n: GraphNode) => boolean,
): (e: GraphEdge, byId: Map<string, GraphNode>) => boolean {
  return (e, byId) => {
    if (edgesOn[e.type] === false) return false
    const a = byId.get(e.source)
    const b = byId.get(e.target)
    if (a !== undefined && a.type === 'memory' && dim(a)) return false
    if (b !== undefined && b.type === 'memory' && dim(b)) return false
    return true
  }
}

export function edgeColor(type: string): string {
  if (type === 'project') return '#7aa2f7'
  if (type === 'similar') return '#bb9af7'
  if (type === 'supersede') return '#f7768e'
  return '#7dcfff'
}

/** 边线样式：相似边虚线（"这是算出来的"），其余实线。 */
export function edgeDash(type: string): number[] {
  if (type === 'similar') return [3, 4]
  if (type === 'supersede') return [2, 3]
  return []
}

// ── ③ 列表侧过滤/排序/统计 ──────────────────────────────────────────────────

export interface MemoryFilter {
  levels: ReadonlySet<string>
  statuses: ReadonlySet<string>
  project: string | null
  unlabeled: boolean
  query: string
}

export const EMPTY_FILTER: MemoryFilter = { levels: new Set(), statuses: new Set(), project: null, unlabeled: false, query: '' }

/** 项目归属判定：'全局'/未标记条目天然命中任何项目过滤（与检索同口径）。 */
export function memoryMatchesProject(m: MemoryDto, project: string): boolean {
  if (m.project === null || m.project === '' || m.project === '全局' || m.project === 'global') return true
  return m.project
    .split(',')
    .map((s) => s.trim())
    .includes(project)
}

export function filterMemories(rows: readonly MemoryDto[], f: MemoryFilter): MemoryDto[] {
  const q = f.query.trim().toLowerCase()
  return rows.filter((m) => {
    if (f.levels.size > 0 && !f.levels.has(m.level)) return false
    if (f.statuses.size > 0 && !f.statuses.has(m.status)) return false
    if (f.unlabeled && !(m.project === null || m.project === '')) return false
    if (f.project !== null && !memoryMatchesProject(m, f.project)) return false
    if (q.length > 0) {
      const hay = `${m.content} ${m.keywords.join(' ')} ${m.title ?? ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

export type MemorySort = 'updated' | 'created' | 'importance'

export function sortMemories(rows: readonly MemoryDto[], sort: MemorySort): MemoryDto[] {
  const copy = [...rows]
  if (sort === 'created') return copy.sort((a, b) => b.createdAt - a.createdAt)
  if (sort === 'importance') return copy.sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt)
  return copy.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function levelCounts(rows: readonly MemoryDto[]): Record<ViewerLevel, number> {
  const out = { soul: 0, user: 0, project: 0, fact: 0, lesson: 0, topic: 0, rules: 0 } as Record<ViewerLevel, number>
  for (const m of rows) out[m.level]++
  return out
}

/** 项目归属计数（null 键 = 未标记/全局）。 */
export function projectCounts(rows: readonly MemoryDto[]): Array<{ name: string | null; count: number }> {
  const map = new Map<string | null, number>()
  for (const m of rows) {
    const key = m.project === null || m.project === '' ? null : m.project
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)))
}

/** 跨库检索命中 → 按工作区聚合展示。 */
export function groupHitsByWorkspace(hits: readonly { workspace: string; workspaceTitle: string; memory: MemoryDto }[]): Array<{
  workspace: string
  title: string
  items: MemoryDto[]
}> {
  const map = new Map<string, { workspace: string; title: string; items: MemoryDto[] }>()
  for (const h of hits) {
    const entry = map.get(h.workspace) ?? { workspace: h.workspace, title: h.workspaceTitle, items: [] }
    entry.items.push(h.memory)
    map.set(h.workspace, entry)
  }
  return [...map.values()]
}
