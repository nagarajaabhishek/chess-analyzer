#!/usr/bin/env bash
# Reinstall Elephant-Goldfish Model for Cursor (local plugin) and print other-harness commands.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/.vendor/elephant-goldfish-model"
EGM_CANDIDATE="${HOME}/.cursor/plugins/local/egm"

if [[ ! -d "$VENDOR/.git" ]]; then
  mkdir -p "$ROOT/.vendor"
  git clone --depth 1 https://github.com/google/elephant-goldfish-model.git "$VENDOR"
else
  git -C "$VENDOR" pull --ff-only || true
fi

rm -rf "$EGM_CANDIDATE"
mkdir -p "$(dirname "$EGM_CANDIDATE")"
mkdir "$EGM_CANDIDATE"
cp -R "$VENDOR/.cursor-plugin" "$VENDOR/skills" "$VENDOR/agents" "$VENDOR/resources" "$VENDOR/docs" "$VENDOR/LICENSE" "$EGM_CANDIDATE/"
cp "$VENDOR/.cursor-plugin/plugin.json" "$EGM_CANDIDATE/plugin.json"
git -C "$VENDOR" rev-parse HEAD > "$EGM_CANDIDATE/.egm-source-sha"

echo "Cursor local EGM installed:"
echo "  EGM_ROOT: $EGM_CANDIDATE"
echo "  SHA: $(cat "$EGM_CANDIDATE/.egm-source-sha")"
echo
echo "Reload Cursor, then confirm the egm plugin under Customize."
echo
echo "Claude Code:"
echo "  claude plugin marketplace add google/elephant-goldfish-model"
echo "  claude plugin install egm@egm"
echo
echo "Codex CLI:"
echo "  codex plugin marketplace add google/elephant-goldfish-model"
echo "  codex plugin add egm@egm"
