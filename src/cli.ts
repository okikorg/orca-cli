import { existsSync } from 'node:fs'

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
import { registerUpdate } from './commands/update.js'
import { registerUsage } from './commands/usage.js'
import { registerWorkflows } from './commands/workflows.js'
import { configPath } from './lib/config.js'
import { CliError, ExitCode } from './lib/errors.js'
import { notifyIfUpdateAvailable } from './lib/update-check.js'
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

// Command groups for the top-level help. Headings are the uppercase group
// labels the design language prescribes; commander renders each group as a
// section (see configureHelp below). Order here does not decide section order —
// that follows registration order (the order commands land in program.commands)
// — but registration is arranged CORE -> OBSERVE -> MANAGE -> SETUP to match.
const GROUP = {
  CORE: 'CORE',
  OBSERVE: 'OBSERVE',
  MANAGE: 'MANAGE',
  SETUP: 'SETUP',
} as const

// Which group each top-level command belongs to. Commands not listed (and the
// implicit `help` command) fall through to SETUP so no stray "Commands:"
// section is emitted. bundles/apps/topology/ping all come from platform.tsx and
// read as observation surfaces, so they sit in OBSERVE.
const COMMAND_GROUP: Record<string, string> = {
  run: GROUP.CORE,
  chat: GROUP.CORE,
  agents: GROUP.CORE,
  runs: GROUP.CORE,
  stats: GROUP.OBSERVE,
  usage: GROUP.OBSERVE,
  sessions: GROUP.OBSERVE,
  doctor: GROUP.OBSERVE,
  topology: GROUP.OBSERVE,
  ping: GROUP.OBSERVE,
  bundles: GROUP.OBSERVE,
  apps: GROUP.OBSERVE,
  workflows: GROUP.MANAGE,
  pools: GROUP.MANAGE,
  skills: GROUP.MANAGE,
  mcp: GROUP.MANAGE,
  secrets: GROUP.MANAGE,
  storage: GROUP.MANAGE,
  memory: GROUP.MANAGE,
  keys: GROUP.MANAGE,
  billing: GROUP.MANAGE,
  auth: GROUP.SETUP,
  context: GROUP.SETUP,
  update: GROUP.SETUP,
}

// Registration order == section order in the grouped help. Grouped
// CORE -> OBSERVE -> MANAGE -> SETUP so the first command of each group appears
// in that sequence (commander keys section order on first appearance in
// program.commands). registerRuns adds both `runs` and the top-level `run`;
// registerPlatform adds topology/ping/bundles/apps.
registerChat(program)
registerAgents(program)
registerRuns(program)

registerStats(program)
registerUsage(program)
registerSessions(program)
registerDoctor(program)
registerPlatform(program)

registerWorkflows(program)
registerPools(program)
registerSkills(program)
registerMcp(program)
registerSecrets(program)
registerStorage(program)
registerMemory(program)
registerKeys(program)
registerBilling(program)

registerAuth(program)
registerContext(program)
registerUpdate(program)

// The implicit `help` command is added lazily by commander and would otherwise
// form its own stray "Commands:" section. Register it explicitly so it can be
// tagged into SETUP alongside auth/context/update. Same name/args/description
// as commander's default so nothing else changes.
program.addHelpCommand(
  new Command('help')
    .argument('[command]', 'command to show help for')
    .description('display help for command')
    .helpGroup(GROUP.SETUP),
)

// Tag each registered top-level command with its group heading. Done here (not
// in each register fn) so command ownership stays with those files; the group
// taxonomy is a top-level-help concern that lives with the help formatter.
// Anything unlisted (defensive) falls through to SETUP.
for (const cmd of program.commands) {
  cmd.helpGroup(COMMAND_GROUP[cmd.name()] ?? GROUP.SETUP)
}

// Grouped, restyled top-level help (configureHelp overrides apply everywhere,
// but the banner + GET STARTED footer are gated to the root command only). The
// group headings arrive already uppercase; styleTitle renders them subtle. The
// GET STARTED sections' own titles ("Options:", "Global Options:", "Usage:")
// also pass through styleTitle, so they pick up the same subtle-uppercase look.
// Color is gated on colorEnabled() (NO_COLOR / non-TTY stay plain), matching
// every other sink in the CLI; glyphs are never emitted in help text.
program.configureHelp({
  // A subtle, uppercased section heading. Group labels are already uppercase;
  // commander's stock titles ("Usage:", "Options:") get uppercased too for one
  // consistent grammar. Never colored when color is disabled.
  styleTitle: (title) => paint(title.toUpperCase(), ansi.subtle),
  // The command name/term in a section: primary emphasis, bold coral.
  styleSubcommandTerm: (term) => paint(term, ansi.bold + ansi.accent),
  // One-line command summaries: muted secondary text.
  styleSubcommandDescription: (desc) => paint(desc, ansi.muted),
  styleOptionDescription: (desc) => paint(desc, ansi.muted),
  styleArgumentDescription: (desc) => paint(desc, ansi.muted),
})

// The brand banner heads the top-level help only (not every subcommand). On a
// first run — no config file and no ORCA_API_KEY in the environment — a subtle
// "not signed in" note follows the brand line, teaching the very first command.
program.addHelpText('beforeAll', (ctx) => {
  if (ctx.command !== program) return ''
  const banner = bannerString()
  return firstRun() ? `${banner}${paint('not signed in · run orca auth login', ansi.subtle)}\n` : banner
})

// GET STARTED footer on the top-level help only: the two commands a new user
// runs first, in coral. Rendered as its own subtle-uppercase section to match
// the command groups above.
program.addHelpText('afterAll', (ctx) => {
  if (ctx.command !== program) return ''
  const heading = paint('GET STARTED', ansi.subtle)
  const login = paint('orca auth login', ansi.accent)
  const doctor = paint('orca doctor', ansi.accent)
  return `\n${heading}\n  ${login}\n  ${doctor}`
})

// firstRun is true when the user has never signed in: no config file on disk
// and no ORCA_API_KEY override in the environment. Sync (fs.existsSync) so it
// can run inside commander's synchronous help hook; a missing file is the
// common first-run case and existsSync never throws.
function firstRun(): boolean {
  if (process.env.ORCA_API_KEY) return false
  return !existsSync(configPath())
}

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
      if (err.code === 'commander.version') {
        // `-v` printed the version to stdout; append a best-effort "update
        // available" hint on stderr (cached, TTY-only, never throws).
        await notifyIfUpdateAvailable(VERSION)
        process.exitCode = 0
        return
      }
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.help') {
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
