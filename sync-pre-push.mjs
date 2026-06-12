#!/usr/bin/env node
import { execFile } from "child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { constants } from "fs";
import { basename, dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { promisify } from "util";
import {
	buildUpdateDocumentArgs,
	prepareNoteContentForLark,
	readBindingFromMarkdown,
	removeLarkBinding
} from "./lark-sync-core.mjs";

const execFileAsync = promisify(execFile);

const PLUGIN_ID = "feishu-lark-cli-sync";
const ZERO_REF = "0000000000000000000000000000000000000000";
const MAX_STDERR_LENGTH = 1600;
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

	for (const file of files) {
		await syncMarkdownFile(resolve(repoRoot.trim(), file), settings);
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

async function syncMarkdownFile(filePath, settings) {
	const content = await readFile(filePath, "utf8");
	const binding = readBindingFromMarkdown(content);
	if (!binding) {
		return;
	}

	const file = { basename: basename(filePath, ".md") };
	const contentForLark = prepareNoteContentForLark(file, removeLarkBinding(content), settings.titleSource);
	await withTempMarkdown(basename(filePath, ".md"), contentForLark, async (tempFile) => {
		const args = buildUpdateDocumentArgs(binding.token || binding.url, tempFile.fileName);
		await runLarkCli(settings, args, tempFile.directory);
	});
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
	console.error(`[Feishu Lark CLI Sync] pre-push sync failed: ${error.message || String(error)}`);
	process.exit(1);
});
