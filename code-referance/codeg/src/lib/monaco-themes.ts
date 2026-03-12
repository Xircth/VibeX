"use client"

import { useEffect, useState } from "react"
import type { BeforeMount } from "@monaco-editor/react"

export const MONACO_LIGHT_THEME = "codeg-light"
export const MONACO_DARK_THEME = "codeg-dark"

export const monacoTokenRules = {
  light: [
    { token: "diff.header", foreground: "52525B", fontStyle: "bold" },
    { token: "diff.meta", foreground: "71717A" },
    { token: "diff.range", foreground: "0369A1", fontStyle: "bold" },
    { token: "diff.file", foreground: "334155" },
    { token: "diff.inserted", foreground: "166534" },
    { token: "diff.deleted", foreground: "991B1B" },
    { token: "diff.context", foreground: "3F3F46" },
  ],
  dark: [
    { token: "diff.header", foreground: "D4D4D8", fontStyle: "bold" },
    { token: "diff.meta", foreground: "A1A1AA" },
    { token: "diff.range", foreground: "7DD3FC", fontStyle: "bold" },
    { token: "diff.file", foreground: "D4D4D8" },
    { token: "diff.inserted", foreground: "86EFAC" },
    { token: "diff.deleted", foreground: "FDA4AF" },
    { token: "diff.context", foreground: "E4E4E7" },
  ],
}

export const monacoThemeColors = {
  light: {
    focusBorder: "#a1a1aa",
    "editor.background": "#ffffff",
    "editor.foreground": "#09090b",
    "editorGutter.background": "#ffffff",
    "editorLineNumber.foreground": "#a1a1aa",
    "editorLineNumber.activeForeground": "#18181b",
    "editor.lineHighlightBackground": "#f4f4f5",
    "editor.selectionBackground": "#e4e4e7",
    "editor.inactiveSelectionBackground": "#f4f4f5",
    "editorWidget.background": "#ffffff",
    "editorWidget.foreground": "#09090b",
    "editorWidget.border": "#e4e4e7",
    "editorHoverWidget.background": "#ffffff",
    "editorHoverWidget.foreground": "#09090b",
    "editorHoverWidget.border": "#e4e4e7",
    "editorHoverWidget.statusBarBackground": "#f4f4f5",
    "editorSuggestWidget.background": "#ffffff",
    "editorSuggestWidget.border": "#e4e4e7",
    "editorSuggestWidget.foreground": "#09090b",
    "editorSuggestWidget.highlightForeground": "#18181b",
    "editorSuggestWidget.selectedBackground": "#f4f4f5",
    "menu.background": "#ffffff",
    "menu.foreground": "#09090b",
    "menu.selectionBackground": "#f4f4f5",
    "menu.selectionForeground": "#09090b",
    "menu.separatorBackground": "#e4e4e7",
    "menu.border": "#e4e4e7",
    "input.background": "#ffffff",
    "input.foreground": "#09090b",
    "input.border": "#e4e4e7",
    "dropdown.background": "#ffffff",
    "dropdown.foreground": "#09090b",
    "dropdown.border": "#e4e4e7",
    "list.hoverBackground": "#f4f4f5",
    "list.activeSelectionBackground": "#f4f4f5",
    "list.activeSelectionForeground": "#09090b",
    "list.inactiveSelectionBackground": "#f4f4f5",
    "list.inactiveSelectionForeground": "#09090b",
    "list.focusOutline": "#a1a1aa",
    "peekView.border": "#e4e4e7",
    "peekViewEditor.background": "#ffffff",
    "peekViewEditor.matchHighlightBackground": "#e4e4e7",
    "peekViewEditorGutter.background": "#ffffff",
    "peekViewResult.background": "#ffffff",
    "peekViewResult.fileForeground": "#09090b",
    "peekViewResult.lineForeground": "#71717a",
    "peekViewResult.matchHighlightBackground": "#e4e4e7",
    "peekViewResult.selectionBackground": "#f4f4f5",
    "peekViewResult.selectionForeground": "#09090b",
    "peekViewTitle.background": "#f4f4f5",
    "peekViewTitleLabel.foreground": "#09090b",
    "peekViewTitleDescription.foreground": "#71717a",
  },
  dark: {
    focusBorder: "#71717a",
    "editor.background": "#171717",
    "editor.foreground": "#fafafa",
    "editorGutter.background": "#171717",
    "editorLineNumber.foreground": "#71717a",
    "editorLineNumber.activeForeground": "#fafafa",
    "editor.lineHighlightBackground": "#27272a",
    "editor.selectionBackground": "#3f3f46",
    "editor.inactiveSelectionBackground": "#27272a",
    "editorWidget.background": "#18181b",
    "editorWidget.foreground": "#fafafa",
    "editorWidget.border": "#27272a",
    "editorHoverWidget.background": "#18181b",
    "editorHoverWidget.foreground": "#fafafa",
    "editorHoverWidget.border": "#27272a",
    "editorHoverWidget.statusBarBackground": "#27272a",
    "editorSuggestWidget.background": "#18181b",
    "editorSuggestWidget.border": "#27272a",
    "editorSuggestWidget.foreground": "#fafafa",
    "editorSuggestWidget.highlightForeground": "#ffffff",
    "editorSuggestWidget.selectedBackground": "#27272a",
    "menu.background": "#18181b",
    "menu.foreground": "#fafafa",
    "menu.selectionBackground": "#27272a",
    "menu.selectionForeground": "#fafafa",
    "menu.separatorBackground": "#3f3f46",
    "menu.border": "#27272a",
    "input.background": "#18181b",
    "input.foreground": "#fafafa",
    "input.border": "#27272a",
    "dropdown.background": "#18181b",
    "dropdown.foreground": "#fafafa",
    "dropdown.border": "#27272a",
    "list.hoverBackground": "#27272a",
    "list.activeSelectionBackground": "#27272a",
    "list.activeSelectionForeground": "#fafafa",
    "list.inactiveSelectionBackground": "#27272a",
    "list.inactiveSelectionForeground": "#fafafa",
    "list.focusOutline": "#71717a",
    "peekView.border": "#27272a",
    "peekViewEditor.background": "#171717",
    "peekViewEditor.matchHighlightBackground": "#3f3f46",
    "peekViewEditorGutter.background": "#171717",
    "peekViewResult.background": "#18181b",
    "peekViewResult.fileForeground": "#fafafa",
    "peekViewResult.lineForeground": "#a1a1aa",
    "peekViewResult.matchHighlightBackground": "#3f3f46",
    "peekViewResult.selectionBackground": "#27272a",
    "peekViewResult.selectionForeground": "#fafafa",
    "peekViewTitle.background": "#27272a",
    "peekViewTitleLabel.foreground": "#fafafa",
    "peekViewTitleDescription.foreground": "#a1a1aa",
  },
}

export const defineDiffLanguage: BeforeMount = (monaco) => {
  const hasDiffLanguage = monaco.languages
    .getLanguages()
    .some((language: { id: string }) => language.id === "diff")

  if (!hasDiffLanguage) {
    monaco.languages.register({ id: "diff" })
  }

  monaco.languages.setMonarchTokensProvider("diff", {
    defaultToken: "diff.context",
    tokenizer: {
      root: [
        [/^diff --git .*$/, "diff.header"],
        [/^index .*$/, "diff.meta"],
        [/^@@ .*@@.*$/, "diff.range"],
        [/^(?:\+\+\+|---) .*$/, "diff.file"],
        [/^\+.*$/, "diff.inserted"],
        [/^-.*$/, "diff.deleted"],
        [/^\\ No newline at end of file$/, "diff.meta"],
        [/^Binary files .* differ$/, "diff.meta"],
        [/^.*$/, "diff.context"],
      ],
    },
  })
}

export const defineMonacoThemes: BeforeMount = (monaco) => {
  defineDiffLanguage(monaco)

  monaco.editor.defineTheme(MONACO_LIGHT_THEME, {
    base: "vs",
    inherit: true,
    rules: monacoTokenRules.light,
    colors: monacoThemeColors.light,
  })

  monaco.editor.defineTheme(MONACO_DARK_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: monacoTokenRules.dark,
    colors: monacoThemeColors.dark,
  })
}

export function useMonacoThemeSync() {
  const [theme, setTheme] = useState(MONACO_LIGHT_THEME)

  useEffect(() => {
    if (typeof window === "undefined") return
    const root = document.documentElement

    const syncTheme = () => {
      setTheme(
        root.classList.contains("dark") ? MONACO_DARK_THEME : MONACO_LIGHT_THEME
      )
    }

    syncTheme()

    const observer = new MutationObserver(syncTheme)
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["class"],
    })
    return () => {
      observer.disconnect()
    }
  }, [])

  return theme
}
