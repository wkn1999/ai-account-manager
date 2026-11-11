import React, { useEffect, useState } from 'react'

export default function SettingsDrawer({ settings, onSave, onClose }) {
  const [proxy, setProxy] = useState(settings.proxyUrl || '')
  const [minutes, setMinutes] = useState(settings.refreshMinutes || 10)
  const [hour, setHour] = useState(settings.checkinHour ?? 9)

  useEffect(() => setProxy(settings.proxyUrl || ''), [settings.proxyUrl])
  useEffect(() => setMinutes(settings.refreshMinutes || 10), [settings.refreshMinutes])

  return (
    <>
      <div className="mask" onClick={onClose} />
      <div className="drawer">
        <h3>设置</h3>
        <div className="muted tiny">改动即时生效</div>

        <div className="field switch">
          <span>定时自动刷新额度</span>
          <input
            type="checkbox"
            checked={Boolean(settings.autoRefreshEnabled)}
            onChange={(e) => onSave({ autoRefreshEnabled: e.target.checked })}
          />
        </div>

        <div className="field switch">
          <span>刷新间隔（分钟）</span>
          <input
            type="number"
            min="1"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            onBlur={() => onSave({ refreshMinutes: Math.max(1, Number(minutes) || 1) })}
            onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
          />
        </div>

        <div className="field switch">
          <span>每日自动签到</span>
          <input
            type="checkbox"
            checked={Boolean(settings.autoCheckinEnabled)}
            onChange={(e) => onSave({ autoCheckinEnabled: e.target.checked })}
          />
        </div>

        <div className="field switch">
          <span>签到时（24 小时制）</span>
          <input
            type="number"
            min="0"
            max="23"
            value={hour}
            onChange={(e) => setHour(e.target.value)}
            onBlur={() => onSave({ checkinHour: Math.min(23, Math.max(0, Number(hour) || 0)) })}
            onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
          />
        </div>

        <div className="muted tiny">
          自动签到只在应用处于开启状态时生效；当天重复触发不影响已签到的账号。
        </div>

        <div className="field">
          <span>网络代理</span>
          <input
            type="text"
            placeholder="http://127.0.0.1:7890"
            value={proxy}
            onChange={(e) => setProxy(e.target.value)}
            onBlur={() => onSave({ proxyUrl: proxy.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
          />
          <div className="muted tiny">ChatGPT / Codex 接口直连不通时填写；留空则跟随系统代理。仅影响本应用发出的请求。</div>
        </div>

        <button className="btn" onClick={onClose}>
          关闭
        </button>
      </div>
    </>
  )
}
