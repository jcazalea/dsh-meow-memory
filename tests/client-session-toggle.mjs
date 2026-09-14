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
const { fetchSessionMemory, postSessionMemory, knownState, publishState } = await import(modUrl)

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

globalThis.fetch = origFetch

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
