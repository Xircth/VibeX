import { screen } from '@testing-library/react';

type Clicker = { click: (element: Element) => Promise<unknown> };

/**
 * Interacts with an AstryxSelect in tests: opens the trigger's listbox and
 * picks the option whose accessible name is `optionName`.
 */
export async function pickAstryxOption(
  user: Clicker,
  trigger: HTMLElement,
  optionName: string
) {
  await user.click(trigger);
  await user.click(await screen.findByRole('option', { name: optionName }));
}
