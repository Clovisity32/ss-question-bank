// Student-facing question bank. Loads data/questions.json (+ optional taxonomy
// for ordering) and renders Q6-by-category / Q7-by-topic with search & filters.

const state = { bank: "Q6", category: "", search: "", school: "", year: "" };
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
      state.category = "";
      document
        .querySelectorAll(".tab")
        .forEach((x) => x.classList.toggle("active", x === t));
      render();
    }),
  );
  $("#search").addEventListener("input", (e) => {
    state.search = e.target.value.toLowerCase();
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
}

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

function render() {
  renderChips();
  const pool = DATA.filter(matchesMeta);
  const items =
    state.bank === "Q6"
      ? pool.filter((q) => !state.category || q.category === state.category)
      : pool.filter(
          (q) =>
            !state.category || `${q.issue}|${q.chapter}` === state.category,
        );

  if (!items.length) {
    $("#results").innerHTML = `<p class="empty">No matching questions.</p>`;
    return;
  }
  $("#results").innerHTML =
    state.bank === "Q6" ? groupQ6(items) : groupQ7(items);
}

function renderChips() {
  const pool = DATA.filter(matchesMeta);
  let chips;
  if (state.bank === "Q6") {
    const counts = countBy(pool, (q) => q.category);
    const order = (
      TAX.categories.length ? TAX.categories : Object.keys(counts)
    ).filter((c) => counts[c]);
    chips = order.map((c) => chip(c, c, counts[c]));
  } else {
    const counts = countBy(pool, (q) =>
      q.issue ? `${q.issue}|${q.chapter}` : null,
    );
    chips = [];
    for (const iss of TAX.issues.length ? TAX.issues : derivedIssues(pool)) {
      for (const ch of iss.chapters) {
        const key = `${iss.issue}|${ch.chapter}`;
        if (counts[key])
          chips.push(chip(key, `I${iss.issue}·Ch${ch.chapter}`, counts[key]));
      }
    }
  }
  $("#chips").innerHTML = chip("", "All", pool.length) + chips.join("");
}

function chip(value, label, n) {
  const active = state.category === value ? "active" : "";
  return `<button class="chip ${active}" data-cat="${esc(value)}">${esc(label)}<span class="n">${n}</span></button>`;
}

$("#chips") &&
  document.addEventListener("click", (e) => {
    const c = e.target.closest(".chip");
    if (!c) return;
    state.category = c.dataset.cat;
    render();
  });

function groupQ6(items) {
  const groups = groupBy(items, (q) => q.category || "uncategorised");
  return Object.keys(groups)
    .sort()
    .map(
      (cat) =>
        `<section><h2 class="group-title">${esc(cat)} · ${groups[cat].length}</h2>` +
        groups[cat].map(card).join("") +
        `</section>`,
    )
    .join("");
}

function groupQ7(items) {
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
function countBy(arr, fn) {
  const o = {};
  for (const x of arr) {
    const k = fn(x);
    if (k) o[k] = (o[k] || 0) + 1;
  }
  return o;
}
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
      m[q.issue] = m[q.issue] || { issue: q.issue, chapters: {} };
      m[q.issue].chapters[q.chapter] = {
        chapter: q.chapter,
        title: q.chapter_title,
      };
    }
  return Object.values(m)
    .sort((a, b) => a.issue - b.issue)
    .map((i) => ({
      issue: i.issue,
      chapters: Object.values(i.chapters).sort((a, b) => a.chapter - b.chapter),
    }));
}

init();
