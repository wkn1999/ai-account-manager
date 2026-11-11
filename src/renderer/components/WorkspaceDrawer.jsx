import React, { useEffect, useMemo, useState } from 'react'
import { fmtRelative } from '../lib/format'

const api = window.api || {}

const TABS = [
  { id: 'sessions', label: '会话' },
  { id: 'agents', label: '智能体' },
  { id: 'shortcut', label: '快捷方式' }
]

const DEFAULT_NAME = 'AI账号管家'

// 如实说明能力边界：不能把 Trae 的云端会话写成「一键迁移到新账号」
const SESSION_NOTE =
  'Qoder 会话存在本地数据库，可完整导出/导入；Trae 会话正文在云端按账号隔离，本地仅能归档索引，跨账号真迁移会被服务端拒绝，本工具不做假迁移'
const AGENT_NOTE =
  '归档只写本机缓存键：Trae 客户端的「自定义智能体」列表由云端按账号下发，不会因此出现。' +
  '要让客户端显示，请用「导出可粘贴清单」或逐行复制名称 / 提示词，在 Trae 内逐个创建；写入本机库前请先完全关闭 Trae。'
const AGENT_VARIANT_NOTE =
  '导出包若同时含 Trae 国内版与国际版智能体，单个目标 uid 会套用到两个变体；建议按变体分批导出 / 导入，或在上方下拉选「自动按变体解析」'
const SESSION_IMPORT_NOTE =
  '导入为真实写入：请先关闭对应客户端；主进程检测到客户端仍在运行会拒绝导入并写明进程名'
const SHORTCUT_NOTE =
  '开发时 appExe 指向 Electron 可执行文件；打包安装后请重新点『创建/更新』指向安装目录的 AI账号管家.exe'

const FILE_FILTERS = [{ name: 'JSON 文件', extensions: ['json'] }]

const BUSY_LABELS = {
  init: '加载工作台数据',
  'sessions:load': '读取会话列表',
  'sessions:refresh': '刷新会话列表',
  'sessions:export': '导出会话',
  'sessions:import': '导入会话包',
  'agents:export': '导出智能体',
  'agents:import': '导入智能体',
  'agents:importAll': '一键全部归档智能体',
  'agents:manifest': '生成可粘贴清单',
  'agents:refresh': '刷新智能体列表',
  'vault:save': '保存保护设置',
  'shortcut:save': '创建/更新快捷方式',
  'shortcut:remove': '删除快捷方式'
}

function busyLabel(key) {
  return BUSY_LABELS[key] || '处理'
}

function truncate(text, limit = 64) {
  const s = String(text == null ? '' : text)
  return s.length > limit ? s.slice(0, limit) + '…' : s
}

/** updatedAt 可能是时间戳也可能是 ISO 字符串，直接相减会算出 NaN 年前 */
function relativeTime(ts) {
  if (ts == null || ts === '') return null
  const num = typeof ts === 'number' ? ts : Date.parse(ts)
  if (!Number.isFinite(num)) return null
  return fmtRelative(num)
}

function agentKey(a) {
  return String((a && (a.key || a.agentId || a.uniqueName || a.name)) || '')
}

/** 只调整下拉顺序，不用平台 id 判定能力：Qoder / Trae 国内版是本次会话能力的落点 */
function preferredFirst(list) {
  const rank = (p) => {
    const label = String((p && p.label) || '')
    if (label.includes('Qoder') && label.includes('国内')) return 0
    if (label.includes('Trae') && label.includes('国内')) return 1
    return 2
  }
  return [...list].sort((a, b) => rank(a) - rank(b))
}

/** 主进程能力可能尚未就绪：缺函数时抛可读错误，避免 undefined(...) 直接白屏 */
async function call(name, ...args) {
  const fn = api[name]
  if (typeof fn !== 'function') {
    throw new Error(`${name} 尚未就绪（主进程未提供该能力，请完整重启应用）`)
  }
  return await fn(...args)
}

/** 契约里成功结果带 ok:true；ok:false 或字段缺失一律按失败处理 */
function ensureOk(r, action) {
  if (!(r && r.ok)) {
    throw new Error((r && (r.error || r.message)) || `${action}：主进程未返回成功结果`)
  }
  return r
}

/** 计数可能为 0，不能用 `|| 兜底值` 把「一个都没导出」报成「导出了 N 个」 */
function countOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** pickFile 契约返回字符串或 null；主进程异常时可能回 {ok:false,error}，一并兜住 */
function pickedPath(r) {
  if (r == null) return ''
  if (typeof r === 'string') return r.trim()
  if (typeof r === 'object' && r.ok === false) {
    throw new Error(r.error || r.message || '选择文件失败')
  }
  if (typeof r === 'object' && typeof r.file === 'string') return r.file.trim()
  return ''
}

/**
 * 复制到剪贴板：应用跑在 file:// 下，navigator.clipboard 可能不可用或被拒绝，
 * 降级到隐藏 textarea + document.execCommand('copy')。两级都失败必须抛可读中文错误，
 * 绝不谎报成功；整段 try/catch/finally，任何异常都不许冒泡成白屏。
 */
async function copyToClipboard(text) {
  const value = String(text == null ? '' : text)
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : null
  if (clip && typeof clip.writeText === 'function') {
    try {
      await clip.writeText(value)
      return
    } catch (e) {
      // 主路径失败：继续走下面的 textarea 降级，不在这里放弃
    }
  }
  let area = null
  try {
    if (typeof document === 'undefined' || !document.body) {
      throw new Error('当前环境不提供剪贴板，也无法创建临时输入框')
    }
    area = document.createElement('textarea')
    area.value = value
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    area.style.left = '-9999px'
    area.style.top = '0'
    document.body.appendChild(area)
    area.select()
    if (!document.execCommand('copy')) {
      throw new Error('浏览器拒绝了复制请求')
    }
  } catch (e) {
    throw new Error(`剪贴板不可用且降级复制未成功：${(e && e.message) || e}`)
  } finally {
    if (area && area.parentNode) area.parentNode.removeChild(area)
  }
}

/** 复制源一律取原文：ws-row-preview 里的 truncate 只用于展示，不能拿来复制 */
function agentPrompt(a) {
  return String((a && a.prompt) || '')
}

function agentName(a) {
  return String((a && a.name) || '')
}

function normalizeVault(r) {
  if (!r || typeof r !== 'object') throw new Error('主进程未返回保护设置')
  if (r.ok === false) throw new Error(r.error || r.message || '读取保护设置失败')
  return {
    protectOnSwitch: Boolean(r.protectOnSwitch),
    autoArchive: Boolean(r.autoArchive),
    archiveKeep: Number(r.archiveKeep) || 0
  }
}

function normalizeShortcut(r) {
  if (!r || typeof r !== 'object') throw new Error('主进程未返回快捷方式状态')
  if (r.ok === false) throw new Error(r.error || r.message || '读取快捷方式状态失败')
  const text = (v) => String(v == null ? '' : v)
  return {
    exists: Boolean(r.exists),
    path: text(r.path),
    name: text(r.name),
    target: text(r.target),
    args: text(r.args),
    cwd: text(r.cwd),
    icon: text(r.icon),
    description: text(r.description),
    appExe: text(r.appExe),
    desktopDir: text(r.desktopDir)
  }
}

export default function WorkspaceDrawer({ open, onClose, accounts, platforms, notify }) {
  const [tab, setTab] = useState('sessions')
  const [busy, setBusy] = useState('')
  const [sessionsPlatform, setSessionsPlatform] = useState('')
  const [sessions, setSessions] = useState([])
  const [sessionsNote, setSessionsNote] = useState('')
  const [selectedSessions, setSelectedSessions] = useState(() => new Set())
  const [agents, setAgents] = useState([])
  const [agentsNote, setAgentsNote] = useState('')
  const [selectedAgents, setSelectedAgents] = useState(() => new Set())
  const [targetUid, setTargetUid] = useState('')
  // 用户显式选过（含选「自动按变体解析」）后不再被初始化覆盖，否则重开抽屉会把 '' 又填回某个 uid
  const [targetUidTouched, setTargetUidTouched] = useState(false)
  const [vault, setVault] = useState({ protectOnSwitch: false, autoArchive: false, archiveKeep: 0 })
  const [shortcut, setShortcutState] = useState(() =>
    normalizeShortcut({ exists: false, name: '', target: '', args: '', cwd: '', icon: '' })
  )
  const [shortcutForm, setShortcutForm] = useState({
    name: DEFAULT_NAME,
    target: '',
    icon: '',
    args: '',
    cwd: ''
  })

  const platformOptions = useMemo(() => preferredFirst(Array.isArray(platforms) ? platforms : []), [platforms])
  const accountList = useMemo(() => (Array.isArray(accounts) ? accounts : []), [accounts])
  const platformLabel = useMemo(() => {
    const p = (Array.isArray(platforms) ? platforms : []).find((x) => x.id === sessionsPlatform)
    return p ? p.label : sessionsPlatform || '未选择平台'
  }, [platforms, sessionsPlatform])
  const exportAccount = useMemo(() => {
    const inPlatform = accountList.filter((a) => a.platform === sessionsPlatform)
    return inPlatform.find((a) => a.isCurrent) || inPlatform[0] || null
  }, [accountList, sessionsPlatform])
  const uidOptions = useMemo(() => accountList.filter((a) => a && a.uid), [accountList])
  // 目标账号按平台分组：Trae 国内版与国际版是两个变体，选错 uid 会写进另一个客户端库
  const uidGroups = useMemo(() => {
    const groups = new Map()
    for (const a of uidOptions) {
      const key = String(a.platform || '其它')
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(a)
    }
    return [...groups.entries()]
  }, [uidOptions])

  function report(message, tone) {
    if (typeof notify === 'function') notify(message, tone ? { tone } : {})
  }

  /** 复制是纯前端瞬时操作：不进 run()、不加全局 busy，失败也要给出可读原因 */
  async function copyAgent(a, kind) {
    const isPrompt = kind === 'prompt'
    const text = isPrompt ? agentPrompt(a) : agentName(a)
    if (!text) {
      report(isPrompt ? '该智能体没有可复制的提示词' : '该智能体没有可复制的名称', 'warn')
      return
    }
    try {
      await copyToClipboard(text)
      const name = agentName(a) || '未命名智能体'
      report(
        isPrompt
          ? `已复制「${name}」的提示词（${text.length} 字），可到 Trae「智能体 → 创建」粘贴`
          : `已复制名称：${name}`,
        'ok'
      )
    } catch (e) {
      report(`复制失败：${(e && e.message) || e}`, 'danger')
    }
  }

  function platformName(id) {
    const p = (Array.isArray(platforms) ? platforms : []).find((x) => x.id === id)
    return p ? p.label : id
  }

  /** 所有异步动作共用一个 busy 键：按钮统一禁用，异常统一转成带原因的提示 */
  async function run(key, fn) {
    if (busy) return
    setBusy(key)
    try {
      await fn()
    } catch (e) {
      report(`失败：${(e && e.message) || e}`, 'danger')
    } finally {
      setBusy('')
    }
  }

  async function loadSessions(pid) {
    if (!pid) throw new Error('尚未选择平台')
    const r = await call('listSessions', pid)
    ensureOk(r, '读取会话列表')
    const items = Array.isArray(r.sessions) ? r.sessions : []
    setSessions(items)
    setSessionsNote(String(r.note || ''))
    setSelectedSessions(new Set())
  }

  /** 默认停在第一个真正有会话的平台，优先 Qoder / Trae 国内版；探测失败不重复弹提示 */
  async function initSessions() {
    const ordered = platformOptions
    if (ordered.length === 0) throw new Error('平台列表为空，无法读取会话')
    let chosen = null
    let lastError = ''
    for (const p of ordered) {
      try {
        const r = await call('listSessions', p.id)
        if (r && r.ok) {
          const items = Array.isArray(r.sessions) ? r.sessions : []
          const found = { id: p.id, items, note: String(r.note || '') }
          if (!chosen) chosen = found
          if (items.length > 0) {
            chosen = found
            break
          }
        } else if (!lastError) {
          lastError = (r && (r.error || r.message)) || ''
        }
      } catch (e) {
        if (!lastError) lastError = (e && e.message) || String(e)
      }
    }
    if (!chosen) {
      setSessionsPlatform(ordered[0].id)
      setSessions([])
      setSessionsNote('')
      throw new Error(lastError || '主进程尚未提供会话能力')
    }
    setSessionsPlatform(chosen.id)
    setSessions(chosen.items)
    setSessionsNote(chosen.note)
    setSelectedSessions(new Set())
  }

  async function loadAgents() {
    const r = await call('listAgents')
    ensureOk(r, '读取智能体列表')
    setAgents(Array.isArray(r.agents) ? r.agents : [])
    setAgentsNote(String(r.note || ''))
    setSelectedAgents(new Set())
  }

  async function loadVault() {
    const r = await call('getVaultSettings')
    setVault(normalizeVault(r))
  }

  async function loadShortcutInfo() {
    const r = await call('getShortcut')
    const info = normalizeShortcut(r)
    setShortcutState(info)
    setShortcutForm({
      name: info.name || DEFAULT_NAME,
      target: info.target || info.appExe,
      icon: info.icon || info.target || info.appExe,
      args: info.args,
      cwd: info.cwd
    })
  }

  /** 初始化把三块错误汇总成一条提示：连续 4 次 notify 只会留下最后一条 */
  async function loadAll() {
    const errors = []
    const collect = async (label, fn) => {
      try {
        await fn()
      } catch (e) {
        errors.push(`${label}（${(e && e.message) || e}）`)
      }
    }
    await Promise.all([
      collect('读取保护设置', loadVault),
      collect('读取智能体列表', loadAgents),
      collect('读取快捷方式状态', loadShortcutInfo),
      collect('读取会话列表', () => (sessionsPlatform ? loadSessions(sessionsPlatform) : initSessions()))
    ])
    if (errors.length > 0) {
      report(`工作台初始化：${errors.length} 项读取失败 · ${errors.join('；')}`, 'danger')
    }
    if (!targetUidTouched && uidOptions.length > 0) setTargetUid(String(uidOptions[0].uid))
  }

  useEffect(() => {
    if (!open) return
    run('init', loadAll)
  }, [open, platforms.length])

  function toggleSession(id) {
    setSelectedSessions((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllSessions() {
    const all = sessions.length > 0 && sessions.every((s) => selectedSessions.has(s.id))
    setSelectedSessions(all ? new Set() : new Set(sessions.map((s) => s.id)))
  }

  function toggleAgent(key) {
    setSelectedAgents((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleAllAgents() {
    const all = agents.length > 0 && agents.every((a) => selectedAgents.has(agentKey(a)))
    setSelectedAgents(all ? new Set() : new Set(agents.map(agentKey)))
  }

  function changeSessionsPlatform(next) {
    setSessionsPlatform(next)
    setSelectedSessions(new Set())
    run('sessions:load', () => loadSessions(next))
  }

  function refreshSessions() {
    if (!sessionsPlatform) {
      report('刷新失败：尚未选择平台', 'warn')
      return
    }
    run('sessions:refresh', () => loadSessions(sessionsPlatform))
  }

  function refreshAgents() {
    run('agents:refresh', loadAgents)
  }

  function exportSelectedSessions() {
    const ids = [...selectedSessions]
    if (busy) return
    if (ids.length === 0) {
      report('请先勾选至少 1 个会话再导出', 'warn')
      return
    }
    run('sessions:export', async () => {
      const file = pickedPath(
        await call('pickFile', {
          mode: 'save',
          defaultPath: `ai-sessions-${sessionsPlatform || 'export'}.json`,
          filters: FILE_FILTERS
        })
      )
      if (!file) {
        report('已取消导出：未选择保存路径', 'warn')
        return
      }
      const r = await call('exportSessions', {
        platform: sessionsPlatform,
        accountId: exportAccount ? exportAccount.id : '',
        sessionIds: ids,
        file
      })
      ensureOk(r, '导出会话')
      report(`已导出 ${countOr(r.count, ids.length)} 个会话到 ${r.file || file}`, 'ok')
    })
  }

  function importSessionPack() {
    if (busy) return
    run('sessions:import', async () => {
      const file = pickedPath(await call('pickFile', { mode: 'open', filters: FILE_FILTERS }))
      if (!file) {
        report('已取消导入：未选择文件', 'warn')
        return
      }
      // 导入会写客户端会话数据库，必须让用户在关掉客户端之后二次确认
      const confirmed = window.confirm(
        `即将把 ${file} 中的会话导入本机。此操作会写入客户端会话数据库，请先关闭对应客户端再继续。确定继续？`
      )
      if (!confirmed) {
        report('已取消导入：用户未确认', 'warn')
        return
      }
      const r = await call('importSessions', { file, mode: 'merge', dryRun: false })
      ensureOk(r, '导入会话')
      report(
        `已导入 ${countOr(r.imported, 0)} 个会话，跳过 ${countOr(r.skipped, 0)} 个${r.message ? ' · ' + r.message : ''}`,
        'ok'
      )
      await loadSessions(sessionsPlatform)
    })
  }

  function saveProtect(next) {
    run('vault:save', async () => {
      const r = await call('setVaultSettings', { protectOnSwitch: next })
      const nextVault = normalizeVault(r)
      setVault(nextVault)
      report(`切号时自动保护会话：已${nextVault.protectOnSwitch ? '开启' : '关闭'}`, 'ok')
    })
  }

  function exportSelectedAgents() {
    const ids = [...selectedAgents]
    if (busy) return
    if (ids.length === 0) {
      report('请先勾选至少 1 个智能体再导出', 'warn')
      return
    }
    run('agents:export', async () => {
      const file = pickedPath(
        await call('pickFile', {
          mode: 'save',
          defaultPath: 'ai-agents.json',
          filters: FILE_FILTERS
        })
      )
      if (!file) {
        report('已取消导出：未选择保存路径', 'warn')
        return
      }
      const r = await call('exportAgents', { file, agentIds: ids })
      ensureOk(r, '导出智能体')
      report(`已导出 ${countOr(r.count, ids.length)} 个智能体到 ${r.file || file}`, 'ok')
    })
  }

  function importAgentPack() {
    if (busy) return
    run('agents:import', async () => {
      const file = pickedPath(await call('pickFile', { mode: 'open', filters: FILE_FILTERS }))
      if (!file) {
        report('已取消导入：未选择文件', 'warn')
        return
      }
      const target = targetUid
        ? `账号 ${targetUid}`
        : '自动按变体解析（每个 Trae 变体各取当前 uid）'
      const confirmed = window.confirm(
        `即将把 ${file} 中的智能体归档到${target}的本机缓存。这只是本机归档，Trae 客户端的「自定义智能体」列表不会因此出现；写入客户端数据库前请先完全关闭 Trae。确定继续？`
      )
      if (!confirmed) {
        report('已取消导入：用户未确认', 'warn')
        return
      }
      const r = await call('importAgents', { file, targetUid, mode: 'merge', dryRun: false })
      ensureOk(r, '导入智能体')
      report(
        `已导入 ${countOr(r.imported, 0)} 个智能体，跳过 ${countOr(r.skipped, 0)} 个${r.message ? ' · ' + r.message : ''}`,
        'ok'
      )
      await loadAgents()
    })
  }

  /** 一键全部归档：无需先导出 JSON、无需逐个勾选，直接把本机全部定义归档 */
  function importAllAgents() {
    if (busy) return
    if (agents.length === 0) {
      report('本机没有已缓存的自定义智能体，无法一键全部归档', 'warn')
      return
    }
    const confirmed = window.confirm(
      `即将把本机全部 ${agents.length} 个自定义智能体一次性归档到当前账号的本机缓存（按每个 Trae 变体自动解析 uid）。\n\n` +
        '注意：这只是归档到本机，Trae 客户端的「自定义智能体」列表由云端下发，不会因此出现。\n' +
        '写入客户端数据库前请先完全关闭 Trae。确定继续？'
    )
    if (!confirmed) {
      report('已取消一键全部归档', 'warn')
      return
    }
    run('agents:importAll', async () => {
      const r = await call('importAgents', { all: true, targetUid: '', mode: 'merge', dryRun: false })
      ensureOk(r, '一键全部归档')
      report(
        `已归档本机 ${r.total || agents.length} 个智能体，本次新增 ${countOr(r.imported, 0)} 个、跳过 ${countOr(r.skipped, 0)} 个${r.message ? ' · ' + r.message : ''}`,
        'ok'
      )
      await loadAgents()
    })
  }

  /** 可粘贴清单：给用户在 Trae 客户端「创建」页逐个复制提示词 / 工具 / MCP */
  function exportAgentManifest() {
    if (busy) return
    if (agents.length === 0) {
      report('本机没有已缓存的自定义智能体，无法生成清单', 'warn')
      return
    }
    run('agents:manifest', async () => {
      const file = pickedPath(
        await call('pickFile', {
          mode: 'save',
          defaultPath: 'ai-agents-manifest.md',
          filters: [{ name: 'Markdown 清单', extensions: ['md'] }]
        })
      )
      if (!file) {
        report('已取消导出：未选择保存路径', 'warn')
        return
      }
      const r = await call('exportAgents', { file, manifest: true })
      ensureOk(r, '导出可粘贴清单')
      report(`已生成可粘贴清单：${countOr(r.count, agents.length)} 个智能体 · ${r.file || file}`, 'ok')
    })
  }

  function updateShortcutForm(field, value) {
    setShortcutForm((prev) => ({ ...prev, [field]: value }))
  }

  function fillCurrentExe() {
    const exe = shortcut.appExe
    if (!exe) {
      report('填入失败：主进程未返回 appExe', 'warn')
      return
    }
    setShortcutForm((prev) => ({ ...prev, target: exe, icon: exe }))
    report(`已填入当前程序路径：${exe}`, 'ok')
  }

  function saveShortcut() {
    run('shortcut:save', async () => {
      const payload = {
        name: shortcutForm.name.trim() || DEFAULT_NAME,
        target: shortcutForm.target.trim(),
        icon: shortcutForm.icon.trim() || shortcutForm.target.trim(),
        args: shortcutForm.args,
        cwd: shortcutForm.cwd,
        operation: 'replace'
      }
      if (!payload.target) {
        report('创建/更新失败：目标 exe 不能为空', 'warn')
        return
      }
      const r = await call('setShortcut', payload)
      ensureOk(r, '创建/更新快捷方式')
      report(`快捷方式已创建/更新：${r.path || payload.name}`, 'ok')
      await loadShortcutInfo()
    })
  }

  function removeShortcut() {
    if (busy) return
    const name = shortcutForm.name.trim() || DEFAULT_NAME
    if (!window.confirm(`确定删除桌面快捷方式「${name}」？只删除快捷方式文件，不会卸载程序。`)) return
    run('shortcut:remove', async () => {
      const r = await call('removeShortcut', { name })
      ensureOk(r, '删除快捷方式')
      // 文件本就不存在时主进程返回 removed:false，不能谎报「已删除」
      if (r.removed === false) {
        report(r.message || `快捷方式「${name}」本就不存在，无需删除`, 'warn')
      } else {
        report(`已删除快捷方式：${name}`, 'ok')
      }
      await loadShortcutInfo()
    })
  }

  // hooks 必须无条件执行，所以 open 的判断放在所有 hook 之后
  if (!open) return null

  const allSessionsSelected = sessions.length > 0 && sessions.every((s) => selectedSessions.has(s.id))
  const allAgentsSelected = agents.length > 0 && agents.every((a) => selectedAgents.has(agentKey(a)))
  const disabled = busy !== ''

  return (
    <>
      <div className="mask" onClick={onClose} />
      <div className="drawer ws-drawer">
        <div className="ws-head">
          <h3>工作台</h3>
          <button className="btn ghost sm" onClick={onClose} disabled={disabled}>
            关闭
          </button>
        </div>
        <div className="muted tiny">会话归档、智能体搬运与桌面快捷方式</div>

        <div className="ws-tabs">
          {TABS.map((t) => (
            <button
              className={'chip' + (tab === t.id ? ' active' : '')}
              key={t.id}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {busy && (
          <div className="ws-busy">
            <span className="spin" />
            <span>正在{busyLabel(busy)}…</span>
          </div>
        )}

        {tab === 'sessions' && (
          <div className="ws-panel">
            <div className="ws-toolbar">
              <select
                className="ws-select"
                value={sessionsPlatform}
                onChange={(e) => changeSessionsPlatform(e.target.value)}
                disabled={disabled || platformOptions.length === 0}
              >
                {platformOptions.length === 0 && <option value="">暂无平台</option>}
                {platformOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <button className="btn sm" onClick={refreshSessions} disabled={disabled}>
                刷新列表
              </button>
            </div>

            <div className="ws-hint">
              {/* 显示精确变体 id：exportSessions 只接受 listPlatforms 的 id，不接受 label 或家族别名 */}
              当前范围：{platformLabel}（{sessionsPlatform || '未选择'}） · {sessions.length} 个会话 · 已选{' '}
              {selectedSessions.size} 个
              {exportAccount ? ` · 导出账号 ${exportAccount.name}` : ' · 该平台暂无已导入账号'}
            </div>

            <div className="ws-list-actions">
              <button
                className="btn sm ghost"
                onClick={toggleAllSessions}
                disabled={disabled || sessions.length === 0}
              >
                {allSessionsSelected ? '取消全选' : '全选'}
              </button>
              <button
                className="btn sm ghost"
                onClick={() => setSelectedSessions(new Set())}
                disabled={disabled || selectedSessions.size === 0}
              >
                清空选择
              </button>
            </div>

            {sessionsNote && <div className="ws-note">{sessionsNote}</div>}

            <div className="ws-list">
              {sessions.length === 0 ? (
                <div className="ws-empty muted">该平台本机没有可归档的会话索引</div>
              ) : (
                sessions.map((s, i) => (
                  <label className={'ws-row' + (selectedSessions.has(s.id) ? ' ws-on' : '')} key={String(s.id || i)}>
                    <input
                      className="ws-check"
                      type="checkbox"
                      checked={selectedSessions.has(s.id)}
                      onChange={() => toggleSession(s.id)}
                      disabled={disabled}
                    />
                    <div className="ws-row-main">
                      <div className="ws-row-title">{s.title || '未命名会话'}</div>
                      <div className="ws-row-meta">
                        {/* Trae 本地只有索引，messageCount 为 null，不能写成「0 条」假装统计过 */}
                        <span>{s.messageCount == null ? '仅本地索引' : `${Number(s.messageCount) || 0} 条`}</span>
                        <span>{relativeTime(s.updatedAt) || '时间未知'}</span>
                        {s.kind && <span className="ws-tag">{s.kind}</span>}
                        {s.uid && <span>uid {truncate(s.uid, 18)}</span>}
                      </div>
                      {s.preview && <div className="ws-row-preview">{truncate(s.preview)}</div>}
                    </div>
                  </label>
                ))
              )}
            </div>

            <div className="ws-hint">{SESSION_IMPORT_NOTE}</div>

            <div className="ws-actions">
              <button
                className="btn sm primary"
                onClick={exportSelectedSessions}
                disabled={disabled || selectedSessions.size === 0}
              >
                导出选中
              </button>
              <button className="btn sm" onClick={importSessionPack} disabled={disabled}>
                导入会话包
              </button>
            </div>

            <div className="field switch ws-switch">
              <span>切号时自动保护会话</span>
              <input
                type="checkbox"
                checked={Boolean(vault.protectOnSwitch)}
                onChange={(e) => saveProtect(e.target.checked)}
                disabled={disabled}
              />
            </div>

            <div className="ws-disclaimer">{SESSION_NOTE}</div>
          </div>
        )}

        {tab === 'agents' && (
          <div className="ws-panel">
            <div className="ws-toolbar">
              <span className="muted tiny">导入到账号</span>
              <select
                className="ws-select"
                value={targetUid}
                onChange={(e) => {
                  setTargetUidTouched(true)
                  setTargetUid(e.target.value)
                }}
                disabled={disabled}
              >
                {/* 空串让主进程按每个变体各自解析当前 uid，混合变体导出包不会串账号 */}
                <option value="">
                  {uidOptions.length === 0 ? '暂无可用账号 · 自动按变体解析' : '自动按变体解析'}
                </option>
                {uidGroups.map(([pid, list]) => (
                  <optgroup key={pid} label={platformName(pid)}>
                    {list.map((a) => (
                      <option key={a.id} value={String(a.uid)}>
                        {a.name} · {truncate(a.uid, 16)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <button className="btn sm" onClick={refreshAgents} disabled={disabled}>
                刷新列表
              </button>
            </div>

            <div className="ws-hint">
              共 {agents.length} 个自定义智能体 · 已选 {selectedAgents.size} 个 · {AGENT_NOTE}
            </div>
            <div className="ws-hint">{AGENT_VARIANT_NOTE}</div>
            <div className="ws-hint">工具与 MCP 配置见「导出可粘贴清单」；单个复制只复制名称 / 提示词原文。</div>

            <div className="ws-list-actions">
              <button
                className="btn sm ghost"
                onClick={toggleAllAgents}
                disabled={disabled || agents.length === 0}
              >
                {allAgentsSelected ? '取消全选' : '全选'}
              </button>
              <button
                className="btn sm ghost"
                onClick={() => setSelectedAgents(new Set())}
                disabled={disabled || selectedAgents.size === 0}
              >
                清空选择
              </button>
            </div>

            {agentsNote && <div className="ws-note">{agentsNote}</div>}

            <div className="ws-list">
              {agents.length === 0 ? (
                <div className="ws-empty muted">本机没有已缓存的自定义智能体定义</div>
              ) : (
                agents.map((a, i) => {
                  const key = agentKey(a) || String(i)
                  return (
                    <label className={'ws-row' + (selectedAgents.has(key) ? ' ws-on' : '')} key={key}>
                      <input
                        className="ws-check"
                        type="checkbox"
                        checked={selectedAgents.has(key)}
                        onChange={() => toggleAgent(key)}
                        disabled={disabled}
                      />
                      <div className="ws-row-main">
                        <div className="ws-row-title">{a.name || '未命名智能体'}</div>
                        <div className="ws-row-meta">
                          <span>{a.uniqueName || '无唯一名'}</span>
                          <span>uid {truncate(a.uid || '—', 18)}</span>
                          <span>prompt {String(a.prompt || '').length} 字</span>
                          {a.platform && <span className="ws-tag">{a.platform}</span>}
                          <span className="ws-tag">{a.source || '未知来源'}</span>
                          {a.type && <span>{a.type}</span>}
                        </div>
                        {a.prompt && <div className="ws-row-preview">{truncate(a.prompt, 80)}</div>}
                        <div className="ws-row-copy">
                          <button
                            type="button"
                            className="btn ghost sm"
                            disabled={disabled || !a.name}
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              copyAgent(a, 'name')
                            }}
                          >
                            复制名称
                          </button>
                          <button
                            type="button"
                            className="btn ghost sm"
                            disabled={disabled || !a.prompt}
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              copyAgent(a, 'prompt')
                            }}
                          >
                            复制提示词
                          </button>
                        </div>
                      </div>
                    </label>
                  )
                })
              )}
            </div>

            <div className="ws-actions">
              <button
                className="btn sm primary"
                onClick={importAllAgents}
                disabled={disabled || agents.length === 0}
              >
                一键全部归档
              </button>
              <button className="btn sm" onClick={exportAgentManifest} disabled={disabled || agents.length === 0}>
                导出可粘贴清单
              </button>
              <button
                className="btn sm"
                onClick={exportSelectedAgents}
                disabled={disabled || selectedAgents.size === 0}
              >
                导出选中为 JSON
              </button>
              <button className="btn sm" onClick={importAgentPack} disabled={disabled}>
                导入 JSON 包
              </button>
            </div>

            <div className="ws-disclaimer">
              本机归档 ≠ 客户端可见：Trae 的「自定义智能体」列表由云端按账号下发，本地只有「当前选中」的缓存键。
              「一键全部归档」把本机全部定义写入缓存与存档（切号后可恢复），但不会出现在 Trae 的「智能体」页；
              「导出可粘贴清单」会给出每个智能体的完整提示词 / 工具 / MCP，请在 Trae 里点「创建」逐个粘贴。
              未在本机打开过的智能体没有本地定义，无法导出或跨机搬运。
            </div>
          </div>
        )}

        {tab === 'shortcut' && (
          <div className="ws-panel">
            <div className="ws-kv">
              <div className="ws-kv-row">
                <span className="ws-kv-key">当前状态</span>
                <span className={'ws-kv-val ' + (shortcut.exists ? 'ws-good' : 'ws-dim')}>
                  {shortcut.exists ? '已存在' : '未创建'}
                </span>
              </div>
              <div className="ws-kv-row">
                <span className="ws-kv-key">名称</span>
                <span className="ws-kv-val">{shortcut.name || '—'}</span>
              </div>
              <div className="ws-kv-row">
                <span className="ws-kv-key">目标路径</span>
                <span className="ws-kv-val">{shortcut.target || '—'}</span>
              </div>
              <div className="ws-kv-row">
                <span className="ws-kv-key">图标</span>
                <span className="ws-kv-val">{shortcut.icon || '—'}</span>
              </div>
              <div className="ws-kv-row">
                <span className="ws-kv-key">启动参数</span>
                <span className="ws-kv-val">{shortcut.args || '—'}</span>
              </div>
              <div className="ws-kv-row">
                <span className="ws-kv-key">工作目录</span>
                <span className="ws-kv-val">{shortcut.cwd || '—'}</span>
              </div>
              <div className="ws-kv-row">
                <span className="ws-kv-key">快捷方式路径</span>
                <span className="ws-kv-val">{shortcut.path || '—'}</span>
              </div>
              <div className="ws-kv-row">
                <span className="ws-kv-key">桌面目录</span>
                <span className="ws-kv-val">{shortcut.desktopDir || '—'}</span>
              </div>
              <div className="ws-kv-row">
                <span className="ws-kv-key">当前程序 appExe</span>
                <span className="ws-kv-val">{shortcut.appExe || '—'}</span>
              </div>
              {shortcut.description && (
                <div className="ws-kv-row">
                  <span className="ws-kv-key">说明</span>
                  <span className="ws-kv-val">{shortcut.description}</span>
                </div>
              )}
            </div>

            <div className="ws-form">
              <div className="field">
                <span>名称</span>
                <input
                  type="text"
                  value={shortcutForm.name}
                  placeholder={DEFAULT_NAME}
                  onChange={(e) => updateShortcutForm('name', e.target.value)}
                />
              </div>
              <div className="field">
                <span>目标 exe（可手动改为安装目录里的 AI账号管家.exe）</span>
                <input
                  type="text"
                  value={shortcutForm.target}
                  onChange={(e) => updateShortcutForm('target', e.target.value)}
                />
              </div>
              <div className="field">
                <span>图标</span>
                <input
                  type="text"
                  value={shortcutForm.icon}
                  onChange={(e) => updateShortcutForm('icon', e.target.value)}
                />
              </div>
              <div className="field">
                <span>启动参数</span>
                <input
                  type="text"
                  value={shortcutForm.args}
                  onChange={(e) => updateShortcutForm('args', e.target.value)}
                />
              </div>
              <div className="field">
                <span>工作目录</span>
                <input
                  type="text"
                  value={shortcutForm.cwd}
                  onChange={(e) => updateShortcutForm('cwd', e.target.value)}
                />
              </div>
            </div>

            <div className="ws-actions">
              <button className="btn sm primary" onClick={saveShortcut} disabled={disabled}>
                创建 / 更新
              </button>
              <button className="btn sm" onClick={fillCurrentExe} disabled={disabled}>
                用当前程序路径填入
              </button>
              <button className="btn sm danger" onClick={removeShortcut} disabled={disabled}>
                删除快捷方式
              </button>
            </div>

            <div className="ws-disclaimer">{SHORTCUT_NOTE}</div>
          </div>
        )}
      </div>
    </>
  )
}
