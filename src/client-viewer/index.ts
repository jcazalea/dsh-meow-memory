/**
 * meow-memory 记忆查看器 — 客户端挂载。
 *
 * 两个官方 slot（都在 `@deepseek-ai/dsh-cordis-client-runner` 的 slot 契约目录里）：
 *  - `main`（keyed / root）：中央面板，key = `meow-memory`；
 *  - `sidebar.panellist`（list / root）：侧栏「全局面板」区的图标，**id 与 main 的 key
 *    同名即自动配对** —— 侧栏读 panellist 生成按钮，点击调 `ctx.layout.selectPanel(id)`，
 *    由 main 按同一 key 派发。
 *
 * 全部 fail-open：宿主没有这两个 slot（旧版本）时静默跳过，不影响既有折叠 UI 与图标。
 */

import { MemoryGlyph, MemoryViewerPanel } from './App.js'
import { ensureViewerCss } from './ui.js'

/** 面板 key / 侧栏图标 id（两者必须一致才会配对）。 */
export const VIEWER_SLOT_ID = 'meow-memory'

export function applyViewerPanel(ctx: { slots?: { inject?: (name: string, cb: () => unknown) => unknown } }): () => void {
  const disposers: Array<() => void> = []
  try {
    ensureViewerCss()
  } catch {
    /* 无 document（非浏览器环境）：跳过 */
  }
  const slots = ctx?.slots
  if (slots === undefined || typeof slots.inject !== 'function') {
    console.warn('[meow-memory] slots service unavailable; 记忆查看器面板未注册')
    return () => undefined
  }
  const register = (name: string, options: Record<string, unknown>, Component: unknown): void => {
    try {
      const dispose = slots.inject?.(name, () => (slots as unknown as { register: (o: unknown, c: unknown) => unknown }).register(options, Component))
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
    } catch (e) {
      console.warn(`[meow-memory] 记忆查看器注册 ${name} 失败（不影响其余功能）：`, e)
    }
  }
  register('main', { name: 'main', key: VIEWER_SLOT_ID }, MemoryViewerPanel)
  register('sidebar.panellist', { name: 'sidebar.panellist', id: VIEWER_SLOT_ID, order: 20, label: () => '记忆' }, MemoryGlyph)
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 清理失败不阻塞 */
      }
    }
  }
}
