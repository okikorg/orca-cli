import type { Command } from 'commander'

import { hintText } from '../ui/theme.js'
import { globalFlags } from './shared.js'

export function registerMcp(program: Command): void {
  const mcp = program.command('mcp').description('run Orca as an MCP server for coding agents')

  // Orca AS an MCP server for the coding agent driving this CLI, with one
  // tool per CLI action. Wired up with: claude mcp add orca -- orca mcp serve
  mcp
    .command('serve')
    .description('run the Orca MCP server on stdio (for coding agents)')
    .action(async (_opts: Record<string, never>, cmd: Command) => {
      const flags = globalFlags(cmd)
      // stdio discipline: stdout belongs to JSON-RPC from here on. Ink is
      // never mounted on this path; diagnostics go to stderr only.
      const [{ buildMcpServer, makeClientSource }, { StdioServerTransport }] = await Promise.all([
        import('../mcp/server.js'),
        import('@modelcontextprotocol/sdk/server/stdio.js'),
      ])
      const server = buildMcpServer(makeClientSource(flags))
      const transport = new StdioServerTransport()
      await server.connect(transport)
      console.error(hintText('orca mcp server listening on stdio'))
      // Stay alive until the client hangs up (stdin EOF), then exit cleanly.
      await new Promise<void>((resolve) => {
        process.stdin.on('end', resolve)
        process.stdin.on('close', resolve)
      })
    })
}
