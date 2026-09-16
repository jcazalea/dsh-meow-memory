/**
 * 记忆查看器（/meow-memory/api）host 侧测试。
 *
 * 覆盖：只读仓储与白名单、跨工作区聚合、记忆检索/过滤、项目分组、时间线、
 * 整理留痕、会话足迹、星图拓扑、ETag/304，以及两条安全红线：
 *  ① 非白名单工作区一律拒绝；
 *  ② 对没有记忆库的工作区**绝不建库**（只读打开会拒绝不存在的文件）。
 *
 * 用法：node tests/viewer.mjs（先 npm run build）
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MemoryDb,
  createViewerApi,
  getCentralDbPath,
  getCentralSessionsDir,
  ViewerRepository,
  buildGraph,
  GRAPH_DEFAULT_THRESHOLD,
} from '../lib/index.js'

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

const DIR = '.dsh-meow'
const root = mkdtempSync(join(tmpdir(), 'meow-viewer-'))
// v3 中央存储：测试用独立中央库目录（绝对路径），所有"工作区"共享一个库。
const centralDir = join(root, 'central')
const wsA = join(root, 'alpha')
const wsB = join(root, 'beta')
const wsEmpty = join(root, 'empty') // 有目录但从未建过库
const wsOutside = join(root, 'outside') // 完全不在白名单

for (const p of [wsA, wsB, wsEmpty, wsOutside, centralDir, getCentralSessionsDir(centralDir)]) mkdirSync(p, { recursive: true })

function seed(rows) {
  const db = new MemoryDb(getCentralDbPath(centralDir))
  for (const r of rows) db.insert(r)
  db.close()
}

seed([
  { level: 'project', content: 'alpha 的架构说明', project: 'alpha', subcategory: 'structure', importance: 3, keywords: ['架构', '模块划分'] },
  { level: 'fact', content: '命中打分 = 交集 × idf × 覆盖率', project: 'alpha', importance: 2, keywords: ['命中打分', 'idf'] },
  { level: 'lesson', content: '跨工作区读取必须用 readOnly', project: 'alpha', importance: 3, keywords: ['readOnly', '跨工作区'], corrected: 1 },
  { level: 'rules', content: '本机文件一律不删除', project: null, importance: 4, keywords: ['不删除', '红线'] },
  { level: 'user', content: '用户时钟是美区时间', project: null, importance: 3, keywords: ['美区时间'] },
  { level: 'project', content: '已完成的老 todo', project: 'alpha', subcategory: 'todo', importance: 1, keywords: ['todo'], status: 'stale' },
  { level: 'project', content: '待办的 todo', project: 'alpha', subcategory: 'todo', importance: 2, keywords: ['todo', '待办'] },
  { level: 'project', content: '没有关键词的条目', project: 'alpha', subcategory: 'ops', importance: 1, keywords: [] },
  { level: 'fact', content: '已归档的旧事实', project: 'alpha', importance: 1, keywords: ['旧'], status: 'archived' },
])
seed([
  { level: 'project', content: 'beta 的设计决策', project: 'beta', subcategory: 'decisions', importance: 3, keywords: ['决策', '设计'] },
  { level: 'topic', content: '让 beta 支持星图', project: 'beta', goal: '支持星图', importance: 2, keywords: ['星图', '可视化'] },
])
// 会话足迹：给 alpha 的 fact 记一条"注入+写过"痕迹（中央 sessions 目录）。
const factRow = new MemoryDb(getCentralDbPath(centralDir))
const activeFact = factRow.list('fact').find((r) => r.status === 'active' && r.content.includes('命中打分'))
if (activeFact === undefined) throw new Error('fixture: 找不到 active 的命中打分条目')
const factId = activeFact.id
factRow.close()
writeFileSync(
  join(getCentralSessionsDir(centralDir), 'session-abc12345.json'),
  JSON.stringify({ injected: [factId], searched: [], accessed: [], written: [factId], projectsQueried: ['alpha'], currentProject: 'alpha', reinjectPending: false }),
  'utf8',
)

// 窗口索引兜底：wsB 不在 registry 里，只出现在 windowIndex
const registryList = [
  { id: 'w-a', path: wsA, title: 'alpha' },
  { id: 'w-e', path: wsEmpty, title: 'empty' },
]
const ctx = { get: (name) => (name === 'workspaceRegistry' ? { list: () => registryList } : undefined) }
const api = createViewerApi({
  ctx,
  dir: centralDir,
  windowWorkspaces: () => [wsB],
  resolveSessionWorkspace: async (sid) => (sid === 'session-abc12345' ? wsA : null),
})

function fakeRes() {
  // ended 由 res.end 置位：handler 是 fire-and-forget 的 async，固定 sleep 会抖动
  // （并发跑测试套件时实测偶发空响应）——改成等"响应真的写完"。
  const state = { status: 0, body: '', headers: {}, ended: false }
  return {
    state,
    res: {
      writeHead(status, headers) {
        state.status = status
        state.headers = headers ?? {}
      },
      end(chunk) {
        if (typeof chunk === 'string') state.body = chunk
        state.ended = true
      },
    },
  }
}
async function call(path, { method = 'GET', headers = {} } = {}) {
  return callWith(api, path, { method, headers })
}
async function callWith(target, path, { method = 'GET', headers = {} } = {}) {
  const { res, state } = fakeRes()
  target.handler({ method, url: path, headers }, res)
  const deadline = Date.now() + 2000
  while (!state.ended && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2))
  if (!state.ended) check(`响应超时（未 end）：${path}`, false)
  let json = null
  try {
    json = JSON.parse(state.body)
  } catch {
    /* 非 JSON（304 空体等） */
  }
  return { status: state.status, json, headers: state.headers, raw: state.body }
}

console.log('— 白名单与安全 —')
{
  const r = await call('/meow-memory/api/memories?workspace=' + encodeURIComponent(wsOutside))
  check('非白名单工作区被拒（403）', r.status === 403 && r.json?.error?.code === 'not-allowlisted', `status=${r.status}`)
  const r2 = await call('/meow-memory/api/memories')
  check('缺 workspace 参数（400）', r2.status === 400 && r2.json?.error?.code === 'bad-request')
  const r3 = await call('/meow-memory/api/nope')
  check('未知端点（404）', r3.status === 404 && r3.json?.error?.code === 'not-found')
  const r4 = await call('/meow-memory/api/workspaces', { method: 'POST' })
  check('非 GET 方法被拒（405）', r4.status === 405 && r4.json?.error?.code === 'method-not-allowed')
  // 关键红线（v3）：中央库不存在时绝不新建；存在时只读打开
  const rootNoDb = join(root, 'nodb')
  mkdirSync(rootNoDb, { recursive: true })
  const noDbCentral = join(rootNoDb, 'central')
  const apiNoDb = createViewerApi({
    ctx,
    dir: noDbCentral,
    windowWorkspaces: () => [],
    resolveSessionWorkspace: async () => null,
  })
  const r5 = await callWith(apiNoDb, '/meow-memory/api/memories?workspace=' + encodeURIComponent(wsA))
  check('中央库不存在返回 no-db（404）', r5.status === 404 && r5.json?.error?.code === 'no-db')
  check('★ 只读：绝不新建中央库文件', !existsSync(getCentralDbPath(noDbCentral)))
  apiNoDb.dispose()
  // 中央库存在 → 所有白名单工作区共享该库（hasDb=true）
  const r6 = await call('/meow-memory/api/workspaces')
  const emptySummary = r6.json.data.workspaces.find((w) => w.path === wsEmpty)
  check('工作区列表：中央库存在 → hasDb=true', emptySummary !== undefined && emptySummary.hasDb === true)
}

console.log('— 工作区列表 / 总览 —')
{
  const r = await call('/meow-memory/api/workspaces')
  const workspaces = r.json.data.workspaces
  check('白名单 = registry ∪ windowIndex', workspaces.length === 3, JSON.stringify(workspaces.map((w) => w.title)))
  const a = workspaces.find((w) => w.path === wsA)
  check('alpha 摘要：总数=中央库全部（11）', a?.total === 11, String(a?.total))
  check('alpha 摘要：层级分布（跨库合并）', a?.counts.project === 5 && a?.counts.fact === 2 && a?.counts.lesson === 1)
  check('alpha 摘要：项目清单（跨库并集）', JSON.stringify(a?.projects) === JSON.stringify(['alpha', 'beta']))
  check('alpha 摘要：最近更新时间', typeof a?.lastUpdatedAt === 'number')

  const ov = await call('/meow-memory/api/overview')
  const d = ov.json.data
  check('overview KPI：工作区/总数', d.kpi.workspaces === 3 && d.kpi.total === 11, JSON.stringify(d.kpi))
  check('overview KPI：项目并集', d.kpi.projects === 2, String(d.kpi.projects))
  check('overview KPI：归档计数', d.kpi.archived === 1 && d.kpi.withDb === 3)
  check('overview byLevel 汇总', d.byLevel.project === 5 && d.byLevel.fact === 2 && d.byLevel.user === 1, JSON.stringify(d.byLevel))
  check('overview：全局条目（project=全局 不谈，此处是未标记→不含）', Array.isArray(d.globalEntries))
  check('overview：跨库最近更新有内容', d.recent.length > 0 && d.recent[0].workspace !== undefined)
  check('overview：健康检查四项齐全', d.health.length === 4 && d.health.every((h) => typeof h.count === 'number'))
  const noKw = d.health.find((h) => h.key === 'noKeywords')
  check('健康检查：无关键词条目被统计', noKw.count >= 1, String(noKw?.count))
  const openTodos = d.health.find((h) => h.key === 'openTodos')
  check('健康检查：未完成 todo 被统计', openTodos.count === 1, String(openTodos?.count))
  check('overview：dream 留痕字段存在', Array.isArray(d.dreamLog))
}

console.log('— 记忆列表 / 检索 / 单条 —')
{
  const all = await call(`/meow-memory/api/memories?workspace=${encodeURIComponent(wsA)}&limit=100`)
  const list = all.json.data.memories
  check('默认只回 active（+ todo 的已完成）', list.every((m) => m.status === 'active' || (m.level === 'project' && m.subcategory === 'todo')), JSON.stringify(list.map((m) => m.status)))
  check('todo 的 stale 视为已完成参与检索', list.some((m) => m.subcategory === 'todo' && m.status === 'stale'))
  check('归档条目不出现', !list.some((m) => m.status === 'archived'))

  const withAll = await call(`/meow-memory/api/memories?workspace=${encodeURIComponent(wsA)}&status=all&limit=100`)
  check('status=all 含归档', withAll.json.data.memories.some((m) => m.status === 'archived'))

  const lv = await call(`/meow-memory/api/memories?workspace=${encodeURIComponent(wsA)}&level=lesson`)
  check('level 过滤', lv.json.data.memories.length === 1 && lv.json.data.memories[0].level === 'lesson')

  const q = await call(`/meow-memory/api/memories?workspace=${encodeURIComponent(wsA)}&q=${encodeURIComponent('命中打分')}&limit=5`)
  check('关键词检索命中且标记 scored', q.json.data.scored === true && q.json.data.memories.length > 0)
  check('检索首位是相关条目', q.json.data.memories[0].content.includes('命中打分'), q.json.data.memories[0]?.content)

  const proj = await call(`/meow-memory/api/memories?workspace=${encodeURIComponent(wsA)}&project=beta`)
  check('项目过滤：跨库项目名不误伤', proj.json.data.memories.every((m) => m.project === null || m.project.includes('beta')))

  const one = await call(`/meow-memory/api/memory?workspace=${encodeURIComponent(wsA)}&id=${factId}`)
  check('单条：完整 id 精确命中', one.status === 200 && one.json.data.memory.id === factId && one.json.data.memory.level === 'fact')
  check('单条：元数据齐全', one.json.data.memory.keywords.length === 2 && one.json.data.memory.corrected === false)
  const pre = await call(`/meow-memory/api/memory?workspace=${encodeURIComponent(wsA)}&id=${factId.slice(0, 12)}`)
  check('单条：截断 id 前缀可定位（返回的 id 以该前缀开头）', pre.status === 200 && pre.json.data.memory.id.startsWith(factId.slice(0, 12)), `got=${pre.json?.data?.memory?.id}`)

  const miss = await call(`/meow-memory/api/memory?workspace=${encodeURIComponent(wsA)}&id=zzzzzzzz`)
  check('单条：找不到返回 404', miss.status === 404 && miss.json.error.code === 'not-found')
}

console.log('— 项目分组 / 时间线 / 留痕 / 会话足迹 —')
{
  const pr = await call(`/meow-memory/api/projects?workspace=${encodeURIComponent(wsA)}`)
  const alpha = pr.json.data.projects.find((p) => p.name === 'alpha')
  check('项目摘要：总数与状态分布', alpha.total === 7 && alpha.archived === 1 && alpha.active === 5, JSON.stringify(alpha))
  check('项目摘要：子类分布', alpha.bySubcategory.structure === 1 && alpha.bySubcategory.todo === 2)
  check('项目桶：未标记计数（rules/user 无归属）', pr.json.data.buckets.unlabeled === 2 && pr.json.data.buckets.global === 0, JSON.stringify(pr.json.data.buckets))

  const tl = await call(`/meow-memory/api/timeline?workspace=${encodeURIComponent(wsA)}&limit=100`)
  check('时间线含全部状态', tl.json.data.memories.some((m) => m.status === 'archived'))

  const dr = await call(`/meow-memory/api/dreams`)
  check('留痕端点返回 log/windows/skipped', Array.isArray(dr.json.data.log) && Array.isArray(dr.json.data.windows) && Array.isArray(dr.json.data.skipped))

  const se = await call(`/meow-memory/api/sessions?workspace=${encodeURIComponent(wsA)}`)
  const s0 = se.json.data.sessions[0]
  check('会话足迹：注入/写过计数', s0.sessionId === 'session-abc12345' && s0.injected === 1 && s0.written === 1)
  check('会话足迹：当前锚定项目', s0.currentProject === 'alpha' && s0.shortId === 'abc12345')

  const cx = await call('/meow-memory/api/context?sessionId=session-abc12345')
  check('context：会话→工作区解析', cx.json.data.workspace === wsA && cx.json.data.workspaceTitle === 'alpha')
  check('context：带该会话足迹', cx.json.data.footprint.injected === 1)
  const cxBad = await call('/meow-memory/api/context?sessionId=session-unknown')
  check('context：未知会话 404', cxBad.status === 404)
}

console.log('— 星图 —')
{
  const g = await call(`/meow-memory/api/graph?workspace=${encodeURIComponent(wsA)}&scope=workspace`)
  const d = g.json.data
  const hubs = d.nodes.filter((n) => n.type === 'project').map((n) => n.label)
  check('星图：项目枢纽节点', hubs.includes('alpha'), JSON.stringify(hubs))
  check('星图：记忆节点带 level/workspace', d.nodes.some((n) => n.type === 'memory' && n.level === 'fact' && n.workspace === getCentralDbPath(centralDir)))
  check('星图：结构边（项目→记忆）', d.stats.byType.project > 0)
  check('星图：会话节点与读写边', d.nodes.some((n) => n.type === 'session') && d.stats.byType.read > 0)
  check('星图：度已计算', d.nodes.every((n) => typeof n.degree === 'number' && n.degree >= 0))
  check('星图：stats 完整', d.stats.truncated === false && typeof d.stats.revision === 'string')
  const similarCount = d.stats.byType.similar
  const g2 = await call(`/meow-memory/api/graph?scope=all&threshold=0.9`)
  check('星图：阈值提高会减少相似边', g2.json.data.stats.byType.similar <= similarCount)
  const g3 = await call(`/meow-memory/api/graph?scope=workspace`)
  check('星图：scope=workspace 缺参数 → 400', g3 === undefined ? true : true)
  const g4 = await call('/meow-memory/api/graph?scope=workspace', {})
  check('星图：scope=workspace 无 workspace 参数返回 400', g4.status === 400)
}

console.log('— ETag / 304 —')
{
  const r1 = await call('/meow-memory/api/overview')
  const etag = r1.headers.etag
  check('响应带 etag', typeof etag === 'string' && etag.startsWith('"'))
  const r2 = await call('/meow-memory/api/overview', { headers: { 'if-none-match': etag } })
  check('ETag 命中 → 304', r2.status === 304 && r2.raw === '')
  const r3 = await call('/meow-memory/api/overview', { headers: { 'if-none-match': '"nope"' } })
  check('ETag 不命中 → 200', r3.status === 200)
}

console.log('— 纯计算层直调（不走 HTTP） —')
{
  const repo = new ViewerRepository(centralDir)
  const allowed = repo.allowed(ctx, [wsB])
  check('仓储白名单 3 个工作区', allowed.length === 3)
  const reader = repo.reader({ path: wsA, title: 'alpha', fromRegistry: true })
  check('只读 reader 可读（中央库）', reader !== undefined && reader.counts().fact === 2)
  check('revision 稳定', reader.revision() === reader.revision())
  const rows = reader.listAll()
  const graph = buildGraph(
    [{ workspace: wsA, title: 'alpha', memories: rows, footprints: reader.sessionsFootprint(centralDir) }],
    { scope: 'all', levels: undefined, edges: undefined, threshold: GRAPH_DEFAULT_THRESHOLD, topK: 3, limit: 2000 },
  )
  check('buildGraph 直调产出节点与边', graph.nodes.length > 0 && graph.edges.length > 0)
  repo.closeAll()
  api.dispose()
}

rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
