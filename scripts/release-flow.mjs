#!/usr/bin/env node
import { execFile } from "child_process";
import { access, mkdir, readFile, stat, writeFile } from "fs/promises";
import { constants } from "fs";
import readline from "readline/promises";
import { promisify } from "util";
import { CORE_OBSIDIAN_ASSETS, RELEASE_ASSETS } from "./release-assets.mjs";

const execFileAsync = promisify(execFile);

const VERSION_FILES = [
	"package.json",
	"package-lock.json",
	"manifest.json",
	"versions.json"
];
const RELEASE_NOTES_DIR = "release-notes";
const MANIFEST_REQUIRED_FIELDS = [
	"id",
	"name",
	"version",
	"minAppVersion",
	"description",
	"author"
];
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printUsage();
		return;
	}

	const packageJson = await readJson("package.json");
	const currentVersion = packageJson.version;
	const targetVersion = options.version || bumpVersion(currentVersion, options.bump);
	assertVersion(targetVersion);

	await assertTagDoesNotExist(targetVersion);
	await assertTrackedTreeClean();
	await warnUntrackedFiles();

	const previousTag = await getPreviousTag();
	const releaseNotesPath = `${RELEASE_NOTES_DIR}/${targetVersion}.md`;
	const releaseNotes = await prepareReleaseNotes(releaseNotesPath, targetVersion, previousTag, options.regenerateNotes);

	console.log(`\nRelease notes prepared at ${releaseNotesPath}:\n`);
	console.log(releaseNotes.trimEnd());
	console.log("");

	const prompt = readline.createInterface({
		input: process.stdin,
		output: process.stdout
	});
	try {
		await confirm(prompt, "Review or edit the release notes, then type \"yes\" to continue publishing");
		await validateReleaseNotes(releaseNotesPath);

		await updateVersionFiles(targetVersion);
		await run("npm", ["run", "release:check"]);
		await validateLocalReleasePackage(targetVersion);

		await stageReleaseFiles(releaseNotesPath);
		await run("git", ["commit", "-m", `chore:[${targetVersion}] 发布 ${targetVersion}`]);
		await run("git", ["tag", targetVersion]);

		console.log("\nGitHub release creation with --verify-tag requires the tag to exist on origin.");
		await run("git", ["push", "origin", `refs/tags/${targetVersion}`]);
		await run("npm", ["run", "release:publish"]);
		await assertReleaseFilesUnchanged(releaseNotesPath);
		await validateRemoteReleasePackage(targetVersion);

		await confirm(prompt, "Remote release assets are complete. Type \"yes\" to push the current branch");
		await run("git", ["push", "origin", "HEAD"]);

		console.log(`\nRelease ${targetVersion} completed and branch pushed.`);
	} finally {
		prompt.close();
	}
}

function parseArgs(args) {
	const options = {
		bump: "patch",
		help: false,
		regenerateNotes: false,
		version: ""
	};

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
		} else if (arg === "--version") {
			options.version = readRequiredValue(args, index, arg);
			index += 1;
		} else if (arg === "--patch" || arg === "--minor" || arg === "--major") {
			options.bump = arg.slice(2);
		} else if (arg === "--regenerate-notes") {
			options.regenerateNotes = true;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return options;
}

function readRequiredValue(args, index, name) {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) {
		throw new Error(`${name} requires a value.`);
	}
	return value;
}

function printUsage() {
	console.log(`Usage:
  npm run release:flow
  npm run release:flow -- --version 0.2.0
  npm run release:flow -- --minor

Options:
  --version <version>   Release an explicit semver version.
  --patch              Bump patch from package.json version. Default.
  --minor              Bump minor from package.json version.
  --major              Bump major from package.json version.
  --regenerate-notes   Overwrite existing release notes for the target version.
  --help               Show this help.
`);
}

function bumpVersion(version, bump) {
	const match = SEMVER_PATTERN.exec(version);
	if (!match) {
		throw new Error(`Cannot auto-bump non-standard version: ${version}. Use --version instead.`);
	}

	const major = Number.parseInt(match[1], 10);
	const minor = Number.parseInt(match[2], 10);
	const patch = Number.parseInt(match[3], 10);

	if (bump === "major") {
		return `${major + 1}.0.0`;
	}
	if (bump === "minor") {
		return `${major}.${minor + 1}.0`;
	}
	return `${major}.${minor}.${patch + 1}`;
}

function assertVersion(version) {
	if (!SEMVER_PATTERN.test(version)) {
		throw new Error(`Version must be plain semver, for example 1.2.3. Received: ${version}`);
	}
}

async function assertTagDoesNotExist(version) {
	const result = await runResult("git", ["rev-parse", "--verify", `refs/tags/${version}`], {
		silent: true
	});
	if (result.ok) {
		throw new Error(`Tag ${version} already exists.`);
	}
}

async function assertTrackedTreeClean() {
	const unstaged = await runResult("git", ["diff", "--quiet"], {
		silent: true
	});
	const staged = await runResult("git", ["diff", "--cached", "--quiet"], {
		silent: true
	});
	if (!unstaged.ok || !staged.ok) {
		throw new Error("Tracked working tree changes exist. Commit or stash them before starting a release.");
	}
}

async function warnUntrackedFiles() {
	const { stdout } = await run("git", ["status", "--porcelain"], {
		silent: true
	});
	const untracked = stdout
		.split("\n")
		.filter((line) => line.startsWith("?? "));
	if (untracked.length > 0) {
		console.log("Warning: untracked files will be left untouched:");
		for (const line of untracked) {
			console.log(`  ${line.slice(3)}`);
		}
	}
}

async function getPreviousTag() {
	const result = await runResult("git", ["describe", "--tags", "--abbrev=0"], {
		silent: true
	});
	return result.ok ? result.stdout.trim() : "";
}

async function prepareReleaseNotes(file, version, previousTag, regenerateNotes) {
	await mkdir(RELEASE_NOTES_DIR, {
		recursive: true
	});

	if (!regenerateNotes && await exists(file)) {
		return await readFile(file, "utf8");
	}

	const notes = await generateReleaseNotes(version, previousTag);
	await writeFile(file, notes);
	return notes;
}

async function generateReleaseNotes(version, previousTag) {
	const range = previousTag ? `${previousTag}..HEAD` : "HEAD";
	const result = await run("git", ["log", "--pretty=format:%s", range], {
		silent: true
	});
	const entries = result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => `- ${line}`);
	const body = entries.length > 0 ? entries.join("\n") : "- No code changes since the previous release tag.";

	return `# ${version}

## Changes

${body}
`;
}

async function confirm(prompt, message) {
	const answer = await prompt.question(`${message}\nType yes to continue: `);
	if (answer.trim().toLowerCase() !== "yes") {
		throw new Error("Release flow cancelled.");
	}
}

async function validateReleaseNotes(file) {
	const content = (await readFile(file, "utf8")).trim();
	if (!content) {
		throw new Error(`Release notes cannot be empty: ${file}`);
	}
}

async function updateVersionFiles(version) {
	const packageJson = await readJson("package.json");
	packageJson.version = version;
	await writeJson("package.json", packageJson);

	const packageLock = await readJson("package-lock.json");
	packageLock.version = version;
	if (packageLock.packages?.[""]) {
		packageLock.packages[""].version = version;
	}
	await writeJson("package-lock.json", packageLock);

	const manifest = await readJson("manifest.json");
	manifest.version = version;
	await writeJson("manifest.json", manifest);

	const versions = await readJson("versions.json");
	versions[version] = manifest.minAppVersion;
	await writeJson("versions.json", versions);
}

async function validateLocalReleasePackage(version) {
	const packageJson = await readJson("package.json");
	const manifest = await readJson("manifest.json");
	const versions = await readJson("versions.json");

	validateVersionFiles(version, packageJson, manifest, versions);
	validateManifest(manifest);
	await validateAssetFiles(CORE_OBSIDIAN_ASSETS, "Obsidian core asset");
	await validateAssetFiles(RELEASE_ASSETS, "Release asset");
}

function validateVersionFiles(version, packageJson, manifest, versions) {
	if (packageJson.version !== version) {
		throw new Error(`package.json version ${packageJson.version} does not match ${version}.`);
	}
	if (manifest.version !== version) {
		throw new Error(`manifest.json version ${manifest.version} does not match ${version}.`);
	}
	if (versions[version] !== manifest.minAppVersion) {
		throw new Error(`versions.json is missing ${version}: ${manifest.minAppVersion}.`);
	}
}

function validateManifest(manifest) {
	for (const field of MANIFEST_REQUIRED_FIELDS) {
		if (typeof manifest[field] !== "string" || manifest[field].trim() === "") {
			throw new Error(`manifest.json is missing required field: ${field}`);
		}
	}
	if (typeof manifest.isDesktopOnly !== "boolean") {
		throw new Error("manifest.json field isDesktopOnly must be a boolean.");
	}
}

async function validateAssetFiles(files, label) {
	for (const file of files) {
		const fileStat = await stat(file);
		if (!fileStat.isFile() || fileStat.size === 0) {
			throw new Error(`${label} ${file} must exist and be non-empty.`);
		}
	}
}

async function stageReleaseFiles(releaseNotesPath) {
	await run("git", ["add", "--", ...VERSION_FILES, releaseNotesPath, ...RELEASE_ASSETS]);
}

async function validateRemoteReleasePackage(version) {
	const { stdout } = await run("gh", ["release", "view", version, "--json", "assets"], {
		silent: true
	});
	const release = JSON.parse(stdout);
	const remoteAssetNames = new Set(release.assets.map((asset) => asset.name));

	for (const asset of CORE_OBSIDIAN_ASSETS) {
		if (!remoteAssetNames.has(asset)) {
			throw new Error(`GitHub release ${version} is missing Obsidian core asset: ${asset}`);
		}
	}
	for (const asset of RELEASE_ASSETS) {
		if (!remoteAssetNames.has(asset)) {
			throw new Error(`GitHub release ${version} is missing release asset: ${asset}`);
		}
	}
}

async function assertReleaseFilesUnchanged(releaseNotesPath) {
	const files = [
		...VERSION_FILES,
		releaseNotesPath,
		...RELEASE_ASSETS
	];
	const result = await runResult("git", ["diff", "--quiet", "--", ...files], {
		silent: true
	});
	if (!result.ok) {
		throw new Error("Release files changed after publishing. Review the local diff before pushing the branch.");
	}
}

async function exists(file) {
	try {
		await access(file, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function readJson(file) {
	return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
	await writeFile(file, `${JSON.stringify(value, null, "\t")}\n`);
}

async function run(command, args, options = {}) {
	const result = await runResult(command, args, options);
	if (!result.ok) {
		throw result.error;
	}
	return result;
}

async function runResult(command, args, options = {}) {
	if (!options.silent) {
		console.log(`> ${[command, ...args].join(" ")}`);
	}
	try {
		const result = await execFileAsync(command, args, {
			maxBuffer: 20 * 1024 * 1024
		});
		return {
			ok: true,
			stdout: result.stdout,
			stderr: result.stderr
		};
	} catch (error) {
		return {
			ok: false,
			error,
			stdout: error.stdout || "",
			stderr: error.stderr || ""
		};
	}
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	process.exit(1);
});
