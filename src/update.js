// Startup update check: is the GitHub repo's main branch ahead of this copy?
// One unauthenticated GitHub API call per start, nothing about the user is sent. Any failure
// (offline, rate limit, unpushed local commits) ends as "unknown" and the app keeps working.
// Opt out with KV_UPDATE_CHECK=0.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const REPO = "kosmik-code/kosmik-voice";
export const BRANCH = "main";
const SHA = /^[0-9a-f]{40}$/;

async function readText(file) {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch {
    return null;
  }
}

/** Resolve the .git directory (plain clone, or a worktree whose .git is a "gitdir:" file). */
async function gitDirs(root) {
  const dotGit = path.join(root, ".git");
  let info;
  try {
    info = await stat(dotGit);
  } catch {
    return null;
  }
  let gitDir = dotGit;
  if (info.isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec((await readText(dotGit)) ?? "");
    if (!m) return null;
    gitDir = path.resolve(root, m[1].trim());
  }
  const common = await readText(path.join(gitDir, "commondir"));
  return { gitDir, commonDir: common ? path.resolve(gitDir, common) : gitDir };
}

async function readRef(dirs, ref) {
  for (const dir of [dirs.gitDir, dirs.commonDir]) {
    const loose = await readText(path.join(dir, ...ref.split("/")));
    if (loose && SHA.test(loose)) return loose;
  }
  const packed = (await readText(path.join(dirs.commonDir, "packed-refs"))) ?? "";
  for (const line of packed.split(/\r?\n/)) {
    const [sha, name] = line.split(" ");
    if (name === ref && SHA.test(sha)) return sha;
  }
  return null;
}

/** Local HEAD commit and the last fetched origin/main, read from .git without needing the git program. */
export async function localState(root) {
  const dirs = await gitDirs(root);
  if (!dirs) return null;
  const head = (await readText(path.join(dirs.gitDir, "HEAD"))) ?? "";
  const m = /^ref:\s*(.+)$/.exec(head);
  const sha = m ? await readRef(dirs, m[1].trim()) : SHA.test(head) ? head : null;
  if (!sha) return null;
  return { sha, branch: m ? m[1].trim().replace(/^refs\/heads\//, "") : null, upstream: await readRef(dirs, `refs/remotes/origin/${BRANCH}`) };
}

async function getJson(fetchImpl, url, timeoutMs) {
  const res = await fetchImpl(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "kosmik-voice-update-check" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;
  return res.json();
}

function newer(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

/**
 * Returns { state: "available" | "current" | "unknown", via: "git" | "zip", behind, url, latest }.
 * git copies compare commits; copies without .git compare package.json versions.
 */
export async function checkForUpdate({ root, fetchImpl = globalThis.fetch, timeoutMs = 5000, repo = REPO } = {}) {
  const page = `https://github.com/${repo}`;
  try {
    const local = await localState(root);
    if (!local) {
      const mine = JSON.parse((await readText(path.join(root, "package.json"))) ?? "{}").version;
      const remote = await getJson(fetchImpl, `https://raw.githubusercontent.com/${repo}/${BRANCH}/package.json`, timeoutMs);
      if (!mine || !remote?.version) return { state: "unknown", via: "zip" };
      return newer(remote.version, mine)
        ? { state: "available", via: "zip", behind: null, url: `${page}/archive/refs/heads/${BRANCH}.zip`, latest: { version: remote.version } }
        : { state: "current", via: "zip" };
    }
    // HEAD first; if it holds commits GitHub has never seen (local work), fall back to the last fetched origin/main.
    for (const base of [local.sha, local.upstream].filter(Boolean)) {
      const cmp = await getJson(fetchImpl, `https://api.github.com/repos/${repo}/compare/${base}...${BRANCH}`, timeoutMs);
      if (!cmp) continue;
      const behind = Number(cmp.ahead_by) || 0;
      if (!behind) return { state: "current", via: "git" };
      const last = cmp.commits?.[cmp.commits.length - 1];
      return {
        state: "available", via: "git", behind,
        url: `${page}/compare/${base.slice(0, 12)}...${BRANCH}`,
        latest: { message: String(last?.commit?.message ?? "").split("\n")[0].slice(0, 120), date: last?.commit?.committer?.date ?? null },
      };
    }
    return { state: "unknown", via: "git" };
  } catch {
    return { state: "unknown" };
  }
}
