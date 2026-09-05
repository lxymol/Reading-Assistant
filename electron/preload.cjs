const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('readingAssistant', {
  selectSkillFolder: () => ipcRenderer.invoke('reading-assistant:select-skill-folder'),
  selectLanguageFolder: () => ipcRenderer.invoke('reading-assistant:select-language-folder'),
  convertDocument: (payload) => ipcRenderer.invoke('reading-assistant:convert-document', payload),
  listProjects: () => ipcRenderer.invoke('reading-assistant:list-projects'),
  getProject: (id) => ipcRenderer.invoke('reading-assistant:get-project', id),
  saveProject: (project) => ipcRenderer.invoke('reading-assistant:save-project', project),
  getProjectFileSource: (projectId, fileId) => ipcRenderer.invoke('reading-assistant:get-project-file-source', projectId, fileId),
  saveProjectFileSource: (payload) => ipcRenderer.invoke('reading-assistant:save-project-file-source', payload),
  deleteProject: (id) => ipcRenderer.invoke('reading-assistant:delete-project', id),
  deleteProjectFile: (projectId, fileId) => ipcRenderer.invoke('reading-assistant:delete-project-file', projectId, fileId),
  openExternal: (url) => ipcRenderer.invoke('reading-assistant:open-external', url),
  getQuickOpenEnabled: () => ipcRenderer.invoke('reading-assistant:get-quick-open-enabled'),
  setQuickOpenEnabled: (enabled) => ipcRenderer.invoke('reading-assistant:set-quick-open-enabled', enabled),
  checkForUpdates: (force = false) => ipcRenderer.invoke('reading-assistant:check-for-updates', force),
  takePendingOpenFiles: () => ipcRenderer.invoke('reading-assistant:take-pending-open-files'),
  onOpenFile: (listener) => {
    const wrapped = (_event, file) => listener(file)
    ipcRenderer.on('reading-assistant:open-file', wrapped)
    return () => ipcRenderer.removeListener('reading-assistant:open-file', wrapped)
  },
  movePanelWindow: (id, x, y) => ipcRenderer.send('reading-assistant:move-panel-window', { id, x, y }),
  preparePanelDrag: () => ipcRenderer.send('reading-assistant:prepare-panel-drag'),
  setPanelDragging: (active) => ipcRenderer.send('reading-assistant:set-panel-dragging', { active }),
  setDockZones: (visible, active, dark) => ipcRenderer.send('reading-assistant:set-dock-zones', { visible, active, dark }),
})
