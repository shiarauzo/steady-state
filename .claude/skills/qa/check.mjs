// QA headless de la visualización Laplace.
// Abre la página en Chromium, recolecta errores de consola/página, valida el
// contexto WebGL y comprueba que el canvas no quede en blanco.
// Sale con código 0 (PASS) o 1 (FAIL) e imprime un resumen JSON.
import puppeteer from "puppeteer";

const QA_URL = process.env.QA_URL || "http://localhost:5173/";
const SETTLE_MS = 2500;

const consoleErrors = [];
const pageErrors = [];

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    // habilita WebGL en headless con backend de software (SwiftShader)
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--no-sandbox",
    "--ignore-gpu-blocklist",
  ],
});

let verdict = { pass: false };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  // "load", no "networkidle0": el WebSocket de HMR de Vite mantiene la red
  // ocupada y networkidle nunca se satisface.
  await page.goto(QA_URL, { waitUntil: "load", timeout: 30000 });

  // instala un listener de pérdida de contexto antes de dejar correr la anim
  await page.evaluate(() => {
    const c = document.getElementById("c");
    window.__qaContextLost = false;
    if (c) c.addEventListener("webglcontextlost", () => (window.__qaContextLost = true));
  });

  await new Promise((r) => setTimeout(r, SETTLE_MS));

  const probe = await page.evaluate(() => {
    const c = document.getElementById("c");
    if (!c) return { ok: false, reason: "no canvas#c" };
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    let renderer = "unknown";
    let lost = true;
    if (gl) {
      lost = gl.isContextLost();
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "hidden";
    }
    // muestrea el canvas a baja resolución para medir contenido no trivial
    const off = document.createElement("canvas");
    off.width = 160;
    off.height = 100;
    const ctx = off.getContext("2d");
    ctx.drawImage(c, 0, 0, off.width, off.height);
    const { data } = ctx.getImageData(0, 0, off.width, off.height);
    let nonBlank = 0;
    const total = off.width * off.height;
    for (let i = 0; i < data.length; i += 4) {
      // píxel "con contenido": no transparente y no casi-negro
      if (data[i + 3] > 8 && data[i] + data[i + 1] + data[i + 2] > 24) nonBlank++;
    }
    return {
      ok: true,
      canvasSize: [c.width, c.height],
      glRenderer: renderer,
      contextLostFlag: lost,
      contextLostEvent: !!window.__qaContextLost,
      nonBlankRatio: nonBlank / total,
    };
  });

  await page.screenshot({
    path: new URL("last-run.png", import.meta.url).pathname,
  });

  const checks = {
    canvasPresent: probe.ok,
    canvasHasSize: probe.ok && probe.canvasSize[0] > 0 && probe.canvasSize[1] > 0,
    contextAlive: probe.ok && !probe.contextLostFlag && !probe.contextLostEvent,
    rendersContent: probe.ok && probe.nonBlankRatio > 0.02,
    noConsoleErrors: consoleErrors.length === 0,
    noPageErrors: pageErrors.length === 0,
  };
  const pass = Object.values(checks).every(Boolean);

  verdict = {
    pass,
    checks,
    glRenderer: probe.glRenderer,
    canvasSize: probe.canvasSize,
    nonBlankRatio: probe.nonBlankRatio,
    contextLost: probe.ok ? probe.contextLostFlag || probe.contextLostEvent : true,
    consoleErrors,
    pageErrors,
  };
} catch (err) {
  verdict = { pass: false, fatal: String(err), consoleErrors, pageErrors };
} finally {
  await browser.close();
}

console.log(JSON.stringify(verdict, null, 2));
process.exit(verdict.pass ? 0 : 1);
