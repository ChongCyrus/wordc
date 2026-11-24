/** 0.11.0 M4b-fix：当前 plan 原始字段诊断（不归一化，供真机核对） */
import { getDb } from './db'
import { isSqliteAvailable, sqliteQuery } from './native-sqlite'

export interface RawSqlitePlanDiagnostic {
  id: string
  date: unknown
  deckId: unknown
  completedAtRaw: unknown
  completedAtType: string
  indexRaw: unknown
  wordIdsRawType: string
  wordIdsLength: number | null
  updatedAtRaw: unknown
}

export interface PlanDiagnostics {
  sqliteAvailable: boolean
  sqlitePlans: RawSqlitePlanDiagnostic[]
  idbPlans: Array<{ id: string; date: string; deckId: string; completedAt: number | null; index: number; wordIdsLength: number; updatedAt: number }>
  error?: string
}

function parseWordIds(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.filter((id): id is string => typeof id === 'string')
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : null
    } catch {
      return null
    }
  }
  return null
}

/** 不经过 mapSqlitePlanRow，直接返回 SQLite raw completed_at/index/wordIds 长度 */
export async function getRawPlanDiagnostics(): Promise<PlanDiagnostics> {
  const idbPlans = (await getDb().plans.toArray()).map((plan) => ({
    id: plan.id,
    date: plan.date,
    deckId: plan.deckId,
    completedAt: plan.completedAt,
    index: plan.index,
    wordIdsLength: plan.wordIds.length,
    updatedAt: plan.updatedAt,
  }))
  if (!isSqliteAvailable()) return { sqliteAvailable: false, sqlitePlans: [], idbPlans }
  try {
    const response = await sqliteQuery({ table: 'plans', limit: 500, offset: 0, orderBy: 'id', direction: 'asc' }, 5_000)
    const rows = (response.rows as Array<Record<string, unknown>> | undefined) ?? []
    const sqlitePlans = rows.map((row) => {
      const parsed = parseWordIds(row.word_ids_json)
      return {
        id: String(row.id),
        date: row.date,
        deckId: row.deck_id,
        completedAtRaw: row.completed_at,
        completedAtType: row.completed_at == null ? 'null' : typeof row.completed_at,
        indexRaw: row.idx,
        wordIdsRawType: row.word_ids_json == null ? 'null' : typeof row.word_ids_json,
        wordIdsLength: parsed ? parsed.length : null,
        updatedAtRaw: row.updated_at,
      }
    })
    return { sqliteAvailable: true, sqlitePlans, idbPlans }
  } catch (error) {
    return { sqliteAvailable: true, sqlitePlans: [], idbPlans, error: error instanceof Error ? error.message : String(error) }
  }
}
