// Exit code contract, documented in the README. stdout stays machine-clean;
// all error text goes to stderr.
export const ExitCode = {
  Ok: 0,
  // API/network failure, or a tailed run that finished error/cancelled/interrupted.
  Failure: 1,
  // Bad usage: missing args in non-interactive mode, validation failure.
  Usage: 2,
  // 401/403, no API key configured.
  Auth: 3,
  // 404 on a named resource.
  NotFound: 4,
  Interrupt: 130,
} as const

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode]

// CliError is the only error commands throw for expected failures.
// cli.ts owns the single process.exitCode assignment.
export class CliError extends Error {
  exitCode: ExitCodeValue
  // Extra lines printed to stderr after the message (hints, field errors).
  detail?: string[]
  constructor(message: string, exitCode: ExitCodeValue = ExitCode.Failure, detail?: string[]) {
    super(message)
    this.exitCode = exitCode
    this.detail = detail
  }
}
