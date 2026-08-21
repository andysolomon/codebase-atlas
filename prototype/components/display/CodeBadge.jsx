import React from 'react';
export function CodeBadge({ code, selected, size = 'md' }) {
  const big = size === 'lg';
  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, letterSpacing: '.05em',
      fontSize: big ? '26px' : '11px', padding: big ? '1px 9px' : '1px 6px',
      border: (big ? 'var(--border-w-heavy)' : 'var(--border-w-hair)') + ' solid var(--border-color)',
      background: selected ? 'var(--highlight-bg)' : 'transparent',
      color: selected ? 'var(--highlight-fg)' : 'var(--text-color)' }}>{code}</span>
  );
}