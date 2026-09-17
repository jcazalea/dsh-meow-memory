/**
 * meow-memory — 会话级记忆开关（v0.28.0；v0.30.2 生效值推导）。
 *
 * 存储：工作区记忆库 session_state 表（三态：memory_enabled=1=显式启用 /
 * 0=显式禁用 / 无记录=未显式配置）。热路径（注入 / 反思 / dream / 工具）经本模块
 * 的内存缓存判断，O(1) 不落盘；TTL 10s——多实例共享同一 memory.db 是设计内场景
 * （dream.ts 注释），别实例写库后本实例缓存 10s 内自动收敛。
 *
 * 生效值优先级（用户拍板 2026-09-17）：
 *   1. 会话显式配置（session_state 有记录）→ 该值；
 *   2. 无显式配置 → 工作区是 git 项目恒启用；非 git 工作区取全局设置
 *      （Config.nonGitWorkspaceMemory，喵记忆设置页可配）。
 *
 * 归属：sessionId 全局唯一（时间前缀），且一个会话只属于一个工作区 →
 * 缓存键直接用 sessionId，workspace 只用于定位记忆库与 git 判定。
 */

import { getDb } from './db.js'
import { isGitWorkspace } from './resolve.js'

/** 缓存 TTL：跨实例写库的收敛窗口（热路径判断在此期间不落盘）。 */
const CACHE_TTL_MS = 10_000

const cache = new Map<string, { enabled: boolean; at: number }>()

/** 非 git 工作区的默认记忆开关（apply 时按 Config.nonGitWorkspaceMemory 设置）。 */
let nonGitMemory = true

/** 设置非 git 工作区记忆策略（apply 时调用；改后需 resetSessionMemoryCache 清旧推导）。 */
export function setNonGitMemoryPolicy(v: boolean): void {
  nonGitMemory = v
}

/** 当前非 git 工作区记忆策略（测试/设置页展示用）。 */
export function getNonGitMemoryPolicy(): boolean {
  return nonGitMemory
}

/** 会话记忆是否生效（含推导）。workspace 定位记忆库 + git 判定，sessionId 全局唯一。 */
export function isSessionMemoryEnabled(workspace: string, sessionId: string, dir = '.dsh-meow'): boolean {
  const hit = cache.get(sessionId)
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.enabled
  // ① 会话显式配置优先；② 无显式 → git 恒启用 / 非 git 走全局策略。
  const explicit = getDb(workspace, dir).getSessionMemoryExplicit(sessionId)
  const enabled = explicit !== undefined ? explicit : isGitWorkspace(workspace) ? true : nonGitMemory
  cache.set(sessionId, { enabled, at: Date.now() })
  return enabled
}

/** 写会话记忆开关：DB 持久化（显式三态）+ 缓存同步（写后立即可见，不等 TTL）。 */
export function setSessionMemoryEnabled(workspace: string, sessionId: string, enabled: boolean, dir = '.dsh-meow'): void {
  getDb(workspace, dir).setSessionMemoryEnabled(sessionId, enabled)
  cache.set(sessionId, { enabled, at: Date.now() })
}

/** 清空缓存（apply 时调用：热重载/重启后以 DB 为准，策略变更后清除旧推导值）。 */
export function resetSessionMemoryCache(): void {
  cache.clear()
}
