import assert from "node:assert/strict";
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
	getDefaultLarkCliCandidates,
	getDefaultPathEntries,
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
assert.equal(stripWrappingQuotes('"C:\\nvm4w\\nodejs\\lark-cli.cmd"'), "C:\\nvm4w\\nodejs\\lark-cli.cmd");
assert.deepEqual(uniquePathEntries(["a", "", "a", "b"]), ["a", "b"]);

const env = {
	NVM_SYMLINK: "C:\\node",
	APPDATA: "",
	LOCALAPPDATA: "",
	PATH: "C:\\Windows"
};
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
	canExecute: async (path) => path === "C:\\node\\lark-cli.cmd",
	pathExists: async () => false,
	isDirectory: async () => false,
	resolveCommandFromLoginShell: async () => ""
});
assert.equal(resolvedDefault, "C:\\node\\lark-cli.cmd");

const commandEnv = buildCommandEnvironment("lark-cli", { env, homeDir: "C:\\Users\\me" });
assert.match(commandEnv.PATH || "", /C:\\node/);
assert.match(commandEnv.PATH || "", /C:\\Windows/);

if (process.platform === "win32") {
	assert.equal(shouldUseCommandShell("C:\\node\\lark-cli.cmd"), true);
	assert.equal(shouldUseCommandShell("C:\\node\\lark-cli.exe"), false);
} else {
	assert.equal(shouldUseCommandShell("/usr/local/bin/lark-cli"), false);
}

console.log("lark cli command tests passed");
