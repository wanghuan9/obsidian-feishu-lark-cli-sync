# 实施任务清单

> 由 spec.md 生成
> 任务总数: 5
> 核心原则: 先建后迁后删，先统一同步入口与状态，再接入精确增量，最后迁移各入口并清理旧 overwrite 路径。

## 依赖关系总览

Task 1 (建立共享同步核心与状态模型)
  ↓
Task 2 (接入插件设置、i18n 与状态文件读写)
  ↓
Task 3 (迁移 Obsidian 插件内同步入口到统一同步流程)
  ↓
Task 4 (迁移 pre-push hook 与补测试)

## 变更影响概览

### 文件变更清单

| 文件 | 操作 | 涉及任务 | 说明 |
|------|------|---------|------|
| `lark-sync-core.ts` | 修改 | Task 1, 2 | 增加统一同步计划、状态模型、失败原因与语言消息 |
| `main.ts` | 修改 | Task 2, 3 | 接入 syncStrategy、状态读写、统一同步入口、通知文案 |
| `sync-pre-push.mjs` | 修改 | Task 2, 4 | 接入语言化错误输出、统一同步核心、pre-push 并发限流与状态写回 |
| `test-lark-sync-core.mjs` | 修改 | Task 1, 4 | 覆盖新核心逻辑与回归用例 |
| `test-pre-push.mjs` | 新增 | Task 4 | 覆盖 hook 状态跳过、失败通知、alias 状态、并发失败与同文档串行 |
| `package.json` | 修改 | Task 4 | 将 pre-push hook 测试纳入 `npm test` |
| `README.md` | 修改 | Task 2, 3 | 更新同步策略与自动同步说明 |
| `README.en.md` | 修改 | Task 2, 3 | 更新同步策略与自动同步说明 |
| `lark-sync-state.json` | 新建 | Task 2 | 插件私有同步状态文件模板/初始化逻辑（运行时生成） |

### 受影响接口

| 接口 | 变更类型 | 调用方 | 涉及任务 |
|------|---------|--------|---------|
| `buildUpdateDocumentArgs()` | 行为替换 | `main.ts`, `sync-pre-push.mjs` | Task 1, 4 |
| `prepareNoteContentForLark()` | 保持不变 | `main.ts`, `sync-pre-push.mjs` | Task 1 |
| `readBindingFromMarkdown()` | 保持不变 | `sync-pre-push.mjs` | Task 1 |
| `removeLarkBinding()` | 保持不变 | `main.ts`, `sync-pre-push.mjs` | Task 1 |

### 构建系统变更

- 无新增构建配置；沿用现有 `tsc` + esbuild 流程。

## 风险与假设

| # | 描述 | 影响任务 | 假设/处理 |
|---|------|---------|----------|
| 1 | 当前仓库没有 `spec.md`/`tasks.md`，需要直接基于会话确认方案落地 | Task 1-4 | 以本轮已确认设计为准，先实现最小可用版本 |
| 2 | 精确增量第一版不实现复杂块移动识别 | Task 1, 3 | 先支持 replace/insert/delete，复杂变化失败通知 |
| 3 | `lark-sync-state.json` 需要在插件目录内原子读写 | Task 2 | 由插件运行时首次创建，避免污染 Markdown frontmatter |
| 4 | 自动同步失败不能静默回退 overwrite | Task 3, 4 | 保持安全优先，只通知、不覆盖 |

## 任务列表

### 任务 1: [x] 建立统一同步核心与状态数据结构
- 文件: `lark-sync-core.ts`（修改）, `test-lark-sync-core.mjs`（修改）
- 依赖: 无
- spec 映射: spec 4.1 方案概览, 4.2 组件设计, 4.2.3 数据模型
- 说明: 把现有 `overwrite` 参数构建改成统一同步计划的基础结构，补充同步策略、失败原因、状态模型、语言化消息格式等纯逻辑能力；保留现有内容清洗与标题处理逻辑不变。
- context:
  - `lark-sync-core.ts` — 当前共享核心，只含 frontmatter 和 overwrite 参数
  - `sync-pre-push.mjs` — 共享核心的直接消费者，后续要复用新计划生成能力
  - `main.ts:syncFileInternal()` — 插件内统一同步入口的直接上游
  - `test-lark-sync-core.mjs` — 现有核心测试，需要覆盖新增接口和回归行为
- 验收标准:
  - [x] `npm test` 中现有 core 相关测试继续通过
  - [x] 新增的同步计划/状态/消息测试可执行并通过
  - [x] `grep -R "overwrite" lark-sync-core.ts sync-pre-push.mjs main.ts` 不再把 overwrite 作为唯一同步计划来源
- 子任务:
  - [x] 1.1 定义 `SyncStrategy`、`SyncFailureReason`、`DocumentSyncState` 等类型
  - [x] 1.2 提供统一的计划生成/错误文案辅助函数
  - [x] 1.3 补充核心测试覆盖

### 任务 2: [x] 接入设置项、状态文件与语言化通知
- 文件: `main.ts`（修改）, `sync-pre-push.mjs`（修改）, `README.md`（修改）, `README.en.md`（修改）
- 依赖: Task 1
- spec 映射: spec 4.1 方案概览, 4.2 组件设计, 4.2.3 数据模型, 4.2.5 错误处理
- 说明: 在插件设置中加入同步策略开关，新增 `lark-sync-state.json` 的读写与初始化逻辑，并让 pre-push hook 和插件本体都按 `language` 输出一致的中文/英文失败通知。
- context:
  - `main.ts:loadSettings()/saveSettings()/registerSaveAutoSync()` — 设置加载与自动同步入口
  - `main.ts:installPrePushHook()` — hook 安装与脚本分发
  - `sync-pre-push.mjs:readSettings()/main()` — 独立进程读取插件设置并执行同步
  - `README.md`, `README.en.md` — 需要同步更新用户可见语义
- 验收标准:
  - [x] `main.ts` 中新增设置项可以编译通过，默认值为安全增量
  - [x] 插件能读写 `lark-sync-state.json`，且不会写入 frontmatter
  - [x] pre-push 输出会根据 `language` 切换中英文
  - [x] README 中同步策略说明与实际行为一致
- 子任务:
  - [x] 2.1 增加设置项与设置文案
  - [x] 2.2 新增状态文件读写与原子落盘
  - [x] 2.3 让 hook 输出跟随语言设置
  - [x] 2.4 更新文档说明

### 任务 3: [x] 迁移 Obsidian 插件内同步入口到统一流程
- 文件: `main.ts`（修改）, `lark-sync-core.ts`（修改）, `test-lark-sync-core.mjs`（修改）, `main.js`（生成）, `lark-sync-core.mjs`（生成）, `reviews/task3-review.md`（新增）
- 依赖: Task 1, Task 2
- spec 映射: spec 4.1 方案概览, 4.2 组件设计, 4.2.4 并发模型, 4.2.5 错误处理
- 说明: 把手动同步、保存后自动同步、目录同步统一接到同一套同步决策与失败处理上，precise 模式失败必须通知，不自动 overwrite；目录同步去掉二次覆盖流程，改为一次生成最终内容后再同步。
- context:
  - `main.ts:syncFileInternal()/syncOrRecreateDocument()` — 当前单文件同步主路径
  - `main.ts:publishFolder()` — 当前目录同步与二次覆盖逻辑
  - `main.ts:runSaveAutoSync()` — 保存后自动同步路径
  - `main.ts:queueSaveAutoSync()` — 自动同步去重与节流逻辑
- 验收标准:
  - [x] 手动同步、保存后自动同步、目录同步都调用统一同步入口
  - [x] `precise` 模式下无法安全更新时只通知、不 fallback overwrite
  - [x] 目录同步不再对已有远端文档执行二次覆盖；新建文档仅在内部链接重写后内容变化时执行 bootstrap 覆盖
  - [x] `npm test` 通过现有前端相关测试
  - [x] Code Review PASS
- 子任务:
  - [x] 3.1 抽取统一同步编排函数
  - [x] 3.2 接入状态判断和失败通知
  - [x] 3.3 改造目录同步为单次最终内容同步

### 任务 4: [x] 迁移 pre-push hook 并补性能/回归测试
- 文件: `sync-pre-push.mjs`（修改）, `test-pre-push.mjs`（新增）, `package.json`（修改）, `reviews/task4-review.md`（新增）
- 依赖: Task 1, Task 2, Task 3
- spec 映射: spec 4.2 组件设计, 4.2.4 并发模型, 4.2.5 错误处理, 4.3 性能考虑
- 说明: 让 pre-push hook 复用统一同步计划与失败通知规则，并补充针对状态跳过、语言输出、并发限流/失败汇总的测试用例。
- context:
  - `sync-pre-push.mjs` — 独立同步入口，需和插件主流程保持一致
  - `lark-sync-core.ts` — 共享计划生成与错误文案
  - `test-lark-sync-core.mjs` — 核心逻辑回归测试入口
- 验收标准:
  - [x] pre-push 不再直接调用旧的 overwrite-only 构建路径
  - [x] pre-push 失败时输出与插件语言设置一致
  - [x] 新增测试覆盖状态跳过和失败通知路径
  - [x] `npm test` 全部通过
- 子任务:
  - [x] 4.1 替换 hook 同步执行路径
  - [x] 4.2 补充失败通知与退出码语义
  - [x] 4.3 补充回归测试

### 后续优化记录
- 文件: `main.ts`（修改）, `lark-sync-core.mjs`（生成）
- 说明: 目录发布与目录同步改为固定 3 并发，目录内同一远端文档保持串行，减少大目录的总耗时和同文档竞态风险；同时缓存 `lark-cli` 路径与 login shell PATH，避免每次调用重复探测。

### 任务 5: [x] 保持已发布目录的单文件内部链接
- 文件: `src/main.ts`（修改）, `src/link-rewrite.ts`（修改）, `test/test-link-rewrite.mjs`（修改）, `main.js`（生成）, `reviews/task5-review.md`（新增）
- 依赖: Task 3
- spec 映射: 本轮已确认的最小修复方案
- 说明: 单文件手动或保存后同步时，仅读取所属已发布目录的现有文档绑定，复用目录发布的链接映射规则改写当前文件内部链接；不同步其他文件，不修改同步核心或状态结构。
- context:
  - `src/main.ts:syncFileInternal()` — 单文件手动/自动同步的统一入口
  - `src/main.ts:buildFolderLinkMap()` — 目录发布的现有链接映射调用方
  - `src/link-rewrite.ts:rewriteInternalLinks()` — 内部链接解析和飞书引用转换
  - `src/lark-sync-core.ts:buildSyncPlan()` — 下游 block hash 和精确同步计划，本任务保持不变
- 验收标准:
  - [x] `npm test` 全部通过
  - [x] `npm run build` 通过且无新的 TypeScript 错误
  - [x] 已发布目录内单文件同步与目录发布使用同一链接映射函数
  - [x] 只修改非链接段落时，内部链接转换结果保持一致
  - [x] Code Review PASS
- 子任务:
  - [x] 5.1 抽取并复用目录链接映射构建逻辑
  - [x] 5.2 在已绑定文件的单文件同步前改写内部链接
  - [x] 5.3 补充非链接段落变更的回归测试
  - [x] 5.4 通过完整测试、构建、代码评审与本地安装验证

## Spec 覆盖映射

| Spec 章节 | 任务 | 说明 |
|-----------|------|------|
| 4.1 | Task 1, 2, 3, 4 | 统一同步策略、失败处理与自动同步兼容 |
| 4.2 | Task 1, 2, 3, 4 | 核心模块、设置、hook、自动同步与目录同步 |
| 4.2.3 | Task 1, 2 | 同步状态与增量元数据模型 |
| 4.2.4 | Task 3, 4 | 限流并发与文档内串行 |
| 4.2.5 | Task 1, 2, 3, 4 | 失败通知、回退与阻断策略 |
| 4.3 | Task 4 | 性能与快速跳过路径 |
| 本轮确认方案 | Task 5 | 已发布目录内单文件同步保持飞书内部链接 |
