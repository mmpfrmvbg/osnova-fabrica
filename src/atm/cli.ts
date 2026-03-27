#!/usr/bin/env node
import { runAtmCommand } from './atm'

const args = process.argv.slice(2)

// Поддержка флага --yaml для чистого вывода без якорей
if (args.includes('--yaml') || args.includes('-y')) {
  const idx = args.indexOf('--yaml')
  if (idx !== -1) args.splice(idx, 1)
  const idx2 = args.indexOf('-y')
  if (idx2 !== -1) args.splice(idx2, 1)
  process.env.ATM_YAML_CLEAN = '1'
}

runAtmCommand(args)
