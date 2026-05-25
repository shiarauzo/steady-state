import * as THREE from "three";
import { NX, NY, PLANE_W, PLANE_H, HEIGHT_SCALE } from "./constants";

/* =============================================================
   PARTÍCULAS: fluyen siguiendo −∇φ sobre la superficie 3D.
   -------------------------------------------------------------
   El gradiente se muestrea (bilinear) del campo descargado a CPU.
   Cada partícula lleva un ring buffer de TRAIL_LEN posiciones para
   dibujar una estela con decay exponencial; cabezas y estelas se
   renderizan con glow aditivo en dos draw calls.
   ============================================================= */
const N_PART = 2000;
const TRAIL_LEN = 8;
const SPEED = 14.0; // avance en coords de grilla por segundo

const POINT_VERT = /* glsl */ `
  attribute float aAlpha;
  varying float vA;
  uniform float uSize;
  void main(){
    vA = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uSize * aAlpha * (260.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }`;

const pointFrag = (falloff: number, gain: number) => /* glsl */ `
  varying float vA;
  uniform vec3 uColor;
  void main(){
    vec2 d = gl_PointCoord - 0.5;
    float r = dot(d, d);
    float a = exp(-r * ${falloff.toFixed(1)});
    gl_FragColor = vec4(uColor * a * vA * ${gain.toFixed(2)}, a * vA * ${gain.toFixed(2)});
  }`;

export function createParticles(
  phi: Float32Array,
  fixed: Uint8Array,
): {
  points: THREE.Points;
  trails: THREE.Points;
  update: (dt: number) => void;
  respawnAll: () => void;
} {
  const partI = new Float32Array(N_PART);
  const partJ = new Float32Array(N_PART);
  const partLife = new Float32Array(N_PART);
  const partMaxLife = new Float32Array(N_PART);
  const partPos = new Float32Array(N_PART * 3);
  const partAlphaArr = new Float32Array(N_PART);

  const trailPos = new Float32Array(N_PART * TRAIL_LEN * 3);
  const trailAlpha = new Float32Array(N_PART * TRAIL_LEN);
  const trailHead = new Uint8Array(N_PART);

  function spawnParticle(idx: number): void {
    partI[idx] = 1 + Math.random() * (NX - 3);
    partJ[idx] = 1 + Math.random() * (NY - 3);
    partLife[idx] = 0;
    partMaxLife[idx] = 1.2 + Math.random() * 2.4;
    const wx = (partI[idx] / (NX - 1) - 0.5) * PLANE_W;
    const wz = (partJ[idx] / (NY - 1) - 0.5) * PLANE_H;
    for (let t = 0; t < TRAIL_LEN; t++) {
      const off = (idx * TRAIL_LEN + t) * 3;
      trailPos[off] = wx;
      trailPos[off + 1] = 0;
      trailPos[off + 2] = wz;
      trailAlpha[idx * TRAIL_LEN + t] = 0;
    }
    trailHead[idx] = 0;
  }
  for (let i = 0; i < N_PART; i++) spawnParticle(i);

  /* ---- Sampling de ∇φ y φ (bilinear) ---- */
  function sampleGradient(fi: number, fj: number, out: [number, number]): void {
    const i0 = Math.floor(fi);
    const j0 = Math.floor(fj);
    const u = fi - i0;
    const v = fj - j0;
    const i1 = i0 + 1;
    const j1 = j0 + 1;
    if (i0 < 1 || i1 >= NX - 1 || j0 < 1 || j1 >= NY - 1) {
      out[0] = 0;
      out[1] = 0;
      return;
    }
    const gx00 = (phi[j0 * NX + i0 + 1] - phi[j0 * NX + i0 - 1]) * 0.5;
    const gx10 = (phi[j0 * NX + i1 + 1] - phi[j0 * NX + i1 - 1]) * 0.5;
    const gx01 = (phi[j1 * NX + i0 + 1] - phi[j1 * NX + i0 - 1]) * 0.5;
    const gx11 = (phi[j1 * NX + i1 + 1] - phi[j1 * NX + i1 - 1]) * 0.5;
    const gy00 = (phi[(j0 + 1) * NX + i0] - phi[(j0 - 1) * NX + i0]) * 0.5;
    const gy10 = (phi[(j0 + 1) * NX + i1] - phi[(j0 - 1) * NX + i1]) * 0.5;
    const gy01 = (phi[(j1 + 1) * NX + i0] - phi[(j1 - 1) * NX + i0]) * 0.5;
    const gy11 = (phi[(j1 + 1) * NX + i1] - phi[(j1 - 1) * NX + i1]) * 0.5;
    out[0] =
      (1 - u) * (1 - v) * gx00 + u * (1 - v) * gx10 + (1 - u) * v * gx01 + u * v * gx11;
    out[1] =
      (1 - u) * (1 - v) * gy00 + u * (1 - v) * gy10 + (1 - u) * v * gy01 + u * v * gy11;
  }

  function samplePhi(fi: number, fj: number): number {
    const i0 = Math.floor(fi);
    const j0 = Math.floor(fj);
    if (i0 < 0 || i0 >= NX - 1 || j0 < 0 || j0 >= NY - 1) return 0;
    const u = fi - i0;
    const v = fj - j0;
    const a = phi[j0 * NX + i0];
    const b = phi[j0 * NX + i0 + 1];
    const c = phi[(j0 + 1) * NX + i0];
    const d = phi[(j0 + 1) * NX + i0 + 1];
    return (1 - u) * (1 - v) * a + u * (1 - v) * b + (1 - u) * v * c + u * v * d;
  }

  /* ---- Geometrías + materiales ---- */
  const partGeom = new THREE.BufferGeometry();
  const partPosAttr = new THREE.BufferAttribute(partPos, 3);
  const partAlphaAttr = new THREE.BufferAttribute(partAlphaArr, 1);
  partPosAttr.setUsage(THREE.DynamicDrawUsage);
  partAlphaAttr.setUsage(THREE.DynamicDrawUsage);
  partGeom.setAttribute("position", partPosAttr);
  partGeom.setAttribute("aAlpha", partAlphaAttr);

  const partMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xf0a95c) },
      uSize: { value: 6.5 },
    },
    vertexShader: POINT_VERT,
    fragmentShader: pointFrag(14.0, 1.0),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(partGeom, partMat);
  points.frustumCulled = false;

  const trailGeom = new THREE.BufferGeometry();
  const trailPosAttr = new THREE.BufferAttribute(trailPos, 3);
  const trailAlphaAttr = new THREE.BufferAttribute(trailAlpha, 1);
  trailPosAttr.setUsage(THREE.DynamicDrawUsage);
  trailAlphaAttr.setUsage(THREE.DynamicDrawUsage);
  trailGeom.setAttribute("position", trailPosAttr);
  trailGeom.setAttribute("aAlpha", trailAlphaAttr);
  const trailMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xf0a95c) },
      uSize: { value: 3.6 },
    },
    vertexShader: POINT_VERT,
    fragmentShader: pointFrag(10.0, 0.7),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const trails = new THREE.Points(trailGeom, trailMat);
  trails.frustumCulled = false;

  const tmpG: [number, number] = [0, 0];
  function update(dt: number): void {
    for (let p = 0; p < N_PART; p++) {
      partLife[p] += dt;
      if (partLife[p] > partMaxLife[p]) {
        spawnParticle(p);
        continue;
      }
      sampleGradient(partI[p], partJ[p], tmpG);
      partI[p] -= tmpG[0] * SPEED * dt;
      partJ[p] -= tmpG[1] * SPEED * dt;

      if (partI[p] < 1 || partI[p] >= NX - 1 || partJ[p] < 1 || partJ[p] >= NY - 1) {
        spawnParticle(p);
        continue;
      }

      // las líneas de campo E = −∇φ terminan en las cargas: si la partícula
      // alcanza una celda Dirichlet (un polo pintado), renace.
      if (fixed[(Math.round(partJ[p]) * NX + Math.round(partI[p]))]) {
        spawnParticle(p);
        continue;
      }

      const wx = (partI[p] / (NX - 1) - 0.5) * PLANE_W;
      const wz = (partJ[p] / (NY - 1) - 0.5) * PLANE_H;
      const wy = samplePhi(partI[p], partJ[p]) * HEIGHT_SCALE + 0.04;

      partPos[3 * p] = wx;
      partPos[3 * p + 1] = wy;
      partPos[3 * p + 2] = wz;

      const t = partLife[p] / partMaxLife[p];
      const fade = Math.min(1, t * 6) * Math.min(1, (1 - t) * 4);
      const gMag = Math.min(1, Math.hypot(tmpG[0], tmpG[1]) * 5);
      partAlphaArr[p] = 0.35 + 0.65 * gMag * fade;

      const h = trailHead[p];
      const off = (p * TRAIL_LEN + h) * 3;
      trailPos[off] = wx;
      trailPos[off + 1] = wy;
      trailPos[off + 2] = wz;
      trailAlpha[p * TRAIL_LEN + h] = partAlphaArr[p];
      trailHead[p] = (h + 1) % TRAIL_LEN;

      const base = p * TRAIL_LEN;
      for (let s = 0; s < TRAIL_LEN; s++) {
        if (s !== h) trailAlpha[base + s] *= 0.86;
      }
    }
    partGeom.attributes.position.needsUpdate = true;
    partGeom.attributes.aAlpha.needsUpdate = true;
    trailGeom.attributes.position.needsUpdate = true;
    trailGeom.attributes.aAlpha.needsUpdate = true;
  }

  function respawnAll(): void {
    for (let i = 0; i < N_PART; i++) spawnParticle(i);
  }

  return { points, trails, update, respawnAll };
}
