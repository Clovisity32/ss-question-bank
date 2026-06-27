// Student-facing question bank.
// Top tabs: Q6 / Q7. Second-level tabs reveal questions ON CLICK:
//   Q6 -> one tab per question type (category)
//   Q7 -> one tab per Issue (questions grouped by chapter)
// A search term shows matches across the whole current bank (bypasses the
// click-to-reveal step); clearing it returns to the tab picker.

const state = { bank: "Q6", sub: null, search: "", school: "", year: "" };
let DATA = [];
let TAX = { categories: [], issues: [] };

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

async function init() {
  try {
    DATA = await fetch("data/questions.json").then((r) => {
      if (!r.ok) throw new Error();
      return r.json();
    });
  } catch {
    $("#results").innerHTML =
      `<p class="empty">No published questions yet.<br>Run the pipeline and review tool, ` +
      `then save <code>questions.json</code> into <code>site/data/</code>.</p>`;
    return;
  }
  try {
    TAX = await fetch("data/taxonomy.json").then((r) => r.json());
  } catch {
    /* optional */
  }

  buildMetaFilters();
  bindEvents();
  render();
}

function buildMetaFilters() {
  const schools = [
    ...new Set(DATA.map((q) => q.school).filter(Boolean)),
  ].sort();
  const years = [...new Set(DATA.map((q) => q.year).filter(Boolean))].sort(
    (a, b) => b - a,
  );
  $("#schoolFilter").insertAdjacentHTML(
    "beforeend",
    schools.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join(""),
  );
  $("#yearFilter").insertAdjacentHTML(
    "beforeend",
    years.map((y) => `<option value="${y}">${y}</option>`).join(""),
  );
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      state.bank = t.dataset.bank;
      state.sub = null; // collapse — require a fresh click on the new bank
      document
        .querySelectorAll(".tab")
        .forEach((x) => x.classList.toggle("active", x === t));
      render();
    }),
  );
  $("#search").addEventListener("input", (e) => {
    state.search = e.target.value.toLowerCase().trim();
    render();
  });
  $("#schoolFilter").addEventListener("change", (e) => {
    state.school = e.target.value;
    render();
  });
  $("#yearFilter").addEventListener("change", (e) => {
    state.year = e.target.value;
    render();
  });

  $("#subtabs").addEventListener("click", (e) => {
    const b = e.target.closest(".subtab");
    if (!b) return;
    state.sub = b.dataset.sub === state.sub ? null : b.dataset.sub; // toggle off if re-clicked
    render();
  });
}

// meta filter (school/year/search) — NOT the sub-tab selection
function matchesMeta(q) {
  if (q.bank !== state.bank) return false;
  if (state.school && q.school !== state.school) return false;
  if (state.year && String(q.year) !== state.year) return false;
  if (state.search) {
    const hay =
      `${q.context || ""} ${q.stem || ""} ${q.category || ""} ${q.chapter_title || ""}`.toLowerCase();
    if (!hay.includes(state.search)) return false;
  }
  return true;
}

const subKey = (q) =>
  state.bank === "Q6" ? q.category || "uncategorised" : String(q.issue ?? "0");

function render() {
  renderSubtabs();
  const pool = DATA.filter(matchesMeta);

  // Search mode: show all matches across the bank, ignoring the click-to-reveal step.
  if (state.search) {
    $("#results").innerHTML = pool.length
      ? state.bank === "Q6"
        ? groupByCategory(pool)
        : groupByChapter(pool)
      : `<p class="empty">No questions match “${esc(state.search)}”.</p>`;
    return;
  }

  // No sub-tab chosen yet -> prompt the user to click one.
  if (!state.sub) {
    const prompt =
      state.bank === "Q6"
        ? "Select a question type above to view its questions."
        : "Select an issue above to view its questions.";
    $("#results").innerHTML = `<p class="empty">${prompt}</p>`;
    return;
  }

  const items = pool.filter((q) => subKey(q) === state.sub);
  if (!items.length) {
    $("#results").innerHTML =
      `<p class="empty">No questions here with the current filters.</p>`;
    return;
  }
  $("#results").innerHTML =
    state.bank === "Q6" ? groupByCategory(items) : groupByChapter(items);
}

function renderSubtabs() {
  const pool = DATA.filter(matchesMeta);
  const counts = {};
  for (const q of pool) counts[subKey(q)] = (counts[subKey(q)] || 0) + 1;

  let tabs = [];
  if (state.bank === "Q6") {
    const present = new Set(
      DATA.filter((q) => q.bank === "Q6").map(
        (q) => q.category || "uncategorised",
      ),
    );
    const ordered = [
      ...(TAX.categories || []),
      ...[...present].filter((c) => !TAX.categories.includes(c)),
    ].filter((c) => present.has(c));
    tabs = ordered.map((c) => subtab(c, c, counts[c] || 0));
  } else {
    for (const iss of TAX.issues.length
      ? TAX.issues
      : derivedIssues(DATA.filter((q) => q.bank === "Q7"))) {
      const key = String(iss.issue);
      if (DATA.some((q) => q.bank === "Q7" && String(q.issue) === key)) {
        tabs.push(
          subtab(key, `Issue ${iss.issue}: ${iss.title}`, counts[key] || 0),
        );
      }
    }
  }
  $("#subtabs").innerHTML = tabs.join("");
  $("#subtabs").style.display = state.search ? "none" : "flex"; // hide picker during search
}

function subtab(value, label, n) {
  const active = state.sub === value ? "active" : "";
  return `<button class="subtab ${active}" data-sub="${esc(value)}">${esc(label)}<span class="n">${n}</span></button>`;
}

function groupByCategory(items) {
  const groups = groupBy(items, (q) => q.category || "uncategorised");
  return Object.keys(groups)
    .sort()
    .map(
      (cat) =>
        `<section><h2 class="group-title">give two ${esc(cat)} · ${groups[cat].length}</h2>` +
        groups[cat].map(card).join("") +
        `</section>`,
    )
    .join("");
}

function groupByChapter(items) {
  const groups = groupBy(items, (q) =>
    q.issue
      ? `Issue ${q.issue} · Ch ${q.chapter}: ${q.chapter_title || ""}`
      : "Unassigned",
  );
  return Object.keys(groups)
    .sort()
    .map(
      (g) =>
        `<section><h2 class="group-title">${esc(g)} · ${groups[g].length}</h2>` +
        groups[g].map(card).join("") +
        `</section>`,
    )
    .join("");
}

function card(q) {
  const tagCls = q.bank === "Q6" ? "q6" : "q7";
  const tag =
    q.bank === "Q6"
      ? `give two ${esc(q.category || "?")}`
      : `Issue ${q.issue ?? "?"} · Ch ${q.chapter ?? "?"}`;
  return `<article class="card">
    <div class="card-top">
      <span class="tag ${tagCls}">${tag}</span>
      ${q.marks != null ? `<span class="marks">[${q.marks} marks]</span>` : ""}
    </div>
    ${q.context ? `<p class="context">${esc(q.context)}</p>` : ""}
    <p class="stem">${esc(q.stem)}</p>
    <p class="source">${esc(q.school || "")} · ${esc(q.paper || "")} · ${esc(q.year || "")}</p>
  </article>`;
}

// ---- helpers ----
function groupBy(arr, fn) {
  const o = {};
  for (const x of arr) {
    const k = fn(x);
    (o[k] = o[k] || []).push(x);
  }
  return o;
}
function derivedIssues(pool) {
  const m = {};
  for (const q of pool)
    if (q.issue) {
      m[q.issue] = m[q.issue] || { issue: q.issue, title: "", chapters: {} };
      m[q.issue].chapters[q.chapter] = {
        chapter: q.chapter,
        title: q.chapter_title,
      };
    }
  return Object.values(m).sort((a, b) => a.issue - b.issue);
}

init();
