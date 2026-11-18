import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkForUpdate, localState } from "../src/update.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

async function repo({ head = "ref: refs/heads/main", loose = {}, packed = "", pkg = { version: "0.1.0" }, git = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "kv-upd-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify(pkg));
  if (!git) return root;
  const g = path.join(root, ".git");
  await mkdir(g);
  await writeFile(path.join(g, "HEAD"), head + "\n");
  for (const [ref, sha] of Object.entries(loose)) {
    await mkdir(path.dirname(path.join(g, ref)), { recursive: true });
    await writeFile(path.join(g, ref), sha + "\n");
  }
  if (packed) await writeFile(path.join(g, "packed-refs"), packed);
  return root;
}

/** Fake fetch: url -> JSON body, or a status number. Records the URLs it was asked for. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const r = routes[url];
    if (r === undefined || typeof r === "number") return { ok: false, status: r ?? 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => r };
  };
  fn.calls = calls;
  return fn;
}

const cmp = (base) => `https://api.github.com/repos/kosmik-code/kosmik-voice/compare/${base}...main`;

test("localState reads HEAD through loose and packed refs without the git program", async () => {
  const loose = await repo({ loose: { "refs/heads/main": A, "refs/remotes/origin/main": B } });
  assert.deepEqual(await localState(loose), { sha: A, branch: "main", upstream: B });
  const packed = await repo({ packed: `# pack-refs\n${A} refs/heads/main\n${B} refs/remotes/origin/main\n` });
  assert.deepEqual(await localState(packed), { sha: A, branch: "main", upstream: B });
  const detached = await repo({ head: A });
  assert.deepEqual(await localState(detached), { sha: A, branch: null, upstream: null });
  assert.equal(await localState(await repo({ git: false })), null);
});

test("git copy behind main: available, with count, latest message and compare link", async () => {
  const root = await repo({ loose: { "refs/heads/main": A } });
  const fetchImpl = fakeFetch({
    [cmp(A)]: { ahead_by: 3, commits: [{ commit: { message: "old" } }, { commit: { message: "feat: nuevo\n\nbody", committer: { date: "2026-11-17T00:00:00Z" } } }] },
  });
  const u = await checkForUpdate({ root, fetchImpl });
  assert.equal(u.state, "available");
  assert.equal(u.behind, 3);
  assert.equal(u.latest.message, "feat: nuevo");
  assert.equal(u.url, `https://github.com/kosmik-code/kosmik-voice/compare/${A.slice(0, 12)}...main`);
});

test("git copy up to date, or only ahead with local work: current", async () => {
  const root = await repo({ loose: { "refs/heads/main": A } });
  assert.equal((await checkForUpdate({ root, fetchImpl: fakeFetch({ [cmp(A)]: { ahead_by: 0, behind_by: 2 } }) })).state, "current");
});

test("unpushed local HEAD falls back to the last fetched origin/main", async () => {
  const root = await repo({ loose: { "refs/heads/main": A, "refs/remotes/origin/main": B } });
  const fetchImpl = fakeFetch({ [cmp(A)]: 404, [cmp(B)]: { ahead_by: 1, commits: [{ commit: { message: "fix" } }] } });
  const u = await checkForUpdate({ root, fetchImpl });
  assert.equal(u.state, "available");
  assert.equal(u.behind, 1);
  assert.deepEqual(fetchImpl.calls, [cmp(A), cmp(B)]);
});

test("offline, rate limit or throwing fetch: unknown, never throws", async () => {
  const root = await repo({ loose: { "refs/heads/main": A } });
  assert.equal((await checkForUpdate({ root, fetchImpl: fakeFetch({ [cmp(A)]: 403 }) })).state, "unknown");
  const boom = async () => {
    throw new Error("offline");
  };
  assert.equal((await checkForUpdate({ root, fetchImpl: boom })).state, "unknown");
});

test("copy without .git compares package.json versions", async () => {
  const raw = "https://raw.githubusercontent.com/kosmik-code/kosmik-voice/main/package.json";
  const root = await repo({ git: false, pkg: { version: "0.1.0" } });
  const u = await checkForUpdate({ root, fetchImpl: fakeFetch({ [raw]: { version: "0.2.0" } }) });
  assert.equal(u.state, "available");
  assert.equal(u.via, "zip");
  assert.equal(u.latest.version, "0.2.0");
  assert.equal((await checkForUpdate({ root, fetchImpl: fakeFetch({ [raw]: { version: "0.1.0" } }) })).state, "current");
  assert.equal((await checkForUpdate({ root, fetchImpl: fakeFetch({ [raw]: { version: "0.0.9" } }) })).state, "current");
});
