// Optional real-browser theme checks. Requires Microsoft Edge on Windows.
// Isolated data/profile; never reads or modifies the running app's configuration.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import path from "node:path";
import WebSocket from "ws";
import { ConfigStore, defaultConfig, defaultPreset } from "../src/config.js";
import { SecretStore } from "../src/discord/auth.js";
import { startServer } from "../src/server.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.resolve(process.env.KV_SCREENSHOTS || path.join(root, "data", "theme-checks"));
await mkdir(out, { recursive: true });
const scratch = await mkdtemp(path.join(out, "run-"));
const ids = Array.from({ length: 5 }, (_, i) => String(i + 1).repeat(18));
const config = new ConfigStore(path.join(scratch, "data"));
const draft = defaultConfig();
draft.users = ids.map((id, i) => ({ id, displayName: i === 3 ? "Un alias extraordinariamente largo" : ["Kosmik", "Invitada", "Muteado", "Sordo", "Ausente"][i], role: i === 0 ? "Host" : "" }));
draft.presets = ["pixel-cafe", "clean", "neon", "comic", "glass"].map((theme) => ({
  ...defaultPreset(theme, theme), theme, mode: "slots", users: ids,
  layout: { ...defaultPreset().layout, alignX: "center", alignY: "center", size: 200, gap: 64 },
}));
await config.save(draft);
const discord = new EventEmitter();
discord.status = { state: "setup_required", message: "Isolated visual check" };
discord.snapshot = () => ({ channel: null, members: [] });
const server = await startServer({ port: 0, dataDir: config.dir, publicDir: path.join(root, "public"), config, secrets: new SecretStore(config.dir), discord });
const edgePath = process.env.KV_EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const edge = spawn(edgePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${path.join(scratch, "edge")}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const edgeExit = new Promise((resolve) => edge.once("exit", resolve));
let ws;
let browserClosed = false;
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Edge did not expose DevTools within 15s")), 15000);
    let log = "";
    edge.once("error", reject);
    edge.stderr.on("data", (chunk) => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
  let seq = 0;
  const pending = new Map();
  ws.on("message", (buf) => {
    const m = JSON.parse(buf);
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
  await writeFile(path.join(config.dir, "assets", "cutout.png"), Buffer.from(cutout, "base64"));
  draft.users[0].images = { idle: "cutout.png" };
  await config.save(draft);
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
} finally {
  ws?.close();
  if (!browserClosed) edge.kill();
  // Wait for our browser process to release the task-owned profile before deleting it.
  let exitTimer;
  await Promise.race([edgeExit, new Promise((resolve) => { exitTimer = setTimeout(resolve, 3000); })]);
  clearTimeout(exitTimer);
  await server.close();
  // Scratch is task-owned. Screenshot evidence remains outside this directory.
  await rm(path.join(scratch, "data"), { recursive: true, force: true });
  // Edge profile cleanup can be delayed by Windows locks; keep it if still in use.
  try { await rm(scratch, { recursive: true, force: true }); } catch { console.log(`Profile still locked: ${scratch}`); }
}
