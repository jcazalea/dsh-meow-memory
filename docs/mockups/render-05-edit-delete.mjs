/**
 * 记忆查看器 UI 稿 #05 — 面板写操作（编辑浮层 / 逻辑删除 / 物理删除）。
 *
 * 设计交付物，不是产品代码。输出 1440×900 的 SVG（假数据）：
 *   05-edit-delete.svg
 *
 * 用法：node docs/mockups/render-05-edit-delete.mjs
 * 转 PNG：rsvg-convert -w 2880 -o docs/mockups/05-edit-delete.png docs/mockups/05-edit-delete.svg
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = dirname(fileURLToPath(import.meta.url))
const W = 1440
const H = 900

// ── 设计 token（对齐 dsh 暗色主题与 02-workspace 稿） ────────────────────────
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
const FONT = 'Noto Sans CJK SC, Source Han Sans SC, sans-serif'
const MONO = 'Noto Sans Mono, Source Han Mono SC, monospace'

const parts = []
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const rect = (x, y, w, h, fill, rx = 0, stroke) =>
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="1"` : ''}/>`)
const line = (x1, y1, x2, y2, color = C.borderSoft) => parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1"/>`)
const circle = (cx, cy, r, fill, stroke) =>
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="1.3"` : ''}/>`)
const text = (x, y, s, { size = 12.5, fill = C.text, font = FONT, weight = 400, anchor = 'start', spacing } = {}) =>
  parts.push(
    `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-family="${font}" font-weight="${weight}" text-anchor="${anchor}"${spacing ? ` letter-spacing="${spacing}"` : ''}>${esc(s)}</text>`,
  )
const chip = (x, y, label, color = C.accent, w = null) => {
  const width = w ?? 14 + label.length * 13
  rect(x, y, width, 19, color + '1e', 9.5)
  rect(x, y, 3, 19, color, 1.5)
  text(x + 12, y + 13.5, label, { size: 11, fill: color, font: MONO })
  return width
}
const btn = (x, y, label, { color = C.text2, bg = C.card, w = null, h = 30, bold = false } = {}) => {
  const width = w ?? 14 + label.length * 13
  rect(x, y, width, h, bg, 8, C.border)
  text(x + width / 2, y + h / 2 + 4, label, { size: 12, fill: color, anchor: 'middle', weight: bold ? 600 : 400 })
  return width
}
const row = (x, y, label, value, mono = true) => {
  text(x, y, label, { size: 11, fill: C.text3, font: MONO })
  text(x + 120, y, value, { size: 11.5, fill: C.text2, font: mono ? MONO : FONT })
}

// ── 底图：侧栏 + 列表 + 详情（简化 02 布局） ────────────────────────────────
rect(0, 0, W, H, C.bg)
rect(0, 0, 220, H, C.panel)
line(220, 0, 220, H)
rect(16, 16, 22, 22, C.accent, 6)
text(46, 32, 'DeepSeek Harness', { size: 13.5, weight: 600 })
rect(12, 128, 196, 30, C.accent, 8, null, 0.14)
text(50, 148, '记忆', { size: 13, fill: C.text, weight: 600 })
circle(30, 143, 5, C.accent, C.accent)
rect(12, 230, 196, 26, C.cardHover, 7)
text(42, 248, 'dsh-meow-memory', { size: 12 })
text(20, 300, '查看器（读 + 写）v0.31.0', { size: 11, fill: C.text3, spacing: '0.4' })
rect(24, 314, 12, 12, C.accent, 3)
text(46, 324, '修改记忆', { size: 12 })
rect(24, 342, 12, 12, C.warn, 3)
text(46, 352, '逻辑删除（归档）', { size: 12 })
rect(24, 370, 12, 12, C.danger, 3)
text(46, 380, '物理删除（不可恢复）', { size: 12 })
text(24, 420, '列表：status: archived 过滤器', { size: 11.5, fill: C.text3 })
rect(24, 432, 172, 30, C.card, 8, C.border)
text(110, 452, 'status: archived ▾', { size: 11.5, fill: C.text2, anchor: 'middle' })
text(24, 470, '可找回 / 一键还原', { size: 11, fill: C.ok })
text(24, 500, '审计：viewer_log 留痕', { size: 11, fill: C.text3 })
text(24, 520, '「整理留痕」tab 可见', { size: 11, fill: C.text3 })

// 中部列表
text(244, 40, '记忆', { size: 18, weight: 700 })
line(220, 64, W, 64)
rect(244, 84, 600, 34, C.panel2, 9, C.border)
circle(262, 101, 5.5, 'none', C.text3)
text(278, 105, '搜索（关键词 + 正文，服务端 BM25）', { size: 11.5, fill: C.text3 })
rect(716, 90, 120, 22, C.card, 6, C.border)
text(776, 105, 'status: active ▾', { size: 11, fill: C.text2, anchor: 'middle' })

const listRows = [
  ['project', 'structure', C.accent, 'meow-memory 代码结构（src/，约 1 万行）：index.ts（host 装配）、db.ts（SQLite 数据层…', '3 分钟前'],
  ['rules', null, C.purple, '客户端 UI 文案沿用硬编码中文——官方 locale 字典没有第三方席位。', '1 小时前'],
  ['fact', null, C.ok, '命中打分 = 交集 × idf × 覆盖率 × 艾宾浩斯衰减 × importance。', '3 小时前'],
]
listRows.forEach(([lv, sub, color, content, when], i) => {
  const y = 130 + i * 120
  rect(244, y, 600, 110, C.card, 10, C.border)
  chip(258, y + 14, lv + (sub ? ` · ${sub}` : ''), color)
  text(840, y + 28, when, { size: 11, fill: C.text3, anchor: 'end' })
  text(258, y + 62, content.slice(0, 34), { size: 12.5 })
  text(258, y + 82, content.slice(0, 34) + '（第二行省略）', { size: 12.5, fill: C.text, opacity: 0.85 })
})

// 右侧详情抽屉（带新操作按钮）
const dX = 860
rect(dX, 84, 320, 420, C.panel, 10, C.border)
text(dX + 16, 112, '详情', { size: 14, weight: 700 })
chip(dX + 16, 124, 'project · structure', C.accent)
text(dX + 290, 137, 'active', { size: 11, fill: C.ok, anchor: 'end' })
line(dX + 16, 152, dX + 304, 152)
text(dX + 16, 176, 'meow-memory 代码结构（src/，约 1 万行）：', { size: 11.5, fill: C.text2 })
text(dX + 16, 195, 'index.ts（host 装配：config/设置页命名空间、', { size: 11.5, fill: C.text2 })
text(dX + 16, 214, 'session 事件→窗口表、pre-step 首轮注入+命中、', { size: 11.5, fill: C.text2 })
text(dX + 16, 233, 'turn-stopping 反思/dream 推进、webServer 路由）', { size: 11.5, fill: C.text2 })
text(dX + 16, 258, '（原文全文，可选中复制）', { size: 10.5, fill: C.text3 })
line(dX + 16, 280, dX + 304, 280)
row(dX + 16, 306, 'id', '0mtykdh9j-40a7dccf…')
row(dX + 16, 328, 'level', 'project')
row(dX + 16, 350, 'subcategory', 'structure')
row(dX + 16, 372, 'importance', '★★★ (3)')
row(dX + 16, 394, 'updated_at', '8 分钟前')
// 操作按钮行（v0.31.0 配色：主操作实心 / 归档琥珀 / 物理删除红）
text(dX + 16, 414, '操作', { size: 12.5, fill: C.text, weight: 600 })
btn(dX + 16, 424, '✎ 编辑', { color: '#16161e', bg: C.accent, w: 82, bold: true })
btn(dX + 106, 424, '无效记忆（归档）', { color: C.warn, bg: C.warn + '22', w: 136, bold: true })
btn(dX + 250, 424, '✕ 物理删除', { color: C.danger, bg: C.danger + '1c', w: 104, bold: true })
btn(dX + 16, 464, '复制正文', { color: C.text2, w: 86 })
btn(dX + 110, 464, '复制 id', { color: C.text2, w: 86 })
// 说明：归档/还原流转
line(dX + 16, 500, dX + 304, 500)
text(dX + 16, 522, '逻辑删除 → status=archived，列表消失', { size: 11, fill: C.text3 })
text(dX + 16, 540, '   · archived 过滤器下可找回、可「还原」', { size: 11, fill: C.text3 })
text(dX + 16, 558, '物理删除 → 彻底移除，仅留审计记录', { size: 11, fill: C.text3 })
text(dX + 16, 576, '   · 需输入「删除」二字二次确认', { size: 11, fill: C.text3 })

// ── 编辑浮层（覆盖全屏） ────────────────────────────────────────────────────
rect(0, 0, W, H, '#0a0a10', 0, null, 0.5)
const mX = 340
const mY = 120
rect(mX, mY, 560, 700, C.panel, 12, C.border)
text(mX + 24, mY + 36, '编辑记忆 · project / structure', { size: 14, weight: 700 })

const f = (label, cy, ctrl) => {
  text(mX + 24, cy, label, { size: 12, fill: C.text3 })
  return ctrl(mX + 24, cy + 8)
}
// 内容 textarea
f('内容', mY + 68, (x, y) => {
  rect(x, y, 512, 96, C.card, 8, C.border)
  text(x + 12, y + 22, 'meow-memory 代码结构（src/，约 1 万行）：index.ts（host 装配）、db.ts（SQLite 数据层）、', { size: 12 })
  text(x + 12, y + 42, 'tools.ts、inject.ts、dream.ts、viewer/（只读仓储 + 12 端点）…', { size: 12 })
})
// 重要性（星标）
f('重要性', mY + 196, (x, y) => {
  for (let i = 0; i < 5; i++) {
    text(x + 10 + i * 24, y + 16, '★', { size: 18, fill: i < 3 ? C.warn : C.text3 })
  }
  text(x + 140, y + 16, '3', { size: 12, fill: C.text3 })
})
// 关键词（反馈轮：改 3 行 textarea，可逗号/换行分隔）
f('关键词', mY + 238, (x, y) => {
  rect(x, y, 512, 64, C.card, 8, C.border)
  text(x + 12, y + 20, '代码结构, 模块划分, index.ts, db.ts', { size: 11.5, fill: C.text3 })
  text(x + 12, y + 40, '（逗号或换行分隔；留空 = 不修改）', { size: 10.5, fill: C.text3 })
})
// 状态
f('状态', mY + 324, (x, y) => {
  rect(x, y, 512, 28, C.card, 8, C.border)
  text(x + 12, y + 19, 'active（生效中）  ▾', { size: 11.5, fill: C.text2 })
})
// 项目
f('项目', mY + 374, (x, y) => {
  rect(x, y, 512, 28, C.card, 8, C.border)
  text(x + 12, y + 19, 'dsh-meow-memory  ▾', { size: 11.5, fill: C.text2 })
  text(x + 340, y + 19, '仅限 未标记 / 全局 / 现有项目', { size: 10.5, fill: C.text3, anchor: 'end' })
})
// 子类
f('子类', mY + 424, (x, y) => {
  rect(x, y, 512, 28, C.card, 8, C.border)
  text(x + 12, y + 19, 'structure（项目结构）  ▾', { size: 11.5, fill: C.text2 })
})
// 底部提示 + 按钮
text(mX + 24, mY + 600, '按层门控：subcategory 仅 project 层 · goal 仅 topic 层 · corrected 仅 lesson 层', { size: 10.5, fill: C.text3 })
text(mX + 24, mY + 618, '乐观锁：保存时校验 expectUpdatedAt，已被其他会话改过 → 409 提示刷新', { size: 10.5, fill: C.text3 })
text(mX + 24, mY + 636, 'ESC 关闭 · 复制正文/复制 id 有 ✓ 提示 · 下拉框跟随系统深色', { size: 10.5, fill: C.text3 })
btn(mX + 512 - 78, mY + 658, '保存', { color: C.accent, bg: C.accent, w: 78, bold: true })
text(mX + 512 - 78 - 24, mY + 672, '取消', { size: 12, fill: C.text2, anchor: 'end' })

// ── 右下角：删除确认流程 callout ────────────────────────────────────────────
const cX = 930
const cY = 620
rect(cX, cY, 380, 250, C.card, 12, C.border)
text(cX + 18, cY + 30, '删除两种入口的确认流', { size: 13, weight: 600 })
text(cX + 18, cY + 58, '① 无效记忆（逻辑删除）', { size: 12, fill: C.warn, weight: 600 })
text(cX + 18, cY + 80, '   confirm: 归档「xxx…」为无效记忆？', { size: 11.5, fill: C.text2 })
text(cX + 18, cY + 98, '   可从 status: archived 找回 / 一键还原', { size: 11, fill: C.text3 })
text(cX + 18, cY + 128, '② 物理删除（不可恢复）', { size: 12, fill: C.danger, weight: 600 })
rect(cX + 18, cY + 140, 344, 56, C.panel2, 8, C.border)
text(cX + 30, cY + 162, '物理删除将彻底移除这条记忆，不可恢复', { size: 11.5, fill: C.text2 })
text(cX + 30, cY + 180, '（仅留审计记录）。请输入「删除」二字确认：', { size: 11.5, fill: C.text2 })
rect(cX + 30, cY + 188, 120, 22, C.bg, 6, C.border)
text(cX + 40, cY + 204, '删除', { size: 11.5, fill: C.danger })
rect(cX + 158, cY + 188, 90, 22, C.danger, 6)
text(cX + 203, cY + 204, '确认删除', { size: 11.5, fill: C.bg, anchor: 'middle', weight: 600 })
text(cX + 18, cY + 222, '任何写操作都进 viewer_log：「谁在什么时候改了什么」', { size: 10.5, fill: C.text3 })

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, '05-edit-delete.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`)
console.log('written', join(OUT, '05-edit-delete.svg'))
