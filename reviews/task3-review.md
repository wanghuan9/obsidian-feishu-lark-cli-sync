# Task 3 Review

## Review Scope

- `main.ts`
- Supporting generated output touched by build: `main.js`
- Supporting core changes needed by Task 3 state closure: `lark-sync-core.ts`, `lark-sync-core.mjs`, `test-lark-sync-core.mjs`

## Round 1 Findings

### Correctness Reviewer

- F-1 [P1] `publishFolder()` blanket-disabled default `precise` mode, so folder sync could not use the unified plan and even safe no-op folder sync failed.
- F-2 [P1] folder sync no longer preserved remote-deleted recreation because bound documents went directly through `updateLarkDocument()`.
- F-3 [P1] successful sync plans were not persisted to `lark-sync-state.json`, so precise state could not accumulate.
- F-4 [P2] blocked plan reasons were discarded and replaced by a generic precise-not-ready message.

### Quality Reviewer

- F-5 [P1] `skipped` precise plans returned success without checking remote existence/content, so deleted or changed remote documents could be silently treated as synced.
- F-6 [P1] folder sync could rebuild a deleted document during final sync after earlier entries had already been rewritten with the old link map.
- F-7 [P1] state keys were inconsistent: updates could save state under token while frontmatter only preserved URL.
- F-8 [P2] newly created folder documents still require a bootstrap create followed by a final overwrite when rewritten links change.
- F-9 [P2] folder sync remains mostly serial; large folders can be optimized with bounded concurrency in Task 4.

## Fix Records

- F-1: Removed the blanket precise-mode guard from folder sync and routed final updates through the shared sync plan. Reason category: execution omission.
- F-2: Restored remote-deleted recreation through `syncOrRecreateDocument()` and added read-only preflight for folder bindings before building the link map. Reason category: edge-case regression.
- F-3/F-7: Added sync-state persistence after successful executable/skipped plans and write state under doc, token, and URL keys when available. Reason category: state consistency gap.
- F-4: Added localized plan failure messages using `formatSyncFailureMessage()` and avoided double-wrapping already localized sync errors. Reason category: notification semantics gap.
- F-5: `skipped` plans now fetch remote Markdown and compare SHA-256 content hashes; mismatches fail with `remote-content-mismatch`, deleted remotes fall through to recreation. Reason category: correctness/safety gap.
- F-6: Folder final sync now rebuilds the link map and retries the batch when a binding changes during final sync, preventing successful completion with stale links. Reason category: concurrency/race consideration.
- F-8: Kept the bootstrap overwrite only for newly created/recreated documents and skipped it when rewritten content is unchanged. Existing remote documents still never fallback to overwrite in `precise` mode. Reason category: API constraint; final content requires all new document URLs, which are only available after creation.
- F-9: Deferred broader bounded-concurrency optimization to Task 4, which already covers performance/regression testing.

## Round 2 Result

Focused re-review on remote-deleted recreation, link-map retry, token/URL state consistency, and default precise safety: PASS after fixes.

## Final Verification

- `npx tsc --noEmit`: PASS
- `npm test`: PASS
- `npm run build`: PASS
- `python3 /Users/wanghuan/.skilldock/skills/code-standards/skills/code-standards/scripts/format-check.py --git-diff`: PASS (no Java/XML files found)
- `git diff --check`: PASS

## Final Result

PASS

## Follow-up Items

- Task 4 should add direct regression tests for remote-deleted folder retry, URL/token state lookup, and skipped-plan remote mismatch.
- Task 4 should evaluate bounded concurrency for folder read/preflight/final sync while preserving per-document serialization.
- A true one-pass folder publish for newly created documents needs either placeholder link support or an API workflow that can reserve document URLs before writing final content.
