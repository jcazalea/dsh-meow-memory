import { env, pipeline } from '@huggingface/transformers'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'

env.cacheDir = process.cwd() + '/.hf-cache'
env.allowLocalModels = false

const MODEL = process.env.MODEL || 'Xenova/all-MiniLM-L6-v2'
console.log('model:', MODEL)

const t0 = performance.now()
const extractor = await pipeline('feature-extraction', MODEL, { dtype: 'q8' })
console.log(`model load: ${((performance.now() - t0) / 1000).toFixed(1)} s`)

const db = new DatabaseSync(new URL('../../.dsh-meow/memory.db', import.meta.url).pathname, { readOnly: true })
const levels = ['soul','user','project','fact','lesson','topic','rules']
const docs = []
for (const l of levels) {
  try { for (const r of db.prepare(`select id,title,content,keywords from ${l}`).all()) docs.push({ ...r, level: l }) }
  catch {}
}
console.log('docs:', docs.length)

const docText = (d) => [d.title ?? '', d.content, (JSON.parse(d.keywords || '[]')).join(' ')].join('\n')

// 1) 编码吞吐
const texts = docs.map(docText)
const t1 = performance.now()
const out = await extractor(texts, { pooling: 'mean', normalize: true })
const encMs = performance.now() - t1
const dim = out.dims[out.dims.length - 1]
console.log(`encode ${texts.length} docs: ${encMs.toFixed(0)} ms (${(encMs / texts.length).toFixed(1)} ms/doc), dim=${dim}`)

const vecs = []
for (let i = 0; i < texts.length; i++) vecs.push(Float32Array.from(out.data.slice(i * dim, (i + 1) * dim)))

// 2) 单句查询编码延迟
const q = '为什么我改了代码没有生效'
const t2 = performance.now()
const qo = await extractor([q], { pooling: 'mean', normalize: true })
console.log(`encode 1 query: ${(performance.now() - t2).toFixed(1)} ms`)

// 3) 语义 vs 词法 召回对比
const { search } = await import(new URL('../../lib/index.js', import.meta.url).pathname)
const queries = [
  '为什么我改了代码没有生效',
  '本地缓存目录只读导致装不上包怎么办',
  '为什么时间戳会串到别的条目上去',
  '启动时文件没准备好服务连不上',
  '怎么把旧格式的老记忆搬进数据库',
]
const brief = (d) => `[${d.level}] ${String(d.content).replace(/\s+/g,' ').slice(0,52)}`

for (const query of queries) {
  const qv = await extractor([query], { pooling: 'mean', normalize: true })
  const qvec = Float32Array.from(qv.data.slice(0, dim))
  const scored = vecs.map((v, i) => {
    let s = 0
    for (let k = 0; k < dim; k++) s += v[k] * qvec[k]
    return { s, d: docs[i] }
  }).sort((a, b) => b.s - a.s)

  const lexDocs = docs.map((d) => {
    const kw = JSON.parse(d.keywords || '[]')
    return { id: d.id, level: d.level, title: d.title, content: kw.length ? kw.join(' ') : d.content.slice(0, 100),
             keywords: [], importance: 2, created_at: 0, updated_at: 0 }
  })
  const lex = search(query, lexDocs, { k: 1, now: null })
  const lexRow = lex.length ? docs.find((d) => d.id === lex[0].id) : null

  console.log(`\nQ: ${query}`)
  console.log(`  词法 top1: ${lexRow ? brief(lexRow) : '0 命中'}`)
  console.log(`  语义 top3:`)
  for (const h of scored.slice(0, 3)) console.log(`    ${h.s.toFixed(3)}  ${brief(h.d)}`)
}
