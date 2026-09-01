import assert from "node:assert/strict";
import esbuild from "esbuild";

await esbuild.build({
	bundle: true,
	entryPoints: ["src/main.ts"],
	format: "esm",
	outfile: "test/.tmp-main-test.mjs",
	platform: "node",
	target: "node20",
	plugins: [{
		name: "obsidian-test-stub",
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({
				path: "obsidian",
				namespace: "obsidian-test-stub"
			}));
			build.onLoad({ filter: /.*/, namespace: "obsidian-test-stub" }, () => ({
				contents: `
					export const addIcon = () => {};
					export class App {}
					export class FileSystemAdapter {}
					export class Menu {}
					export class Notice {
						constructor(message, timeout) {
							globalThis.__obsidianNotices?.push({ message, timeout });
						}
					}
					export class Plugin {}
					export class PluginSettingTab {}
					export class Setting {}
					export class TFile {}
				`
			}));
		}
	}]
});

const { default: LarkCliSyncPlugin } = await import("./.tmp-main-test.mjs");

function createPlugin() {
	const plugin = Object.create(LarkCliSyncPlugin.prototype);
	plugin.settings = {
		language: "zh-CN",
		updateFrontmatter: false
	};
	return plugin;
}

const policyPlugin = createPlugin();
assert.deepEqual(policyPlugin.getRemoteStateRefreshPolicy("save"), {
	attempts: 8,
	delayMs: 1500,
	allowTimeoutFallback: true
});

const diagnosticPlugin = createPlugin();
const diagnosticWarnings = [];
const originalWarn = console.warn;
console.warn = (...args) => {
	diagnosticWarnings.push(args);
};
try {
	diagnosticPlugin.logRemoteStateRefreshTimeout("doc-token", 8, 15, {
		rejectReason: "revision-lag",
		observedRevisionId: 14
	});

	const incompleteState = {
		doc: "doc-token",
		revisionId: 15,
		contentHash: "hash",
		units: [{
			stableId: "0:paragraph",
			kind: "paragraph",
			hash: "hash",
			blockId: ""
		}],
		updatedAt: "2026-08-13T00:00:00.000Z"
	};
	diagnosticPlugin.logRemoteStateRefreshTimeout(
		"doc-token",
		8,
		15,
		diagnosticPlugin.createBlockMappingDiagnostic(incompleteState)
	);
} finally {
	console.warn = originalWarn;
}
assert.deepEqual(diagnosticWarnings[0][1], {
	doc: "doc-token",
	attempts: 8,
	expectedRevisionId: 15,
	observedRevisionId: 14,
	unitCount: undefined,
	missingBlockIdCount: undefined,
	rejectReason: "revision-lag"
});
assert.deepEqual(diagnosticWarnings[1][1], {
	doc: "doc-token",
	attempts: 8,
	expectedRevisionId: 15,
	observedRevisionId: 15,
	unitCount: 1,
	missingBlockIdCount: 1,
	rejectReason: "block-mapping-incomplete"
});

const retryPlugin = createPlugin();
let fetchCount = 0;
const sleepDelays = [];
let persistedState;
const confirmedState = {
	doc: "doc-token",
	revisionId: 15,
	contentHash: "hash",
	units: [{
		stableId: "0:paragraph",
		kind: "paragraph",
		hash: "hash",
		blockId: "block-1"
	}],
	updatedAt: "2026-08-13T00:00:00.000Z"
};
retryPlugin.fetchRemoteDocumentStateAfterExpectedRevision = async () => {
	fetchCount += 1;
	return fetchCount < 8
		? undefined
		: confirmedState;
};
retryPlugin.sleep = async (delayMs) => {
	sleepDelays.push(delayMs);
};
retryPlugin.persistDocumentState = async (state) => {
	persistedState = state;
};
await retryPlugin.saveRemoteDocumentState("doc-token", [], {
	expectedRevisionId: 15,
	updateSubmitted: true,
	context: { mode: "save", path: "docs/a.md" },
	refreshPolicy: retryPlugin.getRemoteStateRefreshPolicy("save")
});
assert.equal(fetchCount, 8);
assert.deepEqual(sleepDelays, Array(7).fill(1500));
assert.equal(persistedState, confirmedState);

const wiringPlugin = createPlugin();
let confirmationOptions;
wiringPlugin.withTempMarkdown = async (_baseName, _content, callback) => {
	return await callback({ directory: "/tmp", fileName: "sync.md" });
};
wiringPlugin.runLarkCli = async () => ({
	ok: true,
	data: { document: { revision_id: 15 } }
});
wiringPlugin.saveRemoteDocumentState = async (_doc, _stateKeys, options) => {
	confirmationOptions = options;
};
await wiringPlugin.executeSyncPlan("doc-token", { content: "Body", images: [] }, {
	mode: "precise",
	commands: [{
		doc: "doc-token",
		command: "block_delete",
		blockId: "block-1"
	}],
	contentHash: "hash"
}, {
	mode: "save",
	path: "docs/a.md",
	stateKeys: []
});
assert.equal(confirmationOptions.expectedRevisionId, 15);
assert.equal(confirmationOptions.updateSubmitted, true);
assert.deepEqual(confirmationOptions.refreshPolicy, {
	attempts: 8,
	delayMs: 1500,
	allowTimeoutFallback: true
});

const createBindingPlugin = createPlugin();
createBindingPlugin.withTempMarkdown = async (_baseName, _content, callback) => {
	return await callback({ directory: "/tmp", fileName: "note.md" });
};
createBindingPlugin.resolveRemoteRootParent = async () => ({ token: "parent-token" });
createBindingPlugin.runLarkCli = async () => ({
	ok: true,
	data: { document: { document_id: "created-token", url: "https://example.com/docx/created-token" } }
});
createBindingPlugin.materializeLocalImages = async () => {
	throw new Error("image upload failed");
};
let provisionalBinding;
await assert.rejects(
	createBindingPlugin.createLarkDocument(
		{ basename: "Note" },
		{ content: "Body", images: [{}] },
		undefined,
		async (binding) => {
			provisionalBinding = binding;
		}
	),
	/image upload failed/
);
assert.deepEqual(provisionalBinding, {
	token: "created-token",
	url: "https://example.com/docx/created-token"
});

const stagedCreatePlugin = createPlugin();
const stagedCreateEvents = [];
const stagedTempContents = [];
const stagedBatchContents = [];
stagedCreatePlugin.withTempMarkdown = async (_baseName, content, callback) => {
	stagedTempContents.push(content);
	return await callback({ directory: "/tmp", fileName: "note.md" });
};
stagedCreatePlugin.writeTempMarkdown = async (_directory, _baseName, content) => {
	stagedBatchContents.push(content);
	return `batch-${stagedBatchContents.length}.md`;
};
stagedCreatePlugin.resolveRemoteRootParent = async () => ({ token: "parent-token" });
stagedCreatePlugin.runLarkCli = async (args) => {
	if (args[1] === "+create") {
		stagedCreateEvents.push("create");
		return {
			ok: true,
			data: { document: { document_id: "large-token", url: "https://example.com/docx/large-token" } }
		};
	}
	stagedCreateEvents.push("append");
	return {
		ok: true,
		data: { document: { revision_id: stagedCreateEvents.length } }
	};
};
stagedCreatePlugin.materializeLocalImages = async () => {};
const largeBodyUnits = Array.from({ length: 401 }, (_, index) => `Paragraph ${index}`).join("\n\n");
await stagedCreatePlugin.createLarkDocument(
	{ basename: "Large" },
	{ content: `# Large\n\n${largeBodyUnits}`, images: [] },
	undefined,
	async () => {
		stagedCreateEvents.push("bind");
	}
);
assert.equal(stagedTempContents[0], "");
assert.deepEqual(stagedCreateEvents.slice(0, 3), ["create", "bind", "append"]);
assert.equal(stagedBatchContents.length, 5);

const stagedResumePlugin = createPlugin();
stagedResumePlugin.findDocumentState = () => undefined;
stagedResumePlugin.fetchLarkDocumentMarkdown = async () => ({
	content: `# Large\n\n${Array.from({ length: 100 }, (_, index) => `Paragraph ${index}`).join("\n\n")}`,
	revisionId: 10
});
let resumedBatches;
stagedResumePlugin.appendStagedDocumentBatches = async (_doc, batches) => {
	resumedBatches = batches;
	return 20;
};
stagedResumePlugin.materializeLocalImages = async () => undefined;
let resumedBaseline;
stagedResumePlugin.saveRemoteDocumentStateFromBaselineAfterExpectedRevision = async (
	_doc,
	_stateKeys,
	baselineMarkdown,
	expectedRevisionId
) => {
	resumedBaseline = { baselineMarkdown, expectedRevisionId };
};
const resumedDocument = await stagedResumePlugin.tryResumeStagedDocumentPublish(
	"large-token",
	{ content: `# Large\n\n${largeBodyUnits}`, images: [] },
	{ mode: "manual", path: "large.md", stateKeys: [] }
);
assert.equal(resumedDocument.revisionId, 20);
assert.equal(resumedBatches.length, 4);
assert.deepEqual(resumedBaseline, {
	baselineMarkdown: `# Large\n\n${largeBodyUnits}`,
	expectedRevisionId: 20
});

const bindingWriterPlugin = createPlugin();
const writtenFrontmatter = {
	lark_doc_token: "legacy-token"
};
bindingWriterPlugin.selfWrittenPaths = new Map();
bindingWriterPlugin.getBinding = () => null;
bindingWriterPlugin.app = {
	vault: {
		read: async () => "Body",
		modify: async () => {}
	},
	fileManager: {
		processFrontMatter: async (_file, update) => update(writtenFrontmatter)
	}
};
await bindingWriterPlugin.writeBinding({ path: "note.md" }, {
	token: "created-token",
	url: "https://example.com/wiki/wiki-node"
});
assert.deepEqual(writtenFrontmatter, {
	lark_doc_url: "https://example.com/wiki/wiki-node"
});

const aliasBootstrapPlugin = createPlugin();
const reusableState = {
	doc: "doc-token",
	revisionId: 4,
	contentHash: "previous-hash",
	units: [{
		stableId: "0:paragraph",
		kind: "paragraph",
		hash: "body-hash",
		blockId: "block-1"
	}],
	updatedAt: "2026-08-16T00:00:00.000Z"
};
aliasBootstrapPlugin.syncState = {
	version: 1,
	documents: { "doc-token": reusableState }
};
aliasBootstrapPlugin.fetchLarkDocumentMarkdown = async () => ({
	doc: "doc-token",
	content: "# Note\n\nBody",
	revisionId: 4
});
aliasBootstrapPlugin.fetchLarkDocumentWithIds = async () => ({
	doc: "doc-token",
	content: "<title id=\"doc-token\">Note</title><p id=\"block-1\">Body</p>",
	revisionId: 4
});
let persistedAliasState;
aliasBootstrapPlugin.persistDocumentState = async (state) => {
	persistedAliasState = state;
};
const bootstrappedAliasState = await aliasBootstrapPlugin.tryBootstrapPreciseSyncState(
	"https://example.com/wiki/wiki-node",
	["https://example.com/wiki/wiki-node"],
	"# Note\n\nBody\n\nFEISHU_LARK_LOCAL_IMAGE_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
);
assert.equal(bootstrappedAliasState, reusableState);
assert.equal(persistedAliasState, reusableState);

const timeoutPlugin = createPlugin();
timeoutPlugin.fetchLarkDocumentWithIds = async () => ({
	doc: "doc-token",
	content: "<p id=\"block-1\">Body</p>",
	revisionId: 14
});
const timeoutDiagnostics = [];
timeoutPlugin.logRemoteStateRefreshTimeout = (...args) => {
	timeoutDiagnostics.push(args);
};
timeoutPlugin.sleep = async () => {};
const warnings = [];
console.warn = (...args) => {
	warnings.push(args);
};
let timeoutError;
try {
	await timeoutPlugin.saveRemoteDocumentState("doc-token", [], {
		expectedMarkdown: "Body",
		expectedRevisionId: 15,
		updateSubmitted: true,
		context: { mode: "save", path: "docs/a.md" },
		refreshPolicy: timeoutPlugin.getRemoteStateRefreshPolicy("save")
	});
} catch (error) {
	timeoutError = error;
} finally {
	console.warn = originalWarn;
}
assert.equal(timeoutError?.updateSubmitted, true);
assert.equal(warnings.length, 0);
assert.deepEqual(timeoutDiagnostics, [["doc-token", 8, 15, {
	rejectReason: "revision-lag",
	observedRevisionId: 14
}]]);

const overwritePlugin = createPlugin();
overwritePlugin.fetchLarkDocumentWithIds = async () => ({
	doc: "doc-token",
	content: "<p id=\"block-1\">Body</p>",
	revisionId: 15
});
overwritePlugin.fetchLarkDocumentMarkdown = async () => ({
	doc: "doc-token",
	content: "stale",
	revisionId: 15
});
overwritePlugin.isRemoteMarkdownContentEquivalent = async () => false;
overwritePlugin.sleep = async () => {};
const overwriteDiagnostics = [];
overwritePlugin.logRemoteStateRefreshTimeout = (...args) => {
	overwriteDiagnostics.push(args);
};
let overwriteError;
try {
	await overwritePlugin.saveRemoteDocumentStateFromBaselineAfterExpectedRevision(
		"doc-token",
		[],
		"Body",
		15,
		{ mode: "save", path: "docs/a.md" }
	);
} catch (error) {
	overwriteError = error;
}
assert.equal(overwriteError?.updateSubmitted, true);
assert.deepEqual(overwriteDiagnostics, [["doc-token", 8, 15, {
	rejectReason: "content-not-equivalent",
	observedRevisionId: 15
}]]);

const noticePlugin = createPlugin();
noticePlugin.autoSyncRunningPaths = new Set();
noticePlugin.autoSyncPendingPaths = new Set();
noticePlugin.syncFileInternal = async () => {
	throw timeoutError;
};
globalThis.__obsidianNotices = [];
console.warn = () => {};
try {
	await noticePlugin.runSaveAutoSync({ path: "docs/a.md" });
} finally {
	console.warn = originalWarn;
}
assert.deepEqual(globalThis.__obsidianNotices, [{
	message: "内容已提交，但远端状态确认超时：docs/a.md\n请稍后检查飞书文档。",
	timeout: 10000
}]);
delete globalThis.__obsidianNotices;

const deletedRemotePlugin = createPlugin();
deletedRemotePlugin.autoSyncRunningPaths = new Set();
deletedRemotePlugin.autoSyncPendingPaths = new Set();
deletedRemotePlugin.selfWrittenPaths = new Map();
deletedRemotePlugin.syncStateChangedKeys = new Set();
deletedRemotePlugin.syncStateRemovedKeys = new Set();
deletedRemotePlugin.syncState = {
	version: 1,
	documents: {
		"deleted-token": {
			doc: "deleted-token",
			contentHash: "hash",
			units: [],
			updatedAt: "2026-08-27T00:00:00.000Z"
		}
	}
};
const deletedRemoteBinding = {
	token: "deleted-token",
	url: "https://example.feishu.cn/docx/deleted-token"
};
deletedRemotePlugin.getBinding = () => deletedRemoteBinding;
deletedRemotePlugin.syncFileInternal = async () => {
	throw new Error('{"code":3380003,"message":"Document page has been deleted"}');
};
const deletedRemoteFrontmatter = {
	lark_doc: "legacy",
	lark_doc_url: deletedRemoteBinding.url,
	lark_doc_token: deletedRemoteBinding.token,
	lark_doc_synced_at: "2026-08-27",
	remoteRoot: "root",
	remoteParentPath: "path",
	tags: ["sync"]
};
deletedRemotePlugin.app = {
	vault: {
		getAbstractFileByPath: () => ({ path: "docs/deleted-remote.md" })
	},
	fileManager: {
		processFrontMatter: async (_file, update) => update(deletedRemoteFrontmatter)
	}
};
let deletedRemoteStateSaved = false;
deletedRemotePlugin.saveLarkSyncState = async () => {
	deletedRemoteStateSaved = true;
};
const deletedRemoteWarnings = [];
globalThis.__obsidianNotices = [];
console.warn = (...args) => {
	deletedRemoteWarnings.push(args);
};
try {
	await deletedRemotePlugin.runSaveAutoSync({ path: "docs/deleted-remote.md" });
} finally {
	console.warn = originalWarn;
}
assert.deepEqual(deletedRemoteFrontmatter, { tags: ["sync"] });
assert.equal(deletedRemotePlugin.syncState.documents["deleted-token"], undefined);
assert.equal(deletedRemoteStateSaved, true);
assert.equal(deletedRemoteWarnings.length, 1);
assert.deepEqual(globalThis.__obsidianNotices, [{
	message: "飞书文档远端已删除，已自动解绑：docs/deleted-remote.md\n如需重新发布，请再次执行“同步到飞书”。",
	timeout: 10000
}]);
delete globalThis.__obsidianNotices;

const deletedNotePlugin = createPlugin();
deletedNotePlugin.autoSyncRunningPaths = new Set();
deletedNotePlugin.autoSyncPendingPaths = new Set();
deletedNotePlugin.app = {
	vault: {
		getAbstractFileByPath: () => null
	}
};
deletedNotePlugin.syncFileInternal = async () => {
	const error = new Error("ENOENT: no such file or directory");
	error.code = "ENOENT";
	throw error;
};
const autoSyncErrors = [];
const originalError = console.error;
globalThis.__obsidianNotices = [];
console.error = (...args) => {
	autoSyncErrors.push(args);
};
try {
	await deletedNotePlugin.runSaveAutoSync({ path: "docs/deleted.md" });
} finally {
	console.error = originalError;
}
assert.deepEqual(globalThis.__obsidianNotices, []);
assert.deepEqual(autoSyncErrors, []);
delete globalThis.__obsidianNotices;

deletedNotePlugin.app.vault.getAbstractFileByPath = () => ({ path: "docs/existing.md" });
const existingNoteErrors = [];
globalThis.__obsidianNotices = [];
console.error = (...args) => {
	existingNoteErrors.push(args);
};
try {
	await deletedNotePlugin.runSaveAutoSync({ path: "docs/existing.md" });
} finally {
	console.error = originalError;
}
assert.deepEqual(globalThis.__obsidianNotices, [{
	message: "自动同步失败：docs/existing.md\nENOENT: no such file or directory",
	timeout: 10000
}]);
assert.equal(existingNoteErrors.length, 1);
delete globalThis.__obsidianNotices;

console.log("main plugin tests passed");
