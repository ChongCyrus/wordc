import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ImportReport } from '../../core'
import { exportMigration, importMigration } from '../../data'
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

  const handleExportMigration = async () => {
    setExporting(true)
    try {
      const blob = await exportMigration()
      const result = await saveBlobFile(
        blob,
        datedFileName(`${BRAND.shortName}-学习进度`, 'migration.json'),
        'application/json',
      )
      const info = saveResultMessage(result)
      if (info.ok) toast.success(`${info.message}（含记忆状态，不含 Token）`)
      else toast.error(info.message)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出失败')
    } finally {
      setExporting(false)
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
            <p style={{ margin: '0 0 4px' }}>· 白板面：只看单词/词性/英文例句，先回忆中文含义。</p>
            <p style={{ margin: '0 0 4px' }}>· 注释面：看中文含义/例句/助记；点「记忆」练 w→c，「加权记忆」对不熟悉的 c 多练。</p>
            <p style={{ margin: '0 0 4px' }}>· 三键：认识 / 模糊 / 不认识；模糊/不认识会当天回炉。</p>
            <p style={{ margin: '0 0 4px' }}>· 今日单词：查看今天复习/新学分别学了哪些。</p>
            <p style={{ margin: '0 0 4px' }}>· 统计：看累计学习量、评分分布与不熟悉度最高的含义。</p>
            <p style={{ margin: 0 }}>· 设置：调学习量、记忆次数、加权记忆、新词顺序、字号/主题等。</p>
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
          hint="含词库 + 记忆状态 + 设置（可迁移到其他设备）"
          value={exporting ? '导出中…' : undefined}
          chevron
          onClick={() => void handleExportMigration()}
        />
        <SettingRow
          label="导入学习进度"
          hint={importing ? '正在导入…' : '选择 .migration.json 迁移包，默认合并（保留较新记录）'}
          chevron
          onClick={() => void handlePickMigrationImport()}
        />
      </div>

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
