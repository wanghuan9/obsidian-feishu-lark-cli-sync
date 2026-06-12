# Task 1 Review

## Review Scope

- `lark-sync-core.ts`
- `test-lark-sync-core.mjs`
- Generated output touched by build: `lark-sync-core.mjs`, `main.js`

## Reviewer Findings

### Correctness Reviewer

- F-1 [P1] `lark-sync-core.ts:createContentHash()` used a 32-bit FNV-style hash while `buildSyncPlan()` treated hash equality as authoritative for skipping sync. A collision could skip a real local change.

### Quality Reviewer

- F-2 [P1] `buildSyncPlan()` did not verify `state.doc === input.doc` before allowing a skipped precise sync.
- F-3 [P1] Same root cause as F-1: short 32-bit hash was not strong enough for correctness-critical skip decisions.
- F-4 [P2] `SyncPlan` allowed invalid mode/reason/command combinations.
- F-5 [P2] `LarkUpdateCommand` allowed invalid command-specific parameter combinations.
- F-6 [P2] Failure-message tests covered only pre-push plus one reason.

## Fix Records

- F-1/F-3: Replaced the 32-bit hash with async SHA-256 via Web Crypto. Reason category: design consideration insufficient; the hash gates correctness, not just cache performance.
- F-2: Added doc identity validation before precise skip; mismatched state returns blocked. Reason category: execution omission; state ownership was defined but not enforced.
- F-4: Changed `SyncPlan` to a discriminated union so blocked/skipped/overwrite/precise plans have constrained fields. Reason category: design consideration insufficient.
- F-5: Changed `LarkUpdateCommand` to a command-specific discriminated union and made `buildUpdateCommandArgs()` switch on command. Reason category: design consideration insufficient.
- F-6: Partially addressed by adding SHA-256 and doc mismatch tests; broader failure-message mode coverage remains a follow-up for Task 4 where hook behavior is migrated.

## Final Verification

- `node test-lark-sync-core.mjs`: PASS
- `npx tsc --noEmit`: PASS
- `npm test`: PASS
- `npm run build`: PASS
- `python3 /Users/wanghuan/.skilldock/skills/code-standards/skills/code-standards/scripts/format-check.py --git-diff`: PASS (no Java/XML files found)

## Final Result

PASS

## Follow-up Items

- Task 4 should add broader failure-message tests for manual/save/folder modes and multiple failure reasons.
