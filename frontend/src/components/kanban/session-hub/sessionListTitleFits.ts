export function sessionListTitleFits(
  slotWidth: number,
  titleWidth: number
): boolean {
  return titleWidth > 0 && slotWidth >= titleWidth;
}
