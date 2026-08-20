import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const src = process.argv[2];
if (!src) {
  console.error("用法: node scripts/import-pool.mjs <sub2api-account.json>");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(src, "utf8"));
const accounts = [];
const seen = new Set();
for (const item of data.accounts || []) {
  const cred = item.credentials || {};
  const base = String(cred.base_url || "");
  const m = base.match(/accounts\/([a-f0-9]{32})/i);
  const apiKey = String(cred.api_key || "").trim();
  if (!m || !apiKey) continue;
  const accountId = m[1].toLowerCase();
  if (seen.has(accountId)) continue;
  seen.add(accountId);
  accounts.push({
    name: item.name || accountId,
    account_id: accountId,
    api_key: apiKey,
  });
}

const out = {
  imported_at: new Date().toISOString(),
  source: path.basename(src),
  count: accounts.length,
  accounts,
};
const dest = path.join(root, "pool.json");
fs.writeFileSync(dest, JSON.stringify(out));
console.log("wrote", dest);
console.log("accounts", accounts.length);
