import React from 'react';
export function RuleHeading({ children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '9px', fontFamily: 'var(--font-mono)' }}>
      <span style={{ fontSize: 'var(--fs-kicker)', letterSpacing: 'var(--ls-kicker)', whiteSpace: 'nowrap', color: 'var(--text-color)', textTransform: 'uppercase' }}>{children}</span>
      <span style={{ flex: 1, height: 'var(--border-w)', background: 'var(--border-color)' }} />
    </div>
  );
}