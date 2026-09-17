# 项目映射表设计（project registry）

> 2026-09-16 · 用户提议：「对于具体的项目，你应该有一张映射表，用于存储项目与 project 的关系，具体每张表中的 project 字段存储的是这个映射表的字段，这样对于可视化界面的展示也很友好呀」

## 一、要解决的问题

v2 后 project 字段存派生 id（git URL / 路径），展示层（面板/导引/星图）直接裸奔长字符串：

```
面板卡片:  github.com/jcazalea/dsh-meow-memory        ← 又长又不友好
导引:      当前项目：/home/azalea/.config/nvm/.../@deepseek-ai/dsh
```

缺一层「id ↔ 展示」的映射，导致：展示不可读、无法给项目起别名、id 变更（路径迁移）无承接结构。

## 二、映射表设计

```sql
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,   -- 稳定唯一标识 = 派生 id（git URL / 路径）
  display_name TEXT NOT NULL,      -- 展示名（面板/导引/星图用；自动生成，可改）
  kind         TEXT NOT NULL DEFAULT 'logical',  -- git | path | logical
  origin       TEXT,               -- 来源详情（git url / 路径）；id 变更时的新值落这里
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
)
```

七层记忆表的 `project` 列存 `projects.id`（外键语义，不强制 FK 约束以兼容全局/未标记）。「全局」/「未标记」**不建行**，维持字面量语义。

```
┌─────────────┐  project=id  ┌────────────────────────────┐
│ fact/lesson │─────────────▶│ projects(id, display_name) │
│ project/... │              │  github.com/jcazalea/…  →  │
│ (7 张表)     │              │  dsh-meow-memory           │
└─────────────┘              └────────────────────────────┘
                                     │ display_name
                                     ▼
                         面板 / 导引 / 星图 / 项目全景
```

## 三、display_name 自动生成规则

| id 形态 | display_name | 冲突处理 |
| --- | --- | --- |
| `github.com/jcazalea/dsh-meow-memory`（git） | repo 末段：`dsh-meow-memory` | 两个不同 owner 同名 repo → 自动加 owner 前缀：`jcazalea/dsh-meow-memory` |
| `/home/.../azalea-video`（path） | 目录末段：`azalea-video` | 同名目录 → 保留全路径作 id，display 加末两级 |
| 内网 git：`git01.yinhaiyun.com/JY23B01-YLYLYW-024/hit-nis-ui` | `hit-nis-ui` | 同上 |

用户可改（别名功能）：`project-admin.py rename <id> <新名>` → 只改 display_name，记忆条目不搬。

## 四、方案取舍：project 列存什么（核心拍板点）

**方案 A（推荐）：project 列 = 派生 id 本身（= 映射表主键）**
- 建表 + 把现存 8 个唯一 id 幂等注册进 projects 即可，**记忆表零改动**（刚迁移完 181 行，不重复搬）
- DB 里 project 列保持可读可审计（调试、project-admin.py、SQL 直查都友好）
- 未来路径迁移：映射表 `origin` 记录新值 → 记忆表一条 `UPDATE ... SET project=新id WHERE project=旧id` 即可，波及面可见
- 严格讲也满足「project 字段存储映射表的字段」——存的就是主键 id 字段

**方案 B：project 列 = 映射表短 key（p1/p2 或 hash）**
- 彻底解耦（id 变更零触碰记忆表），但：
  - 记忆表 project 列全部不可读，所有脚本/调试/手查都要 join 映射表
  - 需要把刚迁移完的历史值再换一遍（8 组 UPDATE，虽风险低但重复劳动）
  - v2「id 可读可审计」的价值被抹掉

**结论：推荐 A**——拿到你想要的全部收益（展示友好、别名、迁移口子、元数据），代价最小。

## 五、影响面（代码）

| 模块 | 改动 |
| --- | --- |
| db.ts | 建 `projects` 表；`registerProjects`（remember 写入时幂等 upsert + 自动生成 display_name）；`renameProject`；`displayNameOf`；`listProjectNames` 改为读 projects 表（保留未标记/全局过滤） |
| tools.ts | `memory_remember` 写入时注册映射行；`memory_project` 参数接受 id 或 display_name（解析到 id） |
| inject.ts | 导引「当前项目」与项目清单显示 display_name |
| viewer / 星图 | projectSummaries 与节点标签用 display_name |
| scripts | `project-admin.py ls` 显示 display_name + id；`rename` 子命令；`migrate-project-id.py` 迁移时顺带注册映射行 |
| test.mjs | 映射表注册/改名/展示断言 |

## 六、迁移步骤（现有库，方案 A）

1. 建 `projects` 表（`upgrade()` 幂等执行）
2. 从七层表收集唯一非空 project 值（排除 全局/未标记）→ 逐条 upsert（id=原值，display_name 自动生成）
3. 展示链路改走 display_name
4. 全部为增量，记忆数据零搬移

## 七、待拍板

1. **方案 A 还是 B**？（推荐 A：project 列=派生 id 主键）
2. display_name 自动生成规则（repo/目录末段 + 同名加前缀）OK？
3. 改名入口：先落 `project-admin.py rename`（脚本），面板写操作（Phase 4）后置，行不行？
4. 「全局/未标记」维持字面量不进映射表，OK？
