import { useEffect, useState } from 'react'
import type { AiConfig, AiProviderId, AiSettingsState } from '../../data/ai'
import {
  AI_PROVIDER_OPTIONS,
  formatAiTestFailure,
} from '../../app/hooks/aiUi'
import {
  clearAiApiKey,
  createLlmProvider,
  DEFAULT_AI_CONFIG,
  loadAiSettings,
  maskApiKey,
  saveAiSettings,
} from '../../data/ai'
import { useToast } from '../../app/toast'

export interface AiSettingsFormValue {
  enabled: boolean
  provider: AiProviderId
  baseUrl: string
  model: string
  keyStorage: 'persistent' | 'session'
  maskedKey: string
  hasKey: boolean
  maxCostPerRun: number
  pregenBudget: number
  /** 兼容模式：false 时不发 response_format（部分免费模型不支持） */
  jsonMode: boolean
}

export interface AiSettingsFormProps {
  value: AiSettingsFormValue
  onChange: (patch: Partial<AiSettingsFormValue>) => void
  /** 保存密钥（session 模式只在内存） */
  onSaveKey: (key: string) => void
  onClearKey: () => void
  onToggleEnabled: (enabled: boolean) => void
  onToggleJsonMode: (enabled: boolean) => void
  onTestConnection: () => void
  testing: boolean
  /** 测试结果文案（成功/错误码映射，已脱敏） */
  testMessage: string | null
  saving?: boolean
}

/**
 * AI 扩充设置（task-71）纯展示表单：
 * - provider/baseURL/model、Key（掩码回显 + persistent/session）、清除 Key、测试连接；
 * - 单次预算 / 全量预生成预算；
 * - 隐私说明：Key 只存本机、不导出、不进日志。
 */
export function AiSettingsForm({
  value,
  onChange,
  onSaveKey,
  onClearKey,
  onToggleEnabled,
  onToggleJsonMode,
  onTestConnection,
  testing,
  testMessage,
  saving = false,
}: AiSettingsFormProps) {
  const [keyInput, setKeyInput] = useState('')

  return (
    <>
      <div className="mm-list">
        <div className="mm-row">
          <span className="mm-row-main">
            <span className="mm-row-title">启用 AI 扩充</span>
            <span className="mm-row-sub">关闭后学习页/设置页隐藏生成入口</span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={value.enabled}
            aria-label="启用 AI 扩充"
            className={`mm-switch${value.enabled ? ' is-on' : ''}`}
            onClick={() => onToggleEnabled(!value.enabled)}
            disabled={saving}
          >
            <span className="mm-switch-thumb" />
          </button>
        </div>

        <div className="mm-row">
          <span className="mm-row-main">
            <span className="mm-row-title">服务商</span>
            <span className="mm-row-sub">DeepSeek 默认；也可填 OpenAI 兼容服务</span>
          </span>
          <select
            className="mm-input"
            aria-label="AI 服务商"
            value={value.provider}
            onChange={(event) => onChange({ provider: event.target.value as AiProviderId })}
            disabled={saving}
          >
            {AI_PROVIDER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <label className="mm-row">
          <span className="mm-row-main">
            <span className="mm-row-title">API baseURL</span>
            <span className="mm-row-sub">DeepSeek 默认 https://api.deepseek.com</span>
          </span>
          <input
            className="mm-input"
            aria-label="AI baseURL"
            value={value.baseUrl}
            onChange={(event) => onChange({ baseUrl: event.target.value })}
            disabled={saving}
          />
        </label>

        <label className="mm-row">
          <span className="mm-row-main">
            <span className="mm-row-title">模型</span>
            <span className="mm-row-sub">如 deepseek-chat</span>
          </span>
          <input
            className="mm-input"
            aria-label="AI 模型"
            value={value.model}
            onChange={(event) => onChange({ model: event.target.value })}
            disabled={saving}
          />
        </label>

        <label className="mm-row">
          <span className="mm-row-main">
            <span className="mm-row-title">API Key</span>
            <span className="mm-row-sub">
              {value.hasKey ? `已配置：${value.maskedKey}` : '未配置（只存本机，不导出/不进日志）'}
            </span>
          </span>
          <input
            className="mm-input"
            type="password"
            aria-label="AI API Key"
            placeholder={value.hasKey ? '输入新 Key 以替换（留空不改）' : 'sk-…'}
            value={keyInput}
            onChange={(event) => setKeyInput(event.target.value)}
            disabled={saving}
            autoComplete="off"
          />
        </label>

        <div className="mm-row">
          <span className="mm-row-main">
            <span className="mm-row-title">JSON 模式</span>
            <span className="mm-row-sub">
              默认开；部分免费模型不支持 response_format 报错时可关闭（靠 prompt 约束输出）
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={value.jsonMode}
            aria-label="JSON 模式"
            className={`mm-switch${value.jsonMode ? ' is-on' : ''}`}
            onClick={() => onToggleJsonMode(!value.jsonMode)}
            disabled={saving}
          >
            <span className="mm-switch-thumb" />
          </button>
        </div>

        <div className="mm-row">
          <span className="mm-row-main">
            <span className="mm-row-title">Key 存储方式</span>
            <span className="mm-row-sub">
              persistent=存本机 DB；session=仅内存，刷新/重启失效
            </span>
          </span>
          <select
            className="mm-input"
            aria-label="Key 存储方式"
            value={value.keyStorage}
            onChange={(event) =>
              onChange({ keyStorage: event.target.value as 'persistent' | 'session' })
            }
            disabled={saving}
          >
            <option value="persistent">持久（本机）</option>
            <option value="session">本次会话</option>
          </select>
        </div>

        <div className="mm-btn-row">
          <button
            type="button"
            className="mm-btn mm-btn--primary"
            disabled={saving || keyInput.trim().length === 0}
            onClick={() => {
              onSaveKey(keyInput.trim())
              setKeyInput('')
            }}
          >
            保存 Key
          </button>
          <button
            type="button"
            className="mm-btn"
            disabled={saving || !value.hasKey}
            onClick={onClearKey}
          >
            清除 Key
          </button>
          <button
            type="button"
            className="mm-btn"
            disabled={testing || saving || !value.hasKey}
            onClick={onTestConnection}
          >
            {testing ? '测试中…' : '测试连接'}
          </button>
        </div>
        {testMessage ? <div className="mm-caption">{testMessage}</div> : null}

        <label className="mm-row">
          <span className="mm-row-main">
            <span className="mm-row-title">单次运行费用上限</span>
            <span className="mm-row-sub">元；0=不限制（默认 3）</span>
          </span>
          <input
            className="mm-input"
            type="number"
            min={0}
            max={1000}
            step={0.5}
            aria-label="单次运行费用上限"
            value={value.maxCostPerRun}
            onChange={(event) => onChange({ maxCostPerRun: Number(event.target.value) })}
            disabled={saving}
          />
        </label>

        <label className="mm-row">
          <span className="mm-row-main">
            <span className="mm-row-title">全量预生成预算</span>
            <span className="mm-row-sub">元；用于「今日/词库」批量预估，0=不限制</span>
          </span>
          <input
            className="mm-input"
            type="number"
            min={0}
            max={10000}
            step={1}
            aria-label="全量预生成预算"
            value={value.pregenBudget}
            onChange={(event) => onChange({ pregenBudget: Number(event.target.value) })}
            disabled={saving}
          />
        </label>
      </div>
      <div className="mm-caption">
        隐私：API Key 只保存在本机（或本次会话内存），<strong>不会导出/不上传/不写日志</strong>；
        生成内容只写入本地词库，可随时删除。费用以服务商账单为准，本页预估仅供参考。
      </div>
    </>
  )
}

function toFormValue(state: AiSettingsState): AiSettingsFormValue {
  const config = state.config
  return {
    enabled: state.enabled,
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    keyStorage: state.keyStorage,
    maskedKey: maskApiKey(config.apiKey),
    hasKey: config.apiKey.trim().length > 0,
    maxCostPerRun: config.maxCostPerRun,
    pregenBudget: state.pregenBudget,
    jsonMode: (config as { jsonMode?: boolean }).jsonMode ?? true,
  }
}

/** 容器：加载/保存 ai.* 设置；SettingsPage 内渲染 */
export function AiSettingsSection() {
  const toast = useToast()
  const [state, setState] = useState<AiSettingsState | null>(null)
  const [form, setForm] = useState<AiSettingsFormValue | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testMessage, setTestMessage] = useState<string | null>(null)

  const reload = async () => {
    const next = await loadAiSettings()
    setState(next)
    setForm(toFormValue(next))
  }

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!form || !state) {
    return <div className="mm-caption">正在加载 AI 设置…</div>
  }

  const savePatch = async (patch: Partial<AiConfig>, extra: { enabled?: boolean; pregenBudget?: number; keyStorage?: 'persistent' | 'session' } = {}) => {
    setSaving(true)
    try {
      await saveAiSettings({ config: patch, ...extra })
      await reload()
      toast.success('AI 设置已保存')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存 AI 设置失败')
    } finally {
      setSaving(false)
    }
  }

  const handleSaveKey = (key: string) => {
    void savePatch({ apiKey: key }, { keyStorage: form.keyStorage })
  }

  const handleClearKey = () => {
    void (async () => {
      setSaving(true)
      try {
        await clearAiApiKey()
        await reload()
        toast.success('已清除本机 Key')
      } finally {
        setSaving(false)
      }
    })()
  }

  const handleTest = () => {
    void (async () => {
      setTesting(true)
      setTestMessage(null)
      try {
        const current = state.config
        const provider = createLlmProvider()
        await provider.chat(
          { messages: [{ role: 'user', content: '这句话只用于连通性测试，请回答 ok。' }] },
          current,
          new AbortController().signal,
        )
        setTestMessage('连接成功：Key 与服务商可用。')
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code)
            : undefined
        setTestMessage(formatAiTestFailure(code, error instanceof Error ? error.message : undefined))
      } finally {
        setTesting(false)
      }
    })()
  }

  return (
    <AiSettingsForm
      value={form}
      onChange={(patch) => setForm((prev) => (prev ? { ...prev, ...patch } : prev))}
      onSaveKey={handleSaveKey}
      onClearKey={handleClearKey}
      onToggleEnabled={(enabled) => void savePatch({}, { enabled })}
      onToggleJsonMode={(enabled) =>
        void savePatch({ jsonMode: enabled } as Partial<AiConfig>)
      }
      onTestConnection={handleTest}
      testing={testing}
      testMessage={testMessage}
      saving={saving}
    />
  )
}

/** 默认 AI 配置（设置页首次/测试用） */
export const AI_DEFAULT_CONFIG_FALLBACK: AiConfig = DEFAULT_AI_CONFIG
