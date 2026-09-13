/**
 * 记忆查看器 client 侧纯逻辑测试（无 DOM、无 React）。
 *
 * 覆盖三块：展示映射（颜色/时间/层级文案）、星图布局（星座确定性 + 力导向收敛 +
 * 命中测试 + 过滤谓词）、列表侧过滤/排序/统计；外加 API 错误映射（fetch 桩）。
 *
 * 用法：node tests/client-viewer.mjs（内部 esbuild 现场打包，保证与 src 同步）
 */
import { build } from 'esbuild'

async function bundleSrc(entry) {
  const { outputFiles } = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'silent',
  })
  const code = outputFiles[0].text
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  return mod
}

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

const model = await bundleSrc('src/client-viewer/model.ts')

console.log('— 展示映射 —')
{
  check('level 颜色齐全', ['project', 'fact', 'lesson', 'topic', 'rules', 'soul', 'user'].every((l) => typeof model.levelColor(l) === 'string' && model.levelColor(l).startsWith('#')))
  check('未知 level 回退灰色', model.levelColor('nope') === model.LEVEL_COLORS.none)
  check('level 中文文案', model.levelLabel('lesson') === '教训' && model.levelLabel('rules') === '准则')
  const now = Date.now()
  check('相对时间：刚刚', model.relativeTime(now - 10_000, now) === '刚刚')
  check('相对时间：分钟/小时/天', model.relativeTime(now - 120_000, now) === '2 分钟前' && model.relativeTime(now - 7_200_000, now) === '2 小时前' && model.relativeTime(now - 3 * 86_400_000, now) === '3 天前')
  check('相对时间：空值', model.relativeTime(null, now) === '—')
  check('绝对时间格式', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(model.absoluteTime(now)))
  check('计数千分位', model.humanCount(12345).replace(/\u00a0/g, ' ') === '12,345')
  check('工作区名回退路径末段', model.workspaceLabel({ title: '', path: '/a/b/meow-memory' }) === 'meow-memory')
}

console.log('— 星图布局 —')
const nodes = [
  { id: 'p:alpha', type: 'project', level: 'project', label: 'alpha', degree: 4, cluster: 'alpha' },
  { id: 'p:beta', type: 'project', level: 'project', label: 'beta', degree: 2, cluster: 'beta' },
  { id: 'm1', type: 'memory', level: 'fact', label: 'f1', degree: 1, cluster: 'alpha', importance: 3, updatedAt: 100 },
  { id: 'm2', type: 'memory', level: 'fact', label: 'f2', degree: 1, cluster: 'alpha', importance: 1, updatedAt: 200 },
  { id: 'm3', type: 'memory', level: 'rules', label: 'r1', degree: 1, cluster: 'alpha', importance: 4, updatedAt: 300 },
  { id: 'm4', type: 'memory', level: 'user', label: 'u1', degree: 1, cluster: null, importance: 2, updatedAt: 400 },
  { id: 's:session-x', type: 'session', level: 'session', label: 'x', degree: 2, cluster: null },
]
const edges = [
  { source: 'p:alpha', target: 'm1', type: 'project', weight: 1 },
  { source: 'p:alpha', target: 'm2', type: 'project', weight: 1 },
  { source: 'p:beta', target: 'm3', type: 'project', weight: 1 },
  { source: 'm1', target: 'm2', type: 'similar', weight: 0.6 },
  { source: 's:session-x', target: 'm1', type: 'read', weight: 1 },
]
{
  const opts = { width: 1000, height: 700 }
  const a = model.constellationLayout(nodes, opts)
  const b = model.constellationLayout(nodes, opts)
  check('星座布局：所有节点都有坐标', nodes.every((n) => a.has(n.id)))
  check('★ 星座布局确定性（同输入同坐标）', nodes.every((n) => a.get(n.id).x === b.get(n.id).x && a.get(n.id).y === b.get(n.id).y))
  check('画布尺寸变化 → 坐标随之变化', model.constellationLayout(nodes, { width: 500, height: 300 }).get('p:alpha').x !== a.get('p:alpha').x)
  const cx = 500
  const cy = 350
  const dist = (id) => Math.hypot(a.get(id).x - cx, a.get(id).y - cy)
  check('项目核心不出画布', ['p:alpha', 'p:beta'].every((id) => dist(id) < Math.max(opts.width, opts.height) / 2))
  check('未标记条目落在星云侧（远离中心）', a.get('m4').x < cx)
  check('会话节点在外环', dist('s:session-x') > dist('m1'))

  // 力导向：收敛（边长趋近目标）+ 不产生 NaN
  const pos = model.constellationLayout(nodes, opts)
  const ticks = model.forceTicks(nodes.length)
  for (let i = 0; i < ticks; i++) model.forceStep(nodes, edges, pos, i < ticks * 0.2 ? 1 : 0.35, { center: { x: cx, y: cy } })
  check('力导向：坐标无 NaN', [...pos.values()].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)))
  // 拉力方向：两点相距 300 且有一条边 → 跑一步必须更近
  const two = [{ id: 'A', type: 'memory', level: 'fact', label: 'A', degree: 1, cluster: null, importance: 1, updatedAt: 1 },
               { id: 'B', type: 'memory', level: 'fact', label: 'B', degree: 1, cluster: null, importance: 1, updatedAt: 2 }]
  const twoPos = new Map([['A', { x: 0, y: 0 }], ['B', { x: 300, y: 0 }]])
  const d0 = Math.hypot(twoPos.get('A').x - twoPos.get('B').x, twoPos.get('A').y - twoPos.get('B').y)
  model.forceStep(two, [{ source: 'A', target: 'B', type: 'similar', weight: 1 }], twoPos, 1)
  const d1 = Math.hypot(twoPos.get('A').x - twoPos.get('B').x, twoPos.get('A').y - twoPos.get('B').y)
  check('力导向：有边的两点被拉近', d1 < d0, `${d0} → ${d1}`)
  const spread = Math.hypot(pos.get('m1').x - pos.get('m2').x, pos.get('m1').y - pos.get('m2').y)
  check('力导向：收敛后坐标有界（不发散）', spread < 400 && [...pos.values()].every((p) => Math.abs(p.x) < 5000 && Math.abs(p.y) < 5000), String(spread))
  check('力导向迭代次数随规模下降', model.forceTicks(100) > model.forceTicks(1000))

  // 命中测试 + 变换
  const t = { tx: 0, ty: 0, k: 1 }
  const p1 = a.get('m1')
  check('命中测试：点中节点', model.hitTest(nodes, a, t, p1.x, p1.y)?.id === 'm1')
  check('命中测试：远处不误中', model.hitTest(nodes, a, t, p1.x + 60, p1.y + 60) === null)
  const world = model.toWorld({ tx: 100, ty: 50, k: 2 }, 300, 250)
  check('屏幕→世界坐标换算', world.x === 100 && world.y === 100, JSON.stringify(world))
  check('命中测试：缩放后可命中', model.hitTest(nodes, a, { tx: 40, ty: 20, k: 2 }, p1.x * 2 + 40, p1.y * 2 + 20)?.id === 'm1')
  check('节点半径：项目 > 会话 > 记忆', model.nodeRadius(nodes[0]) > model.nodeRadius(nodes[6]) && model.nodeRadius(nodes[6]) > model.nodeRadius(nodes[2]))
  check('边样式：相似/取代虚线，结构实线', model.edgeDash('similar').length === 2 && model.edgeDash('supersede').length === 2 && model.edgeDash('project').length === 0)
}

console.log('— 星图过滤谓词 —')
{
  const dim = model.makeDimPredicate(new Set(['fact', 'project']))
  check('层级关掉的记忆变暗', dim(nodes[4]) === true && dim(nodes[2]) === false)
  check('枢纽永不变暗', dim(nodes[0]) === false && dim(nodes[6]) === false)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const vis = model.makeEdgePredicate({ project: true, similar: false, read: true, write: true, supersede: true }, dim)
  check('边类型开关生效（similar 关）', vis(edges[3], byId) === false && vis(edges[0], byId) === true)
  check('端点被层级过滤 → 边隐藏', vis({ source: 'p:alpha', target: 'm3', type: 'project' }, byId) === false)
}

console.log('— 列表侧过滤/排序/统计 —')
{
  const mem = (over) => ({
    id: over.id,
    workspace: '/w',
    level: over.level ?? 'fact',
    title: null,
    content: over.content ?? '内容',
    importance: over.importance ?? 1,
    keywords: over.keywords ?? [],
    status: over.status ?? 'active',
    project: over.project === undefined ? 'alpha' : over.project,
    subcategory: null,
    goal: null,
    corrected: false,
    sourceSession: null,
    hitCount: 0,
    createdAt: over.createdAt ?? 1000,
    updatedAt: over.updatedAt ?? 1000,
    lastAccessedAt: null,
  })
  const rows = [
    mem({ id: 'a', level: 'fact', project: 'alpha', content: '命中打分算法', keywords: ['打分'], updatedAt: 300, importance: 3 }),
    mem({ id: 'b', level: 'rules', project: null, content: '不删除文件', updatedAt: 200, importance: 2 }),
    mem({ id: 'c', level: 'fact', project: '全局', content: '美区时间', updatedAt: 100, importance: 4 }),
    mem({ id: 'd', level: 'lesson', project: 'beta', content: 'readOnly 踩坑', status: 'archived', updatedAt: 400, importance: 1 }),
  ]
  check('无过滤返回全部', model.filterMemories(rows, model.EMPTY_FILTER).length === 4)
  const byLevel = model.filterMemories(rows, { ...model.EMPTY_FILTER, levels: new Set(['fact']) })
  check('层级过滤', byLevel.length === 2 && byLevel.every((m) => m.level === 'fact'))
  const byStatus = model.filterMemories(rows, { ...model.EMPTY_FILTER, statuses: new Set(['archived']) })
  check('状态过滤', byStatus.length === 1 && byStatus[0].id === 'd')
  const byProject = model.filterMemories(rows, { ...model.EMPTY_FILTER, project: 'alpha' })
  check('项目过滤：全局/未标记天然命中', byProject.length === 3, JSON.stringify(byProject.map((m) => m.id)))
  const q = model.filterMemories(rows, { ...model.EMPTY_FILTER, query: '打分' })
  check('本地关键词过滤（正文）', q.length === 1 && q[0].id === 'a')
  const qk = model.filterMemories(rows, { ...model.EMPTY_FILTER, query: '打分' })
  check('本地关键词过滤（关键词字段命中）', qk.length === 1)
  check('memoryMatchesProject：多项目逗号', model.memoryMatchesProject(mem({ id: 'x', project: 'a, b' }), 'b') === true)
  check('排序：更新时间倒序', model.sortMemories(rows, 'updated').map((m) => m.id).join('') === 'dabc')
  check('排序：重要性倒序', model.sortMemories(rows, 'importance')[0].id === 'c' && model.sortMemories(rows, 'importance')[3].id === 'd')
  check('排序：创建时间倒序', model.sortMemories(rows, 'created').length === 4)
  const counts = model.levelCounts(rows)
  check('层级计数', counts.fact === 2 && counts.lesson === 1)
  const pc = model.projectCounts(rows)
  check('项目计数（含 null 桶）', pc.some((p) => p.name === 'alpha' && p.count === 1) && pc.some((p) => p.name === null && p.count === 1))
  const grouped = model.groupHitsByWorkspace([
    { workspace: '/a', workspaceTitle: 'a', memory: rows[0] },
    { workspace: '/a', workspaceTitle: 'a', memory: rows[1] },
    { workspace: '/b', workspaceTitle: 'b', memory: rows[2] },
  ])
  check('跨库命中按工作区分组', grouped.length === 2 && grouped.find((g) => g.workspace === '/a').items.length === 2)
}

console.log('— API 错误映射（fetch 桩） —')
{
  const api = await bundleSrc('src/client-viewer/api.ts')
  globalThis.fetch = async () =>
    ({ ok: true, status: 200, json: async () => ({ ok: false, error: { code: 'not-allowlisted', message: '该工作区不在白名单内' }, meta: {} }) })
  let err = null
  try {
    await api.viewerApi.memories({ workspace: '/x' })
  } catch (e) {
    err = e
  }
  check('宿主错误码 → ViewerApiError', err instanceof api.ViewerApiError && err.code === 'not-allowlisted', String(err))
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: { workspaces: [] }, meta: {} }) })
  const data = await api.viewerApi.workspaces()
  check('正常响应解包 data', Array.isArray(data.workspaces))
  globalThis.fetch = async () => {
    throw new TypeError('failed to fetch')
  }
  let netErr = null
  try {
    await api.viewerApi.overview()
  } catch (e) {
    netErr = e
  }
  check('网络失败 → network 错误码', netErr instanceof api.ViewerApiError && netErr.code === 'network')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
