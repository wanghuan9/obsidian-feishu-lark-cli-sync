import { LocalImageResource } from "./local-image";
import { basename } from "path";

export interface RemoteMediaSnapshot {
	content: string;
	revisionId?: number;
}

export interface InsertedMedia {
	blockId: string;
}

export interface MediaSyncHost {
	fetchRemoteWithIds(): Promise<RemoteMediaSnapshot>;
	insertImage(image: LocalImageResource): Promise<InsertedMedia>;
	moveBlockAfter(blockId: string, targetBlockId: string): Promise<void>;
	deleteBlock(blockId: string, revisionId?: number): Promise<void>;
	removePlaceholder(placeholder: string, revisionId?: number): Promise<void>;
}

type PlaceholderLocation =
	| { mode: "standalone"; blockId: string; startIndex: number; endIndex: number }
	| { mode: "embedded-checkbox"; blockId: string; startIndex: number; endIndex: number };

export async function materializeLocalImages(
	images: LocalImageResource[],
	host: MediaSyncHost
): Promise<RemoteMediaSnapshot | undefined> {
	if (images.length === 0) {
		return undefined;
	}

	let snapshot = await host.fetchRemoteWithIds();
	for (const image of images) {
		const location = findPlaceholderLocation(snapshot.content, image.placeholder);
		if (!location) {
			continue;
		}

		// selection-with-ellipsis 会让飞书重建整篇文档的 block。先追加再移动，只影响新增图片和锚点。
		const insertedMedia = await host.insertImage(image);
		await host.moveBlockAfter(insertedMedia.blockId, location.blockId);
		snapshot = await host.fetchRemoteWithIds();
		const uploadedLocation = findPlaceholderLocation(snapshot.content, image.placeholder);
		if (!uploadedLocation || !hasImageAfter(snapshot.content, uploadedLocation, insertedMedia.blockId)) {
			throw new Error(`图片上传后未出现在预期位置：${image.vaultPath}`);
		}

		if (uploadedLocation.mode === "standalone") {
			await host.deleteBlock(uploadedLocation.blockId, snapshot.revisionId);
		} else {
			await host.removePlaceholder(image.placeholder, snapshot.revisionId);
		}
		snapshot = await host.fetchRemoteWithIds();
		if (snapshot.content.includes(image.placeholder)) {
			throw new Error(`图片占位块删除后仍然存在：${image.vaultPath}`);
		}
	}
	return snapshot;
}

export function buildMediaInsertArgs(
	doc: string,
	image: LocalImageResource
): string[] {
	const args = [
		"docs",
		"+media-insert",
		"--as",
		"user",
		"--doc",
		doc,
		"--file",
		`./${basename(image.absolutePath)}`,
		"--type",
		"image"
	];
	if (image.displayWidth) {
		args.push("--width", String(image.displayWidth));
	}
	if (image.displayHeight) {
		args.push("--height", String(image.displayHeight));
	}
	if (image.alt) {
		args.push("--caption", image.alt);
	}
	args.push("--json");
	return args;
}

export function buildMediaMoveArgs(doc: string, blockId: string, targetBlockId: string): string[] {
	return [
		"docs", "+update", "--api-version", "v2", "--as", "user", "--doc", doc,
		"--command", "block_move_after", "--block-id", targetBlockId,
		"--src-block-ids", blockId, "--json"
	];
}

export function buildPlaceholderRemoveArgs(
	doc: string,
	placeholder: string,
	revisionId?: number
): string[] {
	const args = [
		"docs", "+update", "--api-version", "v2", "--as", "user", "--doc", doc,
		"--command", "str_replace", "--pattern", placeholder, "--content", ""
	];
	if (revisionId !== undefined) {
		args.push("--revision-id", String(revisionId));
	}
	args.push("--json");
	return args;
}

function findPlaceholderLocation(remoteXml: string, placeholder: string): PlaceholderLocation | null {
	return findPlaceholderBlock(remoteXml, placeholder) || findEmbeddedCheckbox(remoteXml, placeholder);
}

function findPlaceholderBlock(
	remoteXml: string,
	placeholder: string
): Extract<PlaceholderLocation, { mode: "standalone" }> | null {
	const escapedPlaceholder = escapeRegExp(placeholder);
	const pattern = new RegExp(`<p\\b([^>]*)>\\s*${escapedPlaceholder}\\s*</p>`, "i");
	const match = pattern.exec(remoteXml);
	if (!match || match.index === undefined) {
		return null;
	}
	const blockId = readBlockId(match[1] || "");
	return blockId ? {
		mode: "standalone",
		blockId,
		startIndex: match.index,
		endIndex: match.index + match[0].length
	} : null;
}

function findEmbeddedCheckbox(
	remoteXml: string,
	placeholder: string
): Extract<PlaceholderLocation, { mode: "embedded-checkbox" }> | null {
	const escapedPlaceholder = escapeRegExp(placeholder);
	const checkboxContent = `(?:(?!<\\/checkbox>)[\\s\\S])*?${escapedPlaceholder}`
		+ "(?:(?!<\\/checkbox>)[\\s\\S])*?";
	const pattern = new RegExp(`<checkbox\\b([^>]*)>${checkboxContent}<\\/checkbox>`, "i");
	const match = pattern.exec(remoteXml);
	if (!match || match.index === undefined) {
		return null;
	}
	const blockId = readBlockId(match[1] || "");
	if (!blockId) {
		return null;
	}
	return {
		mode: "embedded-checkbox",
		blockId,
		startIndex: match.index,
		endIndex: match.index + match[0].length
	};
}

function hasImageAfter(
	remoteXml: string,
	location: PlaceholderLocation,
	blockId: string
): boolean {
	const adjacentContent = remoteXml.slice(location.endIndex).trimStart();
	const escapedBlockId = escapeRegExp(blockId);
	return new RegExp(`^<img\\b[^>]*\\bid=["']${escapedBlockId}["'][^>]*(?:\\/>|>[\\s\\S]*?<\\/img>)`, "i")
		.test(adjacentContent);
}

function readBlockId(attributes: string): string {
	for (const name of ["id", "block-id", "block_id", "blockId", "data-block-id"]) {
		const pattern = new RegExp(`\\s${name}=["']([^"']+)["']`);
		const match = attributes.match(pattern);
		if (match?.[1]) {
			return match[1];
		}
	}
	return "";
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
