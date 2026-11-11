import React, { useEffect, useMemo, useRef, useState } from 'react'
import Sidebar from './components/Sidebar'
import Topbar from './components/Topbar'
import AccountCard from './components/AccountCard'
import SettingsDrawer from './components/SettingsDrawer'
import WorkspaceDrawer from './components/WorkspaceDrawer'
import { checkinStat, expiryStat, quotaView } from './lib/format'

const api = window.api

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'unchecked', label: '待签到' },
  { id: 'checked', label: '已签到' },
  { id: 'expiring', label: '即将到期' },
  { id: 'expired', label: '已过期' },
  { id: 'blocked', label: '用量触顶' }
]

/** 批量操作的动作名只在主进程与这里各出现一次，避免两边文案各写一套 */
const BATCH_LABELS = { refresh: '批量刷新额度', checkin: '批量签到', remove: '批量删除' }

/** 判定口径集中一处：卡片、统计、筛选不会各说各话 */
function accountFlags(a, now = Date.now()) {
  const ck = checkinStat(a)
  const exp = expiryStat(a.quota, now)
  const view = quotaView(a.quota && a.quota.summary)
  return {
    checkable: ck.supported,
    checked: ck.checkedIn === true,
    expired: exp.expired > 0,
    expiring: exp.soon,
    blocked: Boolean((a.quota && a.quota.blocked) || (view && view.percent >= 100))
  }
}

function summarize(list) {
  const s = { accounts: list.length, blocked: 0, checked: 0, checkable: 0, expired: 0, expiring: 0 }
  for (const a of list) {
    const f = accountFlags(a)
    if (f.blocked) s.blocked++
    if (f.checkable) s.checkable++
    if (f.checked) s.checked++
    if (f.expired) s.expired++
    if (f.expiring && !f.expired) s.expiring++
  }
  return s
}

export default function App() {
  const [platforms, setPlatforms] = useState([])
  const [accounts, setAccounts] = useState([])
  const [settings, setSettings] = useState({})
  const [view, setView] = useState('all')
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)
  const [toast, setToast] = useState(null)
  const [showSettings, setShowSettings] = useState(false)
  // 工作台是全局抽屉：切视图不关它，避免用户切到别的平台就丢掉正在操作的内容
  const [showWorkspace, setShowWorkspace] = useState(false)
  const [selected, setSelected] = useState(() => new Set())

  const toastTimer = useRef(null)
  const platformMap = useMemo(() => Object.fromEntries(platforms.map((p) => [p.id, p])), [platforms])

  async function reload() {
    const [p, a, s] = await Promise.all([api.listPlatforms(), api.listAccounts(), api.getSettings()])
    setPlatforms(p)
    setAccounts(a)
    setSettings(s)
  }

  function notify(message, opts = {}) {
    setToast({ message, lines: opts.lines || null, tone: opts.tone || null })
    clearTimeout(toastTimer.current)
    // 带明细的结果停留久一点，用户要逐个看清哪个账号没签上
    toastTimer.current = setTimeout(() => setToast(null), opts.lines ? 12000 : 4500)
  }

  useEffect(() => {
    reload()
    const off = api.onSchedulerEvent((evt) => {
      if (evt.type === 'quota-progress' || evt.type === 'checkin-status-progress') {
        setProgress({ label: evt.type === 'quota-progress' ? '刷新额度' : '查询签到状态', done: evt.done, total: evt.total })
        return
      }
      if (evt.type === 'checkin-progress') {
        setProgress({ label: '签到', done: evt.done, total: evt.total, name: evt.name })
        return
      }
      if (evt.type === 'batch-progress') {
        setProgress({ label: BATCH_LABELS[evt.action] || '批量操作', done: evt.done, total: evt.total, name: evt.name })
        return
      }
      setProgress(null)
      if (evt.type === 'detect') notify(`已导入本机 ${evt.imported || 0} 个账号`)
      else if (evt.type === 'quota') notify('额度已刷新')
      else if (evt.type === 'checkin-status') notify('签到状态已更新')
      else if (evt.type === 'auto-checkin') reportCheckin(evt.results, '自动签到')
      else if (evt.type === 'login')
        notify(
          evt.mode === 'client' && evt.account
            ? `已登录并导入：${evt.account.name}`
            : '已在浏览器打开授权页，完成登录后回到本应用'
        )
      reload()
    })
    return () => {
      off()
      clearTimeout(toastTimer.current)
    }
  }, [])

  async function withBusy(fn) {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      notify('失败：' + (e.message || e), { tone: 'danger' })
    } finally {
      setBusy(false)
      setProgress(null)
      reload()
    }
  }

  /** 批量签到结果：成功计数 + 逐个明细，失败的写明原因，不能只报一句「完成」 */
  function reportCheckin(results, title = '签到') {
    if (!results || results.length === 0) {
      notify(`${title}：没有可签到的账号`)
      return
    }
    const ok = results.filter((r) => r.ok).length
    const lines = results.map(
      (r) => `${r.ok ? '成功' : '失败'} · ${r.name || r.id} · ${r.message || r.error || (r.ok ? '' : '未知原因')}`
    )
    notify(`${title}完成：成功 ${ok} / ${results.length}`, {
      lines,
      tone: ok === results.length ? 'ok' : ok > 0 ? 'warn' : 'danger'
    })
  }

  async function handleAction(action, account, extra) {
    if (action === 'switch') {
      await withBusy(async () => {
        const r = await api.switchAccount(account.id, { killRunning: true })
        const q = r && r.quota
        // 切号成功但额度没拉到：主行照旧报切换成功，失败原因追加在后面，别让用户以为号没切过去
        const lines = [`已切换到 ${account.name}${r.message ? ' · ' + r.message : ''}`]
        // 会话保护是切号闭环的可选返回：旧版主进程没有这个字段，保护全关时也不能每条切号都刷屏
        const sp = (r && r.sessionProtect) || null
        let protectWarn = false
        if (sp && (sp.archived || sp.restored || sp.skipped)) {
          const steps = []
          if (sp.archived) steps.push('切换前已归档当前账号会话')
          if (sp.restored) steps.push('切换后已还原目标账号会话')
          if (sp.skipped) steps.push('跳过自动还原')
          const reason = sp.reason ? String(sp.reason) : ''
          lines.push(`会话保护：${steps.join(' · ')}${reason ? ' · ' + reason : ''}`)
          // 导入摘要里也有「跳过 N 行」，那是正常合并结果，只按真正的失败/跳过原因提 warn
          protectWarn = Boolean(sp.skipped) || /失败|已关闭|不支持|已启动|跳过自动还原/.test(reason)
        }
        if (q && q.ok === false) lines.push(`额度刷新失败：${q.error || '未知原因'}`)
        notify(lines.join(' · '), (q && q.ok === false) || protectWarn ? { tone: 'warn' } : {})
      })
      return
    }
    if (action === 'quota') {
      await withBusy(async () => {
        await api.refreshQuota(account.id)
        notify('额度已刷新')
      })
      return
    }
    if (action === 'checkin') {
      await withBusy(async () => {
        const r = await api.checkin(account.id)
        notify(r.message || (r.ok ? '签到成功' : '签到失败'))
      })
      return
    }
    if (action === 'remove') {
      if (!confirm(`确定删除账号「${account.name}」？本机登录态不受影响。`)) return
      await withBusy(async () => {
        await api.removeAccount(account.id)
        notify('已删除')
      })
      return
    }
    if (action === 'rename') {
      await api.renameAccount(account.id, extra)
      reload()
    }
  }

  function toggleSelect(id) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 全选只作用于当前筛选出来的卡片，用户看到什么就选什么 */
  function toggleSelectAll() {
    const everySelected = visible.length > 0 && visible.every((a) => selected.has(a.id))
    setSelected((prev) => {
      if (everySelected) {
        const next = new Set(prev)
        for (const a of visible) next.delete(a.id)
        return next
      }
      return new Set([...prev, ...visible.map((a) => a.id)])
    })
  }

  /** 批量结果必须逐条列出：只报「完成」的话，用户不知道哪个账号没签上 */
  async function runBatch(action) {
    const ids = [...selected]
    if (ids.length === 0) return
    // 选中里一个能签到的都没有时直接说明原因：发一轮注定失败的请求再报「全部失败」纯属噪音
    if (action === 'checkin') {
      const anyCheckin = accounts.some(
        (a) => selected.has(a.id) && platformMap[a.platform] && platformMap[a.platform].supportsCheckin
      )
      if (!anyCheckin) {
        notify('所选账号所在平台均无签到接口', { tone: 'warn' })
        return
      }
    }
    const label = BATCH_LABELS[action] || '批量操作'
    await withBusy(async () => {
      const r = await api.batchAccounts({ action, ids })
      const results = (r && r.results) || []
      const ok = results.filter((x) => x.ok).length
      const lines = results.map(
        (x) => `${x.ok ? '成功' : '失败'} · ${x.name || x.id} · ${x.message || x.error || (x.ok ? '已完成' : '未知原因')}`
      )
      notify(`${label}完成：成功 ${ok} / ${results.length}`, {
        lines,
        tone: results.length === 0 ? null : ok === results.length ? 'ok' : ok > 0 ? 'warn' : 'danger'
      })
    })
    setSelected(new Set())
  }

  async function removeSelected() {
    const ids = [...selected]
    if (ids.length === 0) return
    if (!confirm(`确定删除已选的 ${ids.length} 个账号？本机登录态不受影响。`)) return
    await runBatch('remove')
  }

  async function detectAll() {
    await withBusy(async () => {
      const { imported, errors } = await api.detect()
      const detail = errors.map((e) => `${e.platform}(${e.message})`).join('、')
      notify(`检测完成，导入/更新 ${imported} 个账号` + (errors.length ? `；读取失败：${detail}` : ''))
    })
  }

  function detectOne(platformId) {
    const p = platformMap[platformId]
    return withBusy(async () => {
      try {
        const list = await api.importAccounts(platformId)
        notify(
          list.length > 1
            ? `已导入 ${list.length} 个账号：${list.map((a) => a.name).join('、')}`
            : `已导入：${list[0].name}`
        )
      } catch (e) {
        notify(`未检测到 ${p ? p.label : platformId} 的登录态：` + (e.message || e), { tone: 'danger' })
      }
    })
  }

  /** 切视图统一走这里：筛选条件和勾选都属于「上一个视图」的上下文，必须一起重置 */
  function switchView(next) {
    setView(next)
    setFilter('all')
    setSelected(new Set())
  }

  /** ChatGPT 走应用内 OAuth，其它平台是「拉起客户端登录 → 回来检测」 */
  function login(platformId) {
    const p = platformMap[platformId]
    return withBusy(async () => {
      const r = await api.login(platformId)
      if (r.mode === 'oauth') notify(`已登录：${r.account.name}`)
      else notify(r.message || '已启动客户端，请在客户端完成登录')
    }).then(() => {
      if (p) switchView(p.id)
    })
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return accounts.filter((a) => {
      if (view !== 'all' && a.platform !== view) return false
      const f = accountFlags(a)
      if (filter === 'unchecked' && (!f.checkable || f.checked)) return false
      if (filter === 'checked' && !f.checked) return false
      if (filter === 'expiring' && !(f.expiring && !f.expired)) return false
      if (filter === 'expired' && !f.expired) return false
      if (filter === 'blocked' && !f.blocked) return false
      if (!q) return true
      return [a.name, a.email, a.uid, a.platformLabel].filter(Boolean).some((x) => String(x).toLowerCase().includes(q))
    })
  }, [accounts, view, query, filter])

  const stats = useMemo(() => ({ ...summarize(accounts), platforms: platforms.length }), [accounts, platforms])
  const shown = useMemo(() => summarize(visible), [visible])
  const allVisibleSelected = useMemo(
    () => visible.length > 0 && visible.every((a) => selected.has(a.id)),
    [visible, selected]
  )

  const scoped = useMemo(() => (view === 'all' ? accounts : accounts.filter((a) => a.platform === view)), [accounts, view])
  const scopedStats = useMemo(() => summarize(scoped), [scoped])
  const currentOfView = useMemo(() => (view === 'all' ? null : scoped.find((a) => a.isCurrent) || null), [scoped, view])
  const canCheckin = useMemo(
    () => scoped.some((a) => platformMap[a.platform] && platformMap[a.platform].supportsCheckin),
    [scoped, platformMap]
  )
  const title = view === 'all' ? '总览' : (platformMap[view] && platformMap[view].label) || '总览'
  // 统计数字集中在下方 3 个概览块里，顶栏副标题只留上下文，不再把同一批维度重复第三遍
  // 平台页直接告诉用户「现在登录的是谁」，否则多账号下只能靠卡片上的「当前」徽章去猜
  const subtitle = view === 'all'
    ? '账号状态一览'
    : `当前账号：${currentOfView ? currentOfView.name : '未登录'}`
  // 待签数取当前平台的完整口径（不受筛选/搜索影响），按钮禁不禁用要和实际可签数量一致
  const pending = Math.max(0, scopedStats.checkable - scopedStats.checked)

  // 7 个数字块收敛成 3 个：待签到 / 到期 / 过期 / 触顶合并成「需关注账号」计数，
  // 具体维度仍由下方 6 个分段筛选逐个下钻，tiles 的点击联动语义保持不变。
  const attention = accounts.reduce((n, a) => {
    const f = accountFlags(a)
    return n + (f.blocked || f.expired || f.expiring || (f.checkable && !f.checked) ? 1 : 0)
  }, 0)

  const tiles = [
    { value: stats.accounts, label: '托管账号', filter: 'all' },
    {
      value: stats.checkable ? `${stats.checked}/${stats.checkable}` : '—',
      label: '今日已签到',
      filter: 'checked'
    },
    { value: attention, label: '需关注账号' }
  ]

  return (
    <div className="app">
      <Sidebar
        platforms={platforms}
        accounts={accounts}
        view={view}
        onView={switchView}
        onOpenSettings={() => setShowSettings(true)}
        onOpenWorkspace={() => setShowWorkspace(true)}
      />

      <div className="main">
        <Topbar
          title={title}
          subtitle={subtitle}
          view={view}
          platforms={platforms}
          query={query}
          onQuery={setQuery}
          onDetect={detectAll}
          onRefreshAll={() =>
            withBusy(async () => {
              await api.refreshAllQuota()
              notify('额度与签到状态刷新完成')
            })
          }
          onCheckinAll={() =>
            withBusy(async () => {
              const r = await api.checkinAll(view === 'all' ? undefined : view)
              if (r.busy) notify(r.message || '已有签到任务在进行中', { tone: 'warn' })
              else reportCheckin(r.results, view === 'all' ? '全部签到' : `${title} 签到`)
            })
          }
          onLogin={login}
          busy={busy}
          progress={progress}
          canCheckin={canCheckin}
          pending={pending}
        />

        <main className="content">
          {view === 'all' && (
            <div className="stats">
              {tiles.map((t) => (
                <div
                  className={'stat' + (t.filter && filter === t.filter ? ' active' : '') + (t.filter ? ' clickable' : '')}
                  key={t.label}
                  onClick={t.filter ? () => setFilter(filter === t.filter ? 'all' : t.filter) : undefined}
                >
                  <b className={t.tone ? 'tone-' + t.tone : undefined}>{t.value}</b>
                  <span className="label">{t.label}</span>
                </div>
              ))}
            </div>
          )}

          <div className="section-title">
            <div className="filters">
              {FILTERS.map((f) => (
                <button
                  className={'chip' + (filter === f.id ? ' active' : '')}
                  key={f.id}
                  disabled={!canCheckin && (f.id === 'checked' || f.id === 'unchecked')}
                  title={!canCheckin && (f.id === 'checked' || f.id === 'unchecked') ? '当前平台未提供签到接口' : undefined}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <span className="list-count">共 {visible.length} 个账号</span>
          </div>

          {selected.size > 0 && (
            <div className="batchbar">
              <span className="batch-count">已选 {selected.size} 个</span>
              <button className="btn sm" onClick={toggleSelectAll}>
                {allVisibleSelected ? '取消全选' : '全选'}
              </button>
              <button className="btn sm" disabled={busy} onClick={() => runBatch('checkin')}>
                批量签到
              </button>
              <button className="btn sm" disabled={busy} onClick={() => runBatch('refresh')}>
                批量刷新额度
              </button>
              <button className="btn sm danger" disabled={busy} onClick={removeSelected}>
                批量删除
              </button>
              <button className="btn sm ghost" disabled={busy} onClick={() => setSelected(new Set())}>
                取消选择
              </button>
            </div>
          )}

          <div className={'cards' + (selected.size > 0 ? ' selecting' : '')}>
            {visible.length === 0 && (
              <div className="empty muted">
                {view === 'all'
                  ? '还没有账号：可以点「登录新账号」在线授权，或先在客户端登录后点「检测本机账号」导入'
                  : filter !== 'all'
                    ? `当前没有「${FILTERS.find((f) => f.id === filter).label}」的账号`
                    : `暂无 ${title} 账号`}
                {view !== 'all' && (
                  <div className="empty-actions">
                    {(platformMap[view] || {}).loginMode !== 'none' && (
                      <button className="btn sm primary" disabled={busy} onClick={() => login(view)}>
                        登录新账号
                      </button>
                    )}
                    <button className="btn sm" disabled={busy} onClick={() => detectOne(view)}>
                      导入本机当前登录账号
                    </button>
                  </div>
                )}
              </div>
            )}
            {visible.map((a) => (
              <AccountCard
                key={a.id}
                account={a}
                platform={platformMap[a.platform]}
                onAction={handleAction}
                busy={busy}
                selected={selected.has(a.id)}
                onToggleSelect={toggleSelect}
              />
            ))}
          </div>
        </main>
      </div>

      {showSettings && (
        <SettingsDrawer
          settings={settings}
          onClose={() => setShowSettings(false)}
          onSave={async (patch) => {
            setSettings(await api.setSettings(patch))
            notify('设置已保存')
          }}
        />
      )}

      <WorkspaceDrawer
        open={showWorkspace}
        onClose={() => setShowWorkspace(false)}
        accounts={accounts}
        platforms={platforms}
        notify={notify}
      />

      {toast && (
        <div className={'toast' + (toast.tone ? ' tone-' + toast.tone : '')}>
          <div>{toast.message}</div>
          {toast.lines && (
            <div className="toast-lines">
              {toast.lines.map((l, i) => (
                <div className={l.startsWith('失败') ? 'toast-line fail' : 'toast-line'} key={i}>
                  {l}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
