/**
 * 记忆查看器 UI 稿生成器（设计交付物，不是产品代码）。
 *
 * 输出三张 1440×900 的 SVG（假数据）：
 *   01-global.svg    全局视图（跨工作区）
 *   02-workspace.svg 工作区视图（项目树 + 记忆列表 + 详情抽屉）
 *   03-starmap.svg   星图视图（星座布局）
 *
 * 用法：node docs/mockups/render-mockups.mjs
 * 转 PNG：rsvg-convert -w 2880 -o 01-global.png 01-global.svg
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = dirname(fileURLToPath(import.meta.url))
const W = 1440
const H = 900

// ── 设计 token（对齐 dsh 暗色主题） ─────────────────────────────────────────
const C = {
  bg: '#16161e',
  panel: '#1a1b26',
  panel2: '#1f2335',
  card: '#1e2130',
  cardHover: '#242838',
  border: '#2f334d',
  borderSoft: '#262a3d',
  text: '#c0caf5',
  text2: '#9aa5ce',
  text3: '#6b7394',
  accent: '#7aa2f7',
  ok: '#9ece6a',
  warn: '#e0af68',
  danger: '#f7768e',
  purple: '#bb9af7',
  cyan: '#7dcfff',
  gray: '#565f89',
}
const LEVEL = {
  project: '#7aa2f7',
  fact: '#9ece6a',
  lesson: '#f7768e',
  topic: '#e0af68',
  rules: '#bb9af7',
  soul: '#7dcfff',
  user: '#c0caf5',
  none: '#565f89',
}
const FONT = "Noto Sans CJK SC, Source Han Sans SC, sans-serif"
const MONO = "Noto Sans Mono, Source Han Mono SC, monospace"

// ── SVG 基础工具 ────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 近似宽度：CJK ≈ fs，其它 ≈ 0.56fs。 */
function textWidth(s, fs) {
  let w = 0
  for (const ch of String(s)) w += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? fs : fs * 0.56
  return w
}
function trunc(s, maxPx, fs) {
  s = String(s)
  if (textWidth(s, fs) <= maxPx) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', fs) > maxPx) break
    out += ch
  }
  return out + '…'
}
function rect(x, y, w, h, o = {}) {
  const a = [`x="${x}" y="${y}" width="${w}" height="${h}"`]
  if (o.r !== undefined) a.push(`rx="${o.r}"`)
  a.push(`fill="${o.fill ?? 'none'}"`)
  if (o.stroke) a.push(`stroke="${o.stroke}" stroke-width="${o.sw ?? 1}"`)
  if (o.op !== undefined) a.push(`opacity="${o.op}"`)
  return `<rect ${a.join(' ')}/>`
}
function txt(x, y, s, o = {}) {
  const a = [`x="${x}" y="${y}"`, `font-size="${o.fs ?? 13}"`, `fill="${o.fill ?? C.text}"`, `font-family="${o.mono ? MONO : FONT}"`]
  if (o.anchor) a.push(`text-anchor="${o.anchor}"`)
  if (o.weight) a.push(`font-weight="${o.weight}"`)
  if (o.op !== undefined) a.push(`opacity="${o.op}"`)
  if (o.ls) a.push(`letter-spacing="${o.ls}"`)
  return `<text ${a.join(' ')}>${esc(s)}</text>`
}
function circ(cx, cy, r, o = {}) {
  const a = [`cx="${cx}" cy="${cy}" r="${r}"`, `fill="${o.fill ?? 'none'}"`]
  if (o.stroke) a.push(`stroke="${o.stroke}" stroke-width="${o.sw ?? 1}"`)
  if (o.op !== undefined) a.push(`opacity="${o.op}"`)
  if (o.dash) a.push(`stroke-dasharray="${o.dash}"`)
  return `<circle ${a.join(' ')}/>`
}
function line(x1, y1, x2, y2, o = {}) {
  const a = [`x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"`, `stroke="${o.stroke ?? C.border}" stroke-width="${o.sw ?? 1}"`]
  if (o.op !== undefined) a.push(`opacity="${o.op}"`)
  if (o.dash) a.push(`stroke-dasharray="${o.dash}"`)
  if (o.cap) a.push(`stroke-linecap="${o.cap}"`)
  return `<line ${a.join(' ')}/>`
}
function path(d, o = {}) {
  const a = [`d="${d}"`, `fill="${o.fill ?? 'none'}"`]
  if (o.stroke) a.push(`stroke="${o.stroke}" stroke-width="${o.sw ?? 1}"`)
  if (o.op !== undefined) a.push(`opacity="${o.op}"`)
  if (o.dash) a.push(`stroke-dasharray="${o.dash}"`)
  return `<path ${a.join(' ')}/>`
}

// ── 业务小部件 ──────────────────────────────────────────────────────────────
/** 卡片：面板底 + 细边 + 圆角。 */
const card = (x, y, w, h, o = {}) =>
  rect(x, y, w, h, { fill: o.fill ?? C.card, r: o.r ?? 10, stroke: o.stroke ?? C.border, sw: o.sw ?? 1, op: o.op })

/** 分段控件（scope 切换）。 */
function segmented(x, y, items, activeIdx) {
  const out = []
  const pad = 4
  let w = 0
  const widths = items.map((t) => textWidth(t, 13) + 26)
  for (const ww of widths) w += ww
  out.push(rect(x, y, w + pad * 2, 32, { fill: C.panel2, r: 9, stroke: C.border }))
  let cx = x + pad
  items.forEach((t, i) => {
    const ww = widths[i]
    if (i === activeIdx) out.push(rect(cx, y + pad, ww, 24, { fill: C.accent, r: 7, op: 0.92 }))
    out.push(txt(cx + ww / 2, y + 21, t, { fs: 13, anchor: 'middle', fill: i === activeIdx ? '#16161e' : C.text2, weight: i === activeIdx ? 600 : 400 }))
    cx += ww
  })
  return out.join('')
}

/** 层级徽章。 */
function levelBadge(x, y, level, w = 58) {
  const col = LEVEL[level] ?? C.gray
  return rect(x, y, w, 18, { fill: col, r: 5, op: 0.18 }) + rect(x, y, 3, 18, { fill: col, r: 1.5 }) + txt(x + w / 2 + 2, y + 13, level, { fs: 11, anchor: 'middle', fill: col, mono: true })
}

/** 状态点。 */
const statusDot = (cx, cy, status) =>
  circ(cx, cy, 3.5, { fill: status === 'active' ? C.ok : status === 'stale' ? C.warn : C.gray, op: status === 'active' ? 1 : 0.85 })

/** 重要性星。 */
function stars(x, y, n) {
  let out = ''
  for (let i = 0; i < n; i++) out += txt(x + i * 11, y, '★', { fs: 11, fill: C.warn })
  return out
}

/** 关键词 chip 行（超出宽度截断）。 */
function chips(x, y, list, maxW) {
  let out = ''
  let cx = x
  for (const k of list) {
    const w = textWidth(k, 11) + 16
    if (cx + w > x + maxW) break
    out += rect(cx, y, w, 19, { fill: C.accent, r: 9, op: 0.12 }) + txt(cx + w / 2, y + 13.5, k, { fs: 11, anchor: 'middle', fill: C.text2 })
    cx += w + 6
  }
  return out
}

/** 七层迷你堆叠条。 */
function levelBar(x, y, w, counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1
  let out = rect(x, y, w, 7, { fill: C.panel2, r: 3.5 })
  let cx = x
  for (const [lv, n] of Object.entries(counts)) {
    const seg = Math.max(2, (n / total) * w)
    out += rect(cx, y, Math.min(seg, x + w - cx), 7, { fill: LEVEL[lv], r: 3.5, op: 0.9 })
    cx += seg
  }
  return out
}

// ── 侧栏（三视图共用） ──────────────────────────────────────────────────────
function sidebar(activePanel = 'memory') {
  const o = []
  const SB = 220
  o.push(rect(0, 0, SB, H, { fill: C.panel }))
  o.push(line(SB, 0, SB, H, { stroke: C.borderSoft }))
  // brand
  o.push(rect(16, 16, 22, 22, { fill: C.accent, r: 6, op: 0.9 }))
  o.push(path(`M21 25 l4 -4 l4 4 l-4 4 z`, { fill: '#16161e' }))
  o.push(txt(46, 32, 'DeepSeek Harness', { fs: 13.5, weight: 600 }))
  // new session
  o.push(rect(16, 52, SB - 32, 32, { fill: C.card, r: 9, stroke: C.border }))
  o.push(txt(30, 73, '＋', { fs: 14, fill: C.text2 }))
  o.push(txt(50, 73, '新会话', { fs: 13, fill: C.text2 }))
  // 全局面板
  o.push(txt(20, 118, '全局面板', { fs: 11, fill: C.text3, ls: 0.6 }))
  const panels = [['记忆', 'memory'], ['文件', 'files']]
  let py = 128
  for (const [label, id] of panels) {
    const active = id === activePanel
    if (active) o.push(rect(12, py, SB - 24, 30, { fill: C.accent, r: 8, op: 0.14 }))
    const col = active ? C.accent : C.text3
    // 图标：星点 + 环（记忆）/ 文档（文件）
    if (id === 'memory') {
      o.push(circ(30, py + 15, 6, { stroke: col, sw: 1.4 }))
      o.push(circ(30, py + 15, 2.2, { fill: col }))
      o.push(circ(38, py + 10, 1.6, { fill: col, op: 0.8 }))
    } else {
      o.push(rect(24, py + 8, 12, 14, { stroke: col, sw: 1.3, r: 2 }))
    }
    o.push(txt(50, py + 20, label, { fs: 13, fill: active ? C.text : C.text2, weight: active ? 600 : 400 }))
    py += 34
  }
  // 工作区
  o.push(txt(20, py + 22, '工作区', { fs: 11, fill: C.text3, ls: 0.6 }))
  const wsList = ['dsh-meow-memory', 'femwa', 'dsh', 'meow-eyes']
  let wy = py + 34
  for (const ws of wsList) {
    const active = ws === 'dsh-meow-memory'
    if (active) o.push(rect(12, wy, SB - 24, 26, { fill: C.cardHover, r: 7 }))
    o.push(rect(24, wy + 8, 10, 10, { fill: LEVEL.project, r: 3, op: active ? 0.9 : 0.5 }))
    o.push(txt(42, wy + 18, trunc(ws, 140, 12), { fs: 12, fill: active ? C.text : C.text2 }))
    wy += 28
  }
  // footer
  o.push(line(16, H - 46, SB - 16, H - 46, { stroke: C.borderSoft }))
  o.push(circ(30, H - 26, 6, { stroke: C.text3, sw: 1.3 }))
  o.push(txt(46, H - 21, '设置', { fs: 12.5, fill: C.text2 }))
  return o.join('')
}

/** 主区顶栏（标题 + 分段 + 搜索 + 刷新）。 */
function header(activeIdx, sub) {
  const o = []
  const X = 244
  o.push(txt(X, 40, '记忆', { fs: 18, weight: 700 }))
  o.push(txt(X + 46, 40, 'Memory', { fs: 12, fill: C.text3, ls: 0.5 }))
  o.push(segmented(X + 118, 20, ['全局', '工作区', '星图'], activeIdx))
  if (sub) o.push(sub)
  // search
  o.push(rect(W - 320, 22, 240, 30, { fill: C.panel2, r: 9, stroke: C.border }))
  o.push(circ(W - 302, 37, 5.5, { stroke: C.text3, sw: 1.3 }))
  o.push(line(W - 298, 41, W - 294, 45, { stroke: C.text3, sw: 1.3 }))
  o.push(txt(W - 286, 41, '搜索记忆…', { fs: 12, fill: C.text3 }))
  // refresh
  o.push(rect(W - 68, 22, 34, 30, { fill: C.panel2, r: 9, stroke: C.border }))
  o.push(path(`M${W - 59} 33 a6.5 6.5 0 1 1 2 4.6`, { stroke: C.text2, sw: 1.4 }))
  o.push(txt(W - 336, 41, '60s 前更新', { fs: 11.5, fill: C.text3, anchor: 'end' }))
  return o.join('')
}

// ── 视图 1：全局 ────────────────────────────────────────────────────────────
function viewGlobal() {
  const o = [rect(0, 0, W, H, { fill: C.bg }), sidebar('memory')]
  o.push(header(0))
  o.push(line(220, 64, W, 64, { stroke: C.borderSoft }))

  // KPI
  const kpis = [
    ['工作区', '6', '5 个有记忆库', C.accent],
    ['记忆总数', '1,284', 'active 1,151', C.ok],
    ['本周新增', '63', '↑ 12%', C.cyan],
    ['项目', '17', '4 个跨工作区', C.purple],
    ['待整理窗口', '3', '空闲 ≥3h', C.warn],
    ['已归档', '42', 'stale 91', C.text3],
  ]
  const gap = 12
  const cw = (W - 244 - 24 - gap * (kpis.length - 1)) / kpis.length
  kpis.forEach(([label, val, sub, col], i) => {
    const x = 244 + i * (cw + gap)
    o.push(card(x, 78, cw, 74))
    o.push(txt(x + 14, 100, label, { fs: 12, fill: C.text3 }))
    o.push(txt(x + 14, 128, val, { fs: 22, weight: 700, fill: col }))
    o.push(txt(x + 14, 144, sub, { fs: 11, fill: C.text3 }))
  })

  // 左：工作区卡片
  const LY = 166
  const LW = 720
  o.push(txt(244, LY + 4, '工作区', { fs: 14, weight: 600 }))
  o.push(txt(244 + 54, LY + 4, '6 个（1 个无记忆库）', { fs: 11.5, fill: C.text3 }))
  const workspaces = [
    ['dsh-meow-memory', '/home/azalea/WorkSpace/azalea-git/dsh-meow-memory', 214, 4, '2 分钟前', { fact: 96, project: 42, lesson: 28, topic: 18, rules: 22, soul: 3, user: 5 }, 'dreamed'],
    ['femwa', '/home/azalea/WorkSpace/azalea-git/femwa', 96, 2, '1 小时前', { fact: 38, project: 22, lesson: 14, topic: 8, rules: 10, soul: 1, user: 3 }, 'dreamed'],
    ['dsh', '/home/azalea/WorkSpace/dsh', 318, 3, '3 小时前', { fact: 141, project: 88, lesson: 32, topic: 21, rules: 28, soul: 2, user: 6 }, 'dreaming'],
    ['meow-eyes', '/home/azalea/WorkSpace/azalea-git/meow-eyes', 58, 1, '昨天', { fact: 24, project: 14, lesson: 6, topic: 4, rules: 8, soul: 0, user: 2 }, 'dreamed'],
  ]
  const cw2 = (LW - 14) / 2
  workspaces.forEach(([title, path, total, proj, rel, counts, dream], i) => {
    const x = 244 + (i % 2) * (cw2 + 14)
    const y = LY + 16 + Math.floor(i / 2) * 150
    o.push(card(x, y, cw2, 136))
    o.push(txt(x + 14, y + 26, title, { fs: 13.5, weight: 600 }))
    // dream 月牙
    if (dream === 'dreaming') o.push(circ(x + cw2 - 22, y + 21, 6, { fill: C.warn, op: 0.9 }))
    else o.push(circ(x + cw2 - 22, y + 21, 6, { fill: C.warn, op: 0.55 }))
    o.push(txt(x + 14, y + 45, trunc(path, cw2 - 28, 11), { fs: 11, fill: C.text3, mono: true }))
    o.push(levelBar(x + 14, y + 58, cw2 - 28, counts))
    // 数字行
    o.push(txt(x + 14, y + 88, String(total), { fs: 20, weight: 700, fill: C.text }))
    o.push(txt(x + 14 + textWidth(String(total), 20) + 6, y + 88, '条', { fs: 11.5, fill: C.text3 }))
    o.push(txt(x + 14, y + 108, `项目 ${proj} · 最近更新 ${rel}`, { fs: 11.5, fill: C.text2 }))
    // 层级小图例
    let lx = x + 14
    for (const [lv, n] of Object.entries(counts)) {
      if (n === 0) continue
      o.push(circ(lx + 3, y + 124, 3, { fill: LEVEL[lv] }))
      o.push(txt(lx + 10, y + 128, String(n), { fs: 10.5, fill: C.text3 }))
      lx += 10 + textWidth(String(n), 10.5) + 12
    }
  })

  // 左下：健康检查（填满卡片区下方空间）
  const HY = LY + 16 + 2 * 150 + 12
  o.push(card(244, HY, LW, 130))
  o.push(txt(258, HY + 24, '健康检查', { fs: 13, weight: 600 }))
  o.push(txt(258 + 62, HY + 24, '（点击跳转到对应过滤结果）', { fs: 10.5, fill: C.text3 }))
  const health = [
    ['无关键词条目', 3, C.warn], ['超期未更新 rules', 4, C.text3], ['疑似重复（相似 ≥0.8）', 5, C.danger], ['未完成 todo', 2, C.cyan],
  ]
  health.forEach(([label, n, col], i) => {
    const x = 258 + (i % 2) * 350
    const y = HY + 44 + Math.floor(i / 2) * 40
    o.push(rect(x, y, 336, 32, { fill: C.card, r: 8 }))
    o.push(circ(x + 16, y + 16, 4, { fill: col }))
    o.push(txt(x + 30, y + 21, String(label), { fs: 12, fill: C.text2 }))
    o.push(txt(x + 280, y + 21, String(n), { fs: 13, weight: 700, fill: col, anchor: 'end' }))
    o.push(txt(x + 322, y + 21, '→', { fs: 12, fill: C.text3, anchor: 'end' }))
  })

  // 右：跨库最近更新 + 全局条目
  const RX = 244 + LW + 20
  const RW = W - RX - 24
  o.push(txt(RX, LY + 4, '跨库最近更新', { fs: 14, weight: 600 }))
  const recent = [
    ['dsh-meow-memory', 'project', 'meow-memory 代码结构（src/，约 1 万行）…', '2 分钟前'],
    ['femwa', 'lesson', 'femGen 的 seed 必须固定，否则渲染不可复现', '1 小时前'],
    ['dsh', 'fact', 'dsh 的 slot 目录在 cordis-client-runner bundle 里', '3 小时前'],
    ['dsh-meow-memory', 'rules', '客户端 UI 文案沿用硬编码中文（官方 locale 无第三方席位）', '昨天'],
    ['meow-eyes', 'fact', '描述路由 /meow-eyes/describe 返回全量快照', '昨天'],
  ]
  recent.forEach(([ws, lv, content, rel], i) => {
    const y = LY + 16 + i * 46
    o.push(card(RX, y, RW, 40, { fill: C.card, r: 8 }))
    o.push(levelBadge(RX + 10, y + 11, lv))
    o.push(txt(RX + 76, y + 18, trunc(content, RW - 150, 12), { fs: 12 }))
    o.push(txt(RX + 76, y + 32, `${ws} · ${rel}`, { fs: 10.5, fill: C.text3 }))
  })
  // 全局条目
  const GY = LY + 16 + 5 * 46 + 12
  o.push(txt(RX, GY, '全局条目（project = 全局，跨库收集）', { fs: 14, weight: 600 }))
  const globals = [
    ['rules', '非常重要、致命、犯错会很糟糕的决策/红线 → importance 4', 'dsh-meow-memory'],
    ['user', '用户机器时钟为美区时间，dream 峰时抑制必须按 Asia/Shanghai 算', 'dsh-meow-memory'],
    ['rules', '本机文件一律不删除（红线）', 'dsh'],
  ]
  globals.forEach(([lv, content, ws], i) => {
    const y = GY + 14 + i * 42
    o.push(card(RX, y, RW, 36, { fill: C.card, r: 8 }))
    o.push(levelBadge(RX + 10, y + 9, lv, 52))
    o.push(txt(RX + 70, y + 17, trunc(content, RW - 150, 11.5), { fs: 11.5, fill: C.text2 }))
    o.push(txt(RX + 70, y + 30, `来源：${ws}`, { fs: 10.5, fill: C.text3 }))
  })

  // 右下：会话足迹（读写痕迹，星图会话边的数据面）
  const FY = GY + 14 + 3 * 42 + 12
  o.push(card(RX, FY, RW, 184, { fill: C.card }))
  o.push(txt(RX + 14, FY + 24, '会话足迹', { fs: 13, weight: 600 }))
  o.push(txt(RX + RW - 14, FY + 24, '本工作区', { fs: 10.5, fill: C.text3, anchor: 'end' }))
  const footprints = [
    ['cd11292b', 12, 3, '2 分钟前'], ['a1f3c9d2', 8, 1, '1 小时前'], ['e95f149b', 21, 0, '昨天'],
  ]
  footprints.forEach(([sid, r, w, rel], i) => {
    const y = FY + 38 + i * 30
    o.push(circ(RX + 22, y + 12, 4, { fill: C.cyan }))
    o.push(txt(RX + 34, y + 17, String(sid), { fs: 11.5, mono: true, fill: C.text2 }))
    o.push(txt(RX + RW - 14, y + 17, `读 ${r} · 写 ${w} · ${rel}`, { fs: 10.5, fill: C.text3, anchor: 'end' }))
  })
  o.push(line(RX + 14, FY + 132, RX + RW - 14, FY + 132, { stroke: C.borderSoft }))
  o.push(txt(RX + 14, FY + 152, '数据源：sessions/<id>.json 的', { fs: 10.5, fill: C.text3 }))
  o.push(txt(RX + 14, FY + 168, 'injected / searched / accessed / written', { fs: 10.5, fill: C.text3, mono: true }))

  // 底部：整理留痕
  const BY = 790
  o.push(line(244, BY - 14, W - 24, BY - 14, { stroke: C.borderSoft }))
  o.push(txt(244, BY + 8, '整理留痕（dream_log）', { fs: 13, weight: 600 }))
  const dreams = [
    ['2 小时前', 'dsh-meow-memory', 'done · groups=3 · stamped=41', C.ok],
    ['5 小时前', 'femwa', 'done · groups=2 · stamped=18', C.ok],
    ['7 小时前', 'dsh', 'recovered (interrupted) · stamped=7', C.warn],
    ['昨天', 'meow-eyes', 'done · groups=3 · stamped=26', C.ok],
  ]
  dreams.forEach(([rel, ws, detail, col], i) => {
    const x = 244 + i * ((W - 268) / 4)
    o.push(circ(x + 4, BY + 30, 4, { fill: col }))
    o.push(txt(x + 16, BY + 26, `${ws}`, { fs: 12, weight: 600 }))
    o.push(txt(x + 16, BY + 42, `${rel} · ${detail}`, { fs: 10.5, fill: C.text3 }))
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${o.join('')}</svg>`
}

// ── 视图 2：工作区 ──────────────────────────────────────────────────────────
function viewWorkspace() {
  const o = [rect(0, 0, W, H, { fill: C.bg }), sidebar('memory')]
  const sel = rect(360, 22, 300, 30, { fill: C.panel2, r: 9, stroke: C.border }) + txt(374, 42, '工作区  dsh-meow-memory', { fs: 12.5 }) + txt(640, 42, '▾', { fs: 12, fill: C.text3 })
  o.push(header(1, sel))
  o.push(line(220, 64, W, 64, { stroke: C.borderSoft }))

  const COL_L = 220, COL_R = 320
  const LX = 244, LY = 84
  const LW = COL_L
  const MX = LX + LW + 16
  const MW = W - MX - COL_R - 24 - 16
  const RX = MX + MW + 16
  const RY = LY
  const RW = COL_R

  // 左：项目树
  o.push(card(LX, LY, LW, 300))
  o.push(txt(LX + 14, LY + 26, '项目', { fs: 13, weight: 600 }))
  const projects = [
    ['全部', 214, true], ['meow-memory', 42], ['dsh', 18], ['femwa', 9], ['全局', 12], ['未标记', 3],
  ]
  projects.forEach(([name, n, active], i) => {
    const y = LY + 38 + i * 28
    if (active) o.push(rect(LX + 8, y, LW - 16, 24, { fill: C.accent, r: 7, op: 0.14 }))
    o.push(circ(LX + 20, y + 12, 4, { fill: active ? C.accent : C.gray, op: active ? 1 : 0.6 }))
    o.push(txt(LX + 32, y + 17, String(name), { fs: 12.5, fill: active ? C.text : C.text2, weight: active ? 600 : 400 }))
    o.push(txt(LX + LW - 16, y + 17, String(n), { fs: 11.5, fill: C.text3, anchor: 'end', mono: true }))
  })
  // 层级图例
  o.push(card(LX, LY + 312, LW, 236))
  o.push(txt(LX + 14, LY + 338, '层级（点击过滤）', { fs: 13, weight: 600 }))
  const levels = [['project', 310], ['fact', 604], ['lesson', 118], ['topic', 87], ['rules', 150], ['soul / user', 15]]
  levels.forEach(([lv, n], i) => {
    const y = LY + 352 + i * 30
    const key = lv.split(' ')[0]
    o.push(circ(LX + 22, y + 12, 5.5, { fill: LEVEL[key] ?? C.gray }))
    o.push(txt(LX + 38, y + 17, lv, { fs: 12.5, fill: C.text2 }))
    o.push(txt(LX + LW - 16, y + 17, String(n), { fs: 11.5, fill: C.text3, anchor: 'end', mono: true }))
  })
  // 标签
  o.push(rect(LX, LY + 560, LW, 34, { fill: C.panel2, r: 9, stroke: C.border }))
  o.push(rect(LX + 4, LY + 564, 100, 26, { fill: C.accent, r: 7, op: 0.9 }))
  o.push(txt(LX + 54, LY + 581, '记忆列表', { fs: 12, anchor: 'middle', fill: '#16161e', weight: 600 }))
  o.push(txt(LX + 162, LY + 581, '时间线', { fs: 12, anchor: 'middle', fill: C.text2 }))
  o.push(txt(LX + 218, LY + 581, '留痕', { fs: 12, anchor: 'middle', fill: C.text2 }))
  // 左下：本会话（会话上下文里的记忆视野）
  const SY = LY + 608
  o.push(card(LX, SY, LW, 168, { fill: C.card }))
  o.push(txt(LX + 14, SY + 24, '本会话', { fs: 13, weight: 600 }))
  o.push(txt(LX + LW - 14, SY + 24, 'cd11292b', { fs: 10.5, fill: C.text3, anchor: 'end', mono: true }))
  const srows = [['已注入/检索', 14], ['写过', 2], ['当前锚定项目', 'meow-memory']]
  srows.forEach(([k, v], i) => {
    const y = SY + 42 + i * 26
    o.push(txt(LX + 14, y + 12, String(k), { fs: 11.5, fill: C.text3 }))
    o.push(txt(LX + LW - 14, y + 12, String(v), { fs: 11.5, fill: C.text2, anchor: 'end', mono: true }))
  })
  o.push(rect(LX + 14, SY + 124, LW - 28, 30, { fill: C.cardHover, r: 8, stroke: C.border }))
  o.push(txt(LX + LW / 2, SY + 144, '在会话中查看', { fs: 12, anchor: 'middle', fill: C.text2 }))

  // 中：过滤条 + 列表
  o.push(rect(MX, LY, MW, 34, { fill: C.panel2, r: 9, stroke: C.border }))
  o.push(circ(MX + 18, LY + 17, 5.5, { stroke: C.text3, sw: 1.3 }))
  o.push(line(MX + 22, LY + 21, MX + 26, LY + 25, { stroke: C.text3, sw: 1.3 }))
  o.push(txt(MX + 34, LY + 21, '搜索（BM25，与 memory_search 同算法）', { fs: 11.5, fill: C.text3 }))
  for (const [i, label] of ['level: 全部 ▾', 'status: active ▾', '时间: 全部 ▾'].entries()) {
    const x = MX + MW - 300 + i * 100
    o.push(rect(x, LY + 6, 92, 22, { fill: C.card, r: 6, stroke: C.border }))
    o.push(txt(x + 46, LY + 21, label, { fs: 11, anchor: 'middle', fill: C.text2 }))
  }
  const rows = [
    ['project', 'structure', 'meow-memory 代码结构（src/，约 1 万行）：index.ts（host 装配）、db.ts（SQLite 数据层）、tools.ts、inject.ts、dream.ts…', ['模块划分', 'index.ts 装配', 'db.ts 数据层', 'client 折叠 UI', 'esbuild 打包'], '8 分钟前', '2026-09-12 23:52', 3, 'active'],
    ['rules', '', '客户端 UI 文案沿用硬编码中文——官方 locale 字典没有第三方席位（settings-page 注释结论）。', ['locale', '硬编码', 'settings-page'], '1 小时前', '2026-09-12 22:40', 3, 'active'],
    ['fact', '', '命中打分 = 交集 × idf × 覆盖率 × 艾宾浩斯衰减(updated_at) × importance × title 加成。', ['命中打分', 'idf', '艾宾浩斯', 'importance'], '3 小时前', '2026-09-12 20:15', 2, 'active'],
    ['lesson', '', '跨工作区读取别家的 memory.db 必须用 readOnly 打开：getDb() 会建表 + 跑 upgrade()，等于写坏别人的库。', ['readOnly', 'node:sqlite', '跨工作区', 'getDb'], '昨天', '2026-09-11 19:02', 3, 'active'],
    ['topic', '', '让 meow-memory 具备可视化记忆查看能力（全局 / 工作区 / 星图三层视图）。', ['记忆查看器', '可视化', '星图', '全局视图'], '昨天', '2026-09-11 15:30', 2, 'active'],
  ]
  let ry = LY + 46
  rows.forEach(([lv, sub, content, kws, rel, abs, imp, status]) => {
    const h = 116
    o.push(card(MX, ry, MW, h, { r: 10 }))
    o.push(levelBadge(MX + 14, ry + 14, lv))
    if (sub) o.push(txt(MX + 80, ry + 27, `· ${sub}`, { fs: 11, fill: C.text3 }))
    o.push(stars(MX + MW - 152, ry + 27, imp))
    o.push(statusDot(MX + MW - 18, ry + 22, status))
    o.push(txt(MX + MW - 30, ry + 27, rel, { fs: 11, fill: C.text3, anchor: 'end' }))
    o.push(txt(MX + 14, ry + 52, trunc(content, MW - 28, 12.5), { fs: 12.5, fill: C.text }))
    if (textWidth(content, 12.5) > MW - 28) {
      o.push(txt(MX + 14, ry + 72, trunc(String(content).slice(20), MW - 28, 12.5), { fs: 12.5, fill: C.text, op: 0.85 }))
    }
    o.push(chips(MX + 14, ry + 88, kws, MW - 240))
    o.push(txt(MX + MW - 14, ry + 102, abs, { fs: 10.5, fill: C.text3, anchor: 'end', mono: true }))
    ry += h + 10
  })

  // 右：详情抽屉
  o.push(card(RX, RY, RW, H - RY - 24, { fill: C.panel }))
  o.push(txt(RX + 16, RY + 28, '详情', { fs: 14, weight: 700 }))
  o.push(levelBadge(RX + 16, RY + 40, 'project'))
  o.push(txt(RX + 84, RY + 53, '· structure', { fs: 11, fill: C.text3 }))
  o.push(txt(RX + RW - 16, RY + 53, 'active', { fs: 11, fill: C.ok, anchor: 'end' }))
  o.push(line(RX + 16, RY + 68, RX + RW - 16, RY + 68, { stroke: C.borderSoft }))
  const body = [
    'meow-memory 代码结构（src/，约 1 万行）：',
    'index.ts（host 装配：config/设置页命名空间、',
    'session 事件→窗口表、pre-step 首轮注入+命中、',
    'turn-stopping 反思/dream 推进、agent/request',
    '换模型、webServer 路由、/dream 命令）；',
    'db.ts（SQLite 数据层：七层表 + windows/',
    'dream_log/dream_meta/dream_skip，dream 租约',
    'claim/advance/touch/finish/release）；tools.ts…',
  ]
  body.forEach((l, i) => o.push(txt(RX + 16, RY + 92 + i * 19, trunc(l, RW - 32, 11.5), { fs: 11.5, fill: C.text2 })))
  o.push(txt(RX + 16, RY + 92 + body.length * 19 + 6, '（原文全文，可选中复制）', { fs: 10.5, fill: C.text3 }))
  // 元数据表
  const META_Y = RY + 290
  o.push(line(RX + 16, META_Y - 12, RX + RW - 16, META_Y - 12, { stroke: C.borderSoft }))
  const meta = [
    ['id', '0mtykdh9j-40a7dccf…'],
    ['level', 'project'],
    ['subcategory', 'structure'],
    ['project', 'dsh-meow-memory'],
    ['importance', '★★★ (3)'],
    ['status', 'active'],
    ['created_at', '2026-09-12 23:52:49'],
    ['updated_at', '2026-09-12 23:52:53（8 分钟前）'],
    ['source_session', 'session-cd11292b'],
    ['hit_count', '2'],
  ]
  meta.forEach(([k, v], i) => {
    const y = META_Y + 8 + i * 22
    o.push(txt(RX + 16, y + 12, k, { fs: 11, fill: C.text3, mono: true }))
    o.push(txt(RX + 130, y + 12, trunc(v, RW - 150, 11.5), { fs: 11.5, fill: C.text2, mono: k !== 'project' }))
  })
  // 按钮
  const BY = META_Y + 8 + meta.length * 22 + 12
  o.push(rect(RX + 16, BY, 132, 30, { fill: C.accent, r: 8, op: 0.9 }))
  o.push(txt(RX + 82, BY + 20, '在会话中查看', { fs: 12, anchor: 'middle', fill: '#16161e', weight: 600 }))
  o.push(rect(RX + 156, BY, 90, 30, { fill: C.card, r: 8, stroke: C.border }))
  o.push(txt(RX + 201, BY + 20, '复制 id', { fs: 12, anchor: 'middle', fill: C.text2 }))
  // 相关记忆
  const RLY = BY + 52
  o.push(txt(RX + 16, RLY, '相关记忆（findSimilar）', { fs: 12.5, weight: 600 }))
  const rel = [['project', '项目结构 · 目录与模块', 0.42], ['lesson', 'readOnly 打开别家库', 0.38], ['fact', 'dream 分轮与三轮制', 0.31]]
  rel.forEach(([lv, t, sim], i) => {
    const y = RLY + 12 + i * 30
    o.push(card(RX + 16, y, RW - 32, 26, { fill: C.card, r: 7 }))
    o.push(levelBadge(RX + 24, y + 4, lv, 52))
    o.push(txt(RX + 84, y + 17, trunc(String(t), RW - 160, 11.5), { fs: 11.5, fill: C.text2 }))
    o.push(txt(RX + RW - 24, y + 17, String(sim), { fs: 10.5, fill: C.text3, anchor: 'end', mono: true }))
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${o.join('')}</svg>`
}

// ── 视图 3：星图 ────────────────────────────────────────────────────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function viewStarmap() {
  const o = [rect(0, 0, W, H, { fill: C.bg }), sidebar('memory')]
  const rnd = mulberry32(20260913)

  // 顶栏（两行过滤）
  o.push(txt(244, 40, '记忆', { fs: 18, weight: 700 }))
  o.push(segmented(362, 20, ['全局', '工作区', '星图'], 2))
  // 边类型开关
  const edgeLabels = [['结构边', true], ['相似边', true], ['会话边', true], ['取代边', false]]
  let ex = 620
  edgeLabels.forEach(([label, on]) => {
    const w = textWidth(label, 12) + 40
    o.push(rect(ex, 22, w, 26, { fill: on ? C.accent : C.card, r: 13, stroke: C.border, op: on ? 0.22 : 1 }))
    o.push(rect(ex + 8, 30, 10, 10, { fill: on ? C.accent : C.gray, r: 3 }))
    o.push(txt(ex + 24, 39, label, { fs: 12, fill: on ? C.text : C.text3 }))
    ex += w + 8
  })
  // 布局切换
  o.push(rect(W - 468, 22, 180, 30, { fill: C.panel2, r: 9, stroke: C.border }))
  o.push(rect(W - 464, 26, 86, 22, { fill: C.accent, r: 7, op: 0.9 }))
  o.push(txt(W - 421, 41, '星座布局', { fs: 11.5, anchor: 'middle', fill: '#16161e', weight: 600 }))
  o.push(txt(W - 334, 41, '力导向', { fs: 11.5, anchor: 'middle', fill: C.text2 }))
  o.push(rect(W - 276, 22, 240, 30, { fill: C.panel2, r: 9, stroke: C.border }))
  o.push(txt(W - 262, 41, '阈值 0.35', { fs: 11.5, fill: C.text2, mono: true }))
  o.push(txt(W - 180, 41, 'topK 3', { fs: 11.5, fill: C.text2, mono: true }))
  o.push(txt(W - 116, 41, '时间 全部', { fs: 11.5, fill: C.text2 }))
  // 第二行：图例
  o.push(line(220, 64, W, 64, { stroke: C.borderSoft }))
  o.push(txt(244, 86, '层级', { fs: 11.5, fill: C.text3 }))
  let lx = 286
  for (const [lv, col] of Object.entries(LEVEL)) {
    if (lv === 'none') continue
    o.push(circ(lx + 5, 82, 5, { fill: col }))
    o.push(txt(lx + 15, 86, lv, { fs: 11.5, fill: C.text2 }))
    lx += 15 + textWidth(lv, 11.5) + 16
  }
  o.push(txt(W - 320, 86, '── 结构边   ┄┄ 相似边   ─→ 会话读写边', { fs: 11.5, fill: C.text3 }))
  o.push(rect(0, 96, W, 1, { fill: C.borderSoft }))

  // 画布区
  const CX0 = 220, CY0 = 97, CW = W - CX0, CH = H - CY0 - 44
  o.push(rect(CX0, CY0, CW, CH, { fill: '#12131b' }))
  // 星点背景
  for (let i = 0; i < 130; i++) {
    const x = CX0 + rnd() * CW, y = CY0 + rnd() * CH
    o.push(circ(x, y, rnd() * 1.2 + 0.3, { fill: '#ffffff', op: rnd() * 0.18 + 0.04 }))
  }

  // 星座布局：星系中心（项目） + 分层记忆
  const clusters = [
    { name: 'dsh', cx: CX0 + 300, cy: CY0 + 250, count: 22, r: 150, size: 1.0 },
    { name: 'dsh-meow-memory', cx: CX0 + 640, cy: CY0 + 210, count: 30, r: 190, size: 1.25 },
    { name: 'femwa', cx: CX0 + 960, cy: CY0 + 330, count: 16, r: 125, size: 0.85 },
    { name: 'meow-eyes', cx: CX0 + 480, cy: CY0 + 560, count: 9, r: 90, size: 0.7 },
  ]
  const layerR = { project: 0.34, fact: 0.6, lesson: 0.6, topic: 0.86, rules: 0.86, soul: 1.0, user: 1.0 }
  const nodes = []
  const edges = []
  // 中心星云（全局/未标记）
  const nebula = { x: CX0 + 250, y: CY0 + 470 }
  o.push(circ(nebula.x, nebula.y, 76, { fill: C.gray, op: 0.07 }))
  o.push(circ(nebula.x, nebula.y, 44, { fill: C.gray, op: 0.09 }))
  o.push(txt(nebula.x, nebula.y + 92, '全局 / 未标记', { fs: 11, anchor: 'middle', fill: C.text3 }))
  for (let i = 0; i < 10; i++) {
    const a = i * 2.399, r = 26 + i * 5.2
    nodes.push({ x: nebula.x + Math.cos(a) * r, y: nebula.y + Math.sin(a) * r * 0.72, level: i % 3 === 0 ? 'rules' : 'user', r: 2.6, cluster: null })
  }
  for (const cl of clusters) {
    // 星系光晕
    o.push(circ(cl.cx, cl.cy, cl.r * 1.12, { fill: LEVEL.project, op: 0.035 }))
    o.push(circ(cl.cx, cl.cy, cl.r * 0.74, { fill: LEVEL.project, op: 0.04 }))
    // 项目核心
    o.push(circ(cl.cx, cl.cy, 9, { fill: 'none', stroke: LEVEL.project, sw: 2, op: 0.95 }))
    o.push(circ(cl.cx, cl.cy, 3, { fill: LEVEL.project }))
    o.push(txt(cl.cx, cl.cy - 17, cl.name, { fs: 11.5, anchor: 'middle', fill: C.text2 }))
    // 分层
    const layers = [['project', 0.34], ['fact', 0.6], ['lesson', 0.6], ['topic', 0.86], ['rules', 0.86], ['user', 1.0]]
    const per = Math.max(2, Math.round(cl.count / layers.length))
    layers.forEach(([lv, fr], li) => {
      for (let i = 0; i < per; i++) {
        const a = (i / per) * Math.PI * 2 + li * 0.7 + rnd() * 0.3
        const rr = cl.r * fr * (0.92 + rnd() * 0.16)
        const x = cl.cx + Math.cos(a) * rr
        const y = cl.cy + Math.sin(a) * rr * 0.82
        const node = { x, y, level: lv, r: (lv === 'project' ? 4.2 : 3) + rnd() * 1.4, cluster: cl.name }
        nodes.push(node)
        edges.push({ a: node, b: { x: cl.cx, y: cl.cy }, type: 'project' })
      }
    })
  }
  // 相似边（同星系内近邻虚线）
  const rnd2 = mulberry32(77)
  for (const cl of clusters) {
    const inCl = nodes.filter((n) => n.cluster === cl.name)
    for (let i = 0; i < inCl.length; i++) {
      for (let k = 0; k < 2; k++) {
        const j = (i + 1 + Math.floor(rnd2() * 4)) % inCl.length
        if (j === i) continue
        const d = Math.hypot(inCl[i].x - inCl[j].x, inCl[i].y - inCl[j].y)
        if (d < 62) edges.push({ a: inCl[i], b: inCl[j], type: 'similar' })
      }
    }
  }
  // 会话节点（外环时间带）+ 读写边
  const sessions = [
    { id: 'cd11292b', x: CX0 + 180, y: CY0 + 120 }, { id: 'a1f3c9d2', x: CX0 + 520, y: CY0 + 90 },
    { id: '7b2e4410', x: CX0 + 880, y: CY0 + 130 }, { id: 'e95f149b', x: CX0 + 1080, y: CY0 + 560 },
  ]
  for (const s of sessions) {
    const targets = nodes.filter((n) => n.cluster !== null).sort(() => rnd() - 0.5).slice(0, 2)
    for (const t of targets) edges.push({ a: s, b: t, type: 'session' })
  }

  // 画边（分层批量）
  const byType = { project: [], similar: [], session: [] }
  for (const e of edges) byType[e.type].push(e)
  o.push(`<g>`)
  for (const e of byType.project) o.push(line(e.a.x, e.a.y, e.b.x, e.b.y, { stroke: LEVEL.project, sw: 0.9, op: 0.22 }))
  for (const e of byType.similar) o.push(line(e.a.x, e.a.y, e.b.x, e.b.y, { stroke: C.purple, sw: 0.8, op: 0.3, dash: '3 4' }))
  for (const e of byType.session) o.push(line(e.a.x, e.a.y, e.b.x, e.b.y, { stroke: C.cyan, sw: 0.9, op: 0.28 }))
  o.push(`</g>`)
  // 画节点
  for (const n of nodes) {
    o.push(circ(n.x, n.y, n.r, { fill: LEVEL[n.level], op: n.cluster === null ? 0.55 : 0.95 }))
    if (n.level === 'project') o.push(circ(n.x, n.y, n.r + 2.4, { stroke: LEVEL.project, sw: 0.8, op: 0.5 }))
  }
  for (const s of sessions) {
    o.push(rect(s.x - 7, s.y - 7, 14, 14, { fill: C.cyan, r: 4, op: 0.9 }))
    o.push(txt(s.x, s.y + 20, s.id, { fs: 9.5, anchor: 'middle', fill: C.text3, mono: true }))
  }
  // 选中节点 + 高亮邻接
  const sel = nodes.find((n) => n.cluster === 'femwa' && n.level === 'fact') ?? nodes[40]
  o.push(circ(sel.x, sel.y, 13, { stroke: C.warn, sw: 1.6, op: 0.9 }))
  for (const e of edges.filter((e) => e.a === sel || e.b === sel)) {
    const other = e.a === sel ? e.b : e.a
    o.push(line(sel.x, sel.y, other.x, other.y, { stroke: C.warn, sw: 1.6, op: 0.85 }))
    o.push(circ(other.x, other.y, 6.5, { stroke: C.warn, sw: 1.2, op: 0.7 }))
  }
  // 选中详情卡
  const DCX = W - 356, DCY = 130
  o.push(card(DCX, DCY, 320, 138, { fill: C.panel, op: 0.97 }))
  o.push(levelBadge(DCX + 14, DCY + 14, 'fact'))
  o.push(txt(DCX + 82, DCY + 27, '· femwa', { fs: 11, fill: C.text3 }))
  o.push(txt(DCX + 306, DCY + 27, '★2', { fs: 11, fill: C.warn, anchor: 'end' }))
  o.push(txt(DCX + 14, DCY + 52, 'femGen 的 seed 必须固定，', { fs: 12.5, fill: C.text }))
  o.push(txt(DCX + 14, DCY + 70, '否则渲染不可复现。', { fs: 12.5, fill: C.text }))
  o.push(chips(DCX + 14, DCY + 82, ['seed', '固定', '可复现'], 292))
  o.push(txt(DCX + 14, DCY + 122, '邻接 5：1 项目 · 3 相似 · 1 会话', { fs: 11, fill: C.text3 }))
  o.push(txt(DCX + 306, DCY + 122, '09-11 19:02', { fs: 10.5, fill: C.text3, anchor: 'end', mono: true }))
  // 左下角提示
  o.push(card(244, H - 148, 250, 74, { fill: C.panel, op: 0.94 }))
  o.push(txt(258, H - 124, '操作提示', { fs: 11.5, weight: 600, fill: C.text2 }))
  o.push(txt(258, H - 106, 'hover 高亮邻接 · 单击详情', { fs: 10.5, fill: C.text3 }))
  o.push(txt(258, H - 92, '双击聚焦 · 滚轮缩放 · 拖拽平移', { fs: 10.5, fill: C.text3 }))
  // 底部统计
  o.push(rect(220, H - 44, W - 220, 44, { fill: C.panel }))
  o.push(line(220, H - 44, W, H - 44, { stroke: C.borderSoft }))
  o.push(txt(244, H - 18, `节点 ${nodes.length + sessions.length} · 边 ${byType.project.length + byType.similar.length + byType.session.length}`, { fs: 11.5, fill: C.text2, mono: true }))
  o.push(txt(500, H - 18, `结构 ${byType.project.length} / 相似 ${byType.similar.length} / 会话 ${byType.session.length}`, { fs: 11.5, fill: C.text3, mono: true }))
  o.push(txt(W - 24, H - 18, '截断 否 · 布局 星座 · 数据版本 g-1789228373824', { fs: 11.5, fill: C.text3, anchor: 'end', mono: true }))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${o.join('')}</svg>`
}

// ── 输出 ────────────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true })
const files = { '01-global.svg': viewGlobal(), '02-workspace.svg': viewWorkspace(), '03-starmap.svg': viewStarmap() }
for (const [name, svg] of Object.entries(files)) {
  writeFileSync(join(OUT, name), svg, 'utf8')
  console.log('wrote', name, svg.length, 'bytes')
}
