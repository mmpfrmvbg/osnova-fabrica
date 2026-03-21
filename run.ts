import { run_patch_agent } from './src/patch-agent/index'
import * as fs from 'fs'

const [,, task, ...paths] = process.argv

if (!task) {
  console.error('Usage: npx ts-node run.ts "task" path1 path2 ...')
  process.exit(1)
}

run_patch_agent({
  task,
  allowed_paths: paths.length ? paths : [],
  forbidden_paths: [],
  context_files: [],
  acceptance_criteria: [],
  max_files_changed: 5,
  must_run_before_commit: []
}).then(r => {
  console.log('OK:', r.commitSha)
}).catch(e => {
  fs.writeFileSync('last-diff.txt', e.message)
  console.error('ERR:', e.message.slice(0, 300))
  process.exit(1)
})
