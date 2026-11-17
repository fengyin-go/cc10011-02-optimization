import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// 整份数据（各模块记录 + 影响传播状态）共用一个存储键，站点修订一次写盘，
// 避免「站点字段已更新、影响清单还没写进去」的半套数据被任务编排读到。
const STORAGE_KEY = 'scraper-strategy-studio:entries'

/** 影响传播的状态挂在同一个根对象的这个键下，和模块记录一起原子写入。 */
export const IMPACT_AUX_KEY = 'impactPropagation'

export type StoreRoot = Record<string, unknown>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isEntryRows(value: unknown): value is EntryRow[] {
  return Array.isArray(value)
}

function readStorage(): StoreRoot {
  const fallback = clone<StoreRoot>(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as StoreRoot
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: StoreRoot | null = null

function root(): StoreRoot {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  const view: Record<string, EntryRow[]> = {}
  for (const [key, value] of Object.entries(root())) {
    if (isEntryRows(value)) {
      view[key] = value
    }
  }
  return view
}

export function listRows(key: string): EntryRow[] {
  const value = root()[key]
  return isEntryRows(value) ? value : []
}

/** 读取与模块记录同根存放的辅助状态。 */
export function readAux<T>(key: string): T | null {
  const value = root()[key]
  if (value === undefined || isEntryRows(value)) {
    return null
  }
  return clone(value as T)
}

export function cloneRoot(): StoreRoot {
  return clone(root())
}

/**
 * 一次写盘提交整份根对象。JSON 序列化或 localStorage 写入失败时直接抛出，
 * 内存缓存保持原样，调用方可以继续使用上一份可执行数据。
 */
export function writeStore(next: StoreRoot): void {
  const serialized = JSON.stringify(next)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, serialized)
  }
  cache = next
}

/** 清掉与模块记录同根存放的辅助状态（例如重置站点登记时一并清空影响清单）。 */
export function clearAux(key: string): void {
  const root = cloneRoot()
  delete root[key]
  writeStore(root)
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...cloneRoot(), [key]: rows }
  writeStore(next)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
