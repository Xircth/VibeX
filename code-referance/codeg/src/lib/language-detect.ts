export function languageFromPath(path: string): string {
  const lower = path.toLowerCase()
  const ext = lower.split(".").pop() ?? ""

  switch (ext) {
    case "ts":
      return "typescript"
    case "tsx":
      return "typescript"
    case "js":
    case "mjs":
    case "cjs":
      return "javascript"
    case "jsx":
      return "javascript"
    case "rs":
      return "rust"
    case "py":
      return "python"
    case "go":
      return "go"
    case "json":
      return "json"
    case "md":
      return "markdown"
    case "yml":
    case "yaml":
      return "yaml"
    case "toml":
      return "toml"
    case "css":
      return "css"
    case "html":
      return "html"
    case "sh":
      return "shell"
    case "sql":
      return "sql"
    default:
      return "plaintext"
  }
}
