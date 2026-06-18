// Builds a single self-contained HTML file with a results folder's data baked in.
// The recipient just double-clicks it — no install, no dragging, no instructions.
//
//   npm run share                       # newest package folder in ./out
//   npm run share -- out/columbus-oh-2026-06-15
//
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, basename } from "path";

const SUPPORTED = /\.(csv|md|markdown|txt)$/i;
const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function newestPackageDir() {
  const out = join(here, "out");
  if (!existsSync(out)) return null;
  const dirs = readdirSync(out)
    .map((d) => join(out, d))
    .filter((p) => statSync(p).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return dirs[0] ?? null;
}

const target = process.argv[2] ? join(process.cwd(), process.argv[2]) : newestPackageDir();
if (!target || !existsSync(target)) {
  console.error("\n  ✗ No results folder found. Run a hunt first, or pass a folder: npm run share -- out/<folder>\n");
  process.exit(1);
}
if (!statSync(target).isDirectory()) {
  console.error(`\n  ✗ ${target} is not a folder. Point this at a package folder inside out/.\n`);
  process.exit(1);
}

const files = readdirSync(target)
  .filter((f) => SUPPORTED.test(f))
  .map((f) => ({ name: f, path: `${basename(target)}/${f}`, text: readFileSync(join(target, f), "utf8") }));

if (!files.length) {
  console.error(`\n  ✗ No .csv or .md files in ${target}.\n`);
  process.exit(1);
}

const viewer = readFileSync(join(here, "viewer.html"), "utf8");
// Escape "<" so embedded "</script>" or "<" in data can't break out of the tag.
const payload = JSON.stringify(files).replace(/</g, "\\u003c");
const embed = `<script>window.__EMBEDDED=${payload};</script>`;
const html = viewer.replace("<!--EMBED-->", embed);

const outName = `${basename(target)}-shareable.html`;
const outPath = join(here, "out", outName);
writeFileSync(outPath, html, "utf8");

const kb = Math.round(html.length / 1024);
console.log(`\n  ✓ Built shareable report: out/${outName}  (${kb} KB, ${files.length} files baked in)`);
console.log(`    Send that ONE file to anyone — they just double-click it. No install, no folder needed.\n`);
