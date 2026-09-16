#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
meow-memory 项目归属审计：扫描会话痕迹，找出「锚定项目」与「工作区目录名」不符的会话。

背景：project 名是模型填的逻辑标签，库里没有 workspace→project 绑定（db.ts:733），
而 currentProject 锚定会话内粘性。若在 A 工作区把记忆贴到 B 项目标签下，A 之后读不到。
本脚本把 session 痕迹 join 起来，量化这种「疑似错归属」（v0.30 修复方案的兜底层）。

数据源（均只读）：
  ~/.dsh-meow/window-index.json   sessionId → 工作区路径
  ~/.dsh-meow/sessions/<id>.json  该会话的 injected/searched/written/currentProject
  ~/.dsh-meow/memory.db           已知项目名集合（复用 project-admin.py 的解析）

判定：
  ✓        锚定 == 目录名，或未锚定（尚未写记忆）
  ⚠ 高危   目录名本身是已知项目，却锚定到另一个项目 → 大概率贴错
  ⚡ 存疑   目录名不是已知项目（临时目录/新项目），锚定到某项目 → 跨项目工作或无从锚定

用法：
    python3 scripts/project-audit.py                 # 表格 + 汇总
    python3 scripts/project-audit.py --json          # 机器可读
    python3 scripts/project-audit.py --home /path    # 指定 ~/.dsh-meow 之外的位置

零依赖（仅 Python 标准库）；全程只读，不会写任何文件。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "project_admin", Path(__file__).resolve().parent / "project-admin.py"
)
pa = importlib.util.module_from_spec(_spec)
assert _spec and _spec.loader
_spec.loader.exec_module(pa)


def load_window_index(home: Path):
    p = home / "window-index.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text("utf-8"))
    except json.JSONDecodeError:
        print(f"错误：window-index.json 解析失败：{p}", file=sys.stderr)
        return {}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="project-audit.py",
        description="扫描会话痕迹，量化「锚定项目 vs 工作区目录名」不符的疑似错归属会话。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("用法：", 1)[-1].strip(),
    )
    ap.add_argument("--home", type=Path, default=None, help="中央数据目录（默认 ~/.dsh-meow）")
    ap.add_argument("--db", type=Path, default=None, help="记忆库路径（默认 ~/.dsh-meow/memory.db）")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    args = ap.parse_args(argv)

    home = (args.home or Path.home() / ".dsh-meow").expanduser()
    db_path = (args.db or pa.default_db()).expanduser()
    sessions_dir = home / "sessions"

    # 已知项目名集合
    known = set()
    if db_path.exists():
        conn = pa.connect(db_path)
        for table in pa.level_tables(conn):
            for row in conn.execute(f"SELECT project FROM {table}"):
                field = row["project"]
                if field is None or pa.is_global(field):
                    continue
                known.update(pa.parse_projects(field))
        conn.close()

    idx = load_window_index(home)
    rows = []
    if sessions_dir.is_dir():
        for f in sorted(sessions_dir.glob("*.json")):
            sid = f.stem
            ws = idx.get(sid)
            if not ws or not isinstance(ws, str):
                continue
            try:
                seen = json.loads(f.read_text("utf-8"))
            except json.JSONDecodeError:
                continue
            base = ws.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1] or ws
            anchor = seen.get("currentProject")
            written = len(seen.get("written") or [])
            if anchor is None or anchor == "":
                verdict, tag = "ok", "未锚定"
            elif anchor == base:
                verdict, tag = "ok", f"一致（{anchor}）"
            elif base in known:
                verdict, tag = "high", f"目录名「{base}」是已知项目，却锚定到「{anchor}」"
            else:
                verdict, tag = "sus", f"目录名「{base}」非已知项目，锚定到「{anchor}」"
            rows.append({"session": sid, "workspace": ws, "base": base, "anchor": anchor, "written": written, "verdict": verdict, "tag": tag})

    if args.json:
        print(json.dumps({"known_projects": sorted(known), "rows": rows, "total": len(rows)}, ensure_ascii=False, indent=2))
        return 0

    high = [r for r in rows if r["verdict"] == "high"]
    sus = [r for r in rows if r["verdict"] == "sus"]
    print(f"记忆库：{db_path}")
    print(f"已知项目（{len(known)} 个）：{' / '.join(sorted(known)) or '（无）'}")
    print(f"会话痕迹：{len(rows)} 条\n")
    if rows:
        print(f"{'判定':<4} {'写入':>4}  {'工作区目录名':<24} 锚定")
        print("-" * 72)
        for r in rows:
            mark = {"ok": "✓", "high": "⚠", "sus": "⚡"}[r["verdict"]]
            print(f"{mark:<4} {r['written']:>4}  {r['base']:<24} {r['tag']}")
    print()
    print(f"汇总：一致/未锚定 {len(rows) - len(high) - len(sus)}，⚠ 高危 {len(high)}，⚡ 存疑 {len(sus)}")
    if high:
        print("\n⚠ 高危会话的写入可能已贴到错误的项目名下；可查这些记忆并用")
        print("   python3 scripts/project-admin.py mv <anchor> <base>  迁移归属。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
