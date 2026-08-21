import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createAuth } from "./src/auth.mjs";
import { r2Enabled, uploadToR2, deleteFromR2, getFromR2, publicObjectUrl } from "./src/r2.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const ACCESS_KEY = String(process.env.ACCESS_KEY || "").trim();
const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
const USE_UPSTASH = !!(UPSTASH_URL && UPSTASH_TOKEN);
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : path.join(__dirname, "data"));
const HOST = "0.0.0.0";
const GROK_BASE = String(process.env.GROK_BASE_URL || "https://grok.888.x10.mx").replace(/\/+$/, "");
const GROK_KEY = String(process.env.GROK_API_KEY || "").trim();

const MODELS = [
  { id: "flux-2-klein-4b", name: "FLUX.2 Klein 4B", hint: "最快 · 推荐", cf: "@cf/black-forest-labs/flux-2-klein-4b", mode: "multipart", caps: ["txt2img", "img2img"], group: "FLUX" },
  { id: "flux-2-klein-9b", name: "FLUX.2 Klein 9B", hint: "更快更高清", cf: "@cf/black-forest-labs/flux-2-klein-9b", mode: "multipart", caps: ["txt2img", "img2img"], group: "FLUX" },
  { id: "flux-2-dev", name: "FLUX.2 Dev", hint: "高质量", cf: "@cf/black-forest-labs/flux-2-dev", mode: "multipart", caps: ["txt2img", "img2img"], group: "FLUX" },
  { id: "flux-1-schnell", name: "FLUX.1 Schnell", hint: "老款极速 JSON", cf: "@cf/black-forest-labs/flux-1-schnell", mode: "json", family: "schnell", caps: ["txt2img"], group: "FLUX", defaultSteps: 4, minSteps: 1, maxSteps: 8, stepKey: "steps" },
  { id: "lucid-origin", name: "Leonardo Lucid Origin", hint: "提示词跟手 · 文字渲染", cf: "@cf/leonardo/lucid-origin", mode: "json", family: "sd", caps: ["txt2img"], group: "Leonardo", defaultSteps: 20, minSteps: 1, maxSteps: 40, maxSize: 1280, guidance: 4.5 },
  { id: "phoenix-1.0", name: "Leonardo Phoenix 1.0", hint: "提示词精准 · 可写字", cf: "@cf/leonardo/phoenix-1.0", mode: "json", family: "sd", caps: ["txt2img"], group: "Leonardo", defaultSteps: 25, minSteps: 1, maxSteps: 50, maxSize: 1280, guidance: 2 },
  { id: "sdxl-lightning", name: "SDXL Lightning", hint: "字节跳动 · 超快 SDXL", cf: "@cf/bytedance/stable-diffusion-xl-lightning", mode: "json", family: "sd", caps: ["txt2img", "img2img"], group: "Stable Diffusion", defaultSteps: 4, minSteps: 1, maxSteps: 20, maxSize: 1024 },
  { id: "dreamshaper-8-lcm", name: "DreamShaper 8 LCM", hint: "二次元友好 · 少步数", cf: "@cf/lykon/dreamshaper-8-lcm", mode: "json", family: "sd", caps: ["txt2img", "img2img"], group: "Stable Diffusion", defaultSteps: 8, minSteps: 1, maxSteps: 20, maxSize: 1024 },
  { id: "sdxl-base-1.0", name: "SDXL Base 1.0", hint: "Stability 经典", cf: "@cf/stabilityai/stable-diffusion-xl-base-1.0", mode: "json", family: "sd", caps: ["txt2img", "img2img"], group: "Stable Diffusion", defaultSteps: 20, minSteps: 1, maxSteps: 20, maxSize: 1024 },
  { id: "sd15-img2img", name: "SD 1.5 图生图", hint: "必须上传参考图", cf: "@cf/runwayml/stable-diffusion-v1-5-img2img", mode: "json", family: "sd", caps: ["img2img"], group: "Stable Diffusion", defaultSteps: 20, minSteps: 1, maxSteps: 20, maxSize: 768 },
  { id: "sd15-inpaint", name: "SD 1.5 局部重绘", hint: "原图 + 遮罩（白=要改）", cf: "@cf/runwayml/stable-diffusion-v1-5-inpainting", mode: "json", family: "sd", caps: ["inpaint", "img2img"], group: "Stable Diffusion", defaultSteps: 20, minSteps: 1, maxSteps: 20, maxSize: 768 },
  { id: "grok-imagine-image-2.0", name: "Grok Imagine 2.0", hint: "生图 + 编辑", backend: "grok", caps: ["txt2img", "img2img"], group: "Grok Imagine" },
  { id: "grok-imagine-image-quality", name: "Grok Imagine Quality", hint: "高质量生图/编辑", backend: "grok", caps: ["txt2img", "img2img"], group: "Grok Imagine" },
  { id: "grok-imagine-image", name: "Grok Imagine", hint: "标准生图/编辑", backend: "grok", caps: ["txt2img", "img2img"], group: "Grok Imagine" },
  { id: "grok-imagine-image-lite", name: "Grok Imagine Lite", hint: "更快更省", backend: "grok", caps: ["txt2img"], group: "Grok Imagine" },
  { id: "grok-imagine-image-edit", name: "Grok Imagine Edit", hint: "只编辑 · 必须参考图", backend: "grok", caps: ["img2img"], group: "Grok Imagine" },
  { id: "moondream3.1-9B-A2B", name: "Moondream 3.1", hint: "看图问答 · 不能生图", cf: "@cf/moondream/moondream3.1-9B-A2B", mode: "json", caps: ["vision"], group: "视觉模型" },
];
const ASPECT = { "1:1": [1024, 1024], "16:9": [1280, 720], "9:16": [720, 1280], "4:3": [1024, 768], "3:4": [768, 1024], "3:2": [1152, 768], "2:3": [768, 1152] };
const MAX_TRIES = 24;
const PAGE = fs.readFileSync(path.join(__dirname, "src", "index.html"), "utf8");
const ADMIN_PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>焰池管理员</title>
<style>
body{font-family:sans-serif;max-width:1080px;margin:24px auto;padding:0 16px;background:#f7f3ff;color:#231c36}
h1{font-size:20px}h3{margin:0 0 10px}label{display:block;margin:10px 0 4px;font-size:12px;color:#666}
input{padding:8px 10px;border:1px solid #ddd;border-radius:8px;width:160px}
button{margin-top:12px;padding:8px 14px;border:0;border-radius:8px;background:#a855f7;color:#fff;cursor:pointer}
table{width:100%;border-collapse:collapse;margin-top:16px;background:#fff;border-radius:12px;overflow:hidden}
th,td{padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;text-align:left}
.card{background:#fff;padding:16px;border-radius:12px;margin:16px 0}
.row{display:flex;flex-wrap:wrap;gap:12px;align-items:end}
a{color:#7c3aed}code{background:#f3e8ff;padding:2px 6px;border-radius:6px}
</style></head><body>
<h1>焰池管理员 · 优惠码 / 存图上限</h1>
<p><a href="/">返回生图</a></p>
<div class="card">
  <h3>生成优惠码</h3>
  <div class="row">
    <div><label>每天可生成张数</label><input id="daily" type="number" value="20"></div>
    <div><label>可使用天数</label><input id="days" type="number" value="7"></div>
    <div><label>可被兑换次数</label><input id="max" type="number" value="1"></div>
    <div><label>云图库上限（张）</label><input id="storage" type="number" value="50"></div>
    <div><label>备注</label><input id="note" type="text" placeholder="例如：内测用户"></div>
  </div>
  <div><button id="go">生成</button></div>
  <p id="out"></p>
</div>
<div class="card">
  <h3>已生成优惠码</h3>
  <table><thead><tr><th>码</th><th>每天张数</th><th>天数</th><th>存图上限</th><th>已兑/上限</th><th>备注</th></tr></thead>
  <tbody id="tb"></tbody></table>
</div>
<div class="card">
  <h3>用户存图上限</h3>
  <p style="font-size:13px;color:#666">可单独改某个已兑换用户的云图库张数。0 表示不让存图。</p>
  <div class="row">
    <div><label>用户 ID</label><input id="uid" type="text" placeholder="Linux Do 数字 ID"></div>
    <div><label>新的存图上限</label><input id="ustorage" type="number" value="50"></div>
    <div><button id="usave">保存上限</button></div>
  </div>
  <p id="uout"></p>
  <table><thead><tr><th>用户</th><th>ID</th><th>今日已用</th><th>云图库</th><th>到期</th></tr></thead>
  <tbody id="users"></tbody></table>
</div>
<script>
async function load(){
  const r = await fetch('/api/admin/codes');
  const d = await r.json();
  document.getElementById('tb').innerHTML = (d.items||[]).map(c => '<tr><td><code>'+c.code+'</code></td><td>'+c.dailyLimit+'</td><td>'+c.days+'</td><td>'+(c.storageLimit??50)+'</td><td>'+c.usedCount+'/'+c.maxRedeems+'</td><td>'+(c.note||'')+'</td></tr>').join('');
  const ur = await fetch('/api/admin/users');
  const ud = await ur.json();
  document.getElementById('users').innerHTML = (ud.items||[]).map(u => {
    const p = u.plan || {};
    const exp = p.expiresAt ? new Date(p.expiresAt).toLocaleDateString() : '-';
    return '<tr><td>@'+(u.username||'')+(u.admin?' · 管理':'')+'</td><td>'+u.id+'</td><td>'+(p.usedToday||0)+'/'+(p.dailyLimit||0)+'</td><td>'+(u.storedCount||0)+'/'+(u.storageLimit||p.storageLimit||0)+'</td><td>'+exp+'</td></tr>';
  }).join('');
}
document.getElementById('go').onclick = async function(){
  const r = await fetch('/api/admin/codes', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({
    dailyLimit: Number(document.getElementById('daily').value),
    days: Number(document.getElementById('days').value),
    maxRedeems: Number(document.getElementById('max').value),
    storageLimit: Number(document.getElementById('storage').value),
    note: document.getElementById('note').value
  })});
  const d = await r.json();
  document.getElementById('out').textContent = d.code ? ('已生成：'+d.code.code+'  每天'+d.code.dailyLimit+'张 / '+d.code.days+'天 / 存图'+d.code.storageLimit+'张') : (d.error||'失败');
  load();
};
document.getElementById('usave').onclick = async function(){
  const r = await fetch('/api/admin/users', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({
    id: document.getElementById('uid').value.trim(),
    storageLimit: Number(document.getElementById('ustorage').value)
  })});
  const d = await r.json();
  document.getElementById('uout').textContent = d.user ? ('已更新 @'+d.user.username+' 存图上限 '+d.user.storageLimit) : (d.error||'失败');
  load();
};
load();
</script>
</body></html>`;


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
const authApi = createAuth({ redisCmd, useUpstash: USE_UPSTASH, dataDir: DATA_DIR });


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
      return json(res, modelsPayload());
    }
    if (req.method === "GET" && p === "/api/health") return json(res, await readHealth());
    if (req.method === "GET" && p === "/auth/linuxdo/login") {
      if (!authApi.AUTH_ENABLED) return json(res, { error: "未配置 LINUX_DO_CLIENT_ID / LINUX_DO_CLIENT_SECRET" }, 500);
      const state = randomUUID();
      res.writeHead(302, {
        Location: authApi.loginUrl(state),
        "Set-Cookie": authApi.cookieHeader("fp_oauth", state, 600),
      });
      return res.end();
    }
    if (req.method === "GET" && p === "/auth/linuxdo/callback") {
      try {
        const cookies = authApi.parseCookies(req);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code) throw new Error("缺少 code");
        if (cookies.fp_oauth && state && cookies.fp_oauth !== state) throw new Error("state 不匹配");
        const info = await authApi.exchangeCode(code);
        const user = await authApi.upsertUser(info);
        const sid = authApi.makeSid(user);
        res.writeHead(302, {
          Location: "/",
          "Set-Cookie": [
            authApi.cookieHeader("fp_sid", sid, 30 * 86400),
            authApi.cookieHeader("fp_oauth", "", 0),
          ],
        });
        return res.end();
      } catch (err) {
        return json(res, { error: formatError(err) }, 400);
      }
    }
    if (req.method === "POST" && p === "/auth/logout") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": authApi.cookieHeader("fp_sid", "", 0),
      });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === "GET" && p === "/api/gallery") {
      const user = await requireUser(req, res, false);
      if (!user) return;
      const items = await authApi.listGallery(user);
      const limit = user.admin ? 99999 : Number((user.plan && user.plan.storageLimit) ?? 50);
      return json(res, { r2: r2Enabled(), items, storageLimit: limit, storedCount: items.length });
    }
    if (req.method === "GET" && p.startsWith("/api/gallery/file/")) {
      const user = await requireUser(req, res, false);
      if (!user) return;
      const key = decodeURIComponent(p.slice("/api/gallery/file/".length));
      const item = (user.gallery || []).find((x) => x.key === key);
      if (!item && !user.admin) return json(res, { error: "图片不存在" }, 404);
      try {
        const obj = await getFromR2(key);
        if (!obj) return json(res, { error: "未配置 R2" }, 500);
        res.writeHead(200, {
          "Content-Type": obj.mime || "image/jpeg",
          "Cache-Control": "private, max-age=31536000, immutable",
          "Content-Length": obj.bytes.length,
        });
        return res.end(obj.bytes);
      } catch (err) {
        return json(res, { error: formatError(err) }, 404);
      }
    }
    async function deleteGallery(user, key) {
      const item = (user.gallery || []).find((x) => x.key === key || x.id === key);
      if (item && item.key) await deleteFromR2(item.key);
      return authApi.removeGalleryItem(user, key);
    }
    if (req.method === "POST" && p === "/api/gallery/delete") {
      const user = await requireUser(req, res, false);
      if (!user) return;
      const body = await readBody(req);
      const key = String(body.key || body.id || "");
      if (!key) return json(res, { error: "缺少图片 key" }, 400);
      const items = await deleteGallery(user, key);
      return json(res, { ok: true, items, storedCount: items.length });
    }
    if (req.method === "DELETE" && p.startsWith("/api/gallery/")) {
      const user = await requireUser(req, res, false);
      if (!user) return;
      const key = decodeURIComponent(p.slice("/api/gallery/".length));
      const items = await deleteGallery(user, key);
      return json(res, { ok: true, items, storedCount: items.length });
    }
    if (req.method === "GET" && p === "/api/me") {
      const user = await currentUser(req);
      return json(res, { authEnabled: authApi.AUTH_ENABLED, r2: r2Enabled(), user: authApi.publicUser(user) });
    }
    if (req.method === "POST" && p === "/api/redeem") {
      const user = await requireUser(req, res, false);
      if (!user) return;
      const body = await readBody(req);
      try { return json(res, { ok: true, user: await authApi.redeem(user, body.code) }); }
      catch (err) { return json(res, { error: formatError(err) }, err.status || 400); }
    }
    if (req.method === "GET" && p === "/api/admin/codes") {
      const user = await requireUser(req, res, true);
      if (!user) return;
      const codes = await authApi.listPrefix("code");
      codes.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return json(res, { items: codes });
    }
    if (req.method === "POST" && p === "/api/admin/codes") {
      const user = await requireUser(req, res, true);
      if (!user) return;
      const body = await readBody(req);
      try { return json(res, { ok: true, code: await authApi.createCode(user, body) }); }
      catch (err) { return json(res, { error: formatError(err) }, err.status || 400); }
    }
    if (req.method === "GET" && p === "/api/admin/users") {
      const user = await requireUser(req, res, true);
      if (!user) return;
      return json(res, { items: (await authApi.listPrefix("user")).map((u) => authApi.publicUser(u)) });
    }
    if (req.method === "POST" && p === "/api/admin/users") {
      const user = await requireUser(req, res, true);
      if (!user) return;
      const body = await readBody(req);
      try { return json(res, { ok: true, user: await authApi.updateUserPlan(body.id || body.userId, body) }); }
      catch (err) { return json(res, { error: formatError(err) }, err.status || 400); }
    }
    if (req.method === "GET" && p === "/admin") {
      const user = await requireUser(req, res, true);
      if (!user) return;
      return html(res, ADMIN_PAGE);
    }
    if (req.method === "GET" && p === "/api/accounts") {
      const user = await requireUser(req, res, true);
      if (!user) return;
      return json(res, await readAccountStatus());
    }
    if (req.method === "GET" && p.startsWith("/api/jobs/")) {
      const user = await requireUser(req, res, false);
      if (!user) return;
      const id = p.slice("/api/jobs/".length).split("/")[0];
      const job = await readJob(id);
      return job ? json(res, job) : json(res, { error: "任务不存在" }, 404);
    }
    if (req.method === "POST" && p === "/api/vision") {
      const user = await requireUser(req, res, false);
      if (!user) return;
      try { await authApi.consumeQuota(user); }
      catch (err) { return json(res, { error: formatError(err) }, err.status || 403); }
      const body = await readBody(req);
      try { return json(res, await vision(body)); }
      catch (err) {
        await authApi.refundQuota(user);
        return json(res, { error: formatError(err) }, err.status || 500);
      }
    }
    if (req.method === "POST" && p === "/api/generate/stream") {
      const user = await requireUser(req, res, false);
      if (!user) return;
      const body = await readBody(req);
      return streamGenerate(req, res, body, user);
    }
    if (req.method === "POST" && (p === "/api/generate" || p === "/api/generate/async" || p === "/v1/images/generations" || p === "/v1/images/edits")) {
      const user = await requireUser(req, res, false);
      if (!user) return;
      try { await authApi.consumeQuota(user); }
      catch (err) { return json(res, { error: formatError(err) }, err.status || 403); }
      const body = await readBody(req);
      if (p === "/v1/images/edits") body.images = collectImages(body);
      try {
        let result = await generate(body);
        result = await maybeStoreR2(user, result, randomUUID(), body);
        if (p.startsWith("/v1/images/")) {
          const b64 = String(result.image_base64 || "").replace(/^data:[^;]+;base64,/, "");
          return json(res, { created: Math.floor(Date.now() / 1000), data: [{ b64_json: b64, url: result.stored ? result.image_url : undefined }], model: result.model, account: result.account });
        }
        return json(res, { status: "completed", ...publicResult(result) });
      } catch (err) {
        await authApi.refundQuota(user);
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

async function currentUser(req) {
  try { return await authApi.getSessionUser(req); }
  catch { return null; }
}

async function requireUser(req, res, needAdmin) {
  if (!authApi.AUTH_ENABLED) {
    return { id: "local", username: "local", admin: true, plan: { dailyLimit: 9999, usedToday: 0, expiresAt: Date.now() + 86400000 * 365 } };
  }
  const user = await currentUser(req);
  if (!user) {
    json(res, { error: "请先用 Linux Do 登录", login: "/auth/linuxdo/login" }, 401);
    return null;
  }
  if (needAdmin && !user.admin) {
    json(res, { error: "需要管理员 Linux Do 账号" }, 403);
    return null;
  }
  return user;
}

function auth(req, url, res) {
  return true;
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
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}
function html(res, page) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page);
}
function send(res, status, body) {
  res.writeHead(status, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS" });
  res.end(body || "");
}
function publicResult(result) {
  if (!result) return result;
  const out = { ...result };
  delete out.bytes;
  if (out.stored && out.image_url && !String(out.image_url).startsWith("data:")) {
    delete out.image_base64;
  }
  return out;
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

async function maybeStoreR2(user, result, jobId, body) {
  if (!user || !result || !result.bytes || !r2Enabled()) return result;
  let uploaded = null;
  try {
    uploaded = await uploadToR2({
      userId: user.id,
      bytes: result.bytes,
      mime: result.mime,
      jobId,
    });
    if (!uploaded) return result;
    await authApi.addGalleryItem(user, {
      id: jobId,
      key: uploaded.key,
      url: uploaded.url || publicObjectUrl(uploaded.key),
      mime: uploaded.mime,
      bytes: uploaded.bytes,
      model: result.model,
      prompt: String((body && body.prompt) || "").slice(0, 240),
      createdAt: Date.now(),
    });
    result.image_url = uploaded.url || publicObjectUrl(uploaded.key);
    result.stored = true;
    result.storage_key = uploaded.key;
  } catch (err) {
    result.store_error = formatError(err);
    if (uploaded && uploaded.key) {
      try { await deleteFromR2(uploaded.key); } catch (_) {}
    }
  }
  return result;
}

async function streamGenerate(req, res, body, user) {
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
  let ping = null;
  if (user) {
    try { await authApi.consumeQuota(user); }
    catch (err) {
      sse("error", { job_id: jobId, error: formatError(err) });
      try { res.end(); } catch (_) {}
      return;
    }
  }
  sse("status", { job_id: jobId, message: "开始出图，额度用尽会自动换号" });
  ping = setInterval(() => {
    sse("ping", { job_id: jobId, t: Date.now() });
    try { res.write(":" + " ".repeat(256) + "\n\n"); } catch (_) {}
  }, 2000);
  const t0 = Date.now();
  try {
    let result = await generate(body, (info) => sse("status", { job_id: jobId, message: info.message || "出图中" }));
    result = await maybeStoreR2(user, result, jobId, body);
    await finishJob(jobId, result);
    sse("done", { job_id: jobId, status: "completed", duration_sec: (Date.now() - t0) / 1000, ...publicResult(result) });
  } catch (err) {
    await authApi.refundQuota(user);
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
    image_base64: result && result.stored ? null : (result && result.image_base64 || null),
    image_url: result && result.image_url || null,
    stored: !!(result && result.stored),
    store_error: result && result.store_error || null,
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
  const prompt = String(body.prompt || "").trim();
  if (!prompt) throw new PoolError("请输入提示词", "bad_input", 400);
  let model = resolveModel(body.model || process.env.DEFAULT_MODEL);
  if (model.caps && model.caps.includes("vision")) return vision(body);
  const images = await normalizeImages(collectImages(body));
  const needImg = model.caps.includes("inpaint") || (model.caps.includes("img2img") && !model.caps.includes("txt2img"));
  if (needImg && !images.length) {
    throw new PoolError(model.caps.includes("inpaint") ? "局部重绘请先上传原图，第二张作为遮罩（白色区域会被重绘）" : "该模型是图生图，请先上传参考图", "bad_input", 400);
  }
  if (images.length && !model.caps.includes("img2img") && !model.caps.includes("inpaint")) {
    model = model.backend === "grok" ? resolveModel("grok-imagine-image-2.0") : resolveModel("flux-2-klein-4b");
  }
  if (model.backend === "grok") return generateGrok(model, { prompt, images, body, onProgress });
  if (!POOL.accounts.length) throw new PoolError("号池为空", "config", 500);
  const [width, height] = parseSize(body, model);
  const seed = body.seed == null || body.seed === "" ? undefined : Number(body.seed);
  const steps = body.steps == null || body.steps === "" ? undefined : Number(body.steps);
  const negative = String(body.negative_prompt || body.negative || "").trim();
  const strength = body.strength == null || body.strength === "" ? undefined : Number(body.strength);
  const guidance = body.guidance == null || body.guidance === "" ? undefined : Number(body.guidance);
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
      const out = await runAccount(acc, model, { prompt, width, height, seed, steps, images, negative, strength, guidance });
      if (!isCompleteImage(out.bytes, out.mime)) throw new PoolError("图片被截断，账号额度可能中途耗尽", "truncated", 502);
      await report({ account_id: acc.account_id, name: acc.name, ok: true });
      const stored = toDataUri(out.bytes, out.mime);
      return { model: model.id, account: acc.name, mime: out.mime, bytes: out.bytes, image_base64: stored, image_url: stored, tried: tried.length, backend: "node" };
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

function grokEnabled() {
  return !!GROK_KEY;
}

function rewriteGrokUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  try {
    const u = new URL(text, GROK_BASE);
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "0.0.0.0") {
      const base = new URL(GROK_BASE);
      u.protocol = base.protocol;
      u.host = base.host;
    }
    return u.toString();
  } catch {
    return GROK_BASE + (text.startsWith("/") ? text : "/" + text);
  }
}

async function downloadGrokImage(url) {
  const abs = rewriteGrokUrl(url);
  const headers = {};
  if (GROK_KEY) headers.Authorization = "Bearer " + GROK_KEY;
  const res = await fetch(abs, { headers });
  if (!res.ok) throw new PoolError("Grok 图片下载失败 HTTP " + res.status, "truncated", 502);
  const bytes = Buffer.from(await res.arrayBuffer());
  const mime = sniffMime(bytes) || (res.headers.get("content-type") || "image/jpeg").split(";")[0];
  if (!isCompleteImage(bytes, mime)) throw new PoolError("Grok 返回的图片不完整", "truncated", 502);
  return { bytes, mime };
}

function grokAspect(body) {
  const ratio = String((body && body.aspect_ratio) || "1:1");
  return { "1:1": "1:1", "16:9": "16:9", "9:16": "9:16", "2:3": "2:3", "3:2": "3:2", "4:3": "4:3", "3:4": "3:4" }[ratio] || "1:1";
}

function grokResolution(body) {
  const raw = String((body && (body.resolution || body.grok_resolution)) || "1k").toLowerCase();
  return raw === "2k" ? "2k" : "1k";
}

function grokQuality(body) {
  const raw = String((body && (body.quality || body.grok_quality)) || "medium").toLowerCase();
  return raw === "low" ? "low" : "medium";
}

async function generateGrok(model, opt) {
  if (!GROK_KEY) throw new PoolError("未配置 GROK_API_KEY，请在 Northflank 环境变量填写", "config", 500);
  const body = opt.body || {};
  const edit = !!(opt.images && opt.images.length && model.caps.includes("img2img"));
  if (typeof opt.onProgress === "function") {
    opt.onProgress({ message: edit ? "Grok 正在按参考图编辑…" : "Grok Imagine 正在出图…" });
  }
  const path = edit ? "/v1/images/edits" : "/v1/images/generations";
  const payload = {
    model: model.id,
    prompt: opt.prompt,
    n: 1,
    quality: grokQuality(body),
    response_format: "b64_json",
    stream: false,
  };
  if (!edit) payload.aspect_ratio = grokAspect(body);
  if (!edit) payload.resolution = grokResolution(body);
  if (edit) {
    const refs = (opt.images || []).map((img) => {
      const dataUrl = toDataUri(img.bytes, img.mime);
      return { url: dataUrl };
    });
    payload.image = refs[0];
    payload.images = refs;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  let res;
  try {
    res = await fetch(GROK_BASE + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + GROK_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new PoolError(err.name === "AbortError" ? "Grok 出图超时" : "Grok 网络错误：" + formatError(err), "truncated", 504);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = {}; }
  if (!res.ok) {
    const message = (data.error && (data.error.message || data.error)) || data.message || text.slice(0, 180) || ("HTTP " + res.status);
    throw new PoolError(String(message), classifyError(res.status, message), res.status);
  }
  const item = (data.data && data.data[0]) || data;
  let out;
  if (item && item.b64_json) {
    const bytes = Buffer.from(String(item.b64_json).replace(/^data:[^;]+;base64,/, ""), "base64");
    const mime = sniffMime(bytes) || "image/jpeg";
    out = { bytes, mime };
  } else if (item && item.url) {
    out = await downloadGrokImage(item.url);
  } else {
    throw new PoolError("Grok 没有返回图片：" + String(text).slice(0, 180), "truncated", 502);
  }
  if (!isCompleteImage(out.bytes, out.mime)) throw new PoolError("Grok 图片不完整", "truncated", 502);
  const stored = toDataUri(out.bytes, out.mime);
  return {
    model: model.id,
    account: "grok",
    mime: out.mime,
    bytes: out.bytes,
    image_base64: stored,
    image_url: stored,
    tried: 0,
    backend: "grok",
  };
}

function modelsPayload() {
  const items = {};
  for (const m of MODELS) {
    const g = m.group || "Cloudflare Workers AI 号池";
    (items[g] ||= []).push({ id: m.id, name: m.name, hint: m.hint, capabilities: m.caps });
  }
  return { default: process.env.DEFAULT_MODEL || "flux-2-klein-4b", items };
}

function buildJsonPayload(model, opt) {
  const payload = { prompt: opt.prompt };
  if (model.family === "schnell") {
    payload.steps = clamp(opt.steps ?? model.defaultSteps ?? 4, model.minSteps || 1, model.maxSteps || 8);
    if (opt.seed != null && !Number.isNaN(opt.seed)) payload.seed = opt.seed;
    return payload;
  }
  if (opt.negative) payload.negative_prompt = opt.negative;
  if (opt.width) payload.width = opt.width;
  if (opt.height) payload.height = opt.height;
  if (opt.seed != null && !Number.isNaN(opt.seed)) payload.seed = opt.seed;
  const steps = clamp(opt.steps ?? model.defaultSteps ?? 20, model.minSteps || 1, model.maxSteps || 20);
  if (model.stepKey === "steps") payload.steps = steps;
  else {
    payload.num_steps = steps;
    if (String(model.cf).includes("leonardo")) payload.steps = steps;
  }
  if (opt.guidance != null && !Number.isNaN(opt.guidance)) payload.guidance = opt.guidance;
  else if (model.guidance != null) payload.guidance = model.guidance;
  const imgs = opt.images || [];
  if (imgs[0] && (model.caps.includes("img2img") || model.caps.includes("inpaint"))) {
    payload.image_b64 = Buffer.from(imgs[0].bytes).toString("base64");
    const strength = opt.strength != null && !Number.isNaN(opt.strength) ? opt.strength : 0.72;
    payload.strength = Math.max(0, Math.min(1, strength));
  }
  if (model.caps.includes("inpaint") && imgs[1]) {
    payload.mask_b64 = Buffer.from(imgs[1].bytes).toString("base64");
  }
  return payload;
}

async function runAccount(acc, model, opt) {
  const url = "https://api.cloudflare.com/client/v4/accounts/" + acc.account_id + "/ai/run/" + model.cf;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  let res;
  try {
    if (model.mode === "json") {
      const payload = buildJsonPayload(model, opt);
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
  const raw = Buffer.from(await res.arrayBuffer());
  const ctype = String(res.headers.get("content-type") || "");
  if (ctype.includes("image/")) {
    if (!res.ok) throw new PoolError("HTTP " + res.status, classifyError(res.status, "image error"), res.status);
    const mime = sniffMime(raw) || ctype.split(";")[0] || "image/png";
    if (!isCompleteImage(raw, mime)) throw new PoolError("图片被截断，换号重试", "truncated", 502);
    return { bytes: raw, mime };
  }
  const text = raw.toString("utf8");
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
  const image = (data && data.result && data.result.image) || (data && data.image) || (typeof (data && data.result) === "string" ? data.result : "");
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
function parseSize(body, model) {
  const max = (model && model.maxSize) || 1536;
  const min = (model && model.minSize) || 256;
  let w;
  let h;
  if (body.size && /^\d+x\d+$/i.test(body.size)) {
    [w, h] = String(body.size).toLowerCase().split("x").map(Number);
  } else {
    const ratio = ASPECT[body.aspect_ratio] ? body.aspect_ratio : "1:1";
    [w, h] = ASPECT[ratio];
    if (body.width) w = Number(body.width);
    if (body.height) h = Number(body.height);
  }
  w = clamp(w || 1024, min, max);
  h = clamp(h || 1024, min, max);
  if (Math.max(w, h) > max) {
    const s = max / Math.max(w, h);
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  if (!model || model.family === "sd" || model.mode === "json") {
    w = Math.max(min, Math.round(w / 8) * 8);
    h = Math.max(min, Math.round(h / 8) * 8);
  }
  return [w, h];
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
