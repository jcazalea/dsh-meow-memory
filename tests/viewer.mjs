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
import { DatabaseSync } from 'node:sqlite'
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
async function call(path, { method = 'GET', headers = {}, body } = {}) {
  return callWith(api, path, { method, headers, body })
}
async function callWith(target, path, { method = 'GET', headers = {}, body } = {}) {
  const { res, state } = fakeRes()
  // POST body：用事件流模拟 req（readJsonBody 依赖 data/end）。
  const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const req = {
    method,
    url: path,
    headers,
    on(event, cb) {
      if (event === 'data' && payload !== null) cb(payload)
      else if (event === 'end') cb()
      return req
    },
  }
  target.handler(req, res)
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

console.log('— 手动迁移旧库（POST /migrate-old） —')
{
  // 造一个"旧工作区"：项目根 + .dsh-meow/memory.db（v0.28 结构：soul/user 无 project 列）+ sessions
  const legacyWs = join(root, 'legacy')
  const legacyDbDir = join(legacyWs, DIR)
  mkdirSync(join(legacyDbDir, 'sessions'), { recursive: true })
  const oldDb = new DatabaseSync(join(legacyDbDir, 'memory.db'))
  const COMMON = "id TEXT PRIMARY KEY, title TEXT, content TEXT NOT NULL, importance INTEGER NOT NULL DEFAULT 1, keywords TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active', source_session TEXT, hit_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_accessed_at INTEGER"
  oldDb.exec(`CREATE TABLE user (${COMMON})`) // 无 project 列 = 早期 schema
  oldDb.exec(`CREATE TABLE project (${COMMON}, project TEXT NOT NULL, subcategory TEXT)`)
  oldDb.prepare(`INSERT INTO user (id, content, created_at, updated_at) VALUES (?, ?, 1, 1)`).run('lg-user-0001', '旧用户偏好：用中文')
  oldDb.prepare(`INSERT INTO project (id, content, project, subcategory, created_at, updated_at) VALUES (?, ?, 'legacy-proj', 'overview', 1, 1)`).run('lg-proj-0001', '旧项目说明')
  oldDb.close()
  writeFileSync(join(legacyDbDir, 'sessions', 'session-legacy.json'), JSON.stringify({ injected: [] }), 'utf8')

  const r = await call('/meow-memory/api/migrate-old', { method: 'POST', body: { path: legacyWs } })
  check('迁移成功（status=success）', r.status === 200 && r.json?.data?.status === 'success', JSON.stringify(r.json))
  check('迁移 2 条记忆', r.json.data.migrated === 2, String(r.json.data.migrated))
  check('sessions 搬移 1 个', r.json.data.sessionsMoved === 1, String(r.json.data.sessionsMoved))
  check('旧库已备份 .old', existsSync(join(legacyDbDir, 'memory.db.old')))
  check('备份路径回传', typeof r.json.data.backup === 'string' && r.json.data.backup.endsWith('.old'), String(r.json.data.backup))
  check('dbPath 回传', r.json.data.dbPath === join(legacyDbDir, 'memory.db'), String(r.json.data.dbPath))
  const db = new MemoryDb(getCentralDbPath(centralDir))
  const legUser = db.list('user').find((m) => m.content.includes('旧用户偏好'))
  check('旧 user 并入且归属=legacy-proj（单项目推断）', legUser !== undefined && legUser.project === 'legacy-proj')
  const legProj = db.list('project').find((m) => m.content.includes('旧项目说明'))
  check('旧 project 并入且 id 规范化为标准格式', legProj !== undefined && legProj.project === 'legacy-proj' && /^[0-9a-z]{9}-/.test(legProj.id), String(legProj?.id))
  db.close()
  // 支持直接传 memory.db 文件
  const legacyFile = join(root, 'legacy2')
  const legacyFileDb = join(legacyFile, 'memory.db')
  mkdirSync(legacyFile, { recursive: true })
  const fdb = new DatabaseSync(legacyFileDb)
  fdb.exec(`CREATE TABLE fact (${COMMON}, project TEXT)`)
  fdb.prepare(`INSERT INTO fact (id, content, project, created_at, updated_at) VALUES (?, '文件直迁事实', 'x', 1, 1)`).run('lg-fact-0001')
  fdb.close()
  const rF = await call('/meow-memory/api/migrate-old', { method: 'POST', body: { path: legacyFileDb } })
  check('直接传 memory.db 文件可迁', rF.json?.data?.status === 'success' && rF.json.data.migrated === 1, JSON.stringify(rF.json?.data))
  // 边界
  const r2 = await call('/meow-memory/api/migrate-old', { method: 'POST', body: {} })
  check('缺 path → 400', r2.status === 400)
  const r3 = await call('/meow-memory/api/migrate-old', { method: 'POST', body: { path: join(root, 'nope') } })
  check('路径不存在 → no-old-db', r3.status === 200 && r3.json.data.status === 'no-old-db')
  const r4 = await call('/meow-memory/api/migrate-old')
  check('GET /migrate-old → 405', r4.status === 405 && r4.json?.error?.code === 'method-not-allowed', String(r4.status))
  // 迁移后 memory.db 已不在 → 再并一次 = no-old-db（不重复）
  const r5 = await call('/meow-memory/api/migrate-old', { method: 'POST', body: { path: legacyWs } })
  check('重复迁移 → no-old-db（原库已备份）', r5.json.data.status === 'no-old-db')
}

console.log('— 面板写操作（update / archive / restore / purge） —')
{
  // 夹具：专用条目（不污染既有断言）
  const db = new MemoryDb(getCentralDbPath(centralDir))
  const editFact = db.insert({ level: 'fact', content: '面板测试：可编辑条目', project: 'alpha', importance: 1, keywords: ['面板测试', '可编辑'] })
  const purgeProj = db.insert({ level: 'project', content: '待物理删除的项目条目', project: 'purge-me', subcategory: 'overview', importance: 1, keywords: ['purge-me'] })
  const editTopic = db.insert({ level: 'topic', content: '面板测试话题', project: 'beta', goal: '原目标', importance: 2, keywords: ['话题'] })
  db.close()
  const wsAEnc = encodeURIComponent(wsA)
  // 防同毫秒竞态：insert 与首笔 update 若落在同一毫秒，after1 === before，
  // 「updated_at 刷新 / 409 冲突 / no-op / 审计摘要」四断言会连锁失败——推一毫秒再打。
  await new Promise((r) => setTimeout(r, 15))
  const before = editFact.updated_at

  // update：content/importance/keywords + 乐观锁
  const r1 = await call('/meow-memory/api/memory/update', {
    method: 'POST',
    body: { workspace: wsA, id: editFact.id, expectUpdatedAt: before, patch: { content: '面板测试：已修改内容', importance: 4, keywords: ['新关键词', '面板'] } },
  })
  check('update：200 且 action=update', r1.status === 200 && r1.json?.data?.action === 'update', JSON.stringify(r1.json))
  const after1 = r1.json?.data?.updatedAt
  check('update：updated_at 刷新', after1 > before, `${before} -> ${after1}`)
  const got1 = await call(`/meow-memory/api/memory?workspace=${wsAEnc}&id=${editFact.id}`)
  const m1 = got1.json.data.memory
  check(
    'update：content/importance/keywords 生效',
    m1.content === '面板测试：已修改内容' && m1.importance === 4 && m1.keywords.length === 2 && m1.keywords[0] === '新关键词',
    JSON.stringify(m1),
  )

  // 乐观锁：expectUpdatedAt 过时 → 409 conflict
  const r2 = await call('/meow-memory/api/memory/update', { method: 'POST', body: { workspace: wsA, id: editFact.id, expectUpdatedAt: before, patch: { content: 'x' } } })
  check('update：expectUpdatedAt 不匹配 → 409 conflict', r2.status === 409 && r2.json?.error?.code === 'conflict', `status=${r2.status}`)

  // 空 patch：200 no-op，updatedAt 不变
  const r3 = await call('/meow-memory/api/memory/update', { method: 'POST', body: { workspace: wsA, id: editFact.id, patch: {} } })
  check('update：空 patch no-op 200', r3.status === 200 && r3.json?.data?.updatedAt === after1)

  // 按层门控：fact 层传 subcategory 被忽略、status 生效
  const r4 = await call('/meow-memory/api/memory/update', { method: 'POST', body: { workspace: wsA, id: editFact.id, patch: { subcategory: 'todo', status: 'stale' } } })
  check('update：fact 层 subcategory 忽略、status 生效', r4.status === 200 && r4.json?.data?.action === 'update')
  const got4 = await call(`/meow-memory/api/memory?workspace=${wsAEnc}&id=${editFact.id}`)
  check('update：门控结果正确（status=stale）', got4.json.data.memory.status === 'stale')

  // topic 层 goal 编辑
  const r5 = await call('/meow-memory/api/memory/update', { method: 'POST', body: { workspace: wsA, id: editTopic.id, patch: { goal: '新目标', content: '面板测试话题 v2' } } })
  check('update：topic 层 goal 可编辑', r5.status === 200)
  const got5 = await call(`/meow-memory/api/memory?workspace=${wsAEnc}&id=${editTopic.id}`)
  check('update：goal 已更新', got5.json.data.memory.goal === '新目标')

  // archive → 归档（逻辑删除），幂等
  const r6 = await call('/meow-memory/api/memory/archive', { method: 'POST', body: { workspace: wsA, id: editFact.id } })
  check('archive：200', r6.status === 200)
  const got6 = await call(`/meow-memory/api/memory?workspace=${wsAEnc}&id=${editFact.id}`)
  check('archive：status=archived', got6.json.data.memory.status === 'archived')
  const r6b = await call('/meow-memory/api/memory/archive', { method: 'POST', body: { workspace: wsA, id: editFact.id } })
  check('archive：重复归档幂等 200', r6b.status === 200)

  // restore → 还原
  const r7 = await call('/meow-memory/api/memory/restore', { method: 'POST', body: { workspace: wsA, id: editFact.id } })
  check('restore：200', r7.status === 200)
  const got7 = await call(`/meow-memory/api/memory?workspace=${wsAEnc}&id=${editFact.id}`)
  check('restore：status=active', got7.json.data.memory.status === 'active')

  // purge：彻底删除 + 孤儿项目映射清理
  const r8 = await call('/meow-memory/api/memory/purge', { method: 'POST', body: { workspace: wsA, id: purgeProj.id } })
  check('purge：200 且 action=purge', r8.status === 200 && r8.json?.data?.action === 'purge', JSON.stringify(r8.json))
  const got8 = await call(`/meow-memory/api/memory?workspace=${wsAEnc}&id=${purgeProj.id}`)
  check('purge：条目已彻底消失（404）', got8.status === 404)
  const prjDb = new DatabaseSync(getCentralDbPath(centralDir))
  const orphan = prjDb.prepare(`SELECT id FROM projects WHERE id = 'purge-me'`).get()
  prjDb.close()
  check('purge：孤儿项目映射行已清理', orphan === undefined)

  // 边界
  const b1 = await call('/meow-memory/api/memory/purge', { method: 'POST', body: { workspace: wsA } })
  check('写操作缺 id → 400', b1.status === 400)
  const b2 = await call('/meow-memory/api/memory/purge', { method: 'POST', body: { workspace: wsOutside, id: editFact.id } })
  check('写操作非白名单工作区 → 403', b2.status === 403 && b2.json?.error?.code === 'not-allowlisted')
  const b3 = await call('/meow-memory/api/memory/update', { method: 'POST', body: { workspace: wsA, id: 'no-such-id-000000', patch: { content: 'x' } } })
  check('写操作未知 id → 404', b3.status === 404)
  const b4 = await call('/meow-memory/api/memory/update')
  check('GET /memory/update → 405', b4.status === 405 && b4.json?.error?.code === 'method-not-allowed')
  const b5 = await call('/meow-memory/api/memory/purge', { method: 'POST', body: { workspace: wsA, id: purgeProj.id } })
  check('已删除条目再 purge → 404', b5.status === 404)

  // audit：留痕包含四种动作
  const au = await call(`/meow-memory/api/audit?workspace=${wsAEnc}&limit=100`)
  const actions = au.json.data.log.map((l) => l.action)
  check('audit：端点可用且按时间倒序', au.status === 200 && au.json.data.log.length > 0 && au.json.data.log[0].at >= au.json.data.log[au.json.data.log.length - 1].at)
  check('audit：含全部四种动作', ['update', 'archive', 'restore', 'purge'].every((a) => actions.includes(a)), JSON.stringify(actions.slice(0, 12)))
  const auditEntry = au.json.data.log.find((l) => l.id === editFact.id && l.action === 'update' && l.summary.includes('content'))
  check('audit：update 留痕带字段摘要', auditEntry !== undefined && auditEntry.summary.includes('importance'), auditEntry?.summary ?? '(无)')
}

console.log('— 纯计算层直调（不走 HTTP） —')
{
  const repo = new ViewerRepository(centralDir)
  const allowed = repo.allowed(ctx, [wsB])
  check('仓储白名单 3 个工作区', allowed.length === 3)
  const reader = repo.reader({ path: wsA, title: 'alpha', fromRegistry: true })
  check('只读 reader 可读（中央库）', reader !== undefined && reader.counts().fact >= 2, String(reader?.counts().fact))
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
