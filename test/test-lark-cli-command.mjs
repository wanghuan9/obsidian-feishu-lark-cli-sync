import assert from "node:assert/strict";
import { win32 } from "node:path";
import esbuild from "esbuild";

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
	NVM_SYMLINK: "C:\\node",
	APPDATA: "",
	LOCALAPPDATA: "",
	PATH: "C:\\Windows"
};
const windowsLarkCli = win32.join("C:\\node", "lark-cli.cmd");
const candidates = getDefaultLarkCliCandidates(env, "C:\\Users\\me");
assert.equal(candidates[0].replace(/\//g, "\\"), "C:\\node\\lark-cli.cmd");
assert.equal(candidates.includes("npm\\lark-cli.cmd"), false);
assert.equal(candidates.at(-1), "lark-cli");

const pathEntries = getDefaultPathEntries(env, "C:\\Users\\me");
assert.equal(pathEntries.includes("C:\\node"), true);
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

const commandEnv = buildCommandEnvironment("lark-cli", { env, homeDir: "C:\\Users\\me" });
assert.match(commandEnv.PATH || "", /C:\\node/);
assert.match(commandEnv.PATH || "", /C:\\Windows/);

if (process.platform !== "win32") {
	const nonWindowsEnv = { PATH: "/usr/bin" };
	assert.equal(getDefaultPathEntries(nonWindowsEnv, "/Users/me").some((entry) => entry.startsWith("C:\\")), false);
	assert.equal(getDefaultLarkCliCandidates(nonWindowsEnv, "/Users/me").some((entry) => entry.endsWith(".cmd")), false);
}

if (process.platform === "win32") {
	assert.equal(shouldUseCommandShell("C:\\node\\lark-cli.cmd"), true);
	assert.equal(shouldUseCommandShell("C:\\node\\lark-cli.exe"), false);
} else {
	assert.equal(shouldUseCommandShell("/usr/local/bin/lark-cli"), false);
}

console.log("lark cli command tests passed");
