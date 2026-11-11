import { PageShell } from '../components/PageShell'
import { SectionBand, Card } from '../components/SectionBand'
import { BUILTIN_DECK_IDS } from '../../data'
import { BRAND, type BrandConfig } from '../../app/brand'
import { APP_VERSION } from '../../app/version'
import { OwlIcon } from '../components/icons'

/**
 * 关于页（SPEC §8.3 / D11 / D20 / D21 / D30 / task-57）：
 * 版本、算法说明（同源 MM/DHP，不承诺逐词一致）、词库版权声明、开源许可、隐私说明。
 * 第三方品牌说明（墨墨/受限商业词表）来自 BRAND 可选字段；公开版省略这些字段即不渲染。
 */
export interface AboutPageProps {
  brand?: BrandConfig
}

export default function AboutPage({ brand = BRAND }: AboutPageProps) {
  return (
    <PageShell title="关于" backTo="/me">
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <OwlIcon size={56} className="mm-owl" />
          <div>
            <div className="mm-row-title">{brand.name}</div>
            <div className="mm-row-sub">{brand.tagline ?? brand.description}</div>
            <div className="mm-caption">
              版本 v{APP_VERSION} · 本地优先 PWA
            </div>
          </div>
        </div>
        <div className="mm-caption">
          {brand.backgroundNote ??
            '一个本地优先的背单词 PWA：单词白板 → 注释 → w-c 记忆 → 认识/模糊/不认识。所有学习数据只保存在本机浏览器（IndexedDB），不上传服务器。'}
        </div>
      </Card>

      <SectionBand title="算法说明" />
      <Card>
        <div className="mm-row-title">同源 MM/DHP 调度模型</div>
        <div className="mm-row-sub" style={{ whiteSpace: 'normal', lineHeight: '24px' }}>
          记忆状态用「记忆半衰期 h + 难度 d」的遗忘曲线建模（p = 2^(-Δt/h)），
          按记忆保持率阈值推算下次复习间隔；认识/模糊/不认识三档反馈更新 h 与 d，
          并限制间隔 1–365 天。参数与公式参考公开资料近似实现。
        </div>
        <div className="mm-caption">
          说明：官方 App 的记忆持久度、难度与部分策略未公开，本应用不承诺与官方逐词数值一致；
          目标是「可解释、同源、可持续优化」。
        </div>
      </Card>

      <SectionBand title="词库与版权" />
      <Card>
        <div className="mm-row-title">内置词库</div>
        <div className="mm-row-sub" style={{ whiteSpace: 'normal', lineHeight: '24px' }}>
          {brand.deckNotice ??
            '内置词库数据来自公开资料；数据来源与许可见 FEATURES-COMPLIANCE / THIRD-PARTY-NOTICES。'}
        </div>
        <div className="mm-caption">
          内置词库 id：{BUILTIN_DECK_IDS.join('、')}
        </div>
        {brand.affiliationNotice ? (
          <div className="mm-caption">{brand.affiliationNotice}</div>
        ) : null}
      </Card>

      <SectionBand title="数据与隐私" />
      <Card>
        <div className="mm-row-sub" style={{ whiteSpace: 'normal', lineHeight: '24px' }}>
          {'词库、学习进度、设置全部只存在本机 IndexedDB，可随时导出迁移包备份。 ' +
            (brand.tokenNotice ??
              'API Token（如填写）也只存本机、不写日志、不进导出包；卸载/清除浏览器数据会一并删除，请定期导出备份。')}
        </div>
      </Card>

      <SectionBand title="开源许可" />
      <Card>
        <div className="mm-row-sub" style={{ whiteSpace: 'normal', lineHeight: '24px' }}>
          React · React Router · Dexie · Vite · vite-plugin-pwa · Tailwind CSS · TypeScript，
          各自遵循 MIT / Apache-2.0 / ISC 等上游许可证。
        </div>
        <div className="mm-caption">
          图标为内联 SVG（线性风格，24px/1.5 描边）；完成页猫头鹰为单色示意图，非官方素材。
        </div>
      </Card>
    </PageShell>
  )
}
