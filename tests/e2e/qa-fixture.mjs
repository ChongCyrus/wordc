/**
 * task-177 最小 JSON fixture 加载器（不依赖 188MB Chromium profile）。
 * fixture 只含：deckId/headwords、今日 plan、已学状态、旧 pack 样本、settings；应用启动后调用。
 * 用法（脚本内）：
 *   import { loadMinimalFixture } from './qa-fixture.mjs'
 *   await loadMinimalFixture(page, 'tests/e2e/fixtures/minimal-profile.json')
 */
import { readFile } from 'node:fs/promises'

export async function loadMinimalFixture(page, fixturePath) {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
  return page.evaluate(async (fx) => {
    const open = () => new Promise((resolve, reject) => {
      const req = indexedDB.open('wordc')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const db = await open()
    const all = (store) => new Promise((resolve) => {
      const req = db.transaction(store, 'readonly').objectStore(store).getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve([])
    })
    const now = Date.now()
    const d = new Date(now)
    const pad = (x) => String(x).padStart(2, '0')
    const dateKey = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const words = await all('words')
    const byHead = new Map(words.filter((w) => w.deckId === fx.deckId).map((w) => [String(w.headword).toLowerCase(), w]))
    const resolved = fx.plan.headwords.map((h) => byHead.get(h.toLowerCase())).filter(Boolean)
    if (resolved.length === 0) throw new Error(`fixture deck/words 不可用：${fx.deckId}`)
    const ids = resolved.map((w) => w.id)
    const idSet = new Set(fx.deckHeadwords.map((h) => h.toLowerCase()))
    void idSet
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['settings', 'plans', 'states', 'reviewLogs', 'words', 'packs', 'packItems', 'meta'], 'readwrite')
      const settings = tx.objectStore('settings')
      for (const [key, value] of Object.entries(fx.settings || {})) settings.put({ key, value, updatedAt: now })
      const planId = `${dateKey}:${fx.deckId}`
      tx.objectStore('plans').put({
        id: planId,
        date: dateKey,
        deckId: fx.deckId,
        wordIds: ids,
        index: 0,
        sources: Object.fromEntries(ids.map((id) => [id, 'goal'])),
        goals: { dailyGoal: fx.plan.goal, dueCount: 0, newBudget: ids.length, extraCount: 0 },
        ratings: [],
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      })
      tx.objectStore('meta').put({ key: 'plan.activeId', value: planId, updatedAt: now })
      for (const head of fx.allRareHeadwords ?? []) {
        const w = byHead.get(String(head).toLowerCase())
        if (!w) continue
        tx.objectStore('words').put({ ...w, rareMeaningIds: w.meanings.map((m) => m.id) })
      }
      for (const head of fx.ncHeadwords ?? []) {
        const w = byHead.get(String(head).toLowerCase())
        if (!w) continue
        tx.objectStore('words').put({ ...w, ncMeaningIds: w.meanings.slice(0, 2).map((m) => m.id), rareMeaningIds: w.rareMeaningIds?.length ? w.rareMeaningIds : w.meanings.map((m) => m.id), rootMnemonic: { text: fx.rootMnemonicText || 'fixture映射助记', source: 'manual', updatedAt: Date.now() } })
      }
      for (const head of fx.rootMnemonicHeadwords ?? []) {
        const w = byHead.get(String(head).toLowerCase())
        if (!w) continue
        tx.objectStore('words').put({ ...w, rareMeaningIds: w.rareMeaningIds?.length ? w.rareMeaningIds : w.meanings.map((m) => m.id), ...(fx.ncHeadwords?.some((h) => String(h).toLowerCase() === String(head).toLowerCase()) ? { ncMeaningIds: w.meanings.slice(0, 2).map((m) => m.id) } : {}), rootMnemonic: { text: fx.rootMnemonicText || 'fixture映射助记', source: 'manual', updatedAt: Date.now() } })
      }
      for (const learned of fx.learned ?? []) {
        const w = byHead.get(String(learned.headword).toLowerCase())
        if (!w) continue
        const meaningStats = Object.fromEntries(w.meanings.map((m, i) => [m.id, learned.meaningStats?.[String(i + 1)] ?? { clicks: 0, encounters: 2 }]))
        tx.objectStore('states').put({
          wordId: w.id,
          deckId: w.deckId,
          phase: 'learning',
          stability: 1,
          difficulty: 5,
          reps: 1,
          lapses: 0,
          firstSeenAt: now - 86_400_000,
          lastReviewedAt: now - 3_600_000,
          dueAt: now + 86_400_000,
          nextIntervalDays: 1,
          retrievability: 1,
          lastRating: '认识',
          sameDayCount: 1,
          sameDayDate: dateKey,
          sameDayRequeued: 0,
          todayProgress: 1,
          meaningStats,
          createdAt: now - 86_400_000,
          updatedAt: now,
        })
        // 顶部「上一个单词」需要当前词有今日可撤销评分快照
        tx.objectStore('reviewLogs').add({
          wordId: w.id,
          deckId: w.deckId,
          rating: '认识',
          reviewedAt: now - 1200,
          corrected: false,
          stateBefore: { phase: 'new', reps: 0, lapses: 0 },
          source: 'fixture',
          createdAt: now - 1200,
        }).catch?.(() => {})
      }
      for (const head of fx.derivationMapHeadwords ?? []) {
        const w = byHead.get(String(head).toLowerCase())
        if (!w) continue
        tx.objectStore('words').put({ ...w, derivationMap: { rootLabel: 'fixture本义', text: 'fixture本义解释（用于映射助记入口）', mermaid: '', source: 'manual', updatedAt: Date.now() } })
      }
      for (const head of fx.annotationContentHeadwords ?? []) {
        const w = byHead.get(String(head).toLowerCase())
        if (!w) continue
        const mid = w.meanings[0]?.id
        tx.objectStore('words').put({
          ...w,
          mnemonics: [...(w.mnemonics ?? []), { type: '词根', text: 'AI [词根] depend… fixture AI助记', ...(mid ? { meaningId: mid } : {}) }],
          userNotes: [...(w.userNotes ?? []), { id: 'fixture-note', text: 'fixture我的笔记', ...(mid ? { meaningId: mid } : {}) }],
          userMnemonics: [...(w.userMnemonics ?? []), { id: 'fixture-mine', type: '联想', text: 'fixture我的助记', ...(mid ? { meaningId: mid } : {}) }],
        })
      }
      for (const pack of fx.oldPacks ?? []) {
        const w = byHead.get(String(pack.word).toLowerCase())
        if (!w) continue
        tx.objectStore('packs').put({
          id: pack.id,
          name: pack.name,
          kind: pack.kind,
          formatVersion: 1,
          checksum: pack.checksum,
          source: 'builtin',
          status: 'applied',
          deckId: fx.deckId,
          promptVersion: pack.promptVersion,
          counts: { items: 1, pending: 0, approved: 0, applied: 1, rejected: 0, skipped: 0 },
          createdAt: now - 2000,
          updatedAt: now - 2000,
        })
        tx.objectStore('packItems').put({
          id: `${pack.id}:1`,
          packId: pack.id,
          seq: 1,
          wordId: w.id,
          headwordLower: w.headwordLower,
          payload: { headword: w.headword, coreSenses: pack.coreSenses, meaningMap: pack.meaningMap },
          status: 'applied',
          createdAt: now - 2000,
          appliedAt: now - 2000,
        })
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    return { deckId: fx.deckId, planId: `${dateKey}:${fx.deckId}`, wordIds: ids, words: resolved.length }
  }, fixture)
}
