const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('readingAssistant', {
  selectSkillFolder: () => ipcRenderer.invoke('reading-assistant:select-skill-folder'),
  selectLanguageFolder: () => ipcRenderer.invoke('reading-assistant:select-language-folder'),
  convertDocument: (payload) => ipcRenderer.invoke('reading-assistant:convert-document', payload),
  listProjects: () => ipcRenderer.invoke('reading-assistant:list-projects'),
  getProject: (id, lightweight = false, indexFileId = null) => ipcRenderer.invoke('reading-assistant:get-project', id, lightweight, indexFileId),
  retrieveProjectContext: (id, query, options) => ipcRenderer.invoke('reading-assistant:retrieve-project-context', id, query, options),
  saveProject: (project) => ipcRenderer.invoke('reading-assistant:save-project', project),
  getProjectFileSource: (projectId, fileId) => ipcRenderer.invoke('reading-assistant:get-project-file-source', projectId, fileId),
  saveProjectFileSource: (payload) => ipcRenderer.invoke('reading-assistant:save-project-file-source', payload),
  deleteProject: (id) => ipcRenderer.invoke('reading-assistant:delete-project', id),
  deleteProjectFile: (projectId, fileId) => ipcRenderer.invoke('reading-assistant:delete-project-file', projectId, fileId),
  openExternal: (url) => ipcRenderer.invoke('reading-assistant:open-external', url),
  checkForUpdates: (force = false) => ipcRenderer.invoke('reading-assistant:check-for-updates', force),
  storeGeneratedImage: (payload) => ipcRenderer.invoke('reading-assistant:store-generated-image', payload),
  storeSelectionImage: (payload) => ipcRenderer.invoke('reading-assistant:store-selection-image', payload),
  readSelectionImage: (id, thumbnail = false) => ipcRenderer.invoke('reading-assistant:read-selection-image', id, thumbnail),
  deleteSelectionImages: (ids) => ipcRenderer.invoke('reading-assistant:delete-selection-images', ids),
  retainSelectionImages: (items) => ipcRenderer.invoke('reading-assistant:retain-selection-images', items),
  deleteStoredSelectionImages: (ids) => ipcRenderer.invoke('reading-assistant:delete-stored-selection-images', ids),
  takePendingOpenFiles: () => ipcRenderer.invoke('reading-assistant:take-pending-open-files'),
  onOpenFile: (listener) => {
    const wrapped = (_event, file) => listener(file)
    ipcRenderer.on('reading-assistant:open-file', wrapped)
    return () => ipcRenderer.removeListener('reading-assistant:open-file', wrapped)
  },
  movePanelWindow: (id, x, y) => ipcRenderer.send('reading-assistant:move-panel-window', { id, x, y }),
  setPanelOnTop: (active) => ipcRenderer.invoke('reading-assistant:set-panel-on-top', active),
  preparePanelDrag: () => ipcRenderer.send('reading-assistant:prepare-panel-drag'),
  setPanelDragging: (active) => ipcRenderer.send('reading-assistant:set-panel-dragging', { active }),
  setDockZones: (visible, active, dark) => ipcRenderer.send('reading-assistant:set-dock-zones', { visible, active, dark }),
})
