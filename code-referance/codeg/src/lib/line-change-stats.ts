export interface LineChangeStats {
  additions: number
  deletions: number
}

const MAX_LCS_MATCH_PAIRS = 200_000

export function splitNormalizedLines(text: string): string[] {
  if (!text) return []
  const lines = text.split("\n")
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop()
  }
  return lines
}

function contiguousChangedLineStats(
  oldLines: string[],
  newLines: string[]
): LineChangeStats {
  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  return {
    additions: Math.max(0, newLines.length - prefix - suffix),
    deletions: Math.max(0, oldLines.length - prefix - suffix),
  }
}

function lowerBound(values: number[], target: number): number {
  let left = 0
  let right = values.length
  while (left < right) {
    const mid = left + ((right - left) >> 1)
    if (values[mid] < target) {
      left = mid + 1
    } else {
      right = mid
    }
  }
  return left
}

function exceedsLcsPairBudget(oldLines: string[], newLines: string[]): boolean {
  if (oldLines.length === 0 || newLines.length === 0) return false

  const oldFreq = new Map<string, number>()
  for (const line of oldLines) {
    oldFreq.set(line, (oldFreq.get(line) ?? 0) + 1)
  }

  const newFreq = new Map<string, number>()
  for (const line of newLines) {
    newFreq.set(line, (newFreq.get(line) ?? 0) + 1)
  }

  let pairs = 0
  for (const [line, oldCount] of oldFreq) {
    const newCount = newFreq.get(line)
    if (!newCount) continue
    pairs += oldCount * newCount
    if (pairs > MAX_LCS_MATCH_PAIRS) return true
  }

  return false
}

function lcsLengthByLine(oldLines: string[], newLines: string[]): number {
  const positions = new Map<string, number[]>()
  for (let i = 0; i < newLines.length; i += 1) {
    const line = newLines[i]
    const bucket = positions.get(line)
    if (bucket) {
      bucket.push(i)
    } else {
      positions.set(line, [i])
    }
  }

  const lis: number[] = []
  for (const line of oldLines) {
    const bucket = positions.get(line)
    if (!bucket || bucket.length === 0) continue

    for (let i = bucket.length - 1; i >= 0; i -= 1) {
      const pos = bucket[i]
      const at = lowerBound(lis, pos)
      if (at === lis.length) {
        lis.push(pos)
      } else {
        lis[at] = pos
      }
    }
  }

  return lis.length
}

export function estimateChangedLineStats(
  oldText: string,
  newText: string
): LineChangeStats {
  const oldLines = splitNormalizedLines(oldText)
  const newLines = splitNormalizedLines(newText)

  if (oldLines.length === 0 && newLines.length === 0) {
    return { additions: 0, deletions: 0 }
  }
  if (oldLines.length === 0) {
    return { additions: newLines.length, deletions: 0 }
  }
  if (newLines.length === 0) {
    return { additions: 0, deletions: oldLines.length }
  }

  if (exceedsLcsPairBudget(oldLines, newLines)) {
    return contiguousChangedLineStats(oldLines, newLines)
  }

  const lcs = lcsLengthByLine(oldLines, newLines)
  return {
    additions: Math.max(0, newLines.length - lcs),
    deletions: Math.max(0, oldLines.length - lcs),
  }
}

export function countUnifiedDiffLineChanges(text: string): LineChangeStats {
  let additions = 0
  let deletions = 0
  for (const line of text.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1
  }
  return { additions, deletions }
}
