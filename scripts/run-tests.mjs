import { rmSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'node_modules', '.tmp', 'raid-tests')
rmSync(output, { recursive: true, force: true })

const sources = [
  'tests/core.test.ts', 'src/services/navigationService.ts', 'src/services/retrievalService.ts',
  'src/services/citationService.ts', 'src/services/tagStore.ts', 'src/services/layoutAnalyzer.ts',
]
const compiler = spawnSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), ...sources, '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--rewriteRelativeImportExtensions', '--outDir', output, '--types', 'node', '--skipLibCheck', '--esModuleInterop'], { cwd: root, stdio: 'inherit' })
if (compiler.status !== 0) process.exit(compiler.status || 1)

const testFile = path.join(output, 'tests', 'core.test.js')
const runner = spawnSync(process.execPath, ['--test', testFile], { cwd: root, stdio: 'inherit' })
process.exit(runner.status || 0)
