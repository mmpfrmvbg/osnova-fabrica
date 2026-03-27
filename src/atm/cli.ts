#!/usr/bin/env node
import { runAtmCommand } from './atm'

runAtmCommand(process.argv.slice(2))
