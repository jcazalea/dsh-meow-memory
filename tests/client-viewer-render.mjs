/**
 * 记忆查看器 — 组件渲染烟雾测试（无浏览器）。
 *
 * 前两个套件覆盖了纯逻辑与 slot 注册契约，但**组件从未真正渲染过一次**。
 * 这里自建一个带 hooks / effect 的迷你渲染器（useState/useEffect/useMemo/useCallback/
 * useRef/useLayoutEffect），配合桩 fetch，把三个视图与面板真的跑一遍：
 *  - 断言数据流真的进到了 DOM 树（KPI、工作区卡、记忆列表、详情抽屉、星图图例/统计）；
 *  - 断言交互回调真的连上了（切 scope、点记忆卡开详情、切星图过滤）；
 *  - 任何渲染/effect 期异常都让测试失败——这正是没有浏览器时最该抓的东西。
 *
 * 用法：node tests/client-viewer-render.mjs（内部 esbuild 现场打包 src）
 */
import { build } from 'esbuild'

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  ok  ${name}`)
  } else {
    failed++
    console.log(`FAIL  ${name} ${detail}`)
  }
}

// ── 迷你 React（hooks + effect） ────────────────────────────────────────────
let currentInst = null      // 根组件的作用域（跨轮持久）
let scopeStack = []         // 渲染期的作用域栈：嵌套函数组件各占一层
let pendingEffects = []
let dirty = false

function depsChanged(prev, next) {
  if (prev === undefined || next === undefined) return true
  if (prev.length !== next.length) return true
  for (let i = 0; i < prev.length; i++) if (prev[i] !== next[i]) return true
  return false
}
function slot(init) {
  const inst = scopeStack[scopeStack.length - 1] ?? currentInst
  const i = inst.cursor++
  if (inst.hooks.length <= i) inst.hooks[i] = { value: typeof init === 'function' ? init() : init }
  return inst.hooks[i]
}
const reactStub = {
  createElement(type, props, ...children) {
    const flat = []
    const push = (c) => {
      if (Array.isArray(c)) c.forEach(push)
      else if (c !== null && c !== undefined && c !== false && c !== true) flat.push(c)
    }
    push(children)
    return { type, props: props ?? {}, children: flat }
  },
  Fragment: 'Fragment',
  useState(init) {
    const s = slot(init)
    return [
      s.value,
      (v) => {
        s.value = typeof v === 'function' ? v(s.value) : v
        dirty = true
      },
    ]
  },
  useRef(init) {
    return slot({ current: init }).value
  },
  useMemo(fn, deps) {
    const s = slot(undefined)
    if (!s.memo || depsChanged(s.deps, deps)) {
      s.memo = { v: fn() }
      s.deps = deps
    }
    return s.memo.v
  },
  useCallback(fn, deps) {
    const s = slot(undefined)
    if (!s.memo || depsChanged(s.deps, deps)) {
      s.memo = { v: fn }
      s.deps = deps
    }
    return s.memo.v
  },
  useEffect(fn, deps) {
    const s = slot(undefined)
    if (depsChanged(s.deps, deps)) {
      s.deps = deps
      pendingEffects.push(fn)
    }
  },
  useLayoutEffect(fn, deps) {
    reactStub.useEffect(fn, deps)
  },
  memo: (c) => c,
}

/** 递归渲染：函数组件就地展开（各自一个 hook 作用域），宿主元素保留 children。 */
function renderNode(node, depth = 0, useCurrentScope = false) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (depth > 60) throw new Error('renderNode: 递归过深（组件自引用？）')
  if (typeof node.type === 'function') {
    // 根组件复用跨轮持久的实例作用域；嵌套组件各拿一个新作用域
    const scope = useCurrentScope ? currentInst : { hooks: [], cursor: 0 }
    scopeStack.push(scope)
    let out
    try {
      out = node.type(node.props)
    } finally {
      scopeStack.pop()
    }
    return renderNode(out, depth + 1)
  }
  return { ...node, children: (node.children ?? []).map((c) => renderNode(c, depth + 1)) }
}

/** 渲染一个组件：跑渲染 → 跑 effect → 等异步 → 有 setState 就再来一轮（有上限）。 */
let lastInst = null
/** reuse 传入上一次的实例即可模拟"同一组件再渲染一轮"（点击后再渲染需要它）。 */
async function renderComponent(Component, props, passes = 8, reuse = null) {
  const inst = reuse ?? { hooks: [], cursor: 0 }
  const prev = currentInst
  let tree
  for (let p = 0; p < passes; p++) {
    currentInst = inst
    scopeStack = [inst]
    inst.cursor = 0
    pendingEffects = []
    dirty = false
    tree = renderNode({ type: Component, props, children: [] }, 0, true)
    for (const fn of pendingEffects) fn()
    // 等这一轮触发的 fetch 全部落地（不靠固定 sleep——并发跑套件时不稳）
    const deadline = Date.now() + 2000
    while (inflight > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2))
    await new Promise((r) => setTimeout(r, 0))
    if (!dirty) break
  }
  currentInst = prev
  scopeStack = []
  lastInst = inst
  return tree
}

// ── 树工具 ──────────────────────────────────────────────────────────────────
function walk(node, fn) {
  if (node === null || node === undefined) return
  if (typeof node === 'string' || typeof node === 'number') return
  fn(node)
  for (const c of node.children ?? []) walk(c, fn)
}
function texts(tree) {
  const out = []
  walk(tree, (n) => {
    for (const c of n.children ?? []) if (typeof c === 'string' || typeof c === 'number') out.push(String(c))
  })
  return out
}
function allText(tree) {
  return texts(tree).join(' ')
}
function findByClass(tree, cls, tag) {
  let hit = null
  walk(tree, (n) => {
    if (hit !== null) return
    const cn = n.props?.className ?? ''
    if (typeof cn === 'string' && cn.includes(cls) && (tag === undefined || n.type === tag)) hit = n
  })
  return hit
}
function findAllByClass(tree, cls) {
  const out = []
  walk(tree, (n) => {
    const cn = n.props?.className ?? ''
    if (typeof cn === 'string' && cn.includes(cls)) out.push(n)
  })
  return out
}
function findButton(tree, label) {
  let hit = null
  walk(tree, (n) => {
    if (hit !== null || n.type !== 'button' || typeof n.props?.onClick !== 'function') return
    const own = (n.children ?? []).filter((c) => typeof c === 'string').join(' ')
    if (own.includes(label)) hit = n
  })
  return hit
}

// ── 浏览器桩 + 假数据 ───────────────────────────────────────────────────────
const WS_A = { path: '/w/alpha', title: 'alpha', id: 'w-a', hasDb: true, total: 3, counts: { soul: 0, user: 1, project: 1, fact: 1, lesson: 0, topic: 0, rules: 0 }, projects: ['alpha'], lastUpdatedAt: Date.now() - 120000, dream: { lastDreamAt: Date.now() - 3600000, lastEventAt: Date.now() - 120000, skipped: false, hasLease: false } }
const WS_B = { path: '/w/beta', title: 'beta', hasDb: false, total: 0, counts: { soul: 0, user: 0, project: 0, fact: 0, lesson: 0, topic: 0, rules: 0 }, projects: [], lastUpdatedAt: null, dream: { lastDreamAt: null, lastEventAt: null, skipped: false, hasLease: false } }
const MEM = {
  id: 'm-1-abcdefghij',
  workspace: '/w/alpha',
  level: 'fact',
  title: null,
  content: '命中打分 = 交集 × idf × 覆盖率',
  importance: 3,
  keywords: ['命中打分', 'idf'],
  status: 'active',
  project: 'alpha',
  subcategory: null,
  goal: null,
  corrected: false,
  sourceSession: 'session-abc12345',
  hitCount: 2,
  createdAt: Date.now() - 86400000,
  updatedAt: Date.now() - 60000,
  lastAccessedAt: null,
}
const OVERVIEW = {
  kpi: { workspaces: 2, withDb: 1, total: 3, newThisWeek: 3, projects: 1, stale: 0, archived: 1, pendingDream: 1 },
  byLevel: { soul: 0, user: 1, project: 1, fact: 1, lesson: 0, topic: 0, rules: 0 },
  workspaces: [WS_A, WS_B],
  recent: [{ workspace: '/w/alpha', workspaceTitle: 'alpha', memory: MEM }],
  globalEntries: [{ workspace: '/w/alpha', workspaceTitle: 'alpha', memory: { ...MEM, id: 'm-2-global', level: 'rules', content: '本机文件一律不删除' } }],
  health: [
    { key: 'noKeywords', count: 0, sample: [] },
    { key: 'staleRules', count: 1, sample: [] },
    { key: 'possibleDuplicates', count: 0, sample: [] },
    { key: 'openTodos', count: 2, sample: [] },
  ],
  dreamLog: [{ workspace: 'alpha', runAt: Date.now() - 7200000, summary: 'window dream done: abc12345 groups=3 stamped=2', note: '' }],
}

const API = {
  '/meow-memory/api/workspaces': { workspaces: [WS_A, WS_B] },
  '/meow-memory/api/context': { sessionId: 'session-abc', workspace: '/w/alpha', workspaceTitle: 'alpha', allowed: true, footprint: null },
  '/meow-memory/api/overview': OVERVIEW,
  '/meow-memory/api/projects': { workspace: '/w/alpha', projects: [{ name: 'alpha', total: 3, active: 3, stale: 0, archived: 0, counts: OVERVIEW.byLevel, lastUpdatedAt: MEM.updatedAt, bySubcategory: { overview: 0, structure: 0, decisions: 0, quotes: 0, ops: 0, todo: 0 } }], buckets: { global: 1, unlabeled: 1 } },
  '/meow-memory/api/memories': { workspace: '/w/alpha', total: 1, offset: 0, limit: 300, memories: [MEM], scored: false },
  '/meow-memory/api/similar': { id: MEM.id, similar: [{ similarity: 0.42, memory: { ...MEM, id: 'm-9-similar', content: '相关的一条记忆' } }] },
  '/meow-memory/api/dreams': { log: [{ runAt: Date.now() - 7200000, summary: 'done', note: '' }], windows: [{ sessionId: 'session-abc12345', workspace: '/w/alpha', lastEventTime: Date.now() - 120000, lastDreamTime: Date.now() - 7200000, lease: null }], skipped: [] },
  '/meow-memory/api/sessions': { sessions: [{ sessionId: 'session-abc12345', shortId: 'abc12345', injected: 2, searched: 1, accessed: 0, written: 1, projectsQueried: ['alpha'], currentProject: 'alpha', reinjectPending: false, updatedAt: Date.now() }] },
  '/meow-memory/api/timeline': { workspace: '/w/alpha', total: 1, offset: 0, limit: 300, memories: [MEM], scored: false },
  '/meow-memory/api/search': { query: 'x', hits: [{ workspace: '/w/alpha', workspaceTitle: 'alpha', memory: MEM }] },
  '/meow-memory/api/graph': {
    scope: { kind: 'workspace' },
    nodes: [
      { id: 'p:alpha', type: 'project', level: 'project', label: 'alpha', degree: 2, cluster: 'alpha' },
      { id: 'm:' + MEM.id, type: 'memory', level: 'fact', label: MEM.content, content: MEM.content, keywords: MEM.keywords, importance: 3, status: 'active', workspace: '/w/alpha', project: 'alpha', updatedAt: MEM.updatedAt, degree: 1, cluster: 'alpha' },
      { id: 's:session-abc12345', type: 'session', level: 'session', label: 'abc12345', degree: 1, cluster: null },
    ],
    edges: [
      { source: 'p:alpha', target: 'm:' + MEM.id, type: 'project', weight: 1 },
      { source: 's:session-abc12345', target: 'm:' + MEM.id, type: 'read', weight: 1 },
    ],
    stats: { nodes: 3, edges: 2, byType: { project: 1, similar: 0, read: 1, write: 0, supersede: 0 }, dropped: 0, truncated: false, revision: 'g-1' },
  },
}
let fetchCalls = []
let inflight = 0
globalThis.fetch = async (url) => {
  const path = String(url).split('?')[0]
  fetchCalls.push(path)
  inflight++
  try {
    await new Promise((r) => setTimeout(r, 0))
    const data = API[path]
    if (data === undefined) return { ok: false, status: 404, json: async () => ({ ok: false, error: { code: 'not-found', message: path }, meta: {} }) }
    return { ok: true, status: 200, json: async () => ({ ok: true, data, meta: { generatedAt: Date.now(), etag: 'e', partial: [] } }) }
  } finally {
    inflight--
  }
}
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
globalThis.requestAnimationFrame = () => 0
globalThis.cancelAnimationFrame = () => {}
globalThis.window = { devicePixelRatio: 1, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, setInterval: () => 0, clearInterval: () => {}, setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} }
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ dataset: {}, style: {}, textContent: '', appendChild() {} }),
  head: { appendChild() {} },
}

// ── 打包并注入假 react ──────────────────────────────────────────────────────
async function bundle(entry) {
  // react 走 external：esbuild 保留 import 语句，我们再把它改写成全局桩
  const { outputFiles } = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'silent',
    external: ['react', 'react/jsx-runtime'],
  })
  const code = outputFiles[0].text
  // import { a as b } from 'react' → const { a: b } = __REACT__（注意 JS 解构用冒号，不是 as）
  const patched = code.replace(/import\s*\{([^}]*)\}\s*from\s*["']react["'];?/g, (_m, spec) => {
    const parts = String(spec)
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
      .map((x) => {
        const renamed = /^(\w+)\s+as\s+(\w+)$/.exec(x)
        return renamed === null ? x : `${renamed[1]}: ${renamed[2]}`
      })
    return `const { ${parts.join(', ')} } = globalThis.__REACT__;`
  })
  return patched.replace(/import\s*\*\s*as\s+(\w+)\s*from\s*["']react["'];?/g, 'const $1 = globalThis.__REACT__;')
}
globalThis.__REACT__ = reactStub
async function load(entry) {
  const code = await bundle(entry)
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}

// react 用真实桩：把 src 里的 `import ... from 'react'` 指到我们的实现
const app = await load('src/client-viewer/App.tsx')
const wsSrc = await load('src/client-viewer/Workspace.tsx')
const starSrc = await load('src/client-viewer/StarMap.tsx')

console.log('— 全局视图 —')
{
  const tree = await renderComponent(app.GlobalView, { overview: OVERVIEW, loading: false, onOpenWorkspace: () => {}, onOpenMemory: () => {} })
  const text = allText(tree)
  check('渲染出 KPI 与数值', text.includes('工作区') && text.includes('记忆总数') && text.includes('3'))
  check('渲染出两个工作区卡', findAllByClass(tree, 'mmv-ws').length === 2)
  check('无记忆库的工作区标注', text.includes('无记忆库'))
  check('渲染出跨库最近更新', text.includes(MEM.content.slice(0, 12)))
  check('渲染出全局条目与来源', text.includes('本机文件一律不删除') && text.includes('全局条目'))
  check('渲染出健康检查四项', text.includes('无关键词条目') && text.includes('未完成 todo') && text.includes('疑似重复'))
  check('健康检查数值', text.includes('staleRules') === false && text.includes('超期未更新准则'))
  check('渲染出整理留痕', text.includes('window dream done'))
  check('空数据不炸', allText(await renderComponent(app.GlobalView, { overview: null, loading: true, onOpenWorkspace: () => {}, onOpenMemory: () => {} })).includes('正在聚合'))
}

console.log('— 面板（数据获取 + 切视图） —')
{
  fetchCalls = []
  const tree = await renderComponent(app.MemoryViewerPanel, { useSessions: () => 'session-abc' })
  const text = allText(tree)
  check('标题与三个 scope 按钮', text.includes('记忆') && findButton(tree, '全局') !== null && findButton(tree, '工作区') !== null && findButton(tree, '星图') !== null)
  check('启动即拉 workspaces + context + overview', fetchCalls.includes('/meow-memory/api/workspaces') && fetchCalls.includes('/meow-memory/api/context') && fetchCalls.includes('/meow-memory/api/overview'))
  check('默认渲染全局视图内容', text.includes('记忆总数'))

  // 切到「星图」：应触发 /graph 并渲染星图 UI
  fetchCalls = []
  const starBtn = findButton(tree, '星图')
  starBtn.props.onClick()
  const starTree = await renderComponent(app.MemoryViewerPanel, { useSessions: () => 'session-abc' }, 8, lastInst)
  check('切星图后拉 /graph', fetchCalls.includes('/meow-memory/api/graph'))
  check('切星图后渲染图例与统计', allText(starTree).includes('星座') && allText(starTree).includes('节点'))
  check('星图控件齐全（边开关 + 阈值）', allText(starTree).includes('结构边') && allText(starTree).includes('相似边') && allText(starTree).includes('阈值'))
}

console.log('— 工作区视图（列表 + 详情 + 相关记忆） —')
{
  fetchCalls = []
  const tree = await renderComponent(wsSrc.WorkspaceView, { workspace: '/w/alpha', title: 'alpha' })
  const text = allText(tree)
  check('拉取项目与记忆列表', fetchCalls.includes('/meow-memory/api/projects') && fetchCalls.includes('/meow-memory/api/memories'))
  check('渲染项目树（含全局桶）', text.includes('alpha') && text.includes('全局条目'))
  check('渲染层级过滤', text.includes('层级') && text.includes('lesson'))
  check('渲染记忆卡内容与关键词', text.includes(MEM.content) && text.includes('命中打分'))
  check('详情区初始为提示态', text.includes('选一条记忆看详情'))

  // 点第一张记忆卡 → 拉 similar 并渲染详情
  const card = findAllByClass(tree, 'mmv-mem')[0]
  check('记忆卡带 onClick', typeof card?.props?.onClick === 'function')
  fetchCalls = []
  card.props.onClick()
  const withDetail = await renderComponent(wsSrc.WorkspaceView, { workspace: '/w/alpha', title: 'alpha' }, 8, lastInst)
  check('点开详情后拉 /similar', fetchCalls.includes('/meow-memory/api/similar'))
  const dtext = allText(withDetail)
  check('详情渲染元数据行', dtext.includes('source_session') && dtext.includes('keywords') && dtext.includes('importance'))
  check('详情渲染相关记忆', dtext.includes('相关记忆'))
  check('详情带复制按钮', dtext.includes('复制正文') && dtext.includes('复制 id'))
}

console.log('— 星图视图（直接渲染） —')
{
  const tree = await renderComponent(starSrc.StarMapView, { workspaces: [WS_A], wsPath: '/w/alpha' })
  const text = allText(tree)
  check('渲染 canvas 容器', findByClass(tree, 'mmv-graph') !== null)
  check('渲染统计（节点/边）', text.includes('节点') && text.includes('边'))
  check('层级图例含七层', ['project', 'fact', 'lesson', 'topic', 'rules', 'soul', 'user'].every((l) => text.includes(l)))
  check('操作提示齐全', text.includes('hover') && text.includes('拖拽平移') && text.includes('滚轮缩放'))
  check('范围/布局切换可点', findButton(tree, '全部工作区') !== null && findButton(tree, '力导向') !== null)
  const before = fetchCalls.length
  findButton(tree, '全部工作区').props.onClick()
  await renderComponent(starSrc.StarMapView, { workspaces: [WS_A], wsPath: '/w/alpha' }, 8, lastInst)
  check('切换范围会重新拉数据', fetchCalls.length >= before)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
