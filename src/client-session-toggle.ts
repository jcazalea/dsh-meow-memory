/**
 * meow-memory — 会话级记忆开关（v0.28.0，client 端 React 壳）。
 *
 * 两个 slot 条目（纯逻辑在 client-session-toggle-core.ts）：
 * - `MemoryToggleDock` → `conversation.input.right`（composer 工具行、发送按钮前）：
 *   两态拨动开关「记忆」（绿点=启用 / 灰点=禁用），点击直接切换并 POST 持久化；
 * - `MemoryDisabledNotice` → `conversation.input.dock`（composer 卡片上方，全宽）：
 *   本会话禁用时显示一行提示条。
 *
 * fail-closed：无会话 id / GET 失败（总开关关闭路由未注册、会话未解析等）→
 * 不渲染（隐藏按钮与提示条），绝不把异常抛进宿主 UI。会话解析有延迟时
 * 短重试（5 次 × 2.5s）后放弃，切换会话即重新尝试。
 */

import { createElement, useCallback, useEffect, useState } from 'react'
import {
  fetchSessionMemory,
  knownState,
  postSessionMemory,
  publishState,
  subscribeStateChange,
} from './client-session-toggle-core.ts'

// ── 拨动开关（conversation.input.right） ────────────────────────────────────

/**
 * @param useSessions - renderer standardProps 注入的官方 sessions store hook
 *   （与 DelegateVanishDock / 查看器面板同款；不可用时 fail-closed 不渲染）。
 */
export function MemoryToggleDock(props: { useSessions?: (sel: (state: unknown) => unknown) => unknown }): any {
  const current = props.useSessions?.((state: unknown) => (state as { current?: string } | undefined)?.current)
  const [enabled, setEnabled] = useState<boolean | null>(null) // null = 未加载/不可用（隐藏）
  const [busy, setBusy] = useState(false)

  // 会话变化 → 加载初始态（已知缓存直接取，否则 GET；失败短重试后放弃）。
  useEffect(() => {
    if (typeof current !== 'string' || current.length === 0) {
      setEnabled(null)
      return
    }
    const known = knownState(current)
    if (known !== undefined) {
      setEnabled(known)
      return
    }
    let cancelled = false
    let attempts = 0
    let timer = 0
    const load = (): void => {
      void fetchSessionMemory(current as string).then((v) => {
        if (cancelled) return
        if (v !== null) {
          publishState(current as string, v)
          setEnabled(v)
          return
        }
        // 不可用（路由未注册 / 会话未解析）：短重试，避免会话刚创建时按钮闪现后又消失。
        attempts++
        if (attempts < 5) timer = window.setTimeout(load, 2500)
        else setEnabled(null)
      })
    }
    load()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [current])

  // 其他入口（如 notice 组件）拉取成功后同步。
  useEffect(() => subscribeStateChange(() => {
    if (typeof current === 'string' && current.length > 0) {
      const v = knownState(current)
      if (v !== undefined) setEnabled(v)
    }
  }), [current])

  const toggle = useCallback(() => {
    if (typeof current !== 'string' || current.length === 0 || busy || enabled === null) return
    const prev = enabled
    const next = !enabled
    setBusy(true)
    setEnabled(next) // 乐观更新
    void postSessionMemory(current, next).then((ok) => {
      if (ok) publishState(current, next)
      else setEnabled(prev) // 失败回滚
      setBusy(false)
    })
  }, [current, enabled, busy])

  if (typeof current !== 'string' || current.length === 0 || enabled === null) return null

  return createElement(
    'button',
    {
      type: 'button',
      'data-meow-memory-toggle': enabled ? 'on' : 'off',
      'data-meow-memory-toggle-busy': busy ? '1' : undefined,
      title: enabled ? '记忆已启用：点击禁用本会话的记忆处理' : '记忆已禁用：点击启用本会话的记忆处理',
      onClick: toggle,
    },
    createElement('span', { 'data-meow-memory-dot': '1' }),
    '记忆',
  )
}

// ── 禁用提示条（conversation.input.dock，composer 卡片上方全宽） ─────────────

/**
 * @param session - InputZone owner props 里的 SessionSnapshot（含 sessionId）。
 */
export function MemoryDisabledNotice(props: { session?: { sessionId?: string } | null }): any {
  const sessionId = (() => {
    const s = props.session
    if (s === null || s === undefined) return undefined
    return typeof s.sessionId === 'string' && s.sessionId.length > 0 ? s.sessionId : undefined
  })()
  const [disabled, setDisabled] = useState(false)

  useEffect(() => {
    if (sessionId === undefined) {
      setDisabled(false)
      return
    }
    const known = knownState(sessionId)
    setDisabled(known === false)
    if (known === undefined) {
      let cancelled = false
      void fetchSessionMemory(sessionId).then((v) => {
        if (cancelled || v === null) return
        publishState(sessionId, v)
        setDisabled(!v)
      })
      return () => {
        cancelled = true
      }
    }
    return undefined
  }, [sessionId])

  // toggle 组件切换后即时联动。
  useEffect(() => subscribeStateChange(() => {
    if (sessionId === undefined) return
    const v = knownState(sessionId)
    if (v !== undefined) setDisabled(!v)
  }), [sessionId])

  if (sessionId === undefined || !disabled) return null

  return createElement(
    'div',
    { 'data-meow-memory-notice': '1' },
    '本会话记忆已禁用：不注入 · 不检索 · 不生成（点「记忆」可恢复）',
  )
}
