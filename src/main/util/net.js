'use strict'
// 网络请求统一入口
// Electron 的 net.fetch 走 Chromium 网络栈，会自动跟随系统代理与 PAC ——
// chatgpt.com 这类域名在直连环境下必须靠代理，而 Node 原生 fetch 不读系统代理。
// 纯 Node 环境（scripts/ 下的诊断脚本）退回全局 fetch。

function httpFetch(input, init) {
  let impl = globalThis.fetch
  try {
    const { net } = require('electron')
    if (net && typeof net.fetch === 'function') impl = net.fetch
  } catch {
    /* 不在 Electron 主进程内 */
  }
  return impl(input, init)
}

module.exports = { httpFetch }
