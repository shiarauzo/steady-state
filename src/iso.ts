import * as THREE from "three";
import { NX, NY, PLANE_W, PLANE_H, HEIGHT_SCALE } from "./constants";

/* =============================================================
   EQUIPOTENCIALES — Marching Squares sobre la grilla
   -------------------------------------------------------------
   Reconstruimos las líneas de nivel a partir del campo descargado
   a CPU. Como el campo se asienta despacio, basta rehacerlas cada
   N frames. Los segmentos se escriben en un único buffer
   pre-asignado y se dibujan como LineSegments.
   ============================================================= */
const ISO_LEVELS = [-0.8, -0.6, -0.4, -0.2, 0.2, 0.4, 0.6, 0.8];
const MAX_SEG = 12000;
const NX1 = NX - 1;
const NY1 = NY - 1;
const HALF_W = PLANE_W * 0.5;
const HALF_H = PLANE_H * 0.5;

export function createIso(phi: Float32Array): {
  lines: THREE.LineSegments;
  rebuild: () => void;
} {
  const isoVerts = new Float32Array(MAX_SEG * 2 * 3);
  const isoGeom = new THREE.BufferGeometry();
  const isoPos = new THREE.BufferAttribute(isoVerts, 3);
  isoPos.setUsage(THREE.DynamicDrawUsage);
  isoGeom.setAttribute("position", isoPos);
  isoGeom.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(0, 0, 0),
    Math.max(PLANE_W, PLANE_H),
  );
  const isoMat = new THREE.LineBasicMaterial({
    color: 0xf0a95c,
    transparent: true,
    opacity: 0.34,
  });
  const lines = new THREE.LineSegments(isoGeom, isoMat);
  lines.frustumCulled = false;

  function rebuild(): void {
    // a=phi(i,j), b=phi(i+1,j), c=phi(i+1,j+1), d=phi(i,j+1).
    // Bits: a→1, b→2, c→4, d→8. Aristas: AB(z=z0), BC(x=x1), CD(z=z1), DA(x=x0).
    let n = 0;
    let over = false;
    for (let lv = 0; lv < ISO_LEVELS.length && !over; lv++) {
      const L = ISO_LEVELS[lv];
      for (let j = 0; j < NY - 1 && !over; j++) {
        for (let i = 0; i < NX - 1; i++) {
          const a = phi[j * NX + i];
          const b = phi[j * NX + i + 1];
          const c = phi[(j + 1) * NX + i + 1];
          const d = phi[(j + 1) * NX + i];
          let m = 0;
          if (a > L) m |= 1;
          if (b > L) m |= 2;
          if (c > L) m |= 4;
          if (d > L) m |= 8;
          if (m === 0 || m === 15) continue;

          const x0 = (i / NX1) * PLANE_W - HALF_W;
          const x1 = ((i + 1) / NX1) * PLANE_W - HALF_W;
          const z0 = (j / NY1) * PLANE_H - HALF_H;
          const z1 = ((j + 1) / NY1) * PLANE_H - HALF_H;
          const y = L * HEIGHT_SCALE + 0.012; // offset anti-z-fighting
          const wx = x1 - x0;
          const wz = z1 - z0;
          const eAB = x0 + wx * ((L - a) / (b - a));
          const eBC = z0 + wz * ((L - b) / (c - b));
          const eCD = x0 + wx * ((L - d) / (c - d));
          const eDA = z0 + wz * ((L - a) / (d - a));

          if (n + 4 > MAX_SEG * 2) {
            over = true;
            break;
          }
          let o = n * 3;
          switch (m) {
            case 1:
            case 14:
              isoVerts[o] = x0; isoVerts[o + 1] = y; isoVerts[o + 2] = eDA;
              isoVerts[o + 3] = eAB; isoVerts[o + 4] = y; isoVerts[o + 5] = z0;
              n += 2; break;
            case 2:
            case 13:
              isoVerts[o] = eAB; isoVerts[o + 1] = y; isoVerts[o + 2] = z0;
              isoVerts[o + 3] = x1; isoVerts[o + 4] = y; isoVerts[o + 5] = eBC;
              n += 2; break;
            case 3:
            case 12:
              isoVerts[o] = x0; isoVerts[o + 1] = y; isoVerts[o + 2] = eDA;
              isoVerts[o + 3] = x1; isoVerts[o + 4] = y; isoVerts[o + 5] = eBC;
              n += 2; break;
            case 4:
            case 11:
              isoVerts[o] = x1; isoVerts[o + 1] = y; isoVerts[o + 2] = eBC;
              isoVerts[o + 3] = eCD; isoVerts[o + 4] = y; isoVerts[o + 5] = z1;
              n += 2; break;
            case 5: // saddle: a,c > L
              isoVerts[o] = x0; isoVerts[o + 1] = y; isoVerts[o + 2] = eDA;
              isoVerts[o + 3] = eAB; isoVerts[o + 4] = y; isoVerts[o + 5] = z0;
              o += 6;
              isoVerts[o] = x1; isoVerts[o + 1] = y; isoVerts[o + 2] = eBC;
              isoVerts[o + 3] = eCD; isoVerts[o + 4] = y; isoVerts[o + 5] = z1;
              n += 4; break;
            case 6:
            case 9:
              isoVerts[o] = eAB; isoVerts[o + 1] = y; isoVerts[o + 2] = z0;
              isoVerts[o + 3] = eCD; isoVerts[o + 4] = y; isoVerts[o + 5] = z1;
              n += 2; break;
            case 7:
            case 8:
              isoVerts[o] = x0; isoVerts[o + 1] = y; isoVerts[o + 2] = eDA;
              isoVerts[o + 3] = eCD; isoVerts[o + 4] = y; isoVerts[o + 5] = z1;
              n += 2; break;
            case 10: // saddle: b,d > L
              isoVerts[o] = eAB; isoVerts[o + 1] = y; isoVerts[o + 2] = z0;
              isoVerts[o + 3] = x1; isoVerts[o + 4] = y; isoVerts[o + 5] = eBC;
              o += 6;
              isoVerts[o] = x0; isoVerts[o + 1] = y; isoVerts[o + 2] = eDA;
              isoVerts[o + 3] = eCD; isoVerts[o + 4] = y; isoVerts[o + 5] = z1;
              n += 4; break;
          }
        }
      }
    }
    isoGeom.setDrawRange(0, n);
    isoGeom.attributes.position.needsUpdate = true;
  }

  return { lines, rebuild };
}
