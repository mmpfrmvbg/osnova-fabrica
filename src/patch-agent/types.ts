export interface CursorTaskContract {
  task: string
  allowed_paths: string[]
  forbidden_paths: string[]
  context_files: string[]
  acceptance_criteria: string[]
  max_files_changed: number
  must_run_before_commit: string[]
  hints?: string[]
}

export interface PatchResult {
  status: 'success' | 'failure'
  commitSha: string
  diff: string
}