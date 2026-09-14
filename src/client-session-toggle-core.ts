/**
 * meow-memory — 会话级记忆开关（v0.28.0）client 纯逻辑层。
 *
 * 与 React 壳（client-session-toggle.ts）分离：本模块零 react 依赖，
 * 可被 client 测试直接 esbuild 打包后测纯函数（仓库惯例）。
 * host DB 是唯一真源；这里只有 GET/POST 封装 + 同模块组件间的共享状态。
 */

const SESSION_MEMORY_URL = '/meow-memory/session-memory'

/** 读取当前会话记忆开关。失败（非 JSON/HTTP 非 2xx）→ null = 不可用，隐藏 UI。 */
export async function fetchSessionMemory(sessionId: string, signal?: AbortSignal): Promise<boolean | null> {
  try {
    const res = await fetch(`${SESSION_MEMORY_URL}?sessionId=${encodeURIComponent(sessionId)}`, {
      signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { ok?: boolean; enabled?: boolean }
    return body.ok === true ? (body.enabled ?? true) : null
  } catch {
    return null
  }
}

/** 写入会话记忆开关。返回是否成功（失败由调用方回滚 UI）。 */
export async function postSessionMemory(sessionId: string, enabled: boolean): Promise<boolean> {
  try {
    const res = await fetch(SESSION_MEMORY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, enabled }),
    })
    if (!res.ok) return false
    const body = (await res.json()) as { ok?: boolean }
    return body.ok === true
  } catch {
    return false
  }
}

// ── 共享状态（toggle 与提示条两组件之间同步；host DB 才是真源） ───────────────

type Listener = () => void
const listeners = new Set<Listener>()
const stateBySession = new Map<string, boolean>()

/** 取某会话已知开关状态；undefined = 尚未加载。 */
export function knownState(sessionId: string): boolean | undefined {
  return stateBySession.get(sessionId)
}

/** 写入共享状态并广播（toggle 组件写库成功后调用）。 */
export function publishState(sessionId: string, enabled: boolean): void {
  stateBySession.set(sessionId, enabled)
  for (const l of listeners) l()
}

/** 订阅状态变化，返回退订函数。 */
export function subscribeStateChange(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
