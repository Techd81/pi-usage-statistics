# Pi Token Usage Statistics

> Track token usage, cost, and cache-hit statistics for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) — with a native TUI dashboard.

在 Pi 终端内查看 token 使用统计的扩展：按 provider / 模型统计实际消耗，区分 input / output / cache 读写，计算缓存命中率与成本，支持项目级 / 全局级范围切换与多系列趋势曲线。**纯本地运行，无浏览器、无 HTTP 服务器、无任何远程上报。**

## Features / 功能

- **Accurate collection** — each completed assistant reply is counted once; streaming increments are never double-counted
- **Aggregates across all local Pi sessions** — total tokens, requests, cost, input / output / cache-create / cache-hit, and hit rate
- **Native TUI dashboard** — `/pi-usage-statistics` opens an embedded interactive view

  | Key / 按键 | Action / 作用 |
  |---|---|
  | `p` / `g` | Toggle project / global scope |
  | `s` | Cycle series visibility (All → Tokens → Cost) |
  | `t` | Cycle time range (Today → 7 days → 30 days → All) |
  | `q` / `Esc` | Close |

- **Multi-series trends** — one bar row per series (total / input / output / cache read / cache write / cost) with per-series legend values
- **Cost traceability** — recorded cost from Pi when available; otherwise estimated via the built-in price table (marked `~`); `--` when no price exists

## Installation / 安装

Requires Pi `>= 0.84.0` and Node.js `>= 22.19.0`.

### npm

```bash
pi install npm:pi-token-usage-statistics
```

### Git

```bash
pi install git:github.com/Techd81/pi-usage-statistics
```

### Local path / 本地路径

```bash
pi install /path/to/pi-token-usage-statistics
```

Restart Pi after installing (extensions initialize at session start). Use `pi list` to view installed extensions and `pi config` to enable / disable them.

## Usage / 使用

Type the command in a Pi session:

```
/pi-usage-statistics           # open the TUI dashboard (default: global scope)
/pi-usage-statistics project   # project scope (sessions under the current working directory)
/pi-usage-statistics global    # global scope (all local sessions)
/pi-usage-statistics refresh   # force a rescan of session files
```

- **Project scope**: only session records under the current working directory
- **Global scope**: all sessions discovered under `~/.pi/agent/sessions/`

In non-interactive modes (`print` / `json`) the command prints a plain-text summary and never touches the TUI.

## Data & Privacy / 数据与隐私

- All data stays local: `<agent-dir>/token-usage-statistics/` (`records.jsonl` + `index.json`)
- The single source of truth is Pi's own session files (JSONL); this extension's index is only a rebuildable acceleration cache
- **No network requests**: no server, no CDN, no telemetry
- Session files are maintained by Pi itself; the extension only reads and aggregates them locally

## Cost Estimation & Price Overrides / 成本估算与价格覆盖

Cost priority:

1. **Recorded** — Pi's own `cost` field, validated and used directly
2. **Estimated** — computed from the built-in versioned price table; shown as `~$x.xxxx (estimated)`
3. **Unavailable** — `--` when no price exists; token statistics are unaffected

### Price override file

Place a `pricing.json` in the data directory to override default prices:

```json
{
  "version": 1,
  "rows": [
    { "provider": "anthropic", "model": "claude-sonnet-4-5", "inputPer1k": 0.003, "outputPer1k": 0.015, "cacheReadPer1k": 0.0003, "cacheWritePer1k": 0.00375 },
    { "provider": "my-provider", "model": "*", "inputPer1k": 0.001, "outputPer1k": 0.002, "cacheReadPer1k": 0.0001, "cacheWritePer1k": 0.0005 }
  ]
}
```

- `model` supports the `*` wildcard
- Prices are USD per 1k tokens
- The override file is merged with the built-in table; overrides take precedence

## Index Rebuild / Reset / 索引重建

Delete the data directory to rebuild the index from session files on next start:

```bash
rm -rf ~/.pi/agent/token-usage-statistics
```

Rebuilding is non-fatal: corrupted session files are skipped and counted, never fatal to Pi.

## Development / 开发

```bash
npm install
npm test           # full test suite (vitest)
npm run typecheck  # type checking
npm pack --dry-run # preview package contents
```

## License

MIT — see [LICENSE](LICENSE).
