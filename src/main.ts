import * as THREE from "three";
import { NX, NY, PLANE_W, PLANE_H } from "./constants";
import { FieldSolver } from "./FieldSolver";
import { createDotField } from "./fieldView";
import { createParticles } from "./particles";
import { seedEquation } from "./seedEquation";

/* =============================================================
   LAPLACE — EL CAMPO QUE SE ASIENTA
   -------------------------------------------------------------
   Ensamblado: el campo se relaja en GPU (FieldSolver), el relieve
   lo lee directo de la textura en el shader (surface), y partículas
   e iso usan una descarga del campo a CPU una vez por frame.
   ============================================================= */
const canvas = document.getElementById("c") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
  // conserva el drawing buffer tras componer: permite leer píxeles / capturar
  // el canvas de forma determinista (QA, screenshots). Coste despreciable aquí.
  preserveDrawingBuffer: true,
});
// pixel ratio adaptativo: cap bajo en pantallas táctiles (fill-rate caro en móvil)
const PR_CAP = matchMedia("(pointer:coarse)").matches ? 1.5 : 2;
renderer.setPixelRatio(Math.min(devicePixelRatio, PR_CAP));
renderer.setClearColor(0x05060a, 1);
renderer.autoClear = true;
renderer.toneMapping = THREE.NoToneMapping; // dots nítidos: color puro sobre negro

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x04050a); // negro tech, espacio negativo

// Cámara CENITAL ortográfica (vista de mapa plano, sin perspectiva ni escorzo).
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
camera.position.set(0, 10, 0);
camera.up.set(0, 0, -1); // +x derecha, +z hacia abajo en pantalla
camera.lookAt(0, 0, 0);

/* ---- Solver GPU + vista de campo (puntos + equipotenciales) ---- */
const solver = new FieldSolver(renderer);

const dotField = createDotField(solver.fieldTexture);
dotField.setDpr(renderer.getPixelRatio());
scene.add(dotField.group);
const setFieldTexture = dotField.setField;

const particles = createParticles(renderer, solver.bcTexture);
particles.points.renderOrder = 3;
particles.trails.renderOrder = 3;

// prefers-reduced-motion: sin partículas en movimiento (queda el campo estático).
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const showParticles = !REDUCED;
if (showParticles) {
  scene.add(particles.points);
  scene.add(particles.trails);
}

// Plano invisible para picking (pintar en el plano del campo).
const pickGeom = new THREE.PlaneGeometry(PLANE_W, PLANE_H);
pickGeom.rotateX(-Math.PI / 2);
const pickMesh = new THREE.Mesh(
  pickGeom,
  new THREE.MeshBasicMaterial({ visible: false }),
);
scene.add(pickMesh);

/* =============================================================
   PICKING + PINTADO de condiciones Dirichlet
   ============================================================= */
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const mouse = {
  x: 0,
  y: 0,
  down: false,
  button: 0,
  lastI: -1,
  lastJ: -1,
  hasLast: false,
};

// Sigilo de la condición de contorno siguiendo el cursor: +φ / −φ al pintar,
// ∅ al borrar (botón central) (issue #9).
const sig = document.getElementById("sig") as HTMLDivElement;
function showSig(e: PointerEvent): void {
  sig.textContent = mouse.button === 1 ? "∅" : mouse.button === 2 ? "−φ" : "+φ";
  sig.style.left = `${e.clientX}px`;
  sig.style.top = `${e.clientY}px`;
  sig.style.display = "block";
}

canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("pointerdown", (e) => {
  if (e.button === 1) e.preventDefault(); // evita el autoscroll del botón central
  canvas.setPointerCapture(e.pointerId); // traza continua aunque el cursor salga
  mouse.down = true;
  mouse.button = e.button;
  mouse.hasLast = false;
  updateMouseFromEvent(e);
  paintAtMouse();
  showSig(e);
});
canvas.addEventListener("pointermove", (e) => {
  updateMouseFromEvent(e);
  if (mouse.down) {
    paintAtMouse();
    showSig(e);
  }
});
const releasePointer = () => {
  mouse.down = false;
  mouse.hasLast = false;
  sig.style.display = "none";
};
addEventListener("pointerup", releasePointer);
addEventListener("pointercancel", releasePointer);
addEventListener("blur", releasePointer);

function updateMouseFromEvent(e: PointerEvent): void {
  const r = canvas.getBoundingClientRect();
  mouse.x = e.clientX - r.left;
  mouse.y = e.clientY - r.top;
}

function paintAtMouse(): void {
  ndc.x = (mouse.x / innerWidth) * 2 - 1;
  ndc.y = -(mouse.y / innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(pickMesh);
  if (!hits.length) return;
  const p = hits[0].point;
  const fi = (p.x / PLANE_W + 0.5) * (NX - 1);
  const fj = (p.z / PLANE_H + 0.5) * (NY - 1);
  const erase = mouse.button === 1; // botón central = goma
  const sign = mouse.button === 2 ? -1 : +1;
  const apply = (bi: number, bj: number) =>
    erase ? eraseBrush(bi, bj) : paintBrush(bi, bj, sign);

  if (mouse.hasLast) {
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(fi - mouse.lastI, fj - mouse.lastJ)),
    );
    for (let s = 1; s <= steps; s++) {
      const u = s / steps;
      apply(mouse.lastI + (fi - mouse.lastI) * u, mouse.lastJ + (fj - mouse.lastJ) * u);
    }
  } else {
    apply(fi, fj);
  }
  mouse.lastI = fi;
  mouse.lastJ = fj;
  mouse.hasLast = true;
}

// Radio de pincel ajustable con la rueda del ratón.
let brushR = 4.5;
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    brushR = Math.max(1.5, Math.min(22, brushR - Math.sign(e.deltaY)));
  },
  { passive: false },
);

function brushBounds(fi: number, fj: number, r: number) {
  return {
    i0: Math.max(1, Math.floor(fi - r)),
    i1: Math.min(NX - 2, Math.ceil(fi + r)),
    j0: Math.max(1, Math.floor(fj - r)),
    j1: Math.min(NY - 2, Math.ceil(fj + r)),
  };
}

function eraseBrush(fi: number, fj: number): void {
  const r2 = brushR * brushR;
  const { i0, i1, j0, j1 } = brushBounds(fi, fj, brushR);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const di = i - fi;
      const dj = j - fj;
      if (di * di + dj * dj > r2) continue;
      solver.unfix(j * NX + i);
    }
  }
}

function paintBrush(fi: number, fj: number, sign: number): void {
  const r = brushR;
  const r2 = r * r;
  const i0 = Math.max(1, Math.floor(fi - r));
  const i1 = Math.min(NX - 2, Math.ceil(fi + r));
  const j0 = Math.max(1, Math.floor(fj - r));
  const j1 = Math.min(NY - 2, Math.ceil(fj + r));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const di = i - fi;
      const dj = j - fj;
      const d2 = di * di + dj * dj;
      if (d2 > r2) continue;
      const k = j * NX + i;
      const w = Math.exp(-d2 / (r2 * 0.45)); // falloff gaussiano
      solver.blendFixed(k, sign, w);
    }
  }
}

/* =============================================================
   RESIZE — encaje ortográfico (campo contenido y centrado, con
   margen de espacio negativo a los lados)
   ============================================================= */
function onResize(): void {
  const w = innerWidth;
  const h = innerHeight;
  renderer.setSize(w, h, false);
  const aspect = w / h;
  const fieldAspect = PLANE_W / PLANE_H;
  const margin = 1.12; // > 1 deja aire alrededor (espacio negativo)
  let halfH: number;
  let halfW: number;
  if (aspect > fieldAspect) {
    halfH = (PLANE_H * 0.5) * margin;
    halfW = halfH * aspect;
  } else {
    halfW = (PLANE_W * 0.5) * margin;
    halfH = halfW / aspect;
  }
  camera.left = -halfW;
  camera.right = halfW;
  camera.top = halfH;
  camera.bottom = -halfH;
  camera.updateProjectionMatrix();
}
addEventListener("resize", onResize);
onResize();

/* ---- Semilla y reinicio del campo ---- */
// Cuatro cargas (cuadrupolo) en coords fraccionarias → relieve más escultural,
// independiente de la resolución de la malla.
function seedPoles(): void {
  const R = Math.round(NY * 0.07); // radio del blob en celdas, proporcional
  const R2 = R * R;
  const blob = (fx: number, fy: number, sign: number) => {
    const ci = Math.round(fx * (NX - 1));
    const cj = Math.round(fy * (NY - 1));
    for (let j = Math.max(1, cj - R); j <= Math.min(NY - 2, cj + R); j++) {
      for (let i = Math.max(1, ci - R); i <= Math.min(NX - 2, ci + R); i++) {
        const d2 = (i - ci) * (i - ci) + (j - cj) * (j - cj);
        if (d2 > R2) continue;
        if (Math.exp(-d2 / (R2 * 0.45)) > 0.4) solver.setFixed(j * NX + i, sign);
      }
    }
  };
  blob(0.3, 0.4, +1);
  blob(0.7, 0.42, -1);
  blob(0.5, 0.74, +1);
  blob(0.82, 0.78, -1);
}

const DISSOLVE_AT = 4.5; // s tras la siembra
let releaseEquation: () => void = () => {};
let equationReleased = false;
let seedT = 0;

// (Re)inicia el campo: limpia, siembra dos polos y la ecuación ∇²φ=0 (que se
// disolverá sobre ellos), y reinicia las partículas. Al cargar y con la tecla R.
function initField(now: number): void {
  solver.reset();
  seedPoles();
  releaseEquation = seedEquation(solver); // se disuelve al converger (issue #11)
  equationReleased = false;
  seedT = now;
  if (showParticles) particles.reseed();
}

// Tecla R: reinicio.
addEventListener("keydown", (e) => {
  if (e.key === "r" || e.key === "R") initField(performance.now() / 1000);
});

/* =============================================================
   LOOP
   ============================================================= */
const t0 = performance.now() / 1000;
let prevT = t0;
let raf = 0;

initField(t0); // siembra inicial (polos + ecuación)

function frame(): void {
  const now = performance.now() / 1000;
  let dt = now - prevT;
  if (dt > 0.05) dt = 0.05;
  prevT = now;

  // disuelve la ecuación sembrada una vez, relativo a la última siembra (issue #11)
  if (!equationReleased && now - seedT > DISSOLVE_AT) {
    releaseEquation();
    equationReleased = true;
  }

  // 1) relajación en GPU + textura del campo a la vista y a las partículas
  solver.step();
  setFieldTexture(solver.fieldTexture);

  // 2) partículas advectadas en GPU leyendo la textura del campo (sin readback)
  if (showParticles) particles.update(dt, solver.fieldTexture);

  renderer.render(scene, camera); // vista cenital nítida (sin postprocesado)
  raf = requestAnimationFrame(frame);
}

function start(): void {
  if (raf) return;
  prevT = performance.now() / 1000; // evita un dt gigante al reanudar
  raf = requestAnimationFrame(frame);
}
function stop(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

// Pérdida de contexto WebGL (sleep, presión de memoria, cambio de GPU):
// detén el loop para no spamear errores; al restaurarse, recarga limpio.
canvas.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();
  stop();
});
canvas.addEventListener("webglcontextrestored", () => location.reload());

// Si el dispositivo no puede renderizar a float/half-float, el campo no existe:
// degradamos a la ecuación estática (CSS) en vez de un canvas negro.
if (solver.supported) {
  // Pausa cuando la pestaña no es visible (ahorra GPU/batería). Solo si hay
  // loop que pausar: en el path no soportado no debe arrancar nada.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else start();
  });
  start();
} else {
  document.body.classList.add("nofield");
}
