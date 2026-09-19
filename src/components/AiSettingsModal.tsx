import { Bot, CheckCircle2, CircleHelp, Download, ExternalLink, Eye, EyeOff, FolderOpen, GitFork, Languages, LoaderCircle, Puzzle, RefreshCw, Settings2, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LanguagePack } from '../i18n'
import { useI18n, type AppLanguage } from '../i18n'
import type { AiConfig, AppUpdateInfo, ImportedSkill, MemorySettings, ShortcutAction, ShortcutSettings } from '../types'
import { shortcutFromKeyboardEvent, shortcutFromMouseEvent } from '../services/shortcuts'

type SettingsTab = 'models' | 'advanced' | 'general'

type Props = {
  value: AiConfig
  serverConfigured: boolean
  skills: ImportedSkill[]
  language: AppLanguage
  languages: LanguagePack[]
  memorySettings: MemorySettings
  userMemory: string
  quickOpenEnabled: boolean
  shortcutSettings: ShortcutSettings
  onClose: () => void
  onSave: (config: AiConfig) => void
  onImportSkill: () => Promise<boolean>
  onRemoveSkill: (id: string) => void
  onImportLanguage: () => Promise<boolean>
  onLanguageChange: (language: AppLanguage) => void
  onMemorySettingsChange: (settings: MemorySettings) => void
  onUserMemoryChange: (memory: string) => void
  onQuickOpenChange: (enabled: boolean) => Promise<void> | void
  onShortcutSettingsChange: (settings: ShortcutSettings) => void
}

export default function AiSettingsModal({ value, serverConfigured, skills, language, languages, memorySettings, userMemory, quickOpenEnabled, shortcutSettings, onClose, onSave, onImportSkill, onRemoveSkill, onImportLanguage, onLanguageChange, onMemorySettingsChange, onUserMemoryChange, onQuickOpenChange, onShortcutSettingsChange }: Props) {
  const { t, pack } = useI18n()
  const [tab, setTab] = useState<SettingsTab>('models')
  const [draft, setDraft] = useState(value)
  const [showKey, setShowKey] = useState(false)
  const [showVisionKey, setShowVisionKey] = useState(false)
  const [showReasoningKey, setShowReasoningKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [loadingModels, setLoadingModels] = useState<'default' | 'vision' | 'reasoning' | null>(null)
  const [modelMenu, setModelMenu] = useState<'default' | 'vision' | 'reasoning' | null>(null)
  const [availableModels, setAvailableModels] = useState<Record<'default' | 'vision' | 'reasoning', string[]>>({ default: [], vision: [], reasoning: [] })
  const [message, setMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)
  const [codexStatus, setCodexStatus] = useState<{ loading: boolean; installed?: boolean; loggedIn?: boolean; accountType?: string; email?: string; planType?: string; error?: string }>({ loading: false })
  const [startingCodexLogin, setStartingCodexLogin] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [recordingShortcut, setRecordingShortcut] = useState<ShortcutAction | null>(null)
  const loginPollRef = useRef<number | null>(null)
  const updateRequestedRef = useRef(false)

  const checkForUpdates = useCallback(async (force = false) => {
    setCheckingUpdate(true)
    try {
      if (!window.readingAssistant?.checkForUpdates) throw new Error('Desktop update check unavailable')
      setUpdateInfo(await window.readingAssistant.checkForUpdates(force))
    } catch {
      setUpdateInfo({ currentVersion: '2.1.0', author: 'xyLee', repositoryUrl: 'https://github.com/lxymol/Reading-Assistant', releaseUrl: 'https://github.com/lxymol/Reading-Assistant/releases/latest', updateAvailable: false, checkedAt: Date.now(), error: 'UPDATE_CHECK_FAILED' })
    } finally {
      setCheckingUpdate(false)
    }
  }, [])

  const openExternal = (url: string) => {
    if (window.readingAssistant?.openExternal) void window.readingAssistant.openExternal(url)
    else window.open(url, '_blank', 'noopener,noreferrer')
  }

  const updateShortcut = (action: ShortcutAction, shortcut: string) => {
    const next = { ...shortcutSettings }
    for (const key of Object.keys(next) as ShortcutAction[]) if (key !== action && shortcut && next[key] === shortcut) next[key] = ''
    next[action] = shortcut
    onShortcutSettingsChange(next)
  }

  const refreshCodexStatus = async () => {
    setCodexStatus({ loading: true })
    try {
      const response = await fetch('/api/codex/status')
      const data = await response.json()
      setCodexStatus({ loading: false, ...data })
      return data as { loggedIn?: boolean; email?: string; planType?: string }
    } catch (reason) {
      setCodexStatus({ loading: false, loggedIn: false, error: reason instanceof Error ? reason.message : 'Codex status unavailable' })
      return null
    }
  }

  const stopLoginPolling = () => {
    if (loginPollRef.current !== null) window.clearInterval(loginPollRef.current)
    loginPollRef.current = null
  }

  const startCodexLogin = async () => {
    setStartingCodexLogin(true)
    setMessage(null)
    stopLoginPolling()
    try {
      const response = await fetch('/api/codex/login', { method: 'POST' })
      const data = await response.json()
      if (!response.ok || !data.authUrl) throw new Error(data.error || (pack.code === 'en-US' ? 'Could not start Codex sign-in.' : '无法启动 Codex 登录。'))
      if (window.readingAssistant?.openExternal) await window.readingAssistant.openExternal(data.authUrl)
      else window.open(data.authUrl, '_blank', 'noopener,noreferrer')
      let checks = 0
      loginPollRef.current = window.setInterval(async () => {
        checks += 1
        const status = await refreshCodexStatus()
        if (status?.loggedIn) {
          stopLoginPolling()
          setStartingCodexLogin(false)
          setMessage({ type: 'ok', text: pack.code === 'en-US' ? 'Codex account connected.' : 'Codex 账户已连接。' })
        } else if (checks >= 120) {
          stopLoginPolling()
          setStartingCodexLogin(false)
          setMessage({ type: 'error', text: pack.code === 'en-US' ? 'Sign-in timed out. You can try again.' : '登录等待超时，可以重新尝试。' })
        }
      }, 1500)
    } catch (reason) {
      setStartingCodexLogin(false)
      setMessage({ type: 'error', text: reason instanceof Error ? reason.message : t('connectionFailed') })
    }
  }

  useEffect(() => {
    if (draft.provider !== 'codex') return
    const timer = window.setTimeout(() => void refreshCodexStatus(), 0)
    return () => window.clearTimeout(timer)
  }, [draft.provider])

  useEffect(() => () => stopLoginPolling(), [])

  useEffect(() => {
    if (tab !== 'general' || updateRequestedRef.current) return
    updateRequestedRef.current = true
    void checkForUpdates()
  }, [tab, checkForUpdates])

  const fetchModels = async (mode: 'default' | 'vision' | 'reasoning') => {
    if (modelMenu === mode && availableModels[mode].length) return setModelMenu(null)
    setLoadingModels(mode)
    setMessage(null)
    try {
      const response = await fetch('/api/ai/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aiConfig: draft, mode }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || (pack.code === 'en-US' ? 'Could not load models.' : '无法获取模型列表。'))
      setAvailableModels((items) => ({ ...items, [mode]: data.models }))
      setModelMenu(mode)
    } catch (reason) {
      setMessage({ type: 'error', text: reason instanceof Error ? reason.message : t('connectionFailed') })
    } finally {
      setLoadingModels(null)
    }
  }

  const modelPicker = (mode: 'default' | 'vision' | 'reasoning', field: 'model' | 'visionModel' | 'reasoningModel' | 'codexModel' | 'codexReasoningModel', placeholder: string) => <div className="model-picker">
    <input className="settings-input" value={draft[field]} onChange={(event) => setDraft({ ...draft, [field]: event.target.value })} placeholder={placeholder} />
    <button type="button" className="model-help" onClick={() => void fetchModels(mode)} title={pack.code === 'en-US' ? 'Show available models' : '获取并显示可用模型'}>{loadingModels === mode ? <LoaderCircle className="spin" size={15} /> : <CircleHelp size={15} />}</button>
    {modelMenu === mode && <div className="model-options">{availableModels[mode].map((model) => <button type="button" key={model} className={draft[field] === model ? 'active' : ''} onClick={() => { setDraft({ ...draft, [field]: model }); setModelMenu(null) }}>{model}</button>)}</div>}
  </div>

  const testConnection = async () => {
    setTesting(true)
    setMessage(null)
    try {
      const response = await fetch('/api/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aiConfig: draft }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || t('connectionFailed'))
      setMessage({ type: 'ok', text: pack.code === 'en-US' ? 'Connection successful.' : '连接成功。' })
    } catch (reason) {
      setMessage({ type: 'error', text: reason instanceof Error ? reason.message : t('connectionFailed') })
    } finally {
      setTesting(false)
    }
  }

  const runImport = async (kind: 'skill' | 'language') => {
    setImporting(true)
    setMessage(null)
    try {
      const imported = await (kind === 'skill' ? onImportSkill() : onImportLanguage())
      if (!imported) return
      setMessage({ type: 'ok', text: kind === 'skill' ? t('skillImported') : t('languageImported') })
    } catch (reason) {
      setMessage({ type: 'error', text: reason instanceof Error ? reason.message : t('importFailed') })
    } finally {
      setImporting(false)
    }
  }


  const save = () => {
    if (draft.provider === 'codex') {
      if (!codexStatus.loggedIn) return setMessage({ type: 'error', text: pack.code === 'en-US' ? 'Sign in to Codex on this computer first.' : '请先在这台电脑上登录 Codex。' })
      if (!draft.codexModel.trim()) return setMessage({ type: 'error', text: pack.code === 'en-US' ? 'Choose a default Codex model.' : '请选择 Codex 默认模型。' })
      if (draft.reasoningEnabled && !draft.codexReasoningModel.trim()) return setMessage({ type: 'error', text: pack.code === 'en-US' ? 'Choose a Codex thinking model.' : '请选择 Codex 深度思考模型。' })
      onSave({ ...draft, provider: 'codex', codexModel: draft.codexModel.trim(), codexReasoningModel: draft.codexReasoningModel.trim() })
      onClose()
      return
    }
    if (!draft.apiKey.trim() && !serverConfigured) return setMessage({ type: 'error', text: pack.code === 'en-US' ? 'Enter an API key.' : '请填写 API Key。' })
    if (!draft.baseUrl.trim() || !draft.model.trim()) return setMessage({ type: 'error', text: pack.code === 'en-US' ? 'The API URL and model are required.' : '接口地址和模型名称不能为空。' })
    if (draft.visionEnabled && !draft.visionModel.trim()) return setMessage({ type: 'error', text: pack.code === 'en-US' ? 'Enter a vision model.' : '启用公式与图表理解后，请填写视觉模型名称。' })
    if (draft.reasoningEnabled && !draft.reasoningModel.trim()) return setMessage({ type: 'error', text: pack.code === 'en-US' ? 'Enter a deep-thinking model.' : '启用深度思考后，请填写深度思考模型名称。' })
    onSave({
      provider: 'api',
      apiKey: draft.apiKey.trim(), baseUrl: draft.baseUrl.trim().replace(/\/$/, ''), model: draft.model.trim(),
      visionEnabled: draft.visionEnabled, visionApiKey: draft.visionApiKey.trim(), visionBaseUrl: draft.visionBaseUrl.trim().replace(/\/$/, ''), visionModel: draft.visionModel.trim(),
      reasoningEnabled: draft.reasoningEnabled, reasoningApiKey: draft.reasoningApiKey.trim(), reasoningBaseUrl: draft.reasoningBaseUrl.trim().replace(/\/$/, ''), reasoningModel: draft.reasoningModel.trim(),
      codexModel: draft.codexModel.trim(), codexReasoningModel: draft.codexReasoningModel.trim(),
      codexAgentEnabled: draft.codexAgentEnabled,
    })
    onClose()
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="settings-heading"><div className="settings-icon"><Settings2 size={20} /></div><div><h2 id="settings-title">{t('settingsTitle')}</h2></div><button className="icon-button" onClick={onClose} aria-label={t('close')}><X size={18} /></button></div>
      <nav className="settings-tabs">
        <button className={tab === 'models' ? 'active' : ''} onClick={() => { setTab('models'); setMessage(null) }}><Bot size={15} />{pack.code === 'en-US' ? 'Models' : '模型'}</button>
        <button className={tab === 'advanced' ? 'active' : ''} onClick={() => { setTab('advanced'); setMessage(null) }}><SlidersHorizontal size={15} />{pack.code === 'en-US' ? 'Advanced' : '高级'}</button>
        <button className={tab === 'general' ? 'active' : ''} onClick={() => { setTab('general'); setMessage(null) }}><Languages size={15} />{pack.code === 'en-US' ? 'General' : '通用'}</button>
      </nav>

      <div className="settings-body">
        {tab === 'models' && <>
          <div className="ai-provider-switch" role="group" aria-label={pack.code === 'en-US' ? 'AI connection' : 'AI 接入方式'}>
            <button type="button" className={draft.provider === 'api' ? 'active' : ''} onClick={() => { setDraft({ ...draft, provider: 'api' }); setMessage(null) }}>API</button>
            <button type="button" className={draft.provider === 'codex' ? 'active' : ''} onClick={() => { setDraft({ ...draft, provider: 'codex' }); setMessage(null) }}>Codex</button>
          </div>
          {draft.provider === 'api' ? <>
          <div className="model-section-title">{t('defaultModel')}</div>
          <label className="field-label">{t('apiUrl')}</label><input className="settings-input" value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://your-provider.example/v1" autoComplete="url" />
          <label className="field-label">{t('model')}</label>{modelPicker('default', 'model', 'model-name')}
          <label className="field-label">{t('apiKey')}</label><div className="key-input"><input type={showKey ? 'text' : 'password'} value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder={serverConfigured ? t('serverFallback') : 'sk-…'} autoComplete="off" /><button onClick={() => setShowKey((value) => !value)} aria-label={showKey ? t('hideKey') : t('showKey')}>{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>

          <section className="vision-config"><label className="vision-toggle"><input type="checkbox" checked={draft.visionEnabled} onChange={(event) => setDraft({ ...draft, visionEnabled: event.target.checked })} /><span className="vision-switch" aria-hidden="true" /><span><strong>{t('visual')}</strong></span></label>{draft.visionEnabled && <div className="vision-fields">
            <label className="field-label">{t('visualUrl')}</label><input className="settings-input" value={draft.visionBaseUrl} onChange={(event) => setDraft({ ...draft, visionBaseUrl: event.target.value })} placeholder={t('inheritUrl')} autoComplete="url" />
            <label className="field-label">{t('visualModel')}</label>{modelPicker('vision', 'visionModel', 'vision-model-name')}
            <label className="field-label">{t('visualKey')}</label><div className="key-input"><input type={showVisionKey ? 'text' : 'password'} value={draft.visionApiKey} onChange={(event) => setDraft({ ...draft, visionApiKey: event.target.value })} placeholder={t('inheritKey')} autoComplete="off" /><button onClick={() => setShowVisionKey((value) => !value)} aria-label={showVisionKey ? t('hideKey') : t('showKey')}>{showVisionKey ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
          </div>}</section>

          <section className="vision-config"><label className="vision-toggle"><input type="checkbox" checked={draft.reasoningEnabled} onChange={(event) => setDraft({ ...draft, reasoningEnabled: event.target.checked })} /><span className="vision-switch" aria-hidden="true" /><span><strong>{t('enableDeepThinking')}</strong></span></label>{draft.reasoningEnabled && <div className="vision-fields">
            <label className="field-label">{t('reasoningUrl')}</label><input className="settings-input" value={draft.reasoningBaseUrl} onChange={(event) => setDraft({ ...draft, reasoningBaseUrl: event.target.value })} placeholder={t('inheritUrl')} autoComplete="url" />
            <label className="field-label">{t('reasoningModel')}</label>{modelPicker('reasoning', 'reasoningModel', 'reasoning-model-name')}
            <label className="field-label">{t('reasoningKey')}</label><div className="key-input"><input type={showReasoningKey ? 'text' : 'password'} value={draft.reasoningApiKey} onChange={(event) => setDraft({ ...draft, reasoningApiKey: event.target.value })} placeholder={t('inheritKey')} autoComplete="off" /><button onClick={() => setShowReasoningKey((value) => !value)} aria-label={showReasoningKey ? t('hideKey') : t('showKey')}>{showReasoningKey ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
          </div>}</section>
          </> : <>
            <section className={`codex-account-status ${codexStatus.loggedIn ? 'connected' : ''}`}>
              <div><strong>{pack.code === 'en-US' ? 'Codex account' : 'Codex 账户'}</strong><small>{codexStatus.loading ? (pack.code === 'en-US' ? 'Checking…' : '正在检查…') : codexStatus.loggedIn ? `${codexStatus.email || (pack.code === 'en-US' ? 'Signed in' : '已登录')}${codexStatus.planType ? ` · ${codexStatus.planType}` : ''}` : codexStatus.accountType === 'apiKey' ? (pack.code === 'en-US' ? 'Codex is using an API key. Sign in with ChatGPT for subscription access.' : 'Codex 当前使用 API Key；如需订阅额度，请改用 ChatGPT 账户登录。') : (codexStatus.error || (pack.code === 'en-US' ? 'No reusable Codex account was found.' : '没有检测到可复用的 Codex 账户。'))}</small></div>
              <button type="button" onClick={() => codexStatus.loggedIn ? void refreshCodexStatus() : void startCodexLogin()} disabled={codexStatus.loading || startingCodexLogin}>{codexStatus.loading || startingCodexLogin ? <LoaderCircle className="spin" size={14} /> : codexStatus.loggedIn ? (pack.code === 'en-US' ? 'Refresh' : '刷新') : (pack.code === 'en-US' ? 'Sign in' : '登录')}</button>
            </section>
            <label className="field-label codex-primary-model-label">{pack.code === 'en-US' ? 'Default model name' : '默认模型名称'}</label>{modelPicker('default', 'codexModel', 'gpt-…')}
            <section className="vision-config"><label className="vision-toggle"><input type="checkbox" checked={draft.codexAgentEnabled} onChange={(event) => setDraft({ ...draft, codexAgentEnabled: event.target.checked })} /><span className="vision-switch" aria-hidden="true" /><span><strong>{pack.code === 'en-US' ? 'Restricted agent mode' : '受限 Agent 模式'}</strong><small>{pack.code === 'en-US' ? 'Can plan and use Raid-approved reading, time, and web-search tools. No terminal, file writes, or computer control.' : '可拆分任务并调用 Raid 白名单中的阅读、时间与联网搜索工具；不开放终端、文件写入或电脑控制。'}</small></span></label></section>
            <section className="vision-config"><label className="vision-toggle"><input type="checkbox" checked={draft.reasoningEnabled} onChange={(event) => setDraft({ ...draft, reasoningEnabled: event.target.checked })} /><span className="vision-switch" aria-hidden="true" /><span><strong>{t('enableDeepThinking')}</strong></span></label>{draft.reasoningEnabled && <div className="vision-fields">
              <label className="field-label">{t('reasoningModel')}</label>{modelPicker('reasoning', 'codexReasoningModel', 'gpt-…')}
            </div>}</section>
          </>}
        </>}

        {tab === 'advanced' && <div className="advanced-settings"><section className="import-settings"><div className="import-header"><div><h3>{t('skillSettings')}</h3><p>{t('skillImportHelp')}</p></div><button className="import-button" disabled={importing} onClick={() => runImport('skill')}>{importing ? <LoaderCircle className="spin" size={15} /> : <FolderOpen size={15} />}{t('importSkill')}</button></div>
          <div className="import-list">{skills.length ? skills.map((skill) => <article key={skill.id} className="import-card"><div><strong>{skill.name}</strong><code>/{skill.command}</code><p>{skill.description}</p><small>{skill.sourcePath}</small></div><button onClick={() => onRemoveSkill(skill.id)} title={t('removeSkill')}><Trash2 size={15} /></button></article>) : <div className="import-empty"><Puzzle size={24} /><p>{t('noSkills')}</p></div>}</div>
        </section>

        <section className="memory-settings">
          <section className="memory-card">
            <label className="vision-toggle"><input type="checkbox" checked={memorySettings.userMemoryEnabled} onChange={(event) => onMemorySettingsChange({ ...memorySettings, userMemoryEnabled: event.target.checked })} /><span className="vision-switch" aria-hidden="true" /><span><strong>{t('userMemory')}</strong><small>{t('userMemoryHelp')}</small></span></label>
            <textarea className="user-memory-editor" value={userMemory} onChange={(event) => onUserMemoryChange(event.target.value)} placeholder={t('userMemoryPlaceholder')} />
            <div className="memory-editor-footer"><small>{userMemory.length} / 12000</small>{userMemory && <button onClick={() => { if (window.confirm(t('confirmClearUserMemory'))) onUserMemoryChange('') }}><Trash2 size={13} />{t('clearUserMemory')}</button>}</div>
          </section>
        </section></div>}

        {tab === 'general' && <div className="general-settings"><section className="import-settings"><div className="import-header"><div><h3>{t('languageSettings')}</h3><p>{t('languageImportHelp')}</p></div><button className="import-button" disabled={importing} onClick={() => runImport('language')}>{importing ? <LoaderCircle className="spin" size={15} /> : <FolderOpen size={15} />}{t('importLanguage')}</button></div>
          <div className="language-list">{languages.map((item) => <button key={item.code} className={language === item.code ? 'active' : ''} onClick={() => onLanguageChange(item.code)}><span>{item.label}</span><small>{item.code}</small>{language === item.code && <CheckCircle2 size={16} />}</button>)}</div>
        </section><section className="memory-card shortcut-settings"><div className="shortcut-heading"><h3>{pack.code === 'en-US' ? 'Shortcuts' : '快捷键'}</h3><small>{pack.code === 'en-US' ? 'Click a field, then press a key combination or mouse button.' : '点击输入框后，按下组合键或鼠标按键。'}</small></div>{(['projects', 'tags', 'chat', 'annotation'] as ShortcutAction[]).map((action) => {
          const labels: Record<ShortcutAction, string> = { projects: pack.code === 'en-US' ? 'Files' : '文件', tags: pack.code === 'en-US' ? 'Tags' : '标签', chat: pack.code === 'en-US' ? 'Chat' : '对话', annotation: pack.code === 'en-US' ? 'Annotation' : '批注' }
          return <label className="shortcut-row" key={action}><span>{labels[action]}</span><input readOnly value={recordingShortcut === action ? (pack.code === 'en-US' ? 'Press shortcut…' : '请按快捷键…') : shortcutSettings[action]} placeholder={pack.code === 'en-US' ? 'Not set' : '未设置'} onFocus={() => setRecordingShortcut(action)} onKeyDown={(event) => { event.preventDefault(); event.stopPropagation(); if (event.key === 'Escape') return setRecordingShortcut(null); const shortcut = shortcutFromKeyboardEvent(event); if (shortcut) { updateShortcut(action, shortcut); setRecordingShortcut(null); event.currentTarget.blur() } }} onMouseDown={(event) => { if (recordingShortcut !== action || event.button === 0) return; event.preventDefault(); event.stopPropagation(); updateShortcut(action, shortcutFromMouseEvent(event)); setRecordingShortcut(null); event.currentTarget.blur() }} onContextMenu={(event) => event.preventDefault()} /><button type="button" onClick={() => { updateShortcut(action, ''); setRecordingShortcut(null) }}>{pack.code === 'en-US' ? 'Clear' : '清除'}</button></label>
        })}</section><section className="memory-card quick-open-card"><label className="vision-toggle"><input type="checkbox" checked={quickOpenEnabled} disabled={!window.readingAssistant} onChange={(event) => void onQuickOpenChange(event.target.checked)} /><span className="vision-switch" aria-hidden="true" /><span><strong>{pack.code === 'en-US' ? 'Open with Raid' : '右键使用 Raid 打开'}</strong><small>{pack.code === 'en-US' ? 'Adds an “Open with Raid” item to the Windows file context menu.' : '在 Windows 文件右键菜单中添加“使用 Raid 打开”。卸载时会自动清理。'}</small></span></label></section>
          <section className="memory-card app-info-card">
            <div className="app-info-heading"><h3>{pack.code === 'en-US' ? 'Raid version' : 'Raid 版本'}</h3><button className="update-refresh" type="button" disabled={checkingUpdate} onClick={() => void checkForUpdates(true)} title={pack.code === 'en-US' ? 'Check again' : '重新检查'}>{checkingUpdate ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}</button></div>
            <div className="version-grid"><span>{pack.code === 'en-US' ? 'Current version' : '当前版本'}</span><strong>{updateInfo ? `v${updateInfo.currentVersion}` : '—'}</strong><span>{pack.code === 'en-US' ? 'Latest version' : '最新版本'}</span><strong>{checkingUpdate && !updateInfo ? (pack.code === 'en-US' ? 'Checking…' : '检查中…') : updateInfo?.latestVersion ? `v${updateInfo.latestVersion}` : (pack.code === 'en-US' ? 'Unavailable' : '暂时无法获取')}</strong></div>
            {updateInfo?.updateAvailable && <div className="update-status available">{pack.code === 'en-US' ? 'A new version is available' : '发现新版本'}</div>}
            {updateInfo?.error && <div className="update-status failed">{pack.code === 'en-US' ? 'Could not check GitHub. You can still open the releases page.' : '暂时无法连接 GitHub，仍可直接打开发布页面。'}</div>}
            <div className="app-info-actions"><button type="button" onClick={() => openExternal(updateInfo?.repositoryUrl || 'https://github.com/lxymol/Reading-Assistant')}><GitFork size={14} />{pack.code === 'en-US' ? 'Repository' : '项目仓库'}<ExternalLink size={11} /></button><button type="button" className={updateInfo?.updateAvailable ? 'primary' : ''} onClick={() => openExternal(updateInfo?.releaseUrl || 'https://github.com/lxymol/Reading-Assistant/releases/latest')}>{updateInfo?.updateAvailable ? <Download size={14} /> : <ExternalLink size={14} />}{updateInfo?.updateAvailable ? (pack.code === 'en-US' ? 'Download update' : '下载更新') : (pack.code === 'en-US' ? 'Releases' : '发布页面')}</button><small className="app-author">by xyLee</small></div>
          </section></div>}

        {message && <div className={`settings-message ${message.type}`}>{message.type === 'ok' ? <CheckCircle2 size={15} /> : <X size={15} />}<span>{message.text}</span></div>}
      </div>
      {tab === 'models' && <div className="settings-footer"><button className="secondary-button" disabled={testing} onClick={testConnection}>{testing && <LoaderCircle className="spin" size={15} />}{t('test')}</button><button className="save-button" onClick={save}>{t('save')}</button></div>}
    </section>
  </div>
}
