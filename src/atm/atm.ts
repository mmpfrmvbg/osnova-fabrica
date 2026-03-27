import * as fs from 'fs'
import * as path from 'path'
import YAML from 'js-yaml'

interface AtmTask {
  id: string
  epic: string
  seq: number
  zone: string
  risk: 'LOW' | 'MEDIUM' | 'HIGH'
  executor: string
  goal: string
  scope: string[]
  notouch: string[]
  done: string
  steps: string[]
  deps: string[]
  maxiter: number
  retries: number
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED'
  priority: 'P0' | 'P1' | 'P2' | 'P3'
}

interface AtmReport {
  version: string
  generated_at: string
  epic: string
  summary: {
    total_tasks: number
    by_status: Record<string, number>
    by_zone: Record<string, number>
    by_risk: Record<string, number>
    by_priority: Record<string, number>
  }
  tasks: AtmTask[]
  deps_graph: Record<string, string[]>
  critical_path: string[]
  recommendations: string[]
}

export function loadAtmFile(filePath: string): AtmTask {
  const content = fs.readFileSync(filePath, 'utf-8')
  const data = YAML.load(content) as AtmTask
  return data
}

export function scanAtmDirectory(dirPath: string): AtmTask[] {
  const tasks: AtmTask[] = []
  
  if (!fs.existsSync(dirPath)) {
    return tasks
  }

  const files = fs.readdirSync(dirPath)
  for (const file of files) {
    if (file.startsWith('ATM-') && file.endsWith('.yaml')) {
      const fullPath = path.join(dirPath, file)
      try {
        const task = loadAtmFile(fullPath)
        tasks.push(task)
      } catch (e) {
        console.error(`Failed to load ${fullPath}:`, e)
      }
    }
  }

  return tasks
}

export function generateAtmReport(epicDir: string): AtmReport {
  const tasks = scanAtmDirectory(epicDir)
  
  // Определяем epic из первого файла
  const epic = tasks.length > 0 ? tasks[0].epic : 'UNKNOWN'
  
  // Считаем статистику
  const byStatus: Record<string, number> = {}
  const byZone: Record<string, number> = {}
  const byRisk: Record<string, number> = {}
  const byPriority: Record<string, number> = {}
  
  for (const task of tasks) {
    byStatus[task.status] = (byStatus[task.status] || 0) + 1
    byZone[task.zone] = (byZone[task.zone] || 0) + 1
    byRisk[task.risk] = (byRisk[task.risk] || 0) + 1
    byPriority[task.priority] = (byPriority[task.priority] || 0) + 1
  }

  // Строим граф зависимостей
  const depsGraph: Record<string, string[]> = {}
  const taskMap = new Map<string, AtmTask>()
  
  for (const task of tasks) {
    taskMap.set(task.id, task)
    depsGraph[task.id] = task.deps
  }

  // Находим критический путь (топологическая сортировка + longest path)
  const criticalPath = findCriticalPath(tasks, depsGraph)

  // Генерируем рекомендации
  const recommendations = generateRecommendations(tasks, byStatus, byRisk)

  return {
    version: '0.1.0',
    generated_at: new Date().toISOString(),
    epic,
    summary: {
      total_tasks: tasks.length,
      by_status: byStatus,
      by_zone: byZone,
      by_risk: byRisk,
      by_priority: byPriority
    },
    tasks: tasks.sort((a, b) => a.seq - b.seq),
    deps_graph: depsGraph,
    critical_path: criticalPath,
    recommendations
  }
}

function findCriticalPath(tasks: AtmTask[], depsGraph: Record<string, string[]>): string[] {
  // Топологическая сортировка и поиск longest path
  const taskMap = new Map(tasks.map(t => [t.id, t]))
  const inDegree = new Map<string, number>()
  const adjList = new Map<string, string[]>()

  // Инициализация
  for (const task of tasks) {
    inDegree.set(task.id, 0)
    adjList.set(task.id, [])
  }

  // Строим обратный граф и считаем in-degree
  for (const [taskId, deps] of Object.entries(depsGraph)) {
    for (const dep of deps) {
      if (adjList.has(dep)) {
        adjList.get(dep)!.push(taskId)
        inDegree.set(taskId, (inDegree.get(taskId) || 0) + 1)
      }
    }
  }

  // BFS для longest path
  const dist = new Map<string, number>()
  const parent = new Map<string, string | null>()
  
  for (const task of tasks) {
    dist.set(task.id, 1)
    parent.set(task.id, null)
  }

  // Kahn's algorithm с tracking longest path
  const queue: string[] = []
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id)
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!
    const neighbors = adjList.get(current) || []
    
    for (const next of neighbors) {
      if (dist.get(next)! < dist.get(current)! + 1) {
        dist.set(next, dist.get(current)! + 1)
        parent.set(next, current)
      }
      
      inDegree.set(next, inDegree.get(next)! - 1)
      if (inDegree.get(next) === 0) {
        queue.push(next)
      }
    }
  }

  // Находим конечную точку longest path
  let maxDist = 0
  let endNode: string | null = null
  for (const [id, d] of dist) {
    if (d > maxDist) {
      maxDist = d
      endNode = id
    }
  }

  // Восстанавливаем путь
  const path: string[] = []
  let current: string | null = endNode
  while (current !== null) {
    path.unshift(current)
    current = parent.get(current) || null
  }

  return path
}

function generateRecommendations(tasks: AtmTask[], byStatus: Record<string, number>, byRisk: Record<string, number>): string[] {
  const recommendations: string[] = []
  
  const pending = byStatus['PENDING'] || 0
  const highRisk = byRisk['HIGH'] || 0
  const inProgress = byStatus['IN_PROGRESS'] || 0

  if (pending > 0) {
    recommendations.push(`Начать с ${pending} ожидающих задач`)
  }

  if (highRisk > 0) {
    recommendations.push(`Уделить внимание ${highRisk} задачам с HIGH риском`)
  }

  if (inProgress === 0 && pending > 0) {
    recommendations.push('Нет активных задач — рекомендуется начать выполнение')
  }

  // Проверяем задачи без цели
  const noGoalTasks = tasks.filter(t => !t.goal || t.goal.trim() === '')
  if (noGoalTasks.length > 0) {
    recommendations.push(`Заполнить goal для ${noGoalTasks.length} задач: ${noGoalTasks.map(t => t.id).join(', ')}`)
  }

  // Проверяем задачи без шагов
  const noStepsTasks = tasks.filter(t => t.steps.length === 0)
  if (noStepsTasks.length > 0) {
    recommendations.push(`Добавить шаги для ${noStepsTasks.length} задач: ${noStepsTasks.map(t => t.id).join(', ')}`)
  }

  return recommendations
}

export function runAtmCommand(args: string[]): void {
  const command = args[0]
  
  switch (command) {
    case 'report': {
      const epicDir = args[1] || '.osnova/epics/EPK-260327-001'
      const report = generateAtmReport(epicDir)
      console.log(YAML.dump(report))
      break
    }
    
    case 'list': {
      const epicDir = args[1] || '.osnova/epics/EPK-260327-001'
      const tasks = scanAtmDirectory(epicDir)
      for (const task of tasks) {
        console.log(`${task.id}: ${task.goal || '(нет цели)'} [${task.status}]`)
      }
      break
    }
    
    case 'status': {
      const taskId = args[1]
      const epicDir = args[2] || '.osnova/epics/EPK-260327-001'
      const tasks = scanAtmDirectory(epicDir)
      const task = tasks.find(t => t.id === taskId)
      
      if (!task) {
        console.error(`Task ${taskId} not found`)
        process.exit(1)
      }
      
      console.log(YAML.dump(task))
      break
    }
    
    default:
      console.error('Unknown command. Usage:')
      console.log('  atm report [epic-dir]  — сгенерировать отчет')
      console.log('  atm list [epic-dir]    — список задач')
      console.log('  atm status <id> [dir]  — статус задачи')
      process.exit(1)
  }
}

// CLI entry point
if (require.main === module) {
  runAtmCommand(process.argv.slice(2))
}
