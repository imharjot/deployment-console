// For tests: client contracts are .tsx, which Node can't load. renderChild runs `body` (an ES module) in a child process
// that registers a small loader (TypeScript transpile for .tsx, "@/" and extensionless paths like Next), so it can
// import them and render with react-dom/server; it returns the JSON on the child's last output line. srcUrl(p) is the
// quoted URL of src/<p>, to paste into a body's import().
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);
export const srcUrl = (p: string) => JSON.stringify(new URL(`src/${p}`, root).href);

const hooks = `
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from ${JSON.stringify(new URL("node_modules/typescript/lib/typescript.js", root).href)};
const SRC = ${JSON.stringify(new URL("src/", root).href)};
const file = (p) => existsSync(p) && !statSync(p).isDirectory();
export async function resolve(spec, ctx, next) {
  let target;
  if (spec.startsWith("@/")) target = new URL(spec.slice(2), SRC).href;
  else if ((spec.startsWith("./") || spec.startsWith("../")) && ctx.parentURL?.startsWith("file:")) target = new URL(spec, ctx.parentURL).href;
  else return next(spec, ctx);
  const p = fileURLToPath(target);
  if (file(p)) return { url: target, shortCircuit: true };
  for (const e of [".ts", ".tsx", "/index.ts", "/index.tsx"]) if (file(p + e)) return { url: pathToFileURL(p + e).href, shortCircuit: true };
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (!url.endsWith(".tsx")) return next(url, ctx);
  const source = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: fileURLToPath(url),
  }).outputText;
  return { format: "module", source, shortCircuit: true };
}`;
const register = `import { register } from "node:module"; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hooks)}`)});`;

export const renderChild = (body: string) => {
  const out = execFileSync(process.execPath, ["--no-warnings", "--import", `data:text/javascript,${encodeURIComponent(register)}`, "--input-type=module", "-e", body], {
    encoding: "utf8",
    cwd: fileURLToPath(root),
    timeout: 60_000,
  });
  return JSON.parse(out.trim().split("\n").pop()!);
};
