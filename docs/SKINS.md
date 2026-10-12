# Skins

A skin changes how the page looks, in light and dark, and nothing else. Copy
the closest shipped skin under `web/skins/` and replace its art and colours.

`npm test` checks the items marked *(tested)*. A skin that fails one does not
pass.

## Requirements

1. **Register it** *(tested)*. Add `{ id: '<id>', name: '<Menu label>' }` to
   the `skins` list in `web/theme.js`. The id is lowercase letters, digits and
   hyphens, starting with a letter. List order is menu order. `defaultSkin` in
   the same file names the skin a new page starts with, currently
   `professional`.
2. **Give it a Yard world** *(tested)*. Add an entry to `WORLDS` in
   `web/yard/model.mjs`, with a hall for every tool, its `characters` and its
   `helpers.agent` and `helpers.shell`. The world's model, the textures it
   references, its backdrop plates and its sky and surface maps stay within
   the size budget `tests/yard.test.mjs` sets; characters and helpers do not
   count. See
   [the yard](yard/README.md).
3. **Link its stylesheet** *(tested)* in `web/index.html`, with the other
   skins, exactly as `<link rel="stylesheet" href="/skins/<id>/skin.css">`.
4. **Scope every rule** to one of these blocks, so it cannot restyle another
   skin. `:where()` keeps each rule at the specificity of the base style it
   overrides.
   * `:where(:root[data-skin="<id>"])` for both themes
   * `:where(:root[data-skin="<id>"][data-theme="dark"])` for dark
   * `:where(:root[data-skin="<id>"][data-theme="light"])` for light
5. **Define every token** *(tested)* in the both-themes block, and every
   colour token again in the dark block.

   | Token | Use | In the dark block |
   | --- | --- | --- |
   | `--bg`, `--surface`, `--surface-2` | Page, cards, inset panels | Yes |
   | `--border`, `--text`, `--muted`, `--heading` | Lines and type | Yes |
   | `--accent`, `--accent-fill`, `--focus` | Accent, buttons, focus ring | Yes |
   | `--accent-text` | Label on `--accent-fill` | No |
   | `--danger`, `--ok`, `--warn` | Status colours | Yes |
   | `--gold`, `--gold-ink` | Ornament and its text | Yes |
   | `--shadow` | Card shadow | Yes |
   | `--radius` | Corner radius | No |
   | `--font-display` | Headings; `var(--font-brand)` keeps the logo's font | No |
6. **Prefix every `@keyframes` name** *(tested)* with `<id>-`.
7. **Style `.notes-text` with `.cwd input`** *(tested)*. Any selector list that
   styles `.cwd input` includes `.notes-text`, so the notes field matches the
   working-folder field.
8. **Give every tool its own art** *(tested)*. Each tool but `shell` has its
   own `.provider[data-id="…"], .session-card[data-provider="…"] {` block and
   its own `.provider-icon[data-provider="…"] {` block, as in [Files](#files).
9. **Ship its art** *(tested)*. Use at least one image by a URL relative to
   `skin.css`, and every such URL must resolve to a file. `data:`, `https:`
   and root-relative URLs do not count.
10. **Keep the sources** of the art, and the script that builds the shipped
    files, in `concept-art/`.

## Leave these alone

Every skin shows the same brand, terminal and controls.

| Element | Where it lives |
| --- | --- |
| Crest, wordmark, favicon, loading splash | `web/brand/`, `--wordmark` and `--font-brand` in `web/styles.css` |
| Terminal colours | `TERMINAL_THEME` in `web/app.js`, `--term-bg` in `web/styles.css` |
| Interface icons | `--icon-*` in `web/styles.css` |
| A tool icon the user set (`.provider-icon.has-image`) | the manager |
| Labels, markup and behaviour | `web/index.html`, `web/styles.css`, `web/app.js` |

## Files

Paths are relative to `web/skins/<id>/`. Each picture is a `.webp` with an
`.avif` of the same name beside it; ask for both, avif first:

```css
image-set(url("page.avif") type("image/avif"), url("page.webp") type("image/webp"))
```

The tools are `shell`, `anthropic`, `openai`, `google`, `xai` and `docker`.
Each has an `idle`, `working` and `locked` portrait. Agent avatars are
`flame`, `leaf`, `night` and `aether`; the page picks one per
agent.

```text
web/skins/<id>/
  skin.css
  page.webp                          dark page background
  page-light.webp                    light page background
  characters/<tool>/idle.webp        portraits, also working.webp and locked.webp
  icons/<tool>.webp                  tool icon
  familiars/flame.png                agent avatars, also leaf, night and aether
  ui/empty-state.webp                shown before the first session
  fonts/<name>.woff2                 display font, with its OFL.txt
```

Set the shell portraits as the default in the both-themes block, then override
them per tool:

```css
.provider, .session-card {
  --idle: image-set(url("characters/shell/idle.avif") type("image/avif"), url("characters/shell/idle.webp") type("image/webp"));
  /* --working and --locked the same way */
}
.provider[data-id="anthropic"], .session-card[data-provider="anthropic"] {
  --idle: image-set(url("characters/anthropic/idle.avif") type("image/avif"), url("characters/anthropic/idle.webp") type("image/webp"));
}
```

Frames, the lock, the level badge and the meter marks are up to the skin; the
shipped ones are in `ui/`.

## Shipped skins

| Skin | Sources | Display font | Notes |
| --- | --- | --- | --- |
| Guild | [default-art-design-v1](../concept-art/default-art-design-v1) | the brand font | Build with `python source/build.py` from the pack. PNG frames and gems |
| Orbital | [orbital-skin](../concept-art/orbital-skin/README.md) | Exo 2 | SVG lock, level and meter marks |
| Grove | [grove-skin](../concept-art/grove-skin/README.md) | Fraunces | A card backdrop behind each portrait, light and dark |
| Gnomeland | [gnomeland-skin](../concept-art/gnomeland-skin/README.md) | Almendra | SVG frame, lock, level and meter marks |
| Goblinville | [goblinville-skin](../concept-art/goblinville-skin/README.md) | Germania One | SVG frame, lock, level and meter marks |
| Professional | [professional-skin](../concept-art/professional-skin/README.md) | the system UI font | A glass object per tool rendered with Blender, in `objects/<tool>/` with a light and a dark version of each state; SVG tool icons, a light and a dark empty state; no familiars, no frame, and the level badge and meters are CSS |

## Slots

Fill the ones the skin needs.

| Slot | Selector |
| --- | --- |
| Tool colour and portraits | `--pc`, `--idle`, `--working`, `--locked` on `.provider[data-id="…"]` and `.session-card[data-provider="…"]` |
| Card art | `.card-art::before` shows `--idle`; working is `.session-card .card-art::after`; locked is `.provider.unavailable .card-art::before` |
| Tool icon | `--icon` on `.provider-icon[data-provider="…"]`, shown by `.provider-icon:not(.has-image)` |
| Frames | `.provider::after`, `.session-card::after`, `.models::after`, `.auth::after` |
| Level badge | `.level-badge`; its text is the level number |
| Agent avatars | `.agent[data-familiar="flame"]`, and the same for `leaf`, `night`, `aether` |
| Empty state | `#empty::before` |
| Page background | `body::before` |
| Working effect | `.session-card:has(.status-pill.active) .card-aura` |
| Meter marks | `.meter-label` for the first meter, `.meter + .meter .meter-label` for the second |

## Motion

The page adds these classes as things appear and removes each when its
animation ends. Animate each once, and none of them under
`prefers-reduced-motion: reduce`.

| Class | When |
| --- | --- |
| `.providers.deal > .provider` | Tool cards appear |
| `.session-card.enter` | A session card appears |
| `.level-badge.level-up` | A level rises |
| `.agent.summon` | An agent appears |
