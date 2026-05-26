import { ClickableCodePlugin } from './plugins/clickable-code-plugin';
import { ReadOnlyLinkPlugin } from './plugins/read-only-link-plugin';

type WysiwygReadOnlyPluginsProps = {
  findMatchingDiffPath?: (text: string) => string | null;
  onCodeClick?: (fullPath: string) => void;
};

export function WysiwygReadOnlyPlugins({
  findMatchingDiffPath,
  onCodeClick,
}: WysiwygReadOnlyPluginsProps) {
  return (
    <>
      <ReadOnlyLinkPlugin />
      {findMatchingDiffPath && onCodeClick && (
        <ClickableCodePlugin
          findMatchingDiffPath={findMatchingDiffPath}
          onCodeClick={onCodeClick}
        />
      )}
    </>
  );
}
