import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporaryRoot = path.join(root, 'node_modules', '.tmp')
mkdirSync(temporaryRoot, { recursive: true })
const directory = mkdtempSync(path.join(temporaryRoot, 'raid-memory-'))

function makePdf(pageCount) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '']
  const kids = []
  for (let index = 0; index < pageCount; index += 1) {
    kids.push(`${objects.length + 1} 0 R`)
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>')
  }
  objects[1] = `<< /Type /Pages /Count ${pageCount} /Kids [${kids.join(' ')}] >>`
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((body, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return pdf
}

const pdfPath = path.join(directory, 'memory-test.pdf')
writeFileSync(pdfPath, makePdf(120))
const environment = { ...process.env, RAID_MEMORY_SMOKE_DIR: path.join(directory, 'profile') }
delete environment.ELECTRON_RUN_AS_NODE
let output = ''
try {
  const child = spawn(electronPath, [root, '--memory-smoke', pdfPath], { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const timeout = setTimeout(() => child.kill(), 90_000)
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (data) => { output += data; process.stdout.write(data) })
  child.stderr.on('data', (data) => process.stderr.write(data))
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  clearTimeout(timeout)
  const metrics = output.split(/\r?\n/).filter((line) => line.startsWith('RAID_MEMORY_METRIC ')).map((line) => JSON.parse(line.slice('RAID_MEMORY_METRIC '.length)))
  if (code !== 0 || output.includes('RAID_MEMORY_ERROR ') || metrics.length !== 9) throw new Error('Desktop memory smoke test did not complete')
  const reading = metrics.filter((item) => item.phase === 'opened' || item.phase.startsWith('scroll-'))
  const maximum = Math.max(...reading.map((item) => item.totalMb))
  if (maximum >= 500) throw new Error(`Raid exceeded 500 MB while reading the 120-page PDF: ${maximum} MB`)
  const growth = reading.at(-1).totalPrivateMb - reading[1].totalPrivateMb
  if (growth > 40) throw new Error(`Raid continued growing after repeated scrolling: +${growth} MB private memory`)
  const privateMaximum = Math.max(...metrics.map((item) => item.totalPrivateMb))
  if (privateMaximum >= 500) throw new Error(`Raid and Codex exceeded 500 MB of private committed memory: ${privateMaximum} MB`)
  console.log(`RAID_MEMORY_PASS readingWorkingSetMaximum=${maximum} MB steadyPrivateGrowth=${growth} MB privateMaximumIncludingCodex=${privateMaximum} MB host=${os.platform()}`)
  console.log(`RAID_SHARED_WORKING_SET_NOTE codexActiveSum=${metrics.find((item) => item.phase === 'codex-running').totalMb} MB includes shared pages counted once for every process`)
} finally {
  const resolved = path.resolve(directory)
  if (!resolved.startsWith(`${path.resolve(temporaryRoot)}${path.sep}`)) throw new Error('Unsafe memory-test cleanup target')
  rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
