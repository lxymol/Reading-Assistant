import { ChevronDown, ChevronUp, FilePlus2, FileText, FolderPlus, LoaderCircle, MessageSquareText, Plus, StickyNote, Trash2, X } from 'lucide-react'
import { useState } from 'react'

type Project = { id: string; name: string; busy: boolean; files: Array<{ id: string; name: string; indexStatus: string }> }
type Conversation = { id: string; title: string }

type Props = {
  projects: Project[]; activeProjectId: string | null; activeFileId: string | null; activeConversationId: string
  conversations: Conversation[]; collapsedProjectIds: ReadonlySet<string>
  onCreateProject: (name: string) => void; onOpenProject: (id: string) => void; onAddFile: (projectId: string, file: File) => Promise<void> | void
  onOpenFile: (projectId: string, fileId: string) => void; onDeleteFile: (projectId: string, fileId: string) => void; onDeleteProject: (id: string) => void
  onCreateConversation: (projectId: string) => void; onOpenNotes: (projectId: string) => void; onToggleProject: (projectId: string) => void
  onOpenConversation: (conversationId: string) => void; onDeleteConversation: (conversationId: string) => void
}

export default function ProjectExplorer(props: Props) {
  const [newProjectName, setNewProjectName] = useState<string | null>(null)
  const createProject = () => {
    const name = newProjectName?.trim()
    if (!name) return
    props.onCreateProject(name)
    setNewProjectName(null)
  }
  return <div className="project-explorer">
    <div className="project-explorer-header"><span>项目与文件</span><button type="button" onClick={() => setNewProjectName((value) => value === null ? '' : null)} title="新建空项目"><FolderPlus size={14} /></button></div>
    {newProjectName !== null && <div className="new-project-row"><input autoFocus value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') createProject(); if (event.key === 'Escape') setNewProjectName(null) }} placeholder="项目名称" /><button type="button" disabled={!newProjectName.trim()} onClick={createProject}>创建</button><button type="button" onClick={() => setNewProjectName(null)} title="取消"><X size={12} /></button></div>}
    {props.projects.map((project) => {
      const active = project.id === props.activeProjectId
      const expanded = active && !props.collapsedProjectIds.has(project.id)
      return <section className={`project-item ${active ? 'active' : ''}`} key={project.id}>
        <button className="project-title" onClick={() => props.onOpenProject(project.id)}>
          {project.busy ? <LoaderCircle className="spin" size={14} /> : <FileText size={14} />}
          <span>{project.name}</span>
          <label title="添加文件" onClick={(event) => event.stopPropagation()}><FilePlus2 size={13} /><input hidden type="file" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void props.onAddFile(project.id, file) }} /></label>
          <i onClick={(event) => { event.stopPropagation(); props.onCreateConversation(project.id) }} title="新对话"><Plus size={13} /></i>
          <i onClick={(event) => { event.stopPropagation(); props.onOpenNotes(project.id) }} title="打开项目笔记"><StickyNote size={13} /></i>
          <i onClick={(event) => { event.stopPropagation(); props.onDeleteProject(project.id) }} title="删除项目"><Trash2 size={13} /></i>
          <i onClick={(event) => { event.stopPropagation(); props.onToggleProject(project.id) }} title={expanded ? '收起' : '展开'}>{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</i>
        </button>
        {expanded && <>
          <div className="project-files">{project.files.map((file) => <button key={file.id} className={file.id === props.activeFileId ? 'active' : ''} onClick={() => props.onOpenFile(project.id, file.id)}>
            {file.indexStatus === 'indexing' ? <LoaderCircle className="spin" size={12} /> : <FileText size={12} />}<span>{file.name}</span><i onClick={(event) => { event.stopPropagation(); props.onDeleteFile(project.id, file.id) }}><X size={11} /></i>
          </button>)}</div>
          <div className="project-conversations">{props.conversations.map((conversation) => <button key={conversation.id} className={conversation.id === props.activeConversationId ? 'active' : ''} onClick={() => props.onOpenConversation(conversation.id)}>
            <MessageSquareText size={12} /><span>{conversation.title}</span><i onClick={(event) => { event.stopPropagation(); props.onDeleteConversation(conversation.id) }}><X size={11} /></i>
          </button>)}</div>
        </>}
      </section>
    })}
  </div>
}
