/**
 * meow-memory 记忆查看器 — 工作区视图（项目树 + 记忆列表 + 详情抽屉 + 时间线/留痕/足迹）。
 *
 * 过滤走后端（level/status/project/q/days），保证与 memory_search 同口径、且大库下
 * 不会把整库拉到前端；本地只做展示层排序与选择态。
 */

import { createElement as h, useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { DreamsDto, MemoryDto, ProjectsDto, SessionsDto } from '../viewer/types.js'
import { ViewerApiError, viewerApi } from './api.js'
import { absoluteTime, humanCount, levelColor, relativeTime } from './model.js'
import { Chips, LevelBadge, MemoryRow, Stars, StatusDot, memoryMetaRows } from './ui.js'

type Tab = 'list' | 'timeline' | 'dreams' | 'sessions'
type StatusFilter = 'active' | 'all' | 'stale' | 'archived'

const LEVELS = ['project', 'fact', 'lesson', 'topic', 'rules', 'soul', 'user'] as const

export function WorkspaceView({ workspace, title, initialProject = '' }: { workspace: string; title?: string; initialProject?: string | null }): ReactNode {
  const [tab, setTab] = useState<Tab>('list')
  const [projects, setProjects] = useState<ProjectsDto | null>(null)
  const [memories, setMemories] = useState<MemoryDto[]>([])
  const [total, setTotal] = useState(0)
  const [level, setLevel] = useState<string | null>(null)
  const [project, setProject] = useState<string | null>(null)
  const [status, setStatus] = useState<StatusFilter>('active')
  const [days, setDays] = useState<number | null>(null)
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [selected, setSelected] = useState<MemoryDto | null>(null)
  const [similar, setSimilar] = useState<Array<{ similarity: number; memory?: MemoryDto }>>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // 搜索框防抖（300ms）
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQ(q), 300)
    return () => window.clearTimeout(timer)
  }, [q])

  // 切工作区/项目：重置所有过滤与选择，并应用选中项目
  useEffect(() => {
    setLevel(null)
    setProject(initialProject && initialProject.length > 0 ? initialProject : null)
    setStatus('active')
    setDays(null)
    setQ('')
    setSelected(null)
    setSimilar([])
  }, [workspace, initialProject])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const d = await viewerApi.projects(workspace)
        if (alive) setProjects(d)
      } catch (e) {
        if (alive) setError(e instanceof ViewerApiError ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [workspace])

  const reloadList = useCallback(async () => {
    setLoading(true)
    try {
      const d = await viewerApi.memories({
        workspace,
        level: level ?? undefined,
        project: project ?? undefined,
        status,
        days: days ?? undefined,
        q: debouncedQ.trim().length > 0 ? debouncedQ.trim() : undefined,
        limit: 300,
      })
      setMemories(d.memories)
      setTotal(d.total)
      setError('')
    } catch (e) {
      setError(e instanceof ViewerApiError ? e.message : String(e))
      setMemories([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [workspace, level, project, status, days, debouncedQ])

  useEffect(() => {
    if (tab !== 'list') return
    void reloadList()
  }, [tab, reloadList])

  const openDetail = useCallback(
    (m: MemoryDto) => {
      setSelected(m)
      setSimilar([])
      void (async () => {
        try {
          const d = await viewerApi.similar(workspace, m.id, 5)
          setSimilar(d.similar)
        } catch {
          /* 相关记忆拿不到不影响详情 */
        }
      })()
    },
    [workspace],
  )

  return h(
    'div',
    { className: 'mmv-wsview' },
    // 左：项目树 + 层级
    h(
      'div',
      { className: 'mmv-pane left' },
      h('div', { className: 'mmv-sect', style: { fontSize: 12.5 } }, '项目'),
      h(
        'div',
        { className: 'mmv-prow' + (project === null ? ' on' : ''), onClick: () => setProject(null) },
        '全部',
        h('b', null, projects === null ? '—' : String(projects.projects.reduce((a, p) => a + p.total, 0) + projects.buckets.unlabeled + projects.buckets.global)),
      ),
      projects?.projects.map((p) =>
        h(
          'div',
          { key: p.name, className: 'mmv-prow' + (project === p.name ? ' on' : ''), onClick: () => setProject(p.name) },
          h('span', { style: { width: 8, height: 8, borderRadius: '50%', background: '#7aa2f7', opacity: 0.85 } }),
          p.name,
          h('b', null, String(p.total)),
        ),
      ),
      projects !== null && projects.buckets.global > 0
        ? h('div', { className: 'mmv-prow' + (project === '全局' ? ' on' : ''), onClick: () => setProject('全局') }, '全局条目', h('b', null, String(projects.buckets.global)))
        : null,
      projects !== null && projects.buckets.unlabeled > 0
        ? h('div', { className: 'mmv-prow', style: { cursor: 'default', opacity: 0.7 } }, '未标记', h('b', null, String(projects.buckets.unlabeled)))
        : null,
      h('div', { className: 'mmv-sect', style: { fontSize: 12.5, marginTop: 14 } }, '层级'),
      h(
        'div',
        { className: 'mmv-prow' + (level === null ? ' on' : ''), onClick: () => setLevel(null) },
        '全部层级',
      ),
      LEVELS.map((l) =>
        h(
          'div',
          { key: l, className: 'mmv-prow' + (level === l ? ' on' : ''), onClick: () => setLevel(level === l ? null : l) },
          h('span', { style: { width: 9, height: 9, borderRadius: '50%', background: levelColor(l) } }),
          l,
        ),
      ),
      h('div', { className: 'mmv-sect', style: { fontSize: 12.5, marginTop: 14 } }, '视图'),
      (['list', 'timeline', 'dreams', 'sessions'] as Tab[]).map((t) =>
        h(
          'div',
          { key: t, className: 'mmv-prow' + (tab === t ? ' on' : ''), onClick: () => setTab(t) },
          t === 'list' ? '记忆列表' : t === 'timeline' ? '时间线' : t === 'dreams' ? '整理留痕' : '会话足迹',
        ),
      ),
    ),
    // 中：内容
    h(
      'div',
      { className: 'mmv-pane mid' },
      title !== undefined ? h('div', { className: 'mmv-note', style: { marginBottom: 8 } }, `项目：${project ?? '全部'} · ${title}`) : null,
      error.length > 0 ? h('div', { className: 'mmv-error' }, error) : null,
      tab === 'list'
        ? h(
            'div',
            null,
            h(
              'div',
              { className: 'mmv-filters' },
              h('input', {
                className: 'mmv-input',
                style: { width: 240 },
                placeholder: '搜索（关键词 + 正文，服务端 BM25）',
                value: q,
                onChange: (e: { target: { value: string } }) => setQ(e.target.value),
              }),
              (['active', 'all', 'stale', 'archived'] as StatusFilter[]).map((s) =>
                h('button', { key: s, className: 'mmv-chip' + (status === s ? ' on' : ''), onClick: () => setStatus(s) }, s === 'all' ? 'status: all' : `status: ${s}`),
              ),
              ([7, 30, 90] as const).map((d) =>
                h('button', { key: d, className: 'mmv-chip' + (days === d ? ' on' : ''), onClick: () => setDays(days === d ? null : d) }, `${d} 天内`),
              ),
              h('span', { className: 'mmv-note' }, loading ? '加载中…' : `${humanCount(total)} 条`),
            ),
            memories.length === 0
              ? h('div', { className: 'mmv-empty' }, loading ? '正在加载…' : '没有匹配的记忆')
              : memories.map((m) =>
                  h(
                    'div',
                    { key: m.id, className: 'mmv-mem' + (selected?.id === m.id ? ' sel' : ''), onClick: () => openDetail(m) },
                    h(
                      'div',
                      { className: 'top' },
                      h(LevelBadge, { level: m.level, sub: m.subcategory }),
                      h('em', null, m.project ?? '未标记'),
                      h('span', { style: { marginLeft: 'auto' } }, h(Stars, { n: m.importance })),
                      h(StatusDot, { status: m.status }),
                      h('span', { className: 'r' }, relativeTime(m.updatedAt)),
                    ),
                    h('p', null, m.content),
                    h(Chips, { items: m.keywords }),
                  ),
                ),
          )
        : tab === 'timeline'
          ? h(TimelineTab, { workspace })
          : tab === 'dreams'
            ? h(DreamsTab, { workspace })
            : h(SessionsTab, { workspace }),
    ),
    // 右：详情
    h(
      'div',
      { className: 'mmv-pane right' },
      selected === null
        ? h('div', { className: 'mmv-empty' }, '← 选一条记忆看详情')
        : h(DetailPane, { memory: selected, similar }),
    ),
  )
}

function DetailPane({
  memory,
  similar,
}: {
  memory: MemoryDto
  similar: Array<{ similarity: number; memory?: MemoryDto }>
}): ReactNode {
  return h(
    'div',
    { className: 'mmv-detail' },
    h(
      'div',
      { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' } },
      h(LevelBadge, { level: memory.level, sub: memory.subcategory }),
      h('span', { className: 'mmv-note' }, memory.project ?? '未标记'),
      h('span', { className: 'mmv-note', style: { marginLeft: 'auto' } }, memory.status),
    ),
    h('p', { className: 'body' }, memory.content),
    h(Chips, { items: memory.keywords }),
    memory.goal !== null && memory.goal !== '' ? h('div', { className: 'mmv-drow', style: { marginTop: 8 } }, h('span', null, 'goal'), h('span', null, memory.goal)) : null,
    h(
      'div',
      { style: { marginTop: 10 } },
      memoryMetaRows(memory).map(([k, v]) =>
        h('div', { className: 'mmv-drow', key: k }, h('span', null, k), h('span', null, v)),
      ),
    ),
    h(
      'div',
      { style: { display: 'flex', gap: 8, marginTop: 10 } },
      h(
        'button',
        {
          className: 'mmv-btn',
          onClick: () => {
            void navigator.clipboard?.writeText(memory.content).catch(() => undefined)
          },
        },
        '复制正文',
      ),
      h(
        'button',
        {
          className: 'mmv-btn',
          onClick: () => {
            void navigator.clipboard?.writeText(memory.id).catch(() => undefined)
          },
        },
        '复制 id',
      ),
    ),
    similar.length > 0
      ? h(
          'div',
          null,
          h('h4', null, '相关记忆（findSimilar）'),
          similar
            .filter((s) => s.memory !== undefined)
            .map((s) =>
              h(MemoryRow, {
                key: s.memory!.id,
                memory: s.memory!,
                showWorkspace: s.similarity.toFixed(2),
              }),
            ),
        )
      : null,
  )
}

function TimelineTab({ workspace }: { workspace: string }): ReactNode {
  const [rows, setRows] = useState<MemoryDto[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const d = await viewerApi.timeline(workspace, undefined)
        if (alive) setRows(d.memories)
      } catch (e) {
        if (alive) setError(e instanceof ViewerApiError ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [workspace])
  if (error.length > 0) return h('div', { className: 'mmv-error' }, error)
  if (rows.length === 0) return h('div', { className: 'mmv-empty' }, '暂无条目')
  return h(
    'div',
    { className: 'mmv-tl' },
    rows.map((m) =>
      h(
        'div',
        { className: 'item', key: m.id },
        h('div', { className: 'when' }, `${absoluteTime(m.updatedAt)}`),
        h(
          'div',
          { className: 'what' },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 3 } }, h(LevelBadge, { level: m.level }), h(StatusDot, { status: m.status })),
          h('div', { style: { fontSize: 12.5 } }, m.content),
        ),
      ),
    ),
  )
}

function DreamsTab({ workspace }: { workspace: string }): ReactNode {
  const [data, setData] = useState<DreamsDto | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const d = await viewerApi.dreams(workspace)
        if (alive) setData(d)
      } catch (e) {
        if (alive) setError(e instanceof ViewerApiError ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [workspace])
  if (error.length > 0) return h('div', { className: 'mmv-error' }, error)
  if (data === null) return h('div', { className: 'mmv-loading' }, '加载中…')
  return h(
    'div',
    null,
    h('div', { className: 'mmv-sect' }, '整理留痕', h('em', null, 'dream_log')),
    data.log.length === 0
      ? h('div', { className: 'mmv-note' }, '还没有整理记录')
      : h(
          'div',
          { className: 'mmv-tl' },
          data.log.map((l, i) =>
            h(
              'div',
              { className: 'item', key: `${l.runAt}-${i}` },
              h('div', { className: 'when' }, relativeTime(l.runAt)),
              h('div', { className: 'what' }, `${l.summary || '（无摘要）'}${l.note ? ` · ${l.note}` : ''}`),
            ),
          ),
        ),
    h('div', { className: 'mmv-sect', style: { marginTop: 14 } }, '窗口状态', h('em', null, 'windows')),
    data.windows.length === 0
      ? h('div', { className: 'mmv-note' }, '没有窗口记录')
      : data.windows.slice(0, 40).map((w) =>
          h(
            'div',
            { className: 'mmv-drow', key: w.sessionId },
            h('span', null, w.sessionId.slice(0, 12)),
            h('span', null, `最后活动 ${relativeTime(w.lastEventTime)} · 上次整理 ${relativeTime(w.lastDreamTime)}${w.lease !== null ? ' · 进行中' : ''}`),
          ),
        ),
  )
}

function SessionsTab({ workspace }: { workspace: string }): ReactNode {
  const [data, setData] = useState<SessionsDto | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const d = await viewerApi.sessions(workspace)
        if (alive) setData(d)
      } catch (e) {
        if (alive) setError(e instanceof ViewerApiError ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [workspace])
  if (error.length > 0) return h('div', { className: 'mmv-error' }, error)
  if (data === null) return h('div', { className: 'mmv-loading' }, '加载中…')
  if (data.sessions.length === 0) return h('div', { className: 'mmv-empty' }, '这个工作区还没有会话痕迹文件')
  return h(
    'div',
    null,
    h('div', { className: 'mmv-sect' }, '会话足迹', h('em', null, 'sessions/<id>.json')),
    data.sessions.map((s) =>
      h(
        'div',
        { className: 'mmv-drow', key: s.sessionId },
        h('span', null, s.shortId),
        h(
          'span',
          null,
          `注入 ${s.injected} · 检索 ${s.searched} · 查阅 ${s.accessed} · 写过 ${s.written}${s.currentProject !== null ? ` · 锚定 ${s.currentProject}` : ''}`,
        ),
      ),
    ),
  )
}
