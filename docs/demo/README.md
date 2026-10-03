# GitHub Pages demo

The public demo is the released web client backed by a deterministic in-browser
simulation. It never connects to a local Agent Guild manager or executes a
command. Release CI builds `docs/.pages` from the tested package artifact and
deploys it only after the corresponding GitHub Release exists.

Build and verify a local copy:

```sh
npm run demo:build -- --version 1.2.3
npm run demo:check
```

Serve `docs/.pages` beneath a project-style path when reviewing it; the builder
converts the installed client's origin-root asset references to relative ones.
The output folder is generated and must not be committed.
