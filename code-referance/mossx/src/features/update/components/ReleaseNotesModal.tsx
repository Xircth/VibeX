import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import X from "lucide-react/dist/esm/icons/x";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Markdown } from "../../messages/components/Markdown";
import type { ReleaseNotesEntry } from "../hooks/useReleaseNotes";

type ReleaseNotesModalProps = {
  isOpen: boolean;
  entries: ReleaseNotesEntry[];
  activeIndex: number;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onRetry: () => void;
};

export function ReleaseNotesModal({
  isOpen,
  entries,
  activeIndex,
  loading,
  error,
  onClose,
  onPrev,
  onNext,
  onRetry,
}: ReleaseNotesModalProps) {
  const { t } = useTranslation();

  const currentEntry = useMemo(
    () => entries[activeIndex] ?? null,
    [activeIndex, entries],
  );
  const currentPage = entries.length > 0 ? activeIndex + 1 : 0;
  const hasPrevious = activeIndex > 0;
  const hasNext = activeIndex < entries.length - 1;

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "ArrowLeft" && hasPrevious) {
        event.preventDefault();
        onPrev();
      }
      if (event.key === "ArrowRight" && hasNext) {
        event.preventDefault();
        onNext();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [hasNext, hasPrevious, isOpen, onClose, onNext, onPrev]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="release-notes-modal" role="dialog" aria-modal="true" aria-label={t("update.releaseNotesTitle")}>
      <button
        type="button"
        className="release-notes-modal-backdrop"
        aria-label={t("common.close")}
        onClick={onClose}
      />
      <section className="release-notes-modal-card">
        <header className="release-notes-modal-header">
          <div className="release-notes-modal-heading">
            <h2>{t("update.releaseNotesTitle")}</h2>
            {currentEntry ? (
              <>
                <span className="release-notes-modal-version">
                  {currentEntry.tagName}
                </span>
                {currentEntry.dateLabel ? (
                  <span className="release-notes-modal-date">{currentEntry.dateLabel}</span>
                ) : null}
              </>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="release-notes-modal-close"
            aria-label={t("common.close")}
            onClick={onClose}
          >
            <X />
          </Button>
        </header>

        <div className="release-notes-modal-body">
          {loading ? (
            <div className="release-notes-modal-state">
              {t("update.releaseNotesLoading")}
            </div>
          ) : null}

          {!loading && error ? (
            <div className="release-notes-modal-state release-notes-modal-state-error">
              <p>{t("update.releaseNotesLoadFailed")}</p>
              <code>{error}</code>
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                {t("common.retry")}
              </Button>
            </div>
          ) : null}

          {!loading && !error && !currentEntry ? (
            <div className="release-notes-modal-state">
              {t("update.releaseNotesEmpty")}
            </div>
          ) : null}

          {!loading && !error && currentEntry ? (
            <ScrollArea className="release-notes-modal-scroll" scrollbarGutter>
              <div className="release-notes-modal-content">
                <section className="release-notes-language-block">
                  <h3 className="release-notes-language-title">
                    {t("update.releaseNotesEnglish")}
                  </h3>
                  <Markdown
                    value={currentEntry.englishBody || t("update.releaseNotesEmpty")}
                    className="release-notes-markdown markdown"
                  />
                </section>
                <section className="release-notes-language-block">
                  <h3 className="release-notes-language-title">
                    {t("update.releaseNotesChinese")}
                  </h3>
                  <Markdown
                    value={currentEntry.chineseBody || t("update.releaseNotesEmpty")}
                    className="release-notes-markdown markdown"
                  />
                </section>
              </div>
            </ScrollArea>
          ) : null}
        </div>

        <footer className="release-notes-modal-footer">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="release-notes-modal-nav"
            aria-label={t("update.releaseNotesPrev")}
            onClick={onPrev}
            disabled={!hasPrevious}
          >
            <ChevronLeft />
          </Button>
          <div className="release-notes-modal-pagination">
            {t("update.releaseNotesPage", {
              current: currentPage,
              total: entries.length,
            })}
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="release-notes-modal-nav"
            aria-label={t("update.releaseNotesNext")}
            onClick={onNext}
            disabled={!hasNext}
          >
            <ChevronRight />
          </Button>
        </footer>
      </section>
    </div>
  );
}
