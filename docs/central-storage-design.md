# meow-memory 中央存储设计方案（v3，已按实测修正 + 用户拍板）

> v1 版曾提议：①每个记忆表加 `workspace TEXT` 物理路径列；②`storageMode` 双模式（central/project）。
> **实测后推翻**：记忆的隔离维度本就是 project 名（逻辑），不是 workspace 物理路径；加物理路径列换电脑路径一变即失效，正好破坏跨设备目标；双模式徒增双份测试矩阵与长期维护。
> v2 起修正：**不加 workspace 列、不做双模式**，直接中央库 + 一次性自动迁移。
> **v3（用户拍板）**：七层记忆（含 soul/user）**统一以 project 名为隔离/归属维度**——不再把 soul/user「去重合并成一份全局」，而是按项目拆分归属。

## 1. 背景与问题

### 当前架构
```
项目A/                     项目B/
└── .dsh-meow/             └── .dsh-meow/
    ├── memory.db              ├── memory.db     # 各自独立的记忆库
    └── sessions/              └── sessions/
        └── <sid>.json             └── <sid>.json
```

### 问题
- **跨设备不可用**：`.dsh-meow/` 已被 gitignore（README 已确认），clone 项目记忆不跟随；换电脑要逐个项目复制 `.dsh-meow` 目录。
- **备份分散**：记忆散落在 N 个项目的隐藏目录里，无从统一备份。
- **soul/user 冗余且无法跨项目隔离**：当前 soul/user 无 project 归属、每 session 全量注入，多工作区库里重复拷贝、且无法表达「某项目特有的用户/AI 信息」。

### 用户拍板（2026-09-14）
1. 跨设备场景 = **搬家/备份式迁移**：复制一个文件到新电脑即可，**不要**多设备自动双向同步（那需 git/Syncthing 等，不在本方案内）。
2. viewer 三层视图 = **按 project 聚合**（工作区维度改为项目维度）。
3. soul/user 及七层 = **统一按项目拆分归属**（不是合并成全局）。
4. 「搬家」**不做打包命令**：README 写一行备份说明（复制 memory.db + sessions/）即可。

## 2. 实测关键发现（支撑本方案）

1. **记忆隔离维度是 project 名，不是 workspace**：当前库全部带 project 列的记忆归属非空（project_null=0），项目名全局唯一（`dsh / dsh-meow-memory / meow-memory / 全局`）。
2. **检索/注入层已按 project 语义工作**：`hitQuery` 过滤条件为 `r.project === null || isGlobalProject(r.project) || projectCovers(r.project, currentProject)`——完全不看 workspace；`memory_project`、`list('project', {project})` 同理。
3. **soul/user 目前无 project 归属、全量注入**（`buildInjectionBody` 里 `db.list('soul')` / `db.list('user')` 不按项目过滤）——这是本次要改成「按项目分」的点：加归属列 + 注入改为「全局 + 当前锚定项目」。
4. **历史**：本项目 2026-09-08 前曾用 homedir 中央目录 `~/.dsh-meow/memory/<workspace>/` 存库（残留仍在），后改为项目内目录——"homedir 中央"是本项目踩过又放弃的方向，放弃原因可能与当前跨设备需求无关，但需知晓。

## 3. 设计目标

1. **单一数据库**：所有项目记忆存一个 SQLite 库。
2. **跨设备友好**：复制 `~/.dsh-meow/memory.db`（+`sessions/`）一个文件即完成搬家。
3. **手动迁移**（v0.29.1 起）：不再自动合并——查看器面板「迁移旧库」手动选库并入；旧库留 `.old` 备份可回退（避免自动迁移在旧库已改名时静默漏迁）。
4. **七层按项目隔离**：soul/user 也获得 project 归属，注入不再全量串项目。
5. **不动检索语义**：现有按 project 过滤的命中/工具层行为保持不变。

## 4. 架构设计

### 4.1 数据库位置
```
~/.dsh-meow/                       # 已有 perf.log / window-index.json / prompts/
├── memory.db                      # 中央记忆数据库（所有项目，node:sqlite）
├── sessions/                      # 会话已见记录（按 sessionId，全局唯一）
│   └── <sessionId>.json
└── (各工作区) .dsh-meow/memory.db.old   # 旧库原位改名备份（首次迁移后）
```

### 4.2 数据结构：不加 workspace 列；soul/user 加 project 列
- **不加 workspace（物理路径）列**：跨设备路径变即失效，与 v1 已否方案一致。
- **soul/user 表加 `project TEXT` 列（可空 = 全局）**：让七层统一以 project 为归属维度。
  - `project = null`（全局）：通用信息（如「用户用中文交流」「方案要带图」）——跨项目注入。
  - `project = <名>`：该项目特有的信息（如「用户开发 NIS 护理系统前端 hit-nis-ui」）——只注入该项目会话。
- project/fact/lesson/topic/rules 维持现有 schema（已有 project 列）。
- `windows` 表保留 workspace 列：运行时数据（session→工作区映射，dream 判定用），非记忆归属，跨设备后自然重建。
- `session_state`（会话级记忆开关）本就按 sessionId 全局唯一，直接搬。
- `sessions/<id>.json` 移到 `~/.dsh-meow/sessions/`：会话级数据，按 sessionId 天然唯一。

### 4.3 getDb 改造（核心，~40 行）
- **缓存键从 workspace 改为库文件路径**：所有 workspace 共用同一中央库实例。
- `getDb(workspace, dir)` 签名**不变**：调用方零改动，仅函数内部把路径解析为中央库。
- `getCentralDbPath(dir)`：`dir` 为绝对路径时直接用 `dir/memory.db`（测试隔离用）；否则 `join(homedir(), dir, 'memory.db')`（默认 `~/.dsh-meow/memory.db`）。

### 4.4 注入语义调整（inject.ts，~30 行）
- soul/user 注入：从「全量」改为「**project=null（全局）∪ 当前锚定 project**」（与 hitQuery 同口径）。
- 首轮无锚定项目 → 注入全局 soul/user；命中/memory_project 锚定后 → 该项目的 soul/user 才注入。

## 5. 迁移策略（新增 migrate-central.ts，~200 行）

**触发**：v0.29.0 曾为插件启动时自动合并（window-index.json ∪ workspaceRegistry 扫描，幂等门 `getMeta('migrated_v3')`）；**v0.29.1 起移除自动触发**——改为查看器面板「迁移旧库」手动选库（POST `/meow-memory/api/migrate-old` → `migrateLegacyPath`），也可用脚本 `scripts/migrate-central.py`。`migrateToCentral`/`migrateLegacyPath` 保留导出供测试/脚本调用；`migrateLegacyPath` 不受幂等门限制（用户显式选库，INSERT OR REPLACE 幂等可随时再并）。

**合并规则**：
| 数据 | 处理 |
|------|------|
| soul/user | **不合并去重**；按来源库归属推断（见下）搬入中央库，保留原 id |
| project 层 + 带 project 的 fact/lesson/topic/rules | 按 project 名 + id 直接搬移（id=base36 毫秒+随机，全局唯一不冲突） |
| 未标记（project=null）的 fact/lesson | 搬移为全局条目（remember 强制 project，此类极少） |
| windows / dream_log / dream_meta / dream_skip / session_state | 合并重建（windows 按 session_id 主键，天然不冲突） |

**soul/user 归属推断规则**：
- 取来源库「project 层记忆的项目名集合」（排除全局标记）。
- 集合恰好一个项目名 → 该库的 soul/user 打该项目标签。
- 集合为空或多个 → 视为全局（project=null）。
- 例：hit-nis-ui 库只有 `hit-nis-ui` 一个项目记忆 → 它的 user 归 hit-nis-ui；dsh-meow-memory 库有 dsh/meow-memory/dsh-meow-memory 三个 → 它的 user 视为全局。

**安全**：
- 每个旧库迁完重命名为 `<workspace>.memory.db.old`（不删除），保留完整回退路径。
- 迁移失败不中断：单库损坏跳过并记日志，其余照常。

**sessions 文件**：旧 `<workspace>/.dsh-meow/sessions/*.json` 全部移到 `~/.dsh-meow/sessions/`（sessionId 唯一，无冲突）。

## 6. 各层适配

| 模块 | 改动 | 量级 |
|------|------|------|
| `db.ts` | getDb 指向中央库 + 缓存键改文件路径 + soul/user 加 project 列 + getCentralDbPath/getCentralSessionsDir/getMeta/rawAll/rawExec | ~80 行 |
| 新增 `migrate-central.ts` | 合并/归属推断/备份/幂等门 + `migrateLegacyPath`（面板手动迁移入口，支持文件/库目录/项目根，.old 冲突避让） | ~340 行 |
| `inject.ts` | sessionsFile 移到中央目录 + soul/user 注入按 projectInScope 过滤 | ~50 行 |
| `dream-signal.ts` | collectDreamStates 直接读中央库 windows | ~30 行 |
| `index.ts` | ~~启动自动迁移~~（v0.29.1 移除）+ skip-dreams 走中央库 + re-export migrateLegacyPath | ~5 行 |
| `viewer` | repository 读中央库 + 白名单保留 + aggregate 按 reader 去重 | ~60 行（后端已完成） |
| **前端 `client-viewer`** | 三层视图 workspace→project 维度 + 面板「迁移旧库」输入/按钮/结果 | ~150 行（已完成） |
| **合计** | | **~600 行** |

> 命中/工具层（tools.ts、hitQuery/buildInjection/memory_project）：**零改动**，已按 project 语义工作。

### viewer 调整（已拍板：按 project 聚合）
- 三层视图 `全局 / 工作区 / 星图` → `全局 / 项目 / 星图`。
- 总览页「工作区卡片」→「项目卡片」（数据源复用 `aggregate.projectSummaries()`，已存在）。
- KPI：`workspaces`/`withDb` → `projects` 计数。
- **后端已落地（repository 只读中央库、overview 按 reader 去重、白名单保留作安全语义）**；前端标签/卡片改项目维度为后续迭代。

## 7. 边界澄清（重要）

- 本方案解决：**换电脑 = 复制 `~/.dsh-meow/memory.db` + `sessions/`**（搬家/备份式迁移）。
- 本方案**不解决**：多设备自动双向同步（两台电脑同时干活自动合并）——那需 git/Syncthing/iCloud 等外部同步，属后续独立话题。
- 跨设备后 workspace 绝对路径不同：`windows` 表等运行时数据在新设备重建，不影响记忆本身（记忆按 project 名归属，路径无关）。

## 8. 风险与对策

| 风险 | 对策 |
|------|------|
| 多实例并发写同一中央库的锁竞争（现各库独立无竞争） | WAL + busy_timeout=5000 已有兜底；**实现后必须实测**多工作区并发写 |
| soul/user 归属推断可能标错 | 推断规则保守：唯一项目才打标，多/空一律全局；迁移不丢数据 |
| 注入语义变化（soul/user 从全量→按项目） | 全局信息（project=null）仍全量注入不受影响；项目特定信息才按锚定过滤 |
| 中央库损坏影响所有工作区（现单库损坏只影响自己） | 迁移留 `.old` 备份；README 建议定期复制 homedir 库 |
| 迁移过程崩溃 | 逐个库迁、每库迁完才重命名备份，中断可续跑 |

## 9. 测试用例

1. 新安装（无旧数据）直接使用中央库。
2. 手动迁移（POST /migrate-old）：文件/库目录/项目根三种路径、soul/user 归属推断（单项目库打标、多项目库全局）、.old 备份、缺 path 400、GET 405、重复迁移 no-old-db。
3. 迁移后旧库 `.old` 保留，可手动回退。
4. 多工作区并发读写同一中央库（实测锁竞争）。
5. 注入语义：项目特定 user 只在锚定该项目时注入，全局 user 始终注入。
6. 迁移失败（损坏库）不中断其余合并、不损坏旧数据。
