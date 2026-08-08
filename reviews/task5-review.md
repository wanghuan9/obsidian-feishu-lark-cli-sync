# Task 5 Code Review Report: 保持已发布目录的单文件内部链接

> **Review Date**: 2026-08-07
> **Task**: Task 5 — 保持已发布目录的单文件内部链接
> **Scope**: obsidian-feishu-lark-cli-sync，3 个审查文件，+160/-31
> **Reviewers**: 2 并行 reviewer（correctness-reviewer + quality-reviewer）

---

## 1. Review Scope

### 改动文件清单

1. `src/link-rewrite.ts` — 抽取目录链接映射构建函数和无链接快速判定。
2. `src/main.ts` — 已绑定单文件同步前改写显式已发布目录中的内部链接。
3. `test/test-link-rewrite.mjs` — 增加非链接段落变更和精确 block 更新回归测试。

### 关联文档

- Spec: N/A（用户在本轮确认最小修复方案）
- Tasks: `tasks.md` Task 5（4 个子任务、5 个验收标准）

### 关键设计决策

1. 不修改 `lark-sync-core.ts` 的 hash、block diff、revision 校验和状态结构。
2. 单文件同步只读取所属显式已发布目录的现有绑定，只上传当前文件。
3. 目录发布与后续单文件同步复用同一链接 alias 映射函数。

---

## 2. Round 1: Findings

### 2.1 性能类 (Performance)

**F-3** (P2) — 无内部链接的保存同步也会扫描 Vault 和目录文件
- **位置**: `src/main.ts:2343`
- **问题**: 每次保存都会调用 `collectMarkdownFiles()`，普通无链接文档也产生额外扫描和排序。
- **证据**: 新增链路在检查内容是否包含可改写链接之前就构建目录 link map。

### 2.2 健壮性类 (Robustness)

**F-1** (P1) — 同名未发布目录可能被误判为已发布目录
- **位置**: `src/main.ts:2337`
- **问题**: `findPublishedFolderForFile()` 会基于目录 basename 和 `folderBindings` 推断发布绑定，可能误改写另一个同名但未发布的目录。
- **证据**: `findPublishedFolderForFile()` 在无显式 `publishedFolders` 记录时调用 `inferPublishedFolderBinding()`，推断仅比较本地目录 basename。

### 2.3 工程规范类 (Standards)

**F-2** (P1) — 回归测试没有覆盖实际 block 同步计划
- **位置**: `test/test-link-rewrite.mjs:79`
- **问题**: 首轮测试只比较两次 `rewriteInternalLinks()` 输出，即使单文件同步接入被移除也会通过。
- **证据**: 测试未建立远端 block 映射，也未断言 `buildSyncPlan()` 不替换链接列表。

### 2.4 契约破坏类 (Contract)

无。

### 2.5 需求/设计符合度类 (Spec Compliance)

无。

---

## 3. Round 1 Fixes

| ID | 优先级 | 问题 | 修复方式 | 犯错原因 |
|----|--------|------|----------|----------|
| F-1 | P1 | 同名未发布目录可能误命中 | 新增只沿父路径查找显式 `publishedFolders` 的方法，不在链接改写路径使用 inference | 设计考虑不足 |
| F-2 | P1 | 测试未覆盖 sync plan | 用转换后基线和远端 block ID 建立状态，断言只产生 `changed-block` 更新命令 | 执行遗漏 |
| F-3 | P2 | 无链接文档也扫描目录 | 在目录查找和文件收集前增加 `mayContainInternalLinks()` 快速返回 | 设计考虑不足 |

---

## 4. Round 2: Re-review

- **F-1**：已关闭；链接改写仅匹配显式 `publishedFolders` 祖先目录。
- **F-2**：已关闭；新测试进入 `createDocumentSyncStateFromRemote()` 和 `buildSyncPlan()` 实际计划链路。
- **F-3**：已关闭；无 `.md` 或 `[[` 的内容在扫描目录前直接返回。
- **无新增 finding**
- **结论: PASS**

---

## 5. 裁决明细

| ID | 维度 | 原始优先级 | 最终处置 | 裁决依据 |
|----|------|-----------|---------|---------|
| F-1 | robustness | P1 | keep，已修复 | `src/main.ts` 原调用的 inference 只比较 basename，无法保证本地路径身份；复审确认新方法只查显式绑定。 |
| F-2 | standards | P1 | keep，已修复 | 首轮测试没有调用 `buildSyncPlan()`；复审确认新断言只生成 `changed-block` 命令。 |
| F-3 | performance | P2 | keep，已修复 | `collectMarkdownFiles()` 会遍历 Vault 并排序；复审确认无链接文档已在调用前返回。 |

---

## 6. 总体结论: PASS

两项 P1 和一项 P2 均已修复，定向复审未发现新 P0/P1。

---

## 7. 正式问题

### P0（必须修复）

无。

### P1（应该修复）

无未解决项。

### P2（建议改进）

无未解决项。

---

## 8. Follow-up Items

无。

---

## 9. Review Summary

- **Review 轮次**: 2 轮（Round 1 3 项 candidate finding → 修复 3 项 → Round 2 PASS）
- **P0 修复**: 0 项
- **P1 修复**: 2 项
- **P2 keep**: 1 项（已修复）
- **Follow-up**: 0 项
- **最终结论**: PASS

## 10. Phase 3 测试结果

- `npm test`: PASS（6 组测试脚本）
- `npm run build`: PASS
- TypeScript `tsc --noEmit`: PASS
