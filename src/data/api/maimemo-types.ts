/**
 * 墨墨导入通道的类型（SPEC §7 / task-8）。
 *
 * 隐私红线（D23/D29/D44）：
 * - 只用**用户自己的 Bearer Token**，绝不收集账号密码/验证码；
 * - Token 只从设置（仅本机 IndexedDB）或调用方传入，**不写日志、不进导出包、不入代码/测试/文档**；
 * - 拿不到的数据（记忆持久度/不熟悉度）按 SPEC §7.3 近似，不伪造官方数值。
 */

import type { ImportIssue } from '../../core'

/** 墨墨 StudyRecord（`POST /study/query_study_records` 的 records[]） */
export interface StudyRecord {
  voc_id?: string
  voc_spelling?: string
  add_date?: string | null
  first_study_date?: string | null
  last_study_date?: string | null
  next_study_date?: string | null
  last_response?: string | null
  study_count?: number | null
  tags?: string | string[] | null
  [key: string]: unknown
}

/** 墨墨错误分类（UI 按 code 给提示与降级按钮） */
export interface MaimemoError extends Error {
  code: MaimemoErrorCode
  /** HTTP 状态码（若有） */
  status?: number
  /** 服务端错误 code（如 common_unauthorized） */
  serverCode?: string
  /** 是否可重试（超时/限流/5xx） */
  retryable?: boolean
}

export type MaimemoErrorCode =
  | 'E_NO_TOKEN'
  | 'E_UNAUTHORIZED'
  | 'E_FORBIDDEN'
  | 'E_RATE_LIMITED'
  | 'E_TIMEOUT'
  | 'E_NETWORK'
  | 'E_CORS'
  | 'E_SERVER'
  | 'E_BAD_RESPONSE'
  | 'E_BAD_INPUT'
  | 'E_CANCELLED'
  | 'E_NOT_IMPLEMENTED'

/** 墨墨导入结果（SPEC §7.3：成功 N / 未匹配 M / 跳过 K） */
export interface MaimemoImportResult {
  ok: boolean
  /** 成功映射并写入的单词数（按 wordId 去重） */
  matched: number
  /** 未匹配到的拼写（最多列 100 个） */
  unmatched: string[]
  /** 未匹配总数（可能 > unmatched.length） */
  unmatchedCount: number
  /** 解析失败/脏数据跳过的记录数 */
  skipped: number
  /** 拉取到的记录总数 */
  totalRecords: number
  /** 导入通道调用次数（分页请求数；手动导入为 0） */
  pages: number
  /** 拉取策略：spellings = 按拼写批量（推荐）；window = 日期窗口兜底；手动导入 undefined */
  strategy?: 'spellings' | 'window'
  /** 已扫描词数（拼写策略 = 本地词库词数；window = 已接收记录数） */
  scanned?: number
  issues: ImportIssue[]
  durationMs: number
  importedAt: number
}

/** 会话（内存态；token 持久化在 settings，不在这里） */
export interface MaimemoSession {
  token: string
  proxyUrl: string
}

/** 导入/鉴权步骤的 UI 文案（dev-ui 直接取用，避免各页各写一套） */
export const MAIMEMO_MESSAGES: Record<
  MaimemoErrorCode,
  { title: string; hint: string; action?: string }
> = {
  E_NO_TOKEN: {
    title: '未配置墨墨 Token',
    hint: '墨墨 App →「我的」→「更多设置」→「实验功能」→「开放 API」→ 复制 Token，粘贴到设置页。Token 只存本机、不会上传。',
    action: '去设置页填写 Token',
  },
  E_UNAUTHORIZED: {
    title: 'Token 失效或错误',
    hint: '网页来源的 Token 约 7 天有效。请重新在墨墨 App 或开放平台获取后粘贴。',
    action: '重新粘贴 Token',
  },
  E_FORBIDDEN: {
    title: '没有权限访问学习数据',
    hint: '请在墨墨 App 中确认已开启「开放 API」与学习数据同步权限，再重试。',
    action: '重试',
  },
  E_RATE_LIMITED: {
    title: '请求太频繁',
    hint: '已自动退避重试。墨墨频控为 10 秒 20 次 / 60 秒 40 次 / 5 小时 2000 次，暂停一会儿再试即可。',
    action: '稍后重试',
  },
  E_TIMEOUT: {
    title: '请求超时',
    hint: '网络较慢或接口无响应，已重试。可稍后再试，或改用「手动粘贴 JSON」方式导入。',
    action: '重试 / 手动导入',
  },
  E_NETWORK: {
    title: '网络连接失败',
    hint: '浏览器无法直连墨墨 API（会被 CORS 拦截）。请在电脑上运行本地代理：node src/data/api/maimemo-proxy.mjs，然后在设置里把代理地址填为 http://127.0.0.1:8787。',
    action: '配置代理 / 手动导入',
  },
  E_CORS: {
    title: '浏览器跨域受限',
    hint: '墨墨开放 API 不允许浏览器直连。请用本地代理（node src/data/api/maimemo-proxy.mjs，默认 http://127.0.0.1:8787），或改用「手动粘贴 JSON」导入。',
    action: '配置代理 / 手动导入',
  },
  E_SERVER: {
    title: '墨墨服务暂时不可用',
    hint: '接口返回 5xx（学习数据接口为公测 beta，可能临时调整）。已自动重试；稍后再试，或先只导入本地词库。',
    action: '稍后重试',
  },
  E_BAD_RESPONSE: {
    title: '墨墨返回了无法识别的数据',
    hint: '接口格式可能已调整。可以尝试「手动粘贴 JSON」，或反馈给开发者。',
    action: '手动导入 / 反馈',
  },
  E_BAD_INPUT: {
    title: '导入数据格式不正确',
    hint: '请粘贴墨墨学习记录的 JSON 数组（或包含 records 数组的对象）。',
    action: '重新粘贴',
  },
  E_CANCELLED: {
    title: '导入已取消',
    hint: '本次墨墨导入已中断，已拉取到的记录不会写入（可重新发起导入，幂等）。',
    action: '重新导入',
  },
  E_NOT_IMPLEMENTED: {
    title: '功能未启用',
    hint: '该功能尚未启用，请升级到最新版本。',
  },
}

/** 手动 JSON 导入的说明文案（设置页展示） */
export const MANUAL_IMPORT_HINT =
  '从墨墨「开放 API 演示页」或你自己的导出中复制学习记录 JSON（形如 {"records":[{...}]} 或 [{...}]），粘贴到这里导入。' +
  '只读取 voc_spelling / 日期 / last_response / study_count / tags，不需要登录墨墨账号。'
