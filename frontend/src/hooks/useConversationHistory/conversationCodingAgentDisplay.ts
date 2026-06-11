export function stripPreviouslyDisplayedAssistantPrefix(
  content: string,
  previousAssistantTranscript: string
): string {
  if (
    previousAssistantTranscript.length < 20 ||
    content.length <= previousAssistantTranscript.length ||
    !content.startsWith(previousAssistantTranscript)
  ) {
    return content;
  }

  const stripped = content.slice(previousAssistantTranscript.length);
  return stripped.trimStart() || content;
}
