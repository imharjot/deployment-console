// The Bedrock Converse adapter, over injected SDK calls so it is tested without AWS (the server module
// src/lib/server/agents/inference/bedrock.ts passes the real ConverseStream / ListFoundationModels / AssumeRole calls).
//
// Credentials come only from the connection (secret()): its own keys, or a role assumed with its own base keys. The
// console's AWS identity — the task role, the default credential chain — is never used for a model call: inference
// must not share the identity that can change infrastructure (AGENT_ARCHITECTURE §4).
import { bedrockCrossRegion, capabilitiesFor, checkRequest, modelOffered } from "./capabilities.ts";
import { bedrockError, buildConverseInput, createConverseStream, parseBedrockModels } from "./bedrock-wire.ts";
import { cleanMessage, streamBroke, toInferenceError } from "./errors.ts";
import { scrubbed, secretOf } from "./http-adapters.ts";
import { DEFAULT_IDLE_MS, StreamIdleError } from "./sse.ts";
import { InferenceError, isInferenceError, type GenerateRequest, type InferenceAdapter, type ModelInfo, type ResolvedConnection } from "./types.ts";

const LABEL = "Bedrock";

export interface AwsKeys {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiresAt?: number;
}

export interface BedrockDeps {
  converseStream(input: Record<string, unknown>, o: { region: string; credentials: AwsKeys; signal: AbortSignal }): Promise<{ stream?: AsyncIterable<unknown>; requestId?: string }>;
  listModels(o: { region: string; credentials: AwsKeys; signal?: AbortSignal }): Promise<{ foundation: unknown[]; profiles: unknown[] }>;
  assumeRole?(o: { roleArn: string; externalId?: string; source: AwsKeys; region: string; signal?: AbortSignal }): Promise<AwsKeys>;
  now?: () => number;
  cache?: Map<string, { at: number; value: unknown }>;
}

const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const ROLE_ARN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;
const REFRESH_BEFORE_MS = 5 * 60_000;

const keysOk = (k: { accessKeyId?: unknown; secretAccessKey?: unknown }) => typeof k.accessKeyId === "string" && !!k.accessKeyId && typeof k.secretAccessKey === "string" && !!k.secretAccessKey;

// The async iterable, item by item, cut off when it stays silent for idleMs (the abort makes the SDK close the stream)
// or when the caller's signal aborts. The iterator's return() is requested but never awaited: an async generator queues
// it behind a pending next(), which a stalled stream never settles.
async function* withIdle<T>(it: AsyncIterable<T>, idleMs: number, abort: AbortController, signal?: AbortSignal): AsyncGenerator<T> {
  const iter = it[Symbol.asyncIterator]();
  let finished = false;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const stop = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const e = new StreamIdleError(idleMs);
          abort.abort(e);
          reject(e);
        }, idleMs);
        onAbort = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
      try {
        const r = await Promise.race([iter.next(), stop]);
        if (r.done) {
          finished = true;
          return;
        }
        yield r.value;
      } finally {
        clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      }
    }
  } finally {
    if (!finished) iter.return?.()?.catch(() => {});
  }
}

export function createBedrockAdapter(deps: BedrockDeps): InferenceAdapter {
  const now = () => deps.now?.() ?? Date.now();
  const cache = deps.cache ?? new Map<string, { at: number; value: unknown }>();
  const caps = (id: string, reported?: Parameters<typeof capabilitiesFor>[2]) => capabilitiesFor("bedrock", id, reported);

  const regionOf = (conn: ResolvedConnection) => {
    const r = (conn.region ?? "").trim();
    if (!REGION.test(r)) throw new InferenceError("invalid_request", `${LABEL} connection needs a region`, { provider: LABEL });
    return r;
  };

  // The connection's AWS credentials: its keys, or its role assumed with its own base keys (cached until 5 minutes
  // before they expire). Never the console's identity.
  const credentialsOf = async (conn: ResolvedConnection, region: string, signal?: AbortSignal): Promise<AwsKeys> => {
    const s = await secretOf(conn, LABEL);
    if (s.kind === "aws") {
      if (!keysOk(s)) throw new InferenceError("auth", `${LABEL} connection's AWS keys are incomplete`, { provider: LABEL });
      if (s.expiresAt !== undefined && s.expiresAt <= now()) throw new InferenceError("auth", `${LABEL} connection's temporary AWS credentials have expired`, { provider: LABEL });
      return { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey, ...(s.sessionToken ? { sessionToken: s.sessionToken } : {}), ...(s.expiresAt ? { expiresAt: s.expiresAt } : {}) };
    }
    if (s.kind === "aws-role") {
      if (!ROLE_ARN.test(s.roleArn)) throw new InferenceError("invalid_request", `${LABEL} connection's role ARN is not valid`, { provider: LABEL });
      if (!s.source || !keysOk(s.source) || !deps.assumeRole)
        throw new InferenceError("auth", `${LABEL} role connections are assumed with the connection's own base credentials — the console's AWS identity is never used for model calls`, { provider: LABEL, code: "no-base-credentials" });
      const key = `bedrock-role|${conn.id}|${s.roleArn}|${s.externalId ?? ""}|${s.source.accessKeyId}`;
      const hit = cache.get(key)?.value as AwsKeys | undefined;
      if (hit && (hit.expiresAt ?? 0) - REFRESH_BEFORE_MS > now()) return hit;
      let keys: AwsKeys;
      try {
        keys = await deps.assumeRole({ roleArn: s.roleArn, externalId: s.externalId, source: s.source, region, signal });
      } catch (e) {
        const err = bedrockError(e);
        // Any refusal to assume the role is an authorisation problem for the person to fix, not an outage.
        throw err.kind === "unavailable" ? err : new InferenceError("auth", `${LABEL} couldn't assume the connection's role: ${cleanMessage((e as Error)?.message ?? e)}`, { provider: LABEL, code: err.code });
      }
      if (!keysOk(keys)) throw new InferenceError("auth", `${LABEL} role session returned no credentials`, { provider: LABEL });
      cache.set(key, { at: now(), value: keys });
      if (cache.size > 200) cache.delete(cache.keys().next().value!);
      return keys;
    }
    throw new InferenceError("auth", `${LABEL} connection has no AWS credentials`, { provider: LABEL });
  };

  // undefined = the credentials may call models but not list them (a least-privilege inference role).
  const list = async (conn: ResolvedConnection, signal?: AbortSignal): Promise<ModelInfo[] | undefined> => {
    const region = regionOf(conn);
    const credentials = await credentialsOf(conn, region, signal);
    try {
      const r = await deps.listModels({ region, credentials, signal });
      return parseBedrockModels(r.foundation, r.profiles, caps);
    } catch (e) {
      if (isInferenceError(e)) throw e;
      if ((e as { name?: string })?.name === "AccessDeniedException") return undefined;
      throw signal?.aborted ? toInferenceError(e, LABEL, signal) : bedrockError(e);
    }
  };

  const adapter: InferenceAdapter = {
    provider: "bedrock",
    label: LABEL,
    async models(conn, o = {}) {
      try {
        return (await list(conn, o.signal)) ?? (conn.model ? [{ id: conn.model, label: conn.model, capabilities: caps(conn.model) }] : []);
      } catch (e) {
        throw await scrubbed(conn, e, LABEL, o.signal);
      }
    },
    async validate(conn, o = {}) {
      const warnings = ["Bedrock lists every model offered in the region; whether this account was granted access to the model shows on its first call."];
      try {
        const models = await list(conn, o.signal);
        if (conn.model && (bedrockCrossRegion(conn.model) || models?.find((m) => m.id === conn.model)?.crossRegion)) warnings.push("this is a cross-region inference profile: requests may be processed outside the connection's region");
        if (!models) {
          warnings.push("these credentials can't list Bedrock models (bedrock:ListFoundationModels), so the model name wasn't checked");
          return conn.model ? { ok: true, model: conn.model, capabilities: caps(conn.model), warnings } : { ok: false, warnings, error: { kind: "invalid_request", message: `${LABEL} connection has no model selected` } };
        }
        const missing = modelOffered(models, conn.model, LABEL);
        if (missing) return { ok: false, models, warnings, error: { kind: missing.kind, message: missing.message } };
        return { ok: true, model: conn.model, models, capabilities: models.find((m) => m.id === conn.model)!.capabilities, warnings };
      } catch (e) {
        const err = await scrubbed(conn, e, LABEL, o.signal);
        return { ok: false, warnings, error: { kind: err.kind, message: err.message } };
      }
    },
    // Every failure comes back an InferenceError whose message the broker scrubbed of the connection's own secret (an
    // AWS signature error quotes the request's credential scope).
    async generate(conn: ResolvedConnection, req: GenerateRequest) {
      try {
        return await generate(conn, req);
      } catch (e) {
        throw await scrubbed(conn, e, LABEL, req.signal);
      }
    },
  };
  async function generate(conn: ResolvedConnection, req: GenerateRequest) {
    const model = (req.model ?? conn.model ?? "").trim();
    if (!model || model.length > 2048 || /\s/.test(model)) throw new InferenceError("invalid_request", `${LABEL} connection has no valid model selected`, { provider: LABEL });
    const c = caps(model);
    const eff = checkRequest(req, c, LABEL, model);
    const input = buildConverseInput(req, model, eff, c);
    const region = regionOf(conn);
    if (req.signal?.aborted) throw new InferenceError("cancelled", `${LABEL} request cancelled`, { provider: LABEL });
    const credentials = await credentialsOf(conn, region, req.signal);
    const abort = new AbortController();
    const onAbort = () => abort.abort(req.signal?.reason);
    req.signal?.addEventListener("abort", onAbort, { once: true });
    const stream = createConverseStream({ onEvent: req.onEvent, model });
    try {
      let res: { stream?: AsyncIterable<unknown>; requestId?: string };
      // The idle limit also bounds the wait for the stream to start.
      const idleMs = req.idleTimeoutMs ?? DEFAULT_IDLE_MS;
      const timer = setTimeout(() => abort.abort(new StreamIdleError(idleMs)), idleMs);
      try {
        res = await deps.converseStream(input, { region, credentials, signal: abort.signal });
      } catch (e) {
        if (req.signal?.aborted) throw new InferenceError("cancelled", `${LABEL} request cancelled`, { provider: LABEL });
        if (abort.signal.reason instanceof StreamIdleError) throw new InferenceError("unavailable", `${LABEL} did not start answering within ${Math.round(idleMs / 1000)} s`, { provider: LABEL, code: "timeout" });
        throw isInferenceError(e) ? e : (e as Error)?.name === "AbortError" || (e as Error)?.name === "TimeoutError" ? toInferenceError(e, LABEL) : bedrockError(e);
      } finally {
        clearTimeout(timer);
      }
      if (!res.stream) throw streamBroke(LABEL, "no-stream", "the answer had no stream", res.requestId);
      try {
        for await (const ev of withIdle(res.stream, idleMs, abort, req.signal)) stream.push(ev);
      } catch (e) {
        if (isInferenceError(e)) throw e;
        if (req.signal?.aborted) throw new InferenceError("cancelled", `${LABEL} request cancelled`, { provider: LABEL, requestId: res.requestId });
        if (e instanceof StreamIdleError) throw streamBroke(LABEL, "idle", e.message, res.requestId);
        // An exception the SDK raises from the event stream: before anything arrived it is the call's own error,
        // afterwards whatever arrived is unusable.
        if (!stream.started) throw bedrockError(e);
        throw streamBroke(LABEL, (e as Error)?.name, (e as Error)?.message, res.requestId);
      }
      if (req.signal?.aborted) throw new InferenceError("cancelled", `${LABEL} request cancelled`, { provider: LABEL, requestId: res.requestId });
      return stream.finish(res.requestId);
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
    }
  }
  return adapter;
}
