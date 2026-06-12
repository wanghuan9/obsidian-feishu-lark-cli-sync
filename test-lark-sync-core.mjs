import assert from "node:assert/strict";
import esbuild from "esbuild";

await esbuild.build({
	bundle: true,
	entryPoints: ["lark-sync-core.ts"],
	format: "esm",
	outfile: ".tmp-lark-sync-core-test.mjs",
	platform: "node",
	target: "node20"
});

const {
	buildSyncPlan,
	buildUpdateCommandArgs,
	buildUpdateDocumentArgs,
	createDocumentSyncStateFromRemote,
	createContentHash,
	createEmptySyncStateFile,
	formatSyncFailureMessage,
	prepareNoteContentForLark,
	readBindingFromMarkdown,
	removeLarkBinding
} = await import("./.tmp-lark-sync-core-test.mjs");

const markdown = `---
lark_doc_url: "https://example.feishu.cn/docx/abc"
lark_doc_synced_at: "2026-06-12 10:42:31"
tags:
  - sync
---
Body`;

assert.deepEqual(readBindingFromMarkdown(markdown), {
	token: "",
	url: "https://example.feishu.cn/docx/abc"
});

assert.equal(removeLarkBinding(markdown), `---
tags:
  - sync
---
Body`);

assert.equal(
	prepareNoteContentForLark({ basename: "Note" }, "Body", "file-name"),
	"# Note\n\nBody"
);

assert.deepEqual(buildUpdateDocumentArgs("doc-token", "sync.md"), [
	"docs",
	"+update",
	"--api-version",
	"v2",
	"--as",
	"user",
	"--doc",
	"doc-token",
	"--command",
	"overwrite",
	"--doc-format",
	"markdown",
	"--content",
	"@sync.md",
	"--json"
]);

assert.deepEqual(buildUpdateCommandArgs({
	doc: "doc-token",
	command: "block_replace",
	docFormat: "markdown",
	blockId: "blk-1",
	contentFileName: "unit.md"
}), [
	"docs",
	"+update",
	"--api-version",
	"v2",
	"--as",
	"user",
	"--doc",
	"doc-token",
	"--command",
	"block_replace",
	"--doc-format",
	"markdown",
	"--block-id",
	"blk-1",
	"--content",
	"@unit.md",
	"--json"
]);

assert.deepEqual(createEmptySyncStateFile(), {
	version: 1,
	documents: {}
});

const contentHash = await createContentHash("# Note\n\nBody");
assert.equal(contentHash, await createContentHash("# Note\n\nBody"));
assert.notEqual(contentHash, await createContentHash("# Note\n\nChanged"));
assert.equal(contentHash.length, 64);

const overwritePlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# Note\n\nBody",
	contentFileName: "sync.md",
	strategy: "overwrite"
});
assert.equal(overwritePlan.mode, "overwrite");
assert.deepEqual(overwritePlan.commands, [{
	doc: "doc-token",
	command: "overwrite",
	docFormat: "markdown",
	contentFileName: "sync.md"
}]);
assert.equal(overwritePlan.contentHash, contentHash);
assert.equal(overwritePlan.nextState.doc, "doc-token");
assert.equal(overwritePlan.nextState.contentHash, contentHash);
assert.deepEqual(overwritePlan.nextState.units, []);
assert.ok(Date.parse(overwritePlan.nextState.updatedAt));

const remoteXml = "<title id=\"doc-token\">Note</title><p id=\"blk-1\">Body</p><h2 id=\"blk-2\">Next</h2>";
const mappedState = await createDocumentSyncStateFromRemote("doc-token", "# Note\n\nBody\n\n## Next", remoteXml, 7);
assert.equal(mappedState.revisionId, 7);
assert.equal(mappedState.units.length, 2);
assert.deepEqual(mappedState.units.map((unit) => unit.blockId), ["blk-1", "blk-2"]);
assert.deepEqual(mappedState.units.map((unit) => unit.kind), ["paragraph", "heading"]);

const partialRemoteXml = "<title id=\"doc-token\">Note</title><p id=\"blk-1\">Body</p><p id=\"blk-2\">Merged<br/>Second</p>";
const partialState = await createDocumentSyncStateFromRemote("doc-token", "# Note\n\nBody\n\n1. Second", partialRemoteXml, 8);
assert.equal(partialState.revisionId, 8);
assert.equal(partialState.units.length, 2);
assert.deepEqual(partialState.units.map((unit) => unit.blockId), ["blk-1", ""]);

const partialReplacePlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# Note\n\nChanged\n\n1. Second",
	contentFileName: "sync.md",
	strategy: "precise",
	state: partialState
});
assert.equal(partialReplacePlan.mode, "precise");
assert.equal(partialReplacePlan.commands.length, 1);
assert.equal(partialReplacePlan.commands[0].blockId, "blk-1");

const unmappedReplacePlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# Note\n\nBody\n\n1. Changed",
	contentFileName: "sync.md",
	strategy: "precise",
	state: partialState
});
assert.equal(unmappedReplacePlan.mode, "blocked");
assert.equal(unmappedReplacePlan.reason, "block-mapping-missing");

const tableRemoteXml = "<title id=\"doc-token\">Note</title><table id=\"blk-1\"><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>";
const tableState = await createDocumentSyncStateFromRemote("doc-token", "# Note\n\n| A | B |\n|-|-|\n| 1 | 2 |", tableRemoteXml, 9);
assert.equal(tableState.units.length, 1);
assert.equal(tableState.units[0].blockId, "blk-1");
assert.equal((await buildSyncPlan({
	doc: "doc-token",
	markdown: "# Note\n\n| A | B |\n|----|------|\n| 1 | 2 |",
	contentFileName: "sync.md",
	strategy: "precise",
	state: tableState
})).mode, "skipped");

const indentedCodeRemoteXml = "<title id=\"doc-token\">Note</title><ul><li id=\"blk-1\">Hint</li></ul><pre id=\"blk-2\"><code>x</code></pre><h2 id=\"blk-3\">Next</h2>";
const indentedCodeState = await createDocumentSyncStateFromRemote(
	"doc-token",
	"# Note\n\n- Hint\n\n  ```java\n  x\n  ```\n\n## Next",
	indentedCodeRemoteXml,
	9
);
assert.equal(indentedCodeState.units.length, 3);
assert.deepEqual(indentedCodeState.units.map((unit) => unit.kind), ["list", "code", "heading"]);

const replacePlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# Note\n\nChanged\n\n## Next",
	contentFileName: "sync.md",
	strategy: "precise",
	state: mappedState
});
assert.equal(replacePlan.mode, "precise");
assert.equal(replacePlan.commands.length, 1);
assert.deepEqual(replacePlan.commands[0], {
	doc: "doc-token",
	command: "block_replace",
	docFormat: "markdown",
	blockId: "blk-1",
	contentFileName: "sync.md",
	content: "Changed"
});
assert.equal(replacePlan.nextState.units[0].blockId, "blk-1");
assert.notEqual(replacePlan.nextState.units[0].hash, mappedState.units[0].hash);

const state = {
	doc: "doc-token",
	contentHash,
	units: [{
		stableId: "unit-1",
		kind: "paragraph",
		hash: "hash-1",
		blockId: "blk-1"
	}],
	updatedAt: "2026-06-12T00:00:00.000Z"
};
assert.deepEqual(await buildSyncPlan({
	doc: "doc-token",
	markdown: "# Note\n\nBody",
	contentFileName: "sync.md",
	strategy: "precise",
	state
}), {
	mode: "skipped",
	commands: [],
	contentHash,
	nextState: state
});

const mismatchedStatePlan = await buildSyncPlan({
	doc: "other-doc-token",
	markdown: "# Note\n\nBody",
	contentFileName: "sync.md",
	strategy: "precise",
	state
});
assert.equal(mismatchedStatePlan.mode, "blocked");
assert.equal(mismatchedStatePlan.reason, "block-mapping-missing");

const missingMappingPlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# Note\n\nBody",
	contentFileName: "sync.md",
	strategy: "precise"
});
assert.equal(missingMappingPlan.mode, "blocked");
assert.equal(missingMappingPlan.reason, "block-mapping-missing");

const complexPlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# Note\n\nBody\n\nInserted\n\n## Next",
	contentFileName: "sync.md",
	strategy: "precise",
	state: mappedState
});
assert.equal(complexPlan.mode, "blocked");
assert.equal(complexPlan.reason, "diff-too-complex");

assert.equal(
	formatSyncFailureMessage({
		language: "zh-CN",
		mode: "pre-push",
		path: "docs/a.md",
		reason: "remote-revision-changed"
	}),
	"[Feishu Lark CLI Sync] pre-push 同步失败：docs/a.md\n原因：远端文档版本已变化，已停止安全增量同步。\n已阻止 git push，以避免覆盖飞书文档修改历史。"
);

assert.equal(
	formatSyncFailureMessage({
		language: "en",
		mode: "pre-push",
		path: "docs/a.md",
		reason: "remote-revision-changed"
	}),
	"[Feishu Lark CLI Sync] pre-push sync failed: docs/a.md\nReason: remote document revision changed; precise sync aborted.\nPush was blocked to avoid overwriting remote document history."
);

assert.equal(
	formatSyncFailureMessage({
		language: "zh-CN",
		mode: "pre-push",
		path: "docs/a.md",
		reason: "lark-cli-failed",
		detail: "network timeout"
	}),
	"[Feishu Lark CLI Sync] pre-push 同步失败：docs/a.md\n原因：lark-cli 执行失败。\nnetwork timeout\n已阻止 git push，以避免覆盖飞书文档修改历史。"
);

assert.equal(
	formatSyncFailureMessage({
		language: "en",
		mode: "save",
		path: "docs/a.md",
		reason: "lark-cli-failed",
		detail: "network timeout"
	}),
	"Auto sync failed: docs/a.md\nReason: lark-cli execution failed.\nnetwork timeout"
);

assert.equal(
	formatSyncFailureMessage({
		language: "zh-CN",
		mode: "pre-push",
		path: "docs/a.md",
		reason: "diff-too-complex",
		detail: "安全增量同步仍在接入中"
	}),
	"[Feishu Lark CLI Sync] pre-push 同步失败：docs/a.md\n原因：本次变更过于复杂，无法安全增量同步。\n安全增量同步仍在接入中\n已阻止 git push，以避免覆盖飞书文档修改历史。"
);

console.log("lark sync core tests passed");
