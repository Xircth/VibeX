import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

type CollapsibleUserTextBlockProps = {
  content: string;
};

const MAX_COLLAPSED_HEIGHT = 160;

export const CollapsibleUserTextBlock = memo(function CollapsibleUserTextBlock({
  content,
}: CollapsibleUserTextBlockProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!contentRef.current) {
      return;
    }

    const checkHeight = () => {
      if (!contentRef.current) {
        return;
      }
      setIsOverflowing(contentRef.current.scrollHeight > MAX_COLLAPSED_HEIGHT);
    };

    checkHeight();
    const observer = new ResizeObserver(checkHeight);
    observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [content]);

  return (
    <div className={`user-collapsible-block ${expanded ? "is-expanded" : "is-collapsed"}`}>
      <div
        className="user-collapsible-content"
        ref={contentRef}
        style={{
          maxHeight: expanded || !isOverflowing ? "none" : `${MAX_COLLAPSED_HEIGHT}px`,
          overflow: "hidden",
        }}
      >
        <div className="user-collapsible-text-content">{content}</div>
        {!expanded && isOverflowing ? <div className="user-collapsible-overlay" /> : null}
      </div>
      {isOverflowing ? (
        <button
          type="button"
          className="user-collapsible-toggle"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          aria-label={expanded ? t("messages.collapseInput") : t("messages.expandInput")}
        >
          <span className={`codicon codicon-chevron-down${expanded ? " is-expanded" : ""}`} />
        </button>
      ) : null}
    </div>
  );
});
