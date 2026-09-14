/**
 * meow-memory — 会话级记忆开关（v0.28.0）。
 *
 * 存储：工作区记忆库 session_state 表（无记录 = 启用，默认向后兼容；只有
 * 禁用的会话才落行）。热路径（注入 / 反思 / dream / 工具）经本模块的内存
 * 缓存判断，O(1) 不落盘；TTL 10s——多实例共享同一 memory.db 是设计内场景
 * （dream.ts 注释），别实例写库后本实例缓存 10s 内自动收敛。
 *
 * 归属：sessionId 全局唯一（时间前缀），且一个会话只属于一个工作区 →
 * 缓存键直接用 sessionId，workspace 只用于定位记忆库。
 */

import { getDb } from './db.js'

/** 缓存 TTL：跨实例写库的收敛窗口（热路径判断在此期间不落盘）。 */
const CACHE_TTL_MS = 10_000

const cache = new Map<string, { enabled: boolean; at: number }>()

/** 会话记忆是否启用（缺省 = 启用）。workspace 定位记忆库，sessionId 全局唯一。 */
export function isSessionMemoryEnabled(workspace: string, sessionId: string, dir = '.dsh-meow'): boolean {
  const hit = cache.get(sessionId)
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.enabled
  const enabled = getDb(workspace, dir).getSessionMemoryEnabled(sessionId)
  cache.set(sessionId, { enabled, at: Date.now() })
  return enabled
}

/** 写会话记忆开关：DB 持久化 + 缓存同步（写后立即可见，不等 TTL）。 */
export function setSessionMemoryEnabled(workspace: string, sessionId: string, enabled: boolean, dir = '.dsh-meow'): void {
  getDb(workspace, dir).setSessionMemoryEnabled(sessionId, enabled)
  cache.set(sessionId, { enabled, at: Date.now() })
}

/** 清空缓存（apply 时调用：热重载/重启后以 DB 为准）。 */
export function resetSessionMemoryCache(): void {
  cache.clear()
}
