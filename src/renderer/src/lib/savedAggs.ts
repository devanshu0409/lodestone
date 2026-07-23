import type { FilterRow } from './filterQuery'

/**
 * Saved Aggregation-tab configurations, persisted per connection in
 * localStorage. Like saved searches, these carry no secrets — just the builder
 * state (index, filter, bucket levels, metrics) — so renderer storage is fine.
 * The level/metric shapes are stored structurally; a corrupt entry is dropped
 * rather than allowed to wedge the tab.
 */
export interface SavedAgg {
  name: string
  index: string
  filterRows: FilterRow[]
  // Stored loosely: the level/metric interfaces live in AggTab and evolve there.
  // localStorage can't type-check across versions anyway, so persist the shape.
  levels: unknown[]
  metrics: unknown[]
  savedAt: number
}

const keyOf = (connId: string): string => `lodestone.savedAggs.${connId}`

const byName = (a: SavedAgg, b: SavedAgg): number => a.name.localeCompare(b.name)

export function listSavedAggs(connId: string): SavedAgg[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(keyOf(connId)) ?? '[]')
    return Array.isArray(parsed) ? (parsed as SavedAgg[]).sort(byName) : []
  } catch {
    return []
  }
}

/** Saves (or replaces, by name) and returns the new list. */
export function saveAgg(connId: string, item: SavedAgg): SavedAgg[] {
  const next = [...listSavedAggs(connId).filter((s) => s.name !== item.name), item].sort(byName)
  localStorage.setItem(keyOf(connId), JSON.stringify(next))
  return next
}

export function deleteSavedAgg(connId: string, name: string): SavedAgg[] {
  const next = listSavedAggs(connId).filter((s) => s.name !== name)
  localStorage.setItem(keyOf(connId), JSON.stringify(next))
  return next
}
