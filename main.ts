import { Menu, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";
import { execFile } from "child_process";
import { constants } from "fs";
import { access } from "fs/promises";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { promisify } from "util";
import {
	getRemoteParentPath as getSelectedRemoteParentPath,
	getSelectedFolderName as getSelectedRemoteRootName
} from "./folder-path";
import { LinkTarget, normalizeLinkPath, parentPath, resolveInternalLink, rewriteInternalLinks } from "./link-rewrite";

const execFileAsync = promisify(execFile);

const DEFAULT_SETTINGS: LarkCliSyncSettings = {
	language: "zh-CN",
	larkCliPath: "lark-cli",
	targetTokenOrUrl: "",
	folderBindings: {},
	titleSource: "first-heading",
	openAfterSync: true,
	updateFrontmatter: true
};

const FRONTMATTER_KEY = "lark_doc";
const MAX_STDERR_LENGTH = 1600;
const LARK_CLI_COMMAND = "lark-cli";
const FALLBACK_LOGIN_SHELLS = ["/bin/zsh", "/bin/bash", "/bin/sh"];
const FALLBACK_PATH_ENTRIES = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

type Language = "zh-CN" | "en";
type TitleSource = "first-heading" | "file-name";
type RemoteParentKind = "wiki" | "drive" | "my_library" | "unknown";

interface LarkCliSyncSettings {
	language: Language;
	larkCliPath: string;
	targetTokenOrUrl: string;
	folderBindings: Record<string, BoundLarkDocument>;
	titleSource: TitleSource;
	openAfterSync: boolean;
	updateFrontmatter: boolean;
}

interface BoundLarkDocument {
	token: string;
	url: string;
	containerToken?: string;
	containerKind?: RemoteParentKind;
	remoteParentPath?: string;
	remoteRoot?: string;
	lastSyncedAt?: string;
}

interface LarkCommandResult {
	ok: boolean;
	data?: {
		token?: string;
		document?: {
			document_id?: string;
			url?: string;
		};
		folder?: {
			token?: string;
			url?: string;
		};
		node?: {
			node_token?: string;
			obj_token?: string;
			url?: string;
		};
		node_token?: string;
		obj_token?: string;
		url?: string;
		wiki_node?: {
			node_token?: string;
			obj_token?: string;
		};
	};
	error?: {
		message?: string;
		hint?: string;
	};
}

interface LarkCommandOptions {
	cwd?: string;
}

interface FolderPublishEntry {
	file: TFile;
	content: string;
	binding?: BoundLarkDocument;
}

interface RemoteParent {
	token: string;
	kind: RemoteParentKind;
}

const MESSAGES = {
	"zh-CN": {
		commandPublishCurrentNote: "发布当前笔记到飞书",
		commandSyncCurrentNote: "同步当前笔记到飞书",
		menuPublishToLark: "发布到飞书",
		menuSyncToLark: "同步到飞书",
		menuPublishFolderToLark: "发布整个目录到飞书",
		ribbonSyncCurrentNote: "同步当前笔记到飞书",
		noticeNoActiveMarkdownNote: "当前没有打开 Markdown 笔记。",
		noticePublishingToLark: "正在发布到飞书...",
		noticeSyncingToLark: "正在同步到飞书...",
		noticePublishingFolderToLark: "正在发布目录到飞书...",
		noticeNoMarkdownFilesInFolder: "该目录下没有 Markdown 文件。",
		noticePublishedToLark: "已发布到飞书",
		noticeSyncedToLark: "已同步到飞书",
		noticePublishedFolderToLark: "已发布 {count} 篇笔记到飞书。",
		noticeSyncFailed: "飞书同步失败：{message}",
		noticeRemoteDeletedRecreate: "远端文档已删除，正在重新创建...",
		errorNoDocumentToken: "lark-cli 没有返回文档 token 或 URL。",
		settingsTitle: "Lark CLI Sync",
		settingLanguageName: "语言",
		settingLanguageDesc: "切换插件设置、菜单和通知的显示语言。",
		languageChinese: "中文",
		languageEnglish: "English",
		settingLarkCliPathName: "lark-cli 路径",
		settingLarkCliPathDesc: "用于执行 lark-cli 的命令或绝对路径。保持默认值时会自动探测。",
		settingDefaultTargetName: "默认上传位置",
		settingDefaultTargetDesc: "填写 Wiki URL、Wiki 节点 token、文件夹 token；留空则上传到个人文档库。",
		settingTitleSourceName: "标题来源",
		settingTitleSourceDesc: "可使用第一个 Markdown 标题，或始终使用文件名。",
		titleSourceFirstHeading: "第一个标题",
		titleSourceFileName: "文件名",
		settingWriteBindingName: "写入 frontmatter 绑定信息",
		settingWriteBindingDesc: "发布后把飞书文档 token 和 URL 保存到笔记 frontmatter。",
		settingOpenAfterSyncName: "同步后打开文档",
		settingOpenAfterSyncDesc: "发布或同步成功后，在浏览器中打开飞书文档。"
	},
	en: {
		commandPublishCurrentNote: "Publish current note to Lark",
		commandSyncCurrentNote: "Sync current note to Lark",
		menuPublishToLark: "Publish to Lark",
		menuSyncToLark: "Sync to Lark",
		menuPublishFolderToLark: "Publish folder to Lark",
		ribbonSyncCurrentNote: "Sync current note to Lark",
		noticeNoActiveMarkdownNote: "No active Markdown note.",
		noticePublishingToLark: "Publishing to Lark...",
		noticeSyncingToLark: "Syncing to Lark...",
		noticePublishingFolderToLark: "Publishing folder to Lark...",
		noticeNoMarkdownFilesInFolder: "No Markdown files found in this folder.",
		noticePublishedToLark: "Published to Lark",
		noticeSyncedToLark: "Synced to Lark",
		noticePublishedFolderToLark: "Published {count} notes to Lark.",
		noticeSyncFailed: "Lark sync failed: {message}",
		noticeRemoteDeletedRecreate: "Remote document was deleted. Creating a new document...",
		errorNoDocumentToken: "lark-cli did not return a document token or URL.",
		settingsTitle: "Lark CLI Sync",
		settingLanguageName: "Language",
		settingLanguageDesc: "Switch the display language for settings, menus, and notices.",
		languageChinese: "中文",
		languageEnglish: "English",
		settingLarkCliPathName: "lark-cli path",
		settingLarkCliPathDesc: "Command or absolute path used to run lark-cli. Keep the default for auto-detection.",
		settingDefaultTargetName: "Default target",
		settingDefaultTargetDesc: "Wiki URL, wiki node token, folder token, or blank for personal library.",
		settingTitleSourceName: "Title source",
		settingTitleSourceDesc: "Use the first Markdown heading when available, or always use the file name.",
		titleSourceFirstHeading: "First heading",
		titleSourceFileName: "File name",
		settingWriteBindingName: "Write binding to frontmatter",
		settingWriteBindingDesc: "Store the Lark document token and URL in the note after publishing.",
		settingOpenAfterSyncName: "Open after sync",
		settingOpenAfterSyncDesc: "Open the Lark document in your browser after publish or sync succeeds."
	}
} as const;

type MessageKey = keyof typeof MESSAGES.en;

export default class LarkCliSyncPlugin extends Plugin {
	settings!: LarkCliSyncSettings;

	override async onload(): Promise<void> {
		await this.loadSettings();

		this.addCommand({
			id: "publish-current-note-to-lark",
			name: this.t("commandPublishCurrentNote"),
			callback: () => {
				void this.publishCurrentNote();
			}
		});

		this.addCommand({
			id: "sync-current-note-to-lark",
			name: this.t("commandSyncCurrentNote"),
			callback: () => {
				void this.syncCurrentNote();
			}
		});

		this.addRibbonIcon("upload", this.t("ribbonSyncCurrentNote"), () => {
			void this.syncCurrentNote();
		});

		this.registerEvent(this.app.workspace.on("file-menu", (menu: Menu, file) => {
			if (file instanceof TFile && file.extension === "md") {
				menu.addItem((item) => {
					item.setTitle(this.t("menuPublishToLark")).setIcon("upload").onClick(() => {
						void this.publishFile(file);
					});
				});
				menu.addItem((item) => {
					item.setTitle(this.t("menuSyncToLark")).setIcon("refresh-cw").onClick(() => {
						void this.syncFile(file);
					});
				});
			}

			if ("children" in file) {
				menu.addItem((item) => {
					item.setTitle(this.t("menuPublishFolderToLark")).setIcon("folder-up").onClick(() => {
						void this.publishFolder(file.path);
					});
				});
			}
		}));

		this.addSettingTab(new LarkCliSyncSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		const savedSettings = await this.loadData() as Partial<LarkCliSyncSettings> | null;
		this.settings = {
			...DEFAULT_SETTINGS,
			...savedSettings,
			folderBindings: {
				...DEFAULT_SETTINGS.folderBindings,
				...(savedSettings?.folderBindings || {})
			}
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private async publishCurrentNote(): Promise<void> {
		const file = this.getActiveMarkdownFile();
		if (!file) {
			new Notice(this.t("noticeNoActiveMarkdownNote"));
			return;
		}

		await this.publishFile(file);
	}

	private async syncCurrentNote(): Promise<void> {
		const file = this.getActiveMarkdownFile();
		if (!file) {
			new Notice(this.t("noticeNoActiveMarkdownNote"));
			return;
		}

		await this.syncFile(file);
	}

	private async publishFile(file: TFile): Promise<void> {
		await this.runWithNotice(this.t("noticePublishingToLark"), async () => {
			const content = await this.readNoteForLark(file);
			const result = await this.createLarkDocument(file, content);

			if (this.settings.updateFrontmatter) {
				await this.writeBinding(file, result);
			}

			this.showSuccess(this.t("noticePublishedToLark"), result.url);
			this.openUrlIfNeeded(result.url);
		});
	}

	private async syncFile(file: TFile): Promise<void> {
		await this.runWithNotice(this.t("noticeSyncingToLark"), async () => {
			const binding = this.getBinding(file);
			if (!binding) {
				const content = await this.readNoteForLark(file);
				const result = await this.createLarkDocument(file, content);

				if (this.settings.updateFrontmatter) {
					await this.writeBinding(file, result);
				}

				this.showSuccess(this.t("noticePublishedToLark"), result.url);
				this.openUrlIfNeeded(result.url);
				return;
			}

			const content = await this.readNoteForLark(file);
			const nextBinding = await this.syncOrRecreateDocument(file, binding, content);

			if (this.settings.updateFrontmatter) {
				await this.writeBinding(file, nextBinding);
			}

			this.showSuccess(this.t("noticeSyncedToLark"), nextBinding.url);
			this.openUrlIfNeeded(nextBinding.url);
		});
	}

	private async publishFolder(folderPath: string): Promise<void> {
		await this.runWithNotice(this.t("noticePublishingFolderToLark"), async () => {
			const files = this.collectMarkdownFiles(folderPath);
			if (files.length === 0) {
				new Notice(this.t("noticeNoMarkdownFilesInFolder"));
				return;
			}

			const entries: FolderPublishEntry[] = [];
			const linkMap = new Map<string, LinkTarget>();
			const folderRoot = this.getSelectedFolderName(folderPath);
			const rootParent = await this.resolveRemoteRootParent();

			for (const file of files) {
				const content = await this.readNoteForLark(file);
				const binding = this.getBinding(file);
				const documentParentPath = this.getRemoteParentPath(folderPath, file, folderRoot);
				const documentParent = await this.ensureRemoteFolderPath(rootParent, documentParentPath);
				const reusableBinding = binding && this.isBindingInRemoteParent(
					binding,
					folderRoot,
					documentParentPath,
					documentParent
				) ? binding : null;
				const nextBinding = reusableBinding
					? await this.syncOrRecreateDocument(file, reusableBinding, content, documentParent)
					: await this.createLarkDocument(file, content, documentParent);
				const nextBindingWithParent = this.withRemoteParentMetadata(
					nextBinding,
					folderRoot,
					documentParentPath,
					documentParent
				);

				entries.push({ file, content, binding: nextBindingWithParent });
				this.addLinkAliases(linkMap, folderPath, file, nextBindingWithParent);

				if (this.settings.updateFrontmatter) {
					await this.writeBinding(file, nextBindingWithParent);
				}
			}

			for (const entry of entries) {
				if (!entry.binding) {
					continue;
				}

				const rewrittenContent = this.rewriteInternalLinks(entry.content, linkMap, entry.file);
				await this.updateLarkDocument(entry.binding.token || entry.binding.url, rewrittenContent);
			}

			new Notice(this.t("noticePublishedFolderToLark", { count: String(entries.length) }), 8000);
		});
	}

	private getActiveMarkdownFile(): TFile | null {
		const file = this.app.workspace.getActiveFile();
		if (file instanceof TFile && file.extension === "md") {
			return file;
		}
		return null;
	}

	private collectMarkdownFiles(folderPath: string): TFile[] {
		return this.app.vault.getMarkdownFiles()
			.filter((file) => file.path === folderPath || file.path.startsWith(`${folderPath}/`))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	private async readNoteForLark(file: TFile): Promise<string> {
		const rawContent = await this.app.vault.read(file);
		const contentWithoutBinding = this.removeLarkBinding(rawContent);
		const title = this.extractTitle(file, contentWithoutBinding);

		if (/^\s*#\s+/m.test(contentWithoutBinding)) {
			return contentWithoutBinding;
		}

		return `# ${title}\n\n${contentWithoutBinding}`;
	}

	private extractTitle(file: TFile, content: string): string {
		if (this.settings.titleSource === "file-name") {
			return file.basename;
		}

		const heading = content.match(/^\s*#\s+(.+?)\s*#*\s*$/m);
		return heading?.[1]?.trim() || file.basename;
	}

	private getBinding(file: TFile): BoundLarkDocument | null {
		const cache = this.app.metadataCache.getFileCache(file);
		const value = cache?.frontmatter?.[FRONTMATTER_KEY] as unknown;
		if (!value || typeof value !== "object") {
			return null;
		}

		const candidate = value as Partial<BoundLarkDocument>;
		if (!candidate.token && !candidate.url) {
			return null;
		}

		return {
			token: candidate.token || "",
			url: candidate.url || "",
			containerToken: candidate.containerToken,
			containerKind: candidate.containerKind,
			remoteRoot: candidate.remoteRoot,
			remoteParentPath: candidate.remoteParentPath,
			lastSyncedAt: candidate.lastSyncedAt
		};
	}

	private async createLarkDocument(file: TFile, content: string, parent?: RemoteParent): Promise<BoundLarkDocument> {
		return await this.withTempMarkdown(file.basename, content, async (tempFile) => {
			const args = ["docs", "+create", "--api-version", "v2", "--as", "user", "--doc-format", "markdown",
				"--content", `@${tempFile.fileName}`, "--json"];

			const remoteParent = parent || await this.resolveRemoteRootParent();
			if (remoteParent.token) {
				args.push("--parent-token", remoteParent.token);
			} else {
				args.push("--parent-position", "my_library");
			}

			const result = await this.runLarkCli(args, { cwd: tempFile.directory });
			const document = result.data?.document;
			const token = document?.document_id;
			const url = document?.url;

			if (!token || !url) {
				throw new Error(this.t("errorNoDocumentToken"));
			}

			return {
				token,
				url,
				lastSyncedAt: new Date().toISOString()
			};
		});
	}

	private async updateLarkDocument(doc: string, content: string): Promise<Partial<BoundLarkDocument>> {
		return await this.withTempMarkdown("sync", content, async (tempFile) => {
			const result = await this.runLarkCli(["docs", "+update", "--api-version", "v2", "--as", "user", "--doc",
				doc, "--command", "overwrite", "--doc-format", "markdown", "--content", `@${tempFile.fileName}`, "--json"], {
				cwd: tempFile.directory
			});
			const document = result.data?.document;

			return {
				token: document?.document_id,
				url: document?.url,
				lastSyncedAt: new Date().toISOString()
			};
		});
	}

	private async syncOrRecreateDocument(
		file: TFile,
		binding: BoundLarkDocument,
		content: string,
		parent?: RemoteParent
	): Promise<BoundLarkDocument> {
		try {
			const result = await this.updateLarkDocument(binding.token || binding.url, content);

			return {
				token: result.token || binding.token,
				url: result.url || binding.url,
				lastSyncedAt: new Date().toISOString()
			};
		} catch (error) {
			if (!this.isRemoteDocumentDeletedError(error)) {
				throw error;
			}

			new Notice(this.t("noticeRemoteDeletedRecreate"), 5000);
			return await this.createLarkDocument(file, content, parent);
		}
	}

	private addLinkAliases(
		linkMap: Map<string, LinkTarget>,
		folderPath: string,
		file: TFile,
		binding: BoundLarkDocument
	): void {
		const aliases = new Set<string>();
		const target = this.toLinkTarget(file, binding);
		const normalizedPath = this.normalizeLinkPath(file.path);
		const relativeToFolder = this.normalizeLinkPath(file.path.slice(folderPath.length).replace(/^\/+/, ""));

		aliases.add(normalizedPath);
		aliases.add(relativeToFolder);
		aliases.add(file.name);
		aliases.add(file.basename);
		aliases.add(this.normalizeLinkPath(file.path.replace(/\.md$/i, "")));
		aliases.add(relativeToFolder.replace(/\.md$/i, ""));

		for (const alias of aliases) {
			if (alias) {
				linkMap.set(alias, target);
			}
		}
	}

	private toLinkTarget(file: TFile, binding: BoundLarkDocument): LinkTarget {
		return {
			token: binding.token,
			url: binding.url,
			label: file.basename
		};
	}

	private rewriteInternalLinks(content: string, linkMap: Map<string, LinkTarget>, currentFile: TFile): string {
		return rewriteInternalLinks(content, linkMap, currentFile);
	}

	private resolveInternalLink(target: string, linkMap: Map<string, LinkTarget>, currentFile: TFile): LinkTarget | null {
		return resolveInternalLink(target, linkMap, currentFile);
	}

	private normalizeLinkPath(path: string): string {
		return normalizeLinkPath(path);
	}

	private parentPath(path: string): string {
		return parentPath(path);
	}

	private async ensureRemoteFolderPath(rootParent: RemoteParent, folderPath: string): Promise<RemoteParent> {
		const normalizedFolderPath = this.normalizeLinkPath(folderPath);
		if (!normalizedFolderPath) {
			return rootParent;
		}

		let parent = rootParent;
		const segments = normalizedFolderPath.split("/").filter(Boolean);
		for (let index = 0; index < segments.length; index += 1) {
			const partialPath = segments.slice(0, index + 1).join("/");
			const bindingKey = this.getFolderBindingKey(rootParent, partialPath);
			const existingBinding = this.settings.folderBindings[bindingKey];

			if (existingBinding?.token) {
				parent = {
					token: existingBinding.token,
					kind: existingBinding.containerKind || parent.kind
				};
				continue;
			}

			const folderBinding = await this.createRemoteFolderPage(segments[index] || "Untitled", parent);
			this.settings.folderBindings[bindingKey] = folderBinding;
			await this.saveSettings();
			parent = {
				token: folderBinding.token,
				kind: folderBinding.containerKind || parent.kind
			};
		}

		return parent;
	}

	private async createRemoteFolderPage(name: string, parent: RemoteParent): Promise<BoundLarkDocument> {
		if (parent.kind === "drive") {
			const result = await this.runLarkCli(["drive", "+create-folder", "--as", "user",
				"--folder-token", parent.token, "--name", name, "--json"]);
			const token = result.data?.folder?.token || result.data?.token;
			const url = result.data?.folder?.url || result.data?.url || "";

			if (!token) {
				throw new Error(this.t("errorNoDocumentToken"));
			}

			return {
				token,
				url,
				containerToken: parent.token,
				containerKind: "drive",
				lastSyncedAt: new Date().toISOString()
			};
		}

		if (parent.kind === "wiki" || parent.kind === "my_library") {
			return await this.createWikiNodePage(name, parent);
		}

		return await this.createLarkDocumentLikePage(name, parent);
	}

	private async createWikiNodePage(name: string, parent: RemoteParent): Promise<BoundLarkDocument> {
		const args = ["wiki", "+node-create", "--as", "user", "--title", name, "--obj-type", "docx", "--json"];
		if (parent.kind === "my_library" && !parent.token) {
			args.push("--space-id", "my_library");
		} else {
			args.push("--parent-node-token", parent.token);
		}

		const result = await this.runLarkCli(args);
		const token = result.data?.node_token || result.data?.node?.node_token;
		const url = result.data?.url || result.data?.node?.url || "";

		if (!token) {
			throw new Error(this.t("errorNoDocumentToken"));
		}

		return {
			token,
			url,
			containerToken: parent.token,
			containerKind: parent.kind,
			lastSyncedAt: new Date().toISOString()
		};
	}

	private async createLarkDocumentLikePage(name: string, parent: RemoteParent): Promise<BoundLarkDocument> {
		const content = `# ${name}\n`;
		return await this.withTempMarkdown(name, content, async (tempFile) => {
			const args = ["docs", "+create", "--api-version", "v2", "--as", "user", "--doc-format", "markdown",
				"--content", `@${tempFile.fileName}`, "--json"];

			if (parent.token) {
				args.push("--parent-token", parent.token);
			} else {
				args.push("--parent-position", "my_library");
			}

			const result = await this.runLarkCli(args, { cwd: tempFile.directory });
			const document = result.data?.document;
			const token = result.data?.wiki_node?.node_token || document?.document_id;
			const url = document?.url || result.data?.url || "";

			if (!token || !url) {
				throw new Error(this.t("errorNoDocumentToken"));
			}

			return {
				token,
				url,
				containerToken: parent.token,
				containerKind: parent.kind,
				lastSyncedAt: new Date().toISOString()
			};
		});
	}

	private getRemoteParentPath(folderPath: string, file: TFile, remoteRoot: string): string {
		return getSelectedRemoteParentPath(folderPath, file.path, remoteRoot);
	}

	private getSelectedFolderName(folderPath: string): string {
		return getSelectedRemoteRootName(folderPath);
	}

	private withRemoteParentMetadata(
		binding: BoundLarkDocument,
		remoteRoot: string,
		remoteParentPath: string,
		parent: RemoteParent
	): BoundLarkDocument {
		return {
			...binding,
			containerToken: parent.token,
			containerKind: parent.kind,
			remoteRoot,
			remoteParentPath
		};
	}

	private isBindingInRemoteParent(
		binding: BoundLarkDocument,
		remoteRoot: string,
		remoteParentPath: string,
		parent: RemoteParent
	): boolean {
		return binding.remoteRoot === remoteRoot
			&& binding.remoteParentPath === remoteParentPath
			&& binding.containerToken === parent.token
			&& binding.containerKind === parent.kind;
	}

	private getFolderBindingKey(rootParent: RemoteParent, folderPath: string): string {
		const target = this.settings.targetTokenOrUrl.trim() || "my_library";
		return `${target}|${rootParent.kind}|${rootParent.token}|${this.normalizeLinkPath(folderPath)}`;
	}

	private async resolveRemoteRootParent(): Promise<RemoteParent> {
		const target = this.settings.targetTokenOrUrl.trim();
		if (!target) {
			return {
				token: "",
				kind: "my_library"
			};
		}

		if (!/^https?:\/\//.test(target)) {
			return {
				token: target,
				kind: "unknown"
			};
		}

		const result = await this.runLarkCli(["drive", "+inspect", "--as", "user", "--url", target, "--json"]);
		const kind = target.includes("/drive/folder/") ? "drive" : "wiki";
		const token = kind === "drive"
			? result.data?.token || this.extractPathToken(target)
			: result.data?.wiki_node?.node_token || result.data?.node?.node_token || result.data?.token || this.extractPathToken(target);

		return {
			token,
			kind
		};
	}

	private async resolveParentToken(): Promise<string> {
		const target = this.settings.targetTokenOrUrl.trim();
		if (!target) {
			return "";
		}

		if (!/^https?:\/\//.test(target)) {
			return target;
		}

		const result = await this.runLarkCli(["drive", "+inspect", "--as", "user", "--url", target, "--json"]);
		const wikiNodeToken = result.data?.wiki_node?.node_token;

		return wikiNodeToken || result.data?.token || target;
	}

	private extractPathToken(url: string): string {
		const match = url.match(/\/(?:wiki|folder|docx|doc)\/([^/?#]+)/);
		return match?.[1] || "";
	}

	private async runLarkCli(args: string[], options: LarkCommandOptions = {}): Promise<LarkCommandResult> {
		try {
			const executable = await this.resolveLarkCliPath();
			const env = await this.buildCommandEnvironment(executable);
			const { stdout } = await execFileAsync(executable, args, {
				cwd: options.cwd,
				env,
				maxBuffer: 20 * 1024 * 1024
			});
			const result = JSON.parse(stdout) as LarkCommandResult;

			if (!result.ok) {
				throw new Error(this.formatLarkError(result));
			}

			return result;
		} catch (error) {
			throw new Error(this.formatCommandError(error));
		}
	}

	private formatLarkError(result: LarkCommandResult): string {
		const message = result.error?.message || "lark-cli request failed.";
		const hint = result.error?.hint;
		return hint ? `${message}\n${hint}` : message;
	}

	private formatCommandError(error: unknown): string {
		if (error instanceof Error && "stderr" in error) {
			const stderr = String((error as Error & { stderr?: string }).stderr || "").trim();
			if (stderr) {
				return this.formatStderr(stderr);
			}
		}

		if (error instanceof Error) {
			return error.message;
		}

		return String(error);
	}

	private formatStderr(stderr: string): string {
		try {
			const parsed = JSON.parse(stderr) as LarkCommandResult;
			if (parsed.error?.message) {
				return this.formatLarkError(parsed);
			}
		} catch {
			// stderr is often plain text from node or shell.
		}

		return stderr.slice(0, MAX_STDERR_LENGTH);
	}

	private isRemoteDocumentDeletedError(error: unknown): boolean {
		const message = error instanceof Error ? error.message : String(error);
		return message.includes("3380003")
			|| message.toLowerCase().includes("document page has been deleted")
			|| message.toLowerCase().includes("no longer be edited");
	}

	private async buildCommandEnvironment(executable: string): Promise<NodeJS.ProcessEnv> {
		const pathEntries = this.getDefaultPathEntries();
		if (executable.startsWith("/")) {
			pathEntries.unshift(dirname(executable));
		}

		const shellPath = await this.getLoginShellPath();
		if (shellPath) {
			pathEntries.unshift(...shellPath.split(":").filter(Boolean));
		}

		const currentPath = process.env.PATH;
		if (currentPath) {
			pathEntries.push(currentPath);
		}

		return {
			...process.env,
			PATH: this.uniquePathEntries(pathEntries).join(":")
		};
	}

	private async resolveLarkCliPath(): Promise<string> {
		const configuredPath = this.settings.larkCliPath.trim();
		if (configuredPath && configuredPath !== LARK_CLI_COMMAND) {
			return configuredPath;
		}

		const shellPath = await this.resolveCommandFromLoginShell(LARK_CLI_COMMAND);
		if (shellPath) {
			return shellPath;
		}

		const candidates = [
			join(homedir(), ".npm-global/bin/lark-cli"),
			join(homedir(), ".local/bin/lark-cli"),
			join(homedir(), "bin/lark-cli"),
			"/opt/homebrew/bin/lark-cli",
			"/usr/local/bin/lark-cli",
			LARK_CLI_COMMAND
		];

		for (const candidate of candidates) {
			if (candidate === LARK_CLI_COMMAND) {
				return candidate;
			}

			if (await this.canExecute(candidate)) {
				return candidate;
			}
		}

		return LARK_CLI_COMMAND;
	}

	private getDefaultPathEntries(): string[] {
		return [
			join(homedir(), ".npm-global/bin"),
			join(homedir(), ".local/bin"),
			join(homedir(), "bin"),
			...FALLBACK_PATH_ENTRIES
		];
	}

	private async resolveCommandFromLoginShell(command: string): Promise<string> {
		for (const shell of this.getShellCandidates()) {
			try {
				const { stdout } = await execFileAsync(shell, ["-lc", `command -v ${command}`], {
					maxBuffer: 1024 * 1024
				});
				const resolvedPath = stdout.trim().split(/\r?\n/)[0] || "";
				if (resolvedPath) {
					return resolvedPath;
				}
			} catch {
				// Try the next shell candidate.
			}
		}

		return "";
	}

	private async getLoginShellPath(): Promise<string> {
		for (const shell of this.getShellCandidates()) {
			try {
				const { stdout } = await execFileAsync(shell, ["-lc", "printf %s \"$PATH\""], {
					maxBuffer: 1024 * 1024
				});
				const path = stdout.trim();
				if (path) {
					return path;
				}
			} catch {
				// Try the next shell candidate.
			}
		}

		return "";
	}

	private getShellCandidates(): string[] {
		const candidates = [process.env.SHELL || "", ...FALLBACK_LOGIN_SHELLS];
		return this.uniquePathEntries(candidates);
	}

	private uniquePathEntries(entries: string[]): string[] {
		const seen = new Set<string>();
		const result: string[] = [];

		for (const entry of entries) {
			if (entry && !seen.has(entry)) {
				seen.add(entry);
				result.push(entry);
			}
		}

		return result;
	}

	private async canExecute(path: string): Promise<boolean> {
		try {
			await access(path, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	}

	private async withTempMarkdown<T>(
		baseName: string,
		content: string,
		callback: (file: { directory: string; fileName: string }) => Promise<T>
	): Promise<T> {
		const tempDir = await mkdtemp(join(tmpdir(), "obsidian-lark-sync-"));
		const fileName = `${this.sanitizeFileName(baseName)}.md`;
		const tempPath = join(tempDir, fileName);

		try {
			await writeFile(tempPath, content, "utf8");
			return await callback({ directory: tempDir, fileName });
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	}

	private sanitizeFileName(name: string): string {
		return name.replace(/[\\/:*?"<>|]/g, "-").trim() || "note";
	}

	private async writeBinding(file: TFile, binding: BoundLarkDocument): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			frontmatter[FRONTMATTER_KEY] = {
				token: binding.token,
				url: binding.url,
				containerToken: binding.containerToken,
				containerKind: binding.containerKind,
				remoteRoot: binding.remoteRoot,
				remoteParentPath: binding.remoteParentPath,
				lastSyncedAt: binding.lastSyncedAt || new Date().toISOString()
			};
		});
	}

	private removeLarkBinding(content: string): string {
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
		const filteredLines = this.removeYamlObject(frontmatter.split(/\r?\n/), FRONTMATTER_KEY);

		if (filteredLines.every((line) => line.trim() === "")) {
			return body.replace(/^\s+/, "");
		}

		return `---\n${filteredLines.join("\n").trim()}\n---\n${body}`;
	}

	private removeYamlObject(lines: string[], key: string): string[] {
		const result: string[] = [];
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

				if (!skipping && name === key) {
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

	private async runWithNotice(message: string, callback: () => Promise<void>): Promise<void> {
		const notice = new Notice(message, 0);

		try {
			await callback();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			new Notice(this.t("noticeSyncFailed", { message: errorMessage }), 10000);
			console.error("[Lark CLI Sync] operation failed", error);
		} finally {
			notice.hide();
		}
	}

	private showSuccess(message: string, url: string): void {
		new Notice(`${message}\n${url}`, 8000);
	}

	private openUrlIfNeeded(url: string): void {
		if (this.settings.openAfterSync && url) {
			window.open(url);
		}
	}

	t(key: MessageKey, params: Record<string, string> = {}): string {
		const messages = MESSAGES[this.settings.language] || MESSAGES["zh-CN"];
		let text: string = messages[key] || MESSAGES.en[key];

		for (const [name, value] of Object.entries(params)) {
			text = text.replaceAll(`{${name}}`, value);
		}

		return text;
	}
}

class LarkCliSyncSettingTab extends PluginSettingTab {
	private readonly plugin: LarkCliSyncPlugin;

	constructor(app: import("obsidian").App, plugin: LarkCliSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: this.plugin.t("settingsTitle") });

		new Setting(containerEl)
			.setName(this.plugin.t("settingLanguageName"))
			.setDesc(this.plugin.t("settingLanguageDesc"))
			.addDropdown((dropdown) => {
				dropdown.addOption("zh-CN", this.plugin.t("languageChinese")).addOption("en", this.plugin.t("languageEnglish"))
					.setValue(this.plugin.settings.language).onChange(async (value) => {
						this.plugin.settings.language = value as Language;
						await this.plugin.saveSettings();
						this.display();
					});
			});

		new Setting(containerEl)
			.setName(this.plugin.t("settingLarkCliPathName"))
			.setDesc(this.plugin.t("settingLarkCliPathDesc"))
			.addText((text) => {
				text.setPlaceholder("lark-cli").setValue(this.plugin.settings.larkCliPath).onChange(async (value) => {
					this.plugin.settings.larkCliPath = value.trim() || DEFAULT_SETTINGS.larkCliPath;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName(this.plugin.t("settingDefaultTargetName"))
			.setDesc(this.plugin.t("settingDefaultTargetDesc"))
			.addText((text) => {
				text.setPlaceholder("https://xxx.feishu.cn/wiki/...").setValue(this.plugin.settings.targetTokenOrUrl)
					.onChange(async (value) => {
						this.plugin.settings.targetTokenOrUrl = value.trim();
						await this.plugin.saveSettings();
					});
				});

		new Setting(containerEl)
			.setName(this.plugin.t("settingTitleSourceName"))
			.setDesc(this.plugin.t("settingTitleSourceDesc"))
			.addDropdown((dropdown) => {
				dropdown.addOption("first-heading", this.plugin.t("titleSourceFirstHeading"))
					.addOption("file-name", this.plugin.t("titleSourceFileName"))
					.setValue(this.plugin.settings.titleSource).onChange(async (value) => {
						this.plugin.settings.titleSource = value as TitleSource;
						await this.plugin.saveSettings();
					});
				});

		new Setting(containerEl)
			.setName(this.plugin.t("settingWriteBindingName"))
			.setDesc(this.plugin.t("settingWriteBindingDesc"))
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.updateFrontmatter).onChange(async (value) => {
					this.plugin.settings.updateFrontmatter = value;
					await this.plugin.saveSettings();
				});
				});

		new Setting(containerEl)
			.setName(this.plugin.t("settingOpenAfterSyncName"))
			.setDesc(this.plugin.t("settingOpenAfterSyncDesc"))
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.openAfterSync).onChange(async (value) => {
					this.plugin.settings.openAfterSync = value;
					await this.plugin.saveSettings();
				});
			});
	}
}
