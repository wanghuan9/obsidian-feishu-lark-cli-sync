import assert from "node:assert/strict";
import esbuild from "esbuild";

await esbuild.build({
	bundle: true,
	entryPoints: ["link-rewrite.ts"],
	format: "esm",
	outfile: ".tmp-link-test.mjs",
	platform: "node",
	target: "node20"
});

const { rewriteInternalLinks } = await import("./.tmp-link-test.mjs");

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

console.log("link rewrite tests passed");
