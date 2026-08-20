import m from 'mithril'
import { HttpTransport, KeyNotFoundError, SyncKv, type WatchEvent } from '@synckv/client'

const FAVORITES_KEY = 'synckv-admin:favorites'
const LAST_PREFIX_KEY = 'synckv-admin:last-prefix'

export type ConnectionState = 'connecting' | 'ready' | 'error'

/** Owns the SyncKv subscription and all view state for the admin console. */
export class AdminModel {
  readonly kv: SyncKv
  prefix = localStorage.getItem(LAST_PREFIX_KEY) ?? ''
  prefixInput = this.prefix
  keys: string[] = []
  selectedKey: string | undefined
  editorValue = ''
  originalValue = ''
  connection: ConnectionState = 'connecting'
  message = 'Connecting…'
  favorites = readFavorites()
  theme: 'light' | 'dark' = preferredTheme()
  creating = false
  createKeyInput = ''
  createValue = '{\n  \n}'
  createError = ''

  private stopWatching: (() => void) | undefined
  private generation = 0

  constructor() {
    const serverUrl = import.meta.env.VITE_SYNCKV_SERVER_URL ??
      `http://${window.location.hostname}:8787`
    this.kv = new SyncKv({
      dbName: 'synckv-admin',
      transport: new HttpTransport({ baseUrl: serverUrl }),
      syncIntervalMs: 15_000,
      onError: (error) => {
        this.connection = 'error'
        this.message = readableError(error)
        m.redraw()
      },
    })
    this.applyTheme()
  }

  get dirty(): boolean {
    return this.selectedKey !== undefined && this.editorValue !== this.originalValue
  }

  get currentIsFavorite(): boolean {
    return this.favorites.includes(this.prefix)
  }

  async start(): Promise<void> {
    await this.openPrefix(this.prefix)
  }

  async search(): Promise<void> {
    await this.openPrefix(this.prefixInput)
  }

  async openPrefix(nextPrefix: string): Promise<void> {
    // Prefixes are literal, so preserve whitespace rather than treating this as a
    // general-purpose text search.
    const next = nextPrefix
    const previous = this.prefix
    if (next !== previous && this.dirty && !window.confirm('Discard the unsaved JSON changes?')) {
      this.prefixInput = previous
      return
    }
    const request = ++this.generation
    this.connection = 'connecting'
    this.message = 'Synchronizing…'
    this.prefixInput = next
    m.redraw()

    try {
      // Subscribe before dropping the old prefix so changing searches never leaves
      // the editor without a valid local subscription.
      await this.kv.sync(next)
      await this.kv.synchronize()
      if (request !== this.generation) return
      if (previous !== next) await this.kv.unsync(previous)

      this.stopWatching?.()
      this.prefix = next
      localStorage.setItem(LAST_PREFIX_KEY, next)
      this.stopWatching = this.kv.watch(next, (event) => void this.onChange(event))
      this.keys = await this.kv.keys(next)
      this.connection = 'ready'
      this.message = `${this.keys.length} ${this.keys.length === 1 ? 'key' : 'keys'}`

      if (!this.selectedKey || !this.keys.includes(this.selectedKey)) {
        this.selectedKey = undefined
        this.editorValue = ''
        this.originalValue = ''
      }
    } catch (error) {
      if (request !== this.generation) return
      this.connection = 'error'
      this.message = readableError(error)
    }
    m.redraw()
  }

  async selectKey(key: string): Promise<void> {
    if (this.dirty && !window.confirm('Discard the unsaved JSON changes?')) return
    try {
      const value = await this.kv.get(key)
      this.selectedKey = key
      this.editorValue = JSON.stringify(value, null, 2)
      this.originalValue = this.editorValue
      this.message = 'Ready'
    } catch (error) {
      this.message = readableError(error)
      this.connection = 'error'
    }
    m.redraw()
  }

  beginCreate(): void {
    this.createKeyInput = this.prefix
    this.createValue = '{\n  \n}'
    this.createError = ''
    this.creating = true
  }

  cancelCreate(): void {
    this.creating = false
    this.createError = ''
  }

  async create(): Promise<void> {
    const key = this.createKeyInput
    try {
      if (!key) throw new Error('A key is required')
      if (!key.startsWith(this.prefix)) throw new Error(`Key must begin with “${this.prefix}”`)
      if (this.keys.includes(key)) throw new Error('That key already exists')
      const value: unknown = JSON.parse(this.createValue)
      this.connection = 'connecting'
      this.message = 'Creating…'
      this.createError = ''
      await this.kv.set(key, value)
      await this.kv.synchronize()
      this.creating = false
      this.selectedKey = key
      this.editorValue = JSON.stringify(value, null, 2)
      this.originalValue = this.editorValue
      this.connection = 'ready'
      this.message = 'Created'
    } catch (error) {
      this.connection = 'error'
      this.message = readableError(error)
      this.createError = error instanceof SyntaxError ? `Invalid JSON: ${error.message}` : readableError(error)
    }
    m.redraw()
  }

  async save(): Promise<void> {
    if (!this.selectedKey) return
    try {
      const value: unknown = JSON.parse(this.editorValue)
      this.connection = 'connecting'
      this.message = 'Saving…'
      await this.kv.set(this.selectedKey, value)
      await this.kv.synchronize()
      this.editorValue = JSON.stringify(value, null, 2)
      this.originalValue = this.editorValue
      this.connection = 'ready'
      this.message = 'Saved'
    } catch (error) {
      this.connection = 'error'
      this.message = error instanceof SyntaxError ? `Invalid JSON: ${error.message}` : readableError(error)
    }
    m.redraw()
  }

  async remove(): Promise<void> {
    const key = this.selectedKey
    if (!key || !window.confirm(`Delete “${key}”? This cannot be undone.`)) return
    try {
      await this.kv.delete(key)
      await this.kv.synchronize()
      this.selectedKey = undefined
      this.editorValue = ''
      this.originalValue = ''
      this.message = 'Deleted'
      this.connection = 'ready'
    } catch (error) {
      this.connection = 'error'
      this.message = readableError(error)
    }
    m.redraw()
  }

  toggleFavorite(): void {
    this.favorites = this.currentIsFavorite
      ? this.favorites.filter((item) => item !== this.prefix)
      : [...this.favorites, this.prefix].sort()
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(this.favorites))
  }

  toggleTheme(): void {
    this.theme = this.theme === 'dark' ? 'light' : 'dark'
    localStorage.setItem('synckv-admin:theme', this.theme)
    this.applyTheme()
  }

  async close(): Promise<void> {
    this.stopWatching?.()
    await this.kv.close()
  }

  private applyTheme(): void {
    document.documentElement.dataset.theme = this.theme
  }

  private async onChange(event: WatchEvent): Promise<void> {
    // Watchers run after atomic local commits. Remote SSE invalidations therefore
    // reach this view only once the new values are readable from IndexedDB.
    this.keys = await this.kv.keys(this.prefix)
    this.message = `${this.keys.length} ${this.keys.length === 1 ? 'key' : 'keys'}`
    this.connection = 'ready'

    if (event.key === this.selectedKey && !this.dirty) {
      try {
        const value = await this.kv.get(event.key)
        this.editorValue = JSON.stringify(value, null, 2)
        this.originalValue = this.editorValue
      } catch (error) {
        if (error instanceof KeyNotFoundError) {
          this.selectedKey = undefined
          this.editorValue = ''
          this.originalValue = ''
        } else {
          throw error
        }
      }
    }
    m.redraw()
  }
}

function preferredTheme(): 'light' | 'dark' {
  const stored = localStorage.getItem('synckv-admin:theme')
  if (stored === 'light' || stored === 'dark') return stored
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function readFavorites(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? '[]')
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : []
  } catch {
    return []
  }
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
