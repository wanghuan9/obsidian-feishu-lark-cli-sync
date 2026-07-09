import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { createContentHash, createSyncContentSignature, getDocumentStateKey } from "../lark-sync-core.mjs";

const execFileAsync = promisify(execFile);

async function run() {
	const workspace = await mkdtemp(join(tmpdir(), "pre-push-test-"));
	try {
		await execFileAsync("git", ["init"], { cwd: workspace });
		await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
		await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: workspace });

			await mkdir(join(workspace, ".obsidian", "plugins", "feishu-lark-cli-sync"), { recursive: true });
			await mkdir(join(workspace, "bin"), { recursive: true });
			await cp("sync-pre-push.mjs", join(workspace, "sync-pre-push.mjs"));
			await cp("lark-sync-core.mjs", join(workspace, "lark-sync-core.mjs"));
			await cp("lark-cli-command.mjs", join(workspace, "lark-cli-command.mjs"));
			await writeFakeLarkCli(workspace);
			await writeFakeSystemNotifiers(workspace);

		await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Body"));
		await writeFile(join(workspace, "unbound.md"), "Body");
		await execFileAsync("git", ["add", "."], { cwd: workspace });
		await execFileAsync("git", ["commit", "-m", "init"], { cwd: workspace });

		await testPreciseSkip(workspace);
		await testPreciseRepairsEmptyStateBeforeSkip(workspace);
		await testPreciseBootstrapFromRemote(workspace);
		await testPreciseBootstrapAfterTrim(workspace);
		await testPreciseBootstrapBlocksWithoutBlockIds(workspace);
		await testPreciseBlockedWhenBootstrapFails(workspace);
		await testPreciseReplaceRefreshesState(workspace);
		await testPreciseInsertRefreshesState(workspace);
		await testPreciseHeadingInsertUsesXml(workspace);
		await testPreciseDeleteRefreshesState(workspace);
		await testPreciseRefreshRetriesStaleRemote(workspace);
		await testPreciseRefreshUsesUpdateRevisionBeforeFetchingWithIds(workspace);
		await testPreciseRefreshFailsOnStaleRemote(workspace);
		await testPreciseRefreshAllowsNormalizedRemoteMarkdown(workspace);
		await testPreciseSkipAllowsNormalizedRemoteMarkdown(workspace);
		await testPreciseSkipRepairsRemoteHeadingDrift(workspace);
		await testAutoOverwriteRefreshesStateBeforeUpdate(workspace);
		await testAutoUsesAcceptablePartialStateForSmallChange(workspace);
		await testPreciseSkipDeletesRemoteInsertedHeading(workspace);
		await testPreciseRefreshBeforeUpdateAvoidsDuplicateInsert(workspace);
		await testOverwriteDoesNotPersistEmptyState(workspace);
		await testOverwriteStripsDocumentTitleBeforeUpdate(workspace);
		await testOverwriteUpdates(workspace);
		await testUnboundFilesDoNotBlock(workspace);
		await testCanonicalStateKey(workspace);
		await testStateWritePreservesExternalDocuments(workspace);
		await testStateCacheTrim(workspace);
		await testSameDocumentAliasesRunSerially(workspace);
		await testConcurrentFailureWaitsForStartedTasks(workspace);
		await testMissingLarkCliFailsWithInstallPrompt(workspace);
		await testUnsupportedLarkCliVersionFailsEarly(workspace);
		await testLarkCliVersionFallsBackToVersionFlag(workspace);
		await testLarkCliVersionCheckPersistsAndSkips(workspace);
		await testMacSystemNotificationOnFailure(workspace);
		await testWindowsSystemNotificationOnFailure(workspace);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

async function testPreciseSkip(workspace) {
	await resetWorkspaceFiles(workspace);
	const contentForLark = "# bound\n\nBody";
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "en" });
	await writeSyncState(workspace, "https://example.feishu.cn/docx/doc-token", contentForLark);
	await clearLog(workspace);
	await runHook(workspace);
	const log = await readLog(workspace);
	assert.match(log, /docs \+fetch .*--api-version v2/);
	assert.doesNotMatch(log, /docs \+update/);
}

async function testPreciseRepairsEmptyStateBeforeSkip(workspace) {
	await resetWorkspaceFiles(workspace);
	const contentForLark = "# bound\n\nBody";
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "en" });
	await writeSyncState(workspace, "https://example.feishu.cn/docx/doc-token", contentForLark);
	await clearLog(workspace);
	await runHook(workspace);
	const log = await readLog(workspace);
	assert.match(log, /docs \+fetch .*--doc-format markdown/);
	assert.match(log, /docs \+fetch .*--detail with-ids/);
	assert.doesNotMatch(log, /docs \+update/);
	const state = await readSyncState(workspace);
	assert.deepEqual(state.documents["doc-token"].units.map((unit) => unit.blockId), ["blk-1"]);
}

async function testPreciseBootstrapFromRemote(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Changed"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "en" });
	await writeSyncStateRaw(workspace, { version: 1, documents: {} });
	await clearLog(workspace);
	await runHook(workspace, {
		env: {
			LARK_CLI_FETCH_CHANGED_AFTER_UPDATE: "1"
		}
	});
	const log = await readLog(workspace);
	assert.match(log, /docs \+fetch .*--doc-format markdown/);
	assert.match(log, /docs \+fetch .*--detail with-ids/);
	assert.match(log, /docs \+update .*--command block_replace .*--block-id blk-1/);
	const state = await readSyncState(workspace);
	assert.equal(state.documents["doc-token"].units.length, 1);
	assert.equal(state.documents["doc-token"].units[0].blockId, "blk-1");
}

async function testPreciseBootstrapAfterTrim(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Changed"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "en" });
	await writeSyncStateRaw(workspace, { version: 1, documents: {} });
	await clearLog(workspace);
	await runHook(workspace, {
		env: {
			LARK_CLI_FETCH_CHANGED_AFTER_UPDATE: "1",
			LARK_CLI_RETURN_DOC_TOKEN_FOR_URL: "1"
		}
	});
	const log = await readLog(workspace);
	assert.match(log, /docs \+fetch .*--doc https:\/\/example\.feishu\.cn\/docx\/doc-token/);
	assert.match(log, /docs \+update .*--doc doc-token .*--command block_replace .*--block-id blk-1/);
	const state = await readSyncState(workspace);
	assert.ok(state.documents["doc-token"]);
	assert.ok(Date.parse(state.documents["doc-token"].updatedAt) > Date.parse("2026-06-12T00:00:00.000Z"));
	assert.equal(state.documents["https://example.feishu.cn/docx/doc-token"], undefined);
}

async function testPreciseBlockedWhenBootstrapFails(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Changed"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "zh-CN" });
	await writeSyncStateRaw(workspace, { version: 1, documents: {} });
	await clearLog(workspace);
	const result = await runHook(workspace, {
		reject: false,
		env: {
			LARK_CLI_NO_BLOCK_IDS: "1"
		}
	});
	assert.notEqual(result.exitCode, 0);
	assert.match(result.stderr, /pre-push 同步失败：bound\.md/);
	assert.match(result.stderr, /缺少远端 block 映射/);
	assert.match(result.stderr, /已阻止 git push/);
	const log = await readLog(workspace);
	assert.match(log, /docs \+fetch/);
	assert.doesNotMatch(log, /docs \+update/);
}

async function testPreciseBootstrapBlocksWithoutBlockIds(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Body"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "zh-CN" });
	await writeSyncStateRaw(workspace, { version: 1, documents: {} });
	await clearLog(workspace);
	const result = await runHook(workspace, {
		reject: false,
		env: {
			LARK_CLI_NO_BLOCK_IDS: "1"
		}
	});
	assert.notEqual(result.exitCode, 0);
	assert.match(result.stderr, /缺少远端 block 映射/);
	const log = await readLog(workspace);
	assert.match(log, /docs \+fetch .*--detail with-ids/);
	assert.match(log, /docs \+fetch .*--doc-format markdown/);
	assert.doesNotMatch(log, /docs \+update/);
	const state = await readSyncState(workspace);
	assert.equal(state.documents["doc-token"], undefined);
}

async function testPreciseReplaceRefreshesState(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Changed"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "en" });
	await writeSyncStateWithUnits(workspace, "https://example.feishu.cn/docx/doc-token", "# bound\n\nBody", [{
		stableId: "0:paragraph",
		kind: "paragraph",
		hash: await createContentHash("Body"),
		blockId: "blk-1"
	}]);
	await clearLog(workspace);
	await runHook(workspace, {
		env: {
			LARK_CLI_FETCH_REPLACED: "1"
		}
	});
	const log = await readLog(workspace);
	assert.match(log, /docs \+update .*--command block_replace .*--block-id blk-1/);
	assert.match(log, /docs \+fetch .*--detail with-ids/);
	const state = await readSyncState(workspace);
	const documentState = state.documents["doc-token"];
	assert.equal(documentState.units.length, 1);
	assert.equal(documentState.units[0].blockId, "blk-2");
	assert.equal(documentState.contentHash, await createContentHash("# bound\n\nChanged"));
}

async function testPreciseInsertRefreshesState(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Body\n\n## Inserted"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "en" });
	await writeSyncStateWithUnits(workspace, "https://example.feishu.cn/docx/doc-token", "# bound\n\nBody", [{
		stableId: "0:paragraph",
		kind: "paragraph",
		hash: await createContentHash("Body"),
		blockId: "blk-1"
	}]);
	await clearLog(workspace);
	await runHook(workspace, {
		env: {
			LARK_CLI_FETCH_INSERTED_AFTER_UPDATE: "1"
		}
	});
	const log = await readLog(workspace);
	assert.match(log, /docs \+update .*--command block_insert_after .*--block-id blk-1/);
	assert.match(log, /docs \+fetch .*--detail with-ids/);
	const state = await readSyncState(workspace);
	assert.deepEqual(state.documents["doc-token"].units.map((unit) => unit.blockId), [
		"blk-1",
		"blk-2"
	]);
}

async function testPreciseHeadingInsertUsesXml(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Body\n\n## Inserted"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "en" });
	await writeSyncStateWithUnits(workspace, "https://example.feishu.cn/docx/doc-token", "# bound\n\nBody", [{
		stableId: "0:paragraph",
		kind: "paragraph",
		hash: await createContentHash("Body"),
		blockId: "blk-1"
	}]);
	await clearLog(workspace);
	await runHook(workspace, {
		env: {
			LARK_CLI_FETCH_INSERTED_AFTER_UPDATE: "1"
		}
	});
	const log = await readLog(workspace);
	assert.match(log, /docs \+update .*--command block_insert_after .*--doc-format xml .*--block-id blk-1/);
	await clearLog(workspace);
}

async function testPreciseDeleteRefreshesState(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Body"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "en" });
	await writeSyncStateWithUnits(workspace, "https://example.feishu.cn/docx/doc-token", "# bound\n\nBody\n\n## Removed", [
		{
			stableId: "0:paragraph",
			kind: "paragraph",
			hash: await createContentHash("Body"),
			blockId: "blk-1"
		},
		{
			stableId: "1:heading",
			kind: "heading",
			hash: await createContentHash("## Removed"),
			blockId: "blk-2"
		}
	]);
	await clearLog(workspace);
	await runHook(workspace);
	const log = await readLog(workspace);
	assert.match(log, /docs \+update .*--command block_delete .*--block-id blk-2/);
	assert.match(log, /docs \+fetch .*--detail with-ids/);
	const state = await readSyncState(workspace);
	const documentState = state.documents["doc-token"];
	assert.equal(documentState.units.length, 1);
	assert.equal(documentState.units[0].blockId, "blk-1");
	assert.equal(documentState.contentHash, await createContentHash("# bound\n\nBody"));
}

async function testPreciseRefreshRetriesStaleRemote(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Body\n\n## Inserted"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "en" });
	await writeSyncStateWithUnits(workspace, "https://example.feishu.cn/docx/doc-token", "# bound\n\nBody", [{
		stableId: "0:paragraph",
		kind: "paragraph",
		hash: await createContentHash("Body"),
		blockId: "blk-1"
	}]);
	await clearLog(workspace);
	await runHook(workspace, {
		env: {
			LARK_CLI_FETCH_INSERTED_AFTER_UPDATE: "1",
			LARK_CLI_STALE_WITH_IDS_FETCHES: "2"
		}
	});
	const log = await readLog(workspace);
	assert.match(log, /docs \+update .*--command block_insert_after/);
	assert.match(log, /--detail with-ids/);
	const state = await readSyncState(workspace);
	assert.deepEqual(state.documents["doc-token"].units.map((unit) => unit.blockId), [
		"blk-1",
		"blk-2"
	]);
}

async function testPreciseRefreshUsesUpdateRevisionBeforeFetchingWithIds(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Body\n\n## Inserted"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "en" });
	await writeSyncStateWithUnits(workspace, "https://example.feishu.cn/docx/doc-token", "# bound\n\nBody", [{
		stableId: "0:paragraph",
		kind: "paragraph",
		hash: await createContentHash("Body"),
		blockId: "blk-1"
	}]);
	await clearLog(workspace);
	await runHook(workspace, {
		env: {
			LARK_CLI_FETCH_INSERTED_AFTER_UPDATE: "1",
			LARK_CLI_UPDATE_REVISION_ID: "5",
			LARK_CLI_STALE_WITH_IDS_FETCHES: "2"
		}
	});
	const log = await readLog(workspace);
	assert.equal((log.match(/--detail with-ids/g) || []).length, 4);
	const state = await readSyncState(workspace);
	assert.equal(state.documents["doc-token"].revisionId, 5);
	assert.deepEqual(state.documents["doc-token"].units.map((unit) => unit.blockId), [
		"blk-1",
		"blk-2"
	]);
}

async function testPreciseRefreshFailsOnStaleRemote(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Body\n\n## Inserted"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "en" });
	await writeSyncStateWithUnits(workspace, "https://example.feishu.cn/docx/doc-token", "# bound\n\nBody", [{
		stableId: "0:paragraph",
		kind: "paragraph",
		hash: await createContentHash("Body"),
		blockId: "blk-1"
	}]);
	await clearLog(workspace);
	const result = await runHook(workspace, {
		reject: false,
		env: {
			LARK_CLI_FETCH_INSERTED_AFTER_UPDATE: "1",
			LARK_CLI_STALE_MARKDOWN_FETCHES: "9"
		}
	});
	assert.notEqual(result.exitCode, 0);
	assert.match(result.stderr, /remote update is not visible yet/);
	const log = await readLog(workspace);
	assert.match(log, /docs \+update .*--command block_insert_after/);
	assert.match(log, /--detail with-ids/);
	const state = await readSyncState(workspace);
	assert.equal(state.documents["doc-token"].units[0].blockId, "blk-1");
	assert.equal(state.documents["doc-token"].units.length, 1);
}

async function testPreciseRefreshAllowsNormalizedRemoteMarkdown(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "**Changed**"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "en" });
	await writeSyncStateWithUnits(workspace, "https://example.feishu.cn/docx/doc-token", "# bound\n\nBody", [{
		stableId: "0:paragraph",
		kind: "paragraph",
		hash: await createContentHash("Body"),
		blockId: "blk-1"
	}]);
	await clearLog(workspace);
	await runHook(workspace, {
		env: {
			LARK_CLI_FETCH_REPLACED: "1"
		}
	});
	const state = await readSyncState(workspace);
	const documentState = state.documents["doc-token"];
	assert.equal(documentState.units.length, 1);
	assert.equal(documentState.units[0].blockId, "blk-2");
	assert.equal(documentState.contentHash, await createContentHash("# bound\n\n**Changed**"));
}

async function testPreciseSkipAllowsNormalizedRemoteMarkdown(workspace) {
	await resetWorkspaceFiles(workspace);
	const contentForLark = "# bound\n\n**Body**";
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "**Body**"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "en" });
	await writeSyncStateWithUnits(workspace, "https://example.feishu.cn/docx/doc-token", contentForLark, [{
		stableId: "0:paragraph",
		kind: "paragraph",
		hash: await createContentHash("Body"),
		blockId: "blk-1"
	}]);
	await clearLog(workspace);
	await runHook(workspace);
	const log = await readLog(workspace);
	assert.match(log, /docs \+fetch/);
	assert.doesNotMatch(log, /--detail with-ids/);
	assert.doesNotMatch(log, /docs \+update/);
}

async function testPreciseSkipRepairsRemoteHeadingDrift(workspace) {
	await resetWorkspaceFiles(workspace);
	const contentForLark = "# bound\n\n## Title\n\nBody";
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "## Title\n\nBody"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "en" });
	await writeSyncStateWithUnits(workspace, "https://example.feishu.cn/docx/doc-token", contentForLark, [
		{
			stableId: "0:heading",
			kind: "heading",
			hash: await createContentHash("Title"),
			blockId: "blk-heading"
		},
		{
			stableId: "1:paragraph",
			kind: "paragraph",
			hash: await createContentHash("Body"),
			blockId: "blk-1"
		}
	]);
	await clearLog(workspace);
	await runHook(workspace, {
		env: {
			LARK_CLI_FETCH_STALE_HEADING: "1"
		}
	});
	const log = await readLog(workspace);
	assert.match(log, /docs \+fetch .*--doc-format markdown/);
	assert.match(log, /docs \+fetch .*--detail with-ids/);
	assert.match(log, /docs \+update .*--command block_replace .*--doc-format xml .*--block-id blk-heading .*--revision-id 4/);
	assert.doesNotMatch(log, /--command block_insert_after .*--block-id blk-heading/);
	assert.doesNotMatch(log, /--command block_delete .*--block-id blk-heading/);
	assert.doesNotMatch(log, /--command overwrite/);
}

async function testPreciseSkipDeletesRemoteInsertedHeading(workspace) {
	await resetWorkspaceFiles(workspace);
	const contentForLark = "# bound\n\nBody";
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Body"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "en" });
	await writeSyncStateWithUnits(workspace, "https://example.feishu.cn/docx/doc-token", contentForLark, [{
		stableId: "0:paragraph",
		kind: "paragraph",
		hash: await createContentHash("Body"),
		blockId: "blk-1"
	}]);
	await clearLog(workspace);
	await runHook(workspace, {
		env: {
			LARK_CLI_FETCH_EXTRA_HEADING: "1"
		}
	});
	const log = await readLog(workspace);
	assert.match(log, /docs \+fetch .*--detail with-ids/);
	assert.match(log, /docs \+update .*--command block_delete .*--block-id blk-extra-heading .*--revision-id 4/);
	assert.doesNotMatch(log, /--command overwrite/);
}

async function testAutoOverwriteRefreshesStateBeforeUpdate(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "## Title\n\nBody"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "auto", language: "en" });
	await writeSyncStateWithUnits(workspace, "https://example.feishu.cn/docx/doc-token", "# bound\n\nOld1\n\nOld2\n\nOld3\n\nOld4\n\nOld5\n\nOld6\n\nOld7\n\nOld8\n\nOld9", [
		{ stableId: "0:paragraph", kind: "paragraph", hash: await createContentHash("Old1"), blockId: "old-1" },
		{ stableId: "1:paragraph", kind: "paragraph", hash: await createContentHash("Old2"), blockId: "old-2" },
		{ stableId: "2:paragraph", kind: "paragraph", hash: await createContentHash("Old3"), blockId: "old-3" },
		{ stableId: "3:paragraph", kind: "paragraph", hash: await createContentHash("Old4"), blockId: "old-4" },
		{ stableId: "4:paragraph", kind: "paragraph", hash: await createContentHash("Old5"), blockId: "old-5" },
		{ stableId: "5:paragraph", kind: "paragraph", hash: await createContentHash("Old6"), blockId: "old-6" },
		{ stableId: "6:paragraph", kind: "paragraph", hash: await createContentHash("Old7"), blockId: "old-7" },
		{ stableId: "7:paragraph", kind: "paragraph", hash: await createContentHash("Old8"), blockId: "old-8" },
		{ stableId: "8:paragraph", kind: "paragraph", hash: await createContentHash("Old9"), blockId: "old-9" }
	]);
	await clearLog(workspace);
	await runHook(workspace, {
		env: {
			LARK_CLI_FETCH_STALE_HEADING: "1"
		}
	});
	const log = await readLog(workspace);
	assert.match(log, /docs \+fetch .*--detail with-ids/);
	assert.match(log, /docs \+update .*--command block_replace .*--doc-format xml .*--block-id blk-heading/);
	assert.doesNotMatch(log, /--command block_insert_after .*--block-id blk-heading/);
	assert.doesNotMatch(log, /--command block_delete .*--block-id blk-heading/);
	assert.doesNotMatch(log, /--command overwrite/);
}

async function testAutoUsesAcceptablePartialStateForSmallChange(workspace) {
	await resetWorkspaceFiles(workspace);
	const previousContent = "# bound\n\n## Title\n\n" + Array.from({ length: 100 }, (_, index) => `Body ${index}`).join("\n\n");
	const nextBody = "## Title 22\n\n" + Array.from({ length: 100 }, (_, index) => `Body ${index}`).join("\n\n");
	const signature = await createSyncContentSignature(previousContent);
	const units = signature.units.map((unit, index) => ({
		stableId: `${index}:${unit.kind}`,
		kind: unit.kind,
		hash: unit.hash,
		blockId: index === 0 ? "blk-heading" : index === 51 ? "" : `blk-${index}`
	}));
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", nextBody));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "auto", language: "en" });
	await writeSyncStateWithUnits(workspace, "https://example.feishu.cn/docx/doc-token", previousContent, units);
	await clearLog(workspace);
	await runHook(workspace, {
		env: {
			LARK_CLI_FETCH_MANY_BLOCKS: "1"
		}
	});
	const log = await readLog(workspace);
	assert.match(log, /docs \+update .*--command block_replace .*--doc-format xml .*--block-id blk-heading/);
	assert.doesNotMatch(log, /--command block_insert_after .*--block-id blk-heading/);
	assert.doesNotMatch(log, /--command block_delete .*--block-id blk-heading/);
	assert.match(log, /docs \+fetch .*--detail with-ids/);
	assert.match(log, /docs \+fetch .*--doc-format markdown/);
	assert.doesNotMatch(log, /--command overwrite/);
}

async function testPreciseRefreshBeforeUpdateAvoidsDuplicateInsert(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Body\n\n## Inserted"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "en" });
	await writeSyncStateWithUnits(workspace, "https://example.feishu.cn/docx/doc-token", "# bound\n\nBody", [{
		stableId: "0:paragraph",
		kind: "paragraph",
		hash: await createContentHash("Body"),
		blockId: "blk-1"
	}]);
	await clearLog(workspace);
	await runHook(workspace, {
		env: {
			LARK_CLI_FETCH_INSERTED: "1"
		}
	});
	const log = await readLog(workspace);
	assert.match(log, /docs \+fetch .*--detail with-ids/);
	assert.doesNotMatch(log, /docs \+update/);
	const state = await readSyncState(workspace);
	assert.deepEqual(state.documents["doc-token"].units.map((unit) => unit.blockId), [
		"blk-1",
		"blk-2"
	]);
}


async function testCanonicalStateKey(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Body"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "overwrite", language: "en" });
	await writeSyncStateRaw(workspace, {
		version: 1,
		documents: {
			"https://example.feishu.cn/docx/doc-token": {
				doc: "https://example.feishu.cn/docx/doc-token",
				contentHash: "legacy-hash",
				units: [],
				updatedAt: "2026-06-12T00:00:00.000Z"
			}
		}
	});
	await clearLog(workspace);
	await runHook(workspace, {
		env: {
			LARK_CLI_RETURN_DOC_TOKEN_FOR_URL: "1"
		}
	});
	const state = await readSyncState(workspace);
	assert.ok(state.documents["doc-token"]);
	assert.deepEqual(state.documents["doc-token"].units.map((unit) => unit.blockId), ["blk-1"]);
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "en" });
	await clearLog(workspace);
	await runHook(workspace);
	const log = await readLog(workspace);
	assert.match(log, /docs \+fetch/);
	assert.doesNotMatch(log, /docs \+update/);
	const refreshedState = await readSyncState(workspace);
	assert.ok(refreshedState.documents["doc-token"]);
}

async function testStateWritePreservesExternalDocuments(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Changed"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "overwrite", language: "en" });
	await writeSyncStateWithUnits(workspace, "https://example.feishu.cn/docx/doc-token", "# bound\n\nBody", [{
		stableId: "0:paragraph",
		kind: "paragraph",
		hash: await createContentHash("Body"),
		blockId: "blk-1"
	}]);
	await clearLog(workspace);
	await runHook(workspace, {
		env: {
			LARK_CLI_FETCH_CHANGED_AFTER_UPDATE: "1",
			LARK_CLI_RETURN_DOC_TOKEN_FOR_URL: "1",
			LARK_CLI_WRITE_EXTERNAL_SYNC_STATE: join(
				workspace,
				".obsidian",
				"plugins",
				"feishu-lark-cli-sync",
				"lark-sync-state.json"
			)
		}
	});
	const state = await readSyncState(workspace);
	assert.ok(state.documents["doc-token"]);
	assert.equal(state.documents["https://example.feishu.cn/docx/doc-token"], undefined);
	assert.equal(state.documents["external-doc"].contentHash, "external-hash");
}

async function testStateCacheTrim(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Body"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, {
		autoSyncMode: "pre-push",
		syncStrategy: "overwrite",
		language: "en",
		stateCacheRetainLimit: 10
	});
	await writeSyncStateRaw(workspace, createSizedSyncState(16));
	await clearLog(workspace);
	await runHook(workspace, {
		env: {
			LARK_CLI_RETURN_DOC_TOKEN_FOR_URL: "1"
		}
	});
	const state = await readSyncState(workspace);
	assert.equal(Object.keys(state.documents).length, 10);
	assert.equal(state.documents["old-doc-000"], undefined);
	assert.equal(state.documents["old-doc-006"], undefined);
	assert.ok(state.documents["old-doc-007"]);
	assert.ok(state.documents["doc-token"]);
}

async function testSameDocumentAliasesRunSerially(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdownWithToken(
		"doc-token",
		"https://example.feishu.cn/docx/doc-token",
		"Body"
	));
	await writeFile(
		join(workspace, "same-doc.md"),
		boundMarkdown("https://example.feishu.cn/docx/doc-token", "Same doc")
	);
	await execFileAsync("git", ["add", "bound.md", "same-doc.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "overwrite", language: "en" });
	await writeSyncStateRaw(workspace, { version: 1, documents: {} });
	await clearLog(workspace);
	const result = await runHook(workspace, {
		env: {
			LARK_CLI_LOCK_DIR: workspace,
			LARK_CLI_RETURN_DOC_TOKEN_FOR_URL: "1"
		}
	});
	assert.equal(result.exitCode, 0);
	const log = await readLog(workspace);
	assert.equal((log.match(/docs \+update/g) || []).length, 2);
	assert.match(log, /--doc doc-token|--doc https:\/\/example\.feishu\.cn\/docx\/doc-token/);
}

async function testConcurrentFailureWaitsForStartedTasks(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Body"));
	await writeFile(
		join(workspace, "second.md"),
		boundMarkdown("https://example.feishu.cn/docx/second-token", "Second")
	);
	await execFileAsync("git", ["add", "bound.md", "second.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "overwrite", language: "en" });
	await writeSyncStateRaw(workspace, { version: 1, documents: {} });
	await clearLog(workspace);
	const result = await runHook(workspace, {
		reject: false,
		env: {
			LARK_CLI_FAIL_DOC: "doc-token"
		}
	});
	assert.notEqual(result.exitCode, 0);
	const log = await readLog(workspace);
	assert.match(log, /--doc https:\/\/example\.feishu\.cn\/docx\/doc-token/);
	assert.match(log, /--doc https:\/\/example\.feishu\.cn\/docx\/second-token/);
	const state = await readSyncState(workspace);
	assert.deepEqual(state.documents["second-token"].units.map((unit) => unit.blockId), ["blk-1"]);
}

async function testUnsupportedLarkCliVersionFailsEarly(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise" });
	await writeSyncStateRaw(workspace, { version: 1, documents: {} });
	await clearLog(workspace);
	const result = await runHook(workspace, {
		reject: false,
		env: {
			LARK_CLI_VERSION: "1.0.53"
		}
	});
	assert.notEqual(result.exitCode, 0);
	assert.match(result.stderr, /lark-cli 版本过低：1\.0\.53，请升级到大于 1\.0\.53 的版本。/);
	const log = await readLog(workspace);
	assert.match(log, /^-version$/m);
	assert.doesNotMatch(log, /docs \+fetch|docs \+update/);
}

async function testMissingLarkCliFailsWithInstallPrompt(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeSettings(workspace, {
		autoSyncMode: "pre-push",
		larkCliPath: join(workspace, "bin", "missing-lark-cli"),
		syncStrategy: "overwrite"
	});
	await writeSyncStateRaw(workspace, { version: 1, documents: {} });
	await clearLog(workspace);
	const result = await runHook(workspace, { reject: false });
	assert.notEqual(result.exitCode, 0);
	assert.match(result.stderr, /未检测到 lark-cli，请先安装 lark-cli。/);
	const log = await readLog(workspace);
	assert.equal(log, "");
}

async function testLarkCliVersionFallsBackToVersionFlag(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "overwrite" });
	await writeSyncStateRaw(workspace, { version: 1, documents: {} });
	await clearLog(workspace);
	await runHook(workspace, {
		env: {
			LARK_CLI_VERSION_COMMAND_UNSUPPORTED: "1"
		}
	});
	const log = await readLog(workspace);
	assert.match(log, /^-version$/m);
	assert.match(log, /^-v$/m);
	assert.match(log, /docs \+update/);
}

async function testLarkCliVersionCheckPersistsAndSkips(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "overwrite" });
	await writeSyncStateRaw(workspace, { version: 1, documents: {} });
	await clearLog(workspace);
	await runHook(workspace);
	const firstLog = await readLog(workspace);
	assert.match(firstLog, /^-version$/m);
	const settings = JSON.parse(await readFile(settingsPath(workspace), "utf8"));
	assert.deepEqual(settings.larkCliVersionCheck, {
		executable: larkCliExecutablePath(workspace),
		version: "1.0.54"
	});

	await clearLog(workspace);
	await runHook(workspace);
	const secondLog = await readLog(workspace);
	assert.doesNotMatch(secondLog, /^-version$/m);
	assert.match(secondLog, /docs \+update/);
}

async function testMacSystemNotificationOnFailure(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Changed"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "en" });
	await writeSyncStateRaw(workspace, { version: 1, documents: {} });
	await clearLog(workspace);
	await clearNotificationLog(workspace);
	const result = await runHook(workspace, {
		reject: false,
		env: {
			FEISHU_LARK_CLI_SYNC_NOTIFY_PLATFORM: "darwin",
			FEISHU_LARK_CLI_SYNC_OSASCRIPT_PATH: fakeNotifierPath(workspace, "osascript"),
			LARK_CLI_NO_BLOCK_IDS: "1"
		}
	});
	assert.notEqual(result.exitCode, 0);
	const notificationLog = await readNotificationLog(workspace);
	assert.match(notificationLog, /^osascript(?:\.cmd)?\n/);
	assert.match(notificationLog, /display\s+notification/);
	assert.match(notificationLog, /pre-push sync failed: bound\.md/);
	if (process.platform !== "win32") {
		assert.match(notificationLog, /with title "Feishu Lark CLI Sync"/);
	}
}

async function testWindowsSystemNotificationOnFailure(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Changed"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "en" });
	await writeSyncStateRaw(workspace, { version: 1, documents: {} });
	await clearLog(workspace);
	await clearNotificationLog(workspace);
	const result = await runHook(workspace, {
		reject: false,
		env: {
			FEISHU_LARK_CLI_SYNC_NOTIFY_PLATFORM: "win32",
			FEISHU_LARK_CLI_SYNC_POWERSHELL_PATH: fakeNotifierPath(workspace, "powershell"),
			LARK_CLI_NO_BLOCK_IDS: "1"
		}
	});
	assert.notEqual(result.exitCode, 0);
	const notificationLog = await readNotificationLog(workspace);
	assert.match(notificationLog, /^powershell(?:\.cmd)?\n/);
	assert.match(notificationLog, /System\.Windows\.Forms\.NotifyIcon/);
	assert.match(notificationLog, /pre-push\s+sync\s+failed:\s+bound\.md/);
	assert.match(notificationLog, /Feishu\s+Lark\s+CLI\s+Sync/);
}

async function testOverwriteUpdates(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "overwrite", language: "en" });
	await writeSyncStateRaw(workspace, { version: 1, documents: {} });
	await clearLog(workspace);
	await runHook(workspace);
	const log = await readLog(workspace);
	assert.match(log, /docs \+update/);
	assert.match(log, /--command overwrite/);
}

async function testOverwriteDoesNotPersistEmptyState(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Changed"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "overwrite", language: "en" });
	await writeSyncStateRaw(workspace, { version: 1, documents: {} });
	await clearLog(workspace);
	await runHook(workspace, {
		env: {
			LARK_CLI_FETCH_CHANGED_AFTER_UPDATE: "1",
			LARK_CLI_RETURN_DOC_TOKEN_FOR_URL: "1"
		}
	});
	const state = await readSyncState(workspace);
	assert.deepEqual(state.documents["doc-token"].units.map((unit) => unit.blockId), ["blk-1"]);
}

async function testOverwriteStripsDocumentTitleBeforeUpdate(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Changed"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "overwrite", language: "en" });
	await writeSyncStateRaw(workspace, { version: 1, documents: {} });
	await clearLog(workspace);
	await runHook(workspace, {
		env: {
			LARK_CLI_EXPORT_TITLE_MARKDOWN: "1",
			LARK_CLI_RETURN_DOC_TOKEN_FOR_URL: "1"
		}
	});
	const overwritten = await readFile(join(workspace, "lark-cli.log.overwrite-https___example_feishu_cn_docx_doc-token.md"), "utf8");
	assert.equal(overwritten, "Changed");
	const state = await readSyncState(workspace);
	assert.deepEqual(state.documents["doc-token"].units.map((unit) => unit.blockId), ["blk-1"]);
}

async function testUnboundFilesDoNotBlock(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), "Body without binding");
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "en" });
	await writeSyncStateRaw(workspace, { version: 1, documents: {} });
	await clearLog(workspace);
	await runHook(workspace);
	assert.equal(await readLog(workspace), "");
}

async function resetWorkspaceFiles(workspace) {
	await unlink(join(workspace, "same-doc.md")).catch(() => {});
	await unlink(join(workspace, "second.md")).catch(() => {});
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Body"));
	await writeFile(join(workspace, "unbound.md"), "Body");
	await execFileAsync("git", ["add", "--all"], { cwd: workspace });
}

async function runHook(workspace, options = {}) {
	const head = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace });
	const refs = `refs/heads/main ${head.stdout.trim()} refs/heads/main 0000000000000000000000000000000000000000\n`;
	const result = await spawnHook(workspace, refs, options.env || {});
	if (result.exitCode !== 0 && options.reject !== false) {
		throw new Error(result.stderr || `hook exited with ${result.exitCode}`);
	}

	return result;
}

async function spawnHook(workspace, stdin, envOverrides) {
		return await new Promise((resolvePromise) => {
			const child = spawn(process.execPath, ["sync-pre-push.mjs"], {
				cwd: workspace,
				env: {
					...process.env,
					PATH: `${join(workspace, "bin")}:${process.env.PATH || ""}`,
					FEISHU_LARK_CLI_SYNC_NOTIFY_PLATFORM: "test",
					FEISHU_LARK_CLI_SYNC_REMOTE_REFRESH_DELAY_MS: "1",
					LARK_CLI_LOG: join(workspace, "lark-cli.log"),
					SYSTEM_NOTIFICATION_LOG: join(workspace, "system-notification.log"),
					...envOverrides
				},
				stdio: ["pipe", "pipe", "pipe"]
			});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("close", (exitCode) => {
			resolvePromise({
				exitCode: exitCode || 0,
				stdout,
				stderr
			});
		});
		child.stdin.end(stdin);
	});
}

async function writeSettings(workspace, settings) {
	await writeFile(
		settingsPath(workspace),
		JSON.stringify({
			autoSyncMode: "pre-push",
			titleSource: "file-name",
			larkCliPath: larkCliExecutablePath(workspace),
			...settings
		}, null, 2),
		"utf8"
	);
}

function settingsPath(workspace) {
	return join(workspace, ".obsidian", "plugins", "feishu-lark-cli-sync", "data.json");
}

function larkCliExecutablePath(workspace) {
	return process.platform === "win32"
		? join(workspace, "bin", "lark-cli.cmd")
		: join(workspace, "bin", "lark-cli");
}

async function writeSyncState(workspace, doc, content) {
	const contentHash = await createContentHash(content);
	await writeSyncStateWithUnits(workspace, doc, content, []);
}

async function writeSyncStateWithUnits(workspace, doc, content, units) {
	const contentHash = await createContentHash(content);
	const stateKey = getDocumentStateKey(doc);
	await writeSyncStateRaw(workspace, {
		version: 1,
		documents: {
			[stateKey]: {
				doc: stateKey,
				contentHash,
				units,
				updatedAt: "2026-06-12T00:00:00.000Z"
			}
		}
	});
}

async function writeSyncStateRaw(workspace, state) {
	await writeFile(
		join(workspace, ".obsidian", "plugins", "feishu-lark-cli-sync", "lark-sync-state.json"),
		JSON.stringify(state, null, 2),
		"utf8"
	);
}

function createSizedSyncState(size) {
	const documents = {};
	for (let index = 0; index < size; index += 1) {
		const key = `old-doc-${String(index).padStart(3, "0")}`;
		documents[key] = {
			doc: key,
			contentHash: `hash-${index}`,
			units: [],
			updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
		};
	}

	return {
		version: 1,
		documents
	};
}

async function writeFakeLarkCli(workspace) {
	const script = `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.LARK_CLI_LOG, args.join(" ") + "\\n");
if (args[0] === "-version") {
  if (process.env.LARK_CLI_VERSION_COMMAND_UNSUPPORTED) {
    process.stderr.write('unknown option "-version"');
    process.exit(1);
  }
  process.stdout.write(process.env.LARK_CLI_VERSION || "1.0.54");
  process.exit(0);
}
if (args[0] === "-v") {
  process.stdout.write(process.env.LARK_CLI_VERSION || "1.0.54");
  process.exit(0);
}
const docIndex = args.indexOf("--doc");
const doc = docIndex >= 0 ? args[docIndex + 1] : "";
const safeDocKey = doc.replace(/[^A-Za-z0-9_-]/g, "_");
const overwrittenMarkdownPath = process.env.LARK_CLI_LOG + ".overwrite-" + safeDocKey + ".md";
if (process.env.LARK_CLI_LOCK_DIR && args.includes("+update") && doc.includes("doc-token")) {
  const lockPath = process.env.LARK_CLI_LOCK_DIR + "/doc-token.lock";
  if (fs.existsSync(lockPath)) {
    process.stdout.write(JSON.stringify({ ok: false, error: { message: "same doc ran concurrently" } }));
    process.exit(0);
  }
  fs.writeFileSync(lockPath, String(process.pid));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  fs.unlinkSync(lockPath);
}
if (process.env.LARK_CLI_FAIL_DOC && doc.includes(process.env.LARK_CLI_FAIL_DOC)) {
  process.stdout.write(JSON.stringify({ ok: false, error: { message: "forced failure" } }));
  process.exit(0);
}
const changedAfterUpdatePath = process.env.LARK_CLI_LOG + ".changed-after-update";
const insertedAfterUpdatePath = process.env.LARK_CLI_LOG + ".inserted-after-update";
const skippedRepairPath = process.env.LARK_CLI_LOG + ".skipped-repair-updated";
const responseDoc = process.env.LARK_CLI_RETURN_DOC_TOKEN_FOR_URL && doc.includes("/docx/doc-token") ? "doc-token" : doc;
if (args.includes("+fetch")) {
  const isWithIds = args.includes("--detail") && args.includes("with-ids");
  const staleLimit = Number(process.env.LARK_CLI_STALE_MARKDOWN_FETCHES || "0");
  const stalePath = process.env.LARK_CLI_LOG + ".stale-markdown-count";
  const staleWithIdsLimit = Number(process.env.LARK_CLI_STALE_WITH_IDS_FETCHES || "0");
  const staleWithIdsPath = process.env.LARK_CLI_LOG + ".stale-with-ids-count";
  let shouldReturnStaleMarkdown = false;
  if (!isWithIds && staleLimit > 0) {
    const count = fs.existsSync(stalePath) ? Number(fs.readFileSync(stalePath, "utf8") || "0") : 0;
    fs.writeFileSync(stalePath, String(count + 1));
    shouldReturnStaleMarkdown = count < staleLimit;
  }
  let shouldReturnStaleWithIds = false;
  if (isWithIds && staleWithIdsLimit > 0 && fs.existsSync(insertedAfterUpdatePath)) {
    const count = fs.existsSync(staleWithIdsPath) ? Number(fs.readFileSync(staleWithIdsPath, "utf8") || "0") : 0;
    fs.writeFileSync(staleWithIdsPath, String(count + 1));
    shouldReturnStaleWithIds = count < staleWithIdsLimit;
  }
  let markdown = "# bound\\n\\nBody";
  if (!isWithIds && fs.existsSync(overwrittenMarkdownPath)) {
    markdown = fs.readFileSync(overwrittenMarkdownPath, "utf8");
    if (process.env.LARK_CLI_EXPORT_TITLE_MARKDOWN) {
      markdown = "<title>bound</title>\\n\\n" + markdown;
    }
  } else if (doc.includes("second-token")) {
    markdown = "# second\\n\\nSecond";
  } else if (process.env.LARK_CLI_FETCH_MANY_BLOCKS) {
    markdown = "# bound\\n\\n## Title 22\\n\\n" + Array.from({ length: 100 }, (_, index) => "Body " + index).join("\\n\\n");
  } else if (process.env.LARK_CLI_FETCH_CHANGED_AFTER_UPDATE && fs.existsSync(changedAfterUpdatePath)) {
    markdown = "# bound\\n\\nChanged";
  } else if (shouldReturnStaleMarkdown) {
    markdown = "# bound\\n\\nBody";
  } else if (process.env.LARK_CLI_FETCH_INSERTED || (process.env.LARK_CLI_FETCH_INSERTED_AFTER_UPDATE && fs.existsSync(insertedAfterUpdatePath))) {
    markdown = "# bound\\n\\nBody\\n\\n## Inserted";
  } else if (process.env.LARK_CLI_FETCH_REPLACED) {
    markdown = "# bound\\n\\nChanged";
  } else if (process.env.LARK_CLI_FETCH_STALE_HEADING) {
    markdown = fs.existsSync(skippedRepairPath) ? "# bound\\n\\n## Title\\n\\nBody" : "# bound\\n\\n## Title121221\\n\\nBody";
  } else if (process.env.LARK_CLI_FETCH_EXTRA_HEADING) {
    markdown = fs.existsSync(skippedRepairPath) ? "# bound\\n\\nBody" : "# bound\\n\\nBody\\n\\n## Extra";
  }
  let content = markdown;
  let revisionId = Number(process.env.LARK_CLI_BASE_REVISION_ID || "4");
  if (isWithIds && !process.env.LARK_CLI_NO_BLOCK_IDS) {
    content = "<title id=\\"doc-title\\">bound</title><p id=\\"blk-1\\">Body</p>";
    if (fs.existsSync(overwrittenMarkdownPath)) {
      const overwritten = fs.readFileSync(overwrittenMarkdownPath, "utf8");
      const lines = overwritten.split(/\\r?\\n/);
      const title = process.env.LARK_CLI_EXPORT_TITLE_MARKDOWN
        ? "bound"
        : (lines.find((line) => /^#\\s+/.test(line)) || "# bound").replace(/^#\\s+/, "");
      const body = lines.filter((line) => line.trim() && !/^#\\s+/.test(line)).join("\\n");
      content = "<title id=\\"doc-title\\">" + title + "</title><p id=\\"blk-1\\">" + body + "</p>";
    } else if (process.env.LARK_CLI_FETCH_MANY_BLOCKS) {
      content = "<title id=\\"doc-title\\">bound</title><h2 id=\\"blk-heading\\">Title 22</h2>"
        + Array.from({ length: 100 }, (_, index) => "<p id=\\"blk-" + index + "\\">Body " + index + "</p>").join("");
    }
    if (!shouldReturnStaleWithIds && (process.env.LARK_CLI_FETCH_INSERTED || (process.env.LARK_CLI_FETCH_INSERTED_AFTER_UPDATE && fs.existsSync(insertedAfterUpdatePath)))) {
      content = "<title id=\\"doc-title\\">bound</title><p id=\\"blk-1\\">Body</p><h2 id=\\"blk-2\\">Inserted</h2>";
    } else if (process.env.LARK_CLI_FETCH_CHANGED_AFTER_UPDATE && fs.existsSync(changedAfterUpdatePath)) {
      content = "<title id=\\"doc-title\\">bound</title><p id=\\"blk-1\\">Changed</p>";
    } else if (process.env.LARK_CLI_FETCH_REPLACED) {
      content = "<title id=\\"doc-title\\">bound</title><p id=\\"blk-2\\">Changed</p>";
    } else if (process.env.LARK_CLI_FETCH_STALE_HEADING) {
      content = fs.existsSync(skippedRepairPath)
        ? "<title id=\\"doc-title\\">bound</title><h2 id=\\"blk-heading\\">Title</h2><p id=\\"blk-1\\">Body</p>"
        : "<title id=\\"doc-title\\">bound</title><h2 id=\\"blk-heading\\">Title121221</h2><p id=\\"blk-1\\">Body</p>";
    } else if (process.env.LARK_CLI_FETCH_EXTRA_HEADING) {
      content = fs.existsSync(skippedRepairPath)
        ? "<title id=\\"doc-title\\">bound</title><p id=\\"blk-1\\">Body</p>"
        : "<title id=\\"doc-title\\">bound</title><p id=\\"blk-1\\">Body</p><h2 id=\\"blk-extra-heading\\">Extra</h2>";
    }
  }
  if (process.env.LARK_CLI_UPDATE_REVISION_ID && fs.existsSync(insertedAfterUpdatePath) && !shouldReturnStaleMarkdown && !shouldReturnStaleWithIds) {
    revisionId = Number(process.env.LARK_CLI_UPDATE_REVISION_ID);
  }
  process.stdout.write(JSON.stringify({ ok: true, data: { document: { document_id: responseDoc, url: doc, content, revision_id: revisionId } } }));
} else {
  const commandIndex = args.indexOf("--command");
  const command = commandIndex >= 0 ? args[commandIndex + 1] : "";
  const contentIndex = args.indexOf("--content");
  const contentArg = contentIndex >= 0 ? args[contentIndex + 1] : "";
  if (command === "overwrite" && contentArg.startsWith("@")) {
    fs.writeFileSync(overwrittenMarkdownPath, fs.readFileSync(contentArg.slice(1), "utf8"));
  }
  if (process.env.LARK_CLI_FETCH_CHANGED_AFTER_UPDATE && args.includes("+update")) {
    fs.writeFileSync(changedAfterUpdatePath, "1");
  }
  if (process.env.LARK_CLI_FETCH_INSERTED_AFTER_UPDATE && args.includes("+update")) {
    fs.writeFileSync(insertedAfterUpdatePath, "1");
  }
  if ((process.env.LARK_CLI_FETCH_STALE_HEADING || process.env.LARK_CLI_FETCH_EXTRA_HEADING) && args.includes("+update")) {
    fs.writeFileSync(skippedRepairPath, "1");
  }
  if (process.env.LARK_CLI_WRITE_EXTERNAL_SYNC_STATE && args.includes("+update")) {
    const statePath = process.env.LARK_CLI_WRITE_EXTERNAL_SYNC_STATE;
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.documents["external-doc"] = {
      doc: "external-doc",
      contentHash: "external-hash",
      units: [],
      updatedAt: "2026-06-12T00:00:02.000Z"
    };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  }
  const revisionId = process.env.LARK_CLI_UPDATE_REVISION_ID ? Number(process.env.LARK_CLI_UPDATE_REVISION_ID) : undefined;
  process.stdout.write(JSON.stringify({ ok: true, data: { document: { document_id: responseDoc, url: doc, revision_id: revisionId } } }));
}
`;
	const scriptPath = join(workspace, "bin", "lark-cli.js");
	await writeFile(scriptPath, script, "utf8");
	if (process.platform === "win32") {
		await writeFile(join(workspace, "bin", "lark-cli.cmd"), "@echo off\r\nnode \"%~dp0\\lark-cli.js\" %*\r\n", "utf8");
		return;
	}

	const executablePath = join(workspace, "bin", "lark-cli");
	await writeFile(executablePath, script, "utf8");
	await chmod(executablePath, 0o755);
}

async function writeFakeSystemNotifiers(workspace) {
const script = `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(process.env.SYSTEM_NOTIFICATION_LOG, (process.env.NOTIFIER_NAME || process.argv[1].split(/[\\\\/]/).pop()) + "\\n");
fs.appendFileSync(process.env.SYSTEM_NOTIFICATION_LOG, process.argv.slice(2).join("\\n") + "\\n");
`;
	const scriptPath = join(workspace, "bin", "notifier.js");
	await writeFile(scriptPath, script, "utf8");
	if (process.platform === "win32") {
		await writeFile(join(workspace, "bin", "osascript.cmd"), "@echo off\r\nset NOTIFIER_NAME=osascript.cmd\r\nnode \"%~dp0\\notifier.js\" %*\r\n", "utf8");
		await writeFile(join(workspace, "bin", "powershell.cmd"), "@echo off\r\nset NOTIFIER_NAME=powershell.cmd\r\nnode \"%~dp0\\notifier.js\" %*\r\n", "utf8");
		return;
	}

	await writeFile(join(workspace, "bin", "osascript"), script, "utf8");
	await chmod(join(workspace, "bin", "osascript"), 0o755);
	await writeFile(join(workspace, "bin", "powershell"), script, "utf8");
	await chmod(join(workspace, "bin", "powershell"), 0o755);
}

function fakeNotifierPath(workspace, name) {
	return process.platform === "win32"
		? join(workspace, "bin", `${name}.cmd`)
		: join(workspace, "bin", name);
}

async function clearLog(workspace) {
	const logPath = join(workspace, "lark-cli.log");
	await writeFile(logPath, "", "utf8");
	await rm(`${logPath}.changed-after-update`, { force: true });
	await rm(`${logPath}.inserted-after-update`, { force: true });
	await rm(`${logPath}.skipped-repair-updated`, { force: true });
	await rm(`${logPath}.stale-markdown-count`, { force: true });
	await rm(`${logPath}.stale-with-ids-count`, { force: true });
}

async function clearNotificationLog(workspace) {
	await writeFile(join(workspace, "system-notification.log"), "", "utf8");
}

async function readLog(workspace) {
	return await readFile(join(workspace, "lark-cli.log"), "utf8");
}

async function readNotificationLog(workspace) {
	return await readFile(join(workspace, "system-notification.log"), "utf8");
}

async function readSyncState(workspace) {
	const rawState = await readFile(
		join(workspace, ".obsidian", "plugins", "feishu-lark-cli-sync", "lark-sync-state.json"),
		"utf8"
	);
	return JSON.parse(rawState);
}

function boundMarkdown(url, body) {
	return `---
lark_doc_url: "${url}"
---
${body}`;
}

function boundMarkdownWithToken(token, url, body) {
	return `---
lark_doc_token: "${token}"
lark_doc_url: "${url}"
---
${body}`;
}

await run();
console.log("pre-push tests passed");
