# Social Studies Question Bank (Q6 & Q7)

A question bank for Singapore Secondary **Combined Humanities / Social Studies** prelim papers.
It extracts the two Section B Structured-Response Questions from each paper and publishes them to a
no-login website for students:

- **Q6** — "give **two** of something" questions, sorted by **question type** (the variable the
  question asks for: strategies, suggestions, reasons, benefits, consequences, impacts, …).
- **Q7** — discursive "Do you think … Explain your answer" questions, sorted by **topic** (Issue → Chapter).

```
papers (.docx/.pdf)  →  pipeline/extract.py  →  questions.draft.json
                     →  site/review.html (confirm)  →  questions.json
                     →  site/index.html (students)  →  GitHub Pages
```

## Project layout

| Path                       | Purpose                                                      |
| -------------------------- | ------------------------------------------------------------ |
| `Question Paper/`          | Input papers (git-ignored, never published)                  |
| `Test/`                    | Holdout paper(s) for verification                            |
| `Topic/`                   | Source of the Issue/Chapter taxonomy                         |
| `pipeline/extract.py`      | Finds Q6 & Q7, classifies, writes the draft                  |
| `pipeline/docx_reader.py`  | Reads `.docx`/`.pdf`; strips the Answer-Scheme region        |
| `pipeline/classify.py`     | Q6 noun extraction + Q7 chapter matching                     |
| `config/categories.json`   | Q6 categories and their synonyms — **editable**              |
| `config/chapters.json`     | The 3 Issues / 11 Chapters and match keywords — **editable** |
| `site/index.html`          | Student-facing browse/search site                            |
| `site/review.html`         | Local point-and-click review tool (not deployed)             |
| `site/data/questions.json` | The published data the site reads                            |

## One-time setup

```bash
python -m venv .venv
.venv\Scripts\activate          # Windows  (source .venv/bin/activate on macOS/Linux)
pip install -r pipeline/requirements.txt
```

## Updating the question bank

1. **Add papers** — drop `.docx` (or `.pdf`) prelim papers into `Question Paper/`.
   Filenames are parsed for metadata; a name like `2025 ACS(BR) Prelim 4E SS.docx` works well
   (year + school + level). Anything unparsed is just corrected in the review step.

2. **Extract**

   ```bash
   python pipeline/extract.py
   ```

   Writes `site/data/questions.draft.json` and `site/data/taxonomy.json`, and prints how many
   questions were found and flagged.

3. **Review & publish** — serve the site folder and open the review tool:

   ```bash
   python -m http.server 8000 -d site
   ```

   Open <http://localhost:8000/review.html>. Confirm/correct each question's **category** (Q6) or
   **Issue · Chapter** (Q7) and metadata (flagged / low-confidence items sort to the top). Click
   **Download questions.json** and save it over `site/data/questions.json`.

4. **Preview** — open <http://localhost:8000/> and check the Q6 and Q7 tabs.

5. **Deploy** — commit and push:
   ```bash
   git add -A && git commit -m "data: update question bank" && git push
   ```
   The Pages workflow (`.github/workflows/pages.yml`) publishes the `site/` folder automatically.
   In the GitHub repo: **Settings → Pages → Source = GitHub Actions** (one-time).

## Uploading papers through the website (no command line)

The live site has a hidden admin page at **`/upload.html`** (not linked from the student bank — bookmark
it). It lets you add papers without running Python:

1. Open `https://<username>.github.io/ss-question-bank/upload.html`.
2. **One-time:** create a GitHub **fine-grained personal access token** with **Contents: Read & write**
   on this repo (<https://github.com/settings/personal-access-tokens>), paste it into _Publish settings_,
   and click **Save token**. The token stays in your browser only — it is the publish lock, so **only you**
   (the token holder) can add questions. Students who open the page can't publish.
3. Choose one or more `.docx` papers. They are parsed **on your device** (the file is never uploaded);
   the same Q6/Q7 detection + classification as the Python pipeline runs in the browser.
4. Review the detected questions (fix any category / Issue·Chapter), then **Publish to live site**.
   This commits the merged `questions.json` to the repo; the Pages workflow redeploys and students see the
   new questions within ~1 minute. Questions are merged by id, so re-uploading a paper updates it in place.

> The in-browser extractor (`site/extract-core.js`) is a direct port of the Python pipeline and uses the
> same rules, exported to `site/data/classify-config.json` by `extract.py`.

## How classification works

- **Q6 category** — the pipeline extracts the noun after `two`/`some` (e.g. "two **strategies**") and
  canonicalises it via `config/categories.json`. Unknown nouns are kept verbatim and flagged for review.
  Add new categories/synonyms by editing that file.
- **Q7 topic** — the question text is scored against each chapter's keywords in `config/chapters.json`;
  the best Issue + Chapter is suggested. Tune matching by editing the `keywords` lists.

The auto-classifier is a starting point — the **review tool is the source of truth**. Anything it gets
wrong is fixed there in seconds before publishing.

## Notes

- Source papers, the holdout, and the taxonomy doc are git-ignored — only the generated `questions.json`
  (question text + metadata, no mark schemes) is published.
- `.pdf` support is scaffolded via `pdfplumber` but untuned; current inputs are all `.docx`.
