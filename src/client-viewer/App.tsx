/**
 * meow-memory 记忆查看器 — 面板根组件 + 全局视图。
 *
 * 形态：注册进 main(key=meow-memory) 的中央面板，与 sidebar.panellist 的图标配对
 * （点侧栏图标切到这里）。数据来自 /meow-memory/api/*（只读端点）+ POST /migrate-old
 * （面板「迁移旧库」手动并入旧库——v0.29.1 起唯一写端点）。
 *
 * 失败一律 fail-open：网络断了、宿主没挂数据面、某个库坏了 → 渲染错误态/部分提示，
 * 绝不抛到宿主渲染树。
 */

import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { MemoryDto, OverviewDto, ProjectSummary, WorkspaceSummary } from '../viewer/types.js'
import { ViewerApiError, viewerApi } from './api.js'
import { humanCount, levelColor, relativeTime } from './model.js'
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
  const [wsPath, setWsPath] = useState<string>('') // 代表工作区（白名单内第一个有库的；读中央库）
  const [projectSel, setProjectSel] = useState<string>('') // 选中项目（空 = 全部）
  const [projSummaries, setProjSummaries] = useState<ProjectSummary[]>([])
  const [overview, setOverview] = useState<OverviewDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>('')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Array<{ workspace: string; workspaceTitle: string; memory: MemoryDto }>>([])
  const [tick, setTick] = useState(0)
  const bootstrapped = useRef(false)
  // 「迁移旧库」（v0.29.1）：手动把任意旧库并入中央库
  const [migrateOpen, setMigrateOpen] = useState(false)
  const [migratePath, setMigratePath] = useState('')
  const [migrating, setMigrating] = useState(false)
  const [migrateMsg, setMigrateMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const doMigrate = useCallback(async (): Promise<void> => {
    const p = migratePath.trim()
    if (p.length === 0) {
      setMigrateMsg({ kind: 'err', text: '请先填写旧库路径' })
      return
    }
    setMigrating(true)
    setMigrateMsg(null)
    try {
      const r = await viewerApi.migrateLegacy(p)
      if (r.status === 'success') {
        setMigrateMsg({
          kind: 'ok',
          text: `已并入 ${r.migrated} 条记忆${r.sessionsMoved > 0 ? ` + ${r.sessionsMoved} 个会话` : ''}${r.backup ? `；旧库备份 → ${r.backup}` : '；旧库未备份'}`,
        })
        setTick((t) => t + 1) // 迁移后立即刷新总览
      } else if (r.status === 'no-old-db') {
        setMigrateMsg({ kind: 'err', text: '未找到旧库：路径不存在，或不是 memory.db/库目录/项目根目录' })
      } else {
        setMigrateMsg({ kind: 'err', text: `旧库读取失败：${r.error ?? '未知错误'}` })
      }
    } catch (e) {
      setMigrateMsg({ kind: 'err', text: e instanceof ViewerApiError ? e.message : String(e) })
    } finally {
      setMigrating(false)
    }
  }, [migratePath])

  const loadWorkspaces = useCallback(async (): Promise<WorkspaceSummary[]> => {
    const data = await viewerApi.workspaces()
    setWorkspaces(data.workspaces)
    return data.workspaces
  }, [])

  // 首次：拉工作区列表，选定代表工作区（白名单内第一个有库的），再拉项目清单
  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    void (async () => {
      setLoading(true)
      setError('')
      try {
        const list = await loadWorkspaces()
        const rep = list.find((w) => w.hasDb)?.path ?? list[0]?.path ?? ''
        setWsPath(rep)
        if (rep.length > 0) {
          try {
            const d = await viewerApi.projects(rep)
            setProjSummaries(d.projects)
          } catch {
            /* 项目清单拿不到不影响后续 */
          }
        }
      } catch (e) {
        setError(e instanceof ViewerApiError ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [loadWorkspaces])

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
        if (projSummaries.length === 0 && wsPath.length > 0) {
          try {
            const p = await viewerApi.projects(wsPath)
            if (alive) setProjSummaries(p.projects)
          } catch {
            /* 项目清单拿不到不影响 */
          }
        }
      } catch (e) {
        if (alive) setError(e instanceof ViewerApiError ? e.message : String(e))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const openProject = useCallback((name: string) => {
    setProjectSel(name)
    setScope('workspace')
  }, [])

  const body = ((): ReactNode => {
    if (error.length > 0 && overview === null && scope === 'global') {
      return h('div', { className: 'mmv-error' }, `记忆查看器数据面不可用：${error}`)
    }
    if (scope === 'global') {
      if (query.trim().length > 0) {
        return h(SearchResults, { hits, onOpenProject: openProject })
      }
      return h(GlobalView, { overview, projSummaries, loading, onOpenProject: openProject })
    }
    if (scope === 'workspace') {
      if (wsPath === '') return h('div', { className: 'mmv-empty' }, loading ? '正在加载…' : '没有可查看的记忆库')
      return h(WorkspaceView, { workspace: wsPath, title: '中央记忆库', initialProject: projectSel })
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
            s === 'global' ? '全局' : s === 'workspace' ? '项目' : '星图',
          ),
        ),
      ),
      scope === 'workspace'
        ? h(
            'select',
            {
              className: 'mmv-input',
              style: { minWidth: 200 },
              value: projectSel,
              onChange: (e: { target: { value: string } }) => setProjectSel(e.target.value),
            },
            h('option', { key: '', value: '' }, '全部项目'),
            projSummaries.map((p) => h('option', { key: p.name, value: p.name }, p.display)),
          )
        : null,
      scope !== 'starmap'
        ? h('input', {
            className: 'mmv-input',
            placeholder: scope === 'global' ? '搜索记忆…' : '搜索该项目…',
            value: query,
            onChange: (e: { target: { value: string } }) => setQuery(e.target.value),
          })
        : null,
      h('div', { className: 'mmv-spacer' }),
      h('span', { className: 'mmv-note' }, loading ? '加载中…' : `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`),
      h('button', { className: 'mmv-btn', onClick: () => setMigrateOpen((v) => !v) }, '迁移旧库'),
      h('button', { className: 'mmv-btn', onClick: () => setTick((t) => t + 1) }, '刷新'),
      migrateOpen
        ? h(
            'div',
            { className: 'mmv-migrate' },
            h('div', { className: 'mmv-migrate-row' },
              h('input', {
                className: 'mmv-input',
                style: { minWidth: 420 },
                placeholder: '旧库路径：memory.db 文件 / 库目录 / 项目根目录（如 /path/to/proj）',
                value: migratePath,
                onChange: (e: { target: { value: string } }) => setMigratePath(e.target.value),
                onKeyDown: (e: { key: string }) => {
                  if (e.key === 'Enter') void doMigrate()
                },
              }),
              h('button', { className: 'mmv-btn', disabled: migrating, onClick: () => void doMigrate() }, migrating ? '迁移中…' : '开始迁移'),
            ),
            migrateMsg !== null
              ? h('div', { className: migrateMsg.kind === 'ok' ? 'mmv-migrate-ok' : 'mmv-migrate-err' }, migrateMsg.text)
              : h('div', { className: 'mmv-migrate-hint' }, '把旧版 .dsh-meow/memory.db（或整个项目目录）并入中央库；迁完自动备份为 .old，可随时再并。'),
          )
        : null,
    ),
    h('div', { className: 'mmv-body' }, body),
  )
}

// ── 全局视图 ────────────────────────────────────────────────────────────────

/** 全局视图（导出供测试直接渲染，不必经过面板的数据获取层）。 */
export function GlobalView({
  overview,
  projSummaries,
  loading,
  onOpenProject,
}: {
  overview: OverviewDto | null
  projSummaries: ProjectSummary[]
  loading: boolean
  onOpenProject: (project: string) => void
}): ReactNode {
  if (overview === null) return h('div', { className: 'mmv-loading' }, loading ? '正在聚合记忆…' : '暂无数据')
  const { kpi, byLevel, recent, globalEntries, health, dreamLog } = overview
  return h(
    'div',
    null,
    h(
      'div',
      { className: 'mmv-kpis' },
      h(KpiCard, { label: '项目', value: String(kpi.projects), sub: '按 project 聚合', color: '#7aa2f7' }),
      h(KpiCard, { label: '记忆总数', value: humanCount(kpi.total), sub: `本周新增 ${kpi.newThisWeek}`, color: '#9ece6a' }),
      h(KpiCard, { label: '工作区', value: String(kpi.workspaces), sub: `${kpi.withDb} 个共享中央库`, color: '#bb9af7' }),
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
        h('div', { className: 'mmv-sect' }, '项目', h('em', null, `${projSummaries.length} 个`)),
        projSummaries.length === 0
          ? h('div', { className: 'mmv-empty' }, '还没有项目记忆')
          : h(
              'div',
              { className: 'mmv-grid2' },
              projSummaries.map((p) =>
                h(ProjectCard, {
                  key: p.name,
                  p,
                  onOpen: () => onOpenProject(p.name),
                  onRename: () => {
                    const next = window.prompt('项目展示名（只改显示，记忆归属不变）：', p.display)
                    if (next === null) return
                    const name = next.trim()
                    if (name === '' || name === p.display) return
                    void (async () => {
                      try {
                        await viewerApi.renameProject(wsPath, p.name, name)
                        const d = await viewerApi.projects(wsPath)
                        setProjSummaries(d.projects)
                      } catch (e) {
                        setError(e instanceof ViewerApiError ? e.message : String(e))
                      }
                    })()
                  },
                }),
              ),
            ),
        h('div', { className: 'mmv-sect', style: { marginTop: 16 } }, '健康检查', h('em', null, '点开即刻过滤到对应条目（在项目视图里看）')),
        h(
          'div',
          { className: 'mmv-health' },
          health.map((item) =>
            h(
              'div',
              { key: item.key, className: 'h', onClick: () => onOpenProject('') },
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
        h('div', { className: 'mmv-sect' }, '最近更新'),
        recent.length === 0
          ? h('div', { className: 'mmv-empty' }, '还没有记忆')
          : recent.slice(0, 12).map((e) =>
              h(MemoryRow, { key: `${e.workspace}-${e.memory.id}`, memory: e.memory, showWorkspace: e.workspaceTitle, onClick: () => onOpenProject(e.memory.project ?? '') }),
            ),
        h('div', { className: 'mmv-sect', style: { marginTop: 14 } }, '全局条目', h('em', null, 'project = 全局')),
        globalEntries.length === 0
          ? h('div', { className: 'mmv-note' }, '暂无标记为「全局」的条目')
          : globalEntries.slice(0, 8).map((e) =>
              h(MemoryRow, { key: `${e.workspace}-${e.memory.id}`, memory: e.memory, showWorkspace: e.workspaceTitle, onClick: () => onOpenProject(e.memory.project ?? '') }),
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

function ProjectCard({ p, onOpen, onRename }: { p: ProjectSummary; onOpen: () => void; onRename: () => void }): ReactNode {
  const total = p.total
  const counts = p.counts
  return h(
    'div',
    { className: 'mmv-ws', onClick: onOpen },
    h(
      'div',
      { className: 't' },
      h('b', null, p.display),
      h('button', {
        className: 'mmv-rename',
        title: '改展示名（记忆归属不变）',
        style: { marginLeft: 8, padding: '1px 6px', borderRadius: 4, border: '1px solid #8884', background: 'transparent', cursor: 'pointer', fontSize: 12 },
        onClick: (e: { stopPropagation: () => void }) => {
          e.stopPropagation()
          onRename()
        },
      }, '✎'),
    ),
    h('div', { className: 'p' }, 'project 维度'),
    h(LevelBar, { counts }),
    h('div', { className: 'num' }, humanCount(total), h('small', null, ' 条')),
    h(
      'div',
      { className: 'mmv-mini' },
      (['project', 'fact', 'lesson', 'topic', 'rules', 'soul', 'user'] as const)
        .filter((l) => (counts[l] ?? 0) > 0)
        .map((l) =>
          h(
            'span',
            { key: l },
            h('i', { style: { background: levelColor(l) } }),
            `${l} ${counts[l]}`,
          ),
        ),
    ),
  )
}

function SearchResults({
  hits,
  onOpenProject,
}: {
  hits: Array<{ workspace: string; workspaceTitle: string; memory: MemoryDto }>
  onOpenProject: (project: string) => void
}): ReactNode {
  if (hits.length === 0) return h('div', { className: 'mmv-empty' }, '没有匹配的记忆')
  return h(
    'div',
    null,
    h('div', { className: 'mmv-sect' }, `命中 ${hits.length} 条`),
    hits.map((hit) =>
      h(MemoryRow, {
        key: `${hit.workspace}-${hit.memory.id}`,
        memory: hit.memory,
        showWorkspace: hit.workspaceTitle,
        onClick: () => onOpenProject(hit.memory.project ?? ''),
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
