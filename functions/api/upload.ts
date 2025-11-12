/**
 * Cloudflare Pages Functions
 * - アップロードしたファイルと content.json の項目追加を “同一コミット” で反映
 * - overwrite=false の場合は既存衝突時にユニーク名へ自動リネーム
 * - CORS 対応、サイズ上限、パス/ファイル名サニタイズ
 */

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
  const dirRaw = (form.get("dir") as string) ?? "";
  const dir = sanitizeDirAllowEmpty(dirRaw); // ルート直下OK
  const customFilename = (form.get("filename") as string) || "";
  const overwrite = ((form.get("overwrite") as string) || "").toLowerCase() === "true";

  // ファイル名決定
  const orig = file.name || "upload.bin";
  const safeOrig = sanitizeFilename(customFilename || orig);
  const hasExt = safeOrig.includes(".");
  const origExt = orig.includes(".") ? orig.split(".").pop() : "";
  const finalName = hasExt ? safeOrig : (origExt ? `${safeOrig}.${origExt}` : safeOrig);

  // GitHub API 用パス
  let targetName = finalName;
  let safePath = dir ? `${dir}/${targetName}` : targetName;

  // サイズ制限（例: 20MB）
  const maxBytes = 20 * 1024 * 1024;
  if (file.size > maxBytes) {
    return cors(env, json({ error: `File too large (> ${maxBytes} bytes)` }, 413), request);
  }

  // base64化（大きなバッファでも安全な手法）
  const buf = new Uint8Array(await file.arrayBuffer());
  const b64 = base64FromBytes(buf);

  const apiBase = "https://api.github.com";
  const repo = env.GH_REPO;    // e.g. "nagito-hiroshima/pool"
  const branch = env.GH_BRANCH || "main";

  // overwrite=false のときは事前に存在チェックしてユニーク名へ変更
  if (!overwrite) {
    const checkRes = await fetch(`${apiBase}/repos/${repo}/contents/${safePath}?ref=${encodeURIComponent(branch)}`, {
      headers: ghHeaders(env.GH_TOKEN),
    });
    if (checkRes.ok) {
      const oldTarget = targetName;
      targetName = `${uniquePrefix()}-${finalName}`;
      safePath   = dir ? `${dir}/${targetName}` : targetName;
      // console.log("rename to unique:", oldTarget, "=>", targetName);
    } else if (checkRes.status !== 404) {
      // 存在確認自体が失敗
      const detail = await checkRes.text();
      return cors(env, json({ error: "Failed to check existing file", status: checkRes.status, detail: safeJSON(detail) }, 502), request);
    }
  }

  // content.json を取得（なければ初期化）
  const contentPath = "content.json";
  let contentObj: any = null;
  {
    const getRes = await fetch(`${apiBase}/repos/${repo}/contents/${contentPath}?ref=${encodeURIComponent(branch)}`, {
      headers: ghHeaders(env.GH_TOKEN),
    });
    if (getRes.ok) {
      const meta = await getRes.json<any>();
      const rawB64 = String(meta.content || "").replace(/\n/g, "");
      const decoded = new TextDecoder().decode(Uint8Array.from(atob(rawB64), c => c.charCodeAt(0)));
      try {
        contentObj = JSON.parse(decoded);
      } catch {
        contentObj = { version: 1, generated_at: new Date().toISOString(), files: [] };
      }
    } else if (getRes.status === 404) {
      contentObj = { version: 1, generated_at: new Date().toISOString(), files: [] };
    } else {
      return cors(env, json({ error: "Failed to fetch content.json", status: getRes.status, detail: await getRes.text() }, 502), request);
    }
  }

  // content.json に追記するエントリ
  const normDir = dir ? `/${dir.replace(/^\/+|\/+$/g, "")}` : "/";
  const entry = {
    dir: normDir,
    name: targetName,
    path: (normDir === "/" ? `/${targetName}` : `${normDir}/${targetName}`),
    type: file.type || null,
    description: "",
    uploaded_at: new Date().toISOString()
  };
  if (!Array.isArray(contentObj.files)) contentObj.files = [];
  contentObj.files.unshift(entry);

  // version bump（minor+1）と generated_at 更新
  const bumpVersion = (v: string | number | undefined): string => {
    if (v === undefined || v === null) return "1.1";
    const s = String(v).trim();
    const m = s.match(/^(\d+)(?:\.(\d+))?$/);
    if (!m) return "1.1";
    const major = Number(m[1]);
    const minor = Number(m[2] ?? "0");
    return `${major}.${minor + 1}`;
  };
  contentObj.version = bumpVersion(contentObj.version);
  contentObj.generated_at = new Date().toISOString();

  // content.json の base64
  const encoder = new TextEncoder();
  const contentB64 = base64FromBytes(encoder.encode(JSON.stringify(contentObj, null, 2)));

  // 同一コミットにまとめるファイル群
  const filesToCommit: Record<string, { contentBase64: string; mode?: string }> = {
    [safePath]: { contentBase64: b64 },          // アップロード本体
    [contentPath]: { contentBase64: contentB64 } // 追記済み content.json
  };

  // ★ 原子コミット（必要に応じ 409 競合を軽減するためリトライ）
  await commitFilesAtomically(
    apiBase,
    repo,
    branch,
    filesToCommit,
    `Upload ${targetName} and update content.json`,
    env.GH_TOKEN
  );

  const rawUrl = `https://raw.githubusercontent.com/${repo}/${branch}/${safePath}`;
  return cors(env, json({ ok: true, path: safePath, filename: targetName, rawUrl }, 200), request);
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
  // fine-grained token を使う場合や最近の推奨に合わせて Bearer に変更
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json",
  "User-Agent": "cf-pages-uploader"
});

const sanitizeFilename = (s: string) =>
  s.replaceAll(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+/, "").slice(0, 180) || "file.bin";

// 空文字を許容し、先頭末尾の / を削るだけ
const sanitizeDirAllowEmpty = (s: string) =>
  (s || "").replaceAll(/[^a-zA-Z0-9/_-]/g, "_").replace(/^\/+/, "").replace(/\/+$/, "");

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
  // @ts-ignore
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

/**
 * 複数ファイルを単一コミットで作成/更新するユーティリティ
 * files: { "<path/in/repo>": { contentBase64: string, mode?: "100644" | "100755" } }
 * 戻り値: 新しいコミット sha
 */
async function commitFilesAtomically(
  apiBase: string,
  repo: string,
  branch: string,
  files: Record<string, { contentBase64: string; mode?: string }>,
  message: string,
  token: string
) {
  const headers = ghHeaders(token);

  // 409 などの競合に備え簡易リトライ（最大3回）
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // 1) ref -> commit sha
      const refRes = await fetch(`${apiBase}/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, { headers });
      if (!refRes.ok) throw new Error(`ref fetch failed: ${refRes.status} ${await refRes.text()}`);
      const refJson = await refRes.json<any>();
      const parentSha = refJson.object?.sha;
      if (!parentSha) throw new Error("no parent sha");

      // 2) get parent commit -> base tree
      const commitRes = await fetch(`${apiBase}/repos/${repo}/git/commits/${parentSha}`, { headers });
      if (!commitRes.ok) throw new Error(`commit fetch failed: ${commitRes.status} ${await commitRes.text()}`);
      const commitJson = await commitRes.json<any>();
      const baseTree = commitJson.tree?.sha;

      // 3) create blobs for each file
      const blobMap: Record<string, string> = {};
      for (const p of Object.keys(files)) {
        const body = { content: files[p].contentBase64, encoding: "base64" };
        const bRes = await fetch(`${apiBase}/repos/${repo}/git/blobs`, { method: "POST", headers, body: JSON.stringify(body) });
        if (!bRes.ok) throw new Error(`blob create failed for ${p}: ${bRes.status} ${await bRes.text()}`);
        const bj = await bRes.json<any>();
        blobMap[p] = bj.sha;
      }

      // 4) create new tree with entries (replacing existing paths)
      const treeRes = await fetch(`${apiBase}/repos/${repo}/git/trees`, {
        method: "POST",
        headers,
        body: JSON.stringify({ base_tree: base_tree, tree: treeEntries })
      });
      if (!treeRes.ok) throw new Error(`tree create failed: ${treeRes.status} ${await treeRes.text()}`);
      const treeJson = await treeRes.json<any>();
      const newTreeSha = treeJson.sha;

      // 5) create commit
      const commitBody = {
        message,
        tree: newTreeSha,
        parents: [parentSha]
      };
      const newCommitRes = await fetch(`${apiBase}/repos/${repo}/git/commits`, { method: "POST", headers, body: JSON.stringify(commitBody) });
      if (!newCommitRes.ok) throw new Error(`commit create failed: ${newCommitRes.status} ${await newCommitRes.text()}`);
      const newCommitJson = await newCommitRes.json<any>();
      const newCommitSha = newCommitJson.sha;

      // 6) update ref to point to new commit
      const updateRes = await fetch(`${apiBase}/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ sha: newCommitSha })
      });
      if (!updateRes.ok) throw new Error(`ref update failed: ${updateRes.status} ${await updateRes.text()}`);

      return newCommitSha;
    } catch (err: any) {
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 200 * attempt));
        continue;
      }
      throw err;
    }
  }

  throw new Error("unreachable");
}
