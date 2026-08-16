export interface LinkContextFile {
	path: string;
}

export interface LinkTarget {
	token: string;
	url: string;
	label: string;
}

export interface FolderLinkMapEntry {
	file: LinkContextFile & {
		name: string;
		basename: string;
	};
	target: LinkTarget;
}

export function buildFolderLinkMap(folderPath: string, entries: FolderLinkMapEntry[]): Map<string, LinkTarget> {
	const linkMap = new Map<string, LinkTarget>();
	for (const entry of entries) {
		const aliases = new Set<string>();
		const normalizedPath = normalizeLinkPath(entry.file.path);
		const relativeToFolder = normalizeLinkPath(entry.file.path.slice(folderPath.length).replace(/^\/+/, ""));

		aliases.add(normalizedPath);
		aliases.add(relativeToFolder);
		aliases.add(entry.file.name);
		aliases.add(entry.file.basename);
		aliases.add(normalizeLinkPath(entry.file.path.replace(/\.md$/i, "")));
		aliases.add(relativeToFolder.replace(/\.md$/i, ""));

		for (const alias of aliases) {
			if (alias) {
				linkMap.set(alias, entry.target);
			}
		}
	}

	return linkMap;
}

export function mayContainInternalLinks(content: string): boolean {
	return content.includes(".md") || content.includes("[[");
}

export function rewriteInternalLinks(content: string, linkMap: Map<string, LinkTarget>, currentFile: LinkContextFile): string {
	const markdownRewritten = content.replace(/\[([^\]]+)]\(([^)]+\.md(?:#[^)]+)?)\)/g,
		(match, _label: string, target: string) => {
			const linkTarget = resolveInternalLink(target, linkMap, currentFile);
			return linkTarget ? formatLarkDocReference(linkTarget) : match;
		});

	const wikiRewritten = markdownRewritten.replace(/(?<!!)\[\[([^|\]#]+)(#[^|\]]+)?(?:\|([^\]]+))?\]\]/g,
		(match, target: string) => {
			const linkTarget = resolveInternalLink(target, linkMap, currentFile);
			return linkTarget ? formatLarkDocReference(linkTarget) : match;
		});

	return wikiRewritten.replace(/(?<![\](/])\b([A-Za-z0-9_. -]+\.md)(#[A-Za-z0-9_.% -]+)?\b/g,
		(match, target: string) => {
			const linkTarget = resolveInternalLink(target, linkMap, currentFile);
			return linkTarget ? formatLarkDocReference(linkTarget) : match;
		});
}

export function resolveInternalLink(
	target: string,
	linkMap: Map<string, LinkTarget>,
	currentFile: LinkContextFile
): LinkTarget | null {
	const withoutAnchor = target.split("#")[0] || "";
	const normalizedTarget = normalizeLinkPath(decodeURIComponent(withoutAnchor));
	const currentRelativeTarget = normalizeLinkPath(`${parentPath(currentFile.path)}/${normalizedTarget}`);
	const normalizedTargetWithExtension = normalizedTarget.endsWith(".md") ? normalizedTarget : `${normalizedTarget}.md`;
	const currentRelativeTargetWithExtension = currentRelativeTarget.endsWith(".md")
		? currentRelativeTarget
		: `${currentRelativeTarget}.md`;
	const candidates = [
		normalizedTarget,
		normalizedTarget.replace(/\.md$/i, ""),
		normalizedTargetWithExtension,
		currentRelativeTarget,
		currentRelativeTarget.replace(/\.md$/i, ""),
		currentRelativeTargetWithExtension
	];

	for (const candidate of candidates) {
		const linkTarget = linkMap.get(candidate);
		if (linkTarget) {
			return linkTarget;
		}
	}

	return null;
}

export function formatLarkDocReference(target: LinkTarget): string {
	const token = target.token || extractDocTokenFromUrl(target.url);
	if (!token) {
		return target.url;
	}

	return `<cite type="doc" doc-id="${escapeXmlAttribute(token)}"></cite>`;
}

export function normalizeLinkPath(path: string): string {
	const parts: string[] = [];

	for (const part of path.replace(/\\/g, "/").split("/")) {
		if (!part || part === ".") {
			continue;
		}
		if (part === "..") {
			parts.pop();
			continue;
		}
		parts.push(part);
	}

	return parts.join("/");
}

export function parentPath(path: string): string {
	const index = path.lastIndexOf("/");
	return index >= 0 ? path.slice(0, index) : "";
}

function extractDocTokenFromUrl(url: string): string {
	const match = url.match(/\/docx\/([^/?#]+)/);
	return match?.[1] || "";
}

function escapeXmlAttribute(value: string): string {
	return value.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
