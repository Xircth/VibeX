const ROW_WIDTHS = ['72%', '54%', '86%', '48%', '64%'] as const;

export function ConversationTimelineSkeleton({ label }: { label: string }) {
  return (
    <div
      className="conv-thread-skeleton"
      data-testid="conversation-timeline-skeleton"
      role="status"
      aria-busy="true"
      aria-label={label}
    >
      {ROW_WIDTHS.map((width, index) => (
        <div className="conv-thread-skeleton-row" key={width}>
          <div
            className="conv-thread-skeleton-bar"
            style={{ width: index % 2 === 0 ? width : '28%' }}
          />
          {index % 2 === 0 ? (
            <div className="conv-thread-skeleton-bar" style={{ width }} />
          ) : null}
        </div>
      ))}
    </div>
  );
}
