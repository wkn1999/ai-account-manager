'use strict'
// 资源包/用量窗口的到期时间处理：各平台 fetchQuota 共用

/** null 排最后，其余按到期先后升序 */
function compareEndTime(a, b) {
  if (a === b) return 0
  if (a == null) return 1
  if (b == null) return -1
  return a - b
}

// Qoder 等平台用 9999-01-01 之类的哨兵值表示「永不过期」，直接显示会很难看
const NEVER = Date.UTC(8000, 0, 1)

/** 归一到期时间：秒转毫秒、哨兵值与非法值一律当作「不过期」返回 null */
function normalizeExpiry(ts) {
  const n = typeof ts === 'number' && isFinite(ts) ? ts : null
  if (n == null || n <= 0 || n >= NEVER) return null
  // 10 位是秒、13 位是毫秒
  return n < 1e11 ? n * 1000 : n
}

/** 就地补上 expired 标记并排序：未过期的、最快到期的排前面 */
function markExpiry(items, now = Date.now()) {
  for (const it of items) {
    it.endTime = normalizeExpiry(it.endTime)
    it.expired = it.endTime != null && it.endTime < now
  }
  items.sort((x, y) => x.expired - y.expired || compareEndTime(x.endTime, y.endTime))
  return items
}

module.exports = { markExpiry }