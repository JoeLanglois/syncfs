import m from 'mithril'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { json } from '@codemirror/lang-json'
import { bracketMatching, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { tags } from '@lezer/highlight'
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'

type EditorAttrs = {
  value: string
  onChange(value: string): void
  onSave?(): void
}

const jsonHighlight = HighlightStyle.define([
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syntax-string)' },
  { tag: tags.propertyName, color: 'var(--syntax-property)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syntax-literal)' },
  { tag: tags.invalid, color: 'var(--destructive)', textDecoration: 'underline' },
])

/** A small Mithril adapter around CodeMirror's JSON-aware editor. */
export const JsonEditor: m.Component<EditorAttrs> = {
  oncreate(vnode) {
    const attrs = vnode.attrs
    const view = new EditorView({
      parent: vnode.dom as HTMLElement,
      state: EditorState.create({
        doc: attrs.value,
        extensions: [
          lineNumbers(),
          drawSelection(),
          highlightActiveLine(),
          history(),
          json(),
          indentUnit.of('  '),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          syntaxHighlighting(jsonHighlight),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                attrs.onSave?.()
                return true
              },
            },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            'aria-label': 'JSON value editor',
            spellcheck: 'false',
            autocapitalize: 'off',
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) attrs.onChange(update.state.doc.toString())
          }),
        ],
      }),
    })
    ;(vnode.state as { view?: EditorView }).view = view
  },

  onupdate(vnode) {
    const view = (vnode.state as { view?: EditorView }).view
    if (!view || view.state.doc.toString() === vnode.attrs.value) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: vnode.attrs.value } })
  },

  onremove(vnode) {
    ;(vnode.state as { view?: EditorView }).view?.destroy()
  },

  view() {
    return m('.json-editor')
  },
}
