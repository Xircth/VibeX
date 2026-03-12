const TAG_NAME_PATTERN = /^[a-z][a-z0-9-]*$/i;
const TAG_REGEX_CACHE = new Map<string, RegExp>();

function getTagRegex(tagName: string): RegExp | null {
  if (!TAG_NAME_PATTERN.test(tagName)) {
    return null;
  }
  const cached = TAG_REGEX_CACHE.get(tagName);
  if (cached) {
    return cached;
  }
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i");
  TAG_REGEX_CACHE.set(tagName, regex);
  return regex;
}

function extractTagContent(text: string, tagName: string): string {
  const pattern = getTagRegex(tagName);
  if (!pattern) {
    return "";
  }
  const match = pattern.exec(text);
  return match?.[1]?.trim() ?? "";
}

export function hasCommandMessageTag(text: string): boolean {
  if (!text) {
    return false;
  }
  return /<command-message>/i.test(text) && /<\/command-message>/i.test(text);
}

export function extractCommandMessageDisplayText(text: string): string {
  if (!text || !hasCommandMessageTag(text)) {
    return text;
  }

  const parts: string[] = [];
  const commandMessage = extractTagContent(text, "command-message");
  const commandArgs = extractTagContent(text, "command-args");

  if (commandMessage) {
    parts.push(commandMessage);
  }
  if (commandArgs) {
    parts.push(commandArgs);
  }

  const processed = parts.join(" ").trim();
  return processed || text;
}
