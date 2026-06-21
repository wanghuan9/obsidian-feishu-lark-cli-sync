import { normalizePath } from "./folder-path";
import {
	createContentHash,
	createDocumentSyncState,
	createDocumentSyncStateFromRemote,
	DocumentSyncState,
	FRONTMATTER_REMOTE_PARENT_PATH_KEY,
	FRONTMATTER_REMOTE_ROOT_KEY,
	FRONTMATTER_TOKEN_KEY,
	FRONTMATTER_URL_KEY,
	getDocumentStateKey,
	getDocumentStateKeys,
	LarkSyncStateFile,
	readBindingFromMarkdown,
	removeLarkBinding,
	touchDocumentSyncState
} from "./lark-sync-core";

export const REMOTE_IMPORT_STATE_FILE_NAME = "remote-import-state.json";
export const DEFAULT_REMOTE_IMPORT_LOCAL_ROOT = "Lark";
export const DEFAULT_REMOTE_IMPORT_PAGE_SIZE = 10;

export type RemoteImportSource =
	| RemoteImportSearchSource
	| RemoteImportDriveFolderSource;

export interface RemoteImportSearchSource {
	type: "search";
	query: string;
	localRoot: string;
	remoteRoot?: string;
	folderToken?: string;
}

export interface RemoteImportDriveFolderSource {
	type: "drive-folder";
	folderToken: string;
	localRoot: string;
	remoteRoot?: string;
	recursive?: boolean;
}

export interface RemoteImportStateFile {
	version: 1;
	sessions: Record<string, RemoteImportSession>;
}

export interface RemoteImportSession {
	id: string;
	source: RemoteImportSource;
	pageToken?: string;
	pendingFolders: RemoteImportFolderCursor[];
	seen: string[];
	imported: number;
	skipped: number;
	conflicts: number;
	failed: number;
	completed: boolean;
	updatedAt: string;
	lastError?: string;
}

export interface RemoteImportFolderCursor {
	folderToken: string;
	path: string;
	pageToken?: string;
}

export interface RemoteImportRunInput {
	source: RemoteImportSource;
	progressState: RemoteImportStateFile;
	syncState: LarkSyncStateFile;
	adapter: RemoteImportAdapter;
	pageSize?: number;
	now?: () => string;
}

export interface RemoteImportAdapter {
	searchPage(input: RemoteImportSearchPageInput): Promise<RemoteImportPage>;
	listFolderPage(input: RemoteImportFolderPageInput): Promise<RemoteImportPage>;
	fetchDocument(doc: string): Promise<RemoteImportFetchedDocument>;
	readLocalFile(path: string): Promise<string | null>;
	writeLocalFile(path: string, content: string): Promise<void>;
}

export interface RemoteImportSearchPageInput {
	query: string;
	folderToken?: string;
	pageToken?: string;
	pageSize: number;
}

export interface RemoteImportFolderPageInput {
	folderToken: string;
	pageToken?: string;
	pageSize: number;
}

export interface RemoteImportPage {
	items: RemoteImportItem[];
	hasMore: boolean;
	nextPageToken?: string;
}

export interface RemoteImportItem {
	token: string;
	url?: string;
	title: string;
	type: string;
	remoteParentPath?: string;
}

export interface RemoteImportFetchedDocument {
	doc?: string;
	url?: string;
	title?: string;
	markdown: string;
	xml?: string;
	revisionId?: number;
}

export interface RemoteImportRunResult {
	session: RemoteImportSession;
	summary: RemoteImportRunSummary;
}

export interface RemoteImportRunSummary {
	imported: number;
	skipped: number;
	conflicts: number;
	failed: number;
	completed: boolean;
	errors: string[];
	files: string[];
}

interface RemoteImportBinding {
	token: string;
	url: string;
	remoteRoot: string;
	remoteParentPath: string;
}

interface RemoteImportDocumentContext {
	item: RemoteImportItem;
	source: RemoteImportSource;
	doc: string;
	url: string;
	title: string;
	markdown: string;
	xml?: string;
	revisionId?: number;
}

interface RemoteImportDocumentResult {
	status: "imported" | "skipped" | "conflicts";
	path?: string;
}

interface RemoteImportPathResolution {
	path: string;
	action: "write" | "skip";
}

export function createEmptyRemoteImportStateFile(): RemoteImportStateFile {
	return {
		version: 1,
		sessions: {}
	};
}

export function isValidRemoteImportStateFile(state: unknown): state is RemoteImportStateFile {
	const candidate = state as Partial<RemoteImportStateFile> | null;
	return Boolean(candidate)
		&& candidate?.version === 1
		&& Boolean(candidate.sessions)
		&& !Array.isArray(candidate.sessions)
		&& typeof candidate.sessions === "object";
}

export function getRemoteImportSessionId(source: RemoteImportSource): string {
	if (source.type === "search") {
		return [
			"search",
			normalizeSessionPart(source.query),
			normalizeSessionPart(source.folderToken || ""),
			normalizeSessionPart(source.localRoot)
		].join("|");
	}

	return [
		"drive-folder",
		normalizeSessionPart(source.folderToken || "root"),
		normalizeSessionPart(source.localRoot),
		source.recursive === false ? "flat" : "recursive"
	].join("|");
}

export async function runProgressiveRemoteImport(input: RemoteImportRunInput): Promise<RemoteImportRunResult> {
	const pageSize = normalizePageSize(input.pageSize);
	const now = input.now || (() => new Date().toISOString());
	const session = getOrCreateRemoteImportSession(input.progressState, input.source, now);
	const summary = createRunSummary(session.completed);

	if (session.completed) {
		return {
			session,
			summary
		};
	}

	const seen = new Set(session.seen);
	if (input.source.type === "search") {
		await importSearchPage(input, session, summary, seen, pageSize);
	} else {
		await importNextFolderPage(input, session, summary, seen, pageSize);
	}

	session.seen = Array.from(seen);
	session.imported += summary.imported;
	session.skipped += summary.skipped;
	session.conflicts += summary.conflicts;
	session.failed += summary.failed;
	session.completed = summary.completed;
	session.updatedAt = now();
	session.lastError = summary.errors[0] || undefined;

	return {
		session,
		summary
	};
}

export function normalizeRemoteImportPage(rawPage: unknown): RemoteImportPage {
	const raw = rawPage as Record<string, unknown> | null;
	const data = unwrapData(raw);
	const items = findFirstArray(data, ["items", "files", "docs", "documents", "results"])
		.map(normalizeRemoteImportItem)
		.filter((item): item is RemoteImportItem => Boolean(item));
	const hasMore = readBoolean(data, ["has_more", "hasMore"]);
	const nextPageToken = readString(data, ["next_page_token", "nextPageToken", "page_token"]);
	return {
		items,
		hasMore,
		nextPageToken
	};
}

export function buildImportedMarkdown(content: string, binding: RemoteImportBinding): string {
	const contentWithoutBinding = removeLarkBinding(content).replace(/\r\n/g, "\n");
	const bindingFrontmatter = createBindingFrontmatter(binding);
	if (contentWithoutBinding.startsWith("---\n")) {
		return contentWithoutBinding.replace(/^---\n/, `---\n${bindingFrontmatter}`);
	}

	return `---\n${bindingFrontmatter}---\n${contentWithoutBinding}`;
}

export function buildRemoteImportLocalPath(source: RemoteImportSource, item: RemoteImportItem): string {
	const localRoot = normalizePath(source.localRoot || DEFAULT_REMOTE_IMPORT_LOCAL_ROOT);
	const parentPath = normalizePath(item.remoteParentPath || "");
	const fileName = `${sanitizeRemoteImportPathSegment(item.title || item.token || "Untitled")}.md`;
	return normalizePath([localRoot, parentPath, fileName].filter(Boolean).join("/"));
}

export function sanitizeRemoteImportPathSegment(value: string): string {
	return value
		.replace(/[\\/:*?"<>|#^[\]]+/g, "-")
		.replace(/\s+/g, " ")
		.replace(/-+/g, "-")
		.replace(/^[.\s-]+|[.\s-]+$/g, "")
		.slice(0, 120) || "Untitled";
}

async function importSearchPage(
	input: RemoteImportRunInput,
	session: RemoteImportSession,
	summary: RemoteImportRunSummary,
	seen: Set<string>,
	pageSize: number
): Promise<void> {
	const source = input.source as RemoteImportSearchSource;
	const page = await input.adapter.searchPage({
		query: source.query,
		folderToken: source.folderToken,
		pageToken: session.pageToken,
		pageSize
	});
	await importPageDocuments(input, session, summary, seen, page.items);
	const hasNextPage = page.hasMore && Boolean(page.nextPageToken);
	session.pageToken = hasNextPage ? page.nextPageToken : undefined;
	summary.completed = !hasNextPage;
}

async function importNextFolderPage(
	input: RemoteImportRunInput,
	session: RemoteImportSession,
	summary: RemoteImportRunSummary,
	seen: Set<string>,
	pageSize: number
): Promise<void> {
	const source = input.source as RemoteImportDriveFolderSource;
	if (session.pendingFolders.length === 0) {
		session.pendingFolders.push({
			folderToken: source.folderToken,
			path: ""
		});
	}

	const cursor = session.pendingFolders[0];
	if (!cursor) {
		summary.completed = true;
		return;
	}

	const page = await input.adapter.listFolderPage({
		folderToken: cursor.folderToken,
		pageToken: cursor.pageToken,
		pageSize
	});
	const documentItems: RemoteImportItem[] = [];
	for (const item of page.items) {
		const remoteParentPath = cursor.path;
		if (isFolderImportItem(item) && source.recursive !== false && item.token) {
			session.pendingFolders.push({
				folderToken: item.token,
				path: normalizePath([cursor.path, item.title].filter(Boolean).join("/"))
			});
			continue;
		}

		documentItems.push({
			...item,
			remoteParentPath
		});
	}

	await importPageDocuments(input, session, summary, seen, documentItems);
	if (page.hasMore && page.nextPageToken) {
		cursor.pageToken = page.nextPageToken;
	} else {
		session.pendingFolders.shift();
	}
	summary.completed = session.pendingFolders.length === 0;
}

async function importPageDocuments(
	input: RemoteImportRunInput,
	session: RemoteImportSession,
	summary: RemoteImportRunSummary,
	seen: Set<string>,
	items: RemoteImportItem[]
): Promise<void> {
	for (const item of items) {
		if (!isDocumentImportItem(item)) {
			summary.skipped += 1;
			continue;
		}

		const seenKey = item.url || item.token;
		if (seen.has(seenKey)) {
			summary.skipped += 1;
			continue;
		}

		try {
			const result = await importRemoteDocument(input, item);
			summary[result.status] += 1;
			if (result.status === "imported" && result.path) {
				summary.files.push(result.path);
			}
			seen.add(seenKey);
		} catch (error) {
			summary.failed += 1;
			summary.errors.push(error instanceof Error ? error.message : String(error));
			seen.add(seenKey);
		}
	}

	session.completed = summary.completed;
}

async function importRemoteDocument(
	input: RemoteImportRunInput,
	item: RemoteImportItem
): Promise<RemoteImportDocumentResult> {
	const fetched = await input.adapter.fetchDocument(item.url || item.token);
	const doc = fetched.doc || item.token || item.url || "";
	if (!doc) {
		throw new Error(`Remote item has no document token: ${item.title}`);
	}

	const context: RemoteImportDocumentContext = {
		item,
		source: input.source,
		doc,
		url: item.url || fetched.url || "",
		title: item.title || fetched.title || doc,
		markdown: fetched.markdown,
		xml: fetched.xml,
		revisionId: fetched.revisionId
	};
	const binding = createRemoteImportBinding(context);
	const resolution = await resolveRemoteImportLocalPath(input.adapter, context, binding);
	if (!resolution) {
		return {
			status: "conflicts"
		};
	}

	if (resolution.action === "skip") {
		return {
			status: "skipped",
			path: resolution.path
		};
	}

	const nextContent = buildImportedMarkdown(context.markdown, binding);
	await input.adapter.writeLocalFile(resolution.path, nextContent);
	await saveImportedDocumentState(input.syncState, context);
	return {
		status: "imported",
		path: resolution.path
	};
}

async function resolveRemoteImportLocalPath(
	adapter: RemoteImportAdapter,
	context: RemoteImportDocumentContext,
	binding: RemoteImportBinding
): Promise<RemoteImportPathResolution | null> {
	const baseItem = {
		...context.item,
		title: context.title
	};
	const basePath = buildRemoteImportLocalPath(context.source, baseItem);
	const baseDecision = await canWriteImportPath(adapter, basePath, binding, context.markdown);
	if (baseDecision === "write") {
		return {
			path: basePath,
			action: "write"
		};
	}
	if (baseDecision === "skip") {
		return {
			path: basePath,
			action: "skip"
		};
	}

	const tokenSuffix = getDocumentStateKey(context.doc).slice(0, 8);
	if (!tokenSuffix) {
		return null;
	}
	const suffixedItem = {
		...baseItem,
		title: `${context.title}-${tokenSuffix}`
	};
	const suffixedPath = buildRemoteImportLocalPath(context.source, suffixedItem);
	const suffixedDecision = await canWriteImportPath(adapter, suffixedPath, binding, context.markdown);
	if (suffixedDecision === "conflict") {
		return null;
	}

	return {
		path: suffixedPath,
		action: suffixedDecision
	};
}

async function canWriteImportPath(
	adapter: RemoteImportAdapter,
	path: string,
	binding: RemoteImportBinding,
	remoteMarkdown: string
): Promise<"write" | "skip" | "conflict"> {
	const existing = await adapter.readLocalFile(path);
	if (existing === null) {
		return "write";
	}

	const existingBinding = readBindingFromMarkdown(existing);
	const existingKey = getDocumentStateKey(existingBinding?.token || existingBinding?.url || "");
	const nextKey = getDocumentStateKey(binding.token || binding.url);
	if (existingBinding && existingKey === nextKey) {
		return isEquivalentMarkdown(existing, remoteMarkdown) ? "write" : "skip";
	}

	if (!existingBinding && isEquivalentMarkdown(existing, remoteMarkdown)) {
		return "write";
	}

	return "conflict";
}

async function saveImportedDocumentState(
	syncState: LarkSyncStateFile,
	context: RemoteImportDocumentContext
): Promise<void> {
	const remoteDoc = context.doc;
	const state = await createRemoteDocumentState(remoteDoc, context.markdown, context.xml, context.revisionId);
	const stateKey = getDocumentStateKey(state.doc);
	for (const key of getDocumentStateKeys([context.doc, context.url, context.item.token, context.item.url || ""])) {
		if (key !== stateKey) {
			delete syncState.documents[key];
		}
	}
	syncState.documents[stateKey] = {
		...touchDocumentSyncState(state),
		doc: stateKey
	};
}

async function createRemoteDocumentState(
	doc: string,
	markdown: string,
	xml: string | undefined,
	revisionId: number | undefined
): Promise<DocumentSyncState> {
	if (xml) {
		return await createDocumentSyncStateFromRemote(doc, markdown, xml, revisionId);
	}

	return createDocumentSyncState(doc, await createContentHash(markdown), revisionId);
}

function createRemoteImportBinding(context: RemoteImportDocumentContext): RemoteImportBinding {
	const remoteRoot = getRemoteImportRoot(context.source);
	const remoteParentPath = normalizePath([remoteRoot, context.item.remoteParentPath || ""].filter(Boolean).join("/"));
	return {
		token: context.doc,
		url: context.url,
		remoteRoot,
		remoteParentPath
	};
}

function getRemoteImportRoot(source: RemoteImportSource): string {
	const remoteRoot = normalizePath(source.remoteRoot || "");
	if (remoteRoot) {
		return remoteRoot;
	}

	const localRoot = normalizePath(source.localRoot || DEFAULT_REMOTE_IMPORT_LOCAL_ROOT);
	return localRoot.split("/").filter(Boolean)[0] || DEFAULT_REMOTE_IMPORT_LOCAL_ROOT;
}

function getOrCreateRemoteImportSession(
	state: RemoteImportStateFile,
	source: RemoteImportSource,
	now: () => string
): RemoteImportSession {
	const sessionId = getRemoteImportSessionId(source);
	const existingSession = state.sessions[sessionId];
	if (existingSession) {
		return existingSession;
	}

	const session: RemoteImportSession = {
		id: sessionId,
		source,
		pendingFolders: [],
		seen: [],
		imported: 0,
		skipped: 0,
		conflicts: 0,
		failed: 0,
		completed: false,
		updatedAt: now()
	};
	state.sessions[sessionId] = session;
	return session;
}

function normalizeRemoteImportItem(rawItem: unknown): RemoteImportItem | null {
	const item = rawItem as Record<string, unknown> | null;
	if (!item) {
		return null;
	}

	const nested = unwrapData(item);
	const token = readString(nested, [
		"token",
		"doc_token",
		"docs_token",
		"document_id",
		"obj_token",
		"node_token",
		"wiki_token",
		"id"
	]);
	const url = readString(nested, ["url", "docs_url", "web_url"]);
	const title = readString(nested, ["title", "name", "doc_name", "display_name"]) || token || url || "Untitled";
	const type = readString(nested, ["type", "doc_type", "obj_type", "file_type"]).toLowerCase();
	if (!token && !url) {
		return null;
	}

	return {
		token,
		url,
		title,
		type
	};
}

function unwrapData(value: Record<string, unknown> | null): Record<string, unknown> {
	if (!value) {
		return {};
	}

	for (const key of ["data", "result", "item", "file", "document", "docs", "wiki"]) {
		const nested = value[key];
		if (nested && typeof nested === "object" && !Array.isArray(nested)) {
			return {
				...value,
				...(nested as Record<string, unknown>)
			};
		}
	}

	return value;
}

function findFirstArray(data: Record<string, unknown>, keys: string[]): unknown[] {
	for (const key of keys) {
		const value = data[key];
		if (Array.isArray(value)) {
			return value;
		}
	}

	for (const value of Object.values(data)) {
		if (value && typeof value === "object" && !Array.isArray(value)) {
			const nested = findFirstArray(value as Record<string, unknown>, keys);
			if (nested.length > 0) {
				return nested;
			}
		}
	}

	return [];
}

function readString(data: Record<string, unknown>, keys: string[]): string {
	for (const key of keys) {
		const value = data[key];
		if (typeof value === "string") {
			return value.trim();
		}
		if (typeof value === "number") {
			return String(value);
		}
	}

	return "";
}

function readBoolean(data: Record<string, unknown>, keys: string[]): boolean {
	for (const key of keys) {
		const value = data[key];
		if (typeof value === "boolean") {
			return value;
		}
	}

	return false;
}

function isDocumentImportItem(item: RemoteImportItem): boolean {
	if (!item.type) {
		return true;
	}

	return ["doc", "docx", "wiki"].includes(item.type.toLowerCase());
}

function isFolderImportItem(item: RemoteImportItem): boolean {
	return item.type.toLowerCase() === "folder";
}

function isEquivalentMarkdown(left: string, right: string): boolean {
	return normalizeMarkdownForComparison(left) === normalizeMarkdownForComparison(right);
}

function normalizeMarkdownForComparison(content: string): string {
	return removeLarkBinding(content).replace(/\r\n/g, "\n").trim();
}

function createBindingFrontmatter(binding: RemoteImportBinding): string {
	const lines: string[] = [];
	if (binding.url) {
		lines.push(`${FRONTMATTER_URL_KEY}: ${quoteYamlString(binding.url)}`);
	}
	if (binding.token) {
		lines.push(`${FRONTMATTER_TOKEN_KEY}: ${quoteYamlString(binding.token)}`);
	}
	if (binding.remoteRoot) {
		lines.push(`${FRONTMATTER_REMOTE_ROOT_KEY}: ${quoteYamlString(binding.remoteRoot)}`);
	}
	if (binding.remoteParentPath) {
		lines.push(`${FRONTMATTER_REMOTE_PARENT_PATH_KEY}: ${quoteYamlString(binding.remoteParentPath)}`);
	}
	return `${lines.join("\n")}\n`;
}

function quoteYamlString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function normalizePageSize(value: number | undefined): number {
	if (!Number.isFinite(value || 0)) {
		return DEFAULT_REMOTE_IMPORT_PAGE_SIZE;
	}

	return Math.max(1, Math.min(20, Math.floor(value || DEFAULT_REMOTE_IMPORT_PAGE_SIZE)));
}

function normalizeSessionPart(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function createRunSummary(completed: boolean): RemoteImportRunSummary {
	return {
		imported: 0,
		skipped: 0,
		conflicts: 0,
		failed: 0,
		completed,
		errors: [],
		files: []
	};
}
