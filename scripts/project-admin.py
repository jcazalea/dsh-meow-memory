#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
meow-memory 项目管理脚本：查看 / 重命名 / 删除记忆面板里的「项目」。

背景（为什么需要这个脚本）：
  记忆面板里的「项目」不是一张独立的表，而是各层记忆条目 `project` 字段值聚合出来的投影
  （src/viewer/repository.ts projects() / src/client-viewer 仅只读渲染）。
  所以：
    · 没有「新建项目」操作 —— 写记忆时 memory_remember 传 project 名，它自动出现；
    · 没有「删除项目」按钮 —— 要让一个项目名从面板消失，只能改写引用它的那些条目的 project 字段。
  本脚本就是把这件事做成可重复执行的命令，自带备份与 --dry-run。

字段语义（与 src/db.ts projectList/isGlobalProject 完全一致）：
  project = NULL 或 ''  → 未标记（面板落进「未标记」桶，不再是独立项目）
  project = '全局'/'global' → 全局（跨项目注入，面板落进「全局」桶）
  project = 'a,b'        → 多归属（逗号分隔），删 a 时只从列表里摘掉 a，b 保留

零依赖：仅 Python 标准库（sqlite3 / pathlib / argparse）。

用法：

    # 1) 看当前有哪些项目、各多少条（面板里那份清单的来源）
    python3 scripts/project-admin.py ls

    # 2) 预览：把 foo 改名为 bar（不写任何文件）
    python3 scripts/project-admin.py mv foo bar --dry-run

    # 3) 真正执行改名（会先自动备份 memory.db）
    python3 scripts/project-admin.py mv foo bar --yes

    # 4) 删除项目：默认 = 摘掉标签 + 归档这些条目（面板立刻消失）
    python3 scripts/project-admin.py rm foo --yes

    # 5) 删除项目，但条目降级为「未标记」（保留 active，仍会被检索到）
    python3 scripts/project-admin.py rm foo --mode unlabel --yes

    # 6) 删除项目并归入「全局」
    python3 scripts/project-admin.py rm foo --mode global --yes

    # 7) 删除项目，连归档条目一起物理清理（危险，不可回退，需 --purge 二次确认）
    python3 scripts/project-admin.py rm foo --purge --yes

退出码：0 成功；1 用法/数据错误；2 库被占用或写入失败。
"""

from __future__ import annotations

import argparse
import os
import shutil
import sqlite3
import sys
import time
from pathlib import Path

LEVELS = ["soul", "user", "project", "fact", "lesson", "topic", "rules"]
GLOBAL_MARKERS = ("全局", "global")  # 与 db.ts isGlobalProject 口径一致（忽略大小写与首尾空白）


# ── 路径与工具 ──────────────────────────────────────────────────────────────

def default_db() -> Path:
    """中央库位置：$DSH_MEOW_HOME/memory.db，默认 ~/.dsh-meow/memory.db。"""
    home = os.environ.get("DSH_MEOW_HOME")
    base = Path(home).expanduser() if home else Path.home() / ".dsh-meow"
    return base / "memory.db"


def parse_projects(field) -> list[str]:
    """project 字段 → 项目名列表（与 db.ts projectList 一致）。"""
    if field is None:
        return []
    s = str(field)
    if is_global(s):
        return []
    return [p.strip() for p in s.split(",") if p.strip()]


def is_global(field) -> bool:
    if field is None:
        return False
    t = str(field).strip()
    return t.lower() in GLOBAL_MARKERS


def global_canon() -> str:
    return "全局"


def connect(db_path: Path) -> sqlite3.Connection:
    if not db_path.exists():
        sys.exit(f"错误：找不到记忆库 {db_path}\n（可用 --db 指定，或确认 dsh 已运行过一次以生成中央库）")
    conn = sqlite3.connect(f"file:{db_path}?mode=rw", uri=True, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def has_column(conn: sqlite3.Connection, table: str, column: str) -> bool:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(r["name"] == column for r in rows)


def level_tables(conn: sqlite3.Connection) -> list[str]:
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    return [t for t in LEVELS if t in names]


def backup(db_path: Path) -> Path:
    """备份主库（含 WAL 里的最新数据：先做一次 wal checkpoint 更稳，但只读连接做不到，
    改为直接 copy 主库 + -wal/-shm，保证 WAL 未合并时也能完整回退）。"""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dst = db_path.with_name(f"{db_path.name}.bak-{stamp}")
    n = 1
    while dst.exists():
        dst = db_path.with_name(f"{db_path.name}.bak-{stamp}-{n}")
        n += 1
    shutil.copy2(db_path, dst)
    for suffix in ("-wal", "-shm"):
        side = Path(str(db_path) + suffix)
        if side.exists():
            shutil.copy2(side, Path(str(dst) + suffix))
    return dst


def warn_if_running() -> None:
    try:
        import subprocess
        out = subprocess.run(["ps", "-eo", "args"], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return
    hits = [l for l in out.splitlines() if "dsh" in l and "web" in l and "ps -eo" not in l]
    if hits:
        print("⚠ 检测到 dsh web 可能正在运行：写库前请先停掉它（或确认当前无 dream/写入），")
        print("  否则可能与插件并发写、并让它内存里的旧视图覆盖你的修改。\n")


# ── ls ──────────────────────────────────────────────────────────────────────

def cmd_ls(conn: sqlite3.Connection, db_path: Path) -> int:
    from collections import defaultdict

    print(f"记忆库：{db_path}\n")
    agg = defaultdict(lambda: defaultdict(int))
    unlabeled = defaultdict(int)
    globalc = defaultdict(int)
    for table in level_tables(conn):
        for row in conn.execute(f"SELECT project, status FROM {table}"):
            field = row["project"]
            status = row["status"]
            if field is None or str(field).strip() == "":
                unlabeled[status] += 1
                continue
            if is_global(field):
                globalc[status] += 1
                continue
            for name in parse_projects(field):
                agg[name][status] += 1

    if not agg:
        print("（面板里没有任何项目：所有条目都是未标记或全局）")
    else:
        print(f"{'项目名':<28}{'总':>5}{'active':>8}{'stale':>7}{'archived':>10}")
        print("-" * 60)
        for name in sorted(agg, key=lambda k: -sum(agg[k].values())):
            c = agg[name]
            total = sum(c.values())
            print(f"{name:<28}{total:>5}{c.get('active', 0):>8}{c.get('stale', 0):>7}{c.get('archived', 0):>10}")
    print()
    for label, bucket in (("全局", globalc), ("未标记", unlabeled)):
        total = sum(bucket.values())
        detail = "，".join(f"{k}={v}" for k, v in sorted(bucket.items())) or "无"
        print(f"{label}：{total} 条（{detail}）")
    print("\n提示：同一项目名下 stale/archived 也计入面板，删除项目前无需先物理清理。")
    return 0


# ── 改写 project 字段 ───────────────────────────────────────────────────────

def replace_project(field, target: str, replacement):
    """把 field 里的 project 名 target 换成 replacement（'' = 摘除）。
    返回 (新值, 是否变化)。多归属条目只摘 target，其余保留。"""
    names = parse_projects(field)
    if target not in names:
        return field, False
    rest = [n for n in names if n != target]
    if replacement:
        rest.append(replacement)
    # 去重保序
    seen, out = set(), []
    for n in rest:
        if n not in seen:
            seen.add(n)
            out.append(n)
    # 注意：project 层表的 project 列是 NOT NULL，摘除只能写空串 ''；
    # 空串在 toDto / unlabeledCounts 中的语义就是「未标记」，与 NULL 等价。
    return ",".join(out), True


def collect(conn: sqlite3.Connection, target: str):
    """扫描所有层，返回 [(table, id, project, status)]。"""
    hits = []
    for table in level_tables(conn):
        for row in conn.execute(f"SELECT id, project, status FROM {table}"):
            if target in parse_projects(row["project"]):
                hits.append((table, row["id"], row["project"], row["status"]))
    return hits


def apply_project(conn: sqlite3.Connection, target: str, replacement, archive: bool, now: int) -> int:
    n = 0
    for table in level_tables(conn):
        for row in conn.execute(f"SELECT id, project FROM {table}"):
            new, changed = replace_project(row["project"], target, replacement)
            if not changed:
                continue
            if archive:
                conn.execute(
                    f"UPDATE {table} SET project = ?, status = CASE WHEN status='active' THEN 'archived' ELSE status END,"
                    " updated_at = ? WHERE id = ?",
                    (new, now, row["id"]),
                )
            else:
                conn.execute(f"UPDATE {table} SET project = ?, updated_at = ? WHERE id = ?", (new, now, row["id"]))
            n += 1
    return n


def purge(conn: sqlite3.Connection, target: str) -> int:
    """物理删除：只删「仅归属该项目且已非 active」的条目，避免误删多归属的活记忆。"""
    n = 0
    for table in level_tables(conn):
        for row in conn.execute(f"SELECT id, project, status FROM {table}"):
            names = parse_projects(row["project"])
            if len(names) != 1 or names[0] != target:
                continue
            if row["status"] == "active":
                continue
            conn.execute(f"DELETE FROM {table} WHERE id = ?", (row["id"],))
            n += 1
    return n


# ── mv / rm ─────────────────────────────────────────────────────────────────

def cmd_mv(args, conn, db_path) -> int:
    if args.old == args.new:
        sys.exit("错误：新旧项目名相同")
    hits = collect(conn, args.old)
    if not hits:
        sys.exit(f"错误：库里没有归属「{args.old}」的条目（先跑 ls 看看确切名字）")

    overlap = collect(conn, args.new)
    print(f"改名：{args.old} → {args.new}")
    print(f"  受影响条目：{len(hits)} 条" + ("（含非 active）" if any(h[3] != "active" for h in hits) else ""))
    if overlap:
        print(f"  ⚠ 目标名「{args.new}」已存在（{len(overlap)} 条），本次改名等价于合并两者")

    if args.dry_run:
        print("\n[dry-run] 未写入。去掉 --dry-run 即执行。")
        return 0
    if not args.yes and not confirm("确认改名？"):
        print("已取消。")
        return 1

    warn_if_running()
    dst = backup(db_path)
    now = int(time.time() * 1000)
    n = apply_project(conn, args.old, args.new, archive=False, now=now)
    conn.commit()
    print(f"✓ 已更新 {n} 条；备份：{dst}")
    return 0


def cmd_rm(args, conn, db_path) -> int:
    hits = collect(conn, args.target)
    if not hits and not args.purge:
        sys.exit(f"错误：库里没有归属「{args.target}」的条目（先跑 ls 看看确切名字）")

    active = sum(1 for h in hits if h[3] == "active")
    archived = len(hits) - active
    mode_desc = {
        "archive": "摘掉项目标签 + 归档该条目（面板立即消失；记忆仍留在库里可查）",
        "unlabel": "摘掉项目标签，条目降级为「未标记」（仍 active，仍会被检索/注入）",
        "global": "把项目标签换成「全局」（仍 active，且会跨项目注入）",
    }[args.mode]

    print(f"删除项目：{args.target}")
    print(f"  命中条目：{len(hits)} 条（active={active}，非 active={archived}）")
    print(f"  处理方式：{mode_desc}")
    if args.mode == "archive":
        print("  注：归档条目仍带旧项目名的历史字段会被一并改写，不需要二次清理。")
    if args.purge:
        print("  ⚠ --purge：执行后还会物理删除「仅归属该项目且非 active」的条目，不可回退（仅靠备份恢复）。")
    if args.dry_run:
        print("\n[dry-run] 未写入。去掉 --dry-run 即执行。")
        return 0
    if not args.yes and not confirm("确认删除该项目？"):
        print("已取消。")
        return 1

    warn_if_running()
    dst = backup(db_path)
    now = int(time.time() * 1000)
    replacement = global_canon() if args.mode == "global" else ""
    # purge 必须排在改写之前：改写会把 project 字段摘成 ''，之后就再也定位不到该项目了。
    removed = purge(conn, args.target) if args.purge else 0
    n = apply_project(conn, args.target, replacement, archive=(args.mode == "archive"), now=now)
    conn.commit()
    print(f"✓ 改写 {n} 条" + (f"，物理删除 {removed} 条" if args.purge else "") + f"；备份：{dst}")
    print("  刷新记忆面板即可看到项目消失（面板数据是实时读库的）。")
    return 0


def confirm(prompt: str) -> bool:
    try:
        return input(f"{prompt} [y/N] ").strip().lower() in ("y", "yes")
    except EOFError:
        return False


# ── CLI ─────────────────────────────────────────────────────────────────────

def cmd_rename(args, conn: sqlite3.Connection, db_path: Path) -> int:
    """项目别名（v0.30.1）：只改 projects 表 display_name，记忆归属不变。"""
    target, display = args.target, args.display
    has = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").fetchone()
    if not has:
        print("错误：该库尚无项目映射表（未运行 v0.30.1 升级，或库未被新版打开过）", file=sys.stderr)
        return 2
    row = conn.execute("SELECT display_name FROM projects WHERE id=?", (target,)).fetchone()
    if not row:
        print(f"错误：映射表里没有项目 id「{target}」（用 ls 看清单）", file=sys.stderr)
        return 2
    clash = conn.execute("SELECT id FROM projects WHERE display_name=? AND id!=?", (display, target)).fetchone()
    if clash:
        print(f"错误：展示名「{display}」已被项目「{clash[0]}」占用", file=sys.stderr)
        return 2
    print(f"将改展示名：{target}\n  {row[0]} → {display}\n（记忆归属不变；面板/导引/星图立即跟随）")
    if getattr(args, "dry_run", False):
        print("（--dry-run 预览，未修改）")
        return 0
    conn.execute("UPDATE projects SET display_name=?, updated_at=? WHERE id=?", (display, int(time.time() * 1000), target))
    conn.commit()
    print("✅ 已改名")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="project-admin.py",
        description="查看/重命名/删除 meow-memory 记忆面板里的项目（改写条目 project 字段）。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("用法：", 1)[-1].strip(),
    )
    ap.add_argument("--db", type=Path, default=None, help=f"记忆库路径（默认 {default_db()}）")
    ap.add_argument("--dry-run", action="store_true", help="只报告，不写任何文件")
    ap.add_argument("--yes", action="store_true", help="跳过交互确认")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add_common_flags(p, with_confirm=True):
        """让 --dry-run/--yes 在子命令前后都能写（SUPPRESS 保证不覆盖顶层已解析的值）。"""
        p.add_argument("--dry-run", action="store_true", default=argparse.SUPPRESS, help=argparse.SUPPRESS)
        if with_confirm:
            p.add_argument("--yes", action="store_true", default=argparse.SUPPRESS, help=argparse.SUPPRESS)

    add_common_flags(sub.add_parser("ls", help="列出所有项目及条目数"), with_confirm=False)

    p_mv = sub.add_parser("mv", help="重命名项目（等价于合并到目标名）")
    p_mv.add_argument("old")
    p_mv.add_argument("new")
    add_common_flags(p_mv)

    p_rm = sub.add_parser("rm", help="删除项目（从面板清单移除）")
    p_rm.add_argument("target")
    add_common_flags(p_rm)
    p_rm.add_argument("--mode", choices=["archive", "unlabel", "global"], default="archive",
                      help="archive=归档(默认) / unlabel=转未标记 / global=转全局")
    p_rm.add_argument("--purge", action="store_true", help="同时物理删除该项目下非 active 的条目")

    p_rename = sub.add_parser("rename", help="项目别名：只改展示名（display_name），记忆归属不变（v0.30.1 映射表）")
    p_rename.add_argument("target", help="项目 id（=记忆表 project 值；ls 可见）")
    p_rename.add_argument("display", help="新展示名")
    add_common_flags(p_rename)

    args = ap.parse_args(argv)
    db_path = (args.db or default_db()).expanduser()
    conn = connect(db_path)
    try:
        if args.cmd == "ls":
            return cmd_ls(conn, db_path)
        if args.cmd == "mv":
            return cmd_mv(args, conn, db_path)
        if args.cmd == "rm":
            return cmd_rm(args, conn, db_path)
        if args.cmd == "rename":
            return cmd_rename(args, conn, db_path)
        return 1
    except sqlite3.OperationalError as e:
        print(f"错误：写库失败（{e}）——若 dsh web 正在运行，请先停掉再执行。", file=sys.stderr)
        return 2
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
