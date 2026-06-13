#!/usr/bin/env node
import { execFile } from "child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "fs/promises";
import { constants } from "fs";
import { basename, dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { promisify } from "util";
import {
	buildSyncPlan,
	buildUpdateCommandArgs,
	createDocumentSyncStateFromRemote,
	createContentHash,
	createEmptySyncStateFile,
	formatSyncFailureMessage,
	prepareNoteContentForLark,
	readBindingFromMarkdown,
	removeLarkBinding
} from "./lark-sync-core.mjs";

const execFileAsync = promisify(execFile);

const PLUGIN_ID = "feishu-lark-cli-sync";
const LARK_SYNC_STATE_FILE_NAME = "lark-sync-state.json";
const ZERO_REF = "0000000000000000000000000000000000000000";
const MAX_STDERR_LENGTH = 1600;
const MAX_PARALLEL_SYNCS = 4;
const FALLBACK_PATH_ENTRIES = [
	"/opt/homebrew/bin",
	"/opt/homebrew/sbin",
	"/usr/local/bin",
	"/usr/bin",
	"/bin",
	"/usr/sbin",
	"/sbin"
];

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
	await writeSyncState(repoRoot.trim(), syncState);
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
			docAliases: getDocumentAliases(binding)
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
	for (const alias of task.docAliases) {
		const state = syncState.documents[alias];
		if (state?.doc) {
			return state.doc;
		}
	}

	return task.docAliases[0] || task.doc;
}

function getDocumentAliases(binding) {
	const aliases = [binding.token, extractDocTokenFromUrl(binding.url), binding.url];
	return uniquePathEntries(aliases);
}

function extractDocTokenFromUrl(url) {
	if (!url) {
		return "";
	}

	try {
		const parsedUrl = new URL(url);
		const match = parsedUrl.pathname.match(/\/(?:wiki|folder|docx|doc)\/([^/?#]+)/);
		return match?.[1] || "";
	} catch {
		const match = url.match(/\/(?:wiki|folder|docx|doc)\/([^/?#]+)/);
		return match?.[1] || "";
	}
}

async function syncMarkdownTask(task, settings, syncState) {
	try {
		const file = { basename: basename(task.filePath, ".md") };
		const contentForLark = prepareNoteContentForLark(file, removeLarkBinding(task.content), settings.titleSource);
		const strategy = readSyncStrategy(settings);
		let state = findDocumentState(syncState, task.docAliases);
		const syncDoc = state?.doc || task.doc;
		if (strategy === "precise" && (!state || state.units.length === 0)) {
			state = await tryBootstrapPreciseSyncState(settings, syncState, syncDoc, task.docAliases);
		}
		const plan = await buildSyncPlan({
			doc: syncDoc,
			markdown: contentForLark,
			contentFileName: "sync.md",
			strategy,
			state
		});
		const stateKeys = task.docAliases;

		if (plan.mode === "skipped") {
			await ensureRemoteDocumentMatches(settings, syncDoc, plan.contentHash, task.repoRelativePath);
			savePlanState(syncState, stateKeys, plan);
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
			for (let index = 0; index < plan.commands.length; index += 1) {
				const command = plan.commands[index];
				const contentFileName = "content" in command && command.content
					? await writeTempMarkdown(tempFile.directory, `sync-${index}`, command.content)
					: tempFile.fileName;
				const args = buildUpdateCommandArgs(
					"contentFileName" in command
						? { ...command, contentFileName }
						: command
				);
				await runLarkCli(settings, args, tempFile.directory);
			}
		});
		savePlanState(syncState, stateKeys, plan);
		if (plan.mode === "precise" && !plan.nextState) {
			await saveRemoteDocumentState(settings, syncState, syncDoc, stateKeys);
		}
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

class PrePushSyncError extends Error {
}

function findDocumentState(syncState, aliases) {
	for (const alias of aliases) {
		const state = syncState.documents[alias];
		if (state) {
			return state;
		}
	}

	return undefined;
}

function savePlanState(syncState, docs, plan) {
	if (!("nextState" in plan) || !plan.nextState) {
		return;
	}

	for (const doc of uniquePathEntries(docs)) {
		syncState.documents[doc] = plan.nextState;
	}
}

async function saveRemoteDocumentState(settings, syncState, doc, docs) {
	const [remoteMarkdown, remoteXml] = await Promise.all([
		fetchLarkDocumentMarkdown(settings, doc),
		fetchLarkDocumentWithIds(settings, doc)
	]);
	const state = await createDocumentSyncStateFromRemote(doc, remoteMarkdown.content, remoteXml.content, remoteXml.revisionId);
	if (state.units.length === 0) {
		return;
	}

	for (const key of uniquePathEntries([doc, ...docs])) {
		syncState.documents[key] = {
			...state,
			doc: key
		};
	}
}

async function tryBootstrapPreciseSyncState(settings, syncState, doc, docs) {
	const [remoteMarkdown, remoteXml] = await Promise.all([
		fetchLarkDocumentMarkdown(settings, doc),
		fetchLarkDocumentWithIds(settings, doc)
	]);
	const state = await createDocumentSyncStateFromRemote(doc, remoteMarkdown.content, remoteXml.content, remoteXml.revisionId);
	if (state.units.length === 0) {
		return undefined;
	}

	for (const key of uniquePathEntries([doc, ...docs])) {
		syncState.documents[key] = {
			...state,
			doc: key
		};
	}

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
		content: result.data?.document?.content || "",
		revisionId: result.data?.document?.revision_id
	};
}

async function ensureRemoteDocumentMatches(settings, doc, expectedContentHash, repoRelativePath) {
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
	const remoteContent = result.data?.document?.content || "";
	const remoteContentHash = await createContentHash(remoteContent);
	if (remoteContentHash !== expectedContentHash) {
		throw new PrePushSyncError(formatSyncFailureMessage({
			language: readLanguage(settings),
			mode: "pre-push",
			path: repoRelativePath,
			reason: "remote-content-mismatch"
		}));
	}
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

async function writeSyncState(repoRoot, syncState) {
	const statePath = getSyncStatePath(repoRoot);
	const tempPath = `${statePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	await mkdir(dirname(statePath), { recursive: true });
	try {
		await writeFile(tempPath, JSON.stringify(syncState, null, 2), "utf8");
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
	const executable = await resolveLarkCliPath(settings);
	try {
		const env = buildCommandEnvironment(executable);
		const { stdout } = await execFileAsync(executable, args, {
			cwd,
			env,
			maxBuffer: 20 * 1024 * 1024
		});
		const result = JSON.parse(stdout);
		if (!result.ok) {
			throw new Error(formatLarkError(result));
		}
		return result;
	} catch (error) {
		throw new Error(formatCommandError(error));
	}
}

function buildCommandEnvironment(executable) {
	const pathEntries = [...FALLBACK_PATH_ENTRIES];
	if (executable.startsWith("/")) {
		pathEntries.unshift(dirname(executable));
	}

	if (process.env.PATH) {
		pathEntries.push(process.env.PATH);
	}

	return {
		...process.env,
		PATH: uniquePathEntries(pathEntries.join(":").split(":")).join(":")
	};
}

function uniquePathEntries(entries) {
	const seen = new Set();
	const result = [];
	for (const entry of entries) {
		if (!entry || seen.has(entry)) {
			continue;
		}

		seen.add(entry);
		result.push(entry);
	}

	return result;
}

async function resolveLarkCliPath(settings) {
	const configuredPath = String(settings.larkCliPath || "").trim();
	if (configuredPath && configuredPath !== "lark-cli") {
		return configuredPath;
	}

	const candidates = [
		join(process.env.HOME || "", ".npm-global/bin/lark-cli"),
		join(process.env.HOME || "", ".local/bin/lark-cli"),
		join(process.env.HOME || "", "bin/lark-cli"),
		"/opt/homebrew/bin/lark-cli",
		"/usr/local/bin/lark-cli",
		"lark-cli"
	];

	for (const candidate of candidates) {
		if (candidate === "lark-cli" || await canExecute(candidate)) {
			return candidate;
		}
	}

	return "lark-cli";
}

async function canExecute(path) {
	try {
		await access(path, constants.X_OK);
		return true;
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

function readSyncStrategy(settings) {
	return settings.syncStrategy === "overwrite" ? "overwrite" : "precise";
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

main().catch((error) => {
	console.error(error.message || String(error));
	process.exit(1);
});
