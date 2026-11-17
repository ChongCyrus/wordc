import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ImportReport } from '../../core'
import {
  exportAllDerivationMaps,
  exportMigration,
  FULL_BACKUP_MAX_BYTES,
  importDerivationBundle,
  importMigration,
  parseDerivationBundle,
} from '../../data'
import { useStatsOverview } from '../../app/hooks/useStats'
import { useTheme } from '../../app/theme'
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
import { SectionBand, Card } from '../components/SectionBand'
import { ConfirmDialog } from '../components/Dialog'
import { SettingRow } from '../components/SettingRow'
import { OwlIcon } from '../components/icons'
import { BatchDerivationPanel } from './BatchDerivationPanel'

/**
 * 我的（SPEC §8.3 / 03-ui §4.7）：
 * 头像/词汇量/打卡 + 学习数据入口 + 数据管理 + 设置/关于 + 深色模式快捷开关。
 */
export default function MePage() {
  const navigate = useNavigate()
  const toast = useToast()
  const { resolved, setMode } = useTheme()
  const { overview } = useStatsOverview()
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [pendingForce, setPendingForce] = useState<string | null>(null)
  const [bundleExporting, setBundleExporting] = useState(false)
  const [bundleImporting, setBundleImporting] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)
  const [confirmCompleteExport, setConfirmCompleteExport] = useState(false)

  const darkMode = resolved === 'dark'

  const describeReport = (report: ImportReport): string => {
    if (report.ok) {
      return `导入完成：${report.counts.decks} 词库 / ${report.counts.words} 词 / ${report.counts.states} 条状态`
    }
    const issue = report.issues.find((item) => item.level === 'error')
    return issue ? `导入失败：${issue.message}` : '导入失败'
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
      const checksumIssue = report.issues.find((item) => item.code === 'E_CHECKSUM')
      if (checksumIssue && !force) {
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

  const handleExportMigration = async (complete = false) => {
    setExporting(true)
    try {
      const blob = await exportMigration(
        complete
          ? { includeDerivationMaps: true, includeContentPacks: true, maxBytes: FULL_BACKUP_MAX_BYTES }
          : undefined,
      )
      const result = await saveBlobFile(
        blob,
        datedFileName(
          `${BRAND.shortName}-${complete ? '完整备份' : '学习进度'}`,
          'migration.json',
        ),
        'application/json',
      )
      const info = saveResultMessage(result)
      if (info.ok)
        toast.success(
          `${info.message}（${complete ? '含引申图/内容包，' : ''}含记忆状态，不含 Token）`,
        )
      else toast.error(info.message)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  const handleExportDerivationBundle = async () => {
    setBundleExporting(true)
    try {
      const bundle = await exportAllDerivationMaps()
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
      const result = await saveBlobFile(
        blob,
        datedFileName(`${BRAND.shortName}-引申图`, 'derivation-bundle.json'),
        'application/json',
      )
      const info = saveResultMessage(result)
      if (info.ok) toast.success(`已导出 ${bundle.items?.length ?? 0} 条引申图`)
      else toast.error(info.message)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出引申图失败')
    } finally {
      setBundleExporting(false)
    }
  }

  const handlePickDerivationBundleImport = async () => {
    setBundleImporting(true)
    try {
      const file = await pickTextFile('.json,application/json')
      if (!file) return
      const text = await readFileAsText(file)
      const parsed = parseDerivationBundle(text)
      if (!parsed.ok) {
        toast.error(`引申图文件无效：${parsed.errors[0] ?? '格式错误'}`)
        return
      }
      const result = await importDerivationBundle(text, { mode: 'merge' })
      toast.success(
        `导入引申图：成功 ${result.imported} / 跳过 ${result.skipped} / 失败 ${result.failed}`,
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导入引申图失败')
    } finally {
      setBundleImporting(false)
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

  return (
    <PageShell title="我的" hero>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div className="mm-avatar">
            <OwlIcon size={40} />
          </div>
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            <div className="mm-row-title">学习者</div>
            <div className="mm-row-sub">
              词汇量 {overview?.totalLearned ?? 0} · 连续打卡 {overview?.streakDays ?? 0} 天
            </div>
          </div>
          <button
            type="button"
            className={`mm-switch${darkMode ? ' is-on' : ''}`}
            role="switch"
            aria-checked={darkMode}
            aria-label="深色模式"
            onClick={() => setMode(darkMode ? 'light' : 'dark')}
          >
            <span className="mm-switch-knob" />
          </button>
        </div>
      </Card>

      <SectionBand title="学习数据" />
      <div className="mm-list">
        <SettingRow
          label="学习统计"
          hint="连续打卡 / 学习量 / 不熟悉度"
          chevron
          onClick={() => navigate('/stats')}
        />
        <SettingRow
          label="今日概览"
          hint={`今日已学 ${overview?.todayReviewed ?? 0} 个 · 累计 ${overview?.totalLearned ?? 0} 个`}
          chevron
          onClick={() => navigate('/')}
        />
      </div>

      <SectionBand title="使用说明" />
      <Card>
        <details>
          <summary className="mm-row-title" style={{ cursor: 'pointer' }}>
            怎么练：推荐主流程（点开展开）
          </summary>
          <div className="mm-caption" style={{ lineHeight: 1.8, paddingTop: 8 }}>
            <p style={{ margin: '0 0 8px' }}>
              <strong>记忆 → 回忆 → 标记不认识的 → 加权记忆 → 回忆 → 标记不认识的 → 加权记忆 …</strong>
              循环，直到所有（主要）含义映射都能回忆起来。
            </p>
            <p
              className="mm-caption usage-guide-note"
              style={{
                display: 'block',
                margin: '0 0 8px',
                whiteSpace: 'normal',
                overflow: 'visible',
                overflowWrap: 'anywhere',
                wordBreak: 'break-word',
                WebkitLineClamp: 'unset',
                lineHeight: 1.7,
              }}
            >
              每次回忆时，建议从尽可能单个、最共性的本义出发，再按使用场景、作用对象、词性逐个引申出各个实际含义。记忆时同理：先找最共性的、底层的、尽可能统一的「生成元」（本义），再按场景/作用对象/词性引申得到各实际含义。
            </p>

            <p
              className="mm-caption usage-guide-note"
              style={{
                display: 'block', margin: '0 0 8px', whiteSpace: 'normal', overflow: 'visible',
                overflowWrap: 'anywhere', wordBreak: 'break-word', WebkitLineClamp: 'unset', lineHeight: 1.7,
              }}
            >
              平时，如果生成元忘记了，我们也可以通过先根据相关记忆、它的已知道的一些含义来回忆起其生成元，进而再通过生成元来引申、回忆其它各实际含义。
            </p>
            <p
              className="mm-caption usage-guide-note"
              style={{
                display: 'block', margin: '0 0 8px', whiteSpace: 'normal', overflow: 'visible',
                overflowWrap: 'anywhere', wordBreak: 'break-word', WebkitLineClamp: 'unset', lineHeight: 1.7,
              }}
            >
              推荐工作流：记忆单词到生成元的映射 → 理解生成元如何引申各个实际含义 → 代入生成元到各个含义的例句，看看是否可以理解各个含义的例句中该生成元的真实指代，找出那些不容易理解出真实指代的含义（记为 nc） → 记忆「通过生成元来得到各个实际含义（可只考虑那些 nc）」的关系网络（或者说使得可以仅通过生成元回忆起那些含义/nc）。
            </p>
            <p style={{ margin: '0 0 4px' }}>· 白板面：只看单词/词性/英文例句，先回忆中文含义。</p>
            <p style={{ margin: '0 0 4px' }}>· 注释面：看中文含义/例句/助记；点「记忆」练「单词→含义」，「加权记忆」对不熟悉的含义多练。</p>
            <p style={{ margin: '0 0 4px' }}>· 三键：认识 / 模糊 / 不认识；模糊/不认识会当天回炉。</p>
            <p style={{ margin: '0 0 4px' }}>· 今日单词：查看今天复习/新学分别学了哪些。</p>
            <p style={{ margin: '0 0 4px' }}>· 统计：看累计学习量、评分分布与不熟悉度最高的含义。</p>
            <p style={{ margin: 0 }}>· 设置：调学习量、记忆次数、加权记忆、新词顺序、字号/主题等。</p>
          </div>
        </details>
      </Card>

      <SectionBand title="原理" />
      <Card>
        <details>
          <summary className="mm-row-title" style={{ cursor: 'pointer' }}>
            原理（点开展开）
          </summary>
          <div className="mm-caption" style={{ lineHeight: 1.8, paddingTop: 8 }}>
            <p style={{ margin: '0 0 6px' }}>原理：</p>
            <ul
              className="principle-list"
              style={{ margin: '0 0 6px', paddingLeft: 20, listStyle: 'disc outside' }}
            >
              <li style={{ margin: '0 0 4px' }}>
                大多或很多情形下，通过把核心义/词源代入实际语境或例句中就可以自然地理解出它的具体指代含义。
              </li>
              <li style={{ margin: '0 0 4px' }}>
                可以很容易地通过核心义/词源来引申得到其各种实际含义。
              </li>
            </ul>
            <p style={{ margin: 0 }}>
              所以，一般只需记忆这个核心义/词源即可。而且，由于这个核心义/词源是各实际含义的共性，因此当忘记时也很容易通过所记住的几个实际含义来回忆起这个核心义/词源。
            </p>
          </div>
        </details>
      </Card>

      <SectionBand title="数据" />
      <div className="mm-list">
        <SettingRow label="词库管理" hint="新建 / 导入 / 导出 / 从墨墨导入" chevron onClick={() => navigate('/decks')} />
        <SettingRow
          label="从墨墨导入学习进度"
          hint="APK 内置直连；浏览器/PWA 需本机代理（详见弹层说明）"
          chevron
          onClick={() => navigate('/decks?maimemo=1')}
        />
        <SettingRow
          label="导出学习进度"
          hint="学习进度备份（不含引申图/内容包）；引申图/内容包可分别用对应导出"
          value={exporting ? '导出中…' : undefined}
          chevron
          onClick={() => void handleExportMigration(false)}
        />
        <SettingRow
          label="完整备份（含引申图/内容包，体积大）"
          hint="点击后确认；体积可能很大、导出较慢，建议存储充足时使用"
          value={exporting ? '导出中…' : undefined}
          chevron
          onClick={() => setConfirmCompleteExport(true)}
        />
        <SettingRow
          label="导入学习进度"
          hint={
            importing
              ? '正在导入…'
              : '兼容轻量/完整包；轻量包不会清空本机引申图/内容包'
          }
          chevron
          onClick={() => void handlePickMigrationImport()}
        />
        <SettingRow
          label="导出全部引申图"
          hint="当前所有已保存的生成元→含义引申图（bundle v1）"
          value={bundleExporting ? '导出中…' : undefined}
          chevron
          onClick={() => void handleExportDerivationBundle()}
        />
        <SettingRow
          label="导入引申图"
          hint={bundleImporting ? '正在导入…' : '默认 merge；缺失词跳过，不覆盖 nc/用户内容/进度'}
          chevron
          onClick={() => void handlePickDerivationBundleImport()}
        />
        <SettingRow
          label="批量生成引申图"
          hint="词库/今日要学选词；排除已生成；并发/进度/停止/失败重试（上限 200）"
          chevron
          onClick={() => setBatchOpen(true)}
        />
      </div>

      <ConfirmDialog
        open={confirmCompleteExport}
        title="完整备份？"
        body="完整备份包含全量引申图与内容包，体积可能很大；超过安全上限时会直接提示并取消（不会崩溃），请改用「导出学习进度 + 导出全部引申图 + 内容包导出」分项备份。"
        confirmLabel="仍要完整备份"
        onCancel={() => setConfirmCompleteExport(false)}
        onConfirm={() => {
          setConfirmCompleteExport(false)
          void handleExportMigration(true)
        }}
      />

      <BatchDerivationPanel open={batchOpen} onClose={() => setBatchOpen(false)} />

      <SectionBand title="其他" />
      <div className="mm-list">
        <SettingRow label="设置" chevron onClick={() => navigate('/me/settings')} />
        <SettingRow label="关于" hint="版本 / 算法说明 / 词库版权 / 开源许可" chevron onClick={() => navigate('/me/about')} />
      </div>

      <div className="mm-caption" style={{ textAlign: 'center', paddingTop: 24 }}>
        本地优先 · 数据只存本机 · v{APP_VERSION}
      </div>

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
