/** rc2g：导入阶段诊断（崩溃/强杀后保留在 meta） */
import { getDb } from './db'

export async function getImportStageDiagnostics(): Promise<{
  stageNow: unknown
  stageTiming: unknown
  stageDiag: unknown
  factsOnlyTiming: unknown
}> {
  const db = getDb()
  const [stageNow, stageTiming, stageDiag, factsOnlyTiming] = await Promise.all([
    db.meta.get('import.sqlite.stageNow'),
    db.meta.get('import.sqlite.stageTiming'),
    db.meta.get('import.sqlite.stageDiag'),
    db.meta.get('import.sqlite.factsOnlyTiming'),
  ])
  return {
    stageNow: stageNow?.value ?? null,
    stageTiming: stageTiming?.value ?? null,
    stageDiag: stageDiag?.value ?? null,
    factsOnlyTiming: factsOnlyTiming?.value ?? null,
  }
}
