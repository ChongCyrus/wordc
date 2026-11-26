# 云端任务调度（tools/cloud）

目标：本地 Agent 只提交任务，超过几秒的工作交给云端执行，结果/日志/产物回传。

## 已实现

```bash
node tools/cloud/job.mjs --provider local  --cmd "pnpm test -- --run"
node tools/cloud/job.mjs --provider github --cmd "pnpm test -- --run"
node tools/cloud/job.mjs --provider ssh    --cmd "pnpm build"
```

- `local`：本机执行，验证契约。
- `github`：触发 `.github/workflows/cloud-task.yml`，轮询 run，下载日志。
- `ssh`：远程 Linux 执行（需要 ECS 时配置）。
- `fc` / `eci`：预留；需要阿里云 AccessKey 后接入。

每次任务输出目录：

```text
.cloud-jobs/<jobId>/
  job.json
  stdout.log / stderr.log / action.log
```

## GitHub 模式

需要：

- `GITHUB_TOKEN`（已有 `.secrets/github-token`）
- 私有仓库已包含 `.github/workflows/cloud-task.yml`
- 可选环境变量：
  - `CLOUD_GITHUB_REPO`（默认 `ChongCyrus/wordc`）
  - `CLOUD_GITHUB_REF`（默认 `main`）

注意：私有仓库有免费分钟额度；公开仓库免费。

## SSH / ECS 模式（以后）

需要：

- `CLOUD_SSH_HOST`
- `CLOUD_SSH_USER`（默认 root）
- `CLOUD_SSH_KEY`（私钥路径）

建议：

- ECS 不暴露 22，使用 Tailscale / Cloudflare Tunnel / 跳板机
- 任务用 Docker 限 CPU/内存/超时

## 阿里云 FC / ECI 接入所需（待用户授权）

1. 阿里云账号已完成实名认证
2. 开通：
   - 函数计算 FC
   - 弹性容器实例 ECI
   - 对象存储 OSS
   - 日志服务 SLS（可选）
3. 创建 **RAM 子用户**（不要用主账号 AccessKey），授予最小权限：
   - `AliyunFCFullAccess`
   - `AliyunECIFullAccess`
   - `AliyunOSSFullAccess`
   - `AliyunLogFullAccess`（如需日志）
4. 选择地域，例如 `cn-hangzhou`
5. 创建 OSS bucket（存代码/产物）
6. 把配置写到本机（不要提交、不要贴聊天）：

```bash
# ./.secrets/aliyun.env
ALIBABA_CLOUD_ACCESS_KEY_ID=...
ALIBABA_CLOUD_ACCESS_KEY_SECRET=...
ALIBABA_CLOUD_REGION=cn-hangzhou
ALIYUN_OSS_BUCKET=...
```

7. 设置预算告警（避免误跑大任务）

## 推荐使用策略

- 小于 15 分钟、无 Docker：FC
- Docker / 长任务：ECI
- 需要常驻/交互：ECS 按量 + 节省停机
- 仓库 CI：GitHub Actions
- 无影：只在需要图形桌面时用

## 尚未实现

- FC/ECI adapter（等 AccessKey 与地域）
- 产物自动上传 OSS
- SLS 日志拉取
- 任务队列/并发控制
