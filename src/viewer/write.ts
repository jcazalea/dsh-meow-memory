/**
 * meow-memory 记忆查看器 — 受控写操作（update / archive / restore / purge）。
 *
 * 面板写操作（v0.31.0）的 host 侧实现。安全边界：
 *  - 写路径**绝不调用 getDb()**（会 mkdir + 建表 + 跑 upgrade），沿用 /projects/rename
 *    先例直接可写打开中央库；只幂等建我们自己的审计表 viewer_log。
 *  - 按层门控与 db.ts 的 MemoryDb.update 完全对齐：subcategory 仅 project 层、
 *    goal 仅 topic 层、corrected 仅 lesson 层、project 列七层皆有（v3 soul/user 补列）。
 *  - 写操作只接受**完整 36 位 id**（前缀匹配有同毫秒歧义，面板拿到的都是全 id）。
 *  - 物理删除（purge）是用户拍板新增的能力，但仍留审计痕迹；
 *    删除后顺带清理 projects 映射表里不再被任何记忆引用的孤儿行（项目 = 记忆的聚合投影）。
 *  - 乐观锁：update 带 expectUpdatedAt，与当前 updated_at 不符 → conflict（前端刷新重试）。
 */

import { DatabaseSync } from 'node:sqlite'
import { getCentralDbPath, LEVELS, projectList, type Level } from '../db.js'
import type { MemoryPatchDto, ViewerLogEntry, ViewerWriteResult } from './types.js'

export type ViewerWriteAction = ViewerWriteResult['action']

export type WriteOutcome =
  | { status: 'ok'; result: ViewerWriteResult }
  | { status: 'not-found' }
  | { status: 'conflict'; currentUpdatedAt: number }

interface Found {
  level: Level
  row: Record<string, unknown>
}

/** 可写打开中央库（写操作专用）：busy_timeout 5s + 幂等建 viewer_log 审计表。 */
export function openCentralWritable(dir: string): DatabaseSync {
  const db = new DatabaseSync(getCentralDbPath(dir), { readOnly: false })
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(`CREATE TABLE IF NOT EXISTS viewer_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    workspace TEXT NOT NULL,
    action TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    level TEXT NOT NULL,
    summary TEXT NOT NULL
  )`)
  return db
}

/** 跨七层精确定位（不前缀匹配：写操作必须全 id）。 */
function findExact(db: DatabaseSync, id: string): Found | undefined {
  for (const level of LEVELS) {
    const r = db.prepare(`SELECT * FROM ${level} WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    if (r) return { level, row: r }
  }
  return undefined
}

function audit(db: DatabaseSync, workspace: string, entry: Omit<ViewerLogEntry, 'at'>): void {
  db.prepare('INSERT INTO viewer_log (at, workspace, action, memory_id, level, summary) VALUES (?, ?, ?, ?, ?, ?)').run(
    Date.now(),
    workspace,
    entry.action,
    entry.id,
    entry.level,
    entry.summary,
  )
}

/** 修改记忆：按层门控拼 SET，任何成功 update 都刷新 updated_at（记忆时间戳=最后更新时间）。 */
export function updateMemory(
  db: DatabaseSync,
  workspace: string,
  id: string,
  patch: MemoryPatchDto,
  expectUpdatedAt?: number,
): WriteOutcome {
  const found = findExact(db, id)
  if (!found) return { status: 'not-found' }
  const { level, row } = found
  const currentUpdatedAt = Number(row.updated_at ?? 0)
  if (expectUpdatedAt !== undefined && expectUpdatedAt !== currentUpdatedAt) {
    return { status: 'conflict', currentUpdatedAt }
  }

  const sets: string[] = []
  const args: unknown[] = []
  const changed: string[] = []
  const push = (col: string, label: string, val: unknown): void => {
    sets.push(`${col} = ?`)
    args.push(val)
    changed.push(label)
  }
  if (patch.content !== undefined && typeof patch.content === 'string') push('content', 'content', patch.content)
  if (patch.title !== undefined && typeof patch.title === 'string') push('title', 'title', patch.title)
  if (patch.importance !== undefined && Number.isFinite(patch.importance)) push('importance', 'importance', Math.round(patch.importance))
  if (patch.keywords !== undefined && Array.isArray(patch.keywords)) {
    // 空数组 = 不更新（沿用 memory_update 语义：防误清空）；非空才写。
    const kw = patch.keywords.map((k) => (typeof k === 'string' ? k.trim() : '')).filter((k) => k.length > 0)
    if (kw.length > 0) push('keywords', 'keywords', JSON.stringify(kw))
  }
  if (patch.status !== undefined && ['active', 'archived', 'stale'].includes(patch.status)) push('status', 'status', patch.status)
  if (patch.corrected !== undefined && level === 'lesson') push('corrected', 'corrected', patch.corrected ? 1 : 0)
  if (patch.project !== undefined && LEVELS.includes(level)) push('project', 'project', patch.project) // null = 未标记
  if (patch.subcategory !== undefined && level === 'project') push('subcategory', 'subcategory', patch.subcategory)
  if (patch.goal !== undefined && level === 'topic') push('goal', 'goal', patch.goal)

  if (sets.length === 0) {
    // 空 patch（无字段变化）：视为调用成功，不刷新时间戳（与 memory_update 一致）。
    return { status: 'ok', result: { id, level, updatedAt: currentUpdatedAt, action: 'update' } }
  }
  // updated_at 是自动刷新的「记忆时间戳」，不算用户改的字段（不进审计摘要的「改」列表）。
  sets.push('updated_at = ?')
  args.push(Date.now())
  const now = Date.now()
  db.prepare(`UPDATE ${level} SET ${sets.join(', ')} WHERE id = ?`).run(...args, id)
  audit(db, workspace, { action: 'update', id, level, summary: `改 ${changed.join(', ')}` })
  return { status: 'ok', result: { id, level, updatedAt: now, action: 'update' } }
}

/** 逻辑删除（无效记忆）：status → archived；可还原。幂等：已 archived 直接返回成功。 */
export function archiveMemory(db: DatabaseSync, workspace: string, id: string): WriteOutcome {
  const found = findExact(db, id)
  if (!found) return { status: 'not-found' }
  if (found.row.status === 'archived') {
    return { status: 'ok', result: { id, level: found.level, updatedAt: Number(found.row.updated_at ?? 0), action: 'archive' } }
  }
  const now = Date.now()
  db.prepare(`UPDATE ${found.level} SET status = 'archived', updated_at = ? WHERE id = ?`).run(now, id)
  audit(db, workspace, { action: 'archive', id, level: found.level, summary: '归档（逻辑删除，可还原）' })
  return { status: 'ok', result: { id, level: found.level, updatedAt: now, action: 'archive' } }
}

/** 还原：status → active。幂等。 */
export function restoreMemory(db: DatabaseSync, workspace: string, id: string): WriteOutcome {
  const found = findExact(db, id)
  if (!found) return { status: 'not-found' }
  if (found.row.status === 'active') {
    return { status: 'ok', result: { id, level: found.level, updatedAt: Number(found.row.updated_at ?? 0), action: 'restore' } }
  }
  const now = Date.now()
  db.prepare(`UPDATE ${found.level} SET status = 'active', updated_at = ? WHERE id = ?`).run(now, id)
  audit(db, workspace, { action: 'restore', id, level: found.level, summary: '还原为 active' })
  return { status: 'ok', result: { id, level: found.level, updatedAt: now, action: 'restore' } }
}

/** 物理删除：彻底移除该行（用户拍板新增能力，仍留审计痕迹）。 */
export function purgeMemory(db: DatabaseSync, workspace: string, id: string): WriteOutcome {
  const found = findExact(db, id)
  if (!found) return { status: 'not-found' }
  db.prepare(`DELETE FROM ${found.level} WHERE id = ?`).run(id)
  cleanupOrphanProjects(db)
  audit(db, workspace, { action: 'purge', id, level: found.level, summary: `物理删除（${found.level}）` })
  return { status: 'ok', result: { id, level: found.level, updatedAt: Date.now(), action: 'purge' } }
}

/** 清理 projects 映射表：不再被任何记忆行引用的 id 移除（项目 = 记忆的聚合投影）。 */
export function cleanupOrphanProjects(db: DatabaseSync): void {
  const used = new Set<string>()
  for (const level of LEVELS) {
    const rows = db.prepare(`SELECT project FROM ${level} WHERE project IS NOT NULL AND project != ''`).all() as Array<{ project: string }>
    for (const r of rows) for (const n of projectList(r.project)) used.add(n)
  }
  const all = db.prepare('SELECT id FROM projects').all() as Array<{ id: string }>
  for (const { id } of all) {
    if (!used.has(id)) db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }
}

/** 读审计留痕（写路径内部/测试用；面板展示走 ViewerReader.auditLog 只读通道）。 */
export function listAudit(db: DatabaseSync, limit: number): ViewerLogEntry[] {
  const rows = db
    .prepare('SELECT at, workspace, action, memory_id, level, summary FROM viewer_log ORDER BY at DESC LIMIT ?')
    .all(Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    at: Number(r.at),
    workspace: String(r.workspace),
    action: r.action as ViewerLogEntry['action'],
    id: String(r.memory_id),
    level: r.level as ViewerLogEntry['level'],
    summary: String(r.summary),
  }))
}
