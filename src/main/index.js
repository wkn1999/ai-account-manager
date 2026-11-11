'use strict'
// Electron 主进程：窗口、IPC、账号仓库、定时任务

const { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } = require('electron')
const fs = require('fs')
const path = require('path')
const { AccountStore } = require('./store')
const platforms = require('./platforms')
const { Scheduler } = require('./scheduler')
const { launchApp, isProcessRunning } = require('./util/core')
const sessionVault = require('./sessionVault')
const agentVault = require('./agentVault')
const shortcuts = require('./shortcuts')

let mainWindow = null
let store = null
let scheduler = null

/**
 * 截图自检（开发辅助）：渲染效果只能靠眼睛看，给一个「启动 → 等数据到位 → 截图 → 退出」的口子。
 * 仅在设置了 AI_SHOT 时调用，生产路径连定时器都不会创建。
 */
async function captureSelfShot(win, file) {
  try {
    await new Promise((r) => setTimeout(r, 9000))
    const img = await win.webContents.capturePage()
    fs.writeFileSync(file, img.toPNG())
    console.log('截图已保存:', file)
  } catch (e) {
    console.warn('截图失败:', e.message)
  } finally {
    // 无论成败都要退出，否则带 AI_SHOT 启动的进程会一直挂着
    app.quit()
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 940,
    minHeight: 640,
    title: 'AI账号管家',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'))
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // 启动先把本机登录态同步进仓库（旧快照的 token 可能已被客户端续期），再拉一次最新数据
  mainWindow.webContents.once('did-finish-load', () => {
    detectAndImport()
      .then((r) => emit({ type: 'detect', imported: r.imported }))
      .catch((e) => console.warn('启动检测失败:', e.message))
      .then(() => scheduler.refreshAll())
      .catch((e) => console.warn('启动刷新失败:', e.message))
  })

  // 截图自检：条件不成立时连监听器都不注册，避免影响正常启动路径
  if (process.env.AI_SHOT) {
    mainWindow.webContents.once('did-finish-load', () => {
      captureSelfShot(mainWindow, process.env.AI_SHOT)
    })
  }
}

function initStore() {
  const dir = app.getPath('userData')
  const ss =
    safeStorage && safeStorage.isEncryptionAvailable()
      ? {
          encrypt: (s) => safeStorage.encryptString(s),
          decrypt: (b) => safeStorage.decryptString(b)
        }
      : null
  store = new AccountStore(dir, ss)
  // 会话/智能体模块要用仓库读当前账号 uid 与持久化 vault 设置，由主进程注入，避免模块自己 new 一份
  sessionVault.setStore(store)
  agentVault.setStore(store)
  scheduler = new Scheduler(store, (evt) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('scheduler:event', evt)
  })
  scheduler.start()
}

/**
 * chatgpt.com / api.openai.com 直连不通，必须走代理。
 * 用户在设置里填了代理就用它，留空则跟随系统代理与 PAC。
 * net.fetch（见 util/net.js）走 Chromium 网络栈，会读到这里设的值。
 */
function applyProxy(settings) {
  const rules = String((settings && settings.proxyUrl) || '').trim()
  const cfg = rules
    ? { mode: 'fixed_servers', proxyRules: rules, proxyBypassRules: '<local>' }
    : { mode: 'system' }
  return session.defaultSession
    .setProxy(cfg)
    .catch((e) => console.warn('设置代理失败:', e.message))
}

/** 只读本机登录态并写入自身仓库，不改动任何客户端文件 */
async function detectAndImport() {
  const found = await platforms.detectAll()
  const errors = []
  let imported = 0
  for (const acc of found) {
    if (acc.detectFailed) {
      errors.push({ platform: acc.platform, message: acc.error })
      continue
    }
    const saved = store.upsert({ ...acc, importedAt: Date.now() })
    // 多 profile 平台只有 activeProfile 才是「当前」，其余不能被标成当前账号
    if (acc.isCurrent !== false) store.markCurrent(saved.platform, saved.id)
    imported++
  }
  return { imported, errors }
}

function emit(evt) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('scheduler:event', evt)
}

const loginWatchers = new Map()

/**
 * 第三方客户端没有可复用的登录协议，只能拉起它让人自己登录。
 * 这里轮询本机登录态，一旦认出是同平台的新账号就自动收进来，省掉再点一次「检测」。
 */
function watchClientLogin(platform) {
  if (loginWatchers.has(platform)) return
  const known = new Set(store.list(platform).map((a) => a.id))
  const deadline = Date.now() + 180000
  let polling = false
  const timer = setInterval(async () => {
    if (Date.now() > deadline) {
      clearInterval(timer)
      loginWatchers.delete(platform)
      return
    }
    if (polling) return
    polling = true
    try {
      let list
      try {
        list = await platforms.importAll(platform)
      } catch {
        return // 客户端还在写登录态，读不到就下一轮再试
      }
      const fresh = list.filter((a) => !known.has(a.id))
      if (fresh.length === 0) return
      clearInterval(timer)
      loginWatchers.delete(platform)
      const saved = []
      for (const acc of fresh) {
        const s = store.upsert({ ...acc, importedAt: Date.now() })
        if (acc.isCurrent !== false) store.markCurrent(s.platform, s.id)
        await scheduler.refreshOne(s)
        saved.push(s)
      }
      emit({ type: 'login', mode: 'client', platform, account: saved[0], accounts: saved })
    } finally {
      polling = false
    }
  }, 4000)
  loginWatchers.set(platform, timer)
}

/**
 * 新增 IPC 统一包一层：异常转成 {ok:false,error}，不把堆栈打到 console。
 * 为什么：主进程错误对象可能夹带路径或数据，渲染层只需要可读中文错误。
 */
function safeHandle(channel, fn) {
  ipcMain.handle(channel, async (...args) => {
    try {
      return await fn(...args)
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) }
    }
  })
}

/**
 * 会话保护结束后补上「拉起客户端」。
 * 为什么：保护开启时给 switchAccount 传了 launch:false，让还原阶段能在客户端关闭的窗口里写库；
 *        这一步放在 finally 里，即使归档/还原抛错也一定执行，绝不出现「切了号但客户端没起来」。
 *        适配器若忽略了 launch 已经自己拉起，就按进程名跳过，避免双开。
 */
function relaunchClient(account, alreadyLaunched) {
  if (alreadyLaunched) return false
  const entry = platforms.registry[account.platform]
  if (!entry || !entry.adapter || !entry.meta) return false
  const meta = entry.meta
  const names = Array.isArray(meta.exeNames) ? meta.exeNames : meta.exeName ? [meta.exeName] : []
  if (names.some((n) => isProcessRunning(n))) return false
  if (typeof entry.adapter.findExe !== 'function') return false
  const exe = entry.adapter.findExe(meta)
  if (!exe) return false
  launchApp(exe)
  return true
}

function registerIpc() {
  ipcMain.handle('platforms:list', () => platforms.listPlatforms())

  ipcMain.handle('accounts:list', () => store.list())

  // 检测即导入：避免渲染层拿到快照后再逐个重新读取解密一遍
  ipcMain.handle('accounts:detect', () => detectAndImport())

  // 多 profile 客户端（DuMate）一次把本机所有账号都收进来，返回数组
  ipcMain.handle('accounts:import', async (_e, platform) => {
    const list = await platforms.importAll(platform)
    const saved = []
    for (const acc of list) {
      const s = store.upsert({ ...acc, importedAt: Date.now() })
      if (acc.isCurrent !== false) store.markCurrent(s.platform, s.id)
      await scheduler.refreshOne(s)
      saved.push(s)
    }
    return saved
  })

  ipcMain.handle('accounts:switch', async (_e, id, opts) => {
    const account = store.get(id)
    if (!account) throw new Error('账号不存在')

    // 会话保护：开启时抑制适配器自动拉起客户端，留出「客户端已关闭」的窗口给会话还原；
    // 关闭时 opts 原样传入，切号流程一字不变。
    const protect = sessionVault.getSettings().protectOnSwitch === true
    const sessionProtect = { archived: false, restored: false, skipped: false, reason: null }
    if (protect) opts = { ...(opts || {}), launch: false }

    // 切号前归档「当前账号」的本地会话，失败只 warn，绝不阻断切号
    if (protect) {
      try {
        const current = store.list(account.platform).find((a) => a.isCurrent)
        if (current) {
          const snap = await sessionVault.snapshotForSwitch(current)
          sessionProtect.archived = Boolean(snap && snap.ok && !snap.skipped)
        }
      } catch (e) {
        sessionProtect.reason = '归档失败：' + e.message
        console.warn('切号前会话归档失败:', e.message)
      }
    }

    const res = await platforms.switchAccount(account, opts || {})

    // 还原 + finally 兜底拉起：归档/还原任何一步抛错，客户端都一定会被拉起来
    if (protect) {
      try {
        try {
          const restored = await sessionVault.restoreForSwitch(account)
          if (restored && restored.ok === false) {
            sessionProtect.skipped = true
            sessionProtect.reason = restored.error || restored.message || '会话还原失败'
          } else if (restored && restored.skipped === true) {
            sessionProtect.skipped = true
            sessionProtect.reason = restored.message || '会话还原被跳过'
          } else {
            sessionProtect.restored = true
            if (restored && restored.message) sessionProtect.reason = restored.message
          }
          if (sessionProtect.skipped && sessionProtect.reason) console.warn('会话还原跳过:', sessionProtect.reason)
        } catch (e) {
          sessionProtect.skipped = true
          sessionProtect.reason = '会话还原失败：' + e.message
          console.warn('切号后会话还原失败:', e.message)
        }
      } finally {
        try {
          relaunchClient(account, Boolean(res && res.launched))
        } catch (e) {
          console.warn('切号后拉起客户端失败:', e.message)
        }
      }
    }

    // sessionProtect 挂到 res 上，保持 return { ...res, quota } 一字不动，res.ok 语义不变
    if (res && typeof res === 'object') res.sessionProtect = sessionProtect

    store.markUsed(id)

    // 切完号卡片上挂的还是上一个账号的额度与签到状态，必须立刻拉一次；
    // 但刷新失败只影响显示，不能把一次成功的切号报成失败。
    const saved = store.get(id) || account
    let quota = { ok: false, error: null }
    try {
      const r = await scheduler.refreshOne(saved)
      quota = { ok: Boolean(r.ok), error: r.ok ? null : r.error || '未知原因' }
    } catch (e) {
      quota = { ok: false, error: e.message }
    }
    try {
      await scheduler.refreshCheckins()
    } catch (e) {
      console.warn('切号后刷新签到状态失败:', e.message)
    }
    return { ...res, quota }
  })

  ipcMain.handle('accounts:remove', (_e, id) => store.remove(id))

  /**
   * 批量操作：串行执行并逐步回报进度。
   * 签到走 scheduler.checkinOne（已含防重入 / 状态回写 / 快照自愈），额度走 scheduler.refreshOne，
   * 删除走 store.remove —— 批量和单个按钮共用同一条实现，不会出现两套口径。
   */
  ipcMain.handle('accounts:batch', async (_e, payload) => {
    const data = payload || {}
    const action = String(data.action || '')
    const ids = Array.isArray(data.ids) ? data.ids.filter(Boolean) : []
    if (!['refresh', 'checkin', 'remove'].includes(action)) throw new Error('未知批量操作: ' + action)
    const total = ids.length
    const results = []
    for (const [i, id] of ids.entries()) {
      const account = store.get(id)
      let name = account ? account.name : id
      let step
      if (!account) {
        step = { ok: false, error: '账号不存在' }
      } else {
        try {
          if (action === 'remove') {
            step = store.remove(id) ? { ok: true, message: '已删除' } : { ok: false, error: '账号不存在' }
          } else if (action === 'refresh') {
            const res = await scheduler.refreshOne(account)
            step = res.ok ? { ok: true, message: '额度已更新' } : { ok: false, error: res.error }
          } else if (!platforms.supportsCheckin(account.platform)) {
            step = { ok: false, message: '该平台无签到接口' }
          } else {
            const res = await scheduler.checkinOne(id)
            step = { ok: Boolean(res.ok), message: res.message, error: res.ok ? null : res.message }
          }
        } catch (e) {
          step = { ok: false, error: e.message }
        }
        name = account.name
      }
      results.push({ id, name, ...step })
      emit({ type: 'batch-progress', action, done: i + 1, total, name })
    }
    return { ok: true, action, results }
  })

  // 登录新账号：ChatGPT 在应用内走 OAuth，其它平台只能拉起客户端，登录完再检测导入
  ipcMain.handle('accounts:login', async (_e, platform) => {
    const res = await platforms.login(platform, (url) => {
      emit({ type: 'login', platform, url })
      shell.openExternal(url)
    })
    if (res.mode === 'oauth' && res.account) {
      const saved = store.upsert({ ...res.account, importedAt: Date.now() })
      store.markCurrent(saved.platform, saved.id)
      await scheduler.refreshOne(saved)
      return { ...res, account: saved }
    }
    if (res.mode === 'client') watchClientLogin(platform)
    return res
  })

  ipcMain.handle('accounts:rename', (_e, id, name) => {
    const acc = store.get(id)
    if (!acc) throw new Error('账号不存在')
    acc.name = name
    return store.upsert(acc)
  })

  ipcMain.handle('quota:refresh', async (_e, id) => {
    const account = store.get(id)
    if (!account) throw new Error('账号不存在')
    const res = await scheduler.refreshOne(account)
    if (!res.ok) throw new Error(res.error)
    return res.quota
  })

  ipcMain.handle('quota:refreshAll', () => scheduler.refreshAll())

  ipcMain.handle('checkin:one', (_e, id) => scheduler.checkinOne(id))

  ipcMain.handle('checkin:all', (_e, platform) => scheduler.checkinAll(platform))

  ipcMain.handle('checkin:status', () => scheduler.refreshCheckins())

  ipcMain.handle('settings:get', () => store.getSettings())

  ipcMain.handle('settings:set', (_e, patch) => {
    const s = store.setSettings(patch)
    scheduler.reschedule()
    return applyProxy(s).then(() => s)
  })

  // ---------------- 会话仓库 / 智能体 / 快捷方式（v0.3.0 新增） ----------------
  safeHandle('sessions:list', (_e, platform) => sessionVault.listSessions(platform))
  safeHandle('sessions:export', (_e, p) => sessionVault.exportSessions(p || {}))
  safeHandle('sessions:import', (_e, p) => sessionVault.importSessions(p || {}))
  safeHandle('vault:settings:get', () => sessionVault.getSettings())
  safeHandle('vault:settings:set', (_e, p) => sessionVault.setSettings(p || {}))
  safeHandle('agents:list', () => agentVault.listAgents())
  safeHandle('agents:export', (_e, p) => agentVault.exportAgents(p || {}))
  safeHandle('agents:import', (_e, p) => agentVault.importAgents(p || {}))
  safeHandle('shortcut:get', (_e, p) => shortcuts.getShortcut(p || {}))
  safeHandle('shortcut:set', (_e, p) => shortcuts.setShortcut(p || {}))
  safeHandle('shortcut:remove', (_e, p) => shortcuts.removeShortcut(p || {}))
  safeHandle('dialog:file', async (_e, p) => {
    const opts = p || {}
    const filters = Array.isArray(opts.filters) ? opts.filters : [{ name: 'JSON', extensions: ['json'] }]
    const common = {
      defaultPath: opts.defaultPath || undefined,
      filters,
      properties: ['openFile']
    }
    if (String(opts.mode || 'open') === 'save') {
      const r = await dialog.showSaveDialog(mainWindow, {
        defaultPath: opts.defaultPath || undefined,
        filters
      })
      return r.canceled ? null : r.filePath || null
    }
    const r = await dialog.showOpenDialog(mainWindow, common)
    return r.canceled || !r.filePaths || !r.filePaths.length ? null : r.filePaths[0]
  })
}

// 双开会并发写客户端登录态（切号期间可能把 storage.json / state.vscdb 写坏），只允许一个实例
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    initStore()
    registerIpc()
    await applyProxy(store.getSettings())
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
