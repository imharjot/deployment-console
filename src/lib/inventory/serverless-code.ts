// Checks on a Lambda deployment package before it is uploaded: base64 decoding, the 8 MB cap, "is this really a zip",
// the files it holds (read from the zip's central directory — nothing is decompressed) and whether the handler's
// file is among them, plus the SHA-256 in the base64 form Lambda reports as CodeSha256. Pure (node:crypto only), no
// `server-only`, so node:test runs it; kept apart from serverless-common.ts so UI code never pulls in node:crypto.
import { createHash } from "node:crypto";
import { fmtBytes } from "./serverless-common.ts";

export const MAX_ZIP_BYTES = 8 * 1024 * 1024;
export const MAX_ZIP_BASE64 = Math.ceil(MAX_ZIP_BYTES / 3) * 4;

export interface ZipCheck {
  bytes?: Uint8Array;
  problem?: string;
}

// base64 → bytes, refusing anything that isn't base64, is empty, too big, or doesn't start like a zip.
export function decodeZip(b64: string, max = MAX_ZIP_BYTES): ZipCheck {
  const clean = b64.replace(/\s+/g, "").replace(/^data:[^,]*;base64,/, "");
  if (!clean) return { problem: "the package is empty" };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean) || clean.length % 4 === 1) return { problem: "zipBase64 isn't valid base64" };
  if (clean.length > Math.ceil(max / 3) * 4 + 4) return { problem: `the package is over ${fmtBytes(max)}` };
  const bytes = new Uint8Array(Buffer.from(clean, "base64"));
  if (bytes.length > max) return { problem: `the package is ${fmtBytes(bytes.length)} — at most ${fmtBytes(max)}; upload bigger packages to S3 and deploy from s3Bucket/s3Key` };
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || !((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6))) return { problem: "the package isn't a .zip file" };
  return { bytes };
}

// File names in a zip, from its central directory. undefined when the directory can't be read (corrupt, zip64).
export function zipEntries(bytes: Uint8Array, maxEntries = 20_000): string[] | undefined {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: signature 0x06054b50, within the last 64 KiB + 22 bytes (the comment is ≤ 65,535).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return undefined;
  const count = v.getUint16(eocd + 10, true);
  const offset = v.getUint32(eocd + 16, true);
  if (count === 0xffff || offset === 0xffffffff) return undefined; // zip64: not expected under 8 MB
  const names: string[] = [];
  const dec = new TextDecoder();
  let p = offset;
  for (let n = 0; n < count && n < maxEntries; n++) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50) return undefined;
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    if (p + 46 + nameLen > bytes.length) return undefined;
    names.push(dec.decode(bytes.subarray(p + 46, p + 46 + nameLen)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

// Lambda reports CodeSha256 as the base64 of the package's SHA-256 digest; the plan shows the same form to compare.
export const codeSha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("base64");

// Files the handler setting can live in, for runtimes where that's knowable ("index.handler" on Node → index.js,
// index.mjs, index.cjs). undefined for compiled runtimes (Java, .NET, Go, custom) — nothing to check there.
export function handlerFiles(runtime: string | undefined, handler: string | undefined): string[] | undefined {
  if (!runtime || !handler) return undefined;
  const dot = handler.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const mod = handler.slice(0, dot);
  if (runtime.startsWith("nodejs")) return [".js", ".mjs", ".cjs"].map((x) => `${mod}${x}`);
  if (runtime.startsWith("python")) return [`${mod.replace(/\./g, "/")}.py`];
  if (runtime.startsWith("ruby")) return [`${mod}.rb`];
  return undefined;
}

export interface PackageSummary {
  size: number;
  sha256: string;
  files?: number;
  handlerFound?: boolean; // undefined = not checkable
  warnings: string[];
}

// What the deploy plan shows about an uploaded zip.
export function summarizePackage(bytes: Uint8Array, runtime?: string, handler?: string): PackageSummary {
  const names = zipEntries(bytes);
  const warnings: string[] = [];
  const want = handlerFiles(runtime, handler);
  let handlerFound: boolean | undefined;
  if (!names) warnings.push("couldn't read the zip's file list — Lambda will reject it if it's corrupt");
  else if (want) {
    handlerFound = names.some((n) => want.includes(n));
    if (!handlerFound) warnings.push(`the handler "${handler}" expects ${want.join(" or ")} at the zip's top level — not found; the function will fail to start`);
  }
  return { size: bytes.length, sha256: codeSha256(bytes), files: names?.filter((n) => !n.endsWith("/")).length, handlerFound, warnings };
}
