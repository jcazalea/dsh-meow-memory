/**
 * meow-memory 记忆查看器 — 星图视图（Canvas）。
 *
 * 布局：默认「星座」（项目=星系核心，level=分层半径，时间=角度，确定性可复现）；
 * 备选「力导向」（节点多时自动限步，纯前端迭代）。
 *
 * 边分三类且可分别开关：结构边（字段直出）/ 相似边（算出来的，虚线）/ 会话读写边。
 * 层级开关只改透明度不重算布局 —— 位置稳定，用户不会"转个开关图就散了"。
 */

import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { GraphDto, GraphEdge, GraphNode } from '../viewer/types.js'
import { ViewerApiError, viewerApi } from './api.js'
import {
  constellationLayout,
  edgeColor,
  edgeDash,
  forceStep,
  forceTicks,
  hitTest,
  levelColor,
  makeDimPredicate,
  makeEdgePredicate,
  nodeRadius,
  relativeTime,
  toWorld,
} from './model.js'
import { LevelBadge } from './ui.js'
import { humanCount } from './model.js'

const LEVELS = ['project', 'fact', 'lesson', 'topic', 'rules', 'soul', 'user'] as const
const EDGE_GROUPS: Array<{ key: 'project' | 'similar' | 'session' | 'supersede'; label: string }> = [
  { key: 'project', label: '结构边' },
  { key: 'similar', label: '相似边' },
  { key: 'session', label: '会话边' },
  { key: 'supersede', label: '取代边' },
]

interface ViewState {
  pos: Map<string, { x: number; y: number }>
  tx: number
  ty: number
  k: number
  drag: { x: number; y: number } | null
  moved: boolean
}

export function StarMapView({ workspaces, wsPath }: { workspaces: readonly { path: string; title: string }[]; wsPath: string }): ReactNode {
  const [scope, setScope] = useState<'workspace' | 'all'>(wsPath.length > 0 ? 'workspace' : 'all')
  const [graph, setGraph] = useState<GraphDto | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [edgesOn, setEdgesOn] = useState<Record<string, boolean>>({ project: true, similar: true, session: true, supersede: false })
  const [levels, setLevels] = useState<Set<string>>(new Set(LEVELS))
  const [layout, setLayout] = useState<'constellation' | 'force'>('constellation')
  const [threshold, setThreshold] = useState(0.35)
  const [topK, setTopK] = useState(3)
  const [selected, setSelected] = useState<GraphNode | null>(null)
  const [hover, setHover] = useState<GraphNode | null>(null)

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const view = useRef<ViewState>({ pos: new Map(), tx: 0, ty: 0, k: 1, drag: null, moved: false })
  const rafRef = useRef(0)
  const forceRef = useRef(0)


  // 拉数据
  useEffect(() => {
    let alive = true
    setLoading(true)
    void (async () => {
      try {
        const d = await viewerApi.graph({
          scope,
          workspace: scope === 'workspace' ? wsPath : undefined,
          level: undefined,
          edges: 'project,similar,read,write,supersede',
          threshold,
          topK,
          limit: 2000,
        })
        if (!alive) return
        setGraph(d)
        setError('')
      } catch (e) {
        if (alive) setError(e instanceof ViewerApiError ? e.message : String(e))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [scope, wsPath, threshold, topK])

  const byId = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph])
  const dim = useMemo(() => makeDimPredicate(levels), [levels])
  const edgeVisible = useMemo(() => {
    const on: Record<string, boolean> = { ...edgesOn }
    // UI 把 read/write 合并成"会话边"
    on.read = edgesOn.session !== false
    on.write = edgesOn.session !== false
    return makeEdgePredicate(on, dim)
  }, [edgesOn, dim])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (canvas === null || ctx === undefined || ctx === null || graph === null) return
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    if (canvas.width !== Math.floor(rect.width * dpr) || canvas.height !== Math.floor(rect.height * dpr)) {
      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, rect.width, rect.height)
    const v = view.current
    const focus = hover ?? selected
    const near = new Set<string>()
    if (focus !== null) {
      near.add(focus.id)
      for (const e of graph.edges) {
        if (e.source === focus.id) near.add(e.target)
        else if (e.target === focus.id) near.add(e.source)
      }
    }
    // 背景星点（确定性：由 id 哈希生成，不随重绘跳动）
    ctx.save()
    ctx.fillStyle = '#ffffff'
    for (let i = 0; i < 90; i++) {
      const x = ((i * 97.13) % rect.width) + 0.5
      const y = ((i * 53.7) % rect.height) + 0.5
      ctx.globalAlpha = 0.03 + ((i * 37) % 7) / 200
      ctx.beginPath()
      ctx.arc(x, y, 0.9, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()

    ctx.save()
    ctx.translate(v.tx, v.ty)
    ctx.scale(v.k, v.k)

    // 星系光晕
    for (const n of graph.nodes) {
      if (n.type !== 'project') continue
      const p = v.pos.get(n.id)
      if (p === undefined) continue
      const radius = 60 + nodeRadius(n) * 8
      const grad = ctx.createRadialGradient(p.x, p.y, 4, p.x, p.y, radius)
      grad.addColorStop(0, 'rgba(122,162,247,0.10)')
      grad.addColorStop(1, 'rgba(122,162,247,0)')
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2)
      ctx.fill()
    }

    // 边
    for (const e of graph.edges) {
      if (!edgeVisible(e, byId)) continue
      const a = v.pos.get(e.source)
      const b = v.pos.get(e.target)
      if (a === undefined || b === undefined) continue
      const dimmed = focus !== null && !(near.has(e.source) && near.has(e.target))
      ctx.globalAlpha = dimmed ? 0.05 : e.type === 'project' ? 0.26 : e.type === 'similar' ? 0.3 : 0.34
      ctx.strokeStyle = edgeColor(e.type)
      ctx.lineWidth = (e.type === 'project' ? 1 : 0.9) / v.k
      const dash = edgeDash(e.type)
      ctx.setLineDash(dash.length > 0 ? dash.map((d) => d / v.k) : [])
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
    ctx.setLineDash([])

    // 节点
    for (const n of graph.nodes) {
      const p = v.pos.get(n.id)
      if (p === undefined) continue
      if (n.type === 'memory' && dim(n)) ctx.globalAlpha = 0.07
      else if (focus !== null) ctx.globalAlpha = near.has(n.id) ? 1 : 0.15
      else ctx.globalAlpha = 1
      const color = n.type === 'memory' ? levelColor(n.level) : levelColor(n.type === 'session' ? 'session' : 'project')
      const r = nodeRadius(n)
      ctx.fillStyle = color
      if (n.type === 'project') {
        ctx.beginPath()
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
        ctx.lineWidth = 2 / v.k
        ctx.strokeStyle = color
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2)
        ctx.fill()
      } else if (n.type === 'session') {
        ctx.fillRect(p.x - 6, p.y - 6, 12, 12)
      } else {
        ctx.beginPath()
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    // 标签：枢纽 + 邻域
    ctx.globalAlpha = 1
    ctx.font = '11px "Noto Sans CJK SC", system-ui, sans-serif'
    ctx.fillStyle = 'rgba(154,165,206,0.95)'
    for (const n of graph.nodes) {
      const p = v.pos.get(n.id)
      if (p === undefined) continue
      const show = n.type === 'project' || n.type === 'session' || (focus !== null && near.has(n.id))
      if (!show) continue
      ctx.textAlign = n.type === 'project' ? 'center' : 'left'
      const label = n.type === 'memory' ? `#${n.id.slice(2, 8)}` : n.label
      ctx.fillText(label, p.x, p.y + (n.type === 'project' ? -14 : 4))
    }
    if (focus !== null) {
      const p = v.pos.get(focus.id)
      if (p !== undefined) {
        ctx.strokeStyle = '#e0af68'
        ctx.lineWidth = 1.6 / v.k
        ctx.beginPath()
        ctx.arc(p.x, p.y, nodeRadius(focus) + 6, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    ctx.restore()
  }, [graph, byId, dim, edgeVisible, hover, selected])

  const requestDraw = useCallback(() => {
    if (rafRef.current !== 0) return
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = 0
      draw()
    })
  }, [draw])

  // 布局：只在「数据 / 布局算法」变化时重算（hover、缩放、平移都不重算——
  // 否则鼠标一动图就跳）。refs 保存坐标，重算才写。
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || graph === null) return
    const rect = canvas.getBoundingClientRect()
    const width = Math.max(320, rect.width)
    const height = Math.max(240, rect.height)
    if (layout === 'constellation') {
      view.current.pos = constellationLayout(graph.nodes, { width, height })
    } else {
      const pos = constellationLayout(graph.nodes, { width, height })
      const ticks = forceTicks(graph.nodes.length)
      for (let i = 0; i < ticks; i++) {
        forceStep(graph.nodes, graph.edges, pos, i < ticks * 0.2 ? 1 : 0.35, { center: { x: width / 2, y: height / 2 } })
      }
      view.current.pos = pos
    }
    view.current.tx = 0
    view.current.ty = 0
    view.current.k = 1
    requestDraw()
  }, [graph, layout, requestDraw])

  // 重绘：draw 的依赖（hover / selected / 过滤器）一变就重画
  useEffect(() => {
    requestDraw()
  }, [draw, requestDraw])

  // 容器尺寸变化 → 重算布局 + 重绘
  useEffect(() => {
    const wrap = wrapRef.current
    if (wrap === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const canvas = canvasRef.current
      if (canvas === null || graph === null) return
      const rect = canvas.getBoundingClientRect()
      const width = Math.max(320, rect.width)
      const height = Math.max(240, rect.height)
      if (layout === 'constellation') {
        view.current.pos = constellationLayout(graph.nodes, { width, height })
      } else {
        const pos = constellationLayout(graph.nodes, { width, height })
        const ticks = forceTicks(graph.nodes.length)
        for (let i = 0; i < ticks; i++) {
          forceStep(graph.nodes, graph.edges, pos, i < ticks * 0.2 ? 1 : 0.35, { center: { x: width / 2, y: height / 2 } })
        }
        view.current.pos = pos
      }
      requestDraw()
    })
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [graph, layout, requestDraw])


  useEffect(
    () => () => {
      window.cancelAnimationFrame(rafRef.current)
      void forceRef.current
    },
    [],
  )

  // ── 交互 ────────────────────────────────────────────────────────────────
  const onMouseDown = (e: { clientX: number; clientY: number }): void => {
    view.current.drag = { x: e.clientX, y: e.clientY }
    view.current.moved = false
    canvasRef.current?.classList.add('drag')
  }
  const onMouseMove = (e: { clientX: number; clientY: number }): void => {
    const v = view.current
    const canvas = canvasRef.current
    if (canvas === null) return
    if (v.drag !== null) {
      v.tx += e.clientX - v.drag.x
      v.ty += e.clientY - v.drag.y
      v.drag = { x: e.clientX, y: e.clientY }
      v.moved = true
      requestDraw()
      return
    }
    const rect = canvas.getBoundingClientRect()
    const hit = hitTest(graph?.nodes ?? [], v.pos, { tx: v.tx, ty: v.ty, k: v.k }, e.clientX - rect.left, e.clientY - rect.top, (n) => !(n.type === 'memory' && dim(n)))
    if ((hit?.id ?? null) !== (hover?.id ?? null)) setHover(hit)
  }
  const onMouseUp = (): void => {
    view.current.drag = null
    canvasRef.current?.classList.remove('drag')
  }
  const onClick = (e: { clientX: number; clientY: number }): void => {
    const canvas = canvasRef.current
    if (canvas === null || view.current.moved) return
    const rect = canvas.getBoundingClientRect()
    const v = view.current
    const hit = hitTest(graph?.nodes ?? [], v.pos, { tx: v.tx, ty: v.ty, k: v.k }, e.clientX - rect.left, e.clientY - rect.top, (n) => !(n.type === 'memory' && dim(n)))
    setSelected(hit)
  }
  /** 缩放：以指针为锚点。挂在原生 wheel 监听上（React 的 onWheel 是被动监听，
   *  preventDefault 无效 → 面板内滚动会带着页面一起动）。 */
  const applyWheel = useCallback(
    (clientX: number, clientY: number, deltaY: number): void => {
      const canvas = canvasRef.current
      if (canvas === null) return
      const rect = canvas.getBoundingClientRect()
      const sx = clientX - rect.left
      const sy = clientY - rect.top
      const v = view.current
      const before = toWorld({ tx: v.tx, ty: v.ty, k: v.k }, sx, sy)
      v.k = Math.max(0.3, Math.min(2.8, v.k * (deltaY < 0 ? 1.12 : 0.9)))
      const after = toWorld({ tx: v.tx, ty: v.ty, k: v.k }, sx, sy)
      v.tx += (after.x - before.x) * v.k
      v.ty += (after.y - before.y) * v.k
      requestDraw()
    },
    [requestDraw],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const handler = (e: WheelEvent): void => {
      e.preventDefault()
      applyWheel(e.clientX, e.clientY, e.deltaY)
    }
    canvas.addEventListener('wheel', handler, { passive: false })
    return () => canvas.removeEventListener('wheel', handler)
  }, [applyWheel])

  const stats = graph?.stats
  const selectedMemory = selected?.type === 'memory' ? selected : null

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 9, height: '100%', minHeight: 0 } },
    h(
      'div',
      { className: 'mmv-filters', style: { marginBottom: 0 } },
      h('span', { className: 'mmv-note' }, '范围'),
      h(
        'button',
        { className: 'mmv-chip' + (scope === 'workspace' ? ' on' : ''), onClick: () => setScope('workspace'), disabled: wsPath === '' },
        '当前工作区',
      ),
      h('button', { className: 'mmv-chip' + (scope === 'all' ? ' on' : ''), onClick: () => setScope('all') }, '全部工作区'),
      h('span', { className: 'mmv-note', style: { marginLeft: 8 } }, '边'),
      EDGE_GROUPS.map((g) =>
        h(
          'button',
          { key: g.key, className: 'mmv-chip' + (edgesOn[g.key] !== false ? ' on' : ''), onClick: () => setEdgesOn((s) => ({ ...s, [g.key]: s[g.key] === false })) },
          g.label,
        ),
      ),
      h('span', { className: 'mmv-note', style: { marginLeft: 8 } }, '布局'),
      h('button', { className: 'mmv-chip' + (layout === 'constellation' ? ' on' : ''), onClick: () => setLayout('constellation') }, '星座'),
      h('button', { className: 'mmv-chip' + (layout === 'force' ? ' on' : ''), onClick: () => setLayout('force') }, '力导向'),
      h('span', { className: 'mmv-note', style: { marginLeft: 8 } }, `阈值 ${threshold.toFixed(2)}`),
      h('input', {
        type: 'range',
        min: 0.15,
        max: 0.8,
        step: 0.05,
        value: threshold,
        style: { width: 90 },
        onChange: (e: { target: { value: string } }) => setThreshold(Number(e.target.value)),
      }),
      h('span', { className: 'mmv-note' }, `topK ${topK}`),
      h('input', {
        type: 'range',
        min: 1,
        max: 6,
        step: 1,
        value: topK,
        style: { width: 70 },
        onChange: (e: { target: { value: string } }) => setTopK(Number(e.target.value)),
      }),
    ),
    h(
      'div',
      { className: 'mmv-filters', style: { marginBottom: 0 } },
      h('span', { className: 'mmv-note' }, '层级'),
      LEVELS.map((l) =>
        h(
          'button',
          {
            key: l,
            className: 'mmv-chip' + (levels.has(l) ? ' on' : ''),
            onClick: () =>
              setLevels((s) => {
                const next = new Set(s)
                if (next.has(l)) next.delete(l)
                else next.add(l)
                return next
              }),
          },
          l,
        ),
      ),
      h('span', { className: 'mmv-note', style: { marginLeft: 'auto' } }, loading ? '加载中…' : stats === undefined ? '' : `节点 ${humanCount(stats.nodes)} · 边 ${humanCount(stats.edges)}${stats.truncated ? ' · 已降采样' : ''}`),
    ),
    error.length > 0 ? h('div', { className: 'mmv-error' }, error) : null,
    h(
      'div',
      { className: 'mmv-graph', ref: wrapRef, style: { flex: '1 1 auto', minHeight: 380 } },
      h('canvas', {
        ref: canvasRef,
        onMouseDown,
        onMouseMove,
        onMouseUp,
        onMouseLeave: () => {
          onMouseUp()
          setHover(null)
        },
        onClick,
        onDoubleClick: () => {
          view.current.tx = 0
          view.current.ty = 0
          view.current.k = 1
          requestDraw()
        },
      }),
      h(
        'div',
        { className: 'mmv-overlay mmv-stats' },
        h('span', null, `节点 ${graph?.nodes.length ?? 0}`),
        h('span', null, `边 ${graph?.edges.length ?? 0}`),
        stats !== undefined
          ? h(
              'span',
              null,
              `结构 ${stats.byType.project} / 相似 ${stats.byType.similar} / 会话 ${stats.byType.read + stats.byType.write}${stats.byType.supersede > 0 ? ` / 取代 ${stats.byType.supersede}` : ''}`,
            )
          : null,
      ),
      h(
        'div',
        { className: 'mmv-overlay mmv-legend' },
        LEVELS.map((l) =>
          h('div', { key: l }, h('i', { style: { background: levelColor(l) } }), l),
        ),
        h('div', { style: { marginTop: 4 } }, h('i', { style: { background: '#7aa2f7' } }), '项目核心'),
        h('div', null, h('i', { style: { background: '#7dcfff' } }), '会话'),
        h('div', { style: { marginTop: 4, opacity: 0.8 } }, '── 结构　┄┄ 相似'),
      ),
      h('div', { className: 'mmv-overlay mmv-hint' }, 'hover 高亮邻接 · 单击详情 · 双击复位 · 拖拽平移 · 滚轮缩放'),
      selected !== null || hover !== null
        ? h(
            'div',
            { className: 'mmv-overlay mmv-info' },
            (() => {
              const n = selected ?? hover!
              if (n.type !== 'memory') {
                return h(
                  'div',
                  null,
                  h('h5', null, h(LevelBadge, { level: n.type === 'project' ? 'project' : 'session' }), n.label),
                  h('p', null, n.type === 'project' ? `该项目 ${n.degree} 条关联记忆` : `会话 ${n.label} 的记忆痕迹`),
                  h('div', { className: 'mmv-note' }, `邻接 ${n.degree}`),
                )
              }
              return h(
                'div',
                null,
                h('h5', null, h(LevelBadge, { level: n.level, sub: null }), h('span', { className: 'mmv-note' }, n.project ?? '未标记')),
                h('p', null, selectedMemory?.content ?? n.content ?? ''),
                n.keywords !== undefined ? h('div', { className: 'mmv-kw' }, n.keywords.slice(0, 6).map((k, i) => h('span', { key: `${k}-${i}` }, k))) : null,
                h('div', { className: 'mmv-note', style: { marginTop: 6 } }, `邻接 ${n.degree} · 更新 ${relativeTime(n.updatedAt)}`),
              )
            })(),
          )
        : null,
    ),
  )
}
