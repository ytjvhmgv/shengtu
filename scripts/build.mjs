import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "src", "index.html"), "utf8");
const core = fs.readFileSync(path.join(root, "src", "worker-core.js"), "utf8");
const d1 = fs.readFileSync(path.join(root, "src", "d1.js"), "utf8");
if (!core.includes("__PAGE__") || !core.includes("__POOL__")) {
  throw new Error("src/worker-core.js missing __PAGE__ or __POOL__ placeholder");
}
const poolPath = path.join(root, "pool.json");
const pool = fs.existsSync(poolPath)
  ? JSON.parse(fs.readFileSync(poolPath, "utf8"))
  : { imported_at: null, count: 0, accounts: [] };

const worker = (core + "\n\n" + d1)
  .replace("__PAGE__", JSON.stringify(html))
  .replace("__POOL__", JSON.stringify(pool));
fs.writeFileSync(path.join(root, "worker.js"), worker);
console.log("wrote worker.js", worker.length, "chars, accounts", (pool.accounts || []).length);
