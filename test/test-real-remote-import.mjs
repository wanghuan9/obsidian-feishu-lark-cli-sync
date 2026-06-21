import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants, existsSync, readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import esbuild from "esbuild";
import {
	buildCommandEnvironment,
	resolveLarkCliPathFromSetting,
	shouldUseCommandShell
} from "../lark-cli-command.mjs";

const execFileAsync = promisify(execFile);
const PLUGIN_ID = "feishu-lark-cli-sync";
const REMOTE_IMPORT_STATE_FILE_NAME = "remote-import-state.json";
const LARK_SYNC_STATE_FILE_NAME = "lark-sync-state.json";

if (process.env.LARK_REAL_E2E !== "1") {
	console.log("real remote import e2e skipped: set LARK_REAL_E2E=1 to create and modify real Lark documents");
	process.exit(0);
}

const parentFolderToken = requireEnv("LARK_E2E_PARENT_FOLDER_TOKEN");
const pageSize = normalizePageSize(process.env.LARK_E2E_PAGE_SIZE || "2");
const keepRemote = process.env.LARK_E2E_KEEP_REMOTE === "1";
const runId = process.env.LARK_E2E_RUN_ID || `obsidian-import-e2e-${formatTimestamp(new Date())}`;

await esbuild.build({
	bundle: true,
	entryPoints: ["src/remote-import-core.ts"],
	format: "esm",
	outfile: "test/.tmp-real-remote-import-core.mjs",
	platform: "node",
	target: "node20"
});

await esbuild.build({
	bundle: true,
	entryPoints: ["src/lark-sync-core.ts"],
	format: "esm",
	outfile: "test/.tmp-real-remote-import-sync-core.mjs",
	platform: "node",
	target: "node20"
});

const {
	createEmptyRemoteImportStateFile,
	normalizeRemoteImportPage,
	runProgressiveRemoteImport
} = await import("./.tmp-real-remote-import-core.mjs");
const {
	buildSyncPlan,
	buildUpdateCommandArgs,
	createEmptySyncStateFile,
	getDocumentStateKey,
	prepareNoteContentForLark,
	readBindingFromMarkdown,
	removeLarkBinding
} = await import("./.tmp-real-remote-import-sync-core.mjs");

const executable = await resolveExecutable();
const commandEnv = buildCommandEnvironment(executable, { env: process.env });
const vaultDirectory = await mkdtemp(join(tmpdir(), "feishu-lark-remote-import-e2e-"));
const pluginDirectory = join(vaultDirectory, ".obsidian", "plugins", PLUGIN_ID);
const remoteImportStatePath = join(pluginDirectory, REMOTE_IMPORT_STATE_FILE_NAME);
const syncStatePath = join(pluginDirectory, LARK_SYNC_STATE_FILE_NAME);
const createdDocuments = new Map();
let rootFolder;
let completed = false;

try {
	await mkdir(pluginDirectory, { recursive: true });
	await assertLarkCliReady();
	rootFolder = await createFolder(parentFolderToken, runId);
	await createRemoteFixture(rootFolder.token);

	const folderSource = {
		type: "drive-folder",
		folderToken: rootFolder.token,
		localRoot: "Lark",
		remoteRoot: "Lark",
		recursive: true
	};
	const folderRuns = await runImportUntilComplete(folderSource, 10);
	assert.equal(folderRuns.length, Math.ceil(createdDocuments.size / pageSize));
	const importStateAfterFolder = readImportState();
	const folderSession = Object.values(importStateAfterFolder.sessions).find((session) => {
		return session.source.type === "drive-folder";
	});
	assert.equal(folderSession?.completed, true);

	assertImportedFrontmatter("Lark", "01 README");
	assertImportedFrontmatter("Lark", "02 Search");
	assertLocalConflictProtected();
	assertEquivalentLocalFileBound();

	const searchSource = {
		type: "search",
		query: runId,
		folderToken: rootFolder.token,
		localRoot: "SearchImport",
		remoteRoot: "SearchImport"
	};
	await waitForSearchResults(rootFolder.token, runId, createdDocuments.size);
	const searchRuns = await runImportUntilComplete(searchSource, 10);
	assert.equal(searchRuns.length, Math.ceil(createdDocuments.size / pageSize));
	const importState = readImportState();
	const sessionTypes = Object.values(importState.sessions).map((session) => session.source.type).sort();
	assert.deepEqual(sessionTypes, ["drive-folder", "search"]);
	assertImportedFrontmatter("SearchImport", "01 README");

	await assertImportedNoteSyncsBackToSameDoc();
	completed = true;
	console.log(`real remote import e2e passed: ${runId}`);
} finally {
	if (rootFolder && completed && !keepRemote) {
		await deleteDriveFolder(rootFolder.token).catch((error) => {
			console.warn(`failed to delete remote fixture ${rootFolder.token}: ${formatError(error)}`);
		});
	}

	if (rootFolder && (!completed || keepRemote)) {
		console.log(`remote fixture retained: ${rootFolder.url || rootFolder.token}`);
	}

	if (completed) {
		await rm(vaultDirectory, { force: true, recursive: true });
	} else {
		console.log(`local fixture retained: ${vaultDirectory}`);
	}
}

async function createRemoteFixture(folderToken) {
	const specs = [
		["01 README", `# 01 README ${runId}\n\nFolder restore baseline.\n\nKeyword: ${runId}`],
		["02 Search", `# 02 Search ${runId}\n\nSearch pagination baseline.\n\nKeyword: ${runId}`],
		["03 Conflict", `# 03 Conflict ${runId}\n\nRemote conflict body.\n\nKeyword: ${runId}`],
		["04 Same Content", `# 04 Same Content ${runId}\n\nEquivalent local body.\n\nKeyword: ${runId}`],
		["05 Sync Back", `# 05 Sync Back ${runId}\n\nInitial remote sync body.\n\nKeyword: ${runId}`]
	];

	await mkdir(join(vaultDirectory, "Lark"), { recursive: true });
	await writeFile(
		join(vaultDirectory, "Lark", safeTitle("03 Conflict")),
		`# 03 Conflict ${runId}\n\nLocal-only content must survive.\n`,
		"utf8"
	);
	await writeFile(
		join(vaultDirectory, "Lark", safeTitle("04 Same Content")),
		specs[3][1],
		"utf8"
	);

	for (const [name, content] of specs) {
		const title = `${name} ${runId}`;
		const document = await createDocument(folderToken, title, content);
		createdDocuments.set(name, {
			...document,
			title,
			content
		});
	}
}

async function runImportUntilComplete(source, maxRuns) {
	const runs = [];
	for (let index = 0; index < maxRuns; index += 1) {
		const result = await runImportOnce(source);
		runs.push(result);
		if (result.summary.completed) {
			return runs;
		}
	}

	throw new Error(`remote import did not complete after ${maxRuns} runs`);
}

async function runImportOnce(source) {
	const progressState = readJsonIfExists(remoteImportStatePath, createEmptyRemoteImportStateFile());
	const syncState = readJsonIfExists(syncStatePath, createEmptySyncStateFile());
	const result = await runProgressiveRemoteImport({
		source,
		progressState,
		syncState,
		adapter: createDiskLarkAdapter(),
		pageSize
	});
	await writeJson(remoteImportStatePath, progressState);
	await writeJson(syncStatePath, syncState);
	return result;
}

function createDiskLarkAdapter() {
	return {
		searchPage: async (input) => {
			const args = [
				"drive",
				"+search",
				"--as",
				"user",
				"--query",
				input.query,
				"--doc-types",
				"docx,wiki",
				"--page-size",
				String(input.pageSize),
				"--json"
			];
			if (input.folderToken) {
				args.push("--folder-tokens", input.folderToken);
			}
			if (input.pageToken) {
				args.push("--page-token", input.pageToken);
			}
			return normalizeRemoteImportPage(await runLarkCli(args));
		},
		listFolderPage: async (input) => {
			const params = {
				folder_token: input.folderToken,
				page_size: input.pageSize,
				...(input.pageToken ? { page_token: input.pageToken } : {})
			};
			const result = await runLarkCli([
				"drive",
				"files",
				"list",
				"--as",
				"user",
				"--params",
				JSON.stringify(params),
				"--json"
			]);
			return normalizeRemoteImportPage(result);
		},
		fetchDocument: async (doc) => {
			const [markdown, xml] = await Promise.all([
				fetchDocumentMarkdown(doc),
				fetchDocumentWithIds(doc)
			]);
			return {
				doc: xml.doc || markdown.doc || doc,
				url: markdown.url || xml.url,
				markdown: markdown.content,
				xml: xml.content,
				revisionId: xml.revisionId ?? markdown.revisionId
			};
		},
		readLocalFile: async (path) => {
			try {
				return await readFile(join(vaultDirectory, path), "utf8");
			} catch (error) {
				if (error && error.code === "ENOENT") {
					return null;
				}
				throw error;
			}
		},
		writeLocalFile: async (path, content) => {
			const targetPath = join(vaultDirectory, path);
			await mkdir(dirname(targetPath), { recursive: true });
			await writeFile(targetPath, content, "utf8");
		}
	};
}

async function assertImportedNoteSyncsBackToSameDoc() {
	const doc = createdDocuments.get("05 Sync Back");
	const localPath = join(vaultDirectory, "Lark", `${doc.title}.md`);
	const importedContent = await readFile(localPath, "utf8");
	const binding = readBindingFromMarkdown(importedContent);
	assert.equal(binding.token, doc.token);

	const nextContent = `${importedContent.trim()}\n\nLocal edit from ${runId}`;
	await writeFile(localPath, nextContent, "utf8");
	const syncState = readJsonIfExists(syncStatePath, createEmptySyncStateFile());
	const documentState = syncState.documents[getDocumentStateKey(binding.token)];
	assert.ok(documentState, "import should create sync state for the edited document");

	const contentForLark = prepareNoteContentForLark(
		{ basename: doc.title },
		removeLarkBinding(nextContent),
		"file-name"
	);
	const plan = await buildSyncPlan({
		doc: binding.token,
		markdown: contentForLark,
		contentFileName: "sync.md",
		strategy: "auto",
		state: documentState
	});
	assert.notEqual(plan.mode, "blocked");
	assert.notEqual(plan.mode, "skipped");
	await executeSyncPlan(binding.token, contentForLark, plan);

	await waitForRemoteContent(binding.token, `Local edit from ${runId}`);
}

async function executeSyncPlan(doc, contentForLark, plan) {
	await withTempMarkdown("sync.md", contentForLark, async (tempFile) => {
		for (const [index, command] of plan.commands.entries()) {
			const contentFileName = "content" in command && command.content
				? await writeTempMarkdown(tempFile.directory, `sync-${index}.md`, command.content)
				: tempFile.fileName;
			const args = buildUpdateCommandArgs(
				"contentFileName" in command
					? { ...command, doc, contentFileName }
					: { ...command, doc }
			);
			await runLarkCli(args, { cwd: tempFile.directory });
		}
	});
}

function assertImportedFrontmatter(localRoot, docName) {
	const doc = createdDocuments.get(docName);
	const content = readText(join(vaultDirectory, localRoot, `${doc.title}.md`));
	const binding = readBindingFromMarkdown(content);
	assert.equal(binding.token, doc.token);
	assert.equal(binding.url, doc.url);
	assert.match(content, /remoteRoot: /);
	assert.match(content, /remoteParentPath: /);
	const syncState = readJsonIfExists(syncStatePath, createEmptySyncStateFile());
	assert.ok(syncState.documents[getDocumentStateKey(doc.token)]);
}

function assertLocalConflictProtected() {
	const doc = createdDocuments.get("03 Conflict");
	const originalPath = join(vaultDirectory, "Lark", `${doc.title}.md`);
	const originalContent = readText(originalPath);
	assert.equal(originalContent, `# 03 Conflict ${runId}\n\nLocal-only content must survive.\n`);
	const suffixedPath = join(vaultDirectory, "Lark", `${doc.title}-${getDocumentStateKey(doc.token).slice(0, 8)}.md`);
	const importState = readImportState();
	const hasSuffixedImport = fileExistsSync(suffixedPath);
	const hasConflictCount = Object.values(importState.sessions).some((session) => session.conflicts > 0);
	assert.equal(hasSuffixedImport || hasConflictCount, true);
}

function assertEquivalentLocalFileBound() {
	const doc = createdDocuments.get("04 Same Content");
	const content = readText(join(vaultDirectory, "Lark", `${doc.title}.md`));
	const binding = readBindingFromMarkdown(content);
	assert.equal(binding.token, doc.token);
	assert.equal(binding.url, doc.url);
	const syncState = readJsonIfExists(syncStatePath, createEmptySyncStateFile());
	assert.ok(syncState.documents[getDocumentStateKey(doc.token)]);
}

async function waitForSearchResults(folderToken, query, expectedCount) {
	const deadline = Date.now() + 90000;
	while (Date.now() < deadline) {
		const page = await createDiskLarkAdapter().searchPage({
			query,
			folderToken,
			pageSize: 20
		});
		if (page.items.length >= expectedCount) {
			return;
		}
		await sleep(5000);
	}

	throw new Error(`search results for ${query} did not reach ${expectedCount} documents`);
}

async function waitForRemoteContent(doc, expectedText) {
	const deadline = Date.now() + 60000;
	while (Date.now() < deadline) {
		const remote = await fetchDocumentMarkdown(doc);
		if (remote.content.includes(expectedText)) {
			return;
		}
		await sleep(3000);
	}

	throw new Error(`remote document ${doc} did not contain expected text: ${expectedText}`);
}

async function assertLarkCliReady() {
	const { stdout } = await execFileAsync(executable, ["--version"], {
		env: commandEnv,
		shell: shouldUseCommandShell(executable),
		maxBuffer: 1024 * 1024
	});
	assert.match(stdout, /\d+\.\d+\.\d+/, `Unexpected lark-cli --version output: ${stdout}`);
	const result = await runLarkCli(["contact", "+get-user", "--as", "user", "--json"]);
	assert.equal(result.ok, true);
}

async function createFolder(parentToken, name) {
	const args = ["drive", "+create-folder", "--as", "user", "--name", name, "--json"];
	if (parentToken) {
		args.push("--folder-token", parentToken);
	}
	const result = await runLarkCli(args);
	const token = result.data?.folder?.token || result.data?.token;
	const url = result.data?.folder?.url || result.data?.url || "";
	assert.ok(token, "folder create should return a token");
	return {
		token,
		url
	};
}

async function createDocument(parentToken, title, markdown) {
	return await withTempMarkdown(`${title}.md`, markdown, async (tempFile) => {
		const result = await runLarkCli([
			"docs",
			"+create",
			"--api-version",
			"v2",
			"--as",
			"user",
			"--doc-format",
			"markdown",
			"--content",
			`@${tempFile.fileName}`,
			"--parent-token",
			parentToken,
			"--json"
		], { cwd: tempFile.directory });
		const document = result.data?.document || {};
		assert.ok(document.document_id, "docs create should return document_id");
		assert.ok(document.url, "docs create should return url");
		return {
			token: document.document_id,
			url: document.url,
			revisionId: document.revision_id
		};
	});
}

async function fetchDocumentMarkdown(doc) {
	const result = await runLarkCli([
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
	const document = result.data?.document || {};
	return {
		doc: document.document_id,
		url: document.url,
		content: document.content || "",
		revisionId: document.revision_id
	};
}

async function fetchDocumentWithIds(doc) {
	const result = await runLarkCli([
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
	const document = result.data?.document || {};
	return {
		doc: document.document_id,
		url: document.url,
		content: document.content || "",
		revisionId: document.revision_id
	};
}

async function deleteDriveFolder(folderToken) {
	await runLarkCli([
		"drive",
		"+delete",
		"--as",
		"user",
		"--file-token",
		folderToken,
		"--type",
		"folder",
		"--yes",
		"--json"
	]);
}

async function runLarkCli(args, options = {}) {
	const { stdout } = await execFileAsync(executable, args, {
		cwd: options.cwd,
		env: commandEnv,
		shell: shouldUseCommandShell(executable),
		maxBuffer: 20 * 1024 * 1024
	});
	const result = JSON.parse(stdout);
	if (!result.ok) {
		throw new Error(result.error?.message || stdout);
	}
	return result;
}

async function resolveExecutable() {
	return await resolveLarkCliPathFromSetting(process.env.LARK_CLI_PATH || "lark-cli", {
		env: process.env,
		canExecute,
		pathExists,
		isDirectory,
		resolveCommandFromLoginShell: async () => ""
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

async function withTempMarkdown(fileName, content, callback) {
	const directory = await mkdtemp(join(tmpdir(), "feishu-lark-e2e-content-"));
	const safeFileName = fileName.replace(/[\\/:*?"<>|]+/g, "-");
	await writeFile(join(directory, safeFileName), content, "utf8");
	try {
		return await callback({
			directory,
			fileName: safeFileName
		});
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

async function writeTempMarkdown(directory, fileName, content) {
	const safeFileName = fileName.replace(/[\\/:*?"<>|]+/g, "-");
	await writeFile(join(directory, safeFileName), content, "utf8");
	return safeFileName;
}

function readImportState() {
	return readJsonIfExists(remoteImportStatePath, createEmptyRemoteImportStateFile());
}

function readJsonIfExists(path, fallback) {
	try {
		return JSON.parse(readText(path));
	} catch (error) {
		if (error && error.code === "ENOENT") {
			return fallback;
		}
		throw error;
	}
}

async function writeJson(path, value) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

function readText(path) {
	return readFileSync(path, "utf8");
}

function fileExistsSync(path) {
	return existsSync(path);
}

function safeTitle(name) {
	return `${name} ${runId}.md`.replace(/[\\/:*?"<>|#^[\]]+/g, "-");
}

function normalizePageSize(rawValue) {
	const parsed = Number.parseInt(rawValue, 10);
	if (!Number.isFinite(parsed)) {
		return 2;
	}
	return Math.max(1, Math.min(20, parsed));
}

function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		throw new Error(`${name} is required when LARK_REAL_E2E=1`);
	}
	return value;
}

function formatTimestamp(date) {
	const pad = (value) => String(value).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatError(error) {
	return error instanceof Error ? error.message : String(error);
}

async function sleep(ms) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
