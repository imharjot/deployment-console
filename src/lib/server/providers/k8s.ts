// Minimal Kubernetes API client for EKS clusters: an IAM-authenticated bearer token (what `aws eks get-token` builds:
// a presigned STS GetCallerIdentity URL naming the cluster) and JSON requests over HTTPS that trust only the
// cluster's own CA. The token lives 60 s, is made per use, never logged and never leaves this module.
import "server-only";
import { request } from "node:https";
import { Hash } from "@smithy/hash-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { CLUSTER_ID_HEADER, TOKEN_TTL_S, presignedUrl, stsHost, tokenFromUrl } from "../../inventory/compute-eks.ts";
import { connectionCredentials } from "../connection-credentials.ts";

// Signed with the AWS connection's credentials: the token says who the cluster is talking to.
export async function eksToken(cluster: string, region: string): Promise<string> {
  const hostname = stsHost(region);
  const signer = new SignatureV4({ credentials: connectionCredentials, region, service: "sts", sha256: Hash.bind(null, "sha256") });
  const req = new HttpRequest({
    method: "GET", protocol: "https:", hostname, path: "/",
    query: { Action: "GetCallerIdentity", Version: "2011-06-15" },
    headers: { host: hostname, [CLUSTER_ID_HEADER]: cluster },
  });
  const signed = await signer.presign(req, { expiresIn: TOKEN_TTL_S });
  return tokenFromUrl(presignedUrl(signed));
}

export interface K8sTarget {
  endpoint: string; // https://….eks.amazonaws.com
  ca: string; // certificateAuthority.data: base64 of the PEM bundle
  token: string;
}

// status = HTTP status from the API server; code = socket-level error (ECONNREFUSED, ETIMEDOUT, ENOTFOUND…).
export class K8sError extends Error {
  status?: number;
  code?: string;
  constructor(message: string, o: { status?: number; code?: string }) {
    super(message);
    this.name = "K8sError";
    this.status = o.status;
    this.code = o.code;
  }
}

const MAX_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 8_000;

export function k8s<T>(t: K8sTarget, method: "GET" | "PATCH", path: string, o: { body?: unknown; contentType?: string; signal?: AbortSignal } = {}): Promise<T> {
  const url = new URL(path, t.endpoint);
  const body = o.body === undefined ? undefined : JSON.stringify(o.body);
  return new Promise<T>((resolve, reject) => {
    const req = request(
      {
        method, hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, servername: url.hostname,
        ca: Buffer.from(t.ca, "base64"), timeout: TIMEOUT_MS, signal: o.signal,
        headers: {
          Authorization: `Bearer ${t.token}`, Accept: "application/json", "User-Agent": "deployment-console",
          ...(body ? { "Content-Type": o.contentType ?? "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) req.destroy(new K8sError(`response larger than ${MAX_BYTES} bytes`, {}));
          else chunks.push(c);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status >= 400) {
            let msg = `HTTP ${status}`;
            try {
              msg = (JSON.parse(text) as { message?: string }).message?.slice(0, 300) || msg;
            } catch {
              // not a Status object
            }
            return reject(new K8sError(msg, { status }));
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            reject(new K8sError("the API server returned something that isn't JSON", { status }));
          }
        });
        res.on("error", (e: NodeJS.ErrnoException) => reject(new K8sError(e.message, { code: e.code })));
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    req.on("error", (e: NodeJS.ErrnoException) => reject(e instanceof K8sError ? e : new K8sError(e.message, { code: e.code ?? e.name })));
    if (body) req.write(body);
    req.end();
  });
}

// A cluster-wide list, paged 500 at a time, stopping at `cap` items.
export async function k8sList<T>(t: K8sTarget, path: string, cap: number, signal?: AbortSignal): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let next: string | undefined;
  do {
    const q = new URLSearchParams({ limit: String(Math.min(500, cap)) });
    if (next) q.set("continue", next);
    const r = await k8s<{ items?: T[]; metadata?: { continue?: string } }>(t, "GET", `${path}?${q}`, { signal });
    items.push(...(r.items ?? []));
    next = r.metadata?.continue || undefined;
  } while (next && items.length < cap);
  return { items: items.slice(0, cap), truncated: !!next || items.length > cap };
}
