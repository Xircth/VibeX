import SwiftUI
import UIKit

/// An assistant answer with structured Markdown blocks (headings, lists, quotes,
/// inline code/bold/links, and syntax-highlighted fenced code blocks).
struct StreamingMessageText: View {
    let text: String
    let streaming: Bool

    @State private var settled = 0
    @State private var progress = 1.0
    @State private var copied = false

    private var blocks: [MarkdownBlock] {
        MarkdownParser.parse(text)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if streaming {
                streamingContent
            } else {
                ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                    MarkdownBlockView(block: block)
                }
            }

            if !streaming && !text.isEmpty {
                HStack(spacing: 12) {
                    Button {
                        UIPasteboard.general.string = text
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        withAnimation(.easeInOut(duration: 0.18)) { copied = true }
                        Task {
                            try? await Task.sleep(for: .seconds(1.5))
                            withAnimation(.easeInOut(duration: 0.18)) { copied = false }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                                .font(.system(size: 11.5, weight: .semibold))
                            Text(copied ? "已复制" : "复制")
                                .font(.system(size: 11.5, weight: .medium))
                        }
                        .foregroundStyle(copied ? Color.accentColor : .secondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(
                            Capsule()
                                .fill(Color(.secondarySystemGroupedBackground))
                        )
                        .contentTransition(.symbolEffect(.replace))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("复制回复")
                }
                .padding(.top, 2)
                .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.easeOut(duration: 0.25), value: streaming)
        .onAppear { settled = text.count }
        .onChange(of: text) { old, new in
            guard new.hasPrefix(old), new.count > old.count else {
                settled = new.count
                progress = 1
                return
            }
            settled = old.count
            var instant = Transaction()
            instant.disablesAnimations = true
            withTransaction(instant) { progress = 0 }
            Task { @MainActor in
                await Task.yield()
                withAnimation(.easeOut(duration: 0.45)) { progress = 1 }
            }
        }
    }

    @ViewBuilder
    private var streamingContent: some View {
        let parsed = blocks
        ForEach(Array(parsed.enumerated()), id: \.offset) { index, block in
            let isLastBlock = index == parsed.count - 1
            if isLastBlock, case .paragraph(let raw) = block {
                let display = raw + "▍"
                if #available(iOS 18.0, *) {
                    Text(MarkdownInline.attributed(display))
                        .font(.system(size: 15))
                        .lineSpacing(4)
                        .textSelection(.enabled)
                        .textRenderer(
                            RevealRenderer(
                                settled: max(0, raw.count - max(0, text.count - settled)),
                                progress: progress,
                                hasCursor: true
                            )
                        )
                } else {
                    Text(MarkdownInline.attributed(display))
                        .font(.system(size: 15))
                        .lineSpacing(4)
                        .textSelection(.enabled)
                }
            } else {
                MarkdownBlockView(block: block)
            }
        }
    }
}

// MARK: - Markdown AST & Parser

private struct NumberedItem: Equatable {
    let number: Int
    var text: String
}

private enum MarkdownBlock: Equatable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case codeBlock(language: String, code: String)
    case bulletList([String])
    case numberedList([NumberedItem])
    case blockquote(String)
    case divider
}

private enum MarkdownParser {
    static func parse(_ source: String) -> [MarkdownBlock] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n")
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map(String.init)

        var blocks: [MarkdownBlock] = []
        var i = 0
        let count = lines.count

        while i < count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.isEmpty {
                i += 1
                continue
            }

            // Fenced code block ```lang
            if trimmed.hasPrefix("```") {
                let lang = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                i += 1
                var codeLines: [String] = []
                while i < count {
                    if lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                        i += 1
                        break
                    }
                    codeLines.append(lines[i])
                    i += 1
                }
                blocks.append(.codeBlock(language: lang, code: codeLines.joined(separator: "\n")))
                continue
            }

            // Horizontal rule
            if trimmed == "---" || trimmed == "***" || trimmed == "___" {
                blocks.append(.divider)
                i += 1
                continue
            }

            // Heading # .. ####
            if let (level, title) = parseHeading(trimmed) {
                blocks.append(.heading(level: level, text: title))
                i += 1
                continue
            }

            // Blockquote >
            if trimmed.hasPrefix(">") {
                var quoteLines: [String] = []
                while i < count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    guard t.hasPrefix(">") else { break }
                    let body = t.dropFirst().trimmingCharacters(in: .whitespaces)
                    quoteLines.append(body)
                    i += 1
                }
                blocks.append(.blockquote(quoteLines.joined(separator: "\n")))
                continue
            }

            // Bullet list (- , * , + , • )
            if let firstBullet = parseBullet(trimmed) {
                var items: [String] = [firstBullet]
                i += 1
                while i < count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    if let item = parseBullet(t) {
                        items.append(item)
                        i += 1
                    } else if !t.isEmpty && (lines[i].hasPrefix("  ") || lines[i].hasPrefix("\t")) {
                        items[items.count - 1] += "\n" + t
                        i += 1
                    } else {
                        break
                    }
                }
                blocks.append(.bulletList(items))
                continue
            }

            // Numbered list (1. , 2. )
            if let firstNum = parseNumbered(trimmed) {
                var items: [NumberedItem] = [firstNum]
                i += 1
                while i < count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    if let item = parseNumbered(t) {
                        items.append(item)
                        i += 1
                    } else if !t.isEmpty && (lines[i].hasPrefix("  ") || lines[i].hasPrefix("\t")) {
                        items[items.count - 1].text += "\n" + t
                        i += 1
                    } else {
                        break
                    }
                }
                blocks.append(.numberedList(items))
                continue
            }

            // Normal paragraph
            var paraLines: [String] = [line]
            i += 1
            while i < count {
                let next = lines[i]
                let nextTrim = next.trimmingCharacters(in: .whitespaces)
                if nextTrim.isEmpty
                    || nextTrim.hasPrefix("```")
                    || nextTrim == "---" || nextTrim == "***"
                    || parseHeading(nextTrim) != nil
                    || nextTrim.hasPrefix(">")
                    || parseBullet(nextTrim) != nil
                    || parseNumbered(nextTrim) != nil
                {
                    break
                }
                paraLines.append(next)
                i += 1
            }
            blocks.append(.paragraph(paraLines.joined(separator: "\n")))
        }

        return blocks
    }

    private static func parseHeading(_ line: String) -> (Int, String)? {
        var level = 0
        for ch in line {
            if ch == "#" { level += 1 } else { break }
        }
        guard (1...4).contains(level), line.count > level else { return nil }
        let idx = line.index(line.startIndex, offsetBy: level)
        guard line[idx] == " " else { return nil }
        let content = line[line.index(after: idx)...].trimmingCharacters(in: .whitespaces)
        return content.isEmpty ? nil : (level, content)
    }

    private static func parseBullet(_ line: String) -> String? {
        for prefix in ["- ", "* ", "+ ", "• "] {
            if line.hasPrefix(prefix) {
                return String(line.dropFirst(prefix.count))
            }
        }
        return nil
    }

    private static func parseNumbered(_ line: String) -> NumberedItem? {
        guard let dot = line.firstIndex(of: ".") else { return nil }
        let numPart = line[..<dot]
        guard let number = Int(numPart),
              line.index(after: dot) < line.endIndex,
              line[line.index(after: dot)] == " "
        else { return nil }
        let body = String(line[line.index(dot, offsetBy: 2)...])
        return NumberedItem(number: number, text: body)
    }
}

private enum MarkdownInline {
    static func attributed(_ raw: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        if var parsed = try? AttributedString(markdown: raw, options: options) {
            for run in parsed.runs where run.inlinePresentationIntent?.contains(.code) == true {
                let range = run.range
                parsed[range].font = .system(size: 13.5, weight: .medium, design: .monospaced)
                parsed[range].backgroundColor = Color.primary.opacity(0.07)
            }
            return parsed
        }
        return AttributedString(raw)
    }
}

// MARK: - Block Views

private struct MarkdownBlockView: View {
    let block: MarkdownBlock

    var body: some View {
        switch block {
        case .heading(let level, let text):
            Text(MarkdownInline.attributed(text))
                .font(headingFont(level))
                .foregroundStyle(.primary)
                .padding(.top, level <= 2 ? 4 : 2)
                .textSelection(.enabled)

        case .paragraph(let text):
            Text(MarkdownInline.attributed(text))
                .font(.system(size: 15))
                .lineSpacing(4)
                .foregroundStyle(.primary)
                .textSelection(.enabled)

        case .codeBlock(let language, let code):
            InlineMarkdownCodeCard(languageTag: language, code: code)

        case .bulletList(let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Circle()
                            .fill(Color.secondary.opacity(0.65))
                            .frame(width: 5, height: 5)
                            .padding(.leading, 4)
                            .offset(y: -2)
                        Text(MarkdownInline.attributed(item))
                            .font(.system(size: 15))
                            .lineSpacing(3.5)
                            .foregroundStyle(.primary)
                            .textSelection(.enabled)
                    }
                }
            }

        case .numberedList(let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, pair in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(pair.number).")
                            .font(.system(size: 13.5, weight: .semibold, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 20, alignment: .trailing)
                        Text(MarkdownInline.attributed(pair.text))
                            .font(.system(size: 15))
                            .lineSpacing(3.5)
                            .foregroundStyle(.primary)
                            .textSelection(.enabled)
                    }
                }
            }

        case .blockquote(let text):
            HStack(alignment: .top, spacing: 10) {
                Capsule()
                    .fill(Color.accentColor.opacity(0.55))
                    .frame(width: 3)
                Text(MarkdownInline.attributed(text))
                    .font(.system(size: 14.5))
                    .foregroundStyle(.secondary)
                    .lineSpacing(3.5)
                    .textSelection(.enabled)
            }
            .padding(.vertical, 2)

        case .divider:
            Divider()
                .padding(.vertical, 4)
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .system(size: 19, weight: .bold)
        case 2: return .system(size: 17, weight: .bold)
        case 3: return .system(size: 15.5, weight: .semibold)
        default: return .system(size: 15, weight: .semibold)
        }
    }
}

private struct InlineMarkdownCodeCard: View {
    let languageTag: String
    let code: String
    @State private var copied = false

    private var language: CodeLanguage {
        CodeLanguage.detectFromFence(languageTag)
    }

    private var highlightedLines: [AttributedString] {
        CodeHighlighter.highlight(code, language: language)
    }

    var body: some View {
        let lines = highlightedLines
        let gutterWidth = CGFloat(max(2, String(lines.count).count)) * 7.5 + 4

        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 7) {
                Circle()
                    .fill(language.accent)
                    .frame(width: 7, height: 7)
                Text(languageTag.isEmpty ? language.displayName : languageTag)
                    .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    UIPasteboard.general.string = code
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    withAnimation { copied = true }
                    Task {
                        try? await Task.sleep(for: .seconds(1.4))
                        withAnimation { copied = false }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 10.5, weight: .semibold))
                        Text(copied ? "已复制" : "复制")
                            .font(.system(size: 11, weight: .medium))
                    }
                    .foregroundStyle(copied ? Color.accentColor : .secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Color(.tertiarySystemFill), in: Capsule())
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(Color.primary.opacity(0.03))

            Divider().opacity(0.5)

            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text("\(index + 1)")
                                .foregroundStyle(.tertiary)
                                .frame(width: gutterWidth, alignment: .trailing)
                            Text(line.characters.isEmpty ? AttributedString(" ") : line)
                                .foregroundStyle(.primary)
                                .fixedSize(horizontal: true, vertical: true)
                        }
                        .font(.system(size: 12.5, design: .monospaced))
                        .padding(.vertical, 0.5)
                    }
                }
                .textSelection(.enabled)
                .padding(.horizontal, 10)
                .padding(.vertical, 9)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5)
        )
    }
}

@available(iOS 18.0, *)
private struct RevealRenderer: TextRenderer {
    var settled: Int
    var progress: Double
    var hasCursor: Bool

    var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        let slices = layout.flatMap { $0 }.flatMap { $0 }
        let fresh = max(1, slices.count - settled - (hasCursor ? 1 : 0))
        for (index, slice) in slices.enumerated() {
            if index < settled || (hasCursor && index == slices.count - 1) {
                context.draw(slice)
                continue
            }
            let order = Double(index - settled) / Double(fresh)
            let local = min(1, max(0, progress * 1.6 - 0.6 * order))
            var copy = context
            copy.opacity = local
            copy.addFilter(.blur(radius: (1 - local) * 4))
            copy.draw(slice)
        }
    }
}
