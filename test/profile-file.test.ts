import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { loadProfileFile } from '../src/lib/profile-file.js'
import { CliError, ExitCode } from '../src/lib/errors.js'

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

describe('loadProfileFile', () => {
  it('parses a full YAML agent into the JSON profile shape', async () => {
    const { profile, warnings } = await loadProfileFile(path.join(fixtures, 'agent.yaml'))
    expect(warnings).toEqual([])
    expect(profile).toEqual({
      name: 'support-bot',
      runtime: 'claude',
      model: 'claude-sonnet-5',
      systemPrompt: 'You answer support questions about Orca.',
      skills: ['orca-docs'],
      tools: ['@orchestration'],
      mcpServers: [{ name: 'docs', transport: 'http', url: 'https://mcp.example.com/docs' }],
      fs: { read: ['/agents/self'] },
      sandbox: { provider: 'e2b', resources: { cpu: 2, memoryMB: 1024 } },
    })
  })

  it('surfaces unknown keys as warnings, not errors', async () => {
    const { profile, warnings } = await loadProfileFile(path.join(fixtures, 'agent-warn.yaml'))
    expect(profile.name).toBe('typo-bot')
    expect(warnings.some((w) => w.includes('model_name'))).toBe(true)
  })

  it('promotes warnings to errors with strict', async () => {
    await expect(
      loadProfileFile(path.join(fixtures, 'agent-warn.yaml'), { strict: true }),
    ).rejects.toMatchObject({ exitCode: ExitCode.Usage })
  })

  it('rejects invalid enums and reserved MCP names with field-level detail', async () => {
    const err = await loadProfileFile(path.join(fixtures, 'agent-bad.yaml')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CliError)
    const detail = (err as CliError).detail ?? []
    expect(detail.some((d) => d.includes('runtime'))).toBe(true)
    expect(detail.some((d) => d.includes('reserved'))).toBe(true)
    expect(detail.some((d) => d.includes('transport'))).toBe(true)
  })

  it('rejects a missing file with a usage error', async () => {
    await expect(loadProfileFile('/nope/missing.yaml')).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
  })
})
