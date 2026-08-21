import React from 'react';
export function Button({ variant = 'outline', size = 'md', disabled, style, children, ...rest }) {
  const pad = size === 'sm' ? '5px 9px' : size === 'lg' ? '11px 16px' : '9px 13px';
  const solid = variant === 'solid';
  return (
    <button disabled={disabled} {...rest} style={{
      fontFamily: 'var(--font-mono)', fontSize: size === 'sm' ? '10px' : 'var(--fs-label)',
      letterSpacing: 'var(--ls-label)', textTransform: 'uppercase',
      border: 'var(--border-w) solid ' + (variant === 'ghost' ? 'transparent' : 'var(--border-color)'),
      background: solid ? 'var(--highlight-bg)' : 'transparent',
      color: solid ? 'var(--highlight-fg)' : 'var(--text-color)',
      padding: pad, borderRadius: 'var(--radius)',
      cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.35 : 1, ...style }}>
      {children}
    </button>
  );
}