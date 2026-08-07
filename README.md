<div align="center">

```
                                                     ████████████╗                                                     
                                                     ╚═██╔═══██╔═╝                                                     
                                                       ██║   ██║                                                       
                                                       ██║   ██║                                                       
                                                       ██║   ██║                                                       
                                                       ╚═╝   ╚═╝                                                       

██╗   ██╗███████╗ █████╗  ██████╗ ███████╗    ███████╗████████╗ █████╗ ████████╗██╗███████╗████████╗██╗ ██████╗███████╗
██║   ██║██╔════╝██╔══██╗██╔════╝ ██╔════╝    ██╔════╝╚══██╔══╝██╔══██╗╚══██╔══╝██║██╔════╝╚══██╔══╝██║██╔════╝██╔════╝
██║   ██║███████╗███████║██║  ███╗█████╗      ███████╗   ██║   ███████║   ██║   ██║███████╗   ██║   ██║██║     ███████╗
██║   ██║╚════██║██╔══██║██║   ██║██╔══╝      ╚════██║   ██║   ██╔══██║   ██║   ██║╚════██║   ██║   ██║██║     ╚════██║
╚██████╔╝███████║██║  ██║╚██████╔╝███████╗    ███████║   ██║   ██║  ██║   ██║   ██║███████║   ██║   ██║╚██████╗███████║
 ╚═════╝ ╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝    ╚══════╝   ╚═╝   ╚═╝  ╚═╝   ╚═╝   ╚═╝╚══════╝   ╚═╝   ╚═╝ ╚═════╝╚══════╝
```

</div>

# Pi Token Usage Statistics

> Track token usage, cost, and cache-hit statistics for the [Pi coding agent](https://github.com/earendil-works/pi) — with a native TUI dashboard.

在 Pi 终端内查看 token 使用统计的扩展：按 provider / 模型统计实际消耗，区分 input / output / cache 读写，计算缓存命中率与成本，支持项目级 / 全局级范围切换与多系列趋势曲线。**纯本地运行，无浏览器、无 HTTP 服务器、无任何远程上报。**

<p align="center">
  <img src="images/image1.png" alt="仪表盘主视图：总览指标与使用趋势" width="900" />
</p>

<p align="center">
  <img src="images/image2.png" alt="按模型统计表" width="900" />
</p>

## Features / 功能

- **Accurate collection** — 每条完成的 assistant 回复只计一次；不订阅 streaming 增量，避免双计
- **Aggregates across all local Pi sessions** — 总 tokens、请求数、成本、input / output / cache-create / cache-hit 与命中率
- **Native TUI dashboard** — `/pi-usage-statistics` 打开嵌入式交互界面

  | Key / 按键 | Action / 作用 |
  |---|---|
  | `p` / `g` | 切换项目 / 全局范围 |
  | `m` | 切换主视图 ↔ 按模型统计表 |
  | `t` | 循环时间范围：当天 → 1d → 7d → 14d → 30d → 1year → 全部 |
  | `Esc` | 返回（模型表 → 主视图）或关闭 |

- **Multi-series trends** — 同屏叠加 Cost / Cache write / Cache read / Input / Output 五条序列
- **Cost traceability** — 优先使用 Pi 记录的 `cost`；否则按内置价表估算（标记 `~` / estimated）；无价格时显示 `--`

## Requirements / 环境要求

- [Pi coding agent](https://github.com/earendil-works/pi) `>= 0.84.0`
- Node.js `>= 22.19.0`

## Installation / 安装

任选一种方式安装后，**重启 Pi**（扩展在 session 启动时加载）。可用 `pi list` 查看已装扩展，`pi config` 启用 / 禁用。

### 推荐：从 GitHub 安装

```bash
pi install git:github.com/Techd81/pi-usage-statistics
```

### 本地路径（开发 / 调试）

```bash
# Windows 示例
pi install D:/pi-usage-statistics

# macOS / Linux 示例
pi install /path/to/pi-usage-statistics
```

### npm（发布后可用）

```bash
pi install npm:pi-token-usage-statistics
```

> 包名是 `pi-token-usage-statistics`；仓库名是 `pi-usage-statistics`。若 npm 尚未发布，请使用上方 Git / 本地路径安装。

安装成功后，在任意 Pi 会话中输入：

```
/pi-usage-statistics
```

即可打开仪表盘。

## Usage / 使用

在 Pi 会话中：

```
/pi-usage-statistics           # 打开 TUI（默认全局范围）
/pi-usage-statistics project   # 仅当前工作目录下的会话
/pi-usage-statistics global    # 全部本地会话
/pi-usage-statistics refresh   # 强制重扫 session 文件并打印摘要
```

- **Project scope**：只统计当前工作目录下的 session
- **Global scope**：扫描 `~/.pi/agent/sessions/` 下发现的全部会话

非交互模式（`print` / `json`）下命令只输出纯文本摘要，不会打开 TUI。

### 仪表盘操作速查

1. 打开后默认看到 **总览 + 趋势图**（如 `images/image1.png`）
2. 按 `m` 进入 **按模型统计表**（如 `images/image2.png`）：Model / Requests / Tokens / Total cost / Avg cost
3. 按 `t` 切换时间窗；按 `p` / `g` 切换项目 / 全局
4. 按 `Esc` 退出（在模型表时先回到主视图）

## Data & Privacy / 数据与隐私

- 数据仅存本地：`<agent-dir>/token-usage-statistics/`（`records.jsonl` + `index.json`）
- 权威数据源是 Pi 自己的 session 文件（JSONL）；本扩展的索引只是可重建的加速缓存
- **无网络请求**：无服务器、无 CDN、无遥测
- 后台扫描在 session 启动时 debounce + single-flight 执行；成功时静默，失败才通知，不打扰正常对话

## Cost Estimation & Price Overrides / 成本估算与价格覆盖

成本优先级：

1. **Recorded** — Pi 自带的 `cost` 字段（校验通过后直接使用）
2. **Estimated** — 内置价表或本地覆盖价表估算；显示为 `~$x.xxxx (estimated)`
3. **Unavailable** — 无价格时为 `--`；token 统计不受影响

### 价格覆盖文件

在数据目录放置 `pricing.json`（与 `records.jsonl` 同目录）：

```json
{
  "schemaVersion": 1,
  "currency": "USD",
  "rows": [
    {
      "provider": "anthropic",
      "model": "claude-sonnet-4-5",
      "inputPer1k": 0.003,
      "outputPer1k": 0.015,
      "cacheReadPer1k": 0.0003,
      "cacheWritePer1k": 0.00375
    },
    {
      "provider": "my-provider",
      "model": "*",
      "inputPer1k": 0.001,
      "outputPer1k": 0.002,
      "cacheReadPer1k": 0.0001,
      "cacheWritePer1k": 0.0005
    }
  ]
}
```

- 字段名必须是 `schemaVersion`（不是 `version`）
- `model` / `provider` 支持 `*` 通配
- 价格单位：USD / 1k tokens
- 覆盖表与内置表合并，覆盖优先；文件非法时整文件忽略，不影响内置表

典型路径：

```bash
# macOS / Linux
~/.pi/agent/token-usage-statistics/pricing.json

# Windows
%USERPROFILE%\.pi\agent\token-usage-statistics\pricing.json
```

写入或修改后，重启 Pi 或执行 `/pi-usage-statistics refresh` 生效。

## Index Rebuild / Reset / 索引重建

删除数据目录后，下次启动会从 session 文件重建索引：

```bash
# macOS / Linux
rm -rf ~/.pi/agent/token-usage-statistics

# Windows (PowerShell)
Remove-Item -Recurse -Force "$env:USERPROFILE\.pi\agent\token-usage-statistics"
```

重建是非致命的：损坏的 session 文件会被跳过并计数，不会拖垮 Pi。

## Performance / 性能

- 查询路径纯内存聚合；5 万条记录量级下 today / all（含趋势）查询目标 &lt; 50ms
- 后台扫描 debounce（默认 1s）+ single-flight，避免与正常对话抢占
- 不挂文件 watcher、不开 HTTP、不在 extension factory 阶段做全量扫描

## Development / 开发

```bash
npm install
npm test           # 完整测试套件（vitest）
npm run typecheck  # 类型检查
npm pack --dry-run # 预览发包内容
```

## Troubleshooting / 排查

| 现象 | 处理 |
|---|---|
| 命令找不到 | 确认已 `pi install` 且重启 Pi；`pi list` 中扩展已启用 |
| 数据为空 | 先正常对话产生 assistant 回复，或执行 `/pi-usage-statistics refresh` |
| 成本显示 `--` | 模型不在价表中；可配置 `pricing.json`，或依赖 Pi 写入的 recorded cost |
| 想强制重算 | 删除 `token-usage-statistics` 目录后重启 / refresh |

## License

MIT — see [LICENSE](LICENSE).
