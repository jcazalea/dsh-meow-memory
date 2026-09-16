/**
 * meow-memory v3 中央存储 — 一次性迁移：把各工作区旧库（<ws>/.dsh-meow/memory.db）
 * 合并进 ~/.dsh-meow/memory.db（中央库）。
 *
 * 触发：插件启动时（index.ts）检测未迁移 → 传已知 workspace 列表调用 migrateToCentral。
 * 幂等：中央库 dream_meta 写 migrated_v3=1 后直接返回，不再扫描。
 *
 * 规则（用户拍板 2026-09-14）：
 * - soul/user 不合并去重；按来源库「project 层记忆的项目名集合」推断归属——集合恰好一个
 *   项目名则打该项目标签，多/空则视为全局（project=null）。
 * - project/fact/lesson/topic/rules 按原 id 搬移（id=base36 毫秒+随机，全局唯一不冲突）。
 * - windows/dream_log/dream_meta/dream_skip/session_state 合并重建。
 * - 旧库迁完 rename 为 <ws>/.dsh-meow/memory.db.old 备份（不删除），wal/shm 清理。
 * - sessions/<id>.json 从 <ws>/.dsh-meow/sessions/ 复制到 ~/.dsh-meow/sessions/。
 *
 * 安全：逐个库迁、每库迁完才 rename 备份，中断可续跑（已迁的库不再被扫描）。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  getCentralDbPath,
  getCentralSessionsDir,
  getDb,
  isGlobalProject,
  LEVELS,
  memoryDbPath,
  projectList,
  type Level,
  type MemoryRow,
  type Status,
  type ProjectSubcategory,
} from './db.js'

const MIGRATED_KEY = 'migrated_v3'

/** 中央库是否已迁移过（幂等门）。 */
export function isCentralMigrated(dir = '.dsh-meow'): boolean {
  try {
    return getDb('', dir).getMeta(MIGRATED_KEY) === 1
  } catch {
    return false
  }
}

/** 把一行旧库记录容错转成 MemoryRow（列缺失按缺省处理——旧库可能没有 project/goal 等列）。 */
function toMemoryRow(level: Level, r: Record<string, unknown>): MemoryRow {
  let keywords: string[] = []
  try {
    keywords = JSON.parse(String(r.keywords ?? '[]')) as string[]
    if (!Array.isArray(keywords)) keywords = []
  } catch {
    keywords = []
  }
  return {
    id: String(r.id),
    level,
    title: r.title == null ? null : String(r.title),
    content: String(r.content ?? ''),
    importance: Number(r.importance ?? 1),
    keywords,
    status: String(r.status ?? 'active') as Status,
    corrected: Number(r.corrected ?? 0),
    project: r.project == null ? null : String(r.project),
    subcategory: r.subcategory == null ? null : (String(r.subcategory) as ProjectSubcategory),
    goal: r.goal == null ? null : String(r.goal),
    source_session: r.source_session == null ? null : String(r.source_session),
    hit_count: Number(r.hit_count ?? 0),
    created_at: Number(r.created_at ?? 0),
    updated_at: Number(r.updated_at ?? 0),
    last_accessed_at: r.last_accessed_at == null ? null : Number(r.last_accessed_at),
  }
}

/**
 * soul/user 归属推断：取旧库 project 层记忆的项目名集合（排除全局标记）。
 * 恰好一个 → 返回该项目名；空/多个 → null（全局）。
 */
function inferSoulUserProject(oldDb: DatabaseSync): string | null {
  try {
    const rows = oldDb
      .prepare(`SELECT project FROM project WHERE project IS NOT NULL AND project != ''`)
      .all() as Array<{ project: string }>
    const names = new Set<string>()
    for (const r of rows) {
      for (const n of projectList(r.project)) {
        if (n.length === 0 || isGlobalProject(n)) continue
        names.add(n)
      }
    }
    if (names.size === 1) return [...names][0]
  } catch {
    /* 旧库无 project 表：无法推断，归全局 */
  }
  return null
}

/** 迁移一个工作区的旧库 → 中央库。返回搬移的记忆条数；库不存在返回 0。 */
function migrateOneWorkspace(central: ReturnType<typeof getDb>, ws: string, srcDir: string): number {
  const oldPath = memoryDbPath(ws, srcDir)
  if (!existsSync(oldPath)) return 0
  // 可写打开 + checkpoint：把 WAL 合入主文件，随后 rename 主文件为 .old 才完整。
  const oldDb = new DatabaseSync(oldPath)
  let migrated = 0
  try {
    try {
      oldDb.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      /* 无 WAL 也无妨 */
    }
    const suProject = inferSoulUserProject(oldDb)
    for (const level of LEVELS) {
      let rows: Array<Record<string, unknown>>
      try {
        rows = oldDb.prepare(`SELECT * FROM ${level}`).all() as Array<Record<string, unknown>>
      } catch {
        continue // 旧库缺该表（早期版本）
      }
      for (const raw of rows) {
        const row = toMemoryRow(level, raw)
        if (level === 'soul' || level === 'user') row.project = suProject
        central.insert(row)
        migrated++
      }
    }
    // 辅助表合并重建：windows 按 session_id 主键 REPLACE；dream_meta 用 IGNORE
    // （保留中央库已有键，旧库只补缺，防覆盖 last_check 等运行态）。
    const REPLACE_TABLES = ['windows', 'dream_log', 'dream_skip', 'session_state'] as const
    for (const table of REPLACE_TABLES) {
      try {
        const rows = oldDb.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>
        if (rows.length === 0) continue
        const cols = Object.keys(rows[0] as Record<string, unknown>)
        if (cols.length === 0) continue
        const placeholders = cols.map(() => '?').join(', ')
        for (const r of rows) {
          try {
            central.rawExec(
              `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`,
              ...cols.map((c) => r[c]),
            )
          } catch {
            /* 单行失败跳过（如列类型不匹配） */
          }
        }
      } catch {
        /* 旧库缺该表 */
      }
    }
    try {
      const rows = oldDb.prepare(`SELECT * FROM dream_meta`).all() as Array<Record<string, unknown>>
      const cols = rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : []
      if (cols.length > 0) {
        const placeholders = cols.map(() => '?').join(', ')
        for (const r of rows) {
          try {
            central.rawExec(
              `INSERT OR IGNORE INTO dream_meta (${cols.join(', ')}) VALUES (${placeholders})`,
              ...cols.map((c) => r[c]),
            )
          } catch {
            /* 单行失败跳过 */
          }
        }
      }
    } catch {
      /* 旧库无 dream_meta */
    }
  } finally {
    oldDb.close()
  }
  // 迁移完成才重命名备份 + 清理 wal/shm（中断则旧库原样保留，可续跑）。
  renameSync(oldPath, `${oldPath}.old`)
  for (const suffix of ['-wal', '-shm']) {
    try {
      unlinkSync(`${oldPath}${suffix}`)
    } catch {
      /* 无残留 */
    }
  }
  return migrated
}

/** 迁移一个工作区的 sessions/<id>.json 到中央 sessions 目录（复制后删原件）。 */
function migrateSessions(ws: string, srcDirName: string, dir: string): number {
  const src = join(ws, srcDirName, 'sessions')
  const dst = getCentralSessionsDir(dir)
  let n = 0
  try {
    mkdirSync(dst, { recursive: true })
    for (const f of readdirSync(src)) {
      if (!f.endsWith('.json')) continue
      const srcFull = join(src, f)
      const dstFull = join(dst, f)
      try {
        copyFileSync(srcFull, dstFull)
        unlinkSync(srcFull)
        n++
      } catch {
        /* 单个文件失败跳过 */
      }
    }
  } catch {
    /* 无 sessions 目录 */
  }
  return n
}

/**
 * 执行中央化迁移。已迁移返回 0；否则遍历 workspaces 合并，完成后置位标记。
 * @param dir 中央库目录：绝对路径直接用，否则 homedir 下子目录（getCentralDbPath 语义）。
 * @param srcDir 旧库在哪个工作区子目录（默认 .dsh-meow）。
 * @returns 迁移的总记忆条数（记忆 + 会话文件）。
 */
export function migrateToCentral(workspaces: readonly string[], dir = '.dsh-meow', srcDir = '.dsh-meow'): number {
  const central = getDb('', dir)
  if (central.getMeta(MIGRATED_KEY) === 1) return 0 // 幂等：已迁移
  let total = 0
  for (const ws of workspaces) {
    if (typeof ws !== 'string' || ws.length === 0) continue
    try {
      total += migrateOneWorkspace(central, ws, srcDir)
      total += migrateSessions(ws, srcDir, dir)
    } catch {
      /* 单工作区迁移失败：跳过（旧库未 rename，可下次续跑） */
    }
  }
  central.setMeta(MIGRATED_KEY, 1)
  return total
}
