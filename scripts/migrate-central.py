#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
meow-memory v3 手动迁移脚本：把历史各工作区的旧库 + sessions 迁移到中央库。

与插件内置的一次性自动迁移（src/migrate-central.ts，docs/central-storage-design.md）规则完全一致，
只是可以脱离 dsh 独立手动执行，适合这些场景：
  ① 还没重启 dsh web、想先把历史数据迁好；
  ② 自动迁移因某个库损坏被跳过、想逐个补跑；
  ③ 换电脑/备份时在新机器上手动合并旧项目数据。

规则一览：
  1. 旧库   = <workspace>/<src-dir>/memory.db        （src-dir 默认 .dsh-meow）
  2. 中央库 = <central>/memory.db                    （默认 ~/.dsh-meow/memory.db）
  3. 幂等   ：中央库 dream_meta 置 migrated_v3=1 后不再重复迁移（--force 可强制重跑，重跑本身安全：
             七层 INSERT OR REPLACE、辅助表 REPLACE/IGNORE，均幂等）
  4. soul/user 归属推断：旧库 project 层记忆的项目名集合（排除全局标记）——恰好一个 → 打该标签；
     空/多个 → 归全局（project=null）
  5. 辅助表：windows/dream_log/dream_skip/session_state 用 INSERT OR REPLACE 合并；
             dream_meta 用 INSERT OR IGNORE（保留中央库已有键）
  6. 旧库迁完 rename 为 memory.db.old（可回退），并清掉 -wal/-shm 残留
  7. sessions/<id>.json 复制到中央 sessions 目录后删除原件

零依赖：只用 Python 标准库（sqlite3）。用法：

    # 预览（不写任何文件）
    python3 scripts/migrate-central.py --dry-run

    # 自动发现历史工作区（读 ~/.dsh-meow/window-index.json）并迁移（交互确认）
    python3 scripts/migrate-central.py

    # 显式指定工作区 + 跳过确认
    python3 scripts/migrate-central.py /path/to/projA /path/to/projB --yes
"""

import argparse
import json
import os
import shutil
import sqlite3
import sys
from pathlib import Path

GLOBAL_MARKERS = ("全局", "global")  # 与 db.ts isGlobalProject 口径一致
LEVELS = ["soul", "user", "project", "fact", "lesson", "topic", "rules"]
REPLACE_TABLES = ["windows", "dream_log", "dream_skip", "session_state"]
MIGRATED_KEY = "migrated_v3"

# ── schema（与 src/db.ts SCHEMAS / 辅助表 DDL 对齐） ────────────────────────
COMMON_COLS = [
    "id", "title", "content", "importance", "keywords", "status",
    "source_session", "hit_count", "created_at", "updated_at", "last_accessed_at",
]
LEVEL_EXTRA = {
    "soul": ["project"],
    "user": ["project"],
    "project": ["project", "subcategory"],
    "fact": ["project"],
    "lesson": ["corrected", "project"],
    "topic": ["goal", "project"],
    "rules": ["project"],
}
TARGET_COLS = {lvl: COMMON_COLS + LEVEL_EXTRA[lvl] for lvl in LEVELS}
# 缺失列的默认值（旧库早期 schema 可能缺列）
DEFAULTS = {
    "title": None, "content": "", "importance": 1, "keywords": "[]", "status": "active",
    "source_session": None, "hit_count": 0, "created_at": 0, "updated_at": 0,
    "last_accessed_at": None, "project": None, "subcategory": None, "goal": None,
    "corrected": 0,
}

DDL_LEVEL = {
    lvl: (
        f"CREATE TABLE IF NOT EXISTS {lvl} ("
        "id TEXT PRIMARY KEY, title TEXT, content TEXT NOT NULL, "
        "importance INTEGER NOT NULL DEFAULT 1, keywords TEXT NOT NULL DEFAULT '[]', "
        "status TEXT NOT NULL DEFAULT 'active', source_session TEXT, "
        "hit_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, "
        "updated_at INTEGER NOT NULL, last_accessed_at INTEGER"
        + ("".join(f", {c} TEXT" for c in LEVEL_EXTRA[lvl]))
        + ")"
    )
    for lvl in LEVELS
}
DDL_AUX = {
    "dream_log": (
        "CREATE TABLE IF NOT EXISTS dream_log (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "run_at INTEGER NOT NULL, summary TEXT, changes TEXT, note TEXT)"
    ),
    "windows": (
        "CREATE TABLE IF NOT EXISTS windows (session_id TEXT PRIMARY KEY, workspace TEXT, "
        "last_event_time INTEGER, last_dream_time INTEGER, dream_owner TEXT, "
        "dream_started_at INTEGER, dream_progress_at INTEGER, dream_group_idx INTEGER, dream_T INTEGER)"
    ),
    "dream_meta": "CREATE TABLE IF NOT EXISTS dream_meta (key TEXT PRIMARY KEY, value INTEGER)",
    "dream_skip": "CREATE TABLE IF NOT EXISTS dream_skip (session_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)",
    "session_state": (
        "CREATE TABLE IF NOT EXISTS session_state (session_id TEXT PRIMARY KEY, "
        "memory_enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL)"
    ),
}


def out(msg: str = "") -> None:
    print(msg)


def is_global(field) -> bool:
    if field is None:
        return False
    t = str(field).strip()
    return t in GLOBAL_MARKERS


def project_list(field):
    if not field or is_global(field):
        return []
    return [s.strip() for s in str(field).split(",") if s.strip()]


def table_exists(conn, name: str) -> bool:
    cur = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    )
    return cur.fetchone() is not None


def column_names(conn, table: str):
    return [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]


def ensure_central_schema(conn) -> None:
    """确保中央库存在全部表；soul/user 缺 project 列则补（v0.28 前旧中央库升级路径）。"""
    for ddl in DDL_LEVEL.values():
        conn.execute(ddl)
    for name, ddl in DDL_AUX.items():
        conn.execute(ddl)
    for lvl in ("soul", "user"):
        cols = column_names(conn, lvl)
        if "project" not in cols:
            conn.execute(f"ALTER TABLE {lvl} ADD COLUMN project TEXT")
    conn.commit()


def infer_soul_user_project(old) -> str | None:
    """旧库 project 层项目名集合：恰一个 → 打标；空/多 → 全局(None)。"""
    if not table_exists(old, "project"):
        return None
    try:
        rows = old.execute(
            "SELECT project FROM project WHERE project IS NOT NULL AND project != ''"
        ).fetchall()
    except sqlite3.Error:
        return None
    names = set()
    for (p,) in rows:
        names.update(n for n in project_list(p) if n)
    return names.pop() if len(names) == 1 else None


def count_rows(conn, table: str) -> int:
    if not table_exists(conn, table):
        return 0
    return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


def migrate_level(central, old, level: str, su_project) -> int:
    """把旧库一层记忆搬进中央库，返回搬移条数。"""
    if not table_exists(old, level):
        return 0
    cur = old.execute(f"SELECT * FROM {level}")
    rows = cur.fetchall()
    if not rows:
        return 0
    src_cols = [d[0] for d in cur.description]
    target = TARGET_COLS[level]
    keys = [c for c in target if c in src_cols]  # 旧库有的列才搬
    if level in ("soul", "user"):
        # 归属推断覆盖 project；旧库可能根本没有该列 → 单独处理
        if "project" in keys:
            keys.remove("project")
        placeholders = ", ".join("?" for _ in keys) + ", ?"
        sql = f"INSERT OR REPLACE INTO {level} ({', '.join(keys)}, project) VALUES ({placeholders})"
        n = 0
        for row in rows:
            rec = dict(zip(src_cols, row))
            vals = [rec.get(k, DEFAULTS.get(k)) for k in keys]
            try:
                central.execute(sql, vals + [su_project])
                n += 1
            except sqlite3.Error:
                pass  # 单行失败跳过（同插件行为）
        return n
    placeholders = ", ".join("?" for _ in keys)
    sql = f"INSERT OR REPLACE INTO {level} ({', '.join(keys)}) VALUES ({placeholders})"
    n = 0
    for row in rows:
        rec = dict(zip(src_cols, row))
        try:
            central.execute(sql, [rec.get(k, DEFAULTS.get(k)) for k in keys])
            n += 1
        except sqlite3.Error:
            pass
    return n


def migrate_aux(central, old) -> None:
    """辅助表合并：REPLACE 表按行 REPLACE；dream_meta 按行 IGNORE。"""
    for table in REPLACE_TABLES:
        if not table_exists(old, table):
            continue
        cur = old.execute(f"SELECT * FROM {table}")
        rows = cur.fetchall()
        if not rows:
            continue
        cols = [d[0] for d in cur.description]
        placeholders = ", ".join("?" for _ in cols)
        sql = f"INSERT OR REPLACE INTO {table} ({', '.join(cols)}) VALUES ({placeholders})"
        for row in rows:
            try:
                central.execute(sql, list(row))
            except sqlite3.Error:
                pass
    if table_exists(old, "dream_meta"):
        cur_m = old.execute("SELECT * FROM dream_meta")
        rows = cur_m.fetchall()
        if rows:
            cols = [d[0] for d in cur_m.description]
            placeholders = ", ".join("?" for _ in cols)
            sql = f"INSERT OR IGNORE INTO dream_meta ({', '.join(cols)}) VALUES ({placeholders})"
            for row in rows:
                try:
                    central.execute(sql, list(row))
                except sqlite3.Error:
                    pass


def migrate_sessions(ws: Path, src_dir: str, central_sessions: Path) -> int:
    src = ws / src_dir / "sessions"
    if not src.is_dir():
        return 0
    central_sessions.mkdir(parents=True, exist_ok=True)
    n = 0
    for f in sorted(src.glob("*.json")):
        try:
            shutil.copy2(f, central_sessions / f.name)
            f.unlink()
            n += 1
        except OSError:
            pass
    return n


def checkpoint_old_db(old_path: Path) -> None:
    """把 WAL 合入主文件（随后 rename 主文件为 .old 才完整）。"""
    try:
        conn = sqlite3.connect(str(old_path))
        try:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            conn.close()
    except sqlite3.Error:
        pass


def plan_workspace(ws: Path, src_dir: str) -> dict:
    """只读统计一个工作区的迁移计划（--dry-run 用）。"""
    old_path = ws / src_dir / "memory.db"
    plan = {
        "ws": ws,
        "old_path": old_path,
        "exists": old_path.exists(),
        "levels": {},
        "soul_user_project": None,
        "sessions": 0,
        "windows": 0,
    }
    if not plan["exists"]:
        return plan
    try:
        conn = sqlite3.connect(f"file:{old_path}?mode=ro", uri=True)
        try:
            plan["soul_user_project"] = infer_soul_user_project(conn)
            for lvl in LEVELS:
                plan["levels"][lvl] = count_rows(conn, lvl)
            plan["windows"] = count_rows(conn, "windows")
        finally:
            conn.close()
    except sqlite3.Error as e:
        plan["error"] = str(e)
    sess_dir = ws / src_dir / "sessions"
    if sess_dir.is_dir():
        plan["sessions"] = len(list(sess_dir.glob("*.json")))
    return plan


def discover_workspaces(window_index: Path, extra: list) -> list:
    """workspace 列表 = 显式参数 ∪ window-index.json 里的历史工作区（去重排序）。"""
    found = set(str(p).rstrip("/") for p in extra if p)
    if window_index is not None and window_index.exists():
        try:
            data = json.loads(window_index.read_text(encoding="utf-8"))
            for v in data.values():
                if isinstance(v, str) and v:
                    found.add(v.rstrip("/"))
        except (OSError, json.JSONDecodeError) as e:
            out(f"⚠ 读取 {window_index} 失败（{e}），仅用显式参数")
    return sorted(found)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="meow-memory v3 手动迁移：历史各工作区旧库 + sessions → 中央库",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("workspaces", nargs="*", help="项目根目录（不传则从 window-index.json 自动发现）")
    parser.add_argument(
        "--central", default=str(Path.home() / ".dsh-meow"),
        help="中央库目录（默认 ~/.dsh-meow；会写 <central>/memory.db 与 <central>/sessions/）",
    )
    parser.add_argument("--src-dir", default=".dsh-meow", help="旧库在哪个工作区子目录")
    parser.add_argument(
        "--window-index", default=str(Path.home() / ".dsh-meow" / "window-index.json"),
        help="window-index.json 路径（不传 workspace 时自动发现历史工作区；传空字符串禁用）",
    )
    parser.add_argument("--dry-run", action="store_true", help="只打印计划，不写任何文件")
    parser.add_argument("--yes", "-y", action="store_true", help="跳过交互确认")
    parser.add_argument("--force", action="store_true", help="即使中央库已标记迁移也重跑（重跑幂等）")
    args = parser.parse_args()

    central_dir = Path(args.central).expanduser()
    central_db = central_dir / "memory.db"
    central_sessions = central_dir / "sessions"

    workspaces = discover_workspaces(
        Path(args.window_index) if args.window_index else None, args.workspaces
    )
    if not workspaces:
        out("✗ 没有发现任何工作区：请显式传入项目根目录，或确认 window-index.json 存在")
        return 1

    out(f"══ meow-memory v3 中央迁移（{len(workspaces)} 个工作区） ══")
    out(f"旧库目录名 : ./{args.src_dir}/memory.db")
    out(f"中央库     : {central_db}")
    out(f"中央sessions: {central_sessions}")
    out()

    # 幂等门
    already_migrated = False
    if central_db.exists():
        try:
            conn = sqlite3.connect(str(central_db))
            try:
                if table_exists(conn, "dream_meta"):
                    row = conn.execute(
                        "SELECT value FROM dream_meta WHERE key=?", (MIGRATED_KEY,)
                    ).fetchone()
                    already_migrated = row is not None and int(row[0]) == 1
            finally:
                conn.close()
        except sqlite3.Error:
            pass
    if already_migrated and not args.force:
        out(f"ℹ 中央库已标记迁移（{MIGRATED_KEY}=1），跳过。--force 可强制重跑（重跑幂等）。")
        return 0

    # 逐个统计计划
    plans = []
    for ws in sorted(workspaces):
        plans.append(plan_workspace(Path(ws), args.src_dir))

    total_mem = 0
    total_sess = 0
    missing = 0
    for p in plans:
        tag = "✔" if p["exists"] else "—"
        out(f"{tag} {p['ws']}")
        out(f"    旧库: {p['old_path']}")
        if not p["exists"]:
            missing += 1
            out("    （无旧库，跳过）")
            continue
        if "error" in p:
            out(f"    ✗ 读取失败: {p['error']}（跳过，不 rename）")
            continue
        levels = p["levels"]
        mem_n = sum(levels.values())
        total_mem += mem_n
        total_sess += p["sessions"]
        su = p["soul_user_project"]
        out(
            f"    记忆 {mem_n} 条: " + " ".join(f"{l}={levels[l]}" for l in LEVELS if levels[l] > 0)
        )
        out(f"    soul/user 归属: {('打标 → ' + su) if su else '全局（project=null）'}"
            + (f"（来源 project 层项目: 推断）" if p["windows"] else ""))
        if p["sessions"]:
            out(f"    sessions 文件 {p['sessions']} 个 → {central_sessions}")
    out()
    out(f"合计: {len(plans) - missing} 个库待迁移，{total_mem} 条记忆，{total_sess} 个会话文件")
    if missing:
        out(f"（{missing} 个工作区没有旧库，自动跳过）")

    if args.dry_run:
        out()
        out("--dry-run：仅预览，未写任何文件。去掉该参数即真正执行。")
        return 0

    if not args.yes:
        try:
            ans = input("确认执行迁移？[y/N] ").strip().lower()
        except EOFError:
            ans = "n"
        if ans not in ("y", "yes"):
            out("已取消。")
            return 0

    # ── 真正执行 ──────────────────────────────────────────────────────────
    central_dir.mkdir(parents=True, exist_ok=True)
    central = sqlite3.connect(str(central_db), timeout=5000)
    central.execute("PRAGMA busy_timeout = 5000")
    try:
        ensure_central_schema(central)
        done_mem = 0
        done_sess = 0
        for p in plans:
            ws = p["ws"]
            old_path = p["old_path"]
            if not p["exists"] or "error" in p:
                continue
            out(f"→ {ws}")
            checkpoint_old_db(old_path)
            old = sqlite3.connect(str(old_path), timeout=5000)
            try:
                su = infer_soul_user_project(old)
                for lvl in LEVELS:
                    n = migrate_level(central, old, lvl, su)
                    done_mem += n
                    if n:
                        out(f"    {lvl}: +{n}")
                migrate_aux(central, old)
            finally:
                old.close()
            central.commit()
            # 迁完才备份：rename .old + 清 wal/shm
            backup = old_path.with_name(old_path.name + ".old")
            try:
                os.replace(str(old_path), str(backup))
                out(f"    旧库已备份 → {backup}")
            except OSError as e:
                out(f"    ⚠ rename 备份失败: {e}（旧库仍在原位，可手动处理）")
            for suffix in ("-wal", "-shm"):
                try:
                    (old_path.with_name(old_path.name + suffix)).unlink()
                except OSError:
                    pass
            n_sess = migrate_sessions(ws, args.src_dir, central_sessions)
            done_sess += n_sess
            if n_sess:
                out(f"    sessions: +{n_sess}")
        # 幂等门置位
        central.execute(
            "INSERT OR REPLACE INTO dream_meta (key, value) VALUES (?, ?)",
            (MIGRATED_KEY, 1),
        )
        central.commit()
    finally:
        central.close()

    out()
    out(f"✔ 迁移完成：{done_mem} 条记忆 + {done_sess} 个会话文件 → {central_db}")
    out("跨设备搬家：把 ~/.dsh-meow/memory.db 和 ~/.dsh-meow/sessions/ 拷到新机器即可。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
