#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v2 项目 id 迁移脚本：把旧逻辑名（模型编的标签）批量改写为 v2 派生 id（git 地址/路径）。

规则（用户拍板 2026-09-16「按照新的规则进行迁移」）：
  - 有 git 工作区的旧名 → 归一化 remote origin URL（如 azalea-video → 111.112.113.230/azalea/azalea-video）
  - 无 git 但有本机项目路径 → 规范化绝对路径（如 dsh → nvm 全局安装目录）
  - 无工作区可派生的（如远端服务 ntfy）→ 归未标记（记忆保留、参与检索、不出项目面板）

语义：
  - 只改写 project 归属字段，不删条目不合并内容（同名已存在 = 自然并到同一 id，安全）
  - 多归属（a,b）里的旧 token 单独替换，替换后去重保序
  - 未标记目标：非 project 层写 NULL；project 层列 NOT NULL → 写空串 ''（语义=未标记）
  - 执行前自动在线备份：memory.db.bak-<时间戳>（sqlite3 backup API，含 WAL 一致快照）

用法：
  python3 scripts/migrate-project-id.py --dry-run            # 预览（不改库）
  python3 scripts/migrate-project-id.py --yes                # 执行（自动备份）
  python3 scripts/migrate-project-id.py --map 'a=b,c='       # 覆盖/追加映射（c= 表示 c → 未标记）
  python3 scripts/migrate-project-id.py --db /path/to.db     # 指定库（默认 ~/.dsh-meow/memory.db）
  python3 scripts/migrate-project-id.py --no-dsh-path        # dsh 不用 nvm 路径，改归未标记
"""

import argparse
import os
import sqlite3
import sys
import time

HOME = os.path.expanduser('~')
DEFAULT_DB = os.path.join(HOME, '.dsh-meow', 'memory.db')
TABLES = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']
DSH_PATH = '/home/azalea/.config/nvm/versions/node/v24.15.0/lib/node_modules/@deepseek-ai/dsh'

# 默认映射（由真实痕迹 window-index + sessions + 内容抽样推导，2026-09-16）
DEFAULT_MAP = {
    'dsh-meow-memory': 'github.com/jcazalea/dsh-meow-memory',
    'meow-memory': 'github.com/jcazalea/dsh-meow-memory',
    'hit-nis-ui': 'git01.yinhaiyun.com/JY23B01-YLYLYW-024/hit-nis-ui',
    'hit-mobile-nurse-ui': 'git01.yinhaiyun.com/JY23B01-YLYLYW-024/hit-mobile-nurse-ui',
    'azalea-video': '111.112.113.230/azalea/azalea-video',
    'azalea': '111.112.113.230/azalea/azalea-project',
    'dsh': DSH_PATH,
    'ntfy': '',  # 未标记
}


def rewrite_project(project, old, new):
    """project 字段按逗号拆分，替换 ==old 的 token；new 为空 = 摘标签。返回新字段值（None=未标记）。"""
    if project is None:
        return None
    parts = [p.strip() for p in str(project).split(',') if p.strip()]
    out = []
    for p in parts:
        if p == old:
            if new:
                out.append(new)
        else:
            out.append(p)
    seen, res = set(), []
    for p in out:
        if p not in seen:
            seen.add(p)
            res.append(p)
    return ','.join(res) if res else None


def collect_stats(conn, mapping):
    """统计每张表受影响行数（不修改）。"""
    stats = {}
    for table in TABLES:
        rows = conn.execute(f'SELECT rowid, project FROM {table}').fetchall()
        changed = 0
        for rowid, project in rows:
            if project is None:
                continue
            orig = str(project)
            rewritten = orig
            for old, new in mapping.items():
                rewritten = rewrite_project(rewritten, old, new)
            if rewritten is not None and rewritten != orig:
                changed += 1
        stats[table] = changed
    return stats


def apply_migration(conn, mapping):
    """执行迁移（调用方负责备份）。返回每表变更行数。"""
    total = 0
    for table in TABLES:
        rows = conn.execute(f'SELECT rowid, project FROM {table}').fetchall()
        n = 0
        for rowid, project in rows:
            if project is None:
                continue
            orig = str(project)
            rewritten = orig
            for old, new in mapping.items():
                rewritten = rewrite_project(rewritten, old, new)
            if rewritten == orig:
                continue
            if rewritten is None:
                # 未标记：project 层 NOT NULL → 写 ''，其余层 NULL
                value = '' if table == 'project' else None
                conn.execute(f'UPDATE {table} SET project=? WHERE rowid=?', (value, rowid))
            else:
                conn.execute(f'UPDATE {table} SET project=? WHERE rowid=?', (rewritten, rowid))
            n += 1
        total += n
        if n:
            print(f'  {table}: {n} 行')
    return total


def backup_db(path):
    """在线一致性备份（sqlite3 backup API，含 WAL）。返回备份路径。"""
    ts = time.strftime('%Y%m%d-%H%M%S')
    bak = f'{path}.bak-{ts}'
    src = sqlite3.connect(path)
    dst = sqlite3.connect(bak)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    print(f'✅ 已备份 → {bak}')
    return bak


def main():
    ap = argparse.ArgumentParser(description='v2 项目 id 迁移（旧逻辑名 → 派生 id）')
    ap.add_argument('--db', default=DEFAULT_DB, help=f'SQLite 库路径（默认 {DEFAULT_DB}）')
    ap.add_argument('--dry-run', action='store_true', help='只预览，不改库')
    ap.add_argument('--yes', action='store_true', help='确认执行（自动备份后写入）')
    ap.add_argument('--map', default='', help='覆盖/追加映射：旧=新,旧=新（新为空 = 归未标记）')
    ap.add_argument('--no-dsh-path', action='store_true', help='dsh 不用 nvm 路径，改归未标记')
    args = ap.parse_args()

    if not os.path.exists(args.db):
        sys.exit(f'错误：库不存在 {args.db}')
    if args.map:
        overrides = {}
        for pair in args.map.split(','):
            if '=' not in pair:
                sys.exit(f'--map 格式错误（缺 =）：{pair}')
            k, v = pair.split('=', 1)
            overrides[k.strip()] = v.strip()
        DEFAULT_MAP.update(overrides)

    mapping = dict(DEFAULT_MAP)
    if args.no_dsh_path:
        mapping['dsh'] = ''

    conn = sqlite3.connect(f'file:{args.db}?mode=ro', uri=True)
    conn.execute('PRAGMA busy_timeout = 5000')
    print(f'库：{args.db}')
    print('映射：')
    for old, new in mapping.items():
        print(f'  {old}  →  {new if new else "(未标记)"}')
    stats = collect_stats(conn, mapping)
    conn.close()
    total = sum(stats.values())
    print(f'\n将变更 {total} 行（按表）：')
    for t, n in stats.items():
        if n:
            print(f'  {t}: {n}')
    if total == 0:
        print('没有需要迁移的条目。')
        return
    if args.dry_run:
        print('\n（--dry-run 预览，未做任何修改）')
        return
    if not args.yes:
        sys.exit('\n这是真实库，需要 --yes 才执行（执行前自动备份）。先用 --dry-run 预览。')

    print('\n执行迁移…')
    backup_db(args.db)
    conn = sqlite3.connect(args.db)
    conn.execute('PRAGMA busy_timeout = 5000')
    try:
        conn.execute('BEGIN')
        n = apply_migration(conn, mapping)
        conn.commit()
        print(f'✅ 迁移完成，共 {n} 行。')
    except Exception as e:
        conn.rollback()
        sys.exit(f'❌ 迁移失败，已回滚：{e}')
    finally:
        conn.close()


if __name__ == '__main__':
    main()
