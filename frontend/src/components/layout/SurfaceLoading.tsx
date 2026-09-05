export function SurfaceLoading({
  label,
  sections = 2,
}: {
  label?: string;
  sections?: 1 | 2;
}) {
  return (
    <div
      className="agent-settings-loading flex flex-col gap-4"
      role="status"
      aria-busy="true"
      aria-label={label}
    >
      <section className="settings-surface" aria-hidden="true">
        <div className="agent-section-heading">
          <span className="agent-settings-loading-line agent-settings-loading-line-heading" />
        </div>
        <ul className="agent-settings-loading-rows">
          <li />
          <li />
          <li />
        </ul>
      </section>
      {sections === 2 ? (
        <section className="settings-surface" aria-hidden="true">
          <div className="agent-section-heading">
            <span className="agent-settings-loading-line agent-settings-loading-line-heading" />
          </div>
          <ul className="agent-settings-loading-rows">
            <li />
            <li />
          </ul>
        </section>
      ) : null}
    </div>
  );
}
