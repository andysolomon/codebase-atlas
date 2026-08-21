/* Atlas DS bundle — plain-JS builds of the component set (no JSX, loadable as a normal script). */
(function () {
  const h = (t, p) => React.createElement(t, p, ...[].slice.call(arguments, 2).flat ? [].slice.call(arguments, 2) : []);
  const e = React.createElement;
  function Button(props) {
    const { variant = 'outline', size = 'md', disabled, style, children } = props;
    const pad = size === 'sm' ? '5px 9px' : size === 'lg' ? '11px 16px' : '9px 13px';
    const solid = variant === 'solid';
    const rest = Object.assign({}, props); ['variant', 'size', 'style', 'children'].forEach((k) => delete rest[k]);
    return e('button', Object.assign(rest, { style: Object.assign({
      fontFamily: 'var(--font-mono)', fontSize: size === 'sm' ? '10px' : 'var(--fs-label)',
      letterSpacing: 'var(--ls-label)', textTransform: 'uppercase',
      border: 'var(--border-w) solid ' + (variant === 'ghost' ? 'transparent' : 'var(--border-color)'),
      background: solid ? 'var(--highlight-bg)' : 'transparent',
      color: solid ? 'var(--highlight-fg)' : 'var(--text-color)',
      padding: pad, borderRadius: 'var(--radius)',
      cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.35 : 1 }, style) }), children);
  }
  function StatCell({ label, value, last }) {
    return e('div', { style: { padding: '8px 14px', borderRight: last ? 'none' : 'var(--border-w) solid var(--border-color)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: '4px', fontFamily: 'var(--font-mono)' } },
      e('div', { style: { fontSize: 'var(--fs-kicker)', letterSpacing: 'var(--ls-kicker)', color: 'var(--text-muted)', textTransform: 'uppercase' } }, label),
      e('div', { style: { fontSize: 'var(--fs-stat)', color: 'var(--text-color)', whiteSpace: 'nowrap' } }, value));
  }
  function CodeBadge({ code, selected, size = 'md' }) {
    const big = size === 'lg';
    return e('span', { style: { fontFamily: 'var(--font-mono)', fontWeight: 700, letterSpacing: '.05em',
      fontSize: big ? '26px' : '11px', padding: big ? '1px 9px' : '1px 6px',
      border: (big ? 'var(--border-w-heavy)' : 'var(--border-w-hair)') + ' solid var(--border-color)',
      background: selected ? 'var(--highlight-bg)' : 'transparent',
      color: selected ? 'var(--highlight-fg)' : 'var(--text-color)' } }, code);
  }
  function RuleHeading({ children }) {
    return e('div', { style: { display: 'flex', alignItems: 'center', gap: '9px', fontFamily: 'var(--font-mono)' } },
      e('span', { style: { fontSize: 'var(--fs-kicker)', letterSpacing: 'var(--ls-kicker)', whiteSpace: 'nowrap', color: 'var(--text-color)', textTransform: 'uppercase' } }, children),
      e('span', { style: { flex: 1, height: 'var(--border-w)', background: 'var(--border-color)' } }));
  }
  function PaperCard({ raised, hatched, style, children }) {
    return e('div', { style: Object.assign({ border: 'var(--border-w) solid var(--border-color)',
      backgroundColor: raised ? 'var(--paper-raised)' : hatched ? 'var(--paper-sunken)' : 'var(--paper)',
      backgroundImage: hatched ? 'var(--hatch-light)' : 'none',
      color: 'var(--text-color)', padding: '11px 13px', fontFamily: 'var(--font-mono)',
      fontSize: 'var(--fs-body)', lineHeight: 'var(--leading-body)', borderRadius: 'var(--radius)' }, style) }, children);
  }
  function ListRow({ code, label, meta, selected, onClick }) {
    return e('div', { onClick, style: { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '4px 12px',
      cursor: onClick ? 'pointer' : 'default', fontFamily: 'var(--font-mono)', fontSize: '11px', lineHeight: 1.3,
      background: selected ? 'var(--highlight-bg)' : 'transparent',
      color: selected ? 'var(--highlight-fg)' : 'var(--text-color)' } },
      e('span', { style: { flex: 'none', width: '20px', fontSize: '9px', border: 'var(--border-w-hair) solid currentColor', textAlign: 'center', padding: '1px 0' } }, code),
      e('span', { style: { flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
      meta ? e('span', { style: { flex: 'none', fontSize: '9px', opacity: 0.6 } }, meta) : null);
  }
  window.AtlasDS = { Button, StatCell, CodeBadge, RuleHeading, PaperCard, ListRow };
})();
