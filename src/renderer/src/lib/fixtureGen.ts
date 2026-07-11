import type { MappingRoot, MappingProperty } from './codegen'

/* ------------------------------------------------------------------ *
 * Fixture data generator — infers plausible values from field types
 * and names, faker-style. Produces NDJSON ready for _bulk.
 * ------------------------------------------------------------------ */

type RNG = () => number

function makeRng(seed: number): RNG {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 0x100000000
    return s / 0x100000000
  }
}

const pick = <T>(rng: RNG, arr: T[]): T => arr[Math.floor(rng() * arr.length)]
const intIn = (rng: RNG, min: number, max: number): number => Math.floor(rng() * (max - min + 1)) + min
const floatIn = (rng: RNG, min: number, max: number): number => rng() * (max - min) + min

/* ---------- name-based inference ---------- */

const NAME_HINTS: Record<string, (rng: RNG) => unknown> = {
  email: (rng) => `${pick(rng, ['alice', 'bob', 'carol', 'dave', 'eve', 'frank', 'grace', 'henry'])}@${pick(rng, ['example.com', 'test.io', 'dev.net', 'mail.org'])}`,
  username: (rng) => pick(rng, ['alice_dev', 'bob_test', 'carol_admin', 'dave_user', 'eve_ops']),
  name: (rng) => pick(rng, ['Alice Johnson', 'Bob Smith', 'Carol Williams', 'Dave Brown', 'Eve Davis', 'Frank Miller', 'Grace Lee', 'Henry Wilson']),
  firstname: (rng) => pick(rng, ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace', 'Henry']),
  lastname: (rng) => pick(rng, ['Johnson', 'Smith', 'Williams', 'Brown', 'Davis', 'Miller', 'Lee', 'Wilson']),
  fullname: (rng) => pick(rng, ['Alice Johnson', 'Bob Smith', 'Carol Williams', 'Dave Brown']),
  phone: (rng) => `+1-${intIn(rng, 200, 999)}-${intIn(rng, 200, 999)}-${intIn(rng, 1000, 9999)}`,
  address: (rng) => `${intIn(rng, 100, 9999)} ${pick(rng, ['Main St', 'Oak Ave', 'Pine Rd', 'Elm Dr', 'Cedar Ln'])}`,
  city: (rng) => pick(rng, ['New York', 'San Francisco', 'Seattle', 'Austin', 'Boston', 'Chicago', 'Denver']),
  state: (rng) => pick(rng, ['CA', 'NY', 'TX', 'WA', 'MA', 'IL', 'CO', 'OR']),
  country: (rng) => pick(rng, ['US', 'UK', 'CA', 'AU', 'DE', 'FR', 'JP', 'IN']),
  zipcode: (rng) => String(intIn(rng, 10000, 99999)),
  zip: (rng) => String(intIn(rng, 10000, 99999)),
  url: (rng) => `https://${pick(rng, ['example', 'test', 'demo'])}.${pick(rng, ['com', 'io', 'org'])}/${pick(rng, ['page', 'post', 'article'])}/${intIn(rng, 1, 1000)}`,
  title: (rng) => pick(rng, ['Senior Engineer', 'Product Manager', 'Data Analyst', 'DevOps Lead', 'QA Specialist', 'UX Designer']),
  description: (rng) => pick(rng, [
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
    'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
    'Ut enim ad minim veniam, quis nostrud exercitation ullamco.',
    'Duis aute irure dolor in reprehenderit in voluptate velit esse.',
  ]),
  status: (rng) => pick(rng, ['active', 'inactive', 'pending', 'deleted', 'draft']),
  type: (rng) => pick(rng, ['type_a', 'type_b', 'type_c']),
  category: (rng) => pick(rng, ['books', 'electronics', 'clothing', 'food', 'tools', 'software']),
  tag: (rng) => pick(rng, ['urgent', 'normal', 'low', 'high', 'critical']),
  tags: (rng) => [pick(rng, ['urgent', 'normal', 'low']), pick(rng, ['red', 'blue', 'green'])],
  price: (rng) => Number(floatIn(rng, 0.99, 999.99).toFixed(2)),
  amount: (rng) => Number(floatIn(rng, 1, 10000).toFixed(2)),
  quantity: (rng) => intIn(rng, 1, 1000),
  count: (rng) => intIn(rng, 0, 500),
  age: (rng) => intIn(rng, 18, 85),
  timestamp: (rng) => new Date(intIn(rng, 1262304000, 1893456000) * 1000).toISOString(),
  created: (rng) => new Date(intIn(rng, 1262304000, 1893456000) * 1000).toISOString(),
  updated: (rng) => new Date(intIn(rng, 1262304000, 1893456000) * 1000).toISOString(),
  modified: (rng) => new Date(intIn(rng, 1262304000, 1893456000) * 1000).toISOString(),
  date: (rng) => new Date(intIn(rng, 1262304000, 1893456000) * 1000).toISOString().slice(0, 10),
  birthdate: (rng) => new Date(intIn(rng, 1262304000, 1893456000) * 1000).toISOString().slice(0, 10),
  company: (rng) => pick(rng, ['Acme Corp', 'Globex Inc', 'Initech', 'Umbrella LLC', 'Stark Industries', 'Wayne Enterprises']),
  organization: (rng) => pick(rng, ['Acme Corp', 'Globex Inc', 'Initech', 'Umbrella LLC']),
  org: (rng) => pick(rng, ['Acme Corp', 'Globex Inc', 'Initech', 'Umbrella LLC']),
  department: (rng) => pick(rng, ['Engineering', 'Sales', 'Marketing', 'HR', 'Finance', 'Operations']),
  role: (rng) => pick(rng, ['admin', 'user', 'manager', 'viewer', 'editor']),
  gender: (rng) => pick(rng, ['male', 'female', 'other']),
  boolean: (rng) => rng() > 0.5,
  active: (rng) => rng() > 0.3,
  enabled: (rng) => rng() > 0.3,
  deleted: (rng) => rng() > 0.8,
  verified: (rng) => rng() > 0.4,
  ip: (rng) => `${intIn(rng, 1, 255)}.${intIn(rng, 0, 255)}.${intIn(rng, 0, 255)}.${intIn(rng, 0, 255)}`,
  ipaddress: (rng) => `${intIn(rng, 1, 255)}.${intIn(rng, 0, 255)}.${intIn(rng, 0, 255)}.${intIn(rng, 0, 255)}`,
  hostname: (rng) => `${pick(rng, ['web', 'db', 'cache', 'app', 'worker'])}-${intIn(rng, 1, 20)}.${pick(rng, ['internal', 'local', 'cluster'])}`,
  uuid: (rng) => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(rng() * 16)
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  }),
  id: (rng) => String(intIn(rng, 1, 100000)),
  message: (rng) => pick(rng, [
    'Hello world',
    'Operation completed successfully',
    'Warning: threshold exceeded',
    'Connection established',
    'Task queued for processing',
  ]),
  content: (rng) => pick(rng, [
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
    'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
    'Ut enim ad minim veniam, quis nostrud exercitation ullamco.',
  ]),
  note: (rng) => pick(rng, ['Important note', 'Follow up later', 'Reviewed and approved', 'Needs attention']),
  label: (rng) => pick(rng, ['label_a', 'label_b', 'label_c', 'label_d']),
  code: (rng) => pick(rng, ['ABC123', 'XYZ789', 'DEF456', 'GHI012', 'JKL345']),
  version: (rng) => `${intIn(rng, 1, 5)}.${intIn(rng, 0, 12)}.${intIn(rng, 0, 99)}`,
  color: (rng) => pick(rng, ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'black', 'white']),
  language: (rng) => pick(rng, ['en', 'es', 'fr', 'de', 'ja', 'zh', 'pt', 'hi']),
  currency: (rng) => pick(rng, ['USD', 'EUR', 'GBP', 'JPY', 'INR', 'AUD', 'CAD']),
}

function nameHint(fieldName: string, rng: RNG): unknown | undefined {
  const lower = fieldName.toLowerCase().replace(/[^a-z]/g, '')
  // Direct match
  if (NAME_HINTS[lower]) return NAME_HINTS[lower](rng)
  // Contains match
  for (const key of Object.keys(NAME_HINTS)) {
    if (lower.includes(key)) return NAME_HINTS[key](rng)
  }
  return undefined
}

/* ---------- type-based generation ---------- */

function genForType(prop: MappingProperty, rng: RNG, fieldName: string): unknown {
  // Check name hints first — they're more specific
  const hint = nameHint(fieldName, rng)
  if (hint !== undefined) return hint

  const type = prop.type ?? 'text'

  switch (type) {
    case 'text':
    case 'match_only_text':
      return pick(rng, [
        'Lorem ipsum dolor sit amet',
        'Quick brown fox jumps over the lazy dog',
        'The quick brown fox',
        'Sample text content for testing',
        'Hello world example',
      ])

    case 'keyword':
      return `${fieldName}_${intIn(rng, 1, 20)}`

    case 'long':
    case 'integer':
      return intIn(rng, 0, 100000)

    case 'short':
      return intIn(rng, 0, 32767)

    case 'byte':
      return intIn(rng, 0, 127)

    case 'unsigned_long':
      return intIn(rng, 0, 4294967295)

    case 'float':
      return Number(floatIn(rng, 0, 1000).toFixed(2))

    case 'double':
      return Number(floatIn(rng, 0, 100000).toFixed(4))

    case 'scaled_float': {
      const factor = prop.scaling_factor ?? 100
      return Number(floatIn(rng, 0, 1000).toFixed(Math.log10(factor)))
    }

    case 'boolean':
      return rng() > 0.5

    case 'date':
      return new Date(intIn(rng, 1262304000, 1893456000) * 1000).toISOString()

    case 'date_nanos':
      return new Date(intIn(rng, 1262304000, 1893456000) * 1000).toISOString()

    case 'ip':
      return `${intIn(rng, 1, 255)}.${intIn(rng, 0, 255)}.${intIn(rng, 0, 255)}.${intIn(rng, 0, 255)}`

    case 'geo_point':
      return {
        lat: Number(floatIn(rng, -90, 90).toFixed(6)),
        lon: Number(floatIn(rng, -180, 180).toFixed(6)),
      }

    case 'geo_shape':
      return {
        type: 'point',
        coordinates: [Number(floatIn(rng, -180, 180).toFixed(6)), Number(floatIn(rng, -90, 90).toFixed(6))],
      }

    case 'object':
    case 'nested': {
      if (prop.enabled === false) return {}
      const subProps = prop.properties ?? {}
      const obj: Record<string, unknown> = {}
      for (const [subName, subProp] of Object.entries(subProps)) {
        obj[subName] = genForType(subProp, rng, subName)
      }
      return obj
    }

    case 'flattened':
      return { [`${fieldName}_key`]: pick(rng, ['value_a', 'value_b', 'value_c']) }

    case 'binary':
      return btoa(String.fromCharCode(...Array.from({ length: 16 }, () => intIn(rng, 0, 255))))

    case 'integer_range':
    case 'float_range':
    case 'long_range':
    case 'double_range':
    case 'date_range':
      return {
        gte: type === 'date_range' ? new Date(intIn(rng, 1262304000, 1577836800) * 1000).toISOString() : intIn(rng, 0, 500),
        lte: type === 'date_range' ? new Date(intIn(rng, 1577836800, 1893456000) * 1000).toISOString() : intIn(rng, 500, 1000),
      }

    case 'ip_range':
      return {
        gte: `${intIn(rng, 1, 255)}.${intIn(rng, 0, 255)}.${intIn(rng, 0, 255)}.0`,
        lte: `${intIn(rng, 1, 255)}.${intIn(rng, 0, 255)}.${intIn(rng, 0, 255)}.255`,
      }

    case 'percolator':
      return { query: { match: { [fieldName]: pick(rng, ['test', 'sample', 'demo']) } } }

    case 'completion':
      return { input: [pick(rng, ['suggestion_a', 'suggestion_b', 'suggestion_c'])] }

    case 'search_as_you_type':
      return pick(rng, ['searchable text example', 'type ahead content'])

    case 'token_count':
      return intIn(rng, 1, 50)

    case 'rank_feature':
      return floatIn(rng, 0, 100)

    case 'dense_vector':
      return Array.from({ length: 10 }, () => Number(floatIn(rng, -1, 1).toFixed(4)))

    case 'sparse_vector':
      return { [`${intIn(rng, 0, 99)}`]: Number(floatIn(rng, -1, 1).toFixed(4)) }

    case 'alias':
      return undefined

    case 'annotated_text':
      return pick(rng, ['annotated [text](entity)', 'sample [content](tag)'])

    default:
      return null
  }
}

/* ---------- multi-field handling ---------- */

function genDoc(
  properties: Record<string, MappingProperty>,
  rng: RNG
): Record<string, unknown> {
  const doc: Record<string, unknown> = {}
  for (const [fieldName, prop] of Object.entries(properties)) {
    // Skip multi-field sub-fields — they're indexed variants of the parent
    if (prop.type === 'alias') continue
    const value = genForType(prop, rng, fieldName)
    if (value !== undefined) doc[fieldName] = value
  }
  return doc
}

/* ---------- public API ---------- */

export interface FixtureOptions {
  count: number
  seed?: number
}

export interface FixtureResult {
  /** NDJSON string ready for _bulk API */
  ndjson: string
  /** First few sample docs for preview */
  samples: Record<string, unknown>[]
}

export function generateFixtures(
  mapping: MappingRoot,
  options: FixtureOptions
): FixtureResult {
  const rng = makeRng(options.seed ?? Date.now())
  const props = mapping.properties ?? {}
  const lines: string[] = []
  const samples: Record<string, unknown>[] = []

  for (let i = 0; i < options.count; i++) {
    const doc = genDoc(props, rng)
    if (i < 5) samples.push(doc)
    const action = JSON.stringify({ index: { _id: i + 1 } })
    const source = JSON.stringify(doc)
    lines.push(action, source)
  }

  return {
    ndjson: lines.join('\n') + '\n',
    samples,
  }
}
