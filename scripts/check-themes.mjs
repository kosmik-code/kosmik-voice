// Optional real-browser theme checks. Requires Microsoft Edge on Windows.
// Isolated data/profile; never reads or modifies the running app's configuration.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { startRustApp, stopOwnedProcess } from "../test/helpers/rust-app.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.resolve(process.env.KV_SCREENSHOTS || path.join(root, "data", "theme-checks"));
const edgePath = process.env.KV_EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const server = await startRustApp({ publicDir: path.join(root, "public") });
let scratch;
let edge;
let ws;
let browserClosed = false;
let checkFailed = false;
try {
  await mkdir(out, { recursive: true });
  scratch = await mkdtemp(path.join(tmpdir(), "kv-edge-test-"));
  const draft = structuredClone(server.defaults);
  const def = draft.presets[0];
  const ids = Array.from({ length: 5 }, (_, i) => String(i + 1).repeat(18));
  draft.users = ids.map((id, i) => ({ id, displayName: i === 3 ? "Un alias extraordinariamente largo" : ["Kosmik", "Invitada", "Muteado", "Sordo", "Ausente"][i], role: i === 0 ? "Host" : "" }));
  draft.presets = ["pixel-cafe", "clean", "neon", "comic", "glass"].map((theme) => ({
    ...def, id: theme, name: theme, theme, mode: "slots", users: ids,
    layout: { ...def.layout, alignX: "center", alignY: "center", size: 200, gap: 64 },
  }));

  edge = spawn(edgePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${path.join(scratch, "edge")}`, "about:blank"], {
    env: { ...process.env, APPDATA: scratch, LOCALAPPDATA: scratch },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let startupTimer;
  const endpoint = await new Promise((resolve, reject) => {
    startupTimer = setTimeout(() => reject(new Error("Edge did not expose DevTools within 15s")), 15000);
    let log = "";
    edge.once("error", reject);
    edge.once("exit", (code, signal) => reject(new Error(`Edge exited before exposing DevTools (${signal ?? code}): ${log}`)));
    const onData = (chunk) => {
      log = (log + chunk).slice(-4096);
      const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)\s/);
      if (match) {
        edge.stderr.off("data", onData);
        edge.stderr.resume();
        resolve(match[1]);
      }
    };
    edge.stderr.on("data", onData);
  }).finally(() => clearTimeout(startupTimer));
  ws = new WebSocket(endpoint);
  let connectTimer;
  await new Promise((resolve, reject) => {
    connectTimer = setTimeout(() => reject(new Error("Edge DevTools WebSocket did not open within 10s")), 10000);
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", (event) => reject(new Error(`Edge DevTools WebSocket failed: ${event.message}`)), { once: true });
  }).finally(() => clearTimeout(connectTimer));
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", ({ data }) => {
    const m = JSON.parse(data);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  });
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await call("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
  const send = (m, p) => call(m, p, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const ready = async (selector) => evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+5000;function check(){if(document.querySelector(${JSON.stringify(selector)}))return resolve(true);if(Date.now()>end)return reject(new Error('Render not ready'));requestAnimationFrame(check)}check()})`);
  // Generate a transparent PNG locally so the comic outline is exercised on real alpha.
  const cutout = await evaluate(`(()=>{const c=document.createElement('canvas');c.width=c.height=200;const x=c.getContext('2d');x.fillStyle='#f6ac64';x.fillRect(45,55,110,115);x.fillRect(45,30,30,35);x.fillRect(125,30,30,35);x.fillStyle='#24223f';x.fillRect(65,90,16,16);x.fillRect(120,90,16,16);x.fillRect(94,125,12,12);return c.toDataURL('image/png').split(',')[1]})()`);
  const upload = await server.request("/api/assets?name=cutout.png", {
    method: "POST", headers: { "Content-Type": "image/png" }, body: Buffer.from(cutout, "base64"),
  });
  const asset = await upload.json();
  assert.equal(upload.status, 201, JSON.stringify(asset));
  assert.equal(asset.name, "cutout.png");
  draft.users[0].images = { idle: asset.name };
  const { status, body } = await server.putConfig(draft);
  assert.equal(status, 200, JSON.stringify(body));
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(out, `${name}.png`), Buffer.from(data, "base64"));
  };
  for (const theme of ["pixel-cafe", "clean", "comic", "neon", "glass"]) {
    await send("Page.navigate", { url: `${server.url}/overlay/${theme}?demo=static&bg=404850` });
    await ready(".tile[data-state='offline']");
    const states = await evaluate("Array.from(document.querySelectorAll('.tile'),e=>e.dataset.state)");
    assert.deepEqual(states, ["talking", "idle", "muted", "deafened", "offline"], theme);
    await evaluate(`Promise.all(Array.from(document.images,i=>i.complete?Promise.resolve():new Promise(r=>{i.onload=r;i.onerror=r})))`);
    await shot(`theme-${theme}-final`);
    if (["neon", "comic", "glass"].includes(theme)) {
      await evaluate(`document.body.style.background='repeating-linear-gradient(45deg,#ffd23f 0 60px,#53618c 60px 120px)'`);
      await shot(`theme-${theme}-busy-final`);
    }
    const overflow = await evaluate(`Array.from(document.querySelectorAll('.name')).map(e=>({text:e.textContent,clipped:getComputedStyle(e).overflowX==='hidden',tooWide:e.scrollWidth>e.clientWidth}))`);
    assert.ok(overflow.every((n) => !n.tooWide || n.clipped), `${theme}: alias escapes label: ${JSON.stringify(overflow)}`);
    console.log(`PASS ${theme}: five voice states, long-name clipping`);
    // Check optional decoration controls through the real overlay classes.
    if (["neon", "comic", "glass"].includes(theme)) {
      await evaluate(`document.getElementById('stage').classList.remove('has-frame');document.getElementById('stage').classList.add('no-glow','shape-circle');document.querySelectorAll('.tile').forEach(e=>e.className=e.className.replace(/anim-\\w+/,'anim-none'));document.getElementById('stage').style.setProperty('--radius','50%')`);
      const animation = await evaluate(`getComputedStyle(document.querySelector('.tile img')).animationName`);
      assert.equal(animation, "none", theme);
      const extraMotion = await evaluate(`(()=>{const tile=document.querySelector('.tile');const box=tile.querySelector('.box');const label=tile.querySelector('.name');const glow=getComputedStyle(box,'::after').animationName;const capture=()=>[getComputedStyle(box).transform,getComputedStyle(label).transform];const talking=capture();tile.dataset.state='idle';const idle=capture();tile.dataset.state='talking';return {glow,talking,idle}})()`);
      assert.equal(extraMotion.glow, "none", `${theme}: no glow pulse when animation is disabled`);
      assert.deepEqual(extraMotion.talking, extraMotion.idle, `${theme}: no lift/pop when animation is disabled`);
      await shot(`theme-${theme}-no-frame`);
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      // OBS reports the streaming PC's OS setting: animations chosen in the preset must still run.
      const motion = await evaluate(`(()=>{const tile=document.querySelector('.tile[data-state="talking"]');tile.className=tile.className.replace(/anim-\\w+/,'anim-bounce');const c=getComputedStyle(tile.querySelector('img'));return {name:c.animationName,cls:tile.className,stage:document.getElementById('stage').className}})()`);
      assert.notEqual(motion.name, "none", `${theme}: talking animation must survive prefers-reduced-motion: ${JSON.stringify(motion)}`);
      await send("Emulation.setEmulatedMedia", { features: [] });
      console.log(`PASS ${theme}: animation none, and animations kept under reduced motion`);
      if (theme === "neon") {
        const stripe = await evaluate(`(()=>{const st=document.getElementById('stage');const n=document.querySelector('.tile[data-state="idle"] .name');const on=getComputedStyle(n).boxShadow;st.classList.add('no-name-stripe');st.style.setProperty('--c-name-bg','#ff0000');const c=getComputedStyle(n);const r={on,off:c.boxShadow,bg:c.backgroundColor};st.classList.remove('no-name-stripe');st.style.removeProperty('--c-name-bg');return r})()`);
        assert.match(stripe.on, /3px 0px 0px 0px/, "neon: stripe drawn by default");
        assert.doesNotMatch(stripe.off, /3px 0px 0px 0px/, "neon: stripe removed with nameStripe off");
        assert.equal(stripe.bg, "rgb(255, 0, 0)", "neon: custom name background applied");
        console.log("PASS neon: name stripe toggle and custom colours");
      }
    }
  }
  await send("Page.navigate", { url: `${server.url}/editor/?preset=neon#presets` });
  await ready("[data-path='presets[2].theme'] select");
  const options = await evaluate(`Array.from(document.querySelector("[data-path='presets[2].theme'] select").options,o=>o.value)`);
  assert.deepEqual(options, ["pixel-cafe", "clean", "neon", "comic", "glass"]);
  await shot("theme-editor-final");
  console.log("PASS editor: five themes selectable");
  const colors = await evaluate(`(()=>{document.querySelector('details.advanced').open=true;const f=document.querySelector("[data-path='presets[2].style.nameBg']");const btn=document.querySelector("[data-path='presets[2].style.nameBorder'] button");const stripe=document.querySelector("[data-path='presets[2].style.nameStripe'] input");f?.scrollIntoView({block:'center'});return {text:f?.querySelector('.hex')?.placeholder,resetDisabled:btn?.disabled,stripe:stripe?.checked}})()`);
  assert.ok(["color del tema", "theme color"].includes(colors.text) && colors.resetDisabled && colors.stripe, JSON.stringify(colors));
  await shot("theme-editor-colors");
  console.log("PASS editor: theme colour fields and name stripe toggle");
  await call("Browser.close");
  browserClosed = true;
} catch (error) {
  checkFailed = true;
  throw error;
} finally {
  const shutdownErrors = [];
  try {
    ws?.close();
    await stopOwnedProcess(edge, { graceful: browserClosed });
  } catch (error) {
    shutdownErrors.push(error);
  }
  if (scratch) {
    // Edge can still hold the profile open on Windows, even after exit.
    try { await rm(scratch, { recursive: true, force: true, maxRetries: 3 }); }
    catch { console.log(`Profile still locked: ${scratch}`); }
  }
  try { await server.close(); } catch (error) { shutdownErrors.push(error); }
  if (shutdownErrors.length) {
    const error = new AggregateError(shutdownErrors, "Could not stop theme check processes");
    if (!checkFailed) throw error;
    console.warn(error);
  }
}
