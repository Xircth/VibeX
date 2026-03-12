import type { DropdownItemProps } from '../types';
import { sanitizeSvg } from '../utils/sanitize';

/**
 * DropdownItem - Dropdown menu item component
 */
export const DropdownItem = ({
  item,
  isActive = false,
  onClick,
  onMouseEnter,
}: DropdownItemProps) => {

  /**
   * Render icon
   */
  const renderIcon = () => {
    // If icon contains SVG tags, it's an inline SVG
    if (item.icon?.startsWith('<svg')) {
      return (
        <span
          className="dropdown-item-icon"
          dangerouslySetInnerHTML={{ __html: sanitizeSvg(item.icon) }}
          style={{
            width: 16,
            height: 16,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        />
      );
    }

    // Otherwise use codicon class name
    const iconClass = item.icon || getDefaultIconClass(item.type);
    return <span className={`dropdown-item-icon codicon ${iconClass}`} />;
  };

  /**
   * Get default icon class name (for codicon)
   */
  const getDefaultIconClass = (type?: string): string => {
    switch (type) {
      case 'file':
        return 'codicon-file';
      case 'directory':
        return 'codicon-folder';
      case 'command':
        return 'codicon-terminal';
      default:
        return 'codicon-symbol-misc';
    }
  };

  // Separator
  if (item.type === 'separator') {
    return <div className="dropdown-separator" />;
  }

  // Section header
  if (item.type === 'section-header') {
    return (
      <div className="dropdown-section-header">
        {item.label}
      </div>
    );
  }

  // All items are selectable (except loading indicator items)
  const isDisabled = item.id === '__loading__';

  return (
    <div
      className={`dropdown-item ${isActive ? 'active' : ''} ${isDisabled ? 'disabled' : ''}`}
      onClick={isDisabled ? undefined : onClick}
      onMouseEnter={() => {
        // Call the original onMouseEnter (for keyboard navigation highlighting)
        onMouseEnter?.();
      }}
      style={isDisabled ? { cursor: 'default' } : undefined}
    >
      {renderIcon()}
      <div className="dropdown-item-content">
        <div className="dropdown-item-label">{item.label}</div>
        {item.description && (
          <div className="dropdown-item-description">{item.description}</div>
        )}
      </div>
    </div>
  );
};

export default DropdownItem;
