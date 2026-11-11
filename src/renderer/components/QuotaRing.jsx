import React from 'react'

const COLORS = { ok: 'var(--ok)', warn: 'var(--warn)', danger: 'var(--danger)', idle: '#3a4b68' }

export default function QuotaRing({ percent, tone = 'idle', size = 66, label }) {
  const stroke = size < 30 ? 3 : 6
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const p = percent == null ? 0 : Math.max(0, Math.min(100, percent))
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle className="track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} />
        <circle
          className="value"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={COLORS[tone] || COLORS.idle}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c - (c * p) / 100}
        />
      </svg>
      <div className="ring-label" style={{ fontSize: size < 30 ? 9 : 13 }}>
        {label ?? (percent == null ? '—' : `${Math.round(p)}%`)}
      </div>
    </div>
  )
}
