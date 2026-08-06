# Pi Token Usage Statistics

在 Pi 终端内查看 token 使用统计的插件：统计各 provider / 模型的实际消耗，区分 input / output / cache 读写，计算缓存命中率与成本，并支持**项目级 / 全局级**范围切换与多系列趋势曲线。**纯本地运行，无浏览器、无 HTTP 服务器、无任何远程上报。**

## 功能

- 自动采集每次完整回复的 token 用量（不会把流式增量算成多次请求）
- 聚合全部本地 Pi 会话：总 token、请求数、成本、input / output / cache 创建 / cache 命中 / 命中率
- `/pi-usage-statistics` 打开终端交互视图，支持：

  | 按键 | 作用 |
  |------|------|
  | `p` / `g` | 项目级 / 全局级范围切换 |
  | `s` | 系列可见性循环（全部 → Tokens → 成本） |
  | `t` | 时间范围循环（今天 → 7天 → 30天 → 全部） |
  | `q` / `Esc` | 关闭 |

- 多系列趋势：total / input / output / cache read / cache write / cost 每系列一行柱状条 + 图例值
- 成本溯源：优先使用 Pi 记录的成本，缺失时按内置价格表估算（带 `~` 标记），无价格时显示 `--`

## 安装

### 通过本地路径

```bash
pi packages add /path/to/pi-token-usage-statistics
```

### 通过 npm / git

```bash
# npm
pi packages add pi-token-usage-statistics
# git
pi packages add git+https://github.com/<you>/pi-token-usage-statistics.git
```

重启 Pi 后生效（扩展在会话启动时初始化）。

## 要求

- Pi `>= 0.84.0`
- Node.js `>= 22.19.0`

## 使用

在 Pi 中直接输入：

```
/pi-usage-statistics           # 打开 TUI 视图（默认全局范围）
/pi-usage-statistics project   # 项目级范围（仅当前工作目录的会话）
/pi-usage-statistics global    # 全局范围（所有本地会话）
/pi-usage-statistics refresh   # 重新扫描会话文件
```

- **项目级**：只统计当前工作目录下的会话记录
- **全局级**：统计 `~/.pi/agent/sessions/` 下发现的所有会话

非交互模式（`print` / `json`）下命令输出纯文本摘要，不调用任何 TUI 接口。

## 数据与隐私

- 数据全部存储在本地：`<agent-dir>/token-usage-statistics/`（`records.jsonl` + `index.json`）
- 唯一的权威数据源是 Pi 自己的会话文件（JSONL）；本插件索引只是可重建的加速缓存
- **没有任何网络请求**：不启动服务器、不加载 CDN、不上报任何遥测
- 会话文件由 Pi 自身维护，插件只读取并做本地聚合

## 成本估算与价格覆盖

成本优先级：

1. **记录成本**（`recorded`）：Pi 消息中自带的 `cost` 字段，经校验后直接使用
2. **估算成本**（`estimated`）：按内置版本化价格表计算，界面以 `~$x.xxxx（估算）` 标记
3. **不可用**（`unavailable`）：无价格记录时显示 `--`，token 统计不受影响

### 价格覆盖文件

在数据目录下放置 `pricing.json` 可覆盖默认价格：

```json
{
  "version": 1,
  "rows": [
    { "provider": "anthropic", "model": "claude-sonnet-4-5", "inputPer1k": 0.003, "outputPer1k": 0.015, "cacheReadPer1k": 0.0003, "cacheWritePer1k": 0.00375 },
    { "provider": "my-provider", "model": "*", "inputPer1k": 0.001, "outputPer1k": 0.002, "cacheReadPer1k": 0.0001, "cacheWritePer1k": 0.0005 }
  ]
}
```

- `model` 支持 `*` 通配符
- 单位为每 1k token 的 USD
- 覆盖文件与内置表合并，覆盖优先

## 索引重建 / 重置

索引损坏或需要重算时，删除数据目录即可（下次会话启动会从会话文件全量重建）：

```bash
rm -rf ~/.pi/agent/token-usage-statistics
```

重建过程非致命：损坏的会话文件会被跳过并计数，不会终止 Pi。

## 开发

```bash
npm install
npm test           # 全量测试（vitest）
npm run typecheck  # 类型检查
npm pack --dry-run # 打包内容预览
```

## License

MIT
