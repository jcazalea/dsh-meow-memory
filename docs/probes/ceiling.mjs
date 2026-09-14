import { search, findSimilar } from '../../lib/index.js'
// 词法上限测算：中文条目 vs 英文问句 / 同义改述
const zh = `profile 插件（从 profile 的 node_modules 加载的插件）改了 lib/ 不会热重载：改完必须重启 dsh web 才加载新代码。旧版备份放在 lib.bak-v0.24.1。`
const docs = [{
  id: 'x1', level: 'lesson', title: 'profile 插件不热重载',
  content: zh, keywords: ['热重载', '重启', 'profile', 'node_modules', 'lib'],
  importance: 2, created_at: Date.now(), updated_at: Date.now(),
}]
const queries = [
  'profile plugin lib change takes effect immediately?',  // 同义英译
  '为什么我改了代码没有生效',                                // 无词面重叠的中文改述
  '改了 lib 不重启会怎样',                                   // 部分重叠
]
for (const q of queries) {
  const hits = search(q, docs, { k: 3, now: null })
  console.log(`Q: ${q}\n   → ${hits.length ? 'hit score ' + hits[0].score.toFixed(3) : '0 命中'}`)
}
