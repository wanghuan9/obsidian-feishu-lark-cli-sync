export type TitleSource = "first-heading" | "file-name";

export interface NoteFile {
	basename: string;
}

export interface LarkDocumentBinding {
	token: string;
	url: string;
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
	return [
		"docs",
		"+update",
		"--api-version",
		"v2",
		"--as",
		"user",
		"--doc",
		doc,
		"--command",
		"overwrite",
		"--doc-format",
		"markdown",
		"--content",
		`@${fileName}`,
		"--json"
	];
}

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
