import { addIcon, FileSystemAdapter, Menu, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";
import { execFile } from "child_process";
import { constants } from "fs";
import { access, chmod, copyFile, mkdir, readFile, rename, stat } from "fs/promises";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { homedir, tmpdir } from "os";
import process from "process";
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
	createEmptySyncStateFile,
	createIncompleteDocumentSyncStateFromMarkdown,
	createSyncContentSignature,
	extractDocumentToken,
	extractTitle,
	formatSyncFailureMessage,
	getDocumentStateKey,
	getDocumentStateKeys,
	FRONTMATTER_TOKEN_KEY,
	FRONTMATTER_URL_KEY,
	isDocumentStateContentEquivalent,
	isDocumentStateBlockMappingAcceptable,
	isSyncContentSignatureEquivalent,
	LEGACY_FRONTMATTER_SYNCED_AT_KEY,
	LarkSyncStateFile,
	mergeSyncStateFiles,
	normalizeStateCacheRetainLimit,
	prepareNoteContentForLark,
	prepareOverwriteMarkdownContent,
	removeBindingOnlyFrontmatterBeforeNextFrontmatter,
	removeLarkBinding,
	stripPreparedMarkdownTitle,
	SyncFailureReason,
	SyncMode,
	SyncPlan,
	SyncStrategy,
	TitleSource,
	touchDocumentSyncState,
	trimSyncStateCache
} from "./lark-sync-core";
import {
	buildCommandEnvironment as buildLarkCommandEnvironment,
	formatMissingLarkCli,
	formatUnsupportedLarkCliVersion,
	isSupportedLarkCliVersion,
	parseLarkCliVersion,
	resolveLarkCliPathFromSetting,
	shouldUseCommandShell,
	uniquePathEntries,
	withDocsApiVersion
} from "./lark-cli-command";
import {
	EMBEDDED_LARK_CLI_COMMAND_SCRIPT,
	EMBEDDED_PRE_PUSH_CORE_SCRIPT,
	EMBEDDED_PRE_PUSH_SCRIPT
} from "./embedded-helpers";

const execFileAsync = promisify(execFile);

const DEFAULT_SETTINGS: LarkCliSyncSettings = {
	language: "zh-CN",
	larkCliPath: "lark-cli",
	targetTokenOrUrl: "",
	folderBindings: {},
	publishedFolders: {},
	titleSource: "file-name",
	openAfterSync: true,
	updateFrontmatter: true,
	autoSyncMode: "save",
	autoSyncDelaySeconds: 15,
	syncStrategy: "auto",
	stateCacheRetainLimit: 100
};

const FRONTMATTER_REMOTE_ROOT_KEY = "remoteRoot";
const FRONTMATTER_REMOTE_PARENT_PATH_KEY = "remoteParentPath";
const MAX_STDERR_LENGTH = 1600;
const MAX_NOTICE_ERROR_DETAIL_LENGTH = 260;
const NODE_COMMAND = "node";
const PRE_PUSH_SCRIPT_NAME = "sync-pre-push.mjs";
const PRE_PUSH_CORE_SCRIPT_NAME = "lark-sync-core.mjs";
const LARK_CLI_COMMAND_SCRIPT_NAME = "lark-cli-command.mjs";
const LARK_SYNC_STATE_FILE_NAME = "lark-sync-state.json";
const PRE_PUSH_HOOK_MARKER = "Feishu Lark CLI Sync";
const LARK_RIBBON_ICON_ID = "feishu-lark-cli-sync-ribbon";
const LARK_RIBBON_ICON_SVG = `
<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"
	stroke-linecap="round" stroke-linejoin="round">
	<path d="M4 12.5 20 5l-5.2 14-3.3-5.1L4 12.5z"/>
	<path d="m11.5 13.9 3.9-4.4"/>
	<path d="M5 18h6"/>
	<path d="M7 21h4"/>
</svg>`;
const AUTO_SYNC_WRITE_IGNORE_MS = 5000;
const DEFAULT_AUTO_SYNC_DELAY_SECONDS = 15;
const DEFAULT_STATE_CACHE_RETAIN_LIMIT = 100;
const SAVE_REMOTE_STATE_REFRESH_ATTEMPTS = 5;
const SAVE_REMOTE_STATE_REFRESH_DELAY_MS = 600;
const STRICT_REMOTE_STATE_REFRESH_ATTEMPTS = 8;
const STRICT_REMOTE_STATE_REFRESH_DELAY_MS = 1500;
const FOLDER_SYNC_PARALLEL_LIMIT = 3;
const LARK_CLI_MAX_CONCURRENT_REQUESTS = 3;
const LARK_CLI_REQUEST_INTERVAL_MS = 350;
const LARK_CLI_RATE_LIMIT_RETRY_DELAYS_MS = [3000, 6000, 12000];
const LARK_CLI_VERSION_ARGS = [["-version"], ["-v"]];
const FALLBACK_LOGIN_SHELLS = ["/bin/zsh", "/bin/bash", "/bin/sh"];

type Language = "zh-CN" | "en";
type AutoSyncMode = "manual" | "save" | "pre-push";
type PrePushHookStatus = "installed" | "not-installed" | "not-git-repository" | "unavailable" | "unknown";
type RemoteParentKind = "wiki" | "drive" | "my_library" | "unknown";

interface LarkCliSyncSettings {
	language: Language;
	larkCliPath: string;
	larkCliVersionCheck?: LarkCliVersionCheck;
	targetTokenOrUrl: string;
	folderBindings: Record<string, BoundLarkDocument>;
	publishedFolders: Record<string, PublishedFolderBinding>;
	titleSource: TitleSource;
	openAfterSync: boolean;
	updateFrontmatter: boolean;
	autoSyncMode: AutoSyncMode;
	autoSyncDelaySeconds: number;
	syncStrategy: SyncStrategy;
	stateCacheRetainLimit: number;
}

interface LarkCliVersionCheck {
	executable: string;
	version: string;
}

interface BoundLarkDocument {
	token: string;
	url: string;
	containerToken?: string;
	containerKind?: RemoteParentKind;
	remoteParentPath?: string;
	remoteRoot?: string;
}

interface PublishedFolderBinding {
	rootParent: RemoteParent;
	remoteRoot: string;
}

interface LarkDocumentUpdateResult extends Partial<BoundLarkDocument> {
	revisionId?: number;
}

interface LarkCommandDocument {
	document_id?: string;
	url?: string;
	revision_id?: number;
	content?: string;
}

interface LarkCommandNode {
	node_token?: string;
	obj_token?: string;
	url?: string;
}

interface LarkCommandResult {
	ok: boolean;
	data?: {
		token?: string;
		folder_token?: string;
		comment_id?: string;
		reply_id?: string;
		"document"?: LarkCommandDocument;
		node?: LarkCommandNode;
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

interface FolderPreparedFile {
	file: TFile;
	content: string;
	binding: BoundLarkDocument | null;
	remoteParentPath: string;
}

interface IndexedFolderPreparedFile {
	preparedFile: FolderPreparedFile;
	index: number;
}

interface RemoteParent {
	token: string;
	kind: RemoteParentKind;
}

interface RemoteFolderPathResolution {
	parent: RemoteParent;
	createdBinding: boolean;
}

interface PublishedFolderResolution {
	folderPath: string;
	binding: PublishedFolderBinding;
	inferred: boolean;
}

interface FolderDocumentParent {
	parent: RemoteParent;
	remoteRoot: string;
	remoteParentPath: string;
}

interface SyncFileOptions {
	allowCreate: boolean;
	openAfterSync: boolean;
	showSuccess: boolean;
	showRemoteDeletedNotice: boolean;
	updateFrontmatter: boolean;
	mode: SyncMode;
	strategy?: SyncStrategy;
	successMessageKey?: MessageKey;
}

interface SyncOrRecreateOptions {
	allowRecreate: boolean;
	showRemoteDeletedNotice: boolean;
	mode: SyncMode;
	path: string;
	strategy?: SyncStrategy;
	stateKeys?: string[];
}

interface RemoteStateRefreshPolicy {
	attempts: number;
	delayMs: number;
	allowTimeoutFallback: boolean;
}

const SAVE_REMOTE_STATE_REFRESH_POLICY: RemoteStateRefreshPolicy = {
	attempts: SAVE_REMOTE_STATE_REFRESH_ATTEMPTS,
	delayMs: SAVE_REMOTE_STATE_REFRESH_DELAY_MS,
	allowTimeoutFallback: true
};

const STRICT_REMOTE_STATE_REFRESH_POLICY: RemoteStateRefreshPolicy = {
	attempts: STRICT_REMOTE_STATE_REFRESH_ATTEMPTS,
	delayMs: STRICT_REMOTE_STATE_REFRESH_DELAY_MS,
	allowTimeoutFallback: false
};

class LocalizedSyncError extends Error {
}

const MESSAGES = {
	"zh-CN": {
		commandSyncCurrentNote: "同步到飞书",
		commandOverwriteCurrentNote: "覆盖同步到飞书",
		menuSyncToLark: "Lark: 同步到飞书",
		menuOverwriteSyncToLark: "Lark: 覆盖到飞书",
		menuPublishFolderToLark: "Lark: 同步目录到飞书",
		ribbonSyncCurrentNote: "同步到飞书",
		noticeNoActiveMarkdownNote: "当前没有打开 Markdown 笔记。",
		noticeSyncingToLark: "正在同步到飞书...",
		noticeOverwriteSyncingToLark: "正在覆盖同步到飞书...",
		noticePublishingFolderToLark: "正在发布目录到飞书...",
		noticeNoMarkdownFilesInFolder: "该目录下没有 Markdown 文件。",
		noticePublishedToLark: "已发布到飞书",
		noticeSyncedToLark: "已同步到飞书",
		noticeOverwriteSyncedToLark: "已覆盖同步到飞书",
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
		errorInvalidDefaultTarget: "默认上传位置无效或当前飞书账号无权访问。\n请检查插件设置中的“默认上传位置”：{target}\n底层原因：{detail}",
		settingsTitle: "Feishu Lark CLI Sync",
		settingsSectionGeneral: "常规",
		settingsSectionContent: "内容",
		settingsSectionSync: "同步",
		settingsSectionGitHook: "Git Hook",
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
		settingSyncStrategyDesc: "自动（推荐）：小改动只更新变动块；改动较大、结构复杂或无法安全增量时，会自动全量覆盖远端。安全增量：只做增量，失败时提示，不覆盖。全量覆盖：每次都重写远端文档。",
		syncStrategyAuto: "自动（推荐）",
		syncStrategyPrecise: "安全增量同步",
		syncStrategyOverwrite: "全量覆盖同步",
		autoSyncModeManual: "关闭",
		autoSyncModeSave: "保存后同步",
		autoSyncModePrePush: "Git pre-push hook",
		settingAutoSyncDelayName: "保存后同步延迟",
		settingAutoSyncDelayDesc: "文件保存后等待多少秒再同步，用于合并连续编辑。",
		settingStateCacheName: "同步状态缓存",
		settingStateCacheDesc: "设置最多保留多少篇文档状态；超过保留数的 1.5 倍时自动裁剪旧状态。老文档下次同步会重新建立块映射。",
		settingInstallPrePushHookName: "安装 Git pre-push hook",
		settingInstallPrePushHookDesc: "把 hook 安装到当前 Obsidian 仓库的 .git/hooks/pre-push。hook 会读取插件设置，只有选择 Git pre-push hook 时才同步。",
		prePushHookStatusInstalled: "状态：hook 已安装。",
		prePushHookStatusMissing: "状态：已选择 Git pre-push hook，但当前仓库尚未安装 hook。",
		prePushHookStatusMissingInactive: "状态：当前仓库尚未安装 hook。",
		prePushHookStatusUnavailable: "状态：当前环境无法检查本地 Git hook。",
		prePushHookStatusNotGitRepository: "状态：当前 Obsidian 仓库不是 Git 仓库，无法安装 hook。",
		prePushHookStatusChecking: "状态：正在检查 hook 安装状态...",
		installPrePushHookButton: "安装 hook"
	},
	en: {
		commandSyncCurrentNote: "Sync to Feishu/Lark",
		commandOverwriteCurrentNote: "Overwrite sync to Feishu/Lark",
		menuSyncToLark: "Lark: Sync to Feishu/Lark",
		menuOverwriteSyncToLark: "Lark: Overwrite to Feishu/Lark",
		menuPublishFolderToLark: "Lark: Sync folder to Feishu/Lark",
		ribbonSyncCurrentNote: "Sync to Feishu/Lark",
		noticeNoActiveMarkdownNote: "No active Markdown note.",
		noticeSyncingToLark: "Syncing to Lark...",
		noticeOverwriteSyncingToLark: "Overwriting to Lark...",
		noticePublishingFolderToLark: "Publishing folder to Lark...",
		noticeNoMarkdownFilesInFolder: "No Markdown files found in this folder.",
		noticePublishedToLark: "Published to Feishu/Lark",
		noticeSyncedToLark: "Synced to Feishu/Lark",
		noticeOverwriteSyncedToLark: "Overwritten to Feishu/Lark",
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
		errorInvalidDefaultTarget: "Default upload target is invalid or inaccessible.\nCheck the Default target setting: {target}\nCause: {detail}",
		settingsTitle: "Feishu Lark CLI Sync",
		settingsSectionGeneral: "General",
		settingsSectionContent: "Content",
		settingsSectionSync: "Sync",
		settingsSectionGitHook: "Git Hook",
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
		settingSyncStrategyDesc: "Auto (recommended): updates only changed blocks for small edits; overwrites when changes are large, structurally complex, or unsafe for precise sync. Safe precise never overwrites. Overwrite rewrites the remote doc every time.",
		syncStrategyAuto: "Auto (recommended)",
		syncStrategyPrecise: "Safe precise sync",
		syncStrategyOverwrite: "Overwrite sync",
		autoSyncModeManual: "Off",
		autoSyncModeSave: "Sync after save",
		autoSyncModePrePush: "Git pre-push hook",
		settingAutoSyncDelayName: "Save sync delay",
		settingAutoSyncDelayDesc: "Seconds to wait after a save before syncing, used to merge continuous edits.",
		settingStateCacheName: "Sync state cache",
		settingStateCacheDesc: "Maximum document states to keep. Old states are trimmed after the cache exceeds 1.5x this value. Old documents rebuild block mapping on next sync.",
		settingInstallPrePushHookName: "Install Git pre-push hook",
		settingInstallPrePushHookDesc: "Install the hook into .git/hooks/pre-push of the current Obsidian vault. The hook reads plugin settings and syncs only when Git pre-push hook mode is selected.",
		prePushHookStatusInstalled: "Status: hook is installed.",
		prePushHookStatusMissing: "Status: Git pre-push hook is selected, but this repository has no installed hook yet.",
		prePushHookStatusMissingInactive: "Status: this repository has no installed hook yet.",
		prePushHookStatusUnavailable: "Status: cannot check the local Git hook in this environment.",
		prePushHookStatusNotGitRepository: "Status: the current Obsidian vault is not a Git repository, so hook cannot be installed.",
		prePushHookStatusChecking: "Status: checking hook installation...",
		installPrePushHookButton: "Install hook"
	}
} as const;

type MessageKey = keyof typeof MESSAGES.en;

export default class LarkCliSyncPlugin extends Plugin {
	settings!: LarkCliSyncSettings;
	private readonly autoSyncTimers = new Map<string, number>();
	private readonly autoSyncRunningPaths = new Set<string>();
	private readonly autoSyncPendingPaths = new Set<string>();
	private readonly selfWrittenPaths = new Map<string, number>();
	private syncStateSaveQueue: Promise<void> = Promise.resolve();
	private deferredSyncStateSaveDepth = 0;
	private hasDeferredSyncStateSave = false;
	private cachedLarkCliPath: string | null = null;
	private cachedLarkCliPathSetting = "";
	private pendingLarkCliPath: Promise<string> | null = null;
	private cachedCommandEnvironment: Record<string, string | undefined> | null = null;
	private cachedCommandEnvironmentExecutable = "";
	private cachedCommandEnvironmentShellPath = "";
	private cachedLoginShellPath: string | null = null;
	private pendingLoginShellPath: Promise<string> | null = null;
	private checkedLarkCliVersionExecutable = "";
	private pendingLarkCliVersionExecutable = "";
	private pendingLarkCliVersionCheck: Promise<void> | null = null;
	private larkCliRequestQueue: Promise<void> = Promise.resolve();
	private larkCliActiveRequestCount = 0;
	private lastLarkCliRequestAt = 0;
	private syncState: LarkSyncStateFile = createEmptySyncStateFile();
	private readonly syncStateChangedKeys = new Set<string>();
	private readonly syncStateRemovedKeys = new Set<string>();

	override async onload(): Promise<void> {
		addIcon(LARK_RIBBON_ICON_ID, LARK_RIBBON_ICON_SVG);
		await this.loadSettings();
		this.syncState = await this.loadLarkSyncState();
		await this.tryEnsureLarkSyncStateFile();
		await this.tryRefreshInstalledPrePushHook();
		this.registerSaveAutoSync();
		this.register(() => {
			for (const timer of this.autoSyncTimers.values()) {
				window.clearTimeout(timer);
			}
			this.autoSyncTimers.clear();
		});

		this.addCommand({
			id: "sync-current-note-to-lark",
			name: this.t("commandSyncCurrentNote"),
			callback: () => {
				void this.syncCurrentNote();
			}
		});

		this.addCommand({
			id: "overwrite-sync-current-note-to-lark",
			name: this.t("commandOverwriteCurrentNote"),
			callback: () => {
				void this.overwriteSyncCurrentNote();
			}
		});

		this.addRibbonIcon(LARK_RIBBON_ICON_ID, this.t("ribbonSyncCurrentNote"), () => {
			void this.syncCurrentNote();
		});

		this.registerEvent(this.app.workspace.on("file-menu", (menu: Menu, file) => {
			if (file instanceof TFile && file.extension === "md") {
				menu.addItem((item) => {
					item.setTitle(this.t("menuSyncToLark")).setIcon("refresh-cw").onClick(() => {
						void this.syncFile(file);
					});
				});
				menu.addItem((item) => {
					item.setTitle(this.t("menuOverwriteSyncToLark")).setIcon("replace").onClick(() => {
						void this.overwriteSyncFile(file);
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
		const savedData: unknown = await this.loadData();
		const savedSettings = this.isRecord(savedData) ? savedData as Partial<LarkCliSyncSettings> : {};
		const savedSettingsWithoutTrimThreshold: Partial<LarkCliSyncSettings> & { stateCacheTrimThreshold?: unknown } = {
			...(savedSettings || {})
		};
		delete savedSettingsWithoutTrimThreshold.stateCacheTrimThreshold;
		this.settings = {
			...DEFAULT_SETTINGS,
			...savedSettingsWithoutTrimThreshold,
			stateCacheRetainLimit: this.normalizePositiveInteger(
				savedSettings?.stateCacheRetainLimit,
				DEFAULT_STATE_CACHE_RETAIN_LIMIT
			),
			folderBindings: {
				...DEFAULT_SETTINGS.folderBindings,
				...(savedSettings?.folderBindings || {})
			},
			publishedFolders: {
				...DEFAULT_SETTINGS.publishedFolders,
				...(savedSettings?.publishedFolders || {})
			}
		};
	}

	async saveSettings(): Promise<void> {
		this.clearLarkCliCommandCache();
		await this.saveData(this.settings);
	}

	private async saveSettingsWithoutClearingCommandCache(): Promise<void> {
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

	private async syncCurrentNote(): Promise<void> {
		const file = this.getActiveMarkdownFile();
		if (!file) {
			new Notice(this.t("noticeNoActiveMarkdownNote"));
			return;
		}

		await this.syncFile(file);
	}

	private async overwriteSyncCurrentNote(): Promise<void> {
		const file = this.getActiveMarkdownFile();
		if (!file) {
			new Notice(this.t("noticeNoActiveMarkdownNote"));
			return;
		}

		await this.overwriteSyncFile(file);
	}

	async runLarkCliCommand(args: string[], options: LarkCommandOptions = {}): Promise<LarkCommandResult> {
		return await this.runLarkCli(args, options);
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

	private async overwriteSyncFile(file: TFile): Promise<void> {
		await this.runWithNotice(this.t("noticeOverwriteSyncingToLark"), async () => {
			await this.syncFileInternal(file, {
				allowCreate: true,
				openAfterSync: true,
				showSuccess: true,
				showRemoteDeletedNotice: true,
				updateFrontmatter: this.settings.updateFrontmatter,
				mode: "manual",
				strategy: "overwrite",
				successMessageKey: "noticeOverwriteSyncedToLark"
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
			const publishedFolder = await this.resolvePublishedFolderParentForFile(file);
			const result = publishedFolder
				? this.withRemoteParentMetadata(
					await this.createLarkDocument(file, content, publishedFolder.parent),
					publishedFolder.remoteRoot,
					publishedFolder.remoteParentPath,
					publishedFolder.parent
				)
				: await this.createLarkDocument(file, content);
			await this.saveCreatedDocumentStateFromBaseline(result, content);

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
			strategy: options.strategy,
			stateKeys: [binding.token, binding.url]
		});

		if (this.shouldWriteBinding(binding, nextBinding, options.updateFrontmatter)) {
			await this.writeBinding(file, nextBinding);
		}

		if (options.showSuccess) {
			this.showSuccess(this.t(options.successMessageKey || "noticeSyncedToLark"), nextBinding.url);
		}

		if (options.openAfterSync) {
			this.openUrlIfNeeded(nextBinding.url);
		}

		return nextBinding;
	}

	private queueSaveAutoSync(file: TFile): void {
		const selfWrittenAt = this.selfWrittenPaths.get(file.path);
		if (selfWrittenAt && Date.now() - selfWrittenAt < AUTO_SYNC_WRITE_IGNORE_MS) {
			return;
		}

		if (this.autoSyncRunningPaths.has(file.path)) {
			this.autoSyncPendingPaths.add(file.path);
			return;
		}

		if (!this.getBinding(file)) {
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
			this.autoSyncPendingPaths.add(file.path);
			return;
		}

		this.autoSyncRunningPaths.add(file.path);
		this.autoSyncPendingPaths.delete(file.path);
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
			if (this.autoSyncPendingPaths.delete(file.path)) {
				this.queueSaveAutoSync(file);
			}
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
			const targetScript = join(hooksDirectory, PRE_PUSH_SCRIPT_NAME);
			const nodePath = await this.resolveNodePath();
			await mkdir(hooksDirectory, { recursive: true });
			await this.refreshPrePushHookHelpers(hooksDirectory);
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

	private async tryRefreshInstalledPrePushHook(): Promise<void> {
		try {
			const hookInfo = await this.getPrePushHookInfo();
			if (hookInfo.status !== "installed" || !hookInfo.hooksDirectory) {
				return;
			}

			await this.refreshPrePushHookHelpers(hookInfo.hooksDirectory);
		} catch (error) {
			console.warn("[Feishu Lark CLI Sync] failed to refresh pre-push hook helpers", error);
		}
	}

	async getPrePushHookStatus(): Promise<PrePushHookStatus> {
		try {
			const hookInfo = await this.getPrePushHookInfo();
			return hookInfo.status;
		} catch (error) {
			console.warn("[Feishu Lark CLI Sync] failed to check pre-push hook status", error);
			return "unknown";
		}
	}

	private async getPrePushHookInfo(): Promise<{ status: PrePushHookStatus; hooksDirectory?: string }> {
		const vaultPath = this.getVaultBasePath();
		if (!vaultPath) {
			return { status: "unavailable" };
		}

		const gitDirectory = join(vaultPath, ".git");
		if (!await this.pathExists(gitDirectory)) {
			return { status: "not-git-repository" };
		}

		const hooksDirectory = join(gitDirectory, "hooks");
		const hookPath = join(hooksDirectory, "pre-push");
		if (!await this.pathExists(hookPath)) {
			return { status: "not-installed", hooksDirectory };
		}

		const hookContent = await readFile(hookPath, "utf8");
		if (!hookContent.includes(PRE_PUSH_HOOK_MARKER)) {
			return { status: "not-installed", hooksDirectory };
		}

		return { status: "installed", hooksDirectory };
	}

	private async refreshPrePushHookHelpers(hooksDirectory: string): Promise<void> {
		const pluginDirectory = this.getPluginDirectoryPath();
		const sourceScript = join(pluginDirectory, PRE_PUSH_SCRIPT_NAME);
		const sourceCoreScript = join(pluginDirectory, PRE_PUSH_CORE_SCRIPT_NAME);
		const sourceCommandScript = join(pluginDirectory, LARK_CLI_COMMAND_SCRIPT_NAME);
		const targetScript = join(hooksDirectory, PRE_PUSH_SCRIPT_NAME);
		const targetCoreScript = join(hooksDirectory, PRE_PUSH_CORE_SCRIPT_NAME);
		const targetCommandScript = join(hooksDirectory, LARK_CLI_COMMAND_SCRIPT_NAME);
		await this.copyOrWriteEmbeddedHelper(sourceScript, targetScript, EMBEDDED_PRE_PUSH_SCRIPT);
		await this.copyOrWriteEmbeddedHelper(sourceCoreScript, targetCoreScript, EMBEDDED_PRE_PUSH_CORE_SCRIPT);
		await this.copyOrWriteEmbeddedHelper(sourceCommandScript, targetCommandScript, EMBEDDED_LARK_CLI_COMMAND_SCRIPT);
		await chmod(targetScript, 0o755);
	}

	private async copyOrWriteEmbeddedHelper(sourcePath: string, targetPath: string, embeddedContent: string): Promise<void> {
		if (await this.pathExists(sourcePath)) {
			await copyFile(sourcePath, targetPath);
			return;
		}

		await writeFile(targetPath, embeddedContent);
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

		return join(vaultPath, this.app.vault.configDir, "plugins", this.manifest.id);
	}

	private getLarkSyncStatePath(): string | null {
		const vaultPath = this.getVaultBasePath();
		if (!vaultPath) {
			return null;
		}

		return join(vaultPath, this.app.vault.configDir, "plugins", this.manifest.id, LARK_SYNC_STATE_FILE_NAME);
	}

	private async loadLarkSyncState(): Promise<LarkSyncStateFile> {
		const statePath = this.getLarkSyncStatePath();
		if (!statePath) {
			return createEmptySyncStateFile();
		}

		try {
			const rawState = await readFile(statePath, "utf8");
			const state: unknown = JSON.parse(rawState);
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
		if (this.deferredSyncStateSaveDepth > 0) {
			this.hasDeferredSyncStateSave = true;
			return;
		}

		await this.writeLarkSyncStateQueued();
	}

	private async flushDeferredLarkSyncStateSave(): Promise<void> {
		if (!this.hasDeferredSyncStateSave) {
			return;
		}

		this.hasDeferredSyncStateSave = false;
		await this.writeLarkSyncStateQueued();
	}

	private async writeLarkSyncStateQueued(): Promise<void> {
		const saveTask = this.syncStateSaveQueue.then(() => {
			return this.writeLarkSyncState();
		});
		this.syncStateSaveQueue = saveTask.catch(() => {});
		await saveTask;
	}

	private async withDeferredLarkSyncStateSave(callback: () => Promise<void>): Promise<void> {
		this.deferredSyncStateSaveDepth += 1;
		let callbackError: unknown;
		try {
			await callback();
		} catch (error) {
			callbackError = error;
		}

		try {
			this.deferredSyncStateSaveDepth -= 1;
			if (this.deferredSyncStateSaveDepth === 0) {
				await this.flushDeferredLarkSyncStateSave();
			}
		} catch (error) {
			if (!callbackError) {
				throw error;
			}
			console.warn("[Feishu Lark CLI Sync] failed to flush deferred sync state", error);
		}

		if (callbackError) {
			throw this.toError(callbackError);
		}
	}

	private async writeLarkSyncState(): Promise<void> {
		const statePath = this.getLarkSyncStatePath();
		if (!statePath) {
			return;
		}

		const tempPath = `${statePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
		const changedKeys = new Set(this.syncStateChangedKeys);
		const removedKeys = new Set(this.syncStateRemovedKeys);
		this.syncStateChangedKeys.clear();
		this.syncStateRemovedKeys.clear();
		await mkdir(dirname(statePath), { recursive: true });
		try {
			const persistedState = await this.readPersistedLarkSyncState(statePath);
			const mergedState = mergeSyncStateFiles(persistedState, this.syncState, {
				changedKeys,
				removedKeys
			});
			const nextState = this.trimSyncStateCacheIfNeeded(mergedState);
			await writeFile(tempPath, JSON.stringify(nextState, null, 2), "utf8");
			await rename(tempPath, statePath);
			this.syncState = mergeSyncStateFiles(nextState, this.syncState, {
				changedKeys: this.syncStateChangedKeys,
				removedKeys: this.syncStateRemovedKeys
			});
		} catch (error) {
			this.restorePendingSyncStateKeys(changedKeys, removedKeys);
			await rm(tempPath, { force: true });
			throw error;
		}
	}

	private async readPersistedLarkSyncState(statePath: string): Promise<LarkSyncStateFile | undefined> {
		try {
			const rawState = await readFile(statePath, "utf8");
			const state: unknown = JSON.parse(rawState);
			if (this.isValidLarkSyncStateFile(state)) {
				return {
					version: 1,
					documents: state.documents
				};
			}
		} catch (error) {
			if (!this.isFileNotFoundError(error)) {
				console.warn("[Feishu Lark CLI Sync] failed to read persisted sync state", error);
			}
		}

		return undefined;
	}

	private setDocumentSyncState(stateKey: string, state: LarkSyncStateFile["documents"][string]): void {
		this.syncState.documents[stateKey] = state;
		this.syncStateChangedKeys.add(stateKey);
		this.syncStateRemovedKeys.delete(stateKey);
	}

	private deleteDocumentSyncStateKey(stateKey: string): void {
		delete this.syncState.documents[stateKey];
		this.syncStateChangedKeys.delete(stateKey);
		this.syncStateRemovedKeys.add(stateKey);
	}

	private restorePendingSyncStateKeys(changedKeys: Iterable<string>, removedKeys: Iterable<string>): void {
		for (const key of changedKeys) {
			if (!this.syncStateRemovedKeys.has(key)) {
				this.syncStateChangedKeys.add(key);
			}
		}
		for (const key of removedKeys) {
			if (!this.syncStateChangedKeys.has(key)) {
				this.syncStateRemovedKeys.add(key);
			}
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

	private isValidLarkSyncStateFile(state: unknown): state is LarkSyncStateFile {
		if (!this.isRecord(state)
			|| state.version !== 1
			|| !this.isRecord(state.documents)) {
			return false;
		}

		return Object.values(state.documents).every((documentState) => {
			return this.isRecord(documentState)
				&& typeof documentState.doc === "string"
				&& typeof documentState.contentHash === "string"
				&& Array.isArray(documentState.units)
				&& typeof documentState.updatedAt === "string";
		});
	}

	private isFileNotFoundError(error: unknown): boolean {
		return error instanceof Error && "code" in error && error.code === "ENOENT";
	}

	private trimSyncStateCacheIfNeeded(state: LarkSyncStateFile): LarkSyncStateFile {
		const retainLimit = normalizeStateCacheRetainLimit(
			this.settings.stateCacheRetainLimit,
			DEFAULT_STATE_CACHE_RETAIN_LIMIT
		);
		return trimSyncStateCache(state, {
			retainLimit
		});
	}

	private normalizePositiveInteger(value: unknown, fallback: number): number {
		const numericValue = typeof value === "number"
			? value
			: typeof value === "string"
				? Number.parseInt(value, 10)
				: Number.NaN;
		if (!Number.isFinite(numericValue)) {
			return fallback;
		}

		return Math.max(1, Math.floor(numericValue));
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
			await this.withDeferredLarkSyncStateSave(async () => {
				const files = this.collectMarkdownFiles(folderPath);
				if (files.length === 0) {
					new Notice(this.t("noticeNoMarkdownFilesInFolder"));
					return;
				}

				const entries: FolderPublishEntry[] = [];
				const folderRoot = this.getSelectedFolderName(folderPath);
				const rootParent = await this.resolveRemoteRootParent();
				const preparedFiles = await Promise.all(files.map(async (file) => {
					const content = await this.readNoteForLark(file);
					const binding = this.getBinding(file);
					const documentParentPath = this.getRemoteParentPath(folderPath, file, folderRoot);
					return {
						file,
						content,
						binding,
						remoteParentPath: documentParentPath
					};
				}));
				const parentsByPath = await this.resolveFolderParents(rootParent, preparedFiles);
				const indexedPreparedFiles = preparedFiles.map((preparedFile, index) => {
					return {
						preparedFile,
						index
					};
				});

				const preparedFileGroups = this.groupPreparedFilesByDocument(indexedPreparedFiles);
				await this.runWithConcurrency(preparedFileGroups, FOLDER_SYNC_PARALLEL_LIMIT, async (preparedFileGroup) => {
					for (const item of preparedFileGroup) {
						await this.prepareFolderEntry(item, entries, folderRoot, rootParent, parentsByPath);
					}
				});

				await this.syncFolderEntries(folderPath, folderRoot, entries);
				this.savePublishedFolderBinding(folderPath, rootParent, folderRoot);
				await this.saveSettings();

				new Notice(this.t("noticePublishedFolderToLark", { count: String(entries.length) }), 8000);
			});
		});
	}

	private async resolveFolderParents(
		rootParent: RemoteParent,
		preparedFiles: FolderPreparedFile[]
	): Promise<Map<string, RemoteParent>> {
		const parentsByPath = new Map<string, RemoteParent>();
		let hasFolderBindingChanges = false;
		const parentPaths = uniquePathEntries(preparedFiles.map((preparedFile) => {
			return preparedFile.remoteParentPath;
		})).sort((left, right) => {
			return this.countPathSegments(left) - this.countPathSegments(right) || left.localeCompare(right);
		});

		for (const parentPath of parentPaths) {
			const resolution = await this.ensureRemoteFolderPath(rootParent, parentPath);
			parentsByPath.set(parentPath, resolution.parent);
			hasFolderBindingChanges = hasFolderBindingChanges || resolution.createdBinding;
		}

		if (hasFolderBindingChanges) {
			await this.saveSettings();
		}

		return parentsByPath;
	}

	private groupPreparedFilesByDocument(
		preparedFiles: IndexedFolderPreparedFile[]
	): IndexedFolderPreparedFile[][] {
		const groups = new Map<string, IndexedFolderPreparedFile[]>();
		for (const preparedFile of preparedFiles) {
			const binding = preparedFile.preparedFile.binding;
			const groupKey = binding ? getDocumentStateKey(binding.token || binding.url) : `new:${preparedFile.index}`;
			const group = groups.get(groupKey) || [];
			group.push(preparedFile);
			groups.set(groupKey, group);
		}

		return Array.from(groups.values());
	}

	private async prepareFolderEntry(
		item: IndexedFolderPreparedFile,
		entries: FolderPublishEntry[],
		folderRoot: string,
		rootParent: RemoteParent,
		parentsByPath: Map<string, RemoteParent>
	): Promise<void> {
		const { preparedFile, index } = item;
		const documentParent = parentsByPath.get(preparedFile.remoteParentPath) || rootParent;
		const nextBinding = preparedFile.binding
			? await this.resolveFolderBinding(
				preparedFile.file,
				preparedFile.binding,
				preparedFile.content,
				documentParent
			)
			: await this.createLarkDocument(preparedFile.file, preparedFile.content, documentParent);
		const nextBindingWithParent = this.withRemoteParentMetadata(
			nextBinding,
			folderRoot,
			preparedFile.remoteParentPath,
			documentParent
		);

		entries[index] = {
			file: preparedFile.file,
			content: preparedFile.content,
			binding: nextBindingWithParent,
			parent: documentParent,
			remoteParentPath: preparedFile.remoteParentPath,
			isNewDocument: !preparedFile.binding
				|| nextBinding.token !== preparedFile.binding.token
				|| nextBinding.url !== preparedFile.binding.url
		};

		if (this.shouldWriteBinding(preparedFile.binding, nextBindingWithParent, this.settings.updateFrontmatter)) {
			await this.writeBinding(preparedFile.file, nextBindingWithParent);
		}
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
		const entryGroups = this.groupFolderEntriesByDocument(entries);
		let hasBindingChanged = false;
		await this.runWithConcurrency(entryGroups, FOLDER_SYNC_PARALLEL_LIMIT, async (entryGroup) => {
			const groupBindingChanged = await this.syncFolderEntryGroupOnce(folderRoot, entryGroup, linkMap);
			hasBindingChanged = hasBindingChanged || groupBindingChanged;
		});

		return hasBindingChanged;
	}

	private groupFolderEntriesByDocument(entries: FolderPublishEntry[]): FolderPublishEntry[][] {
		const groups = new Map<string, FolderPublishEntry[]>();
		for (const entry of entries) {
			if (!entry.binding) {
				continue;
			}

			const groupKey = getDocumentStateKey(entry.binding.token || entry.binding.url);
			const group = groups.get(groupKey) || [];
			group.push(entry);
			groups.set(groupKey, group);
		}

		return Array.from(groups.values());
	}

	private async syncFolderEntryGroupOnce(
		folderRoot: string,
		entries: FolderPublishEntry[],
		linkMap: Map<string, LinkTarget>
	): Promise<boolean> {
		for (const entry of entries) {
			if (!entry.binding) {
				continue;
			}

			const rewrittenContent = this.rewriteInternalLinks(entry.content, linkMap, entry.file);
			if (entry.isNewDocument) {
				await this.saveCreatedDocumentStateFromBaseline(entry.binding, entry.content);
				if (rewrittenContent === entry.content) {
					continue;
				}
			}
			const strategy = entry.isNewDocument ? "precise" : undefined;

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

			if (this.shouldWriteBinding(entry.binding, nextBindingWithParent, this.settings.updateFrontmatter)) {
				await this.writeBinding(entry.file, nextBindingWithParent);
			}

		}

		return false;
	}

	private async runWithConcurrency<T>(
		items: T[],
		limit: number,
		worker: (item: T) => Promise<void>
	): Promise<void> {
		const executing = new Set<Promise<void>>();
		let firstError: unknown;
		for (const item of items) {
			let task: Promise<void>;
			task = Promise.resolve().then(() => {
				return worker(item);
			}).catch((error) => {
				firstError = firstError || error;
			}).finally(() => {
				executing.delete(task);
			});
			executing.add(task);
			if (executing.size >= limit) {
				await Promise.race(executing);
			}
		}

		await Promise.all(executing);
		if (firstError) {
			throw this.toError(firstError);
		}
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
		const normalizedContent = removeBindingOnlyFrontmatterBeforeNextFrontmatter(rawContent);
		const contentWithoutBinding = removeLarkBinding(normalizedContent);
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
		const title = extractTitle(file, content, "first-heading");
		const bodyContent = stripPreparedMarkdownTitle(content);
		return await this.withTempMarkdown(file.basename, bodyContent, async (tempFile) => {
			const args = ["docs", "+create", "--api-version", "v2", "--as", "user", "--doc-format", "markdown",
				"--title", title, "--content", `@${tempFile.fileName}`, "--json"];

			const remoteParent = parent || await this.resolveRemoteRootParent();
			if (remoteParent.token) {
				args.push("--parent-token", remoteParent.token);
			} else {
				args.push("--parent-position", "my_library");
			}

			const result = await this.runLarkCli(args, { cwd: tempFile.directory });
			const commandDocument = result.data?.["document"];
			const token = commandDocument?.document_id;
			const url = commandDocument?.url;

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
		if (strategy !== "overwrite" && this.shouldRefreshPreciseSyncState(state)) {
			state = await this.tryBootstrapPreciseSyncState(syncDoc, context.stateKeys || [], content) || state;
			syncDoc = state?.doc || syncDoc;
		}
		syncDoc = state?.doc || syncDoc;
		const plan = await buildSyncPlan({
			doc: syncDoc,
			markdown: content,
			contentFileName: "sync.md",
			strategy,
			state
		});
		if (strategy !== "overwrite" && this.shouldRetryPlanWithRefreshedState(plan)) {
			const refreshedState = await this.tryBootstrapPreciseSyncState(syncDoc, context.stateKeys || [], content);
			if (refreshedState) {
				const refreshedPlan = await buildSyncPlan({
					doc: refreshedState.doc,
					markdown: content,
					contentFileName: "sync.md",
					strategy,
					state: refreshedState
				});
				if (refreshedPlan.mode !== "blocked") {
					return await this.executeSyncPlan(refreshedState.doc, content, refreshedPlan, {
						...context,
						previousRevisionId: refreshedState.revisionId
					});
				}
			}
		}

		return await this.executeSyncPlan(syncDoc, content, plan, {
			...context,
			previousRevisionId: state?.revisionId
		});
	}

	private shouldRetryPlanWithRefreshedState(plan: SyncPlan): boolean {
		if (plan.mode === "blocked" || plan.mode === "overwrite") {
			return true;
		}

		return plan.mode === "precise" && plan.commands.some((command) => {
			return command.command === "block_insert_after"
				&& !this.isBlockDeletedByPlan(plan.commands, command.blockId);
		});
	}

	private isBlockDeletedByPlan(commands: SyncPlan["commands"], blockId: string): boolean {
		return commands.some((command) => {
			return command.command === "block_delete"
				&& command.blockId.split(",").includes(blockId);
		});
	}

	private shouldRefreshPreciseSyncState(state: LarkSyncStateFile["documents"][string] | undefined): boolean {
		return !state || !isDocumentStateBlockMappingAcceptable(state);
	}

	private findDocumentState(docs: string[]): LarkSyncStateFile["documents"][string] | undefined {
		for (const key of getDocumentStateKeys(docs)) {
			const state = this.syncState.documents[key];
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
		context: { mode: SyncMode; path: string; stateKeys?: string[]; previousRevisionId?: number }
	): Promise<Partial<BoundLarkDocument>> {
		if (plan.mode === "skipped") {
			return await this.executeSkippedSyncPlan(doc, content, plan, context);
		}

		if (plan.mode === "blocked") {
			await this.ensureRemoteDocumentExists(doc);
			throw new LocalizedSyncError(this.formatSyncFailure(context.mode, context.path, plan.reason));
		}

		return await this.withTempMarkdown("sync", content, async (tempFile) => {
			let latestDocument: LarkDocumentUpdateResult = {};
			let nextRevisionId = context.previousRevisionId;
			if (plan.mode === "overwrite") {
				this.removeSyncStateKeys([doc, ...(context.stateKeys || [])], doc);
				await this.saveLarkSyncState();
			}
			for (const [index, command] of plan.commands.entries()) {
				const contentFileName = command.command === "overwrite"
					? await this.writeTempMarkdown(tempFile.directory, `sync-${index}`, prepareOverwriteMarkdownContent(content))
					: "content" in command && command.content
					? await this.writeTempMarkdown(tempFile.directory, `sync-${index}`, command.content)
					: tempFile.fileName;
				const commandRevisionId = plan.mode === "precise" ? nextRevisionId : undefined;
				const commandWithContent = "contentFileName" in command
					? { ...command, doc, contentFileName }
					: { ...command, doc };
				const commandWithRevision = commandRevisionId === undefined
					? commandWithContent
					: { ...commandWithContent, revisionId: commandRevisionId };
				const commandArgs = buildUpdateCommandArgs(commandWithRevision);
				const result = await this.runLarkCli(commandArgs, {
					cwd: tempFile.directory
				});
				const commandDocument = result.data?.["document"];
				nextRevisionId = commandDocument?.revision_id;
				latestDocument = {
					token: commandDocument?.document_id || latestDocument.token,
					url: commandDocument?.url || latestDocument.url,
					revisionId: commandDocument?.revision_id ?? latestDocument.revisionId
				};
			}

			if (plan.mode === "precise") {
				await this.saveRemoteDocumentState(doc, context.stateKeys || [], {
					expectedMarkdown: content,
					expectedRevisionId: latestDocument.revisionId,
					allowRemoteChanges: true,
					context,
					refreshPolicy: this.getRemoteStateRefreshPolicy(context.mode)
				});
			} else if (plan.mode === "overwrite") {
				await this.saveOverwrittenDocumentState(
					doc,
					latestDocument,
					content,
					context
				);
			} else {
				await this.saveSyncPlanStateForDocument(doc, latestDocument, plan, context.stateKeys || []);
			}
			return latestDocument;
		});
	}

	private async saveSyncPlanStateForDocument(
		doc: string,
		document: Partial<BoundLarkDocument>,
		plan: SyncPlan,
		extraKeys: string[]
	): Promise<void> {
		await this.saveSyncPlanState(doc, plan);
		if (document.token || document.url) {
			this.removeSyncStateKeys([doc, document.token || "", document.url || "", ...extraKeys], doc);
			await this.saveLarkSyncState();
		}
	}

	private async saveSyncPlanState(doc: string, plan: SyncPlan): Promise<void> {
		if (plan.mode === "blocked") {
			return;
		}

		const nextState = this.getCompletePlanNextState(plan);
		if (!nextState) {
			return;
		}

		const stateKey = getDocumentStateKey(doc);
		this.setDocumentSyncState(stateKey, {
			...touchDocumentSyncState(nextState),
			doc: stateKey
		});
		await this.saveLarkSyncState();
	}

	private async saveOverwrittenDocumentState(
		doc: string,
		document: LarkDocumentUpdateResult,
		expectedMarkdown: string,
		context: { mode: SyncMode; path: string; stateKeys?: string[] }
	): Promise<void> {
		const resolvedDoc = document.token || document.url || doc;
		const stateKeys = [doc, document.token || "", document.url || "", ...(context.stateKeys || [])];
		await this.saveRemoteDocumentStateFromBaselineAfterExpectedRevision(
			resolvedDoc,
			stateKeys,
			expectedMarkdown,
			document.revisionId,
			context
		);
	}

	private async saveCreatedDocumentState(binding: BoundLarkDocument): Promise<void> {
		const remoteDoc = binding.token || binding.url;
		const [remoteMarkdown, remoteXml] = await Promise.all([
			this.fetchLarkDocumentMarkdown(remoteDoc),
			this.fetchLarkDocumentWithIds(remoteDoc)
		]);
		await this.saveRemoteDocumentStateFromFetched(remoteMarkdown, remoteXml, [remoteDoc, binding.token, binding.url]);
	}

	private async saveCreatedDocumentStateFromBaseline(
		binding: BoundLarkDocument,
		baselineMarkdown?: string
	): Promise<void> {
		if (baselineMarkdown !== undefined) {
			await this.saveSyncStateFromBaselineAndRemoteIds(binding, baselineMarkdown);
			return;
		}

		const doc = binding.token || binding.url;
		const [remoteMarkdown, remoteXml] = await Promise.all([
			this.fetchLarkDocumentMarkdown(doc),
			this.fetchLarkDocumentWithIds(doc)
		]);
		await this.saveRemoteDocumentStateFromFetched(remoteMarkdown, remoteXml, [doc, binding.token, binding.url], baselineMarkdown);
	}

	private async saveSyncStateFromBaselineAndRemoteIds(
		binding: BoundLarkDocument,
		baselineMarkdown: string
	): Promise<void> {
		const doc = binding.token || binding.url;
		const remoteXml = await this.fetchLarkDocumentWithIds(doc);
		const remoteMarkdown = {
			doc: remoteXml.doc,
			content: baselineMarkdown,
			revisionId: remoteXml.revisionId
		};
		await this.saveRemoteDocumentStateFromFetched(remoteMarkdown, remoteXml, [doc, binding.token, binding.url], baselineMarkdown);
	}

	private async saveRemoteDocumentStateFromBaselineAfterExpectedRevision(
		doc: string,
		stateKeys: string[],
		baselineMarkdown: string,
		expectedRevisionId: number | undefined,
		context: { mode: SyncMode; path: string }
	): Promise<void> {
		const refreshPolicy = this.getRemoteStateRefreshPolicy(context.mode);
		const expectedSignature = await createSyncContentSignature(baselineMarkdown);
		for (let attempt = 0; attempt < refreshPolicy.attempts; attempt += 1) {
			const remoteXml = await this.fetchLarkDocumentWithIds(doc);
			if (expectedRevisionId !== undefined
				&& (remoteXml.revisionId === undefined || remoteXml.revisionId < expectedRevisionId)) {
				if (attempt < refreshPolicy.attempts - 1) {
					await this.sleep(refreshPolicy.delayMs);
				}
				continue;
			}

			const actualRemoteMarkdown = await this.fetchLarkDocumentMarkdown(doc);
			if (!await this.isRemoteMarkdownContentEquivalent(actualRemoteMarkdown.content, expectedSignature)) {
				if (attempt < refreshPolicy.attempts - 1) {
					await this.sleep(refreshPolicy.delayMs);
				}
				continue;
			}

			const stateMarkdown = {
				doc: remoteXml.doc,
				content: baselineMarkdown,
				revisionId: remoteXml.revisionId
			};
			const state = await this.createRemoteDocumentState(doc, stateMarkdown, remoteXml, baselineMarkdown);
			if (isDocumentStateBlockMappingAcceptable(state)) {
				await this.persistDocumentState(state, [doc, ...stateKeys]);
				return;
			}

			if (attempt < refreshPolicy.attempts - 1) {
				await this.sleep(refreshPolicy.delayMs);
			}
		}

		throw new LocalizedSyncError(
			this.formatSyncFailure(context.mode, context.path, "remote-update-not-visible")
		);
	}

	private async saveRemoteDocumentStateFromFetched(
		remoteMarkdown: { doc?: string; content: string; revisionId?: number },
		remoteXml: { doc?: string; content: string; revisionId?: number },
		stateKeys: Array<string | undefined>,
		baselineMarkdown?: string
	): Promise<void> {
		const remoteDoc = remoteXml.doc || remoteMarkdown.doc || stateKeys.find((key) => key) || "";
		const effectiveMarkdown = baselineMarkdown || remoteMarkdown.content;
		const state = await createDocumentSyncStateFromRemote(
			remoteDoc,
			effectiveMarkdown,
			remoteXml.content,
			remoteXml.revisionId ?? remoteMarkdown.revisionId
		);
		await this.persistDocumentState(state, stateKeys.filter((key): key is string => Boolean(key)));
	}

	private removeSyncStateKeys(docs: string[], keepDoc: string): void {
		const keepKey = getDocumentStateKey(keepDoc);
		for (const key of getDocumentStateKeys(docs)) {
			if (key !== keepKey) {
				this.deleteDocumentSyncStateKey(key);
			}
		}
	}

	private async saveRemoteDocumentState(
		doc: string,
		stateKeys: string[],
		options: {
			expectedMarkdown?: string;
			expectedRevisionId?: number;
			previousRevisionId?: number;
			fallbackState?: LarkSyncStateFile["documents"][string];
			fallbackMarkdown?: string;
			allowIncompleteFallback?: boolean;
			allowRemoteChanges?: boolean;
			refreshPolicy?: RemoteStateRefreshPolicy;
			context?: { mode: SyncMode; path: string };
		} = {}
	): Promise<void> {
		const refreshPolicy = options.refreshPolicy || STRICT_REMOTE_STATE_REFRESH_POLICY;
		const expectedSignature = options.expectedMarkdown
			? await createSyncContentSignature(options.expectedMarkdown)
			: undefined;
		let state: LarkSyncStateFile["documents"][string] | undefined;
		let latestState: LarkSyncStateFile["documents"][string] | undefined;
		for (let attempt = 0; attempt < refreshPolicy.attempts; attempt += 1) {
			const remoteState = options.expectedRevisionId !== undefined
				? await this.fetchRemoteDocumentStateAfterExpectedRevision(
					doc,
					options.expectedRevisionId,
					expectedSignature,
					options.expectedMarkdown,
					options.allowRemoteChanges
				)
				: await this.fetchRemoteDocumentState(
					doc,
					options.expectedMarkdown,
					options.allowRemoteChanges
				);
			latestState = remoteState;
			if (remoteState
				&& this.isRemoteDocumentStateRefreshAccepted(remoteState, expectedSignature, options.previousRevisionId)) {
				state = remoteState;
				break;
			}

			if (attempt < refreshPolicy.attempts - 1) {
				await this.sleep(refreshPolicy.delayMs);
			}
		}

		if (!state && refreshPolicy.allowTimeoutFallback && !options.expectedMarkdown) {
			state = this.firstCompleteSyncState([latestState]);
			if (!state) {
				const refreshedState = await this.fetchRemoteDocumentState(doc);
				state = this.firstCompleteSyncState([refreshedState]);
			}
		}
		if (!state && options.allowIncompleteFallback) {
			state = await this.selectIncompleteFallbackState(doc, latestState, options);
		}
		if (state && options.allowIncompleteFallback && state.units.length === 0 && options.fallbackMarkdown) {
			state = await this.createIncompleteFallbackState(doc, {
				...options,
				fallbackState: state
			});
		}

		if (!state) {
			if (options.context) {
				throw new LocalizedSyncError(
					this.formatSyncFailure(options.context.mode, options.context.path, "remote-update-not-visible")
				);
			}
			return;
		}

		await this.persistDocumentState(state, [doc, ...stateKeys]);
	}

	private async selectIncompleteFallbackState(
		doc: string,
		latestState: LarkSyncStateFile["documents"][string] | undefined,
		options: {
			expectedRevisionId?: number;
			fallbackState?: LarkSyncStateFile["documents"][string];
			fallbackMarkdown?: string;
		}
	): Promise<LarkSyncStateFile["documents"][string] | undefined> {
		if (latestState && latestState.units.length > 0) {
			return latestState;
		}

		return await this.createIncompleteFallbackState(doc, {
			...options,
			fallbackState: latestState || options.fallbackState
		});
	}

	private async createIncompleteFallbackState(
		doc: string,
		options: {
			expectedRevisionId?: number;
			fallbackState?: LarkSyncStateFile["documents"][string];
			fallbackMarkdown?: string;
		}
	): Promise<LarkSyncStateFile["documents"][string] | undefined> {
		if (this.isCompleteSyncState(options.fallbackState) || !options.fallbackMarkdown) {
			return options.fallbackState;
		}

		return await createIncompleteDocumentSyncStateFromMarkdown(
			doc,
			options.fallbackMarkdown,
			options.expectedRevisionId ?? options.fallbackState?.revisionId
		);
	}

	private async fetchRemoteDocumentStateAfterExpectedRevision(
		doc: string,
		expectedRevisionId: number,
		expectedSignature: Awaited<ReturnType<typeof createSyncContentSignature>> | undefined,
		expectedMarkdown?: string,
		allowRemoteChanges = false
	): Promise<LarkSyncStateFile["documents"][string] | undefined> {
		const remoteXml = await this.fetchLarkDocumentWithIds(doc);
		if (remoteXml.revisionId === undefined || remoteXml.revisionId < expectedRevisionId) {
			return undefined;
		}
		if (allowRemoteChanges && expectedMarkdown) {
			const state = await this.createRemoteDocumentState(
				doc,
				{ doc: remoteXml.doc, content: expectedMarkdown, revisionId: remoteXml.revisionId },
				remoteXml,
				expectedMarkdown
			);
			return isDocumentStateBlockMappingAcceptable(state) ? state : undefined;
		}

		const remoteMarkdown = await this.fetchLarkDocumentMarkdown(doc);
		if (remoteMarkdown.revisionId !== undefined && remoteMarkdown.revisionId < expectedRevisionId) {
			return undefined;
		}

		if (expectedMarkdown && expectedSignature) {
			const isExpectedContentVisible = await this.isRemoteMarkdownContentEquivalent(
				remoteMarkdown.content,
				expectedSignature
			);
			if (!isExpectedContentVisible) {
				return undefined;
			}
		}

		const state = await this.createRemoteDocumentState(doc, remoteMarkdown, remoteXml, expectedMarkdown);
		if (expectedMarkdown && !isDocumentStateBlockMappingAcceptable(state)) {
			return undefined;
		}

		return state;
	}

	private async fetchRemoteDocumentState(
		doc: string,
		baselineMarkdown?: string,
		allowRemoteChanges = false
	): Promise<LarkSyncStateFile["documents"][string] | undefined> {
		if (allowRemoteChanges && baselineMarkdown) {
			const remoteXml = await this.fetchLarkDocumentWithIds(doc);
			const state = await this.createRemoteDocumentState(
				doc,
				{ doc: remoteXml.doc, content: baselineMarkdown, revisionId: remoteXml.revisionId },
				remoteXml,
				baselineMarkdown
			);
			return isDocumentStateBlockMappingAcceptable(state) ? state : undefined;
		}

		const [remoteMarkdown, remoteXml] = await Promise.all([
			this.fetchLarkDocumentMarkdown(doc),
			this.fetchLarkDocumentWithIds(doc)
		]);
		if (baselineMarkdown) {
			const expectedSignature = await createSyncContentSignature(baselineMarkdown);
			if (!await this.isRemoteMarkdownContentEquivalent(remoteMarkdown.content, expectedSignature)) {
				return undefined;
			}
		}

		const state = await this.createRemoteDocumentState(doc, remoteMarkdown, remoteXml, baselineMarkdown);
		if (baselineMarkdown && !isDocumentStateBlockMappingAcceptable(state)) {
			return undefined;
		}

		return state;
	}

	private async createRemoteDocumentState(
		doc: string,
		remoteMarkdown: { doc?: string; content: string; revisionId?: number },
		remoteXml: { doc?: string; content: string; revisionId?: number },
		baselineMarkdown?: string
	): Promise<LarkSyncStateFile["documents"][string]> {
		const remoteDoc = remoteXml.doc || remoteMarkdown?.doc || doc;
		return await createDocumentSyncStateFromRemote(
			remoteDoc,
			baselineMarkdown || remoteMarkdown.content,
			remoteXml.content,
			remoteXml.revisionId ?? remoteMarkdown.revisionId
		);
	}

	private async isRemoteMarkdownContentEquivalent(
		remoteMarkdown: string,
		expectedSignature: Awaited<ReturnType<typeof createSyncContentSignature>>
	): Promise<boolean> {
		const remoteSignature = await createSyncContentSignature(remoteMarkdown);
		return isSyncContentSignatureEquivalent(remoteSignature, expectedSignature);
	}

	private isRemoteDocumentStateRefreshAccepted(
		remoteState: LarkSyncStateFile["documents"][string],
		expectedSignature: Awaited<ReturnType<typeof createSyncContentSignature>> | undefined,
		previousRevisionId: number | undefined
	): boolean {
		if (expectedSignature) {
			return isDocumentStateContentEquivalent(remoteState, expectedSignature);
		}

		if (previousRevisionId !== undefined) {
			return remoteState.revisionId !== undefined && remoteState.revisionId !== previousRevisionId;
		}

		return true;
	}

	private getPlanNextState(plan: SyncPlan): LarkSyncStateFile["documents"][string] | undefined {
		if (!("nextState" in plan)) {
			return undefined;
		}

		return plan.nextState;
	}

	private getCompletePlanNextState(plan: SyncPlan): LarkSyncStateFile["documents"][string] | undefined {
		const nextState = this.getPlanNextState(plan);
		if (!this.isCompleteSyncState(nextState)) {
			return undefined;
		}

		return nextState;
	}

	private firstCompleteSyncState(
		states: Array<LarkSyncStateFile["documents"][string] | undefined>
	): LarkSyncStateFile["documents"][string] | undefined {
		return states.find((state) => this.isCompleteSyncState(state));
	}

	private isCompleteSyncState(state: LarkSyncStateFile["documents"][string] | undefined): boolean {
		if (!state) {
			return false;
		}

		return state.units.length > 0
			&& state.units.every((unit) => Boolean(unit.blockId));
	}

	private getRemoteStateRefreshPolicy(mode: SyncMode): RemoteStateRefreshPolicy {
		if (mode === "save") {
			return SAVE_REMOTE_STATE_REFRESH_POLICY;
		}

		return STRICT_REMOTE_STATE_REFRESH_POLICY;
	}

	private async persistDocumentState(
		state: LarkSyncStateFile["documents"][string],
		aliases: string[]
	): Promise<void> {
		const stateKey = getDocumentStateKey(state.doc);
		this.setDocumentSyncState(stateKey, {
			...touchDocumentSyncState(state),
			doc: stateKey
		});
		this.removeSyncStateKeys(aliases, stateKey);
		await this.saveLarkSyncState();
	}

	private async tryBootstrapPreciseSyncState(
		doc: string,
		stateKeys: string[],
		expectedMarkdown?: string
	): Promise<LarkSyncStateFile["documents"][string] | undefined> {
		const [remoteMarkdown, remoteXml] = await Promise.all([
			this.fetchLarkDocumentMarkdown(doc),
			this.fetchLarkDocumentWithIds(doc)
		]);
		const remoteDoc = remoteXml.doc || remoteMarkdown?.doc || doc;
		const baselineMarkdown = remoteMarkdown?.content || expectedMarkdown || "";
		const state = await createDocumentSyncStateFromRemote(
			remoteDoc,
			baselineMarkdown,
			remoteXml.content,
			remoteXml.revisionId
		);
		if (isDocumentStateBlockMappingAcceptable(state)) {
			await this.persistDocumentState(state, [doc, remoteDoc, ...stateKeys]);
			return state;
		}
		return undefined;
	}

	private async fetchLarkDocumentMarkdown(doc: string): Promise<{ doc?: string; content: string; revisionId?: number }> {
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
			doc: result.data?.["document"]?.document_id,
			content: result.data?.["document"]?.content || "",
			revisionId: result.data?.["document"]?.revision_id
		};
	}

	private async fetchLarkDocumentWithIds(doc: string): Promise<{ doc?: string; content: string; revisionId?: number }> {
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
			doc: result.data?.["document"]?.document_id,
			content: result.data?.["document"]?.content || "",
			revisionId: result.data?.["document"]?.revision_id
		};
	}

	private async fetchLarkDocumentRevisionId(doc: string): Promise<number | undefined> {
		const remoteMarkdown = await this.fetchLarkDocumentMarkdown(doc);
		return remoteMarkdown.revisionId;
	}

	private async sleep(ms: number): Promise<void> {
		await new Promise((resolvePromise) => window.setTimeout(resolvePromise, ms));
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

	private async executeSkippedSyncPlan(
		doc: string,
		content: string,
		plan: SyncPlan,
		context: { mode: SyncMode; path: string; stateKeys?: string[]; previousRevisionId?: number }
	): Promise<Partial<BoundLarkDocument>> {
		const remoteMarkdown = await this.fetchLarkDocumentMarkdown(doc);
		const [remoteSignature, expectedSignature] = await Promise.all([
			createSyncContentSignature(remoteMarkdown.content),
			createSyncContentSignature(content)
		]);
		if (isSyncContentSignatureEquivalent(remoteSignature, expectedSignature)) {
			const nextState = this.getPlanNextState(plan);
			const refreshedPlan = nextState && remoteMarkdown.revisionId !== undefined
				? { ...plan, nextState: { ...nextState, revisionId: remoteMarkdown.revisionId } }
				: plan;
			await this.saveSyncPlanStateForDocument(doc, {}, refreshedPlan, context.stateKeys || []);
			return {};
		}

		await this.saveRemoteDocumentState(doc, context.stateKeys || [], {
			expectedMarkdown: content,
			expectedRevisionId: remoteMarkdown.revisionId,
			allowRemoteChanges: true,
			context,
			refreshPolicy: this.getRemoteStateRefreshPolicy(context.mode)
		});
		return {};
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
			await this.saveCreatedDocumentStateFromBaseline(recreatedBinding, content);
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
			await this.saveCreatedDocumentStateFromBaseline(recreatedBinding, content);
			return recreatedBinding;
		}
	}

	private hasBindingChanged(previous: BoundLarkDocument | null | undefined, next: BoundLarkDocument): boolean {
		return Boolean(previous)
			&& (previous?.token !== next.token || previous.url !== next.url);
	}

	private shouldWriteBinding(
		previous: BoundLarkDocument | null | undefined,
		next: BoundLarkDocument,
		updateFrontmatter: boolean
	): boolean {
		if (this.hasBindingChanged(previous, next)) {
			return true;
		}

		if (!updateFrontmatter) {
			return false;
		}

		return !previous
			|| previous.url !== next.url
			|| Boolean(previous.token)
			|| previous.remoteRoot !== next.remoteRoot
			|| previous.remoteParentPath !== next.remoteParentPath;
	}

	private removeSyncStateForBinding(binding: BoundLarkDocument): void {
		this.removeSyncStateForDocuments(this.getBindingAliases(binding));
	}

	private removeSyncStateForDocuments(docs: string[]): void {
		const keys = uniquePathEntries([...docs, ...getDocumentStateKeys(docs)]);
		for (const key of keys) {
			this.deleteDocumentSyncStateKey(key);
		}
	}

	private getBindingAliases(binding: BoundLarkDocument): string[] {
		return uniquePathEntries([
			binding.token,
			binding.url,
			binding.url ? extractDocumentToken(binding.url) : ""
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

	private countPathSegments(path: string): number {
		return this.normalizeLinkPath(path).split("/").filter(Boolean).length;
	}

	private parentPath(path: string): string {
		return parentPath(path);
	}

	private async resolvePublishedFolderParentForFile(file: TFile): Promise<FolderDocumentParent | null> {
		const publishedFolder = this.findPublishedFolderForFile(file);
		if (!publishedFolder) {
			return null;
		}

		const remoteParentPath = this.getRemoteParentPath(publishedFolder.folderPath, file, publishedFolder.binding.remoteRoot);
		const resolution = await this.ensureRemoteFolderPath(publishedFolder.binding.rootParent, remoteParentPath);
		if (publishedFolder.inferred || resolution.createdBinding) {
			await this.saveSettings();
		}

		return {
			parent: resolution.parent,
			remoteRoot: publishedFolder.binding.remoteRoot,
			remoteParentPath
		};
	}

	private findPublishedFolderForFile(file: TFile): PublishedFolderResolution | null {
		let folderPath = this.parentPath(file.path);
		while (folderPath) {
			const normalizedFolderPath = this.normalizeLinkPath(folderPath);
			const existingBinding = this.settings.publishedFolders[normalizedFolderPath];
			const binding = existingBinding || this.inferPublishedFolderBinding(normalizedFolderPath);
			if (binding) {
				this.settings.publishedFolders[normalizedFolderPath] = binding;
				return {
					folderPath,
					binding,
					inferred: !existingBinding
				};
			}

			folderPath = this.parentPath(folderPath);
		}

		return null;
	}

	private inferPublishedFolderBinding(folderPath: string): PublishedFolderBinding | null {
		const remoteRoot = this.getSelectedFolderName(folderPath);
		for (const bindingKey of Object.keys(this.settings.folderBindings)) {
			const bindingPath = this.getFolderBindingPath(bindingKey);
			if (bindingPath !== remoteRoot) {
				continue;
			}

			return {
				rootParent: this.getFolderBindingRootParent(bindingKey),
				remoteRoot
			};
		}

		return null;
	}

	private getFolderBindingPath(bindingKey: string): string {
		const segments = bindingKey.split("|");
		return this.normalizeLinkPath(segments[3] || "");
	}

	private getFolderBindingRootParent(bindingKey: string): RemoteParent {
		const segments = bindingKey.split("|");
		return {
			kind: this.normalizeRemoteParentKind(segments[1]),
			token: segments[2] || ""
		};
	}

	private normalizeRemoteParentKind(kind: string | undefined): RemoteParentKind {
		if (kind === "wiki" || kind === "drive" || kind === "my_library" || kind === "unknown") {
			return kind;
		}

		return "unknown";
	}

	private savePublishedFolderBinding(folderPath: string, rootParent: RemoteParent, remoteRoot: string): void {
		this.settings.publishedFolders[this.normalizeLinkPath(folderPath)] = {
			rootParent,
			remoteRoot
		};
	}

	private async ensureRemoteFolderPath(
		rootParent: RemoteParent,
		folderPath: string
	): Promise<RemoteFolderPathResolution> {
		const normalizedFolderPath = this.normalizeLinkPath(folderPath);
		if (!normalizedFolderPath) {
			return {
				parent: rootParent,
				createdBinding: false
			};
		}

		let parent = rootParent;
		let createdBinding = false;
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
			createdBinding = true;
			parent = {
				token: folderBinding.token,
				kind: folderBinding.containerKind || parent.kind
			};
		}

		return {
			parent,
			createdBinding
		};
	}

	private async createRemoteFolderPage(name: string, parent: RemoteParent): Promise<BoundLarkDocument> {
		if (parent.kind === "drive") {
			const result = await this.runLarkCli(["drive", "+create-folder", "--as", "user",
				"--folder-token", parent.token, "--name", name, "--json"]);
			const token = result.data?.folder_token;
			const url = result.data?.url || "";

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
		const token = result.data?.node_token;
		const url = result.data?.url || "";

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
		const bodyContent = stripPreparedMarkdownTitle(content);
		return await this.withTempMarkdown(name, bodyContent, async (tempFile) => {
			const args = ["docs", "+create", "--api-version", "v2", "--as", "user", "--doc-format", "markdown",
				"--title", name, "--content", `@${tempFile.fileName}`, "--json"];

			if (parent.token) {
				args.push("--parent-token", parent.token);
			} else {
				args.push("--parent-position", "my_library");
			}

			const result = await this.runLarkCli(args, { cwd: tempFile.directory });
			const commandDocument = result.data?.["document"];
			const token = result.data?.wiki_node?.node_token || commandDocument?.document_id;
			const url = commandDocument?.url || result.data?.url || "";

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

		const result = await this.inspectDefaultTarget(target);
		const kind = target.includes("/drive/folder/") ? "drive" : "wiki";
		const token = kind === "drive"
			? result.data?.token || extractDocumentToken(target)
			: result.data?.wiki_node?.node_token || result.data?.node?.node_token || result.data?.token || extractDocumentToken(target);

		return {
			token,
			kind
		};
	}

	private async inspectDefaultTarget(target: string): Promise<LarkCommandResult> {
		try {
			return await this.runLarkCli(["drive", "+inspect", "--as", "user", "--url", target, "--json"]);
		} catch (error) {
			const detail = this.formatNoticeErrorDetail(error);
			throw new LocalizedSyncError(this.t("errorInvalidDefaultTarget", {
				target,
				detail
			}));
		}
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

	private async runLarkCli(args: string[], options: LarkCommandOptions = {}): Promise<LarkCommandResult> {
		return await this.runLarkCliQueued(args, options);
	}

	private async runLarkCliQueued(args: string[], options: LarkCommandOptions): Promise<LarkCommandResult> {
		const previousRequest = this.larkCliRequestQueue;
		let releaseRequestSlot: () => void = () => {};
		this.larkCliRequestQueue = new Promise((resolveRequestSlot) => {
			releaseRequestSlot = resolveRequestSlot;
		});

		await previousRequest;
		try {
			while (this.larkCliActiveRequestCount >= LARK_CLI_MAX_CONCURRENT_REQUESTS) {
				await this.sleep(LARK_CLI_REQUEST_INTERVAL_MS);
			}
			await this.waitForLarkCliStartInterval();
			this.larkCliActiveRequestCount += 1;
		} finally {
			releaseRequestSlot();
		}

		try {
			return await this.runLarkCliWithRetry(args, options);
		} catch (error) {
			throw new Error(this.formatCommandError(error));
		} finally {
			this.larkCliActiveRequestCount = Math.max(0, this.larkCliActiveRequestCount - 1);
		}
	}

	private async waitForLarkCliStartInterval(): Promise<void> {
		const elapsedMs = Date.now() - this.lastLarkCliRequestAt;
		if (elapsedMs < LARK_CLI_REQUEST_INTERVAL_MS) {
			await this.sleep(LARK_CLI_REQUEST_INTERVAL_MS - elapsedMs);
		}
		this.lastLarkCliRequestAt = Date.now();
	}

	private async runLarkCliWithRetry(args: string[], options: LarkCommandOptions): Promise<LarkCommandResult> {
		for (let attempt = 0; attempt <= LARK_CLI_RATE_LIMIT_RETRY_DELAYS_MS.length; attempt += 1) {
			try {
				return await this.runLarkCliOnce(args, options);
			} catch (error) {
				if (!this.isLarkRateLimitError(error) || attempt >= LARK_CLI_RATE_LIMIT_RETRY_DELAYS_MS.length) {
					throw error;
				}

				const retryDelayMs = LARK_CLI_RATE_LIMIT_RETRY_DELAYS_MS[attempt];
				if (retryDelayMs === undefined) {
					throw error;
				}
				await this.sleep(retryDelayMs);
			}
		}

		throw new Error("lark-cli request failed.");
	}

	private async runLarkCliOnce(args: string[], options: LarkCommandOptions): Promise<LarkCommandResult> {
		const executable = await this.resolveLarkCliPath();
		const env = await this.buildCommandEnvironment(executable);
		await this.ensureSupportedLarkCliVersion(executable, env);
		const { stdout } = await execFileAsync(executable, withDocsApiVersion(args), {
			cwd: options.cwd,
			env,
			shell: shouldUseCommandShell(executable),
			maxBuffer: 20 * 1024 * 1024
		});
		const result = this.parseLarkCommandResult(stdout);

		if (!result.ok) {
			throw new Error(this.formatLarkError(result));
		}

		return result;
	}

	private async ensureSupportedLarkCliVersion(executable: string, env: NodeJS.ProcessEnv): Promise<void> {
		if (this.checkedLarkCliVersionExecutable === executable) {
			return;
		}

		const cachedCheck = this.settings.larkCliVersionCheck;
		if (cachedCheck?.executable === executable && isSupportedLarkCliVersion(cachedCheck.version)) {
			this.checkedLarkCliVersionExecutable = executable;
			return;
		}

		if (this.pendingLarkCliVersionCheck && this.pendingLarkCliVersionExecutable === executable) {
			return await this.pendingLarkCliVersionCheck;
		}

		this.pendingLarkCliVersionExecutable = executable;
		this.pendingLarkCliVersionCheck = this.checkLarkCliVersion(executable, env);
		try {
			await this.pendingLarkCliVersionCheck;
		} finally {
			this.pendingLarkCliVersionExecutable = "";
			this.pendingLarkCliVersionCheck = null;
		}
	}

	private async checkLarkCliVersion(executable: string, env: NodeJS.ProcessEnv): Promise<void> {
		let versionOutput: string;
		try {
			versionOutput = await this.readLarkCliVersionOutput(executable, env);
		} catch (error) {
			if (this.isExecutableLaunchError(error)) {
				throw new Error(formatMissingLarkCli(this.settings.language));
			}
			throw error;
		}

		const version = parseLarkCliVersion(versionOutput);
		if (!isSupportedLarkCliVersion(version)) {
			throw new Error(formatUnsupportedLarkCliVersion(version, this.settings.language));
		}

		this.settings.larkCliVersionCheck = {
			executable,
			version
		};
		await this.saveSettingsWithoutClearingCommandCache();
		this.checkedLarkCliVersionExecutable = executable;
	}

	private async readLarkCliVersionOutput(executable: string, env: NodeJS.ProcessEnv): Promise<string> {
		let lastError: unknown = null;
		let onlyUnsupportedVersionCommands = true;
		for (const args of LARK_CLI_VERSION_ARGS) {
			try {
				const { stdout, stderr } = await execFileAsync(executable, args, {
					env,
					shell: shouldUseCommandShell(executable),
					maxBuffer: 1024 * 1024
				});
				return `${this.commandOutputToString(stdout)}\n${this.commandOutputToString(stderr)}`;
			} catch (error) {
				lastError = error;
				if (!this.isUnsupportedVersionCommandError(error)) {
					onlyUnsupportedVersionCommands = false;
				}
			}
		}

		if (onlyUnsupportedVersionCommands) {
			return "";
		}
		throw this.toError(lastError);
	}

	private isExecutableLaunchError(error: unknown): boolean {
		if (!(error instanceof Error) || !("code" in error)) {
			return false;
		}
		return error.code === "ENOENT" || error.code === "EACCES";
	}

	private isUnsupportedVersionCommandError(error: unknown): boolean {
		const message = [
			error instanceof Error ? error.message : String(error),
			this.hasCommandStderr(error) ? this.commandOutputToString(error.stderr) : "",
			this.hasCommandStdout(error) ? this.commandOutputToString(error.stdout) : ""
		].join("\n").toLowerCase();
		return message.includes("unknown command")
			|| message.includes("unknown flag")
			|| message.includes("unknown shorthand flag")
			|| message.includes("unknown option")
			|| message.includes("unrecognized option");
	}

	private isLarkRateLimitError(error: unknown): boolean {
		const message = error instanceof Error ? error.message : String(error);
		const normalizedMessage = message.toLowerCase();
		return normalizedMessage.includes("request trigger frequency limit")
			|| normalizedMessage.includes("frequency limit")
			|| normalizedMessage.includes("rate limit")
			|| normalizedMessage.includes("too many requests");
	}

	private formatLarkError(result: LarkCommandResult): string {
		const message = result.error?.message || "lark-cli request failed.";
		const hint = result.error?.hint;
		return hint ? `${message}\n${hint}` : message;
	}

	private formatCommandError(error: unknown): string {
		if (this.hasCommandStderr(error)) {
			const stderr = this.commandOutputToString(error.stderr).trim();
			if (stderr) {
				return this.formatStderr(stderr);
			}
		}

		if (this.hasCommandStdout(error)) {
			const stdout = this.commandOutputToString(error.stdout).trim();
			if (stdout) {
				return this.formatStderr(stdout);
			}
		}

		if (error instanceof Error) {
			return error.message;
		}

		return String(error);
	}

	private hasCommandStderr(error: unknown): error is Error & { stderr: unknown } {
		return error instanceof Error && "stderr" in error;
	}

	private hasCommandStdout(error: unknown): error is Error & { stdout: unknown } {
		return error instanceof Error && "stdout" in error;
	}

	private commandOutputToString(output: unknown): string {
		if (typeof output === "string") {
			return output;
		}
		if (Buffer.isBuffer(output)) {
			return output.toString("utf8");
		}
		return "";
	}

	private toError(error: unknown): Error {
		return error instanceof Error ? error : new Error(String(error));
	}

	private formatStderr(stderr: string): string {
		const parsed = this.tryParseLarkCommandResult(stderr);
		if (parsed?.error?.message) {
			return this.formatLarkError(parsed);
		}

		const embeddedJson = this.extractEmbeddedJson(stderr);
		if (embeddedJson) {
			const embeddedResult = this.tryParseLarkCommandResult(embeddedJson);
			if (embeddedResult?.error?.message) {
				return this.formatLarkError(embeddedResult);
			}
		}

		return stderr.slice(0, MAX_STDERR_LENGTH);
	}

	private parseLarkCommandResult(rawJson: string): LarkCommandResult {
		const parsed: unknown = JSON.parse(rawJson);
		if (!this.isLarkCommandResult(parsed)) {
			throw new Error("lark-cli returned an invalid JSON response.");
		}

		return parsed;
	}

	private tryParseLarkCommandResult(rawJson: string): LarkCommandResult | null {
		try {
			const parsed: unknown = JSON.parse(rawJson);
			return this.isLarkCommandResult(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}

	private isLarkCommandResult(value: unknown): value is LarkCommandResult {
		if (!this.isRecord(value) || typeof value.ok !== "boolean") {
			return false;
		}

		const data = value.data;
		const error = value.error;
		return (data === undefined || this.isLarkCommandData(data))
			&& (error === undefined || this.isLarkCommandError(error));
	}

	private isLarkCommandData(value: unknown): value is LarkCommandResult["data"] {
		if (!this.isRecord(value)) {
			return false;
		}

		return this.isOptionalString(value.token)
			&& this.isOptionalString(value.folder_token)
			&& this.isOptionalString(value.comment_id)
			&& this.isOptionalString(value.reply_id)
			&& this.isOptionalString(value.node_token)
			&& this.isOptionalString(value.obj_token)
			&& this.isOptionalString(value.url)
			&& this.isOptionalLarkCommandDocument(value["document"])
			&& this.isOptionalLarkCommandNode(value.node)
			&& this.isOptionalLarkCommandNode(value.wiki_node);
	}

	private isLarkCommandError(value: unknown): value is LarkCommandResult["error"] {
		return this.isRecord(value)
			&& this.isOptionalString(value.message)
			&& this.isOptionalString(value.hint);
	}

	private isOptionalLarkCommandDocument(value: unknown): value is LarkCommandDocument | undefined {
		if (value === undefined) {
			return true;
		}

		return this.isRecord(value)
			&& this.isOptionalString(value.document_id)
			&& this.isOptionalString(value.url)
			&& this.isOptionalNumber(value.revision_id)
			&& this.isOptionalString(value.content);
	}

	private isOptionalLarkCommandNode(value: unknown): value is LarkCommandNode | undefined {
		if (value === undefined) {
			return true;
		}

		return this.isRecord(value)
			&& this.isOptionalString(value.node_token)
			&& this.isOptionalString(value.obj_token)
			&& this.isOptionalString(value.url);
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return Boolean(value) && typeof value === "object" && !Array.isArray(value);
	}

	private isOptionalString(value: unknown): value is string | undefined {
		return value === undefined || typeof value === "string";
	}

	private isOptionalNumber(value: unknown): value is number | undefined {
		return value === undefined || typeof value === "number";
	}

	private extractEmbeddedJson(text: string): string {
		const firstBrace = text.indexOf("{");
		const lastBrace = text.lastIndexOf("}");
		if (firstBrace < 0 || lastBrace <= firstBrace) {
			return "";
		}

		return text.slice(firstBrace, lastBrace + 1);
	}

	private formatNoticeErrorDetail(error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		const lines = message.split("\n").map((line) => line.trim()).filter(Boolean);
		const detail = lines[0] || message;
		return detail.slice(0, MAX_NOTICE_ERROR_DETAIL_LENGTH);
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
		const shellPath = await this.getLoginShellPath();
		if (this.cachedCommandEnvironment
			&& this.cachedCommandEnvironmentExecutable === executable
			&& this.cachedCommandEnvironmentShellPath === shellPath) {
			return this.cachedCommandEnvironment;
		}

		const env = buildLarkCommandEnvironment(executable, {
			loginShellPath: shellPath
		});
		this.cachedCommandEnvironment = env;
		this.cachedCommandEnvironmentExecutable = executable;
		this.cachedCommandEnvironmentShellPath = shellPath;
		return env;
	}

	private async resolveLarkCliPath(): Promise<string> {
		const configuredPath = this.settings.larkCliPath.trim();
		if (this.cachedLarkCliPathSetting === configuredPath && this.cachedLarkCliPath) {
			return this.cachedLarkCliPath;
		}

		if (this.pendingLarkCliPath) {
			return await this.pendingLarkCliPath;
		}

		this.pendingLarkCliPath = this.resolveLarkCliPathUncached(configuredPath);
		try {
			return await this.pendingLarkCliPath;
		} finally {
			this.pendingLarkCliPath = null;
		}
	}

	private async resolveLarkCliPathUncached(configuredPath: string): Promise<string> {
		const resolvedPath = await resolveLarkCliPathFromSetting(configuredPath, {
			env: process.env,
			canExecute: (path) => this.canExecute(path),
			pathExists: (path) => this.pathExists(path),
			isDirectory: (path) => this.isDirectory(path),
			resolveCommandFromLoginShell: (command) => this.resolveCommandFromLoginShell(command)
		});
		return this.cacheResolvedLarkCliPath(configuredPath, resolvedPath);
	}

	private cacheResolvedLarkCliPath(setting: string, resolvedPath: string): string {
		this.cachedLarkCliPathSetting = setting;
		this.cachedLarkCliPath = resolvedPath;
		this.cachedCommandEnvironment = null;
		this.cachedCommandEnvironmentExecutable = "";
		this.cachedCommandEnvironmentShellPath = "";
		return resolvedPath;
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
		if (this.cachedLoginShellPath !== null) {
			return this.cachedLoginShellPath;
		}

		if (this.pendingLoginShellPath) {
			return await this.pendingLoginShellPath;
		}

		this.pendingLoginShellPath = this.resolveLoginShellPathUncached();
		try {
			this.cachedLoginShellPath = await this.pendingLoginShellPath;
			return this.cachedLoginShellPath;
		} finally {
			this.pendingLoginShellPath = null;
		}
	}

	private async resolveLoginShellPathUncached(): Promise<string> {
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

	private clearLarkCliCommandCache(): void {
		this.cachedLarkCliPath = null;
		this.cachedLarkCliPathSetting = "";
		this.cachedCommandEnvironment = null;
		this.cachedCommandEnvironmentExecutable = "";
		this.cachedCommandEnvironmentShellPath = "";
		this.cachedLoginShellPath = null;
		this.pendingLarkCliPath = null;
		this.pendingLoginShellPath = null;
		this.checkedLarkCliVersionExecutable = "";
		this.pendingLarkCliVersionExecutable = "";
		this.pendingLarkCliVersionCheck = null;
	}

	private getShellCandidates(): string[] {
		const candidates = [process.env.SHELL || "", ...FALLBACK_LOGIN_SHELLS];
		return uniquePathEntries(candidates);
	}

	private async canExecute(path: string): Promise<boolean> {
		try {
			await access(path, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	}

	private async isDirectory(path: string): Promise<boolean> {
		try {
			return (await stat(path)).isDirectory();
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
		const previousBinding = this.getBinding(file);
		if (previousBinding && this.hasBindingChanged(previousBinding, binding)) {
			this.removeSyncStateForBinding(previousBinding);
			await this.saveLarkSyncState();
		}

		this.selfWrittenPaths.set(file.path, Date.now());
		const rawContent = await this.app.vault.read(file);
		const normalizedContent = removeBindingOnlyFrontmatterBeforeNextFrontmatter(rawContent);
		if (normalizedContent !== rawContent) {
			await this.app.vault.modify(file, normalizedContent);
			this.selfWrittenPaths.set(file.path, Date.now());
		}

		await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
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

		new Setting(containerEl).setName(this.plugin.t("settingsTitle")).setHeading();

		const generalSectionEl = this.createSection(containerEl, "settingsSectionGeneral");
		new Setting(generalSectionEl)
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

		new Setting(generalSectionEl)
			.setName(this.plugin.t("settingLarkCliPathName"))
			.setDesc(this.plugin.t("settingLarkCliPathDesc"))
			.addText((text) => {
				text.setPlaceholder("lark-cli").setValue(this.plugin.settings.larkCliPath).onChange(async (value) => {
					this.plugin.settings.larkCliPath = value.trim() || DEFAULT_SETTINGS.larkCliPath;
					await this.plugin.saveSettings();
				});
			});

		new Setting(generalSectionEl)
			.setName(this.plugin.t("settingDefaultTargetName"))
			.setDesc(this.plugin.t("settingDefaultTargetDesc"))
			.addText((text) => {
				text.setPlaceholder("https://xxx.feishu.cn/wiki/...").setValue(this.plugin.settings.targetTokenOrUrl)
					.onChange(async (value) => {
						this.plugin.settings.targetTokenOrUrl = value.trim();
						await this.plugin.saveSettings();
					});
				});

		const contentSectionEl = this.createSection(containerEl, "settingsSectionContent");
		new Setting(contentSectionEl)
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

		new Setting(contentSectionEl)
			.setName(this.plugin.t("settingWriteBindingName"))
			.setDesc(this.plugin.t("settingWriteBindingDesc"))
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.updateFrontmatter).onChange(async (value) => {
					this.plugin.settings.updateFrontmatter = value;
					await this.plugin.saveSettings();
				});
				});

		new Setting(contentSectionEl)
			.setName(this.plugin.t("settingOpenAfterSyncName"))
			.setDesc(this.plugin.t("settingOpenAfterSyncDesc"))
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.openAfterSync).onChange(async (value) => {
					this.plugin.settings.openAfterSync = value;
					await this.plugin.saveSettings();
				});
			});

		const syncSectionEl = this.createSection(containerEl, "settingsSectionSync");
		new Setting(syncSectionEl)
			.setName(this.plugin.t("settingSyncStrategyName"))
			.setDesc(this.plugin.t("settingSyncStrategyDesc"))
			.addDropdown((dropdown) => {
				dropdown.addOption("auto", this.plugin.t("syncStrategyAuto"))
					.addOption("precise", this.plugin.t("syncStrategyPrecise"))
					.addOption("overwrite", this.plugin.t("syncStrategyOverwrite"))
					.setValue(this.plugin.settings.syncStrategy).onChange(async (value) => {
						this.plugin.settings.syncStrategy = value as SyncStrategy;
						await this.plugin.saveSettings();
					});
			});

		new Setting(syncSectionEl)
			.setName(this.plugin.t("settingAutoSyncModeName"))
			.setDesc(this.plugin.t("settingAutoSyncModeDesc"))
			.addDropdown((dropdown) => {
				dropdown.addOption("manual", this.plugin.t("autoSyncModeManual"))
					.addOption("save", this.plugin.t("autoSyncModeSave"))
					.addOption("pre-push", this.plugin.t("autoSyncModePrePush"))
					.setValue(this.plugin.settings.autoSyncMode).onChange(async (value) => {
						this.plugin.settings.autoSyncMode = value as AutoSyncMode;
						await this.plugin.saveSettings();
						this.display();
					});
			});

		new Setting(syncSectionEl)
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

		new Setting(syncSectionEl)
			.setName(this.plugin.t("settingStateCacheName"))
			.setDesc(this.plugin.t("settingStateCacheDesc"))
			.addText((text) => {
				text.setPlaceholder(String(DEFAULT_STATE_CACHE_RETAIN_LIMIT))
					.setValue(String(this.plugin.settings.stateCacheRetainLimit)).onChange(async (value) => {
						const retainLimit = Number.parseInt(value, 10);
						this.plugin.settings.stateCacheRetainLimit = Number.isFinite(retainLimit)
							? Math.max(1, retainLimit)
							: DEFAULT_STATE_CACHE_RETAIN_LIMIT;
						await this.plugin.saveSettings();
					});
			});

		const gitHookSectionEl = this.createSection(containerEl, "settingsSectionGitHook");
		const installPrePushHookSetting = new Setting(gitHookSectionEl)
			.setName(this.plugin.t("settingInstallPrePushHookName"))
			.setDesc(this.plugin.t("settingInstallPrePushHookDesc"))
			.addButton((button) => {
				button.setButtonText(this.plugin.t("installPrePushHookButton")).onClick(async () => {
					await this.plugin.installPrePushHook();
					this.display();
				});
			});
		this.renderPrePushHookStatus(installPrePushHookSetting);
	}

	private createSection(containerEl: HTMLElement, titleKey: MessageKey): HTMLElement {
		const sectionEl = containerEl.createDiv({ cls: "feishu-lark-settings-section" });
		new Setting(sectionEl).setName(this.plugin.t(titleKey)).setHeading();
		return sectionEl;
	}

	private renderPrePushHookStatus(setting: Setting): void {
		const statusEl = setting.descEl.createDiv({
			cls: "feishu-lark-pre-push-hook-status is-muted",
			text: this.plugin.t("prePushHookStatusChecking")
		});
		void this.plugin.getPrePushHookStatus().then((status) => {
			statusEl.setText(this.getPrePushHookStatusText(status));
			statusEl.removeClass("is-installed", "is-error", "is-warning", "is-muted");
			statusEl.addClass(this.getPrePushHookStatusClass(status));
		});
	}

	private getPrePushHookStatusText(status: PrePushHookStatus): string {
		if (status === "installed") {
			return this.plugin.t("prePushHookStatusInstalled");
		}

		if (status === "not-git-repository") {
			return this.plugin.t("prePushHookStatusNotGitRepository");
		}

		if (status === "unavailable" || status === "unknown") {
			return this.plugin.t("prePushHookStatusUnavailable");
		}

		if (this.plugin.settings.autoSyncMode !== "pre-push") {
			return this.plugin.t("prePushHookStatusMissingInactive");
		}

		return this.plugin.t("prePushHookStatusMissing");
	}

	private getPrePushHookStatusClass(status: PrePushHookStatus): string {
		if (status === "installed") {
			return "is-installed";
		}

		if (status === "not-installed" && this.plugin.settings.autoSyncMode === "pre-push") {
			return "is-error";
		}

		if (status === "not-git-repository") {
			return "is-warning";
		}

		return "is-muted";
	}
}
