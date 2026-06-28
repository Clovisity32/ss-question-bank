// Regression test: the admin console must absorb GitHub's read-after-write
// consistency lag. Right after a successful publish, a follow-up GET on the
// Contents API can return the previous sha, so the next PUT is rejected with
// 409 "does not match". Before the fix this surfaced as
// "Publish failed — 409 …" and forced the user to refresh the page.
// putWithRetry() in upload.js now re-fetches the head sha and retries.
//
// Run: npm install && npm test     (jsdom is a devDependency)
//
// Pattern follows CLAUDE.md "Testing pattern (jsdom)": runScripts "outside-only",
// stub fetch (local files + GitHub API) and window.mammoth, then drive the DOM.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { JSDOM } = require("jsdom");

const SITE = path.join(__dirname, "..", "site");
const read = (f) => fs.readFileSync(path.join(SITE, f), "utf8");

const dom = new JSDOM(read("upload.html"), {
  runScripts: "outside-only",
  url: "http://localhost:8000/upload.html",
});
const { window } = dom;

// ---- injected globals the site relies on ----
const { TextEncoder, TextDecoder } = require("util");
window.TextEncoder = TextEncoder;
window.TextDecoder = TextDecoder;
window.atob = (b) => Buffer.from(b, "base64").toString("binary");
window.btoa = (b) => Buffer.from(b, "binary").toString("base64");
window.confirm = () => true;

const errors = [];
window.addEventListener("error", (e) =>
  errors.push("window.error: " + (e.error?.stack || e.message)),
);
window.addEventListener("unhandledrejection", (e) =>
  errors.push("unhandledrejection: " + (e.reason?.stack || e.reason)),
);
process.on("unhandledRejection", (r) =>
  errors.push("node.unhandledRejection: " + (r?.stack || r)),
);

// ---- config the site fetches ----
const CONFIG = {
  categories: { strategies: ["strategy"] },
  issues: [
    {
      issue: 1,
      chapters: [{ chapter: 1, title: "Test Ch", keywords: ["agree"] }],
    },
  ],
};
const TAXONOMY = {
  categories: ["strategies"],
  issues: [{ issue: 1, chapters: [{ chapter: 1, title: "Test Ch" }] }],
};

// ---- fake GitHub repo (strongly consistent, except where we inject lag) ----
let repoContent = JSON.stringify([], null, 2);
let repoSha = "sha-0";
let prevSha = null;
let shaCounter = 0;
let staleNextGet = false; // when true, the next GET returns the previous sha once
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

const jsonResp = (obj, status = 200) =>
  Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(obj),
    text: () => Promise.resolve(JSON.stringify(obj)),
  });

window.fetch = (url, opts = {}) => {
  url = String(url);
  // GitHub Contents API — check FIRST (its URL also contains data/questions.json)
  if (url.includes("api.github.com")) {
    const method = opts.method || "GET";
    if (method === "GET" && staleNextGet) {
      staleNextGet = false; // simulate read-after-write lag: stale sha, once
      return jsonResp({ content: b64(repoContent), sha: prevSha });
    }
    if (method === "GET")
      return jsonResp({ content: b64(repoContent), sha: repoSha });
    if (method === "PUT") {
      const body = JSON.parse(opts.body);
      if (repoSha && body.sha !== repoSha) {
        return jsonResp({ message: "does not match" }, 409); // GitHub's sha conflict
      }
      repoContent = Buffer.from(body.content, "base64").toString("utf8");
      prevSha = repoSha;
      repoSha = "sha-" + ++shaCounter;
      return jsonResp({ content: { sha: repoSha } });
    }
  }
  if (url.includes("classify-config.json")) return jsonResp(CONFIG);
  if (url.includes("taxonomy.json")) return jsonResp(TAXONOMY);
  if (url.includes("data/questions.json"))
    return jsonResp(JSON.parse(repoContent));
  return jsonResp({ message: "unhandled " + url }, 404);
};

// mammoth stub: returns a minimal paper (one Q6 "give two" + one Q7 discursive)
window.mammoth = {
  convertToHtml: () =>
    Promise.resolve({
      value:
        "<p>Some Secondary School</p>" +
        "<p>Give two strategies to manage this issue. [4]</p>" +
        "<p>Do you agree that this is effective? Explain your answer. [8]</p>",
    }),
};

window.localStorage.setItem("ssqb_token", "fake-token");
window.localStorage.setItem("ssqb_repo", "Clovisity32/ss-question-bank");

// ---- run the real site scripts ----
const ctx = dom.getInternalVMContext();
vm.runInContext(read("extract-core.js"), ctx);
vm.runInContext(read("upload.js"), ctx);

// ---- drive ----
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => window.document.querySelector(s);
const setFiles = (input, files) =>
  Object.defineProperty(input, "files", { value: files, configurable: true });

async function pick(name) {
  const input = $("#file");
  setFiles(input, [
    { name, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) },
  ]);
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
  await wait(50);
}
async function clickPublish() {
  $("#publishBtn").click();
  await wait(2000); // cover the retry backoff (600ms) + network awaits
}
const draftCards = () =>
  window.document.querySelectorAll("#draftRows .rev-card").length;

(async () => {
  await wait(100); // init()

  await pick("StAndrews-2024-4E5N.docx");
  await clickPublish(); // publish #1 (advances the sha)

  await pick("Raffles-2024-4E5N.docx");
  staleNextGet = true; // GitHub hands back the stale sha on the next GET -> 409
  await clickPublish(); // publish #2 must recover via putWithRetry

  const publishStatus = $("#publishStatus").textContent;
  const pass =
    publishStatus.startsWith("✓ Published") &&
    draftCards() === 0 &&
    !errors.length;

  console.log("publishStatus:", JSON.stringify(publishStatus));
  console.log("draftCards:", draftCards(), "| errors:", errors.length);
  console.log(
    pass
      ? "PASS — stale-sha 409 absorbed by retry; no refresh needed"
      : "FAIL — second publish did not recover from the 409",
  );
  if (errors.length) console.log(errors.join("\n---\n"));
  process.exit(pass ? 0 : 1);
})();
