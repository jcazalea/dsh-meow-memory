# 记忆查看器（Memory Viewer）设计方案

> 目标：给 meow-memory 补上一个**可视化记忆查看**能力 —— 能看全局、能看单个工作区，并在数据库现有关系支持范围内提供**星图**视图。
> 状态：**Phase 0–3 已实现**（v0.27.0，2026-09-13）。实现记录见文末「实现记录」；配图：`docs/mockups/*.png` / `*.svg`；可点原型：`docs/mockups/viewer.html`。

---

## 0. 一句话方案

**宿主侧新增一组只读 JSON API（跨工作区聚合 + 星图边计算），客户端新增一个"全局面板"承载三层视图（全局 / 工作区 / 星图）——零 dsh 本体改动，全部走 dsh 已公开的扩展点。**

```
┌─────────────────────────────── 浏览器（dsh web shell） ───────────────────────────────┐
│  侧栏「全局面板」图标 ──► main slot: meow-memory（我们注册的中央面板）                 │
│      │                                                                                │
│      └─ MemoryViewer App                                                              │
│           ├ ScopeBar   全局 / 工作区 / 星图                                            │
│           ├ GlobalView 跨工作区 KPI + 工作区卡片 + 跨库最近更新 + 全局条目             │
│           ├ WorkspaceView 项目树 + 记忆列表 + 详情抽屉 + 时间线/整理留痕               │
│           └ StarMapView  Canvas 星图（星座布局 / 力导向）                              │
└───────────────────────────────────┬───────────────────────────────────────────────────┘
                                    │ fetch（loopback，只读）
┌───────────────────────────────────▼───────────────────────────────────────────────────┐
│  宿主 meow-memory plugin（src/viewer/）                                                │
│   webServer prefix route  /meow-memory/api                                            │
│     ├ 白名单：workspaceRegistry.list().path ∪ windowIndex cwd                          │
│     ├ Repository：node:sqlite readOnly 打开各工作区 memory.db（LRU 缓存 + revision）   │
│     ├ Aggregate：全局聚合（KPI / per-level / per-workspace / 最近更新 / 全局条目）      │
│     └ Graph：星图节点与边（结构边 + 相似边(bm25) + 会话读写边 + 取代边）                │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. 需求拆解

| 编号 | 需求 | 落点 | 说明 |
|---|---|---|---|
| R1 | 查看**全局**情况 | `GlobalView` | 跨工作区聚合：有多少工作区/多少条记忆、各层分布、项目清单、最近更新、待整理窗口、归档量；以及各工作区里 `project="全局"` 的条目汇总 |
| R2 | 查看**某个工作区**情况 | `WorkspaceView` | 单库浏览：项目/子类分组、层级、状态、时间线、关键词检索、单条详情（原文 + 全量元数据 + 相似条目） |
| R3 | **星图**（在数据支持范围内） | `StarMapView` | 记忆↔项目↔会话↔相似/取代关系的关系图；支持按当前 scope（全局/工作区/项目）过滤 |
| R4（附带） | 不改 dsh 本体、不破坏现有纪律 | 全局 | 只读优先、fail-open、零新增运行时依赖、文案外置、双版本兼容 |

**非目标（v1 明确不做）**
- 不做写操作（编辑/删除/新建记忆）——写路径仍归 `memory_*` 工具；v2 再评估「受控写」（§10）。
- 不做跨工作区的记忆合并/搬迁（各库自治是现有语义）。
- 不做多用户/权限/云同步。
- 不做「记忆全文导出」以外的数据外流。

---

## 2. 可行性结论（有据可依）

### 2.1 宿主扩展点：dsh 客户端已提供现成的"挂载点"

dsh 0.1.5 客户端 bundle 内含一份**机器可读的 slot 契约目录**（`@deepseek-ai/dsh-cordis-client-runner` 的 `client.js`，共 69 个 slot）。与本方案相关的条目原文摘录：

| slot | kind / scope | 目录原文（关键句） | 用途 |
|---|---|---|---|
| `main` | `keyed` / `root` | "Central panel selected by sidebar entry id. The reserved `conversation` key hosts the Conversation; **other keys receive no Session binding**." | 我们的**主视图页面**（key = `meow-memory`） |
| `sidebar.panellist` | `list` / `root` | "Global panel icons. **Each list id addresses the matching main panel**; the sidebar owns the button and resolves its label from list metadata." | **入口图标**（id 与 main 的 key 同名即自动配对） |
| `sidebar.footer.action` | `list` / `root` | "Optional actions beside Settings at the sidebar foot." | 备用入口（侧栏底部按钮） |
| `shell.overlay` | `list` / `root` | "Frame-wide floating layer, above every column and outside their scroll containers. … The layer itself is click-through — entries opt back into pointer events." | **快速查看浮层**（点击聊天里的记忆 chip 弹出） |
| `settings.section` | `list` / `root` | "One settings page per list entry." | 已有能力（「喵记忆」标签页），可作**降级入口** |
| `conversation.session.header.actions` | `list` / `session` | "Title-adjacent Session actions in ascending order." | 会话头按钮（"看本会话记忆"） |

已经验证过的实现路径（同仓库 `src/client.ts` / `src/settings-page.ts` 的既有写法）：

```ts
// 主面板：key 与 panellist 的 id 相同，侧栏点图标 → 中央切到我们的面板
ctx.slots.inject('main', () => ctx.slots.register(
  { name: 'main', key: 'meow-memory' }, MemoryViewerApp))
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
  { name: 'sidebar.panellist', id: 'meow-memory', order: 20, label: () => '记忆' },
  () => React.createElement(MemoryGlyph)))
```

> 侧栏 `syncPanels()` 的实现确认了这条链路：它把 `sidebar.panellist` 的登记项读成 `{id, order, label}` 列表，点行调用 `ctx.layout.selectPanel(id)`，由 `main` slot 按同一个 key 派发。

### 2.2 数据面：跨工作区的权威来源已经存在

- **工作区清单**：`ctx.workspaceRegistry.list(): Workspace[]`，每个 `Workspace` 有 `id / path(realpath) / title / sessionIds / status()`。这是"全局视图"的权威来源（比现在插件用的 `windowIndex` 更全、更准）。
- **兜底来源**：`windowIndex`（sessionId→cwd，已在用）+ `sessionPersistence.list()`（含 cwd，已在用）。
- **路由能力**：`ctx.webServer.register({ kind: 'exact' | 'prefix', path, handler })`，handler 是原生 `node:http` 的 `(req, res)`，可自由返回 JSON/HTML/SSE（现有 `/meow-memory/dreamed-sessions` 等即此机制）。
- **只读打开（关键，已实测）**：

  | 实测项 | 结果 |
  |---|---|
  | `new DatabaseSync(path, { readOnly: true })` | ✅ 可读 |
  | readOnly 下写入 | ✅ 被拒：`attempt to write a readonly database` |
  | readOnly 打开**不存在**的库 | ✅ 直接抛错（`unable to open database file`）→ **天然不会给别的工作区误建记忆库** |
  | `PRAGMA data_version` | ✅ 可用于缓存失效判定 |

  ⚠️ 因此查看器**不能复用 `getDb()`**：那个入口会 `mkdirSync` + 建表 + 跑 `upgrade()`（写操作）。跨工作区读取必须走新的只读仓储（§4.4）。

### 2.3 星图可行性：**能画，但边分两类，必须诚实标注**

结论先行：

- ✅ **结构关系是真实存在的**（规范化字段，可靠）：`project`（含多值逗号）、`subcategory`、`source_session → windows`、`level`、`status`、`corrected`、`created_at/updated_at`、`dream_log`。
- ✅ **语义相似关系可以算**：`keywords` 字段（LLM 提取 / bigram）+ 现成的 `bm25.findSimilar()`（bigram 词频向量余弦）——只需阈值与每节点 top-K 剪枝。
- ✅ **"谁读过/写过哪条记忆"的关系存在，但在文件里不在库里**：`.dsh-meow/sessions/<id>.json` 的 `injected / searched / accessed / written / projectsQueried`。
- ❌ **没有声明式的记忆间链接**：表里没有任何 `links`/`refs` 列，`A → B` 的"引用"关系数据库**不提供**，只能推断。

所以星图的边分三类，UI 上必须可分辨、可开关（详见 §7）：

| 类别 | 边 | 来源 | 可靠性 |
|---|---|---|---|
| 结构边（默认开） | 记忆 → 项目、记忆 → 会话 | 直接来自字段 | 确定 |
| 计算边（默认开，剪枝） | 记忆 ↔ 记忆（相似）、旧条目 → 新条目（取代） | `bm25.findSimilar` / 同 level 高相似 + status 差异 | 概率性 |
| 痕迹边（默认开） | 会话 →（读/写）→ 记忆 | `sessions/*.json` | 确定（但只覆盖"记录还在"的窗口） |

> 如果后续想要"真正的知识图谱"（人工/模型显式声明 A 依赖 B），建议 v2 在表层加一个可选 `links` 列（JSON 数组存 id），由 `memory_remember` 的 `links` 参数写入 —— 那才是声明式边。本方案不假设它存在。

---

## 3. 架构与代码落点

```
src/
├── viewer/                      # 新增：宿主只读数据面（Node 侧）
│   ├── routes.ts                #   prefix 路由注册 + 内部分发 + 参数校验
│   ├── repository.ts            #   跨工作区只读仓储：白名单 / readOnly 打开 / LRU / revision
│   ├── aggregate.ts             #   全局聚合（KPI、per-level、per-workspace、最近更新、全局条目）
│   ├── graph.ts                 #   星图节点与边计算（复用 bm25.findSimilar）
│   ├── sessions.ts              #   sessions/<id>.json 痕迹汇总（读/写/检索关系）
│   ├── http.ts                  #   JSON 响应、ETag/304、分页、错误形状
│   └── types.ts                 #   传输契约（host/client 共用，纯类型）
├── client-viewer/               # 新增：浏览器视图（React，只有 react 是外部依赖）
│   ├── index.ts                 #   slots 挂载（main + sidebar.panellist [+ shell.overlay]）
│   ├── api.ts                   #   fetch 封装 + 轮询/刷新
│   ├── App.tsx                  #   ScopeBar + 视图路由（全局/工作区/星图）
│   ├── views/                   #   GlobalView / WorkspaceView / StarMapView
│   ├── components/              #   KpiCard / LevelBadge / MemoryCard / DetailDrawer / FilterBar / TimelineRow …
│   └── graph/                   #   layout.ts（星座/力导向，纯函数）/ render.ts（Canvas）/ hit.ts
├── index.ts                     # 改动：applyInner 里注册 viewer 路由（与现有路由同一套重试/dispose 逻辑）
└── client.ts                    # 改动：apply 里挂载 viewer 入口
```

**打包**：viewer 视图代码先进 `lib/client.js`（与现有折叠 UI 同一个 bundle）。若实测 `lib/client.js` 超过 ~400KB（未压缩），再把 `client-viewer` 拆成第二个入口 `lib/viewer.js`，由宿主路由 `/meow-memory/viewer.js` 提供、主 bundle 里 `import()` 动态加载（浏览器原生动态 import，宿主无需改动）。**Phase 0 第一件事就是量体积。**

**纪律（沿用现有代码风格）**
- 纯逻辑与 DOM 分层：布局/过滤/配色/解析全是纯函数 → 可单测（照 `src/client-fold.ts` 的模式）。
- 幂等：DOM/Canvas 操作只做存在性判断与差值写入（现有 `ensureAnchor` 的风格）。
- fail-open：视图拿不到数据只显示空态/错误态，绝不抛到宿主（宿主侧路由已有 try/catch 兜底）。
- 文案：客户端 UI 文案沿用现状（硬编码中文，官方 locale 字典无第三方席位）；服务端返回的**面向模型**的文案才走 `prompts/<lang>/`。

---

## 4. 宿主 API 设计

统一前缀 `/meow-memory/api`，一个 `prefix` 路由 + 内部按 `method + pathname` 分发（避免为每个端点各注册一条路由）。

### 4.1 端点表

| 方法 | 路径 | 参数 | 说明 |
|---|---|---|---|
| GET | `/meow-memory/api/context` | `sessionId?` | 会话 → 工作区解析（复用 `resolveWorkspaceForSession`），返回当前工作区 path/title + 该会话的已见/写过痕迹摘要 |
| GET | `/meow-memory/api/workspaces` | — | 工作区列表 + 每库摘要：`{path,title,hasDb,countsByLevel,total,projects,lastUpdatedAt,dream:{lastDreamAt,skipped,hasLease}},status` |
| GET | `/meow-memory/api/overview` | `recent=20` | 全局聚合：KPI、per-level、per-workspace、跨库最近更新、`project="全局"` 条目、最近 dream 留痕、健康检查项 |
| GET | `/meow-memory/api/memories` | `workspace`(必填), `level,status,project,q,days,importance,sort,limit,offset` | 列表 / 关键词检索（`q` 走 `bm25.search`）；返回原文 + 元数据 |
| GET | `/meow-memory/api/memory` | `workspace,id` | 单条全量（含 `source_session`、`hit_count`、`last_accessed_at`） |
| GET | `/meow-memory/api/projects` | `workspace` | 项目清单（含 `全局`/未标记桶）+ 每项目：层级分布、状态分布、最近更新时间 |
| GET | `/meow-memory/api/timeline` | `workspace,days,level` | 按 `updated_at` 的时间线（含 dream 封存点） |
| GET | `/meow-memory/api/dreams` | `workspace?,limit` | `dream_log` + `windows`（`last_event_time/last_dream_time` 租约）+ `dream_skip` |
| GET | `/meow-memory/api/sessions` | `workspace` | 会话↔记忆痕迹（读/写/检索/查阅）汇总，供星图的会话边与"本会话"视图 |
| GET | `/meow-memory/api/graph` | `scope=all\|workspace\|project`, `workspace?,project?,levels?,edges?,threshold=0.35,topK=3,limit=2000` | 星图 `{nodes, edges, stats}` |
| PATCH | `/meow-memory/api/memory` | body: `{workspace,id,patch,expectUpdatedAt}` | **v2 可选**：受控写（status/importance/keywords/project），乐观锁 |

### 4.2 响应形状

```jsonc
// GET /meow-memory/api/overview
{
  "ok": true,
  "data": {
    "kpi": { "workspaces": 6, "withDb": 5, "total": 1284, "newThisWeek": 63,
             "projects": 17, "stale": 91, "archived": 42, "pendingDream": 3 },
    "byLevel": { "soul": 3, "user": 12, "project": 310, "fact": 604, "lesson": 118, "topic": 87, "rules": 150 },
    "workspaces": [ { "path": "/…/dsh-meow-memory", "title": "dsh-meow-memory", "total": 214,
                      "lastUpdatedAt": 1789228373824, "dream": { "lastDreamAt": null, "skipped": false },
                      "countsByLevel": { "...": 0 } } ],
    "recent":    [ { "workspace": "dsh-meow-memory", "id": "0mtykdh9…", "level": "project",
                     "project": "dsh-meow-memory", "content": "…", "updatedAt": 1789228373824 } ],
    "globalEntries": [ { "workspace": "femwa", "id": "…", "level": "rules", "content": "…" } ],
    "health": { "noKeywords": 3, "staleTodo": 2, "possibleDuplicates": 5, "staleRules": 4 }
  },
  "meta": { "generatedAt": 1789228400000, "etag": "W/\"ov-6-1789228373824\"", "partial": [] }
}
```

```jsonc
// GET /meow-memory/api/graph?scope=workspace&workspace=/…/femwa&threshold=0.35&topK=3
{
  "ok": true,
  "data": {
    "nodes": [
      { "id": "m:0mtyk…", "type": "memory", "level": "fact", "project": "femwa",
        "title": "关键词…", "importance": 3, "status": "active",
        "updatedAt": 1789228373824, "degree": 4, "size": 7.2, "hub": "p:femwa" },
      { "id": "p:femwa",   "type": "project", "label": "femwa", "count": 96 },
      { "id": "s:session-cd1129…", "type": "session", "label": "cd11292b", "lastEventAt": 1789228300000 }
    ],
    "edges": [
      { "source": "m:0mtyk…", "target": "p:femwa", "type": "project", "weight": 1 },
      { "source": "m:0mtyk…", "target": "m:0mtykd…", "type": "similar", "weight": 0.61 },
      { "source": "s:session-cd1129…", "target": "m:0mtyk…", "type": "read", "weight": 2 },
      { "source": "m:OLD…", "target": "m:NEW…", "type": "supersede", "weight": 0.83 }
    ],
    "stats": { "nodes": 214, "edges": 612, "byType": { "project": 214, "similar": 318, "read": 64, "write": 16 },
               "truncated": false, "revision": "g-1789228373824" }
  }
}
```

**统一约定**：`{ ok, data?, error?: { code, message }, meta: { generatedAt, etag, partial: string[] } }`；`partial` 列出打开失败的工作区（单库坏了不拖垮全局视图）。错误码：`bad-request` / `not-allowlisted` / `no-db` / `not-found` / `read-only-violation`。

### 4.3 缓存与新鲜度

- 每库 `revision`：`PRAGMA data_version` + 各表 `COUNT(*)` + `MAX(updated_at)` 的组合哈希（轻量，一次请求内只算一次）。
- 全局 `etag`：各库 revision 的哈希。请求带 `If-None-Match` 且命中 → **304**（前端轮询几乎零成本）。
- 前端刷新策略：面板激活时拉一次 + 每 60s 轮询（复用现有 `client-dream-events.ts` 的全页共享轮询思路，避免多连接）；提供手动刷新按钮。
- 聚合的并发：跨库读取用 `Promise` 串行或小并发（默认 4），单库超时（如 300ms）就跳过并记入 `partial`。

### 4.4 只读仓储（新代码，不复用 `getDb`）

```ts
// src/viewer/repository.ts（设计示意）
interface WorkspaceHandle {
  path: string; title: string
  db: DatabaseSync | null      // readOnly 打开；无库/打不开 = null
  revision: string
  openedAt: number
}
const cache = new Map<string, WorkspaceHandle>()   // LRU，容量默认 16

function openReadOnly(path: string): DatabaseSync | null {
  if (!existsSync(join(path, projectDir, 'memory.db'))) return null   // 绝不新建
  return new DatabaseSync(join(path, projectDir, 'memory.db'), { readOnly: true })
}
```

- **白名单**：任何 `workspace` 参数必须命中 `allowedWorkspaces()`（`workspaceRegistry.list().path` ∪ `windowIndex` 的 cwd），命中前统一 `realpath` 归一化（Windows 盘符/大小写差异也走 `realpath`）。
- **不写不建**：readOnly + 存在性检查；连 `dream_skip` 之类的写操作也不在此路径做。
- **句柄回收**：`ctx.on('dispose')` 里关闭 viewer 仓储的全部句柄（与既有 `closeAllDbs()` 并列）。

### 4.5 安全

| 项 | 措施 |
|---|---|
| 暴露面 | 仅 loopback（dsh webServer 默认 `127.0.0.1`），不设 CORS，不加 header 放行 |
| 路径穿越 | `workspace` 只接受白名单里的 canonical path，拒绝任意路径 |
| 隐私 | 记忆正文**不写日志**（沿用 `textLen` 式打点）；不做外部上报 |
| 写风险 | v1 全只读；v2 的 PATCH 需显式开关 + 乐观锁 |
| 资源 | 单库超时/容量上限/分页；`limit` 上限（如 5000 节点） |

---

## 5. 视图设计（配图见 `docs/mockups/`）

### 5.1 全局视图 `01-global.png`

```
┌─ 记忆 ───────────────────────────────────────────────────────────────────────────────┐
│  [ 全局 ● ] [ 工作区 ] [ 星图 ]        🔍 搜索全部工作区…            ⟳ 60s 前  ⚙      │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  ┌ 工作区 6 ┐ ┌ 记忆 1,284 ┐ ┌ 本周新增 63 ┐ ┌ 项目 17 ┐ ┌ 待整理 3 ┐ ┌ 已归档 42 ┐ │
├───────────────────────────────────────────────┬──────────────────────────────────────┤
│  工作区                                        │  跨库最近更新                        │
│  ┌───────────────────────┐ ┌─────────────────┐ │  ● dsh-meow-memory  project  2 分钟前│
│  │ dsh-meow-memory       │ │ femwa           │ │  ● femwa            lesson   1 小时前│
│  │ /…/dsh-meow-memory    │ │ /…/femwa        │ │  ● dsh              fact     3 小时前│
│  │ ▓▓▓▓▓▓▓▓░ 214 条       │ │ ▓▓▓▓▓░░░ 96 条   │ │  …（20 条）                          │
│  │ 项目 4 · 最近 2 分钟前 │ │ 项目 2 · 1 小时前│ ├──────────────────────────────────────┤
│  │                       │ │                 │ │  全局条目（project = 全局，跨库）     │
│  └───────────────────────┘ └─────────────────┘ │  rules  ▸ 健康、安全相关的准则…       │
│  ┌───────────────────────┐ ┌─────────────────┐ │  user   ▸ 用户偏好：…                │
│  │ dsh                   │ │ meow-eyes       │ │  …（12 条，点开看原文与来源工作区）   │
│  └───────────────────────┘ └─────────────────┘ │                                      │
├───────────────────────────────────────────────┴──────────────────────────────────────┤
│  整理留痕（dream_log）  2 小时前 dsh-meow-memory done groups=3 stamped=41              │
│                         5 小时前 femwa          done groups=2 stamped=18              │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

要点：
- **KPI 卡**点开即过滤（如点「待整理 3」→ 列出这 3 个窗口及它们的 `last_event_time`）。
- **工作区卡**里的迷你条 = 七层堆叠（颜色见图例 §8.3），一眼看出这个库是"事实多"还是"规则多"。
- **全局条目**区专治语义歧义：全局视图是"跨工作区总览"，而 `project="全局"` 是库内语义；这里把各库的全局条目**连同来源工作区**列出来，两个概念不混淆。
- **健康检查**（可选卡）：无关键词条目、超期 stale rules、疑似重复（`findSimilar` ≥0.8）、长期未完成 todo —— 一键跳到对应过滤结果。

### 5.2 工作区视图 `02-workspace.png`

```
┌─ 记忆 ──────────────────────────────────────────────────────────────────────────────┐
│  [ 全局 ] [ 工作区 ● ] [ 星图 ]     工作区 ▾ dsh-meow-memory (/…/dsh-meow-memory) ⟳  │
├──────────────┬────────────────────────────────────────────┬─────────────────────────┤
│ 项目          │ 🔍 搜索（BM25）  level: 全部▾ status: active▾ 时间: 全部▾  ↕时间戳      │
│ ● 全部   214  │ ┌────────────────────────────────────────┐ │ 详情                     │
│   meow-mem 42 │ │ [project] dsh-meow-memory               │ │ project · overview       │
│   dsh       18│ │ meow-memory 代码结构（src/，约 1 万行）…│ │ ─────────────────────── │
│   femwa      9│ │ 模块划分 · index.ts 装配 · db.ts …      │ │ meow-memory 代码结构…    │
│   全局      12│ │ 8 分钟前 · ★3 · active                  │ │ （全文，可选中复制）      │
│   未标记     3│ ├────────────────────────────────────────┤ │ ─────────────────────── │
│              │ │ [rules] 记忆写作准则                    │ │ id      0mtykdh9j-40a7…  │
│ level 图例    │ │ fact/lesson ≤60 字…                     │ │ level   project          │
│ ● project 310 │ │ 1 小时前 · ★3 · active                  │ │ subcat  structure        │
│ ● fact    604 │ ├────────────────────────────────────────┤ │ 项目    dsh-meow-memory  │
│ ● lesson  118 │ │ [fact] 命中打分 = 交集×idf×覆盖率…      │ │ 关键词  模块划分, index… │
│ ● topic    87 │ │ 3 小时前 · ★2 · active                  │ │ 时间戳  09-12 23:52      │
│ ● rules   150 │ │ …                                      │ │        （8 分钟前）      │
│ ● soul/user 15│ │                                        │ │ 来源    session-cd11292b │
│              │ │                                        │ │ [在会话中查看] [复制 id] │
│ [时间线][留痕]│ │                                        │ │ ── 相关记忆 ──           │
│              │ │                                        │ │ ▸ [project] 项目结构…    │
└──────────────┴────────────────────────────────────────────┴─────────────────────────┘
```

要点：
- 左列 = 项目树（`memory_project` 的数据面）+ 层级图例（可点击过滤）+ 底部切「时间线 / 整理留痕」标签。
- 中列 = 记忆列表（卡片/表格两种密度）；每张卡带层级徽章、内容摘要、关键词 chips、相对 + 绝对时间戳、importance、status 点。
- 右列 = 详情抽屉：原文全文、全量元数据、**相关记忆**（`findSimilar` 现成能力）、`source_session` 链接（跳"本会话"视图）。
- 检索走服务端 `bm25.search`（与 `memory_search` 同一套算法），保证"人看到的排序 = 模型看到的排序"。

### 5.3 星图视图 `03-starmap.png`

```
┌─ 记忆 ──────────────────────────────────────────────────────────────────────────────┐
│  [ 全局 ] [ 工作区 ] [ 星图 ● ]   范围: 全部工作区▾   边: ☑结构 ☑相似 ☑会话 ☐取代    │
│  布局: (星座 ●)(力导向 ○)   阈值 ▁▂▃ 0.35   topK 3   ⏱ 全部时间 ▁▂▃▄▅              │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│        ·  ✦        ✦                    ✦  ·                                        │
│      ✦   ╭───╮  ·        ·        ╭───╮      ✦        ⟡ = 项目核心                 │
│     ·    │ F │───✦       ✦───│ D │  ·                ● = project                  │
│      ✦   ╰───╯  ·   ✦        ╰───╯                   ● = fact                     │
│         ·   ✦        ·   ·        ✦                  ● = lesson                   │
│              ✦   ╭───╮      ·                       ● = topic                    │
│                 │ M │  ✦  ·   ·                     ● = rules                    │
│                 ╰───╯                                ◌ = soul/user               │
│   ┌ 选中：fact 0mtyk… ┐   ✦  ·        ·   ◌         ▭ = session                  │
│   │ 命中打分 = 交集×… │                              ── 结构边                    │
│   │ 项目 femwa ★3     │                              ┄┄ 相似边                    │
│   │ 邻接 4（1 项目 2 相似 1 会话）                    ─→ 会话读写边                │
│   └──────────────────┘                                                              │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  节点 214 · 边 612（结构 214 / 相似 318 / 读 64 / 写 16）· 截断 否 · 布局 星座      │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. 交互入口与降级

| 优先级 | 入口 | 机制 | 适用 |
|---|---|---|---|
| 主 | 侧栏「全局面板」图标（🐱/🧠 图形 + hover 文案「记忆」） | `sidebar.panellist` id=`meow-memory` ↔ `main` key=`meow-memory` | 全版本（slot 存在即生效） |
| 次 | 会话头「本会话记忆」按钮 | `conversation.session.header.actions` | 停在某个会话时快速看"这个窗口看过/写过什么" |
| 次 | 聊天里的记忆 chip 点开浮层 | `shell.overlay` + `data-chat-flow-key` 定位（复用折叠 UI 的 DOM 手法） | Phase 4 |
| 命令 | `/memories` | `commands` 服务（已有 `/dream` 注册经验） | 键盘流 |
| 降级 | 设置页「喵记忆 → 查看器」标签 | `settings.section`（已在用） | 万一 `main`/`panellist` 在旧宿主不存在 |
| 兜底 | 独立页 `GET /meow-memory/view` | 宿主直接吐一个自包含 HTML（复用同一份数据 API） | slots 不可用 / 想在新标签页看大图 |

client 挂载时应当**能力探测**：`ctx.slots.entriesOfSlot('sidebar.panellist')` 之类的探测失败不报错，直接退回设置页标签；所有路径都 fail-open。

---

## 7. 星图设计

### 7.1 节点模型

| type | 来源 | 视觉 | 备注 |
|---|---|---|---|
| `memory` | 七层表的行 | 圆点，颜色=level，半径 ∝ log(importance)+degree，描边=status | 主力节点 |
| `project` | `project` 字段的并集（多值拆开；排除 `全局`） | 大环（星座核心） | 每个 project 一个 |
| `session` | `source_session` ∪ `windows.session_id` | 圆角方块 | 承载"读写痕迹边" |
| `keyword` | `keywords`（可选，默认关） | 小菱形 | 只在开启时生成，否则面条 |
| `global` | `project="全局"` / 未标记 | 中心灰色星云 | 不参与"项目星系" |

### 7.2 边模型与算法

```ts
// src/viewer/graph.ts（设计示意）
type EdgeType = 'project' | 'similar' | 'read' | 'write' | 'supersede' | 'timeline'

// 1) 结构边：字段直出（O(n)）
for (const r of rows) for (const p of projectList(r.project)) edges.push({ source: nid(r), target: `p:${p}`, type: 'project' })
for (const r of rows) if (r.source_session) edges.push({ source: `s:${r.source_session}`, target: nid(r), type: 'write' })

// 2) 相似边：同项目桶内两两（或按 keywords 倒排取候选），bigram 余弦，每节点 top-K，阈值剪枝
for (const bucket of byProjectBucket(rows)) {
  const hits = topSimilarWithin(bucket, { threshold: 0.35, topK: 3 })   // 复用 bm25.findSimilar
  edges.push(...hits.map(h => ({ source: nid(h.a), target: nid(h.b), type: 'similar', weight: h.sim })))
}

// 3) 取代边：同 level + 相似度 ≥ 0.8 + 一条 archived/stale 一条 active + 时间更晚
// 4) 痕迹边：sessions/<id>.json 的 injected/searched/accessed → read，written → write
```

- 相似度实现**直接复用** `bm25.findSimilar`（`bigram` 词频向量余弦，`memory_find_similar` 已用它）；候选集先用 keywords 倒排缩小（同 keyword 才算），避免 O(n²)。
- **剪枝纪律**：每节点相似边 ≤ `topK`（默认 3）、全局边数 ≤ 8000、节点 ≤ 2000；超限即降采样（先丢 importance 低 + degree=1 + archived 的节点）并在 `stats.truncated` 标记。

### 7.3 布局

**默认「星座布局」（确定性、稳定、可读）** —— 力导向每次跑出来的图都不一样，看"记忆地图"反而更难记。

```
1. 星系中心：每个 project 分配一个中心点，按项目条目数加权，落在同心圆/黄金角螺旋上；
   `全局/未标记` 放画布中心（星云），旁边不放星系，避免遮挡。
2. 星系内部：记忆按 level 分层半径（project=0.35R → fact/lesson=0.6R → topic/rules=0.85R → soul/user=1.0R），
   同一层内按 updated_at 升序排角度（时间沿圆周推进），同层拥挤时加 ±0.15rad 抖动（黄金角）。
3. 会话节点：画布外环「时间带」，按 last_event_time 排序排布。
4. 坐标一旦算出即缓存（key = revision + scope + 过滤条件），窗口 resize 只做缩放不平移重算。
```

**备选「力导向」**：Fruchterman–Reingold 简化版（斥力 O(n²) 或网格近似 + 弹簧引力 + 每帧降温），300 次迭代后冻结；仅节点 < 800 时开放（否则太慢且糊）。

### 7.4 交互

| 操作 | 行为 |
|---|---|
| hover 节点 | 高亮该节点与其邻接（其余降到 12% 透明）；显示 tooltip（level / 项目 / 摘要 / 时间） |
| 单击 | 右侧详情抽屉（复用工作区视图的 DetailDrawer） |
| 双击 | 聚焦（缩放到该节点邻域），再双击空白回到全景 |
| 图例点击 | 过滤 level（不重算布局，只改透明度 → 位置稳定） |
| 时间滑块 | 按 `updated_at` 过滤（同上，只改透明度） |
| 边类型开关 | 结构/相似/会话/取代 各自开关 |
| 框选 | 选中的节点 → 「只看这些 / 导出清单」 |
| 导出 | PNG（canvas.toDataURL）+ JSON（当前 nodes/edges） |

### 7.5 性能

- **Canvas 2D**（不用 SVG/DOM 节点）：`devicePixelRatio` 适配；静态层（边）画一次到离屏 canvas，交互时只重画高亮层。
- 命中测试：均匀网格索引（cell ≈ 24px），O(1) 查最近节点。
- 边渲染：按类型分层批量 `beginPath()`；权重映射 alpha（相似边越弱越淡）。
- 标签：只画 hub（project/session）与 hover/选中节点，其余靠 tooltip —— 避免文字糊成一团。

---

## 8. UI 规格

### 8.1 与 dsh 视觉对齐

全部使用宿主 CSS 变量（现有 client 代码已在用），主题切换自动跟随：
`--dsw-alias-label-primary / -secondary / -tertiary / -caption`、`--dsw-alias-border-l3`、`--dsw-alias-interactive-bg-hover`、`--dsw-specific-bubble`、`--dsw-alias-fill-*`。

### 8.2 组件清单（client-viewer/components）

`ScopeBar`（分段控件）· `KpiCard` · `WorkspaceCard`（含 `LevelBar` 迷你堆叠条）· `ProjectTree` · `FilterBar`（level/status/days/sort）· `MemoryCard` / `MemoryRow` · `LevelBadge` · `StatusDot` · `ImportanceStars` · `KeywordChips` · `DetailDrawer` · `RelatedList` · `TimelineRow` · `DreamLogRow` · `GraphCanvas` · `GraphLegend` · `GraphFilters` · `EmptyState` · `ErrorState` · `PartialBanner`（部分工作区打不开时提示）

### 8.3 色板（level → 颜色）

| level | 颜色（暗色主题友好） | 形状 |
|---|---|---|
| `project` | `#7aa2f7` 蓝 | 实心大方点 |
| `fact` | `#9ece6a` 绿 | 圆点 |
| `lesson` | `#f7768e` 红粉 | 圆点（带浅色描边） |
| `topic` | `#e0af68` 琥珀 | 圆点 |
| `rules` | `#bb9af7` 紫 | 圆点（带环） |
| `soul` | `#7dcfff` 青 | 小圆 |
| `user` | `#c0caf5` 灰蓝 | 小圆 |
| `全局/未标记` | `#565f89` 灰 | 星云团 |

> 颜色是"层级"，形状/描边是"状态"（active 实线 / stale 虚线 / archived 灰化 30%），两个维度不混用；同时提供**色盲友好开关**（改成按层级不同形状）。

### 8.4 无障碍与键盘

- 列表/抽屉可全键盘操作（`Tab` 焦点环、`Enter` 打开详情、`Esc` 收起抽屉）。
- 图例/过滤器是真 `<button>` + `aria-pressed`；Canvas 图提供"表格视图"替代（同一份数据的列表），不把信息只放进画布。
- 对比度：正文 ≥ 4.5:1；层级色仅作辅助编码，文字始终带层级徽章。

---

## 9. 实施计划

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **Phase 0**（0.5d） | `repository.ts` + `http.ts` + `routes.ts`；端点 `/api/workspaces`、`/api/overview`、`/api/context`；量一次 `lib/client.js` 体积 | `curl` 拿到全局 KPI；打开别的工作区不产生新文件（`ls` 对比前后）；坏库进 `partial` |
| **Phase 1**（1d） | `/api/memories`、`/api/memory`、`/api/projects`、`/api/dreams`；client 面板注册（`main` + `sidebar.panellist`）；WorkspaceView（列表 + 筛选 + 详情抽屉） | 侧栏出现「记忆」图标，点开能浏览某个工作区全部条目、能搜索、能看原文与元数据 |
| **Phase 2**（0.5d） | GlobalView（KPI + 工作区卡 + 跨库最近更新 + 全局条目）+ 空态/错误态/`PartialBanner` + 60s 刷新 | 全局视图数字与直接 `sqlite` 查询一致；断网/坏库有明确提示不白屏 |
| **Phase 3**（1.5d） | `/api/graph` + `graph/layout.ts` + `GraphCanvas` + 过滤/图例/详情联动 | 2000 节点内 30fps 可交互；相似边开关行为正确；`truncated` 有可视化提示 |
| **Phase 4**（可选） | 写操作（PATCH + 乐观锁）、记忆 chip（`shell.overlay`）、导出 PNG/JSON、独立页 `/meow-memory/view`、`/memories` 命令 | 各自单独评审 |

每阶段都跑：`npm test`（新增 host 单测 + `tests/client-viewer.mjs` 纯逻辑套件）。

---

## 10. v2 写操作的边界（若要做）

- 允许：`status`（active/stale/archived）、`importance`、`keywords`、`project`、`title`（project/topic）。
- 不允许：物理删除（项目红线：本机文件一律不删除 → 归档即软删除）、跨库搬迁。
- 并发：请求带 `expectUpdatedAt`，不等于当前值则 409（前端提示"这条刚被 dream/模型改过，已刷新"）。
- 审计：写操作落 `dream_log` 同款留痕（新增 `viewer_log` 或复用 `note` 字段）——"谁在什么时候改了什么"。
- 开关：默认关闭，设置页加一项「允许在查看器里编辑记忆」（默认 false）。

---

## 11. 风险与对策

| # | 风险 | 对策 |
|---|---|---|
| 1 | 跨工作区打开 SQLite 有成本、句柄泄漏 | readOnly + LRU(16) + revision 缓存 + dispose 全关；单库超时跳过 |
| 2 | **误写别的工作区**（`getDb()` 会建表/迁移） | 新仓储只用 `readOnly`（已实测拒绝写、拒绝不存在的文件），绝不调用 `getDb()` |
| 3 | 旧宿主没有 `main`/`sidebar.panellist` | 挂载前能力探测，失败降级到 `settings.section`（已在用）/ 独立页 |
| 4 | client bundle 体积膨胀 | Phase 0 量化；超阈值拆 `/meow-memory/viewer.js` + 动态 import |
| 5 | 星图变"意大利面条" | 默认只开结构边 + 每节点 topK=3 相似边 + 节点/边上限 + 时间过滤 + 降采样标记 |
| 6 | 隐私（记忆正文含个人信息） | 仅 loopback、不设 CORS、正文不进日志、不外发 |
| 7 | 与 dream 并发读到中间态 | 只读 + WAL 快照；UI 显示"数据版本/生成时间"，可手动刷新 |
| 8 | Windows 路径（盘符大小写/分隔符） | 一律用 `workspaceRegistry` 的 canonical `path` 做键与白名单；不做字符串拼接比较 |
| 9 | 大库（万条级）聚合慢 | 分页 + 上限 + ETag/304 + revision 缓存；必要时后台预热 |
| 10 | Canvas 无法单测 | 布局/过滤/配色/命中测试做成纯函数单测；Canvas 只做绘制 |

---

## 12. 测试策略

- **host 单测**（扩展 `test.mjs` 或新增 `tests/viewer.mjs`）：用临时目录造多库夹具 → 测白名单拒绝、readOnly 不建库、聚合数字、ETag/304、图算法（结构边数量、相似边阈值与 topK、取代边方向）、`partial` 行为。
- **client 纯逻辑**（照 `tests/client-fold.mjs` 模式：esbuild 现场打包 src）：`graph/layout.ts`（同输入同坐标、分层半径单调）、过滤谓词、level→颜色/形状映射、API 响应解析与容错。
- **契约测试**：断言我们注册的 slot 名与 options 形状（`main` 用 `key`、list slot 用 `id`+`label`）——防止宿主升级改契约后静默失效。
- **手工验收**：见 Phase 验收标准 + 三张 UI 稿逐项对照。

---

## 13. 需要拍板的点

1. **入口形态**：侧栏「全局面板」图标（我推荐）／设置页标签／独立新标签页？
2. **v1 是否坚持只读**（我推荐只读；写操作放 v2 且默认关闭）？
3. **星图默认布局**：星座（我推荐，稳定可读）还是力导向（炫但每次不同）？
4. **"全局"口径**：跨工作区总览 + 各库 `project="全局"` 条目并排展示（我推荐），还是你只想要其中一种？
5. **要不要"记忆 chip"**（在聊天消息里点开浮层看这条记忆）——它要碰对话流 DOM，成本比面板高，建议放 Phase 4。
6. **是否现在按 Phase 0/1 开工**？

---

## 附：配图与原型

| 文件 | 内容 |
|---|---|
| `docs/mockups/01-global.svg` / `.png` | 全局视图（跨工作区） |
| `docs/mockups/02-workspace.svg` / `.png` | 工作区视图（项目树 + 列表 + 详情抽屉） |
| `docs/mockups/03-starmap.svg` / `.png` | 星图视图（星座布局 + 图例 + 过滤） |
| `docs/mockups/viewer.html` | **可点原型**：三个视图 + 可拖拽/缩放的 Canvas 星图（假数据） |
| `docs/mockups/render-mockups.mjs` | 生成上面三张 SVG 的脚本（假数据，可复现） |

---

## 实现记录（v0.27.0，2026-09-13）

落地情况与本文档设计的差异（实现为准）：

| 项 | 设计 | 实现 |
|---|---|---|
| 路由 | 10 个端点 | 12 个：额外加了 `/similar`（详情抽屉的"相关记忆"）与 `/search`（全局视图的跨工作区搜索框） |
| 入口 | main + sidebar.panellist（+ shell.overlay 后置） | main + sidebar.panellist（已实现）；`shell.overlay` 记忆 chip 未做（Phase 4） |
| 独立页 `/meow-memory/view` | 兜底入口 | 未做（设置页标签仍可作为降级入口，本次未接线） |
| 写操作 | v2 可选的 PATCH | 未做（v1 全只读，与设计一致） |
| 客户端打包 | 先合并，超 400KB 再拆 | `lib/client.js` 78.6KB → **152.5KB**，未超阈值，未拆 |
| JSX | — | 新增：客户端 JSX 走**经典转换**（`jsxFactory: h`），只依赖 `react`；不赌宿主提供 `react/jsx-runtime` |
| 代码落点 | `src/viewer/*` + `src/client-viewer/*` | 与设计一致（+~2.0k 行 host、+~1.7k 行 client） |
| 测试 | host 单测 + client 纯逻辑 | `tests/viewer.mjs`(60) + `tests/client-viewer.mjs`(45) + `tests/client-viewer-mount.mjs`(16，打包产物级挂载契约) |

**实测结论（写进 README 的升级提示）**：profile 插件从 `node_modules` 加载，**改 `lib/` 必须重启 `dsh web` 才生效**——HMR 不覆盖 profile 插件（现场证据：`~/.dsh-meow/perf.log` 里每次 `apply #1 pid=` 都对应一个新进程；touch 文件不触发重载，settings.yaml 变更也不触发 fiber 重跑）。

**真实数据实测**（本机 6 个工作区 / 122 条记忆）：`/workspaces` 100ms、`/graph`（138 节点 / 348 边）249ms、`partial` 为空。
