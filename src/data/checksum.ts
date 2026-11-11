/**
 * 稳定序列化 + 校验和（SPEC §1.1 / §6.2）。
 *
 * - `stableStringify`：对象 key 递归排序、数组保持顺序、无空白 —— 保证同一份数据在任何端
 *   序列化结果一致，checksum 可复现。
 * - `computeChecksum`：优先 `crypto.subtle` 的 SHA-256；**非安全上下文**（例如局域网 http
 *   访问的 PWA，`crypto.subtle` 为 undefined）降级为 FNV-1a 64 位，并在导出文件的
 *   `meta.checksumAlgo` 标注。
 * - `verifyChecksum`：两种算法都尝试，任一匹配即通过（跨端导出的包仍能互相导入）。
 */

export type ChecksumAlgo = 'sha256' | 'fnv1a64'

export interface ChecksumResult {
  algo: ChecksumAlgo
  /** 小写 hex；sha256 = 64 位，fnv1a64 = 16 位 */
  hex: string
}

/**
 * 确定性 JSON 序列化：对象 key 递归排序、无空格、undefined 对象字段忽略（数组里变 null）。
 * 与 JSON.stringify 的差异仅在对象 key 顺序与空白，语义一致。
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  const type = typeof value
  if (type === 'number') {
    return Number.isFinite(value as number) ? JSON.stringify(value) : 'null'
  }
  if (type === 'boolean') return value ? 'true' : 'false'
  if (type === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const item of value) {
      parts.push(item === undefined ? 'null' : stableStringify(item))
    }
    return `[${parts.join(',')}]`
  }
  if (type === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort()
    const parts: string[] = []
    for (const key of keys) {
      parts.push(`${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    }
    return `{${parts.join(',')}}`
  }
  // function / symbol / bigint：JSON 里也不可序列化，统一 null
  return 'null'
}

const FNV64_OFFSET = 0xcbf29ce484222325n
const FNV64_PRIME = 0x100000001b3n
const FNV64_MASK = 0xffffffffffffffffn

/** FNV-1a 64 位（小写 hex，16 位补零）—— `crypto.subtle` 不可用时的降级 */
export function fnv1a64Hex(input: string): string {
  let hash = FNV64_OFFSET
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i))
    hash = (hash * FNV64_PRIME) & FNV64_MASK
  }
  return hash.toString(16).padStart(16, '0')
}

/** SHA-256 小写 hex；环境不支持（非安全上下文 / 无 WebCrypto）时返回 null */
export async function sha256Hex(input: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  try {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(input))
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    return null
  }
}

/** 计算 canonical 字符串的 checksum */
export async function computeChecksum(canonical: string): Promise<ChecksumResult> {
  const sha = await sha256Hex(canonical)
  if (sha) return { algo: 'sha256', hex: sha }
  return { algo: 'fnv1a64', hex: fnv1a64Hex(canonical) }
}

/** 校验 checksum：sha256 / fnv1a64 都试，命中即 true */
export async function verifyChecksum(
  canonical: string,
  expected: string,
): Promise<{ ok: boolean; matchedAlgo: ChecksumAlgo | null }> {
  const target = expected.trim().toLowerCase()
  if (!target) return { ok: false, matchedAlgo: null }
  const sha = await sha256Hex(canonical)
  if (sha && sha === target) return { ok: true, matchedAlgo: 'sha256' }
  if (fnv1a64Hex(canonical) === target) return { ok: true, matchedAlgo: 'fnv1a64' }
  return { ok: false, matchedAlgo: null }
}

/** 迁移包 checksum 的 canonical 载荷（SPEC §6.2 固定为这 4 个字段） */
export function migrationChecksumPayload(file: {
  format: string
  formatVersion: number
  dataVersion: number
  data: unknown
}): string {
  return stableStringify({
    format: file.format,
    formatVersion: file.formatVersion,
    dataVersion: file.dataVersion,
    data: file.data,
  })
}
