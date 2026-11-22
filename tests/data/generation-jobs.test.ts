/** 0.4.0/task-283 B2：生成任务持久化/续跑/命名/删除 */
import './test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  appendGenerationJobFailed,
  appendGenerationJobResult,
  clearFinishedGenerationJobs,
  createGenerationJob,
  deleteGenerationJob,
  getGenerationJob,
  getGenerationJobPendingTargets,
  listGenerationJobs,
  renameGenerationJob,
  resetDatabase,
  resumeGenerationJob,
  updateGenerationJob,
} from '../../src/data'

describe('0.4.0 · generation jobs B2', () => {
  beforeEach(async () => { await resetDatabase() })

  it('0.5.0 targets/config/sourceWordCount + pending + 旧 job 兼容', async () => {
    const job = await createGenerationJob({
      kind: 'examples',
      source: 'selected',
      targets: [{ wordId: 'w1', headword: 'alpha' }, { wordId: 'w2', headword: 'beta' }, { wordId: 'w3', headword: 'gamma' }],
      config: { kinds: ['examples'], batchSize: 5, excludes: ['rejected'] },
      sourceWordCount: 10,
    })
    expect(job.targets).toHaveLength(3)
    expect(job.config).toMatchObject({ batchSize: 5 })
    expect(job.sourceWordCount).toBe(10)
    expect((await getGenerationJobPendingTargets(job.id)).map((t) => t.wordId)).toEqual(['w1', 'w2', 'w3'])
    await appendGenerationJobResult(job.id, { wordId: 'w1', cursor: 1 })
    const pending = await getGenerationJobPendingTargets(job.id)
    expect(pending.map((t) => t.wordId)).toEqual(['w2', 'w3'])
    const resumed = await resumeGenerationJob(job.id)
    expect(resumed.resumable).toBe(true)
    expect(resumed.cursor).toBe(1)
    expect(resumed.targets.map((t) => t.wordId)).toEqual(['w2', 'w3'])
    expect(resumed.config).toMatchObject({ kinds: ['examples'] })
    await updateGenerationJob(job.id, { status: 'completed' })
    expect(await getGenerationJobPendingTargets(job.id)).toEqual([])
    expect((await resumeGenerationJob(job.id)).resumable).toBe(false)
    // 旧 job 无 targets
    const legacy = await createGenerationJob({ kind: 'examples', source: 'today' })
    const old = await resumeGenerationJob(legacy.id)
    expect(old.resumable).toBe(false)
    expect(old.targets).toEqual([])
  })

  it('创建/命名/更新/结果/失败/续跑/删除/清理', async () => {
    const job = await createGenerationJob({
      name: '词源批量', kind: 'root-etymology', source: 'deck', filter: { deckId: 'd1' }, targetTotal: 10, concurrency: 2,
    })
    expect(job.status).toBe('queued')
    await renameGenerationJob(job.id, '词源批量-改名')
    expect((await getGenerationJob(job.id))?.name).toBe('词源批量-改名')
    const running = await updateGenerationJob(job.id, { status: 'running', cursor: 3 })
    expect(running.cursor).toBe(3)
    await appendGenerationJobResult(job.id, { wordId: 'w1', headword: 'alpha' })
    await appendGenerationJobResult(job.id, { wordId: 'w2', headword: 'beta' })
    await appendGenerationJobFailed(job.id, { wordId: 'w3', message: 'timeout', code: 'AI_TIMEOUT' })
    let current = (await getGenerationJob(job.id))!
    expect(current.cursor).toBe(5)
    expect(current.results).toHaveLength(2)
    expect(current.failed).toHaveLength(1)
    // 模拟重启：列表仍可读，resume 拿 cursor
    expect((await listGenerationJobs())[0]!.id).toBe(job.id)
    current = (await updateGenerationJob(job.id, { status: 'paused' }))
    const resumed = await resumeGenerationJob(job.id)
    // 本测试 job 无 targets：按 0.5.0 旧 job 兼容，不可续
    expect(resumed.cursor).toBe(5)
    expect(resumed.resumable).toBe(false)
    // 完成/取消不可续
    await updateGenerationJob(job.id, { status: 'completed' })
    expect((await resumeGenerationJob(job.id)).cursor).toBe(5)
    // 删除/清理
    expect(await deleteGenerationJob(job.id)).toBe(true)
    expect(await getGenerationJob(job.id)).toBeNull()
    expect(await deleteGenerationJob('nope')).toBe(false)
    const done = await createGenerationJob({ kind: 'examples', source: 'today' })
    await updateGenerationJob(done.id, { status: 'failed' })
    expect(await clearFinishedGenerationJobs()).toBeGreaterThanOrEqual(1)
    expect(await listGenerationJobs()).toHaveLength(0)
  })
})
