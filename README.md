# Lark CLI Sync

Obsidian desktop plugin for publishing Markdown notes to Feishu/Lark Docs through the local `lark-cli`.

## Requirements

- Obsidian desktop
- `lark-cli` installed and authenticated
- A user profile that can create documents in the target folder or wiki node

The plugin does not ask for App ID, App Secret, access tokens, or OAuth configuration. It only shells out to the local `lark-cli`.

## Features

- Publish the current note as a Lark Docx document
- Sync an already published note by overwriting the bound Lark Docx document
- Publish a folder of Markdown notes in one action
- Preserve the local folder hierarchy when publishing folders
- Rewrite internal folder links to Lark document references
- File menu actions for Markdown files
- Ribbon button for syncing the active note
- Optional frontmatter binding:

```yaml
---
lark_doc:
  token: YTi3dFxPEodFKXxl8J3c2PWGn07
  url: https://atrenew.feishu.cn/docx/YTi3dFxPEodFKXxl8J3c2PWGn07
  lastSyncedAt: "2026-06-11T10:48:33.000Z"
---
```

## Settings

- `Language`: switch plugin settings, context menus, commands, and notices between Chinese and English
- `lark-cli path`: optional command path. Leave it as `lark-cli` for automatic detection.
- `Default target`: wiki URL, wiki node token, folder token, or blank for personal library
- `Title source`: first Markdown heading or file name
- `Write binding to frontmatter`: stores Lark document token and URL after publishing
- `Open after sync`: opens the Lark document after successful publish/sync

## CLI Detection

When `lark-cli path` is left as `lark-cli`, the plugin resolves the command in this order:

1. Run the user's login shell and execute `command -v lark-cli`
2. Check common user-local install paths under `$HOME`, such as `$HOME/.npm-global/bin/lark-cli`
3. Check common Homebrew/system paths, such as `/opt/homebrew/bin/lark-cli` and `/usr/local/bin/lark-cli`
4. Fall back to `lark-cli`

The plugin also passes a reconstructed `PATH` to the child process so `lark-cli` can find `node` when Obsidian was launched outside a terminal.

## Folder Publish

Right-click a folder and choose `Publish folder to Lark`.

The plugin runs a two-pass publish:

1. Create the same remote folder/page hierarchy as the selected local folder
2. Create or sync each Markdown note under its matching remote parent and collect its Lark document token
3. Rebuild each remote document after rewriting internal links to Lark document references

For example, publishing `ITC-78270` creates `ITC-78270/design/...` remotely. Publishing `design` directly creates `design/...` remotely and does not include its local parent folders.

Supported internal link forms include:

```md
详细设计见 02-database.md。
[组件设计](03-components.md#section)
[[04-api|接口设计]]
```

Local notes keep their original links. Only the uploaded Lark document content is rewritten.

## Build

```bash
npm install
npm run build
```

Copy `manifest.json`, `main.js`, and optionally `README.md` into:

```text
<vault>/.obsidian/plugins/lark-cli-sync/
```

Then enable the plugin in Obsidian.
