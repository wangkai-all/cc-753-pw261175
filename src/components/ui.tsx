import type { ReactNode } from 'react'

export function Card({
  title,
  aside,
  children,
  className,
}: {
  title?: ReactNode
  aside?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || aside) && (
        <header className="card-head">
          <h2>{title}</h2>
          {aside}
        </header>
      )}
      {children}
    </section>
  )
}

export function Notice({
  tone = 'info',
  icon,
  children,
}: {
  tone?: 'info' | 'warn' | 'critical' | 'good'
  icon?: string
  children: ReactNode
}) {
  const glyph = icon ?? (tone === 'critical' ? '!' : tone === 'warn' ? '!' : tone === 'good' ? '✓' : 'i')
  return (
    <div className={`notice notice-${tone}`} role={tone === 'critical' ? 'alert' : undefined}>
      <span className="notice-icon" aria-hidden="true">
        {glyph}
      </span>
      <div>{children}</div>
    </div>
  )
}

export function Stat({
  label,
  value,
  sub,
  small,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  small?: boolean
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${small ? 'sm' : ''}`}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

export function Swatch({ slot, line }: { slot: number; line?: boolean }) {
  return (
    <span
      className={line ? 'swatch swatch-line' : 'swatch'}
      style={{ background: `var(--series-${Math.min(8, Math.max(1, slot))})` }}
      aria-hidden="true"
    />
  )
}

export function Seg<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T
  options: { value: T; label: string; title?: string }[]
  onChange: (value: T) => void
  ariaLabel: string
}) {
  return (
    <div className="seg" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="field">
      <label>
        <span>{label}</span>
        {hint && <span className="muted small">{hint}</span>}
      </label>
      {children}
    </div>
  )
}
