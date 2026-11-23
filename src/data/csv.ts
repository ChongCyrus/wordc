/**
 * CSV 规范（SPEC §6.3）：
 *
 * ```csv
 * headword,pos,meaning,example,exampleTranslation,phoneticUK,phoneticUS,tags
 * abandon,vt.,放弃；抛弃,He abandoned the plan.,他放弃了计划,,[əˈbændən],我的词
 * ```
 *
 * - UTF-8（可带 BOM，读取时剥掉）；英文逗号分隔；字段按 RFC4180 转义（含逗号/引号/换行加引号）。
 * - 第一行必须是表头（列名大小写不敏感；`headword` 必填，其它列可缺）。
 * - `meaning` 用中文分号 `；`（也兼容 `;`）分隔 → 每条一个 Meaning；`pos` 对全部生效。
 * - 同 headword 多行 → 合并 meanings（按 cn 去重）。
 * - 错误带行号（1 起，表头为第 1 行）。
 */

import { makeIssue } from './schema'
import type { ImportIssue } from '../core'
import type { RawMeaningInput, RawWordInput } from './word-factory'

export interface CsvRow {
  /** 该行在文件中的起始行号（1 起） */
  line: number
  values: string[]
}

export interface CsvParseResult {
  header: string[]
  rows: CsvRow[]
  issues: ImportIssue[]
}

/** RFC4180 解析（支持引号内逗号/换行/双引号转义；CRLF 兼容） */
export function parseCsv(text: string): CsvParseResult {
  const source = text.replace(/^\uFEFF/, '')
  const issues: ImportIssue[] = []
  const records: CsvRow[] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false
  let line = 1
  let recordStartLine = 1
  let recordHasContent = false

  const pushField = () => {
    record.push(field)
    field = ''
  }
  const pushRecord = () => {
    if (recordHasContent || record.length > 1 || (record[0] ?? '') !== '') {
      records.push({ line: recordStartLine, values: record })
    }
    record = []
    recordHasContent = false
  }

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
        if (char === '\n') line += 1
      }
      continue
    }
    if (char === '"') {
      inQuotes = true
      recordHasContent = true
    } else if (char === ',') {
      pushField()
      recordHasContent = true
    } else if (char === '\r') {
      // 忽略 CR（CRLF）
    } else if (char === '\n') {
      pushField()
      pushRecord()
      line += 1
      recordStartLine = line
    } else {
      field += char
      recordHasContent = true
    }
  }
  // 文件末尾没有换行
  if (field !== '' || record.length > 0 || recordHasContent) {
    pushField()
    pushRecord()
  }

  if (inQuotes) {
    issues.push(makeIssue('error', 'E_FIELD', 'CSV 引号未闭合', { row: recordStartLine }))
  }
  if (records.length === 0) {
    return { header: [], rows: [], issues: [...issues, makeIssue('error', 'E_FORMAT', 'CSV 文件为空')] }
  }
  const header = records[0]!.values.map((value) => value.trim().toLowerCase())
  if (!header.includes('headword')) {
    issues.push(
      makeIssue('error', 'E_FIELD', 'CSV 表头缺少必填列 headword', { row: 1, field: 'headword' }),
    )
  }
  const rows = records.slice(1).filter((row) => row.values.some((value) => value.trim() !== ''))
  return { header, rows, issues }
}

/** 支持的列（小写） */
const COLUMN_ALIASES: Record<string, string> = {
  headword: 'headword',
  word: 'headword',
  term: 'headword',
  单词: 'headword',
  pos: 'pos',
  词性: 'pos',
  meaning: 'meaning',
  translation: 'meaning',
  释义: 'meaning',
  example: 'example',
  例句: 'example',
  exampletranslation: 'exampleTranslation',
  例句翻译: 'exampleTranslation',
  phoneticuk: 'phoneticUK',
  'phonetic-uk': 'phoneticUK',
  英式音标: 'phoneticUK',
  phoneticus: 'phoneticUS',
  'phonetic-us': 'phoneticUS',
  美式音标: 'phoneticUS',
  tags: 'tags',
  标签: 'tags',
}

function splitMulti(value: string, pattern: RegExp): string[] {
  return value
    .split(pattern)
    .map((item) => item.trim())
    .filter(Boolean)
}

export interface CsvToWordsResult {
  words: RawWordInput[]
  issues: ImportIssue[]
}

/** CSV 行 → 词条原始输入（同 headword 多行合并） */
export function csvToWordInputs(parsed: CsvParseResult): CsvToWordsResult {
  const issues: ImportIssue[] = [...parsed.issues]
  if (parsed.header.length === 0) return { words: [], issues }
  const columns = new Map<string, number>()
  parsed.header.forEach((name, index) => {
    const mapped = COLUMN_ALIASES[name]
    if (mapped && !columns.has(mapped)) columns.set(mapped, index)
  })
  const cell = (row: CsvRow, name: string): string => {
    const idx = columns.get(name)
    if (idx == null) return ''
    return (row.values[idx] ?? '').trim()
  }

  const byHeadword = new Map<string, RawWordInput>()
  const order: string[] = []
  for (const row of parsed.rows) {
    const headword = cell(row, 'headword')
    if (!headword) {
      issues.push(
        makeIssue('error', 'E_FIELD', `第 ${row.line} 行缺少 headword`, {
          row: row.line,
          field: 'headword',
        }),
      )
      continue
    }
    const pos = cell(row, 'pos')
    const meaningRaw = cell(row, 'meaning')
    const meaningParts = splitMulti(meaningRaw, /[；;]/)
    const meanings: RawMeaningInput[] = meaningParts.map((cn) => (pos ? { pos, cn } : { cn }))
    if (meanings.length === 0) {
      issues.push(
        makeIssue('warning', 'W_NO_MEANING', `第 ${row.line} 行没有释义，已用单词本身兜底`, {
          row: row.line,
          field: 'meaning',
        }),
      )
    }
    const tags = splitMulti(cell(row, 'tags'), /[;；,，|]/)
    const key = headword.trim().replace(/\s+/g, ' ').toLowerCase()
    const existing = byHeadword.get(key)
    const phoneticUK = cell(row, 'phoneticUK')
    const phoneticUS = cell(row, 'phoneticUS')
    if (existing) {
      // 同 headword 多行：合并 meanings（按 cn 去重）
      const merged = existing.meanings ?? []
      const seen = new Set(merged.map((item) => item.cn.toLowerCase()))
      for (const meaning of meanings) {
        if (seen.has(meaning.cn.toLowerCase())) continue
        seen.add(meaning.cn.toLowerCase())
        merged.push(meaning)
      }
      existing.meanings = merged
      if (!existing.example) {
        const example = cell(row, 'example')
        if (example) existing.example = example
      }
      if (!existing.exampleTranslation) {
        const translation = cell(row, 'exampleTranslation')
        if (translation) existing.exampleTranslation = translation
      }
      if (!existing.phonetic && (phoneticUK || phoneticUS)) {
        existing.phonetic = { uk: phoneticUK || undefined, us: phoneticUS || undefined }
      }
      if (tags.length > 0) existing.tags = [...new Set([...(existing.tags ?? []), ...tags])]
      continue
    }
    const input: RawWordInput = { headword, meanings }
    const example = cell(row, 'example')
    if (example) input.example = example
    const exampleTranslation = cell(row, 'exampleTranslation')
    if (exampleTranslation) input.exampleTranslation = exampleTranslation
    if (phoneticUK || phoneticUS) input.phonetic = { uk: phoneticUK || undefined, us: phoneticUS || undefined }
    if (tags.length > 0) input.tags = tags
    byHeadword.set(key, input)
    order.push(key)
  }
  if (order.length === 0 && !issues.some((issue) => issue.level === 'error')) {
    issues.push(makeIssue('error', 'E_FIELD', 'CSV 没有可导入的词条'))
  }
  return { words: order.map((key) => byHeadword.get(key)!), issues }
}
