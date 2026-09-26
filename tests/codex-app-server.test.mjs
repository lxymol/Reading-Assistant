import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { codexAppServer } from '../server/codex-app-server.mjs'

test('Codex conversations use restricted attachment tools; quick translation stays direct', async () => {
  const originalAccount = codexAppServer.account
  const originalRequest = codexAppServer.request
  const calls = []
  try {
    codexAppServer.account = async () => ({ type: 'chatgpt' })
    codexAppServer.request = async (method, params) => {
      calls.push({ method, params })
      if (method === 'config/read') return { config: { mcp_servers: { filesystem: {} }, plugins: { localFiles: {} } } }
      if (method === 'thread/start') return { thread: { id: 'test-thread' } }
      if (method === 'thread/resume') return { thread: { id: params.threadId } }
      if (method === 'turn/start') {
        if (params.input[0].text.includes('Create file')) await codexAppServer.toolHandlers.get('test-thread')('create_text_file', { name: 'notes.md', content: '# Note' })
        setTimeout(() => {
          for (const listener of codexAppServer.listeners) {
            listener('item/agentMessage/delta', { threadId: 'test-thread', turnId: 'test-turn', delta: 'Answer' })
            listener('turn/completed', { threadId: 'test-thread', turn: { id: 'test-turn', status: 'completed' } })
          }
        }, 0)
        return { turn: { id: 'test-turn' } }
      }
      throw new Error(`Unexpected method: ${method}`)
    }

    assert.equal((await codexAppServer.complete({ prompt: 'Analyze the document', persistThread: true })).content, 'Answer')
    const nativeThread = calls.find((call) => call.method === 'thread/start').params
    const nativeTurn = calls.find((call) => call.method === 'turn/start').params
    assert.equal(nativeThread.sandbox, 'read-only')
    assert.equal(nativeThread.ephemeral, false)
    assert.equal(nativeThread.config['features.shell_tool'], false)
    assert.equal(nativeThread.config['tools.view_image'], false)
    assert.equal(nativeThread.config['mcp_servers.filesystem.enabled'], false)
    assert.equal(nativeThread.config['plugins.localFiles.enabled'], false)
    assert.deepEqual(nativeThread.dynamicTools.map((tool) => tool.name), ['read_attachment', 'search_attachments', 'create_text_file'])
    assert.equal(nativeTurn.sandboxPolicy.type, 'readOnly')
    assert.equal(nativeTurn.sandboxPolicy.networkAccess, false)
    assert.deepEqual(nativeTurn.input[0].text_elements, [])
    assert.equal(existsSync(nativeThread.cwd), false)

    calls.length = 0
    assert.equal((await codexAppServer.complete({ prompt: 'Follow-up', threadId: 'test-thread', persistThread: true, initialContext: 'Old history' })).content, 'Answer')
    assert.equal(calls.find((call) => call.method === 'thread/resume').params.excludeTurns, true)
    assert.equal(calls.some((call) => call.method === 'thread/start'), false)
    assert.equal(calls.find((call) => call.method === 'turn/start').params.input[0].text, 'Follow-up')

    calls.length = 0
    const artifact = await codexAppServer.complete({ prompt: 'Create file', captureFiles: true })
    assert.deepEqual(artifact.files, [{ name: 'notes.md', content: '# Note' }])
    assert.equal(existsSync(calls.find((call) => call.method === 'thread/start').params.cwd), false)

    calls.length = 0
    const attached = await codexAppServer.complete({ prompt: 'Create file', captureFiles: true, prepareDocuments: async (directory) => {
      mkdirSync(`${directory}/attachments`)
      writeFileSync(`${directory}/attachments/paper.txt`, 'Complete paper')
      return [{ id: 'paper', name: 'paper.pdf', path: `${directory}/attachments/paper.txt`, byteLength: 14 }]
    } })
    assert.deepEqual(attached.files, [{ name: 'notes.md', content: '# Note' }], 'Supplied documents must not be imported as generated files')
    assert.match(calls.find((call) => call.method === 'turn/start').params.input[0].text, /attachment id: "paper"/)
    assert.equal(codexAppServer.toolHandlers.size, 0)

    calls.length = 0
    assert.equal((await codexAppServer.complete({ prompt: 'Translate', allowTools: false })).content, 'Answer')
    const directThread = calls.find((call) => call.method === 'thread/start').params
    const directTurn = calls.find((call) => call.method === 'turn/start').params
    assert.equal(directThread.sandbox, 'read-only')
    assert.equal(directTurn.sandboxPolicy.networkAccess, false)
  } finally {
    codexAppServer.account = originalAccount
    codexAppServer.request = originalRequest
    codexAppServer.listeners.clear()
    codexAppServer.toolHandlers.clear()
  }
})

test('Codex streams only final answers and discards reasoning and commentary', async () => {
  const originalAccount = codexAppServer.account
  const originalRequest = codexAppServer.request
  const deltas = []
  try {
    codexAppServer.account = async () => ({ type: 'chatgpt' })
    codexAppServer.request = async (method) => {
      if (method === 'config/read') return { config: {} }
      if (method === 'thread/start') return { thread: { id: 'phase-thread' } }
      if (method === 'turn/start') {
        setTimeout(() => {
          const emit = (name, params) => { for (const listener of codexAppServer.listeners) listener(name, { threadId: 'phase-thread', turnId: 'phase-turn', ...params }) }
          emit('item/started', { item: { id: 'comment', type: 'agentMessage', phase: 'commentary' } })
          emit('item/agentMessage/delta', { itemId: 'comment', delta: 'I will examine the files.' })
          emit('item/reasoning/summaryTextDelta', { delta: 'Reasoning summary' })
          emit('item/completed', { item: { id: 'comment', type: 'agentMessage', phase: 'commentary', text: 'I will examine the files.' } })
          emit('item/started', { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer' } })
          emit('item/agentMessage/delta', { itemId: 'answer', delta: 'Final ' })
          emit('item/agentMessage/delta', { itemId: 'answer', delta: 'answer.' })
          emit('item/completed', { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Final answer.' } })
          emit('turn/completed', { turn: { id: 'phase-turn', status: 'completed' } })
        }, 0)
        return { turn: { id: 'phase-turn' } }
      }
      throw new Error(method)
    }
    const result = await codexAppServer.complete({ prompt: 'Question', onDelta: (delta) => deltas.push(delta) })
    assert.equal(result.content, 'Final answer.')
    assert.equal(deltas.join(''), 'Final answer.')
  } finally {
    codexAppServer.account = originalAccount
    codexAppServer.request = originalRequest
    codexAppServer.listeners.clear()
    codexAppServer.toolHandlers.clear()
  }
})

test('Codex child process stops when idle but remains alive during a turn', async () => {
  const originalProcess = codexAppServer.process
  const originalStop = codexAppServer.stop
  const originalActiveTurns = codexAppServer.activeTurns
  let stops = 0
  try {
    codexAppServer.process = {}
    codexAppServer.stop = () => { stops += 1; codexAppServer.clearIdleTimer(); codexAppServer.process = null }
    codexAppServer.activeTurns = 1
    codexAppServer.scheduleIdleStop(5)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(stops, 0)
    codexAppServer.activeTurns = 0
    codexAppServer.scheduleIdleStop(5)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(stops, 1)
  } finally {
    codexAppServer.clearIdleTimer()
    codexAppServer.process = originalProcess
    codexAppServer.stop = originalStop
    codexAppServer.activeTurns = originalActiveTurns
  }
})
