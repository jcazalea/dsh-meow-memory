/**
 * 记忆查看器 — 打包产物级挂载测试（无浏览器，纯桩）。
 *
 * 直接加载 lib/client.js（ModuleLoader 包装的 CJS），用桩 window/document/react 跑一遍
 * 插件 client 端 apply()，断言：
 *  ① 两个 slot 注册真的发生，且 **main 的 key 与 sidebar.panellist 的 id 相同**
 *     （这是「侧栏图标 ↔ 中央面板」配对的唯一契约，写错就静默不生效）；
 *  ② 注册选项形状正确（label 可求值、order 为数字）；
 *  ③ apply 返回 disposer（热重载要能注销），且不抛错。
 *
 * 用法：node tests/client-viewer-mount.mjs（先 npm run build）
 */
import { readFileSync } from 'node:fs'

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

// ── 最小 DOM / 浏览器桩 ─────────────────────────────────────────────────────
function makeElement(tag = 'div') {
  const el = {
    tagName: tag,
    className: '',
    innerHTML: '',
    textContent: '',
    value: '',
    title: '',
    dataset: {},
    style: { setProperty() {}, getPropertyValue: () => '' },
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) {
      this.children.push(c)
      return c
    },
    removeChild() {},
    remove() {},
    insertBefore(c) {
      return c
    },
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600 }),
    getContext: () => null,
    cloneNode() {
      return makeElement(tag)
    },
    replaceChildren() {},
  }
  return el
}
const body = makeElement('body')
const head = makeElement('head')
globalThis.document = {
  body,
  head,
  documentElement: makeElement('html'),
  createElement: (t) => makeElement(t),
  createTextNode: () => ({}),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
}
class MutationObserverStub {
  observe() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}
globalThis.MutationObserver = MutationObserverStub
const ResizeObserverStub = MutationObserverStub
globalThis.ResizeObserver = ResizeObserverStub
globalThis.CSS = { escape: (s) => String(s) }
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => undefined } }, configurable: true })
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: {}, meta: {} }) })
Object.defineProperty(globalThis, 'location', { value: { origin: 'http://127.0.0.1:3080', href: 'http://127.0.0.1:3080/' }, configurable: true })
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
globalThis.requestAnimationFrame = () => 0
globalThis.cancelAnimationFrame = () => {}

let factory = null
globalThis.window = {
  document: globalThis.document,
  location: globalThis.location,
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
  setInterval: () => 0,
  clearInterval() {},
  setTimeout,
  clearTimeout,
  __ModuleLoader__: {
    load({ id, factory: f }) {
      globalThis.__loadedId = id
      factory = f
    },
  },
}

// ── 加载 lib/client.js ──────────────────────────────────────────────────────
const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
new Function('window', 'document', 'navigator', 'location', 'fetch', 'MutationObserver', 'ResizeObserver', 'CSS', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', code)(
  globalThis.window,
  globalThis.document,
  globalThis.navigator,
  globalThis.location,
  globalThis.fetch,
  MutationObserverStub,
  ResizeObserverStub,
  globalThis.CSS,
  globalThis.setInterval,
  globalThis.clearInterval,
  globalThis.requestAnimationFrame,
  globalThis.cancelAnimationFrame,
)
check('ModuleLoader 注册 id = meow-memory', globalThis.__loadedId === 'meow-memory', String(globalThis.__loadedId))
check('factory 可调用', typeof factory === 'function')

// 假 react：只提供被 import 的成员（apply 阶段不会真正渲染）
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'Fragment',
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
  memo: (c) => c,
  forwardRef: (c) => c,
  createContext: () => ({ Provider: 'Provider', Consumer: 'Consumer' }),
  Component: class {},
}
const fakeRequire = (name) => {
  if (name === 'react' || name.startsWith('react/')) return reactStub
  throw new Error(`unexpected require: ${name}`)
}

const mod = factory(fakeRequire)
check('导出 apply 函数', typeof mod?.apply === 'function')
check('导出 inject 服务清单', Array.isArray(mod?.inject) && mod.inject.includes('slots'))

// ── 跑 apply（桩 ctx） ─────────────────────────────────────────────────────
const registrations = []
const injections = []
const ctx = {
  slots: {
    inject(name, cb) {
      injections.push(name)
      const d = cb()
      return typeof d === 'function' ? d : () => {}
    },
    register(options, Component) {
      registrations.push({ options, Component })
      return () => {}
    },
  },
  settingsScope: { bind: () => ({ get: () => ({}), set: () => {}, watch: () => () => {} }) },
  sessions: {},
  effect: (fn) => {
    const d = fn()
    return typeof d === 'function' ? d : () => {}
  },
  get: () => undefined,
  logger: { info() {}, warn() {}, error() {} },
}

let dispose = null
let threw = null
try {
  dispose = mod.apply(ctx)
} catch (e) {
  threw = e
}
check('apply 不抛错', threw === null, String(threw))
check('apply 返回 disposer', typeof dispose === 'function')

const main = registrations.find((r) => r.options?.name === 'main')
const pane = registrations.find((r) => r.options?.name === 'sidebar.panellist')
check('注册了 main 面板', main !== undefined)
check('注册了 sidebar.panellist 图标', pane !== undefined)
check('★ main.key 与 panellist.id 一致（配对契约）', main?.options?.key === 'meow-memory' && pane?.options?.id === 'meow-memory', JSON.stringify([main?.options, pane?.options]))
check('panellist 带可求值 label', typeof pane?.options?.label === 'function' && pane.options.label() === '记忆', String(pane?.options?.label))
check('panellist order 是数字', typeof pane?.options?.order === 'number')
check('main 绑定了组件', typeof main?.Component === 'function')
check('panellist 绑定了组件（图标）', typeof pane?.Component === 'function')
check('两个 slot 都走了 inject（响应式注入）', injections.includes('main') && injections.includes('sidebar.panellist'))
check('settings.section（既有设置页）仍注册', registrations.some((r) => r.options?.name === 'settings.section'))

// dispose 可调用
let disposeThrew = null
try {
  dispose?.()
} catch (e) {
  disposeThrew = e
}
check('dispose 不抛错', disposeThrew === null, String(disposeThrew))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
