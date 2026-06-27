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
    /(In your opinion\b|Do you think\b|Do you agree\b|Do you feel\b|Do you believe\b|To what extent\b|What can\b|What are\b|What do\b|Why \b|Why do\b|How can\b|How far\b|How do\b|Suggest\b|Explain how\b)/i;

  // Content signatures used to locate the two Section-B questions without relying
  // on a printed number (some papers auto-number, leaving no number in the text).
  const Q7_TRIGGER =
    /\b(Do you think|Do you agree|Do you feel|Do you believe|To what extent|How far do you agree)\b/i;
  // Q6 always asks for "two <noun>" — the reliable structural signal (a discursive
  // Q6 like "why do you think…" still has this; "some of the…" must NOT match).
  const GIVE_TWO = /\btwo\s+[a-z]+/i;
  const HAS_MARKS = /\[\s*\d+\s*\]/;
  // does a (number-stripped) line begin with the instruction itself (no inline lead-in)?
  const INSTRUCTION_START =
    /^(In your opinion|Do you think|Do you agree|Do you feel|Do you believe|To what extent|How far|Suggest|Why do you|How can|What can|What are|What do|Explain how)/i;
  const BARE_LABEL = /^(extract|source)\s*\d*\s*:?\s*$/i;
  const END_PAPER = /(^|~\s*)end of (the )?paper/i;

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

  const SCHOOL_RE =
    /([A-Z][A-Za-z.'()&/-]*(?:\s+[A-Z][A-Za-z.'()&/-]*){0,4}?\s+(?:SECONDARY SCHOOL|INSTITUTION|JUNIOR COLLEGE|HIGH SCHOOL))/i;
  const titleCase = (s) =>
    s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

  function detectSchool(segments) {
    for (const seg of segments.slice(0, 14)) {
      const m = SCHOOL_RE.exec(seg.text);
      if (m) {
        let name = m[1].replace(/\s+/g, " ").trim();
        name = name.replace(/^(?:[A-Z]\s+)+/, ""); // drop stray leading logo letters
        name = name
          .replace(/\s*\b(secondary school|high school)\b/i, "")
          .trim();
        return name === name.toUpperCase() ? titleCase(name) : name;
      }
    }
    return null;
  }

  function metadata(filename, segments) {
    const stem = filename.replace(/\.[^.]+$/, "");
    const ym = stem.match(/(20\d{2})/);
    const year = ym ? parseInt(ym[1], 10) : null;
    let school = detectSchool(segments || []);
    if (!school) {
      for (const tok of stem.match(/[A-Z]{2,}(?:\([A-Za-z]+\))?/g) || []) {
        if (!STOP_TOKENS.has(tok.toUpperCase())) {
          school = tok;
          break;
        }
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

  const stripNum = (t) => t.replace(/^\s*[67][.)\s]+/, "").trim();

  // Does this question line already carry its own lead-in, or do we need to pull
  // the short context sentence from the preceding segment?
  const needsContext = (seg) => INSTRUCTION_START.test(stripNum(seg.text));

  // Short lead-in sentence (e.g. "Extract 1 states ...") — never a source passage.
  function contextLike(seg) {
    const t = seg.text;
    return !!t && t.length <= 240 && !BARE_LABEL.test(t) && !HAS_MARKS.test(t);
  }
  function findContext(qp, idx, otherIdx) {
    for (let j = idx - 1; j >= Math.max(0, idx - 3); j--) {
      if (j === otherIdx) break;
      if (BARE_LABEL.test(qp[j].text)) continue; // skip "Extract 1" labels
      return contextLike(qp[j]) ? qp[j].text : "";
    }
    return "";
  }
  function buildText(qp, idx, otherIdx) {
    const body = stripNum(qp[idx].text);
    const ctx = needsContext(qp[idx]) ? findContext(qp, idx, otherIdx) : "";
    return (ctx ? ctx + " " : "") + body;
  }

  function extractFromSegments(segments, filename, cfg) {
    let qp = questionPaperRegion(segments);
    for (let i = 0; i < qp.length; i++) {
      if (END_PAPER.test(qp[i].text)) {
        qp = qp.slice(0, i);
        break;
      } // drop acknowledgements
    }
    const meta = metadata(filename, segments);
    const records = [],
      warnings = [];

    // Q6 = the "two <noun> [marks]" line (the SRQ "give two" question).
    let q6i = -1;
    for (let i = qp.length - 1; i >= 0; i--) {
      if (GIVE_TWO.test(qp[i].text) && HAS_MARKS.test(qp[i].text)) {
        q6i = i;
        break;
      }
    }
    // Q7 = a discursive line that is NOT the "two <noun>" question. Prefer one
    // after Q6 with marks; otherwise search the whole region.
    let q7i = -1;
    const pickQ7 = (from) => {
      for (let i = from; i < qp.length; i++) {
        if (i === q6i) continue;
        if (Q7_TRIGGER.test(qp[i].text) && !GIVE_TWO.test(qp[i].text)) {
          q7i = i;
          if (HAS_MARKS.test(qp[i].text)) return true;
        }
      }
      return q7i >= 0;
    };
    if (!(q6i >= 0 && pickQ7(q6i + 1))) pickQ7(0);

    // Fallback to the old printed-number anchor if content detection missed.
    if (q6i < 0) {
      const f = findStart(qp, 6);
      if (f !== null) q6i = f;
    }
    if (q7i < 0) {
      const f = findStart(qp, 7);
      if (f !== null && f !== q6i) q7i = f;
    }

    if (q6i >= 0)
      records.push(makeQ6(buildText(qp, q6i, q7i), meta, filename, cfg));
    else warnings.push("Q6 not found");
    if (q7i >= 0)
      records.push(makeQ7(buildText(qp, q7i, q6i), meta, filename, cfg));
    else warnings.push("Q7 not found");

    return { records, warnings, meta };
  }

  // textContent but with spaces inserted between block elements, so two stacked
  // <p>s in one cell don't fuse ("learning." + "In your opinion" -> with a space).
  function textOf(el) {
    let out = "";
    for (const n of el.childNodes) {
      if (n.nodeType === 3) out += n.textContent;
      else if (n.nodeType === 1) {
        const t = n.tagName.toLowerCase();
        const inner = textOf(n);
        out += /^(p|div|br|li|h[1-6]|tr|table|blockquote)$/.test(t)
          ? " " + inner + " "
          : inner;
      }
    }
    return out;
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
            const cells = [...tr.children].map((td) => norm(textOf(td)));
            const text = norm(dedupCells(cells));
            if (text) segs.push({ kind: "row", text, cells });
          }
        } else if (/^(p|h[1-6]|li|blockquote)$/.test(tag)) {
          const t = norm(textOf(el));
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
