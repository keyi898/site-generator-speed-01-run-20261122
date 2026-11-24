[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/keyi898/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/keyi898/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)

# site-generator-speed-01-run-20261122

A faster drop-in for makefun-site 1.0.0: `solve.js` answers every case exactly
as makefun-site does — the same output tree, byte for byte — while running
noticeably faster. `main.ts` is the program the harness runs: it reads every
case from `/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.

- `solve.js` — dependency-free ES module; `run(input)` returns the output tree
  (each page's `index.html`, the index and tag pages, `build-report.txt` and
  each static file) as a JSON object of path -> file text.
- `main.ts` — the entrypoint, run on Node 22.18+.

Pure JavaScript/TypeScript only: no WebAssembly, no native addons, no prebuilt
binaries, no network access at runtime.
