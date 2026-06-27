// Local review tool: load draft, correct fields, export questions.json.
// Runs entirely in the browser — nothing is uploaded.

let DATA = [];
let TAX = { categories: [], issues: [] };

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

async function load() {
  try {
    [DATA, TAX] = await Promise.all([
      fetch("data/questions.draft.json").then((r) => r.json()),
      fetch("data/taxonomy.json").then((r) => r.json()),
    ]);
  } catch (e) {
    $("#rows").innerHTML =
      `<p class="muted">Could not load draft data. Run <code>python pipeline/extract.py</code> first, ` +
      `then serve this folder (e.g. <code>python -m http.server -d site</code>).</p>`;
    return;
  }
  render();
}

function chapterOptions(selIssue, selChapter) {
  let html = `<option value="">— choose chapter —</option>`;
  for (const iss of TAX.issues) {
    for (const ch of iss.chapters) {
      const sel =
        iss.issue === selIssue && ch.chapter === selChapter ? "selected" : "";
      html += `<option value="${iss.issue}|${ch.chapter}" ${sel}>Issue ${iss.issue} · Ch ${ch.chapter}: ${esc(ch.title)}</option>`;
    }
  }
  return html;
}

function categoryOptions(sel) {
  const known = new Set(TAX.categories);
  let opts = [...TAX.categories];
  if (sel && !known.has(sel)) opts.unshift(sel); // keep an extracted-but-unknown noun
  let html = `<option value="">— choose category —</option>`;
  for (const c of opts)
    html += `<option value="${esc(c)}" ${c === sel ? "selected" : ""}>${esc(c)}</option>`;
  return html;
}

function card(q, idx) {
  const lowConf = (q.confidence ?? 0) < 0.6;
  const flagged = q.needs_review || lowConf;
  const confCls = lowConf ? "conf low" : "conf";
  const bankCtrls =
    q.bank === "Q6"
      ? `<label>Category (asks for two…)
         <select data-i="${idx}" data-f="category">${categoryOptions(q.category)}</select></label>`
      : `<label>Topic (Issue · Chapter)
         <select data-i="${idx}" data-f="topic">${chapterOptions(q.issue, q.chapter)}</select></label>`;

  return `<article class="rev-card ${flagged ? "flagged" : ""}">
    <div class="rev-top">
      <span class="badge">${q.bank}</span>
      <span class="${confCls}">conf ${(q.confidence ?? 0).toFixed(2)}</span>
      ${flagged ? `<span class="flag-pill">needs review</span>` : ""}
      <span class="muted">${esc(q.school || "?")} · ${esc(q.year || "?")} · ${esc(q.paper || "")}</span>
    </div>
    ${q.context ? `<p class="rev-context">${esc(q.context)}</p>` : ""}
    <p class="rev-stem">${esc(q.stem)}</p>
    <div class="rev-controls">
      ${bankCtrls}
      <label>School<input type="text" data-i="${idx}" data-f="school" value="${esc(q.school || "")}"></label>
      <label>Year<input type="number" data-i="${idx}" data-f="year" value="${esc(q.year || "")}"></label>
      <label>Paper<input type="text" data-i="${idx}" data-f="paper" value="${esc(q.paper || "")}"></label>
      <label>Marks<input type="number" data-i="${idx}" data-f="marks" value="${esc(q.marks ?? "")}"></label>
    </div>
  </article>`;
}

function render() {
  const flaggedOnly = $("#flaggedOnly").checked;
  const list = DATA.map((q, i) => ({ q, i }))
    .filter(
      ({ q }) => !flaggedOnly || q.needs_review || (q.confidence ?? 0) < 0.6,
    )
    .sort((a, b) => (a.q.confidence ?? 0) - (b.q.confidence ?? 0)); // lowest confidence first

  $("#rows").innerHTML =
    list.map(({ q, i }) => card(q, i)).join("") ||
    `<p class="muted">Nothing to show.</p>`;

  const flagged = DATA.filter(
    (q) => q.needs_review || (q.confidence ?? 0) < 0.6,
  ).length;
  $("#counts").textContent = `${DATA.length} questions · ${flagged} flagged`;
}

document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.matches("#flaggedOnly")) return render();
  const i = el.dataset.i;
  if (i === undefined) return;
  const q = DATA[i];
  const f = el.dataset.f;
  if (f === "topic") {
    if (el.value) {
      const [iss, ch] = el.value.split("|").map(Number);
      q.issue = iss;
      q.chapter = ch;
      q.chapter_title =
        TAX.issues
          .find((x) => x.issue === iss)
          ?.chapters.find((c) => c.chapter === ch)?.title || null;
    } else {
      q.issue = q.chapter = null;
      q.chapter_title = null;
    }
  } else if (f === "year" || f === "marks") {
    q[f] = el.value ? Number(el.value) : null;
  } else {
    q[f] = el.value || null;
  }
  // a human touched it → clear the flag
  q.needs_review = false;
  q.confidence = Math.max(q.confidence ?? 0, 0.9);
});

$("#downloadBtn").addEventListener("click", () => {
  // strip working-only fields for the published file
  const clean = DATA.map(({ category_raw, needs_review, ...keep }) => keep);
  const blob = new Blob([JSON.stringify(clean, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "questions.json";
  a.click();
  URL.revokeObjectURL(a.href);
  $("#status").textContent = "Downloaded — move it to site/data/questions.json";
});

load();
