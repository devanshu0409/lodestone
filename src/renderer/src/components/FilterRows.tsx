import { Plus, X } from 'lucide-react'
import type { MappedField } from '../lib/api'
import { OPS, VALUELESS, newRow, type Conj, type FilterRow, type Op } from '../lib/filterQuery'

/**
 * The structured filter-row builder (field / operator / value joined by
 * AND/OR), shared by the Search tab and the Aggregations tab.
 */
export function FilterRows({
  rows,
  onChange,
  fields,
  onEnter
}: {
  rows: FilterRow[]
  onChange: (rows: FilterRow[]) => void
  fields: MappedField[]
  /** Pressing Enter in a value input (e.g. run the search). */
  onEnter?: () => void
}): React.JSX.Element {
  const patch = (id: number, p: Partial<FilterRow>): void =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...p } : r)))

  return (
    <div className="filter-rows">
      {rows.map((row, i) => (
        <div key={row.id} className="filter-row">
          {i === 0 ? (
            <span className="conj-lead mono">where</span>
          ) : (
            <select
              className="input mono conj-select"
              value={row.conj}
              onChange={(e) => patch(row.id, { conj: e.target.value as Conj })}
            >
              <option value="AND">AND</option>
              <option value="OR">OR</option>
            </select>
          )}
          <select
            className="input mono"
            style={{ flex: 2 }}
            value={row.field}
            onChange={(e) => patch(row.id, { field: e.target.value })}
          >
            <option value="">— field —</option>
            {fields.map((f) => (
              <option key={f.path} value={f.path}>
                {f.path} ({f.type})
              </option>
            ))}
          </select>
          <select
            className="input mono"
            style={{ width: 110 }}
            value={row.op}
            onChange={(e) => patch(row.id, { op: e.target.value as Op })}
          >
            {OPS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          {!VALUELESS.has(row.op) && (
            <input
              className="input mono"
              style={{ flex: 3 }}
              placeholder="value"
              value={row.value}
              onChange={(e) => patch(row.id, { value: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && onEnter?.()}
            />
          )}
          <button
            className="icon-btn"
            title="Remove filter"
            onClick={() => onChange(rows.length > 1 ? rows.filter((r) => r.id !== row.id) : [newRow()])}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <button
        className="btn ghost"
        style={{ alignSelf: 'flex-start' }}
        onClick={() => onChange([...rows, newRow()])}
      >
        <Plus size={12} />
        Add filter
      </button>
    </div>
  )
}
