import { createHash, createHmac } from "node:crypto";

function env(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

export function r2Enabled() {
  return !!(env("R2_ACCOUNT_ID") && env("R2_ACCESS_KEY_ID") && env("R2_SECRET_ACCESS_KEY") && env("R2_BUCKET"));
}

function endpoint() {
  const custom = env("R2_ENDPOINT");
  if (custom) return custom.replace(/\/+$/, "");
  return "https://" + env("R2_ACCOUNT_ID") + ".r2.cloudflarestorage.com";
}

function publicBase() {
  return (env("R2_PUBLIC_BASE") || env("R2_PUBLIC_URL")).replace(/\/+$/, "");
}

export function publicObjectUrl(key) {
  const pub = publicBase();
  if (pub) return pub + "/" + key;
  return "/api/gallery/file/" + String(key || "").split("/").map(encodeURIComponent).join("/");
}

function hmac256(key, data) {
  return createHmac("sha256", key).update(data).digest();
}
function sha256hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function amzDate(d = new Date()) {
  const iso = d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return { amz: iso, date: iso.slice(0, 8) };
}

function signRequest({ method, key, contentType, body }) {
  const { amz, date } = amzDate();
  const host = new URL(endpoint()).host;
  const region = env("R2_REGION", "auto");
  const bucket = env("R2_BUCKET");
  const canonicalUri = "/" + bucket + "/" + String(key).split("/").map(encodeURIComponent).join("/");
  const payload = body && body.length ? body : Buffer.alloc(0);
  const payloadHash = sha256hex(payload);
  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amz,
  };
  if (contentType) headers["content-type"] = contentType;
  const signed = Object.keys(headers).sort();
  const canonicalHeaders = signed.map((h) => h + ":" + String(headers[h]).trim() + "\n").join("");
  const signedHeaders = signed.join(";");
  const canonical = [method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = date + "/" + region + "/s3/aws4_request";
  const stringToSign = ["AWS4-HMAC-SHA256", amz, scope, sha256hex(canonical)].join("\n");
  const kDate = hmac256("AWS4" + env("R2_SECRET_ACCESS_KEY"), date);
  const kRegion = hmac256(kDate, region);
  const kService = hmac256(kRegion, "s3");
  const kSigning = hmac256(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  headers.authorization =
    "AWS4-HMAC-SHA256 Credential=" + env("R2_ACCESS_KEY_ID") + "/" + scope +
    ", SignedHeaders=" + signedHeaders + ", Signature=" + signature;
  return { url: endpoint() + canonicalUri, headers };
}

export async function uploadToR2({ userId, bytes, mime, jobId }) {
  if (!r2Enabled()) return null;
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const key = "users/" + userId + "/" + (jobId || Date.now()) + "." + ext;
  const body = Buffer.from(bytes);
  const { url, headers } = signRequest({
    method: "PUT",
    key,
    contentType: mime || "image/jpeg",
    body,
  });
  const res = await fetch(url, { method: "PUT", headers, body });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("R2 上传失败 HTTP " + res.status + " " + String(text).slice(0, 180));
  }
  return {
    key,
    url: publicObjectUrl(key),
    bytes: body.length,
    mime: mime || "image/jpeg",
  };
}

export async function getFromR2(key) {
  if (!r2Enabled() || !key) return null;
  const { url, headers } = signRequest({
    method: "GET",
    key,
    body: Buffer.alloc(0),
  });
  const res = await fetch(url, { method: "GET", headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("R2 读取失败 HTTP " + res.status + " " + String(text).slice(0, 120));
  }
  return {
    bytes: Buffer.from(await res.arrayBuffer()),
    mime: (res.headers.get("content-type") || "image/jpeg").split(";")[0],
  };
}

export async function deleteFromR2(key) {
  if (!r2Enabled() || !key) return;
  const { url, headers } = signRequest({
    method: "DELETE",
    key,
    body: Buffer.alloc(0),
  });
  await fetch(url, { method: "DELETE", headers });
}
