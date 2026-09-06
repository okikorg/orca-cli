import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { loadProfileFile } from '../src/lib/profile-file.js'
import { validateProfile } from '../src/lib/profile-schema.js'
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

  it('accepts pi as a first-class runtime', () => {
    const result = validateProfile({ name: 'pi-agent', runtime: 'pi' })
    expect(result).toMatchObject({
      ok: true,
      warnings: [],
      profile: { name: 'pi-agent', runtime: 'pi' },
    })
  })

  it('normalises the deprecated general runtime to vercel', () => {
    const result = validateProfile({ name: 'legacy-agent', runtime: 'general' })
    expect(result.ok).toBe(true)
    expect(result.profile?.runtime).toBe('vercel')
    expect(result.warnings).toContain('runtime "general" is deprecated; it was imported as "vercel"')
  })

  it('rejects a missing file with a usage error', async () => {
    await expect(loadProfileFile('/nope/missing.yaml')).rejects.toMatchObject({
      exitCode: ExitCode.Usage,
    })
  })

  it('carries worker placement through for a sandbox profile', () => {
    const result = validateProfile({
      name: 'sandboxed',
      runtime: 'marlin',
      model: 'anthropic:claude-sonnet-4-6',
      workerMode: 'sandbox',
      workerSubstrate: ' daytona ',
      workerImage: 'orca-agent-worker-dyn',
    })
    expect(result).toMatchObject({
      ok: true,
      warnings: [],
      profile: {
        workerMode: 'sandbox',
        workerSubstrate: 'daytona',
        workerImage: 'orca-agent-worker-dyn',
      },
    })
  })

  it('drops worker placement on a static profile with a warning, and omits static itself', () => {
    const result = validateProfile({
      name: 'warm',
      runtime: 'vercel',
      workerMode: 'static',
      workerSubstrate: 'e2b',
    })
    expect(result.ok).toBe(true)
    expect(result.profile).not.toHaveProperty('workerMode')
    expect(result.profile).not.toHaveProperty('workerSubstrate')
    expect(result.warnings).toContain(
      'workerSubstrate/workerImage only apply when workerMode is "sandbox"; dropped',
    )
  })

  it('rejects an unknown workerMode and marlin without a sandbox worker', () => {
    const bad = validateProfile({ name: 'x', runtime: 'vercel', workerMode: 'remote' })
    expect(bad.ok).toBe(false)
    expect(bad.errors).toContain('workerMode must be one of: static, sandbox')

    const marlin = validateProfile({ name: 'y', runtime: 'marlin', model: 'openai:gpt-5.2' })
    expect(marlin.ok).toBe(false)
    expect(marlin.errors).toContain('runtime "marlin" requires workerMode "sandbox"')
  })

  it('warns, but does not reject, a substrate this build has not heard of', () => {
    const result = validateProfile({
      name: 'z',
      runtime: 'pi',
      workerMode: 'sandbox',
      workerSubstrate: 'firecracker',
    })
    expect(result.ok).toBe(true)
    expect(result.profile?.workerSubstrate).toBe('firecracker')
    expect(result.warnings[0]).toMatch(/Unrecognised workerSubstrate "firecracker"/)
  })

  it('accepts a catalog ref MCP entry and rejects one that copies a url', () => {
    const ok = validateProfile({
      name: 'apps',
      runtime: 'pi',
      mcpServers: [{ name: 'github', ref: 'catalog://github', optional: true }],
    })
    expect(ok.ok).toBe(true)
    expect(ok.profile?.mcpServers).toEqual([{ name: 'github', ref: 'catalog://github', optional: true }])

    const bad = validateProfile({
      name: 'apps',
      runtime: 'pi',
      mcpServers: [{ name: 'github', ref: 'catalog://other', url: 'https://x.example' }],
    })
    expect(bad.ok).toBe(false)
    expect(bad.errors).toContain('mcpServers[0].ref must be "catalog://<name>" (matching the entry\'s name)')
    expect(bad.errors).toContain('mcpServers[0]: a catalog ref must not copy url or headers')
  })
})
