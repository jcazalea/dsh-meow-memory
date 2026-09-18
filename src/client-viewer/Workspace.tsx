/**
 * meow-memory 记忆查看器 — 工作区视图（项目树 + 记忆列表 + 详情抽屉 + 时间线/留痕/足迹）。
 *
 * 过滤走后端（level/status/project/q/days），保证与 memory_search 同口径、且大库下
 * 不会把整库拉到前端；本地只做展示层排序与选择态。
 */

import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { DreamsDto, MemoryDto, MemoryPatchDto, ProjectsDto, SessionsDto, ViewerLogEntry, ViewerStatus } from '../viewer/types.js'
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
  const [editing, setEditing] = useState<MemoryDto | null>(null)
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
    setEditing(null)
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

  // 展示层统一走短名（项目映射表 display）；未标记/多值兼容；未知 id 回退原值
  const displayOf = useCallback(
    (id: string | null | undefined): string => {
      if (id === null || id === undefined || id === '') return '未标记'
      return id
        .split(',')
        .map((s) => {
          const t = s.trim()
          if (t === '') return t
          const hit = (projects?.projects ?? []).find((p: { name: string; display: string }) => p.name === t)
          return hit ? hit.display : t
        })
        .join(', ')
    },
    [projects],
  )

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

  // 写操作后的通用收尾：刷新列表 + 重取详情（已删除则清空选择）+ 关编辑浮层。
  const refreshAfterWrite = useCallback(
    async (id: string): Promise<void> => {
      setEditing(null)
      await reloadList()
      try {
        const d = await viewerApi.memory(workspace, id)
        setSelected(d.memory)
      } catch {
        setSelected(null)
      }
    },
    [workspace, reloadList],
  )

  const runMutation = useCallback(
    async (op: () => Promise<unknown>, okMsg: string, id: string): Promise<void> => {
      try {
        await op()
        setError('')
        await refreshAfterWrite(id)
      } catch (e) {
        setError(e instanceof ViewerApiError ? e.message : String(e))
      }
    },
    [refreshAfterWrite],
  )

  const handleArchive = useCallback(
    (m: MemoryDto) => {
      if (!window.confirm(`归档「${m.content.slice(0, 24)}${m.content.length > 24 ? '…' : ''}」为无效记忆？\n将从默认列表消失，可在 status: archived 过滤器下找回或还原。`)) return
      void runMutation(() => viewerApi.archiveMemory(workspace, m.id), '已归档', m.id)
    },
    [workspace, runMutation],
  )

  const handleRestore = useCallback(
    (m: MemoryDto) => {
      void runMutation(() => viewerApi.restoreMemory(workspace, m.id), '已还原', m.id)
    },
    [workspace, runMutation],
  )

  const handlePurge = useCallback(
    (m: MemoryDto) => {
      if (window.prompt('物理删除将彻底移除这条记忆，不可恢复（仅留审计记录）。\n请输入「删除」二字确认：') !== '删除') return
      void runMutation(() => viewerApi.purgeMemory(workspace, m.id), '已物理删除', m.id)
    },
    [workspace, runMutation],
  )

  const handleSaveEdit = useCallback(
    async (patch: MemoryPatchDto, expectUpdatedAt: number): Promise<void> => {
      if (editing === null) return
      try {
        await viewerApi.updateMemory(workspace, editing.id, patch, expectUpdatedAt)
        setError('')
        await refreshAfterWrite(editing.id)
      } catch (e) {
        if (e instanceof ViewerApiError && e.code === 'conflict') {
          setError('该记忆刚被其他会话/模型更新，已刷新最新内容，请重新编辑。')
          await refreshAfterWrite(editing.id)
          return
        }
        throw e
      }
    },
    [workspace, editing, refreshAfterWrite],
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
          p.display,
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
      title !== undefined ? h('div', { className: 'mmv-note', style: { marginBottom: 8 } }, `项目：${project ? displayOf(project) : '全部'} · ${title}`) : null,
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
                      h('em', null, displayOf(m.project)),
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
            : h(SessionsTab, { workspace, displayOf }),
    ),
    // 右：详情
    h(
      'div',
      { className: 'mmv-pane right' },
      selected === null
        ? h('div', { className: 'mmv-empty' }, '← 选一条记忆看详情')
        : h(DetailPane, {
            memory: selected,
            similar,
            displayOf,
            onEdit: () => setEditing(selected),
            onArchive: () => handleArchive(selected),
            onRestore: () => handleRestore(selected),
            onPurge: () => handlePurge(selected),
          }),
    ),
    editing !== null
      ? h(EditModal, {
          memory: editing,
          projects,
          displayOf,
          onClose: () => setEditing(null),
          onSave: (patch) => void handleSaveEdit(patch, editing.updatedAt),
        })
      : null,
  )
}

function DetailPane({
  memory,
  similar,
  displayOf,
  onEdit,
  onArchive,
  onRestore,
  onPurge,
}: {
  memory: MemoryDto
  similar: Array<{ similarity: number; memory?: MemoryDto }>
  displayOf: (id: string | null | undefined) => string
  onEdit: () => void
  onArchive: () => void
  onRestore: () => void
  onPurge: () => void
}): ReactNode {
  const [copied, setCopied] = useState<'content' | 'id' | null>(null)
  const copyTimer = useRef<number | null>(null)
  const copy = (kind: 'content' | 'id'): void => {
    const txt = kind === 'content' ? memory.content : memory.id
    void navigator.clipboard
      ?.writeText(txt)
      .then(() => {
        setCopied(kind)
        if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
        copyTimer.current = window.setTimeout(() => setCopied(null), 1600)
      })
      .catch(() => undefined)
  }
  return h(
    'div',
    { className: 'mmv-detail' },
    h(
      'div',
      { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' } },
      h(LevelBadge, { level: memory.level, sub: memory.subcategory }),
      h('span', { className: 'mmv-note' }, displayOf(memory.project)),
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
      { className: 'mmv-sect', style: { marginTop: 14 } },
      '操作',
    ),
    h(
      'div',
      { style: { display: 'flex', gap: 8, marginTop: 2, flexWrap: 'wrap' } },
      h('button', { className: 'mmv-btn primary', onClick: onEdit }, '✎ 编辑'),
      memory.status === 'archived'
        ? h('button', { className: 'mmv-btn ok', onClick: onRestore }, '↩ 还原')
        : h('button', { className: 'mmv-btn warn', onClick: onArchive }, '无效记忆（归档）'),
      h('button', { className: 'mmv-btn danger', onClick: onPurge }, '✕ 物理删除'),
    ),
    h(
      'div',
      { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
      h('button', { className: 'mmv-btn', onClick: () => copy('content') }, copied === 'content' ? '✓ 已复制正文' : '复制正文'),
      h('button', { className: 'mmv-btn', onClick: () => copy('id') }, copied === 'id' ? '✓ 已复制 id' : '复制 id'),
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
  const [auditLog, setAuditLog] = useState<ViewerLogEntry[]>([])
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
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const d = await viewerApi.audit(workspace, 50)
        if (alive) setAuditLog(d.log)
      } catch {
        /* 老库无 viewer_log 表 → 留痕区留空即可 */
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
    h('div', { className: 'mmv-sect', style: { marginTop: 14 } }, '面板操作留痕', h('em', null, 'viewer_log')),
    auditLog.length === 0
      ? h('div', { className: 'mmv-note' }, '还没有面板写操作（修改/归档/还原/物理删除）')
      : h(
          'div',
          { className: 'mmv-tl' },
          auditLog.map((l, i) =>
            h(
              'div',
              { className: 'item', key: `${l.at}-${l.id}-${i}` },
              h('div', { className: 'when' }, relativeTime(l.at)),
              h(
                'div',
                { className: 'what' },
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 3 } },
                  h(LevelBadge, { level: l.level }),
                  h('b', { style: { fontSize: 11.5, fontWeight: 600 } }, actionLabel(l.action)),
                  h('span', { className: 'mmv-note' }, l.id.slice(0, 12)),
                ),
                h('div', { style: { fontSize: 12.5 } }, l.summary),
              ),
            ),
          ),
        ),
  )
}

function SessionsTab({ workspace, displayOf }: { workspace: string; displayOf: (id: string | null | undefined) => string }): ReactNode {
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
          `注入 ${s.injected} · 检索 ${s.searched} · 查阅 ${s.accessed} · 写过 ${s.written}${s.currentProject !== null ? ` · 锚定 ${displayOf(s.currentProject)}` : ''}`,
        ),
      ),
    ),
  )
}

/** 写操作动作的中文标签（审计展示用）。 */
function actionLabel(a: string): string {
  return a === 'update' ? '修改' : a === 'archive' ? '归档' : a === 'restore' ? '还原' : '物理删除'
}

const SUBCATEGORY_LABELS: Record<string, string> = {
  overview: '目标概述',
  structure: '项目结构',
  decisions: '技术决策',
  quotes: '用户原话',
  ops: '部署与数据',
  todo: '进行中',
}

const STATUS_OPTIONS: Array<{ v: ViewerStatus; l: string }> = [
  { v: 'active', l: 'active（生效中）' },
  { v: 'stale', l: 'stale（已完结）' },
  { v: 'archived', l: 'archived（已删除）' },
]

/**
 * 编辑记忆浮层（v0.31.0）。
 * - 字段按层门控：subcategory 仅 project 层、goal 仅 topic 层、title 有值或 topic/project 层才显示；
 * - project 只能从「未标记 / 全局 / 现有项目」里选（杜绝自由输入造成错归属）；
 * - 关键词留空 = 不修改（沿用 memory_update 语义）；409 冲突由上层捕获并刷新。
 */
function EditModal({
  memory,
  projects,
  displayOf,
  onClose,
  onSave,
}: {
  memory: MemoryDto
  projects: ProjectsDto | null
  displayOf: (id: string | null | undefined) => string
  onClose: () => void
  onSave: (patch: MemoryPatchDto) => Promise<void>
}): ReactNode {
  const [content, setContent] = useState(memory.content)
  const [importance, setImportance] = useState(Math.max(1, Math.min(5, memory.importance)))
  const [keywordsText, setKeywordsText] = useState(memory.keywords.join(', '))
  const [status, setStatus] = useState<ViewerStatus>(memory.status)
  const [projectSel, setProjectSel] = useState<string>(
    memory.project === null ? '__unlabeled__' : memory.project.trim() === '全局' ? '__global__' : memory.project,
  )
  const [subcategory, setSubcategory] = useState<string>(memory.subcategory ?? 'overview')
  const [goal, setGoal] = useState(memory.goal ?? '')
  const [title, setTitle] = useState(memory.title ?? '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const showTitle = memory.title !== null || memory.level === 'topic' || memory.level === 'project'
  const canSubmit = content.trim().length > 0 && !saving

  // ESC 关闭（保存中不响应，避免手滑丢改动）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const submit = (): void => {
    if (!canSubmit) return
    const patch: MemoryPatchDto = {}
    if (content !== memory.content) patch.content = content.trim()
    const origImportance = Math.max(1, Math.min(5, memory.importance))
    if (importance !== origImportance) patch.importance = importance
    const kw = keywordsText.split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean)
    const kwChanged = kw.length !== memory.keywords.length || kw.some((k, i) => k !== memory.keywords[i])
    if (kw.length > 0 && kwChanged) patch.keywords = kw
    if (status !== memory.status) patch.status = status
    if (projectSel === '__unlabeled__') {
      if (memory.project !== null) patch.project = null
    } else if (projectSel === '__global__') {
      if (memory.project !== '全局') patch.project = '全局'
    } else if (projectSel !== memory.project) {
      patch.project = projectSel
    }
    if (memory.level === 'project') {
      const origSub = memory.subcategory ?? 'overview'
      if (subcategory !== origSub) patch.subcategory = subcategory as MemoryPatchDto['subcategory']
    }
    if (memory.level === 'topic' && goal !== (memory.goal ?? '')) patch.goal = goal.trim()
    if (showTitle && title !== (memory.title ?? '')) patch.title = title.trim()
    setSaving(true)
    setErr('')
    void onSave(patch)
      .then(() => undefined)
      .catch((e: unknown) => {
        setErr(e instanceof Error ? e.message : String(e))
        setSaving(false)
      })
  }

  const field = (label: string, ctrl: ReactNode, full?: boolean): ReactNode =>
    h('div', { className: 'mmv-frow' + (full ? ' full' : '') }, h('label', null, label), h('div', { className: 'ctrl' }, ctrl))

  return h(
    'div',
    { className: 'mmv-overlay-fixed', onClick: (e: { target: unknown; currentTarget: unknown }) => { if (e.target === e.currentTarget && !saving) onClose() } },
    h(
      'div',
      { className: 'mmv-modal' },
      h('h3', null, `编辑记忆 · ${memory.level}${memory.subcategory ? ` / ${memory.subcategory}` : ''}`),
      field(
        '内容',
        h('textarea', { className: 'mmv-input', value: content, placeholder: '记忆正文', onChange: (e: { target: { value: string } }) => setContent(e.target.value) }),
        true,
      ),
      field(
        '重要性',
        h(
          'span',
          { style: { display: 'inline-flex', gap: 2 } },
          [1, 2, 3, 4, 5].map((n) =>
            h(
              'button',
              { key: n, type: 'button', className: 'mmv-star' + (n <= importance ? ' on' : ''), onClick: () => setImportance(n) },
              '★',
            ),
          ),
        ),
      ),
      field('关键词', h('textarea', { className: 'mmv-input mmv-kwta', value: keywordsText, placeholder: '逗号分隔；留空 = 不修改（可换行）', onChange: (e: { target: { value: string } }) => setKeywordsText(e.target.value) })),
      field(
        '状态',
        h(
          'select',
          { className: 'mmv-input', value: status, onChange: (e: { target: { value: string } }) => setStatus(e.target.value as ViewerStatus) },
          STATUS_OPTIONS.map((o) => h('option', { key: o.v, value: o.v }, o.l)),
        ),
      ),
      field(
        '项目',
        h(
          'select',
          { className: 'mmv-input', style: { width: '100%' }, value: projectSel, onChange: (e: { target: { value: string } }) => setProjectSel(e.target.value) },
          h('option', { value: '__unlabeled__' }, '未标记'),
          h('option', { value: '__global__' }, '全局'),
          (projects?.projects ?? []).map((p) => h('option', { key: p.name, value: p.name }, p.display)),
        ),
      ),
      memory.level === 'project'
        ? field(
            '子类',
            h(
              'select',
              { className: 'mmv-input', style: { width: '100%' }, value: subcategory, onChange: (e: { target: { value: string } }) => setSubcategory(e.target.value) },
              Object.entries(SUBCATEGORY_LABELS).map(([v, l]) => h('option', { key: v, value: v }, `${v}（${l}）`)),
            ),
          )
        : null,
      memory.level === 'topic' ? field('goal', h('input', { className: 'mmv-input', style: { width: '100%' }, value: goal, placeholder: '话题目标句', onChange: (e: { target: { value: string } }) => setGoal(e.target.value) })) : null,
      showTitle ? field('title', h('input', { className: 'mmv-input', style: { width: '100%' }, value: title, onChange: (e: { target: { value: string } }) => setTitle(e.target.value) })) : null,
      err.length > 0 ? h('div', { className: 'mmv-error', style: { margin: '8px 0 0' } }, err) : null,
      h(
        'div',
        { className: 'mmv-modal-foot' },
        h('button', { className: 'mmv-btn', disabled: saving, onClick: onClose }, '取消'),
        h('button', { className: 'mmv-btn primary', disabled: !canSubmit, onClick: submit }, saving ? '保存中…' : '保存'),
      ),
    ),
  )
}
