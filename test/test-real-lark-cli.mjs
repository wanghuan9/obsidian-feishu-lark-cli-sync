import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	buildCommandEnvironment,
	resolveLarkCliPathFromSetting,
	shouldUseCommandShell
} from "../lark-cli-command.mjs";

const execFileAsync = promisify(execFile);

async function canExecute(path) {
	try {
		const { access, constants } = await import("node:fs/promises").then(async (fsPromises) => {
			const fs = await import("node:fs");
			return { access: fsPromises.access, constants: fs.constants };
		});
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

const executable = await resolveLarkCliPathFromSetting("lark-cli", {
	env: process.env,
	canExecute,
	pathExists: canExecute,
	isDirectory: async () => false
});
const env = buildCommandEnvironment(executable, { env: process.env });

const { stdout } = await execFileAsync(executable, ["--version"], {
	env,
	shell: shouldUseCommandShell(executable),
	maxBuffer: 1024 * 1024
});

assert.match(stdout, /\d+\.\d+\.\d+/, `Unexpected lark-cli --version output: ${stdout}`);

for (const subcommand of ["+fetch", "+update", "+create"]) {
	const { stdout: helpOutput } = await execFileAsync(executable, ["docs", subcommand, "--api-version", "v2", "--help"], {
		env,
		shell: shouldUseCommandShell(executable),
		maxBuffer: 1024 * 1024
	});
	assert.match(helpOutput, /--api-version string/, `docs ${subcommand} help did not include --api-version`);
	assert.match(helpOutput, /default "v2"/, `docs ${subcommand} help did not advertise v2 as the default`);
}

console.log(`real lark-cli ok: ${executable} -> ${stdout.trim()}; docs fetch/update/create accept --api-version v2`);
