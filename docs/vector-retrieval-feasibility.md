# meow-memory 向量检索（语义召回）可行性方案

> 版本：v0.27.0 现状 · 2026-09-13
> 配图：`docs/mockups/04-vector-retrieval-design.svg`（PNG 同目录）
> 本文所有数字均为本机实测，命令与结果在 §2、§3。

---

## 1. 结论

**能支持，但不是"往现有链路里塞一个向量库"，而是"给检索加一条并行的第二通道，再由融合层合并"。**

四句话说完：

1. **技术上完全可行**——存储层只要一张 `memory_vec` 表，检索用纯 JS 暴力余弦即可，**不需要引入 sqlite-vec、不需要原生模块**；
2. **真正的硬约束只有一个**——`agent/pre-step` 在每个 step 前**同步**执行注入，向量通道一旦阻塞就会拖慢每一轮对话（§3.1）；
3. **值不值得做要看目标**——如果目标是"改述/同义/跨语言也能召回"，价值很实在（§2.2 实测词法确实失明）；如果只是为了"更好的搜索"，当前 19 条记忆的规模下收益接近于零，**应该等库长到几百条再上**；
4. **本地小模型这条路，本机暂时验证不了**——原生依赖能装（需换官方 npm 源），但**模型权重下不来**（HF 与 hf-mirror 全部超时，§3.5.2）。要走这条，必须先把"权重从哪来"设计清楚。

推荐路线：**词法为主 + 语义为辅的双通道融合，语义通道默认关闭（`λ=0` 时与 v0.27.0 行为逐字节一致）**，先落地"表 + 融合层 + 离线回填"，再决定要不要接本地 ONNX 模型。

---

## 2. 现状实测

### 2.1 库的规模（决定要不要向量索引）

```
soul     0 条
user     1 条      73 字符
project 12 条   5,521 字符
fact     0 条
lesson   6 条   2,024 字符
topic    0 条
rules    0 条
────────────────────────────
合计    19 条   7,618 字符        DB 文件 1.2 MB（WAL 撑大，实体仅 4 KB）
```

**这个规模是全部结论的前提**：19 条记忆下，任何检索方式的延迟都可忽略，向量索引的"加速"价值为零；向量带来的唯一增量是**召回质量**。

### 2.2 词法检索的语义盲区（实测）

现有命中链路（`src/inject.ts:550`）的打分面是**条目 keywords + title**，用 BM25 × 覆盖率 × 艾宾浩斯 × importance：

```ts
const hits = keywordHitScore(query, docs, { k: o.hitTopK })
```

用真实库和真实问句打，结果如下（`now: null` 关闭时间衰减，纯看词法能力）：

| 用户可能这样问 | 应该命中 | 词法实际给出 | 判定 |
|---|---|---|---|
| 为什么我改了代码没有生效 | 「profile 插件不热重载」lesson | 「用户对本项目的定位原话」project（无关） | ❌ 失明 |
| 本地缓存目录只读导致装不上包 | 「npm cache EROFS」相关 | 沾边（靠 npm/test 等偶然词） | ⚠ 侥幸 |
| 为什么时间戳会串到别的条目 | 「同毫秒 id 串号」lesson（第 3 位） | 两条 meow-memory project 概述排在前 | ⚠ 排序错 |
| 启动时文件没准备好服务连不上 | 「webServer 晚于插件就绪」lesson | 「用户偏好：交付物要带配图」user（无关） | ❌ 失明 |
| 怎么把旧格式老记忆搬进数据库 | 「migrate 旧 PROJECT.md→SQLite」 | 「用户对本项目的定位原话」（无关） | ❌ 失明 |

**失败机制很清晰**：用户口语化提问与 `keywords` 字段的词面几乎不重叠。BM25 只能靠偶然命中的高频词凑分，于是把「内容长、关键词泛」的项目概述顶到前排。

这正是**语义向量唯一能补、且词法永远补不上的那一块**。

### 2.3 词法检索的"上限"（同一段内容的改述 / 跨语言）

同一段内容（profile 插件不热重载）作为唯一候选，换三种问法：

| 问法 | 词法得分 | 说明 |
|---|---|---|
| `profile plugin lib change takes effect immediately?` | 1.003 | 靠 profile / lib 这两个英文词偶然命中 |
| `为什么我改了代码没有生效` | 0.575 | 只剩"生效"一个词的弱信号 |
| `改了 lib 不重启会怎样` | 1.178 | 有 lib / 重启 直接重叠 |

结论：**词法不是"完全不能用"，而是"必须恰好撞上同一个词"**。跨语言问答场景（用户中文提问、记忆英文存储，或反之）在当前实现下**必然零命中**——`tokenize` 的 CJK bigram 与拉丁整词是两套完全不相交的词表。

---

## 3. 硬约束（决定方案长什么样）

### 3.1 每消息热路径不可阻塞 ⚠ 最重要

```ts
ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
  const decision = await next()
  return (await preStepInject({ agent, signal }, decision))
})
```

注入挂在 pre-step，**每个 step 前同步 await**。当前这行 `keywordHitScore` 是全库内存计算的毫秒级操作。一旦语义通道要"把用户消息喂给模型编码"，就变成：

- 本地 ONNX 小模型：单句编码 **几十毫秒量级**（CPU）
- 云端 API：单次 **100–500ms** + 网络抖动

**这会把每一轮对话都拖慢**，且编码失败时整条链路 fail-open 退化——不可接受。

**因此设计上必须满足**：
1. **查询向量缓存**：按消息文本 hash 缓存，同一消息只编码一次（多 step 复用）；
2. **超时降级**：`Promise.race` + N 毫秒超时，超时即 `λ=0` 走纯词法，本步不注入语义命中；
3. **异步预热**：编码在上一轮 turn-stopping 或首轮时后台预跑，pre-step 只读缓存；
4. **写入侧同步算**：`memory_remember` / `memory_update` / dream 封存时算向量——写入不在热路径，可以慢。

### 3.2 零运行时依赖 + 无原生模块是项目红线

`package.json` 的 `dependencies` 为空，`node:sqlite` 内置驱动。全项目 10,841 行里没有任何原生模块。

**任何引入 ONNX Runtime 的方案都会打破这条红线**，所以它必须是**可选、可缺席、缺席时功能自动降级**的模块。

### 3.3 node:sqlite 的扩展加载（实测）

```
node v24.15.0 / SQLite 3.51.3
DatabaseSync 有 loadExtension / enableLoadExtension 方法

直接 enableLoadExtension(true)：
  ✗ ERR: Cannot enable extension loading because it was disabled at database creation.

new DatabaseSync(':memory:', { allowExtension: true }) + enableLoadExtension(true)：
  ✓ OK
  ✓ loadExtension('/nonexistent/vec0.so') → 尝试 .so.so，说明真去 dlopen 了
```

**结论：技术上能用 sqlite-vec**（Node 24 支持 `allowExtension` 构造选项）。但**不建议**：

| 反对理由 | 说明 |
|---|---|
| 打破零依赖 | sqlite-vec 要随平台分发 `vec0.so` / `vec0.dylib` / `vec0.dll` |
| 生态不成熟 | sqlite-vec 仍是 pre-v1；社区已有"node:sqlite + sqlite-vec 在 macOS 装不上"的实测坑（编译期 `OMIT_LOAD_EXTENSION`） |
| **完全没必要** | 见下方实测：纯 JS 暴力余弦在 1 万条内 &lt;3ms |

### 3.4 纯 JS 暴力余弦的可扩展性（实测）

384 维 Float32，随机向量，测 dot product 全表扫描：

| 库规模 | 单次查询 | 原始 f32 占用 |
|---:|---:|---:|
| 100 条 | 0.06 ms | 0.15 MB |
| 1,000 条 | 0.37 ms | 1.46 MB |
| 5,000 条 | 2.52 ms | 7.32 MB |
| 20,000 条 | 9.82 ms | 29.30 MB |

**结论**：这个插件是"每工作区一份库"，真实规模是几百到几千条。**暴力余弦比现有 BM25 还快**，引入 ANN 索引或 sqlite-vec 纯属过度设计。Int8 量化（精度损失 ~0.003）还能把内存再砍 4 倍，属可选优化。

### 3.5 本地 ONNX 模型在本机的真实障碍（实测）

想走"本地小模型"路线，本机实测先卡在**安装**这一步（后来换源解决，见 §3.5.1）：

```
npm install @huggingface/transformers          (v4.2.0)
  ✗ onnxruntime-node@1.24.3 postinstall 失败
    Error: Failed to download build list. HTTP status code = 302

npm install --omit=optional
  ✗ 无效：v4 已把 onnxruntime-node 从 optional 提升为硬依赖

npm install @huggingface/transformers@3.7.6    (v3，镜像源)
  ✗ Failed to download build list. HTTP status code = 302

npm install @huggingface/transformers@3.7.6    (官方源)
  ✗ 走到下载 onnxruntime-linux-x64-gpu-1.21.0.tgz
    Extracting libonnxruntime_providers_cuda.so ...
    `nvcc` not found. Assuming CUDA 12.
```

两个独立的环境级坑：

1. **npmmirror 镜像把 GitHub release 请求改写坏**（302）；换官方源后**安装成功**（`--registry=https://registry.npmjs.org`）；
2. **本机是纯 CPU 机器（无 `nvidia-smi`），onnxruntime-node 却去拉 GPU 版**（`onnxruntime-linux-x64-gpu-1.21.0.tgz`），解包时 `nvcc` not found。

这与本项目已有的环境记忆完全同源（npm 缓存目录在沙箱外只读 → EROFS）——**这台机器上任何带 postinstall 二进制下载的包都需要预先验证**。

#### 3.5.1 但换官方源后真的装成了（修正上面的判断）

```
npm install --registry=https://registry.npmjs.org @huggingface/transformers@3.7.6
  ✓ 完成（CUDA provider 解包报 nvcc 缺失，但未中断安装）

node -e "import('onnxruntime-node')"
  ✓ onnxruntime-node OK
  ✓ version: { common: '1.21.0', node: '1.21.0' }
```

`onnxruntime-node` 的原生二进制：`libonnxruntime.so.1`（21.9 MB）+ `onnxruntime_binding.node`（347 KB）+ 意外多下的 `libonnxruntime_providers_cuda.so`（**78 MB**）。

**注意那 78 MB**：纯 CPU 机器上，本地模型路线的原生依赖解包后约 **100 MB 起**——这是"零依赖"之外第二个必须正视的体积成本。

#### 3.5.2 真正的断点：模型权重下不来（实测）

装好依赖后跑真实编码 benchmark，卡在**模型权重下载**：

```
model: Xenova/all-MiniLM-L6-v2
TypeError: fetch failed
  cause: ConnectTimeoutError (attempted addresses:
    2a03:2880:f111:83:face:b00c0:25de:443,  75.126.135.131:443, timeout: 10000ms)

# 换镜像端点逐个验证
curl https://hf-mirror.com/Xenova/all-MiniLM-L6-v2/resolve/main/config.json
  ✗ exit=124（45s 超时，一个字节都没下来）
curl https://huggingface.co/...
  ✗ 60s 超时被 SIGTERM
```

**结论（对本机/本网络环境）：**

| 环节 | 实测结果 |
|---|---|
| npm 装依赖 | ⚠ 镜像源失败，**官方源成功** |
| 原生库加载 | ✅ 正常（onnxruntime-node 1.21.0） |
| **模型权重下载** | ❌ **HF 与 hf-mirror 全部超时，本地 ONNX 路线在本机跑不通** |
| 因此编码延迟/召回增益 | ⏸ **无法实测**，不能靠猜写进方案 |

这直接改变方案排序：**方案 B（本地 ONNX）在本机当前网络下不可验证，也不该作为默认实现**。若要走 B，必须先解决权重来源（离线自带 / 内网镜像 / ModelScope 等），并且模型分发方式要成为设计的一部分，而不是实现细节。

> ⚠ 对插件用户的含义：如果 `onnxruntime-node` 在用户机器上装不上，插件会**直接安装失败**（npm 的 postinstall 是非可选的）。所以本地模型**绝不能进 `dependencies`**，只能是用户显式安装的可选 peer。

---

## 4. 候选方案对比

| 维度 | A. 云端 embedding API | B. 本地 ONNX 小模型 | C. 纯 JS 降级方案 |
|---|---|---|---|
| 代表 | OpenAI / Jina / Voyage | transformers.js + bge-small-zh / all-MiniLM-L6 | 字符 n-gram + 同义词表 + topic 质心扩展 |
| 依赖 | HTTP，无原生模块 | onnxruntime（原生！） | **零** |
| 联网 | 每条必须 | 仅首次下载模型 | 无 |
| 隐私 | 记忆出网 ❌ | 本地 ✅ | 本地 ✅ |
| 跨语言 | ✅ 强 | ✅ 中（多语言模型） | ❌ 基本无 |
| 每消息延迟 | 100–500ms ❌ | 几十 ms ⚠ | &lt;1ms ✅ |
| 首次体验 | 立即可用 | 下载 ~30–100MB 模型 | 立即可用 |
| 安装风险 | 无 | 原生依赖 ~100MB；镜像源装不上（§3.5.1） | 无 |
| 权重获取 | — | **本机 HF/hf-mirror 全超时（§3.5.2）** | — |
| 与项目红线 | 破"不联网" | 破"零依赖" | **完全兼容** |
| 本机实测判定 | ❌ 不建议 | ⚠ 方向可行，但**本机无法验证**，需先解决权重来源 | ✅ 兜底 |

> **用户取向（2026-09-13 拍板）**：接受"可选 peer + 首次使用下载权重"的本地 ONNX 形态（B），不接受云端 API（不破坏本机隐私）；但**默认实现仍是词法通道**，B 的落地以解决权重来源为前提。

### 4.1 关于方案 C 的具体做法（零依赖的"伪语义"）

在完全不加依赖的前提下，仍能改善一部分词法盲区：

1. **同义词/别名表**：条目 `keywords` 写入时让模型多写别名（已有能力，只改 prompt），另建一份小型同义词映射（如「不生效 / 没反应 / 不起作用」→「热重载」「重启」）；
2. **topic 质心扩展查询**：复用现成的 `topicDrift`（`src/bm25.ts:447`）——先算问句与各 topic 质心的相似度，用最相关 topic 的 keywords 扩展查询词集合；
3. **字符级 Jaccard 兜底**：中文短句用字符 bigram 的 Jaccard 做粗召回（`src/viewer/graph.ts` 的相似边已经在用这招），比关键词交集更宽容；
4. **改写查询**（可选）：用主模型把用户问句改写成 3–5 个检索关键词再走 BM25——**成本是一次额外 LLM 调用**，与"零延迟"冲突，只适合 `/memory search` 这种显式检索，不适合每消息注入。

**方案 C 的天花板**：能补"用词不同但字面相近"的情况，补不了真正的语义等价和跨语言。它的价值是**让语义通道缺席时不至于完全没改善**。

---

## 5. 推荐方案（分阶段）

```
Phase 1（不引入任何依赖，可立即做）
  ├─ memory_vec 表：id / level / dim / vec(BLOB) / model / content_hash / updated_at
  ├─ 融合层：score = 词法分 + λ·语义分，同一 id 取大者，再乘 importance/艾宾浩斯
  ├─ λ 默认 0 → 行为与 v0.27.0 完全一致；置 0 即回滚
  └─ 语义通道可插拔：无 provider 时整个通道缺席，其余不变

Phase 2（可选，用户显式安装）
  ├─ provider 接口：embed(texts[]) → Float32Array[]
  ├─ 内置 provider 优先级：本地 ONNX（可选 peer）> 用户配置的 HTTP 端点 > 缺席
  ├─ 写入侧同步算向量；查询侧异步预热 + 消息 hash 缓存 + 超时降级
  └─ 冷启动回填：升级后后台逐条补算，未回填完自动只用词法

Phase 3（按需）
  ├─ topic 质心 / 星图相似边切换到真实向量（语义边从"概率性"升级）
  ├─ Int8 量化降内存；库超过 ~2 万条再考虑 ANN
  └─ 查看器：条目详情显示"语义近邻"，设置页显示向量覆盖率
```

### 5.1 融合细节

```ts
// 概念代码：唯一改动点
const lex = keywordHitScore(query, docs, { k: hitTopK * 2 })      // 现状
const sem = semanticHits(queryVec, vecIndex, { k: hitTopK * 2 })  // 新增（可缺席）

const merged = new Map<string, number>()
for (const h of lex) merged.set(h.id, { src: 'lex', s: h.score / maxLex })
for (const h of sem) {
  const prev = merged.get(h.id)
  const s = lambda * (h.cosine / maxSem)
  merged.set(h.id, prev ? { src: 'both', s: prev.s + s } : { src: 'sem', s })
}
// 再乘 importance 权重与艾宾浩斯（沿用 recencyWeight）
// 排序取 top-K → 仍走独立 plugin snapshot，不改写用户 prompt
```

**要点**：两路分数先各自归一化（除以本轮最大值）再相加，否则 BM25 的绝对量纲会压死余弦值。命中来源（`lex` / `sem` / `both`）应记进调试日志，方便评估 λ 调得好不好。

### 5.2 设置页扩展（建议）

与现有 `CONFIG_DEFAULTS`（`src/defaults.ts`）同构：新增 `semantic` 子对象，和 `dream` / `delegate` 平级；`settings-page.ts` 的 FieldSpec 加一组 `sub: 'semantic'` 即可（`factoryDefaultOf` 已支持二级子对象）。

```ts
semantic: {
  enabled: false,
  provider: 'auto',            // auto | local | http | off
  model: 'bge-small-zh-v1.5',
  lambda: 0.35,
  timeoutMs: 50,
  backfill: 'background',
  minEntries: 200,
}
```

| 配置项 | 默认 | 说明 |
|---|---|---|
| `semantic.enabled` | `false` | 总开关；关闭时零开销 |
| `semantic.provider` | `auto` | `auto` / `local` / `http` / `off` |
| `semantic.model` | `bge-small-zh-v1.5` | 本地模型 id（首次使用时下载） |
| `semantic.lambda` | `0.35` | 语义权重；0 = 退化为纯词法 |
| `semantic.timeoutMs` | `50` | 单次查询编码超时，超时降级纯词法 |
| `semantic.backfill` | `background` | 冷启动回填策略 |
| `semantic.minEntries` | `200` | **库小于此值直接跳过语义通道**（当前 19 条 → 自动不启用） |

最后一项是关键的产品判断：**让插件自己知道"现在还不值得用向量"**。

---

## 6. 风险与开放问题

| # | 风险 | 缓解 |
|---|---|---|
| 1 | 每消息编码拖慢对话 | 缓存 + 超时 + 异步预热；`minEntries` 门限；λ 可关 |
| 2 | 热路径阻塞导致"看起来卡" | 超时降级到纯词法，绝不 fail-hard |
| 3 | onnxruntime 装不上（§3.5 实测） | 绝不放 `dependencies`；设为可选 peer + 安装前置检测 + 友好降级提示 |
| 4 | 模型权重体积（30–100MB） | 不随包分发，首次使用时按需下载；或走 HTTP provider |
| 5 | 向量与内容不一致（改了内容没重算） | `content_hash` 校验，命中即视为失效重算；dream 封存时统一刷 |
| 6 | 多工作区多库 | `memory_vec` 每库自带，无需中心化 |
| 7 | 评估缺基准 | 建议先建 20–30 条"问句→期望条目"的标注集，作为 λ 与门限的回归测试（可进 `test.mjs`） |

**开放问题（需要你拍板）**

1. **目标场景**究竟是"用户口语化提问也能召回"，还是"跨语言检索"，还是"只是想试试"？——决定选 B 还是 C。
2. 语义通道是**每消息自动命中**，还是只在 `memory_search` 工具里用？——后者零热路径风险，性价比可能更高。
3. 是否接受**首次使用时下载模型**（30–100MB）的体验？
4. λ 与 `minEntries` 的默认值，要不要先在当前 19 条库上做标注集验证再定？

---

## 7. 本机已复现的命令

```bash
# 库规模
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('.dsh-meow/memory.db',{readOnly:true});for(const l of ['soul','user','project','fact','lesson','topic','rules']){try{console.log(l,db.prepare('select count(*) c from '+l).get().c)}catch{}}"

# node:sqlite 扩展加载（能否用 sqlite-vec）
node -e "const s=require('node:sqlite');const db=new s.DatabaseSync(':memory:',{allowExtension:true});db.enableLoadExtension(true);try{db.loadExtension('/nonexistent/vec0.so')}catch(e){console.log(e.message)}"

# 词法失明复现 / 词法上限 / 暴力余弦可扩展性（需先 npm run build）
node docs/probes/gap2.mjs
node docs/probes/ceiling.mjs
node docs/probes/scaling.mjs

# 本地 ONNX 路线（需官方 npm 源；本机卡在模型权重下载）
npm_config_registry=https://registry.npmjs.org npm i @huggingface/transformers@3.7.6
node docs/probes/embed-bench.mjs
```

> 全部实测脚本与运行说明见 `docs/probes/README.md`；配图源文件 `docs/mockups/04-vector-retrieval-design.svg`（PNG 同目录）。
> 探测用的 `node_modules` / 缓存（约 750 MB，含 78 MB CUDA provider）已清理，未留在仓库内。
