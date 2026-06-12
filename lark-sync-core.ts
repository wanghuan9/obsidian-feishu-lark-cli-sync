export type TitleSource = "first-heading" | "file-name";
export type SyncStrategy = "precise" | "overwrite";
export type MessageLanguage = "zh-CN" | "en";
export type SyncMode = "manual" | "save" | "pre-push" | "folder";
export type SyncFailureReason =
	| "remote-revision-changed"
	| "remote-content-mismatch"
	| "block-mapping-missing"
	| "block-id-invalid"
	| "diff-too-complex"
	| "lark-cli-failed";
export type SyncPlanMode = "skipped" | "precise" | "overwrite" | "blocked";

export interface NoteFile {
	basename: string;
}

export interface LarkDocumentBinding {
	token: string;
	url: string;
}

export interface LarkSyncStateFile {
	version: 1;
	documents: Record<string, DocumentSyncState>;
}

export interface DocumentSyncState {
	doc: string;
	revisionId?: number;
	contentHash: string;
	units: SyncUnitState[];
	updatedAt: string;
}

export interface SyncUnitState {
	stableId: string;
	kind: string;
	hash: string;
	blockId: string;
}

export type LarkUpdateCommand =
	| LarkOverwriteCommand
	| LarkBlockReplaceCommand
	| LarkBlockInsertAfterCommand
	| LarkBlockDeleteCommand;

export interface LarkOverwriteCommand {
	doc: string;
	command: "overwrite";
	docFormat: "markdown" | "xml";
	contentFileName: string;
}

export interface LarkBlockReplaceCommand {
	doc: string;
	command: "block_replace";
	docFormat: "markdown" | "xml";
	blockId: string;
	contentFileName: string;
}

export interface LarkBlockInsertAfterCommand {
	doc: string;
	command: "block_insert_after";
	docFormat: "markdown" | "xml";
	blockId: string;
	contentFileName: string;
}

export interface LarkBlockDeleteCommand {
	doc: string;
	command: "block_delete";
	blockId: string;
}

export type SyncPlan =
	| SkippedSyncPlan
	| PreciseSyncPlan
	| OverwriteSyncPlan
	| BlockedSyncPlan;

export interface SkippedSyncPlan {
	mode: "skipped";
	commands: [];
	contentHash: string;
	nextState: DocumentSyncState;
}

export interface PreciseSyncPlan {
	mode: "precise";
	commands: LarkUpdateCommand[];
	contentHash: string;
	nextState?: DocumentSyncState;
}

export interface OverwriteSyncPlan {
	mode: "overwrite";
	commands: [LarkOverwriteCommand];
	contentHash: string;
	nextState: DocumentSyncState;
}

export interface BlockedSyncPlan {
	mode: "blocked";
	commands: [];
	contentHash: string;
	reason: SyncFailureReason;
}

export interface BuildSyncPlanInput {
	doc: string;
	markdown: string;
	contentFileName: string;
	strategy: SyncStrategy;
	state?: DocumentSyncState;
}

export interface FormatSyncFailureInput {
	language: MessageLanguage;
	mode: SyncMode;
	path: string;
	reason: SyncFailureReason;
	detail?: string;
}

export const FRONTMATTER_URL_KEY = "lark_doc_url";
export const FRONTMATTER_TOKEN_KEY = "lark_doc_token";
export const LEGACY_FRONTMATTER_SYNCED_AT_KEY = "lark_doc_synced_at";
export const FRONTMATTER_REMOTE_ROOT_KEY = "remoteRoot";
export const FRONTMATTER_REMOTE_PARENT_PATH_KEY = "remoteParentPath";
export const FRONTMATTER_BINDING_KEYS = [
	"lark_doc",
	FRONTMATTER_URL_KEY,
	FRONTMATTER_TOKEN_KEY,
	LEGACY_FRONTMATTER_SYNCED_AT_KEY,
	FRONTMATTER_REMOTE_ROOT_KEY,
	FRONTMATTER_REMOTE_PARENT_PATH_KEY
];

export function prepareNoteContentForLark(file: NoteFile, content: string, titleSource: TitleSource): string {
	const title = extractTitle(file, content, titleSource);
	if (titleSource === "file-name") {
		return withMarkdownTitle(content, title);
	}

	if (/^\s*#\s+/m.test(content)) {
		return content;
	}

	return withMarkdownTitle(content, title);
}

export function extractTitle(file: NoteFile, content: string, titleSource: TitleSource): string {
	if (titleSource === "file-name") {
		return file.basename;
	}

	const heading = content.match(/^[ \t]*#[ \t]+(.+?)[ \t#]*$/m);
	return heading?.[1]?.trim() || file.basename;
}

export function readBindingFromMarkdown(content: string): LarkDocumentBinding | null {
	const frontmatter = readFrontmatter(content);
	if (!frontmatter) {
		return null;
	}

	const token = readYamlString(frontmatter, FRONTMATTER_TOKEN_KEY);
	const url = readYamlString(frontmatter, FRONTMATTER_URL_KEY);
	if (!token && !url) {
		return null;
	}

	return { token, url };
}

export function removeLarkBinding(content: string): string {
	if (!content.startsWith("---")) {
		return content;
	}

	const endMatch = content.slice(3).match(/\n---\r?\n/);
	if (!endMatch || endMatch.index === undefined) {
		return content;
	}

	const frontmatterStart = 3;
	const frontmatterEnd = frontmatterStart + endMatch.index;
	const frontmatter = content.slice(frontmatterStart, frontmatterEnd);
	const body = content.slice(frontmatterEnd + endMatch[0].length);
	const filteredLines = removeYamlObjects(frontmatter.split(/\r?\n/), FRONTMATTER_BINDING_KEYS);
	if (filteredLines.every((line) => line.trim() === "")) {
		return body.replace(/^\s+/, "");
	}

	return `---\n${filteredLines.join("\n").trim()}\n---\n${body}`;
}

export function buildUpdateDocumentArgs(doc: string, fileName: string): string[] {
	return buildUpdateCommandArgs({
		doc,
		command: "overwrite",
		docFormat: "markdown",
		contentFileName: fileName
	});
}

export function buildUpdateCommandArgs(command: LarkUpdateCommand): string[] {
	const args = [
		"docs",
		"+update",
		"--api-version",
		"v2",
		"--as",
		"user",
		"--doc",
		command.doc,
		"--command",
		command.command
	];

	switch (command.command) {
		case "overwrite":
			args.push("--doc-format", command.docFormat, "--content", `@${command.contentFileName}`);
			break;
		case "block_replace":
		case "block_insert_after":
			args.push(
				"--doc-format",
				command.docFormat,
				"--block-id",
				command.blockId,
				"--content",
				`@${command.contentFileName}`
			);
			break;
		case "block_delete":
			args.push("--block-id", command.blockId);
			break;
	}

	args.push("--json");
	return args;
}

export async function buildSyncPlan(input: BuildSyncPlanInput): Promise<SyncPlan> {
	const contentHash = await createContentHash(input.markdown);
	if (input.strategy === "overwrite") {
		return {
			mode: "overwrite",
			commands: [
				{
					doc: input.doc,
					command: "overwrite",
					docFormat: "markdown",
					contentFileName: input.contentFileName
				}
			],
			contentHash,
			nextState: createDocumentSyncState(input.doc, contentHash)
		};
	}

	if (input.state && input.state.doc !== input.doc) {
		return {
			mode: "blocked",
			commands: [],
			contentHash,
			reason: "block-mapping-missing"
		};
	}

	if (input.state?.contentHash === contentHash) {
		return {
			mode: "skipped",
			commands: [],
			contentHash,
			nextState: input.state
		};
	}

	if (!input.state || input.state.units.length === 0) {
		return {
			mode: "blocked",
			commands: [],
			contentHash,
			reason: "block-mapping-missing"
		};
	}

	return {
		mode: "blocked",
		commands: [],
		contentHash,
		reason: "diff-too-complex"
	};
}

export function createEmptySyncStateFile(): LarkSyncStateFile {
	return {
		version: 1,
		documents: {}
	};
}

export function createDocumentSyncState(doc: string, contentHash: string): DocumentSyncState {
	return {
		doc,
		contentHash,
		units: [],
		updatedAt: new Date().toISOString()
	};
}

export async function createContentHash(content: string): Promise<string> {
	const bytes = new TextEncoder().encode(content);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function formatSyncFailureMessage(input: FormatSyncFailureInput): string {
	const language = input.language === "en" ? "en" : "zh-CN";
	const reason = SYNC_FAILURE_REASON_MESSAGES[language][input.reason];
	const detail = input.detail ? `\n${input.detail}` : "";
	if (language === "en") {
		return formatEnglishSyncFailure(input, reason, detail);
	}

	return formatChineseSyncFailure(input, reason, detail);
}

function formatEnglishSyncFailure(input: FormatSyncFailureInput, reason: string, detail: string): string {
	if (input.mode === "pre-push") {
		return `[Feishu Lark CLI Sync] pre-push sync failed: ${input.path}\nReason: ${reason}.${detail}\nPush was blocked to avoid overwriting remote document history.`;
	}

	if (input.mode === "save") {
		return `Auto sync failed: ${input.path}\nReason: ${reason}.${detail}`;
	}

	if (input.mode === "folder") {
		return `Folder sync failed: ${input.path}\nReason: ${reason}.${detail}`;
	}

	return `Feishu/Lark sync failed: ${input.path}\nReason: ${reason}.${detail}`;
}

function formatChineseSyncFailure(input: FormatSyncFailureInput, reason: string, detail: string): string {
	if (input.mode === "pre-push") {
		return `[Feishu Lark CLI Sync] pre-push 同步失败：${input.path}\n原因：${reason}。${detail}\n已阻止 git push，以避免覆盖飞书文档修改历史。`;
	}

	if (input.mode === "save") {
		return `自动同步失败：${input.path}\n原因：${reason}。${detail}`;
	}

	if (input.mode === "folder") {
		return `目录同步失败：${input.path}\n原因：${reason}。${detail}`;
	}

	return `飞书同步失败：${input.path}\n原因：${reason}。${detail}`;
}

const SYNC_FAILURE_REASON_MESSAGES: Record<MessageLanguage, Record<SyncFailureReason, string>> = {
	"zh-CN": {
		"remote-revision-changed": "远端文档版本已变化，已停止安全增量同步",
		"remote-content-mismatch": "远端文档内容与本地基线不一致，无法安全建立增量同步状态",
		"block-mapping-missing": "缺少远端 block 映射，无法安全增量同步",
		"block-id-invalid": "远端 block id 已失效，无法安全增量同步",
		"diff-too-complex": "本次变更过于复杂，无法安全增量同步",
		"lark-cli-failed": "lark-cli 执行失败"
	},
	en: {
		"remote-revision-changed": "remote document revision changed; precise sync aborted",
		"remote-content-mismatch": "remote content does not match the local baseline; precise sync state cannot be established safely",
		"block-mapping-missing": "remote block mapping is missing; precise sync aborted",
		"block-id-invalid": "remote block id is invalid; precise sync aborted",
		"diff-too-complex": "the change is too complex for safe precise sync",
		"lark-cli-failed": "lark-cli execution failed"
	}
};

function withMarkdownTitle(content: string, title: string): string {
	if (/^[ \t]*#[ \t]+/m.test(content)) {
		return content.replace(/^[ \t]*#[ \t]+.+?[ \t#]*$/m, `# ${title}`);
	}

	return `# ${title}\n\n${content}`;
}

function readFrontmatter(content: string): string {
	if (!content.startsWith("---")) {
		return "";
	}

	const endMatch = content.slice(3).match(/\n---\r?\n/);
	if (!endMatch || endMatch.index === undefined) {
		return "";
	}

	return content.slice(3, 3 + endMatch.index);
}

function readYamlString(frontmatter: string, key: string): string {
	const pattern = new RegExp(`^${escapeRegExp(key)}:\\s*(.*)$`, "m");
	const match = frontmatter.match(pattern);
	if (!match?.[1]) {
		return "";
	}

	return match[1].trim().replace(/^["']|["']$/g, "");
}

function removeYamlObjects(lines: string[], keys: string[]): string[] {
	const result: string[] = [];
	const keySet = new Set(keys);
	let skipping = false;
	let skipIndent = 0;

	for (const line of lines) {
		const keyMatch = line.match(/^(\s*)([A-Za-z0-9_-]+):/);
		if (keyMatch) {
			const indent = keyMatch[1]?.length || 0;
			const name = keyMatch[2];

			if (skipping && indent <= skipIndent) {
				skipping = false;
			}

			if (!skipping && name && keySet.has(name)) {
				skipping = true;
				skipIndent = indent;
				continue;
			}
		}

		if (!skipping) {
			result.push(line);
		}
	}

	return result;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
