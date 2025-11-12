export const onRequestOptions: PagesFunction<Env> = async ({ request, env }) => {
  return cors(env, new Response(null, { status: 204 }), request);
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // 認可
  const token = request.headers.get("X-Admin-Token");
  if (!token || token !== env.ADMIN_TOKEN) {
    return cors(env, json({ error: "Unauthorized" }, 401), request);
  }

  // multipart 以外は拒否
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return cors(env, json({ error: "Use multipart/form-data" }, 400), request);
  }

  const form = await request.formData();
  const file = form.get("file") as File | null;
  if (!file) {
    return cors(env, json({ error: "Missing file" }, 400), request);
  }

  // 入力
  const dir = sanitizeDir((form.get("dir") as string) || "images");
  const customFilename = (form.get("filename") as string) || "";
  const overwrite = ((form.get("overwrite") as string) || "").toLowerCase() === "true";

  // ファイル名決定
  const orig = file.name || "upload.bin";
  const safeOrig = sanitizeFilename(customFilename || orig);
  const datedPrefix = `${new Date().toISOString().slice(0,10).replaceAll("-", "/")}/`; // YYYY/MM/DD/
  const path = `${dir}/${datedPrefix}${uniquePrefix()}-${safeOrig}`.replaceAll("//", "/");

  // サイズ制限（例: 20MB）
  const maxBytes = 20 * 1024 * 1024;
  if (file.size > maxBytes) {
    return cors(env, json({ error: `File too large (> ${maxBytes} bytes)` }, 413), request);
  }

  // base64化（大きいバッファでも安全な分割エンコード）
  const buf = new Uint8Array(await file.arrayBuffer());
  const b64 = base64FromBytes(buf);

  const apiBase = "https://api.github.com";
  const repo = env.GH_REPO;    // e.g. "nagito-hiroshima/pool"
  const branch = env.GH_BRANCH || "main";

  // 上書きの場合は sha を取得
  let sha: string | undefined;
  if (overwrite) {
    const getRes = await fetch(`${apiBase}/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`, {
      headers: ghHeaders(env.GH_TOKEN),
    });
    if (getRes.ok) {
      const meta = await getRes.json<any>();
      sha = meta.sha;
    }
    // 存在しなくても続行（新規としてPUTする）
  }

  // PUT でコミット
  const putRes = await fetch(`${apiBase}/repos/${repo}/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: ghHeaders(env.GH_TOKEN),
    body: JSON.stringify({
      message: `Upload ${safeOrig} via CF Pages`,
      content: b64,
      branch,
      ...(sha ? { sha } : {})
    })
  });

  const text = await putRes.text();
  if (!putRes.ok) {
    return cors(env, json({ error: "GitHub API error", status: putRes.status, detail: safeJSON(text) }, putRes.status), request);
  }

  const payload = safeJSON(text);
  // raw URL（GitHubの生ファイルURL）
  const rawUrl = `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;

  return cors(env, json({ ok: true, path, rawUrl, github: payload }, 200), request);
};

/* ===== ユーティリティ ===== */
type Env = {
  GH_TOKEN: string;
  GH_REPO: string;
  GH_BRANCH?: string;
  ADMIN_TOKEN: string;
  ALLOWED_ORIGINS?: string; // CSV または "*" を想定
};

const json = (obj: any, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const ghHeaders = (token: string) => ({
  "Authorization": `token ${token}`,
  "Accept": "application/vnd.github+json",
  "Content-Type": "application/json",
  "User-Agent": "cf-pages-uploader"
});

const sanitizeFilename = (s: string) =>
  s.replaceAll(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+/, "").slice(0, 180) || "file.bin";

const sanitizeDir = (s: string) =>
  s.replaceAll(/[^a-zA-Z0-9/_-]/g, "_").replace(/^\/+/, "").replace(/\/+$/,"") || "uploads";

const uniquePrefix = () => {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 6);
  return `${t}-${r}`;
};

const safeJSON = (text: string) => {
  try { return JSON.parse(text); } catch { return text; }
};

// 大きなArrayBufferでも安全にbase64化
const base64FromBytes = (bytes: Uint8Array) => {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode(...sub);
  }
  // @ts-ignore (btoa は標準API)
  return btoa(binary);
};

// CORS
const cors = (env: Env, res: Response, req: Request) => {
  const origin = req.headers.get("Origin") || "";
  const allow = env.ALLOWED_ORIGINS?.split(",").map(s=>s.trim()) || [];
  const allowed = env.ALLOWED_ORIGINS === "*" || allow.includes(origin);
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token");
  headers.set("Vary", "Origin");
  if (allowed) headers.set("Access-Control-Allow-Origin", origin);
  return new Response(res.body, { status: res.status, headers });
};
