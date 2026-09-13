/**
 * meow-memory 记忆查看器 — 面板根组件 + 全局视图。
 *
 * 形态：注册进 main(key=meow-memory) 的中央面板，与 sidebar.panellist 的图标配对
 * （点侧栏图标切到这里）。数据全部来自 /meow-memory/api/*（只读）。
 *
 * 失败一律 fail-open：网络断了、宿主没挂数据面、某个库坏了 → 渲染错误态/部分提示，
 * 绝不抛到宿主渲染树。
 */

import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { MemoryDto, OverviewDto, WorkspaceSummary } from '../viewer/types.js'
import { ViewerApiError, viewerApi } from './api.js'
import { humanCount, levelColor, relativeTime, workspaceLabel } from './model.js'
import { KpiCard, LevelBar, LevelBadge, MemoryRow, ensureViewerCss } from './ui.js'
import { WorkspaceView } from './Workspace.js'
import { StarMapView } from './StarMap.js'

type Scope = 'global' | 'workspace' | 'starmap'

export interface MemoryViewerPanelProps {
  /** 宿主注入的 sessions 快照 hook（旧宿主可能缺席）。 */
  useSessions?: (sel: (state: unknown) => unknown) => unknown
  /** 宿主注入的 workspaces 快照 hook（备用来源）。 */
  useWorkspaces?: (sel: (state: unknown) => unknown) => unknown
}

const REFRESH_MS = 60_000

export function MemoryViewerPanel(props: MemoryViewerPanelProps): ReactNode {
  try {
    ensureViewerCss()
  } catch {
    /* 非浏览器环境（SSR/测试）：跳过样式注入 */
  }
  const [scope, setScope] = useState<Scope>('global')
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [wsPath, setWsPath] = useState<string>('')
  const [overview, setOverview] = useState<OverviewDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>('')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Array<{ workspace: string; workspaceTitle: string; memory: MemoryDto }>>([])
  const [tick, setTick] = useState(0)
  const bootstrapped = useRef(false)

  // 当前会话 → 工作区（找不到就退回列表第一个）
  const currentSession = (() => {
    try {
      const v = props.useSessions?.((s) => (s as { current?: string } | undefined)?.current)
      return typeof v === 'string' ? v : ''
    } catch {
      return ''
    }
  })()

  const loadWorkspaces = useCallback(async (): Promise<WorkspaceSummary[]> => {
    const data = await viewerApi.workspaces()
    setWorkspaces(data.workspaces)
    return data.workspaces
  }, [])

  // 首次：拉工作区列表 + 用当前会话定位工作区
  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    void (async () => {
      setLoading(true)
      setError('')
      try {
        const list = await loadWorkspaces()
        let preferred = ''
        if (currentSession.length > 0) {
          try {
            const ctx = await viewerApi.context(currentSession)
            preferred = ctx.workspace
          } catch {
            /* 会话不在本实例：忽略 */
          }
        }
        const fallback = list.find((w) => w.hasDb)?.path ?? list[0]?.path ?? ''
        setWsPath(preferred.length > 0 && list.some((w) => w.path === preferred) ? preferred : fallback)
      } catch (e) {
        setError(e instanceof ViewerApiError ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [currentSession, loadWorkspaces])

  // 总览数据（全局视图 + 星图都用它做工作区清单）
  useEffect(() => {
    if (scope !== 'global') return
    let alive = true
    setLoading(true)
    void (async () => {
      try {
        const d = await viewerApi.overview()
        if (!alive) return
        setOverview(d)
        setWorkspaces(d.workspaces)
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
  }, [scope, tick])

  // 60s 自动刷新（与 dream 图标同一节奏；切走/卸载即停）
  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [])

  // 跨工作区检索（全局视图搜索框，300ms 防抖）
  useEffect(() => {
    const q = query.trim()
    if (q.length === 0) {
      setHits([])
      return
    }
    let alive = true
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const d = await viewerApi.search(q, 40)
          if (alive) setHits(d.hits)
        } catch {
          if (alive) setHits([])
        }
      })()
    }, 300)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [query])

  const openWorkspace = useCallback((path: string) => {
    setWsPath(path)
    setScope('workspace')
  }, [])

  const currentWs = workspaces.find((w) => w.path === wsPath)

  const body = ((): ReactNode => {
    if (error.length > 0 && overview === null && scope === 'global') {
      return h('div', { className: 'mmv-error' }, `记忆查看器数据面不可用：${error}`)
    }
    if (scope === 'global') {
      if (query.trim().length > 0) {
        return h(SearchResults, { hits, onOpenWorkspace: openWorkspace })
      }
      return h(GlobalView, { overview, loading, onOpenWorkspace: openWorkspace, onOpenMemory: () => setScope('workspace') })
    }
    if (scope === 'workspace') {
      if (wsPath === '') return h('div', { className: 'mmv-empty' }, loading ? '正在加载工作区…' : '没有可查看的工作区')
      return h(WorkspaceView, { workspace: wsPath, title: currentWs === undefined ? undefined : workspaceLabel(currentWs) })
    }
    return h(StarMapView, { workspaces, wsPath })
  })()

  return h(
    'div',
    { className: 'mmv-root' },
    h(
      'div',
      { className: 'mmv-bar' },
      h('h2', { className: 'mmv-title' }, '记忆'),
      h(
        'div',
        { className: 'mmv-seg' },
        (['global', 'workspace', 'starmap'] as Scope[]).map((s) =>
          h(
            'button',
            { key: s, className: scope === s ? 'on' : '', onClick: () => setScope(s) },
            s === 'global' ? '全局' : s === 'workspace' ? '工作区' : '星图',
          ),
        ),
      ),
      scope === 'workspace' || scope === 'starmap'
        ? h(
            'select',
            {
              className: 'mmv-input',
              style: { minWidth: 200 },
              value: wsPath,
              onChange: (e: { target: { value: string } }) => setWsPath(e.target.value),
            },
            workspaces.map((w) => h('option', { key: w.path, value: w.path }, `${workspaceLabel(w)}${w.hasDb ? '' : '（无记忆库）'}`)),
          )
        : null,
      scope !== 'starmap'
        ? h('input', {
            className: 'mmv-input',
            placeholder: scope === 'global' ? '跨工作区搜索记忆…' : '搜索本工作区…',
            value: query,
            onChange: (e: { target: { value: string } }) => setQuery(e.target.value),
          })
        : null,
      h('div', { className: 'mmv-spacer' }),
      h('span', { className: 'mmv-note' }, loading ? '加载中…' : `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`),
      h('button', { className: 'mmv-btn', onClick: () => setTick((t) => t + 1) }, '刷新'),
    ),
    h('div', { className: 'mmv-body' }, body),
  )
}

// ── 全局视图 ────────────────────────────────────────────────────────────────

/** 全局视图（导出供测试直接渲染，不必经过面板的数据获取层）。 */
export function GlobalView({
  overview,
  loading,
  onOpenWorkspace,
}: {
  overview: OverviewDto | null
  loading: boolean
  onOpenWorkspace: (path: string) => void
  onOpenMemory: () => void
}): ReactNode {
  if (overview === null) return h('div', { className: 'mmv-loading' }, loading ? '正在聚合各工作区记忆…' : '暂无数据')
  const { kpi, byLevel, workspaces, recent, globalEntries, health, dreamLog } = overview
  return h(
    'div',
    null,
    h(
      'div',
      { className: 'mmv-kpis' },
      h(KpiCard, { label: '工作区', value: String(kpi.workspaces), sub: `${kpi.withDb} 个有记忆库`, color: '#7aa2f7' }),
      h(KpiCard, { label: '记忆总数', value: humanCount(kpi.total), sub: `本周新增 ${kpi.newThisWeek}`, color: '#9ece6a' }),
      h(KpiCard, { label: '项目', value: String(kpi.projects), sub: '跨工作区去重', color: '#bb9af7' }),
      h(KpiCard, { label: '待整理窗口', value: String(kpi.pendingDream), sub: '空闲且未 dream', color: '#e0af68' }),
      h(KpiCard, { label: '已完结/删除', value: `${kpi.stale} / ${kpi.archived}`, sub: 'stale / archived', color: '#565f89' }),
      h(KpiCard, { label: '层级分布', value: `P${byLevel.project} F${byLevel.fact}`, sub: `L${byLevel.lesson} T${byLevel.topic} R${byLevel.rules}` }),
    ),
    h(
      'div',
      { className: 'mmv-cols' },
      h(
        'div',
        { className: 'mmv-col', style: { flex: '1 1 60%' } },
        h('div', { className: 'mmv-sect' }, '工作区', h('em', null, `${workspaces.length} 个`)),
        h(
          'div',
          { className: 'mmv-grid2' },
          workspaces.map((w) => h(WorkspaceCard, { key: w.path, ws: w, onOpen: () => onOpenWorkspace(w.path) })),
        ),
        h('div', { className: 'mmv-sect', style: { marginTop: 16 } }, '健康检查', h('em', null, '点开即刻过滤到对应条目（在工作区视图里看）')),
        h(
          'div',
          { className: 'mmv-health' },
          health.map((item) =>
            h(
              'div',
              { key: item.key, className: 'h', onClick: () => onOpenWorkspace(workspaces.find((w) => w.hasDb)?.path ?? '') },
              h('i', { style: { background: healthColor(item.key) } }),
              healthLabel(item.key),
              h('b', { style: { color: healthColor(item.key) } }, String(item.count)),
            ),
          ),
        ),
      ),
      h(
        'div',
        { className: 'mmv-col', style: { flex: '1 1 32%', minWidth: 280 } },
        h('div', { className: 'mmv-sect' }, '跨库最近更新'),
        recent.length === 0
          ? h('div', { className: 'mmv-empty' }, '还没有记忆')
          : recent.slice(0, 12).map((e) =>
              h(MemoryRow, { key: `${e.workspace}-${e.memory.id}`, memory: e.memory, showWorkspace: e.workspaceTitle, onClick: () => onOpenWorkspace(e.workspace) }),
            ),
        h('div', { className: 'mmv-sect', style: { marginTop: 14 } }, '全局条目', h('em', null, 'project = 全局')),
        globalEntries.length === 0
          ? h('div', { className: 'mmv-note' }, '暂无标记为「全局」的条目')
          : globalEntries.slice(0, 8).map((e) =>
              h(MemoryRow, { key: `${e.workspace}-${e.memory.id}`, memory: e.memory, showWorkspace: e.workspaceTitle, onClick: () => onOpenWorkspace(e.workspace) }),
            ),
      ),
    ),
    dreamLog.length > 0
      ? h(
          'div',
          { style: { marginTop: 18 } },
          h('div', { className: 'mmv-sect' }, '整理留痕', h('em', null, 'dream_log')),
          h(
            'div',
            { className: 'mmv-tl' },
            dreamLog.slice(0, 8).map((d, i) =>
              h(
                'div',
                { className: 'item', key: `${d.workspace}-${d.runAt}-${i}` },
                h('div', { className: 'when' }, relativeTime(d.runAt)),
                h('div', { className: 'what' }, `${d.workspace} · ${d.summary || d.note || '（无摘要）'}`),
              ),
            ),
          ),
        )
      : null,
  )
}

function WorkspaceCard({ ws, onOpen }: { ws: WorkspaceSummary; onOpen: () => void }): ReactNode {
  const total = Object.values(ws.counts).reduce((a, b) => a + b, 0)
  return h(
    'div',
    { className: 'mmv-ws', onClick: onOpen },
    h(
      'div',
      { className: 't' },
      h('b', null, workspaceLabel(ws)),
      h('span', { style: { marginLeft: 'auto', color: '#e0af68', opacity: ws.dream.hasLease ? 1 : 0.55 } }, '●'),
    ),
    h('div', { className: 'p' }, ws.path),
    h(LevelBar, { counts: ws.counts }),
    h('div', { className: 'num' }, ws.hasDb ? humanCount(total) : '—', h('small', null, ' 条')),
    h('div', { className: 'meta' }, ws.hasDb ? `项目 ${ws.projects.length} · 最近更新 ${relativeTime(ws.lastUpdatedAt)}` : '无记忆库（还没写过记忆）'),
    ws.error !== undefined ? h('div', { className: 'mmv-note', style: { color: '#f7768e' } }, `读取失败：${ws.error}`) : null,
    h(
      'div',
      { className: 'mmv-mini' },
      (['project', 'fact', 'lesson', 'topic', 'rules', 'soul', 'user'] as const)
        .filter((l) => (ws.counts[l] ?? 0) > 0)
        .map((l) =>
          h(
            'span',
            { key: l },
            h('i', { style: { background: levelColor(l) } }),
            `${l} ${ws.counts[l]}`,
          ),
        ),
    ),
  )
}

function SearchResults({
  hits,
  onOpenWorkspace,
}: {
  hits: Array<{ workspace: string; workspaceTitle: string; memory: MemoryDto }>
  onOpenWorkspace: (path: string) => void
}): ReactNode {
  if (hits.length === 0) return h('div', { className: 'mmv-empty' }, '没有匹配的记忆')
  return h(
    'div',
    null,
    h('div', { className: 'mmv-sect' }, `跨工作区命中 ${hits.length} 条`),
    hits.map((hit) =>
      h(MemoryRow, {
        key: `${hit.workspace}-${hit.memory.id}`,
        memory: hit.memory,
        showWorkspace: hit.workspaceTitle,
        onClick: () => onOpenWorkspace(hit.workspace),
      }),
    ),
  )
}

function healthLabel(key: string): string {
  if (key === 'noKeywords') return '无关键词条目'
  if (key === 'staleRules') return '超期未更新准则'
  if (key === 'possibleDuplicates') return '疑似重复（≥0.8）'
  return '未完成 todo'
}

function healthColor(key: string): string {
  if (key === 'noKeywords') return '#e0af68'
  if (key === 'staleRules') return '#565f89'
  if (key === 'possibleDuplicates') return '#f7768e'
  return '#7dcfff'
}

// ── 侧栏图标（sidebar.panellist 的 glyph） ──────────────────────────────────

/** 记忆图标：中心星 + 三层轨道（与"记忆星图"语义一致，纯 SVG 不吃字体）。 */
export function MemoryGlyph({ size = 18 }: { size?: number }): ReactNode {
  return h(
    'svg',
    { width: size, height: size, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': 'true' },
    h('circle', { cx: 10, cy: 10, r: 3.1, fill: 'currentColor' }),
    h('ellipse', { cx: 10, cy: 10, rx: 8.4, ry: 4.2, stroke: 'currentColor', strokeWidth: 1.1, opacity: 0.75 }),
    h('ellipse', { cx: 10, cy: 10, rx: 4.4, ry: 8.4, stroke: 'currentColor', strokeWidth: 1.1, opacity: 0.5 }),
    h('circle', { cx: 17.4, cy: 7.2, r: 1.5, fill: 'currentColor', opacity: 0.85 }),
    h('circle', { cx: 6.4, cy: 17.6, r: 1.3, fill: 'currentColor', opacity: 0.7 }),
  )
}
