/**
 * meow-memory 记忆查看器 — 共享 UI 片段与样式。
 *
 * 样式以 `mmv-` 前缀命名空间注入（一次，幂等）：宿主主题 token 优先，带兜底色，
 * 主题切换自动跟随。组件全是纯展示，不含数据获取逻辑。
 */

import { createElement as h } from 'react'
import type { ReactNode } from 'react'
import type { MemoryDto, ViewerLevel, ViewerStatus } from '../viewer/types.js'
import { absoluteTime, humanCount, levelColor, levelLabel, relativeTime, STATUS_LABELS } from './model.js'

export const VIEWER_CSS = `
.mmv-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:13px}
.mmv-bar{display:flex;align-items:center;gap:12px;padding:12px 20px;border-bottom:1px solid var(--dsw-alias-border-l3);flex-wrap:wrap;flex:0 0 auto}
.mmv-title{font-size:16px;font-weight:600;margin:0}
.mmv-seg{display:flex;gap:2px;background:color-mix(in srgb,currentColor 6%,transparent);border:1px solid var(--dsw-alias-border-l3);border-radius:9px;padding:3px}
.mmv-seg button{border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;padding:4px 12px;border-radius:7px;cursor:pointer}
.mmv-seg button.on{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:600}
.mmv-spacer{flex:1}
.mmv-input{height:28px;min-width:200px;background:color-mix(in srgb,currentColor 5%,transparent);border:1px solid var(--dsw-alias-border-l3);border-radius:8px;color:inherit;padding:0 10px;font:inherit;font-size:12.5px}
.mmv-input::placeholder{color:var(--dsw-alias-label-caption)}
/* 原生 select 的底色不跟随系统主题（深色模式下默认白底）——显式给主题底色 */
select.mmv-input{background:var(--dsw-alias-bg-base,#1a1b26);color:var(--dsw-alias-label-primary)}
select.mmv-input option{background:var(--dsw-alias-bg-base,#1a1b26);color:var(--dsw-alias-label-primary)}
.mmv-btn{border:1px solid var(--dsw-alias-border-l3);background:color-mix(in srgb,currentColor 4%,transparent);color:var(--dsw-alias-label-secondary);border-radius:8px;padding:4px 11px;font:inherit;font-size:12px;cursor:pointer}
.mmv-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mmv-btn.on{border-color:var(--dsw-alias-label-secondary);color:var(--dsw-alias-label-primary)}
.mmv-body{flex:1 1 auto;min-height:0;overflow:auto;padding:16px 20px 24px}
.mmv-note{font-size:11.5px;color:var(--dsw-alias-label-caption)}
.mmv-migrate{display:flex;flex-direction:column;gap:6px;flex-basis:100%;padding:8px 10px;border:1px dashed var(--dsw-alias-border-l3);border-radius:9px}
.mmv-migrate-row{display:flex;gap:8px;align-items:center}
.mmv-migrate-hint{font-size:11.5px;color:var(--dsw-alias-label-caption)}
.mmv-migrate-ok{font-size:12px;color:var(--dsw-success-500,#2da44e)}
.mmv-migrate-err{font-size:12px;color:var(--dsw-danger-500,#cf222e)}
.mmv-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:16px}
.mmv-kpi{background:color-mix(in srgb,currentColor 4%,transparent);border:1px solid var(--dsw-alias-border-l3);border-radius:10px;padding:10px 12px}
.mmv-kpi span{font-size:11.5px;color:var(--dsw-alias-label-caption)}
.mmv-kpi b{display:block;font-size:20px;margin:3px 0 1px}
.mmv-kpi i{font-style:normal;font-size:11px;color:var(--dsw-alias-label-caption)}
.mmv-cols{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
.mmv-col{min-width:0}
.mmv-sect{font-size:13px;font-weight:600;margin:0 0 8px;display:flex;align-items:center;gap:8px}
.mmv-sect em{font-style:normal;font-size:11px;color:var(--dsw-alias-label-caption);font-weight:400}
.mmv-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.mmv-ws{background:color-mix(in srgb,currentColor 4%,transparent);border:1px solid var(--dsw-alias-border-l3);border-radius:10px;padding:12px;cursor:pointer}
.mmv-ws:hover{border-color:var(--dsw-alias-label-secondary)}
.mmv-ws .t{display:flex;align-items:center;gap:8px}
.mmv-ws .t b{font-size:13px}
.mmv-ws .p{font-size:11px;color:var(--dsw-alias-label-caption);font-family:ui-monospace,monospace;margin:5px 0 7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mmv-bar7{display:flex;height:7px;border-radius:4px;overflow:hidden;background:color-mix(in srgb,currentColor 8%,transparent)}
.mmv-bar7 i{height:100%}
.mmv-ws .num{margin-top:9px;font-size:19px;font-weight:700}
.mmv-ws .num small{font-size:11px;color:var(--dsw-alias-label-caption);font-weight:400}
.mmv-ws .meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:3px}
.mmv-mini{display:flex;gap:9px;flex-wrap:wrap;margin-top:7px;font-size:10.5px;color:var(--dsw-alias-label-caption)}
.mmv-mini i{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px}
.mmv-row{background:color-mix(in srgb,currentColor 4%,transparent);border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:7px 10px;margin-bottom:7px;display:flex;gap:9px;align-items:flex-start;cursor:pointer}
.mmv-row:hover{border-color:var(--dsw-alias-label-secondary)}
.mmv-row .c{min-width:0;flex:1}
.mmv-row .c b{display:block;font-weight:400;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mmv-row .c em{font-style:normal;font-size:10.5px;color:var(--dsw-alias-label-caption)}
.mmv-badge{font:11px/17px ui-monospace,monospace;padding:0 6px;border-radius:5px;border-left:3px solid;white-space:nowrap;flex:0 0 auto}
.mmv-health{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:9px}
.mmv-health .h{display:flex;align-items:center;gap:9px;background:color-mix(in srgb,currentColor 4%,transparent);border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:6px 11px;cursor:pointer}
.mmv-health .h:hover{border-color:var(--dsw-alias-label-secondary)}
.mmv-health .h i{width:8px;height:8px;border-radius:50%}
.mmv-health .h b{margin-left:auto;font-size:12.5px}
.mmv-wsview{display:flex;gap:14px;align-items:stretch;min-height:0;height:100%}
.mmv-pane{background:color-mix(in srgb,currentColor 3%,transparent);border:1px solid var(--dsw-alias-border-l3);border-radius:10px;padding:12px;overflow:auto;min-height:0;max-height:100%}
.mmv-pane.left{width:210px;flex:0 0 210px}
.mmv-pane.mid{flex:1 1 auto;min-width:0;min-height:0;background:none;border:0;padding:0;overflow:auto}
.mmv-pane.right{width:320px;flex:0 0 320px}
.mmv-prow{display:flex;align-items:center;gap:8px;height:25px;border-radius:7px;padding:0 7px;cursor:pointer;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.mmv-prow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mmv-prow.on{background:color-mix(in srgb,currentColor 8%,transparent);color:var(--dsw-alias-label-primary);font-weight:600}
.mmv-prow b{margin-left:auto;font:11px ui-monospace,monospace;color:var(--dsw-alias-label-caption)}
.mmv-filters{display:flex;gap:7px;margin-bottom:9px;flex-wrap:wrap;align-items:center;position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-base,#16161e);padding:8px 2px 9px;border-bottom:1px solid var(--dsw-alias-border-l3);margin-left:-2px;margin-right:-2px}
.mmv-chip{border:1px solid var(--dsw-alias-border-l3);background:color-mix(in srgb,currentColor 4%,transparent);border-radius:8px;padding:4px 9px;font-size:11.5px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.mmv-chip.on{border-color:var(--dsw-alias-label-secondary);color:var(--dsw-alias-label-primary)}
.mmv-mem{background:color-mix(in srgb,currentColor 4%,transparent);border:1px solid var(--dsw-alias-border-l3);border-radius:10px;padding:10px 12px;margin-bottom:9px;cursor:pointer}
.mmv-mem:hover{border-color:var(--dsw-alias-label-secondary)}
.mmv-mem.sel{border-color:var(--dsw-alias-label-secondary)}
.mmv-mem .top{display:flex;align-items:center;gap:7px;margin-bottom:6px;flex-wrap:wrap}
.mmv-mem .top em{font-style:normal;font-size:11px;color:var(--dsw-alias-label-caption)}
.mmv-mem .top .r{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-caption)}
.mmv-mem p{margin:0;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-primary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.mmv-kw{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px}
.mmv-kw span{font-size:10.5px;background:color-mix(in srgb,currentColor 8%,transparent);color:var(--dsw-alias-label-secondary);border-radius:9px;padding:1px 7px}
.mmv-drow{display:flex;gap:8px;font-size:11.5px;padding:3px 0;border-bottom:1px dashed var(--dsw-alias-border-l3)}
.mmv-drow span:first-child{width:96px;flex:0 0 96px;color:var(--dsw-alias-label-caption);font-family:ui-monospace,monospace}
.mmv-drow span:last-child{color:var(--dsw-alias-label-secondary);word-break:break-all}
.mmv-detail p.body{margin:0 0 10px;font-size:12.5px;line-height:1.7;white-space:pre-wrap;word-break:break-word}
.mmv-detail h4{margin:12px 0 6px;font-size:12.5px}
.mmv-graph{position:relative;height:100%;min-height:360px;border:1px solid var(--dsw-alias-border-l3);border-radius:12px;overflow:hidden}
.mmv-graph canvas{display:block;width:100%;height:100%;cursor:grab}
.mmv-graph canvas.drag{cursor:grabbing}
.mmv-overlay{position:absolute;background:color-mix(in srgb,var(--dsw-alias-bg-base, #1a1b26) 88%,transparent);border:1px solid var(--dsw-alias-border-l3);border-radius:10px;padding:8px 11px;font-size:11.5px;color:var(--dsw-alias-label-secondary);backdrop-filter:blur(6px)}
.mmv-legend{left:12px;bottom:12px}
.mmv-legend div{display:flex;align-items:center;gap:6px;margin-bottom:3px}
.mmv-legend i{width:8px;height:8px;border-radius:50%}
.mmv-stats{left:12px;top:12px;font-family:ui-monospace,monospace;display:flex;gap:14px;color:var(--dsw-alias-label-caption)}
.mmv-info{right:12px;top:12px;width:290px}
.mmv-info h5{margin:0 0 6px;font-size:12.5px;display:flex;gap:7px;align-items:center;flex-wrap:wrap}
.mmv-info p{margin:0 0 6px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary)}
.mmv-hint{right:12px;bottom:12px;color:var(--dsw-alias-label-caption);font-size:11px}
.mmv-empty{padding:40px 0;text-align:center;color:var(--dsw-alias-label-caption);font-size:12.5px}
.mmv-error{margin:14px 0;padding:10px 12px;border:1px solid var(--dsw-alias-fill-danger, #f7768e);border-radius:9px;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.mmv-loading{color:var(--dsw-alias-label-caption);font-size:12px;padding:10px 0}
.mmv-tl{display:flex;flex-direction:column;gap:0}
.mmv-tl .item{display:flex;gap:10px;padding:7px 0;border-bottom:1px dashed var(--dsw-alias-border-l3)}
.mmv-tl .when{width:130px;flex:0 0 130px;color:var(--dsw-alias-label-caption);font-size:11.5px;font-family:ui-monospace,monospace}
.mmv-tl .what{min-width:0;flex:1}
.mmv-btn.primary{border-color:var(--dsw-alias-fill-accent,#7aa2f7);background:var(--dsw-alias-fill-accent,#7aa2f7);color:#16161e;font-weight:600}
.mmv-btn.primary:hover{background:#8fb0ff;border-color:#8fb0ff;color:#16161e}
.mmv-btn.warn{border-color:var(--dsw-alias-fill-warn,#e0af68);background:rgba(224,175,104,.13);color:var(--dsw-alias-fill-warn,#e0af68);font-weight:600}
.mmv-btn.warn:hover{background:rgba(224,175,104,.24);color:var(--dsw-alias-fill-warn,#e0af68)}
.mmv-btn.ok{border-color:var(--dsw-alias-fill-ok,#9ece6a);background:rgba(158,206,106,.13);color:var(--dsw-alias-fill-ok,#9ece6a);font-weight:600}
.mmv-btn.ok:hover{background:rgba(158,206,106,.24);color:var(--dsw-alias-fill-ok,#9ece6a)}
.mmv-btn.danger{border-color:var(--dsw-alias-fill-danger,#f7768e);background:rgba(247,118,142,.1);color:var(--dsw-alias-fill-danger,#f7768e);font-weight:600}
.mmv-btn.danger:hover{background:rgba(247,118,142,.22);color:var(--dsw-alias-fill-danger,#f7768e)}
.mmv-btn:disabled{opacity:.5;cursor:default}
.mmv-overlay-fixed{position:fixed;inset:0;background:rgba(10,10,16,.5);display:flex;align-items:center;justify-content:center;z-index:999}
.mmv-modal{width:540px;max-width:94vw;max-height:88vh;overflow:auto;background:var(--dsw-alias-bg-base,#1a1b26);border:1px solid var(--dsw-alias-border-l3);border-radius:12px;padding:16px 18px;box-shadow:0 12px 40px rgba(0,0,0,.4)}
.mmv-modal h3{margin:0 0 12px;font-size:14px}
.mmv-frow{display:flex;gap:8px;align-items:flex-start;margin-bottom:10px}
.mmv-frow>label{width:84px;flex:0 0 84px;font-size:12px;color:var(--dsw-alias-label-caption);padding-top:6px}
.mmv-frow .ctrl{flex:1;min-width:0;display:flex;align-items:center}
.mmv-frow textarea.mmv-input{width:100%;min-height:110px;resize:vertical;padding:7px 10px;line-height:1.5}
.mmv-frow textarea.mmv-kwta{min-height:64px;height:64px}
.mmv-frow select.mmv-input{height:28px;padding:0 8px}
.mmv-star{background:none;border:0;color:var(--dsw-alias-label-caption);font-size:16px;cursor:pointer;padding:2px 1px;line-height:1}
.mmv-star.on{color:#e0af68}
.mmv-modal-foot{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
`

/** 幂等注入样式（与既有插件 CSS 注入同款：只保留一份）。 */
export function ensureViewerCss(doc: Document = document): void {
  const id = 'meow-memory-viewer-css'
  if (doc.querySelector(`style[data-meow-css="${id}"]`) !== null) {
    const existing = doc.querySelector<HTMLStyleElement>(`style[data-meow-css="${id}"]`)
    if (existing !== null && existing.textContent === VIEWER_CSS) return
    existing?.remove()
  }
  const tag = doc.createElement('style')
  tag.dataset.meowCss = id
  tag.textContent = VIEWER_CSS
  doc.head.appendChild(tag)
}

// ── 纯展示组件 ──────────────────────────────────────────────────────────────

export function LevelBadge({ level, sub }: { level: string; sub?: string | null }): ReactNode {
  const c = levelColor(level)
  return h(
    'span',
    { className: 'mmv-badge', style: { color: c, borderColor: c, background: `${c}22` } },
    sub ? `${level} · ${sub}` : level,
  )
}

export function StatusDot({ status }: { status: ViewerStatus }): ReactNode {
  const color = status === 'active' ? '#9ece6a' : status === 'stale' ? '#e0af68' : '#565f89'
  return h('i', { style: { width: 7, height: 7, borderRadius: '50%', background: color, display: 'inline-block', flex: '0 0 auto' } })
}

export function Stars({ n }: { n: number }): ReactNode {
  return h('span', { style: { color: '#e0af68', fontSize: 11, letterSpacing: 1 } }, '★'.repeat(Math.max(0, Math.min(4, n))))
}

export function Chips({ items }: { items: readonly string[] }): ReactNode {
  if (items.length === 0) return null
  return h('div', { className: 'mmv-kw' }, items.map((k, i) => h('span', { key: `${k}-${i}` }, k)))
}

export function LevelBar({ counts }: { counts: Record<string, number> }): ReactNode {
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  if (total === 0) return h('div', { className: 'mmv-bar7' })
  const known: ViewerLevel[] = ['project', 'fact', 'lesson', 'topic', 'rules', 'soul', 'user']
  return h(
    'div',
    { className: 'mmv-bar7' },
    known
      .filter((l) => (counts[l] ?? 0) > 0)
      .map((l) => h('i', { key: l, style: { width: `${((counts[l] ?? 0) / total) * 100}%`, background: levelColor(l) } })),
  )
}

export function KpiCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }): ReactNode {
  return h(
    'div',
    { className: 'mmv-kpi' },
    h('span', null, label),
    h('b', { style: color ? { color } : undefined }, value),
    sub !== undefined ? h('i', null, sub) : null,
  )
}

export function MemoryRow({
  memory,
  onClick,
  showWorkspace,
}: {
  memory: MemoryDto
  onClick?: () => void
  showWorkspace?: string
}): ReactNode {
  return h(
    'div',
    { className: 'mmv-row', onClick },
    h(LevelBadge, { level: memory.level, sub: memory.subcategory }),
    h(
      'div',
      { className: 'c' },
      h('b', null, memory.content),
      h('em', null, `${showWorkspace !== undefined ? `${showWorkspace} · ` : ''}${relativeTime(memory.updatedAt)}`),
    ),
  )
}

export function levelCountText(counts: Record<string, number>): string {
  const known: ViewerLevel[] = ['project', 'fact', 'lesson', 'topic', 'rules', 'soul', 'user']
  return known
    .filter((l) => (counts[l] ?? 0) > 0)
    .map((l) => `${levelLabel(l)} ${counts[l]}`)
    .join(' · ')
}

export function memoryMetaRows(m: MemoryDto): Array<[string, string]> {
  return [
    ['id', m.id],
    ['level', m.level],
    ['subcategory', m.subcategory ?? '—'],
    ['project', m.project ?? '—'],
    ['importance', `${'★'.repeat(Math.max(0, Math.min(4, m.importance)))} (${m.importance})`],
    ['status', STATUS_LABELS[m.status] ?? m.status],
    ['created_at', absoluteTime(m.createdAt)],
    ['updated_at', `${absoluteTime(m.updatedAt)}（${relativeTime(m.updatedAt)}）`],
    ['source_session', m.sourceSession ?? '—'],
    ['hit_count', humanCount(m.hitCount)],
    ['keywords', m.keywords.length > 0 ? m.keywords.join(', ') : '（无关键词）'],
  ]
}
