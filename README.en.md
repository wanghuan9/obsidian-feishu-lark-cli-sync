# Feishu Lark CLI Sync

[简体中文](./README.md) | [English](./README.en.md)

An Obsidian desktop plugin that publishes and syncs Markdown notes to Feishu/Lark Docs through the local `lark-cli`.

It is useful when Obsidian is your local source of truth and Feishu/Lark is where the team reads, comments, and collaborates.

## Features

- **Single-note sync**: publish or update the current Markdown note as a Feishu/Lark Docx document.
- **Overwrite to Feishu/Lark**: force the remote document to match the local Markdown content.
- **Folder sync**: right-click a folder and sync all Markdown files while preserving the folder hierarchy.
- **Auto sync**: sync after save, or sync bound notes before `git push` through a Git `pre-push` hook.
- **Safe precise sync**: updates changed blocks by default; if it cannot update safely, it stops and notifies you.
- **Internal link rewriting**: uploaded content rewrites Markdown and Obsidian internal links into Feishu/Lark document references.

## Installation

### Obsidian Community Plugins (Recommended)

After the plugin is published to the community plugin browser:

1. Open Obsidian → Settings → Community plugins → Browse.
2. Search for `Feishu Lark CLI Sync`.
3. Click Install and enable the plugin.

### Manual Installation

If the plugin is not available from the community plugin browser, install it from source with the install script:

```bash
git clone https://github.com/wanghuan9/obsidian-feishu-lark-cli-sync.git
cd obsidian-feishu-lark-cli-sync
./install.sh "/path/to/your/vault"
```

Replace `/path/to/your/vault` with your Obsidian vault path. If no path is provided, the script will prompt for it.

After installation, restart Obsidian and enable `Feishu Lark CLI Sync` in Settings → Community plugins.

## Prerequisites

Install and log in to `lark-cli` first:

```bash
npm install -g @larksuite/cli
lark-cli auth login
lark-cli auth status
```

If Obsidian cannot find `lark-cli`, set the absolute path in the plugin settings:

```bash
which lark-cli
```

On Windows, try the default `lark-cli` value first. The plugin auto-detects PATH, `C:\nvm4w\nodejs`, `%APPDATA%\npm`, and other common locations. If you set a path manually, use the folder containing `lark-cli.cmd` or the full shim path, for example:

```powershell
C:\nvm4w\nodejs\lark-cli.cmd
```

The `Check lark-cli` button in settings verifies the command path, version, and current login identity. The plugin requires `lark-cli` `1.0.55` or newer.

## Usage

### Single-note Sync

Open a Markdown file, then click the ribbon icon or use the file context menu:

- `Lark: Sync to Feishu/Lark`: create a document when no binding exists, or update the bound remote document.
- `Lark: Overwrite to Feishu/Lark`: clear and rewrite the remote document with the local Markdown content.

Sync is one-way from Obsidian to Feishu/Lark. The local Markdown note is the source.

Default binding example:

```yaml
---
lark_doc_url: "https://example.feishu.cn/docx/xxxx"
---
```

### Folder Sync

Right-click a folder and choose `Lark: Sync folder to Feishu/Lark`. The plugin creates the matching remote hierarchy, syncs Markdown files, and rewrites internal links in the uploaded content.

Supported link forms:

```md
Detailed design: 02-database.md
[Component design](03-components.md#section)
[[04-api|API design]]
```

Local notes remain unchanged.

### Auto Sync

Choose one mode in settings:

- `Off`: manual sync only.
- `Sync after save`: sync bound Markdown notes after save.
- `Git pre-push hook`: sync bound Markdown notes before `git push`.

For Git hook mode, click `Install hook` in the `Git Hook` settings section. If sync fails, the current `git push` is blocked.

## Settings

- `Default target`: Wiki URL, wiki node token, folder token, or blank for the personal library.
- `Title source`: use the first Markdown heading or the file name.
- `Write binding to frontmatter`: store the remote document URL, doc token, and folder-publish remote path in note frontmatter.
- `Sync strategy`: safe precise sync by default, or overwrite sync.
- `Sync state cache`: controls how many document states are kept for safe precise sync.

Safe precise sync state is stored at:

```text
.obsidian/plugins/feishu-lark-cli-sync/lark-sync-state.json
```

## Notes

- The plugin uses the local `lark-cli` and does not store App Secret, access token, or OAuth configuration.
- Auto sync only handles already bound notes and never auto-publishes unbound files.
- If the remote Feishu/Lark document was edited manually, merge those edits back into the local Markdown file first. This plugin treats local Markdown as the source of truth.

## Development

```bash
npm install
npm run build
npm test
```

After changing source files, run `npm run build` again to regenerate `main.js` and `lark-sync-core.mjs`.

Install to a local vault:

```bash
./install.sh "/path/to/your/vault"
```

## License

MIT License
