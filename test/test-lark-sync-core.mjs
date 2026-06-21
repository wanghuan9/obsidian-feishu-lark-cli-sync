import assert from "node:assert/strict";
import esbuild from "esbuild";

await esbuild.build({
	bundle: true,
	entryPoints: ["src/lark-sync-core.ts"],
	format: "esm",
	outfile: "test/.tmp-lark-sync-core-test.mjs",
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
	createSyncContentSignature,
	extractDocumentToken,
	formatSyncFailureMessage,
	getDocumentStateKey,
	getDocumentStateKeys,
	isDocumentStateContentEquivalent,
	isRemoteXmlContentEquivalent,
	normalizeStateCacheRetainLimit,
	normalizeStateCacheTrimThreshold,
	prepareNoteContentForLark,
	readBindingFromMarkdown,
	removeLarkBinding,
	trimSyncStateCache
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

assert.equal(removeLarkBinding(`---
lark_doc_url: "https://example.feishu.cn/docx/abc"
lark_doc_token: "abc"
---
Body`), "Body");

assert.equal(
	prepareNoteContentForLark({ basename: "Note" }, "Body", "file-name"),
	"# Note\n\nBody"
);
assert.equal(
	prepareNoteContentForLark({ basename: "Note" }, "# Heading\n\nBody", "file-name"),
	"# Note\n\nBody"
);
assert.equal(
	prepareNoteContentForLark({ basename: "Note" }, "# Heading\n\nBody", "first-heading"),
	"# Heading\n\nBody"
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

assert.equal(extractDocumentToken("https://example.feishu.cn/docx/doc-token?from=copy"), "doc-token");
assert.equal(getDocumentStateKey("https://example.feishu.cn/docx/doc-token"), "doc-token");
assert.deepEqual(getDocumentStateKeys(["doc-token", "https://example.feishu.cn/docx/doc-token", ""]), ["doc-token"]);
assert.equal(normalizeStateCacheRetainLimit("10"), 10);
assert.equal(normalizeStateCacheRetainLimit("bad", 20), 20);
assert.equal(normalizeStateCacheTrimThreshold(100), 150);
assert.equal(normalizeStateCacheTrimThreshold(10), 15);
assert.equal(normalizeStateCacheTrimThreshold(3), 5);
const oversizedState = {
	version: 1,
	documents: Object.fromEntries(Array.from({ length: 151 }, (_, index) => {
		const key = `doc-${String(index).padStart(3, "0")}`;
		return [key, {
			doc: key,
			contentHash: `hash-${index}`,
			units: [],
			updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
		}];
	}))
};
const trimmedState = trimSyncStateCache(oversizedState, {
	retainLimit: 100,
	trimThreshold: 150
});
assert.equal(Object.keys(trimmedState.documents).length, 100);
assert.equal(trimmedState.documents["doc-050"], undefined);
assert.ok(trimmedState.documents["doc-051"]);
assert.ok(trimmedState.documents["doc-150"]);
assert.equal(trimSyncStateCache(trimmedState, {
	retainLimit: 100,
	trimThreshold: 150
}), trimmedState);
const smallTrimmedState = trimSyncStateCache(oversizedState, {
	retainLimit: 3
});
assert.deepEqual(Object.keys(smallTrimmedState.documents), ["doc-148", "doc-149", "doc-150"]);

const contentHash = await createContentHash("# Note\n\nBody");
assert.equal(contentHash, await createContentHash("# Note\n\nBody"));
assert.notEqual(contentHash, await createContentHash("# Note\n\nChanged"));
assert.equal(contentHash.length, 64);

const formattedSignature = await createSyncContentSignature("# Note\n\n**Changed**");
const normalizedRemoteState = await createDocumentSyncStateFromRemote(
	"doc-token",
	"# Note\n\nChanged",
	"<title id=\"title\">Note</title><p id=\"blk-1\">Changed</p>"
);
assert.ok(isDocumentStateContentEquivalent(normalizedRemoteState, formattedSignature));
assert.notEqual(normalizedRemoteState.contentHash, formattedSignature.contentHash);

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

const exportedMarkdownState = await createDocumentSyncStateFromRemote("doc-token", "# Note\n\n## Exported", remoteXml, 7);
assert.equal(exportedMarkdownState.contentHash, await createContentHash("# Note\n\n## Exported"));
assert.notEqual(exportedMarkdownState.contentHash, await createContentHash("# Note\n\n## Local"));
assert.equal(await isRemoteXmlContentEquivalent(remoteXml, "# Note\n\nBody\n\n## Next"), true);
assert.equal(await isRemoteXmlContentEquivalent(remoteXml, "# Note\n\nBody"), false);

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

const autoUnmappedReplacePlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# Note\n\nBody\n\n1. Changed",
	contentFileName: "sync.md",
	strategy: "auto",
	state: partialState
});
assert.equal(autoUnmappedReplacePlan.mode, "overwrite");

const incompleteState = {
	...partialState,
	units: [
		partialState.units[0],
		{ ...partialState.units[1], blockId: "" }
	]
};
assert.equal(incompleteState.units.some((unit) => !unit.blockId), true);

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

const paddedTableRemoteXml = [
	"<title id=\"doc-token\">Note</title>",
	"<h2 id=\"heading-1\">Section</h2>",
	"<table id=\"table-1\"><tr><th>接口类</th><th>功能说明</th></tr>",
	"<tr><td><b>PERM_QUOTE — 报价权限</b></td><td></td></tr></table>"
].join("");
const paddedTableState = await createDocumentSyncStateFromRemote(
	"doc-token",
	[
		"# Note",
		"",
		"## Section",
		"",
		"| 接口类 | 功能说明 |",
		"| --- | --- |",
		"| **PERM_QUOTE — 报价权限** | |"
	].join("\n"),
	paddedTableRemoteXml,
	9
);
assert.deepEqual(paddedTableState.units.map((unit) => unit.blockId), ["heading-1", "table-1"]);
const paddedTableResyncedPlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: [
		"# Note",
		"",
		"## Section",
		"",
		"| 接口类 | 功能说明 |",
		"| --- | --- |",
		"| **PERM_QUOTE — 报价权限** | |"
	].join("\n"),
	contentFileName: "sync.md",
	strategy: "auto",
	state: paddedTableState
});
assert.equal(paddedTableResyncedPlan.mode, "skipped");

const nestedListRemoteXml = [
	"<title id=\"doc-token\">Note</title>",
	"<h4 id=\"heading-1\">4.4 jdx-titans 后台统一账号分页查询</h4>",
	"<p id=\"p-1\">接口路径：<code>POST /backend/partner-account/page</code></p>",
	"<ol id=\"ol-1\"><li id=\"li-1\">基础查询：以 <code>partner_account</code> 为主表。</li>",
	"<li id=\"li-2\">主账号（accountType=1）：<ul><li id=\"li-3\">名称：<code>partner_account.name</code>。</li><li id=\"li-4\">手机号：<code>partner_account.phone</code>。</li></ul></li>",
	"<li id=\"li-5\">子账号（accountType=2）：<ul><li id=\"li-6\">手机号：<code>partner_account.phone</code> 匹配。</li><li id=\"li-7\">权限筛选：匹配 <code>partner_account.permissions</code> JSON 中是否包含指定权限编码。</li></ul></li></ol>"
].join("");
const nestedListState = await createDocumentSyncStateFromRemote(
	"doc-token",
	[
		"# Note",
		"",
		"#### 4.4 jdx-titans 后台统一账号分页查询",
		"",
		"接口路径：`POST /backend/partner-account/page`",
		"",
		"1. **基础查询**：以 `partner_account` 为主表。",
		"2. **主账号（accountType=1）**：",
		"   - 名称：`partner_account.name`。",
		"   - 手机号：`partner_account.phone`。",
		"3. **子账号（accountType=2）**：",
		"   - 手机号：`partner_account.phone` 匹配。",
		"   - 权限筛选：匹配 `partner_account.permissions` JSON 中是否包含指定权限编码。"
	].join("\n"),
	nestedListRemoteXml,
	10
);
assert.deepEqual(nestedListState.units.map((unit) => unit.blockId), [
	"heading-1",
	"p-1",
	"li-1",
	"li-2",
	"li-3",
	"li-4",
	"li-5",
	"li-6",
	"li-7"
]);
assert.equal(nestedListState.units.filter((unit) => unit.kind === "list").length, 7);

const indentedCodeRemoteXml = "<title id=\"doc-token\">Note</title><ul><li id=\"blk-1\">Hint</li></ul><pre id=\"blk-2\"><code>x</code></pre><h2 id=\"blk-3\">Next</h2>";
const indentedCodeState = await createDocumentSyncStateFromRemote(
	"doc-token",
	"# Note\n\n- Hint\n\n  ```java\n  x\n  ```\n\n## Next",
	indentedCodeRemoteXml,
	9
);
assert.equal(indentedCodeState.units.length, 3);
assert.deepEqual(indentedCodeState.units.map((unit) => unit.kind), ["list", "code", "heading"]);

const richBlockRemoteXml = [
	"<doc id=\"container\">",
	"<title block-id=\"doc-title\">Note</title>",
	"<ul><li id=\"blk-list-1\">A</li><li id=\"blk-list-2\">B</li></ul>",
	"<table id=\"blk-table\"><tr><th>K</th><th>V</th></tr><tr><td>x</td><td>y</td></tr></table>",
	"<pre block_id=\"blk-code\" lang=\"ts\"><code>const a = 1;<br/>const b = 2;</code></pre>",
	"<hr id=\"blk-hr\"/>",
	"</doc>"
].join("");
const richBlockState = await createDocumentSyncStateFromRemote(
	"doc-token",
	"# Note\n\n- A\n- B\n\n| K | V |\n| --- | --- |\n| x | y |\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\n---",
	richBlockRemoteXml,
	10
);
assert.equal(richBlockState.titleBlockId, "doc-title");
assert.deepEqual(richBlockState.units.map((unit) => unit.kind), ["list", "list", "table", "code", "hr"]);
assert.deepEqual(richBlockState.units.map((unit) => unit.blockId), ["blk-list-1", "blk-list-2", "blk-table", "blk-code", "blk-hr"]);

const looseListState = await createDocumentSyncStateFromRemote(
	"doc-token",
	"# Note\n\n- A\n- B",
	"<title id=\"doc-title\">Note</title><ul id=\"blk-list\"><li>A</li><li>B</li></ul>",
	11
);
assert.deepEqual(looseListState.units, []);

const duplicatedHeadingRemoteXml = "<title id=\"doc-token\">Note</title><h2 id=\"blk-1\">Inserted</h2><p id=\"blk-2\">Inserted</p>";
const duplicatedHeadingState = await createDocumentSyncStateFromRemote(
	"doc-token",
	"# Note\n\n## Inserted",
	duplicatedHeadingRemoteXml,
	12
);
assert.deepEqual(duplicatedHeadingState.units.map((unit) => unit.kind), ["heading"]);

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

const compactReplaceState = await createDocumentSyncStateFromRemote(
	"doc-token",
	"# Note\n\nOne\n\nTwo\n\nThree\n\nFour\n\nFive\n\nSix\n\nSeven\n\nEight\n\nNine\n\nTen\n\nEleven\n\nTwelve",
	[
		"<title id=\"doc-title\">Note</title>",
		"<p id=\"blk-1\">One</p>",
		"<p id=\"blk-2\">Two</p>",
		"<p id=\"blk-3\">Three</p>",
		"<p id=\"blk-4\">Four</p>",
		"<p id=\"blk-5\">Five</p>",
		"<p id=\"blk-6\">Six</p>",
		"<p id=\"blk-7\">Seven</p>",
		"<p id=\"blk-8\">Eight</p>",
		"<p id=\"blk-9\">Nine</p>",
		"<p id=\"blk-10\">Ten</p>",
		"<p id=\"blk-11\">Eleven</p>",
		"<p id=\"blk-12\">Twelve</p>"
	].join(""),
	20
);
const compactReplacePlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# Note\n\nOne\n\nTwo changed\n\nThree changed\n\nFour changed\n\nFive\n\nSix\n\nSeven\n\nEight\n\nNine\n\nTen\n\nEleven\n\nTwelve",
	contentFileName: "sync.md",
	strategy: "precise",
	state: compactReplaceState
});
assert.equal(compactReplacePlan.mode, "precise");
assert.deepEqual(compactReplacePlan.commands, [
	{
		doc: "doc-token",
		command: "block_insert_after",
		docFormat: "markdown",
		blockId: "blk-1",
		contentFileName: "sync.md",
		content: "Two changed\n\nThree changed\n\nFour changed"
	},
	{
		doc: "doc-token",
		command: "block_delete",
		blockId: "blk-2,blk-3,blk-4"
	}
]);

const leadingCompactReplacePlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# Note\n\nOne changed\n\nTwo changed\n\nThree changed\n\nFour\n\nFive\n\nSix\n\nSeven\n\nEight\n\nNine\n\nTen\n\nEleven\n\nTwelve",
	contentFileName: "sync.md",
	strategy: "precise",
	state: compactReplaceState
});
assert.equal(leadingCompactReplacePlan.mode, "precise");
assert.deepEqual(leadingCompactReplacePlan.commands, [
	{
		doc: "doc-token",
		command: "block_insert_after",
		docFormat: "markdown",
		blockId: "doc-title",
		contentFileName: "sync.md",
		content: "One changed\n\nTwo changed\n\nThree changed"
	},
	{
		doc: "doc-token",
		command: "block_delete",
		blockId: "blk-1,blk-2,blk-3"
	}
]);

const largeChangeState = await createDocumentSyncStateFromRemote(
	"doc-token",
	[
		"# Note",
		"",
		"One",
		"",
		"Two",
		"",
		"Three",
		"",
		"Four",
		"",
		"Five",
		"",
		"Six",
		"",
		"Seven",
		"",
		"Eight",
		"",
		"Nine",
		"",
		"Ten"
	].join("\n"),
	[
		"<title id=\"doc-title\">Note</title>",
		"<p id=\"blk-1\">One</p>",
		"<p id=\"blk-2\">Two</p>",
		"<p id=\"blk-3\">Three</p>",
		"<p id=\"blk-4\">Four</p>",
		"<p id=\"blk-5\">Five</p>",
		"<p id=\"blk-6\">Six</p>",
		"<p id=\"blk-7\">Seven</p>",
		"<p id=\"blk-8\">Eight</p>",
		"<p id=\"blk-9\">Nine</p>",
		"<p id=\"blk-10\">Ten</p>"
	].join(""),
	21
);
const largeChangeMarkdown = [
	"# Note",
	"",
	"One changed",
	"",
	"Two changed",
	"",
	"Three changed",
	"",
	"Four changed",
	"",
	"Five changed",
	"",
	"Six changed",
	"",
	"Seven changed",
	"",
	"Eight changed",
	"",
	"Nine changed",
	"",
	"Ten changed"
].join("\n");
const largeChangePlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: largeChangeMarkdown,
	contentFileName: "sync.md",
	strategy: "auto",
	state: largeChangeState
});
assert.equal(largeChangePlan.mode, "overwrite");
assert.deepEqual(largeChangePlan.commands, [{
	doc: "doc-token",
	command: "overwrite",
	docFormat: "markdown",
	contentFileName: "sync.md"
}]);
const preciseLargeChangePlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: largeChangeMarkdown,
	contentFileName: "sync.md",
	strategy: "precise",
	state: largeChangeState
});
assert.equal(preciseLargeChangePlan.mode, "precise");

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

assert.deepEqual(await buildSyncPlan({
	doc: "doc-token",
	markdown,
	contentFileName: "sync.md",
	strategy: "precise",
	state: {
		...state,
		contentHash: await createContentHash(markdown)
	}
}), {
	mode: "skipped",
	commands: [],
	contentHash: await createContentHash(markdown),
	nextState: {
		...state,
		contentHash: await createContentHash(markdown)
	}
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

const autoMissingMappingPlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# Note\n\nBody",
	contentFileName: "sync.md",
	strategy: "auto"
});
assert.equal(autoMissingMappingPlan.mode, "overwrite");

const complexPlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# Note\n\nBody\n\nInserted\n\n## Next",
	contentFileName: "sync.md",
	strategy: "precise",
	state: mappedState
});
assert.equal(complexPlan.mode, "precise");
assert.deepEqual(complexPlan.commands, [{
	doc: "doc-token",
	command: "block_insert_after",
	docFormat: "markdown",
	blockId: "blk-1",
	contentFileName: "sync.md",
	content: "Inserted"
}]);

const modifiedAroundInsertState = await createDocumentSyncStateFromRemote(
	"doc-token",
	"# Note\n\nOld one\n\nOld two\n\nKeep",
	[
		"<title id=\"doc-title\">Note</title>",
		"<p id=\"blk-1\">Old one</p>",
		"<p id=\"blk-2\">Old two</p>",
		"<p id=\"blk-3\">Keep</p>"
	].join(""),
	11
);
const modifiedAroundInsertPlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# Note\n\nNew one\n\nInserted\n\nNew two\n\nKeep",
	contentFileName: "sync.md",
	strategy: "precise",
	state: modifiedAroundInsertState
});
assert.equal(modifiedAroundInsertPlan.mode, "precise");
assert.deepEqual(modifiedAroundInsertPlan.commands, [
	{
		doc: "doc-token",
		command: "block_delete",
		blockId: "blk-1,blk-2"
	},
	{
		doc: "doc-token",
		command: "block_insert_after",
		docFormat: "markdown",
		blockId: "doc-title",
		contentFileName: "sync.md",
		content: "New one\n\nInserted\n\nNew two"
	}
]);

const headingInsertPlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# Note\n\nBody\n\n## Inserted\n\n## Next",
	contentFileName: "sync.md",
	strategy: "precise",
	state: mappedState
});
assert.equal(headingInsertPlan.mode, "precise");
assert.deepEqual(headingInsertPlan.commands, [{
	doc: "doc-token",
	command: "block_insert_after",
	docFormat: "xml",
	blockId: "blk-1",
	contentFileName: "sync.md",
	content: "<h2>Inserted</h2>"
}]);

const headingReplacePlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# Note\n\nBody\n\n## Updated",
	contentFileName: "sync.md",
	strategy: "precise",
	state: mappedState
});
assert.equal(headingReplacePlan.mode, "precise");
assert.deepEqual(headingReplacePlan.commands, [{
	doc: "doc-token",
	command: "block_replace",
	docFormat: "xml",
	blockId: "blk-2",
	contentFileName: "sync.md",
	content: "<h2>Updated</h2>"
}]);

const paragraphLabelState = await createDocumentSyncStateFromRemote(
	"doc-token",
	"# Note\n\nBody\n\n**原因**：\n\n- Keep",
	"<title id=\"doc-token\">Note</title><p id=\"blk-1\">Body</p><p id=\"blk-2\"><b>原因</b>：</p><ul><li id=\"blk-3\">Keep</li></ul>",
	10
);
const paragraphLabelPlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# Note\n\nBody\n2121\n21212\n**原因**：\n\n- Keep",
	contentFileName: "sync.md",
	strategy: "precise",
	state: paragraphLabelState
});
assert.equal(paragraphLabelPlan.mode, "precise");
assert.deepEqual(paragraphLabelPlan.commands, [{
	doc: "doc-token",
	command: "block_replace",
	docFormat: "markdown",
	blockId: "blk-1",
	contentFileName: "sync.md",
	content: "Body\n2121\n21212"
}]);

const leadingInsertPlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# Note\n\nInserted\n\nBody\n\n## Next",
	contentFileName: "sync.md",
	strategy: "precise",
	state: mappedState
});
assert.equal(leadingInsertPlan.mode, "precise");
assert.deepEqual(leadingInsertPlan.commands, [{
	doc: "doc-token",
	command: "block_insert_after",
	docFormat: "markdown",
	blockId: "doc-token",
	contentFileName: "sync.md",
	content: "Inserted"
}]);

const middleDeleteState = await createDocumentSyncStateFromRemote(
	"doc-token",
	"# Note\n\nBody\n\nInserted\n\n## Next",
	"<title id=\"doc-token\">Note</title><p id=\"blk-1\">Body</p><p id=\"blk-2\">Inserted</p><h2 id=\"blk-3\">Next</h2>",
	10
);
const middleDeletePlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# Note\n\nBody\n\n## Next",
	contentFileName: "sync.md",
	strategy: "precise",
	state: middleDeleteState
});
assert.equal(middleDeletePlan.mode, "precise");
assert.deepEqual(middleDeletePlan.commands, [{
	doc: "doc-token",
	command: "block_delete",
	blockId: "blk-2"
}]);

const listHeadRestoreFullMarkdown = "# Note\n\n**原因**：\n\n- 权限项稳定，适合用枚举表达\n- 避免额外的权限定义表查询\n- 子账号权限读取链路简单，便于缓存\n- 当前权限数量少，JSON 存储足够支撑本期复杂度\n\n## Next";
const listHeadRestoreDeletedMarkdown = "# Note\n\n**原因**：\n\n- 当前权限数量少，JSON 存储足够支撑本期复杂度\n\n## Next";
const listHeadRestoreState = await createDocumentSyncStateFromRemote(
	"doc-token",
	listHeadRestoreDeletedMarkdown,
	"<title id=\"doc-title\">Note</title><p id=\"blk-1\"><b>原因</b>：</p><ul><li id=\"blk-5\">当前权限数量少，JSON 存储足够支撑本期复杂度</li></ul><h2 id=\"blk-6\">Next</h2>",
	11
);
assert.equal(listHeadRestoreState.titleBlockId, "doc-title");
const listHeadRestorePlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: listHeadRestoreFullMarkdown,
	contentFileName: "sync.md",
	strategy: "precise",
	state: listHeadRestoreState
});
assert.equal(listHeadRestorePlan.mode, "precise");
assert.deepEqual(listHeadRestorePlan.commands, [{
	doc: "doc-token",
	command: "block_insert_after",
	docFormat: "markdown",
	blockId: "blk-1",
	contentFileName: "sync.md",
	content: "- 权限项稳定，适合用枚举表达\n- 避免额外的权限定义表查询\n- 子账号权限读取链路简单，便于缓存"
}]);

const mixedRestoreState = await createDocumentSyncStateFromRemote(
	"doc-token",
	"# Note\n\n**原因**：\n21212\n\n- 权限项稳定，适合用枚举表达\n- 当前权限数量少，JSON 存储足够支撑本期复杂度\n\n## Next",
	"<title id=\"doc-title\">Note</title><p id=\"blk-1\"><b>原因</b>：<br/>21212</p><ul><li id=\"blk-2\">权限项稳定，适合用枚举表达</li><li id=\"blk-5\">当前权限数量少，JSON 存储足够支撑本期复杂度</li></ul><h2 id=\"blk-6\">Next</h2>",
	13
);
const mixedRestorePlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# Note\n\n**原因**：\n21212333\n\n- 权限项稳定，适合用枚举表达\n- 避免额外的权限定义表查询\n- 子账号权限读取链路简单，便于缓存\n- 当前权限数量少，JSON 存储足够支撑本期复杂度\n\n## Next",
	contentFileName: "sync.md",
	strategy: "precise",
	state: mixedRestoreState
});
assert.equal(mixedRestorePlan.mode, "precise");
assert.deepEqual(mixedRestorePlan.commands, [
	{
		doc: "doc-token",
		command: "block_replace",
		docFormat: "markdown",
		blockId: "blk-1",
		contentFileName: "sync.md",
		content: "**原因**：\n21212333"
	},
	{
		doc: "doc-token",
		command: "block_insert_after",
		docFormat: "markdown",
		blockId: "blk-2",
		contentFileName: "sync.md",
		content: "- 避免额外的权限定义表查询\n- 子账号权限读取链路简单，便于缓存"
	}
]);

const mixedDeleteReplaceRemoteMarkdown = "# Note\n\n**原因**：\n\n- A\n- B\n- C\n- B\n- C\n- D\n\n```java\nclass Demo {\n    private final String code;\n    private final String desc;\n\n    private final List<String> dependencies;\n}\n```\n\n## Next";
const mixedDeleteReplaceState = await createDocumentSyncStateFromRemote(
	"doc-token",
	mixedDeleteReplaceRemoteMarkdown,
	"<title id=\"doc-title\">Note</title><p id=\"blk-1\"><b>原因</b>：</p><ul><li id=\"blk-2\">A</li><li id=\"blk-3\">B</li><li id=\"blk-4\">C</li><li id=\"blk-5\">B</li><li id=\"blk-6\">C</li><li id=\"blk-7\">D</li></ul><pre id=\"blk-8\" lang=\"java\"><code>class Demo {<br/>    private final String code;<br/>    private final String desc;<br/><br/>    private final List&lt;String&gt; dependencies;<br/>}</code></pre><h2 id=\"blk-9\">Next</h2>",
	14
);
const mixedDeleteReplacePlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# Note\n\n**原因**：\n\n- A\n- B\n- C\n- D\n\n```java\nclass Demo {\n    private final String code;\n    private final String desc;\n    private final PermissionType type;\n    private final List<String> dependencies;\n}\n```\n\n## Next",
	contentFileName: "sync.md",
	strategy: "precise",
	state: mixedDeleteReplaceState
});
assert.equal(mixedDeleteReplacePlan.mode, "precise");
assert.deepEqual(mixedDeleteReplacePlan.commands, [
	{
		doc: "doc-token",
		command: "block_delete",
		blockId: "blk-5,blk-6"
	},
	{
		doc: "doc-token",
		command: "block_replace",
		docFormat: "markdown",
		blockId: "blk-8",
		contentFileName: "sync.md",
		content: "```java\nclass Demo {\n    private final String code;\n    private final String desc;\n    private final PermissionType type;\n    private final List<String> dependencies;\n}\n```"
	}
]);

const leadingRestoreState = await createDocumentSyncStateFromRemote(
	"doc-token",
	"# Note\n\nBody\n\n## Next",
	"<title id=\"doc-title\">Note</title><p id=\"blk-1\">Body</p><h2 id=\"blk-2\">Next</h2>",
	12
);
const leadingRestorePlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# Note\n\nInserted\n\nBody\n\n## Next",
	contentFileName: "sync.md",
	strategy: "precise",
	state: leadingRestoreState
});
assert.equal(leadingRestorePlan.mode, "precise");
assert.deepEqual(leadingRestorePlan.commands, [{
	doc: "doc-token",
	command: "block_insert_after",
	docFormat: "markdown",
	blockId: "doc-title",
	contentFileName: "sync.md",
	content: "Inserted"
}]);

const rebuiltInsertState = await createDocumentSyncStateFromRemote(
	"doc-token",
	"# tasks-main\n\n## 实施任务清单（主功能）\n\n| 由 spec.md 6.2-6.5 章节生成 |\n| --- |\n| 分 6 批提交，每批是一个独立 review 单元 |\n| 核心原则: 自底向上 |\n\n## 分批总览\n\n| 批次 | 主题 |\n| --- | --- |\n| 1 | A |",
	"<title id=\"doc-title\">tasks-main</title><h2 id=\"blk-1\">实施任务清单（主功能）</h2><table id=\"blk-2\"><tr><td>由 spec.md 6.2-6.5 章节生成</td></tr><tr><td>分 6 批提交，每批是一个独立 review 单元</td></tr><tr><td>核心原则: 自底向上</td></tr></table><h2 id=\"blk-3\">分批总览</h2><table id=\"blk-4\"><tr><th>批次</th><th>主题</th></tr><tr><td>1</td><td>A</td></tr></table>",
	15
);
const rebuiltInsertPlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# tasks-main\n\n## 实施任务清单（主功能）\n\n| 由 spec.md 6.2-6.5 章节生成 |\n| --- |\n| 分 6 批提交，每批是一个独立 review 单元 |\n| 核心原则: 自底向上 |\n\n## 分批总览\n\n212122\n\n| 批次 | 主题 |\n| --- | --- |\n| 1 | A |",
	contentFileName: "sync.md",
	strategy: "precise",
	state: rebuiltInsertState
});
assert.equal(rebuiltInsertPlan.mode, "precise");
assert.deepEqual(rebuiltInsertPlan.commands, [{
	doc: "doc-token",
	command: "block_insert_after",
	docFormat: "markdown",
	blockId: "blk-3",
	contentFileName: "sync.md",
	content: "212122"
}]);

const rebuiltReplacePlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# tasks-main\n\n## 实施任务清单（主功能）\n\n| 由 spec.md 6.2-6.5 章节生成 |\n| --- |\n| 分 6 批提交，每批是一个独立 review 单元 |\n| 核心原则: 自底向上 |\n\n## 分批总览更新\n\n| 批次 | 主题 |\n| --- | --- |\n| 1 | A |",
	contentFileName: "sync.md",
	strategy: "precise",
	state: rebuiltInsertState
});
assert.equal(rebuiltReplacePlan.mode, "precise");
assert.deepEqual(rebuiltReplacePlan.commands, [{
	doc: "doc-token",
	command: "block_replace",
	docFormat: "xml",
	blockId: "blk-3",
	contentFileName: "sync.md",
	content: "<h2>分批总览更新</h2>"
}]);

const rebuiltDeletePlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# tasks-main\n\n## 实施任务清单（主功能）\n\n| 由 spec.md 6.2-6.5 章节生成 |\n| --- |\n| 分 6 批提交，每批是一个独立 review 单元 |\n| 核心原则: 自底向上 |\n\n| 批次 | 主题 |\n| --- | --- |\n| 1 | A |",
	contentFileName: "sync.md",
	strategy: "precise",
	state: rebuiltInsertState
});
assert.equal(rebuiltDeletePlan.mode, "precise");
assert.deepEqual(rebuiltDeletePlan.commands, [{
	doc: "doc-token",
	command: "block_delete",
	blockId: "blk-3"
}]);

const rebuiltInsertReplacePlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# tasks-main\n\n## 实施任务清单（主功能）\n\n| 由 spec.md 6.2-6.5 章节生成 |\n| --- |\n| 分 6 批提交，每批是一个独立 review 单元 |\n| 核心原则: 自底向上 |\n\n## 分批总览更新\n\n212122\n\n| 批次 | 主题 |\n| --- | --- |\n| 1 | A |",
	contentFileName: "sync.md",
	strategy: "precise",
	state: rebuiltInsertState
});
assert.equal(rebuiltInsertReplacePlan.mode, "precise");
assert.deepEqual(rebuiltInsertReplacePlan.commands, [
	{
		doc: "doc-token",
		command: "block_replace",
		docFormat: "xml",
		blockId: "blk-3",
		contentFileName: "sync.md",
		content: "<h2>分批总览更新</h2>"
	},
	{
		doc: "doc-token",
		command: "block_insert_after",
		docFormat: "markdown",
		blockId: "blk-3",
		contentFileName: "sync.md",
		content: "212122"
	}
]);

const headingInsertAroundHrState = await createDocumentSyncStateFromRemote(
	"doc-token",
	"# spec\n\n## 三、用户角色\n\n| 角色 | 说明 |\n| --- | --- |\n| 主账号 | 可管理子账号 |\n| 子账号 | 无法管理其他子账号 |\n\n---\n\n## 四、功能需求\n\n### 4.1 账号管理",
	"<title id=\"doc-title\">spec</title><h2 id=\"blk-role\">三、用户角色</h2><table id=\"blk-table\"><tr><th>角色</th><th>说明</th></tr><tr><td>主账号</td><td>可管理子账号</td></tr><tr><td>子账号</td><td>无法管理其他子账号</td></tr></table><hr id=\"blk-hr\"/><h2 id=\"blk-feature\">四、功能需求</h2><h3 id=\"blk-account\">4.1 账号管理</h3>",
	17
);
const headingInsertAroundHrPlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# spec\n\n## 三、用户角色\n\n| 角色 | 说明 |\n| --- | --- |\n| 主账号 | 可管理子账号 |\n| 子账号 | 无法管理其他子账号 |\n\n### 测试githook修改11\n\n---\n\n## 四、功能需求 测试修改\n\n### 4.1 账号管理",
	contentFileName: "sync.md",
	strategy: "precise",
	state: headingInsertAroundHrState
});
assert.equal(headingInsertAroundHrPlan.mode, "precise");
assert.deepEqual(headingInsertAroundHrPlan.commands, [
	{
		doc: "doc-token",
		command: "block_insert_after",
		docFormat: "xml",
		blockId: "blk-table",
		contentFileName: "sync.md",
		content: "<h3>测试githook修改11</h3>"
	},
	{
		doc: "doc-token",
		command: "block_replace",
		docFormat: "xml",
		blockId: "blk-feature",
		contentFileName: "sync.md",
		content: "<h2>四、功能需求 测试修改</h2>"
	}
]);

const kindChangedGapState = await createDocumentSyncStateFromRemote(
	"doc-token",
	"# Note\n\n## Before\n\nBody\n\n## After",
	"<title id=\"doc-title\">Note</title><h2 id=\"blk-before\">Before</h2><p id=\"blk-body\">Body</p><h2 id=\"blk-after\">After</h2>",
	18
);
const kindChangedGapPlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# Note\n\n## Before\n\n- Body\n- Extra\n\n## After",
	contentFileName: "sync.md",
	strategy: "precise",
	state: kindChangedGapState
});
assert.equal(kindChangedGapPlan.mode, "precise");
assert.deepEqual(kindChangedGapPlan.commands, [
	{
		doc: "doc-token",
		command: "block_delete",
		blockId: "blk-body"
	},
	{
		doc: "doc-token",
		command: "block_insert_after",
		docFormat: "markdown",
		blockId: "blk-before",
		contentFileName: "sync.md",
		content: "- Body\n- Extra"
	}
]);

const rebuiltDeleteReplacePlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# tasks-main\n\n## 实施任务清单（主功能）\n\n| 由 spec.md 6.2-6.5 章节生成 |\n| --- |\n| 分 6 批提交，每批是一个独立 review 单元 |\n| 核心原则: 自底向上 |\n\n| 批次 | 主题 |\n| --- | --- |\n| 1 | B |",
	contentFileName: "sync.md",
	strategy: "precise",
	state: rebuiltInsertState
});
assert.equal(rebuiltDeleteReplacePlan.mode, "precise");
assert.deepEqual(rebuiltDeleteReplacePlan.commands, [
	{
		doc: "doc-token",
		command: "block_delete",
		blockId: "blk-3"
	},
	{
		doc: "doc-token",
		command: "block_replace",
		docFormat: "markdown",
		blockId: "blk-4",
		contentFileName: "sync.md",
		content: "| 批次 | 主题 |\n| --- | --- |\n| 1 | B |"
	}
]);

const rebuiltTasksBackendState = await createDocumentSyncStateFromRemote(
	"doc-token",
	"# 实施任务清单（PC 后台接口）\n\n> 由 spec.md 04-api.md 第四节生成\n> 核心原则: jdx-titans 作为数据 owner 提供后台查询接口，pjt-partner-admin 对前端暴露统一入口并做模式分发\n\n## 依赖关系\n\n```\nBatch 1（模型基础层） ← Task 7.1, 7.3 依赖\nTask 7.1 (jdx-titans 后台 DTO) ← Task 7.2 依赖\n```\n\n## 变更影响概览\n\n### 文件变更清单\n\n| 文件 | 操作 | 涉及任务 | 说明 |\n| --- | --- | --- | --- |\n| jdx-titans-model/.../BackendAccountOptionReq.java | 新建 | Task 7.1 | 后台候选查询请求 |",
	"<title id=\"doc-title\">实施任务清单（PC 后台接口）</title><blockquote id=\"blk-1\"><p>由 spec.md 04-api.md 第四节生成</p><p>核心原则: jdx-titans 作为数据 owner 提供后台查询接口，pjt-partner-admin 对前端暴露统一入口并做模式分发</p></blockquote><h2 id=\"blk-2\">依赖关系</h2><pre id=\"blk-3\"><code>Batch 1（模型基础层） ← Task 7.1, 7.3 依赖\nTask 7.1 (jdx-titans 后台 DTO) ← Task 7.2 依赖</code></pre><h2 id=\"blk-4\">变更影响概览</h2><p id=\"blk-extra\">远端结构化占位</p><h3 id=\"blk-5\">文件变更清单</h3><table id=\"blk-6\"><tr><th>文件</th><th>操作</th><th>涉及任务</th><th>说明</th></tr><tr><td>jdx-titans-model/.../BackendAccountOptionReq.java</td><td>新建</td><td>Task 7.1</td><td>后台候选查询请求</td></tr></table>",
	16
);
assert.deepEqual(rebuiltTasksBackendState.units.map((unit) => unit.blockId), [
	"blk-1",
	"blk-2",
	"blk-3",
	"blk-4",
	"blk-5",
	"blk-6"
]);
const rebuiltTasksBackendInsertPlan = await buildSyncPlan({
	doc: "doc-token",
	markdown: "# 实施任务清单（PC 后台接口）\n\n> 由 spec.md 04-api.md 第四节生成\n> 核心原则: jdx-titans 作为数据 owner 提供后台查询接口，pjt-partner-admin 对前端暴露统一入口并做模式分发\n\n## 依赖关系\n\n```\nBatch 1（模型基础层） ← Task 7.1, 7.3 依赖\nTask 7.1 (jdx-titans 后台 DTO) ← Task 7.2 依赖\n```\n\n## 变更影响概览\n212dsa\n\n### 文件变更清单\n\n| 文件 | 操作 | 涉及任务 | 说明 |\n| --- | --- | --- | --- |\n| jdx-titans-model/.../BackendAccountOptionReq.java | 新建 | Task 7.1 | 后台候选查询请求 |",
	contentFileName: "sync.md",
	strategy: "precise",
	state: rebuiltTasksBackendState
});
assert.equal(rebuiltTasksBackendInsertPlan.mode, "precise");
assert.deepEqual(rebuiltTasksBackendInsertPlan.commands, [{
	doc: "doc-token",
	command: "block_insert_after",
	docFormat: "markdown",
	blockId: "blk-4",
	contentFileName: "sync.md",
	content: "212dsa"
}]);

const repeatedSectionState = await createDocumentSyncStateFromRemote(
	"doc-token",
	[
		"# API",
		"",
		"## A",
		"",
		"请求参数：",
		"",
		"```json",
		"{\"id\":1}",
		"```",
		"",
		"响应参数：",
		"",
		"## B",
		"",
		"请求参数：",
		"",
		"```json",
		"{\"id\":1}",
		"```",
		"",
		"响应参数："
	].join("\n"),
	[
		"<title id=\"doc-title\">API</title>",
		"<h2 id=\"heading-a\">A</h2>",
		"<p id=\"a-req\">请求参数：</p>",
		"<pre id=\"a-code\"><code>{\"id\":1}</code></pre>",
		"<p id=\"a-resp\">响应参数：</p>",
		"<h2 id=\"heading-b\">B</h2>",
		"<p id=\"b-req\">请求参数：</p>",
		"<pre id=\"b-code\"><code>{\"id\":1}</code></pre>",
		"<p id=\"b-resp\">响应参数：</p>"
	].join(""),
	17
);
assert.deepEqual(repeatedSectionState.units.map((unit) => unit.blockId), [
	"heading-a",
	"a-req",
	"a-code",
	"a-resp",
	"heading-b",
	"b-req",
	"b-code",
	"b-resp"
]);

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
