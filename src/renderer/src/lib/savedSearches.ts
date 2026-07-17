import type { FilterRow } from './filterQuery'

/**
 * Saved Search-tab requests, persisted per connection in localStorage.
 *
 * These are UI convenience only — an index name, filter rows and a sort. No
 * credentials, so they don't need the main process's encrypted store (that's
 * reserved for connection secrets). Anything unparseable is treated as "no
 * saved searches" rather than throwing: a corrupt entry must never wedge the
 * Search tab.
 */
export interface SavedSearch {
  name: string
  index: string
  rawMode: boolean
  rawJson: string
  rows: FilterRow[]
  sort: { field: string; dir: 'asc' | 'desc' } | null
  size: number
  savedAt: number
}

const keyOf = (connId: string): string => `lodestone.savedSearches.${connId}`

const byName = (a: SavedSearch, b: SavedSearch): number => a.name.localeCompare(b.name)

export function listSaved(connId: string): SavedSearch[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(keyOf(connId)) ?? '[]')
    return Array.isArray(parsed) ? (parsed as SavedSearch[]).sort(byName) : []
  } catch {
    return []
  }
}

/** Saves (or replaces, by name) and returns the new list. */
export function saveSearch(connId: string, item: SavedSearch): SavedSearch[] {
  const next = [...listSaved(connId).filter((s) => s.name !== item.name), item].sort(byName)
  localStorage.setItem(keyOf(connId), JSON.stringify(next))
  return next
}

export function deleteSaved(connId: string, name: string): SavedSearch[] {
  const next = listSaved(connId).filter((s) => s.name !== name)
  localStorage.setItem(keyOf(connId), JSON.stringify(next))
  return next
}
