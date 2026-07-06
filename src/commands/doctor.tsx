import type { Command } from 'commander'

import {
  applyStrict,
  doctorExitCode,
  gatherContext,
  runDoctor,
  summarize,
  toJsonResults,
  type CheckResult,
} from '../lib/doctor.js'
import { outputMode, printJson, printPlainRows, renderStatic } from '../lib/output.js'
import { globalFlags } from './shared.js'

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('run preflight checks and suggest a fix for anything the CLI needs')
    .option('--strict', 'treat warnings as failures (exit 1)')
    .action(async (opts: { strict?: boolean }, cmd: Command) => {
      const flags = globalFlags(cmd)
      // Resolve tolerantly (never throws on a corrupt config) so every other
      // check still runs and the report is complete.
      const ctx = await gatherContext({ context: flags.context, apiUrl: flags.apiUrl })
      const results = applyStrict(await runDoctor({ ctx }), Boolean(opts.strict))
      const mode = outputMode(flags)

      if (mode === 'json') {
        printJson(toJsonResults(results))
      } else if (mode === 'plain') {
        printPlainRows(results.map((r) => [r.name, r.status, r.message]))
      } else {
        await renderReport(results)
      }

      // The report is the primary output; set the exit code directly so stdout
      // stays clean and no extra error line is printed on failures.
      process.exitCode = doctorExitCode(results)
    })
}

// renderReport paints the coral DOCTOR panel. Ink is imported lazily (only in
// the TTY path) so it never enters the CLI's cold-start module graph.
async function renderReport(results: CheckResult[]): Promise<void> {
  const { DoctorReport } = await import('../ui/DoctorReport.js')
  const s = summarize(results)
  const subtitle =
    `${s.fail} failed, ${s.warn} warned, ${s.pass} ok` + (s.skip ? `, ${s.skip} skipped` : '')
  await renderStatic(<DoctorReport results={results} subtitle={subtitle} />)
}
