# Changelog

本项目的所有显著变更都会记录在此文件。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 约定，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-08-16

### Added

- **Pi Web 兼容面板**（[PR #2](https://github.com/Techd81/pi-usage-statistics/pull/2)）：在 Pi Web `>= 0.8.8` 的 RPC 会话中输入 `/pi-usage-statistics` 打开浏览器内的交互式统计面板
- **ASCII-safe Web 渲染器**：摘要、按模型统计表与趋势图使用纯 ASCII 布局，避免 Emoji / Unicode 框线与浏览器字体度量差异造成的列错位；窄宽度自动切换堆叠行布局
- **RPC 自动回退**：不支持自定义面板桥的通用 RPC 客户端自动回退到紧凑文本摘要，不改变原有行为
- **`Ctrl+C` 关闭面板**：兼容 Pi Web 面板「关闭」按钮的关闭字节，终端 `Esc` 导航逻辑不受影响

### Changed

- README 补充 Pi Web `0.8.8+` 安装与使用说明；命令描述同步更新

### Unchanged

- 终端 TUI 体验保持原样（完整艺术字、多系列图表、框线布局）
- 统计、去重、价格计算、持久化与实时刷新全部复用现有实现，无重复逻辑

## [0.1.0] - 2026-07-XX

### Added

- 首个 npm 发布版本
- **TUI dashboard**：`/pi-usage-statistics` 打开嵌入式交互面板——总览卡片、五项指标槽、多系列趋势图与按模型统计表
- **Accurate collection**：仅统计完成的 assistant 回复，不订阅 streaming 增量，避免双计
- **多范围查询**：项目级（当前工作目录）与全局级（全部本地会话）切换；时间范围：当天 → 1d → 7d → 14d → 30d → 1year → 全部
- **成本可追溯**：优先使用 Pi 记录的 cost，否则按内置价表估算；支持 `pricing.json` 价格覆盖文件
- **实时刷新**：`message_end` 防抖热更新；多窗口场景磁盘轮询重载共享 `records.jsonl`
- **独立查看器**：`pi-usage`（或 PowerShell wrapper `pi usage`）免启动会话直接打开面板
- **跨窗口热更新**：多进程安全合并写入 + 5s 强制校准兜底

[0.2.0]: https://github.com/Techd81/pi-usage-statistics/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Techd81/pi-usage-statistics/releases/tag/v0.1.0
