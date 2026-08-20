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
  private allKeys: string[] = []
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
  private startPromise: Promise<void> | undefined

  constructor() {
    const serverUrl = import.meta.env.VITE_SYNCKV_SERVER_URL ?? (import.meta.env.DEV
      ? `http://${window.location.hostname}:8787`
      : window.location.origin)
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

  start(): Promise<void> {
    // Route changes reuse one model and must not open duplicate SSE listeners.
    return this.startPromise ??= this.initialize()
  }

  private async initialize(): Promise<void> {
    const request = ++this.generation
    this.connection = 'connecting'
    this.message = 'Synchronizing key index…'
    try {
      // The admin console subscribes to the root prefix once. This gives it a live
      // local key index, so both prefix and contains searches are instant and SSE
      // invalidations update the current result without polling.
      await this.kv.sync('')
      // Remove the last narrow subscription left by older admin versions. The root
      // subscription still covers its records, so this does not evict values.
      if (this.prefix) await this.kv.unsync(this.prefix)
      await this.kv.synchronize()
      if (request !== this.generation) return
      this.stopWatching = this.kv.watch('', (event) => void this.onChange(event))
      this.allKeys = await this.kv.keys('')
      this.applySearch(this.prefix)
      this.connection = 'ready'
    } catch (error) {
      this.connection = 'error'
      this.message = readableError(error)
    }
    m.redraw()
  }

  async search(): Promise<void> {
    await this.openPrefix(this.prefixInput)
  }

  async openPrefix(query: string, navigate = true): Promise<void> {
    // Search is local once the root key index has synchronized, so it is cheap
    // enough to run for every input event without debounce or network races.
    this.prefixInput = query
    this.prefix = query
    localStorage.setItem(LAST_PREFIX_KEY, query)
    this.applySearch(query)
    if (navigate) m.route.set(query ? '/prefix/:prefix...' : '/', { prefix: query }, { replace: true })
    m.redraw()
  }

  async selectKey(key: string, navigate = true): Promise<void> {
    if (this.dirty && !window.confirm('Discard the unsaved JSON changes?')) return
    try {
      const value = await this.kv.get(key)
      this.selectedKey = key
      this.editorValue = JSON.stringify(value, null, 2)
      this.originalValue = this.editorValue
      this.message = 'Ready'
      if (navigate) m.route.set('/key/:key...', { key })
    } catch (error) {
      this.message = readableError(error)
      this.connection = 'error'
    }
    m.redraw()
  }

  beginCreate(): void {
    // Reuse the query only when it is a real key prefix. A contains search such as
    // "companies" should not produce an accidentally root-level key.
    this.createKeyInput = this.allKeys.some((key) => key.startsWith(this.prefix)) ? this.prefix : ''
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
      if (this.allKeys.includes(key)) throw new Error('That key already exists')
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
      m.route.set('/key/:key...', { key })
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
      m.route.set(this.prefix ? '/prefix/:prefix...' : '/', { prefix: this.prefix })
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
    this.allKeys = await this.kv.keys('')
    this.applySearch(this.prefix)
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

  private applySearch(query: string): void {
    const needle = query.toLocaleLowerCase()
    this.keys = needle
      ? this.allKeys.filter((key) => key.toLocaleLowerCase().includes(needle))
      : [...this.allKeys]
    // True prefix matches are the most likely intent; contains matches such as
    // "companies" → "dividends/companies/*" follow immediately afterward.
    this.keys.sort((left, right) => {
      const leftPrefix = left.toLocaleLowerCase().startsWith(needle)
      const rightPrefix = right.toLocaleLowerCase().startsWith(needle)
      return Number(rightPrefix) - Number(leftPrefix) || left.localeCompare(right)
    })
    this.message = needle
      ? `${this.keys.length} of ${this.allKeys.length} keys`
      : `${this.allKeys.length} ${this.allKeys.length === 1 ? 'key' : 'keys'}`
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
