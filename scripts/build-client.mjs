// Zero-dependency client build: strips TypeScript types with Node's built-in stripper and copies static files.
import { mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";

const src = "src/client";
const out = "public";
mkdirSync(join(out, "js"), { recursive: true });
for (const f of readdirSync(src)) {
  if (f.endsWith(".ts")) {
    const code = stripTypeScriptTypes(readFileSync(join(src, f), "utf8"), { mode: "strip" });
    writeFileSync(join(out, "js", f.replace(/\.ts$/, ".js")), code.replace(/(from\s+["'][^"']+)\.ts(["'])/g, "$1.js$2"));
  } else if (/\.(html|css|svg)$/.test(f)) copyFileSync(join(src, f), join(out, f));
}
console.log("client built");
