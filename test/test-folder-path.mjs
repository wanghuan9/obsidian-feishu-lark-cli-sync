import assert from "node:assert/strict";
import esbuild from "esbuild";

await esbuild.build({
	bundle: true,
	entryPoints: ["src/folder-path.ts"],
	format: "esm",
	outfile: "test/.tmp-folder-path-test.mjs",
	platform: "node",
	target: "node20"
});

const { getRemoteParentPath, getSelectedFolderName } = await import("./.tmp-folder-path-test.mjs");

assert.equal(getSelectedFolderName("功能需求/供应业务/2026/ITC-78270"), "ITC-78270");
assert.equal(getSelectedFolderName("功能需求/供应业务/2026/ITC-78270/design"), "design");

assert.equal(
	getRemoteParentPath(
		"功能需求/供应业务/2026/ITC-78270",
		"功能需求/供应业务/2026/ITC-78270/design/spec.md",
		"ITC-78270"
	),
	"ITC-78270/design"
);

assert.equal(
	getRemoteParentPath(
		"功能需求/供应业务/2026/ITC-78270/design",
		"功能需求/供应业务/2026/ITC-78270/design/spec.md",
		"design"
	),
	"design"
);

assert.equal(
	getRemoteParentPath(
		"功能需求/供应业务/2026/ITC-78270/design",
		"功能需求/供应业务/2026/ITC-78270/design/db/schema.md",
		"design"
	),
	"design/db"
);

console.log("folder path tests passed");
