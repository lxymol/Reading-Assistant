import { spawn } from 'node:child_process'
import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'

const abortError = () => Object.assign(new Error('请求已取消'), { name: 'AbortError' })

function findCodexExecutable() {
  const candidates = [process.env.RAID_CODEX_BINARY, process.env.CODEX_BINARY].filter(Boolean)
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const bundledBin = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')
    try {
      const builds = fs.readdirSync(bundledBin, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(bundledBin, entry.name, 'codex.exe'))
        .filter((candidate) => fs.existsSync(candidate))
        .sort((first, second) => fs.statSync(second).mtimeMs - fs.statSync(first).mtimeMs)
      candidates.push(...builds)
    } catch { /* Fall back to PATH when Codex Desktop is not installed here. */ }
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || 'codex'
}

class CodexAppServer {
  process = null
  reader = null
  ready = null
  nextId = 1
  pending = new Map()
  listeners = new Set()
  stderr = ''

  async ensureStarted() {
    if (this.ready) return this.ready
    this.ready = this.start().catch((error) => {
      this.stop()
      throw error
    })
    return this.ready
  }

  async start() {
    const child = spawn(findCodexExecutable(), ['app-server', '--stdio'], {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.process = child
    this.stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-4000) })
    child.once('error', (error) => this.failAll(error))
    child.once('exit', (code) => this.failAll(new Error(this.stderr.trim() || `Codex App Server 已退出（${code ?? 'unknown'}）`)))
    this.reader = readline.createInterface({ input: child.stdout })
    this.reader.on('line', (line) => this.onLine(line))
    await this.request('initialize', { clientInfo: { name: 'raid_reader', title: 'Raid', version: '1.3.0' } }, false)
    this.notify('initialized', {})
  }

  onLine(line) {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (Object.hasOwn(message, 'id') && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message || 'Codex 请求失败'))
      else pending.resolve(message.result)
      return
    }
    if (Object.hasOwn(message, 'id') && message.method) {
      this.write({ id: message.id, error: { code: -32601, message: 'Raid 不允许 Codex 调用交互式工具。' } })
      return
    }
    if (message.method) this.listeners.forEach((listener) => listener(message.method, message.params || {}))
  }

  write(message) {
    if (!this.process?.stdin?.writable) throw new Error('Codex App Server 未运行')
    this.process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  notify(method, params) { this.write({ method, params }) }

  async request(method, params = {}, ensure = true) {
    if (ensure) await this.ensureStarted()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex 请求超时：${method}`))
      }, 20000)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      try { this.write({ method, id, params }) } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }

  failAll(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    this.listeners.forEach((listener) => listener('server/error', { error }))
  }

  async account() {
    const result = await this.request('account/read', { refreshToken: true })
    return result?.account || null
  }

  async startLogin() {
    const result = await this.request('account/login/start', {
      type: 'chatgpt',
      appBrand: 'codex',
      codexStreamlinedLogin: true,
      useHostedLoginSuccessPage: true,
    })
    if (result?.type !== 'chatgpt' || !result.authUrl || !result.loginId) throw new Error('Codex 没有返回有效的登录地址')
    return { authUrl: result.authUrl, loginId: result.loginId }
  }

  async status() {
    try {
      const account = await this.account()
      return {
        installed: true,
        loggedIn: account?.type === 'chatgpt',
        accountType: account?.type || '',
        email: account?.email || '',
        planType: account?.planType || '',
        requiresChatGptLogin: account?.type !== 'chatgpt',
      }
    } catch (error) {
      const missing = error?.code === 'ENOENT' || /ENOENT|not recognized|找不到/.test(String(error?.message || ''))
      return { installed: !missing, loggedIn: false, error: missing ? '未检测到 Codex。请先安装并登录 Codex。' : String(error?.message || '无法读取 Codex 登录状态') }
    }
  }

  async models() {
    const account = await this.account()
    if (account?.type !== 'chatgpt') throw new Error('当前电脑尚未登录 Codex 账户。请先在 Codex 中登录。')
    const models = []
    let cursor = null
    do {
      const result = await this.request('model/list', { cursor, limit: 100, includeHidden: false })
      models.push(...(Array.isArray(result?.data) ? result.data : []))
      cursor = result?.nextCursor || null
    } while (cursor && models.length < 300)
    return models
  }

  async complete({ prompt, images = [], model, effort, signal, onDelta, generalChat = false }) {
    if (signal?.aborted) throw abortError()
    const account = await this.account()
    if (signal?.aborted) throw abortError()
    if (account?.type !== 'chatgpt') throw new Error('当前电脑尚未登录 Codex 账户。请先在 Codex 中登录。')
    const threadResult = await this.request('thread/start', {
      model: model || null,
      cwd: process.cwd(),
      approvalPolicy: 'never',
      sandbox: 'read-only',
      serviceName: 'raid_reader',
      ephemeral: true,
      developerInstructions: generalChat
        ? 'You are embedded in Raid as a general conversational assistant. You have no direct tools. Never use the shell, local files, or the network. Raid may provide results from its own restricted tools inside the user message; use only those results and answer without assuming any other access. Final user-facing answers must be Markdown and must not be wrapped in one outer code fence.'
        : 'You are embedded in Raid as a document-reading model. You have no direct tools. Never use the shell, local files, or the network. Raid may provide results from its own restricted tools inside the user message; use only the supplied material. Final user-facing answers must be Markdown and must not be wrapped in one outer code fence.',
    })
    if (signal?.aborted) throw abortError()
    const threadId = threadResult?.thread?.id
    if (!threadId) throw new Error('Codex 未能创建临时会话')
    let turnId = ''
    let content = ''
    let settled = false
    let resolveCompletion
    let rejectCompletion
    const completion = new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject })
    const finish = (error) => {
      if (settled) return
      settled = true
      this.listeners.delete(listener)
      signal?.removeEventListener('abort', abort)
      if (error) rejectCompletion(error)
      else resolveCompletion(content)
    }
    const listener = (method, params) => {
      if (method === 'server/error') return finish(params.error || new Error('Codex App Server 已停止'))
      if (params.threadId && params.threadId !== threadId) return
      if (turnId && params.turnId && params.turnId !== turnId) return
      if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
        content += params.delta
        onDelta?.(params.delta)
      }
      if (method === 'turn/completed') {
        const turn = params.turn || {}
        if (turn.id && turnId && turn.id !== turnId) return
        const status = typeof turn.status === 'string' ? turn.status : turn.status?.type
        if (status && !['completed', 'complete'].includes(status)) finish(new Error(turn.error?.message || `Codex 生成未完成（${status}）`))
        else finish()
      }
    }
    const abort = () => {
      if (turnId) void this.request('turn/interrupt', { threadId, turnId }).catch(() => undefined)
      finish(abortError())
    }
    this.listeners.add(listener)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const turnResult = await this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }, ...images.map((url) => ({ type: 'image', url, detail: 'high' }))],
        model: model || null,
        effort: effort || null,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      })
      turnId = turnResult?.turn?.id || ''
      if (!turnId) throw new Error('Codex 未能开始生成')
      if (signal?.aborted) abort()
      const result = await completion
      if (!result.trim()) throw new Error('Codex 未返回内容')
      return result
    } catch (error) {
      if (!settled) {
        settled = true
        this.listeners.delete(listener)
        signal?.removeEventListener('abort', abort)
      }
      throw error
    }
  }

  stop() {
    this.reader?.close()
    this.reader = null
    if (this.process && !this.process.killed) this.process.kill()
    this.process = null
    this.ready = null
  }
}

export const codexAppServer = new CodexAppServer()
