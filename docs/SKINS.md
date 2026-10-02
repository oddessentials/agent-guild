# Skins

A skin is the page's art and design styling. Each skin has a light and a dark
variant. The skin menu in the top bar switches skins in place, with no reload;
the Light/Dark button switches the variant. A skin changes how the page looks
and nothing else: layout, controls, labels and behaviour stay the same.

| Skin | id | Folder |
| --- | --- | --- |
| Guild (default) | `guild` | `web/skins/guild/` |
| Professional | `professional` | `web/skins/professional/` |

## What a skin changes

* Colour tokens, radius and display font.
* Provider card art (idle, working and locked) and provider icons.
* Session card art, working effect and level badge.
* Agent avatars, meter decorations and tier colours.
* Card frames, dialog frames, the unavailable-provider lock and the empty-sessions illustration.
* Page background.
* Buttons, pills, inputs, tooltips, dialogs and panel surfaces.
* Entrance and highlight animations.

## What a skin never changes

| Element | Where it lives |
| --- | --- |
| Logo: crest image and the "Agent Guild" wordmark (Cinzel font, gold gradient) | `web/brand/crest.png`, `--wordmark`, `--font-brand` in `web/styles.css` |
| Favicon | `web/brand/favicon.png` |
| Loading splash (the crest) | `web/styles.css` |
| Terminal: xterm content, colours and `--term-bg` | `web/app.js` (`TERMINAL_THEME`), `web/styles.css` |
| Interface icons: sun, moon, chevron, external link, info, GitHub | `--icon-*` in `web/styles.css` |
| Labels, text, provider names and vendor-supplied provider icons (`.provider-icon.has-image`) | `web/index.html`, `web/app.js`, the manager |
| Layout, markup and behaviour | `web/index.html`, `web/styles.css`, `web/app.js` |

## Required output

A new skin with id `<id>` consists of exactly these changes:

```
web/skins/<id>/
  skin.css                    every rule and token of the skin
  page.<ext>                  page background, dark
  page-light.<ext>            page background, light
  …                           the skin's other art, referenced from skin.css by relative URL
concept-art/<id>/             the sources or generator the art is built from
web/theme.js                  one entry added to the skins list
web/index.html                one <link> added after the other skin stylesheets
```

### 1. Registration

`web/theme.js`, in the `skins` list (menu order; the first entry is the default):

```js
{ id: '<id>', name: '<Menu label>' },
```

`web/index.html`, after the existing skin stylesheets:

```html
<link rel="stylesheet" href="/skins/<id>/skin.css">
```

### 2. Stylesheet scope

`skin.css` contains three blocks and the skin's keyframes, in this order:

```css
:where(:root[data-skin="<id>"]) { /* light tokens, then every rule for both variants */ }
:where(:root[data-skin="<id>"][data-theme="dark"]) { /* dark tokens, then dark-only rules */ }
:where(:root[data-skin="<id>"][data-theme="light"]) { /* light-only rules (optional) */ }
@keyframes <id>-… { … }
```

* Rules are nested inside the blocks, so they apply only while the skin is active.
* `:where()` keeps the specificity of every nested rule equal to the base rule it overrides.
* Every `@keyframes` name starts with `<id>-`.
* Asset URLs are relative to `skin.css` (`url("ui/lock.svg")`).
* Nothing in `skin.css` targets the elements in "What a skin never changes".

### 3. Tokens

Each skin defines every token below for light, and redefines the colour tokens for dark.

| Token | Used for |
| --- | --- |
| `--bg` | Page background colour |
| `--surface` | Cards, top bar, dialogs, inputs |
| `--surface-2` | Secondary surfaces: chips, pills, meter tracks, hovered rows |
| `--border` | Borders and dividers |
| `--text` | Body text |
| `--muted` | Secondary text, captions, icons |
| `--heading` | Section headings |
| `--accent` | Links, highlighted text, selection tint |
| `--accent-fill` | Primary buttons, selected chips and filters |
| `--accent-text` | Text on `--accent-fill` |
| `--danger` | Errors, Stop buttons, exited sessions |
| `--ok` | Ready states, running sessions, the first usage meter |
| `--warn` | Updates, warnings, low meters |
| `--gold` | Ornament colour: rules, borders and accents drawn by the skin |
| `--gold-ink` | Text in the ornament colour |
| `--focus` | Keyboard focus outline |
| `--shadow` | Default card and list shadow |
| `--radius` | Corner radius of buttons, inputs and panels |
| `--font-display` | Section headings (`h2`) and any skin-styled display text |

Tier colours (benchmark grades) are set per skin when they differ from the
base palette: `.tier-s` … `.tier-d`, each with `--tier` (bar and badge colour)
and `--tier-ink` (badge text), for light and dark.

### 4. Art slots

Every slot below is filled in both variants. Images may be AVIF+WebP (via
`image-set()`), PNG or SVG. The Guild column is the inventory of the default
skin; the Professional column is the inventory of the second skin.

| Slot | Selector / variable | Guild | Professional |
| --- | --- | --- | --- |
| Provider colour | `--pc` on `.provider[data-id="…"]`, `.session-card[data-provider="…"]` | `#d97757` anthropic, `#1fd08f` openai, `#5b9cff` google, `#38d6e8` xai, `#a67cf6` shell | `#d97757`, `#10a37f`, `#4285f4`, `#14b8c4`, `#7c6cf0` |
| Provider art, idle | `--idle` on the same selectors; drawn by `.card-art::before` | `characters/<provider>/idle.avif\|webp`, 640 px wide, transparent | `banners/<provider>/idle.svg`, 640×400, transparent |
| Provider art, working | `--working`; drawn by `.session-card .card-art::after` while the session is active | `characters/<provider>/working.avif\|webp` | `banners/<provider>/working.svg` |
| Provider art, locked | `--locked`; drawn on `.provider.unavailable .card-art::before` | `characters/<provider>/locked.avif\|webp` | `banners/<provider>/locked.svg` |
| Fallback provider art | `.provider, .session-card` without a provider match | shell set | shell set |
| Provider icon | `--icon` on `.provider-icon[data-provider="…"]`, painted on `.provider-icon:not(.has-image)` | `icons/<provider>.avif\|webp`, 128×128 | `icons/<provider>.svg`, 64×64 |
| Card frame | `.provider::after`, `.session-card::after` | `ui/frame.png`, 337×337 nine-slice, `border-image` slice 168, border 44 px | none (1 px border, 10 px radius) |
| Dialog frame | `.models::after`, `.auth::after` | `ui/frame-ornate.png`, 465×465 nine-slice, slice 232, border 54 px | none (12 px radius, shadow) |
| Locked provider badge | `.provider.unavailable::after` | `ui/padlock.png`, 87×120, top right | `ui/lock.svg`, 40×40, top right |
| Level badge | `.level-badge` (session card, bottom left of the art) | `ui/level-medallion.png`, 125×128 | styled chip, no image |
| Agent avatars | `.agent[data-familiar="flame\|leaf\|night\|aether"]` | `familiars/<name>.png`, 112 px tall | letter avatar, no image |
| Usage meter markers | `.meter-label`, `.meter + .meter .meter-label` | `ui/gem-vitality.png`, `ui/gem-mana.png`, 48 px tall | 7 px colour square |
| Empty sessions illustration | `#empty::before` | `ui/empty-state.avif\|webp`, 420 px wide, both variants | `ui/empty-state.svg` (dark), `ui/empty-state-light.svg` (light), 240×180 |
| Page background | `--page-art`, drawn by `body::before` | `page.avif\|webp` 1920×1088 (dark), `page-light.avif\|webp` 1392×752 (light) | `page.svg`, `page-light.svg`, 1600×1000 |
| Working effect | `.card-aura::before`, `.card-aura::after` while active | glowing ring and rising sparks in `--pc` | sweeping 3 px bar in `--pc` |
| Tooltip | `.tip` | dark parchment, Cinzel title | base tooltip |

### 5. Card geometry

The art area sits behind the card content. Each skin sets its size and the
matching card padding, per variant where they differ.

| Element | Property | Guild dark | Guild light | Professional |
| --- | --- | --- | --- | --- |
| `.provider` | `padding-top` | 188px | 242px | 124px |
| `.provider .card-art` | `inset`, `height` | `0 0 auto 0`, 250px (fades out) | `14px 14px auto`, 214px | `0 0 auto 0`, 106px |
| `.session-card` | `padding-left`, `min-height` | 152px, 196px | 160px, 196px | 108px, 164px |
| `.session-card .card-art`, `.card-aura` | `width` | 168px | 132px | 92px |
| `.session-card` at ≤ 640px | `padding-left` / art `width` | 118px / 132px | 140px / 112px | 92px / 76px |

### 6. Motion hooks

The page adds these classes once and removes each when an animation on that
element ends. Each skin runs an animation (its own keyframes) on every one,
and turns it off under `prefers-reduced-motion: reduce`.

| Class | When | Guild | Professional |
| --- | --- | --- | --- |
| `.providers.deal > .provider` | Provider cards first appear | `guild-deal`, staggered | `professional-rise`, staggered |
| `.session-card.enter` | A session card appears | `guild-card-enter` | `professional-rise` |
| `.level-badge.level-up` | A session's level rises | `guild-level-up` | `professional-pop` |
| `.agent.summon` | A new agent appears | `guild-summon` | `professional-pop` |

### 7. Art sources

| Skin | Source | Output |
| --- | --- | --- |
| Guild | `concept-art/default-art-design-v1/` (`source/build.py`) | `web/skins/guild/`, `web/brand/` |
| Professional | `concept-art/professional-skin/build.mjs` (`node concept-art/professional-skin/build.mjs`) | `web/skins/professional/` |

## Acceptance checklist

* The skin appears in the top-bar menu, and selecting it restyles the page without a reload.
* After a reload the page opens in the selected skin with no flash of another skin.
* Light and dark both show every slot in section 4.
* Switching between all skins and both variants leaves layout, labels and controls unchanged apart from card geometry (section 5).
* The logo, favicon, splash, terminal and interface icons look the same in every skin.
* All four motion hooks animate once and stop; nothing animates under reduced motion.
* `npm test` passes.
