import React from 'react';
export function PaperCard({ raised, hatched, style, children }) {
  return (
    <div style={{ border: 'var(--border-w) solid var(--border-color)',
      backgroundColor: raised ? 'var(--paper-raised)' : hatched ? 'var(--paper-sunken)' : 'var(--paper)',
      backgroundImage: hatched ? 'var(--hatch-light)' : 'none',
      color: 'var(--text-color)', padding: '11px 13px', fontFamily: 'var(--font-mono)',
      fontSize: 'var(--fs-body)', lineHeight: 'var(--leading-body)', borderRadius: 'var(--radius)', ...style }}>
      {children}
    </div>
  );
}