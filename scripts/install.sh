#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ID="feishu-lark-cli-sync"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VAULT_PATH="${1:-}"

if [ -z "$VAULT_PATH" ]; then
  read -r -p "请输入 Obsidian 仓库路径 / Obsidian vault path: " VAULT_PATH
fi

if [ -z "$VAULT_PATH" ]; then
  echo "Obsidian 仓库路径不能为空 / Obsidian vault path is required." >&2
  exit 1
fi

case "$VAULT_PATH" in
  "~")
    VAULT_PATH="$HOME"
    ;;
  "~/"*)
    VAULT_PATH="$HOME/${VAULT_PATH#"~/"}"
    ;;
esac

if [ ! -d "$VAULT_PATH" ]; then
  echo "Obsidian 仓库路径不存在 / Obsidian vault path does not exist: $VAULT_PATH" >&2
  exit 1
fi

PLUGIN_DIR="$VAULT_PATH/.obsidian/plugins/$PLUGIN_ID"
mkdir -p "$PLUGIN_DIR"

for file in manifest.json main.js lark-sync-core.mjs README.md README.en.md sync-pre-push.mjs styles.css; do
  if [ ! -f "$REPO_DIR/$file" ]; then
    echo "缺少 $file，请先运行 npm install && npm run build / Missing $file, run npm install && npm run build first." >&2
    exit 1
  fi

  cp "$REPO_DIR/$file" "$PLUGIN_DIR/$file"
done

chmod +x "$PLUGIN_DIR/sync-pre-push.mjs"

HOOK_PATH="$VAULT_PATH/.git/hooks/pre-push"
HOOK_DIR="$VAULT_PATH/.git/hooks"
if [ -f "$HOOK_PATH" ] && grep -q "Feishu Lark CLI Sync" "$HOOK_PATH"; then
  cp "$PLUGIN_DIR/sync-pre-push.mjs" "$HOOK_DIR/sync-pre-push.mjs"
  cp "$PLUGIN_DIR/lark-sync-core.mjs" "$HOOK_DIR/lark-sync-core.mjs"
  chmod +x "$HOOK_DIR/sync-pre-push.mjs"
fi

echo "已安装到 / Installed to: $PLUGIN_DIR"
echo "请在 Obsidian 设置中启用 Feishu Lark CLI Sync。"
echo "Enable Feishu Lark CLI Sync in Obsidian settings."
