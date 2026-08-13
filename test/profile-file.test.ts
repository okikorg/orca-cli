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

  // The custom runtime and its harness template. The pairing is enforced in
  // both directions here so a profile that cannot boot is caught before the
  // POST, matching the server's validateProfileTemplate.
  describe('custom runtime', () => {
    it('accepts a custom agent with a template object', () => {
      const result = validateProfile({
        name: 'invoice-agent',
        runtime: 'custom',
        template: { name: 'invoice-harness', version: 3 },
      })
      expect(result).toMatchObject({
        ok: true,
        warnings: [],
        profile: {
          name: 'invoice-agent',
          runtime: 'custom',
          template: { name: 'invoice-harness', version: 3 },
        },
      })
    })

    it('accepts the bare string form and reads it as tracking the active version', () => {
      const result = validateProfile({
        name: 'invoice-agent',
        runtime: 'custom',
        template: 'invoice-harness',
      })
      expect(result.ok).toBe(true)
      expect(result.profile?.template).toEqual({ name: 'invoice-harness' })
    })

    it('drops version 0 rather than pinning to it', () => {
      // Zero means "track the active pointer", which is the same thing as
      // omitting the field. Sending 0 would read as a pin to a version that
      // cannot exist.
      const result = validateProfile({
        name: 'invoice-agent',
        runtime: 'custom',
        template: { name: 'invoice-harness', version: 0 },
      })
      expect(result.ok).toBe(true)
      expect(result.profile?.template).toEqual({ name: 'invoice-harness' })
    })

    it('rejects a custom agent with no template', () => {
      const result = validateProfile({ name: 'invoice-agent', runtime: 'custom' })
      expect(result.ok).toBe(false)
      expect(result.errors.some((e) => e.includes('requires a template'))).toBe(true)
    })

    it('rejects a template on a platform runtime', () => {
      const result = validateProfile({
        name: 'support-bot',
        runtime: 'claude',
        template: { name: 'invoice-harness' },
      })
      expect(result.ok).toBe(false)
      expect(result.errors.some((e) => e.includes('only valid with runtime "custom"'))).toBe(true)
    })

    it('rejects a template name that could escape the registry path', () => {
      const result = validateProfile({
        name: 'invoice-agent',
        runtime: 'custom',
        template: { name: '../other-tenant' },
      })
      expect(result.ok).toBe(false)
      expect(result.errors.some((e) => e.includes('lowercase alphanumeric'))).toBe(true)
    })

    it('rejects a negative version', () => {
      const result = validateProfile({
        name: 'invoice-agent',
        runtime: 'custom',
        template: { name: 'invoice-harness', version: -1 },
      })
      expect(result.ok).toBe(false)
      expect(result.errors.some((e) => e.includes('template.version'))).toBe(true)
    })

    it('warns on an unknown key inside template without blocking', () => {
      const result = validateProfile({
        name: 'invoice-agent',
        runtime: 'custom',
        template: { name: 'invoice-harness', digest: 'sha256:...' },
      })
      expect(result.ok).toBe(true)
      expect(result.warnings.some((w) => w.includes('digest'))).toBe(true)
    })
  })
})
