# 历史数据迁移方案（旧逻辑名 → v2 派生 id）

> 2026-09-16 · 基于真实痕迹数据（`~/.dsh-meow/window-index.json` + `sessions/*.json` + `memory.db` 抽样）
> **状态：✅ 已执行**（2026-09-16 20:48，181 行，备份 `~/.dsh-meow/memory.db.bak-20260916-204858`）

## 一、为什么要迁移

v2 起 project 由工作区派生（git 地址 / 路径）。升级前写入的记忆用「模型编的逻辑名」（`dsh-meow-memory`、`azalea-video`…），升级后新写入走派生 id —— 双轨并存会让同一项目的记忆被检索/聚合时拆成两份。迁移 = 把旧逻辑名下的条目 project 字段改写为新派生 id。

**注意**：迁移脚本在 `main` 分支（v2 已提交为 `32d51df`）；当前工作区在 `release/v0.29.0`（无 v2）。执行迁移前需 `git checkout main`。

## 二、映射表（由真实痕迹推导）

| 旧逻辑名 | 条目数 | 迁移目标（新派生 id） | 依据 |
| --- | --- | --- | --- |
| `dsh-meow-memory` | 24 | `github.com/jcazalea/dsh-meow-memory` | 会话唯一工作区即该仓库 |
| `meow-memory` | 31 | `github.com/jcazalea/dsh-meow-memory` | 插件开发发生在 dsh-meow-memory 工作区（v2 语义收敛） |
| `hit-nis-ui` | 21 | `git01.yinhaiyun.com/JY23B01-YLYLYW-024/hit-nis-ui` | 唯一候选 |
| `hit-mobile-nurse-ui` | 3 | `git01.yinhaiyun.com/JY23B01-YLYLYW-024/hit-mobile-nurse-ui` | 唯一候选 |
| `azalea-video` | 61 | `111.112.113.230/azalea/azalea-video` | 内容抽样=azalea-video 项目本体 |
| `azalea` | 6 | `111.112.113.230/azalea/azalea-project` | 内容明确指向 azalea-project（.git origin 已核实） |
| `dsh` | 36 | `/home/azalea/.config/nvm/versions/node/v24.15.0/lib/node_modules/@deepseek-ai/dsh` | 无 git → 路径规则（本机 dsh 安装目录） |
| `ntfy` | 6 | 未标记 | 远端服务无本地路径（记忆保留、参与检索、不出面板） |
| `github.com/jcazalea/dsh-meow-memory` | 4 | 不动 | 已是新 id |

### dsh / ntfy 的处理（已拍板：按 v2 规则，不搞特例）

- `dsh`：无 git 工作区 → 走「无 git 用项目路径」规则，取本机 dsh 安装目录 `/home/azalea/.config/nvm/versions/node/v24.15.0/lib/node_modules/@deepseek-ai/dsh`（存在、无 .git，规则成立）。
- `ntfy`：公网服务运维，无本地项目路径 → 归未标记（记忆保留、参与检索、不出项目面板）。

## 三、迁移动作与语义

- 迁移 = `scripts/migrate-project-id.py`（一键脚本，`--dry-run`/`--yes`/自动在线备份 `memory.db.bak-<时间戳>`）：遍历七层表，project 字段按逗号拆分替换旧 token；未标记目标非 project 层写 NULL、project 层写 `''`（NOT NULL）；只改归属不删条目不合并内容，同名已存在 = 自然并到同一 id。
- 目标 id 下已有的条目不受影响（如 `github.com/jcazalea/dsh-meow-memory` 下 4 条保留）。
- 全部动作前自动在线备份（sqlite3 backup API 一致快照，含 WAL），可整体回滚。

## 四、执行结果（2026-09-16 20:48）

按映射表 8 项执行，共 181 行变更（副本先验证再真实执行）：

| 表 | 变更行数 |
| --- | --- |
| user | 6 |
| project | 78 |
| fact | 39 |
| lesson | 43 |
| topic | 12 |
| rules | 3 |

迁移后项目分布：`111.112.113.230/azalea/azalea-video` 61 · `github.com/jcazalea/dsh-meow-memory` 59 · dsh 路径 36 · `git01.yinhaiyun.com/JY23B01-YLYLYW-024/hit-nis-ui` 21 · 未标记 10 · azalea-project 6 · hit-mobile-nurse-ui 3 · 全局 2。旧逻辑名零残留。

回滚（如需）：停 `dsh web`，`~/.dsh-meow/memory.db.bak-20260916-204858` 覆盖回原库。

## 五、遗留提醒

- 迁移脚本在 `main` 分支（v2 已提交为 `32d51df`）；`docs/migration-plan.md` 与 `scripts/migrate-project-id.py` 需随 main 一并提交。
- 面板/会话锚定数据（sessions/<id>.json 的 currentProject）未迁移——历史会话的锚定还是旧名，仅影响该会话的压缩重注入展示，不阻塞。
