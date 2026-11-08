import SwiftUI
import UIKit

// MARK: - Language

/// Languages the lightweight highlighter understands. Detection is by file
/// name; anything unknown renders as plain monospaced text.
enum CodeLanguage: String {
    case javascript, typescript, json, swift, rust, python, go, java, kotlin
    case c, cpp, csharp, css, html, xml, shell, yaml, toml, markdown, sql, ruby, php
    case plain

    static func detect(path: String) -> CodeLanguage {
        let name = (path as NSString).lastPathComponent.lowercased()
        switch name {
        case "dockerfile", "makefile", ".zshrc", ".bashrc", ".env", ".gitignore": return .shell
        case "cargo.lock": return .toml
        default: break
        }
        switch (name as NSString).pathExtension {
        case "js", "jsx", "mjs", "cjs": return .javascript
        case "ts", "tsx", "mts", "cts": return .typescript
        case "json", "jsonc", "json5", "lock": return .json
        case "swift": return .swift
        case "rs": return .rust
        case "py", "pyi": return .python
        case "go": return .go
        case "java": return .java
        case "kt", "kts": return .kotlin
        case "c", "h": return .c
        case "cc", "cpp", "cxx", "hpp", "hh", "m", "mm": return .cpp
        case "cs": return .csharp
        case "css", "scss", "sass", "less": return .css
        case "html", "htm", "vue", "svelte": return .html
        case "xml", "plist", "svg", "xib", "storyboard": return .xml
        case "sh", "bash", "zsh", "fish": return .shell
        case "yml", "yaml": return .yaml
        case "toml", "ini", "cfg", "conf": return .toml
        case "md", "mdx", "markdown": return .markdown
        case "sql": return .sql
        case "rb": return .ruby
        case "php": return .php
        default: return .plain
        }
    }

    static func detectFromFence(_ raw: String) -> CodeLanguage {
        let tag = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !tag.isEmpty else { return .plain }
        switch tag {
        case "javascript", "js", "jsx", "mjs", "cjs", "node": return .javascript
        case "typescript", "ts", "tsx": return .typescript
        case "json", "jsonc", "json5": return .json
        case "swift": return .swift
        case "rust", "rs": return .rust
        case "python", "py": return .python
        case "go", "golang": return .go
        case "java": return .java
        case "kotlin", "kt": return .kotlin
        case "c", "h": return .c
        case "cpp", "c++", "cc", "cxx", "hpp", "objc", "objective-c": return .cpp
        case "csharp", "c#", "cs": return .csharp
        case "css", "scss", "sass", "less": return .css
        case "html", "htm", "vue", "svelte": return .html
        case "xml", "svg", "plist": return .xml
        case "sh", "bash", "zsh", "fish", "shell", "console", "terminal": return .shell
        case "yaml", "yml": return .yaml
        case "toml", "ini": return .toml
        case "markdown", "md", "mdx": return .markdown
        case "sql", "postgres", "mysql", "sqlite": return .sql
        case "ruby", "rb": return .ruby
        case "php": return .php
        default:
            return detect(path: tag.contains(".") ? tag : "snippet.\(tag)")
        }
    }

    var displayName: String {
        switch self {
        case .javascript: return "JavaScript"
        case .typescript: return "TypeScript"
        case .json: return "JSON"
        case .swift: return "Swift"
        case .rust: return "Rust"
        case .python: return "Python"
        case .go: return "Go"
        case .java: return "Java"
        case .kotlin: return "Kotlin"
        case .c: return "C"
        case .cpp: return "C++"
        case .csharp: return "C#"
        case .css: return "CSS"
        case .html: return "HTML"
        case .xml: return "XML"
        case .shell: return "Shell"
        case .yaml: return "YAML"
        case .toml: return "TOML"
        case .markdown: return "Markdown"
        case .sql: return "SQL"
        case .ruby: return "Ruby"
        case .php: return "PHP"
        case .plain: return "Text"
        }
    }

    /// Brand-ish accent used for the header dot and file icons.
    var accent: Color {
        switch self {
        case .javascript: return Color(red: 0.94, green: 0.76, blue: 0.13)
        case .typescript: return Color(red: 0.19, green: 0.47, blue: 0.78)
        case .json: return Color(red: 0.80, green: 0.55, blue: 0.10)
        case .swift: return Color(red: 0.98, green: 0.42, blue: 0.24)
        case .rust: return Color(red: 0.72, green: 0.38, blue: 0.22)
        case .python: return Color(red: 0.22, green: 0.46, blue: 0.67)
        case .go: return Color(red: 0.0, green: 0.68, blue: 0.85)
        case .java, .kotlin: return Color(red: 0.69, green: 0.36, blue: 0.85)
        case .c, .cpp, .csharp: return Color(red: 0.35, green: 0.45, blue: 0.80)
        case .css: return Color(red: 0.34, green: 0.30, blue: 0.80)
        case .html, .xml: return Color(red: 0.89, green: 0.30, blue: 0.15)
        case .shell: return Color(red: 0.30, green: 0.68, blue: 0.35)
        case .yaml, .toml: return Color(red: 0.80, green: 0.25, blue: 0.30)
        case .markdown: return Color(red: 0.35, green: 0.40, blue: 0.48)
        case .sql: return Color(red: 0.85, green: 0.50, blue: 0.10)
        case .ruby: return Color(red: 0.80, green: 0.15, blue: 0.20)
        case .php: return Color(red: 0.47, green: 0.48, blue: 0.70)
        case .plain: return .secondary
        }
    }

    fileprivate var keywords: Set<String> {
        switch self {
        case .javascript, .typescript:
            return [
                "import", "export", "from", "default", "const", "let", "var", "function", "return",
                "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "new",
                "class", "extends", "super", "this", "typeof", "instanceof", "in", "of", "async",
                "await", "yield", "try", "catch", "finally", "throw", "delete", "void", "null",
                "undefined", "true", "false", "interface", "type", "enum", "implements", "as",
                "public", "private", "protected", "readonly", "static", "declare", "namespace",
                "keyof", "satisfies", "abstract",
            ]
        case .json: return ["true", "false", "null"]
        case .swift:
            return [
                "import", "let", "var", "func", "return", "if", "else", "guard", "for", "in",
                "while", "repeat", "switch", "case", "default", "break", "continue", "struct",
                "class", "enum", "protocol", "extension", "init", "deinit", "self", "Self", "super",
                "nil", "true", "false", "private", "fileprivate", "internal", "public", "open",
                "static", "some", "any", "async", "await", "throws", "throw", "try", "catch", "do",
                "where", "typealias", "inout", "mutating", "override", "final", "lazy", "weak",
                "defer", "is", "as", "@State", "@Binding", "@Environment", "@MainActor",
            ]
        case .rust:
            return [
                "fn", "let", "mut", "pub", "use", "mod", "crate", "self", "Self", "super", "struct",
                "enum", "impl", "trait", "for", "in", "if", "else", "match", "loop", "while",
                "return", "break", "continue", "as", "where", "async", "await", "move", "ref",
                "static", "const", "type", "dyn", "unsafe", "true", "false", "Some", "None", "Ok", "Err",
            ]
        case .python:
            return [
                "def", "class", "return", "if", "elif", "else", "for", "while", "in", "not", "and",
                "or", "is", "import", "from", "as", "with", "try", "except", "finally", "raise",
                "pass", "break", "continue", "lambda", "yield", "global", "nonlocal", "None", "True",
                "False", "async", "await", "self",
            ]
        case .go:
            return [
                "package", "import", "func", "return", "var", "const", "type", "struct", "interface",
                "map", "chan", "go", "defer", "if", "else", "for", "range", "switch", "case",
                "default", "break", "continue", "select", "nil", "true", "false",
            ]
        case .java, .kotlin, .csharp, .c, .cpp, .php:
            return [
                "import", "package", "class", "interface", "enum", "struct", "public", "private",
                "protected", "static", "final", "void", "int", "long", "float", "double", "bool",
                "boolean", "char", "return", "if", "else", "for", "while", "do", "switch", "case",
                "default", "break", "continue", "new", "this", "null", "true", "false", "try",
                "catch", "finally", "throw", "throws", "extends", "implements", "fun", "val", "var",
                "const", "using", "namespace", "include", "define", "typedef", "auto", "function",
                "echo", "override", "object", "when", "is", "in",
            ]
        case .shell:
            return [
                "if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "case",
                "esac", "function", "return", "export", "local", "echo", "cd", "set", "unset",
                "source", "exit", "FROM", "RUN", "COPY", "CMD", "ENV", "WORKDIR", "ARG", "EXPOSE",
            ]
        case .sql:
            let base = [
                "select", "from", "where", "insert", "into", "values", "update", "set", "delete",
                "create", "table", "drop", "alter", "index", "join", "left", "right", "inner",
                "outer", "on", "and", "or", "not", "null", "as", "order", "by", "group", "having",
                "limit", "primary", "key", "foreign", "references", "default", "distinct",
            ]
            return Set(base + base.map { $0.uppercased() })
        case .ruby:
            return [
                "def", "end", "class", "module", "if", "elsif", "else", "unless", "while", "do",
                "return", "require", "self", "nil", "true", "false", "yield", "begin", "rescue",
            ]
        case .yaml, .toml: return ["true", "false", "null", "yes", "no", "on", "off"]
        case .css, .html, .xml, .markdown, .plain: return []
        }
    }

    fileprivate var lineComment: [String] {
        switch self {
        case .python, .shell, .yaml, .toml, .ruby: return ["#"]
        case .sql: return ["--"]
        case .json: return ["//"]
        case .css, .html, .xml, .markdown, .plain: return []
        case .php: return ["//", "#"]
        default: return ["//"]
        }
    }

    fileprivate var blockComment: (String, String)? {
        switch self {
        case .html, .xml, .markdown: return ("<!--", "-->")
        case .python, .shell, .yaml, .toml, .ruby, .plain: return nil
        default: return ("/*", "*/")
        }
    }

    fileprivate var hasMarkup: Bool {
        switch self {
        case .html, .xml, .javascript, .typescript: return true
        default: return false
        }
    }
}

// MARK: - Highlighter

private enum TokenKind {
    case keyword, string, comment, number, type, function, property, tag, attribute, punctuation
}

private struct CodeTheme {
    static func color(_ kind: TokenKind) -> UIColor {
        switch kind {
        case .keyword: return dynamic(0xCF222E, 0xFF7B72)
        case .string: return dynamic(0x0A3069, 0xA5D6FF)
        case .comment: return dynamic(0x6E7781, 0x8B949E)
        case .number: return dynamic(0x0550AE, 0x79C0FF)
        case .type: return dynamic(0x953800, 0xFFA657)
        case .function: return dynamic(0x8250DF, 0xD2A8FF)
        case .property: return dynamic(0x0550AE, 0x7EE787)
        case .tag: return dynamic(0x116329, 0x7EE787)
        case .attribute: return dynamic(0x0550AE, 0x79C0FF)
        case .punctuation: return dynamic(0x57606A, 0x8B949E)
        }
    }

    private static func dynamic(_ light: UInt32, _ dark: UInt32) -> UIColor {
        UIColor { $0.userInterfaceStyle == .dark ? hex(dark) : hex(light) }
    }

    private static func hex(_ v: UInt32) -> UIColor {
        UIColor(
            red: CGFloat((v >> 16) & 0xFF) / 255,
            green: CGFloat((v >> 8) & 0xFF) / 255,
            blue: CGFloat(v & 0xFF) / 255,
            alpha: 1
        )
    }
}

/// Single-pass scanner over UTF-16 units. Not a parser — it recognises
/// comments, strings, numbers, identifiers and markup tags well enough for a
/// readable phone preview, and degrades to plain text for anything else.
enum CodeHighlighter {
    static func highlight(_ source: String, language: CodeLanguage) -> [AttributedString] {
        let ns = source as NSString
        let length = ns.length
        var units = [unichar](repeating: 0, count: length)
        ns.getCharacters(&units, range: NSRange(location: 0, length: length))

        var tokens: [(NSRange, TokenKind)] = []
        if language != .plain {
            tokens = scan(units, language: language)
        }

        // Split into lines and colour each line's slice of the token stream.
        var lines: [AttributedString] = []
        var tokenIndex = 0
        var lineStart = 0
        var i = 0
        while i <= length {
            if i == length || units[i] == 10 {
                var end = i
                if end > lineStart, units[end - 1] == 13 { end -= 1 }
                let text = ns.substring(with: NSRange(location: lineStart, length: end - lineStart))
                var line = AttributedString(text)
                while tokenIndex < tokens.count, NSMaxRange(tokens[tokenIndex].0) <= lineStart {
                    tokenIndex += 1
                }
                var t = tokenIndex
                while t < tokens.count, tokens[t].0.location < end {
                    let (range, kind) = tokens[t]
                    let lo = max(range.location, lineStart) - lineStart
                    let hi = min(NSMaxRange(range), end) - lineStart
                    if hi > lo {
                        let sLo = String.Index(utf16Offset: lo, in: text)
                        let sHi = String.Index(utf16Offset: hi, in: text)
                        if let r = Range(sLo..<sHi, in: line) {
                            line[r].foregroundColor = Color(uiColor: CodeTheme.color(kind))
                        }
                    }
                    t += 1
                }
                lines.append(line)
                lineStart = i + 1
            }
            i += 1
        }
        return lines
    }

    private static func isIdentStart(_ c: unichar) -> Bool {
        (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95 || c == 36 || c == 64 || c > 127
    }

    private static func isIdent(_ c: unichar) -> Bool {
        isIdentStart(c) || (c >= 48 && c <= 57)
    }

    private static func isDigit(_ c: unichar) -> Bool { c >= 48 && c <= 57 }

    private static func matches(_ units: [unichar], _ at: Int, _ word: String) -> Bool {
        let w = Array(word.utf16)
        guard at + w.count <= units.count else { return false }
        for k in 0..<w.count where units[at + k] != w[k] { return false }
        return true
    }

    private static func scan(_ u: [unichar], language: CodeLanguage) -> [(NSRange, TokenKind)] {
        var out: [(NSRange, TokenKind)] = []
        let n = u.count
        let keywords = language.keywords
        let lineComments = language.lineComment
        let block = language.blockComment
        var i = 0
        var lineHasContent = false

        func add(_ start: Int, _ end: Int, _ kind: TokenKind) {
            if end > start { out.append((NSRange(location: start, length: end - start), kind)) }
        }

        while i < n {
            let c = u[i]
            if c == 10 { lineHasContent = false; i += 1; continue }

            // Block comment
            if let (open, close) = block, matches(u, i, open) {
                let start = i
                i += open.utf16.count
                while i < n, !matches(u, i, close) { i += 1 }
                i = min(n, i + close.utf16.count)
                add(start, i, .comment)
                continue
            }

            // Line comment (shell '#' only at token boundary)
            if let lc = lineComments.first(where: { matches(u, i, $0) }) {
                let boundary = i == 0 || u[i - 1] == 32 || u[i - 1] == 9 || u[i - 1] == 10
                if lc != "#" || boundary || language == .python || language == .yaml || language == .toml {
                    let start = i
                    while i < n, u[i] != 10 { i += 1 }
                    add(start, i, .comment)
                    continue
                }
            }

            // Markup tags: <Tag attr="x"> / </Tag>
            if language.hasMarkup, c == 60, i + 1 < n, isIdentStart(u[i + 1]) || u[i + 1] == 47 {
                var j = i + 1
                if u[j] == 47 { j += 1 }
                let nameStart = j
                while j < n, isIdent(u[j]) || u[j] == 46 || u[j] == 45 || u[j] == 58 { j += 1 }
                if j > nameStart, language == .html || language == .xml || u[nameStart] >= 65 && u[nameStart] <= 90 || j < n && (u[j] == 32 || u[j] == 62 || u[j] == 10 || u[j] == 47) {
                    add(i, nameStart, .punctuation)
                    add(nameStart, j, (u[nameStart] >= 65 && u[nameStart] <= 90) ? .type : .tag)
                    i = j
                    // attributes until '>' on the same tag (html/xml only; JSX attrs fall through)
                    if language == .html || language == .xml {
                        while i < n, u[i] != 62 {
                            if u[i] == 34 || u[i] == 39 {
                                let q = u[i]; let s = i; i += 1
                                while i < n, u[i] != q { i += 1 }
                                i = min(n, i + 1)
                                add(s, i, .string)
                            } else if isIdentStart(u[i]) {
                                let s = i
                                while i < n, isIdent(u[i]) || u[i] == 45 || u[i] == 58 { i += 1 }
                                add(s, i, .attribute)
                            } else { i += 1 }
                        }
                        if i < n { add(i, i + 1, .punctuation); i += 1 }
                    }
                    lineHasContent = true
                    continue
                }
            }

            // Strings
            if c == 34 || c == 39 || (c == 96 && language != .markdown) {
                if c == 39, language == .markdown || language == .plain { i += 1; continue }
                let start = i
                let quote = c
                i += 1
                while i < n {
                    if u[i] == 92 { i += 2; continue }
                    if u[i] == quote { i += 1; break }
                    if u[i] == 10, quote != 96 { break }
                    i += 1
                }
                i = min(i, n)
                // JSON / YAML keys: string followed by ':'
                var k = i
                while k < n, u[k] == 32 || u[k] == 9 { k += 1 }
                let isKey = k < n && u[k] == 58 && (language == .json || language == .yaml || language == .javascript || language == .typescript || language == .python)
                add(start, i, isKey ? .property : .string)
                lineHasContent = true
                continue
            }

            // Numbers
            if isDigit(c), i == 0 || !isIdent(u[i - 1]) {
                let start = i
                while i < n, isIdent(u[i]) || u[i] == 46 { i += 1 }
                add(start, i, .number)
                lineHasContent = true
                continue
            }

            // Identifiers
            if isIdentStart(c) {
                let start = i
                i += 1
                while i < n, isIdent(u[i]) || (language == .css && u[i] == 45) { i += 1 }
                let word = String(utf16CodeUnits: Array(u[start..<i]), count: i - start)
                var k = i
                while k < n, u[k] == 32 { k += 1 }
                let next: unichar = k < n ? u[k] : 0

                if keywords.contains(word) {
                    add(start, i, .keyword)
                } else if language.hasMarkup, next == 61, k + 1 < n, u[k + 1] == 123 || u[k + 1] == 34 {
                    add(start, i, .attribute)
                } else if (language == .yaml || language == .toml), !lineHasContent, next == 58 || next == 61 {
                    add(start, i, .property)
                } else if language == .css, next == 58 {
                    add(start, i, .property)
                } else if next == 40 {
                    add(start, i, .function)
                } else if let first = word.utf16.first, first >= 65, first <= 90 {
                    add(start, i, .type)
                } else if start > 0, u[start - 1] == 46 {
                    add(start, i, .property)
                }
                lineHasContent = true
                continue
            }

            // Markdown headings / list markers
            if language == .markdown, !lineHasContent, c == 35 || c == 62 || c == 45 || c == 42 {
                let start = i
                while i < n, u[i] != 10 { i += 1 }
                add(start, i, c == 35 ? .keyword : .punctuation)
                continue
            }

            if c != 32, c != 9 { lineHasContent = true }
            i += 1
        }
        return out
    }
}

// MARK: - File icons

enum FileGlyph {
    static func symbol(for path: String) -> String {
        let name = (path as NSString).lastPathComponent.lowercased()
        let ext = (name as NSString).pathExtension
        if name.hasPrefix("readme") { return "book.closed" }
        if name == "license" || name.hasPrefix("license.") { return "checkmark.seal" }
        if name.hasPrefix(".git") { return "arrow.triangle.branch" }
        if name == "dockerfile" { return "shippingbox" }
        switch ext {
        case "png", "jpg", "jpeg", "gif", "webp", "heic", "ico", "icns": return "photo"
        case "svg": return "scribble.variable"
        case "mp4", "mov", "webm": return "film"
        case "mp3", "wav", "m4a": return "waveform"
        case "zip", "gz", "tar", "tgz", "rar", "7z": return "doc.zipper"
        case "pdf": return "doc.richtext"
        case "md", "mdx", "txt", "rtf": return "doc.plaintext"
        case "json", "jsonc", "lock": return "curlybraces"
        case "yml", "yaml", "toml", "ini", "cfg", "conf", "env", "plist": return "gearshape"
        case "swift": return "swift"
        case "sh", "bash", "zsh", "fish": return "terminal"
        case "html", "htm", "xml", "vue", "svelte": return "chevron.left.forwardslash.chevron.right"
        case "css", "scss", "sass", "less": return "paintbrush"
        case "sql", "db", "sqlite": return "cylinder.split.1x2"
        case "ttf", "otf", "woff", "woff2": return "textformat"
        case "js", "jsx", "mjs", "cjs", "ts", "tsx", "rs", "py", "go", "java", "kt", "c", "h",
             "cpp", "hpp", "cs", "rb", "php", "m", "mm":
            return "chevron.left.forwardslash.chevron.right"
        default: return "doc.text"
        }
    }
}

// MARK: - Code block

/// Code viewer modelled on the desktop `CodeBlock`: titled header with the
/// language, copy and wrap actions, a line-number gutter and syntax colours.
struct CodeBlockView: View {
    let code: String
    let title: String
    var language: CodeLanguage = .plain
    var hasLineNumbers = true
    var note: String?

    @State private var lines: [AttributedString]?
    @State private var wraps = false
    @State private var copied = false
    @AppStorage("vibex.code.fontSize") private var fontSize: Double = 12

    private var lineCount: Int { lines?.count ?? 0 }
    private var gutterWidth: CGFloat {
        CGFloat(max(2, String(lineCount).count)) * fontSize * 0.62 + 6
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().opacity(0.6)
            if let lines {
                codeBody(lines)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color(.secondarySystemGroupedBackground))
        .task(id: code) {
            let source = code
            let lang = language
            lines = await Task.detached(priority: .userInitiated) {
                CodeHighlighter.highlight(source, language: lang)
            }.value
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: FileGlyph.symbol(for: title))
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(language.accent)
                .frame(width: 22, height: 22)
                .background(language.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            VStack(alignment: .leading, spacing: 0) {
                Text(title)
                    .font(.system(size: 13, weight: .semibold, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text("\(language.displayName) · \(lineCount) 行")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 6)
            headerButton(wraps ? "text.alignleft" : "arrow.left.and.right.text.vertical", label: wraps ? "取消换行" : "自动换行", on: wraps) {
                withAnimation(.easeInOut(duration: 0.18)) { wraps.toggle() }
            }
            Menu {
                Button("缩小字号", systemImage: "textformat.size.smaller") { fontSize = max(9, fontSize - 1) }
                Button("放大字号", systemImage: "textformat.size.larger") { fontSize = min(18, fontSize + 1) }
                Button("恢复默认", systemImage: "arrow.counterclockwise") { fontSize = 12 }
            } label: {
                Image(systemName: "textformat.size")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 28, height: 28)
                    .background(Color(.tertiarySystemFill), in: Circle())
            }
            headerButton(copied ? "checkmark" : "doc.on.doc", label: "复制代码", on: copied) {
                UIPasteboard.general.string = code
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                withAnimation { copied = true }
                Task {
                    try? await Task.sleep(for: .seconds(1.4))
                    withAnimation { copied = false }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private func headerButton(_ icon: String, label: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(on ? Color.accentColor : .secondary)
                .frame(width: 28, height: 28)
                .background(on ? Color.accentColor.opacity(0.14) : Color(.tertiarySystemFill), in: Circle())
                .contentTransition(.symbolEffect(.replace))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    @ViewBuilder
    private func codeBody(_ lines: [AttributedString]) -> some View {
        let font = Font.system(size: fontSize, design: .monospaced)
        let rows = LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    if hasLineNumbers {
                        Text("\(index + 1)")
                            .foregroundStyle(.tertiary)
                            .frame(width: gutterWidth, alignment: .trailing)
                    }
                    Text(line.characters.isEmpty ? AttributedString(" ") : line)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: !wraps, vertical: true)
                        .frame(maxWidth: wraps ? .infinity : nil, alignment: .leading)
                }
                .font(font)
                .lineSpacing(2)
                .padding(.vertical, 1)
            }
            if let note {
                Label(note, systemImage: "scissors")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.top, 12)
            }
        }
        .textSelection(.enabled)
        .padding(.vertical, 10)
        .padding(.horizontal, 12)

        if wraps {
            ScrollView(.vertical) { rows }
        } else {
            ScrollView([.vertical, .horizontal]) { rows }
        }
    }
}

#Preview {
    CodeBlockView(
        code: """
        'use client';

        import {CodeBlock} from '@astryxdesign/core/CodeBlock';

        const code = `{
          "name": "@astryxdesign/core",
          "version": "0.0.5"
        }`;

        export default function CodeBlockJSONConfig() {
          return (
            <CodeBlock code={code} language="json" title="package.json" hasLineNumbers />
          );
        }
        """,
        title: "CodeBlockJSONConfig.tsx",
        language: .typescript
    )
}
