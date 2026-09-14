// 词法检索语义盲区实测：用项目自己的 tokenize/BM25 打分
import { DatabaseSync } from 'node:sqlite'
const mod = await import('../../lib/index.js').catch(() => null)
// 直接内联 BM25 所需的最小逻辑（复用 lib 里的 tokenize 若可用）
let tokenize
if (mod?.tokenize) tokenize = mod.tokenize
else {
  const bm = await import('../../src/bm25.ts').catch(() => null)
  tokenize = bm?.tokenize
}
console.log('tokenize available:', !!tokenize)

const db = new DatabaseSync(new URL('../../.dsh-meow/memory.db', import.meta.url).pathname, { readOnly: true })
const levels = ['soul','user','project','fact','lesson','topic','rules']
const docs = []
for (const l of levels) {
  try {
    for (const r of db.prepare(`select id,title,content,keywords from ${l}`).all()) {
      docs.push({ level: l, ...r })
    }
  } catch {}
}
console.log('docs:', docs.length)

// 手工语义测试对：问句 vs 真正该命中的记忆
const cases = [
  ['向量检索要怎么做', '向量'],
  ['embedding 模型怎么选', 'embedding'],
  ['怎么防止重复整理记忆', 'dream'],
  ['记忆库存在哪', 'memory.db'],
]
if (tokenize) {
  for (const [q, hint] of cases) {
    const qt = new Set(tokenize(q))
    let best = null
    for (const d of docs) {
      const dt = tokenize([d.content, d.title ?? ''].join(' '))
      let overlap = 0
      for (const t of new Set(dt)) if (qt.has(t)) overlap++
      const cov = dt.length ? overlap / new Set(dt).size : 0
      if (!best || cov > best.cov) best = { cov, title: d.title, level: d.level, overlap }
    }
    console.log(`\nQ: ${q}`)
    console.log(`  top1 overlap=${best.overlap} cov=${best.cov.toFixed(3)} level=${best.level} title=${String(best.title).slice(0,50)}`)
  }
}
