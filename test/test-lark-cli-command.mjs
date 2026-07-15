import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { promisify } from "node:util";
import esbuild from "esbuild";

const execFileAsync = promisify(execFile);

await esbuild.build({
	bundle: true,
	entryPoints: ["src/lark-cli-command.ts"],
	format: "esm",
	outfile: "test/.tmp-lark-cli-command-test.mjs",
	platform: "node",
	target: "node20"
});

const {
	buildCommandEnvironment,
	formatUnsupportedLarkCliVersion,
	getDefaultLarkCliCandidates,
	getDefaultPathEntries,
	isSupportedLarkCliVersion,
	parseLarkCliVersion,
	resolveLarkCliInvocation,
	resolveLarkCliPathFromSetting,
	shouldUseCommandShell,
	stripWrappingQuotes,
	uniquePathEntries,
	withDocsApiVersion
} = await import("./.tmp-lark-cli-command-test.mjs");

assert.deepEqual(withDocsApiVersion(["docs", "+fetch", "--doc", "doc-token"]), [
	"docs",
	"+fetch",
	"--api-version",
	"v2",
	"--doc",
	"doc-token"
]);
assert.deepEqual(withDocsApiVersion(["docs", "+media-download", "--token", "tok"]), [
	"docs",
	"+media-download",
	"--token",
	"tok"
]);
assert.throws(() => withDocsApiVersion(["docs", "+update", "--api-version", "v1"]), /--api-version v2/);
assert.equal(parseLarkCliVersion("lark-cli version 1.0.54"), "1.0.54");
assert.equal(parseLarkCliVersion("1.0.53"), "1.0.53");
assert.equal(isSupportedLarkCliVersion("1.0.53"), false);
assert.equal(isSupportedLarkCliVersion("1.0.54"), true);
assert.equal(isSupportedLarkCliVersion("1.0.55"), true);
assert.equal(formatUnsupportedLarkCliVersion("1.0.53"), "lark-cli 版本过低：1.0.53，请升级到大于 1.0.53 的版本。");
assert.equal(stripWrappingQuotes('"C:\\nvm4w\\nodejs\\lark-cli.cmd"'), "C:\\nvm4w\\nodejs\\lark-cli.cmd");
assert.deepEqual(uniquePathEntries(["a", "", "a", "b"]), ["a", "b"]);

const env = {
	NVM_SYMLINK: "C:\\Program Files\\nodejs",
	APPDATA: "",
	LOCALAPPDATA: "",
	PATH: "C:\\Windows"
};
const windowsLarkCli = win32.join("C:\\Program Files\\nodejs", "lark-cli.cmd");
const candidates = getDefaultLarkCliCandidates(env, "C:\\Users\\me");
assert.equal(candidates[0].replace(/\//g, "\\"), "C:\\Program Files\\nodejs\\lark-cli.cmd");
assert.equal(candidates.includes("npm\\lark-cli.cmd"), false);
assert.equal(candidates.at(-1), "lark-cli");

const pathEntries = getDefaultPathEntries(env, "C:\\Users\\me");
assert.equal(pathEntries.includes("C:\\Program Files\\nodejs"), true);
assert.equal(pathEntries.includes(""), false);

const resolvedDefault = await resolveLarkCliPathFromSetting("lark-cli", {
	env,
	homeDir: "C:\\Users\\me",
	canExecute: async (path) => path === windowsLarkCli,
	pathExists: async () => false,
	isDirectory: async () => false,
	resolveCommandFromLoginShell: async () => ""
});
assert.equal(resolvedDefault, windowsLarkCli);

const npmPackageJson = win32.join("C:\\Program Files\\nodejs", "node_modules", "@larksuite", "cli", "package.json");
const newRunEntry = win32.join("C:\\Program Files\\nodejs", "node_modules", "@larksuite", "cli", "scripts", "new-run.js");
const invocation = await resolveLarkCliInvocation(windowsLarkCli, {
	pathExists: async (path) => path === newRunEntry,
	readTextFile: async (path) => {
		assert.equal(path, npmPackageJson);
		return JSON.stringify({ bin: { "lark-cli": "scripts/new-run.js" } });
	}
}, { platform: "win32", nodeCommand: "node" });
assert.deepEqual(invocation, {
	executable: "node",
	argsPrefix: [newRunEntry]
});

const unixInvocation = await resolveLarkCliInvocation("/usr/local/bin/lark-cli", {
	pathExists: async () => false,
	readTextFile: async () => ""
}, { platform: "linux" });
assert.deepEqual(unixInvocation, {
	executable: "/usr/local/bin/lark-cli",
	argsPrefix: []
});

const commandEnv = buildCommandEnvironment("lark-cli", { env, homeDir: "C:\\Users\\me" });
assert.match(commandEnv.PATH || "", /C:\\Program Files\\nodejs/);
assert.match(commandEnv.PATH || "", /C:\\Windows/);

if (process.platform !== "win32") {
	const nonWindowsEnv = { PATH: "/usr/bin" };
	assert.equal(getDefaultPathEntries(nonWindowsEnv, "/Users/me").some((entry) => entry.startsWith("C:\\")), false);
	assert.equal(getDefaultLarkCliCandidates(nonWindowsEnv, "/Users/me").some((entry) => entry.endsWith(".cmd")), false);
}

if (process.platform === "win32") {
	assert.equal(shouldUseCommandShell("C:\\node\\lark-cli.cmd"), true);
	assert.equal(shouldUseCommandShell("C:\\node\\lark-cli.exe"), false);

	const workspace = await mkdtemp(join(tmpdir(), "lark cli invocation-"));
	try {
		const shimPath = join(workspace, "lark-cli.cmd");
		const packageDirectory = join(workspace, "node_modules", "@larksuite", "cli");
		const entryDirectory = join(packageDirectory, "scripts");
		const entryPath = join(entryDirectory, "new-run.js");
		await mkdir(entryDirectory, { recursive: true });
		await writeFile(shimPath, "@echo off\r\n", "utf8");
		await writeFile(join(packageDirectory, "package.json"), JSON.stringify({
			bin: { "lark-cli": "scripts/new-run.js" }
		}), "utf8");
		await writeFile(entryPath, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n", "utf8");

		const spacedInvocation = await resolveLarkCliInvocation(shimPath, {
			pathExists: async (path) => {
				try {
					await access(path);
					return true;
				} catch {
					return false;
				}
			},
			readTextFile: (path) => readFile(path, "utf8")
		}, { platform: "win32", nodeCommand: process.execPath });
		const { stdout } = await execFileAsync(spacedInvocation.executable, [
			...spacedInvocation.argsPrefix,
			"--name",
			"Folder With Spaces"
		]);
		assert.deepEqual(JSON.parse(stdout), ["--name", "Folder With Spaces"]);
	} finally {
		await rm(workspace, { force: true, recursive: true });
	}
} else {
	assert.equal(shouldUseCommandShell("/usr/local/bin/lark-cli"), false);
}

console.log("lark cli command tests passed");
