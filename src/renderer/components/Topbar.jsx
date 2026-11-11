import React, { useEffect, useRef, useState } from 'react'

const LOGIN_HINT = {
  oauth: '在应用内完成授权',
  client: '启动客户端登录后自动导入',
  none: '该平台不支持在本应用登录'
}

export default function Topbar({
  title,
  subtitle,
  view,
  platforms,
  query,
  onQuery,
  onDetect,
  onRefreshAll,
  onCheckinAll,
  onLogin,
  busy,
  progress,
  canCheckin,
  pending = 0
}) {
  const [menu, setMenu] = useState(false)
  const wrapRef = useRef(null)

  useEffect(() => {
    if (!menu) return
    const close = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setMenu(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menu])

  function pick(id) {
    setMenu(false)
    onLogin(id)
  }

  const single = view !== 'all' ? platforms.find((p) => p.id === view) : null

  return (
    <header className="topbar">
      <div className="topbar-title">
        <h2>{title}</h2>
        <div className="title-sub">
          <span className="muted tiny title-sub-text">{subtitle}</span>
          {/* 进度是状态提示，不该占动作位：放进标题区，动作区只留按钮，1280 下才能一行放下 */}
          {progress && (
            <span className="progress-pill" title={progress.name || ''}>
              <span className="spin" />
              {progress.label} {progress.done}/{progress.total}
              {progress.name ? ` · ${progress.name}` : ''}
            </span>
          )}
        </div>
      </div>
      <div className="top-actions">
        <input
          className="search"
          placeholder="搜索账号 / 邮箱"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
        {single && single.loginMode !== 'none' ? (
          <button className="btn" disabled={busy} title={LOGIN_HINT[single.loginMode]} onClick={() => onLogin(single.id)}>
            登录账号
          </button>
        ) : (
          <div className="menu-wrap" ref={wrapRef}>
            <button className="btn" disabled={busy} onClick={() => setMenu((v) => !v)}>
              登录新账号 <span className="caret">▾</span>
            </button>
            {menu && (
              <div className="menu">
                {platforms.map((p) => (
                  <button
                    className="menu-item"
                    key={p.id}
                    disabled={p.loginMode === 'none'}
                    title={LOGIN_HINT[p.loginMode]}
                    onClick={() => pick(p.id)}
                  >
                    <span>{p.label}</span>
                    <span className="muted tiny">{p.loginMode === 'oauth' ? '应用内授权' : p.loginMode === 'client' ? '拉起客户端' : '仅导入'}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button className="btn primary" disabled={busy} onClick={onDetect}>
          {busy ? <span className="spin" /> : null} 检测本机账号
        </button>
        <button className="btn" disabled={busy} onClick={onRefreshAll}>
          刷新全部额度
        </button>
        {canCheckin && (
          <button
            className="btn"
            disabled={busy || pending <= 0}
            title={pending > 0 ? `还有 ${pending} 个账号待签到` : '今日可签到的账号都已签到'}
            onClick={onCheckinAll}
          >
            {`${view === 'all' ? '全部签到' : '签到本平台'} (${pending})`}
          </button>
        )}
      </div>
    </header>
  )
}
