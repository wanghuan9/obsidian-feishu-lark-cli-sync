export type TitleSource = "first-heading" | "file-name";

export interface NoteFile {
	basename: string;
}

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

function withMarkdownTitle(content: string, title: string): string {
	if (/^[ \t]*#[ \t]+/m.test(content)) {
		return content.replace(/^[ \t]*#[ \t]+.+?[ \t#]*$/m, `# ${title}`);
	}

	return `# ${title}\n\n${content}`;
}
