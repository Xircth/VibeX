import type { ReactNode } from 'react';

export function AgentNativeResourceSection({
  icon,
  title,
  items,
  empty,
}: {
  icon: ReactNode;
  title: string;
  items: Array<{ id: string; detail?: string | null }>;
  empty: string;
}) {
  return (
    <div className="plugin-detail-section">
      <h4>
        {icon}
        {title}
      </h4>
      {items.length ? (
        <ul className="plugin-contribution-list">
          {items.map((item) => (
            <li key={`${item.id}:${item.detail ?? ''}`}>
              <span>{item.id}</span>
              {item.detail ? <code>{item.detail}</code> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="plugin-detail-empty-copy">{empty}</p>
      )}
    </div>
  );
}
