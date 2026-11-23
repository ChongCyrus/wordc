# 词根缀源全量生成报告（2026-11-23）

- 词库：kaoyan-2027-dagang（商业词表 5528 词）
- 产物：`data/generated/root-etymology.bundle.json`（minified 4.5MB，gzip 1.1MB）
- 条目：**5528 / 5528**
- parts 统计：prefix 2166 / root 7041 / suffix 3695 / other 196
- 每条均有 etymology 与 composition；parts.meaning 全部非空
- 校验：merger 无 invalid、无重复 wordId
- checksum：`589e90135e31c39f88a7ab06d4b7abf1e00c0e4368b0010b5a38ddc3313239a2`
- 生成方式：
  - 0–250 词：DeepSeek CLI + buddy 试点（100 + 150）
  - 250–5650 词：buddy workflow 子代理（108 分片 × 50）
  - 5650–5528 词：DeepSeek CLI 补尾（1052 词，¥1.33）
- 已知差异：DeepSeek 补尾 1052 词的 part 不带 `note`（buddy 部分带），质量略低；buddy 额度恢复后可重生成覆盖
- 覆盖率：商业词表 100%；2027 大纲词库（5528 词）未生成
- 0.7.6：wordId 已统一为 App 规范（deck:小写词形），与内置 deck/DB 一致（5528/5528）
