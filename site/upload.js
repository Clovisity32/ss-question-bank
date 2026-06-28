// Admin console: parse .docx on-device, fully edit, publish; plus manage
// (edit / delete) questions already on the live site. The token is the lock.

let CFG = { categories: {}, issues: [] };
let TAX = { categories: [], issues: [] };
let DRAFT = []; // parsed, pending publish
let PUB = [],
  PUB_SHA = null; // loaded live bank, for editing/deleting
let EXISTING_IDS = new Set(); // ids already in the published bank (for dup warnings)

const confirmAction = (msg) => window.confirm(msg); // wrapper so it can be stubbed in tests

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const slug = (s) =>
  String(s || "x")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const LS = { repo: "ssqb_repo", token: "ssqb_token" };
const PATH = "site/data/questions.json";

async function init() {
  try {
    [CFG, TAX] = await Promise.all([
      fetch("data/classify-config.json").then((r) => r.json()),
      fetch("data/taxonomy.json").then((r) => r.json()),
    ]);
  } catch {
    $("#parseStatus").textContent =
      "Could not load config — serve the site over http.";
  }
  $("#catList").innerHTML = (TAX.categories || [])
    .map((c) => `<option value="${esc(c)}">`)
    .join("");
  $("#repo").value =
    localStorage.getItem(LS.repo) || "Clovisity32/ss-question-bank";
  // existing ids from the (public) live data — used to warn about duplicates
  try {
    const live = await fetch("data/questions.json?t=" + Date.now()).then((r) =>
      r.json(),
    );
    EXISTING_IDS = new Set(live.map((q) => q.id));
  } catch {
    /* first deploy may have none */
  }
  refreshTokenState();
  bind();
}

function refreshTokenState() {
  $("#tokenState").textContent = localStorage.getItem(LS.token)
    ? "· token saved ✓"
    : "· no token yet";
}

function bind() {
  $("#saveToken").addEventListener("click", () => {
    const t = $("#token").value.trim(),
      r = $("#repo").value.trim();
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
  });
  $("#file").addEventListener("change", onFiles);
  $("#clearDraftBtn").addEventListener("click", clearDraft);
  $("#publishBtn").addEventListener("click", publish);
  $("#loadBtn").addEventListener("click", loadPublished);
  $("#saveBtn").addEventListener("click", saveChanges);

  // one delegated handler for both editor lists
  document.addEventListener("input", onEdit);
  document.addEventListener("change", onEdit);
  document.addEventListener("click", onClick);
}

// ---------- parsing (multi-file) ----------
async function onFiles(e) {
  const files = [...e.target.files];
  if (!files.length) return;
  const notes = [];
  for (const f of files) {
    try {
      const buf = await f.arrayBuffer();
      const { value: html } = await window.mammoth.convertToHtml({
        arrayBuffer: buf,
      });
      const segs = window.ExtractCore.htmlToSegments(html);
      const { records, warnings } = window.ExtractCore.extractFromSegments(
        segs,
        f.name,
        CFG,
      );
      DRAFT.push(...records);
      notes.push(
        `✓ ${f.name}: ${records.length} question(s)` +
          (warnings.length ? ` — ⚠ ${warnings.join(", ")}` : ""),
      );
    } catch (err) {
      notes.push(`✗ ${f.name}: failed to parse (${err.message})`);
    }
  }
  e.target.value = ""; // allow re-selecting the same file later
  $("#parseStatus").innerHTML = notes.map(esc).join("<br>");
  renderDraft();
}

// ---------- shared editable card ----------
function topicOptions(q) {
  let html = `<option value="">— choose topic —</option>`;
  for (const iss of TAX.issues)
    for (const ch of iss.chapters) {
      const sel =
        iss.issue === q.issue && ch.chapter === q.chapter ? "selected" : "";
      html += `<option value="${iss.issue}|${ch.chapter}" ${sel}>Issue ${iss.issue} · Ch ${ch.chapter}: ${esc(ch.title)}</option>`;
    }
  return html;
}

function dupBadge(q, arr) {
  if (arr !== "draft") return "";
  const inBatch = DRAFT.filter((d) => d.id === q.id).length > 1;
  const inBank = EXISTING_IDS.has(q.id);
  if (inBatch)
    return `<span class="flag-pill dup">⚠ duplicate id in this upload</span>`;
  if (inBank)
    return `<span class="flag-pill warn">↻ already in bank — publishing overwrites it</span>`;
  return "";
}

function editorCard(q, arr, i) {
  const low = (q.confidence ?? 1) < 0.6;
  const flagged = q.needs_review || low;
  const bankField =
    q.bank === "Q6"
      ? `<label>Category (give two…)
         <input list="catList" data-arr="${arr}" data-i="${i}" data-f="category" value="${esc(q.category || "")}"></label>`
      : `<label>Topic (Issue · Chapter)
         <select data-arr="${arr}" data-i="${i}" data-f="topic">${topicOptions(q)}</select></label>`;
  return `<article class="rev-card ${flagged ? "flagged" : ""}" data-card="${arr}-${i}">
    <div class="rev-top">
      <label class="inline">Q-type
        <select data-arr="${arr}" data-i="${i}" data-f="bank">
          <option value="Q6" ${q.bank === "Q6" ? "selected" : ""}>Q6</option>
          <option value="Q7" ${q.bank === "Q7" ? "selected" : ""}>Q7</option>
        </select></label>
      ${q.confidence != null ? `<span class="conf ${low ? "low" : ""}">conf ${q.confidence.toFixed(2)}</span>` : ""}
      ${flagged ? `<span class="flag-pill">check this</span>` : ""}
      ${dupBadge(q, arr)}
      <button class="btn-ghost danger" data-del="${arr}" data-i="${i}">${arr === "pub" ? "Delete" : "Remove"}</button>
    </div>
    <div class="rev-controls">
      ${bankField}
      <label>School<input type="text" data-arr="${arr}" data-i="${i}" data-f="school" value="${esc(q.school || "")}"></label>
      <label>Year<input type="number" data-arr="${arr}" data-i="${i}" data-f="year" value="${esc(q.year ?? "")}"></label>
      <label>Exam / paper<input type="text" data-arr="${arr}" data-i="${i}" data-f="paper" value="${esc(q.paper || "")}"></label>
      <label>Q-number<input type="number" data-arr="${arr}" data-i="${i}" data-f="question_number" value="${esc(q.question_number ?? "")}"></label>
      <label>Marks<input type="number" data-arr="${arr}" data-i="${i}" data-f="marks" value="${esc(q.marks ?? "")}"></label>
    </div>
    <label class="full">Context (lead-in)
      <textarea rows="2" data-arr="${arr}" data-i="${i}" data-f="context">${esc(q.context || "")}</textarea></label>
    <label class="full">Question
      <textarea rows="3" data-arr="${arr}" data-i="${i}" data-f="stem">${esc(q.stem || "")}</textarea></label>
  </article>`;
}

const arrayOf = (name) => (name === "pub" ? PUB : DRAFT);

function renderDraft() {
  $("#draftRows").innerHTML = DRAFT.map((q, i) =>
    editorCard(q, "draft", i),
  ).join("");
  $("#publishBar").hidden = DRAFT.length === 0;
}
// Discard the pending (un-published) batch and reset the file input, so a new
// upload starts fresh instead of stacking onto questions left over from a
// cancelled/failed publish — no page refresh needed.
function clearDraft() {
  if (
    DRAFT.length &&
    !confirmAction(
      `Discard ${DRAFT.length} unpublished question(s) in this draft?`,
    )
  )
    return;
  DRAFT = [];
  $("#file").value = "";
  $("#parseStatus").textContent = "";
  renderDraft();
  set("#publishStatus", "Draft cleared.");
}
function renderPub() {
  $("#pubRows").innerHTML = PUB.map((q, i) => editorCard(q, "pub", i)).join("");
  $("#saveBar").hidden = PUB.length === 0 && PUB_SHA == null;
  $("#manageStatus").textContent = `${PUB.length} question(s) loaded`;
}

function reId(q) {
  q.id = `${slug(q.school)}-${q.year}-q${q.question_number}`;
}

function onEdit(e) {
  const el = e.target;
  const arr = el.dataset.arr;
  if (!arr || el.dataset.i === undefined) return;
  const list = arrayOf(arr);
  const q = list[el.dataset.i];
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
      q.issue = q.chapter = q.chapter_title = null;
    }
  } else if (f === "bank") {
    q.bank = el.value;
    if (q.bank === "Q6") {
      q.issue = q.chapter = q.chapter_title = null;
    } else {
      q.category = null;
    }
    (arr === "pub" ? renderPub : renderDraft)(); // swap category/topic control
    return;
  } else if (f === "year" || f === "marks" || f === "question_number") {
    q[f] = el.value === "" ? null : Number(el.value);
  } else {
    q[f] = el.value || null;
  }
  if (["school", "year", "question_number"].includes(f)) {
    reId(q);
    // refresh duplicate badges once the field is committed (blur), not per keystroke
    if (arr === "draft" && e.type === "change") renderDraft();
  }
}

function onClick(e) {
  const del = e.target.closest("[data-del]");
  if (!del) return;
  const arr = del.dataset.del;
  const q = arrayOf(arr)[Number(del.dataset.i)];
  if (
    arr === "pub" &&
    !confirmAction(
      `Delete this question from the live bank?\n\n${q.school || "?"} · ${q.bank} · ${(q.stem || "").slice(0, 70)}…\n\nIt is removed when you click “Save changes”.`,
    )
  )
    return;
  arrayOf(arr).splice(Number(del.dataset.i), 1);
  (arr === "pub" ? renderPub : renderDraft)();
}

// ---------- GitHub I/O ----------
const b64encode = (str) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(str)));
const b64decode = (b64) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(b64.replace(/\n/g, "")), (c) => c.charCodeAt(0)),
  );

function ctx() {
  const token = localStorage.getItem(LS.token);
  const repo = (localStorage.getItem(LS.repo) || "").trim();
  return {
    token,
    repo,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
    api: `https://api.github.com/repos/${repo}/contents/${PATH}`,
  };
}
async function getLive(c) {
  const r = await fetch(`${c.api}?ref=main`, { headers: c.headers });
  if (r.status === 404) return { arr: [], sha: null };
  if (!r.ok) throw new Error(`read failed (${r.status})`);
  const d = await r.json();
  return { arr: JSON.parse(b64decode(d.content)), sha: d.sha };
}
async function putLive(c, arr, sha, message) {
  const r = await fetch(c.api, {
    method: "PUT",
    headers: c.headers,
    body: JSON.stringify({
      message,
      content: b64encode(JSON.stringify(arr, null, 2)),
      sha: sha || undefined,
      branch: "main",
    }),
  });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
// PUT, retrying on 409. GitHub's Contents API is read-after-write *eventually*
// consistent: right after a successful write, a follow-up GET can still return
// the previous sha, so the next PUT is rejected with 409 "does not match". We
// re-fetch the head sha and retry instead of forcing the user to refresh.
async function putWithRetry(c, arr, message, sha, statusSel) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await putLive(c, arr, sha, message);
    } catch (err) {
      if (attempt < 2 && /^409:/.test(err.message)) {
        if (statusSel)
          set(statusSel, `Sync conflict — retrying (${attempt + 1}/2)…`);
        await sleep(600 * (attempt + 1));
        sha = (await getLive(c)).sha; // freshest sha, then retry
        continue;
      }
      throw err;
    }
  }
}
const cleanOut = (list) =>
  list.map(({ category_raw, needs_review, confidence, ...keep }) => keep);

// ---------- publish uploads ----------
async function publish() {
  const c = ctx();
  if (!c.token)
    return set("#publishStatus", "No token saved — add one in step 1.", true);
  if (!/^[^/]+\/[^/]+$/.test(c.repo))
    return set("#publishStatus", "Repo must be owner/name.", true);
  if (!DRAFT.length) return set("#publishStatus", "Nothing to publish.", true);
  set("#publishStatus", "Fetching current bank…");
  try {
    const { arr: existing, sha } = await getLive(c);
    const byId = new Map(existing.map((q) => [q.id, q]));
    let added = 0,
      updated = 0;
    for (const r of cleanOut(DRAFT)) {
      byId.has(r.id) ? updated++ : added++;
      byId.set(r.id, r);
    }
    if (
      updated &&
      !confirmAction(
        `Publish ${DRAFT.length} question(s)? ${updated} will overwrite an existing question with the same id, ${added} are new.`,
      )
    )
      return set("#publishStatus", "Publish cancelled.");
    const merged = [...byId.values()];
    await putWithRetry(
      c,
      merged,
      `data: add/update ${DRAFT.length} question(s) via admin`,
      sha,
      "#publishStatus",
    );
    merged.forEach((q) => EXISTING_IDS.add(q.id));
    DRAFT = [];
    renderDraft();
    set(
      "#publishStatus",
      `✓ Published ${added} new + ${updated} updated. Live in ~1 min.`,
    );
  } catch (err) {
    set("#publishStatus", `Publish failed — ${err.message}`, true);
  }
}

// ---------- manage published ----------
async function loadPublished() {
  const c = ctx();
  if (!c.token)
    return set("#manageStatus", "Add your token in step 1 first.", true);
  set("#manageStatus", "Loading…");
  try {
    const { arr, sha } = await getLive(c);
    PUB = arr;
    PUB_SHA = sha;
    EXISTING_IDS = new Set(PUB.map((q) => q.id));
    renderPub();
  } catch (err) {
    set("#manageStatus", `Load failed — ${err.message}`, true);
  }
}
async function saveChanges() {
  const c = ctx();
  if (!c.token)
    return set("#saveStatus", "Add your token in step 1 first.", true);
  if (
    !confirmAction(
      `Save changes to the live site?\n\nThis replaces the published bank with the ${PUB.length} question(s) shown here (any you deleted will be permanently removed).`,
    )
  )
    return set("#saveStatus", "Save cancelled.");
  set("#saveStatus", "Saving…");
  try {
    const { sha } = await getLive(c); // freshest sha to avoid conflicts
    await putWithRetry(
      c,
      cleanOut(PUB),
      `data: edit/delete via admin (${PUB.length} remain)`,
      sha,
      "#saveStatus",
    );
    EXISTING_IDS = new Set(PUB.map((q) => q.id));
    PUB_SHA = sha;
    set("#saveStatus", `✓ Saved ${PUB.length} question(s). Live in ~1 min.`);
  } catch (err) {
    set("#saveStatus", `Save failed — ${err.message}`, true);
  }
}

function set(sel, msg, err) {
  const el = $(sel);
  el.textContent = msg;
  el.style.color = err ? "#c0392b" : "var(--muted)";
}

init();
