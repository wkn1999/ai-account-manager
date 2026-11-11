import React from 'react'
import QuotaRing from './QuotaRing'
import { brandColor, navLabel, quotaView, tone } from '../lib/format'

function worstPercent(list) {
  let worst = null
  for (const a of list) {
    const v = quotaView(a.quota && a.quota.summary)
    if (v && (worst == null || v.percent > worst)) worst = v.percent
  }
  return worst
}

export default function Sidebar({ platforms, accounts, view, onView, onOpenSettings, onOpenWorkspace }) {
  const byPlatform = (id) => accounts.filter((a) => a.platform === id)

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">AI</div>
        <div>AI账号管家</div>
      </div>

      <div className={'nav-item' + (view === 'all' ? ' active' : '')} onClick={() => onView('all')}>
        <span className="dot" style={{ background: 'var(--accent)' }} />
        <span className="grow">总览</span>
        <span className="count">{accounts.length}</span>
      </div>

      {platforms.map((p) => {
        const list = byPlatform(p.id)
        const worst = worstPercent(list)
        const current = list.find((a) => a.isCurrent)
        return (
          <div key={p.id} className={'nav-item' + (view === p.id ? ' active' : '')} onClick={() => onView(p.id)} title={p.label}>
            <span className="dot" style={{ background: brandColor(p.id) }} />
            <span className="nav-text grow">
              <span className="nav-label">{navLabel(p.label)}</span>
              {/* 平台内多账号时，光看数量分不出现在登录的是谁 */}
              <span className={'nav-sub' + (current ? '' : ' nav-sub-empty')} title={current ? current.name : '未登录'}>
                {current ? current.name : '未登录'}
              </span>
            </span>
            {worst != null && <QuotaRing size={22} percent={worst} tone={tone(worst)} label={`${Math.round(worst)}`} />}
            <span className="count">{list.length}</span>
          </div>
        )
      })}

      <div className="sidebar-foot ws-foot">
        <button className="btn ghost sm" onClick={onOpenWorkspace}>
          工作台
        </button>
        <button className="btn ghost sm" onClick={onOpenSettings}>
          设置
        </button>
      </div>
    </aside>
  )
}
