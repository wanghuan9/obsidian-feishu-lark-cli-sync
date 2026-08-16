#!/usr/bin/env node
import { execFile } from "child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { constants } from "fs";
import { basename, dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { promisify } from "util";
import {
	buildCommandEnvironment,
	formatMissingLarkCli,
	formatUnsupportedLarkCliVersion,
	isSupportedLarkCliVersion,
	parseLarkCliVersion,
	resolveLarkCliInvocation,
	resolveLarkCliPathFromSetting,
	shouldUseCommandShell,
	withDocsApiVersion
} from "./lark-cli-command.mjs";
import {
	buildSyncPlan,
	buildUpdateCommandArgs,
	buildMediaInsertArgs,
	buildMediaMoveArgs,
	buildPlaceholderRemoveArgs,
	containsLocalImagePlaceholders,
	createDocumentSyncStateFromRemote,
	createContentHash,
	createEmptySyncStateFile,
	createSyncContentSignature,
	isDocumentStateBlockMappingAcceptable,
	isRemoteXmlContentEquivalent,
	getDocumentStateKey,
	getDocumentStateKeys,
	formatSyncFailureMessage,
	findReferencingMarkdownFiles,
	invalidateLocalImageSyncState,
	isSyncContentSignatureEquivalent,
	mergeSyncStateFiles,
	materializeLocalImages,
	normalizeStateCacheRetainLimit,
	prepareNoteContentForLark,
	prepareLocalImages,
	prepareOverwriteMarkdownContent,
	readBindingFromMarkdown,
	removeBindingOnlyFrontmatterBeforeNextFrontmatter,
	removeLarkBinding,
	touchDocumentSyncState,
	trimSyncStateCache
} from "./lark-sync-core.mjs";

const execFileAsync = promisify(execFile);

const PLUGIN_ID = "feishu-lark-cli-sync";
const LARK_SYNC_STATE_FILE_NAME = "lark-sync-state.json";
const ZERO_REF = "0000000000000000000000000000000000000000";
const MAX_STDERR_LENGTH = 1600;
const MAX_PARALLEL_SYNCS = 3;
const DEFAULT_STATE_CACHE_RETAIN_LIMIT = 100;
const REMOTE_STATE_REFRESH_ATTEMPTS = readPositiveIntegerEnv(
	"FEISHU_LARK_CLI_SYNC_REMOTE_REFRESH_ATTEMPTS",
	8
);
const REMOTE_STATE_REFRESH_DELAY_MS = readPositiveIntegerEnv(
	"FEISHU_LARK_CLI_SYNC_REMOTE_REFRESH_DELAY_MS",
	1500
);
const LARK_CLI_MAX_CONCURRENT_REQUESTS = 3;
const LARK_CLI_REQUEST_INTERVAL_MS = 350;
const LARK_CLI_RATE_LIMIT_RETRY_DELAYS_MS = [3000, 6000, 12000];
const LARK_CLI_VERSION_ARGS = [["-version"], ["-v"]];
const SYSTEM_NOTIFICATION_TITLE = "Feishu Lark CLI Sync";
const SYSTEM_NOTIFICATION_TIMEOUT_MS = 3000;
const MAC_NOTIFICATION_EXECUTABLE_ENV = "FEISHU_LARK_CLI_SYNC_OSASCRIPT_PATH";
const WINDOWS_NOTIFICATION_EXECUTABLE_ENV = "FEISHU_LARK_CLI_SYNC_POWERSHELL_PATH";

let larkCliRequestQueue = Promise.resolve();
let larkCliActiveRequestCount = 0;
let lastLarkCliRequestAt = 0;
let checkedLarkCliVersionExecutable = "";
let pendingLarkCliVersionExecutable = "";
let pendingLarkCliVersionCheck = null;
let settingsPath = "";
const changedSyncStateKeys = new Set();
const removedSyncStateKeys = new Set();

async function main() {
	const repoRoot = await git(["rev-parse", "--show-toplevel"]);
	const normalizedRepoRoot = repoRoot.trim();
	const settings = await readSettings(normalizedRepoRoot);
	if (settings.autoSyncMode !== "pre-push") {
		return;
	}

	const changedFiles = await collectChangedFiles();
	const files = await collectSyncMarkdownFiles(normalizedRepoRoot, changedFiles);
	if (files.length === 0) {
		return;
	}

	const syncState = await readSyncState(normalizedRepoRoot);
	const tasks = await collectSyncTasks(normalizedRepoRoot, files);
	const failure = await runWithConcurrency(groupTasksByDoc(tasks, syncState), MAX_PARALLEL_SYNCS, async (taskGroup) => {
		for (const task of taskGroup) {
			await syncMarkdownTask(task, settings, syncState);
		}
	});
	await writeSyncState(normalizedRepoRoot, syncState, settings);
	if (failure) {
		throw failure;
	}
}

async function collectChangedFiles() {
	const refs = await readStdin();
	const fromRefs = await collectFilesFromPushRefs(refs);
	if (fromRefs.length > 0) {
		return uniqueFiles(fromRefs);
	}

	const changed = await git(["diff", "--name-only", "HEAD"]);
	return uniqueFiles(changed.split(/\r?\n/));
}

async function collectSyncMarkdownFiles(repoRoot, changedFiles) {
	const markdownFiles = changedFiles.filter((file) => file.endsWith(".md"));
	const imageFiles = changedFiles.filter((file) => isSupportedImageFile(file));
	if (imageFiles.length === 0) {
		return uniqueFiles(markdownFiles);
	}

	const trackedMarkdownOutput = await git(["ls-files", "*.md"]);
	const trackedMarkdownFiles = uniqueFiles(trackedMarkdownOutput.split(/\r?\n/));
	const referencingFiles = await findReferencingMarkdownFiles({
		vaultRoot: repoRoot,
		markdownPaths: trackedMarkdownFiles,
		changedImagePaths: imageFiles
	});
	return uniqueFiles([...markdownFiles, ...referencingFiles]);
}

async function collectFilesFromPushRefs(refs) {
	const files = [];
	const lines = refs.split(/\r?\n/).filter(Boolean);
	for (const line of lines) {
		const [, localSha, , remoteSha] = line.split(/\s+/);
		if (!localSha || localSha === ZERO_REF) {
			continue;
		}

		if (!remoteSha || remoteSha === ZERO_REF) {
			const output = await git(["ls-files"]);
			files.push(...output.split(/\r?\n/));
			continue;
		}

		const output = await git(["diff", "--name-only", `${remoteSha}..${localSha}`]);
		files.push(...output.split(/\r?\n/));
	}

	return files;
}

function uniqueFiles(files) {
	const seen = new Set();
	const result = [];
	for (const file of files) {
		if (!file || seen.has(file)) {
			continue;
		}

		seen.add(file);
		result.push(file);
	}

	return result;
}

function isSupportedImageFile(path) {
	return /\.(?:png|jpe?g|gif|webp|bmp)$/i.test(path);
}

async function collectSyncTasks(repoRoot, files) {
	const tasks = await Promise.all(files.map(async (file) => {
		const filePath = resolve(repoRoot, file);
		const content = await readFile(filePath, "utf8");
		const binding = readBindingFromMarkdown(content);
		if (!binding) {
			return null;
		}

		return {
			vaultRoot: repoRoot,
			filePath,
			repoRelativePath: file,
			content,
			binding,
			doc: binding.token || binding.url,
			stateKeys: getDocumentStateKeys([binding.token, binding.url])
		};
	}));

	return tasks.filter(Boolean);
}

function groupTasksByDoc(tasks, syncState) {
	const taskGroups = new Map();
	for (const task of tasks) {
		const groupKey = resolveDocumentGroupKey(task, syncState);
		const existingTasks = taskGroups.get(groupKey) || [];
		existingTasks.push(task);
		taskGroups.set(groupKey, existingTasks);
	}

	return Array.from(taskGroups.values());
}

function resolveDocumentGroupKey(task, syncState) {
	for (const key of task.stateKeys) {
		const state = syncState.documents[key];
		if (state?.doc) {
			return state.doc;
		}
	}

	return getDocumentStateKey(task.doc);
}

async function syncMarkdownTask(task, settings, syncState) {
	try {
		const file = { basename: basename(task.filePath, ".md") };
		const normalizedContent = removeBindingOnlyFrontmatterBeforeNextFrontmatter(task.content);
		const markdownForLark = prepareNoteContentForLark(file, removeLarkBinding(normalizedContent), settings.titleSource);
		const preparedContent = await prepareLocalImages({
			vaultRoot: task.vaultRoot,
			markdownPath: task.repoRelativePath,
			content: markdownForLark
		});
		const contentForLark = preparedContent.content;
		const strategy = settings.syncStrategy || "auto";
		let state = findDocumentState(syncState, task.stateKeys);
		let syncDoc = state?.doc || task.doc;
		if (strategy !== "overwrite" && shouldRefreshPreciseSyncState(state)) {
			state = await tryBootstrapPreciseSyncState(settings, syncState, syncDoc, task.stateKeys, contentForLark) || state;
			syncDoc = state?.doc || syncDoc;
		}
		const plan = await buildSyncPlan({
			doc: syncDoc,
			markdown: contentForLark,
			contentFileName: "sync.md",
			strategy,
			state
		});
		const stateKeys = task.stateKeys;
		if (strategy !== "overwrite" && shouldRetryPlanWithRefreshedState(plan)) {
			const refreshedState = await tryBootstrapPreciseSyncState(settings, syncState, syncDoc, stateKeys, contentForLark);
			if (refreshedState) {
				const refreshedPlan = await buildSyncPlan({
					doc: refreshedState.doc,
					markdown: contentForLark,
					contentFileName: "sync.md",
					strategy,
					state: refreshedState
				});
				if (refreshedPlan.mode !== "blocked") {
					await executeSyncPlanForTask(
						task,
						settings,
						syncState,
						refreshedState.doc,
						contentForLark,
						refreshedPlan,
						stateKeys,
						refreshedState.revisionId,
						preparedContent.images
					);
					return;
				}
			}
		}

		await executeSyncPlanForTask(
			task,
			settings,
			syncState,
			syncDoc,
			contentForLark,
			plan,
			stateKeys,
			state?.revisionId,
			preparedContent.images
		);
	} catch (error) {
		if (error instanceof PrePushSyncError) {
			throw error;
		}

		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(formatSyncFailureMessage({
			language: readLanguage(settings),
			mode: "pre-push",
			path: task.repoRelativePath,
			reason: "lark-cli-failed",
			detail
		}));
	}
}

function shouldRetryPlanWithRefreshedState(plan) {
	if (plan.mode === "blocked" || plan.mode === "overwrite") {
		return true;
	}

	return plan.mode === "precise" && plan.commands.some((command) => {
		return command.command === "block_insert_after"
			&& !isBlockDeletedByPlan(plan.commands, command.blockId);
	});
}

function isBlockDeletedByPlan(commands, blockId) {
	return commands.some((command) => {
		return command.command === "block_delete"
			&& command.blockId.split(",").includes(blockId);
	});
}

function shouldRefreshPreciseSyncState(state) {
	return !state || !isDocumentStateBlockMappingAcceptable(state);
}

async function executeSyncPlanForTask(
	task,
	settings,
	syncState,
	doc,
	contentForLark,
	plan,
	stateKeys,
	baseRevisionId,
	images
) {
	if (plan.mode === "skipped") {
		if (images.length > 0) {
			const mediaSnapshot = await materializeImagesForTask(settings, doc, images);
			await saveRemoteDocumentState(
				settings,
				syncState,
				doc,
				stateKeys,
				contentForLark,
				task.repoRelativePath,
				mediaSnapshot?.revisionId,
				true
			);
			return;
		}
		await executeSkippedSyncPlanForTask(task, settings, syncState, doc, contentForLark, plan, stateKeys);
		return;
	}

	if (plan.mode === "blocked") {
		throw new PrePushSyncError(formatSyncFailureMessage({
			language: readLanguage(settings),
			mode: "pre-push",
			path: task.repoRelativePath,
			reason: plan.reason
		}));
	}

	await withTempMarkdown(basename(task.filePath, ".md"), contentForLark, async (tempFile) => {
		let latestRevisionId;
		let nextRevisionId = baseRevisionId;
		for (let index = 0; index < plan.commands.length; index += 1) {
			const command = plan.commands[index];
			const contentFileName = command.command === "overwrite"
				? await writeTempMarkdown(tempFile.directory, `sync-${index}`, prepareOverwriteMarkdownContent(contentForLark))
				: "content" in command && command.content
				? await writeTempMarkdown(tempFile.directory, `sync-${index}`, command.content)
				: tempFile.fileName;
			const commandRevisionId = plan.mode === "precise" ? nextRevisionId : undefined;
			const args = buildUpdateCommandArgs(
				"contentFileName" in command
					? { ...command, contentFileName, revisionId: commandRevisionId }
					: { ...command, revisionId: commandRevisionId }
			);
			const result = await runLarkCli(settings, args, tempFile.directory);
			nextRevisionId = result.data?.document?.revision_id;
			latestRevisionId = nextRevisionId ?? latestRevisionId;
		}
		const mediaSnapshot = await materializeImagesForTask(settings, doc, images);
		latestRevisionId = mediaSnapshot?.revisionId ?? latestRevisionId;
		if (plan.mode === "precise") {
			await saveRemoteDocumentState(
				settings,
				syncState,
				doc,
				stateKeys,
				contentForLark,
				task.repoRelativePath,
				latestRevisionId,
				true
			);
		} else if (plan.mode === "overwrite") {
			await saveRemoteDocumentState(
				settings,
				syncState,
				doc,
				stateKeys,
				contentForLark,
				task.repoRelativePath,
				latestRevisionId
			);
		} else {
			savePlanState(syncState, stateKeys, plan);
		}
	});
}

async function materializeImagesForTask(settings, doc, images) {
	return await materializeLocalImages(images, {
		fetchRemoteWithIds: async () => {
			const remote = await fetchLarkDocumentWithIds(settings, doc);
			return { content: remote.content, revisionId: remote.revisionId };
		},
		insertImage: async (image) => {
			const result = await runLarkCli(
				settings,
				buildMediaInsertArgs(doc, image),
				dirname(image.absolutePath)
			);
			const blockId = result.data?.block_id || result.data?.document?.new_blocks?.[0]?.block_id;
			if (!blockId) {
				throw new Error(`图片上传后未返回 block id：${image.vaultPath}`);
			}
			return { blockId };
		},
		moveBlockAfter: async (blockId, targetBlockId) => {
			await runLarkCli(settings, buildMediaMoveArgs(doc, blockId, targetBlockId));
		},
		deleteBlock: async (blockId, revisionId) => {
			const args = buildUpdateCommandArgs({
				doc,
				command: "block_delete",
				blockId,
				revisionId
			});
			await runLarkCli(settings, args);
		},
		removePlaceholder: async (placeholder, revisionId) => {
			const args = buildPlaceholderRemoveArgs(doc, placeholder, revisionId);
			await runLarkCli(settings, args);
		}
	});
}

async function executeSkippedSyncPlanForTask(task, settings, syncState, doc, contentForLark, plan, stateKeys) {
	const remoteMarkdown = await fetchLarkDocumentMarkdown(settings, doc);
	const [remoteSignature, expectedSignature] = await Promise.all([
		createSyncContentSignature(remoteMarkdown.content),
		createSyncContentSignature(contentForLark)
	]);
	if (isSyncContentSignatureEquivalent(remoteSignature, expectedSignature)) {
		const refreshedPlan = remoteMarkdown.revisionId === undefined
			? plan
			: { ...plan, nextState: { ...plan.nextState, revisionId: remoteMarkdown.revisionId } };
		savePlanState(syncState, stateKeys, refreshedPlan);
		return;
	}

	await saveRemoteDocumentState(
		settings,
		syncState,
		doc,
		stateKeys,
		contentForLark,
		task.repoRelativePath,
		remoteMarkdown.revisionId,
		true
	);
}

class PrePushSyncError extends Error {
}

function findDocumentState(syncState, aliases) {
	for (const key of getDocumentStateKeys(aliases)) {
		const state = syncState.documents[key];
		if (state) {
			return state;
		}
	}

	return undefined;
}

function savePlanState(syncState, docs, plan) {
	if (!("nextState" in plan) || !isCompleteNextState(plan.nextState)) {
		return;
	}

	const stateKey = getDocumentStateKey(plan.nextState.doc || docs[0] || "");
	setDocumentSyncState(syncState, stateKey, {
		...touchDocumentSyncState(plan.nextState),
		doc: stateKey
	});
	removeSyncStateKeys(syncState, docs, stateKey);
}

function isCompleteNextState(nextState) {
	return Boolean(nextState)
		&& Array.isArray(nextState.units)
		&& nextState.units.length > 0
		&& nextState.units.every((unit) => Boolean(unit.blockId));
}

async function saveRemoteDocumentState(
	settings,
	syncState,
	doc,
	docs,
	expectedMarkdown,
	path,
	expectedRevisionId,
	allowRemoteChanges = false
) {
	let state;
	for (let attempt = 0; attempt < REMOTE_STATE_REFRESH_ATTEMPTS; attempt += 1) {
		const remoteState = expectedRevisionId !== undefined
			? await fetchRemoteDocumentStateAfterExpectedRevision(
				settings,
				doc,
				expectedRevisionId,
				expectedMarkdown,
				allowRemoteChanges
			)
			: await fetchRemoteDocumentState(settings, doc, expectedMarkdown, allowRemoteChanges);
		if (remoteState && (!expectedMarkdown || isDocumentStateBlockMappingAcceptable(remoteState))) {
			state = remoteState;
			break;
		}

		if (attempt < REMOTE_STATE_REFRESH_ATTEMPTS - 1) {
			await sleep(REMOTE_STATE_REFRESH_DELAY_MS);
		}
	}

	if (!state) {
		throw new PrePushSyncError(formatSyncFailureMessage({
			language: readLanguage(settings),
			mode: "pre-push",
			path,
			reason: "remote-update-not-visible"
		}));
	}

	const stateKey = getDocumentStateKey(state.doc);
	setDocumentSyncState(syncState, stateKey, {
		...touchDocumentSyncState(state),
		doc: stateKey
	});
	removeSyncStateKeys(syncState, docs, stateKey);
}

function removeSyncStateKeys(syncState, docs, keepDoc) {
	const keepKey = getDocumentStateKey(keepDoc);
	for (const key of getDocumentStateKeys(docs)) {
		if (key !== keepKey) {
			deleteDocumentSyncStateKey(syncState, key);
		}
	}
}

function setDocumentSyncState(syncState, stateKey, state) {
	syncState.documents[stateKey] = state;
	changedSyncStateKeys.add(stateKey);
	removedSyncStateKeys.delete(stateKey);
}

function deleteDocumentSyncStateKey(syncState, stateKey) {
	delete syncState.documents[stateKey];
	changedSyncStateKeys.delete(stateKey);
	removedSyncStateKeys.add(stateKey);
}

async function fetchRemoteDocumentStateAfterExpectedRevision(
	settings,
	doc,
	expectedRevisionId,
	expectedMarkdown,
	allowRemoteChanges = false
) {
	const remoteXml = await fetchLarkDocumentWithIds(settings, doc);
	if (remoteXml.revisionId === undefined || remoteXml.revisionId < expectedRevisionId) {
		return undefined;
	}
	if (allowRemoteChanges && expectedMarkdown) {
		const state = await createRemoteDocumentState(
			doc,
			{ doc: remoteXml.doc, content: expectedMarkdown, revisionId: remoteXml.revisionId },
			remoteXml,
			expectedMarkdown
		);
		return isDocumentStateBlockMappingAcceptable(state) ? state : undefined;
	}

	const remoteMarkdown = await fetchLarkDocumentMarkdown(settings, doc);
	if (remoteMarkdown.revisionId !== undefined && remoteMarkdown.revisionId < expectedRevisionId) {
		return undefined;
	}
	if (expectedMarkdown && !await isRemoteContentExpected(remoteMarkdown.content, remoteXml.content, expectedMarkdown)) {
		return undefined;
	}

	const state = await createRemoteDocumentState(doc, remoteMarkdown, remoteXml, expectedMarkdown);
	return expectedMarkdown && !isDocumentStateBlockMappingAcceptable(state)
		? undefined
		: state;
}

async function fetchRemoteDocumentState(settings, doc, expectedMarkdown, allowRemoteChanges = false) {
	if (allowRemoteChanges && expectedMarkdown) {
		const remoteXml = await fetchLarkDocumentWithIds(settings, doc);
		const state = await createRemoteDocumentState(
			doc,
			{ doc: remoteXml.doc, content: expectedMarkdown, revisionId: remoteXml.revisionId },
			remoteXml,
			expectedMarkdown
		);
		return isDocumentStateBlockMappingAcceptable(state) ? state : undefined;
	}

	const [remoteMarkdown, remoteXml] = await Promise.all([
		fetchLarkDocumentMarkdown(settings, doc),
		fetchLarkDocumentWithIds(settings, doc)
	]);
	if (expectedMarkdown && !await isRemoteContentExpected(remoteMarkdown.content, remoteXml.content, expectedMarkdown)) {
		return undefined;
	}

	return await createRemoteDocumentState(doc, remoteMarkdown, remoteXml, expectedMarkdown);
}

async function createRemoteDocumentState(doc, remoteMarkdown, remoteXml, expectedMarkdown) {
	const remoteDoc = remoteXml.doc || remoteMarkdown?.doc || doc;
	const baselineMarkdown = expectedMarkdown || remoteMarkdown?.content || "";
	return await createDocumentSyncStateFromRemote(
		remoteDoc,
		baselineMarkdown,
		remoteXml.content,
		remoteXml.revisionId ?? remoteMarkdown?.revisionId
	);
}

async function isRemoteMarkdownContentExpected(remoteMarkdown, expectedMarkdown) {
	const [remoteSignature, expectedSignature] = await Promise.all([
		createSyncContentSignature(remoteMarkdown),
		createSyncContentSignature(expectedMarkdown)
	]);
	return isSyncContentSignatureEquivalent(remoteSignature, expectedSignature);
}

async function isRemoteContentExpected(remoteMarkdown, remoteXml, expectedMarkdown) {
	if (containsLocalImagePlaceholders(expectedMarkdown)) {
		return await isRemoteXmlContentEquivalent(remoteXml, expectedMarkdown);
	}
	return await isRemoteMarkdownContentExpected(remoteMarkdown, expectedMarkdown);
}

async function sleep(ms) {
	await new Promise((resolvePromise) => {
		setTimeout(resolvePromise, ms);
	});
}

function readPositiveIntegerEnv(name, defaultValue) {
	const rawValue = process.env[name];
	if (!rawValue) {
		return defaultValue;
	}

	const parsedValue = Number.parseInt(rawValue, 10);
	if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
		return defaultValue;
	}

	return parsedValue;
}

async function tryBootstrapPreciseSyncState(settings, syncState, doc, docs, expectedMarkdown) {
	const [remoteMarkdown, remoteXml] = await Promise.all([
		fetchLarkDocumentMarkdown(settings, doc),
		fetchLarkDocumentWithIds(settings, doc)
	]);
	const remoteDoc = remoteXml.doc || remoteMarkdown?.doc || doc;
	const existingState = findDocumentState(syncState, [remoteDoc, doc, ...docs]);
	if (existingState
		&& existingState.revisionId !== undefined
		&& existingState.revisionId === remoteXml.revisionId
		&& isDocumentStateBlockMappingAcceptable(existingState)) {
		return existingState;
	}
	const baselineMarkdown = expectedMarkdown && containsLocalImagePlaceholders(expectedMarkdown)
		? expectedMarkdown
		: remoteMarkdown?.content || expectedMarkdown || "";
	let state = await createDocumentSyncStateFromRemote(
		remoteDoc,
		baselineMarkdown,
		remoteXml.content,
		remoteXml.revisionId
	);
	if (expectedMarkdown && containsLocalImagePlaceholders(expectedMarkdown)) {
		state = invalidateLocalImageSyncState(state);
	}
	if (!isDocumentStateBlockMappingAcceptable(state)) {
		return undefined;
	}

	const stateKey = getDocumentStateKey(remoteDoc);
	setDocumentSyncState(syncState, stateKey, {
		...touchDocumentSyncState(state),
		doc: stateKey
	});

	return state;
}

async function fetchLarkDocumentMarkdown(settings, doc) {
	const result = await runLarkCli(settings, [
		"docs",
		"+fetch",
		"--api-version",
		"v2",
		"--as",
		"user",
		"--doc",
		doc,
		"--doc-format",
		"markdown",
		"--json"
	]);
	return {
		doc: result.data?.document?.document_id,
		content: result.data?.document?.content || "",
		revisionId: result.data?.document?.revision_id
	};
}

async function fetchLarkDocumentWithIds(settings, doc) {
	const result = await runLarkCli(settings, [
		"docs",
		"+fetch",
		"--api-version",
		"v2",
		"--as",
		"user",
		"--doc",
		doc,
		"--detail",
		"with-ids",
		"--json"
	]);
	return {
		doc: result.data?.document?.document_id,
		content: result.data?.document?.content || "",
		revisionId: result.data?.document?.revision_id
	};
}

async function runWithConcurrency(items, limit, worker) {
	const executing = new Set();
	const failures = [];
	for (const item of items) {
		const task = Promise.resolve().then(() => worker(item)).catch((error) => {
			failures.push(error);
		});
		executing.add(task);
		task.finally(() => executing.delete(task));
		if (executing.size >= limit) {
			await Promise.race(executing);
		}
	}

	await Promise.all(executing);
	if (failures.length > 0) {
		return failures[0];
	}

	return null;
}

async function withTempMarkdown(baseName, content, callback) {
	const tempDir = await mkdtemp(join(tmpdir(), "feishu-lark-cli-sync-"));
	const fileName = `${sanitizeFileName(baseName)}.md`;
	const tempPath = join(tempDir, fileName);

	try {
		await writeFile(tempPath, content, "utf8");
		await callback({ directory: tempDir, fileName });
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
}

async function writeTempMarkdown(directory, baseName, content) {
	const fileName = `${sanitizeFileName(baseName)}.md`;
	await writeFile(join(directory, fileName), content, "utf8");
	return fileName;
}

function sanitizeFileName(name) {
	return name.replace(/[\\/:*?"<>|]/g, "-").trim() || "note";
}

async function readSettings(repoRoot) {
	settingsPath = join(repoRoot, ".obsidian", "plugins", PLUGIN_ID, "data.json");
	try {
		const rawSettings = await readFile(settingsPath, "utf8");
		const settings = JSON.parse(rawSettings);
		return isRecord(settings) ? settings : {};
	} catch {
		return {};
	}
}

async function writeLarkCliVersionCheck(versionCheck) {
	if (!settingsPath) {
		return;
	}

	const tempPath = `${settingsPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	await mkdir(dirname(settingsPath), { recursive: true });
	try {
		const latestSettings = await readLatestSettingsForWrite();
		await writeFile(tempPath, JSON.stringify({
			...latestSettings,
			larkCliVersionCheck: versionCheck
		}, null, 2), "utf8");
		await rename(tempPath, settingsPath);
	} catch (error) {
		await rm(tempPath, { force: true });
		throw error;
	}
}

async function readLatestSettingsForWrite() {
	try {
		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		return isRecord(settings) ? settings : {};
	} catch {
		return {};
	}
}

async function readSyncState(repoRoot) {
	const statePath = getSyncStatePath(repoRoot);
	try {
		const rawState = await readFile(statePath, "utf8");
		const state = JSON.parse(rawState);
		if (isValidSyncState(state)) {
			return {
				version: 1,
				documents: state.documents
			};
		}
	} catch {
		return createEmptySyncStateFile();
	}

	return createEmptySyncStateFile();
}

async function writeSyncState(repoRoot, syncState, settings) {
	const statePath = getSyncStatePath(repoRoot);
	const tempPath = `${statePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	await mkdir(dirname(statePath), { recursive: true });
	try {
		const persistedState = await readSyncState(repoRoot);
		const mergedState = mergeSyncStateFiles(persistedState, syncState, {
			changedKeys: changedSyncStateKeys,
			removedKeys: removedSyncStateKeys
		});
		const nextState = trimSyncStateCache(mergedState, {
			retainLimit: normalizeStateCacheRetainLimit(settings.stateCacheRetainLimit, DEFAULT_STATE_CACHE_RETAIN_LIMIT)
		});
		await writeFile(tempPath, JSON.stringify(nextState, null, 2), "utf8");
		await rename(tempPath, statePath);
		changedSyncStateKeys.clear();
		removedSyncStateKeys.clear();
	} catch (error) {
		await rm(tempPath, { force: true });
		throw error;
	}
}

function getSyncStatePath(repoRoot) {
	return join(repoRoot, ".obsidian", "plugins", PLUGIN_ID, LARK_SYNC_STATE_FILE_NAME);
}

function isValidSyncState(state) {
	return Boolean(state)
		&& state.version === 1
		&& state.documents
		&& !Array.isArray(state.documents)
		&& typeof state.documents === "object";
}

async function runLarkCli(settings, args, cwd) {
	return await runLarkCliQueued(settings, withDocsApiVersion(args), cwd);
}

async function runLarkCliQueued(settings, args, cwd) {
	const previousRequest = larkCliRequestQueue;
	let releaseRequestSlot = () => {};
	larkCliRequestQueue = new Promise((resolveRequestSlot) => {
		releaseRequestSlot = resolveRequestSlot;
	});

	await previousRequest;
	try {
		while (larkCliActiveRequestCount >= LARK_CLI_MAX_CONCURRENT_REQUESTS) {
			await sleep(LARK_CLI_REQUEST_INTERVAL_MS);
		}
		await waitForLarkCliStartInterval();
		larkCliActiveRequestCount += 1;
	} finally {
		releaseRequestSlot();
	}

	try {
		return await runLarkCliWithRetry(settings, args, cwd);
	} catch (error) {
		throw new Error(formatCommandError(error));
	} finally {
		larkCliActiveRequestCount = Math.max(0, larkCliActiveRequestCount - 1);
	}
}

async function waitForLarkCliStartInterval() {
	const elapsedMs = Date.now() - lastLarkCliRequestAt;
	if (elapsedMs < LARK_CLI_REQUEST_INTERVAL_MS) {
		await sleep(LARK_CLI_REQUEST_INTERVAL_MS - elapsedMs);
	}
	lastLarkCliRequestAt = Date.now();
}

async function runLarkCliWithRetry(settings, args, cwd) {
	for (let attempt = 0; attempt <= LARK_CLI_RATE_LIMIT_RETRY_DELAYS_MS.length; attempt += 1) {
		try {
			return await runLarkCliOnce(settings, args, cwd);
		} catch (error) {
			if (!isLarkRateLimitError(error) || attempt >= LARK_CLI_RATE_LIMIT_RETRY_DELAYS_MS.length) {
				throw error;
			}

			await sleep(LARK_CLI_RATE_LIMIT_RETRY_DELAYS_MS[attempt]);
		}
	}

	throw new Error("lark-cli request failed.");
}

async function runLarkCliOnce(settings, args, cwd) {
	const executable = await resolveLarkCliPath(settings);
	const env = buildCommandEnvironment(executable);
	await ensureSupportedLarkCliVersion(settings, executable, env);
	const invocation = await resolveInvocation(executable);
	const { stdout } = await execFileAsync(invocation.executable, [...invocation.argsPrefix, ...args], {
		cwd,
		env,
		maxBuffer: 20 * 1024 * 1024
	});
	const result = parseLarkCommandResult(stdout);
	if (!result.ok) {
		throw new Error(formatLarkError(result));
	}
	return result;
}

async function ensureSupportedLarkCliVersion(settings, executable, env) {
	if (checkedLarkCliVersionExecutable === executable) {
		return;
	}

	const cachedCheck = settings.larkCliVersionCheck;
	if (cachedCheck?.executable === executable && isSupportedLarkCliVersion(cachedCheck.version)) {
		checkedLarkCliVersionExecutable = executable;
		return;
	}

	if (pendingLarkCliVersionCheck && pendingLarkCliVersionExecutable === executable) {
		return await pendingLarkCliVersionCheck;
	}

	pendingLarkCliVersionExecutable = executable;
	pendingLarkCliVersionCheck = checkLarkCliVersion(settings, executable, env);
	try {
		await pendingLarkCliVersionCheck;
	} finally {
		pendingLarkCliVersionExecutable = "";
		pendingLarkCliVersionCheck = null;
	}
}

async function checkLarkCliVersion(settings, executable, env) {
	let versionOutput;
	try {
		versionOutput = await readLarkCliVersionOutput(executable, env);
	} catch (error) {
		if (isExecutableLaunchError(error)) {
			throw new Error(formatMissingLarkCli(readLanguage(settings)));
		}
		throw error;
	}

	const version = parseLarkCliVersion(versionOutput);
	if (!isSupportedLarkCliVersion(version)) {
		throw new Error(formatUnsupportedLarkCliVersion(version, readLanguage(settings)));
	}

	const versionCheck = {
		executable,
		version
	};
	settings.larkCliVersionCheck = versionCheck;
	await writeLarkCliVersionCheck(versionCheck);
	checkedLarkCliVersionExecutable = executable;
}

async function readLarkCliVersionOutput(executable, env) {
	let lastError = null;
	let onlyUnsupportedVersionCommands = true;
	const invocation = await resolveInvocation(executable);
	for (const args of LARK_CLI_VERSION_ARGS) {
		try {
			const { stdout, stderr } = await execFileAsync(invocation.executable, [...invocation.argsPrefix, ...args], {
				env,
				maxBuffer: 1024 * 1024
			});
			return `${commandOutputToString(stdout)}\n${commandOutputToString(stderr)}`;
		} catch (error) {
			lastError = error;
			if (!isUnsupportedVersionCommandError(error)) {
				onlyUnsupportedVersionCommands = false;
			}
		}
	}

	if (onlyUnsupportedVersionCommands) {
		return "";
	}
	throw toError(lastError);
}

function isExecutableLaunchError(error) {
	if (!(error instanceof Error) || !("code" in error)) {
		return false;
	}
	return error.code === "ENOENT" || error.code === "EACCES";
}

function isUnsupportedVersionCommandError(error) {
	const message = [
		error instanceof Error ? error.message : String(error),
		hasCommandStderr(error) ? commandOutputToString(error.stderr) : "",
		hasCommandStdout(error) ? commandOutputToString(error.stdout) : ""
	].join("\n").toLowerCase();
	return message.includes("unknown command")
		|| message.includes("unknown flag")
		|| message.includes("unknown shorthand flag")
		|| message.includes("unknown option")
		|| message.includes("unrecognized option");
}

function toError(error) {
	return error instanceof Error ? error : new Error(String(error));
}

function isLarkRateLimitError(error) {
	const message = error instanceof Error ? error.message : String(error);
	const normalizedMessage = message.toLowerCase();
	return normalizedMessage.includes("request trigger frequency limit")
		|| normalizedMessage.includes("frequency limit")
		|| normalizedMessage.includes("rate limit")
		|| normalizedMessage.includes("too many requests");
}

async function resolveLarkCliPath(settings) {
	return await resolveLarkCliPathFromSetting(String(settings.larkCliPath || "").trim(), {
		env: process.env,
		canExecute,
		pathExists,
		isDirectory
	});
}

async function resolveInvocation(executable) {
	return await resolveLarkCliInvocation(executable, {
		pathExists,
		readTextFile: (path) => readFile(path, "utf8")
	});
}

async function canExecute(path) {
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function pathExists(path) {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function isDirectory(path) {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

function formatLarkError(result) {
	const message = result.error?.message || "lark-cli request failed.";
	const hint = result.error?.hint;
	return hint ? `${message}\n${hint}` : message;
}

function formatCommandError(error) {
	if (hasCommandStderr(error)) {
		const stderr = commandOutputToString(error.stderr).trim();
		if (stderr) {
			return stderr.slice(0, MAX_STDERR_LENGTH);
		}
	}

	if (hasCommandStdout(error)) {
		const stdout = commandOutputToString(error.stdout).trim();
		if (stdout) {
			return stdout.slice(0, MAX_STDERR_LENGTH);
		}
	}

	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

function hasCommandStderr(error) {
	return error instanceof Error && "stderr" in error;
}

function hasCommandStdout(error) {
	return error instanceof Error && "stdout" in error;
}

function commandOutputToString(output) {
	if (typeof output === "string") {
		return output;
	}
	if (Buffer.isBuffer(output)) {
		return output.toString("utf8");
	}
	return "";
}

function parseLarkCommandResult(rawJson) {
	const parsed = JSON.parse(rawJson);
	if (!isLarkCommandResult(parsed)) {
		throw new Error("lark-cli returned an invalid JSON response.");
	}

	return parsed;
}

function isLarkCommandResult(value) {
	if (!isRecord(value) || typeof value.ok !== "boolean") {
		return false;
	}

	return (value.data === undefined || isRecord(value.data))
		&& (value.error === undefined || isRecord(value.error));
}

function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readLanguage(settings) {
	return settings.language === "en" ? "en" : "zh-CN";
}

async function notifySystemFailure(message) {
	const command = buildSystemNotificationCommand(message);
	if (!command) {
		return;
	}

	try {
		await execFileAsync(command.executable, command.args, {
			env: buildCommandEnvironment(command.executable),
			shell: shouldUseCommandShell(command.executable),
			timeout: SYSTEM_NOTIFICATION_TIMEOUT_MS,
			windowsHide: true
		});
	} catch {
		// stderr is the reliable hook output; system notifications are best-effort only.
	}
}

function buildSystemNotificationCommand(message) {
	const platform = process.env.FEISHU_LARK_CLI_SYNC_NOTIFY_PLATFORM || process.platform;
	const body = summarizeNotificationBody(message);
	if (platform === "darwin") {
		return {
			executable: process.env[MAC_NOTIFICATION_EXECUTABLE_ENV] || "osascript",
			args: [
				"-e",
				`display notification "${escapeAppleScriptString(body)}" with title "${escapeAppleScriptString(SYSTEM_NOTIFICATION_TITLE)}"`
			]
		};
	}

	if (platform === "win32") {
		return {
			executable: process.env[WINDOWS_NOTIFICATION_EXECUTABLE_ENV] || "powershell.exe",
			args: [
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				buildWindowsNotificationScript(body)
			]
		};
	}

	return null;
}

function summarizeNotificationBody(message) {
	return message.split(/\r?\n/).filter(Boolean).slice(0, 3).join("\n");
}

function escapeAppleScriptString(value) {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildWindowsNotificationScript(body) {
	return [
		"Add-Type -AssemblyName System.Windows.Forms",
		"$notification = New-Object System.Windows.Forms.NotifyIcon",
		"$notification.Icon = [System.Drawing.SystemIcons]::Warning",
		"$notification.Visible = $true",
		`$notification.BalloonTipTitle = ${toPowerShellString(SYSTEM_NOTIFICATION_TITLE)}`,
		`$notification.BalloonTipText = ${toPowerShellString(body)}`,
		"$notification.ShowBalloonTip(10000)",
		"Start-Sleep -Milliseconds 500",
		"$notification.Dispose()"
	].join("; ");
}

function toPowerShellString(value) {
	return `'${value.replace(/'/g, "''")}'`;
}

async function git(args) {
	const { stdout } = await execFileAsync("git", args, {
		env: buildCommandEnvironment("git"),
		maxBuffer: 20 * 1024 * 1024
	});
	return stdout;
}

async function readStdin() {
	return await new Promise((resolvePromise, rejectPromise) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolvePromise(data);
		});
		process.stdin.on("error", rejectPromise);
	});
}

main().catch(async (error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	await notifySystemFailure(message);
	process.exit(1);
});
