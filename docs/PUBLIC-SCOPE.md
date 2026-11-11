# 公开版范围说明

本仓库是私有项目的**脱敏公开版**（名称 WordC · 词到义，包名 com.wordc.app）。

## 与私版的差异

| 项 | 私版 | 公开版 |
|---|---|---|
| 默认内置词库 | 受限商业词表 2025（6702）+ 大纲（5528） | **仅大纲（5528）**；受限商业词表词表不随仓分发 |
| 原始数据/构建脚本 | data/raw、词库构建脚本 | 不含（只有预构建的大纲词库 JSON） |
| 官方 App 素材/研究 | docs/research、docs/assets、官方截图/前端片段 | 不含 |
| APK 壳/签名/工具链 | tools/apk + keystore + toolchain | 不含；CI 不构建 APK |
| CI | 含 apk job（签名 secrets） | 仅 tsc/单测/build/E2E，无 secrets |
| 品牌 | 改版MaiMemo背单词 / com.dsh.momoreword | WordC / com.wordc.app |
| MaiMemo导入 | 官方开放 API + 用户 Token（浏览器需本地代理） | **功能保留**，文档保留用户说明（不公开非公开研究/协议细节） |

## 不变的功能

学习队列/三键反馈/当日进度回炉/单词详情/统计/计划续学/回退改判/导入导出（迁移包）/
从MaiMemo导入（官方 API + 自己 Token）/PWA 离线。

## 不公开的内容

内部决策记录、非公开研究文档、官方截图与前端片段、QA 报告、私有构建/签名流程。
