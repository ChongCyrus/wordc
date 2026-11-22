import { describe, expect, it } from 'vitest'
import { guardServiceWorkerVersion, SW_VERSION_KEY } from '../../src/app/swUpdate'

function makeDeps(overrides: Record<string, unknown> = {}) {
  const store = new Map<string, string>()
  const calls = { unregister: 0, caches: 0, reload: 0 }
  const deps = {
    version: '0.3.52',
    storage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value)
      },
    },
    hasController: true,
    unregisterAll: async () => {
      calls.unregister += 1
    },
    clearCaches: async () => {
      calls.caches += 1
    },
    reload: () => {
      calls.reload += 1
    },
    ...overrides,
  }
  return { deps, calls, store }
}

describe('旧 SW 清理防黑屏（task-174）', () => {
  it('无 controller：记录版本，不清理', async () => {
    const { deps, calls, store } = makeDeps({ hasController: false })
    expect(await guardServiceWorkerVersion(deps as never)).toBe('no-controller')
    expect(store.get(SW_VERSION_KEY)).toBe('0.3.52')
    expect(calls.unregister).toBe(0)
    expect(calls.reload).toBe(0)
  })

  it('版本一致：不清理', async () => {
    const { deps, calls, store } = makeDeps()
    store.set(SW_VERSION_KEY, '0.3.52')
    expect(await guardServiceWorkerVersion(deps as never)).toBe('current')
    expect(calls.unregister).toBe(0)
    expect(calls.reload).toBe(0)
  })

  it('版本变化：注销 SW、清缓存并重载一次', async () => {
    const { deps, calls, store } = makeDeps()
    store.set(SW_VERSION_KEY, '0.3.50')
    expect(await guardServiceWorkerVersion(deps as never)).toBe('reloaded')
    expect(store.get(SW_VERSION_KEY)).toBe('0.3.52')
    expect(calls.unregister).toBe(1)
    expect(calls.caches).toBe(1)
    expect(calls.reload).toBe(1)
  })

  it('清理异常不阻塞重载', async () => {
    const { deps, calls } = makeDeps({
      unregisterAll: async () => {
        throw new Error('boom')
      },
      clearCaches: async () => {
        throw new Error('cache boom')
      },
    })
    expect(await guardServiceWorkerVersion(deps as never)).toBe('reloaded')
    expect(calls.reload).toBe(1)
  })
})
