import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { ClusterConnection, SaveConnectionPayload } from '@shared/types'

interface PersistedConnection extends Omit<ClusterConnection, 'hasSecret'> {
  /** Password encrypted with the OS vault (DPAPI / Keychain), base64. */
  secretEnc?: string
}

interface StoreFile {
  version: 1
  connections: PersistedConnection[]
}

/**
 * Connection registry persisted in userData. Secrets never leave the main
 * process: they are encrypted with Electron safeStorage at rest, and the
 * renderer only ever sees a hasSecret flag.
 */
export class ConnectionStore {
  private file: string
  private data: StoreFile

  constructor() {
    this.file = join(app.getPath('userData'), 'connections.json')
    this.data = this.load()
  }

  private load(): StoreFile {
    if (!existsSync(this.file)) return { version: 1, connections: [] }
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as StoreFile
    } catch (err) {
      console.error('Failed to read connections.json, starting empty:', err)
      return { version: 1, connections: [] }
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8')
  }

  list(): ClusterConnection[] {
    return this.data.connections.map(({ secretEnc, ...conn }) => ({
      ...conn,
      hasSecret: secretEnc !== undefined
    }))
  }

  get(id: string): ClusterConnection | undefined {
    return this.list().find((c) => c.id === id)
  }

  save(payload: SaveConnectionPayload): ClusterConnection {
    const { connection, secret } = payload
    const existing = this.data.connections.find((c) => c.id === connection.id)

    let secretEnc = existing?.secretEnc
    if (secret === null) {
      secretEnc = undefined
    } else if (typeof secret === 'string' && secret.length > 0) {
      secretEnc = this.encrypt(secret)
    }

    const persisted: PersistedConnection = { ...connection, secretEnc }
    if (existing) {
      this.data.connections = this.data.connections.map((c) => (c.id === connection.id ? persisted : c))
    } else {
      this.data.connections.push(persisted)
    }
    this.persist()
    return { ...connection, hasSecret: secretEnc !== undefined }
  }

  delete(id: string): void {
    this.data.connections = this.data.connections.filter((c) => c.id !== id)
    this.persist()
  }

  /** Decrypted secret for the transport layer only. */
  getSecret(id: string): string | undefined {
    const enc = this.data.connections.find((c) => c.id === id)?.secretEnc
    if (enc === undefined) return undefined
    return this.decrypt(enc)
  }

  private encrypt(plain: string): string {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(plain).toString('base64')
    }
    // Extremely rare on Windows/macOS; degrade loudly rather than fail.
    console.warn('safeStorage unavailable — storing secret obfuscated only')
    return `plain:${Buffer.from(plain, 'utf8').toString('base64')}`
  }

  private decrypt(enc: string): string {
    if (enc.startsWith('plain:')) {
      return Buffer.from(enc.slice('plain:'.length), 'base64').toString('utf8')
    }
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  }
}
