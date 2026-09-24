/**
 * client-session-toggle 纯逻辑测试：fetchSessionMemory（GET 解析/失败语义）/
 * postSessionMemory（POST 载荷与成功判定）/ 共享状态（publish/known/subscribe）。
 * 运行：node tests/client-session-toggle.mjs（构建后；内部 esbuild 打包源码保证与 src 同步）。
 */
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: ['src/client-session-toggle-core.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
})
const code = new TextDecoder().decode(outputFiles[0].contents)
const modUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
const { fetchSessionMemory, postSessionMemory, knownState, publishState, resolveSessionId } = await import(modUrl)

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`) }
  else { failed++; console.log(`FAIL  ${name} ${detail}`) }
}

// ── fetchSessionMemory ───────────────────────────────────────────────────────
const origFetch = globalThis.fetch

globalThis.fetch = async (url, opts) => ({
  ok: true,
  json: async () => ({ ok: true, sessionId: 's-1', enabled: false }),
})
check('fetch parses disabled', await fetchSessionMemory('s-1') === false)
check('fetch url encodes sessionId', (await (async () => { let seen = ''; globalThis.fetch = async (u) => { seen = String(u); return { ok: true, json: async () => ({ ok: true, enabled: true }) } }; await fetchSessionMemory('s p&x'); return seen })()) === '/meow-memory/session-memory?sessionId=s%20p%26x')

globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: false }) })
check('fetch ok:false → null', await fetchSessionMemory('s-2') === null)

globalThis.fetch = async () => ({ ok: false, json: async () => ({}) })
check('fetch http error → null', await fetchSessionMemory('s-3') === null)

globalThis.fetch = async () => { throw new Error('network') }
check('fetch network error → null', await fetchSessionMemory('s-4') === null)

globalThis.fetch = async () => ({ ok: true, json: async () => { throw new Error('bad json') } })
check('fetch bad json → null', await fetchSessionMemory('s-5') === null)

// ── postSessionMemory ────────────────────────────────────────────────────────
let postedBody = ''
globalThis.fetch = async (_url, opts) => {
  postedBody = String(opts.body)
  return { ok: true, json: async () => ({ ok: true }) }
}
check('post sends sessionId+enabled', await postSessionMemory('s-6', false) === true && postedBody === '{"sessionId":"s-6","enabled":false}')

globalThis.fetch = async () => ({ ok: false, json: async () => ({}) })
check('post http error → false', await postSessionMemory('s-7', true) === false)

globalThis.fetch = async () => { throw new Error('network') }
check('post network error → false', await postSessionMemory('s-8', true) === false)

globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: false }) })
check('post ok:false → false', await postSessionMemory('s-9', true) === false)

// ── 共享状态 ────────────────────────────────────────────────────────────────
check('knownState empty initially', knownState('s-10') === undefined)
publishState('s-10', false)
check('publishState → knownState', knownState('s-10') === false)
publishState('s-10', true)
check('publishState overwrite', knownState('s-10') === true)

// ── resolveSessionId（v0.31.1 回归修复，v0.32.1 重新并入源码） ───────────────
// dsh 0.1.6 起 session 作用域槽注入 sessionId 标准 prop、快照移除 current：
// 只认 store.current 会让组件恒 undefined → fail-closed 静默消失（「记忆」开关
// 消失根因）。以下模拟 0.1.6 快照（无 current）+ prop 注入的两种真实形态。
check('resolve: 0.1.6 形态（无 current + prop 注入）→ prop', resolveSessionId('sess-a', undefined) === 'sess-a')
check('resolve: 0.1.6 形态（store 无 current 字段）→ prop 兜底成功', resolveSessionId('sess-b', { current: undefined }) === 'sess-b')
check('resolve: 旧宿主（无 prop + store.current）→ current', resolveSessionId(undefined, 'sess-c') === 'sess-c')
check('resolve: 双源齐备 → 优先 prop', resolveSessionId('sess-d', 'sess-d-old') === 'sess-d')
check('resolve: prop 为空串 → 回退 current', resolveSessionId('', 'sess-e') === 'sess-e')
check('resolve: prop 为空白串 → 回退 current', resolveSessionId('   ', 'sess-f') === 'sess-f')
check('resolve: prop 非字符串（对象）→ 回退 current', resolveSessionId({ sessionId: 'sess-g' }, 'sess-g') === 'sess-g')
check('resolve: prop 非字符串 + 无 current → undefined', resolveSessionId(42, undefined) === undefined)
check('resolve: 双源皆空串 → undefined', resolveSessionId('', '') === undefined)
check('resolve: 双源皆 undefined → undefined', resolveSessionId(undefined, undefined) === undefined)
check('resolve: prop 长度 0 但 current 为数字 → undefined', resolveSessionId('', 7) === undefined)

globalThis.fetch = origFetch

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
