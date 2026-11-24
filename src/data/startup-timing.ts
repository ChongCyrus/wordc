/** 0.11.0 启动性能打点：各阶段 ms 持久化到 localStorage/meta，随诊断包导出 */
export interface StartupTiming {
  startAt: number
  phases: Record<string, number>
  finishedAt?: number
}

let timing: StartupTiming = { startAt: 0, phases: {} }

function persist(): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('momo:startup-timing', JSON.stringify(timing))
    }
  } catch {
    /* ignore */
  }
}

export function markStartupPhase(phase: string, now: number = typeof performance !== 'undefined' ? performance.now() : Date.now()): void {
  if (timing.startAt === 0) timing.startAt = now
  timing.phases[phase] = Math.round(now - timing.startAt)
  persist()
}

export function finishStartupTiming(): void {
  timing.finishedAt = Date.now()
  persist()
}

export function getStartupTiming(): StartupTiming {
  if (timing.startAt === 0) {
    try {
      const raw = typeof window !== 'undefined' ? window.localStorage.getItem('momo:startup-timing') : null
      if (raw) return JSON.parse(raw) as StartupTiming
    } catch {
      /* ignore */
    }
  }
  return timing
}

export function resetStartupTiming(): void {
  timing = { startAt: typeof performance !== 'undefined' ? performance.now() : Date.now(), phases: {} }
  persist()
}
