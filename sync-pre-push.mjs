#!/usr/bin/env node
import { execFile } from "child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { constants } from "fs";
import { basename, dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { promisify } from "util";
import {
	buildCommandEnvironment,
	resolveLarkCliPathFromSetting,
	shouldUseCommandShell,
	withDocsApiVersion
} from "./lark-cli-command.mjs";
import {
	buildSyncPlan,
	buildUpdateCommandArgs,
	createDocumentSyncStateFromRemote,
	createContentHash,
	createEmptySyncStateFile,
	createSyncContentSignature,
	isDocumentStateBlockMappingAcceptable,
	getDocumentStateKey,
	getDocumentStateKeys,
	formatSyncFailureMessage,
	isSyncContentSignatureEquivalent,
	normalizeStateCacheRetainLimit,
	prepareNoteContentForLark,
	readBindingFromMarkdown,
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
const SYSTEM_NOTIFICATION_TITLE = "Feishu Lark CLI Sync";
const SYSTEM_NOTIFICATION_TIMEOUT_MS = 3000;
const MAC_NOTIFICATION_EXECUTABLE_ENV = "FEISHU_LARK_CLI_SYNC_OSASCRIPT_PATH";
const WINDOWS_NOTIFICATION_EXECUTABLE_ENV = "FEISHU_LARK_CLI_SYNC_POWERSHELL_PATH";

let larkCliRequestQueue = Promise.resolve();
let larkCliActiveRequestCount = 0;
let lastLarkCliRequestAt = 0;

async function main() {
	const repoRoot = await git(["rev-parse", "--show-toplevel"]);
	const settings = await readSettings(repoRoot.trim());
	if (settings.autoSyncMode !== "pre-push") {
		return;
	}

	const files = await collectMarkdownFiles();
	if (files.length === 0) {
		return;
	}

	const syncState = await readSyncState(repoRoot.trim());
	const tasks = await collectSyncTasks(repoRoot.trim(), files);
	const failure = await runWithConcurrency(groupTasksByDoc(tasks, syncState), MAX_PARALLEL_SYNCS, async (taskGroup) => {
		for (const task of taskGroup) {
			await syncMarkdownTask(task, settings, syncState);
		}
	});
	await writeSyncState(repoRoot.trim(), syncState, settings);
	if (failure) {
		throw failure;
	}
}

async function collectMarkdownFiles() {
	const refs = await readStdin();
	const fromRefs = await collectFilesFromPushRefs(refs);
	if (fromRefs.length > 0) {
		return uniqueMarkdownFiles(fromRefs);
	}

	const changed = await git(["diff", "--name-only", "HEAD"]);
	return uniqueMarkdownFiles(changed.split(/\r?\n/));
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
			const output = await git(["ls-files", "*.md"]);
			files.push(...output.split(/\r?\n/));
			continue;
		}

		const output = await git(["diff", "--name-only", `${remoteSha}..${localSha}`]);
		files.push(...output.split(/\r?\n/));
	}

	return files;
}

function uniqueMarkdownFiles(files) {
	const seen = new Set();
	const result = [];
	for (const file of files) {
		if (!file.endsWith(".md") || seen.has(file)) {
			continue;
		}

		seen.add(file);
		result.push(file);
	}

	return result;
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
		const contentForLark = prepareNoteContentForLark(file, removeLarkBinding(task.content), settings.titleSource);
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
						refreshedState.revisionId
					);
					return;
				}
			}
		}

		await executeSyncPlanForTask(task, settings, syncState, syncDoc, contentForLark, plan, stateKeys, state?.revisionId);
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
		return command.command === "block_insert_after";
	});
}

function shouldRefreshPreciseSyncState(state) {
	return !state || !isDocumentStateBlockMappingAcceptable(state);
}

async function executeSyncPlanForTask(task, settings, syncState, doc, contentForLark, plan, stateKeys, baseRevisionId) {
	if (plan.mode === "skipped") {
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
			const contentFileName = "content" in command && command.content
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
		if (plan.mode === "precise") {
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

async function executeSkippedSyncPlanForTask(task, settings, syncState, doc, contentForLark, plan, stateKeys) {
	const remoteMarkdown = await fetchLarkDocumentMarkdown(settings, doc);
	const [remoteSignature, expectedSignature] = await Promise.all([
		createSyncContentSignature(remoteMarkdown.content),
		createSyncContentSignature(contentForLark)
	]);
	if (isSyncContentSignatureEquivalent(remoteSignature, expectedSignature)) {
		savePlanState(syncState, stateKeys, plan);
		return;
	}

	const remoteXml = await fetchLarkDocumentWithIds(settings, doc);
	const remoteState = await createRemoteDocumentState(doc, remoteMarkdown, remoteXml);
	const repairPlan = await buildSyncPlan({
		doc: remoteState.doc,
		markdown: contentForLark,
		contentFileName: "sync.md",
		strategy: "precise",
		state: remoteState
	});
	if (repairPlan.mode === "skipped") {
		savePlanState(syncState, stateKeys, repairPlan);
		return;
	}
	if (repairPlan.mode === "precise") {
		await executeSyncPlanForTask(
			task,
			settings,
			syncState,
			remoteState.doc,
			contentForLark,
			repairPlan,
			stateKeys,
			remoteState.revisionId
		);
		return;
	}
	if (repairPlan.mode === "blocked") {
		throw new PrePushSyncError(formatSyncFailureMessage({
			language: readLanguage(settings),
			mode: "pre-push",
			path: task.repoRelativePath,
			reason: repairPlan.reason
		}));
	}

	throw new PrePushSyncError(formatSyncFailureMessage({
		language: readLanguage(settings),
		mode: "pre-push",
		path: task.repoRelativePath,
		reason: "remote-content-mismatch"
	}));
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
	syncState.documents[stateKey] = {
		...touchDocumentSyncState(plan.nextState),
		doc: stateKey
	};
}

function isCompleteNextState(nextState) {
	return Boolean(nextState)
		&& Array.isArray(nextState.units)
		&& nextState.units.length > 0
		&& nextState.units.every((unit) => Boolean(unit.blockId));
}

async function saveRemoteDocumentState(settings, syncState, doc, docs, expectedMarkdown, path, expectedRevisionId) {
	let state;
	for (let attempt = 0; attempt < REMOTE_STATE_REFRESH_ATTEMPTS; attempt += 1) {
		const remoteState = expectedRevisionId !== undefined
			? await fetchRemoteDocumentStateAfterExpectedRevision(settings, doc, expectedRevisionId, expectedMarkdown)
			: await fetchRemoteDocumentState(settings, doc, expectedMarkdown);
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
	syncState.documents[stateKey] = {
		...touchDocumentSyncState(state),
		doc: stateKey
	};
}

async function fetchRemoteDocumentStateAfterExpectedRevision(settings, doc, expectedRevisionId, expectedMarkdown) {
	const remoteXml = await fetchLarkDocumentWithIds(settings, doc);
	if (remoteXml.revisionId === undefined || remoteXml.revisionId < expectedRevisionId) {
		return undefined;
	}

	const remoteMarkdown = expectedMarkdown
		? { doc: remoteXml.doc, content: expectedMarkdown, revisionId: remoteXml.revisionId }
		: await fetchLarkDocumentMarkdown(settings, doc);
	const state = await createRemoteDocumentState(doc, remoteMarkdown, remoteXml);
	return expectedMarkdown && !isDocumentStateBlockMappingAcceptable(state)
		? undefined
		: state;
}

async function fetchRemoteDocumentState(settings, doc, expectedMarkdown) {
	const remoteMarkdownPromise = expectedMarkdown
		? Promise.resolve(undefined)
		: fetchLarkDocumentMarkdown(settings, doc);
	const [remoteMarkdown, remoteXml] = await Promise.all([
		remoteMarkdownPromise,
		fetchLarkDocumentWithIds(settings, doc)
	]);
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
	const remoteMarkdownPromise = expectedMarkdown
		? Promise.resolve(undefined)
		: fetchLarkDocumentMarkdown(settings, doc);
	const [remoteMarkdown, remoteXml] = await Promise.all([
		remoteMarkdownPromise,
		fetchLarkDocumentWithIds(settings, doc)
	]);
	const remoteDoc = remoteXml.doc || remoteMarkdown?.doc || doc;
	const baselineMarkdown = expectedMarkdown || remoteMarkdown?.content || "";
	const state = await createDocumentSyncStateFromRemote(
		remoteDoc,
		baselineMarkdown,
		remoteXml.content,
		remoteXml.revisionId
	);
	if (!isDocumentStateBlockMappingAcceptable(state)) {
		return undefined;
	}

	const stateKey = getDocumentStateKey(remoteDoc);
	syncState.documents[stateKey] = {
		...touchDocumentSyncState(state),
		doc: stateKey
	};

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
	const settingsPath = join(repoRoot, ".obsidian", "plugins", PLUGIN_ID, "data.json");
	try {
		const rawSettings = await readFile(settingsPath, "utf8");
		return JSON.parse(rawSettings);
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
		const nextState = trimSyncStateCache(syncState, {
			retainLimit: normalizeStateCacheRetainLimit(settings.stateCacheRetainLimit, DEFAULT_STATE_CACHE_RETAIN_LIMIT)
		});
		await writeFile(tempPath, JSON.stringify(nextState, null, 2), "utf8");
		await rename(tempPath, statePath);
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
	const { stdout } = await execFileAsync(executable, args, {
		cwd,
		env,
		shell: shouldUseCommandShell(executable),
		maxBuffer: 20 * 1024 * 1024
	});
	const result = JSON.parse(stdout);
	if (!result.ok) {
		throw new Error(formatLarkError(result));
	}
	return result;
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
	if (error instanceof Error && "stderr" in error) {
		const stderr = String(error.stderr || "").trim();
		if (stderr) {
			return stderr.slice(0, MAX_STDERR_LENGTH);
		}
	}

	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
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
	const message = error.message || String(error);
	console.error(message);
	await notifySystemFailure(message);
	process.exit(1);
});
