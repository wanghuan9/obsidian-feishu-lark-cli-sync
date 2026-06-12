import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { createContentHash } from "./lark-sync-core.mjs";

const execFileAsync = promisify(execFile);

async function run() {
	const workspace = await mkdtemp(join(tmpdir(), "pre-push-test-"));
	try {
		await execFileAsync("git", ["init"], { cwd: workspace });
		await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
		await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: workspace });

		await mkdir(join(workspace, ".obsidian", "plugins", "feishu-lark-cli-sync"), { recursive: true });
		await mkdir(join(workspace, "bin"), { recursive: true });
		await cp("sync-pre-push.mjs", join(workspace, "sync-pre-push.mjs"));
		await cp("lark-sync-core.mjs", join(workspace, "lark-sync-core.mjs"));
		await writeFakeLarkCli(workspace);

		await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Body"));
		await writeFile(join(workspace, "unbound.md"), "Body");
		await execFileAsync("git", ["add", "."], { cwd: workspace });
		await execFileAsync("git", ["commit", "-m", "init"], { cwd: workspace });

		await testPreciseSkip(workspace);
		await testPreciseBootstrapFromRemote(workspace);
		await testPreciseBlockedWhenBootstrapFails(workspace);
		await testOverwriteUpdates(workspace);
		await testUnboundFilesDoNotBlock(workspace);
		await testTokenUrlStateAliases(workspace);
		await testSameDocumentAliasesRunSerially(workspace);
		await testConcurrentFailureWaitsForStartedTasks(workspace);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

async function testPreciseSkip(workspace) {
	await resetWorkspaceFiles(workspace);
	const contentForLark = "# bound\n\nBody";
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "en" });
	await writeSyncState(workspace, "https://example.feishu.cn/docx/doc-token", contentForLark);
	await clearLog(workspace);
	await runHook(workspace);
	const log = await readLog(workspace);
	assert.match(log, /docs \+fetch/);
	assert.doesNotMatch(log, /docs \+update/);
}

async function testPreciseBootstrapFromRemote(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Changed"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "en" });
	await writeSyncStateRaw(workspace, { version: 1, documents: {} });
	await clearLog(workspace);
	await runHook(workspace);
	const log = await readLog(workspace);
	assert.match(log, /docs \+fetch .*--doc-format markdown/);
	assert.match(log, /docs \+fetch .*--detail with-ids/);
	assert.match(log, /docs \+update .*--command block_replace .*--block-id blk-1/);
	const state = await readSyncState(workspace);
	assert.equal(state.documents["https://example.feishu.cn/docx/doc-token"].units.length, 1);
	assert.equal(state.documents["https://example.feishu.cn/docx/doc-token"].units[0].blockId, "blk-1");
}

async function testPreciseBlockedWhenBootstrapFails(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "zh-CN" });
	await writeSyncStateRaw(workspace, { version: 1, documents: {} });
	await clearLog(workspace);
	const result = await runHook(workspace, {
		reject: false,
		env: {
			LARK_CLI_NO_BLOCK_IDS: "1"
		}
	});
	assert.notEqual(result.exitCode, 0);
	assert.match(result.stderr, /pre-push 同步失败：bound\.md/);
	assert.match(result.stderr, /缺少远端 block 映射/);
	assert.match(result.stderr, /已阻止 git push/);
	const log = await readLog(workspace);
	assert.match(log, /docs \+fetch/);
	assert.doesNotMatch(log, /docs \+update/);
}

async function testTokenUrlStateAliases(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Body"));
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "overwrite", language: "en" });
	await writeSyncStateRaw(workspace, { version: 1, documents: {} });
	await clearLog(workspace);
	await runHook(workspace);
	const state = await readSyncState(workspace);
	assert.ok(state.documents["doc-token"]);
	assert.ok(state.documents["https://example.feishu.cn/docx/doc-token"]);
	assert.equal(state.documents["doc-token"].doc, "https://example.feishu.cn/docx/doc-token");
	assert.equal(state.documents["https://example.feishu.cn/docx/doc-token"].doc, "https://example.feishu.cn/docx/doc-token");
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "en" });
	await clearLog(workspace);
	await runHook(workspace);
	const log = await readLog(workspace);
	assert.match(log, /docs \+fetch/);
	assert.doesNotMatch(log, /docs \+update/);
}

async function testSameDocumentAliasesRunSerially(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdownWithToken(
		"doc-token",
		"https://example.feishu.cn/docx/doc-token",
		"Body"
	));
	await writeFile(
		join(workspace, "same-doc.md"),
		boundMarkdown("https://example.feishu.cn/docx/doc-token", "Same doc")
	);
	await execFileAsync("git", ["add", "bound.md", "same-doc.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "overwrite", language: "en" });
	await writeSyncStateRaw(workspace, { version: 1, documents: {} });
	await clearLog(workspace);
	const result = await runHook(workspace, {
		env: {
			LARK_CLI_LOCK_DIR: workspace
		}
	});
	assert.equal(result.exitCode, 0);
	const log = await readLog(workspace);
	assert.equal((log.match(/--doc doc-token/g) || []).length, 2);
}

async function testConcurrentFailureWaitsForStartedTasks(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Body"));
	await writeFile(
		join(workspace, "second.md"),
		boundMarkdown("https://example.feishu.cn/docx/second-token", "Second")
	);
	await execFileAsync("git", ["add", "bound.md", "second.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "overwrite", language: "en" });
	await writeSyncStateRaw(workspace, { version: 1, documents: {} });
	await clearLog(workspace);
	const result = await runHook(workspace, {
		reject: false,
		env: {
			LARK_CLI_FAIL_DOC: "doc-token"
		}
	});
	assert.notEqual(result.exitCode, 0);
	const log = await readLog(workspace);
	assert.match(log, /--doc https:\/\/example\.feishu\.cn\/docx\/doc-token/);
	assert.match(log, /--doc https:\/\/example\.feishu\.cn\/docx\/second-token/);
	const state = await readSyncState(workspace);
	assert.ok(state.documents["https://example.feishu.cn/docx/second-token"]);
}

async function testOverwriteUpdates(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "overwrite", language: "en" });
	await writeSyncStateRaw(workspace, { version: 1, documents: {} });
	await clearLog(workspace);
	await runHook(workspace);
	const log = await readLog(workspace);
	assert.match(log, /docs \+update/);
	assert.match(log, /--command overwrite/);
}

async function testUnboundFilesDoNotBlock(workspace) {
	await resetWorkspaceFiles(workspace);
	await writeFile(join(workspace, "bound.md"), "Body without binding");
	await execFileAsync("git", ["add", "bound.md"], { cwd: workspace });
	await writeSettings(workspace, { autoSyncMode: "pre-push", syncStrategy: "precise", language: "en" });
	await writeSyncStateRaw(workspace, { version: 1, documents: {} });
	await clearLog(workspace);
	await runHook(workspace);
	assert.equal(await readLog(workspace), "");
}

async function resetWorkspaceFiles(workspace) {
	await unlink(join(workspace, "same-doc.md")).catch(() => {});
	await unlink(join(workspace, "second.md")).catch(() => {});
	await writeFile(join(workspace, "bound.md"), boundMarkdown("https://example.feishu.cn/docx/doc-token", "Body"));
	await writeFile(join(workspace, "unbound.md"), "Body");
	await execFileAsync("git", ["add", "--all"], { cwd: workspace });
}

async function runHook(workspace, options = {}) {
	const head = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace });
	const refs = `refs/heads/main ${head.stdout.trim()} refs/heads/main 0000000000000000000000000000000000000000\n`;
	const result = await spawnHook(workspace, refs, options.env || {});
	if (result.exitCode !== 0 && options.reject !== false) {
		throw new Error(result.stderr || `hook exited with ${result.exitCode}`);
	}

	return result;
}

async function spawnHook(workspace, stdin, envOverrides) {
	return await new Promise((resolvePromise) => {
		const child = spawn(process.execPath, ["sync-pre-push.mjs"], {
			cwd: workspace,
			env: {
				...process.env,
				PATH: `${join(workspace, "bin")}:${process.env.PATH || ""}`,
				LARK_CLI_LOG: join(workspace, "lark-cli.log"),
				...envOverrides
			},
			stdio: ["pipe", "pipe", "pipe"]
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("close", (exitCode) => {
			resolvePromise({
				exitCode: exitCode || 0,
				stdout,
				stderr
			});
		});
		child.stdin.end(stdin);
	});
}

async function writeSettings(workspace, settings) {
	await writeFile(
		join(workspace, ".obsidian", "plugins", "feishu-lark-cli-sync", "data.json"),
		JSON.stringify({
			autoSyncMode: "pre-push",
			titleSource: "file-name",
			larkCliPath: join(workspace, "bin", "lark-cli"),
			...settings
		}, null, 2),
		"utf8"
	);
}

async function writeSyncState(workspace, doc, content) {
	const contentHash = await createContentHash(content);
	await writeSyncStateRaw(workspace, {
		version: 1,
		documents: {
			[doc]: {
				doc,
				contentHash,
				units: [],
				updatedAt: "2026-06-12T00:00:00.000Z"
			}
		}
	});
}

async function writeSyncStateRaw(workspace, state) {
	await writeFile(
		join(workspace, ".obsidian", "plugins", "feishu-lark-cli-sync", "lark-sync-state.json"),
		JSON.stringify(state, null, 2),
		"utf8"
	);
}

async function writeFakeLarkCli(workspace) {
	const script = `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.LARK_CLI_LOG, args.join(" ") + "\\n");
const docIndex = args.indexOf("--doc");
const doc = docIndex >= 0 ? args[docIndex + 1] : "";
if (process.env.LARK_CLI_LOCK_DIR && args.includes("+update") && doc.includes("doc-token")) {
  const lockPath = process.env.LARK_CLI_LOCK_DIR + "/doc-token.lock";
  if (fs.existsSync(lockPath)) {
    process.stdout.write(JSON.stringify({ ok: false, error: { message: "same doc ran concurrently" } }));
    process.exit(0);
  }
  fs.writeFileSync(lockPath, String(process.pid));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  fs.unlinkSync(lockPath);
}
if (process.env.LARK_CLI_FAIL_DOC && doc.includes(process.env.LARK_CLI_FAIL_DOC)) {
  process.stdout.write(JSON.stringify({ ok: false, error: { message: "forced failure" } }));
  process.exit(0);
}
if (args.includes("+fetch")) {
  const isWithIds = args.includes("--detail") && args.includes("with-ids");
  const markdown = doc.includes("second-token") ? "# second\\n\\nSecond" : "# bound\\n\\nBody";
  const content = isWithIds && !process.env.LARK_CLI_NO_BLOCK_IDS
    ? "<title id=\\"doc-title\\">bound</title><p id=\\"blk-1\\">Body</p>"
    : markdown;
  process.stdout.write(JSON.stringify({ ok: true, data: { document: { document_id: doc, url: doc, content, revision_id: 4 } } }));
} else {
  process.stdout.write(JSON.stringify({ ok: true, data: { document: { document_id: doc, url: doc } } }));
}
`;
	const path = join(workspace, "bin", "lark-cli");
	await writeFile(path, script, "utf8");
	await chmod(path, 0o755);
}

async function clearLog(workspace) {
	await writeFile(join(workspace, "lark-cli.log"), "", "utf8");
}

async function readLog(workspace) {
	return await readFile(join(workspace, "lark-cli.log"), "utf8");
}

async function readSyncState(workspace) {
	const rawState = await readFile(
		join(workspace, ".obsidian", "plugins", "feishu-lark-cli-sync", "lark-sync-state.json"),
		"utf8"
	);
	return JSON.parse(rawState);
}

function boundMarkdown(url, body) {
	return `---
lark_doc_url: "${url}"
---
${body}`;
}

function boundMarkdownWithToken(token, url, body) {
	return `---
lark_doc_token: "${token}"
lark_doc_url: "${url}"
---
${body}`;
}

await run();
console.log("pre-push tests passed");
