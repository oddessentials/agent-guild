# Terminal copying

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
