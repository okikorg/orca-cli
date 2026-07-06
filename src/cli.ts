import { Command, CommanderError } from 'commander'

import { registerAgents } from './commands/agents.js'
import { registerAuth } from './commands/auth.js'
import { registerBilling } from './commands/billing.js'
import { registerChat } from './commands/chat.js'
import { registerContext } from './commands/context.js'
import { registerDoctor } from './commands/doctor.js'
import { registerKeys } from './commands/keys.js'
import { registerMcp } from './commands/mcp.js'
import { registerMemory } from './commands/memory.js'
import { registerPlatform } from './commands/platform.js'
import { registerPools } from './commands/pools.js'
import { registerRuns } from './commands/runs.js'
import { registerSecrets } from './commands/secrets.js'
import { registerSessions } from './commands/sessions.js'
import { registerSkills } from './commands/skills.js'
import { registerStats } from './commands/stats.js'
import { registerStorage } from './commands/storage.js'
import { registerUsage } from './commands/usage.js'
import { registerWorkflows } from './commands/workflows.js'
import { CliError, ExitCode } from './lib/errors.js'
import { bannerString } from './ui/banner.js'
import { ansi, paint } from './ui/theme.js'
import { VERSION } from './version.js'

const program = new Command()

program
  .name('orca')
  .description('Manage agents, runs, and publishing on the Orca platform')
  .version(VERSION, '-v, --version')
  .option('--context <name>', 'use a named context from the config file')
  .option('--api-url <url>', 'override the conductor API base URL')
  .option('--json', 'machine-readable JSON output')
  .exitOverride()

// The ASCII wordmark heads the top-level help only (not every subcommand).
program.addHelpText('beforeAll', (ctx) => (ctx.command === program ? bannerString() : ''))

registerAuth(program)
registerContext(program)
registerDoctor(program)
registerAgents(program)
registerPools(program)
registerRuns(program)
registerKeys(program)
registerChat(program)
registerMcp(program)
registerSecrets(program)
registerSkills(program)
registerSessions(program)
registerStorage(program)
registerMemory(program)
registerStats(program)
registerBilling(program)
registerUsage(program)
registerWorkflows(program)
registerPlatform(program)

async function main(): Promise<void> {
  try {
    // Bare `orca` (no subcommand) greets with the banner + command list (the
    // banner is prepended by the beforeAll help hook), rather than
    // commander's terse usage line.
    if (process.argv.length <= 2) {
      program.outputHelp()
      return
    }
    await program.parseAsync()
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help/version output already happened; usage errors already printed
      // to stderr by commander. Map them onto the exit-code contract.
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version' || err.code === 'commander.help') {
        process.exitCode = 0
        return
      }
      process.exitCode = ExitCode.Usage
      return
    }
    if (err instanceof CliError) {
      console.error(paint(`orca: ${err.message}`, ansi.destructive))
      for (const line of err.detail ?? []) console.error(paint(`  ${line}`, ansi.subtle))
      process.exitCode = err.exitCode
      return
    }
    console.error(paint(`orca: ${err instanceof Error ? err.message : String(err)}`, ansi.destructive))
    process.exitCode = ExitCode.Failure
  }
}

void main()
