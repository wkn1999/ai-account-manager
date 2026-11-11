'use strict'
// 定时任务：定时刷新额度 + 定时一键签到 + 签到状态检测

const platforms = require('./platforms')
const { refreshQuota, checkin, checkinStatus } = platforms

/** 能力判定只有注册表一处口径，卡片按钮、批量签到、定时任务不会各说各话 */
function checkinCapable(account) {
  return platforms.supportsCheckin(account.platform) ? account : null
}

/** 限额并发：账号多了以后串行刷新太慢，但也不能一次几十个请求打过去 */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await worker(items[i], i)
    }
  })
  await Promise.all(runners)
  return out
}

class Scheduler {
  constructor(store, onEvent) {
    this.store = store
    this.onEvent = onEvent || (() => {})
    this.timer = null
    this.lastRun = 0
    this.lastAutoCheckin = null
    this.checkinRunning = false
    // 按账号维度的签到在途表：同一账号并发签到会重复发领取请求
    this.checkinInflight = new Map()
  }

  settings() {
    return this.store.getSettings() || {}
  }

  reschedule() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    const s = this.settings()
    if (!s.autoRefreshEnabled) return
    const minutes = Math.max(1, Number(s.refreshMinutes) || 10)
    this.timer = setInterval(() => {
      this.runOnce('refresh')
      this.autoCheckinTick()
    }, minutes * 60 * 1000)
  }

  /**
   * 到点自动签到：每个刷新周期检查一次「今天是否已到点且还没跑过」。
   * 重复调用是安全的 —— 各平台的 checkin() 都会先查状态，已签到就直接返回。
   */
  autoCheckinTick() {
    const s = this.settings()
    if (!s.autoCheckinEnabled) return
    const hour = Number.isFinite(Number(s.checkinHour)) ? Math.min(23, Math.max(0, Number(s.checkinHour))) : 9
    const now = new Date()
    if (now.getHours() < hour) return
    const day = now.toDateString()
    if (this.lastAutoCheckin === day) return
    this.lastAutoCheckin = day
    this.checkinAll()
      .then((r) => {
        if (r && r.results && r.results.length) this.onEvent({ type: 'auto-checkin', results: r.results })
      })
      .catch((e) => console.warn('自动签到失败:', e.message))
  }

  /**
   * 仓库里的快照可能比客户端旧（客户端在后台自己续期了 token）。
   * 接口报登录失效时，若本机客户端当前登录的就是这个账号，用本机最新登录态覆盖快照再试一次；
   * 不是同一个账号就不动它 —— 那只能靠切号或重新登录解决。
   */
  async healSnapshot(account) {
    try {
      const live = await platforms.importCurrent(account.platform)
      if (!live || live.id !== account.id) return false
      account.snapshot = live.snapshot
      if (live.deviceId) account.deviceId = live.deviceId
      account.updatedAt = Date.now()
      this.store.upsert(account)
      return true
    } catch {
      return false
    }
  }

  async quotaWithHeal(account) {
    try {
      return await refreshQuota(account)
    } catch (e) {
      if (!e.loggedOut || !(await this.healSnapshot(account))) throw e
      return refreshQuota(account)
    }
  }

  async checkinStatusWithHeal(account) {
    let st = await checkinStatus(account)
    if (!st.ok && st.loggedOut && (await this.healSnapshot(account))) st = await checkinStatus(account)
    return st
  }

  async checkinWithHeal(account) {
    let r = await checkin(account)
    if (!r.ok && r.loggedOut && (await this.healSnapshot(account))) r = await checkin(account)
    return r
  }

  /**
   * 拉一次额度并落库。失败时保留上一次的数据，只用 quotaError 标记 ——
   * 否则一次网络抖动就会把用户已经看到的额度清空。
   */
  async refreshOne(account) {
    try {
      const quota = await this.quotaWithHeal(account)
      account.quota = { ...quota, fetchedAt: Date.now() }
      account.quotaError = null
      this.store.upsert(account)
      return { ok: true, quota: account.quota }
    } catch (e) {
      account.quotaError = { at: Date.now(), message: e.message }
      this.store.upsert(account)
      return { ok: false, error: e.message }
    }
  }

  async refreshAll() {
    const list = this.store.list()
    let done = 0
    const updated = await mapLimit(list, 4, async (account) => {
      const res = await this.refreshOne(account)
      this.onEvent({ type: 'quota-progress', done: ++done, total: list.length, id: account.id })
      return res.ok ? { id: account.id, ok: true } : { id: account.id, ok: false, error: res.error }
    })
    this.onEvent({ type: 'quota', updated })
    await this.refreshCheckins()
    return updated
  }

  /** 逐个查询今日签到状态，结果写进 account.checkin 供卡片与统计使用 */
  async refreshCheckins() {
    const list = this.store.list().filter(checkinCapable)
    let done = 0
    const results = await mapLimit(list, 4, async (account) => {
      const st = await this.checkinStatusWithHeal(account)
      account.checkin = { ...st, at: Date.now() }
      this.store.upsert(account)
      this.onEvent({ type: 'checkin-status-progress', done: ++done, total: list.length, id: account.id })
      return { id: account.id, supported: st.supported, checkedIn: Boolean(st.checkedIn) }
    })
    this.onEvent({ type: 'checkin-status', results })
    return results
  }

  /**
   * 同一账号的签到必须串行：定时自动签到与手动单卡/批量签到撞车时，
   * 会对同一账号发出两次领取请求（服务端多半会拦，但没必要冒风控的险）。
   * 锁只按账号维度，不同账号互不影响 —— 批量签到本身就是串行循环，不会被自己锁住。
   */
  async withCheckinLock(account, worker) {
    if (this.checkinInflight.has(account.id)) {
      return { ok: false, busy: true, message: '该账号签到正在进行中' }
    }
    this.checkinInflight.set(account.id, true)
    try {
      return await worker()
    } finally {
      this.checkinInflight.delete(account.id)
    }
  }

  async checkinOne(id) {
    const account = this.store.get(id)
    if (!account) throw new Error('账号不存在')
    if (!checkinCapable(account)) return { ok: false, supported: false, message: '该平台不支持签到' }
    return this.withCheckinLock(account, async () => {
      const res = await this.checkinWithHeal(account)
      account.lastCheckin = { at: Date.now(), ok: res.ok, message: res.message }
      const st = await this.checkinStatusWithHeal(account)
      account.checkin = { ...st, at: Date.now() }
      this.store.upsert(account)
      this.onEvent({ type: 'checkin', results: [{ id: account.id, ...res }] })
      return res
    })
  }

  /**
   * 批量签到。串行执行并逐个回报进度 —— 签到接口普遍按账号限频，
   * 并发打过去容易触发风控，而且用户需要看到「签到第几个了」。
   * @param {string} [platform] 只签这一个平台
   */
  async checkinAll(platform) {
    if (this.checkinRunning) return { ok: false, busy: true, message: '已有签到任务在进行中', results: [] }
    const list = this.store.list().filter((a) => checkinCapable(a) && (!platform || a.platform === platform))
    if (list.length === 0) return { ok: true, results: [], message: '没有可签到的账号' }
    this.checkinRunning = true
    const results = []
    try {
      for (const [i, account] of list.entries()) {
        this.onEvent({ type: 'checkin-progress', done: i, total: list.length, id: account.id, name: account.name })
        let r
        try {
          // 与单卡/批量签到共用同一把账号锁：谁先到谁签，另一路拿到 busy 而不是再发一次 POST
          r = await this.withCheckinLock(account, () => this.checkinWithHeal(account))
        } catch (e) {
          r = { ok: false, message: e.message }
        }
        account.lastCheckin = { at: Date.now(), ok: r.ok, message: r.message }
        this.store.upsert(account)
        results.push({ id: account.id, name: account.name, platform: account.platform, ...r })
        this.onEvent({ type: 'checkin-progress', done: i + 1, total: list.length, id: account.id, name: account.name, result: r })
      }
    } finally {
      this.checkinRunning = false
    }
    this.onEvent({ type: 'checkin', results })
    await this.refreshCheckins()
    return { ok: true, results }
  }

  async runOnce(kind) {
    this.lastRun = Date.now()
    if (kind === 'refresh') return this.refreshAll()
    return this.checkinAll()
  }

  start() {
    this.reschedule()
    // 开机晚于签到点的情况：起来后补一次
    setTimeout(() => this.autoCheckinTick(), 25000)
  }
}

module.exports = { Scheduler }
