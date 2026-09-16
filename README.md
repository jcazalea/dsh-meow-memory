# meow-memory 🐱📝

| [中文](README.md) | [English](README.en.md) | [MIT License](LICENSE) |
| :---: | :---: | :---: |

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）打造的跨会话记忆插件。


**核心理念**：所有项目共享一份中央结构化记忆数据库（`~/.dsh-meow/memory.db`，基于 `node:sqlite`），
按项目（project）名隔离记忆，换电脑只需拷贝这一个文件（连同 `~/.dsh-meow/sessions/`）。
静态记忆手册（数据总览 + 工具用法 + 写作准则）以固定 section 的形式放在 **system prompt** 里——
文本恒定，因此不会破坏 LLM provider 的 KV/上下文缓存。动态内容（soul/user 全量、设计原则、
记忆导引）作为**第一条用户消息的前缀**注入，且首轮只注入长期记忆、不做关键词命中；
从第二轮起每条用户消息做关键词命中（top-2）。模型按需用 `memory_search` /
`memory_project` 深入检索。每个窗口由自己的主 agent 在空闲时（"dream"）整理记忆
（本窗口建立 + 提取过的记忆），以窗口最后一次对话时间戳冻结其知识。

## ✨ 功能特性

- **七层记忆**（`soul` = AI 自身 / `user` = 用户基本信息与偏好 / `project` = 项目信息，
  含 `subcategory`（overview/structure/decisions/quotes/ops/todo）/ `fact` = 原子事实 /
  `lesson` = 教训与纠正 / `topic` = 进行中的讨论话题，带目标句 / `rules` = 设计原则与行为准则）。
  每层一张 SQLite 表，UUID 带时间前缀，id 顺序即创建顺序。
- **首轮注入（长期记忆块）**：第一条用户消息前注入固定格式
  `===== 长期记忆 =====` → `【关于你】`（soul 全量）→ `【关于user】`（user 全量）→
  `【设计原则】`（全局 rules 且 importance≥2，少而精的命令式准则）→ `【记忆导引】`
  （用法说明 + 「用户的所有 project」动态列表，供 `memory_project` 选用）。
  记忆作为独立 plugin snapshot 消息放在真实 user 消息之前，不改写用户 prompt。
  **首轮不跑关键词命中**（命中从第二轮起）。即使首条用户消息与插件通知消息同批到达
  （如 approval policy 变更通知），快照仍会紧贴插入到真实用户消息之前、命中绝不提前。
- **每消息关键词命中**：从第二条用户消息起，每条真实用户消息都检索
  fact/lesson/rules/topic（范围 = 全局 + 当前 project 锚定），top-2 命中以
  「可能相关的记忆，仅供参考：」前缀注入。命中基于**条目关键词**（LLM 提取或自动
  bigram）而非全文——全文匹配噪音大。打分 = 交集分 × idf × 覆盖率 × 艾宾浩斯衰减
  （按记忆时间戳）× importance 权重 × title 加成。
- **当前 project 锚定**：`memory_remember/search/update/project` 带 project 参数即锚定
  该会话的当前项目；未锚定时命中只搜全局（用户闲聊不误伤）。
- **缓存友好设计**：静态 `meow-memory:guide` section（order 130，紧随各 `tool:*` 说明之后）
  在 system prompt 中注册一次——文本恒定，KV 缓存友好。已见记忆（`injected` + `searched`）
  按会话记录（`~/.dsh-meow/sessions/<id>.json`）：注入绝不重复；`memory_search` 前 5 条按相关度
  无脑取（不排除已见/本 session 建立的记忆），其余从排名后续绕开已见补齐；收到会话压缩
  信号（`compaction/*`）时释放已见记录，允许压缩后被再次命中提取。
- **压缩后重注入**：会话被压缩（手动 `/compact` 或 token 压力自动触发）后，下一个用户
  消息轮自动重新注入长期记忆快照 + 本会话此前用 `memory_project` 查阅过的项目全景 +
  本会话自己写入/更新过的记忆原文（均按最新数据重新整理）——压缩甩掉的"记性"一个回合
  就补回来，AI 不会因为压缩突然失忆。
- **工具集**：`memory_remember`（写入，必填 content/project/keywords/importance 且缺失报错引导重填，
  自动去重合并，返回读回确认：关键词/项目归属）/
  `memory_search`（BM25 × 近期权重，支持 level/project/status/days 过滤，默认 top10 = 前 5 条
  最相关不排除已见 + 后 5 条绕开已见补齐，按记忆时间戳排序；返回检索元数据视图：
  归属 + 完整 id + 相对时间 + 关键词列表，不含原文）/
  `memory_project`（项目全景注入段落：**project 参数必填**——你要看哪个项目的信息？按子标签分组、未过时条目全给、每条带完整 id 与
  最后更新时间戳、todo 输出「已完成：」最近 5 条 +「To do list：」，末尾附记忆库与
  会话历史定位说明）/
  `memory_find_similar`（查重与冲突检测）/ `memory_read` / `memory_update`（含 status
  active/archived/stale、importance、goal、keywords 手动修正）/ `memory_dream`（手动触发；
  用户也可以直接在输入框敲 `/dream` 命令）。
- **记忆时间戳**（`updated_at` = 最后更新时间）：dream 封存或 `memory_update` 刷新时更新。
  展示的时间戳一律是 `updated_at`；search（工作视图）带相对时间戳，命中注入/memory_project
  （原文视图）带相对 + 绝对时间戳（如「2026-08-15 10:58 [2 天前]」）。
- **project 归属**：全局适用的信息 project 填 `"全局"`（与留空=未标记区分）；同时适用于
  多个项目时用英文逗号分隔（如 `"dsh, femwa"`）——检索/命中按"包含当前项目名 或 全局"判定。
- **按窗口 dream**：窗口空闲 ≥ `idleMinutes`（默认 **180 分钟 = 3 小时**）即进入允许
  触发状态（替代原夜间窗口），每个最后发言晚于上次 dream 的窗口由自己的主 agent
  整理——分轮处理（第 1 轮原子记忆 project/fact/lesson/rules/soul/user，第 2 轮 topic
  记忆，第 3 轮项目总结——本窗口涉及具体项目时追加：调 memory_project 复查并精简成
  新的项目长期记忆，被取代的旧条目归档），project 小标题分段，每条记忆附关键词行
  （AI 核查/重写关键词用），范围=本窗口
  建立 + 提取过（注入/检索/查阅 memory_read）的记忆，使用其完整会话上下文；
  长期稳定的 rules 不反复重审（`dream.rulesReviewDays` 默认 2 天内有更新才进清单，
  防"没话找话"式更新）。**峰时抑制**（按 `timeZone` 计算，默认
  北京时间）：`suppressWindows`（默认 09:00–12:00、14:00–18:00，API 峰谷电价峰时）
  及各自开始前 `suppressLeadMinutes`（默认 15）分钟内不触发，峰时结束后下一个检查
  周期自动触发；进行中的 dream 不打断。无 live agent 且超过 24h 的旧窗口、以及已归档
  的会话，均不处理。
- **`/dream` 命令**：不想等空闲触发？在输入框敲 `/dream` 立即手动唤起本窗口的记忆整理
  （与 `memory_dream` 工具同语义，不受峰时抑制）。dsh 命令平面执行、不发给模型，输入 `/`
  的补全菜单里直接可见；已有整理在进行中会明确提示，不会重复启动。
- **跳过梦境整理（client 端）**：某个窗口的记忆不想被自动整理？左侧边栏该会话行的「…」
  菜单里点一下**「跳过梦境整理记忆」**即可，再点**「取消跳过梦境整理记忆」**恢复。被跳过
  的窗口不再被空闲定时器自动 dream（`/dream` 与 `memory_dream` 手动触发不受影响），
  会话列表里显示**静音灰「月牙+斜杠」**图标、一眼可辨。跳过状态持久保存、重启不丢；
  双实例共享同一记忆库，状态天然一致。
- **反思**：单次任务内连续 ≥7 个工具 step 后，插件询问模型自上次整理以来是否有值得记忆的内容。
  最后工具是 `memory_*` 视为已主动记忆、不重复反思；被取消的轮次绝不触发。
- **注入折叠 UI（client 端）**：首轮长期记忆 / 每消息关键词命中的注入文本在前端
  折叠成「▸ 已注入记忆（长期记忆/关键词命中）」横条（与用户气泡同宽），点开可查看
  注入全文；用户 prompt 以气泡形式直接显示，消息流干净不被注入刷屏。纯文本消息才折叠
  （带附件的保持原样）。
- **记忆查看器（client 端，v0.27.0）**：侧栏「全局面板」区多一个**记忆图标**，点开是
  全幅的记忆浏览器——**全局**（跨工作区 KPI、工作区卡、跨库最近更新、各库
  `project=全局` 条目、健康检查、整理留痕、跨工作区搜索）/ **工作区**（项目树 + 层级
  过滤 + BM25 检索 + 详情抽屉 + 相关记忆 + 时间线/留痕/会话足迹）/ **星图**（Canvas：
  星座布局默认、力导向备选；结构边/相似边/会话读写边/取代边可分别开关，层级开关只改
  透明度不重算布局）。**纯只读**：跨工作区读取用 `node:sqlite` 只读连接（不建库、不写
  他库），工作区参数过白名单。详见下方「记忆查看器」。
- **反思轮折叠 UI（client 端）**：记忆反思/dream 轮的 prompt 与后续 think/tool call/汇报
  折叠成一条横条（默认折叠，显示「新增记忆 N 条」/「记忆梦境任务」），点击向下展开成
  卡片查看完整记录——卡片内 Think / tool call / 上下文注入均可点开查看细节。
- **会话列表 dream 图标（client 端）**：左侧会话列表中，"dream 整理过记忆且之后无新对话
  新信息"的会话行显示**淡黄色小月牙 🌙**；dream 轮进行中显示**白→金呼吸灯月牙**（与 dsh
  状态点并存、月牙居左，不与正常工作混淆）；被**跳过梦境整理**的会话显示**静音灰「月牙+斜杠」**
  （取消跳过自动回落；优先级：呼吸灯 > 跳过 > 月牙）；有新活动即移除。图标放进 dsh 会话行的
  状态槽位、状态点左侧——只追加/只移除自有节点，不改写 React 拥有的子节点（整槽替换会令
  React 虚拟 DOM 失同步，commit 抛 removeChild NotFoundError 把侧边栏整树卸载）。
  数据走全页共享的 60s 轮询 diff（v0.23.0 连接池修复，替代原 SSE 长连接）：
  `/meow-memory/dreamed-sessions` 与 `/meow-memory/skip-dreams` 各一次 GET，事件语义不变——
  dream 开始推 `state:'dreaming'`、完成推 `state:'dreamed'`、有新活动推 `state:'active'`、
  跳过翻转推 `state:'skip'/'unskip'`；client 挂载时全量对账一次。
  行定位零 dsh 改动：读 React 18 fiber（`__reactFiber$` 内部属性）拿会话行渲染 key =
  session id，不依赖标题匹配。
- **dream 防重复**：check 门（DB 原子 60s 检查节流）+ start 幂等抢占（`dream_pending`）+
  中断自愈（未收尾的 dream 自动补收尾）+ 孤儿收尾（跨实例/热重载后 turn 结束也能收尾）；
  插件注入轮的事件不刷新窗口活跃度——已 dream 的窗口不会反复被 dream。
- **零运行时依赖**：`node:sqlite`（Node ≥22.13 默认可用；22.5–22.12 需 `--experimental-sqlite`）+ 自包含 esbuild 产物（`lib/index.js`）。
  无原生模块。

## 📦 安装

### 一键安装（推荐）

```sh
dsh plugin --profile web add github:Phant0Meow/dsh-meow-memory
```

一条命令装完即生效：安装时自动编译（包内含 `prepare` 脚本），自动挂载，重启 `dsh web` 后新会话自动加载插件。

> pnpm ≥10 默认会阻止安装期的构建脚本：首次 `add` 可能失败并提示 `allowBuilds`，按提示把输出的键加进 profile 的 `pnpm-workspace.yaml` 后重跑即可。

### 卸载

```sh
dsh plugin --profile web remove meow-memory
```

### 手动安装（开发者，任意 DSH 安装，无需 npm）

1. 把本包复制（或软链）到 profile 的 `node_modules`：
   ```sh
   mkdir -p ~/.dsh/profiles/web/node_modules
   ln -s /path/to/meow-memory ~/.dsh/profiles/web/node_modules/meow-memory
   ```
   （Windows：`New-Item -ItemType Junction ...` —— NTFS junction，无需管理员权限。）
2. 把 `meow-memory` 加进 profile `package.json` 的 `dsh.profile.bundles`（同上）。
3. 重启 `dsh web`。新会话自动加载插件。

## 🔌 兼容性

支持 **dsh 0.1.5**（含最新的 `0.1.5-rc.1`），同时向下兼容旧版本——升级 dsh 不需要改本插件，也不需要改任何配置。

插件不写死版本号，而是运行时探测宿主能力，因此新旧版走各自正确的分支。已实测两代：`0.1.5-rc.1` 上首次注入、记忆工具调用、客户端渲染全部正常；`0.1.1-rc.2` 上行为与历史版本完全一致。

## ⚙️ 配置

所有字段均可选（profile patch 或 `cordis.patch.yml`）。**也可以不手编文件**：DSH 设置页里有本插件的「喵记忆」标签页（与「通用」「模型」平级），下面这些项全部图形化可改、字段级保存、可单项恢复默认（恢复默认 = 回到插件出厂默认，不受 patch 基线影响）；保存后热重载/重启 meow-memory 插件生效。

```yaml
- id: meow-memory
  name: 'meow-memory'
  config:
    enabled: true          # 总开关
    projectDir: '.dsh-meow' # 中央库目录（默认 ~/.dsh-meow/memory.db；填绝对路径则用该目录）
    promptLang: 'zh'       # ⚠️ 首次使用建议显式配置（见下方说明）
    hitTopK: 2             # 每条用户消息关键词命中的条目数上限（fact/lesson/rules/topic）
    reflect: true          # 连续 ≥reflectTurns 轮工具调用后自动反思
    reflectTurns: 7        # 触发反思所需的连续工具轮数
    dream:
      enabled: true
      idleMinutes: 180      # 窗口空闲 ≥180 分钟（3 小时）允许 dream
      suppressWindows:      # 峰时抑制时段（按下方 timeZone 计算，"HH:MM" 起止）
        - start: '09:00'    #   API 峰谷电价峰时
          end: '12:00'
        - start: '14:00'
          end: '18:00'
      suppressLeadMinutes: 15  # 每个峰时开始前 15 分钟也不触发
      checkMinutes: 15
      timeZone: 'Asia/Shanghai'  # 用户机器时钟为美区时间；抑制时段必须
                                 # 按此固定时区计算
      rulesReviewDays: 2    # updated_at 距今超该天数的稳定准则不进 dream 第 1 轮
                            # 清单（防反复整理不变化的条目）；0 = 不过滤
    delegate:
      model: ''            # 整理任务换模型（可选）：填写后反思轮与梦境轮自动换用
                           # 该模型执行，轮次结束自动换回主模型；'provider/model'
                           # 指定 provider+model，'model' 只换模型（provider 继承
                           # 主会话）；留空 = 全程主模型
```

### 整理任务换模型（可选）

反思轮和 dream 各组始终在主窗口执行（steer）——prompt、模型回应、工具调用落在主会话 log（折叠 UI 负责视觉收纳）。独立 fork 子代理执行方式已于 v0.24 移除，不再提供"独立执行"开关。

如果想让记忆整理换个（更便宜的）模型跑：配置 `delegate.model` 后，反思/梦境轮发起的每个 LLM 请求会经 dsh 的 `agent/request` waterfall 自动覆盖 provider/model，轮次结束自动换回主模型——正常对话、工具轮完全不受影响。实现是无状态的：按"当前 turn 是否携带反思/梦境指令标记"逐请求判定，用户中止、崩溃、热重载都不会留下"卡在换模型"的脏状态。

### promptLang：prompt 与检索语言（重要）

`promptLang` 决定两件事：①注入/反思/dream 文案的语言；②工具描述的语言。它同时影响模型写记忆条目用的语言——关键词按条目语言提取，**以你说话的语言为准**。

**因此首次使用时请显式配置它**：`promptLang: 'zh'`（默认）或 `'en'`（内置英文语言包）。如果你的对话语言和界面语言不一致（比如界面英文、说话中文），**以你说话的语言为准**。

检索侧说明：BM25 分词自 v0.20.0 起语言无关（类别路由），条目与查询语言不一致不再"杀检索"；`en` 模式额外启用英语归一化（停用词过滤 + Porter 词干还原），屈折变化不影响命中（`tokenizers` 能命中存为 `tokenizer` 的条目）。

自定义 / 社区语言包：prompt 文案是数据文件（`src/prompts/`），一门语言一个子目录，改文件即生效、无需改代码——详见 [`src/prompts/README.md`](src/prompts/README.md)（含贡献指南与 `npm run check-lang` 自查）。实例级自定义：`<home>/.dsh-meow/prompts/<lang>/` 下放同名槽位文件即可覆盖（可只覆盖部分）。

## 🧠 工作原理

```
第一条用户消息（首轮）         第二条起的每条消息                空闲≥3h 且非峰时
┌────────────────────┐        ┌────────────────────┐        ┌──────────────────────┐
│ ===== 长期记忆 ===== │        │ 可能相关的记忆，仅供  │        │ 按窗口 dream：        │
│ 【关于你】(soul)     │        │ 参考：keywords 命中   │        │ 三轮（含项目总结）      │
│ 【关于user】         │        │ top-2（全局+当前     │        │ 七层+提取过的，       │
│ 【设计原则】(rules)   │        │ project 锚定）      │        │ updated_at 以 T 封存  │
│ 【记忆导引】          │        └────────────────────┘        └──────────────────────┘
└────────────────────┘        已见 id 按会话记录
独立 plugin snapshot        (sessions/<id>.json)
↓ 原样 user prompt          压缩信号 → 释放已见
 每会话只注入一次，
 首轮不做命中
```

## 💾 数据位置与跨设备备份（v3 中央存储）

自 v0.29.0 起，所有项目的记忆存在**一个中央库**：

| 内容 | 位置 |
| --- | --- |
| 记忆库（七层 + windows/dream 等辅助表） | `~/.dsh-meow/memory.db` |
| 会话已见痕迹（`sessions/<id>.json`） | `~/.dsh-meow/sessions/` |
| 实例级运行态（窗口索引、prompt 覆盖、日志） | `~/.dsh-meow/` |

**迁移旧数据（v0.29.1 起手动触发）**：不再启动自动合并。两个入口：

- **查看器面板**：记忆面板工具栏「迁移旧库」→ 填旧库路径（`memory.db` 文件 / 库目录 / 项目根目录）→ 开始迁移；
- **命令行脚本**：`python3 scripts/migrate-central.py`（`--dry-run` 预览 / `--yes` 执行 / `--force` 重跑）。

合并规则：soul/user 按来源库的项目归属打标签或归全局，其余层原样并入；
旧库改名 `memory.db.old` 保留备份（`.old` 已存在时避让为 `.old.<时间戳>`）；
`sessions/` 复制进中央目录后删除原件。

**换电脑 / 备份**：拷贝 `~/.dsh-meow/memory.db` 和 `~/.dsh-meow/sessions/`
这两个到新机器的相同位置即可（不是双向同步，是搬家式拷贝）。

## 🔭 记忆查看器（v0.27.0）

**入口**：左侧栏「全局面板」区多一个记忆图标（`sidebar.panellist`）——点它，中央区域切到记忆查看器（`main` 面板，key = `meow-memory`）。零 dsh 本体改动：两个 slot 都是官方扩展点，id/key 同名即自动配对。

**三层视图**

| 视图 | 内容 |
| --- | --- |
| 全局 | 跨工作区 KPI（工作区/记忆总数/本周新增/项目/待整理窗口/已完结+删除）、每个工作区的层级堆叠条与 dream 状态、跨库最近更新、各库 `project="全局"` 条目（标注来源工作区）、健康检查（无关键词 / 超期准则 / 疑似重复 / 未完成 todo）、整理留痕；搜索框跨工作区检索 |
| 工作区 | 左：项目树 + 层级过滤；中：记忆列表（服务端过滤：level/status/project/天数/BM25 检索）；右：详情抽屉（原文全文 + 全量元数据 + 相关记忆 `findSimilar`）；底部标签：时间线 / 整理留痕 / 会话足迹 |
| 星图 | Canvas 绘制。默认**星座布局**（项目=星系核心、level=分层半径、时间=角度，确定性可复现），可切力导向；边分四类可分别开关；层级开关只改透明度、不重算布局（位置稳定） |

**数据面**（宿主 `prefix` 路由 `/meow-memory/api`，全部只读）：

```
GET /context?sessionId=        会话 → 工作区 + 该会话记忆足迹
GET /workspaces                工作区清单 + 摘要（层级分布/项目/dream 状态/读取失败原因）
GET /overview                  跨工作区总览（KPI/层级/工作区卡/最近更新/全局条目/健康检查/留痕）
GET /memories?workspace=&level=&status=&project=&q=&days=&importance=&sort=&limit=&offset=
GET /memory?workspace=&id=     单条全量（支持截断 id 前缀，先精确后前缀）
GET /similar?workspace=&id=&k= 相关记忆（复用 bm25.findSimilar）
GET /projects | /timeline | /dreams | /sessions    项目分组 / 时间线 / 留痕+窗口 / 会话足迹
GET /search?q=                 跨工作区检索
GET /graph?scope=&workspace=&level=&edges=&threshold=&topK=&limit=   星图节点与边
```

统一响应 `{ ok, data, meta: { generatedAt, etag, partial } }`；带 `If-None-Match` 命中即 304（前端 60s 轮询几乎零成本）；`partial` 列出读取失败的工作区。

**面板里的「项目」从哪来 / 怎么删**

项目**不是一张独立的表**，也没有"新建项目"入口：它是各层记忆条目 `project` 字段值的聚合投影（`repository.projects()` / `aggregate.projectSummaries()`；单值或逗号分隔的多归属都拆开计数，`全局`/`未标记` 各自成桶）。所以：

- **出现**：任何一次 `memory_remember`（v2 起缺省自动归属当前工作区派生的项目 id；或显式传的 project、dream 封存时打的归属、旧库迁移带进来的标签）都会让该项目出现在面板里。
- **消失**：改写引用它的那些条目的 `project` 字段。查看器本身**只读**（Phase 4 的写操作未做），所以用脚本：

```bash
python3 scripts/project-admin.py ls                  # 看当前项目清单与条目数
python3 scripts/project-admin.py rm foo --dry-run    # 预览：摘标签 + 归档（面板立即消失）
python3 scripts/project-admin.py rm foo --yes        # 执行（自动备份 memory.db 为 .bak-<时间戳>）
python3 scripts/project-admin.py mv foo bar --yes    # 改名（同名已存在则等价于合并）
```

`rm` 三种处理方式：`--mode archive`（默认，摘标签+归档，记忆仍在库里可查）/ `unlabel`（摘标签但保持 active，仍参与检索注入）/ `global`（转为全局，跨项目注入）；加 `--purge` 额外物理删除该项目下非 active 的条目。**删项目前先停掉 `dsh web`**，避免插件并发写覆盖。

**项目错归属防护（v2）**：project 不再由模型编标签，而是**由工作区自动派生**——有 git 用归一化 remote origin 地址（如 `github.com/jcazalea/dsh-meow-memory`，剥协议/凭证/端口/尾部 `.git`、host 小写），无 git（或本地仓库无 remote）用规范化绝对路径。解析规则：

- **探测**：沿 cwd 向上找最近 `.git`（与 `git rev-parse --show-toplevel` 语义一致，支持 worktree/submodule 的 gitfile），只向上不向下（父目录含多个子仓库时走路径 id，确定性可审计）。
- **写入**：`memory_remember` 的 `project` 参数可选，缺省 = 当前工作区解析 id；显式传且与当前项目不一致时**自动改写为当前项目并返回 `note`**；「全局」通道保留（跨项目准则/用户偏好）。会话锚定在首轮由解析器自动设置，工具调用不再改变锚定（`memory_project` 不传参数即查当前项目）。
- **旧数据**：既有逻辑名（`femwa`、`meow-memory` 等）保持原样，升级后新记忆走新 id（双轨并存，暂不迁移；可用 `project-admin.py mv` 手工合并）。
- 开关：`apply({ resolveProject: false })` 退回「模型显式传 project」模式。

配套两个只读诊断脚本：

```bash
python3 scripts/project-check.py foo --workspace /path/to/cwd   # 写前校验：名字存在？与目录名匹配？
python3 scripts/project-audit.py                                 # 审计：扫描会话痕迹，标出锚定与目录名不符的会话
```

**只读与安全（硬约束）**

- 跨工作区读取用 `new DatabaseSync(path, { readOnly: true })`：拒绝写、**拒绝打开不存在的库**（不会给别的工作区误建库）。刻意**不复用 `getDb()`**——它会 `mkdirSync` + 建表 + 跑 `upgrade()`。
- `workspace` 参数一律过白名单（`workspaceRegistry.list().path` ∪ 会话窗口索引），非白名单直接 403；路由只在本机 loopback 上暴露，记忆正文不写日志。
- 单库损坏/无库只影响它自己：进 `meta.partial` / 返回 `no-db`，全局视图照常渲染其余工作区。

**星图的边从哪来（诚实版）**

| 边 | 来源 | 可靠性 |
| --- | --- | --- |
| 结构边 | `project`（含多值）、`source_session` 字段直出 | 确定 |
| 相似边 | 关键词倒排取候选 + bigram 余弦，阈值 + 每节点 topK 剪枝 | 概率性（虚线绘制） |
| 会话边 | `~/.dsh-meow/sessions/<id>.json` 的注入/检索/查阅/写过痕迹 | 确定（只覆盖痕迹文件还在的窗口） |
| 取代边 | 同 level + 高相似 + 一新一旧（旧条目已非 active） | 推断 |

数据库里**没有**声明式的"记忆 A 引用记忆 B"字段（没有 `links`/`refs` 列），所以记忆之间的关系只能推断；要做真正的知识图谱，需要在 v2 给表层加 `links`。节点/边超上限时自动降采样并在 `stats.truncated` 标记，不静默丢数据。

> ⚠️ **升级提示**：插件是从 profile 的 `node_modules` 加载的，**改完 `lib/` 需要重启 `dsh web` 才会生效**（profile 插件不走 HMR）。重启后刷新页面即可看到侧栏「记忆」图标。
>
> 自检：`node scripts/check-viewer.mjs`（顺带打印每个工作区的条目数 / 星图规模 / ETag 是否生效）。返回 404 就说明宿主还在跑旧代码。

## 🛠 开发

```sh
npm install
npm run build          # esbuild 打包 → lib/index.js（自包含）+ lib/client.js（浏览器 bundle）
npm run test           # 557 项逻辑测试：主套件 405（db/bm25/migrate/inject/reflect/dream/tools/apply）
                       #   + 记忆查看器 152（host 60 / 纯逻辑 45 / 组件渲染 31 / 打包产物挂载 16）
                       #   + 既有 client 套件（折叠 / 委托气泡 / 图标 / 跳过）
npm run typecheck      # tsc --noEmit（本地类型检查；存量 react/@dsh 运行时类型缺口已知）
```

> 没有浏览器也能验证客户端：`tests/client-viewer-render.mjs` 自带一个迷你 React 渲染器
> （hooks + effect + 桩 fetch），把三个视图真渲染一遍。它当场抓出过两个只在运行期暴露的
> bug（effect 依赖数组引用后声明的 `useCallback` → TDZ；`ui.tsx` 漏 import）。改客户端代码后
> 建议跑一遍 `npm run typecheck` 并用它复查 TS2304（未定义）/ TS2448 / TS2454 / TS2552（先用后声明）。

`@deepseek-ai/*` 包位于 dsh-meow pnpm workspace 中，不在本包的 `node_modules` 里。
在 Windows 上，`npm run link-workspace`（或 `scripts/link-workspace.ps1`）创建 workspace
包的 junction 镜像，使 esbuild 能解析它们；`build.mjs` 通过 `nodePaths` 引用。
这些链接仅构建期需要。

## 🙏 致谢

感谢每一位贡献者让 meow-memory 越来越好：

- **[daveycodez](https://github.com/daveycodez)** — 英文语言包与英文分词（[PR #6](https://github.com/Phant0Meow/dsh-meow-memory/pull/6)，v0.22.0 发布）
- **[chenmzh](https://github.com/chenmzh)** — 记忆注入改为独立 plugin snapshot 消息，根治会话标题污染（[PR #10](https://github.com/Phant0Meow/dsh-meow-memory/pull/10)）
- **[cuddly-guacamole](https://github.com/cuddly-guacamole)** — dsh 0.1.2-alpha.4 双版本 Session events 兼容（[PR #11](https://github.com/Phant0Meow/dsh-meow-memory/pull/11)）

## 📄 License

MIT —— 见 [LICENSE](LICENSE)。
