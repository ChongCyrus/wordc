/**
 * 首页学习按钮 6 态文案（SPEC-v2 §6.2；数据层事实 → 纯展示映射，便于单测）。
 *
 * 注：`HomeStateLike` 与 core 的 `HomeStudyState` 结构一致；等 core/index 导出
 * `HomeStudyState` 后可直接替换为 `import type { HomeStudyState }`，映射逻辑不变。
 */

export type HomeStateKind =
  | 'no-deck'
  | 'no-words'
  | 'fresh'
  | 'ongoing'
  | 'done-with-overdue'
  | 'done'

export type HomeStateLike =
  | { kind: 'no-deck' }
  | { kind: 'no-words' }
  | { kind: 'fresh'; pendingReview: number; pendingNew: number }
  | { kind: 'ongoing'; remaining: number; index: number; total: number }
  | { kind: 'done-with-overdue'; overdue: number }
  | { kind: 'done' }

/** 按钮点击后去的路由 */
export type HomeActionTarget = 'study' | 'decks' | 'stats'

export interface HomeActionView {
  title: string
  subtitle: string
  buttonLabel: string
  buttonKind: 'start' | 'continue' | 'done'
  target: HomeActionTarget
}

export function homeActionView(state: HomeStateLike): HomeActionView {
  switch (state.kind) {
    case 'no-deck':
      return {
        title: '今日任务',
        subtitle: '还没有词库，先去添加或导入一个词库',
        buttonLabel: '去添加词库',
        buttonKind: 'start',
        target: 'decks',
      }
    case 'no-words':
      return {
        title: '今日任务',
        subtitle: '词库里还没有单词，去添加或导入单词',
        buttonLabel: '去词库',
        buttonKind: 'start',
        target: 'decks',
      }
    case 'fresh':
      return {
        title: '今日任务',
        subtitle: `待复习 ${state.pendingReview} · 待新学 ${state.pendingNew}`,
        buttonLabel: '开始学习',
        buttonKind: 'start',
        target: 'study',
      }
    case 'ongoing':
      return {
        title: '今日任务',
        subtitle: `已学 ${state.index} / 共 ${state.total} · 还剩 ${state.remaining}`,
        buttonLabel: '继续学习',
        buttonKind: 'continue',
        target: 'study',
      }
    case 'done-with-overdue':
      return {
        title: '今日任务',
        subtitle: `今日已完成 · 还有 ${state.overdue} 个到期复习`,
        buttonLabel: `继续学习（还有 ${state.overdue} 个到期复习）`,
        buttonKind: 'continue',
        target: 'study',
      }
    case 'done':
      return {
        title: '今日任务',
        subtitle: '今日已完成，明天再来',
        buttonLabel: '查看今日',
        buttonKind: 'done',
        target: 'stats',
      }
  }
}
