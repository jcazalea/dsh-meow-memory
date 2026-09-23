# 会话级记忆开关 — 设计方案

> 状态：**已确认并实施**（交互形态拍板：两态拨动开关；工具行为拍板：返回禁用提示错误）
> 配套：`mockup.png`（静态设计稿）· `mockup.html`（可交互体验稿，浏览器直接打开）

## 1. 需求理解

现状：meow-memory 只有**全局总开关**（`config.enabled`，设置页 / cordis.patch.yml），一关全关，无法只对某个会话关闭记忆。

目标：新增**会话级开关**——在对话输入框（发送消息位置）增加一个「记忆」按钮，两个选项：

| 选项 | 含义 |
|---|---|
| **启用**（默认） | 允许本会话发起记忆处理：注入（首轮快照 / 关键词命中 / 压缩重注入）、检索（`memory_search` 等工具）、生成（反思 / dream 整理 / `memory_remember` 等工具） |
| **禁用** | 本会话不发起任何记忆处理：不注入、不命中、不反思、不自动 dream；模型调用记忆工具时返回明确提示 |

与总开关的关系是**双层串联**（详见 §6 图示）：

```
总开关 enabled（设置页/配置，全局）──► 会话开关「记忆」（输入框旁，每会话）──► 记忆链路
```

- 总开关 = 关 → 一切停用（现状行为不变，按钮也不显示）；
- 总开关 = 开 → 每个会话可单独启用/禁用；
- **默认启用**，无记录会话 = 启用 → 与现状完全一致，向后兼容。

## 2. 交互设计（UI 稿见 mockup.png / mockup.html）

- **位置**：composer 工具行右侧、模型选择器与发送按钮之前（dsh 官方 slot `conversation.input.right`，list / session 作用域——正好渲染在「发送消息」位置上，与发送按钮同一行）。
- **形态（已拍板：两态拨动开关，无弹层）**：紧凑胶囊按钮 = 状态点 + 文案「记忆」，按钮即开关。
  - 启用：绿点（强调色描边）；
  - 禁用：灰点（弱色描边）；
  - **单击直接切换**两态，切换立即 POST 持久化，不需要确认弹层。
- **禁用时的辅助反馈**：
  - composer 上方一行细提示条（`conversation.input.dock` 全宽槽位）：「本会话记忆已禁用：不注入 · 不检索 · 不生成（点「记忆」可恢复）」；
  - 对话流不再出现「已注入记忆」横条 / 反思 chip（对比 A、C 两栏）；
  - AI 调用记忆工具时返回错误文案（见 §4），模型不会静默绕开。
- **会话切换**：按钮随当前会话 id 联动——每个会话独立状态，切会话即显示该会话自己的开关状态。

## 3. 状态存储与语义

- **存储**：工作区记忆库 SQLite 新增表（沿用 `dream_skip` 的既有模式）：

  ```sql
  CREATE TABLE IF NOT EXISTS session_state (
    session_id   TEXT PRIMARY KEY,     -- 会话 id（与 windows 表同键）
    memory_enabled INTEGER NOT NULL DEFAULT 1,
    updated_at   INTEGER NOT NULL
  )
  ```

- **语义**：无记录 = 启用（默认，兼容现状）；禁用 = 写入 `memory_enabled = 0`。持久化，重启 / 热重载不丢。
- **读写路径**：
  - 客户端按钮：`GET /meow-memory/session-memory?sessionId=…` 读初始态；`POST /meow-memory/session-memory { sessionId, enabled }` 写状态（沿用 `/meow-memory/skip-dreams` 的 POST + `readJsonBody` 模式）；
  - host 热路径：**内存缓存** `Map<sessionId, boolean>` + DB 兜底（与 `windowIndex` 同款：apply 时从 DB 恢复，写时双写）。注入 / 反思 / dream 都在每次判断时读缓存，O(1) 且不落盘。

## 4. Host 端拦截点（禁用时行为）

| 链路 | 现有位置 | 禁用时行为 |
|---|---|---|
| 首轮快照注入 | `preStepInject`（首条消息分支） | 跳过 |
| 关键词命中注入 | `preStepInject`（命中链路） | 跳过 |
| 压缩后重注入 | `preStepInject`（reinject 分支） | 跳过 |
| 首次语言引导 | `preStepInject`（welcome 分支） | 跳过 |
| 自动反思 | `turnStoppingCore` | 跳过 |
| 自动 dream（空闲扫描） | `dreamSweepOnce` | 跳过本会话 |
| 打开会话补 dream | `resumeAndDream` | 跳过 |
| `memory_remember/search/read/update/project/find_similar/dream` | `tools.ts` / `dream.ts` | 返回错误：「本会话记忆已禁用（点输入框旁的「记忆」可恢复）」 |
| `/dream` 命令 | `dreamCommandDefinition` | 返回不可用提示 |

要点：

- **工具返回错误而非静默放行**：需求是"不允许发起记忆的处理"，模型调用记忆工具时应得到明确反馈（并提示恢复方式），而不是悄悄成功；其余非记忆工具不受影响。
- **子代理继承判定**：`sessionIdOf()` 已把子代理归到父窗口——父会话禁用则子代理里的记忆工具同样被拦，无需额外处理。
- **查看器面板 / 设置页保持可用**：它们属于用户显式查看 / 配置动作，不是会话自动的记忆处理，不在禁用范围内。

## 5. Client 端实现

- 新组件 `MemoryToggleDock` 注册到 `conversation.input.right`（list / session）。
- **会话 id**：`useSessions(state => state.current)`——本插件已在 header 隐身哨兵（`DelegateVanishDock`）与查看器面板（`App.tsx`）用过同一模式，验证可行；`useSessions` 不可用时 fail-closed 不渲染。
- **初始态**：挂载时 `GET` 一次；切换时 `POST`，乐观更新 + 失败回滚并提示。
- **样式**：内联 CSS（与 `client.ts` 的 `FOLD_CSS` 同风格，用 `--dsw-alias-*` token），主题自适应；热重载时替换旧 style（现有 `data-meow-memory-css` 机制）。
- **多标签页**：状态真源在 host DB，行为一致性自动保证；另一标签页的按钮 UI 同步靠既有 SSE 通道（可选，本期不做）。
- **总开关关闭时**：host 不注册路由 → 客户端 `GET` 失败 → 按钮 fail-closed 隐藏。

## 5.5 模型侧可见性（v0.32.0 追加）

> 用户反馈（2026-09-19）：禁用后虽提示「不注入 · 不检索 · 不生成」，也确实没有获取和写入记忆，
> 但模型还是实打实的思考了总结来的记忆，只是没有使用。核对：动态内容与执行层门禁原本已生效，
> 缺口在**静态记忆系统面**——系统提示词里的记忆手册 + memory_* 工具定义全局恒定可见。

- **目标**：会话禁用后，模型上下文**零记忆痕迹**——不注入内容、不显示记忆手册、不提供
  memory_* 工具；模型不再按手册指示去"思考总结记忆"。
- **修法 ① 展示层（system-prompt/assemble 门禁）**：host 注册
  `ctx.on('system-prompt/assemble', listener, { global: true })`（dsh 官方扩展点，与
  system-prompt-invariant 同款注册）。装配时 `context.scope` === agent（dsh-agent
  `assembleContextFor`：`{ agent, scope: agent, signal }`），取 `session.header.id/.cwd`
  （子代理经 `parentSession` 归父窗口，与 tools.ts `sessionIdOf` 同口径）判
  `isSessionMemoryEnabled`。禁用 → 从装配结果移除 `meow-memory:guide` section、全部
  memory_* 工具、`meow-memory` 前缀 contexts。纯函数 `applySessionMemoryVisibility`
  / `sessionMemoryOnForAssemble` 可单测。
- **修法 ② 上下文清理（pre-step）**：`preStepInject` 禁用分支过滤 `decision.messages`
  里 `source.kind==='plugin' && source.plugin==='meow-memory'` 的消息——会话**中途**禁用
  后，此前注入的长期记忆/命中/重注入/引导通知块也从模型上下文剔除（会话记录不动）。
- **双层互补**：展示层裁剪（模型看不到）+ 工具 execute 门禁（模型从历史/子代理 prompt
  硬调仍被拦，报 `memory.disabled`）。重新启用即刻恢复。
- **边界**：会话中途禁用前已注入的块属于会话记录，UI 折叠条仍显示（仅模型侧剔除）；
  新会话从头禁用 = 无任何痕迹。

## 6. 双层开关图示

```
┌──────────────────┐   ┌──────────────────┐   ┌─────────────────────────────┐
│ 总开关 enabled    │──►│ 会话开关「记忆」   │──►│ 记忆链路                    │
│ 设置页/配置·全局   │   │ 输入框旁·每会话    │   │ 注入·命中·反思·dream·工具    │
│ 关=全部停用(现状)  │   │ 默认启用·持久化    │   │ 两级都为「开」才运行          │
└──────────────────┘   └──────────────────┘   └─────────────────────────────┘
```

## 7. 改动文件清单（实施记录）

| 文件 | 改动 | 状态 |
|---|---|---|
| `src/db.ts` | `session_state` 表 + `getSessionMemoryEnabled` / `setSessionMemoryEnabled` / `listDisabledSessions` | ✅ |
| `src/session-state.ts`（新） | 内存缓存（TTL 10s）+ `isSessionMemoryEnabled` / `setSessionMemoryEnabled` / `resetSessionMemoryCache` | ✅ |
| `src/index.ts` | 路由 `GET/POST /meow-memory/session-memory`；`preStepInject` / `turnStoppingCore` 门禁；apply 时恢复缓存；导出 session-state | ✅ |
| `src/tools.ts` | `registerMemoryTools` 统一包一层 execute 门禁（禁用时报 `memory.disabled` 文案） | ✅ |
| `src/dream.ts` | `dreamSweepOnce` / `resumeAndDream` 门禁；`dreamTool` / `/dream` 命令门禁 | ✅ |
| `src/prompts/zh/en labels.md` | 新增 `memory.disabled` 键（中英文） | ✅ |
| `src/client.ts` | 注册 `MemoryToggleDock`（input.right）+ `MemoryDisabledNotice`（input.dock）；追加 TOGGLE_CSS | ✅ |
| `src/client-session-toggle.ts`（新） | 拨动开关 + 提示条组件（React 壳） | ✅ |
| `src/client-session-toggle-core.ts`（新） | GET/POST 封装 + 共享状态（纯逻辑，可测） | ✅ |
| `test.mjs` / `tests/client-session-toggle.mjs`（新） | DB 层 + 缓存 + 工具门禁 + 子代理继承 + dream 门禁 + client 纯逻辑 | ✅ |
| `docs/session-memory-toggle/*` | 本设计稿 + mockup（svg/png/html） | ✅ |

## 8. 边界与风险

- **新会话工作区解析**：POST 前 `resolveWorkspaceForSession` 兜底（windowIndex → sessionPersistence.list），解析不到返回 404，客户端 fail-closed 隐藏按钮（安全侧）。
- **热重载**：缓存以 DB 为准，apply 时重建；写路径双写 DB + 缓存，无脏状态。
- **向后兼容**：默认启用 = 现状行为零变化；`dream_skip` 不受影响。
- **明确不做**：不做按项目 / 关键词的精细规则；不做会话级记忆库导出；不做 UI 文案国际化（沿用项目现状：中文硬编码）。

## 9. 验收标准

1. 输入框旁出现「记忆」拨动开关，默认「启用」，与现状行为完全一致；
2. 点击切「禁用」后：新消息无注入、无命中、无反思；该会话不自动 dream；调用 `memory_search` 等工具返回禁用提示；
3. 再点击切回「启用」：立即恢复全部链路；
4. 重启 dsh 后状态保持；
5. 其他会话不受影响；总开关关闭时按钮不显示。
