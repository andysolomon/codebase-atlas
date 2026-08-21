import React from 'react';
export function ListRow({ code, label, meta, selected, onClick }) {
  return (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'baseline', gap: '8px', padding: '4px 12px',
      cursor: onClick ? 'pointer' : 'default', fontFamily: 'var(--font-mono)', fontSize: '11px', lineHeight: 1.3,
      background: selected ? 'var(--highlight-bg)' : 'transparent',
      color: selected ? 'var(--highlight-fg)' : 'var(--text-color)' }}>
      <span style={{ flex: 'none', width: '20px', fontSize: '9px', border: 'var(--border-w-hair) solid currentColor', textAlign: 'center', padding: '1px 0' }}>{code}</span>
      <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      {meta ? <span style={{ flex: 'none', fontSize: '9px', opacity: .6 }}>{meta}</span> : null}
    </div>
  );
}