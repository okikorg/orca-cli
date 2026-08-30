# Dimmer Terminal Coral Design

## Goal

Make Orca's primary coral accent more comfortable for sustained use on dark
terminal backgrounds without changing the CLI's visual hierarchy or color
semantics.

## Design

Replace the primary accent `#FE785D` (RGB `254,120,93`) with the substantially
dimmer coral `#B85C4A` (RGB `184,92,74`). Replace the strong accent `#F0543C`
(RGB `240,84,60`) with `#9E4938` (RGB `158,73,56`). The new colors keep the
existing warm coral hue while reducing brightness and saturation enough to
avoid glare.

Update both representations in `src/ui/theme.ts`:

- `theme.accent`, used by Ink components, becomes `#B85C4A`.
- `ansi.accent`, used by direct terminal output, becomes the matching 24-bit
  escape sequence `\x1b[38;2;184;92;74m`.
- `theme.accentStrong` and `ansi.accentStrong` become `#9E4938` and
  `\x1b[38;2;158;73;56m` respectively, keeping inline code from retaining the
  brighter coral.

Leave status colors, muted text, subtle text, borders, and `NO_COLOR` behavior
unchanged. This is a token-only change; every existing accent consumer inherits
it automatically.

## Verification

Add a focused theme test that locks the Ink and ANSI representations to the
same RGB value. Run the theme test, the full test suite, typecheck, and package
build. Do not start a development server.
