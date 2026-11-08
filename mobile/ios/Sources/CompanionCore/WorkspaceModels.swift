import Foundation

public struct WorkspaceTree: Decodable, Equatable, Sendable {
    public let path: String
    public let entries: [WorkspaceEntry]
    public let truncated: Bool
}

public struct WorkspaceFile: Decodable, Equatable, Sendable {
    public let path: String
    public let size: Int
    public let binary: Bool
    public let truncated: Bool
    public let content: String?
}

struct WorkspaceDiffEntry: Decodable {
    let path: String
    let status: String
    let diff: String
    let is_binary: Bool
    let truncated: Bool?
}

public struct DiffLine: Identifiable, Equatable, Sendable {
    public enum Kind: Sendable { case context, added, removed }

    public let id: Int
    public let kind: Kind
    public let text: String
    public let oldNumber: Int?
    public let newNumber: Int?
}

public struct DiffHunk: Identifiable, Equatable, Sendable {
    public let id: Int
    public let header: String
    public let lines: [DiffLine]
}

public struct FileDiff: Identifiable, Equatable, Sendable {
    public enum Change: Sendable { case added, modified, deleted, renamed, untracked }

    public let path: String
    public let change: Change
    public let isBinary: Bool
    public let truncated: Bool
    public let hunks: [DiffHunk]

    public var id: String { path }
    public var additions: Int { count(.added) }
    public var deletions: Int { count(.removed) }
    /// Untracked or newly added files with no unified diff payload fetch their whole content as additions instead.
    public var needsContent: Bool { hunks.isEmpty && !isBinary && change != .deleted }

    private func count(_ kind: DiffLine.Kind) -> Int {
        hunks.reduce(0) { $0 + $1.lines.filter { $0.kind == kind }.count }
    }

    public init(path: String, hunks: [DiffHunk]) {
        self.path = path
        self.change = .modified
        self.isBinary = false
        self.truncated = false
        self.hunks = hunks
    }

    init(_ entry: WorkspaceDiffEntry) {
        path = entry.path
        isBinary = entry.is_binary
        truncated = entry.truncated ?? false
        hunks = UnifiedDiff.parse(entry.diff)
        switch entry.status {
        case "A": change = .added
        case "D": change = .deleted
        case "R", "C": change = .renamed
        case "?": change = .untracked
        default: change = .modified
        }
    }

    /// Every line of a new file as an addition.
    public static func additions(of content: String) -> [DiffHunk] {
        let lines = content.split(separator: "\n", omittingEmptySubsequences: false)
        let trimmed = lines.last == "" ? Array(lines.dropLast()) : lines
        guard !trimmed.isEmpty else { return [] }
        let rows = trimmed.enumerated().map {
            DiffLine(id: $0.offset, kind: .added, text: String($0.element), oldNumber: nil, newNumber: $0.offset + 1)
        }
        return [DiffHunk(id: 0, header: "@@ -0,0 +1,\(rows.count) @@", lines: rows)]
    }
}

public enum UnifiedDiff {
    /// Parses the hunks of one file's `git diff` text; header lines before the first hunk are skipped.
    public static func parse(_ text: String) -> [DiffHunk] {
        var hunks: [DiffHunk] = []
        var header = ""
        var lines: [DiffLine] = []
        var oldNumber = 0
        var newNumber = 0
        var inHunk = false

        func flush() {
            if inHunk { hunks.append(DiffHunk(id: hunks.count, header: header, lines: lines)) }
            lines = []
        }

        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line.hasPrefix("@@") {
                flush()
                guard let (old, new) = hunkStarts(line) else {
                    inHunk = false
                    continue
                }
                header = line
                oldNumber = old
                newNumber = new
                inHunk = true
                continue
            }
            guard inHunk, let marker = line.first else { continue }
            let body = String(line.dropFirst())
            switch marker {
            case "+":
                lines.append(DiffLine(id: lines.count, kind: .added, text: body, oldNumber: nil, newNumber: newNumber))
                newNumber += 1
            case "-":
                lines.append(DiffLine(id: lines.count, kind: .removed, text: body, oldNumber: oldNumber, newNumber: nil))
                oldNumber += 1
            case " ":
                lines.append(DiffLine(id: lines.count, kind: .context, text: body, oldNumber: oldNumber, newNumber: newNumber))
                oldNumber += 1
                newNumber += 1
            default:
                continue // "\ No newline at end of file"
            }
        }
        flush()
        return hunks
    }

    /// `@@ -a[,b] +c[,d] @@ ...` → (a, c)
    private static func hunkStarts(_ header: String) -> (Int, Int)? {
        let parts = header.split(separator: " ")
        guard parts.count >= 3, parts[1].hasPrefix("-"), parts[2].hasPrefix("+") else { return nil }
        func start(_ part: Substring) -> Int? { Int(part.dropFirst().split(separator: ",").first ?? "") }
        guard let old = start(parts[1]), let new = start(parts[2]) else { return nil }
        return (old, new)
    }
}
