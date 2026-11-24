/** 0.10.0：检查点保存/轮换/启动空 states 自动恢复/坏包不写 */
import './test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  appendWordsToTodayPlan,
  clearAllData,
  buildInitialState,
  createDeck,
  getDb,
  getStateCheckpointStatus,
  resetDatabase,
  restoreStateCheckpointIfEmpty,
  saveStateCheckpoint,
  updateSettings,
  type AutoBackupBridge,
  type AutoBackupEntry,
} from '../../src/data'

class FakeBridge implements AutoBackupBridge {
  files = new Map<string, string>()
  seq = 0
  isAvailable() { return true }
  save(text: string, name: string) { this.files.set(name, text); this.seq += 1; return { ok: true, mode: 'native' as const, name, path: `/p/${name}` } }
  list(): AutoBackupEntry[] { return [...this.files.entries()].map(([name, text]) => ({ name, size: text.length, mtime: ++this.seq, path: `/p/${name}` })) }
  read(name: string) { return this.files.get(name) ?? null }
  delete(name: string) { return this.files.delete(name) }
  prune() { return 0 }
  getFlag() { return '' }
  setFlag() { return true }
  appendDiagLog() { return undefined }
}

async function setup() {
  const deck = await createDeck({ name: 'cp', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }, { headword: 'beta', meanings: [{ cn: '乙' }] }] })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const db = getDb()
  const words = await db.words.where('deckId').equals(deck.id).toArray()
  for (const word of words) await db.states.put({ ...buildInitialState(word, Date.now()), phase: 'review' })
  const plan = await appendWordsToTodayPlan({ wordIds: [words[0]!.id] })
  return { deck, words, plan: plan.plan }
}

describe('0.10.0 · state checkpoint', () => {
  beforeEach(async () => { await resetDatabase() })

  it('保存/轮换3/空 states 自动恢复；不改 words', async () => {
    const { deck, plan } = await setup()
    const bridge = new FakeBridge()
    await saveStateCheckpoint(bridge)
    expect(bridge.files.has('checkpoint-latest.state.json')).toBe(true)
    // 多次保存轮换，最多 latest + 3 历史
    for (let i = 0; i < 5; i += 1) await saveStateCheckpoint(bridge)
    const names = [...bridge.files.keys()].filter((name) => /^checkpoint-(\d+)\.state\.json$/.test(name))
    expect(names.length).toBeLessThanOrEqual(3)
    expect((await getStateCheckpointStatus()).state).toBe('saved')
    // 模拟 IndexedDB 丢失 states/plans，但 words 仍在
    const db = getDb()
    await db.states.clear()
    await db.plans.clear()
    expect(await db.states.count()).toBe(0)
    const restored = await restoreStateCheckpointIfEmpty(bridge)
    expect(restored.state).toBe('restored')
    expect(restored.restored?.states).toBe(2)
    expect((await db.states.count())).toBe(2)
    expect((await db.plans.get(plan.id))?.wordIds.length).toBe(1)
    expect(await db.words.where('deckId').equals(deck.id).count()).toBe(2)
  })

  it('0.10.0 清空数据删除检查点/写 clearedAt，重启不复活', async () => {
    const { deck } = await setup()
    const bridge = new FakeBridge()
    await saveStateCheckpoint(bridge)
    expect(bridge.files.size).toBeGreaterThan(0)
    await clearAllData({ unsafe: true, checkpointBridge: bridge })
    expect(bridge.files.size).toBe(0)
    const restored = await restoreStateCheckpointIfEmpty(bridge)
    expect(restored.skipped).toBe(true)
    expect(await getDb().states.count()).toBe(0)
    expect(await getDb().words.where('deckId').equals(deck.id).count()).toBe(0)
  })

  it('0.10.0 清空后新评分→新检查点可恢复；旧检查点不复活', async () => {
    await setup()
    const bridge = new FakeBridge()
    await saveStateCheckpoint(bridge)
    await clearAllData({ unsafe: true, checkpointBridge: bridge })
    expect(await getDb().meta.get('data.clearedAt')).toBeTruthy()
    // 新会话：新词/新 state/新检查点（createdAt 晚于 clearedAt）
    const db = getDb()
    const words = await db.words.toArray()
    expect(words.length).toBe(0)
    const deck2 = await createDeck({ name: 'after-clear', words: [{ headword: 'omega', meanings: [{ cn: '终' }] }] })
    const word2 = (await db.words.where('deckId').equals(deck2.id).toArray())[0]!
    await db.states.put({ ...buildInitialState(word2, Date.now() + 10), phase: 'review' })
    await saveStateCheckpoint(bridge)
    await db.states.clear()
    const restored = await restoreStateCheckpointIfEmpty(bridge)
    expect(restored.state).toBe('restored')
    expect(restored.restored?.states).toBe(1)
    expect(await db.states.count()).toBe(1)
  })

  it('坏包/0KB 不写入，状态 failed/idle', async () => {
    const { deck } = await setup()
    const bridge = new FakeBridge()
    bridge.files.set('checkpoint-latest.state.json', '')
    const db = getDb()
    await db.states.clear()
    const result = await restoreStateCheckpointIfEmpty(bridge)
    expect(result.state === 'idle' || result.state === 'failed').toBe(true)
    expect(await db.states.count()).toBe(0)
    expect(await db.words.where('deckId').equals(deck.id).count()).toBe(2)
  })
})
