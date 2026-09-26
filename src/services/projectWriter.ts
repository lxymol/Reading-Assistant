import type { DocumentParagraph, Project, RuntimeProjectFile } from '../types'

type SavedIndex = { paragraphs: WeakRef<DocumentParagraph[]>; state: string }

// React project snapshots are immutable. Remember only weak references to indexes
// that the storage worker has acknowledged, never keeping inactive PDFs alive.
export class ProjectWriter {
  private pending = new Map<string, Promise<unknown>>()
  private indexes = new Map<string, Map<string, SavedIndex>>()

  constructor(private write: (project: Project) => Promise<boolean>) {}

  private enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(id)
    const task = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(operation)
    this.pending.set(id, task)
    const release = () => { if (this.pending.get(id) === task) this.pending.delete(id) }
    void task.then(release, release)
    return task
  }

  async flush(id?: string) {
    if (id) await this.pending.get(id)
    else await Promise.all(this.pending.values())
  }

  save(project: Project) {
    return this.enqueue(project.id, async () => {
      const saved = this.indexes.get(project.id)
      const files = project.files.map((file) => {
        const previous = saved?.get(file.id)
        return previous?.paragraphs.deref() === file.paragraphs && previous.state === JSON.stringify(file.indexState)
          ? { ...file, paragraphs: [], indexLoaded: false } : file
      })
      const result = await this.write({ ...project, files })
      if (!result) throw new Error('项目保存未完成。')
      const next = new Map<string, SavedIndex>()
      for (const file of project.files as RuntimeProjectFile[]) {
        if (file.indexLoaded !== false) next.set(file.id, { paragraphs: new WeakRef(file.paragraphs), state: JSON.stringify(file.indexState) })
        else if (saved?.has(file.id)) next.set(file.id, saved.get(file.id)!)
      }
      this.indexes.delete(project.id)
      this.indexes.set(project.id, next)
      // This cache is an optimization; eviction simply sends the next full index.
      if (this.indexes.size > 32) this.indexes.delete(this.indexes.keys().next().value!)
      return result
    })
  }

  remove<T>(id: string, operation: () => Promise<T>) {
    return this.enqueue(id, async () => {
      this.indexes.delete(id)
      return operation()
    })
  }
}
