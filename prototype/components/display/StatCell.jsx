import React from 'react';
export function StatCell({ label, value, last }) {
  return (
    <div style={{ padding: '8px 14px', borderRight: last ? 'none' : 'var(--border-w) solid var(--border-color)',
      display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: '4px', fontFamily: 'var(--font-mono)' }}>
      <div style={{ fontSize: 'var(--fs-kicker)', letterSpacing: 'var(--ls-kicker)', color: 'var(--text-muted)', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 'var(--fs-stat)', color: 'var(--text-color)', whiteSpace: 'nowrap' }}>{value}</div>
    </div>
  );
}