import React, { useEffect, useRef, useState } from 'react'
import QuotaRing from './QuotaRing'
import {
  brandColor,
  checkinStat,
  expiryStat,
  expiryView,
  fmtCountdown,
  fmtDateTime,
  fmtRelative,
  fmtTime,
  monogram,
  quotaView,
  tone
} from '../lib/format'

const MAX_PACKS = 3

/** 无签到平台的说明文案：按钮直接消失会让人以为界面缺了东西，必须写清原因 */
function noCheckinHint(platformId) {
  const qoderNote = String(platformId || '').startsWith('qoder')
    ? '（Qoder 的权益需在客户端「权益中心」手动领取）'
    : ''
  return `该平台未开放签到接口${qoderNote}`
}

export default function AccountCard({ account, platform, onAction, busy, selected, onToggleSelect }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(account.name)
  const [openPacks, setOpenPacks] = useState(false)
  // 摘要态 / 展开态：详情默认折叠，展开后原有信息一条不少
  const [expanded, setExpanded] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef(null)

  useEffect(() => {
    if (!moreOpen) return
    const close = (e) => {
      if (moreRef.current && !moreRef.current.contains(e.target)) setMoreOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [moreOpen])

  const quota = account.quota
  const view = quotaView(quota && quota.summary)
  const pct = view ? view.percent : null
  const allItems = quota && Array.isArray(quota.items) ? quota.items : []
  const items = openPacks ? allItems : allItems.slice(0, MAX_PACKS)
  const resetAt = quota && quota.summary && quota.summary.resetAt
  const exp = expiryStat(quota)
  const ck = checkinStat(account)
  const quotaFail = account.quotaError
  const noCheckin = Boolean(platform) && platform.supportsCheckin === false
  const lastUsed = fmtRelative(account.lastUsed)
  // 有些平台的账号名就是邮箱/uid 本身，第二行再印一遍纯属冗余：改显示平台名，
  // 但保留两行结构（.cards 用 align-items:start，隐藏会让卡片高度参差）。
  const secondary = account.email || account.uid || '—'
  const sameAsName = String(secondary).trim() === String(account.name || '').trim()
  const secondaryText = sameAsName
    ? (platform && platform.label) || account.platformLabel || account.platform || '—'
    : secondary

  function toggleSelect() {
    if (onToggleSelect) onToggleSelect(account.id)
  }

  function switchAccount() {
    // 切号会关掉客户端并改写本机登录态，属于破坏性操作，必须先确认
    if (!confirm(`切换会关闭 ${platform ? platform.label : account.platformLabel} 客户端并改写本机登录态，确定？`)) return
    onAction('switch', account)
  }

  /**
   * 状态标记统一建模：数组第 1 项永远是签到状态（或「无签到活动」说明），
   * 其后按严重度排布异常。摘要态只取前 2 个 —— 签到状态 + 最严重的一条异常；
   * 展开态全部展示，旧版能看到的标记一个不少。
   */
  const primary = (() => {
    if (!ck.supported) {
      return noCheckin
        ? { key: 'no', text: '无签到活动', cls: 'dim', title: noCheckinHint(account.platform) }
        : null
    }
    if (ck.failed) return { key: 'ck', text: '签到检测失败', cls: 'danger', title: ck.message || '' }
    if (ck.checkedIn === null) return { key: 'ck', text: '签到待检测', cls: '', title: '' }
    if (ck.checkedIn) {
      return {
        key: 'ck',
        text: `今日已签到${ck.streakDays ? ` · 连续 ${ck.streakDays} 天` : ''}`,
        cls: 'ok',
        title: ck.message || ''
      }
    }
    return { key: 'ck', text: '今日未签到', cls: 'warn', title: '' }
  })()

  const anomalies = []
  if (quotaFail) anomalies.push({ key: 'qf', text: '额度获取失败', cls: 'danger', title: quotaFail.message || '' })
  if (quota && quota.blocked) anomalies.push({ key: 'blocked', text: '用量触顶', cls: 'danger', title: '' })
  if (exp.expired > 0) anomalies.push({ key: 'expired', text: `${exp.expired} 个资源包已过期`, cls: 'danger', title: '' })
  if (exp.expired === 0 && exp.soon) {
    anomalies.push({ key: 'soon', text: `${fmtCountdown(exp.expiresAt)}到期`, cls: 'warn', title: '' })
  }
  if (ck.supported && noCheckin) {
    anomalies.push({ key: 'no', text: '无签到活动', cls: 'dim', title: noCheckinHint(account.platform) })
  }

  const badges = [primary, ...anomalies].filter(Boolean)
  const shownBadges = expanded ? badges : badges.slice(0, 2)
  const detailLabel = allItems.length > 0 ? `查看 ${allItems.length} 个资源包 / 详情` : '查看详情'

  return (
    <div
      className={
        'card' + (account.isCurrent ? ' current' : '') + (selected ? ' selected' : '') +
        (expanded ? ' expanded' : '') + (moreOpen ? ' menu-open' : '')
      }
      style={{ '--card-accent': brandColor(account.platform) }}
    >
      <label className={'card-check' + (selected ? ' on' : '')} title={selected ? '取消选择' : '选择此账号'}>
        <input type="checkbox" checked={Boolean(selected)} onChange={toggleSelect} />
      </label>

      <div className="card-head">
        <div className="avatar">{monogram((platform && platform.label) || account.platformLabel || account.platform)}</div>
        <div className="card-id">
          {editing ? (
            <input
              className="name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                setEditing(false)
                const next = name.trim()
                if (next && next !== account.name) onAction('rename', account, next)
              }}
              onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
              autoFocus
            />
          ) : (
            <div className="name" title="双击重命名" onDoubleClick={() => setEditing(true)}>
              {account.name}
              {account.isCurrent && <span className="tag-current" style={{ marginLeft: 6 }}>当前</span>}
            </div>
          )}
          <div className="muted small" title={secondaryText}>
            {secondaryText}
          </div>
          {expanded && lastUsed && <div className="muted tiny">上次使用 · {lastUsed}</div>}
        </div>
        {expanded && (
          <div style={{ textAlign: 'right', flex: 'none' }}>
            <span className="badge plan">{(quota && quota.plan) || account.plan || '未知套餐'}</span>
            <div className="muted tiny">{fmtTime(quota && quota.fetchedAt)}</div>
          </div>
        )}
      </div>

      {shownBadges.length > 0 && (
        <div className="chips">
          {shownBadges.map((b) => (
            <span className={'badge' + (b.cls ? ' ' + b.cls : '')} key={b.key} title={b.title || undefined}>
              {b.text}
            </span>
          ))}
        </div>
      )}

      {expanded ? (
        <div className="card-body">
          <QuotaRing percent={pct} tone={quota ? tone(pct) : 'idle'} />
          <div className="quota-text">
            {view ? (
              <>
                <span className="quota-value">{view.value}</span>
                {view.unit && <span className="quota-unit">{view.unit}</span>}
                <div className="muted small">{view.sub}</div>
                <div className="muted tiny">
                  {resetAt
                    ? `${fmtDateTime(resetAt)} 重置 · ${fmtCountdown(resetAt)}`
                    : quota && quota.message
                      ? quota.message
                      : ''}
                </div>
              </>
            ) : (
              <div className="muted small">
                {(quota && quota.message) || (quota ? '该平台未返回汇总额度' : '未查询额度')}
              </div>
            )}
            {items.length > 0 && (
              <div className="packs">
                {items.map((p, i) => {
                  const ev = expiryView(p)
                  return (
                    <div className={'pack' + (ev && ev.expired ? ' expired' : '')} key={i}>
                      <div className="pack-title">
                        <span className="pack-name" title={p.label}>
                          {p.label}
                        </span>
                        {ev ? (
                          <span className={'pack-expiry ' + ev.tone}>{ev.text}</span>
                        ) : (
                          <span className="pack-expiry muted">长期有效</span>
                        )}
                      </div>
                      {(p.metrics || []).slice(0, 3).map((m, j) => {
                        // 主指标偶尔是「剩余」而不是「已用」（如 DuMate 积分包），由 showRemaining 显式声明
                        const shown = m.showRemaining && m.remaining != null ? m.remaining : m.used
                        return (
                          <div className="metric" key={j}>
                            <span>{m.label}</span>
                            <span className="muted">
                              {shown != null ? shown : '—'}
                              {m.limit != null ? ` / ${m.limit}` : ''}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
                {allItems.length > MAX_PACKS && (
                  <button className="pack-more" onClick={() => setOpenPacks((v) => !v)}>
                    {openPacks ? '收起' : `展开其余 ${allItems.length - MAX_PACKS} 个资源包`}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="quota-summary">
          {view ? (
            <>
              <div className="quota-line">
                <span className="quota-value">{view.value}</span>
                {view.unit && <span className="quota-unit">{view.unit}</span>}
              </div>
              {pct != null && (
                <div className="bar">
                  <div className="bar-inner" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
                </div>
              )}
            </>
          ) : (
            <div className="quota-empty muted small">
              {(quota && quota.message) || (quota ? '该平台未返回汇总额度' : '未查询额度')}
            </div>
          )}
        </div>
      )}

      <div className="actions">
        {platform && platform.readOnly ? (
          <button className="btn sm" disabled title="该平台登录态由其私有密钥加密，不支持外部切号">
            不支持切号
          </button>
        ) : (
          <button className="btn sm primary" disabled={busy} onClick={switchAccount}>
            {expanded ? '切换到此账号' : '切换'}
          </button>
        )}

        {expanded ? (
          <>
            <button className="btn sm" disabled={busy} onClick={() => onAction('quota', account)}>
              刷新额度
            </button>
            {platform && platform.supportsCheckin && (
              <button
                className="btn sm"
                disabled={busy || ck.checkedIn === true}
                title={ck.checkedIn === true ? '今天已经签过到了' : ck.message || ''}
                onClick={() => onAction('checkin', account)}
              >
                {ck.checkedIn === true ? '已签到' : '签到'}
              </button>
            )}
            <button className="btn sm danger" disabled={busy} onClick={() => onAction('remove', account)}>
              删除
            </button>
          </>
        ) : (
          <div className="more-wrap" ref={moreRef}>
            <button className="btn sm link" disabled={busy} onClick={() => setMoreOpen((v) => !v)}>
              更多 <span className="caret">▾</span>
            </button>
            {moreOpen && (
              <div className="more-menu">
                <button
                  className="more-item"
                  disabled={busy}
                  onClick={() => {
                    setMoreOpen(false)
                    onAction('quota', account)
                  }}
                >
                  刷新额度
                </button>
                {platform && platform.supportsCheckin && (
                  <button
                    className="more-item"
                    disabled={busy || ck.checkedIn === true}
                    title={ck.checkedIn === true ? '今天已经签过到了' : ck.message || ''}
                    onClick={() => {
                      setMoreOpen(false)
                      onAction('checkin', account)
                    }}
                  >
                    {ck.checkedIn === true ? '已签到' : '签到'}
                  </button>
                )}
                <button
                  className="more-item danger"
                  disabled={busy}
                  onClick={() => {
                    setMoreOpen(false)
                    onAction('remove', account)
                  }}
                >
                  删除
                </button>
              </div>
            )}
          </div>
        )}

        <button
          className="detail-toggle"
          onClick={() => {
            setExpanded((v) => !v)
            setMoreOpen(false)
          }}
        >
          {expanded ? '收起详情' : detailLabel} <span className="caret">{expanded ? '▴' : '▾'}</span>
        </button>
      </div>
    </div>
  )
}
