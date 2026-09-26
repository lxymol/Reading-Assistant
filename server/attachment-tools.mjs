import fs from 'node:fs'
import path from 'node:path'

const tool = (name, description, properties, required) => ({ type: 'function', name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } })
export const attachmentTools = [
  tool('read_attachment', 'Read complete attached document text in byte ranges. Continue with nextOffset until eof; files are not truncated.', { id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 32768 } }, ['id']),
  tool('search_attachments', 'Search a literal phrase in all complete attached documents. Returns matching byte offsets and snippets for further reading.', { query: { type: 'string', minLength: 1, maxLength: 200 } }, ['query']),
  tool('create_text_file', 'Create a requested UTF-8 text file in Raid. The file will appear in the file pane.', { name: { type: 'string' }, content: { type: 'string' } }, ['name', 'content']),
]

export function createAttachmentHandler(documents, workdir, captureFiles) {
  const allowed = new Map(documents.map((document, index) => [document.id || String(index + 1), document]))
  const generated = new Map()
  return async (name, args) => {
    if (!args || typeof args !== 'object') throw new Error('Invalid tool arguments')
    if (name === 'read_attachment') {
      const document = allowed.get(args.id)
      if (!document) throw new Error('Unknown attachment ID; arbitrary file paths are not allowed')
      const offset = args.offset ?? 0
      const limit = args.limit ?? 32768
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 32768) throw new Error('Invalid byte range')
      const buffer = Buffer.alloc(limit + 4)
      const descriptor = fs.openSync(document.path, 'r')
      let length
      try { length = fs.readSync(descriptor, buffer, 0, buffer.length, offset) } finally { fs.closeSync(descriptor) }
      let start = 0
      while (start < length && (buffer[start] & 0xc0) === 0x80) start += 1
      let end = Math.min(limit, length)
      while (end < length && (buffer[end] & 0xc0) === 0x80) end += 1
      const nextOffset = offset + end
      return { name: document.name, text: buffer.subarray(start, end).toString('utf8'), nextOffset, eof: nextOffset >= document.byteLength }
    }
    if (name === 'search_attachments') {
      if (typeof args.query !== 'string' || !args.query.length || args.query.length > 200) throw new Error('Invalid search phrase')
      const query = Buffer.from(args.query)
      const hits = []
      for (const [id, document] of allowed) {
        let tail = Buffer.alloc(0)
        let offset = 0
        for await (const chunk of fs.createReadStream(document.path, { highWaterMark: 32768 })) {
          const data = Buffer.concat([tail, chunk])
          for (let match = data.indexOf(query); match >= 0; match = data.indexOf(query, match + query.length)) {
            hits.push({ id, name: document.name, offset: offset - tail.length + match, snippet: data.subarray(Math.max(0, match - 100), Math.min(data.length, match + query.length + 200)).toString('utf8') })
            if (hits.length >= 20) return { hits, moreMatchesPossible: true }
          }
          offset += chunk.length
          tail = data.subarray(Math.max(0, data.length - query.length + 1))
        }
      }
      return { hits, moreMatchesPossible: false }
    }
    if (name === 'create_text_file') {
      if (!captureFiles) throw new Error('The user has not requested an output file')
      const filename = String(args.name || '')
      const content = String(args.content || '')
      if (!filename || filename.length > 160 || /[<>:"/\\|?*\x00-\x1f]|^\.|[. ]$/.test(filename) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)) throw new Error('A plain filename is required; directory paths are not allowed')
      const bytes = Buffer.byteLength(content)
      if (!bytes || bytes > 1024 * 1024 || generated.size >= 12 || [...generated.values()].reduce((sum, size) => sum + size, 0) + bytes > 12 * 1024 * 1024) throw new Error('Generated files exceed the memory budget')
      fs.writeFileSync(path.join(workdir, filename), content, 'utf8')
      generated.set(filename, bytes)
      return { name: filename, saved: true }
    }
    throw new Error('This tool is not available in Raid')
  }
}
