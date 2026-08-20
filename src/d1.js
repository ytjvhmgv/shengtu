async function ensureD1(env) {
  if (!env || !env.DB) return false;
  if (ensureD1.ready) return true;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)"
  ).run();
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS account_state (" +
      "account_id TEXT PRIMARY KEY," +
      "name TEXT," +
      "kind TEXT," +
      "until INTEGER DEFAULT 0," +
      "hits INTEGER DEFAULT 0," +
      "fail_streak INTEGER DEFAULT 0," +
      "ok INTEGER DEFAULT 0," +
      "fail INTEGER DEFAULT 0," +
      "last_error TEXT," +
      "last_ok INTEGER," +
      "last_fail INTEGER" +
    ")"
  ).run();
  ensureD1.ready = true;
  return true;
}

async function pickFromStore(env, pool, limit) {
  if (await ensureD1(env)) {
    const now = Date.now();
    const blockedRes = await env.DB.prepare(
      "SELECT account_id, kind, until FROM account_state WHERE until > ?"
    ).bind(now).all();
    const blocked = new Set((blockedRes.results || []).map((row) => row.account_id));
    const meta = await env.DB.prepare("SELECT v FROM meta WHERE k = ?").bind("cursor").first();
    let cursor = meta ? Number(meta.v) : NaN;
    const n = pool.accounts.length;
    if (!n) return { accounts: [], backend: "d1", cursor: 0 };
    if (!Number.isFinite(cursor) || cursor < 0) cursor = Math.floor(Math.random() * n);
    const start = ((cursor % n) + n) % n;
    const out = [];
    for (let i = 0; i < n && out.length < limit; i++) {
      const acc = pool.accounts[(start + i) % n];
      if (!blocked.has(acc.account_id)) out.push(acc);
    }
    return { accounts: out, backend: "d1", cursor: start };
  }
  const state = await loadState(env);
  return { accounts: pickAccounts(pool, state, limit), backend: "cache", state };
}

async function reportToStore(env, pool, payload) {
  if (await ensureD1(env)) {
    const now = Date.now();
    const id = payload.account_id;
    const name = payload.name || "";
    const row = await env.DB.prepare(
      "SELECT hits, fail_streak, ok, fail FROM account_state WHERE account_id = ?"
    ).bind(id).first();
    if (payload.ok) {
      const idx = pool.accounts.findIndex((a) => a.account_id === id);
      if (idx >= 0) {
        await env.DB.prepare(
          "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"
        ).bind("cursor", String((idx + 1) % pool.accounts.length)).run();
      }
      await env.DB.prepare(
        "INSERT INTO account_state (account_id, name, kind, until, hits, fail_streak, ok, fail, last_error, last_ok, last_fail) " +
        "VALUES (?, ?, NULL, 0, 0, 0, 1, 0, NULL, ?, NULL) " +
        "ON CONFLICT(account_id) DO UPDATE SET " +
        "name = excluded.name, kind = NULL, until = 0, fail_streak = 0, ok = account_state.ok + 1, last_ok = excluded.last_ok"
      ).bind(id, name, now).run();
      return;
    }
    if (payload.kind === "bad_input" || payload.kind === "config") return;
    let kind = payload.kind || "other";
    const failStreak = (row ? Number(row.fail_streak) : 0) + 1;
    const hits = (row ? Number(row.hits) : 0) + 1;
    if (kind === "rate" && failStreak >= 2) kind = "neurons";
    const until = disableUntil(kind);
    await env.DB.prepare(
      "INSERT INTO account_state (account_id, name, kind, until, hits, fail_streak, ok, fail, last_error, last_ok, last_fail) " +
      "VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, NULL, ?) " +
      "ON CONFLICT(account_id) DO UPDATE SET " +
      "name = excluded.name, kind = excluded.kind, until = excluded.until, hits = account_state.hits + 1, " +
      "fail_streak = account_state.fail_streak + 1, fail = account_state.fail + 1, last_error = excluded.last_error, last_fail = excluded.last_fail"
    ).bind(id, name, kind, until, hits, failStreak, payload.error || "", now).run();
    return;
  }
  const state = await loadState(env);
  if (payload.ok) {
    const acc = pool.accounts.find((a) => a.account_id === payload.account_id);
    if (acc) {
      if (state.disabled) delete state.disabled[acc.account_id];
      advanceCursor(state, pool, acc);
    }
    state.ok = (state.ok || 0) + 1;
  } else if (payload.kind !== "bad_input" && payload.kind !== "config") {
    const acc = pool.accounts.find((a) => a.account_id === payload.account_id) || {
      account_id: payload.account_id,
      name: payload.name,
    };
    disableAccount(state, acc, payload.kind || "other", payload.error);
  }
  await saveState(env, state);
}

async function readHealth(env, pool) {
  if (await ensureD1(env)) {
    const now = Date.now();
    const rows = await env.DB.prepare(
      "SELECT name, kind, until, hits, last_error FROM account_state WHERE until > ?"
    ).bind(now).all();
    const disabledRows = rows.results || [];
    const neurons = disabledRows.filter((row) => row.kind === "neurons").length;
    const auth = disabledRows.filter((row) => row.kind === "auth").length;
    const rate = disabledRows.filter((row) => row.kind === "rate").length;
    const meta = await env.DB.prepare("SELECT v FROM meta WHERE k = ?").bind("cursor").first();
    return {
      ok: true,
      backend: "d1",
      total: pool.accounts.length,
      available: Math.max(0, pool.accounts.length - disabledRows.length),
      disabled: disabledRows.length,
      neurons_exhausted: neurons,
      auth_disabled: auth,
      rate_limited: rate,
      cursor: meta ? Number(meta.v) || 0 : 0,
      imported_at: pool.imported_at || null,
      disabled_accounts: disabledRows.map((row) => ({
        name: row.name || "",
        kind: row.kind,
        until: row.until,
        hits: row.hits || 0,
        error: row.last_error || "",
      })),
    };
  }
  const state = await loadState(env);
  return summarizeHealth(pool, state);
}

async function readAccountStatus(env, pool) {
  const health = await readHealth(env, pool);
  return {
    backend: health.backend,
    total: health.total,
    available: health.available,
    neurons_exhausted: health.neurons_exhausted,
    disabled: health.disabled_accounts || [],
  };
}
function jobImageRequest(id) {
  return new Request("https://cf-flux-pool.internal/jobs/" + id + "/image");
}

async function createJob(env, id) {
  const now = Date.now();
  if (await ensureD1(env)) {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, status TEXT, error TEXT, model TEXT, account TEXT, mime TEXT, tried INTEGER, created_at INTEGER, updated_at INTEGER)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO jobs (id, status, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).bind(id, "processing", now, now).run();
  }
}

async function finishJob(env, id, result) {
  const now = Date.now();
  if (result && result.bytes) {
    try {
      await caches.default.put(
        jobImageRequest(id),
        new Response(result.bytes, {
          headers: {
            "Content-Type": result.mime || "image/jpeg",
            "Cache-Control": "public, max-age=3600",
          },
        })
      );
    } catch (_) {}
  }
  if (await ensureD1(env)) {
    await env.DB.prepare(
      "UPDATE jobs SET status = ?, error = ?, model = ?, account = ?, mime = ?, tried = ?, updated_at = ? WHERE id = ?"
    ).bind(
      result && result.ok === false ? "error" : "completed",
      result && result.error ? String(result.error).slice(0, 500) : null,
      result && result.model || null,
      result && result.account || null,
      result && result.mime || null,
      result && result.tried || 0,
      now,
      id
    ).run();
  }
}

async function readJob(env, id) {
  let row = null;
  if (await ensureD1(env)) {
    row = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first();
  }
  if (!row) return null;
  const out = {
    id: row.id,
    status: row.status,
    error: row.error,
    model: row.model,
    account: row.account,
    mime: row.mime,
    tried: row.tried,
  };
  if (row.status === "completed") {
    const img = await caches.default.match(jobImageRequest(id));
    if (img) {
      const buf = new Uint8Array(await img.arrayBuffer());
      const mime = img.headers.get("content-type") || row.mime || "image/jpeg";
      out.image_base64 = toDataUri(buf, mime);
      out.image_url = out.image_base64;
    }
  }
  return out;
}
