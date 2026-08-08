import assert from "node:assert/strict";
import esbuild from "esbuild";

await esbuild.build({
	bundle: true,
	entryPoints: ["src/link-rewrite.ts"],
	format: "esm",
	outfile: "test/.tmp-link-test.mjs",
	platform: "node",
	target: "node20"
});

const { buildFolderLinkMap, mayContainInternalLinks, rewriteInternalLinks } = await import("./.tmp-link-test.mjs");
const { buildSyncPlan, createDocumentSyncStateFromRemote } = await import("../lark-sync-core.mjs");

const databaseTarget = {
	token: "database",
	url: "https://example.feishu.cn/docx/database",
	label: "02-database"
};
const componentsTarget = {
	token: "components",
	url: "https://example.feishu.cn/docx/components",
	label: "03-components"
};
const apiTarget = {
	token: "api",
	url: "https://example.feishu.cn/docx/api",
	label: "04-api"
};
const linkMap = new Map([
	["ITC-78270/design/02-database.md", databaseTarget],
	["ITC-78270/design/02-database", databaseTarget],
	["02-database.md", databaseTarget],
	["02-database", databaseTarget],
	["03-components.md", componentsTarget],
	["03-components", componentsTarget],
	["04-api.md", apiTarget]
]);

const currentFile = { path: "ITC-78270/design/spec.md" };
const source = [
	"详细设计见 02-database.md。",
	"详细设计见 [组件设计](03-components.md#section)。",
	"接口见 [[04-api|接口设计]]。",
	"外部链接 [README](https://example.com/README.md) 不应改。"
].join("\n");

const result = rewriteInternalLinks(source, linkMap, currentFile);

assert.match(result, /详细设计见 <cite type="doc" doc-id="database"><\/cite>。/);
assert.match(result, /详细设计见 <cite type="doc" doc-id="components"><\/cite>。/);
assert.match(result, /接口见 <cite type="doc" doc-id="api"><\/cite>。/);
assert.match(result, /\[README]\(https:\/\/example\.com\/README\.md\)/);

const publishedFolderPath = "requirements/供应业务/2026/2026-08/ITC-82194";
const publishedSpecFile = {
	path: `${publishedFolderPath}/spec.md`,
	name: "spec.md",
	basename: "spec"
};
const publishedFolderLinkMap = buildFolderLinkMap(publishedFolderPath, [{
	file: {
		path: `${publishedFolderPath}/design/02-components.md`,
		name: "02-components.md",
		basename: "02-components"
	},
	target: componentsTarget
}]);
const publishedSource = [
	"# spec",
	"",
	"## 已有链接",
	"- [02-components.md](design/02-components.md)",
	"",
	"## 后续修改",
	"原始内容"
].join("\n");
const changedPublishedSource = publishedSource.replace("原始内容", "只修改非链接段落");
const publishedResult = rewriteInternalLinks(publishedSource, publishedFolderLinkMap, publishedSpecFile);
const changedPublishedResult = rewriteInternalLinks(changedPublishedSource, publishedFolderLinkMap, publishedSpecFile);

assert.equal(mayContainInternalLinks("# spec\n\n普通内容"), false);
assert.equal(mayContainInternalLinks(publishedSource), true);
assert.match(publishedResult, /- <cite type="doc" doc-id="components"><\/cite>/);
assert.match(changedPublishedResult, /- <cite type="doc" doc-id="components"><\/cite>/);
assert.equal(
	publishedResult.split("## 后续修改")[0],
	changedPublishedResult.split("## 后续修改")[0]
);

const publishedRemoteXml = [
	'<title id="title-block">spec</title>',
	'<h2 id="links-heading">已有链接</h2>',
	'<ul id="links-block"><li><cite doc-id="components" type="doc"></cite></li></ul>',
	'<h2 id="change-heading">后续修改</h2>',
	'<p id="changed-block">原始内容</p>'
].join("");
const publishedState = await createDocumentSyncStateFromRemote(
	"spec-document",
	publishedResult,
	publishedRemoteXml,
	1
);
const changedPublishedPlan = await buildSyncPlan({
	doc: "spec-document",
	markdown: changedPublishedResult,
	contentFileName: "sync.md",
	strategy: "precise",
	state: publishedState
});

assert.equal(changedPublishedPlan.mode, "precise");
assert.deepEqual(changedPublishedPlan.commands.map((command) => command.blockId), ["changed-block"]);

console.log("link rewrite tests passed");
