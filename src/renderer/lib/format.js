export const round2 = (n) => Math.round((n ?? 0) * 100) / 100

export function fmtTime(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

export function tone(percent) {
  if (percent == null) return 'idle'
  if (percent >= 90) return 'danger'
  if (percent >= 70) return 'warn'
  return 'ok'
}

/**
 * 把各平台形态不同的 quota.summary 归一成一种视图模型：
 * amount —— 有明确总量（Trae / CodeBuddy）
 * percent —— 只有百分比（Qoder 仅回传 percentage、Codex 的用量窗口）
 */
export function quotaView(summary) {
  if (!summary) return null
  const p = usagePercent(summary)
  if (p == null) return null
  if (summary.unit === '%') {
    return { mode: 'percent', percent: p, value: `${round2(p)}%`, caption: '用量', sub: `已用 ${round2(p)}%` }
  }
  if (summary.total > 0) {
    return {
      mode: 'amount',
      percent: p,
      value: round2(summary.remaining),
      unit: ` / ${round2(summary.total)} ${summary.unit || ''}`.trim(),
      sub: `已用 ${round2(summary.used)} · 剩余 ${round2(summary.remaining)} ${summary.unit || ''}`.trim()
    }
  }
  return { mode: 'percent', percent: p, value: `${round2(p)}%`, caption: '用量', sub: `已用 ${round2(p)}% · 该平台未返回总量` }
}

export function usagePercent(s) {
  if (!s) return null
  if (s.total > 0) return Math.min(100, ((s.used ?? 0) / s.total) * 100)
  if (s.percent == null) return null
  return Math.max(0, Math.min(100, s.percent > 0 && s.percent <= 1 ? s.percent * 100 : s.percent))
}

export const BRAND = {
  trae: '#4f9dff',
  'trae-cn': '#4f9dff',
  qoder: '#8b6cff',
  'qoder-cn': '#8b6cff',
  codebuddy: '#22c9a4',
  'codebuddy-cn': '#22c9a4',
  workbuddy: '#f5a524',
  dumate: '#2932e1',
  codex: '#25d07d'
}

export function brandColor(platformId) {
  return BRAND[platformId] || '#6b7280'
}

/** 侧栏宽度有限：国际版 → 国际，国内版 → 国内 */
export function navLabel(label) {
  return String(label || '').replace(/(国际|国内)版/, '$1')
}

export function monogram(label) {
  const text = (label || '?').trim()
  const ascii = /^[A-Za-z]/.test(text) ? text.slice(0, 1).toUpperCase() : text.slice(0, 1)
  return ascii
}

export function isToday(ts) {
  if (!ts) return false
  const d = new Date(ts)
  const n = new Date()
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
}

/** 两位补零，避免 2026-1-5 这种对不齐的时间 */
const pad = (n) => String(n).padStart(2, '0')

/** 到期时间用绝对日期展示，倒计时只作辅助 —— 用户要的是「到底哪天过期」 */
export function fmtDateTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 「上次使用 · 3 小时前」这种相对时间：用于上次使用等弱信息，绝对时间反而要心算 */
export function fmtRelative(ts, now = Date.now()) {
  if (!ts) return null
  const diff = now - ts
  if (diff < 60000) return '刚刚'
  const min = Math.floor(diff / 60000)
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  const month = Math.floor(day / 30)
  if (month < 12) return `${month} 个月前`
  return `${Math.floor(month / 12)} 年前`
}

/** 精确倒计时：天/时/分三级，不足 1 分钟显示「即将」 */
export function fmtCountdown(ts, now = Date.now()) {
  if (!ts) return null
  const diff = ts - now
  const abs = Math.abs(diff)
  const day = Math.floor(abs / 86400000)
  const hour = Math.floor((abs % 86400000) / 3600000)
  const min = Math.floor((abs % 3600000) / 60000)
  const parts = day > 0 ? `${day} 天 ${hour} 小时` : hour > 0 ? `${hour} 小时 ${min} 分` : min > 0 ? `${min} 分钟` : null
  if (!parts) return diff >= 0 ? '即将重置' : '刚刚过期'
  return diff >= 0 ? `${parts}后` : `${parts}前`
}

/** 资源包到期行：过期标红，剩余不足 3 天标黄 */
export function expiryView(item, now = Date.now()) {
  if (!item || item.endTime == null) return null
  // 以渲染时刻判定，不看抓取时写下的 expired —— 数据放一晚上也不会显示成「还有几小时」
  const expired = item.endTime < now
  const date = fmtDateTime(item.endTime)
  const relative = fmtCountdown(item.endTime, now)
  const tone = expired ? 'danger' : item.endTime - now < 3 * 86400000 ? 'warn' : 'muted'
  return { expired, date, relative, text: expired ? `${date} 已过期` : `${date} · ${relative}`, tone }
}

const SOON = 7 * 86400000

/** 账号的到期情况：几个资源包已过期 + 最近一个何时到期 */
export function expiryStat(quota, now = Date.now()) {
  const items = quota && Array.isArray(quota.items) ? quota.items : []
  const expired = items.filter((i) => i.endTime != null && i.endTime < now).length
  const future = items.map((i) => i.endTime).filter((t) => t != null && t > now).sort((a, b) => a - b)
  const expiresAt = future.length ? future[0] : null
  return { expired, expiresAt, soon: expiresAt != null && expiresAt - now < SOON }
}

/**
 * 签到状态只在「今天查过且查询成功」的前提下才可信：接口按自然日计数，
 * 昨天的结果今天没有意义，失败的查询也不能当成「未签到」。
 */
export function checkinStat(account) {
  const c = account.checkin
  if (!c || !c.supported) return { supported: false }
  const fresh = isToday(c.at) && c.ok !== false
  return {
    supported: true,
    fresh,
    checkedIn: fresh ? Boolean(c.checkedIn) : null,
    // 今天查过但查失败（多半是登录态失效）：不能骗用户说「未签到」，要让他知道是检测没成功
    failed: c.ok === false && isToday(c.at),
    streakDays: c.streakDays || 0,
    credits: c.credits,
    totalCredits: c.totalCredits,
    message: c.message
  }
}
