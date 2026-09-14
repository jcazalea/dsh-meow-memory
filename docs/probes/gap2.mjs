import { DatabaseSync } from 'node:sqlite'
import { search } from '../../lib/index.js'

const db = new DatabaseSync(new URL('../../.dsh-meow/memory.db', import.meta.url).pathname, { readOnly: true })
const levels = ['soul','user','project','fact','lesson','topic','rules']
const docs = []
for (const l of levels) {
  try { for (const r of db.prepare(`select id,title,content,keywords,importance,created_at,updated_at from ${l}`).all()) docs.push({ ...r, level: l }) }
  catch {}
}
const preview = (d) => `[${d.level}] ${String(d.content).replace(/\s+/g,' ').slice(0,60)}`

// 真正的语义/同义/跨语言问句：与库中措辞零词面重叠，但语义相关
const queries = [
  '本地缓存目录只读导致装不上包怎么办',
  '怎么让插件改完立刻看到效果',
  '为什么时间戳会串到别的条目上去',
  '启动时文件没准备好服务连不上',
  '怎么把旧格式的老记忆搬进数据库',
]
for (const q of queries) {
  const hits = search(q, docs, { k: 3, now: null })
  console.log(`\nQ: ${q}`)
  if (!hits.length) { console.log('  → 0 命中（词法完全失明）'); continue }
  for (const h of hits) console.log(`  ${h.score.toFixed(4)}  ${preview(h)}`)
}
