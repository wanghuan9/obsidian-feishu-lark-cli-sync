# Feishu Lark CLI Sync

[简体中文](./README.md) | [English](./README.en.md)

通过本地 `lark-cli` 将 Obsidian Markdown 笔记一键发布和同步到飞书 / Lark 云文档的桌面端插件。

> 中文用户可以直接理解为“Obsidian 飞书同步插件”。海外用户通常使用 Lark，因此 README 同时保留 Feishu / Lark 关键词。

## 功能

- 单文件发布：将当前 Markdown 笔记发布为飞书 / Lark Docx 文档
- 单文件同步：对已发布笔记执行覆盖同步，保持 Obsidian 内容作为源
- 自动同步：可选择保存后同步，或安装 Git `pre-push` hook 后在推送前同步
- 整个目录发布：右键目录，一键发布该目录下所有 Markdown 文件
- 整个目录同步：再次右键同一目录发布时，会同步已绑定文档，并为新增文件创建新文档
- 目录结构保持：发布目录时保留“所选目录”及其子目录结构
- 引用改写：将目录内 Markdown / Obsidian 内部引用改写为飞书文档引用
- 支持中文 / English 设置、菜单和通知
- 不需要在插件里填写 App ID、App Secret、access token 或 OAuth 配置，直接复用本机 `lark-cli` 登录态
- 可选写入 frontmatter 绑定信息：

```yaml
---
lark_doc_url: "https://atrenew.feishu.cn/docx/YTi3dFxPEodFKXxl8J3c2PWGn07"
---
```

## 使用要求

- Obsidian 桌面端
- 已安装并完成登录的 `lark-cli`
- 当前 `lark-cli` 用户有权限在目标 Wiki 节点、目录或个人文档库中创建文档

### 安装和登录 lark-cli

本插件不直接调用飞书开放平台认证，也不会要求你在插件里填写密钥。所有飞书 / Lark API 调用都通过本机的 `lark-cli` 完成。

`lark-cli` 是 Lark/Feishu Open Platform 的官方 CLI：

- GitHub: <https://github.com/larksuite/cli>
- npm: <https://www.npmjs.com/package/@larksuite/cli>

安装：

```bash
npm install -g @larksuite/cli
```

登录：

```bash
lark-cli auth login
```

检查是否可用：

```bash
lark-cli --version
lark-cli auth status
```

如果 Obsidian 中提示找不到 `lark-cli`，可以在插件设置里的 `lark-cli 路径` 填写命令绝对路径。常见检查方式：

```bash
which lark-cli
```

## 设置

- `语言`：切换插件设置、右键菜单、命令和通知语言
- `lark-cli 路径`：可填写命令名或绝对路径；保持 `lark-cli` 时自动探测
- `默认上传位置`：可填写 Wiki URL、Wiki 节点 token、文件夹 token；留空则发布到个人文档库
- `标题来源`：使用第一个 Markdown 一级标题，或使用文件名
- `写入 frontmatter 绑定信息`：发布后记录飞书文档 URL 和同步时间，后续可直接同步
- `同步后打开文档`：发布或同步成功后在浏览器中打开飞书文档
- `自动同步方式`：可选择关闭、保存后同步、Git `pre-push` hook。自动同步只处理已绑定 Markdown 文档，不会自动发布未绑定文档。
- `保存后同步延迟`：保存后等待一段时间再同步，用于合并连续编辑。

## 单文件发布和同步

在 Markdown 文件上右键，或打开当前笔记后使用命令面板：

- `发布到飞书` / `Publish to Feishu/Lark`：创建一个新的飞书 / Lark Docx 文档，并写入绑定信息
- `同步到飞书` / `Sync to Feishu/Lark`：如果已有绑定，则覆盖同步到对应远端文档；如果没有绑定，则先发布为新文档

同步是从 Obsidian 到飞书 / Lark 的覆盖同步。本地 Markdown 是源内容，远端文档会被更新为本地内容。

## 自动同步

插件支持两种互斥的自动同步方式：

- `保存后同步`：Obsidian 中已绑定的 Markdown 文件保存后，延迟同步到对应飞书文档。该模式依赖 Obsidian 正在运行。
- `Git pre-push hook`：在插件设置中点击 `安装 hook` 后，会把 hook 安装到当前仓库的 `.git/hooks/pre-push`。之后即使 Obsidian 未打开，只要在该仓库执行 `git push`，hook 也会同步已绑定 Markdown 文档。

选择 `保存后同步` 或 `关闭` 时，已安装的 hook 会读取插件设置并直接退出，不会执行同步。Git hook 是按仓库安装的，换一个 Obsidian 仓库需要重新安装。

插件不会写入同步时间，避免自动同步或 Git hook 在本地笔记中制造额外变更。

## 目录发布

右键一个目录，选择 `发布整个目录到飞书` / `Publish folder to Feishu/Lark`。

插件会执行三步：

1. 在飞书 / Lark 中创建和所选目录一致的远端层级
2. 将每个 Markdown 文件发布或同步到对应远端父目录下
3. 二次覆盖远端文档，把内部链接改写为飞书文档引用

再次对同一个目录执行发布时，插件会根据 frontmatter 绑定信息同步已有文档；目录中新增的 Markdown 文件会被创建为新的远端文档。

路径规则只从“你右键点击的目录”开始：

- 发布 `Project-Alpha`：远端创建 `Project-Alpha/docs/...`
- 直接发布 `docs`：远端只创建 `docs/...`，不会带上本地上级目录 `Project-Alpha`

支持的内部引用形式：

```md
详细设计见 02-database.md。
[组件设计](03-components.md#section)
[[04-api|接口设计]]
```

本地笔记内容不会被改写。只有上传到飞书 / Lark 的远端文档会被改写为文档引用。

## lark-cli 探测

当 `lark-cli 路径` 保持默认值时，插件按以下顺序查找命令：

1. 通过用户登录 shell 执行 `command -v lark-cli`
2. 检查 `$HOME/.npm-global/bin/lark-cli`、`$HOME/.local/bin/lark-cli`、`$HOME/bin/lark-cli`
3. 检查 `/opt/homebrew/bin/lark-cli`、`/usr/local/bin/lark-cli`
4. 回退为直接执行 `lark-cli`

插件也会重建子进程 `PATH`，避免从 Obsidian 启动时 `lark-cli` 找不到 `node`。

## 手动安装

社区插件市场上架前，可以下载本项目后执行安装脚本。把 `/path/to/your/vault` 改成你的 Obsidian 仓库路径：

```bash
./install.sh "/path/to/your/vault"
```

不传路径时，脚本会提示你输入 Obsidian 仓库路径。

然后在 Obsidian 设置中启用 `Feishu Lark CLI Sync`。

开发者本地构建：

```bash
npm install
npm run build
```
