import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { registerSkills } from '../../src/commands/skills.js'
import { ExitCode } from '../../src/lib/errors.js'
import { commandHarness, list } from '../helpers/cli.js'
import { jsonResponse, stubFetch } from '../helpers/fetch-mock.js'

const SKILL = {
  id: 'skill_1',
  object: 'skill',
  name: 'release-notes',
  description: 'Draft release notes\nfrom a changelog\n',
  default_version: '1',
  latest_version: '2',
  created_at: 1_783_245_600,
}

const { run, stdout } = commandHarness(registerSkills)

describe('skills', () => {
  it('lists skills with the description on one line', async () => {
    stubFetch({ 'GET /v1/skills?limit=10': jsonResponse(list([SKILL])) })
    await run(['skills', 'list'])
    expect(stdout()).toBe('skill_1\trelease-notes\t1\tDraft release notes from a changelog\n')
  })

  it('shows one skill', async () => {
    stubFetch({ 'GET /v1/skills/skill_1': jsonResponse(SKILL) })
    await run(['skills', 'get', 'skill_1'])
    expect(stdout()).toContain('latestVersion\t2')
  })

  it('uploads a folder as a directory upload under its own name', async () => {
    const dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'orca-skill-')), 'release-notes')
    await mkdir(path.join(dir, 'scripts'), { recursive: true })
    await writeFile(path.join(dir, 'SKILL.md'), '---\nname: release-notes\ndescription: Draft\n---\nSteps.\n')
    await writeFile(path.join(dir, 'scripts', 'run.sh'), 'echo hi\n')
    const calls = stubFetch({ 'POST /v1/skills': jsonResponse(SKILL) })
    await run(['skills', 'create', dir])
    const parts = calls[0].form?.getAll('files[]') as File[]
    expect(parts.map((p) => p.name)).toEqual(['release-notes/SKILL.md', 'release-notes/scripts/run.sh'])
    expect(stdout()).toContain('Created skill "release-notes" (skill_1)')
  })

  it('needs a SKILL.md before any request', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'orca-skill-'))
    const calls = stubFetch({})
    await expect(run(['skills', 'create', dir])).rejects.toMatchObject({ exitCode: ExitCode.Usage })
    expect(calls).toHaveLength(0)
  })

  it('deletes with --yes', async () => {
    const calls = stubFetch({ 'DELETE /v1/skills/skill_1': jsonResponse({ id: 'skill_1', object: 'skill.deleted', deleted: true }) })
    await run(['skills', 'delete', 'skill_1', '--yes'])
    expect(calls).toHaveLength(1)
  })
})
