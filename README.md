# Feishu Lark CLI Sync

An Obsidian desktop plugin that publishes and syncs Markdown notes to Feishu/Lark Docs through the local `lark-cli`.

It is useful when Obsidian is your local source of truth and Feishu/Lark is where the team reads, comments, and collaborates.

## Features

- **Single-note sync**: publish or update the current Markdown note as a Feishu/Lark Docx document.
- **Folder sync**: right-click a folder and sync all Markdown files while preserving the folder hierarchy.
- **Block-level incremental sync**: update only changed blocks for small edits, without rewriting the whole document, so Feishu/Lark history can be preserved.
- **Full overwrite sync**: clear and rewrite the remote document when the local Markdown file should be the complete source of truth.
- **Automatic sync strategy**: use the automatic strategy by default; small changes are synced incrementally, while large or complex changes fall back to full overwrite when safe incremental sync is not possible.
- **Auto sync triggers**: sync after save, or sync bound notes before `git push` through a Git `pre-push` hook.
- **Internal link rewriting**: uploaded content rewrites Markdown and Obsidian internal links into Feishu/Lark document references.

## Installation

### Obsidian Community Plugins (Recommended)

After the plugin is published to the community plugin browser:

1. Open Obsidian -> Settings -> Community plugins -> Browse.
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

After installation, restart Obsidian and enable `Feishu Lark CLI Sync` in Settings -> Community plugins.

## Prerequisites

Install and log in to `lark-cli` first:

```bash
npm install -g @larksuite/cli
lark-cli version
lark-cli auth login
lark-cli auth status
```

Use `lark-cli > 1.0.53`. Older versions may create documents with the title `Untitled` or cause sync errors. If your version is too old, upgrade it:

```bash
npm install -g @larksuite/cli@latest
```

If Obsidian cannot find `lark-cli`, set the absolute path in the plugin settings:

```bash
which lark-cli
```

## Usage

### Single-note Sync

Open a Markdown file, then click the ribbon icon or use the file context menu:

- `Lark: Sync to Feishu/Lark`: create a document when no binding exists, or update the bound remote document.
- `Lark: Overwrite to Feishu/Lark`: clear and rewrite the remote document with the local Markdown content.

![Obsidian actions](./docs/images/obsidian-actions.png)

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

Auto sync only handles already bound documents. For first-time use, run `Lark: Sync to Feishu/Lark` in Obsidian to publish the document and write the `lark_doc_url` binding; subsequent save-after-sync or Git hook sync can then find and update that file.

#### Trigger Modes

Choose one mode in settings:

- `Off`: manual sync only.
- `Sync after save`: while Obsidian is running, sync bound Markdown notes after file save events.
- `Git pre-push hook`: sync bound Markdown notes before `git push`.

#### When It Takes Effect

`Sync after save` depends on Obsidian receiving file change events, so it works in these cases:

- Editing and saving directly in Obsidian: auto sync is triggered.
- Editing with another editor while Obsidian is running and watching the vault: auto sync can be triggered.
- Editing with another editor while Obsidian is not running or the vault is not open: auto sync is not triggered.

`Git pre-push hook` depends only on the Git push command. It does not require Obsidian or any editor to be running, and is useful when sync should be part of the publishing flow before `git push`.

For Git hook mode, click `Install hook` in the `Git Hook` settings section. If sync fails, the current `git push` is blocked.

## Settings

- `Default target`: Wiki URL, wiki node token, folder token, or blank for the personal library.
- `Title source`: use the first Markdown heading or the file name.
- `Write binding to frontmatter`: store the remote document URL in note frontmatter.
- `Sync strategy`: use automatic strategy by default; small changes use incremental sync, while large, complex, or unsafe incremental changes automatically fall back to full overwrite.
- `Sync state cache`: controls how many document states are kept for safe precise sync.

## Incremental Sync And Feishu/Lark History

The plugin splits Markdown into top-level content blocks and records the mapping between those blocks and Feishu/Lark document block ids. Later syncs prefer incremental updates for changed blocks, such as replacing a paragraph, inserting a new paragraph, or deleting an outdated paragraph.

This block-level sync does not clear and rewrite the whole document, so Feishu/Lark can keep the corresponding edit history, recent update records, and collaboration context. The remote document is rewritten only when you choose `Overwrite to Feishu/Lark`, or when the automatic strategy decides that the change is too large, too complex, or unsafe for incremental sync.

![Feishu/Lark history preservation](./docs/images/lark-history.png)

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
