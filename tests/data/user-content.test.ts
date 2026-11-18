/** task-139 F6 · 用户笔记/助记 CRUD、AI 助记编辑/隐藏、迁移、AI apply 不覆盖 */
import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import { createDeck, getDb, getWord, resetDatabase, updateSettings } from '../../src/data'
import {
  applyApproved,
  approveItems,
  buildMigrationFile,
  deleteAiMnemonic,
  deleteUserMnemonic,
  deleteUserNote,
  editAiMnemonic,
  importMigration,
  importPack,
  listMergedMnemonics,
  listPackItems,
  listUserMnemonics,
  listUserNotes,
  mnemonicKey,
  upsertUserMnemonic,
  upsertUserNote,
} from '../../src/data'
import { computeChecksum } from '../../src/data/checksum'
import { packChecksumPayload } from '../../src/data/packs/schema'
import type { PackFileV1, PackItemV1 } from '../../src/data'

async function setup() {
  const deck = await createDeck({
    name: 'F6 用户内容',
    words: [
      { headword: 'alpha', meanings: [{ pos: 'n.', cn: '甲' }, { pos: 'n.', cn: '阿尔法' }] },
      { headword: 'beta', meanings: [{ pos: 'n.', cn: '乙' }] },
    ],
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const word = (await getWord(`${deck.id}:alpha`))!
  const secondMeaning = word.meanings[1]!.id
  return { deck, word, secondMeaning }
}

async function makePack(items: PackItemV1[], deckId: string): Promise<PackFileV1> {
  const base = {
    format: 'momo-pack' as const,
    formatVersion: 1 as const,
    kind: 'mixed' as const,
    createdAt: Date.UTC(2026, 11, 14),
    generator: 'test@f6',
    items,
    meta: { source: 'import' as const, deckId },
  }
  const checksum = (await computeChecksum(packChecksumPayload(base))).hex
  return { ...base, checksum }
}

describe('task-139 F6 · 用户笔记/助记', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('笔记 CRUD：w 级与 c 级区分；更新/删除；不改 packItems', async () => {
    const { word, secondMeaning } = await setup()
    const packCountBefore = await getDb().packItems.count()

    const wNote = await upsertUserNote(word.id, { text: '  词级笔记  ' })
    expect(wNote.text).toBe('词级笔记')
    expect(wNote.meaningId).toBeUndefined()
    const cNote = await upsertUserNote(word.id, { text: '第二个含义的笔记', meaningId: secondMeaning })
    expect(cNote.meaningId).toBe(secondMeaning)

    expect((await listUserNotes(word.id)).map((note) => note.text)).toEqual(['词级笔记'])
    expect((await listUserNotes(word.id, secondMeaning)).map((note) => note.text)).toEqual(['第二个含义的笔记'])

    const updated = await upsertUserNote(word.id, { id: wNote.id, text: '改后的词级笔记' })
    expect(updated.text).toBe('改后的词级笔记')
    expect((await listUserNotes(word.id)).length).toBe(1)

    expect(await deleteUserNote(word.id, cNote.id)).toBe(true)
    expect(await deleteUserNote(word.id, cNote.id)).toBe(false)
    expect((await listUserNotes(word.id, secondMeaning)).length).toBe(0)
    expect(await getDb().packItems.count()).toBe(packCountBefore) // 不写 packItems
    await expect(upsertUserNote(word.id, { text: 'x', meaningId: 'bad-meaning-id' })).rejects.toThrow(/含义不存在/)
    await expect(upsertUserNote(word.id, { text: '   ' })).rejects.toThrow(/不能为空/)
  })

  it('助记 CRUD：类型校验；w/c 级过滤；不改学习进度', async () => {
    const { word, secondMeaning } = await setup()
    const stateCount = await getDb().states.count()
    const wMnemonic = await upsertUserMnemonic(word.id, { type: '联想', text: '词级联想' })
    const cMnemonic = await upsertUserMnemonic(word.id, { type: '谐音', text: 'c 级谐音', meaningId: secondMeaning })
    expect((await listUserMnemonics(word.id)).map((item) => item.text)).toEqual(['词级联想'])
    expect((await listUserMnemonics(word.id, secondMeaning)).map((item) => item.text)).toEqual(['c 级谐音'])
    await expect(upsertUserMnemonic(word.id, { type: '乱写' as never, text: 'x' })).rejects.toThrow(/不支持/)
    expect(await deleteUserMnemonic(word.id, cMnemonic.id)).toBe(true)
    expect((await listUserMnemonics(word.id, secondMeaning)).length).toBe(0)
    expect((await listUserMnemonics(word.id))[0]!.id).toBe(wMnemonic.id)
    expect(await getDb().states.count()).toBe(stateCount)
  })

  it('AI 助记编辑/删除：hidden key 生效；重应用 AI 包不恢复', async () => {
    const { deck, word } = await setup()
    const db = getDb()
    const meaningId = word.meanings[0]!.id
    const aiMnemonic = { type: '联想' as const, text: 'AI 原助记', meaningId }
    const aiMnemonic2 = { type: '谐音' as const, text: 'AI 第二条', meaningId }
    const withAi = (await db.words.get(word.id))!
    withAi.mnemonics = [aiMnemonic, aiMnemonic2]
    await db.words.put(withAi)

    expect((await listMergedMnemonics(word.id, meaningId)).map((item) => item.text)).toEqual(['AI 原助记', 'AI 第二条'])

    // 编辑第一条 AI → hidden + 用户副本
    const copy = await editAiMnemonic(word.id, aiMnemonic, { text: '用户改后的助记' })
    expect(copy.text).toBe('用户改后的助记')
    let merged = await listMergedMnemonics(word.id, meaningId)
    expect(merged.find((item) => item.source === 'user')!.text).toBe('用户改后的助记')
    expect(merged.some((item) => item.text === 'AI 原助记')).toBe(false)
    expect((await getDb().words.get(word.id))!.hiddenMnemonicKeys).toContain(mnemonicKey(meaningId, '联想', 'AI 原助记'))

    // 删除第二条 AI → 只 hidden
    await deleteAiMnemonic(word.id, aiMnemonic2)
    merged = await listMergedMnemonics(word.id, meaningId)
    expect(merged.some((item) => item.text === 'AI 第二条')).toBe(false)

    // 重应用 AI 包（同助记）→ hidden 不恢复
    const file = await makePack(
      [{ headword: 'alpha', headwordLower: 'alpha', meaningIndex: 1, mnemonics: [aiMnemonic, aiMnemonic2] }],
      deck.id,
    )
    const imported = await importPack(JSON.stringify(file))
    const items = await listPackItems(imported.packId!)
    await approveItems(imported.packId!, items.map((item) => item.id))
    const applied = await applyApproved(imported.packId!)
    expect(applied.applied + applied.skipped).toBeGreaterThan(0)
    const after = (await getDb().words.get(word.id))!
    expect(after.hiddenMnemonicKeys).toEqual(expect.arrayContaining([mnemonicKey(meaningId, '联想', 'AI 原助记'), mnemonicKey(meaningId, '谐音', 'AI 第二条')]))
    const mergedAfter = await listMergedMnemonics(word.id, meaningId)
    expect(mergedAfter.some((item) => item.text === 'AI 原助记' || item.text === 'AI 第二条')).toBe(false)
    expect(mergedAfter.some((item) => item.text === '用户改后的助记')).toBe(true)
  })

  it('API 严格按 meaningId 分层：w/c 不串；空串按 w 级；prefill 查询精确', async () => {
    const { word, secondMeaning } = await setup()
    const firstMeaning = word.meanings[0]!.id
    const db = getDb()

    await upsertUserNote(word.id, { text: 'w 笔记' })
    await upsertUserNote(word.id, { text: 'c1 笔记', meaningId: firstMeaning })
    await upsertUserNote(word.id, { text: 'c2 笔记', meaningId: secondMeaning })
    expect((await listUserNotes(word.id)).map((note) => note.text)).toEqual(['w 笔记'])
    expect((await listUserNotes(word.id, '')).map((note) => note.text)).toEqual(['w 笔记']) // 空串=w 级
    expect((await listUserNotes(word.id, firstMeaning)).map((note) => note.text)).toEqual(['c1 笔记'])
    expect((await listUserNotes(word.id, secondMeaning)).map((note) => note.text)).toEqual(['c2 笔记'])

    await upsertUserMnemonic(word.id, { type: '联想', text: 'w 助记' })
    await upsertUserMnemonic(word.id, { type: '谐音', text: 'c1 助记', meaningId: firstMeaning })
    expect((await listUserMnemonics(word.id)).map((item) => item.text)).toEqual(['w 助记'])
    expect((await listUserMnemonics(word.id, firstMeaning)).map((item) => item.text)).toEqual(['c1 助记'])

    // AI 助记同时有 w 级与 c 级
    const current = (await db.words.get(word.id))!
    current.mnemonics = [
      { type: '联想', text: 'w AI 助记' },
      { type: '联想', text: 'c1 AI 助记', meaningId: firstMeaning },
    ]
    await db.words.put(current)

    const mergedW = await listMergedMnemonics(word.id)
    expect(mergedW.some((item) => item.text === 'w AI 助记')).toBe(true)
    expect(mergedW.some((item) => item.text === 'c1 AI 助记')).toBe(false)
    const mergedC1 = await listMergedMnemonics(word.id, firstMeaning)
    expect(mergedC1.some((item) => item.text === 'c1 AI 助记')).toBe(true)
    expect(mergedC1.some((item) => item.text === 'w AI 助记')).toBe(false)
    expect(mergedC1.some((item) => item.text === 'c1 助记')).toBe(true)

    // 编辑 c1 AI → hidden 只影响 c1，不影响 w
    await editAiMnemonic(word.id, { type: '联想', text: 'c1 AI 助记', meaningId: firstMeaning }, { text: 'c1 用户改后' })
    expect((await listMergedMnemonics(word.id)).some((item) => item.text === 'w AI 助记')).toBe(true)
    const afterC1 = await listMergedMnemonics(word.id, firstMeaning)
    expect(afterC1.some((item) => item.text === 'c1 AI 助记')).toBe(false)
    expect(afterC1.some((item) => item.text === 'c1 用户改后')).toBe(true)
  })

  it('迁移导出→清库→导入恢复 userNotes/userMnemonics/hiddenMnemonicKeys', async () => {
    const { word, secondMeaning } = await setup()
    const note = await upsertUserNote(word.id, { text: '迁移笔记', meaningId: secondMeaning })
    const mnemonic = await upsertUserMnemonic(word.id, { type: '口诀', text: '迁移口诀' })
    await hideMnemonicForTest(word.id, mnemonicKey(undefined, '联想', '被隐藏的 AI 助记'))
    const file = await buildMigrationFile({ includeReviewLogs: false })
    const text = JSON.stringify(file)

    await resetDatabase()
    const report = await importMigration(text, { strategy: 'replace' })
    expect(report.issues.filter((issue) => issue.level === 'error')).toEqual([])
    const restored = (await getWord(word.id))!
    expect(restored.userNotes?.find((item) => item.id === note.id)?.text).toBe('迁移笔记')
    expect(restored.userMnemonics?.find((item) => item.id === mnemonic.id)?.text).toBe('迁移口诀')
    expect(restored.hiddenMnemonicKeys).toContain(mnemonicKey(undefined, '联想', '被隐藏的 AI 助记'))
  })
})

// 单独导入 hideMnemonic，避免顶部列表过长
import { hideMnemonic as hideMnemonicForTest } from '../../src/data'
