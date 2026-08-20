import m from 'mithril'
import './style.css'
import { JsonEditor } from './json-editor.js'
import { AdminModel } from './model.js'

const model = new AdminModel()

const App: m.Component = {
  oncreate() {
    window.addEventListener('keydown', saveShortcut)
    window.addEventListener('pagehide', close, { once: true })
  },

  onremove() {
    window.removeEventListener('keydown', saveShortcut)
    window.removeEventListener('pagehide', close)
  },

  view() {
    return m('main.app-shell', [
      m('aside.sidebar', [
        m('.brand', [m('.brand-mark', 'S'), m('.brand-copy', [m('strong', 'SyncKv'), m('span', 'Admin')])]),
        m('.sidebar-section', [
          m('.section-label', 'Favorites'),
          model.favorites.length === 0
            ? m('p.sidebar-empty', 'Favorite a prefix for quick access.')
            : model.favorites.map((prefix) => m('button.favorite', {
                class: prefix === model.prefix ? 'active' : '',
                onclick: () => void model.openPrefix(prefix),
                title: prefix || 'All keys',
              }, [m('span.star', '★'), m('span', prefix || 'All keys')])),
        ]),
        m('.sidebar-footer', [
          m('button.icon-button', {
            onclick: () => model.toggleTheme(),
            title: `Use ${model.theme === 'dark' ? 'light' : 'dark'} mode`,
            'aria-label': `Use ${model.theme === 'dark' ? 'light' : 'dark'} mode`,
          }, model.theme === 'dark' ? '☀' : '◐'),
          m('span', model.theme === 'dark' ? 'Dark mode' : 'Light mode'),
        ]),
      ]),

      m('section.workspace', [
        m('header.toolbar', [
          m('form.prefix-search', {
            onsubmit: (event: SubmitEvent) => {
              event.preventDefault()
              void model.search()
            },
          }, [
            m('span.search-icon', '⌕'),
            m('input', {
              value: model.prefixInput,
              oninput: (event: InputEvent) => {
                void model.openPrefix((event.target as HTMLInputElement).value)
              },
              placeholder: 'Search keys by prefix or text…',
              'aria-label': 'Search keys',
              spellcheck: false,
            }),
            m('kbd', 'Enter'),
          ]),
          m('button.icon-button.favorite-toggle', {
            class: model.currentIsFavorite ? 'selected' : '',
            onclick: () => model.toggleFavorite(),
            title: model.currentIsFavorite ? 'Remove favorite' : 'Favorite this prefix',
            'aria-label': model.currentIsFavorite ? 'Remove favorite' : 'Favorite this prefix',
          }, model.currentIsFavorite ? '★' : '☆'),
        ]),

        m('.content-grid', [
          m('section.key-browser', [
            m('.pane-heading', [
              m('div', [m('h1', model.prefix || 'All keys'), m('span.count', String(model.keys.length))]),
              m('button.button.compact', { onclick: () => model.beginCreate() }, '+ New key'),
            ]),
            m('.key-list', model.keys.length === 0
              ? m('.empty-list', [m('span', '⌁'), m('p', 'No matching keys')])
              : model.keys.map((key) => m('button.key-row', {
                  class: key === model.selectedKey ? 'selected' : '',
                  key,
                  onclick: () => void model.selectKey(key),
                  title: key,
                }, [m('span.key-glyph', '{}'), m('span.key-name', key)]))),
          ]),

          m('section.value-pane', model.selectedKey
            ? [
                m('.editor-heading', [
                  m('.key-title', [m('span.eyebrow', 'JSON value'), m('h2', model.selectedKey)]),
                  m('.editor-actions', [
                    m('button.button.danger', { onclick: () => void model.remove() }, 'Delete'),
                    m('button.button.primary', {
                      disabled: !model.dirty || model.connection === 'connecting',
                      onclick: () => void model.save(),
                    }, 'Save'),
                  ]),
                ]),
                m(JsonEditor, {
                  value: model.editorValue,
                  onChange: (value) => {
                    model.editorValue = value
                    m.redraw()
                  },
                  onSave: () => void model.save(),
                }),
              ]
            : m('.empty-editor', [
                m('.empty-icon', '{}'),
                m('h2', 'Select a key'),
                m('p', 'Choose a key from the list to inspect and edit its JSON value.'),
              ])),
        ]),

        m('footer.statusbar', [
          m('span.connection', { class: model.connection }, [m('i'), model.message]),
          m('span', import.meta.env.VITE_SYNCKV_SERVER_URL ?? (import.meta.env.DEV
            ? `${window.location.hostname}:8787`
            : window.location.host)),
          model.dirty ? m('span.unsaved', 'Unsaved changes') : null,
        ]),
      ]),

      model.creating ? m('.dialog-backdrop', {
        onclick: (event: MouseEvent) => {
          if (event.target === event.currentTarget) model.cancelCreate()
        },
      }, m('section.create-dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'create-title' }, [
        m('.dialog-heading', [
          m('div', [m('span.eyebrow', 'New record'), m('h2#create-title', 'Create key')]),
          m('button.icon-button', { onclick: () => model.cancelCreate(), 'aria-label': 'Close dialog' }, '×'),
        ]),
        m('.dialog-fields', [
          m('label.key-field', [
            m('span', 'Key'),
            m('input', {
              value: model.createKeyInput,
              oninput: (event: InputEvent) => {
                model.createKeyInput = (event.target as HTMLInputElement).value
                model.createError = ''
              },
              oncreate: (vnode: m.VnodeDOM) => (vnode.dom as HTMLInputElement).focus(),
              spellcheck: false,
              placeholder: model.prefix || 'namespace/key',
            }),
          ]),
          m('label.editor-label', 'JSON value'),
          m('.create-editor', m(JsonEditor, {
            value: model.createValue,
            onChange: (value) => {
              model.createValue = value
              model.createError = ''
              m.redraw()
            },
            onSave: () => void model.create(),
          })),
          model.createError ? m('p.dialog-error', model.createError) : null,
        ]),
        m('.dialog-actions', [
          m('button.button', { onclick: () => model.cancelCreate() }, 'Cancel'),
          m('button.button.primary', {
            disabled: model.connection === 'connecting',
            onclick: () => void model.create(),
          }, 'Create key'),
        ]),
      ])) : null,
    ])
  },
}

function saveShortcut(event: KeyboardEvent): void {
  if (event.key === 'Escape' && model.creating) {
    model.cancelCreate()
    m.redraw()
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    if (model.creating) void model.create()
    else if (model.dirty) void model.save()
  }
}

function close(): void {
  void model.close()
}

const root = document.querySelector<HTMLElement>('#app')
if (!root) throw new Error('Missing #app mount point')

function route(mode: 'all' | 'prefix' | 'key'): m.RouteResolver<Record<string, string | undefined>> {
  return {
    async onmatch(params) {
      await model.start()
      if (mode === 'prefix') await model.openPrefix(String(params.prefix ?? ''), false)
      if (mode === 'key') {
        const key = String(params.key ?? '')
        // Showing the key itself as the search keeps the surrounding list focused
        // while preserving a stable URL for browser refresh and sharing.
        await model.openPrefix(key, false)
        await model.selectKey(key, false)
      }
      if (mode === 'all') await model.openPrefix('', false)
      return App
    },
  }
}

// Clean history URLs are rooted below the server's /admin mount. The server falls
// back to index.html for these paths, allowing direct links and page refreshes.
m.route.prefix = '/admin'
m.route(root, '/', {
  '/': route('all'),
  '/prefix/:prefix...': route('prefix'),
  '/key/:key...': route('key'),
})
