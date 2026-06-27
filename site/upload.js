// Upload page: parse .docx in-browser -> classify (extract-core) -> review ->
// publish to GitHub (commit questions.json). The token is the publish lock.

let CFG = { categories: {}, issues: [] };
let TAX = { categories: [], issues: [] };
let DRAFT = []; // parsed records pending review/publish

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const LS = { repo: "ssqb_repo", token: "ssqb_token" };

async function init() {
  try {
    [CFG, TAX] = await Promise.all([
      fetch("data/classify-config.json").then((r) => r.json()),
      fetch("data/taxonomy.json").then((r) => r.json()),
    ]);
  } catch {
    $("#parseStatus").textContent =
      "Could not load config. Serve the site over http and try again.";
  }
  $("#repo").value =
    localStorage.getItem(LS.repo) || "Clovisity32/ss-question-bank";
  refreshTokenState();
  bind();
}

function refreshTokenState() {
  const has = !!localStorage.getItem(LS.token);
  $("#tokenState").textContent = has ? "· token saved ✓" : "· no token yet";
}

function bind() {
  $("#saveToken").addEventListener("click", () => {
    const t = $("#token").value.trim();
    const r = $("#repo").value.trim();
    if (r) localStorage.setItem(LS.repo, r);
    if (t) {
      localStorage.setItem(LS.token, t);
      $("#token").value = "";
    }
    refreshTokenState();
    $("#publishStatus").textContent = "Settings saved.";
  });
  $("#clearToken").addEventListener("click", () => {
    localStorage.removeItem(LS.token);
    refreshTokenState();
    $("#publishStatus").textContent = "Token forgotten.";
  });
  $("#file").addEventListener("change", onFiles);
  $("#publishBtn").addEventListener("click", publish);
  document.addEventListener("change", onEdit);
}

async function onFiles(e) {
  const files = [...e.target.files];
  if (!files.length) return;
  DRAFT = [];
  const notes = [];
  for (const f of files) {
    try {
      const buf = await f.arrayBuffer();
      const { value: html } = await window.mammoth.convertToHtml({
        arrayBuffer: buf,
      });
      const segs = window.ExtractCore.htmlToSegments(html);
      const { records, warnings, meta } =
        window.ExtractCore.extractFromSegments(segs, f.name, CFG);
      DRAFT.push(...records);
      const tag =
        `${f.name}: ${records.length} question(s)` +
        (warnings.length ? ` — ⚠ ${warnings.join(", ")}` : "");
      notes.push(tag);
      if (!meta.meta_ok) notes.push(`  (check school/year for ${f.name})`);
    } catch (err) {
      notes.push(`${f.name}: failed to parse (${err.message})`);
    }
  }
  $("#parseStatus").innerHTML = notes.map(esc).join("<br>");
  $("#reviewSection").hidden = DRAFT.length === 0;
  renderReview();
}

// ---- review UI (mirrors review.js) ----
function chapterOptions(selIssue, selChapter) {
  let html = `<option value="">— choose chapter —</option>`;
  for (const iss of TAX.issues)
    for (const ch of iss.chapters) {
      const sel =
        iss.issue === selIssue && ch.chapter === selChapter ? "selected" : "";
      html += `<option value="${iss.issue}|${ch.chapter}" ${sel}>Issue ${iss.issue} · Ch ${ch.chapter}: ${esc(ch.title)}</option>`;
    }
  return html;
}
function categoryOptions(sel) {
  const known = new Set(TAX.categories);
  const opts = [...TAX.categories];
  if (sel && !known.has(sel)) opts.unshift(sel);
  let html = `<option value="">— choose category —</option>`;
  for (const c of opts)
    html += `<option value="${esc(c)}" ${c === sel ? "selected" : ""}>${esc(c)}</option>`;
  return html;
}
function card(q, i) {
  const low = (q.confidence ?? 0) < 0.6;
  const flagged = q.needs_review || low;
  const ctrls =
    q.bank === "Q6"
      ? `<label>Category (asks for two…)<select data-i="${i}" data-f="category">${categoryOptions(q.category)}</select></label>`
      : `<label>Topic (Issue · Chapter)<select data-i="${i}" data-f="topic">${chapterOptions(q.issue, q.chapter)}</select></label>`;
  return `<article class="rev-card ${flagged ? "flagged" : ""}">
    <div class="rev-top">
      <span class="badge">${q.bank}</span>
      <span class="conf ${low ? "low" : ""}">conf ${(q.confidence ?? 0).toFixed(2)}</span>
      ${flagged ? `<span class="flag-pill">check this</span>` : ""}
      <span class="muted">${esc(q.school || "?")} · ${esc(q.year || "?")} · ${esc(q.paper || "")}</span>
    </div>
    ${q.context ? `<p class="rev-context">${esc(q.context)}</p>` : ""}
    <p class="rev-stem">${esc(q.stem)}</p>
    <div class="rev-controls">
      ${ctrls}
      <label>School<input type="text" data-i="${i}" data-f="school" value="${esc(q.school || "")}"></label>
      <label>Year<input type="number" data-i="${i}" data-f="year" value="${esc(q.year || "")}"></label>
      <label>Paper<input type="text" data-i="${i}" data-f="paper" value="${esc(q.paper || "")}"></label>
      <label>Marks<input type="number" data-i="${i}" data-f="marks" value="${esc(q.marks ?? "")}"></label>
    </div>
  </article>`;
}
function renderReview() {
  $("#rows").innerHTML = DRAFT.map((q, i) => card(q, i)).join("");
}
function onEdit(e) {
  const el = e.target;
  if (el.dataset.i === undefined) return;
  const q = DRAFT[el.dataset.i],
    f = el.dataset.f;
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
      q.issue = q.chapter = q.chapter_title = null;
    }
  } else if (f === "year" || f === "marks") {
    q[f] = el.value ? Number(el.value) : null;
  } else {
    q[f] = el.value || null;
  }
  // recompute id if school/year changed
  q.id = `${slug(q.school)}-${q.year}-q${q.question_number}`;
}
const slug = (s) =>
  String(s || "x")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// ---- GitHub publish ----
function b64encode(str) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(str)));
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
const PATH = "site/data/questions.json";

async function publish() {
  const token = localStorage.getItem(LS.token);
  const repo = (localStorage.getItem(LS.repo) || "").trim();
  if (!token) return setPub("No token saved — add one in step 1.", true);
  if (!/^[^/]+\/[^/]+$/.test(repo))
    return setPub("Repo must be owner/name.", true);
  if (!DRAFT.length) return setPub("Nothing to publish.", true);

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  };
  const api = `https://api.github.com/repos/${repo}/contents/${PATH}`;
  setPub("Fetching current bank…");
  try {
    let existing = [],
      sha = null;
    const g = await fetch(`${api}?ref=main`, { headers });
    if (g.ok) {
      const d = await g.json();
      sha = d.sha;
      existing = JSON.parse(b64decode(d.content));
    } else if (g.status !== 404) throw new Error(`read failed (${g.status})`);

    // merge by id (new entries override matching ids)
    const clean = DRAFT.map(({ category_raw, needs_review, ...keep }) => keep);
    const byId = new Map(existing.map((q) => [q.id, q]));
    let added = 0,
      updated = 0;
    for (const r of clean) {
      byId.has(r.id) ? updated++ : added++;
      byId.set(r.id, r);
    }
    const merged = [...byId.values()];

    setPub(`Publishing (${added} new, ${updated} updated)…`);
    const put = await fetch(api, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message: `data: add/update ${clean.length} question(s) via upload page`,
        content: b64encode(JSON.stringify(merged, null, 2)),
        sha: sha || undefined,
        branch: "main",
      }),
    });
    if (!put.ok)
      throw new Error(`${put.status}: ${(await put.text()).slice(0, 160)}`);
    setPub(
      `✓ Published ${added} new + ${updated} updated. Live in ~1 min: it will appear on the bank automatically.`,
    );
  } catch (err) {
    setPub(`Publish failed — ${err.message}`, true);
  }
}
function setPub(msg, err) {
  const el = $("#publishStatus");
  el.textContent = msg;
  el.style.color = err ? "#c0392b" : "var(--muted)";
}

init();
