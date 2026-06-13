import { FileSystemAdapter, Menu, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";
import { execFile } from "child_process";
import { constants } from "fs";
import { access, chmod, copyFile, mkdir, readFile, rename } from "fs/promises";
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
import {
	buildSyncPlan,
	buildUpdateCommandArgs,
	createDocumentSyncStateFromRemote,
	createContentHash,
	createEmptySyncStateFile,
	formatSyncFailureMessage,
	FRONTMATTER_TOKEN_KEY,
	FRONTMATTER_URL_KEY,
	LEGACY_FRONTMATTER_SYNCED_AT_KEY,
	LarkSyncStateFile,
	prepareNoteContentForLark,
	removeLarkBinding,
	SyncFailureReason,
	SyncMode,
	SyncPlan,
	SyncStrategy,
	TitleSource
} from "./lark-sync-core";

const execFileAsync = promisify(execFile);

const DEFAULT_SETTINGS: LarkCliSyncSettings = {
	language: "zh-CN",
	larkCliPath: "lark-cli",
	targetTokenOrUrl: "",
	folderBindings: {},
	titleSource: "file-name",
	openAfterSync: true,
	updateFrontmatter: true,
	autoSyncMode: "manual",
	autoSyncDelaySeconds: 15,
	syncStrategy: "precise"
};

const FRONTMATTER_REMOTE_ROOT_KEY = "remoteRoot";
const FRONTMATTER_REMOTE_PARENT_PATH_KEY = "remoteParentPath";
const MAX_STDERR_LENGTH = 1600;
const LARK_CLI_COMMAND = "lark-cli";
const NODE_COMMAND = "node";
const PRE_PUSH_SCRIPT_NAME = "sync-pre-push.mjs";
const PRE_PUSH_CORE_SCRIPT_NAME = "lark-sync-core.mjs";
const LARK_SYNC_STATE_FILE_NAME = "lark-sync-state.json";
const PRE_PUSH_HOOK_MARKER = "Feishu Lark CLI Sync";
const AUTO_SYNC_WRITE_IGNORE_MS = 5000;
const DEFAULT_AUTO_SYNC_DELAY_SECONDS = 15;
const FALLBACK_LOGIN_SHELLS = ["/bin/zsh", "/bin/bash", "/bin/sh"];
const FALLBACK_PATH_ENTRIES = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

type Language = "zh-CN" | "en";
type AutoSyncMode = "manual" | "save" | "pre-push";
type RemoteParentKind = "wiki" | "drive" | "my_library" | "unknown";

interface LarkCliSyncSettings {
	language: Language;
	larkCliPath: string;
	targetTokenOrUrl: string;
	folderBindings: Record<string, BoundLarkDocument>;
	titleSource: TitleSource;
	openAfterSync: boolean;
	updateFrontmatter: boolean;
	autoSyncMode: AutoSyncMode;
	autoSyncDelaySeconds: number;
	syncStrategy: SyncStrategy;
}

interface BoundLarkDocument {
	token: string;
	url: string;
	containerToken?: string;
	containerKind?: RemoteParentKind;
	remoteParentPath?: string;
	remoteRoot?: string;
}

interface LarkCommandResult {
	ok: boolean;
	data?: {
		token?: string;
			document?: {
				document_id?: string;
				url?: string;
				revision_id?: number;
				content?: string;
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
	parent: RemoteParent;
	remoteParentPath: string;
	isNewDocument: boolean;
}

interface RemoteParent {
	token: string;
	kind: RemoteParentKind;
}

interface SyncFileOptions {
	allowCreate: boolean;
	openAfterSync: boolean;
	showSuccess: boolean;
	showRemoteDeletedNotice: boolean;
	updateFrontmatter: boolean;
	mode: SyncMode;
}

interface SyncOrRecreateOptions {
	allowRecreate: boolean;
	showRemoteDeletedNotice: boolean;
	mode: SyncMode;
	path: string;
	strategy?: SyncStrategy;
	stateKeys?: string[];
}

class LocalizedSyncError extends Error {
}

const MESSAGES = {
	"zh-CN": {
		commandPublishCurrentNote: "发布到飞书",
		commandSyncCurrentNote: "同步到飞书",
		menuPublishToLark: "发布到飞书",
		menuSyncToLark: "同步到飞书",
		menuPublishFolderToLark: "发布整个目录到飞书",
		ribbonSyncCurrentNote: "同步到飞书",
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
		noticeGitHookInstalled: "已安装 pre-push hook。选择 pre-push 模式后，git push 前会同步已绑定文档。",
		noticeGitHookInstallFailed: "安装 pre-push hook 失败：{message}",
		noticeNoDesktopVaultPath: "当前环境无法获取本地仓库路径，不能安装 Git hook。",
		noticeNoGitRepository: "当前 Obsidian 仓库不是 Git 仓库，未找到 .git 目录。",
		noticeExistingGitHookBackedUp: "检测到已有 pre-push hook，已备份并在新 hook 中继续调用：{path}",
		noticeAutoSyncFailed: "自动同步失败：{path}\n{message}",
		errorNoDocumentToken: "lark-cli 没有返回文档 token 或 URL。",
		settingsTitle: "Feishu Lark CLI Sync",
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
		settingWriteBindingDesc: "发布后把飞书文档 URL 保存到笔记 frontmatter。",
		settingOpenAfterSyncName: "同步后打开文档",
		settingOpenAfterSyncDesc: "发布或同步成功后，在浏览器中打开飞书文档。",
		settingAutoSyncModeName: "自动同步方式",
		settingAutoSyncModeDesc: "自动同步只处理已绑定的 Markdown 文档。保存后同步依赖 Obsidian；pre-push hook 可脱离 Obsidian 独立运行。",
		settingSyncStrategyName: "同步策略",
		settingSyncStrategyDesc: "安全增量同步会尽量只修改变动块；无法安全更新时会失败并通知，不会自动全量覆盖。全量覆盖同步会清空并重写远端文档。",
		syncStrategyPrecise: "安全增量同步（推荐）",
		syncStrategyOverwrite: "全量覆盖同步",
		autoSyncModeManual: "关闭",
		autoSyncModeSave: "保存后同步",
		autoSyncModePrePush: "Git pre-push hook",
		settingAutoSyncDelayName: "保存后同步延迟",
		settingAutoSyncDelayDesc: "文件保存后等待多少秒再同步，用于合并连续编辑。",
		settingInstallPrePushHookName: "安装 Git pre-push hook",
		settingInstallPrePushHookDesc: "把 hook 安装到当前 Obsidian 仓库的 .git/hooks/pre-push。hook 会读取插件设置，只有选择 Git pre-push hook 时才同步。",
		installPrePushHookButton: "安装 hook"
	},
	en: {
		commandPublishCurrentNote: "Publish to Feishu/Lark",
		commandSyncCurrentNote: "Sync to Feishu/Lark",
		menuPublishToLark: "Publish to Feishu/Lark",
		menuSyncToLark: "Sync to Feishu/Lark",
		menuPublishFolderToLark: "Publish folder to Feishu/Lark",
		ribbonSyncCurrentNote: "Sync to Feishu/Lark",
		noticeNoActiveMarkdownNote: "No active Markdown note.",
		noticePublishingToLark: "Publishing to Lark...",
		noticeSyncingToLark: "Syncing to Lark...",
		noticePublishingFolderToLark: "Publishing folder to Lark...",
		noticeNoMarkdownFilesInFolder: "No Markdown files found in this folder.",
		noticePublishedToLark: "Published to Feishu/Lark",
		noticeSyncedToLark: "Synced to Feishu/Lark",
		noticePublishedFolderToLark: "Published {count} notes to Feishu/Lark.",
		noticeSyncFailed: "Feishu/Lark sync failed: {message}",
		noticeRemoteDeletedRecreate: "Remote document was deleted. Creating a new document...",
		noticeGitHookInstalled: "Installed the pre-push hook. When pre-push mode is selected, bound notes sync before git push.",
		noticeGitHookInstallFailed: "Failed to install pre-push hook: {message}",
		noticeNoDesktopVaultPath: "Cannot resolve the local vault path in this environment, so Git hook cannot be installed.",
		noticeNoGitRepository: "The current Obsidian vault is not a Git repository. No .git directory was found.",
		noticeExistingGitHookBackedUp: "Existing pre-push hook detected. It was backed up and will still be called by the new hook: {path}",
		noticeAutoSyncFailed: "Auto sync failed: {path}\n{message}",
		errorNoDocumentToken: "lark-cli did not return a document token or URL.",
		settingsTitle: "Feishu Lark CLI Sync",
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
		settingWriteBindingDesc: "Store the Lark document URL in note frontmatter.",
		settingOpenAfterSyncName: "Open after sync",
		settingOpenAfterSyncDesc: "Open the Lark document in your browser after publish or sync succeeds.",
		settingAutoSyncModeName: "Auto sync mode",
		settingAutoSyncModeDesc: "Auto sync only handles bound Markdown notes. Save sync depends on Obsidian; the pre-push hook can run without Obsidian.",
		settingSyncStrategyName: "Sync strategy",
		settingSyncStrategyDesc: "Safe precise sync updates only changed blocks when possible. If it cannot update safely, it fails with a notice instead of falling back to overwrite. Overwrite sync clears and rewrites the remote document.",
		syncStrategyPrecise: "Safe precise sync (recommended)",
		syncStrategyOverwrite: "Overwrite sync",
		autoSyncModeManual: "Off",
		autoSyncModeSave: "Sync after save",
		autoSyncModePrePush: "Git pre-push hook",
		settingAutoSyncDelayName: "Save sync delay",
		settingAutoSyncDelayDesc: "Seconds to wait after a save before syncing, used to merge continuous edits.",
		settingInstallPrePushHookName: "Install Git pre-push hook",
		settingInstallPrePushHookDesc: "Install the hook into .git/hooks/pre-push of the current Obsidian vault. The hook reads plugin settings and syncs only when Git pre-push hook mode is selected.",
		installPrePushHookButton: "Install hook"
	}
} as const;

type MessageKey = keyof typeof MESSAGES.en;

export default class LarkCliSyncPlugin extends Plugin {
	settings!: LarkCliSyncSettings;
	private readonly autoSyncTimers = new Map<string, number>();
	private readonly autoSyncRunningPaths = new Set<string>();
	private readonly selfWrittenPaths = new Map<string, number>();
	private syncState: LarkSyncStateFile = createEmptySyncStateFile();

	override async onload(): Promise<void> {
		await this.loadSettings();
		this.syncState = await this.loadLarkSyncState();
		await this.tryEnsureLarkSyncStateFile();
		this.registerSaveAutoSync();
		this.register(() => {
			for (const timer of this.autoSyncTimers.values()) {
				window.clearTimeout(timer);
			}
			this.autoSyncTimers.clear();
		});

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

	private registerSaveAutoSync(): void {
		this.registerEvent(this.app.vault.on("modify", (file) => {
			if (this.settings.autoSyncMode !== "save") {
				return;
			}

			if (!(file instanceof TFile) || file.extension !== "md") {
				return;
			}

			this.queueSaveAutoSync(file);
		}));
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
			const binding = this.getBinding(file);
			const content = await this.readNoteForLark(file);
			const result = await this.createLarkDocument(file, content);
			if (binding) {
				this.removeSyncStateForBinding(binding);
			}
			await this.saveCreatedDocumentState(result, content);

			if (this.settings.updateFrontmatter || this.hasBindingChanged(binding, result)) {
				await this.writeBinding(file, result);
			}

			this.showSuccess(this.t("noticePublishedToLark"), result.url);
			this.openUrlIfNeeded(result.url);
		});
	}

	private async syncFile(file: TFile): Promise<void> {
		await this.runWithNotice(this.t("noticeSyncingToLark"), async () => {
			await this.syncFileInternal(file, {
				allowCreate: true,
				openAfterSync: true,
				showSuccess: true,
				showRemoteDeletedNotice: true,
				updateFrontmatter: this.settings.updateFrontmatter,
				mode: "manual"
			});
		});
	}

	private async syncFileInternal(file: TFile, options: SyncFileOptions): Promise<BoundLarkDocument | null> {
		const binding = this.getBinding(file);
		if (!binding) {
			if (!options.allowCreate) {
				return null;
			}

			const content = await this.readNoteForLark(file);
			const result = await this.createLarkDocument(file, content);
			await this.saveCreatedDocumentState(result, content);

			if (options.updateFrontmatter) {
				await this.writeBinding(file, result);
			}

			if (options.showSuccess) {
				this.showSuccess(this.t("noticePublishedToLark"), result.url);
			}

			if (options.openAfterSync) {
				this.openUrlIfNeeded(result.url);
			}

			return result;
		}

		const content = await this.readNoteForLark(file);
		const nextBinding = await this.syncOrRecreateDocument(file, binding, content, undefined, {
			allowRecreate: options.allowCreate,
			showRemoteDeletedNotice: options.showRemoteDeletedNotice,
			mode: options.mode,
			path: file.path,
			stateKeys: [binding.token, binding.url]
		});

		if (options.updateFrontmatter || this.hasBindingChanged(binding, nextBinding)) {
			await this.writeBinding(file, nextBinding);
		}

		if (options.showSuccess) {
			this.showSuccess(this.t("noticeSyncedToLark"), nextBinding.url);
		}

		if (options.openAfterSync) {
			this.openUrlIfNeeded(nextBinding.url);
		}

		return nextBinding;
	}

	private queueSaveAutoSync(file: TFile): void {
		if (!this.getBinding(file)) {
			return;
		}

		const selfWrittenAt = this.selfWrittenPaths.get(file.path);
		if (selfWrittenAt && Date.now() - selfWrittenAt < AUTO_SYNC_WRITE_IGNORE_MS) {
			return;
		}

		const existingTimer = this.autoSyncTimers.get(file.path);
		if (existingTimer) {
			window.clearTimeout(existingTimer);
		}

		const delayMs = this.getAutoSyncDelayMs();
		const timer = window.setTimeout(() => {
			this.autoSyncTimers.delete(file.path);
			void this.runSaveAutoSync(file);
		}, delayMs);
		this.autoSyncTimers.set(file.path, timer);
	}

	private async runSaveAutoSync(file: TFile): Promise<void> {
		if (this.autoSyncRunningPaths.has(file.path)) {
			this.queueSaveAutoSync(file);
			return;
		}

		this.autoSyncRunningPaths.add(file.path);
		try {
			await this.syncFileInternal(file, {
				allowCreate: false,
				openAfterSync: false,
				showSuccess: false,
				showRemoteDeletedNotice: false,
				updateFrontmatter: this.settings.updateFrontmatter,
				mode: "save"
			});
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			new Notice(this.t("noticeAutoSyncFailed", { path: file.path, message: errorMessage }), 10000);
			console.error("[Feishu Lark CLI Sync] auto sync failed", error);
		} finally {
			this.autoSyncRunningPaths.delete(file.path);
		}
	}

	private getAutoSyncDelayMs(): number {
		const delaySeconds = Number.isFinite(this.settings.autoSyncDelaySeconds)
			? this.settings.autoSyncDelaySeconds
			: DEFAULT_AUTO_SYNC_DELAY_SECONDS;
		return Math.max(1, delaySeconds) * 1000;
	}

	async installPrePushHook(): Promise<void> {
		try {
			const vaultPath = this.getVaultBasePath();
			if (!vaultPath) {
				new Notice(this.t("noticeNoDesktopVaultPath"), 10000);
				return;
			}

			const gitDirectory = join(vaultPath, ".git");
			if (!await this.pathExists(gitDirectory)) {
				new Notice(this.t("noticeNoGitRepository"), 10000);
				return;
			}

			const hooksDirectory = join(gitDirectory, "hooks");
			const hookPath = join(hooksDirectory, "pre-push");
			const sourceScript = join(this.getPluginDirectoryPath(), PRE_PUSH_SCRIPT_NAME);
			const sourceCoreScript = join(this.getPluginDirectoryPath(), PRE_PUSH_CORE_SCRIPT_NAME);
			const targetScript = join(hooksDirectory, PRE_PUSH_SCRIPT_NAME);
			const targetCoreScript = join(hooksDirectory, PRE_PUSH_CORE_SCRIPT_NAME);
			const nodePath = await this.resolveNodePath();
			await mkdir(hooksDirectory, { recursive: true });
			await copyFile(sourceScript, targetScript);
			await copyFile(sourceCoreScript, targetCoreScript);
			await chmod(targetScript, 0o755);
			const backupHookPath = await this.backupExistingPrePushHook(hookPath);
			await writeFile(hookPath, this.buildPrePushHookScript(targetScript, backupHookPath, nodePath), { mode: 0o755 });
			await chmod(hookPath, 0o755);
			if (backupHookPath) {
				new Notice(this.t("noticeExistingGitHookBackedUp", { path: backupHookPath }), 10000);
			}
			new Notice(this.t("noticeGitHookInstalled"), 10000);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(this.t("noticeGitHookInstallFailed", { message }), 10000);
			console.error("[Feishu Lark CLI Sync] install pre-push hook failed", error);
		}
	}

	private getVaultBasePath(): string | null {
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			return adapter.getBasePath();
		}

		return null;
	}

	private getPluginDirectoryPath(): string {
		const vaultPath = this.getVaultBasePath();
		if (!vaultPath) {
			throw new Error(this.t("noticeNoDesktopVaultPath"));
		}

		return join(vaultPath, ".obsidian", "plugins", this.manifest.id);
	}

	private getLarkSyncStatePath(): string | null {
		const vaultPath = this.getVaultBasePath();
		if (!vaultPath) {
			return null;
		}

		return join(vaultPath, ".obsidian", "plugins", this.manifest.id, LARK_SYNC_STATE_FILE_NAME);
	}

	private async loadLarkSyncState(): Promise<LarkSyncStateFile> {
		const statePath = this.getLarkSyncStatePath();
		if (!statePath) {
			return createEmptySyncStateFile();
		}

		try {
			const rawState = await readFile(statePath, "utf8");
			const state = JSON.parse(rawState) as Partial<LarkSyncStateFile>;
			if (this.isValidLarkSyncStateFile(state)) {
				return {
					version: 1,
					documents: state.documents
				};
			}
		} catch (error) {
			if (!this.isFileNotFoundError(error)) {
				console.warn("[Feishu Lark CLI Sync] failed to load sync state", error);
			}
		}

		const emptyState = createEmptySyncStateFile();
		await this.tryRepairLarkSyncStateFile(emptyState);
		return emptyState;
	}

	private async saveLarkSyncState(): Promise<void> {
		const statePath = this.getLarkSyncStatePath();
		if (!statePath) {
			return;
		}

		const tempPath = `${statePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
		await mkdir(dirname(statePath), { recursive: true });
		try {
			await writeFile(tempPath, JSON.stringify(this.syncState, null, 2), "utf8");
			await rename(tempPath, statePath);
		} catch (error) {
			await rm(tempPath, { force: true });
			throw error;
		}
	}

	private async ensureLarkSyncStateFile(): Promise<void> {
		const statePath = this.getLarkSyncStatePath();
		if (!statePath || await this.pathExists(statePath)) {
			return;
		}

		await this.saveLarkSyncState();
	}

	private async tryEnsureLarkSyncStateFile(): Promise<void> {
		try {
			await this.ensureLarkSyncStateFile();
		} catch (error) {
			console.warn("[Feishu Lark CLI Sync] failed to initialize sync state file", error);
		}
	}

	private async tryRepairLarkSyncStateFile(state: LarkSyncStateFile): Promise<void> {
		const previousState = this.syncState;
		try {
			this.syncState = state;
			await this.saveLarkSyncState();
		} catch (error) {
			console.warn("[Feishu Lark CLI Sync] failed to repair sync state file", error);
		} finally {
			this.syncState = previousState;
		}
	}

	private isValidLarkSyncStateFile(state: Partial<LarkSyncStateFile>): state is LarkSyncStateFile {
		if (state.version !== 1 || !state.documents || Array.isArray(state.documents) || typeof state.documents !== "object") {
			return false;
		}

		return Object.values(state.documents).every((documentState) => {
			return Boolean(documentState)
				&& typeof documentState.doc === "string"
				&& typeof documentState.contentHash === "string"
				&& Array.isArray(documentState.units)
				&& typeof documentState.updatedAt === "string";
		});
	}

	private isFileNotFoundError(error: unknown): boolean {
		return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
	}

	private async backupExistingPrePushHook(hookPath: string): Promise<string> {
		if (!await this.pathExists(hookPath)) {
			return "";
		}

		const content = await readFile(hookPath, "utf8");
		if (content.includes(PRE_PUSH_HOOK_MARKER)) {
			return "";
		}

		const backupHookPath = `${hookPath}.before-feishu-lark-cli-sync`;
		await copyFile(hookPath, backupHookPath);
		await chmod(backupHookPath, 0o755);
		return backupHookPath;
	}

	private buildPrePushHookScript(scriptPath: string, backupHookPath: string, nodePath: string): string {
		const runBackupHook = backupHookPath
			? `"${backupHookPath}" "$@"\n`
			: "";
		return `#!/usr/bin/env sh
# ${PRE_PUSH_HOOK_MARKER}
set -eu
${runBackupHook}
exec "${nodePath}" "${scriptPath}" "$@"
`;
	}

	private async resolveNodePath(): Promise<string> {
		const shellPath = await this.resolveCommandFromLoginShell(NODE_COMMAND);
		if (shellPath) {
			return shellPath;
		}

		const candidates = [
			"/opt/homebrew/bin/node",
			"/usr/local/bin/node",
			join(homedir(), ".nvm/current/bin/node"),
			NODE_COMMAND
		];

		for (const candidate of candidates) {
			if (candidate === NODE_COMMAND || await this.canExecute(candidate)) {
				return candidate;
			}
		}

		return NODE_COMMAND;
	}

	private async pathExists(path: string): Promise<boolean> {
		try {
			await access(path, constants.F_OK);
			return true;
		} catch {
			return false;
		}
	}

	private async publishFolder(folderPath: string): Promise<void> {
		await this.runWithNotice(this.t("noticePublishingFolderToLark"), async () => {
			const files = this.collectMarkdownFiles(folderPath);
			if (files.length === 0) {
				new Notice(this.t("noticeNoMarkdownFilesInFolder"));
				return;
			}

			const entries: FolderPublishEntry[] = [];
			const folderRoot = this.getSelectedFolderName(folderPath);
			const rootParent = await this.resolveRemoteRootParent();

			for (const file of files) {
				const content = await this.readNoteForLark(file);
				const binding = this.getBinding(file);
				const documentParentPath = this.getRemoteParentPath(folderPath, file, folderRoot);
				const documentParent = await this.ensureRemoteFolderPath(rootParent, documentParentPath);
				const nextBinding = binding
					? await this.resolveFolderBinding(file, binding, content, documentParent)
					: await this.createLarkDocument(file, content, documentParent);
				const nextBindingWithParent = this.withRemoteParentMetadata(
					nextBinding,
					folderRoot,
					documentParentPath,
					documentParent
				);

				entries.push({
					file,
					content,
					binding: nextBindingWithParent,
					parent: documentParent,
					remoteParentPath: documentParentPath,
					isNewDocument: !binding || nextBinding.token !== binding.token || nextBinding.url !== binding.url
				});

				if (this.settings.updateFrontmatter || this.hasBindingChanged(binding, nextBindingWithParent)) {
					await this.writeBinding(file, nextBindingWithParent);
				}
			}

			await this.syncFolderEntries(folderPath, folderRoot, entries);

			new Notice(this.t("noticePublishedFolderToLark", { count: String(entries.length) }), 8000);
		});
	}

	private async syncFolderEntries(folderPath: string, folderRoot: string, entries: FolderPublishEntry[]): Promise<void> {
		const maxAttempts = entries.length + 1;
		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			const linkMap = this.buildFolderLinkMap(folderPath, entries);
			const bindingChanged = await this.syncFolderEntriesOnce(folderRoot, entries, linkMap);
			if (!bindingChanged) {
				return;
			}
		}

		throw new LocalizedSyncError(this.formatSyncFailure("folder", folderPath, "remote-revision-changed"));
	}

	private buildFolderLinkMap(folderPath: string, entries: FolderPublishEntry[]): Map<string, LinkTarget> {
		const linkMap = new Map<string, LinkTarget>();
		for (const entry of entries) {
			if (entry.binding) {
				this.addLinkAliases(linkMap, folderPath, entry.file, entry.binding);
			}
		}
		return linkMap;
	}

	private async syncFolderEntriesOnce(
		folderRoot: string,
		entries: FolderPublishEntry[],
		linkMap: Map<string, LinkTarget>
	): Promise<boolean> {
		for (const entry of entries) {
			if (!entry.binding) {
				continue;
			}

			const rewrittenContent = this.rewriteInternalLinks(entry.content, linkMap, entry.file);
			const strategy = entry.isNewDocument ? "overwrite" : undefined;
			if (entry.isNewDocument && rewrittenContent === entry.content) {
				await this.saveCreatedDocumentState(entry.binding, entry.content);
				continue;
			}

			const nextBinding = await this.syncOrRecreateDocument(entry.file, entry.binding, rewrittenContent, entry.parent, {
				allowRecreate: true,
				showRemoteDeletedNotice: false,
				mode: "folder",
				path: entry.file.path,
				strategy,
				stateKeys: [entry.binding.token, entry.binding.url]
			});
			const nextBindingWithParent = this.withRemoteParentMetadata(
				nextBinding,
				folderRoot,
				entry.remoteParentPath,
				entry.parent
			);

			if (nextBindingWithParent.token !== entry.binding.token || nextBindingWithParent.url !== entry.binding.url) {
				entry.binding = nextBindingWithParent;
				entry.isNewDocument = true;
				await this.writeBinding(entry.file, nextBindingWithParent);
				return true;
			}

			if (this.settings.updateFrontmatter) {
				await this.writeBinding(entry.file, nextBindingWithParent);
			}

			if (strategy === "overwrite") {
				await this.saveCreatedDocumentState(nextBindingWithParent, rewrittenContent);
			}
		}

		return false;
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
		const contentWithoutBinding = removeLarkBinding(rawContent);
		return prepareNoteContentForLark(file, contentWithoutBinding, this.settings.titleSource);
	}

	private getBinding(file: TFile): BoundLarkDocument | null {
		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter;
		if (!frontmatter) {
			return null;
		}

		const token = this.readFrontmatterString(frontmatter[FRONTMATTER_TOKEN_KEY]);
		const url = this.readFrontmatterString(frontmatter[FRONTMATTER_URL_KEY]);
		if (!token && !url) {
			return null;
		}

		return {
			token,
			url
		};
	}

	private readFrontmatterString(value: unknown): string {
		return typeof value === "string" ? value : "";
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
				url
			};
		});
	}

	private async updateLarkDocument(
		doc: string,
		content: string,
		context: { mode: SyncMode; path: string; strategy?: SyncStrategy; stateKeys?: string[] }
	): Promise<Partial<BoundLarkDocument>> {
		const strategy = context.strategy || this.settings.syncStrategy;
		let state = this.findDocumentState([doc, ...(context.stateKeys || [])]);
		let syncDoc = state?.doc || doc;
		if (strategy === "precise" && (!state || state.units.length === 0)) {
			state = await this.tryBootstrapPreciseSyncState(syncDoc, context.stateKeys || []);
			syncDoc = state?.doc || syncDoc;
		}
		const plan = await buildSyncPlan({
			doc: syncDoc,
			markdown: content,
			contentFileName: "sync.md",
			strategy,
			state
		});

		return await this.executeSyncPlan(syncDoc, content, plan, context);
	}

	private findDocumentState(docs: string[]): LarkSyncStateFile["documents"][string] | undefined {
		for (const doc of this.uniquePathEntries(docs)) {
			const state = this.syncState.documents[doc];
			if (state) {
				return state;
			}
		}

		return undefined;
	}

	private async executeSyncPlan(
		doc: string,
		content: string,
		plan: SyncPlan,
		context: { mode: SyncMode; path: string; stateKeys?: string[] }
	): Promise<Partial<BoundLarkDocument>> {
		if (plan.mode === "skipped") {
			await this.ensureRemoteDocumentMatches(doc, plan.contentHash, context);
			await this.saveSyncPlanStateForDocument(doc, {}, plan, context.stateKeys || []);
			return {};
		}

		if (plan.mode === "blocked") {
			await this.ensureRemoteDocumentExists(doc);
			throw new LocalizedSyncError(this.formatSyncFailure(context.mode, context.path, plan.reason));
		}

		return await this.withTempMarkdown("sync", content, async (tempFile) => {
			let latestDocument: Partial<BoundLarkDocument> = {};
			for (const [index, command] of plan.commands.entries()) {
				const contentFileName = "content" in command && command.content
					? await this.writeTempMarkdown(tempFile.directory, `sync-${index}`, command.content)
					: tempFile.fileName;
				const commandArgs = buildUpdateCommandArgs(
					"contentFileName" in command
						? { ...command, doc, contentFileName }
						: { ...command, doc }
				);
				const result = await this.runLarkCli(commandArgs, {
					cwd: tempFile.directory
				});
				const document = result.data?.document;
				latestDocument = {
					token: document?.document_id || latestDocument.token,
					url: document?.url || latestDocument.url
				};
			}

			await this.saveSyncPlanStateForDocument(doc, latestDocument, plan, context.stateKeys || []);
			return latestDocument;
		});
	}

	private async saveSyncPlanStateForDocument(
		doc: string,
		document: Partial<BoundLarkDocument>,
		plan: SyncPlan,
		extraKeys: string[]
	): Promise<void> {
		const keys = this.uniquePathEntries([doc, ...extraKeys, document.token || "", document.url || ""]);
		for (const key of keys) {
			await this.saveSyncPlanState(key, plan);
		}
	}

	private async saveSyncPlanState(doc: string, plan: SyncPlan): Promise<void> {
		if (plan.mode === "blocked") {
			return;
		}

		if (!("nextState" in plan) || !plan.nextState) {
			return;
		}

		this.syncState.documents[doc] = {
			...plan.nextState,
			doc
		};
		await this.saveLarkSyncState();
	}

	private async saveCreatedDocumentState(binding: BoundLarkDocument, content: string): Promise<void> {
		const doc = binding.token || binding.url;
		const fetched = await this.fetchLarkDocumentWithIds(doc);
		const state = await createDocumentSyncStateFromRemote(doc, content, fetched.content, fetched.revisionId);
		const documentKeys = this.uniquePathEntries([binding.token, binding.url]);
		for (const key of documentKeys) {
			this.syncState.documents[key] = {
				...state,
				doc: key
			};
		}
		await this.saveLarkSyncState();
	}

	private async tryBootstrapPreciseSyncState(
		doc: string,
		stateKeys: string[]
	): Promise<LarkSyncStateFile["documents"][string] | undefined> {
		const [remoteMarkdown, remoteXml] = await Promise.all([
			this.fetchLarkDocumentMarkdown(doc),
			this.fetchLarkDocumentWithIds(doc)
		]);
		const state = await createDocumentSyncStateFromRemote(doc, remoteMarkdown.content, remoteXml.content, remoteXml.revisionId);
		if (state.units.length === 0) {
			return undefined;
		}

		for (const key of this.uniquePathEntries([doc, ...stateKeys])) {
			this.syncState.documents[key] = {
				...state,
				doc: key
			};
		}
		await this.saveLarkSyncState();
		return state;
	}

	private async fetchLarkDocumentMarkdown(doc: string): Promise<{ content: string; revisionId?: number }> {
		const result = await this.runLarkCli([
			"docs",
			"+fetch",
			"--api-version",
			"v2",
			"--as",
			"user",
			"--doc",
			doc,
			"--doc-format",
			"markdown",
			"--json"
		]);
		return {
			content: result.data?.document?.content || "",
			revisionId: result.data?.document?.revision_id
		};
	}

	private async fetchLarkDocumentWithIds(doc: string): Promise<{ content: string; revisionId?: number }> {
		const result = await this.runLarkCli([
			"docs",
			"+fetch",
			"--api-version",
			"v2",
			"--as",
			"user",
			"--doc",
			doc,
			"--detail",
			"with-ids",
			"--json"
		]);
		return {
			content: result.data?.document?.content || "",
			revisionId: result.data?.document?.revision_id
		};
	}

	private formatSyncFailure(mode: SyncMode, path: string, reason: SyncFailureReason): string {
		return formatSyncFailureMessage({
			language: this.settings.language,
			mode,
			path,
			reason
		});
	}

	private async ensureRemoteDocumentExists(doc: string): Promise<void> {
		const args = ["drive", "+inspect", "--as", "user", "--url", doc, "--json"];
		if (!/^https?:\/\//.test(doc)) {
			args.push("--type", "docx");
		}

		await this.runLarkCli(args);
	}

	private async ensureRemoteDocumentMatches(
		doc: string,
		expectedContentHash: string,
		context: { mode: SyncMode; path: string }
	): Promise<void> {
		const result = await this.runLarkCli([
			"docs",
			"+fetch",
			"--api-version",
			"v2",
			"--as",
			"user",
			"--doc",
			doc,
			"--doc-format",
			"markdown",
			"--json"
		]);
		const remoteContent = result.data?.document?.content || "";
		const remoteContentHash = await createContentHash(remoteContent);
		if (remoteContentHash !== expectedContentHash) {
			throw new LocalizedSyncError(this.formatSyncFailure(context.mode, context.path, "remote-content-mismatch"));
		}
	}

	private async syncOrRecreateDocument(
		file: TFile,
		binding: BoundLarkDocument,
		content: string,
		parent: RemoteParent | undefined,
		options: SyncOrRecreateOptions
	): Promise<BoundLarkDocument> {
		try {
			const result = await this.updateLarkDocument(binding.token || binding.url, content, {
				mode: options.mode,
				path: options.path,
				strategy: options.strategy,
				stateKeys: options.stateKeys
			});

			return {
				token: result.token || binding.token,
				url: result.url || binding.url
			};
		} catch (error) {
			if (!this.isRemoteDocumentDeletedError(error)) {
				throw error;
			}

			if (!options.allowRecreate) {
				throw error;
			}

			if (options.showRemoteDeletedNotice) {
				new Notice(this.t("noticeRemoteDeletedRecreate"), 5000);
			}
			const recreatedBinding = await this.createLarkDocument(file, content, parent);
			this.removeSyncStateForBinding(binding);
			await this.saveCreatedDocumentState(recreatedBinding, content);
			return recreatedBinding;
		}
	}

	private async resolveFolderBinding(
		file: TFile,
		binding: BoundLarkDocument,
		content: string,
		parent: RemoteParent
	): Promise<BoundLarkDocument> {
		try {
			await this.ensureRemoteDocumentExists(binding.token || binding.url);
			return binding;
		} catch (error) {
			if (!this.isRemoteDocumentDeletedError(error)) {
				throw error;
			}

			const recreatedBinding = await this.createLarkDocument(file, content, parent);
			this.removeSyncStateForBinding(binding);
			await this.saveCreatedDocumentState(recreatedBinding, content);
			return recreatedBinding;
		}
	}

	private hasBindingChanged(previous: BoundLarkDocument | null | undefined, next: BoundLarkDocument): boolean {
		return Boolean(previous)
			&& (previous?.token !== next.token || previous.url !== next.url);
	}

	private removeSyncStateForBinding(binding: BoundLarkDocument): void {
		for (const key of this.getBindingAliases(binding)) {
			delete this.syncState.documents[key];
		}
	}

	private getBindingAliases(binding: BoundLarkDocument): string[] {
		return this.uniquePathEntries([
			binding.token,
			binding.url,
			binding.url ? this.extractPathToken(binding.url) : ""
		]);
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
				containerKind: "drive"
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
				containerKind: parent.kind
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
				containerKind: parent.kind
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
			|| message.toLowerCase().includes("no longer be edited")
			|| message.toLowerCase().includes("not exist")
			|| message.toLowerCase().includes("not found");
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
		const tempDir = await mkdtemp(join(tmpdir(), "feishu-lark-cli-sync-"));
		const fileName = `${this.sanitizeFileName(baseName)}.md`;
		const tempPath = join(tempDir, fileName);

		try {
			await writeFile(tempPath, content, "utf8");
			return await callback({ directory: tempDir, fileName });
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	}

	private async writeTempMarkdown(directory: string, baseName: string, content: string): Promise<string> {
		const fileName = `${this.sanitizeFileName(baseName)}.md`;
		await writeFile(join(directory, fileName), content, "utf8");
		return fileName;
	}

	private sanitizeFileName(name: string): string {
		return name.replace(/[\\/:*?"<>|]/g, "-").trim() || "note";
	}

	private async writeBinding(file: TFile, binding: BoundLarkDocument): Promise<void> {
		this.selfWrittenPaths.set(file.path, Date.now());
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			delete frontmatter.lark_doc;
			delete frontmatter[FRONTMATTER_TOKEN_KEY];
			delete frontmatter[FRONTMATTER_REMOTE_ROOT_KEY];
			delete frontmatter[FRONTMATTER_REMOTE_PARENT_PATH_KEY];
			delete frontmatter[LEGACY_FRONTMATTER_SYNCED_AT_KEY];
			frontmatter[FRONTMATTER_URL_KEY] = binding.url;
		});
		this.selfWrittenPaths.set(file.path, Date.now());
	}

	private async runWithNotice(message: string, callback: () => Promise<void>): Promise<void> {
		const notice = new Notice(message, 0);

		try {
			await callback();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const noticeMessage = error instanceof LocalizedSyncError
				? errorMessage
				: this.t("noticeSyncFailed", { message: errorMessage });
			new Notice(noticeMessage, 10000);
			console.error("[Feishu Lark CLI Sync] operation failed", error);
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

		new Setting(containerEl)
			.setName(this.plugin.t("settingSyncStrategyName"))
			.setDesc(this.plugin.t("settingSyncStrategyDesc"))
			.addDropdown((dropdown) => {
				dropdown.addOption("precise", this.plugin.t("syncStrategyPrecise"))
					.addOption("overwrite", this.plugin.t("syncStrategyOverwrite"))
					.setValue(this.plugin.settings.syncStrategy).onChange(async (value) => {
						this.plugin.settings.syncStrategy = value as SyncStrategy;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName(this.plugin.t("settingAutoSyncModeName"))
			.setDesc(this.plugin.t("settingAutoSyncModeDesc"))
			.addDropdown((dropdown) => {
				dropdown.addOption("manual", this.plugin.t("autoSyncModeManual"))
					.addOption("save", this.plugin.t("autoSyncModeSave"))
					.addOption("pre-push", this.plugin.t("autoSyncModePrePush"))
					.setValue(this.plugin.settings.autoSyncMode).onChange(async (value) => {
						this.plugin.settings.autoSyncMode = value as AutoSyncMode;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName(this.plugin.t("settingAutoSyncDelayName"))
			.setDesc(this.plugin.t("settingAutoSyncDelayDesc"))
			.addText((text) => {
				text.setPlaceholder(String(DEFAULT_AUTO_SYNC_DELAY_SECONDS))
					.setValue(String(this.plugin.settings.autoSyncDelaySeconds)).onChange(async (value) => {
						const delay = Number.parseInt(value, 10);
						this.plugin.settings.autoSyncDelaySeconds = Number.isFinite(delay)
							? Math.max(1, delay)
							: DEFAULT_SETTINGS.autoSyncDelaySeconds;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName(this.plugin.t("settingInstallPrePushHookName"))
			.setDesc(this.plugin.t("settingInstallPrePushHookDesc"))
			.addButton((button) => {
				button.setButtonText(this.plugin.t("installPrePushHookButton")).onClick(() => {
					void this.plugin.installPrePushHook();
				});
			});
	}
}
