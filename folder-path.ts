export function normalizePath(path: string): string {
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

export function getSelectedFolderName(folderPath: string): string {
	const normalizedFolderPath = normalizePath(folderPath);
	const segments = normalizedFolderPath.split("/").filter(Boolean);
	return segments[segments.length - 1] || normalizedFolderPath || "Untitled";
}

export function getRemoteParentPath(folderPath: string, filePath: string, remoteRoot: string): string {
	const normalizedFolderPath = normalizePath(folderPath);
	const relativeFilePath = normalizePath(filePath.slice(normalizedFolderPath.length).replace(/^\/+/, ""));
	const parent = parentPath(relativeFilePath);
	return normalizePath(`${remoteRoot}/${parent}`);
}

function parentPath(path: string): string {
	const index = path.lastIndexOf("/");
	return index >= 0 ? path.slice(0, index) : "";
}
