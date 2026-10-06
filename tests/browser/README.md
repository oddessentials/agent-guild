# Browser checks

The GitHub panel's account selection, issue editing, delayed requests and repository
picker also have a browser regression check: `node tests/browser/github.mjs`.
The environment dialog's four scopes, folder edit, session refusal, launch label
and shell-card isolation are checked by `node tests/browser/environment-scopes.mjs`.
Branch pagination, scroll anchoring, filtering and copy controls are checked by
`node tests/browser/github-branches.mjs`. `BRANCH_SCREENSHOTS` optionally names
a folder for desktop and phone screenshots. These checks use simulated GitHub
responses and never contact GitHub. Set `CHROME_PATH`
to Chrome or Edge on Windows, as with the checks below.
The Yard's Cards parity, pending actions, skin gate, reduced motion and
reconnect behavior are checked by
`node --test --test-concurrency=1 tests/browser/yard.mjs`.
`npm test` covers asset bytes, placement and the skin gate in `tests/yard.test.mjs`.

## Dialog lifecycle

Use `withDialogClose(evaluate, selector, action)` from `chrome.mjs` whenever a
browser action closes a native dialog before the next interaction. It registers
the real `close` listener before the action and awaits that event, including for
trusted touch/keyboard input and indirect closes such as switching sessions.
Neither `dialog.open === false` nor restored focus means that the queued close
handler has finished. Keep animation/frame waits for geometry measurements only.

The lifecycle audit covers folder selection and remote-access Close in the proxy
check; terminal-copy Done, Escape, session switching, Hide and page departure;
and the history, environment, model, remote-access and folder sizing checks.
Layout and GitHub checks close docks, popovers or inline forms, not native dialogs.
The deliberately delayed-close regression stays in the environment unit test,
where close events are explicitly queued and released.

Before pushing a browser synchronization change, run the full Linux/Node 24
sequence in CI order (with dependencies installed and Chrome available):

```sh
set -e
export CHROME_NO_SANDBOX=1
node tests/browser/terminal-copy.mjs
node tests/browser/terminal-controls.mjs
node tests/browser/layout.mjs
node --test --test-concurrency=1 tests/browser/yard.mjs   # local only: too slow without a GPU for CI
node tests/browser/github.mjs
node tests/browser/github-branches.mjs
node tests/browser/environment-scopes.mjs
node tests/browser/proxy.mjs
npm install --prefix .cache/browser-tools --no-save --package-lock=false --ignore-scripts playwright-core@1.63.0
node .cache/browser-tools/node_modules/playwright-core/cli.js install --with-deps webkit
PLAYWRIGHT_MODULE=.cache/browser-tools/node_modules/playwright-core/index.mjs node tests/browser/dialogs.mjs
```

## HTTPS reverse proxy

`node tests/browser/proxy.mjs` starts an isolated manager, a real test PTY and
an HTTPS proxy on loopback. Chrome resolves `guild.example.ts.net` to that
proxy and checks authentication, API writes, events, terminal input/output
and CSP. It uses the public test key and certificate in `tests/fixtures`;
certificate errors are ignored only in this disposable browser. It does not
change the machine's trust store, contact Tailscale or use existing accounts.

## Touch terminal keys

`node tests/browser/terminal-controls.mjs` checks the six touch keys with the
real page and xterm. It covers normal/application cursor modes, retained
focus, keyboard and assistive click activation, canceled gestures, split
targeting, delayed snapshots, reconnects and responsive layouts in every skin.
`CONTROLS_SCREENSHOTS=/path/to/folder` saves representative layouts. The HTTPS
proxy check also sends all six keys through a real PTY in both cursor modes.

Viewport geometry is simulated: these checks cannot certify a native mobile
keyboard, IME or screen reader. Physical-device validation should cover iPhone
and iPad Safari, Android Chrome and the affected tablet browser, with the
keyboard open/closed, rotation, an attached keyboard/mouse, Copy and dictation.
Check that each tap reaches the intended prompt once, preserves keyboard
visibility and keeps output and controls visible. Floating keyboards are
positioned by the OS and need not resize the browser viewport.

## Safari dialog sizing

`node tests/browser/dialogs.mjs` verifies a 200-row history list, filtering,
empty states and shared dialog bodies in Chrome. It checks actual scrollable
space and footer reachability at desktop, tablet and phone sizes.

To also run WebKit (as CI does), install the test tools separately from the
application's dependencies:

```sh
npm install --prefix .cache/browser-tools --no-save --package-lock=false --ignore-scripts playwright-core@1.63.0
node .cache/browser-tools/node_modules/playwright-core/cli.js install webkit
```

Set `PLAYWRIGHT_MODULE` to
`.cache/browser-tools/node_modules/playwright-core/index.mjs` and run the
dialog check. Linux may need `install --with-deps webkit`. The WebKit pass also
checks trusted terminal taps with and without input focus. This engine check
does not emulate an iOS software keyboard or replace physical-device testing.

## Terminal copying

`npm test` covers buffer text and application lifecycle. Run the integrated
page in Chrome with:

```sh
node tests/browser/terminal-copy.mjs
```

Set `CHROME_PATH` if Chrome is not found automatically. In an isolated CI or
container that cannot run Chrome's sandbox, set `CHROME_NO_SANDBOX=1`. The
test serves the real page and installed xterm with the repository's simulated
session manager; it does not start a shell or contact a coding provider.
`COPY_SCREENSHOT=/path/to/copy.png` optionally saves the copy sheet.

The browser check uses trusted touch input to press Copy and reads back the
result for comparison. Only the test requests clipboard-read permission.
It covers clipboard denial, missing APIs, delayed completion, cleanup,
responsive layout and touch/mouse hybrids. Selection ranges are set through
the DOM: desktop touch emulation does **not** verify Android's selection
handles, native Copy menu or OS clipboard.

Before release, check the affected Android tablet and browser, plus Chrome
Android and Samsung Internet where supported:

- Open **Copy…**, long-press text, move both handles and copy a word, multiple
  lines, a wrapped command, Unicode and older scrollback. Paste into another
  Android app and compare the text.
- Test **Copy selection** and the native Copy menu separately. When clipboard
  permission is denied, selection must remain usable for native Copy.
- Repeat while output arrives, after rotating the tablet, and with an external
  keyboard or mouse. The live terminal must keep running; selection must not
  send keystrokes or mouse events. At unchanged viewport dimensions, opening
  the sheet must not resize the terminal.
- Check **Done**, Escape/Back, Hide, session switching/removal and reconnects.
  Closed sheets must not retain text or show an earlier copy's completion.
- Confirm existing typing, IME, paste, Ctrl+C, links, touch scrolling, full-screen
  tools, mouse reporting and Dictate still behave as before.

Record the device/browser versions and outcomes. Physical-device acceptance
is still pending; a passing emulated test is not Android release certification.
