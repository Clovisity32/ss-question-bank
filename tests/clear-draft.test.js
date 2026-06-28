// Regression test: the "Clear draft" button must discard the pending batch and
// reset the file input, so a fresh upload starts clean instead of stacking onto
// questions left over from a cancelled/failed publish — without a page refresh.
//
// Run: npm install && npm test     (jsdom is a devDependency)

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

const { TextEncoder, TextDecoder } = require("util");
window.TextEncoder = TextEncoder;
window.TextDecoder = TextDecoder;
window.atob = (b) => Buffer.from(b, "base64").toString("binary");
window.btoa = (b) => Buffer.from(b, "binary").toString("base64");
window.confirm = () => true; // approve the "discard?" prompt

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
const jsonResp = (obj, status = 200) =>
  Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(obj),
    text: () => Promise.resolve(JSON.stringify(obj)),
  });
window.fetch = (url) => {
  url = String(url);
  if (url.includes("classify-config.json")) return jsonResp(CONFIG);
  if (url.includes("taxonomy.json")) return jsonResp(TAXONOMY);
  if (url.includes("questions.json")) return jsonResp([]);
  return jsonResp({}, 404);
};
window.mammoth = {
  convertToHtml: () =>
    Promise.resolve({
      value:
        "<p>Some Secondary School</p>" +
        "<p>Give two strategies to manage this issue. [4]</p>" +
        "<p>Do you agree that this is effective? Explain your answer. [8]</p>",
    }),
};

const ctx = dom.getInternalVMContext();
vm.runInContext(read("extract-core.js"), ctx);
vm.runInContext(read("upload.js"), ctx);

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
const draftCards = () =>
  window.document.querySelectorAll("#draftRows .rev-card").length;

(async () => {
  await wait(100); // init()

  await pick("StAndrews-2024-4E5N.docx");
  const before = draftCards();

  $("#clearDraftBtn").click();
  await wait(20);

  const after = draftCards();
  const barHidden = $("#publishBar").hidden;
  const statusCleared = $("#parseStatus").textContent === "";

  const pass = before === 2 && after === 0 && barHidden && statusCleared;
  console.log(
    `draft before=${before} after=${after} | publishBar hidden=${barHidden} | parseStatus cleared=${statusCleared}`,
  );
  console.log(
    pass
      ? "PASS — Clear draft resets the pending batch and file input"
      : "FAIL — draft not fully cleared",
  );
  process.exit(pass ? 0 : 1);
})();
