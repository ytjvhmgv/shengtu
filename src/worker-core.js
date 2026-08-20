/**
 * CF Flux Pool — 用导入的 Cloudflare Workers AI 号池轮询生图。
 *
 * 核心策略：
 * - 账号轮询，成功后指针前移，把额度摊开
 * - 某号当天神经元用尽 / 日配额耗尽：标记到 UTC 次日，当天不再请求该号
 * - 401/403 停用 12 小时；429 冷却 3 分钟；5xx 冷却 1 分钟
 * - 请求体错误不换号死磕，直接返回
 */

const MODELS = [
  { id: "flux-2-klein-4b", name: "FLUX.2 Klein 4B", hint: "最快 · 推荐", cf: "@cf/black-forest-labs/flux-2-klein-4b", mode: "multipart", caps: ["txt2img", "img2img"] },
  { id: "flux-2-klein-9b", name: "FLUX.2 Klein 9B", hint: "更快更高清", cf: "@cf/black-forest-labs/flux-2-klein-9b", mode: "multipart", caps: ["txt2img", "img2img"] },
  { id: "flux-2-dev", name: "FLUX.2 Dev", hint: "高质量", cf: "@cf/black-forest-labs/flux-2-dev", mode: "multipart", caps: ["txt2img", "img2img"] },
  { id: "flux-1-schnell", name: "FLUX.1 Schnell", hint: "老款极速 JSON", cf: "@cf/black-forest-labs/flux-1-schnell", mode: "json", caps: ["txt2img"] },
];

const ASPECT = {
  "1:1": [1024, 1024],
  "16:9": [1280, 720],
  "9:16": [720, 1280],
  "4:3": [1024, 768],
  "3:4": [768, 1024],
  "3:2": [1152, 768],
  "2:3": [768, 1152],
};

const PAGE = __PAGE__;
const EMBEDDED_POOL = __POOL__;

const STATE_URL = "https://cf-flux-pool.internal/state";
const MAX_TRIES = 24;
let memState = null;

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    try {
      return cors(await handle(request, env, ctx));
    } catch (err) {
      return cors(json({ error: formatError(err) }, err.status || 500));
    }
  },
};

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "GET" && path === "/") {
    return new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  if (request.method === "GET" && (path === "/api/models" || path === "/v1/models")) {
    return json({
      default: env.DEFAULT_MODEL || "flux-2-klein-4b",
      items: {
        "Cloudflare Workers AI 号池": MODELS.map((m) => ({
          id: m.id,
          name: m.name,
          hint: m.hint,
          capabilities: m.caps,
        })),
      },
    });
  }

  if (request.method === "GET" && path === "/api/health") {
    const pool = getPool(env);
    return json(await readHealth(env, pool));
  }

  if (request.method === "GET" && path === "/api/accounts") {
    requireAccess(request, env);
    const pool = getPool(env);
    return json(await readAccountStatus(env, pool));
  }

  if (request.method === "GET" && path.startsWith("/api/tasks/")) {
    requireAccess(request, env);
    const id = path.slice("/api/tasks/".length);
    const task = await getTask(id);
    if (!task) return json({ error: "任务不存在或已过期" }, 404);
    return json(task);
  }

  if (request.method === "GET" && path.startsWith("/api/jobs/")) {
    requireAccess(request, env);
    const id = path.slice("/api/jobs/".length).split("/")[0];
    const job = await readJob(env, id);
    if (!job) return json({ error: "任务不存在" }, 404);
    return json(job);
  }

  if (request.method === "POST" && path === "/api/generate/stream") {
    requireAccess(request, env);
    const body = await readBody(request);
    return streamGenerate(env, body, ctx);
  }

  if (request.method === "POST" && (path === "/api/generate/async" || path === "/v1/generate/async")) {
    requireAccess(request, env);
    const body = await readBody(request);
    const id = crypto.randomUUID();
    const t0 = Date.now();
    try {
      const result = await generate(env, body);
      return json({ id, status: "completed", duration_sec: (Date.now() - t0) / 1000, ...result });
    } catch (err) {
      return json({ id, status: "error", duration_sec: (Date.now() - t0) / 1000, error: formatError(err) }, err.status || 500);
    }
  }

  if (request.method === "POST" && (path === "/api/generate" || path === "/v1/images/generations" || path === "/v1/images/edits")) {
    requireAccess(request, env);
    const body = await readBody(request);
    if (path === "/v1/images/edits") body.images = collectImages(body);
    const result = await generate(env, body);
    if (path.startsWith("/v1/images/")) {
      const b64 = String(result.image_base64 || "").replace(/^data:[^;]+;base64,/, "");
      return json({ created: Math.floor(Date.now() / 1000), data: [{ b64_json: b64 }], model: result.model, account: result.account });
    }
    return json(result);
  }

  return json({ error: "not found" }, 404);
}


function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function streamGenerate(env, body, ctx) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event, data) => {
        try {
          controller.enqueue(enc.encode("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n"));
        } catch (_) {}
      };
      const pad = () => {
        try {
          controller.enqueue(enc.encode(":" + " ".repeat(256) + "\n\n"));
        } catch (_) {}
      };
      const jobId = crypto.randomUUID();
      await createJob(env, jobId);
      send("status", { job_id: jobId, message: "开始出图，额度用尽会自动换号" });
      pad();
      let finished = false;
      const t0 = Date.now();
      const work = (async function () {
        try {
          const result = await generate(env, body, function (info) {
            if (!finished) send("status", { job_id: jobId, message: info.message || "出图中" });
          });
          const bytes = result.image_base64 ? parseDataUri(result.image_base64).bytes : null;
          await finishJob(env, jobId, {
            ok: true,
            model: result.model,
            account: result.account,
            mime: result.mime,
            tried: result.tried,
            bytes: bytes,
          });
          return result;
        } catch (err) {
          await finishJob(env, jobId, { ok: false, error: formatError(err) });
          throw err;
        }
      })();
      if (ctx && ctx.waitUntil) ctx.waitUntil(work.then(function () {}, function () {}));
      const pinger = (async function () {
        while (!finished) {
          await sleep(2000);
          if (finished) break;
          try {
            send("ping", { job_id: jobId, t: Date.now() });
            pad();
          } catch (_) {}
        }
      })();
      try {
        const result = await work;
        finished = true;
        send("done", {
          job_id: jobId,
          status: "completed",
          duration_sec: (Date.now() - t0) / 1000,
          model: result.model,
          account: result.account,
          mime: result.mime,
          image_base64: result.image_base64,
          image_url: result.image_url,
          tried: result.tried,
          backend: result.backend,
        });
      } catch (err) {
        finished = true;
        send("error", { job_id: jobId, error: formatError(err) });
      } finally {
        finished = true;
        try { controller.close(); } catch (_) {}
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

async function runAsyncTask(env, id, body) {
  const t0 = Date.now();
  try {
    await putTask(id, { id, status: "processing", created_at: body && body.created_at });
    const result = await generate(env, body);
    await putTask(id, {
      id,
      status: "completed",
      duration_sec: (Date.now() - t0) / 1000,
      ...result,
    });
  } catch (err) {
    await putTask(id, {
      id,
      status: "error",
      duration_sec: (Date.now() - t0) / 1000,
      error: formatError(err),
    });
  }
}

async function generate(env, body, onProgress) {
  const pool = getPool(env);
  if (!pool.accounts.length) throw new PoolError("号池为空。请先导入 sub2api 账号 JSON 再构建部署。", "config", 500);

  const prompt = String(body.prompt || "").trim();
  if (!prompt) throw new PoolError("请输入提示词", "bad_input", 400);

  let model = resolveModel(body.model || env.DEFAULT_MODEL);
  const images = await normalizeImages(collectImages(body));
  if (images.length && !model.caps.includes("img2img")) {
    model = resolveModel("flux-2-klein-4b");
  }

  const [width, height] = parseSize(body);
  const seed = body.seed == null || body.seed === "" ? undefined : Number(body.seed);
  const steps = body.steps == null || body.steps === "" ? undefined : Number(body.steps);

  const picked = await pickFromStore(env, pool, MAX_TRIES);
  const candidates = picked.accounts;
  if (!candidates.length) {
    const health = await readHealth(env, pool);
    throw new PoolError(
      "号池里暂时没有可用账号。今日神经元耗尽 " + health.neurons_exhausted + " 个，其它停用 " + (health.disabled - health.neurons_exhausted) + " 个。等 UTC 0 点重置后再试。",
      "neurons",
      429
    );
  }

  const tried = [];
  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    const acc = candidates[i];
    if (typeof onProgress === "function") {
      onProgress({
        phase: "try",
        index: i + 1,
        total: candidates.length,
        account: acc.name,
        message: "正在用账号 " + (i + 1) + "/" + candidates.length + " 出图",
      });
    }
    try {
      const out = await runAccount(acc, model, { prompt, width, height, seed, steps, images });
      if (!isCompleteImage(out.bytes, out.mime)) {
        throw new PoolError("图片被截断，账号额度可能中途耗尽", "truncated", 502);
      }
      await reportToStore(env, pool, {
        account_id: acc.account_id,
        name: acc.name,
        ok: true,
      });
      const stored = toDataUri(out.bytes, out.mime);
      return {
        model: model.id,
        account: acc.name,
        mime: out.mime,
        image_base64: stored,
        image_url: stored,
        tried: tried.length,
        backend: picked.backend,
      };
    } catch (err) {
      lastErr = err;
      const kind = err.kind || "other";
      const msg = formatError(err);
      tried.push({ account: acc.name, kind, error: msg });
      await reportToStore(env, pool, {
        account_id: acc.account_id,
        name: acc.name,
        ok: false,
        kind: kind,
        error: msg,
      });
      if (kind === "policy") {
        throw new PoolError("不是额度问题（号池仍可用）。Cloudflare 把这张图判定为违规输出，换个提示词或去掉参考图再试。", "policy", 400);
      }
      if (typeof onProgress === "function") {
        onProgress({
          phase: "switch",
          index: i + 1,
          total: candidates.length,
          account: acc.name,
          kind: kind,
          error: msg,
          message: "账号出图失败（" + kind + "），换下一个 " + (i + 2) + "/" + candidates.length,
        });
      }
      if (isFatalInput(kind, msg)) break;
    }
  }

  const health = await readHealth(env, pool);
  const last = lastErr ? formatError(lastErr) : "未知错误";
  throw new PoolError(
    "连续尝试 " + tried.length + " 个账号仍失败。可用 " + health.available + " / " + health.total + "，今日神经元耗尽 " + health.neurons_exhausted + "。最后错误：" + last,
    (lastErr && lastErr.kind) || "other",
    502
  );
}

async function runAccount(acc, model, opt) {
  const url = "https://api.cloudflare.com/client/v4/accounts/" + acc.account_id + "/ai/run/" + model.cf;
  const headers = { Authorization: "Bearer " + acc.api_key };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("timeout"), 120000);
  let res;
  try {
    if (model.mode === "json") {
      const payload = { prompt: opt.prompt, steps: clamp(opt.steps ?? 4, 1, 8) };
      if (opt.seed != null && !Number.isNaN(opt.seed)) payload.seed = opt.seed;
      res = await fetch(url, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } else {
      const form = new FormData();
      form.append("prompt", opt.prompt);
      if (opt.width) form.append("width", String(opt.width));
      if (opt.height) form.append("height", String(opt.height));
      if (opt.steps != null && !Number.isNaN(opt.steps)) form.append("steps", String(opt.steps));
      if (opt.seed != null && !Number.isNaN(opt.seed)) form.append("seed", String(opt.seed));
      for (const img of opt.images || []) {
        form.append("image", new Blob([img.bytes], { type: img.mime }), img.name || "ref.jpg");
      }
      res = await fetch(url, { method: "POST", headers, body: form, signal: ctrl.signal });
    }
  } catch (err) {
    throw new PoolError(err.name === "AbortError" ? "上游超时" : "网络错误：" + formatError(err), "server", 504);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new PoolError("上游响应被截断，换号重试：" + String(text).slice(0, 120), "truncated", 502);
  }
  if (!res.ok || (data && data.success === false)) {
    const message = cfMessage(data, text) || ("HTTP " + res.status);
    throw new PoolError(message, classifyError(res.status, message), res.status);
  }
  return parseImage(data, res, text);
}

function parseImage(data, res, text) {
  const image = data && data.result && data.result.image;
  if (typeof image === "string" && image.length > 32) {
    let bytes;
    try {
      bytes = b64ToBytes(image);
    } catch (err) {
      throw new PoolError("图片数据不完整，换号重试", "truncated", 502);
    }
    const mime = sniffMime(bytes) || "image/jpeg";
    if (!isCompleteImage(bytes, mime)) {
      throw new PoolError("图片被截断，换号重试", "truncated", 502);
    }
    return { bytes, mime };
  }
  throw new PoolError("上游没有返回图片：" + String(text).slice(0, 180), "truncated", 502);
}

function isCompleteImage(bytes, mime) {
  if (!bytes || bytes.length < 4096) return false;
  const n = bytes.length;
  if (mime === "image/jpeg" || (bytes[0] === 0xff && bytes[1] === 0xd8)) {
    for (let i = n - 1; i >= Math.max(1, n - 32); i--) {
      if (bytes[i] === 0xd9 && bytes[i - 1] === 0xff) return true;
    }
    return false;
  }
  if (mime === "image/png" || bytes[0] === 0x89) {
    return n >= 12 && bytes[n - 8] === 0x49 && bytes[n - 7] === 0x45 && bytes[n - 6] === 0x4e && bytes[n - 5] === 0x44;
  }
  return n > 8192;
}

function isFatalInput(kind, message) {
  if (kind === "config" || kind === "policy") return true;
  const text = String(message || "").toLowerCase();
  if (/neuron|neurons|quota|daily limit|usage limit|insufficient|truncated|额度|神经元|余额|配额|截断/.test(text)) return false;
  if (kind !== "bad_input") return false;
  return /required properties|multipart|not valid json|5006|6003|bad input/.test(text);
}

function pickAccounts(pool, state, limit) {
  const now = Date.now();
  const n = pool.accounts.length;
  if (!n) return [];
  if (state.cursor == null || state.cursor < 0) {
    state.cursor = Math.floor(Math.random() * n);
  }
  const start = ((state.cursor % n) + n) % n;
  const out = [];
  for (let i = 0; i < n && out.length < limit; i++) {
    const acc = pool.accounts[(start + i) % n];
    if (!isDisabled(state, acc.account_id, now)) out.push(acc);
  }
  return out;
}

function advanceCursor(state, pool, acc) {
  const idx = pool.accounts.findIndex((a) => a.account_id === acc.account_id);
  state.cursor = ((idx >= 0 ? idx : 0) + 1) % pool.accounts.length;
}

function isDisabled(state, accountId, now) {
  const row = (state.disabled || {})[accountId];
  return !!(row && row.until > now);
}

function disableAccount(state, acc, kind, error) {
  if (!state.disabled) state.disabled = {};
  const prev = state.disabled[acc.account_id] || {};
  const hits = (prev.hits || 0) + 1;
  if (kind === "rate" && hits >= 2) kind = "neurons";
  state.disabled[acc.account_id] = {
    until: disableUntil(kind),
    kind,
    hits,
    name: acc.name,
    at: Date.now(),
    error: error || prev.error || "",
  };
}

function disableUntil(kind) {
  const now = Date.now();
  if (kind === "neurons") return neuronResetAt(now);
  if (kind === "auth") return now + 12 * 60 * 60 * 1000;
  if (kind === "rate") return now + 3 * 60 * 1000;
  if (kind === "server") return now + 60 * 1000;
  return now + 30 * 1000;
}

function neuronResetAt(now) {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) + 5 * 60 * 1000;
  return Math.max(next, now + 15 * 60 * 1000);
}

function classifyError(status, message) {
  const text = String(message || "").toLowerCase();
  if (
    status === 402 ||
    /neuron|neurons|quota|daily limit|usage limit|insufficient|out of credit|exceeded your|额度|神经元|余额不足|配额/.test(text)
  ) {
    return "neurons";
  }
  if (status === 401 || status === 403) return "auth";
  if (status === 429 || /rate limit|too many requests|capacity/.test(text)) return "rate";
  if (/flagged|moderat|nsfw|choose another prompt|input image combination|content.?polic|safety/.test(text)) return "policy";
  if (/truncat|incomplete|network|timeout|aborted/.test(text)) return "truncated";
  if (status === 400 || status === 415 || status === 422) return "bad_input";
  if (status >= 500) return "server";
  return "other";
}

function summarizeHealth(pool, state) {
  const now = Date.now();
  const disabledRows = Object.values(state.disabled || {}).filter((row) => row && row.until > now);
  const neurons = disabledRows.filter((row) => row.kind === "neurons").length;
  const auth = disabledRows.filter((row) => row.kind === "auth").length;
  const rate = disabledRows.filter((row) => row.kind === "rate").length;
  return {
    ok: true,
    total: pool.accounts.length,
    available: Math.max(0, pool.accounts.length - disabledRows.length),
    disabled: disabledRows.length,
    neurons_exhausted: neurons,
    auth_disabled: auth,
    rate_limited: rate,
    cursor: state.cursor || 0,
    imported_at: pool.imported_at || null,
    backend: "cache",
    disabled_accounts: disabledRows.map((row) => ({
      name: row.name || "",
      kind: row.kind,
      until: row.until,
      hits: row.hits || 0,
      error: row.error || "",
    })),
  };
}

function getPool(env) {
  let data = EMBEDDED_POOL;
  if (env.POOL_JSON) {
    try { data = JSON.parse(env.POOL_JSON); } catch (_) {}
  }
  const accounts = (data && data.accounts) || [];
  return { accounts, imported_at: data && data.imported_at, count: accounts.length };
}

async function loadState(env) {
  if (memState) return memState;
  if (env.STATE) {
    try {
      const raw = await env.STATE.get("pool-state");
      if (raw) {
        memState = JSON.parse(raw);
        if (!memState.disabled) memState.disabled = {};
        return memState;
      }
    } catch (_) {}
  }
  try {
    const res = await caches.default.match(new Request(STATE_URL));
    if (res) {
      memState = await res.json();
      if (!memState.disabled) memState.disabled = {};
      return memState;
    }
  } catch (_) {}
  memState = { cursor: null, disabled: {}, ok: 0 };
  return memState;
}

async function saveState(env, state) {
  memState = state;
  const res = new Response(JSON.stringify(state), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=172800" },
  });
  try { await caches.default.put(new Request(STATE_URL), res.clone()); } catch (_) {}
  if (env.STATE) {
    try { await env.STATE.put("pool-state", JSON.stringify(state), { expirationTtl: 172800 }); } catch (_) {}
  }
}

function resolveModel(id) {
  const key = String(id || "").trim();
  return MODELS.find((m) => m.id === key || m.cf === key) || MODELS[0];
}

function parseSize(body) {
  if (body.size && /^\d+x\d+$/i.test(body.size)) {
    const [w, h] = String(body.size).toLowerCase().split("x").map(Number);
    return [clamp(w, 256, 1536), clamp(h, 256, 1536)];
  }
  const ratio = ASPECT[body.aspect_ratio] ? body.aspect_ratio : "1:1";
  let [w, h] = ASPECT[ratio];
  if (body.width) w = Number(body.width);
  if (body.height) h = Number(body.height);
  return [clamp(w || 1024, 256, 1536), clamp(h || 1024, 256, 1536)];
}

function collectImages(body) {
  const out = [];
  if (body.image) out.push(body.image);
  if (Array.isArray(body.images)) out.push(...body.images);
  return out.filter(Boolean).slice(0, 3);
}

async function normalizeImages(images) {
  const out = [];
  for (const item of images) {
    const text = String(item || "");
    if (/^https?:\/\//i.test(text)) {
      const res = await fetch(text);
      if (!res.ok) throw new PoolError("参考图下载失败", "bad_input", 400);
      const buf = new Uint8Array(await res.arrayBuffer());
      const mime = (res.headers.get("content-type") || "image/jpeg").split(";")[0];
      out.push({ bytes: buf, mime, name: "ref" + out.length + extOf(mime) });
    } else {
      const parsed = parseDataUri(text);
      out.push({ bytes: parsed.bytes, mime: parsed.mime, name: "ref" + out.length + extOf(parsed.mime) });
    }
  }
  return out;
}

function requireAccess(request, env) {
  const need = String(env.ACCESS_KEY || "").trim();
  if (!need) return;
  const url = new URL(request.url);
  const got =
    bearer(request) ||
    request.headers.get("x-api-key") ||
    url.searchParams.get("key") ||
    "";
  if (got !== need) {
    const err = new PoolError("需要 ACCESS_KEY", "auth", 401);
    throw err;
  }
}

function bearer(request) {
  const h = request.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

async function readBody(request) {
  const ctype = request.headers.get("content-type") || "";
  if (ctype.includes("multipart/form-data")) {
    const form = await request.formData();
    const body = {};
    for (const [k, v] of form.entries()) {
      if (typeof v === "string") body[k] = v;
    }
    return body;
  }
  return request.json();
}

async function putTask(id, data) {
  await caches.default.put(
    taskRequest(id),
    new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
    })
  );
}

async function getTask(id) {
  const res = await caches.default.match(taskRequest(id));
  return res ? res.json() : null;
}

function taskRequest(id) {
  return new Request("https://cf-flux-pool.internal/tasks/" + id);
}

function cfMessage(data, text) {
  if (!data) return String(text || "").slice(0, 240);
  const errors = data.errors;
  if (Array.isArray(errors) && errors[0]) {
    return errors[0].message || errors[0].code || JSON.stringify(errors[0]);
  }
  return data.error || data.message || String(text || "").slice(0, 240);
}

class PoolError extends Error {
  constructor(message, kind, status) {
    super(message);
    this.kind = kind || "other";
    this.status = status || 500;
  }
}

function parseDataUri(input) {
  const text = String(input || "");
  const m = text.match(/^data:([^;]+);base64,(.+)$/);
  const mime = m ? m[1] : "image/png";
  const b64 = m ? m[2] : text.replace(/^base64,/, "");
  return { mime, bytes: b64ToBytes(b64) };
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function toDataUri(bytes, mime) {
  return "data:" + (mime || "image/jpeg") + ";base64," + bytesToBase64(bytes);
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x400;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function sniffMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49) return "image/webp";
  return "";
}

function extOf(mime) {
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  return ".jpg";
}

function clamp(n, min, max) {
  n = Number(n);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function formatError(err) {
  if (!err) return "";
  if (typeof err === "string") return err;
  return err.message || err.error || String(err);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function cors(res) {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return new Response(res.body, { status: res.status, headers });
}
