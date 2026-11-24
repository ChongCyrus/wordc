import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { createDeck, getDb, resetDatabase, updateSettings } from '../../src/data'
const originalWindow = (globalThis as { window?: unknown }).window
afterEach(() => { (globalThis as { window?: unknown }).window = originalWindow })
describe('rc11 settings event', () => {
  it('updateSettings idb 分支 dispatch momo:settings-updated', async () => {
    await resetDatabase()
    const deck = await createDeck({ name: 'evt', words: [{ headword: 'a', meanings: [{ cn: '甲' }] }] })
    const events: Array<{ type: string; detail?: unknown }> = []
    ;(globalThis as { window?: unknown }).window = {
      dispatchEvent: (event: { type: string; detail?: unknown }) => { events.push(event); return true },
    }
    await updateSettings({ 'data.selectedDeckId': deck.id, 'study.dailyGoal': 33 })
    expect(events.some((event) => event.type === 'momo:settings-updated')).toBe(true)
    expect((await getDb().settings.get('study.dailyGoal'))?.value).toBe(33)
  })
})
