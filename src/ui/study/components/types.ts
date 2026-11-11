/**
 * 学习页展示层的纯数据类型（不依赖 core / data）。
 * 页面 hook（useStudySession）负责把 core/data 的类型映射成这里的 ViewModel，
 * 这样所有展示组件都可以脱离数据库单独测试/复用。
 */
import type { DerivationChainView } from './DerivationChain'

/** 一条中文含义 + 用户对该含义的点击/遇到计数 */
export interface MeaningView {
  /** 本义→引申链（task-77；无映射不渲染） */
  derivation?: DerivationChainView
  meaningId: string
  pos?: string
  cn: string
  /** 被点「标记不熟悉」的累计次数 */
  clicks: number
  /** 被遇到的累计次数 */
  encounters: number
  /** 不熟悉度 = clamp01(clicks/encounters)；encounters=0 时为 null（展示 “—”） */
  familiarity: number | null
}

export interface ExampleView {
  en: string
  cn?: string
}

export interface MnemonicView {
  type: string
  text: string
}

export interface PhraseView {
  en: string
  cn: string
}

/** 学习页顶部进度 */
export interface StudyProgress {
  /** 当前第几个词（1 起） */
  index: number
  /** 本次会话计划词数 */
  total: number
}

/**
 * 评分三键（认识/模糊/不认识）。
 * 与 core 的 Rating 一致（'familiar' | 'vague' | 'forgot'）；
 * 这里本地声明是为了让展示组件不依赖 core，可单独测试。
 */
export type Rating = 'familiar' | 'vague' | 'forgot'
