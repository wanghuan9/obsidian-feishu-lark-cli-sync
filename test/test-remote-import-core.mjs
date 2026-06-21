import assert from "node:assert/strict";
import esbuild from "esbuild";

await esbuild.build({
	bundle: true,
	entryPoints: ["src/remote-import-core.ts"],
	format: "esm",
	outfile: "test/.tmp-remote-import-core-test.mjs",
	platform: "node",
	target: "node20"
});

await esbuild.build({
	bundle: true,
	entryPoints: ["src/lark-sync-core.ts"],
	format: "esm",
	outfile: "test/.tmp-remote-import-sync-core-test.mjs",
	platform: "node",
	target: "node20"
});

const {
	createEmptyRemoteImportStateFile,
	buildImportedMarkdown,
	normalizeRemoteImportPage,
	runProgressiveRemoteImport
} = await import("./.tmp-remote-import-core-test.mjs");
const {
	buildSyncPlan,
	createEmptySyncStateFile,
	getDocumentStateKey,
	prepareNoteContentForLark,
	readBindingFromMarkdown,
	removeLarkBinding
} = await import("./.tmp-remote-import-sync-core-test.mjs");

function createMemoryAdapter({ pages, documents, files }) {
	const pageCalls = [];
	const writes = [];
	return {
		pageCalls,
		writes,
		adapter: {
			async searchPage(input) {
				pageCalls.push({ kind: "search", ...input });
				return pages.search?.[input.pageToken || ""] || { items: [], hasMore: false };
			},
			async listFolderPage(input) {
				pageCalls.push({ kind: "folder", ...input });
				return pages.folder?.[`${input.folderToken}|${input.pageToken || ""}`] || { items: [], hasMore: false };
			},
			async fetchDocument(doc) {
				const document = documents[doc];
				if (!document) {
					throw new Error(`Missing document fixture: ${doc}`);
				}
				return document;
			},
			async readLocalFile(path) {
				return files.has(path) ? files.get(path) : null;
			},
			async writeLocalFile(path, content) {
				writes.push({ path, content });
				files.set(path, content);
			}
		}
	};
}

{
	const progressState = createEmptyRemoteImportStateFile();
	const syncState = createEmptySyncStateFile();
	const files = new Map();
	const harness = createMemoryAdapter({
		files,
		pages: {
			search: {
				"": {
					items: [{ token: "doc-one", title: "Doc One", type: "docx", url: "https://example.feishu.cn/docx/doc-one" }],
					hasMore: true,
					nextPageToken: "page-2"
				},
				"page-2": {
					items: [{ token: "doc-two", title: "Doc Two", type: "docx", url: "https://example.feishu.cn/docx/doc-two" }],
					hasMore: false
				}
			}
		},
		documents: {
			"https://example.feishu.cn/docx/doc-one": {
				doc: "doc-one",
				markdown: "# Doc One\n\nBody one",
				revisionId: 1
			},
			"https://example.feishu.cn/docx/doc-two": {
				doc: "doc-two",
				markdown: "# Doc Two\n\nBody two",
				revisionId: 2
			}
		}
	});
	const source = {
		type: "search",
		query: "doc",
		localRoot: "Imported",
		remoteRoot: "Imported"
	};

	const firstRun = await runProgressiveRemoteImport({
		source,
		progressState,
		syncState,
		adapter: harness.adapter,
		pageSize: 1,
		now: () => "2026-06-21T00:00:00.000Z"
	});
	assert.equal(firstRun.summary.imported, 1);
	assert.equal(firstRun.summary.completed, false);
	assert.equal(files.has("Imported/Doc One.md"), true);
	assert.deepEqual(readBindingFromMarkdown(files.get("Imported/Doc One.md")), {
		token: "doc-one",
		url: "https://example.feishu.cn/docx/doc-one"
	});
	assert.ok(syncState.documents[getDocumentStateKey("doc-one")]);

	const secondRun = await runProgressiveRemoteImport({
		source,
		progressState,
		syncState,
		adapter: harness.adapter,
		pageSize: 1,
		now: () => "2026-06-21T00:00:01.000Z"
	});
	assert.equal(secondRun.summary.imported, 1);
	assert.equal(secondRun.summary.completed, true);
	assert.equal(harness.pageCalls[1].pageToken, "page-2");
	assert.equal(files.has("Imported/Doc Two.md"), true);
	assert.ok(syncState.documents[getDocumentStateKey("doc-two")]);

	const importedContent = files.get("Imported/Doc Two.md");
	const importedBinding = readBindingFromMarkdown(importedContent);
	const importedState = syncState.documents[getDocumentStateKey(importedBinding.token)];
	const localContentForLark = prepareNoteContentForLark(
		{ basename: "Doc Two" },
		removeLarkBinding(importedContent),
		"file-name"
	);
	const plan = await buildSyncPlan({
		doc: importedBinding.token,
		markdown: localContentForLark,
		contentFileName: "sync.md",
		strategy: "auto",
		state: importedState
	});
	assert.equal(plan.mode, "skipped");
}

{
	const progressState = createEmptyRemoteImportStateFile();
	const syncState = createEmptySyncStateFile();
	const files = new Map();
	const harness = createMemoryAdapter({
		files,
		pages: {
			folder: {
				"root|": {
					items: [
						{ token: "sub", title: "Sub", type: "folder" },
						{ token: "root-doc", title: "Root Doc", type: "docx" }
					],
					hasMore: false
				},
				"sub|": {
					items: [{ token: "nested-doc", title: "Nested", type: "docx" }],
					hasMore: false
				}
			}
		},
		documents: {
			"root-doc": {
				doc: "root-doc",
				markdown: "# Root Doc\n\nRoot body",
				revisionId: 1
			},
			"nested-doc": {
				doc: "nested-doc",
				markdown: "# Nested\n\nNested body",
				revisionId: 1
			}
		}
	});
	const source = {
		type: "drive-folder",
		folderToken: "root",
		localRoot: "Lark",
		remoteRoot: "Lark",
		recursive: true
	};

	const firstRun = await runProgressiveRemoteImport({
		source,
		progressState,
		syncState,
		adapter: harness.adapter,
		pageSize: 20
	});
	assert.equal(firstRun.summary.imported, 1);
	assert.equal(firstRun.summary.completed, false);
	assert.equal(files.has("Lark/Root Doc.md"), true);

	const secondRun = await runProgressiveRemoteImport({
		source,
		progressState,
		syncState,
		adapter: harness.adapter,
		pageSize: 20
	});
	assert.equal(secondRun.summary.imported, 1);
	assert.equal(secondRun.summary.completed, true);
	assert.equal(files.has("Lark/Sub/Nested.md"), true);
	assert.match(files.get("Lark/Sub/Nested.md"), /remoteParentPath: "Lark\/Sub"/);
}

{
	const progressState = createEmptyRemoteImportStateFile();
	const syncState = createEmptySyncStateFile();
	const files = new Map([
		["Imported/Collision.md", "# Local\n\nDifferent"],
		["Imported/Collision-doc-coll.md", "# Other\n\nDifferent"]
	]);
	const harness = createMemoryAdapter({
		files,
		pages: {
			search: {
				"": {
					items: [{ token: "doc-collision", title: "Collision", type: "docx" }],
					hasMore: false
				}
			}
		},
		documents: {
			"doc-collision": {
				doc: "doc-collision",
				markdown: "# Collision\n\nRemote"
			}
		}
	});

	const result = await runProgressiveRemoteImport({
		source: {
			type: "search",
			query: "Collision",
			localRoot: "Imported",
			remoteRoot: "Imported"
		},
		progressState,
		syncState,
		adapter: harness.adapter
	});
	assert.equal(result.summary.conflicts, 1);
	assert.equal(harness.writes.length, 0);
	assert.equal(syncState.documents[getDocumentStateKey("doc-collision")], undefined);
}

{
	const progressState = createEmptyRemoteImportStateFile();
	const syncState = createEmptySyncStateFile();
	const files = new Map([["Imported/Same.md", "# Same\n\nBody"]]);
	const harness = createMemoryAdapter({
		files,
		pages: {
			search: {
				"": {
					items: [{ token: "doc-same", title: "Same", type: "docx", url: "https://example.feishu.cn/docx/doc-same" }],
					hasMore: false
				}
			}
		},
		documents: {
			"https://example.feishu.cn/docx/doc-same": {
				doc: "doc-same",
				markdown: "# Same\n\nBody"
			}
		}
	});

	const result = await runProgressiveRemoteImport({
		source: {
			type: "search",
			query: "Same",
			localRoot: "Imported",
			remoteRoot: "Imported"
		},
		progressState,
		syncState,
		adapter: harness.adapter
	});
	assert.equal(result.summary.imported, 1);
	assert.deepEqual(readBindingFromMarkdown(files.get("Imported/Same.md")), {
		token: "doc-same",
		url: "https://example.feishu.cn/docx/doc-same"
	});
}

{
	const imported = buildImportedMarkdown("# Title\n\nBody", {
		token: "doc-token",
		url: "https://example.feishu.cn/docx/doc-token",
		remoteRoot: "Lark",
		remoteParentPath: "Lark/Sub"
	});
	assert.deepEqual(readBindingFromMarkdown(imported), {
		token: "doc-token",
		url: "https://example.feishu.cn/docx/doc-token"
	});
}

{
	const page = normalizeRemoteImportPage({
		ok: true,
		data: {
			files: [{ token: "doc-token", name: "Doc", type: "docx" }],
			has_more: true,
			next_page_token: "next"
		}
	});
	assert.deepEqual(page, {
		items: [{ token: "doc-token", url: "", title: "Doc", type: "docx" }],
		hasMore: true,
		nextPageToken: "next"
	});
}

{
	const page = normalizeRemoteImportPage({
		ok: true,
		data: {
			results: [{
				entity_type: "DOC",
				title_highlighted: "Search <h>Hit</h>",
				result_meta: {
					token: "doc-search",
					url: "https://example.feishu.cn/docx/doc-search",
					doc_types: "DOCX"
				}
			}],
			has_more: true,
			page_token: "search-next"
		}
	});
	assert.deepEqual(page, {
		items: [{
			token: "doc-search",
			url: "https://example.feishu.cn/docx/doc-search",
			title: "Search Hit",
			type: "docx"
		}],
		hasMore: true,
		nextPageToken: "search-next"
	});
}

console.log("remote-import-core tests passed");
