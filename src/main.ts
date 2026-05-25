import * as THREE from "three";
import { NX, NY, PLANE_W, PLANE_H } from "./constants";
import { FieldSolver } from "./FieldSolver";
import { createSurface } from "./surface";
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
renderer.setClearColor(0x07080d, 0); // transparente: deja ver la atmósfera CSS
renderer.autoClear = true;
// AgX tone mapping: HDR→LDR moderno; preserva los highlights cálidos sin quemar
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.35;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x07080d, 12, 26);

const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 120);
// Picado moderado (~52°): el plano llena el cuadro conservando el relieve 3D.
const CAM_DIR = new THREE.Vector3(0, 0.79, 0.615); // sin52°, cos52°
const CAM_TARGET = new THREE.Vector3(0, 0.15, 0);
const CAM_BASE = new THREE.Vector3();
let camDist = 12;

// Iluminación cálida: hemisférica + direccional rasante + rim frío opuesto.
scene.add(new THREE.HemisphereLight(0xf0a95c, 0x0a1530, 0.55));
const dir = new THREE.DirectionalLight(0xfff0d8, 0.85);
dir.position.set(5.5, 9, 4.5);
scene.add(dir);
const rim = new THREE.DirectionalLight(0x6088c8, 0.25);
rim.position.set(-6, 4, -5);
scene.add(rim);

/* ---- Solver GPU + objetos ---- */
const solver = new FieldSolver(renderer);

const { mesh: surfaceMesh, setFieldTexture } = createSurface(solver.fieldTexture);
scene.add(surfaceMesh);

// Anillo decorativo bajo la superficie — refuerza el aire de instrumento.
{
  const ringGeom = new THREE.RingGeometry(PLANE_W * 0.62, PLANE_W * 0.625, 128);
  ringGeom.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xf0a95c,
    transparent: true,
    opacity: 0.07,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(ringGeom, ringMat);
  ring.position.y = -0.001;
  scene.add(ring);
}

const particles = createParticles(solver.phi);
scene.add(particles.points);
scene.add(particles.trails);

// (Las equipotenciales ahora se dibujan en screen-space dentro del shader de
// la superficie — ya no hay marching squares en CPU ni objeto aparte.)

// Plano invisible para picking: pintar sobre la "sombra" del relieve evita
// oclusiones contraintuitivas cuando el campo se levanta.
const pickGeom = new THREE.PlaneGeometry(PLANE_W, PLANE_H);
pickGeom.rotateX(-Math.PI / 2);
const pickMesh = new THREE.Mesh(
  pickGeom,
  new THREE.MeshBasicMaterial({ visible: false }),
);
scene.add(pickMesh);

const showParticles = true;

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

// Sigilo de la condición Dirichlet: ±φ siguiendo el cursor al pintar (issue #9).
const sig = document.getElementById("sig") as HTMLDivElement;
function showSig(e: PointerEvent): void {
  if (mouse.button === 1) return; // botón central no pinta: tampoco sigilo
  sig.textContent = mouse.button === 2 ? "−φ" : "+φ";
  sig.style.left = `${e.clientX}px`;
  sig.style.top = `${e.clientY}px`;
  sig.style.display = "block";
}

canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("pointerdown", (e) => {
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
  const sign = mouse.button === 0 ? +1 : mouse.button === 2 ? -1 : 0;
  if (sign === 0) return;

  if (mouse.hasLast) {
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(fi - mouse.lastI, fj - mouse.lastJ)),
    );
    for (let s = 1; s <= steps; s++) {
      const u = s / steps;
      paintBrush(
        mouse.lastI + (fi - mouse.lastI) * u,
        mouse.lastJ + (fj - mouse.lastJ) * u,
        sign,
      );
    }
  } else {
    paintBrush(fi, fj, sign);
  }
  mouse.lastI = fi;
  mouse.lastJ = fj;
  mouse.hasLast = true;
}

const BRUSH_R = 4.5;
function paintBrush(fi: number, fj: number, sign: number): void {
  const r = BRUSH_R;
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
   RESIZE + FIT CÁMARA
   ============================================================= */
function fitCamera(): void {
  const aspect = camera.aspect;
  const vFOV = (camera.fov * Math.PI) / 180;
  const hFOV = 2 * Math.atan(Math.tan(vFOV / 2) * aspect);
  const margin = 1.12;
  const distW = (PLANE_W * 0.5 * margin) / Math.tan(hFOV / 2);
  const distH = (PLANE_H * 0.5 * CAM_DIR.y * margin) / Math.tan(vFOV / 2);
  camDist = Math.max(distW, distH);
  CAM_BASE.copy(CAM_DIR).multiplyScalar(camDist).add(CAM_TARGET);
  const fog = scene.fog as THREE.Fog;
  fog.near = camDist * 0.6;
  fog.far = camDist * 2.6;
}

function onResize(): void {
  const w = innerWidth;
  const h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  fitCamera();
}
addEventListener("resize", onResize);
onResize();

/* ---- Semilla: dos polos suaves para que se vea algo al cargar ---- */
(function seed(): void {
  const setBlob = (ci: number, cj: number, sign: number) => {
    const j0 = Math.max(1, cj - 7);
    const j1 = Math.min(NY - 2, cj + 7);
    const i0 = Math.max(1, ci - 7);
    const i1 = Math.min(NX - 2, ci + 7);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d2 = (i - ci) * (i - ci) + (j - cj) * (j - cj);
        if (d2 > 49) continue;
        const w = Math.exp(-d2 / 22);
        if (w > 0.4) solver.setFixed(j * NX + i, sign * w);
      }
    }
  };
  setBlob(60, 60, +1);
  setBlob(140, 60, -1);
})();

// La ecuación ∇²φ = 0 sembrada en el propio campo; se disolverá al converger,
// asentándose sobre los dos polos (issue #11).
const releaseEquation = seedEquation(solver);
const DISSOLVE_AT = 4.5; // s tras la carga
let equationReleased = false;

// Respeta prefers-reduced-motion: anula la "respiración" de cámara (issue #10).
const SWAY = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 1;

/* =============================================================
   LOOP
   ============================================================= */
const t0 = performance.now() / 1000;
let prevT = t0;
let raf = 0;

function frame(): void {
  const now = performance.now() / 1000;
  let dt = now - prevT;
  if (dt > 0.05) dt = 0.05;
  prevT = now;

  // disuelve la ecuación sembrada una vez (issue #11)
  if (!equationReleased && now - t0 > DISSOLVE_AT) {
    releaseEquation();
    equationReleased = true;
  }

  // cámara con oscilación lenta ("respiración"); SWAY=0 con reduced-motion
  camera.position.x = CAM_BASE.x + Math.sin(now * 0.13) * 0.45 * SWAY;
  camera.position.z = CAM_BASE.z + Math.cos(now * 0.11) * 0.35 * SWAY;
  camera.position.y = CAM_BASE.y + Math.sin(now * 0.07) * 0.12 * SWAY;
  camera.lookAt(CAM_TARGET);

  // 1) relajación en GPU + textura del campo al shader de superficie
  solver.step();
  setFieldTexture(solver.fieldTexture);

  // 2) descarga del campo para partículas (CPU); las iso ya van en el shader
  solver.readback();

  if (showParticles) particles.update(dt);

  renderer.render(scene, camera);
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

// Pausa cuando la pestaña no es visible (ahorra GPU/batería).
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stop();
  else start();
});

// Pérdida de contexto WebGL (sleep, presión de memoria, cambio de GPU):
// detén el loop para no spamear errores; al restaurarse, recarga limpio.
canvas.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();
  stop();
});
canvas.addEventListener("webglcontextrestored", () => location.reload());

start();
