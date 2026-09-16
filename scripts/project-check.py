#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
meow-memory 项目归属诊断：写入前校验「我要写的 project 名」是否真实存在、是否和当前工作区对得上。

背景（为什么需要它）：
  project 名是模型自己填的**逻辑标签**，库里没有 workspace→project 绑定（db.ts:733
  明确「记忆隔离靠 project 名，不靠物理路径」）。而 tools.ts 的 memory_remember 只校验
  project 非空、不校验存在性；首轮导引用 db.listProjectNames() 列的是**全库**项目名
  （inject.ts:288），不含"当前是哪个项目"。于是存在两个真实缺口：
    ① 贴错项目名 → 记忆进了别的项目，A 再也读不到（且 currentProject 锚定粘性，整条会话都歪）；
    ② 拼错/凭空造名 → 新造一个假项目，静默发生（memory_project 对不存在的名字返回 null 但不报错）。
  本脚本就是写入前的那道人工校验：查名字是否存在、和 cwd 目录名是否一致。

零依赖（仅 Python 标准库）。用法：

    # 0) 先看当前库的真实项目清单（写入前对照）
    python3 scripts/project-admin.py ls

    # 1) 校验一个名字是否存在（模糊匹配会提示"你是不是想写 xxx"）
    python3 scripts/project-check.py dsh-meow-memory

    # 2) 带上当前工作区一起校验（推荐：能发现"目录名和项目名不符"的贴错风险）
    python3 scripts/project-check.py dsh-meow-memory --workspace /home/azalea/WorkSpace/azalea-git/dsh-meow-memory

    # 3) 批量校验多个候选名
    python3 scripts/project-check.py azalea dsh ntfy meow-memory

退出码：0 全部存在；1 有名字不存在或明显不匹配（可当 CI/写入前门禁用）。
"""

from __future__ import annotations

import argparse
import importlib.util
import sys
from difflib import get_close_matches
from pathlib import Path

# 直接复用 project-admin.py 的实现（同目录、同口径），避免两套逻辑漂移。
_spec = importlib.util.spec_from_file_location(
    "project_admin", Path(__file__).resolve().parent / "project-admin.py"
)
pa = importlib.util.module_from_spec(_spec)
assert _spec and _spec.loader
_spec.loader.exec_module(pa)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="project-check.py",
        description="写入前校验 project 名是否存在、与当前工作区是否对得上。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("用法：", 1)[-1].strip(),
    )
    ap.add_argument("names", nargs="+", help="要校验的 project 名（可多个）")
    ap.add_argument("--db", type=Path, default=None, help=f"记忆库路径（默认 {pa.default_db()}）")
    ap.add_argument("--workspace", type=Path, default=None,
                    help="当前会话工作区路径；提供后会比对目录名与项目名")
    args = ap.parse_args(argv)

    db_path = (args.db or pa.default_db()).expanduser()
    conn = pa.connect(db_path)

    known = set()
    for table in pa.level_tables(conn):
        for row in conn.execute(f"SELECT project FROM {table}"):
            field = row["project"]
            if field is None or pa.is_global(field):
                continue
            known.update(pa.parse_projects(field))

    ws_dir = args.workspace.expanduser().name if args.workspace else None
    ok = True
    print(f"记忆库：{db_path}")
    print(f"已知项目（{len(known)} 个）：{' / '.join(sorted(known))}\n")
    if ws_dir:
        print(f"当前工作区目录名：{ws_dir}\n")

    for name in args.names:
        if name in known:
            print(f"✓ {name} —— 存在")
            if ws_dir and name != ws_dir:
                print(f"  ⚠ 但与当前工作区目录名「{ws_dir}」不同：确认这条记忆真的属于 {name}，"
                      f"否则 {ws_dir} 之后读不到它")
                # 目录名本身是否为已知项目
                if ws_dir in known:
                    print(f"  ↳ 提示：目录名「{ws_dir}」本身是已知项目，写错锚定会把整条会话带偏")
        else:
            ok = False
            close = get_close_matches(name, sorted(known), n=3, cutoff=0.6)
            print(f"✗ {name} —— 不存在（写下去会新建一个『假项目』）")
            if close:
                print(f"  ↳ 你是不是想写：{' / '.join(close)}")
    conn.close()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
