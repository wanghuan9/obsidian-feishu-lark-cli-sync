import { delimiter, dirname, join, win32 } from "path";
import { homedir } from "os";
import process from "process";

export const LARK_CLI_COMMAND = "lark-cli";
export const LARK_DOCS_API_VERSION = "v2";
export const MIN_EXCLUSIVE_LARK_CLI_VERSION = "1.0.53";

const WINDOWS_LARK_CLI_SHIMS = [
	"C:\\nvm4w\\nodejs\\lark-cli.cmd",
	"C:\\Program Files\\nodejs\\lark-cli.cmd"
];
const FALLBACK_PATH_ENTRIES = [
	"/opt/homebrew/bin",
	"/opt/homebrew/sbin",
	"/usr/local/bin",
	"/usr/bin",
	"/bin",
	"/usr/sbin",
	"/sbin"
];
const DOCS_V2_SUBCOMMANDS = new Set(["+create", "+fetch", "+update"]);

export interface LarkCliPathHost {
	env?: Record<string, string | undefined>;
	homeDir?: string;
	canExecute(path: string): Promise<boolean>;
	pathExists(path: string): Promise<boolean>;
	isDirectory(path: string): Promise<boolean>;
	resolveCommandFromLoginShell?(command: string): Promise<string>;
}

export interface CommandEnvironmentOptions {
	env?: Record<string, string | undefined>;
	homeDir?: string;
	loginShellPath?: string;
}

export async function resolveLarkCliPathFromSetting(
	configuredPath: string,
	host: LarkCliPathHost
): Promise<string> {
	const env = host.env || process.env;
	const home = host.homeDir || homedir();
	const normalizedConfiguredPath = stripWrappingQuotes(configuredPath).replace(/[\\/]+$/, "");
	if (normalizedConfiguredPath && normalizedConfiguredPath !== LARK_CLI_COMMAND) {
		return await resolveConfiguredLarkCliPath(normalizedConfiguredPath, host);
	}

	const shellPath = await host.resolveCommandFromLoginShell?.(LARK_CLI_COMMAND);
	if (shellPath) {
		return shellPath;
	}

	for (const candidate of getDefaultLarkCliCandidates(env, home)) {
		if (candidate === LARK_CLI_COMMAND || await host.canExecute(candidate)) {
			return candidate;
		}
	}

	return LARK_CLI_COMMAND;
}

export async function resolveConfiguredLarkCliPath(
	configuredPath: string,
	host: LarkCliPathHost
): Promise<string> {
	if (process.platform !== "win32") {
		return configuredPath;
	}

	if (await host.isDirectory(configuredPath)) {
		return await findWindowsLarkCliInDirectory(configuredPath, host) || LARK_CLI_COMMAND;
	}

	if (!/\.(cmd|bat|exe)$/i.test(configuredPath)) {
		const cmdCandidate = `${configuredPath}.cmd`;
		if (await host.pathExists(cmdCandidate)) {
			return cmdCandidate;
		}
	}

	return configuredPath;
}

export async function findWindowsLarkCliInDirectory(
	directory: string,
	host: Pick<LarkCliPathHost, "pathExists">
): Promise<string> {
	const candidates = [
		join(directory, "lark-cli.cmd"),
		join(directory, "lark-cli.exe"),
		join(directory, "lark-cli.bat"),
		join(directory, "npm", "lark-cli.cmd"),
		join(directory, "Roaming", "npm", "lark-cli.cmd"),
		join(directory, "Local", "npm", "lark-cli.cmd"),
		join(directory, "Programs", "nodejs", "lark-cli.cmd")
	];

	for (const candidate of candidates) {
		if (await host.pathExists(candidate)) {
			return candidate;
		}
	}

	return "";
}

export function buildCommandEnvironment(
	executable: string,
	options: CommandEnvironmentOptions = {}
): Record<string, string | undefined> {
	const env = options.env || process.env;
	const pathEntries = getDefaultPathEntries(env, options.homeDir || homedir());
	if (isAbsoluteCommandPath(executable)) {
		pathEntries.unshift(dirname(executable));
	}

	if (options.loginShellPath) {
		pathEntries.unshift(...options.loginShellPath.split(delimiter).filter(Boolean));
	}

	if (env.PATH) {
		pathEntries.push(env.PATH);
	}

	return {
		...env,
		PATH: uniquePathEntries(pathEntries).join(delimiter)
	};
}

export function getDefaultPathEntries(
	env: Record<string, string | undefined> = process.env,
	home = homedir()
): string[] {
	const windowsEntries = isWindowsPathEnvironment(env) ? [
		env.NVM_SYMLINK || "",
		env.APPDATA ? win32.join(env.APPDATA, "npm") : "",
		env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, "npm") : "",
		env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, "Programs", "nodejs") : "",
		"C:\\nvm4w\\nodejs",
		"C:\\Program Files\\nodejs"
	] : [];

	return [
		...windowsEntries,
		join(home, ".npm-global/bin"),
		join(home, ".local/bin"),
		join(home, "bin"),
		...FALLBACK_PATH_ENTRIES
	].filter(Boolean);
}

export function getDefaultLarkCliCandidates(
	env: Record<string, string | undefined> = process.env,
	home = homedir()
): string[] {
	const windowsCandidates = isWindowsPathEnvironment(env) ? [
		env.NVM_SYMLINK ? win32.join(env.NVM_SYMLINK, "lark-cli.cmd") : "",
		env.APPDATA ? win32.join(env.APPDATA, "npm", "lark-cli.cmd") : "",
		env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, "npm", "lark-cli.cmd") : "",
		env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, "Programs", "nodejs", "lark-cli.cmd") : "",
		...WINDOWS_LARK_CLI_SHIMS
	] : [];

	return [
		...windowsCandidates,
		join(home, ".npm-global/bin/lark-cli"),
		join(home, ".local/bin/lark-cli"),
		join(home, "bin/lark-cli"),
		"/opt/homebrew/bin/lark-cli",
		"/usr/local/bin/lark-cli",
		LARK_CLI_COMMAND
	].filter(Boolean);
}

export function withDocsApiVersion(args: string[]): string[] {
	if (args[0] !== "docs" || !DOCS_V2_SUBCOMMANDS.has(args[1] || "")) {
		return args;
	}

	const apiVersionIndex = args.indexOf("--api-version");
	if (apiVersionIndex >= 0) {
		if (args[apiVersionIndex + 1] !== LARK_DOCS_API_VERSION) {
			throw new Error(`docs commands must use --api-version ${LARK_DOCS_API_VERSION}.`);
		}
		return args;
	}

	const insertIndex = args.length > 1 ? 2 : 1;
	return [
		...args.slice(0, insertIndex),
		"--api-version",
		LARK_DOCS_API_VERSION,
		...args.slice(insertIndex)
	];
}

export function parseLarkCliVersion(output: string): string {
	return output.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] || "";
}

export function isSupportedLarkCliVersion(version: string): boolean {
	return compareSemverCore(version, MIN_EXCLUSIVE_LARK_CLI_VERSION) > 0;
}

export function formatUnsupportedLarkCliVersion(
	version: string,
	language: "zh-CN" | "en" = "zh-CN"
): string {
	if (language === "en") {
		return version
			? `lark-cli ${version} is too old. Please upgrade to a version greater than ${MIN_EXCLUSIVE_LARK_CLI_VERSION}.`
			: `lark-cli is too old. Please upgrade to a version greater than ${MIN_EXCLUSIVE_LARK_CLI_VERSION}.`;
	}

	return version
		? `lark-cli 版本过低：${version}，请升级到大于 ${MIN_EXCLUSIVE_LARK_CLI_VERSION} 的版本。`
		: `lark-cli 版本过低，请升级到大于 ${MIN_EXCLUSIVE_LARK_CLI_VERSION} 的版本。`;
}

export function shouldUseCommandShell(executable: string): boolean {
	return process.platform === "win32" && /\.(cmd|bat)$/i.test(executable);
}

export function stripWrappingQuotes(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith("\"") && trimmed.endsWith("\""))
		|| (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

export function uniquePathEntries(entries: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const entry of entries) {
		if (!entry || seen.has(entry)) {
			continue;
		}

		seen.add(entry);
		result.push(entry);
	}

	return result;
}

function isAbsoluteCommandPath(path: string): boolean {
	return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function isWindowsPathEnvironment(env: Record<string, string | undefined>): boolean {
	return process.platform === "win32"
		|| Boolean(env.NVM_SYMLINK || env.APPDATA || env.LOCALAPPDATA);
}

function compareSemverCore(left: string, right: string): number {
	const leftParts = parseSemverCore(left);
	const rightParts = parseSemverCore(right);
	if (!leftParts || !rightParts) {
		return -1;
	}

	for (let index = 0; index < 3; index += 1) {
		const leftPart = leftParts[index] ?? 0;
		const rightPart = rightParts[index] ?? 0;
		const difference = leftPart - rightPart;
		if (difference !== 0) {
			return difference;
		}
	}

	return 0;
}

function parseSemverCore(version: string): [number, number, number] | null {
	const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!match) {
		return null;
	}

	const major = Number.parseInt(match[1] || "", 10);
	const minor = Number.parseInt(match[2] || "", 10);
	const patch = Number.parseInt(match[3] || "", 10);
	if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
		return null;
	}

	return [
		major,
		minor,
		patch
	];
}
