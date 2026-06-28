# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A question bank for Singapore Secondary **Combined Humanities / Social Studies** prelim papers. It extracts
the two Section B Structured-Response Questions from each `.docx` paper and publishes them to a no-login
static website for students, hosted on **GitHub Pages** (`https://clovisity32.github.io/ss-question-bank/`).

- **Q6** — the "give **two** of something" question; classified by the variable it asks for
  (strategies, benefits, reasons, …).
- **Q7** — the discursive "Do you think / Do you agree … Explain your answer" question; classified by
  topic (Issue → Chapter, 3 Issues / 11 chapters).

## Commands

```bash
# one-time
python -m venv .venv && .venv\Scripts\activate
pip install -r pipeline/requirements.txt          # python-docx, pdfplumber

# extract Q6/Q7 from papers in Question Paper/  -> site/data/questions.draft.json (+ taxonomy/classify-config)
python pipeline/extract.py
python pipeline/extract.py "Test"                 # run on the holdout folder instead

# publish: review draft, then copy/regenerate to site/data/questions.json (the file the site reads)

# serve locally
python -m http.server 8000 -d site                # student: /  · admin: /upload.html · review: /review.html

# deploy: commit + push to main -> .github/workflows/pages.yml publishes site/
```

There is no automated test suite in-repo. Behaviour is verified with ad-hoc **jsdom** harnesses (see
parity/UI testing pattern below) and a **Python↔JS parity** check on real papers.

## Architecture & data flow

```
Question Paper/ (input, git-ignored)
   └─ pipeline/{docx_reader,extract,classify}.py
        ├─ docx_reader: ordered paragraph+table "segments"; strips the Answer-Scheme region
        ├─ extract:     finds Q6/Q7 by CONTENT SIGNATURE; reads school from the header; metadata
        └─ classify:    Q6 noun → category (config/categories.json); Q7 → Issue/Chapter (config/chapters.json)
   →  site/data/questions.draft.json
   →  site/review.html      (local point-and-click review → exports questions.json)
   →  site/data/questions.json   (the published bank)
   →  site/index.html + app.js   (student: Q6 per-type tabs, Q7 per-issue tabs, reveal-on-click + search)
   →  GitHub Pages

site/extract-core.js  = in-browser JS port of the Python pipeline (used by upload.html)
site/upload.html + upload.js = admin console (parse .docx on-device, edit, publish/manage via GitHub token)
```

**Extraction is rule-based, not AI.** Questions are located by content signature, not by their printed
number (papers vary: some auto-number with no number in the text, some embed an answer-scheme that
re-numbers): Q6 = a line matching `two <noun>` + `[marks]`; Q7 = a discursive trigger
(`Do you think|Do you agree|To what extent|…`) + marks, that isn't the "two" line. Only the question line
plus its one short lead-in is captured — never the source extracts between questions.

## Project rules (important)

- **Never commit or publish source papers.** `Question Paper/`, `Test/`, `Topic/`, and `*.draft.json` are
  git-ignored. Only `site/data/questions.json` (question text + metadata, no mark schemes) is public.
- **`config/*.json` is the single source of truth** for classification. `extract.py` exports a copy as
  `site/data/classify-config.json` (+ `taxonomy.json`) so the browser uses the same rules.
- **Keep `site/extract-core.js` and `pipeline/extract.py` in parity.** They must classify identically.
  After ANY change to extraction/classification, run both over `Question Paper/` and diff the output
  (category / issue / chapter / marks) on every question.
- **The admin page (`/upload.html`) is gated only by the GitHub token** held in the browser; publishing
  uses the GitHub Contents API (GET sha → PUT). Do not link it from the student page.
- **The Contents API is read-after-write _eventually_ consistent.** A GET right after a successful PUT can
  return the stale sha, so the next PUT fails with **409 "does not match"**. Always go through
  `putWithRetry()` (re-fetches the head sha + retries on 409) — never call `putLive()` directly from a
  publish/save path, or the user will hit a 409 and have to refresh.
- Pages deploy needs the token's `workflow` scope and Pages enabled with `build_type=workflow`.

## Testing pattern (jsdom)

For the vanilla-JS site and the JS↔Python parity, use Node + jsdom (no Playwright):
`new JSDOM(html, { runScripts: "outside-only" })` → stub `window.fetch` (local files + GitHub API) and
`window.mammoth`/`window.confirm` → `vm.runInContext(script, dom.getInternalVMContext())` → assert the DOM.
Inject `TextEncoder`/`TextDecoder`; set `input.files` via `Object.defineProperty`. Gotcha: stub the GitHub
**API branch before** the local-file branch — the API URL also contains `data/questions.json`, so a
naive `url.includes(...)` order returns the wrong shape.

Committed harnesses live in `tests/` and run via `npm install && npm test` (jsdom is a devDependency):
`publish-retry.test.js` (409 stale-sha recovery) and `clear-draft.test.js`.

## Changelog

| Date    | What                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06 | Built the SS Q6/Q7 bank: Python + JS (parity-tested) extraction, static site with reveal-on-click Q6/Q7 tabs, in-browser upload/admin console (multi-file, full-field edit, delete, confirm dialogs, duplicate detection), deployed to GitHub Pages. Switched extraction from number-anchored to content-signature; added header-based school detection.                                                                              |
| 2026-06 | Fixed "must refresh between uploads": consecutive publishes hit GitHub Contents API read-after-write lag → 409 stale-sha. Added `putWithRetry()` (re-fetch sha + retry, used by publish/save), a "retrying…" status hint, and a "Clear draft" button (reset pending batch + file input without refresh). Added committed jsdom tests in `tests/` + `npm test` (jsdom devDependency); reproduced and root-caused with a jsdom harness. |
