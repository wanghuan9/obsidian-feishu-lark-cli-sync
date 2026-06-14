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
	| "remote-update-not-visible"
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

export interface TrimSyncStateCacheOptions {
	retainLimit: number;
	trimThreshold?: number;
}

export interface DocumentSyncState {
	doc: string;
	revisionId?: number;
	contentHash: string;
	titleBlockId?: string;
	units: SyncUnitState[];
	updatedAt: string;
}

export interface SyncUnitState {
	stableId: string;
	kind: string;
	hash: string;
	blockId: string;
}

export interface SyncContentSignature {
	contentHash: string;
	units: SyncContentUnitSignature[];
}

export interface SyncContentUnitSignature {
	kind: string;
	hash: string;
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
	content?: string;
}

export interface LarkBlockInsertAfterCommand {
	doc: string;
	command: "block_insert_after";
	docFormat: "markdown" | "xml";
	blockId: string;
	contentFileName: string;
	content?: string;
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

export function extractDocumentToken(doc: string): string {
	if (!doc) {
		return "";
	}

	try {
		const parsedUrl = new URL(doc);
		const match = parsedUrl.pathname.match(/\/(?:wiki|folder|docx|doc)\/([^/?#]+)/);
		return match?.[1] || "";
	} catch {
		const match = doc.match(/\/(?:wiki|folder|docx|doc)\/([^/?#]+)/);
		return match?.[1] || "";
	}
}

export function getDocumentStateKey(doc: string): string {
	const normalizedDoc = doc.trim();
	return extractDocumentToken(normalizedDoc) || normalizedDoc;
}

export function getDocumentStateKeys(docs: string[]): string[] {
	const seen = new Set<string>();
	const keys: string[] = [];
	for (const doc of docs) {
		const key = getDocumentStateKey(doc || "");
		if (!key || seen.has(key)) {
			continue;
		}

		seen.add(key);
		keys.push(key);
	}

	return keys;
}

export function trimSyncStateCache(
	state: LarkSyncStateFile,
	options: TrimSyncStateCacheOptions
): LarkSyncStateFile {
	const retainLimit = normalizeStateCacheRetainLimit(options.retainLimit);
	const trimThreshold = normalizeStateCacheTrimThreshold(retainLimit, options.trimThreshold);
	if (trimThreshold <= retainLimit) {
		return state;
	}

	const keys = Object.keys(state.documents);
	if (keys.length <= trimThreshold) {
		return state;
	}

	const entries: Array<[string, DocumentSyncState]> = [];
	for (const key of keys) {
		const documentState = state.documents[key];
		if (documentState) {
			entries.push([key, documentState]);
		}
	}
	const sortedEntries = entries.sort(([, left], [, right]) => {
		return getDocumentStateUpdatedAt(left) - getDocumentStateUpdatedAt(right);
	});
	const documents = Object.fromEntries(sortedEntries.slice(entries.length - retainLimit));
	return {
		version: 1,
		documents
	};
}

export function normalizeStateCacheRetainLimit(value: unknown, fallback = 100): number {
	const numericValue = typeof value === "number" ? value : Number.parseInt(String(value || ""), 10);
	if (!Number.isFinite(numericValue)) {
		return fallback;
	}

	return Math.max(1, Math.floor(numericValue));
}

export function normalizeStateCacheTrimThreshold(retainLimit: number, trimThreshold?: unknown): number {
	if (trimThreshold !== undefined) {
		const numericValue = typeof trimThreshold === "number" ? trimThreshold : Number.parseInt(String(trimThreshold || ""), 10);
		if (Number.isFinite(numericValue)) {
			return Math.max(retainLimit + 1, Math.floor(numericValue));
		}
	}

	return Math.max(retainLimit + 1, Math.ceil(retainLimit * 1.5));
}

export function touchDocumentSyncState(state: DocumentSyncState): DocumentSyncState {
	return {
		...state,
		updatedAt: new Date().toISOString()
	};
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

	if (input.state && getDocumentStateKey(input.state.doc) !== getDocumentStateKey(input.doc)) {
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

	const units = await createMarkdownSyncUnits(input.markdown);
	if (!input.state || input.state.units.length === 0) {
		return {
			mode: "blocked",
			commands: [],
			contentHash,
			reason: "block-mapping-missing"
		};
	}

	const precisePlan = await buildPreciseReplacePlan(input, contentHash, units);
	if (precisePlan) {
		return precisePlan;
	}

	const insertPlan = await buildPreciseInsertPlan(input, contentHash, units);
	if (insertPlan) {
		return insertPlan;
	}

	const mixedInsertReplacePlan = await buildPreciseMixedInsertReplacePlan(input, contentHash, units);
	if (mixedInsertReplacePlan) {
		return mixedInsertReplacePlan;
	}

	const deletePlan = await buildPreciseDeletePlan(input, contentHash, units);
	if (deletePlan) {
		return deletePlan;
	}

	return {
		mode: "blocked",
		commands: [],
		contentHash,
		reason: "diff-too-complex"
	};
}

export async function createDocumentSyncStateFromRemote(
	doc: string,
	markdown: string,
	remoteXml: string,
	revisionId?: number
): Promise<DocumentSyncState> {
	const contentHash = await createContentHash(markdown);
	const markdownUnits = await createMarkdownSyncUnits(markdown);
	const remoteUnits = readRemoteTopLevelUnits(remoteXml);
	const titleBlockId = readRemoteTitleBlockId(remoteXml);
	if (markdownUnits.length !== remoteUnits.length) {
		return createDocumentSyncStateFromPartialMapping(
			doc,
			contentHash,
			markdownUnits,
			remoteUnits,
			revisionId,
			titleBlockId
		);
	}

	const units = markdownUnits.map((unit, index) => {
		const remoteUnit = remoteUnits[index];
		if (!remoteUnit || remoteUnit.kind !== unit.kind) {
			return null;
		}

		return {
			stableId: unit.stableId,
			kind: unit.kind,
			hash: unit.hash,
			blockId: remoteUnit.blockId
		};
	});

	if (units.some((unit) => !unit)) {
		return createDocumentSyncStateFromPartialMapping(
			doc,
			contentHash,
			markdownUnits,
			remoteUnits,
			revisionId,
			titleBlockId
		);
	}

	return {
		doc,
		revisionId,
		contentHash,
		titleBlockId,
		units: units as SyncUnitState[],
		updatedAt: new Date().toISOString()
	};
}

function createDocumentSyncStateFromPartialMapping(
	doc: string,
	contentHash: string,
	markdownUnits: MarkdownSyncUnit[],
	remoteUnits: RemoteSyncUnit[],
	revisionId?: number,
	titleBlockId?: string
): DocumentSyncState {
	const markdownKeyCounts = countUnitFingerprintKeys(markdownUnits);
	const remoteUnitsByKey = collectUniqueRemoteUnitsByFingerprint(remoteUnits);
	const units = markdownUnits.map((unit) => {
		const key = createUnitFingerprintKey(unit);
		const remoteUnit = markdownKeyCounts.get(key) === 1 ? remoteUnitsByKey.get(key) : undefined;
		return {
			stableId: unit.stableId,
			kind: unit.kind,
			hash: unit.hash,
			blockId: remoteUnit?.blockId || ""
		};
	});

	if (units.every((unit) => !unit.blockId)) {
		return createDocumentSyncState(doc, contentHash, revisionId);
	}

	return {
		doc,
		revisionId,
		contentHash,
		titleBlockId,
		units,
		updatedAt: new Date().toISOString()
	};
}

export async function createSyncContentSignature(markdown: string): Promise<SyncContentSignature> {
	const contentHash = await createContentHash(markdown);
	const units = await createMarkdownSyncUnits(markdown);
	return {
		contentHash,
		units: units.map((unit) => ({
			kind: unit.kind,
			hash: unit.hash
		}))
	};
}

export function isDocumentStateContentEquivalent(
	state: DocumentSyncState,
	signature: SyncContentSignature
): boolean {
	if (state.contentHash === signature.contentHash) {
		return true;
	}

	return areSyncContentUnitsEquivalent(state.units, signature.units);
}

export function isSyncContentSignatureEquivalent(
	current: SyncContentSignature,
	expected: SyncContentSignature
): boolean {
	if (current.contentHash === expected.contentHash) {
		return true;
	}

	return areSyncContentUnitsEquivalent(current.units, expected.units);
}

function areSyncContentUnitsEquivalent(
	currentUnits: SyncContentUnitSignature[],
	expectedUnits: SyncContentUnitSignature[]
): boolean {
	if (currentUnits.length !== expectedUnits.length) {
		return false;
	}

	return currentUnits.every((unit, index) => {
		const expectedUnit = expectedUnits[index];
		if (!expectedUnit) {
			return false;
		}

		return unit.kind === expectedUnit.kind && unit.hash === expectedUnit.hash;
	});
}

function getDocumentStateUpdatedAt(state: DocumentSyncState): number {
	const updatedAt = Date.parse(state.updatedAt);
	return Number.isFinite(updatedAt) ? updatedAt : 0;
}

export function createEmptySyncStateFile(): LarkSyncStateFile {
	return {
		version: 1,
		documents: {}
	};
}

export function createDocumentSyncState(doc: string, contentHash: string, revisionId?: number): DocumentSyncState {
	return {
		doc,
		revisionId,
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
		"remote-update-not-visible": "远端更新尚未可见，无法安全刷新增量同步状态，请稍后重试",
		"lark-cli-failed": "lark-cli 执行失败"
	},
	en: {
		"remote-revision-changed": "remote document revision changed; precise sync aborted",
		"remote-content-mismatch": "remote content does not match the local baseline; precise sync state cannot be established safely",
		"block-mapping-missing": "remote block mapping is missing; precise sync aborted",
		"block-id-invalid": "remote block id is invalid; precise sync aborted",
		"diff-too-complex": "the change is too complex for safe precise sync",
		"remote-update-not-visible": "remote update is not visible yet; precise sync state cannot be refreshed safely; retry later",
		"lark-cli-failed": "lark-cli execution failed"
	}
};

function withMarkdownTitle(content: string, title: string): string {
	if (/^[ \t]*#[ \t]+/m.test(content)) {
		return content.replace(/^[ \t]*#[ \t]+.+?[ \t#]*$/m, `# ${title}`);
	}

	return `# ${title}\n\n${content}`;
}

interface MarkdownSyncUnit {
	stableId: string;
	kind: string;
	hash: string;
	content: string;
	fingerprint: string;
}

interface RemoteSyncUnit {
	kind: string;
	blockId: string;
	fingerprint: string;
}

async function buildPreciseReplacePlan(
	input: BuildSyncPlanInput,
	contentHash: string,
	units: MarkdownSyncUnit[]
): Promise<SyncPlan | null> {
	if (!input.state || input.state.units.length !== units.length) {
		return null;
	}

	const commands: LarkUpdateCommand[] = [];
	const nextUnits: SyncUnitState[] = [];
	for (let index = 0; index < units.length; index += 1) {
		const previousUnit = input.state.units[index];
		const nextUnit = units[index];
		if (!previousUnit || !nextUnit || previousUnit.kind !== nextUnit.kind || previousUnit.stableId !== nextUnit.stableId) {
			return null;
		}

		nextUnits.push({
			stableId: previousUnit.stableId,
			kind: previousUnit.kind,
			hash: nextUnit.hash,
			blockId: previousUnit.blockId
		});
		if (previousUnit.hash !== nextUnit.hash) {
			if (!previousUnit.blockId) {
				return {
					mode: "blocked",
					commands: [],
					contentHash,
					reason: "block-mapping-missing"
				};
			}

			commands.push({
				doc: input.doc,
				command: "block_replace",
				docFormat: "markdown",
				blockId: previousUnit.blockId,
				contentFileName: input.contentFileName,
				content: nextUnit.content
			});
		}
	}

	if (commands.length === 0) {
		return {
			mode: "skipped",
			commands: [],
			contentHash,
			nextState: input.state
		};
	}

	return {
		mode: "precise",
		commands,
		contentHash,
		nextState: {
			doc: input.doc,
			revisionId: input.state.revisionId,
			contentHash,
			titleBlockId: input.state.titleBlockId,
			units: nextUnits,
			updatedAt: new Date().toISOString()
		}
	};
}

async function buildPreciseInsertPlan(
	input: BuildSyncPlanInput,
	contentHash: string,
	units: MarkdownSyncUnit[]
): Promise<SyncPlan | null> {
	if (!input.state || input.state.units.length >= units.length) {
		return null;
	}

	const previousUnits = input.state.units;
	let prefixLength = 0;
	while (prefixLength < previousUnits.length
		&& areEquivalentMappedUnits(previousUnits[prefixLength], units[prefixLength])) {
		prefixLength += 1;
	}

	let suffixLength = 0;
	while (suffixLength < previousUnits.length - prefixLength
		&& areEquivalentMappedUnits(
			previousUnits[previousUnits.length - 1 - suffixLength],
			units[units.length - 1 - suffixLength]
		)) {
		suffixLength += 1;
	}

	if (prefixLength + suffixLength !== previousUnits.length) {
		return null;
	}

	const anchorBlockId = prefixLength === 0
		? input.state.titleBlockId
		: previousUnits[prefixLength - 1]?.blockId;
	if (!anchorBlockId) {
		return {
			mode: "blocked",
			commands: [],
			contentHash,
			reason: "block-mapping-missing"
		};
	}

	const insertedUnits = units.slice(prefixLength, units.length - suffixLength);
	if (insertedUnits.length === 0) {
		return null;
	}

	return {
		mode: "precise",
		commands: [{
			doc: input.doc,
			command: "block_insert_after",
			docFormat: "markdown",
			blockId: anchorBlockId,
			contentFileName: input.contentFileName,
			content: joinInsertedUnitContent(insertedUnits)
		}],
		contentHash
	};
}

function joinInsertedUnitContent(units: MarkdownSyncUnit[]): string {
	return units.reduce((content, unit, index) => {
		if (index === 0) {
			return unit.content;
		}

		const previousUnit = units[index - 1];
		const separator = previousUnit?.kind === "list" && unit.kind === "list" ? "\n" : "\n\n";
		return `${content}${separator}${unit.content}`;
	}, "");
}

async function buildPreciseMixedInsertReplacePlan(
	input: BuildSyncPlanInput,
	contentHash: string,
	units: MarkdownSyncUnit[]
): Promise<SyncPlan | null> {
	if (!input.state) {
		return null;
	}

	const previousUnits = input.state.units;
	const matches = findMappedContentMatches(previousUnits, units);
	if (matches.length === 0) {
		return null;
	}

	const commands: LarkUpdateCommand[] = [];
	let previousCursor = 0;
	let nextCursor = 0;
	let anchorBlockId = input.state.titleBlockId || "";
	for (const match of [...matches, { previousIndex: previousUnits.length, nextIndex: units.length }]) {
		const previousGap = previousUnits.slice(previousCursor, match.previousIndex);
		const nextGap = units.slice(nextCursor, match.nextIndex);
		const gapCommands = buildMixedGapCommands(input.doc, input.contentFileName, previousGap, nextGap, anchorBlockId);
		if (!gapCommands) {
			return null;
		}

		commands.push(...gapCommands);
		const matchedBlockId = previousUnits[match.previousIndex]?.blockId;
		if (matchedBlockId) {
			anchorBlockId = matchedBlockId;
		}
		previousCursor = match.previousIndex + 1;
		nextCursor = match.nextIndex + 1;
	}

	if (commands.length === 0) {
		return null;
	}

	return {
		mode: "precise",
		commands,
		contentHash
	};
}

function findMappedContentMatches(
	previousUnits: SyncUnitState[],
	nextUnits: MarkdownSyncUnit[]
): Array<{ previousIndex: number; nextIndex: number }> {
	const lengths = Array.from({ length: previousUnits.length + 1 }, () => {
		return new Array<number>(nextUnits.length + 1).fill(0);
	});
	for (let previousIndex = previousUnits.length - 1; previousIndex >= 0; previousIndex -= 1) {
		for (let nextIndex = nextUnits.length - 1; nextIndex >= 0; nextIndex -= 1) {
			const row = lengths[previousIndex];
			if (!row) {
				continue;
			}

			row[nextIndex] = areEquivalentContentUnits(previousUnits[previousIndex], nextUnits[nextIndex])
				? readMatrixValue(lengths, previousIndex + 1, nextIndex + 1) + 1
				: Math.max(
					readMatrixValue(lengths, previousIndex + 1, nextIndex),
					readMatrixValue(lengths, previousIndex, nextIndex + 1)
				);
		}
	}

	const matches: Array<{ previousIndex: number; nextIndex: number }> = [];
	let previousIndex = 0;
	let nextIndex = 0;
	while (previousIndex < previousUnits.length && nextIndex < nextUnits.length) {
		if (areEquivalentContentUnits(previousUnits[previousIndex], nextUnits[nextIndex])) {
			matches.push({ previousIndex, nextIndex });
			previousIndex += 1;
			nextIndex += 1;
		} else if (
			readMatrixValue(lengths, previousIndex + 1, nextIndex)
			>= readMatrixValue(lengths, previousIndex, nextIndex + 1)
		) {
			previousIndex += 1;
		} else {
			nextIndex += 1;
		}
	}

	return matches;
}

function readMatrixValue(matrix: number[][], rowIndex: number, columnIndex: number): number {
	return matrix[rowIndex]?.[columnIndex] || 0;
}

function buildMixedGapCommands(
	doc: string,
	contentFileName: string,
	previousGap: SyncUnitState[],
	nextGap: MarkdownSyncUnit[],
	anchorBlockId: string
): LarkUpdateCommand[] | null {
	if (previousGap.length === 0 && nextGap.length === 0) {
		return [];
	}

	if (previousGap.length === 0) {
		return buildInsertAfterCommands(doc, contentFileName, nextGap, anchorBlockId);
	}

	if (nextGap.length === 0) {
		return buildDeleteCommands(doc, previousGap);
	}

	const replaceCount = Math.min(previousGap.length, nextGap.length);
	const replaceUnits = nextGap.slice(0, replaceCount);
	const replacedPreviousUnits = previousGap.slice(0, replaceCount);
	if (!replacedPreviousUnits.every((unit, index) => unit.blockId && replaceUnits[index]?.kind === unit.kind)) {
		return buildMixedUnalignedGapCommands(doc, contentFileName, previousGap, nextGap, anchorBlockId);
	}

	const commands: LarkUpdateCommand[] = [];
	for (let index = 0; index < replaceCount; index += 1) {
		const previousUnit = replacedPreviousUnits[index];
		const nextUnit = replaceUnits[index];
		if (!previousUnit || !nextUnit || previousUnit.hash === nextUnit.hash) {
			continue;
		}

		commands.push({
			doc,
			command: "block_replace",
			docFormat: "markdown",
			blockId: previousUnit.blockId,
			contentFileName,
			content: nextUnit.content
		});
	}

	if (previousGap.length > nextGap.length) {
		const deleteCommands = buildDeleteCommands(doc, previousGap.slice(replaceCount));
		return deleteCommands ? [...commands, ...deleteCommands] : null;
	}

	const insertedUnits = nextGap.slice(previousGap.length);
	const insertAnchorBlockId = previousGap[previousGap.length - 1]?.blockId || "";
	const insertCommands = buildInsertAfterCommands(doc, contentFileName, insertedUnits, insertAnchorBlockId);
	return insertCommands ? [...commands, ...insertCommands] : null;
}

function buildMixedUnalignedGapCommands(
	doc: string,
	contentFileName: string,
	previousGap: SyncUnitState[],
	nextGap: MarkdownSyncUnit[],
	anchorBlockId: string
): LarkUpdateCommand[] | null {
	const matches = findGapKindMatches(previousGap, nextGap);
	if (matches.length === 0) {
		return null;
	}

	const commands: LarkUpdateCommand[] = [];
	let previousCursor = 0;
	let nextCursor = 0;
	let currentAnchorBlockId = anchorBlockId;
	for (const match of matches) {
		const deleteCommands = buildDeleteCommands(doc, previousGap.slice(previousCursor, match.previousIndex));
		if (!deleteCommands) {
			return null;
		}

		commands.push(...deleteCommands);
		const insertCommands = buildInsertAfterCommands(
			doc,
			contentFileName,
			nextGap.slice(nextCursor, match.nextIndex),
			currentAnchorBlockId
		);
		if (!insertCommands) {
			return null;
		}

		commands.push(...insertCommands);
		const previousUnit = previousGap[match.previousIndex];
		const nextUnit = nextGap[match.nextIndex];
		if (!previousUnit?.blockId || !nextUnit) {
			return null;
		}

		if (previousUnit.hash !== nextUnit.hash) {
			commands.push({
				doc,
				command: "block_replace",
				docFormat: "markdown",
				blockId: previousUnit.blockId,
				contentFileName,
				content: nextUnit.content
			});
		}

		currentAnchorBlockId = previousUnit.blockId;
		previousCursor = match.previousIndex + 1;
		nextCursor = match.nextIndex + 1;
	}

	const deleteCommands = buildDeleteCommands(doc, previousGap.slice(previousCursor));
	if (!deleteCommands) {
		return null;
	}

	commands.push(...deleteCommands);
	const insertCommands = buildInsertAfterCommands(doc, contentFileName, nextGap.slice(nextCursor), currentAnchorBlockId);
	return insertCommands ? [...commands, ...insertCommands] : null;
}

function findGapKindMatches(
	previousGap: SyncUnitState[],
	nextGap: MarkdownSyncUnit[]
): Array<{ previousIndex: number; nextIndex: number }> {
	const matches: Array<{ previousIndex: number; nextIndex: number }> = [];
	const usedNextIndexes = new Set<number>();
	for (let previousIndex = 0; previousIndex < previousGap.length; previousIndex += 1) {
		const previousUnit = previousGap[previousIndex];
		const nextIndex = nextGap.findIndex((nextUnit, candidateIndex) => {
			return !usedNextIndexes.has(candidateIndex) && nextUnit.kind === previousUnit?.kind;
		});
		if (nextIndex >= 0) {
			usedNextIndexes.add(nextIndex);
			matches.push({ previousIndex, nextIndex });
		}
	}

	return matches;
}

function buildDeleteCommands(doc: string, deletedUnits: SyncUnitState[]): LarkUpdateCommand[] | null {
	if (deletedUnits.length === 0) {
		return [];
	}

	const deletedBlockIds = deletedUnits.map((unit) => unit.blockId).filter(Boolean);
	if (deletedBlockIds.length !== deletedUnits.length) {
		return null;
	}

	return [{
		doc,
		command: "block_delete",
		blockId: deletedBlockIds.join(",")
	}];
}

function buildInsertAfterCommands(
	doc: string,
	contentFileName: string,
	insertedUnits: MarkdownSyncUnit[],
	anchorBlockId: string
): LarkUpdateCommand[] | null {
	if (insertedUnits.length === 0) {
		return [];
	}

	if (!anchorBlockId) {
		return null;
	}

	return [{
		doc,
		command: "block_insert_after",
		docFormat: "markdown",
		blockId: anchorBlockId,
		contentFileName,
		content: joinInsertedUnitContent(insertedUnits)
	}];
}

async function buildPreciseDeletePlan(
	input: BuildSyncPlanInput,
	contentHash: string,
	units: MarkdownSyncUnit[]
): Promise<SyncPlan | null> {
	if (!input.state || input.state.units.length <= units.length) {
		return null;
	}

	const previousUnits = input.state.units;
	let prefixLength = 0;
	while (prefixLength < units.length && areEquivalentMappedUnits(previousUnits[prefixLength], units[prefixLength])) {
		prefixLength += 1;
	}

	let suffixLength = 0;
	while (suffixLength < units.length - prefixLength
		&& areEquivalentMappedUnits(
			previousUnits[previousUnits.length - 1 - suffixLength],
			units[units.length - 1 - suffixLength]
		)) {
		suffixLength += 1;
	}

	if (prefixLength + suffixLength !== units.length) {
		return null;
	}

	const deletedUnits = previousUnits.slice(prefixLength, previousUnits.length - suffixLength);
	if (deletedUnits.length === 0) {
		return null;
	}

	const deletedBlockIds = deletedUnits.map((unit) => unit.blockId).filter(Boolean);
	if (deletedBlockIds.length !== deletedUnits.length) {
		return {
			mode: "blocked",
			commands: [],
			contentHash,
			reason: "block-mapping-missing"
		};
	}

	return {
		mode: "precise",
		commands: [{
			doc: input.doc,
			command: "block_delete",
			blockId: deletedBlockIds.join(",")
		}],
		contentHash
	};
}

function areEquivalentMappedUnits(
	previousUnit: SyncUnitState | undefined,
	nextUnit: MarkdownSyncUnit | undefined
): boolean {
	return Boolean(previousUnit)
		&& Boolean(nextUnit)
		&& previousUnit?.kind === nextUnit?.kind
		&& previousUnit?.hash === nextUnit?.hash
		&& Boolean(previousUnit?.blockId);
}

function areEquivalentContentUnits(
	previousUnit: SyncUnitState | undefined,
	nextUnit: MarkdownSyncUnit | undefined
): boolean {
	return Boolean(previousUnit)
		&& Boolean(nextUnit)
		&& previousUnit?.kind === nextUnit?.kind
		&& previousUnit?.hash === nextUnit?.hash;
}

async function createMarkdownSyncUnits(markdown: string): Promise<MarkdownSyncUnit[]> {
	const blocks = splitMarkdownTopLevelBlocks(stripMarkdownTitle(markdown));
	const units: MarkdownSyncUnit[] = [];
	for (const [index, block] of blocks.entries()) {
		units.push({
			stableId: `${index}:${block.kind}`,
			kind: block.kind,
			hash: await createContentHash(createMarkdownComparisonContent(block.kind, block.content)),
			content: block.content,
			fingerprint: createMarkdownFingerprint(block.kind, block.content)
		});
	}

	return units;
}

function stripMarkdownTitle(markdown: string): string {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	let index = 0;
	while (index < lines.length && (lines[index] || "").trim() === "") {
		index += 1;
	}

	if (/^#\s+/.test(lines[index] || "")) {
		index += 1;
		while (index < lines.length && (lines[index] || "").trim() === "") {
			index += 1;
		}
		return lines.slice(index).join("\n");
	}

	return lines.join("\n");
}

function splitMarkdownTopLevelBlocks(markdown: string): Array<{ kind: string; content: string }> {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	const blocks: Array<{ kind: string; content: string }> = [];
	let index = 0;
	while (index < lines.length) {
		const line = lines[index] || "";
		if (line.trim() === "") {
			index += 1;
			continue;
		}

		const start = index;
		const kind = readMarkdownBlockKind(line);
		if (kind === "heading" || kind === "hr") {
			index += 1;
		} else if (kind === "code") {
			index += 1;
			while (index < lines.length && !/^\s{0,3}```/.test(lines[index] || "")) {
				index += 1;
			}
			if (index < lines.length) {
				index += 1;
			}
		} else if (kind === "list") {
			index += 1;
			while (index < lines.length
				&& (lines[index] || "").trim() !== ""
				&& readMarkdownBlockKind(lines[index] || "") === "paragraph"
				&& /^\s+/.test(lines[index] || "")) {
				index += 1;
			}
		} else if (kind === "blockquote" || kind === "table") {
			index += 1;
			while (index < lines.length && readMarkdownBlockKind(lines[index] || "") === kind) {
				index += 1;
			}
		} else {
			index += 1;
			while (index < lines.length
				&& (lines[index] || "").trim() !== ""
				&& !isMarkdownBlockBoundary(lines[index] || "")
				&& !isMarkdownParagraphLabelBoundary(lines[index] || "")) {
				index += 1;
			}
		}

		blocks.push({
			kind,
			content: lines.slice(start, index).join("\n").trim()
		});
	}

	return blocks;
}

function isMarkdownBlockBoundary(line: string): boolean {
	const kind = readMarkdownBlockKind(line);
	return kind !== "paragraph";
}

function isMarkdownParagraphLabelBoundary(line: string): boolean {
	return /^\*\*[^*\n]+?\*\*[：:]\s*$/.test(line.trim());
}

function readMarkdownBlockKind(line: string): string {
	if (/^#{2,6}\s+/.test(line)) {
		return "heading";
	}

	if (/^\s{0,3}```/.test(line)) {
		return "code";
	}

	if (/^\s*>/.test(line)) {
		return "blockquote";
	}

	if (/^\s*(?:[-+*]|\d+\.)\s+/.test(line)) {
		return "list";
	}

	if (/^\s*\|/.test(line)) {
		return "table";
	}

	if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
		return "hr";
	}

	return "paragraph";
}

function readRemoteTopLevelUnits(xml: string): RemoteSyncUnit[] {
	const units: RemoteSyncUnit[] = [];
	const tagPattern = /<\/?([A-Za-z][A-Za-z0-9-]*)([^>]*)>/g;
	const stack: Array<{ tagName: string; startIndex: number; kind?: string; blockId?: string }> = [];
	let match: RegExpExecArray | null;
	while ((match = tagPattern.exec(xml))) {
		const rawTag = match[0] || "";
		const tagName = match[1] || "";
		const attributes = match[2] || "";
		const isClosing = rawTag.startsWith("</");
		const isSelfClosing = rawTag.endsWith("/>");
		if (isClosing) {
			const frame = stack.pop();
			if (frame?.blockId && frame.kind) {
				const content = xml.slice(frame.startIndex, tagPattern.lastIndex);
				units.push({
					kind: frame.kind,
					blockId: frame.blockId,
					fingerprint: createXmlFingerprint(frame.kind, content)
				});
			}
			continue;
		}

		const depth = stack.length;
		const parentTagName = stack[0]?.tagName;
		const blockId = readXmlAttribute(attributes, "id");
		const isTopLevelBlock = depth === 0 && tagName !== "title" && tagName !== "ul" && tagName !== "ol" && blockId;
		const isTopLevelListItem = depth === 1 && tagName === "li" && (parentTagName === "ul" || parentTagName === "ol")
			&& blockId;
		const kind = isTopLevelBlock ? normalizeRemoteBlockKind(tagName) : isTopLevelListItem ? "list" : "";
		if (isSelfClosing) {
			if (kind) {
				units.push({
					kind,
					blockId,
					fingerprint: createXmlFingerprint(kind, rawTag)
				});
			}
			continue;
		}

		stack.push({
			tagName,
			startIndex: match.index,
			kind,
			blockId
		});
	}

	return units;
}

function readRemoteTitleBlockId(xml: string): string | undefined {
	const titleMatch = xml.match(/<title\b([^>]*)>/i);
	return titleMatch ? readXmlAttribute(titleMatch[1] || "", "id") || undefined : undefined;
}

function countUnitFingerprintKeys(units: MarkdownSyncUnit[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const unit of units) {
		const key = createUnitFingerprintKey(unit);
		counts.set(key, (counts.get(key) || 0) + 1);
	}

	return counts;
}

function collectUniqueRemoteUnitsByFingerprint(units: RemoteSyncUnit[]): Map<string, RemoteSyncUnit> {
	const result = new Map<string, RemoteSyncUnit>();
	const duplicates = new Set<string>();
	for (const unit of units) {
		const key = createUnitFingerprintKey(unit);
		if (result.has(key)) {
			result.delete(key);
			duplicates.add(key);
			continue;
		}

		if (!duplicates.has(key)) {
			result.set(key, unit);
		}
	}

	return result;
}

function createUnitFingerprintKey(unit: { kind: string; fingerprint: string }): string {
	return `${unit.kind}\u0000${unit.fingerprint}`;
}

function createMarkdownFingerprint(kind: string, content: string): string {
	if (kind === "table") {
		return createMarkdownTableFingerprint(content);
	}

	const lines = content.replace(/\r\n/g, "\n").split("\n");
	const normalizedLines = lines.map((line) => {
		if (kind === "heading") {
			return line.replace(/^#{2,6}\s+/, "");
		}

		if (kind === "list") {
			return line.replace(/^\s*(?:[-+*]|\d+\.)\s+/, "");
		}

		if (kind === "blockquote") {
			return line.replace(/^\s*>\s?/, "");
		}

		return line;
	});
	return normalizeFingerprintText(normalizedLines.join("\n"));
}

function createMarkdownComparisonContent(kind: string, content: string): string {
	if (kind === "code") {
		return content.replace(/\r\n/g, "\n").trim();
	}

	return createMarkdownFingerprint(kind, content);
}

function createMarkdownTableFingerprint(content: string): string {
	return content.replace(/\r\n/g, "\n").split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !isMarkdownTableSeparatorLine(line))
		.map((line) => line.split("|").map((cell) => normalizeFingerprintText(cell)).join("|"))
		.join("\n");
}

function isMarkdownTableSeparatorLine(line: string): boolean {
	return /^\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)+\|?$/.test(line);
}

function createXmlFingerprint(kind: string, content: string): string {
	if (kind === "hr") {
		return "";
	}

	if (kind === "table") {
		return createXmlTableFingerprint(content);
	}

	const text = content
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, "");
	return normalizeFingerprintText(decodeXmlEntities(text));
}

function createXmlTableFingerprint(content: string): string {
	const rows = Array.from(content.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi), (rowMatch) => {
		const rowContent = rowMatch[1] || "";
		const cells = Array.from(rowContent.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi), (cellMatch) => {
			const text = (cellMatch[1] || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
			return normalizeFingerprintText(decodeXmlEntities(text));
		});
		return cells.join("|");
	});

	return rows.join("\n");
}

function normalizeFingerprintText(content: string): string {
	return content
		.replace(/\\([~`*_{}\[\]()#+\-.!|>])/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/_([^_]+)_/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

function decodeXmlEntities(content: string): string {
	return content
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, "\"")
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");
}

function normalizeRemoteBlockKind(tagName: string): string {
	if (/^h[1-9]$/.test(tagName)) {
		return "heading";
	}

	if (tagName === "p") {
		return "paragraph";
	}

	if (tagName === "ul" || tagName === "ol") {
		return "list";
	}

	if (tagName === "pre") {
		return "code";
	}

	return tagName;
}

function readXmlAttribute(attributes: string, name: string): string {
	const pattern = new RegExp(`\\s${escapeRegExp(name)}=["']([^"']+)["']`);
	const match = attributes.match(pattern);
	return match?.[1] || "";
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
