/**
 * 记忆查看器上线自检（激活后跑一次即可）。
 *
 * 用法：node scripts/check-viewer.mjs [baseUrl]
 *   默认 http://127.0.0.1:3080
 *
 * 退出码：0 = 数据面已就绪；1 = 宿主仍是旧代码（需要重启 dsh web）。
 * 只读：全部是 GET，不会写任何东西。
 */

const BASE = (process.argv[2] ?? 'http://127.0.0.1:3080').replace(/\/+$/, '')

async function get(path) {
  const url = `${BASE}${path}`
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON（如旧宿主的 404 HTML） */
    }
    return { status: res.status, json, text }
  } catch (e) {
    return { status: 0, json: null, text: e instanceof Error ? e.message : String(e) }
  }
}

const ok = (s) => `\x1b[32m${s}\x1b[0m`
const bad = (s) => `\x1b[31m${s}\x1b[0m`

console.log(`记忆查看器自检 → ${BASE}\n`)

const ws = await get('/meow-memory/api/workspaces')
if (ws.status === 404) {
  console.log(bad('✗ /meow-memory/api/workspaces 返回 404'))
  console.log('  数据面不存在 = 宿主还在跑旧代码（profile 插件不热重载）。')
  console.log('  处理：重启 dsh web，然后刷新页面即可看到侧栏「记忆」图标。')
  process.exit(1)
}
if (ws.status !== 200 || ws.json?.ok !== true) {
  console.log(bad(`✗ /workspaces 异常：HTTP ${ws.status}`))
  console.log('  ' + String(ws.text).slice(0, 200))
  process.exit(1)
}

const workspaces = ws.json.data.workspaces ?? []
console.log(ok(`✓ /workspaces 正常（${workspaces.length} 个工作区，partial=${JSON.stringify(ws.json.meta?.partial ?? [])}）`))
for (const w of workspaces.slice(0, 10)) {
  console.log(`   - ${w.title}  db=${w.hasDb ? '有' : '无'}  ${w.total} 条  项目 ${w.projects?.length ?? 0}${w.error ? `  \x1b[31m读取失败：${w.error}\x1b[0m` : ''}`)
}

const ov = await get('/meow-memory/api/overview')
if (ov.json?.ok === true) {
  const k = ov.json.data.kpi
  console.log(ok(`✓ /overview 正常（工作区 ${k.workspaces} / 记忆 ${k.total} / 项目 ${k.projects} / 待整理 ${k.pendingDream}）`))
} else {
  console.log(bad(`✗ /overview 异常：HTTP ${ov.status}`))
}

const withDb = workspaces.find((w) => w.hasDb)
if (withDb !== undefined) {
  const q = encodeURIComponent(withDb.path)
  const mem = await get(`/meow-memory/api/memories?workspace=${q}&limit=3`)
  if (mem.json?.ok === true) {
    console.log(ok(`✓ /memories 正常（${withDb.title}：共 ${mem.json.data.total} 条，取回 ${mem.json.data.memories.length}）`))
    const first = mem.json.data.memories[0]
    if (first !== undefined) {
      console.log(`   - 示例：[${first.level}] ${String(first.content).slice(0, 40)}`)
      const sim = await get(`/meow-memory/api/similar?workspace=${q}&id=${encodeURIComponent(first.id)}&k=3`)
      console.log(sim.json?.ok === true ? ok(`✓ /similar 正常（${sim.json.data.similar.length} 条相关记忆）`) : bad(`✗ /similar 异常：HTTP ${sim.status}`))
    }
  } else {
    console.log(bad(`✗ /memories 异常：HTTP ${mem.status}`))
  }
}

const g = await get('/meow-memory/api/graph?scope=all&threshold=0.35&topK=3')
if (g.json?.ok === true) {
  const s = g.json.data.stats
  console.log(ok(`✓ /graph 正常（节点 ${s.nodes} / 边 ${s.edges} · 结构 ${s.byType.project} 相似 ${s.byType.similar} 会话 ${s.byType.read + s.byType.write} 取代 ${s.byType.supersede}${s.truncated ? ' · 已降采样' : ''}）`))
} else {
  console.log(bad(`✗ /graph 异常：HTTP ${g.status}`))
}

const etag = ws.json.meta?.etag
if (typeof etag === 'string') {
  const cached = await fetch(`${BASE}/meow-memory/api/workspaces`, { headers: { 'if-none-match': `"${etag}"` } })
  console.log(cached.status === 304 ? ok('✓ ETag/304 生效') : bad(`✗ ETag 未生效（HTTP ${cached.status}）`))
}

console.log('\n数据面已就绪。若侧栏还没出现「记忆」图标，刷新一次页面即可。')
