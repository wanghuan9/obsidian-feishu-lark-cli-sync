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
	buildUpdateDocumentArgs,
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

console.log("lark sync core tests passed");
