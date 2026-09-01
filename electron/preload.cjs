const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('readingAssistant', {
  selectSkillFolder: () => ipcRenderer.invoke('reading-assistant:select-skill-folder'),
  selectLanguageFolder: () => ipcRenderer.invoke('reading-assistant:select-language-folder'),
  convertDocument: (payload) => ipcRenderer.invoke('reading-assistant:convert-document', payload),
  listProjectMemories: () => ipcRenderer.invoke('reading-assistant:list-project-memories'),
  getProjectMemory: (id) => ipcRenderer.invoke('reading-assistant:get-project-memory', id),
  saveProjectMemory: (record) => ipcRenderer.invoke('reading-assistant:save-project-memory', record),
  deleteProjectMemory: (id) => ipcRenderer.invoke('reading-assistant:delete-project-memory', id),
  listProjectMemorySummaries: () => ipcRenderer.invoke('reading-assistant:list-project-memory-summaries'),
  getProjectMigrationStatus: () => ipcRenderer.invoke('reading-assistant:get-project-migration-status'),
  completeProjectMigration: () => ipcRenderer.invoke('reading-assistant:complete-project-migration'),
  openExternal: (url) => ipcRenderer.invoke('reading-assistant:open-external', url),
  movePanelWindow: (id, x, y) => ipcRenderer.send('reading-assistant:move-panel-window', { id, x, y }),
  preparePanelDrag: () => ipcRenderer.send('reading-assistant:prepare-panel-drag'),
  setPanelDragging: (active) => ipcRenderer.send('reading-assistant:set-panel-dragging', { active }),
  setDockZones: (visible, active, dark) => ipcRenderer.send('reading-assistant:set-dock-zones', { visible, active, dark }),
})
