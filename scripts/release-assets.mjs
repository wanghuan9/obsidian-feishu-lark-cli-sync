export const CORE_OBSIDIAN_ASSETS = [
	"main.js",
	"manifest.json",
	"styles.css"
];

export const HELPER_RELEASE_ASSETS = [
	"lark-sync-core.mjs",
	"lark-cli-command.mjs",
	"sync-pre-push.mjs"
];

export const RELEASE_ASSETS = [
	...CORE_OBSIDIAN_ASSETS,
	...HELPER_RELEASE_ASSETS
];
