# 记忆查看器（Memory Viewer）功能流程图 & 启动卡住问题分析

> 版本：v0.27.0（2026-09-13 新增）｜数据面 `src/viewer/`，客户端 `src/client-viewer/`，入口 `src/index.ts`
> 配套设计文档：`docs/memory-viewer-design.md`；UI 稿：`docs/mockups/*.png`

---

## 一、功能总览（一句话）

**宿主侧新增一组只读 JSON API（跨工作区聚合 + 星图边计算），客户端新增一个"记忆"全幅面板（全局 / 工作区 / 星图三层视图）——零 dsh 本体改动，全部走官方扩展点。**

---

## 二、功能流程图（启动注册路径）

```
dsh web 启动
  └─ cordis loader 加载 profile bundle（package.json dsh.profile.bundles 含 meow-memory）
       └─ meow-memory apply(ctx, config)
            ├─ 1. 设置命名空间注册（双版本兼容；失败降级到 patch 层，不阻塞）
            ├─ 2. resolveConfig → enabled 检查
            ├─ 3. loadWindowIndex()            → perf.log "window-index restored 21 windows"
            ├─ 4. registerMemoryTools()        → ctx.tools.register(memory_* 5 个工具)
            ├─ 5. dream 调度 + DreamStateBroadcast（SSE 数据面）
            ├─ 6. tryRegisterDreamRoutes(0)    → webServer 未就绪则 1s×20 重试
            │      └─ ctx.effect(() => ws.register({kind:'exact', ...}))   ← dispose 自动注销
            ├─ 7. ★ createViewerApi()          → new ViewerRepository(dir)   ← 惰性，构造不重
            │      └─ tryRegisterViewerApi(0)  → webServer 未就绪则 1s×20 重试
            │            └─ ctx.effect(() => wsvc.register({kind:'prefix',
            │                 path:'/meow-memory/api', handler}))            ← 一条 prefix 接全部端点
            │                  └─ dispose → repo.closeAll()（关只读句柄）
            └─ 8. tryRegisterDreamCommand(0)   → /dream 用户命令（1s×20 重试）
```

## 三、功能流程图（请求运行时路径）

```
浏览器（dsh web shell）
  └─ applyViewerPanel(ctx)（client.ts 内，fail-open：缺 slot 静默降级）
       ├─ slots.inject('main', {key:'meow-memory'}, MemoryViewerPanel)   ← 中央面板
       └─ slots.inject('sidebar.panellist', {id:'meow-memory', order:20,
            label:'记忆'}, MemoryGlyph)                                   ← 侧栏图标
              └─ 点击图标 → layout.selectPanel('meow-memory') → 全幅面板挂载
                    └─ MemoryViewerApp
                         ├─ ScopeBar（全局 / 工作区 / 星图 切换）
                         ├─ GlobalView     → GET /meow-memory/api/overview | /workspaces
                         │                    （60s 自动刷新 REFRESH_MS）
                         ├─ WorkspaceView  → GET /api/projects | /memories | /timeline
                         │                    | /sessions | /similar（详情抽屉）
                         ├─ StarMapView    → GET /api/graph（Canvas：星座布局默认/力导向备选；
                         │                    边：结构/相似/会话读写/取代，可分别开关）
                         └─ 搜索框         → GET /api/search?q=...（300ms 防抖）
                              └─ fetch 错误（404/网络）→ ViewerApiError → 面板显示错误，不阻塞其余功能

GET /meow-memory/api/*（宿主 prefix 路由，node:http (req,res)）
  └─ handle()
       ├─ URL 解析 → 按 method+pathname 分发 12 端点：
       │     context / workspaces / overview / memories / memory / projects
       │     / timeline / dreams / sessions / similar / search / graph
       ├─ allowedNow()：白名单 = workspaceRegistry.list().path ∪ 会话窗口索引 cwd
       ├─ workspace 参数 → resolve() 白名单校验（非白名单 → 403，绝不接受任意路径）
       ├─ ViewerReader：node:sqlite readOnly 打开 <ws>/.dsh-meow/memory.db
       │     （拒绝写、拒绝打开不存在的库；句柄 LRU 缓存上限 16；缺表/损坏 fail-open 返回空）
       ├─ aggregate.ts / graph.ts / bm25.ts 计算（KPI、项目清单、时间线、星图边）
       ├─ 响应 { ok, data, meta:{ generatedAt, etag, partial } }
       │     If-None-Match → 304；单库坏了只进 partial，不拖垮全局视图
       └─ 未知端点 → 404 { ok:false, ... }
```

## 四、启动卡住问题分析（结合日志，最后一次启动 17:53:40 之后）

### 4.1 关键日志证据（时间均为本地 UTC+8；最后一次启动 = pid 45377，17:53 启动）

| 时间（本地） | 日志来源 | 内容 |
|---|---|---|
| 09:46:25–09:53:32 | `perf.log` | **8 个 dsh web 进程**依次启动（pid 35208→44686），每个只跑到 apply #1 |
| 17:52:25 | `state.json` | `{"disabled":["@linxin666/dsh-web-all","meow-memory"],...}` — **插件管理器持久化"用户已停用 meow-memory"** |
| 17:53:28 | `cordis.patch.yml` | meow-memory `disabled: false`（**loader 配置是启用的**）—— 两处"真相"打架 |
| 17:53:40 | `perf.log` | apply #1 pid=45377 成功（window-index restored 21 windows） |
| 17:53:43 | market log | `boot: plugin kept off: meow-memory`（插件管理器启动时按 state.json 强制停用） |
| 17:53:44 | `perf.log` + `apply-error.log` | apply #2 / #3 同一进程内再次触发，均抛 `cannot create effect on inactive context`（registerMemoryTools → ctx.tools.register） |
| 17:53:42–44 | market log | 连续 14+ 条 `meow-memory -> off: fiber=false`（自愈守卫反复按下 fiber） |
| 当前实例 | HTTP 探测 | `/meow-memory/api/workspaces` → **404**（meow-memory 实际未加载，查看器不可用） |

### 4.2 根因链路（机制）

```
插件管理器（dsh-market）state.json 持久化 disabled 列表含 meow-memory
   vs
loader 配置（cordis.patch.yml + package.json bundles）声明 meow-memory enabled
        │
        ▼ 每次 dsh web 启动：
loader 先 apply（apply #1 成功，工具/路由注册完）
   → market 启动回放 disabled 列表（mountClientOnlyDeps().then）
        └─ themes.setEntryDisabled('meow-memory', true)
             ├─ 写 "disabled row meow-memory" 进 cordis.patch.yml
             └─ 日志 "plugin kept off: meow-memory"
   → loader 感知 patch 变化 → 重新 apply（apply #2 / #3）
        └─ 但 fiber 已被 dispose（inactive）
             └─ registerMemoryTools → ctx.tools.register → Fiber.effect
                  └─ "cannot create effect on inactive context" → apply 抛错（apply-error.log）
   → market 自愈守卫 host.on('internal/plugin')：disabled 列表里的插件 fiber 一起来就再按下去
        └─ apply ↔ disable 反复循环（17:53:40–44 实测多轮）
             └─ 每轮重跑 loadWindowIndex / 工具注册 / 1s×20 重试定时器（webServer/commands/viewer）
                  └─ 阻塞启动事件循环 → "卡住很久，整个 dsh 无法使用"
   → 最终 state.json 胜出："plugin kept off: meow-memory"
        └─ 当前实例 meow-memory 未加载 → /meow-memory/api/* 404 → 查看器面板不可用
```

### 4.3 结论

1. **记忆查看器功能本身不是卡住的直接原因**：`createViewerApi()` 只做 `new ViewerRepository(dir)`（惰性，构造不重），路由注册走 `ctx.effect` + 1s×20 重试，客户端面板 fail-open——查看器代码不会阻塞启动。
2. **真正的根因是"插件管理器状态"与"loader 配置"互相矛盾**：`~/.dsh/profiles/web/.dsh-market/state.json` 的 disabled 列表里躺着 `meow-memory`（还有 `@linxin666/dsh-web-all`），而 `cordis.patch.yml`/`package.json` 声明启用。启动时 loader 与插件管理器互相"apply ↔ 强制停用"拉锯，每次启动都重演一遍，造成长时间卡顿，最终以插件停用收场。
3. 时间线上，17:45–17:53 之间插件管理器做过一轮大操作（写 `cordis.patch.yml.bak-plugin-manager`、批量改 web-ui-* 行、`restart scheduled`），随后 8 次重启 `dsh web` 均卡——与拉锯战完全吻合。

### 4.4 修复建议

- **首选**：把 `meow-memory`（如需要 web-all 全家桶则连同 `@linxin666/dsh-web-all`）从
  `~/.dsh/profiles/web/.dsh-market/state.json` 的 `disabled` 列表移除，或直接在「插件管理器」UI 里把它重新启用（UI 操作会同步写 state.json），然后**重启一次 dsh web**。
- 检查 `cordis.patch.yml` 与 `state.json` 两处状态一致（都启用 / 都停用），避免再次打架。
- 若希望插件常驻：确认 profile `package.json` 的 `dsh.profile.bundles` 里保留 meow-memory，且 `cordis.patch.yml` 里 `disabled: false`。
