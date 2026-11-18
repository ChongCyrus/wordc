# 资源纪律与 OOM 防护（0.3.8 起）

手机环境：Android proot Ubuntu，`MemTotal ≈ 11.9GB`，但 Android 系统 + DSH 引擎 + WebView/Chromium + Node 构建会叠加；可用内存常只剩 2–4GB。引擎被 Android LMK 杀掉时表现为「崩溃/中断」，无法在 proot 内提高上限（无 root、无 cgroups、`swapon` 通常被禁）。

## 硬规则（所有 agent 必须遵守）

1. **同一时间只允许一个重型任务**：`pnpm build` / 全量 E2E / 大测试 / APK 打包 / 大数据导入，四类互斥。
2. **长任务优先 GitHub Actions**：
   - 单元测试、`tsc`、`build`、**APK 构建**、**S1–S21 全量 E2E** → CI（`ci.yml` / `e2e.yml`）。
   - 本机只做：单文件测试、快速冒烟、UI 截图抽查、数据生成（workflow 免费模型）。
3. **大体积测试 CI-only**：`REAL_PACKS_TEST=1` 的 real-packs（9.6MB pack）只在 CI 跑；本机不跑。
4. **E2E 单实例**：Chromium 一次只开一个；跑完 `pkill` 清理；不并行多视口。
5. **vitest 单 fork**：`--pool=forks --poolOptions.forks.maxForks=1`；测试文件按需指定，不跑全量。
6. **构建前后检查内存**：`free -m`，可用 < 2.5GB 时先杀残留进程/重启 App，或改天/交给 CI。
7. **禁止并行多 agent 重型操作**：一个 agent 跑 build/E2E 时，其他 agent 只做只读或编辑。
8. **引擎崩溃恢复流程**：查 `git status`、后台 job、CI run 后恢复；不重复执行可能已产生的构建产物（先查文件/CI artifact）。

## 本机可做的降载

- 关闭不用的后台 app；DSH 息屏后引擎可能被限流（长任务建议亮屏/充电）。
- 重启 dsh-go App 可释放累积内存（会话在磁盘，不丢数据）。
- 避免 `pnpm build` 与 vitest 同时跑。
- 大文件（pack/APK）用 `unzip`/复制后及时清理 `/tmp` 中间产物。

## 提不了上限时

- 无法改 Android LMK 策略（需 root）；不要尝试 `swapon`/cgroup 调整。
- 用「换机器/CI」代替「加内存」：GitHub runner 内存 7GB+，更适合构建与全量测试。
