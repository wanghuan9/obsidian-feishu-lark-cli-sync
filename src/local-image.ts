import { createHash } from "crypto";
import { readdir, readFile, realpath } from "fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "path";

const LOCAL_IMAGE_PLACEHOLDER_PREFIX = "FEISHU_LARK_LOCAL_IMAGE_";
const SUPPORTED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

export interface LocalImageReference {
	sourceSyntax: string;
	target: string;
	alt?: string;
	displayWidth?: number;
	displayHeight?: number;
	start: number;
	end: number;
}

export interface LocalImageResource {
	placeholder: string;
	sourceSyntax: string;
	vaultPath: string;
	absolutePath: string;
	contentHash: string;
	mimeType: string;
	sourceWidth: number;
	sourceHeight: number;
	displayWidth?: number;
	displayHeight?: number;
	alt?: string;
}

export interface PreparedLocalImages {
	content: string;
	images: LocalImageResource[];
}

export interface LocalImageFileIndex {
	paths: Set<string>;
	pathsByBasename: Map<string, string[]>;
}

export interface PrepareLocalImagesInput {
	vaultRoot: string;
	markdownPath: string;
	content: string;
	imageIndex?: LocalImageFileIndex;
}

export interface FindReferencingMarkdownInput {
	vaultRoot: string;
	markdownPaths: string[];
	changedImagePaths: string[];
}

export class LocalImageError extends Error {
	readonly reason: string;
	readonly markdownPath: string;
	readonly imageReference: string;

	constructor(reason: string, markdownPath: string, imageReference: string, detail: string) {
		super(`${detail}（文档：${markdownPath}，图片：${imageReference}）`);
		this.reason = reason;
		this.markdownPath = markdownPath;
		this.imageReference = imageReference;
	}
}

export async function buildLocalImageFileIndex(vaultRoot: string): Promise<LocalImageFileIndex> {
	const paths = new Set<string>();
	const pathsByBasename = new Map<string, string[]>();
	await collectImageFiles(vaultRoot, vaultRoot, paths, pathsByBasename);
	return { paths, pathsByBasename };
}

export async function prepareLocalImages(input: PrepareLocalImagesInput): Promise<PreparedLocalImages> {
	const references = scanLocalImageReferences(input.content);
	if (references.length === 0) {
		return { content: input.content, images: [] };
	}

	const imageIndex = input.imageIndex || await buildLocalImageFileIndex(input.vaultRoot);
	const images: LocalImageResource[] = [];
	const occurrenceCounts = new Map<string, number>();
	for (const reference of references) {
		const vaultPath = resolveLocalImageVaultPath(reference.target, input.markdownPath, imageIndex);
		if (!vaultPath) {
			throw new LocalImageError(
				"image-missing",
				input.markdownPath,
				reference.sourceSyntax,
				"找不到本地图片"
			);
		}
		const occurrenceKey = JSON.stringify({
			vaultPath,
			displayWidth: reference.displayWidth,
			displayHeight: reference.displayHeight,
			alt: reference.alt
		});
		const occurrenceIndex = occurrenceCounts.get(occurrenceKey) || 0;
		occurrenceCounts.set(occurrenceKey, occurrenceIndex + 1);
		const image = await readLocalImage(
			input.vaultRoot,
			input.markdownPath,
			reference,
			vaultPath,
			occurrenceIndex
		);
		images.push(image);
	}

	return {
		content: replaceImageReferences(input.content, references, images),
		images
	};
}

export function scanLocalImageReferences(content: string): LocalImageReference[] {
	const references: LocalImageReference[] = [];
	let offset = 0;
	let fenceMarker = "";
	while (offset <= content.length) {
		const nextLineBreak = content.indexOf("\n", offset);
		const rawLine = content.slice(offset, nextLineBreak < 0 ? content.length : nextLineBreak);
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		const fenceMatch = line.match(/^\s{0,3}(```+|~~~+)/);
		if (fenceMatch?.[1]) {
			const marker = fenceMatch[1].slice(0, 3);
			if (!fenceMarker) {
				fenceMarker = marker;
			} else if (fenceMarker === marker) {
				fenceMarker = "";
			}
		} else if (!fenceMarker) {
			references.push(...scanLineImageReferences(line, offset));
		}
		if (nextLineBreak < 0) {
			break;
		}
		offset = nextLineBreak + 1;
	}
	return references.sort((left, right) => left.start - right.start);
}

export async function findReferencingMarkdownFiles(input: FindReferencingMarkdownInput): Promise<string[]> {
	const changedPaths = new Set(input.changedImagePaths.map(normalizeVaultPath));
	const changedBasenames = new Set(Array.from(changedPaths, (path) => basename(path)));
	const referencing = new Set<string>();
	for (const markdownPath of input.markdownPaths) {
		const absoluteMarkdownPath = resolve(input.vaultRoot, markdownPath);
		let content: string;
		try {
			content = await readFile(absoluteMarkdownPath, "utf8");
		} catch {
			continue;
		}
		const references = scanLocalImageReferences(content);
		if (references.some((reference) => referenceMayTargetChangedImage(reference, markdownPath, changedPaths,
			changedBasenames))) {
			referencing.add(normalizeVaultPath(markdownPath));
		}
	}
	return Array.from(referencing).sort();
}

export function isLocalImagePlaceholder(content: string): boolean {
	return new RegExp(`^${LOCAL_IMAGE_PLACEHOLDER_PREFIX}[a-f0-9]{64}$`).test(content.trim());
}

export function containsLocalImagePlaceholders(content: string): boolean {
	return content.replace(/\r\n/g, "\n").split("\n").some(isLocalImagePlaceholder);
}

export function isSupportedImagePath(path: string): boolean {
	return SUPPORTED_IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

function scanLineImageReferences(line: string, lineOffset: number): LocalImageReference[] {
	const references: LocalImageReference[] = [];
	const occupiedRanges: Array<{ start: number; end: number }> = [];
	const wikiPattern = /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
	let wikiMatch: RegExpExecArray | null;
	while ((wikiMatch = wikiPattern.exec(line))) {
		const sourceSyntax = wikiMatch[0] || "";
		const target = (wikiMatch[1] || "").trim();
		if (!target || !isSupportedImagePath(stripQueryAndFragment(target))) {
			continue;
		}
		const dimensions = parseWikiImageAlias(wikiMatch[2] || "");
		const start = lineOffset + wikiMatch.index;
		const end = start + sourceSyntax.length;
		references.push({
			sourceSyntax,
			target,
			alt: dimensions.alt,
			displayWidth: dimensions.width,
			displayHeight: dimensions.height,
			start,
			end
		});
		occupiedRanges.push({ start: wikiMatch.index, end: wikiMatch.index + sourceSyntax.length });
	}

	const markdownPattern = /!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(?:\s+["'][^)]*["'])?\)/g;
	let markdownMatch: RegExpExecArray | null;
	while ((markdownMatch = markdownPattern.exec(line))) {
		const relativeStart = markdownMatch.index;
		const relativeEnd = relativeStart + (markdownMatch[0] || "").length;
		if (occupiedRanges.some((range) => relativeStart < range.end && relativeEnd > range.start)) {
			continue;
		}
		const rawTarget = (markdownMatch[2] || "").replace(/^<|>$/g, "");
		if (/^https?:\/\//i.test(rawTarget) || !isSupportedImagePath(stripQueryAndFragment(rawTarget))) {
			continue;
		}
		const sourceSyntax = markdownMatch[0] || "";
		const start = lineOffset + relativeStart;
		references.push({
			sourceSyntax,
			target: rawTarget,
			alt: markdownMatch[1] || undefined,
			start,
			end: start + sourceSyntax.length
		});
	}
	return references;
}

function parseWikiImageAlias(alias: string): { width?: number; height?: number; alt?: string } {
	const normalizedAlias = alias.trim();
	const dimensions = normalizedAlias.match(/^(\d+)(?:x(\d+))?$/i);
	if (!dimensions?.[1]) {
		return normalizedAlias ? { alt: normalizedAlias } : {};
	}
	return {
		width: Number(dimensions[1]),
		height: dimensions[2] ? Number(dimensions[2]) : undefined
	};
}

function resolveLocalImageVaultPath(
	target: string,
	markdownPath: string,
	imageIndex: LocalImageFileIndex
): string | null {
	const decodedTarget = decodeImageTarget(target);
	if (!decodedTarget || isAbsolute(decodedTarget) || /^[A-Za-z]:[\\/]/.test(decodedTarget)) {
		throw new LocalImageError("image-outside-vault", markdownPath, target, "图片路径必须位于 Obsidian vault 内");
	}
	const rootCandidate = normalizePathInsideVault(decodedTarget);
	const relativeCandidate = normalizePathInsideVault(join(dirname(markdownPath), decodedTarget));
	if (!relativeCandidate) {
		throw new LocalImageError("image-outside-vault", markdownPath, target, "图片路径必须位于 Obsidian vault 内");
	}
	const exactCandidates = [relativeCandidate, rootCandidate].filter((candidate): candidate is string => Boolean(candidate))
		.filter((candidate, index, candidates) => {
		return candidates.indexOf(candidate) === index && imageIndex.paths.has(candidate);
	});
	if (exactCandidates.length === 1) {
		return exactCandidates[0] || null;
	}
	if (exactCandidates.length > 1) {
		throw new LocalImageError("image-path-ambiguous", markdownPath, target, "本地图片引用存在歧义");
	}

	const basenameMatches = imageIndex.pathsByBasename.get(basename(decodedTarget.replace(/\\/g, "/"))) || [];
	if (basenameMatches.length === 1) {
		return basenameMatches[0] || null;
	}
	if (basenameMatches.length > 1) {
		throw new LocalImageError("image-path-ambiguous", markdownPath, target, "存在多个同名本地图片，请使用明确路径");
	}
	return null;
}

async function readLocalImage(
	vaultRoot: string,
	markdownPath: string,
	reference: LocalImageReference,
	vaultPath: string,
	occurrenceIndex: number
): Promise<LocalImageResource> {
	const absoluteRoot = await realpath(vaultRoot);
	const absolutePath = await realpath(resolve(absoluteRoot, vaultPath));
	if (!isPathInsideRoot(absoluteRoot, absolutePath)) {
		throw new LocalImageError("image-outside-vault", markdownPath, reference.sourceSyntax,
			"图片解析结果位于 Obsidian vault 外");
	}
	let buffer: Buffer;
	try {
		buffer = await readFile(absolutePath);
	} catch (error) {
		throw new LocalImageError("image-read-failed", markdownPath, reference.sourceSyntax,
			error instanceof Error ? error.message : String(error));
	}
	const dimensions = readImageDimensions(buffer, extname(vaultPath).toLowerCase());
	if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
		throw new LocalImageError("image-format-unsupported", markdownPath, reference.sourceSyntax,
			"无法读取图片尺寸或图片格式不受支持");
	}
	const contentHash = createHash("sha256").update(buffer).digest("hex");
	const displayDimensions = calculateDisplayDimensions(reference, dimensions);
	const identity = JSON.stringify({
		markdownPath: normalizeVaultPath(markdownPath),
		vaultPath,
		contentHash,
		displayWidth: displayDimensions.width,
		displayHeight: displayDimensions.height,
		alt: reference.alt,
		occurrenceIndex
	});
	const placeholderHash = createHash("sha256").update(identity).digest("hex");
	return {
		placeholder: `${LOCAL_IMAGE_PLACEHOLDER_PREFIX}${placeholderHash}`,
		sourceSyntax: reference.sourceSyntax,
		vaultPath,
		absolutePath,
		contentHash,
		mimeType: mimeTypeForExtension(extname(vaultPath).toLowerCase()),
		sourceWidth: dimensions.width,
		sourceHeight: dimensions.height,
		displayWidth: displayDimensions.width,
		displayHeight: displayDimensions.height,
		alt: reference.alt
	};
}

function calculateDisplayDimensions(
	reference: LocalImageReference,
	dimensions: { width: number; height: number }
): { width?: number; height?: number } {
	if (!reference.displayWidth) {
		return {};
	}
	if (reference.displayHeight) {
		return { width: reference.displayWidth, height: reference.displayHeight };
	}
	return {
		width: reference.displayWidth,
		height: Math.max(1, Math.round(dimensions.height * reference.displayWidth / dimensions.width))
	};
}

function replaceImageReferences(
	content: string,
	references: LocalImageReference[],
	images: LocalImageResource[]
): string {
	let result = "";
	let cursor = 0;
	for (const [index, reference] of references.entries()) {
		const image = images[index];
		if (!image) {
			continue;
		}
		result += content.slice(cursor, reference.start);
		const lineStart = content.lastIndexOf("\n", reference.start - 1) + 1;
		const nextLineBreak = content.indexOf("\n", reference.end);
		const lineEnd = nextLineBreak < 0 ? content.length : nextLineBreak;
		const prefix = content.slice(lineStart, reference.start).trim();
		const suffix = content.slice(reference.end, lineEnd).trim();
		const previousLineStart = lineStart > 0 ? content.lastIndexOf("\n", lineStart - 2) + 1 : 0;
		const previousLine = lineStart > 0 ? content.slice(previousLineStart, lineStart - 1).trim() : "";
		const separatorBefore = prefix ? "\n\n" : previousLine ? "\n" : "";
		const separatorAfter = suffix ? "\n\n" : "";
		result += `${separatorBefore}${image.placeholder}${separatorAfter}`;
		cursor = reference.end;
	}
	return result + content.slice(cursor);
}

async function collectImageFiles(
	vaultRoot: string,
	directory: string,
	paths: Set<string>,
	pathsByBasename: Map<string, string[]>
): Promise<void> {
	const entries = await readdir(directory, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name === ".git" || entry.name === "node_modules") {
			continue;
		}
		const absolutePath = join(directory, entry.name);
		if (entry.isDirectory()) {
			await collectImageFiles(vaultRoot, absolutePath, paths, pathsByBasename);
			continue;
		}
		if (!entry.isFile() || !isSupportedImagePath(entry.name)) {
			continue;
		}
		const vaultPath = normalizeVaultPath(relative(vaultRoot, absolutePath));
		paths.add(vaultPath);
		const fileName = basename(vaultPath);
		const matches = pathsByBasename.get(fileName) || [];
		matches.push(vaultPath);
		pathsByBasename.set(fileName, matches);
	}
}

function referenceMayTargetChangedImage(
	reference: LocalImageReference,
	markdownPath: string,
	changedPaths: Set<string>,
	changedBasenames: Set<string>
): boolean {
	const target = normalizeVaultPath(decodeImageTarget(reference.target));
	const relativeCandidate = normalizeVaultPath(join(dirname(markdownPath), target));
	return changedPaths.has(target)
		|| changedPaths.has(relativeCandidate)
		|| (!target.includes("/") && changedBasenames.has(basename(target)));
}

function decodeImageTarget(target: string): string {
	const strippedTarget = stripQueryAndFragment(target).replace(/^<|>$/g, "");
	try {
		return decodeURIComponent(strippedTarget);
	} catch {
		return strippedTarget;
	}
}

function stripQueryAndFragment(target: string): string {
	return target.split(/[?#]/, 1)[0] || "";
}

function normalizeVaultPath(path: string): string {
	return path.replace(/\\/g, "/").split("/").reduce<string[]>((parts, part) => {
		if (!part || part === ".") {
			return parts;
		}
		if (part === "..") {
			parts.pop();
			return parts;
		}
		parts.push(part);
		return parts;
	}, []).join("/");
}

function normalizePathInsideVault(path: string): string | null {
	const parts: string[] = [];
	for (const part of path.replace(/\\/g, "/").split("/")) {
		if (!part || part === ".") {
			continue;
		}
		if (part === "..") {
			if (parts.length === 0) {
				return null;
			}
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return parts.join("/");
}

function isPathInsideRoot(root: string, path: string): boolean {
	return path === root || path.startsWith(`${root}${sep}`);
}

function mimeTypeForExtension(extension: string): string {
	const mimeTypes: Record<string, string> = {
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".webp": "image/webp",
		".bmp": "image/bmp"
	};
	return mimeTypes[extension] || "application/octet-stream";
}

function readImageDimensions(buffer: Buffer, extension: string): { width: number; height: number } | null {
	if (extension === ".png" && buffer.length >= 24
		&& buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
		return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
	}
	if (extension === ".gif" && buffer.length >= 10 && /^GIF8[79]a$/.test(buffer.toString("ascii", 0, 6))) {
		return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
	}
	if (extension === ".bmp" && buffer.length >= 26 && buffer.toString("ascii", 0, 2) === "BM") {
		return { width: Math.abs(buffer.readInt32LE(18)), height: Math.abs(buffer.readInt32LE(22)) };
	}
	if (extension === ".jpg" || extension === ".jpeg") {
		return readJpegDimensions(buffer);
	}
	if (extension === ".webp") {
		return readWebpDimensions(buffer);
	}
	return null;
}

function readJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
	let offset = 2;
	while (offset + 9 < buffer.length) {
		if (buffer[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		const marker = buffer[offset + 1] || 0;
		const length = buffer.readUInt16BE(offset + 2);
		if (length < 2 || offset + length + 2 > buffer.length) {
			return null;
		}
		if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
			|| (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
			return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
		}
		offset += length + 2;
	}
	return null;
}

function readWebpDimensions(buffer: Buffer): { width: number; height: number } | null {
	if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF"
		|| buffer.toString("ascii", 8, 12) !== "WEBP") {
		return null;
	}
	const type = buffer.toString("ascii", 12, 16);
	if (type === "VP8X") {
		return {
			width: 1 + buffer.readUIntLE(24, 3),
			height: 1 + buffer.readUIntLE(27, 3)
		};
	}
	if (type === "VP8 " && buffer.length >= 30) {
		return {
			width: buffer.readUInt16LE(26) & 0x3fff,
			height: buffer.readUInt16LE(28) & 0x3fff
		};
	}
	if (type === "VP8L" && buffer.length >= 25) {
		const bits = buffer.readUInt32LE(21);
		return {
			width: (bits & 0x3fff) + 1,
			height: ((bits >> 14) & 0x3fff) + 1
		};
	}
	return null;
}
