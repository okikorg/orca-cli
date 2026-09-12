import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerKits } from '../../src/commands/kits.js'
import { saveConfig } from '../../src/lib/config.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'
import { useTmpConfigDir } from '../helpers/tmp-config.js'

// Declining the y/N gate is the one path that needs a TTY on both ends, which
// puts the command in Ink mode. Ink cannot mount under vitest (patch-console
// wants the real global console), so renderStatic is stubbed and the prompt
// answers no. Its own file so neither mock reaches the rest of the suite.
vi.mock('../../src/ui/PromptInput.js', () => ({ promptText: vi.fn(async () => 'n') }))
vi.mock('../../src/lib/output.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/output.js')>()),
  renderStatic: vi.fn(async () => {}),
}))

const KEY = 'ao_dev_abcdefghijklmnopqrstuv'
const ID = 'kit-utRCllawsrI2cqKdT'
let cleanup: () => Promise<void>

beforeEach(async () => {
  const tmp = await useTmpConfigDir()
  cleanup = tmp.cleanup
  await saveConfig({ currentContext: 'default', contexts: { default: { apiUrl: 'http://test:8080', apiKey: KEY } } })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})
afterEach(async () => { await cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('kit add confirmation', () => {
  it('declining it aborts without an error and copies nothing', async () => {
    const savedIn = process.stdin.isTTY
    const savedOut = process.stdout.isTTY
    process.stdin.isTTY = true
    process.stdout.isTTY = true
    try {
      const calls = stubFetch({
        [`GET /api/kits/${ID}`]: jsonResponse({ id: 'tpl-1', publicId: ID, slug: 'seo-helper', label: 'seo-helper' }),
        [`POST /api/kits/${ID}/events`]: () => new Response(null, { status: 204 }),
        'GET /api/templates/seo-helper/copy?id=tpl-1': jsonResponse({ templateId: 'tpl-1', version: 1, assets: [{ kind: 'skill', name: 'seo', digest: 'd', status: 'new', collision: false, suggestedName: 'seo' }] }),
      })
      const program = new Command()
      program.exitOverride().option('--context <name>').option('--api-url <url>').option('--json')
      registerKits(program)
      await program.parseAsync(['kit', 'add', ID], { from: 'user' })
      expect(calls.some((c) => c.method === 'POST' && c.path.includes('/copy'))).toBe(false)
      // A cancelled add reads as a view with no click, exactly as on the page.
      const events = calls.filter((c) => c.path.endsWith('/events')).map((c) => JSON.parse(c.body as string))
      expect(events.map((e) => e.type)).toEqual(['view'])
      expect(
        vi.mocked(console.error).mock.calls.map((c) => c.map(String).join(' ')).join('\n'),
      ).toContain('Aborted.')
    } finally {
      process.stdin.isTTY = savedIn
      process.stdout.isTTY = savedOut
    }
  }, 10_000)
})
