# Feishu Lark CLI Sync

[简体中文](./README.md) | [English](./README.en.md)

An Obsidian desktop plugin that publishes and syncs Markdown notes to Feishu/Lark Docs through the local `lark-cli`.

## Features

- Single-note publish: publish the current Markdown note as a Feishu/Lark Docx document
- Single-note sync: overwrite-sync an already published note, using Obsidian as the source
- Folder publish: right-click a folder and publish all Markdown files in one action
- Folder sync: publishing the same folder again updates bound documents and creates remote documents for new local Markdown files
- Folder hierarchy: preserve the selected folder and its subfolders
- Link rewriting: rewrite local Markdown/Obsidian internal links into Feishu/Lark document references
- Chinese and English UI
- No App ID, App Secret, access token, or OAuth setup inside the plugin; it reuses the local `lark-cli` login state
- Optional frontmatter binding:

```yaml
---
lark_doc:
  token: YTi3dFxPEodFKXxl8J3c2PWGn07
  url: https://atrenew.feishu.cn/docx/YTi3dFxPEodFKXxl8J3c2PWGn07
  lastSyncedAt: "2026-06-11T10:48:33.000Z"
---
```

## Requirements

- Obsidian desktop
- Installed and authenticated `lark-cli`
- Permission to create documents in the target Wiki node, folder, or personal library

### Install and Login to lark-cli

This plugin does not handle Feishu/Lark API credentials itself. All API calls are delegated to the local `lark-cli`.

`lark-cli` is the official CLI for the Lark/Feishu Open Platform:

- GitHub: <https://github.com/larksuite/cli>
- npm: <https://www.npmjs.com/package/@larksuite/cli>

Install:

```bash
npm install -g @larksuite/cli
```

Login:

```bash
lark-cli auth login
```

Check:

```bash
lark-cli --version
lark-cli auth status
```

If Obsidian cannot find `lark-cli`, set the absolute command path in the plugin settings. You can locate it with:

```bash
which lark-cli
```

## Settings

- `Language`: switch plugin settings, context menus, commands, and notices
- `lark-cli path`: command name or absolute path; keep `lark-cli` for automatic detection
- `Default target`: Wiki URL, Wiki node token, folder token, or blank for personal library
- `Title source`: first Markdown H1 or file name
- `Write binding to frontmatter`: store Feishu/Lark document token and URL after publishing
- `Open after sync`: open the remote document after publish or sync

## Single-Note Publish and Sync

Right-click a Markdown file, or open the command palette while a note is active:

- `Publish current note to Feishu/Lark`: create a new Feishu/Lark Docx document and write binding metadata
- `Sync current note to Feishu/Lark`: overwrite-sync the bound remote document; if no binding exists, publish a new document first

Sync is one-way from Obsidian to Feishu/Lark. The local Markdown note is the source, and the remote document is updated to match it.

## Folder Publishing

Right-click a folder and choose `Publish folder to Feishu/Lark`.

The plugin does three things:

1. Creates the matching remote hierarchy in Feishu/Lark
2. Publishes or syncs each Markdown file under its matching remote parent
3. Overwrites the remote documents again after rewriting internal links into Feishu/Lark document references

Running folder publish again works as folder sync: bound documents are overwritten, and new local Markdown files are created remotely.

The remote hierarchy starts from the selected folder only:

- Publishing `ITC-78270` creates `ITC-78270/design/...`
- Publishing `design` directly creates `design/...` and does not include its local parent folder `ITC-78270`

Supported internal link forms:

```md
Detailed design: 02-database.md
[Component design](03-components.md#section)
[[04-api|API design]]
```

Local notes remain unchanged. Only the uploaded remote documents are rewritten with Feishu/Lark document references.

## lark-cli Detection

When `lark-cli path` is left as the default value, the plugin resolves the command in this order:

1. Run the user's login shell and execute `command -v lark-cli`
2. Check `$HOME/.npm-global/bin/lark-cli`, `$HOME/.local/bin/lark-cli`, and `$HOME/bin/lark-cli`
3. Check `/opt/homebrew/bin/lark-cli` and `/usr/local/bin/lark-cli`
4. Fall back to `lark-cli`

The plugin also reconstructs `PATH` for the child process so `lark-cli` can find `node` when Obsidian was launched outside a terminal.

## Manual Installation

Before the plugin is available in the community plugin browser, install it with the following command. Replace `VAULT` with your Obsidian vault path:

```bash
VAULT="/path/to/your/vault" bash -c 'set -euo pipefail
PLUGIN_DIR="$VAULT/.obsidian/plugins/feishu-lark-cli-sync"
mkdir -p "$PLUGIN_DIR"
for file in manifest.json main.js README.md README.en.md; do
  curl -fsSL "https://github.com/wanghuan9/obsidian-feishu-lark-cli-sync/releases/latest/download/$file" -o "$PLUGIN_DIR/$file"
done
echo "Installed Feishu Lark CLI Sync to $PLUGIN_DIR"'
```

Then enable `Feishu Lark CLI Sync` in Obsidian settings.

Local development:

```bash
npm install
npm run build
```
