export function appendChildConversationStack(
  stack: string[],
  conversationId: string
): string[] {
  const id = conversationId.trim();
  if (!id || stack.at(-1) === id) return stack;
  return [...stack, id];
}

export function popChildConversationStack(stack: string[]): string[] {
  return stack.slice(0, -1);
}
