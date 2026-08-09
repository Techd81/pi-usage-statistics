#!/usr/bin/env bash
# =============================================================================
# install-pi-usage.sh — macOS / Linux 版 `pi usage` 快捷入口安装脚本
#
# 与 scripts/install-pi-usage.ps1（Windows PowerShell）功能对齐：
# 向 ~/.bashrc 或 ~/.zshrc 注入一个 `pi` 包装函数，把 `pi usage [args...]`
# 翻译成 `pi-usage [args...]`（独立统计查看器，不启动 pi 会话）；其他所有
# `pi` 调用原样透传。幂等：重复执行始终收敛为单份最新 wrapper，绝不重复。
#
# 用法:
#   install-pi-usage.sh [--shell bash|zsh|auto] [--uninstall] [-h|--help]
#
# 前提（wrapper 生效需要）:
#   - 已全局安装本包:  npm i -g pi-token-usage-statistics   (提供 pi-usage bin)
#   - 已安装 pi 扩展以产生数据: pi install git:github.com/Techd81/pi-usage-statistics
# 新开 shell 会话（或 source ~/.bashrc）后生效。
# =============================================================================
set -euo pipefail

marker_start='# === pi-usage-statistics wrapper (managed by install-pi-usage.sh) ==='
marker_end='# === end pi-usage-statistics wrapper ==='

wrapper_block() {
  cat <<'WRAPPER'
# === pi-usage-statistics wrapper (managed by install-pi-usage.sh) ===
# Translates `pi usage [args...]` into `pi-usage [args...]` — the standalone
# statistics viewer (htop-style TUI, no pi session, Esc to exit). All other
# invocations pass through unchanged.
# Requires the pi-usage-statistics package to be installed (`npm i -g`).
pi() {
    if [ "$1" = "usage" ]; then
        shift
        # `command pi-usage` runs the real npm bin as a child process (no
        # exec — the shell must survive the viewer); `command` also bypasses
        # this wrapper itself for the generic `pi` pass-through below.
        command pi-usage "$@"
        return $?
    fi
    command pi "$@"
}
# === end pi-usage-statistics wrapper ===
WRAPPER
}

usage() {
  cat <<'EOF'
Usage: install-pi-usage.sh [--shell bash|zsh|auto] [--uninstall] [-h|--help]

Installs a `pi` shell function that translates `pi usage [args...]` into
`pi-usage [args...]` (the standalone statistics viewer — no pi session,
Esc to exit). Every other `pi` invocation passes through unchanged.

Options:
  --shell <bash|zsh|auto>  Target rc file: bash -> ~/.bashrc, zsh -> ~/.zshrc.
                           Default: auto (detected from $SHELL, bash fallback).
  --uninstall              Remove the managed wrapper block from the rc file.
  -h, --help               Show this help and exit.

The wrapper takes effect in NEW shells (or after: source ~/.bashrc).
EOF
}

# ---------------------------------------------------------------------------
# 从 rc 文件中移除所有受管块（含孤儿 start/end 标记）。
# 用 awk 的整行字符串比较，避免 sed 正则转义标记中的 `(` `)` `.`。
# ---------------------------------------------------------------------------
strip_managed_blocks() {
  awk -v s="$marker_start" -v e="$marker_end" '
    $0 == s { inblock = 1; next }
    inblock && $0 == e { inblock = 0; next }
    !inblock && $0 == e { next }      # orphan end marker
    !inblock { print }
  ' "$1" > "$1.tmp.$$"
  mv "$1.tmp.$$" "$1"
}

main() {
  local target=""
  local uninstall=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --shell)
        [ $# -ge 2 ] || { echo "error: --shell requires bash|zsh|auto" >&2; exit 2; }
        target="$2"; shift 2 ;;
      --uninstall) uninstall=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) echo "error: unknown argument: $1" >&2; usage; exit 2 ;;
    esac
  done

  case "$target" in
    bash) rc="$HOME/.bashrc" ;;
    zsh)  rc="$HOME/.zshrc" ;;
    auto|"")
      case "${SHELL:-/bin/bash}" in
        *zsh) rc="$HOME/.zshrc" ;;
        *)    rc="$HOME/.bashrc" ;;
      esac ;;
    *) echo "error: --shell must be bash|zsh|auto" >&2; exit 2 ;;
  esac

  if [ ! -f "$rc" ]; then
    touch "$rc"
  fi

  if [ "$uninstall" = "1" ]; then
    strip_managed_blocks "$rc"
    echo "  pi wrapper removed from: $rc"
    exit 0
  fi

  # 语法自检 wrapper 本身（bash -n），防止未来编辑引入语法错误。
  local block
  block="$(wrapper_block)"
  if ! printf '%s\n' "$block" | bash -n; then
    echo "error: generated wrapper failed bash -n syntax check" >&2
    exit 1
  fi

  local had_managed=0
  grep -qF "$marker_start" "$rc" && had_managed=1

  # 1. 移除旧的受管块（完整块 / 重复 / 孤儿标记）。
  strip_managed_blocks "$rc"
  # 2. 清理文件尾部多余空行后追加一份新块。
  sed -i '' -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$rc" 2>/dev/null || true
  printf '\n%s\n' "$block" >> "$rc"

  echo ""
  if [ "$had_managed" = "1" ]; then
    echo "  pi wrapper updated in: $rc"
  else
    echo "  pi wrapper installed in: $rc"
  fi
  echo ""
  echo "  Now you can run:  pi usage"
  echo "  Equivalent to:     pi-usage  (standalone viewer — no pi session, Esc to exit)"
  echo "  All other pi calls (pi -c, pi --help, pi install ...) pass through unchanged."
  echo ""
  echo "  Requirements:"
  echo "    - pi-usage-statistics package installed (npm i -g pi-token-usage-statistics)"
  echo "    - pi extension installed for data (pi install git:github.com/Techd81/pi-usage-statistics)"
  echo ""
  echo "  The wrapper applies to NEW shells (or run: source $rc)"
  echo ""
}

main "$@"
