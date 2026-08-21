import { randomUUID, createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CLIENT_ID = String(process.env.LINUX_DO_CLIENT_ID || "").trim();
const CLIENT_SECRET = String(process.env.LINUX_DO_CLIENT_SECRET || "").trim();
const ADMIN_RAW = String(process.env.LINUX_DO_ADMIN_IDS || process.env.LINUX_DO_ADMIN_ID || "").trim();
const PUBLIC_URL = String(process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const REDIRECT = String(process.env.LINUX_DO_REDIRECT_URI || (PUBLIC_URL ? PUBLIC_URL + "/auth/linuxdo/callback" : "")).trim();
const SESSION_SECRET = String(process.env.SESSION_SECRET || CLIENT_SECRET || "fluxpool-dev-secret").trim();
export const AUTH_ENABLED = !!(CLIENT_ID && CLIENT_SECRET);

const ADMINS = new Set(ADMIN_RAW.split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean));

function isAdminUser(user) {
  if (!user) return false;
  const id = String(user.id || "");
  const name = String(user.username || "").toLowerCase();
  return ADMINS.has(id) || ADMINS.has(name) || user.admin === true;
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}
function sign(obj) {
  const body = b64url(JSON.stringify(obj));
  const sig = createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return body + "." + sig;
}
function unsign(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expect = createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(body, "base64url").toString("utf8")); }
  catch { return null; }
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || "");
  const out = {};
  raw.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function cookieHeader(name, value, maxAge) {
  const parts = [
    name + "=" + encodeURIComponent(value),
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (PUBLIC_URL.startsWith("https://")) parts.push("Secure");
  if (maxAge != null) parts.push("Max-Age=" + maxAge);
  return parts.join("; ");
}

export function createAuth({ redisCmd, useUpstash, dataDir }) {
  const file = (name) => path.join(dataDir, name);
  function readJson(name, fallback) {
    try { return JSON.parse(fs.readFileSync(file(name), "utf8")); }
    catch { return fallback; }
  }
  function writeJson(name, data) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file(name), JSON.stringify(data));
  }

  async function kvGet(key) {
    if (useUpstash) {
      const raw = await redisCmd(["GET", key]);
      return raw ? JSON.parse(raw) : null;
    }
    const db = readJson("auth.json", { users: {}, codes: {}, sessions: {} });
    if (key.startsWith("fluxpool:user:")) return db.users[key.slice(14)] || null;
    if (key.startsWith("fluxpool:code:")) return db.codes[key.slice(14)] || null;
    if (key.startsWith("fluxpool:session:")) return db.sessions[key.slice(17)] || null;
    return null;
  }
  async function kvSet(key, value, ttlSec) {
    if (useUpstash) {
      const args = ["SET", key, JSON.stringify(value)];
      if (ttlSec) args.push("EX", String(ttlSec));
      await redisCmd(args);
      return;
    }
    const db = readJson("auth.json", { users: {}, codes: {}, sessions: {} });
    if (key.startsWith("fluxpool:user:")) db.users[key.slice(14)] = value;
    else if (key.startsWith("fluxpool:code:")) db.codes[key.slice(14)] = value;
    else if (key.startsWith("fluxpool:session:")) db.sessions[key.slice(17)] = value;
    writeJson("auth.json", db);
  }
  async function kvDel(key) {
    if (useUpstash) { await redisCmd(["DEL", key]); return; }
    const db = readJson("auth.json", { users: {}, codes: {}, sessions: {} });
    if (key.startsWith("fluxpool:user:")) delete db.users[key.slice(14)];
    else if (key.startsWith("fluxpool:code:")) delete db.codes[key.slice(14)];
    else if (key.startsWith("fluxpool:session:")) delete db.sessions[key.slice(17)];
    writeJson("auth.json", db);
  }
  async function listPrefix(kind) {
    if (useUpstash) {
      const pattern = kind === "code" ? "fluxpool:code:*" : kind === "user" ? "fluxpool:user:*" : "fluxpool:session:*";
      const keys = (await redisCmd(["KEYS", pattern])) || [];
      const out = [];
      for (const k of keys) {
        const raw = await redisCmd(["GET", k]);
        if (raw) out.push(JSON.parse(raw));
      }
      return out;
    }
    const db = readJson("auth.json", { users: {}, codes: {}, sessions: {} });
    if (kind === "code") return Object.values(db.codes || {});
    if (kind === "user") return Object.values(db.users || {});
    return Object.values(db.sessions || {});
  }

  async function getSessionUser(req) {
    const sid = parseCookies(req).fp_sid;
    if (!sid) return null;
    const sess = unsign(sid);
    if (!sess || !sess.uid || (sess.exp && sess.exp < Date.now())) return null;
    const user = await kvGet("fluxpool:user:" + sess.uid);
    if (!user) return null;
    user.admin = isAdminUser(user);
    return user;
  }

  function publicUser(user) {
    if (!user) return null;
    const plan = user.plan || null;
    const today = new Date().toISOString().slice(0, 10);
    const usedToday = plan && plan.usedDate === today ? (plan.usedToday || 0) : 0;
    const expired = !!(plan && plan.expiresAt && plan.expiresAt < Date.now());
    const dailyLimit = plan ? Number(plan.dailyLimit || 0) : 0;
    const storedCount = Array.isArray(user.gallery) ? user.gallery.length : Number(user.storedCount || 0);
    const storageLimit = isAdminUser(user) ? 99999 : Number((plan && plan.storageLimit) ?? 50);
    return {
      id: user.id,
      username: user.username,
      name: user.name || user.username,
      avatar: user.avatar || "",
      admin: isAdminUser(user),
      storageLimit,
      storedCount,
      plan: plan ? {
        code: plan.code,
        dailyLimit,
        usedToday,
        remainingToday: Math.max(0, dailyLimit - usedToday),
        storageLimit: Number(plan.storageLimit ?? 50),
        expiresAt: plan.expiresAt || 0,
        expired,
        daysLeft: plan.expiresAt ? Math.max(0, Math.ceil((plan.expiresAt - Date.now()) / 86400000)) : 0,
      } : null,
    };
  }

  async function addGalleryItem(user, item) {
    const limit = isAdminUser(user) ? 99999 : Number((user.plan && user.plan.storageLimit) ?? 50);
    const gallery = Array.isArray(user.gallery) ? user.gallery.slice() : [];
    if (!isAdminUser(user) && limit > 0 && gallery.length >= limit) {
      const err = new Error("图库已满（上限 " + limit + " 张）。请删除旧图或联系管理员提高上限");
      err.status = 403;
      err.kind = "storage";
      throw err;
    }
    gallery.unshift(item);
    user.gallery = gallery.slice(0, isAdminUser(user) ? 500 : (limit > 0 ? limit : gallery.length));
    user.storedCount = user.gallery.length;
    await kvSet("fluxpool:user:" + user.id, user);
    return user.gallery;
  }
  async function listGallery(user) {
    return Array.isArray(user.gallery) ? user.gallery : [];
  }
  async function removeGalleryItem(user, key) {
    user.gallery = (user.gallery || []).filter((x) => x.key !== key && x.id !== key);
    user.storedCount = user.gallery.length;
    await kvSet("fluxpool:user:" + user.id, user);
    return user.gallery;
  }
  async function updateUserPlan(id, patch) {
    const user = await kvGet("fluxpool:user:" + String(id));
    if (!user) {
      const err = new Error("用户不存在");
      err.status = 404;
      throw err;
    }
    user.plan = user.plan || {};
    if (patch.storageLimit != null && patch.storageLimit !== "") {
      user.plan.storageLimit = Math.max(0, Number(patch.storageLimit));
    }
    if (patch.dailyLimit != null && patch.dailyLimit !== "") {
      user.plan.dailyLimit = Math.max(1, Number(patch.dailyLimit));
    }
    if (patch.days != null && patch.days !== "") {
      user.plan.expiresAt = Date.now() + Math.max(1, Number(patch.days)) * 86400000;
    }
    await kvSet("fluxpool:user:" + user.id, user);
    return publicUser(user);
  }

  async function consumeQuota(user) {
    if (isAdminUser(user)) return { ok: true, remaining: 9999 };
    const plan = user.plan;
    if (!plan) {
      const err = new Error("请先兑换优惠码后再生图");
      err.status = 403;
      err.kind = "quota";
      throw err;
    }
    if (plan.expiresAt && plan.expiresAt < Date.now()) {
      const err = new Error("优惠码已过期，请联系管理员重新发放");
      err.status = 403;
      err.kind = "quota";
      throw err;
    }
    const today = new Date().toISOString().slice(0, 10);
    if (plan.usedDate !== today) {
      plan.usedDate = today;
      plan.usedToday = 0;
    }
    const limit = Number(plan.dailyLimit || 0);
    if (plan.usedToday >= limit) {
      const err = new Error("今日额度已用完（" + limit + " 张），明天 0 点刷新或联系管理员");
      err.status = 429;
      err.kind = "quota";
      throw err;
    }
    plan.usedToday += 1;
    plan.totalUsed = (plan.totalUsed || 0) + 1;
    user.plan = plan;
    await kvSet("fluxpool:user:" + user.id, user);
    return { ok: true, remaining: Math.max(0, limit - plan.usedToday) };
  }

  async function refundQuota(user) {
    if (!user || isAdminUser(user) || !user.plan) return;
    const today = new Date().toISOString().slice(0, 10);
    if (user.plan.usedDate === today && user.plan.usedToday > 0) {
      user.plan.usedToday -= 1;
      user.plan.totalUsed = Math.max(0, (user.plan.totalUsed || 1) - 1);
      await kvSet("fluxpool:user:" + user.id, user);
    }
  }

  function loginUrl(state) {
    const u = new URL("https://connect.linux.do/oauth2/authorize");
    u.searchParams.set("client_id", CLIENT_ID);
    u.searchParams.set("redirect_uri", REDIRECT);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "user");
    u.searchParams.set("state", state);
    return u.toString();
  }

  async function exchangeCode(code) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT,
      code,
    });
    const tokenRes = await fetch("https://connect.linux.do/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const token = await tokenRes.json();
    if (!tokenRes.ok || !token.access_token) {
      throw new Error(token.error_description || token.error || "Linux Do 换票失败");
    }
    const userRes = await fetch("https://connect.linux.do/api/user", {
      headers: { Authorization: "Bearer " + token.access_token },
    });
    const info = await userRes.json();
    if (!userRes.ok || info.id == null) throw new Error("读取 Linux Do 用户失败");
    return {
      id: String(info.id),
      username: info.username || info.login || String(info.id),
      name: info.name || info.username || "",
      avatar: info.avatar_url || info.avatar_template || "",
      trust_level: info.trust_level || 0,
    };
  }

  async function upsertUser(info) {
    const prev = (await kvGet("fluxpool:user:" + info.id)) || {};
    const user = {
      ...prev,
      id: info.id,
      username: info.username,
      name: info.name,
      avatar: info.avatar,
      trust_level: info.trust_level,
      lastLogin: Date.now(),
    };
    user.admin = isAdminUser(user);
    await kvSet("fluxpool:user:" + user.id, user);
    return user;
  }

  function makeSid(user) {
    return sign({ uid: user.id, exp: Date.now() + 30 * 86400000 });
  }

  function genCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s = "FP-";
    const buf = randomBytes(8);
    for (let i = 0; i < 8; i++) s += alphabet[buf[i] % alphabet.length];
    return s;
  }

  async function createCode(admin, body) {
    const dailyLimit = Math.max(1, Number(body.dailyLimit || body.daily || 10));
    const days = Math.max(1, Number(body.days || body.durationDays || 7));
    const maxRedeems = Math.max(1, Number(body.maxRedeems || body.maxUses || 1));
    const storageLimit = Math.max(0, Number(body.storageLimit || body.galleryLimit || 50));
    const code = String(body.code || genCode()).toUpperCase();
    const row = {
      code,
      dailyLimit,
      days,
      maxRedeems,
      storageLimit,
      usedCount: 0,
      note: String(body.note || ""),
      createdBy: admin.username,
      createdAt: Date.now(),
    };
    await kvSet("fluxpool:code:" + code, row);
    return row;
  }

  async function redeem(user, rawCode) {
    const code = String(rawCode || "").trim().toUpperCase();
    if (!code) throw Object.assign(new Error("请输入优惠码"), { status: 400 });
    const row = await kvGet("fluxpool:code:" + code);
    if (!row) throw Object.assign(new Error("优惠码不存在"), { status: 404 });
    if (row.usedCount >= row.maxRedeems) throw Object.assign(new Error("优惠码兑换次数已用完"), { status: 410 });
    row.usedCount += 1;
    row.lastRedeemBy = user.username;
    row.lastRedeemAt = Date.now();
    await kvSet("fluxpool:code:" + code, row);
    user.plan = {
      code,
      dailyLimit: row.dailyLimit,
      storageLimit: Number(row.storageLimit || 50),
      expiresAt: Date.now() + row.days * 86400000,
      usedToday: 0,
      usedDate: "",
      totalUsed: 0,
      redeemedAt: Date.now(),
    };
    await kvSet("fluxpool:user:" + user.id, user);
    return publicUser(user);
  }

  return {
    AUTH_ENABLED,
    REDIRECT,
    getSessionUser,
    publicUser,
    consumeQuota,
    refundQuota,
    loginUrl,
    exchangeCode,
    upsertUser,
    makeSid,
    createCode,
    redeem,
    listPrefix,
    addGalleryItem,
    listGallery,
    removeGalleryItem,
    updateUserPlan,
    cookieHeader,
    parseCookies,
    isAdminUser,
  };
}
