#!/usr/bin/env node
import { execFile } from "child_process";
import { access, readFile, stat } from "fs/promises";
import { constants } from "fs";
import { promisify } from "util";
import { RELEASE_ASSETS } from "./release-assets.mjs";

const execFileAsync = promisify(execFile);

const RELEASE_NOTES_DIR = "release-notes";
const mode = process.argv.includes("--publish") ? "publish" : "check";

async function main() {
	const packageJson = await readJson("package.json");
	const manifest = await readJson("manifest.json");
	const versions = await readJson("versions.json");
	const version = packageJson.version;

	validateVersionFiles(version, manifest, versions);
	await run("npm", ["run", "test"]);
	await run("npm", ["run", "build"]);
	await validateReleaseAssets();

	if (mode === "check") {
		console.log(`Release check passed for ${version}. No GitHub release was created.`);
		return;
	}

	const releaseNotesPath = `${RELEASE_NOTES_DIR}/${version}.md`;
	await validatePublishInputs(version, releaseNotesPath);
	await createRelease(version, releaseNotesPath);
	await validateRemoteReleaseAssets(version);
	console.log(`Release ${version} published with all required assets.`);
}

async function readJson(file) {
	const content = await readFile(file, "utf8");
	return JSON.parse(content);
}

function validateVersionFiles(version, manifest, versions) {
	if (!version) {
		throw new Error("package.json is missing version.");
	}
	if (manifest.version !== version) {
		throw new Error(`manifest.json version ${manifest.version} does not match package.json version ${version}.`);
	}
	if (versions[version] !== manifest.minAppVersion) {
		throw new Error(`versions.json is missing ${version}: ${manifest.minAppVersion}.`);
	}
}

async function validateReleaseAssets() {
	for (const asset of RELEASE_ASSETS) {
		const assetStat = await stat(asset);
		if (!assetStat.isFile() || assetStat.size === 0) {
			throw new Error(`Release asset ${asset} must exist and be non-empty.`);
		}
	}
}

async function validatePublishInputs(version, releaseNotesPath) {
	await assertFileExists(releaseNotesPath, `Release notes file is required: ${releaseNotesPath}`);
	await run("git", ["rev-parse", "--verify", `refs/tags/${version}`]);
	await run("gh", ["auth", "status"]);
}

async function assertFileExists(file, message) {
	try {
		await access(file, constants.R_OK);
	} catch {
		throw new Error(message);
	}
}

async function createRelease(version, releaseNotesPath) {
	const title = `v${version}`;
	const args = [
		"release",
		"create",
		version,
		...RELEASE_ASSETS,
		"--title",
		title,
		"--notes-file",
		releaseNotesPath,
		"--verify-tag"
	];
	await run("gh", args);
}

async function validateRemoteReleaseAssets(version) {
	const { stdout } = await run("gh", ["release", "view", version, "--json", "assets"], {
		silent: true
	});
	const release = JSON.parse(stdout);
	const remoteAssetNames = new Set(release.assets.map((asset) => asset.name));
	const missingAssets = RELEASE_ASSETS.filter((asset) => !remoteAssetNames.has(asset));
	if (missingAssets.length > 0) {
		throw new Error(`GitHub release ${version} is missing assets: ${missingAssets.join(", ")}.`);
	}
}

async function run(command, args, options = {}) {
	if (!options.silent) {
		console.log(`> ${[command, ...args].join(" ")}`);
	}
	return execFileAsync(command, args, {
		maxBuffer: 20 * 1024 * 1024
	});
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	process.exit(1);
});
