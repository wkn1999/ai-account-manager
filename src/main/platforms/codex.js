'use strict'
// ChatGPT / Codex CLI 适配器
// 登录态：~/.codex/auth.json（OpenAI OAuth：id_token / access_token / refresh_token）
// 身份与套餐直接解析 JWT claims，无需联网；额度走 chatgpt.com/backend-api/codex/usage
// 该域名在部分网络环境需要代理，请求统一走 util/net（Electron 下自动跟随系统代理）

const http = require('http')
const crypto = require('crypto')
const { homeDir, exists, readJson, writeJsonAtomic, backupFile } = require('../util/core')
const { httpFetch } = require('../util/net')
const { markExpiry } = require('../util/quota')

const VARIANTS = {
  codex: {
    id: 'codex',
    label: 'ChatGPT / Codex',
    dirName: '.codex',
    region: 'international',
    usageApi: 'https://chatgpt.com/backend-api/codex/usage',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    loginPort: 1455
  }
}

const OAUTH_SCOPE = 'openid profile email offline_access'

// Codex CLI 使用的公开 OAuth 客户端 ID（非密钥，取自 auth.json 的 oauth_provenance）
const FALLBACK_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

function authPath(v) {
  return homeDir(v.dirName, 'auth.json')
}

function decodeJwt(token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && !Number.isNaN(Number(v))) return Number(v)
  return null
}

const clampPercent = (v) => Math.max(0, Math.min(100, v))

/** 从 access/id token 的 claims 里取身份，离线可用 */
function identity(tokens) {
  const access = decodeJwt(tokens.access_token) || {}
  const idt = decodeJwt(tokens.id_token) || {}
  const auth = access['https://api.openai.com/auth'] || idt['https://api.openai.com/auth'] || {}
  const profile = access['https://api.openai.com/profile'] || {}
  return {
    accountId: auth.chatgpt_account_id || tokens.account_id || null,
    userId: auth.chatgpt_user_id || idt.sub || null,
    planType: auth.chatgpt_plan_type || null,
    email: profile.email || idt.email || null,
    name: profile.name || idt.name || null,
    clientId: (tokens.oauth_provenance && tokens.oauth_provenance.client_id) || access.client_id || FALLBACK_CLIENT_ID
  }
}

function toAccount(variant, raw, ident) {
  const v = VARIANTS[variant]
  const key = ident.accountId || ident.email || ident.userId || 'unknown'
  return {
    id: `${variant}:${String(key).replace(/[^\w.@-]/g, '_')}`,
    platform: variant,
    platformLabel: v.label,
    region: v.region,
    name: ident.name || ident.email || String(key),
    email: ident.email || null,
    uid: ident.accountId || ident.userId || null,
    plan: ident.planType || null,
    snapshot: { auth: raw },
    updatedAt: Date.now()
  }
}

function detectCurrent(variant) {
  const v = VARIANTS[variant]
  if (!v) return null
  const p = authPath(v)
  if (!exists(p)) return null
  const raw = readJson(p)
  if (!raw || !raw.tokens || !raw.tokens.access_token) return null
  return toAccount(variant, raw, identity(raw.tokens))
}

/** 切换：备份后原子写回 auth.json，Codex CLI 下次启动即生效（无需杀进程） */
async function applyAccount(account) {
  const v = VARIANTS[account.platform]
  if (!v) throw new Error('未知平台: ' + account.platform)
  const raw = account.snapshot && account.snapshot.auth
  if (!raw || !raw.tokens) throw new Error('账号快照缺失，请重新导入该账号')
  const target = authPath(v)
  backupFile(target)
  writeJsonAtomic(target, raw)
  return { ok: true, storagePath: target, launched: false, message: '已写入 auth.json，Codex CLI 下次启动生效' }
}

/**
 * 应用内登录一个新的 ChatGPT 账号（Codex CLI 同款 OAuth PKCE）。
 * 只把拿到的 token 交给调用方入库，不写 ~/.codex/auth.json —— 添加账号不该顶掉当前登录。
 * @param {(url:string)=>void} [onUrl] 拿到授权链接后回调，由主进程用系统浏览器打开
 */
async function loginInteractive(variant, onUrl, timeoutMs = 300000) {
  const v = VARIANTS[variant]
  if (!v) throw new Error('未知平台: ' + variant)
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest().toString('base64url')
  const state = crypto.randomBytes(16).toString('base64url')
  const redirectUri = `http://localhost:${v.loginPort}/auth/callback`

  const authorizeUrl =
    v.authorizeUrl +
    '?' +
    new URLSearchParams({
      response_type: 'code',
      client_id: FALLBACK_CLIENT_ID,
      scope: OAUTH_SCOPE,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true'
    }).toString()

  const code = await new Promise((resolve, reject) => {
    const settle = (fn) => (arg) => {
      clearTimeout(timer)
      fn(arg)
    }
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost')
      if (u.pathname !== '/auth/callback') {
        res.writeHead(404)
        res.end()
        return
      }
      const fail = (msg) => {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<h3>登录失败：${msg}</h3>`)
        server.close()
        reject(new Error(msg))
      }
      if (u.searchParams.get('state') !== state) return fail('回调 state 校验失败')
      if (u.searchParams.get('error')) return fail(u.searchParams.get('error_description') || u.searchParams.get('error'))
      const c = u.searchParams.get('code')
      if (!c) return fail('回调里没有 code')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<h3>登录完成，可以关闭这个页面回到 AI账号管家</h3>')
      server.close()
      settle(resolve)(c)
    })
    const timer = setTimeout(() => {
      server.close()
      reject(new Error('登录超时：5 分钟内没有完成浏览器授权'))
    }, timeoutMs)
    server.once('error', (e) => {
      clearTimeout(timer)
      reject(e.code === 'EADDRINUSE' ? new Error(`回调端口 ${v.loginPort} 被占用，请先关闭其它 Codex 登录窗口`) : e)
    })
    // 只监听回环地址：授权码不会暴露到局域网
    server.listen(v.loginPort, '127.0.0.1', () => {
      if (onUrl) onUrl(authorizeUrl)
    })
  })

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: FALLBACK_CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri
  })
  let res
  try {
    res = await httpFetch(v.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString()
    })
  } catch (e) {
    throw new Error(`无法连接 auth.openai.com（${e.message}）：请在设置里配置代理后重试`)
  }
  const text = await res.text()
  if (!res.ok) throw new Error(`换取 Token 失败 HTTP ${res.status}: ${text.slice(0, 160)}`)
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('Token 响应非 JSON')
  }
  if (!data.access_token) throw new Error('Token 响应缺少 access_token')

  const raw = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      access_token: data.access_token,
      id_token: data.id_token || null,
      refresh_token: data.refresh_token || null,
      account_id: data.account_id || null
    },
    last_refresh: new Date().toISOString()
  }
  return toAccount(variant, raw, identity(raw.tokens))
}

/** access_token 过期时用 refresh_token 续期，只更新应用内的快照，不回写本机登录文件 */
async function refreshSession(v, raw) {
  const refresh = raw.tokens && raw.tokens.refresh_token
  if (!refresh) throw new Error('缺少 refresh_token，请重新登录 Codex CLI')
  const res = await httpFetch(v.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: identity(raw.tokens).clientId,
      scope: 'openid profile email offline_access'
    })
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`刷新 Token 失败 HTTP ${res.status}: ${text.slice(0, 160)}`)
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('刷新 Token 响应非 JSON')
  }
  if (!data.access_token) throw new Error('刷新 Token 未返回 access_token')
  raw.tokens.access_token = data.access_token
  if (data.id_token) raw.tokens.id_token = data.id_token
  if (data.refresh_token) raw.tokens.refresh_token = data.refresh_token
  raw.last_refresh = new Date().toISOString()
}

function usageWindow(win, label) {
  if (!win) return null
  const percent = num(win.used_percent)
  return {
    label,
    endTime: win.reset_at ? win.reset_at * 1000 : null,
    metrics: [{ label: '已用', limit: 100, used: percent == null ? null : clampPercent(percent) }],
    percent,
    windowHours: win.limit_window_seconds ? Math.round(win.limit_window_seconds / 3600) : null
  }
}

/** 查询 Codex 用量：主/次窗口、Credits、是否触顶 */
async function fetchQuota(account) {
  const v = VARIANTS[account.platform]
  const raw = account.snapshot && account.snapshot.auth
  if (!raw || !raw.tokens || !raw.tokens.access_token) throw new Error('缺少登录态，请重新导入账号')
  const ident = identity(raw.tokens)
  const headers = {
    Authorization: `Bearer ${raw.tokens.access_token}`,
    Accept: 'application/json',
    'User-Agent': 'ai-account-manager/0.1.0'
  }
  if (ident.accountId) headers['ChatGPT-Account-Id'] = ident.accountId

  let res
  try {
    res = await httpFetch(v.usageApi, { headers })
    if (res.status === 401 || res.status === 403) {
      await refreshSession(v, raw)
      headers.Authorization = `Bearer ${raw.tokens.access_token}`
      res = await httpFetch(v.usageApi, { headers })
    }
  } catch (e) {
    throw new Error(`无法连接 chatgpt.com（${e.message}）：请在设置里配置代理后重试`)
  }

  const text = await res.text()
  if (!res.ok) throw new Error(`额度查询失败 HTTP ${res.status}: ${text.slice(0, 160)}`)
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('额度响应非 JSON')
  }

  const rl = data.rate_limit || {}
  const primary = usageWindow(rl.primary_window, 'Codex 主窗口')
  const secondary = usageWindow(rl.secondary_window, 'Codex 次窗口')
  const items = [primary, secondary].filter(Boolean)

  const credits = data.credits || {}
  if (credits.has_credits) {
    items.push({
      label: 'Credits',
      endTime: null,
      metrics: [
        { label: '余额', limit: null, used: num(credits.balance) },
        { label: '约可发消息', limit: null, used: num(credits.approx_local_messages) }
      ]
    })
  }

  const percent = primary && primary.percent != null ? clampPercent(primary.percent) : null
  const summary =
    percent == null
      ? null
      : {
          total: 100,
          used: percent,
          remaining: Math.max(0, 100 - percent),
          unit: '%',
          percent,
          resetAt: primary.endTime
        }

  let message = null
  if (rl.limit_reached) message = '已达用量上限' + (primary && primary.endTime ? `，${fmtReset(primary.endTime)}重置` : '')
  else if (credits.overage_limit_reached) message = 'Credits 超额上限已触达'
  else if (data.spend_control && data.spend_control.reached) message = '消费上限已触达'

  markExpiry(items)

  return {
    plan: data.plan_type || ident.planType || null,
    summary,
    items,
    blocked: Boolean(rl.limit_reached),
    allowed: rl.allowed !== false,
    message,
    raw: { plan_type: data.plan_type, rate_limit: rl, credits }
  }
}

/** 精确到分钟的本地时间，避免只说「N 天后」让人猜是哪天 */
function fmtReset(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

module.exports = {
  VARIANTS,
  variants: Object.keys(VARIANTS),
  authPath,
  identity,
  detectCurrent,
  applyAccount,
  loginInteractive,
  fetchQuota
}
