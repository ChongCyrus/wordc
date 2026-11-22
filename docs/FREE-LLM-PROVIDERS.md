# 免费大模型 API 调研与接入方案（国内 provider）

> 任务：task-79 · 负责人 research-api · 核实日期：**2026-11-11**
> 范围：**只看国内平台**（按用户要求，国外 Gemini/Groq/OpenRouter/GitHub Models/Cloudflare/Mistral 全部排除）
> 用途：给 WordC 私版「AI 扩充（例句/词组/助记/本义链）」批量生成 + DSH Agent 自身换模型
> 标注：**【官】** = 官方页面原文（已实抓）·**【二手】** = 第三方/博客/聚合页（未在官方页复核）·**【待核】** = 已知惯例但本次未抓到官方原文

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 有没有「永久免费」的国内大模型 API？ | **有**：智谱 `GLM-4.7-Flash`（官方定价 0 元/0 元）是唯一明确「永久免费 + 200K 上下文」的；硅基流动有若干 ¥0 免费模型（需实名）。 |
| 有没有「送 token」的一次性额度？ | **有**：阿里百炼每模型约 100 万 tokens / 90 天（仅新加坡地域）；火山方舟每模型 50 万 tokens；腾讯混元 100 万 tokens / 1 年；百度千帆 17 个模型各 100 万 / 3 个月。 |
| 够不够我们批量生成？ | 我们一轮全量（5530 词 × 例句/词组/助记 ≈ 数十万 tokens）**免费模型就够**，只是并发低、要串行+限速。一次性赠送额度适合「一次性跑完」的场景。 |
| 接入 App 要改代码吗？ | **不用**：App 已支持 OpenAI 兼容 baseURL + model（`src/data/ai/provider.ts`）。但注意 `buildChatUrl()` 只认 `/v1` 或完整 `/chat/completions`，**非 /v1 端点必须填完整 URL**（见 §3.1）。 |
| 接入 DSH 要改代码吗？ | **不用**：composed profile 已挂载 `@deepseek-ai/dsh-llm-pi-ai`（当前空配置），可在 **Settings → Models** 加自定义 OpenAI 兼容 route，或改 `~/.dsh/profiles/web/cordis.patch.yml`（见 §4）。 |
| 推荐 Top3 | **① 智谱 GLM-4.7-Flash（免费主力）② 硅基流动 Qwen3-8B（免费备用/分流）③ 火山方舟豆包 或 阿里百炼（一次性赠送额度冲刺）** |

---

## 1. 国内 provider 免费额度对比（核实 2026-11-11）

| Provider | 免费额度（官方原文要点） | 有效期 | 注册/实名门槛 | OpenAI 兼容 baseURL | 备注 / 来源 |
|---|---|---|---|---|---|
| **智谱 BigModel** | `GLM-4.7-Flash`：输入**免费**、输出**免费**、缓存命中免费，200K 上下文【官】 | **长期/永久**（官方定价表标「免费」，非活动） | 手机号注册 + 控制台建 API Key；免费模型额度按并发限制（权益等级）【官】 | `https://open.bigmodel.cn/api/paas/v4`【官】 | 官方定价页；速率限制页。免费档并发较小（【二手】实测 1~30 说法不一，以控制台「速率限制」为准） |
| **硅基流动 SiliconFlow** | 「实名认证后使用**全部免费模型**；免费模型调用免费（账单 0 元），Rate Limits 固定」【官】；具体免费模型如 `Qwen/Qwen3-8B`、`Qwen/Qwen2.5-7B-Instruct`【二手】 | 长期（¥0 模型） | **注册手机号 + 实名认证**（身份证/港澳台通行证/永居证）【二手+官】 | `https://api.siliconflow.cn/v1`【官】 | 官方 Rate Limits 文档确认免费模型机制；JSON 模式有官方文档 |
| **阿里云百炼（通义）** | 新用户**每个模型约 100 万 tokens**，各模型独立不互通；「仅**新加坡地域**模型享有免费额度」【官】 | **90 天**（自开通/模型发布较晚者起算）【官】 | 需**完善信息**（实名）后才能开通；免费额度用尽自动转按量付费 | `https://dashscope.aliyuncs.com/compatible-mode/v1`（老域名仍可用）；新域名 `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`【官】 | 官方新人免费额度页。⚠️ 免费额度仅新加坡地域；API Key 按地域绑定 |
| **火山方舟（豆包）** | 「每个模型提供一定额度免费调用量」；安心体验模式「仅消耗平台赠送的 **50w token** 免费额度」【官】 | 以控制台/开通页为准 | 火山引擎账号 + **实名认证**（【二手】，官方开通流程要求实名） | `https://ark.cn-beijing.volces.com/api/v3`【官】 | 官方开通管理文档 |
| **腾讯混元 Hunyuan** | 首次开通送 **100 万 tokens** 免费资源包（Hunyuan-a13b/role/translation/vision/embedding 等共享消耗）【官】 | **1 年** | 腾讯云**企业/个人实名认证**后才可开通【官】 | `https://api.hunyuan.cloud.tencent.com/v1`【二手/官网文章】 | ⚠️ 官方公告：混元能力**逐步迁移至 TokenHub**，原平台不再新增模型、停止新购；新用户建议直接去 TokenHub。默认并发 5【二手】 |
| **百度千帆** | 新用户 **17 个指定模型各 100 万 tokens**（ERNIE-4.5-Turbo-128K/32K、ERNIE-X1-Turbo、DeepSeek-R1/V3/V3.1、Kimi-K2、Qwen3 系列等）【官】 | **3 个月** | 百度智能云注册 + **实名认证**；另送 20 元代金券（【二手】） | `https://qianfan.baidubce.com/v2`【官】 | 官方「新用户免费额度」页（更新 2025-11-17） |
| **月之暗面 Kimi（Moonshot）** | **无免费 API 额度**；按量计费（K3 系列 1M 上下文、K2 系列 262K）【官】 | — | 手机号注册 | `https://api.moonshot.cn/v1`【官】 | ⚠️ K2 系列 2026-10-31 起停止对新用户开放，12 月底全部下线【官】 |
| **MiniMax** | **无免费额度**；`MiniMax-M3.1-Flash` 1.00/4.00 元/百万 tokens（输入/输出），M3「永久五折」【官】 | — | 手机号注册 | `https://api.minimaxi.com/v1`【待核】 | 官方定价页；文档站未抓到 baseURL 原文 |
| **阶跃星辰 StepFun** | 未见官方免费额度页；【二手】聚合站称「阶跃星辰等模型限时免费，每模型 100 次/天、不扣积分」 | 限时/未知 | 手机号注册 | `https://api.stepfun.com/v1`【待核】 | 未在官方页复核，**不列入推荐** |
| **百川智能 Baichuan** | 平台价格页 404；【二手】称「注册送 80 元体验金（约 500 万 tokens）」「M3Plus 海纳百川计划需申请审核」 | 未知 | 未知 | `https://api.baichuan-ai.com/v1`【待核】 | 平台状态不稳定，**不推荐依赖** |
| **零一万物 01.AI** | 平台**已退役停服**（HTTP 410；【二手】时间线：2026-08-03 停注册充值、09-03 停调用、12-03 退款截止） | — | — | — | **不可用** |
| **DeepSeek（本项目默认）** | **无公开免费额度/赠送**：官方定价页只有按量计费（Flash / V4-Pro，峰谷定价）【官+二手】 | — | 手机号注册 | `https://api.deepseek.com`（Anthropic 兼容 `/anthropic`）【官】 | 本机 DSH 已走 `deepseek-account`（账号授权，无需 API Key） |

**够不够「2–3 万 c 内容」**：我们单轮全量约 5530 词、每批 20 词、3 类内容，估算 100–300 万 tokens 量级；若只按 `momo-pack` 单批实测（20 词 42 c 约 ¥0.05、15.7s），免费模型逐批跑完全量约需数小时（受并发 1~3 限制）。**结论：免费模型够量，但更适合分片夜间跑；一次性赠送额度（百炼 100 万/模型 × 多模型、千帆 17×100 万）适合集中冲刺。**

---

## 2. Top3 推荐

### ① 智谱 GLM-4.7-Flash —— 免费主力（首选）
- 理由：**官方定价「输入 免费 / 输出 免费」**，200K 上下文（足够 20 词/批 + 长 prompt）；OpenAI 兼容；有 JSON 支持（prompt 已要求严格 JSON，App 会带 `response_format: json_object`）。
- 代价：免费档**并发很低**（控制台速率限制页为准），批量脚本把 `--concurrency` 降到 1–2，`429` 退避重试（CLI 已内置 1s/2s/4s）。
- 注册：bigmodel.cn 手机号注册 → 控制台建 API Key。

### ② 硅基流动 SiliconFlow `Qwen/Qwen3-8B`（免费）—— 免费备用/分流
- 理由：官方明示「实名后全部免费模型可用、调用 0 元」；同一 baseURL 还托管 DeepSeek/Qwen/GLM/Kimi 等（付费可无缝升级）；OpenAI 兼容 + JSON 模式官方文档。
- 代价：**必须实名认证**；免费模型 RPM/TPM 固定较低（官方 Rate Limits 页：语言模型 RPM 1000–10000 / TPM 5万–500万 是整体区间，免费模型取固定低值）。

### ③ 火山方舟豆包 / 阿里百炼 —— 一次性赠送额度冲刺
- **火山方舟**：每模型 50 万 tokens 免费，baseURL `https://ark.cn-beijing.volces.com/api/v3`，模型名形如 `doubao-seed-2-1-pro-260915`（以控制台为准）。
- **阿里百炼**：每模型约 100 万 tokens，90 天；可对 qwen-plus / qwen-flash / qwen3-max 等多个模型分别领取（独立额度），叠加量大；**但免费额度仅新加坡地域**，baseURL 用 `dashscope.aliyuncs.com` 老域名或工作空间新域名，API Key 要按地域创建。
- 适合：需要一次性跑完全量、不想只靠低速免费模型时。

> 不推荐把 Moonshot / MiniMax 作为「免费」方案（无免费层）；StepFun/百川/零一 因官方信息不稳或已停服，不列入。

---

## 3. 接入我们的 App（WordC）具体配置

### 3.1 关键兼容性结论（基于 `src/data/ai/provider.ts`）

- 请求：`POST {baseUrl}/v1/chat/completions`；`Authorization: Bearer <key>`；body 含 `model/messages/temperature/stream:false`，**默认带 `response_format:{type:'json_object'}`**（`body.jsonMode !== false` 时）。
- **URL 拼接规则（踩坑点）**：
  - `baseUrl` 以 `/chat/completions` 结尾 → 原样使用（**最稳，建议所有非 /v1 端点都这么填**）；
  - 以 `/v1` 结尾 → 拼 `/chat/completions`；
  - 否则 → 拼 `/v1/chat/completions`。
  - ⚠️ 所以智谱 `/api/paas/v4`、火山 `/api/v3`、千帆 `/v2` **不能**只填根路径，否则会变成 `.../v4/v1/chat/completions` 而 404。
- JSON 模式：App 默认发 `response_format:{type:'json_object'}`。**若某 provider 不认该字段会 400**，此时把 `jsonMode` 关闭（代码已有开关，但批量 CLI 走同一 provider，需 dev 确认 CLI 是否暴露该开关；见 §5 遗留）。
- 响应解析：只认 OpenAI 标准 `choices[0].message.content` + `usage`；各 provider 均满足。

### 3.2 各 provider 填入 App 的建议值

| Provider | `ai.baseUrl` 填这个（可直接用） | `ai.model` | JSON 模式 | 需在 APK `AiApi` 放行的 host |
|---|---|---|---|---|
| **智谱** | `https://open.bigmodel.cn/api/paas/v4/chat/completions` | `glm-4.7-flash` | 支持【官】 | `open.bigmodel.cn` |
| **硅基流动** | `https://api.siliconflow.cn/v1` | `Qwen/Qwen3-8B` | 支持【官】 | `api.siliconflow.cn` |
| **火山方舟** | `https://ark.cn-beijing.volces.com/api/v3/chat/completions` | 控制台「推理接入点」模型 ID，如 `doubao-seed-2-1-pro-260915` | 支持【官】 | `ark.cn-beijing.volces.com` |
| **腾讯混元** | `https://api.hunyuan.cloud.tencent.com/v1` | `hunyuan-turbos-latest` / `hunyuan-lite` | 支持（OpenAI 兼容）【二手】 | `api.hunyuan.cloud.tencent.com` |
| **百度千帆** | `https://qianfan.baidubce.com/v2/chat/completions` | `ernie-4.5-turbo-128k` 等（按模型页） | 支持（`response_format`）【待核】 | `qianfan.baidubce.com` |
| **阿里百炼** | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` / `qwen-flash` 等 | 支持【官】 | `dashscope.aliyuncs.com`（新工作空间域名 `{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com` 需逐个精确放行，**白名单不支持通配**） |
| **Kimi** | `https://api.moonshot.cn/v1` | `kimi-k3` 等（无免费，仅备选） | 支持 | `api.moonshot.cn` |
| **MiniMax** | `https://api.minimaxi.com/v1`【待核】 | `MiniMax-M3.1-Flash` 等 | 待核 | `api.minimaxi.com` |
| DeepSeek（现状） | `https://api.deepseek.com` | `deepseek-flash` | 支持 | `api.deepseek.com`（**已默认放行**） |

### 3.3 两处需要放行/配置的地方

1. **APK 原生桥 `AiApi`**（`docs/APK.md §3.4`）：host 白名单**默认只有 `api.deepseek.com`**，且必须是 **https + 精确域名（非 443 端口不行）**。用户可在 App 设置页添加自定义 host，走**原生确认对话框**（`AiApi.addHost` → `__aiApiHostResult`，JS 侧 `requestAiHostPermission`）；每加一个上表 host 都要确认一次。若要内置默认（不改代码的前提下只能靠用户手点），建议 dev 后续把 Top3 的 host 写进 APK 默认白名单（需改 APK 源码，不在本任务范围）。
2. **浏览器/PWA 代理** `tools/ai-proxy.mjs`：上游由**启动者用 env 固定**（防 SSRF，页面不能指定上游），只转发 `POST {AI_PATH}`：
   ```bash
   AI_UPSTREAM=https://open.bigmodel.cn AI_PATH=/api/paas/v4/chat/completions node tools/ai-proxy.mjs
   # → App 设置页代理地址 http://127.0.0.1:8788，baseUrl 填 http://127.0.0.1:8788（不再用 /v1）
   ```
   ⚠️ 注意：`buildChatUrl()` 对 `http://127.0.0.1:8788` 会拼成 `/v1/chat/completions`，而代理只认 `AI_PATH`；**要么把 `AI_PATH` 设为 `/v1/chat/completions` 并在 `AI_UPSTREAM` 里带上游完整路径**（推荐：`AI_UPSTREAM=https://api.siliconflow.cn` + `AI_PATH=/v1/chat/completions`），要么把 baseUrl 填成 `http://127.0.0.1:8788/chat/completions` 并把 `AI_PATH=/chat/completions`。动代码前先用 curl 验证代理路径。

### 3.4 批量 CLI（`tools/gen-pack-deepseek.mjs`）
- 支持 `--model` / `--base-url`；同样受 §3.1 URL 拼接规则约束（非 `/v1` 端点传完整 URL）。
- 成本上限/重试已内置：`401/402` 直接中止（**注意**：很多免费 provider 用 `429` 表示额度/限频，CLI 会重试 3 次后退避；`403` 可能表示需要实名/开通，按错误文案处理）。
- 建议：智谱免费档 `--concurrency 1`，硅基流动 `--concurrency 3`，分批跑（`--shard i/n --resume`）。

---

## 4. 接入 DSH 本体（不改源码）

### 4.1 现状（实读 2026-11-11）
- DSH 版本 `0.2.2-rc.1`，npm 包 `@deepseek-ai/dsh`；profile 在 `~/.dsh/profiles/web/`。
- 组合配置（`dsh --profile web --dump-config`【实测】）已挂载：
  - `llm-pi-ai` = `@deepseek-ai/dsh-llm-pi-ai`（**当前无 config，即"空路由"**）——这是给「多 provider / OpenAI 兼容网关」用的适配器；
  - `llm-deepseek` = `@deepseek-ai/dsh-llm-deepseek-api-key`（官方 DeepSeek，API Key 方式）；
  - `llm-deepseek-account` = 账号授权方式（当前 `agent-default-model` 的 `provider: deepseek-account`, `model: deepseek-flash`）；
  - 凭据存储：`~/.dsh/.credentials.yaml`（`refs:` 存环境变量名→密钥，**stored key 优先于 env**）。
- pi-ai 已装 catalog（`@earendil-works/pi-ai`）自带：`zai`(智谱/Z.ai)、`moonshotai`/`moonshotai-cn`、`minimax`/`minimax-cn`、`deepseek`、`qwen-token-plan`、`xiaomi` 等国内 provider 的路由与模型目录；**硅基流动/火山方舟/腾讯混元/百度千帆不在 catalog** → 需「hand-declared route」（`api: openai-completions` + `baseURL` + `models` 列表）。

### 4.2 方案 A：界面操作（最简单，推荐先试）
1. 打开当前 Web GUI（`http://127.0.0.1:3080`）→ **Settings → Models**；
2. 已有 catalog provider（如 Z.ai/智谱）直接点开卡片 → 粘贴 API Key → Apply（Key 写入凭据存储，`cordis.patch.yml` 不出现密钥）；
3. 或在 Models 页 **「添加 provider」** 手填：
   - Provider ID：`siliconflow`（固定，不能改）
   - API 协议：`OpenAI Chat Completions`（`openai-completions`）
   - Base URL：`https://api.siliconflow.cn/v1`
   - 模型：`Qwen/Qwen3-8B`（可选加 `contextWindow`/`maxTokens`）
   - API Key：粘贴 → Apply；
4. 回到对话输入框，在**模型选择器**里选新 provider 的模型（保存选择会写 `agent-default-model`，新 session 生效）。

### 4.3 方案 B：改 profile patch 文件（可批量、可版本化）
编辑 `~/.dsh/profiles/web/cordis.patch.yml`，加显式 patch 条目（id 与组合树中的 id 相同即覆盖 config）：

```yaml
# 追加到现有数组末尾（注意 YAML 缩进；不要在文件里写 API Key）
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      # 手声明 OpenAI 兼容网关
      siliconflow:
        displayName: SiliconFlow
        api: openai-completions
        baseURL: https://api.siliconflow.cn/v1
        apiKeyEnv: SILICONFLOW_API_KEY
        models:
          - id: Qwen/Qwen3-8B
            name: Qwen3 8B
            contextWindow: 40960
            maxTokens: 8192
      zhipu:
        displayName: 智谱 GLM
        api: openai-completions
        baseURL: https://open.bigmodel.cn/api/paas/v4
        apiKeyEnv: ZHIPU_API_KEY
        models:
          - id: glm-4.7-flash
            name: GLM-4.7-Flash
            contextWindow: 200000
            maxTokens: 128000
          - id: glm-5.3-flash
            name: GLM-5.3-Flash
            contextWindow: 1048576
            maxTokens: 65536
      ark:
        displayName: 火山方舟
        api: openai-completions
        baseURL: https://ark.cn-beijing.volces.com/api/v3
        apiKeyEnv: ARK_API_KEY
        models:
          - id: doubao-seed-2-1-pro-260915
            name: Doubao Seed 2.1 Pro
            contextWindow: 262144
            maxTokens: 32768
```

- **Key 两种给法**（二选一）：
  1. 启动 DSH 前 `export ZHIPU_API_KEY=...` / `export SILICONFLOW_API_KEY=...`（写进 `~/.bashrc` 或启动脚本）；
  2. 不落 env：用 §4.2 的 Models 页输入 Key（写入 `.credentials.yaml` 的 `refs`，**stored 优先于 env**）。
- 改完验证（不启动、不改源码）：
  ```bash
  dsh --profile web --dump-config | grep -A20 "llm-pi-ai"
  ```
  看到 `providers:` 下出现新 route 即生效；之后重启 `dsh web`（或等 HMR 自动重组）即可在模型选择器看到。
- 切换默认模型：改 `- id: agent-default-model` 的 `provider:`（如 `zhipu`）/`model:`（如 `glm-4.7-flash`），或直接用界面选择器（会写回 patch）。
- 路由名冲突会**加载失败**（同一 route 只能一个 adapter 拥有）；如与 catalog route 重名（如 `zai`），改用手声明的新名字（如上例 `zhipu`）。

### 4.4 直接可用/需手声明的清单（DSH）
| Provider | DSH 走法 |
|---|---|
| 智谱（Z.ai/GLM） | catalog 自带 route（`zai`，`ZAI_API_KEY`），Settings → Models 填 Key 即可；也可按 §4.3 手声明 `zhipu` |
| 月之暗面 Kimi | catalog 自带（`moonshotai`，`MOONSHOT_API_KEY`） |
| MiniMax | catalog 自带（`minimax` / `minimax-cn`，`MINIMAX_API_KEY` / `MINIMAX_CN_API_KEY`） |
| DeepSeek | 已有（`deepseek-account` 账号授权 / `deepseek-api-key`，`DEEPSEEK_API_KEY`） |
| 硅基流动 / 火山方舟 / 腾讯混元 / 百度千帆 / 阿里百炼 | **手声明 route**（§4.3 模板），`api: openai-completions` + `baseURL` + `models` |

> 说明：DSH 的 pi-ai 适配器请求协议是 **OpenAI Chat Completions**（`openai-completions`），与上表 baseURL 兼容；不要给它填 `/chat/completions` 完整路径（适配器自己拼 `/chat/completions`，`baseURL` 填到 `/v1` 或 `/api/paas/v4`、`/api/v3`、`/v2` 这类根即可）。

---

## 5. 风险提示

1. **额度变化极快**：本表是 2026-11-11 快照。阿里百炼 9/15 起要求先完善信息、免费额度仅新加坡；腾讯混元正在迁 TokenHub；百度已下架 ERNIE-Speed/Lite「永久免费」（【二手】）；智谱免费模型列表也会变。**接入前以控制台「免费额度/速率限制」页为准，代码里做好 `403/429/402` 的降级与切换提示。**
2. **API Key 保密**：Key 只能填在 App 设置（`ai.keyStorage='session'` 时不落库）或 DSH 凭据存储/env；**不要写进 `cordis.patch.yml`、不要提交 git、不要贴聊天**。App 已有 `sanitizeSnippet`/`redactAiConfig` 脱敏，错误信息不含 key。
3. **数据条款/训练用途**：免费层通常保留「用你的输入改进服务」的权利（各家隐私政策不同，需逐家阅读；尤其「免费=可能用于训练」是行业惯例）。**我们要生成的是词库例句/助记内容，不含用户隐私**，风险可控；但不要把用户学习记录/账号数据发给第三方模型。
4. **内容版权**：生成内容用于个人学习的内部词库；对外发布时注意 provider ToS 对「生成内容商用」的限制（多数允许，但免费层可能有限制，发布前逐家确认）。
5. **实名要求**：硅基流动（全部免费模型）、阿里百炼（完善信息）、腾讯混元（实名认证）、火山方舟（实名）、百度千帆（实名）——不实名基本拿不到免费额度；智谱手机号注册即可用免费模型。
6. **接入稳定性**：免费模型并发低、可能排队；批量脚本务必幂等（`--resume`）+ 限速（`--concurrency 1~3`）+ 失败重试；不同 provider 的 `429` 语义不同（限频 vs 额度耗尽），按响应体区分。
7. **CORS/白名单**：浏览器 PWA 必须走本地代理；APK 必须逐个添加 host（精确匹配、https/443）。未加 host 时原生桥会直接 `ok:false`，表现为 `AI_NETWORK`。

---

## 6. 核实来源清单（2026-11-11）

**官方（已实抓/原文引用）**
- 智谱 API 定价（GLM-4.7-Flash 免费）：<https://docs.bigmodel.cn/cn/guide/start/pricing.md>
- 智谱速率限制：<https://docs.bigmodel.cn/cn/api/rate-limit.md> · 免费模型文档：<https://docs.bigmodel.cn/cn/guide/models/free/glm-4.7-flash> · 控制台：<https://bigmodel.cn/pricing>
- 硅基流动 Rate Limits（免费模型机制/实名）：<https://docs.siliconflow.cn/cn/userguide/faqs/rate-limit-and-upgradation> · 实名认证：<https://docs.siliconflow.cn/cn/userguide/faqs/authentication> · OpenAI 调用示例：<https://docs.siliconflow.cn/cn/userguide/capabilities/text-generation> · JSON 模式：<https://docs.siliconflow.cn/cn/userguide/guides/json-mode>
- 阿里云百炼新人免费额度：<https://www.alibabacloud.com/help/zh/model-studio/new-free-quota> · OpenAI 兼容：<https://www.alibabacloud.com/help/zh/model-studio/compatibility-of-openai-with-dashscope>
- 火山方舟免费额度/安心体验：<https://docs.volcengine.com/docs/ark/activation-management> · OpenAI 兼容 baseURL：<https://console.volcengine.com/ark/region:cn-beijing/docs/compatible-with-openai-sdk>
- 腾讯混元计费/免费额度/实名：<https://cloud.tencent.com/document/product/1729/97731>
- 百度千帆新用户免费额度：<https://cloud.baidu.com/doc/qianfan/s/Imi2rpirg> · V2 chat 接口：<https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb>
- Kimi 模型推理定价：<https://platform.moonshot.cn/docs/pricing> · API：<https://platform.moonshot.cn/docs/api/chat>
- MiniMax 定价：<https://platform.minimaxi.com/document/price>
- DeepSeek API/定价：<https://platform.deepseek.com/api-docs/pricing>

**二手/聚合（仅作旁证，未作为决策唯一依据）**
- free-llm-intel（火山/百度/DeepSeek/国内 70 家免费额度巡检）：<https://github.com/rockbenben/free-llm-intel>
- free-llm-api-hub（硅基流动免费模型/实名细节）：<https://github.com/pacocartones/free-llm-api-hub>
- AI 优惠聚合器（阶跃/百川/零一停服等）：<https://buguoshixc.github.io/ai-deals-aggregator/>、<https://freeaidog.com/zh/blog/>
- GLM-4.7-Flash 免费档并发实测：<https://ofox.ai/zh/blog/glm-4-7-flash-free-api-china-guide-2026/>

**本仓库内部依据**
- App provider/URL 拼接/JSON 模式：`src/data/ai/provider.ts`、`src/data/ai/settings.ts`、`src/data/ai/transport.ts`
- APK `AiApi` 白名单机制：`docs/APK.md §3.4`、`src/data/ai/native.ts`
- 浏览器代理：`tools/ai-proxy.mjs`
- 批量生成 CLI：`tools/gen-pack-deepseek.mjs`、`docs/AI-BULK-GEN.md`
- DSH：`dsh --version`（0.2.2-rc.1）、`dsh --profile web --dump-config`、`/opt/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/README.md`、`@earendil-works/pi-ai/dist/providers/`、`~/.dsh/.credentials.yaml`

---

## 7. 遗留问题
1. 智谱/硅基流动的**免费模型具体并发/RPM** 官方只在控制台「速率限制」页展示（需登录），文档未给固定数字；接入后需实测并记录。
2. 火山方舟「每模型 50w」与「安心体验模式 50w」是否叠加/同源，官方表述含糊，以控制台为准。
3. `gen-pack-deepseek.mjs` 是否暴露 `jsonMode` 关闭开关（用于不支持 `response_format` 的 provider）需 dev-engine 确认；若不支持，优先选我们验证过的智谱/硅基流动（都支持 JSON 模式）。
4. DSH 的 Models UI 能否顺利手声明「非 catalog provider」（硅基流动等）建议实测一次（字段：Provider ID / API 协议 / baseURL / models / Key）。
