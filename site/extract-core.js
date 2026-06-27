// In-browser port of pipeline/{docx_reader,extract,classify}.py.
// Operates on "segments": {kind:"para"|"row", text, cells?[]}.
// Classification is driven by data/classify-config.json (same rules as Python).
(function (global) {
  "use strict";

  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function norm(s) {
    return String(s || "")
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, "-")
      .replace(/\s+/g, " ")
      .trim();
  }

  function dedupCells(cells) {
    const out = [];
    for (let c of cells) {
      c = (c || "").trim();
      if (c && (out.length === 0 || out[out.length - 1] !== c)) out.push(c);
    }
    return out.join("  ");
  }

  const AS_MARKERS =
    /(^\s*L\s*[1-4]\b|\bAward\s+\d+\s*(?:[-–]\s*\d+)?\s*m(?:ark)?s?\b|\bmark(?:ing)?\s+scheme\b|\banswer\s+scheme\b|\bsuggested\s+answer|\btarget\s+skill\b)/i;

  function questionPaperRegion(segments) {
    for (let i = 0; i < segments.length; i++) {
      if (AS_MARKERS.test(segments[i].text)) return segments.slice(0, i);
    }
    return segments;
  }

  function isQStart(seg, n) {
    if (seg.cells && seg.cells.length && seg.cells[0].trim() === String(n))
      return true;
    return new RegExp("^" + n + "[\\.\\)\\s]\\s*\\S").test(seg.text);
  }

  function findStart(segments, n) {
    for (let i = 0; i < segments.length; i++)
      if (isQStart(segments[i], n)) return i;
    return null;
  }

  function blockText(segments, start, end, n) {
    const parts = [];
    for (let i = start; i < end; i++) parts.push(segments[i].text);
    let text = parts.join(" ");
    text = text.replace(new RegExp("^" + n + "[\\.\\)\\s]+"), "");
    return text.replace(/\s+/g, " ").trim();
  }

  const TRIGGER =
    /(In your opinion\b|Do you think\b|What can\b|What are\b|What do\b|Why \b|How can\b|How far\b|How do\b|Suggest\b|Explain how\b)/i;

  function splitContextStem(text) {
    const m = TRIGGER.exec(text);
    if (m && m.index > 0)
      return [text.slice(0, m.index).trim(), text.slice(m.index).trim()];
    return ["", text];
  }

  function marks(text) {
    const found = [...text.matchAll(/\[\s*(\d+)\s*\]/g)];
    return found.length ? parseInt(found[found.length - 1][1], 10) : null;
  }

  const STOP_TOKENS = new Set([
    "SS",
    "QP",
    "AS",
    "PRELIM",
    "PRELIMS",
    "SECTION",
    "HUM",
    "AND",
    "V2",
    "V1",
  ]);

  function metadata(filename) {
    const stem = filename.replace(/\.[^.]+$/, "");
    const ym = stem.match(/(20\d{2})/);
    const year = ym ? parseInt(ym[1], 10) : null;
    let school = null;
    for (const tok of stem.match(/[A-Z]{2,}(?:\([A-Za-z]+\))?/g) || []) {
      if (!STOP_TOKENS.has(tok.toUpperCase())) {
        school = tok;
        break;
      }
    }
    const lm = stem.match(/(S?4E5N|4E5N|S4E5N|4E|5N|4N)/);
    const paper = lm ? "Prelim " + lm[1] : "Prelim";
    return { school, year, paper, meta_ok: !!(school && year) };
  }

  const slug = (s) =>
    String(s || "x")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

  // ---- classification ----
  const STOP_AFTER_NUM = new Set([
    "main",
    "key",
    "possible",
    "important",
    "specific",
    "good",
    "of",
    "such",
    "other",
  ]);

  function buildVariantMap(categories) {
    const m = {};
    for (const canon of Object.keys(categories)) {
      m[canon.toLowerCase()] = canon;
      for (const v of categories[canon]) m[v.toLowerCase()] = canon;
    }
    return m;
  }

  function classifyQ6(text, categories) {
    const variants = buildVariantMap(categories);
    const re = /\b(?:two|some)\s+([a-z]+)(?:\s+([a-z]+))?/gi;
    let m;
    const low = text.toLowerCase();
    while ((m = re.exec(low)) !== null) {
      const w1 = m[1],
        w2 = m[2];
      let candidates;
      if (STOP_AFTER_NUM.has(w1) && w2) candidates = [w2, w1];
      else candidates = w2 ? [w1, w2] : [w1];
      for (const w of candidates)
        if (variants[w])
          return { category: variants[w], raw: w, confidence: 1.0 };
      const raw = STOP_AFTER_NUM.has(w1) && w2 ? w2 : w1;
      return { category: null, raw, confidence: 0.4 };
    }
    return { category: null, raw: "", confidence: 0.2 };
  }

  function classifyQ7(text, issues) {
    const scored = [];
    for (const iss of issues) {
      for (const ch of iss.chapters) {
        let score = 0;
        for (const kw of ch.keywords) {
          const weight = 1.0 + 0.7 * (kw.split(/\s+/).length - 1);
          const re = new RegExp("\\b" + reEsc(kw), "gi");
          const n = (text.match(re) || []).length;
          if (n) score += weight * (1 + 0.4 * (n - 1));
        }
        scored.push({
          score,
          issue: iss.issue,
          chapter: ch.chapter,
          title: ch.title,
        });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best || best.score === 0)
      return {
        issue: null,
        chapter: null,
        chapter_title: null,
        confidence: 0.0,
      };
    const second = scored[1] ? scored[1].score : 0;
    let conf = Math.min(1.0, best.score / 4.0);
    if (best.score - second < 1.0) conf = Math.min(conf, 0.45);
    return {
      issue: best.issue,
      chapter: best.chapter,
      chapter_title: best.title,
      confidence: Math.round(conf * 100) / 100,
    };
  }

  function baseRec(meta, filename, n, context, stem, mk) {
    return {
      id: `${slug(meta.school)}-${meta.year}-q${n}`,
      school: meta.school,
      year: meta.year,
      paper: meta.paper,
      question_number: n,
      context,
      stem,
      marks: mk,
      source_file: filename,
    };
  }

  function makeQ6(text, meta, filename, cfg) {
    const [context, stem] = splitContextStem(text);
    const c = classifyQ6(stem || text, cfg.categories);
    const rec = baseRec(meta, filename, 6, context, stem || text, marks(text));
    return Object.assign(rec, {
      bank: "Q6",
      category: c.category || c.raw,
      category_raw: c.raw,
      issue: null,
      chapter: null,
      chapter_title: null,
      confidence: c.confidence,
      needs_review: c.category === null || !meta.meta_ok,
    });
  }

  function makeQ7(text, meta, filename, cfg) {
    const [context, stem] = splitContextStem(text);
    const c = classifyQ7(text, cfg.issues);
    const rec = baseRec(meta, filename, 7, context, stem || text, marks(text));
    return Object.assign(rec, {
      bank: "Q7",
      category: null,
      category_raw: null,
      issue: c.issue,
      chapter: c.chapter,
      chapter_title: c.chapter_title,
      confidence: c.confidence,
      needs_review: c.issue === null || c.confidence < 0.5 || !meta.meta_ok,
    });
  }

  function extractFromSegments(segments, filename, cfg) {
    const qp = questionPaperRegion(segments);
    const meta = metadata(filename);
    const i6 = findStart(qp, 6),
      i7 = findStart(qp, 7),
      i8 = findStart(qp, 8);
    const records = [],
      warnings = [];

    if (i6 !== null) {
      const end = i7 !== null ? i7 : i8 !== null ? i8 : qp.length;
      records.push(makeQ6(blockText(qp, i6, end, 6), meta, filename, cfg));
    } else warnings.push("Q6 not found");

    if (i7 !== null) {
      let end = i8 !== null ? i8 : qp.length;
      for (let j = i7 + 1; j < end; j++) {
        if (/END OF (THE )?PAPER/i.test(qp[j].text)) {
          end = j;
          break;
        }
      }
      records.push(makeQ7(blockText(qp, i7, end, 7), meta, filename, cfg));
    } else warnings.push("Q7 not found");

    return { records, warnings, meta };
  }

  // Convert mammoth-produced HTML into ordered segments.
  function htmlToSegments(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const segs = [];
    function walk(node) {
      for (const el of node.children) {
        const tag = el.tagName.toLowerCase();
        if (tag === "table") {
          for (const tr of el.querySelectorAll("tr")) {
            const cells = [...tr.children].map((td) => norm(td.textContent));
            const text = norm(dedupCells(cells));
            if (text) segs.push({ kind: "row", text, cells: cells.map(norm) });
          }
        } else if (/^(p|h[1-6]|li|blockquote)$/.test(tag)) {
          const t = norm(el.textContent);
          if (t) segs.push({ kind: "para", text: t });
        } else if (el.children.length) {
          walk(el);
        }
      }
    }
    walk(doc.body);
    return segs;
  }

  global.ExtractCore = {
    norm,
    dedupCells,
    questionPaperRegion,
    findStart,
    blockText,
    classifyQ6,
    classifyQ7,
    extractFromSegments,
    htmlToSegments,
    metadata,
  };
})(window);
