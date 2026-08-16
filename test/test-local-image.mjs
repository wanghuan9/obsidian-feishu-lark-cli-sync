import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildMediaInsertArgs,
	buildMediaMoveArgs,
	buildPlaceholderRemoveArgs,
	buildSyncPlan,
	createSyncContentSignature,
	findReferencingMarkdownFiles,
	invalidateLocalImageSyncState,
	materializeLocalImages,
	prepareLocalImages,
	scanLocalImageReferences
} from "../lark-sync-core.mjs";

const workspace = await mkdtemp(join(tmpdir(), "local-image-test-"));
try {
	await mkdir(join(workspace, "notes"), { recursive: true });
	await mkdir(join(workspace, "assets"), { recursive: true });
	await writeFile(join(workspace, "root.png"), createPngHeader(2, 1));
	await writeFile(join(workspace, "assets", "relative.png"), createPngHeader(8, 4));

	const markdown = [
		"- 结论 ![[root.png|600]]",
		"",
		"![[root.png|600x400]]",
		"",
		"![架构图](../assets/relative.png)",
		"",
		"![remote](https://example.com/remote.png)",
		"",
		"```md",
		"![[root.png]]",
		"~~~",
		"![[root.png]]",
		"```"
	].join("\n");
	const references = scanLocalImageReferences(markdown);
	assert.equal(references.length, 3);
	assert.equal(scanLocalImageReferences("第一行\r\n![[root.png]]\r\n")[0].sourceSyntax, "![[root.png]]");

	const prepared = await prepareLocalImages({
		vaultRoot: workspace,
		markdownPath: "notes/note.md",
		content: markdown
	});
	assert.equal(prepared.images.length, 3);
	assert.equal(prepared.images[0].vaultPath, "root.png");
	assert.equal(prepared.images[0].displayWidth, 600);
	assert.equal(prepared.images[0].displayHeight, 300);
	assert.equal(prepared.images[1].displayWidth, 600);
	assert.equal(prepared.images[1].displayHeight, 400);
	assert.equal(prepared.images[2].vaultPath, "assets/relative.png");
	assert.equal(prepared.images[2].alt, "架构图");
	assert.match(prepared.content, /- 结论\s+FEISHU_LARK_LOCAL_IMAGE_[a-f0-9]{64}/);
	assert.match(prepared.content, /!\[remote\]\(https:\/\/example\.com\/remote\.png\)/);
	assert.match(prepared.content, /```md\n!\[\[root\.png\]\]\n~~~\n!\[\[root\.png\]\]\n```/);
	const listAdjacentImage = await prepareLocalImages({
		vaultRoot: workspace,
		markdownPath: "notes/note.md",
		content: "- [ ] 验收交互\n![[root.png]]\n\n下一项"
	});
	assert.match(
		listAdjacentImage.content,
		/- \[ \] 验收交互\n\nFEISHU_LARK_LOCAL_IMAGE_[a-f0-9]{64}\n\n下一项/
	);
	const stableImage = await prepareLocalImages({
		vaultRoot: workspace,
		markdownPath: "notes/note.md",
		content: "![[root.png]]"
	});
	const legacyIdentity = JSON.stringify({
		markdownPath: "notes/note.md",
		vaultPath: stableImage.images[0].vaultPath,
		contentHash: stableImage.images[0].contentHash,
		alt: undefined,
		occurrenceIndex: 0
	});
	const legacyPlaceholder = `FEISHU_LARK_LOCAL_IMAGE_${createHash("sha256").update(legacyIdentity).digest("hex")}`;
	assert.equal(stableImage.images[0].placeholder, legacyPlaceholder);
	const shiftedStableImage = await prepareLocalImages({
		vaultRoot: workspace,
		markdownPath: "notes/note.md",
		content: "新增文字\n\n![[root.png]]"
	});
	assert.equal(stableImage.images[0].placeholder, shiftedStableImage.images[0].placeholder);
	const duplicatedImage = await prepareLocalImages({
		vaultRoot: workspace,
		markdownPath: "notes/note.md",
		content: "![[root.png]]\n\n![[root.png]]"
	});
	assert.notEqual(duplicatedImage.images[0].placeholder, duplicatedImage.images[1].placeholder);

	await writeFile(join(workspace, "notes", "note.md"), markdown);
	assert.deepEqual(await findReferencingMarkdownFiles({
		vaultRoot: workspace,
		markdownPaths: ["notes/note.md"],
		changedImagePaths: ["root.png"]
	}), ["notes/note.md"]);
	assert.deepEqual(await findReferencingMarkdownFiles({
		vaultRoot: workspace,
		markdownPaths: ["notes/note.md"],
		changedImagePaths: ["assets/relative.png"]
	}), ["notes/note.md"]);

	await assert.rejects(
		prepareLocalImages({
			vaultRoot: workspace,
			markdownPath: "notes/note.md",
			content: "![](../../outside.png)"
		}),
		(error) => error?.reason === "image-outside-vault"
	);

	await mkdir(join(workspace, "duplicate-a"));
	await mkdir(join(workspace, "duplicate-b"));
	await writeFile(join(workspace, "duplicate-a", "same.png"), createPngHeader(1, 1));
	await writeFile(join(workspace, "duplicate-b", "same.png"), createPngHeader(1, 1));
	await assert.rejects(
		prepareLocalImages({
			vaultRoot: workspace,
			markdownPath: "notes/note.md",
			content: "![[same.png]]"
		}),
		(error) => error?.reason === "image-path-ambiguous"
	);

	const [firstImage, secondImage] = prepared.images;
	let remoteXml = `<title id="title">Note</title><p id="first">${firstImage.placeholder}</p><p id="second">${secondImage.placeholder}</p>`;
	let revisionId = 1;
	const inserted = [];
	const moved = [];
	const deleted = [];
	const snapshot = await materializeLocalImages([firstImage, secondImage], {
		async fetchRemoteWithIds() {
			return { content: remoteXml, revisionId };
		},
		async insertImage(image) {
			inserted.push(image.placeholder);
			const blockId = `image-${inserted.length}`;
			remoteXml += `<img id="${blockId}"/>`;
			revisionId += 1;
			return { blockId };
		},
		async moveBlockAfter(blockId, targetBlockId) {
			moved.push([blockId, targetBlockId]);
			remoteXml = remoteXml.replace(`<img id="${blockId}"/>`, "")
				.replace(
					new RegExp(`(<p id="${targetBlockId}">[^<]+</p>)`),
					`$1<img id="${blockId}"/>`
				);
			revisionId += 1;
		},
		async deleteBlock(blockId) {
			deleted.push(blockId);
			remoteXml = remoteXml.replace(new RegExp(`<p id="${blockId}">[^<]+</p>`), "");
			revisionId += 1;
		}
	});
	assert.deepEqual(inserted, [firstImage.placeholder, secondImage.placeholder]);
	assert.deepEqual(moved, [["image-1", "first"], ["image-2", "second"]]);
	assert.deepEqual(deleted, ["first", "second"]);
	assert.doesNotMatch(snapshot.content, /FEISHU_LARK_LOCAL_IMAGE_/);

	let embeddedRemoteXml = `<checkbox id="task">验收交互<br/>${firstImage.placeholder}</checkbox><p id="next">下一项</p>`;
	let embeddedRevisionId = 1;
	const embeddedMoves = [];
	const removedPlaceholders = [];
	const embeddedSnapshot = await materializeLocalImages([firstImage], {
		async fetchRemoteWithIds() {
			return { content: embeddedRemoteXml, revisionId: embeddedRevisionId };
		},
		async insertImage() {
			embeddedRemoteXml += "<img id=\"embedded-image\"/>";
			embeddedRevisionId += 1;
			return { blockId: "embedded-image" };
		},
		async moveBlockAfter(blockId, targetBlockId) {
			embeddedMoves.push([blockId, targetBlockId]);
			embeddedRemoteXml = embeddedRemoteXml.replace(`<img id="${blockId}"/>`, "")
				.replace("</checkbox>", `</checkbox><img id="${blockId}"/>`);
			embeddedRevisionId += 1;
		},
		async deleteBlock() {
			assert.fail("嵌入待办块的占位符不应删除整个待办块");
		},
		async removePlaceholder(placeholder) {
			removedPlaceholders.push(placeholder);
			embeddedRemoteXml = embeddedRemoteXml.replace(placeholder, "");
			embeddedRevisionId += 1;
		}
	});
	assert.deepEqual(embeddedMoves, [["embedded-image", "task"]]);
	assert.deepEqual(removedPlaceholders, [firstImage.placeholder]);
	assert.match(embeddedSnapshot.content, /<checkbox id="task">验收交互<br\/><\/checkbox><img id="embedded-image"\/>/);
	assert.doesNotMatch(embeddedSnapshot.content, /FEISHU_LARK_LOCAL_IMAGE_/);

	const mediaArgs = buildMediaInsertArgs("doc-token", firstImage);
	assert.deepEqual(mediaArgs.slice(0, 2), ["docs", "+media-insert"]);
	assert.equal(mediaArgs[mediaArgs.indexOf("--file") + 1], "./root.png");
	assert.ok(!mediaArgs.includes("--selection-with-ellipsis"));
	assert.ok(!mediaArgs.includes("--before"));
	assert.ok(mediaArgs.includes("--width"));
	assert.ok(mediaArgs.includes("--height"));
	assert.deepEqual(buildMediaMoveArgs("doc-token", "image-block", "placeholder-block"), [
		"docs", "+update", "--api-version", "v2", "--as", "user", "--doc", "doc-token",
		"--command", "block_move_after", "--block-id", "placeholder-block",
		"--src-block-ids", "image-block", "--json"
	]);
	assert.deepEqual(buildPlaceholderRemoveArgs("doc-token", firstImage.placeholder, 7), [
		"docs", "+update", "--api-version", "v2", "--as", "user", "--doc", "doc-token",
		"--command", "str_replace", "--pattern", firstImage.placeholder, "--content", "",
		"--revision-id", "7", "--json"
	]);

	const baselineMarkdown = "- [ ] 验收交互\n\n下一项";
	const baselineSignature = await createSyncContentSignature(baselineMarkdown);
	const baselineState = {
		doc: "doc-token",
		contentHash: baselineSignature.contentHash,
		units: baselineSignature.units.map((unit, index) => ({
			stableId: `${index}:${unit.kind}`,
			kind: unit.kind,
			hash: unit.hash,
			blockId: `block-${index}`
		})),
		updatedAt: new Date(0).toISOString()
	};
	const addedImage = await prepareLocalImages({
		vaultRoot: workspace,
		markdownPath: "notes/note.md",
		content: "- [ ] 验收交互\n![[root.png]]\n\n下一项"
	});
	const addedImagePlan = await buildSyncPlan({
		doc: "doc-token",
		markdown: addedImage.content,
		contentFileName: "sync.md",
		strategy: "auto",
		state: baselineState
	});
	assert.equal(addedImagePlan.mode, "precise");
	assert.deepEqual(addedImagePlan.commands.map((command) => command.command), ["block_insert_after"]);

	const imageState = invalidateLocalImageSyncState({
		doc: "doc-token",
		contentHash: "content-hash",
		units: [
			{ stableId: "0:paragraph", kind: "paragraph", hash: "body", blockId: "body" },
			{ stableId: "1:img", kind: "img", hash: "image", blockId: "image" }
		],
		updatedAt: new Date(0).toISOString()
	});
	assert.equal(imageState.contentHash, "");
	assert.equal(imageState.units[0].hash, "body");
	assert.equal(imageState.units[1].hash, "");
} finally {
	await rm(workspace, { recursive: true, force: true });
}

console.log("local image tests passed");

function createPngHeader(width, height) {
	const buffer = Buffer.alloc(24);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
	buffer.writeUInt32BE(width, 16);
	buffer.writeUInt32BE(height, 20);
	return buffer;
}
