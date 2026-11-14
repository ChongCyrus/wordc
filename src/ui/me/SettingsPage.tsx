import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ImportReport, SettingsMap } from '../../core'
import {
  clearAllData,
  isNativeHttpAvailable,
  ensureBuiltinDecks,
  exportMigration,
  importMigration,
  SETTINGS_DEFAULTS,
} from '../../data'
import { useDecks } from '../../app/hooks/useDecks'
import {
  hasOfficialSetting,
  OFFICIAL_SETTING_META,
  patchOfficialBool,
  readOfficialBool,
} from '../../app/hooks/officialSettings'
import { parseDailyGoalInput } from './daily-goal'
import { applyDailyGoalChange } from '../../app/hooks/useDailyGoal'
import {
  hasNewWordOrderSetting,
  readNewWordOrder,
  saveNewWordOrder,
} from '../../app/hooks/newWordOrder'
import { NewWordOrderSetting } from './NewWordOrderSetting'
import { AiSettingsSection } from './AiSettingsSection'
import {
  DERIVATION_MARKDOWN_KEY,
  hasDerivationMarkdownSetting,
  readDerivationMarkdown,
} from '../study/lib/derivation-markdown'
import {
  BOARD_SHOW_MEANING_PHRASES_KEY,
  hasBoardShowMeaningPhrasesSetting,
  readBoardShowMeaningPhrases,
} from '../../app/hooks/boardPhrases'
import { ContentPackImportSection } from './ContentPackImportSection'
import { ContentPackManagerSection } from './ContentPackManagerSection'
import {
  DAILY_REVIEW_CAP_PRESETS,
  dailyReviewCapLabel,
  hasDailyReviewCapSetting,
  parseDailyReviewCapInput,
  readDailyReviewCap,
  saveDailyReviewCap,
} from '../../app/hooks/dailyReviewCap'
import { useSettings } from '../../app/hooks/useSettings'
import { useToast } from '../../app/toast'
import {
  datedFileName,
  pickTextFile,
  readFileAsText,
  saveBlobFile,
  saveResultMessage,
} from '../../app/utils/files'
import { APP_VERSION } from '../../app/version'
import { BRAND } from '../../app/brand'
import { PageShell } from '../components/PageShell'
import { SectionBand } from '../components/SectionBand'
import { SettingRow } from '../components/SettingRow'
import { Switch } from '../components/Switch'
import { Stepper, Slider } from '../components/Stepper'
import { SegmentedControl } from '../components/SegmentedControl'
import { Dialog, ConfirmDialog } from '../components/Dialog'

type ThemeValue = SettingsMap['app.theme']

function describeReport(report: ImportReport): string {
  if (report.ok) {
    return `导入完成：${report.counts.decks} 词库 / ${report.counts.words} 词 / ${report.counts.states} 条状态`
  }
  const issue = report.issues.find((item) => item.level === 'error')
  return issue ? `导入失败：${issue.message}` : '导入失败'
}

/**
 * 设置页（SPEC §5 的 16 个 key 全部可调 + 实时生效，AC4）。
 * - Switch/分段/Stepper 点击即写；Slider 松手写；输入类失焦保存。
 * - 主题只需写 settings（app.theme），ThemeProvider 通过 useLiveQuery 立即应用。
 */
export default function SettingsPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const { settings, update, loading } = useSettings()
  const { decks } = useDecks()

  const [dailyGoalOpen, setDailyGoalOpen] = useState(false)
  const [dailyGoalInput, setDailyGoalInput] = useState('30')
  const [dailyGoalError, setDailyGoalError] = useState<string | null>(null)
  const [reviewCapOpen, setReviewCapOpen] = useState(false)
  const [reviewCapMode, setReviewCapMode] = useState<string>('0')
  const [reviewCapInput, setReviewCapInput] = useState('0')
  const [reviewCapError, setReviewCapError] = useState<string | null>(null)
  const [exampleOpen, setExampleOpen] = useState(false)
  const [tokenOpen, setTokenOpen] = useState(false)
  const [tokenDraft, setTokenDraft] = useState('')
  const [proxyOpen, setProxyOpen] = useState(false)
  const [proxyDraft, setProxyDraft] = useState('')
  const [importing, setImporting] = useState(false)
  const [pendingForce, setPendingForce] = useState<string | null>(null)
  const [clearStep, setClearStep] = useState<0 | 1 | 2>(0)
  const [clearing, setClearing] = useState(false)

  const s = settings ?? SETTINGS_DEFAULTS
  const selectedDeck = decks.find((deck) => deck.id === s['data.selectedDeckId'])

  const patch = async (next: Partial<SettingsMap>) => {
    try {
      await update(next)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存设置失败')
    }
  }

  const handleExportMigration = async () => {
    try {
      const blob = await exportMigration()
      const result = await saveBlobFile(
        blob,
        datedFileName(`${BRAND.shortName}-学习进度`, 'migration.json'),
        'application/json',
      )
      const info = saveResultMessage(result)
      if (info.ok) toast.success(`${info.message}（不含 Token）`)
      else toast.error(info.message)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出失败')
    }
  }

  const handlePickMigrationImport = async () => {
    try {
      const file = await pickTextFile('.json,application/json')
      if (!file) return
      const text = await readFileAsText(file)
      await handleImportMigration(text)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取文件失败')
    }
  }

  const handleImportMigration = async (text: string, force = false) => {
    setImporting(true)
    try {
      const report = await importMigration(text, { strategy: 'merge', ...(force ? { force: true } : {}) })
      if (report.ok) {
        setPendingForce(null)
        toast.success(describeReport(report))
        return
      }
      if (report.issues.some((issue) => issue.code === 'E_CHECKSUM') && !force) {
        setPendingForce(text)
        return
      }
      toast.error(describeReport(report))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导入失败')
    } finally {
      setImporting(false)
    }
  }

  const handleClearAll = async () => {
    setClearing(true)
    try {
      await clearAllData({ keepToken: false })
      await ensureBuiltinDecks()
      setClearStep(0)
      toast.success('已清空全部数据，内置词库已恢复')
      navigate('/')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '清空失败')
    } finally {
      setClearing(false)
    }
  }

  if (loading) {
    return (
      <PageShell title="设置" backTo="/me">
        <div className="mm-loading">正在加载设置…</div>
      </PageShell>
    )
  }

  return (
    <PageShell title="设置" backTo="/me">
      <SectionBand title="学习设置" />
      <div className="mm-list">
        <SettingRow
          label="每日学习量"
          hint="复习 + 新学，单位=单词数（1–9999，官方可设 9999）"
          value={`${s['study.dailyGoal']} 词`}
          chevron
          onClick={() => {
            setDailyGoalInput(String(s['study.dailyGoal']))
            setDailyGoalError(null)
            setDailyGoalOpen(true)
          }}
        />
        {hasDailyReviewCapSetting(s) ? (
          <SettingRow
            label="每日复习上限"
            hint="0 = 不限（默认）；超出上限的到期复习顺延到之后（不丢失）"
            value={dailyReviewCapLabel(readDailyReviewCap(s))}
            chevron
            onClick={() => {
              const current = readDailyReviewCap(s)
              const presetMatched = DAILY_REVIEW_CAP_PRESETS.includes(current)
              setReviewCapMode(presetMatched ? String(current) : 'custom')
              setReviewCapInput(String(current))
              setReviewCapError(null)
              setReviewCapOpen(true)
            }}
          />
        ) : null}
        {hasNewWordOrderSetting(s) ? (
          <NewWordOrderSetting
            value={readNewWordOrder(s)}
            onChange={(value) => {
              void saveNewWordOrder(value).catch((error: unknown) =>
                toast.error(error instanceof Error ? error.message : '保存新词顺序失败'),
              )
            }}
          />
        ) : null}
        {hasOfficialSetting(s, 'study.labelSwitch') ? (
          <SettingRow
            label={OFFICIAL_SETTING_META['study.labelSwitch'].label}
            hint={OFFICIAL_SETTING_META['study.labelSwitch'].hint}
            control={
              <Switch
                label={OFFICIAL_SETTING_META['study.labelSwitch'].label}
                checked={readOfficialBool(s, 'study.labelSwitch')}
                onChange={(checked) => {
                  void update(patchOfficialBool('study.labelSwitch', checked)).catch(
                    (error: unknown) =>
                      toast.error(error instanceof Error ? error.message : '保存设置失败'),
                  )
                }}
              />
            }
          />
        ) : null}
        <SettingRow
          label="记忆方向"
          hint="v1 固定：看英文回忆中文"
          value={<span className="mm-badge mm-badge--muted">英 → 中</span>}
        />
        <SettingRow
          label="白板面例句数量"
          hint="0–3 条英文例句（无中文）"
          value={`${s['board.exampleCount']} 条`}
          chevron
          onClick={() => setExampleOpen(true)}
        />
        <SettingRow
          label="白板面显示音标"
          hint="无音标数据时自动隐藏"
          control={
            <Switch
              label="白板面显示音标"
              checked={s['board.showPhonetic']}
              onChange={(checked) => void patch({ 'board.showPhonetic': checked })}
            />
          }
        />
        {hasBoardShowMeaningPhrasesSetting(s) ? (
          <SettingRow
            label="白板面显示各 c 词组"
            hint="默认关；开启后每个含义下显示对应英文词组（不显示中文）"
            control={
              <Switch
                label="白板面显示各 c 词组"
                checked={readBoardShowMeaningPhrases(s)}
                onChange={(checked) =>
                  void patch({
                    [BOARD_SHOW_MEANING_PHRASES_KEY]: checked,
                  } as unknown as Partial<SettingsMap>)
                }
              />
            }
          />
        ) : null}
      </div>

      <SectionBand title="记忆设置" />
      <div className="mm-list">
        <SettingRow
          label="记忆总次数"
          hint="每个中文含义记忆几次（1–10）"
          control={
            <Stepper
              ariaLabel="记忆总次数"
              value={s['memory.totalRepeats']}
              min={1}
              max={10}
              onChange={(value) => void patch({ 'memory.totalRepeats': value })}
            />
          }
        />
        <SettingRow
          label="加权记忆最少次数"
          hint="加权记忆每个 c 至少练几次（1–10）"
          control={
            <Stepper
              ariaLabel="加权记忆最少次数"
              value={s['memory.weightedMin']}
              min={1}
              max={10}
              onChange={(value) => {
                const maxValue = Math.max(value, s['memory.weightedMax'])
                void patch({ 'memory.weightedMin': value, ...(maxValue !== s['memory.weightedMax'] ? { 'memory.weightedMax': maxValue } : {}) })
              }}
            />
          }
        />
        <SettingRow
          label="加权记忆最多次数"
          hint="加权记忆每个 c 最多练几次（1–20，≥最少次数）"
          control={
            <Stepper
              ariaLabel="加权记忆最多次数"
              value={Math.max(s['memory.weightedMax'], s['memory.weightedMin'])}
              min={Math.max(1, s['memory.weightedMin'])}
              max={20}
              onChange={(value) => void patch({ 'memory.weightedMax': Math.max(value, s['memory.weightedMin']) })}
            />
          }
        />
        <SettingRow
          label="加权强度"
          hint="不熟悉度放大倍数 k（0–2，默认 1；0=不放大）"
          control={
            <Stepper
              ariaLabel="加权强度"
              value={s['memory.weightedK']}
              min={0}
              max={2}
              step={0.1}
              onChange={(value) => void patch({ 'memory.weightedK': Math.round(value * 10) / 10 })}
            />
          }
        />
        <SettingRow
          label="记忆模式"
          hint="默认按顺序；随机从未满含义中挑"
          control={
            <SegmentedControl<'sequential' | 'random'>
              ariaLabel="记忆模式"
              value={s['memory.mode']}
              onChange={(value) => void patch({ 'memory.mode': value })}
              options={[
                { value: 'sequential', label: '默认' },
                { value: 'random', label: '随机' },
              ]}
            />
          }
        />
        <SettingRow
          label="显示词组及翻译"
          hint="w-c 页显示含单词/含义的词组（无数据时隐藏）"
          control={
            <Switch
              label="显示词组及翻译"
              checked={s['memory.showPhrases']}
              onChange={(checked) => void patch({ 'memory.showPhrases': checked })}
            />
          }
        />
        {hasOfficialSetting(s, 'memory.showPredictedInterval') ? (
          <SettingRow
            label={OFFICIAL_SETTING_META['memory.showPredictedInterval'].label}
            hint={OFFICIAL_SETTING_META['memory.showPredictedInterval'].hint}
            control={
              <Switch
                label={OFFICIAL_SETTING_META['memory.showPredictedInterval'].label}
                checked={readOfficialBool(s, 'memory.showPredictedInterval')}
                onChange={(checked) => {
                  void update(patchOfficialBool('memory.showPredictedInterval', checked)).catch(
                    (error: unknown) =>
                      toast.error(error instanceof Error ? error.message : '保存设置失败'),
                  )
                }}
              />
            }
          />
        ) : null}
        {hasOfficialSetting(s, 'study.allowVagueComplete') ? (
          <SettingRow
            label={OFFICIAL_SETTING_META['study.allowVagueComplete'].label}
            hint={OFFICIAL_SETTING_META['study.allowVagueComplete'].hint}
            control={
              <Switch
                label={OFFICIAL_SETTING_META['study.allowVagueComplete'].label}
                checked={readOfficialBool(s, 'study.allowVagueComplete')}
                onChange={(checked) => {
                  void update(patchOfficialBool('study.allowVagueComplete', checked)).catch(
                    (error: unknown) =>
                      toast.error(error instanceof Error ? error.message : '保存设置失败'),
                  )
                }}
              />
            }
          />
        ) : null}
        <SettingRow
          label="w-c 页字号"
          hint={`当前 ×${s['memory.fontScale'].toFixed(2)}（0.8–1.6）`}
          control={
            <Slider
              ariaLabel="w-c 页字号"
              value={s['memory.fontScale']}
              min={0.8}
              max={1.6}
              step={0.05}
              onChange={(value) => void patch({ 'memory.fontScale': value })}
            />
          }
        />
        <SettingRow
          label="w-c 页卡片大小"
          hint={`当前 ×${s['memory.cardSize'].toFixed(2)}（0.8–1.4）`}
          control={
            <Slider
              ariaLabel="w-c 页卡片大小"
              value={s['memory.cardSize']}
              min={0.8}
              max={1.4}
              step={0.05}
              onChange={(value) => void patch({ 'memory.cardSize': value })}
            />
          }
        />
      </div>

      <SectionBand title="外观" />
      <div className="mm-list">
        <SettingRow
          label="全局字号"
          hint={`当前 ×${s['app.fontScale'].toFixed(2)}（0.9–1.2）`}
          control={
            <Slider
              ariaLabel="全局字号"
              value={s['app.fontScale']}
              min={0.9}
              max={1.2}
              step={0.05}
              onChange={(value) => void patch({ 'app.fontScale': value })}
            />
          }
        />
        <SettingRow
          label="主题"
          control={
            <SegmentedControl<ThemeValue>
              ariaLabel="主题"
              value={s['app.theme']}
              onChange={(value) => void patch({ 'app.theme': value })}
              options={[
                { value: 'system', label: '跟随系统' },
                { value: 'light', label: '浅色' },
                { value: 'dark', label: '深色' },
              ]}
            />
          }
        />
        <SettingRow
          label="减少动效"
          hint="所有动画时长 1ms（同时尊重系统「减少动态效果」）"
          control={
            <Switch
              label="减少动效"
              checked={s['app.reduceMotion']}
              onChange={(checked) => void patch({ 'app.reduceMotion': checked })}
            />
          }
        />
        {hasDerivationMarkdownSetting(s) ? (
          <SettingRow
            label="右页文字 Markdown 渲染"
            hint="默认开；支持标题/加粗/斜体/行内代码/列表，不渲染 HTML"
            control={
              <Switch
                label="右页文字 Markdown 渲染"
                checked={readDerivationMarkdown(s)}
                onChange={(checked) =>
                  void patch({
                    [DERIVATION_MARKDOWN_KEY]: checked,
                  } as unknown as Partial<SettingsMap>)
                }
              />
            }
          />
        ) : null}
      </div>

      <SectionBand title="内容包" />
      <ContentPackImportSection />
      <ContentPackManagerSection />

      <SectionBand title="AI 扩充（可选）" />
      <AiSettingsSection />

      <SectionBand title="数据" />
      <div className="mm-list">
        <SettingRow
          label="当前在学词库"
          hint={selectedDeck ? `${selectedDeck.wordCount} 词` : '未选择'}
          value={selectedDeck?.name ?? '去选择'}
          chevron
          onClick={() => navigate('/decks')}
        />
        <SettingRow
          label="墨墨 API Token"
          hint="只存本机，不写日志、不进导出包；7 天有效"
          value={s['data.maimemoToken'] ? '已设置' : '未设置'}
          chevron
          onClick={() => {
            setTokenDraft(s['data.maimemoToken'])
            setTokenOpen(true)
          }}
        />
        {isNativeHttpAvailable() ? (
          <SettingRow
            label="墨墨代理地址"
            hint="APK 内置直连，无需代理（原值保留，切回浏览器/PWA 仍可用）"
            value="内置直连"
          />
        ) : (
          <SettingRow
            label="墨墨代理地址"
            hint="本地小代理，绕过浏览器 CORS"
            value={s['data.proxyUrl'] || '未设置'}
            chevron
            onClick={() => {
              setProxyDraft(s['data.proxyUrl'])
              setProxyOpen(true)
            }}
          />
        )}
        <SettingRow
          label="导出学习进度"
          hint="含词库 + 记忆状态 + 设置（迁移/备份）"
          chevron
          onClick={() => void handleExportMigration()}
        />
        <SettingRow
          label="导入学习进度"
          hint={importing ? '正在导入…' : '选择 .migration.json，默认合并'}
          chevron
          onClick={() => void handlePickMigrationImport()}
        />
        <SettingRow
          label="清空全部数据"
          hint="删除全部学习记录与词库，无法恢复"
          danger
          chevron
          onClick={() => setClearStep(1)}
        />
      </div>
      <SectionBand title="关于" />
      <div className="mm-list">
        <SettingRow label="版本" value={`v${APP_VERSION}`} />
        <SettingRow label="关于 / 版权 / 许可" chevron onClick={() => navigate('/me/about')} />
      </div>

      {/* 每日学习量 */}
      <Dialog
        open={dailyGoalOpen}
        title="每日学习量"
        onClose={() => setDailyGoalOpen(false)}
        actions={
          <>
            <button type="button" className="mm-btn" onClick={() => setDailyGoalOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="mm-btn mm-btn--primary"
              onClick={() => {
                const parsed = parseDailyGoalInput(dailyGoalInput)
                if (!parsed.ok || parsed.value == null) {
                  setDailyGoalError(parsed.message ?? '输入不合法')
                  return
                }
                setDailyGoalError(null)
                setDailyGoalOpen(false)
                void applyDailyGoalChange(parsed.value)
                  .then((outcome) => {
                    if (!outcome.ok) toast.error(outcome.message)
                    else toast.success(outcome.message)
                  })
                  .catch((error: unknown) =>
                    toast.error(error instanceof Error ? error.message : '保存失败'),
                  )
              }}
            >
              保存
            </button>
          </>
        }
      >
        <label className="mm-field">
          <span className="mm-field-label">复习 + 新学合计（1–9999 词）</span>
          <input
            className="mm-input"
            type="number"
            inputMode="numeric"
            min={1}
            max={9999}
            step={1}
            value={dailyGoalInput}
            aria-label="每日学习量"
            onChange={(event) => {
              setDailyGoalInput(event.target.value)
              setDailyGoalError(null)
            }}
            autoFocus
          />
        </label>
        {dailyGoalError ? (
          <span className="mm-caption mm-danger-text">{dailyGoalError}</span>
        ) : (
          <span className="mm-caption">输入 1–9999 的整数；官方实测最大 9999。</span>
        )}
      </Dialog>

      {/* 每日复习上限 */}
      <Dialog
        open={reviewCapOpen}
        title="每日复习上限"
        onClose={() => setReviewCapOpen(false)}
        actions={
          <>
            <button type="button" className="mm-btn" onClick={() => setReviewCapOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="mm-btn mm-btn--primary"
              onClick={() => {
                const target =
                  reviewCapMode === 'custom'
                    ? parseDailyReviewCapInput(reviewCapInput)
                    : { ok: true as const, value: Number(reviewCapMode) }
                if (!target.ok || target.value == null) {
                  setReviewCapError(target.message ?? '输入不合法')
                  return
                }
                setReviewCapError(null)
                setReviewCapOpen(false)
                void saveDailyReviewCap(target.value)
                  .then(() => toast.success(`每日复习上限已更新为 ${dailyReviewCapLabel(target.value!)}`))
                  .catch((error: unknown) =>
                    toast.error(error instanceof Error ? error.message : '保存失败'),
                  )
              }}
            >
              保存
            </button>
          </>
        }
      >
        <div className="mm-row-sub">超出上限的到期复习不会丢失，会顺延到之后复习。</div>
        <SegmentedControl<'0' | '50' | '100' | '200' | 'custom'>
          block
          ariaLabel="每日复习上限"
          value={reviewCapMode as '0' | '50' | '100' | '200' | 'custom'}
          onChange={(value) => {
            setReviewCapMode(value)
            setReviewCapError(null)
            if (value !== 'custom') setReviewCapInput(value)
          }}
          options={[
            { value: '0', label: '不限' },
            { value: '50', label: '50' },
            { value: '100', label: '100' },
            { value: '200', label: '200' },
            { value: 'custom', label: '自定义' },
          ]}
        />
        {reviewCapMode === 'custom' ? (
          <label className="mm-field">
            <span className="mm-field-label">自定义上限（0 = 不限，最大 9999）</span>
            <input
              className="mm-input"
              type="number"
              inputMode="numeric"
              min={0}
              max={9999}
              step={1}
              value={reviewCapInput}
              onChange={(event) => {
                setReviewCapInput(event.target.value)
                setReviewCapError(null)
              }}
            />
          </label>
        ) : null}
        {reviewCapError ? (
          <span className="mm-caption mm-danger-text">{reviewCapError}</span>
        ) : (
          <span className="mm-caption">
            0 = 不限；今日新学预算 = 学习量 − 今日入队复习数。
          </span>
        )}
      </Dialog>

      {/* 白板面例句数量 */}
      <Dialog
        open={exampleOpen}
        title="白板面例句数量"
        onClose={() => setExampleOpen(false)}
        actions={
          <button type="button" className="mm-btn mm-btn--primary" onClick={() => setExampleOpen(false)}>
            完成
          </button>
        }
      >
        <SegmentedControl<'0' | '1' | '2' | '3'>
          block
          ariaLabel="白板面例句数量"
          value={String(s['board.exampleCount']) as '0' | '1' | '2' | '3'}
          onChange={(value) => void patch({ 'board.exampleCount': Number(value) })}
          options={[
            { value: '0', label: '0 条' },
            { value: '1', label: '1 条' },
            { value: '2', label: '2 条' },
            { value: '3', label: '3 条' },
          ]}
        />
      </Dialog>

      {/* 墨墨 Token */}
      <Dialog
        open={tokenOpen}
        title="墨墨 API Token"
        onClose={() => setTokenOpen(false)}
        actions={
          <>
            <button type="button" className="mm-btn" onClick={() => setTokenOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="mm-btn mm-btn--primary"
              onClick={() => {
                void patch({ 'data.maimemoToken': tokenDraft.trim().slice(0, 2048) })
                setTokenOpen(false)
              }}
            >
              保存
            </button>
          </>
        }
      >
        <label className="mm-field">
          <span className="mm-field-label">Token（仅本机保存，不会上传）</span>
          <input
            className="mm-input"
            type="password"
            value={tokenDraft}
            placeholder="墨墨App → 我的 → 更多设置 → 实验功能 → 开放 API"
            onChange={(event) => setTokenDraft(event.target.value)}
            autoFocus
          />
        </label>
      </Dialog>

      {/* 代理地址 */}
      <Dialog
        open={proxyOpen}
        title="墨墨本地代理地址"
        onClose={() => setProxyOpen(false)}
        actions={
          <>
            <button type="button" className="mm-btn" onClick={() => setProxyOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="mm-btn mm-btn--primary"
              onClick={() => {
                void patch({ 'data.proxyUrl': proxyDraft.trim() })
                setProxyOpen(false)
              }}
            >
              保存
            </button>
          </>
        }
      >
        <label className="mm-field">
          <span className="mm-field-label">代理 URL（空 = 不使用代理）</span>
          <input
            className="mm-input"
            value={proxyDraft}
            placeholder="http://127.0.0.1:8787"
            onChange={(event) => setProxyDraft(event.target.value)}
            autoFocus
          />
        </label>
      </Dialog>

      <ConfirmDialog
        open={clearStep === 1}
        title="清空全部数据？"
        body="清空后将删除全部学习记录与词库，无法恢复。建议先导出学习进度备份。"
        confirmLabel="继续"
        danger
        onCancel={() => setClearStep(0)}
        onConfirm={() => setClearStep(2)}
      />
      <ConfirmDialog
        open={clearStep === 2}
        title="最后确认"
        body="此操作不可恢复。确定清空全部数据吗？"
        confirmLabel="清空"
        cancelLabel="取消"
        danger
        busy={clearing}
        onCancel={() => setClearStep(0)}
        onConfirm={() => void handleClearAll()}
      />
      <ConfirmDialog
        open={pendingForce != null}
        title="校验和不一致"
        body="迁移包可能被修改或损坏。仍要导入吗？（可能产生重复词条，建议先备份）"
        confirmLabel="仍要导入"
        danger
        busy={importing}
        onCancel={() => setPendingForce(null)}
        onConfirm={() => {
          if (pendingForce) void handleImportMigration(pendingForce, true)
        }}
      />
    </PageShell>
  )
}
