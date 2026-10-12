// Reading everything on stdin, for `-f -`, `echo hi | orca chat`, and a piped
// vault token.

import { fstatSync, readFileSync } from 'node:fs'

// readStdin returns all of stdin as UTF-8. A regular file (a heredoc, or
// `< file`) is read straight from fd 0: in the Bun binary, a file stdin that
// was touched before it is drained (an isTTY check, then an await) has already
// ended, so iterating process.stdin returns nothing. A pipe or anything else is
// drained as a stream, which also works when stdin is not a file at all.
export async function readStdin(): Promise<string> {
  if (stdinIsFile()) return readFileSync(0, 'utf8')
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function stdinIsFile(): boolean {
  try {
    return fstatSync(0).isFile()
  } catch {
    return false
  }
}
