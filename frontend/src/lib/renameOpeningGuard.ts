/**
 * The session-card menu selects on pointerdown and unmounts before click.
 * That click lands on the card, blurs the new rename field, and submits the
 * unchanged name. Hold the field open through that click, then focus it.
 */
export function armRenameOpeningClick(guard: {
  opening: { current: boolean };
  focus: () => void;
}): () => void {
  guard.opening.current = true;
  let timer = 0;
  const stopOpeningClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    window.removeEventListener('click', stopOpeningClick, true);
    timer = window.setTimeout(() => {
      guard.opening.current = false;
      guard.focus();
    }, 0);
  };
  window.addEventListener('click', stopOpeningClick, true);
  return () => {
    window.removeEventListener('click', stopOpeningClick, true);
    window.clearTimeout(timer);
    guard.opening.current = false;
  };
}
