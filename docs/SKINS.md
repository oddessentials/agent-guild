# Skins

A skin changes how the page looks, in light and dark, and nothing else. The
skins live in `web/skins/<id>/`; copy the closest one to start.

A skin never restyles the logo, favicon, terminal, interface icons, layout or
labels.

## Add a skin

1. Add `{ id: '<id>', name: '<Menu label>' }` to the `skins` list in
   `web/theme.js`. List order is menu order; the first is the default.
2. Link `<link rel="stylesheet" href="/skins/<id>/skin.css">` in
   `web/index.html` with the other skins.
3. Write `web/skins/<id>/skin.css`:
   * Put rules inside `:where(:root[data-skin="<id>"])`, and dark or light
     overrides inside `:where(:root[data-skin="<id>"][data-theme="dark"])` or
     `…[data-theme="light"]`.
   * Define every token in `TOKENS` in `tests/skins.test.mjs` in the first
     block, and the colour tokens again in the dark block.
   * Prefix every `@keyframes` name with `<id>-`.
   * Wherever a rule styles `.cwd input`, style `.notes-text` too.
   * Use at least one image, by a URL relative to `skin.css`.
4. Put the art's sources in `concept-art/`.
5. Run `npm test`.

## Slots

All optional; leave out what the skin does not need.

| Slot | Selector |
| --- | --- |
| Tool colour and art | `--pc`, `--idle`, `--working`, `--locked` on `.provider[data-id="…"]` and `.session-card[data-provider="…"]` |
| Card art | `.card-art::before`; working art `.session-card .card-art::after`; locked `.provider.unavailable .card-art::before` |
| Tool icon | `.provider-icon:not(.has-image)[data-provider="…"]` |
| Frames | `.provider::after`, `.session-card::after`, `.models::after`, `.auth::after` |
| Level badge | `.level-badge` |
| Agent avatars | `.agent[data-familiar="flame\|leaf\|night\|aether"]` |
| Empty state | `#empty::before` |
| Background | `body::before` |
| Working effect | `.session-card:has(.status-pill.active) .card-aura` |

## Motion

The page adds these classes and removes each when its animation ends. Animate
each once, and nothing under `prefers-reduced-motion: reduce`.

| Class | When |
| --- | --- |
| `.providers.deal > .provider` | Tool cards appear |
| `.session-card.enter` | A session card appears |
| `.level-badge.level-up` | A level rises |
| `.agent.summon` | An agent appears |
