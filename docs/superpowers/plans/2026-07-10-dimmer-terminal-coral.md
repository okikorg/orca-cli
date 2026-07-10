# Dimmer Terminal Coral Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bright terminal coral family with substantially dimmer tones while keeping Ink and raw ANSI output consistent.

**Architecture:** The palette remains centralized in `src/ui/theme.ts`. Change the primary accent in its hex and ANSI forms and add a focused consistency test; all consumers continue using the existing tokens.

**Tech Stack:** TypeScript, Ink, Vitest, tsup

## Global Constraints

- Use `#B85C4A` and RGB `184,92,74` for the primary accent.
- Use `#9E4938` and RGB `158,73,56` for the strong accent.
- Leave all other palette tokens and color-gating behavior unchanged.
- Do not add dependencies or start a server.

---

### Task 1: Dim the primary accent token

**Files:**
- Modify: `src/ui/theme.ts`
- Test: `test/ui/theme.test.ts`

**Interfaces:**
- Consumes: the exported `theme.accent` and `ansi.accent` tokens.
- Produces: matching hex and ANSI values for the dimmed primary and strong coral tokens.

- [ ] **Step 1: Write the failing test**

Add this test to `test/ui/theme.test.ts`:

```ts
it('keeps the muted coral hex and ANSI accent values aligned', () => {
  expect(theme.accent).toBe('#B85C4A')
  expect(ansi.accent).toBe('\x1b[38;2;184;92;74m')
  expect(theme.accentStrong).toBe('#9E4938')
  expect(ansi.accentStrong).toBe('\x1b[38;2;158;73;56m')
})
```

Import `ansi` and `theme` from `../../src/ui/theme.js`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx vitest run test/ui/theme.test.ts`

Expected: FAIL because the current coral tokens still use the brighter values.

- [ ] **Step 3: Update the centralized tokens**

In `src/ui/theme.ts`, set:

```ts
accent: '#B85C4A',
accentStrong: '#9E4938',
```

and:

```ts
accent: '\x1b[38;2;184;92;74m',
accentStrong: '\x1b[38;2;158;73;56m',
```

Update the adjacent comments to describe the muted terminal coral accurately.

- [ ] **Step 4: Run focused and full verification**

Run:

```bash
npx vitest run test/ui/theme.test.ts
npm test
npm run typecheck
npm run build
```

Expected: every command exits successfully.
