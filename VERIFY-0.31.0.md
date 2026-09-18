# v0.31.0 查看器写操作 — 验证报告

日期：2026-09-18 · 实现 + 全量测试 + 自检均在本机完成。

## 一、功能清单（已实现并验证）

| 功能 | 实现 | 验证 |
|---|---|---|
| 修改记忆 | `POST /memory/update`（body `{workspace,id,expectUpdatedAt?,patch}`）+ 前端 `EditModal` 浮层（内容/重要性星标/关键词/状态/项目下拉/子类/ goal / title，按层门控） | tests/viewer.mjs 写操作段 |
| 逻辑删除（无效记忆） | `POST /memory/archive` → `status=archived`（默认列表消失，`status: archived` 过滤器可找回） | 同上 |
| 还原 | `POST /memory/restore` → `status=active` | 同上 |
| 物理删除 | `POST /memory/purge` → 删行 + 清理 `projects` 孤儿映射；前端 `prompt` 输入「删除」二次确认 | 同上（孤儿项目清理专项断言） |
| 审计留痕 | `viewer_log` 表 + `GET /audit`；「整理留痕」tab 展示 | 四种动作 + 摘要断言 |
| 乐观锁 | `expectUpdatedAt` 不匹配 → 409 `conflict` | 专项断言 |
| UI 稿 | `docs/mockups/05-edit-delete.svg/png`（`render-05-edit-delete.mjs` 可再生） | rsvg-convert 已出图 |

## 二、关键设计（与方案一致）

- 写路径直接可写打开中央库（`busy_timeout 5s`），**绝不调用 `getDb()`**（防建表/迁移）——复用 `/projects/rename` 先例。
- 写操作只接受完整 36 位 id（前缀匹配有同毫秒歧义）。
- `sanitizePatch` 字段白名单：未知字段一律丢弃，绝不经 body 直写 SQL。
- 物理删除为本次用户拍板新增（超出旧设计 §10「仅软删除」边界），仍留审计记录。

## 三、测试结果（`npm test` 全量，日志见 `VERIFY-0.31.0.log`）

```
test.mjs               478 passed, 0 failed
tests/viewer.mjs        98 passed, 0 failed   （含 +25 写操作断言；6 连跑验证无同毫秒竞态）
tests/client-viewer.mjs 45 passed, 0 failed
tests/client-viewer-render.mjs  37 passed, 0 failed
tests/client-viewer-mount.mjs   16 passed, 0 failed
tests/client-fold.mjs   24 passed, 0 failed
tests/client-delegate-notice.mjs 22 passed, 0 failed
tests/client-delegate-vanish.mjs 13 passed, 0 failed
exit = 0
```

## 四、上线自检

`npm run check-viewer` ✓（数据面 14 工作区 / 211 记忆 / ETag-304 全正常）。

> ⚠️ 运行中的 dsh web 经 profile `link:` 加载的是**启动时的旧 lib**——本次改动需**重启 dsh web** 后，面板里才会出现「编辑 / 无效记忆（归档）/ 物理删除」按钮。git push 需在本地终端执行（本环境无 GitHub 凭证）。

## 四·补、UI 反馈轮（2026-09-18）

用户反馈：「按钮不明显」「中间的记忆列表，应该有滚动条，不应该全屏一起滚动」。已修：
- 操作按钮醒目化：编辑=实心主色（✎）、无效记忆（归档）=琥珀、物理删除=红色（✕）、还原=绿色（↩），与复制按钮分行；`EditModal` 保存键同步实心主色。
- 列表独立滚动：`.mmv-wsview` 改 `align-items:stretch`、`.mmv-pane.mid` 加 `overflow:auto;min-height:0`——列表在面板内滚动，不再全屏滚动。
- 全量测试复跑 8 套件全绿；`docs/mockups/05-edit-delete.*` 已同步新按钮样式。

## 四·补2、UI 反馈轮 2（2026-09-19）

用户反馈 5 条，全部修复：
1. 复制正文/复制 id 后按钮变「✓ 已复制…」提示，1.6s 回退。
2. 列表滚动时顶部搜索+状态过滤固定：`.mmv-filters` 改 `position:sticky`（主题底色，列表不穿透）。
3. 编辑弹窗支持 ESC 关闭（保存中不响应）。
4. 关键词编辑区改 3 行 textarea（逗号/中文逗号/换行皆可分隔）。
5. 状态/项目/子类下拉框显式主题底色（`select.mmv-input` + option），深色模式跟随系统。
全量测试 8 套件复跑全绿；UI 稿已同步。

## 五、发现并解决的问题

1. **同毫秒竞态**（测试非确定性）：fixture insert 与首笔 update 落在同一毫秒时，`updated_at` 不严格增大 → 「刷新/409/no-op/审计摘要」四断言连锁失败。修法：测试中 insert 后 sleep 15ms；另把自动刷新的 `updated_at` 从审计摘要「改」列表剔除（它不算用户改的字段）。
2. **惰性建表与只读句柄快照冲突**：`ViewerReader` 打开时快照表集合，而 `viewer_log` 是面板首次写时才惰性创建 → 缓存句柄永远读不到。修法：`auditLog` 不依赖 `has()` 守卫，直接查询 + try/catch fail-open。
3. **测试脚本笔误**：`MemoryRow` 字段是下划线风格，fixture 误用 `editFact.updatedAt`（应为 `updated_at`）导致乐观锁形同虚设——修正后 409 路径真实生效。
