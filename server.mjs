import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const ACCESS_KEY = String(process.env.ACCESS_KEY || "").trim();
const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
const USE_UPSTASH = !!(UPSTASH_URL && UPSTASH_TOKEN);
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : path.join(__dirname, "data"));
const HOST = "0.0.0.0";

const MODELS = [
  { id: "flux-2-klein-4b", name: "FLUX.2 Klein 4B", hint: "最快 · 推荐", cf: "@cf/black-forest-labs/flux-2-klein-4b", mode: "multipart", caps: ["txt2img", "img2img"] },
  { id: "flux-2-klein-9b", name: "FLUX.2 Klein 9B", hint: "更快更高清", cf: "@cf/black-forest-labs/flux-2-klein-9b", mode: "multipart", caps: ["txt2img", "img2img"] },
  { id: "flux-2-dev", name: "FLUX.2 Dev", hint: "高质量", cf: "@cf/black-forest-labs/flux-2-dev", mode: "multipart", caps: ["txt2img", "img2img"] },
  { id: "flux-1-schnell", name: "FLUX.1 Schnell", hint: "老款极速 JSON", cf: "@cf/black-forest-labs/flux-1-schnell", mode: "json", caps: ["txt2img"] },
  { id: "moondream3.1-9B-A2B", name: "Moondream 3.1", hint: "看图问答 · 不能生图", cf: "@cf/moondream/moondream3.1-9B-A2B", mode: "json", caps: ["vision"] },
];
const ASPECT = { "1:1": [1024, 1024], "16:9": [1280, 720], "9:16": [720, 1280], "4:3": [1024, 768], "3:4": [768, 1024], "3:2": [1152, 768], "2:3": [768, 1152] };
const MAX_TRIES = 24;
const PAGE = fs.readFileSync(path.join(__dirname, "src", "index.html"), "utf8");

if (!USE_UPSTASH) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, "jobs"), { recursive: true });
}
const STATE_PATH = path.join(DATA_DIR, "state.json");
const STATE_KEY = "fluxpool:state";
const JOB_PREFIX = "fluxpool:job:";

function loadPool() {
  const raw = process.env.POOL_JSON || fs.readFileSync(pickPoolPath(), "utf8");
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  return { accounts: data.accounts || [], imported_at: data.imported_at || null };
}
function pickPoolPath() {
  for (const p of [path.join(DATA_DIR, "pool.json"), path.join(__dirname, "pool.json")]) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("找不到 pool.json，请挂载 /data/pool.json 或设置 POOL_JSON");
}
const POOL = loadPool();

async function redisCmd(args) {
  const res = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + UPSTASH_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || ("Upstash HTTP " + res.status));
  return data.result;
}

async function loadState() {
  if (USE_UPSTASH) {
    try {
      const raw = await redisCmd(["GET", STATE_KEY]);
      if (raw) return JSON.parse(raw);
    } catch (err) {
      console.error("upstash loadState", err);
    }
    return { cursor: 0, disabled: {}, stats: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { cursor: 0, disabled: {}, stats: {} };
  }
}
async function saveState(state) {
  if (USE_UPSTASH) {
    await redisCmd(["SET", STATE_KEY, JSON.stringify(state)]);
    return;
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(state));
}

class PoolError extends Error {
  constructor(message, kind, status) {
    super(message);
    this.kind = kind || "other";
    this.status = status || 500;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return send(res, 204, "");
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "GET" && p === "/") return html(res, PAGE);
    if (req.method === "GET" && p === "/healthz") return json(res, { ok: true, accounts: POOL.accounts.length });
    if (req.method === "GET" && (p === "/api/models" || p === "/v1/models")) {
      return json(res, { default: process.env.DEFAULT_MODEL || "flux-2-klein-4b", items: { "Cloudflare Workers AI 号池": MODELS.map((m) => ({ id: m.id, name: m.name, hint: m.hint, capabilities: m.caps })) } });
    }
    if (req.method === "GET" && p === "/api/health") return json(res, await readHealth());
    if (req.method === "GET" && p === "/api/accounts") {
      if (!auth(req, url, res)) return;
      return json(res, await readAccountStatus());
    }
    if (req.method === "GET" && p.startsWith("/api/jobs/")) {
      if (!auth(req, url, res)) return;
      const id = p.slice("/api/jobs/".length).split("/")[0];
      const job = await readJob(id);
      return job ? json(res, job) : json(res, { error: "任务不存在" }, 404);
    }
    if (req.method === "POST" && p === "/api/vision") {
      if (!auth(req, url, res)) return;
      const body = await readBody(req);
      try { return json(res, await vision(body)); }
      catch (err) { return json(res, { error: formatError(err) }, err.status || 500); }
    }
    if (req.method === "POST" && p === "/api/generate/stream") {
      if (!auth(req, url, res)) return;
      const body = await readBody(req);
      return streamGenerate(req, res, body);
    }
    if (req.method === "POST" && (p === "/api/generate" || p === "/api/generate/async" || p === "/v1/images/generations" || p === "/v1/images/edits")) {
      if (!auth(req, url, res)) return;
      const body = await readBody(req);
      if (p === "/v1/images/edits") body.images = collectImages(body);
      try {
        const result = await generate(body);
        if (p.startsWith("/v1/images/")) {
          const b64 = String(result.image_base64 || "").replace(/^data:[^;]+;base64,/, "");
          return json(res, { created: Math.floor(Date.now() / 1000), data: [{ b64_json: b64 }], model: result.model, account: result.account });
        }
        return json(res, { status: "completed", ...result });
      } catch (err) {
        return json(res, { status: "error", error: formatError(err) }, err.status || 500);
      }
    }
    return json(res, { error: "not found" }, 404);
  } catch (err) {
    return json(res, { error: formatError(err) }, err.status || 500);
  }
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 120000;
server.listen(PORT, HOST, () => {
  console.log("flux-pool listening on " + HOST + ":" + PORT + " accounts=" + POOL.accounts.length);
});

function auth(req, url, res) {
  if (!ACCESS_KEY) return true;
  const got = bearer(req) || req.headers["x-api-key"] || url.searchParams.get("key") || "";
  if (got === ACCESS_KEY) return true;
  json(res, { error: "需要 ACCESS_KEY" }, 401);
  return false;
}
function bearer(req) {
  const h = String(req.headers.authorization || "");
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}
function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}
function html(res, page) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page);
}
function send(res, status, body) {
  res.writeHead(status, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
  res.end(body || "");
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

async function streamGenerate(req, res, body) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
  });
  const jobId = randomUUID();
  await writeJob(jobId, { id: jobId, status: "processing", created_at: Date.now() });
  const sse = (event, data) => {
    try { res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n"); } catch (_) {}
  };
  sse("status", { job_id: jobId, message: "开始出图，额度用尽会自动换号" });
  const ping = setInterval(() => {
    sse("ping", { job_id: jobId, t: Date.now() });
    try { res.write(":" + " ".repeat(256) + "\n\n"); } catch (_) {}
  }, 2000);
  const t0 = Date.now();
  try {
    const result = await generate(body, (info) => sse("status", { job_id: jobId, message: info.message || "出图中" }));
    await finishJob(jobId, result);
    sse("done", { job_id: jobId, status: "completed", duration_sec: (Date.now() - t0) / 1000, ...result });
  } catch (err) {
    await finishJob(jobId, { error: formatError(err) });
    sse("error", { job_id: jobId, error: formatError(err) });
  } finally {
    clearInterval(ping);
    try { res.end(); } catch (_) {}
  }
}

async function writeJob(id, data) {
  if (USE_UPSTASH) {
    await redisCmd(["SET", JOB_PREFIX + id, JSON.stringify(data), "EX", "3600"]);
    return;
  }
  fs.writeFileSync(path.join(DATA_DIR, "jobs", id + ".json"), JSON.stringify(data));
}
async function finishJob(id, result) {
  const row = {
    id,
    status: result && result.error ? "error" : "completed",
    error: result && result.error || null,
    model: result && result.model || null,
    account: result && result.account || null,
    mime: result && result.mime || null,
    tried: result && result.tried || 0,
    image_base64: result && result.image_base64 || null,
    image_url: result && result.image_url || null,
    updated_at: Date.now(),
  };
  await writeJob(id, row);
}
async function readJob(id) {
  if (USE_UPSTASH) {
    const raw = await redisCmd(["GET", JOB_PREFIX + id]);
    return raw ? JSON.parse(raw) : null;
  }
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "jobs", id + ".json"), "utf8")); }
  catch { return null; }
}

async function vision(body) {
  const model = resolveModel("moondream3.1-9B-A2B");
  const images = await normalizeImages(collectImages(body));
  if (!images.length) throw new PoolError("Moondream 是看图模型，请先上传参考图", "bad_input", 400);
  const img = images[0];
  const dataUri = toDataUri(img.bytes, img.mime);
  const task = String(body.task || "query");
  const question = String(body.question || body.prompt || "What's in this image?").trim();
  const target = String(body.target || body.prompt || "object").trim();
  const candidates = await pickAccounts(MAX_TRIES);
  if (!candidates.length) throw new PoolError("号池里暂时没有可用账号", "neurons", 429);
  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    const acc = candidates[i];
    try {
      const out = await runVision(acc, { task, image: dataUri, question, target });
      await report({ account_id: acc.account_id, name: acc.name, ok: true });
      return { model: model.id, account: acc.name, task, ...out, backend: USE_UPSTASH ? "upstash" : "file" };
    } catch (err) {
      lastErr = err;
      const kind = err.kind || "other";
      await report({ account_id: acc.account_id, name: acc.name, ok: false, kind, error: formatError(err) });
      if (kind === "policy" || isFatalInput(kind, formatError(err))) {
        if (kind === "policy") throw new PoolError("内容审核拦截，换一张图或换个问题。", "policy", 400);
        break;
      }
    }
  }
  throw new PoolError("看图失败：" + formatError(lastErr), (lastErr && lastErr.kind) || "other", 502);
}

async function runVision(acc, opt) {
  const url = "https://api.cloudflare.com/client/v4/accounts/" + acc.account_id + "/ai/run/@cf/moondream/moondream3.1-9B-A2B";
  const payload = { task: opt.task || "query", image: opt.image, stream: false, reasoning: false };
  if (payload.task === "query") payload.question = opt.question || "What's in this image?";
  if (payload.task === "caption") payload.caption_length = "normal";
  if (payload.task === "detect" || payload.task === "point") payload.target = opt.target || "object";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + acc.api_key, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new PoolError(err.name === "AbortError" ? "看图超时，换号重试" : "网络错误：" + formatError(err), "truncated", 504);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new PoolError("看图响应被截断，换号重试", "truncated", 502); }
  if (!res.ok || (data && data.success === false)) {
    const message = cfMessage(data, text) || ("HTTP " + res.status);
    throw new PoolError(message, classifyError(res.status, message), res.status);
  }
  const result = (data && data.result) || data || {};
  return {
    answer: result.answer || result.caption || result.response || "",
    caption: result.caption || "",
    objects: result.objects || null,
    points: result.points || null,
    raw: result,
  };
}

async function generate(body, onProgress) {
  if (!POOL.accounts.length) throw new PoolError("号池为空", "config", 500);
  const prompt = String(body.prompt || "").trim();
  if (!prompt) throw new PoolError("请输入提示词", "bad_input", 400);
  let model = resolveModel(body.model || process.env.DEFAULT_MODEL);
  if (model.caps && model.caps.includes("vision")) return vision(body);
  const images = await normalizeImages(collectImages(body));
  if (images.length && !model.caps.includes("img2img")) model = resolveModel("flux-2-klein-4b");
  const [width, height] = parseSize(body);
  const seed = body.seed == null || body.seed === "" ? undefined : Number(body.seed);
  const steps = body.steps == null || body.steps === "" ? undefined : Number(body.steps);
  const candidates = await pickAccounts(MAX_TRIES);
  if (!candidates.length) {
    const health = await readHealth();
    throw new PoolError("号池里暂时没有可用账号。今日神经元耗尽 " + health.neurons_exhausted + " 个。", "neurons", 429);
  }
  const tried = [];
  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    const acc = candidates[i];
    if (typeof onProgress === "function") onProgress({ message: "正在用账号 " + (i + 1) + "/" + candidates.length + " 出图" });
    try {
      const out = await runAccount(acc, model, { prompt, width, height, seed, steps, images });
      if (!isCompleteImage(out.bytes, out.mime)) throw new PoolError("图片被截断，账号额度可能中途耗尽", "truncated", 502);
      await report({ account_id: acc.account_id, name: acc.name, ok: true });
      const stored = toDataUri(out.bytes, out.mime);
      return { model: model.id, account: acc.name, mime: out.mime, image_base64: stored, image_url: stored, tried: tried.length, backend: "node" };
    } catch (err) {
      lastErr = err;
      const kind = err.kind || "other";
      const msg = formatError(err);
      tried.push({ account: acc.name, kind, error: msg });
      await report({ account_id: acc.account_id, name: acc.name, ok: false, kind, error: msg });
      if (kind === "policy") {
        throw new PoolError("不是额度问题（号池仍可用）。Cloudflare 把这张图判定为违规输出，换个提示词或去掉参考图再试。", "policy", 400);
      }
      if (typeof onProgress === "function") onProgress({ message: "账号出图失败（" + kind + "），换下一个 " + (i + 2) + "/" + candidates.length });
      if (isFatalInput(kind, msg)) break;
    }
  }
  const health = await readHealth();
  throw new PoolError("连续尝试 " + tried.length + " 个账号仍失败。可用 " + health.available + "/" + health.total + "。最后错误：" + formatError(lastErr), (lastErr && lastErr.kind) || "other", 502);
}

async function runAccount(acc, model, opt) {
  const url = "https://api.cloudflare.com/client/v4/accounts/" + acc.account_id + "/ai/run/" + model.cf;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  let res;
  try {
    if (model.mode === "json") {
      const payload = { prompt: opt.prompt, steps: clamp(opt.steps ?? 4, 1, 8) };
      if (opt.seed != null && !Number.isNaN(opt.seed)) payload.seed = opt.seed;
      res = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + acc.api_key, "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: ctrl.signal });
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
      res = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + acc.api_key }, body: form, signal: ctrl.signal });
    }
  } catch (err) {
    throw new PoolError(err.name === "AbortError" ? "上游超时，换号重试" : "网络错误：" + formatError(err), "truncated", 504);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new PoolError("上游响应被截断，换号重试", "truncated", 502); }
  if (!res.ok || (data && data.success === false)) {
    const message = cfMessage(data, text) || ("HTTP " + res.status);
    throw new PoolError(message, classifyError(res.status, message), res.status);
  }
  return parseImage(data, text);
}

function parseImage(data, text) {
  const image = data && data.result && data.result.image;
  if (typeof image === "string" && image.length > 32) {
    let bytes;
    try { bytes = Buffer.from(image, "base64"); }
    catch { throw new PoolError("图片数据不完整，换号重试", "truncated", 502); }
    const mime = sniffMime(bytes) || "image/jpeg";
    if (!isCompleteImage(bytes, mime)) throw new PoolError("图片被截断，换号重试", "truncated", 502);
    return { bytes, mime };
  }
  throw new PoolError("上游没有返回图片：" + String(text).slice(0, 180), "truncated", 502);
}

async function pickAccounts(limit) {
  const state = await loadState();
  const now = Date.now();
  prune(state, now);
  const n = POOL.accounts.length;
  if (!n) return [];
  if (state.cursor == null || state.cursor < 0) state.cursor = Math.floor(Math.random() * n);
  const start = ((state.cursor % n) + n) % n;
  const out = [];
  for (let i = 0; i < n && out.length < limit; i++) {
    const acc = POOL.accounts[(start + i) % n];
    const row = state.disabled[acc.account_id];
    if (!(row && row.until > now)) out.push(acc);
  }
  await saveState(state);
  return out;
}

async function report(payload) {
  const state = await loadState();
  const now = Date.now();
  prune(state, now);
  if (!state.stats) state.stats = {};
  const id = payload.account_id;
  const st = state.stats[id] || { ok: 0, fail: 0, fail_streak: 0 };
  if (payload.ok) {
    st.ok += 1; st.fail_streak = 0; st.last_ok = now;
    if (state.disabled) delete state.disabled[id];
    const idx = POOL.accounts.findIndex((a) => a.account_id === id);
    if (idx >= 0) state.cursor = (idx + 1) % POOL.accounts.length;
  } else if (payload.kind !== "bad_input" && payload.kind !== "config" && payload.kind !== "policy") {
    st.fail += 1; st.fail_streak += 1; st.last_fail = now; st.last_error = payload.error || "";
    let kind = payload.kind || "other";
    if (kind === "rate" && st.fail_streak >= 2) kind = "neurons";
    const prev = state.disabled[id] || {};
    state.disabled[id] = { until: disableUntil(kind), kind, hits: (prev.hits || 0) + 1, name: payload.name || prev.name || "", at: now, error: payload.error || "" };
  }
  state.stats[id] = st;
  await saveState(state);
}

function prune(state, now) {
  for (const id of Object.keys(state.disabled || {})) {
    if (!state.disabled[id] || state.disabled[id].until <= now) delete state.disabled[id];
  }
}

async function readHealth() {
  const state = await loadState();
  prune(state, Date.now());
  const disabledRows = Object.values(state.disabled || {});
  return {
    ok: true, backend: USE_UPSTASH ? "upstash" : "file", total: POOL.accounts.length,
    available: Math.max(0, POOL.accounts.length - disabledRows.length),
    disabled: disabledRows.length,
    neurons_exhausted: disabledRows.filter((r) => r.kind === "neurons").length,
    auth_disabled: disabledRows.filter((r) => r.kind === "auth").length,
    rate_limited: disabledRows.filter((r) => r.kind === "rate").length,
    cursor: state.cursor || 0, imported_at: POOL.imported_at,
    disabled_accounts: disabledRows.map((row) => ({ name: row.name || "", kind: row.kind, until: row.until, hits: row.hits || 0, error: row.error || "" })),
  };
}
async function readAccountStatus() {
  const h = await readHealth();
  return { backend: h.backend, total: h.total, available: h.available, neurons_exhausted: h.neurons_exhausted, disabled: h.disabled_accounts };
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
      const buf = Buffer.from(await res.arrayBuffer());
      const mime = (res.headers.get("content-type") || "image/jpeg").split(";")[0];
      out.push({ bytes: buf, mime, name: "ref" + out.length + extOf(mime) });
    } else {
      const parsed = parseDataUri(text);
      out.push({ bytes: parsed.bytes, mime: parsed.mime, name: "ref" + out.length + extOf(parsed.mime) });
    }
  }
  return out;
}
function classifyError(status, message) {
  const text = String(message || "").toLowerCase();
  if (status === 402 || /neuron|neurons|quota|daily limit|usage limit|insufficient|out of credit|exceeded your|额度|神经元|余额不足|配额/.test(text)) return "neurons";
  if (status === 401 || status === 403) return "auth";
  if (status === 429 || /rate limit|too many requests|capacity/.test(text)) return "rate";
  if (/flagged|moderat|nsfw|choose another prompt|input image combination|content.?polic|safety/.test(text)) return "policy";
  if (/truncat|incomplete|network|timeout|aborted/.test(text)) return "truncated";
  if (status === 400 || status === 415 || status === 422) return "bad_input";
  if (status >= 500) return "server";
  return "other";
}
function isFatalInput(kind, message) {
  if (kind === "config" || kind === "policy") return true;
  const text = String(message || "").toLowerCase();
  if (/neuron|quota|daily limit|usage limit|insufficient|truncated|额度|神经元|余额|配额|截断/.test(text)) return false;
  if (kind !== "bad_input") return false;
  return /required properties|multipart|not valid json|5006|6003|bad input/.test(text);
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
function disableUntil(kind) {
  const now = Date.now();
  if (kind === "neurons") {
    const d = new Date(now);
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) + 5 * 60 * 1000;
    return Math.max(next, now + 15 * 60 * 1000);
  }
  if (kind === "auth") return now + 12 * 60 * 60 * 1000;
  if (kind === "rate") return now + 3 * 60 * 1000;
  if (kind === "server") return now + 60 * 1000;
  return now + 30 * 1000;
}
function cfMessage(data, text) {
  if (!data) return String(text || "").slice(0, 240);
  if (Array.isArray(data.errors) && data.errors[0]) return data.errors[0].message || data.errors[0].code || JSON.stringify(data.errors[0]);
  return data.error || data.message || String(text || "").slice(0, 240);
}
function parseDataUri(input) {
  const text = String(input || "");
  const m = text.match(/^data:([^;]+);base64,(.+)$/);
  const mime = m ? m[1] : "image/png";
  const b64 = m ? m[2] : text.replace(/^base64,/, "");
  return { mime, bytes: Buffer.from(b64, "base64") };
}
function toDataUri(bytes, mime) {
  return "data:" + (mime || "image/jpeg") + ";base64," + Buffer.from(bytes).toString("base64");
}
function sniffMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
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
