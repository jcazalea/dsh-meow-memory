# 实测脚本（向量检索可行性论证用）

`docs/vector-retrieval-feasibility.md` 里所有数字都由这些脚本产出。它们**不是测试套件**，不进 `npm test`，仅用于复现结论。

前置：先在仓库根 `npm run build`（`gap2.mjs` / `ceiling.mjs` / `embed-bench.mjs` 依赖 `lib/index.js` 导出的 `search` / `tokenize`）。

| 脚本 | 回答什么问题 | 依赖 |
|---|---|---|
| `gap2.mjs` | 词法检索在真实库上的语义盲区（问句 → 实际命中哪条） | 构建产物 + `.dsh-meow/memory.db` |
| `ceiling.mjs` | 同一段内容的改述/跨语言问法，词法打分能到多少 | 构建产物 |
| `lexical-gap.mjs` | 问句与全库条目的词面覆盖率分布 | 构建产物 |
| `scaling.mjs` | 纯 JS 暴力余弦的延迟与内存随库规模的曲线 | **无**（纯算力） |

```bash
node docs/probes/gap2.mjs
node docs/probes/ceiling.mjs
node docs/probes/scaling.mjs
```

## `embed-bench.mjs`（本地 ONNX 路线，本机跑不通）

测的是：模型加载耗时 → 全库编码吞吐 → 单句查询编码延迟 → 语义/词法召回对比。

```bash
cd /tmp/vec-probe
npm init -y
npm_config_registry=https://registry.npmjs.org npm i @huggingface/transformers@3.7.6
cp <repo>/docs/probes/embed-bench.mjs .
node embed-bench.mjs                    # MODEL=Xenova/all-MiniLM-L6-v2 可换模型
```

**本机实测结果：卡在模型权重下载**（HF 与 hf-mirror 均超时，见方案 §3.5.2），因此脚本里的编码延迟与召回增益数字**尚未取得**。换到能访问 HF 的网络后可直接跑出这些数字。

注意：`@huggingface/transformers` **必须用官方 npm 源安装**（npmmirror 会把 onnxruntime 的 GitHub release 请求改写成 302 导致失败）；解包后原生依赖约 100 MB（含意外的 78 MB CUDA provider）。
