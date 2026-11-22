# UI 审计（0.3.93–0.3.98 收尾）

> 范围：0.3.93 全面审计后的 UI 坑、0.3.94–0.3.98 回归发现。**只记录/修复，不新增功能。**
> **版本注记：0.3.96 / 0.3.97 未公开发布，修复并入 0.3.98。**
> 审计方式：源码审查 + 生产 dist 的 QA gate（不调真实 API）。

## 结论摘要

| # | 发现 | 影响 | 状态 | 回归 gate |
|---|---|---|---|---|
| U1 | 新全屏面板默认 `open=false` 仍渲染 DOM/遮罩/监听 | 隐藏层抢滚动、back 哨兵异常、内存/监听残留 | 已修：条件挂载，关闭清理 | `qa-task297-gate` + DOM 检查 |
| U2 | 详情冷启动等待聚合/内容包后才渲染 | 白屏/慢、以为卡死 | 已修：先直接渲染，内容异步补 | `qa-detail-root-card-gate` |
| U3 | 浏览器 back 哨兵按打开次数重复 push，history 增长 | 返回多次才能退出、返回逻辑错乱 | 已修：单层单哨兵；popstate 只关闭当前层 | 手动 history 长度 + 返回路径 |
| U4 | 批量面板切换「选中来源」时旧请求覆盖新结果 | 候选数/开始按钮与来源不一致，可能误操作 | 已修：请求序号/取消旧请求，只接受当前来源响应 | `qa-task297-gate` |
| U5 | fresh 预装/内容包顺序 | 预装数据先于内容包或互相覆盖 | 已修：先内容包 apply 再 mnemonics；失败重试 | fresh 预装手测 |
| U6 | 自动备份/恢复 UI 文案与异常 | 100MB/gzip/恢复态/旧 sources 兼容 | 已修/已验 | `qa-autobackup-native-gate` |

## 回归命令（生产 dist）

```bash
node tests/e2e/qa-task297-gate.mjs
node tests/e2e/qa-detail-root-card-gate.mjs
node tests/e2e/qa-requeue-gate.mjs
node tests/e2e/qa-autobackup-native-gate.mjs
```

## 通过标准

- U1–U4 在 390/360 无隐藏层残留、返回一次到原页、无控制台错误；
- 详情首屏直接出现卡片；批量面板来源切换后数字/按钮正确；
- 备份恢复不覆盖当前数据（merge + pre-restore）；
- 任一项失败记录截图/复现步骤，修复后再进 0.3.98 发版。
