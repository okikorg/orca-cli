import { CliError, ExitCode } from './errors.js'

// The conductor's look-back window is a positive integer followed by a unit:
// m (minutes), h (hours), d (days), or w (weeks). The CLI surfaces 1h/24h/7d/30d
// as the common choices, and `orca usage --days N` produces `Nd`. We validate
// the shape client-side so a typo fails fast with exit 2 and a clear message,
// matching how --meter/--transport/--visibility/--type are checked before any
// network call. The unit set is deliberately permissive (a superset of what the
// docs advertise) so we never reject a value the server would have accepted.
const WINDOW_RE = /^(\d+)([mhdw])$/

export function assertWindow(w: string): string {
  const m = WINDOW_RE.exec(w)
  if (!m) {
    throw new CliError(
      `invalid --window "${w}"; expected a number followed by m, h, d, or w (e.g. 1h, 24h, 7d, 30d)`,
      ExitCode.Usage,
    )
  }
  if (Number(m[1]) <= 0) {
    throw new CliError(`invalid --window "${w}"; the amount must be greater than zero`, ExitCode.Usage)
  }
  return w
}
