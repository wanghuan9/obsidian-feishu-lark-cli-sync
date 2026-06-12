import assert from "node:assert/strict";
import esbuild from "esbuild";

await esbuild.build({
	bundle: true,
	entryPoints: ["src/note-content.ts"],
	format: "esm",
	outfile: "test/.tmp-note-content-test.mjs",
	platform: "node",
	target: "node20"
});

const { prepareNoteContentForLark } = await import("./.tmp-note-content-test.mjs");

const file = { basename: "File Name Title" };

assert.equal(
	prepareNoteContentForLark(file, "# Markdown Title\n\nBody", "file-name"),
	"# File Name Title\n\nBody"
);

assert.equal(
	prepareNoteContentForLark(file, "# Markdown Title\n\nBody", "first-heading"),
	"# Markdown Title\n\nBody"
);

assert.equal(
	prepareNoteContentForLark(file, "Body", "file-name"),
	"# File Name Title\n\nBody"
);

console.log("note content tests passed");
