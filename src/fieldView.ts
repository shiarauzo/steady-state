import * as THREE from "three";
import { PLANE_W, PLANE_H } from "./constants";
import { buildPaletteLUT } from "./palette";

/* =============================================================
   VISTA CENITAL — CUADRÍCULA DE PUNTOS + EQUIPOTENCIALES
   -------------------------------------------------------------
   Presentación plana (top-down) tipo data-viz: el campo φ se
   muestrea en una rejilla regular y cada celda es un círculo
   nítido cuyo TAMAÑO y COLOR codifican el potencial; las celdas
   casi neutras (φ≈0) no dibujan punto → negro y espacio negativo.
   Debajo, equipotenciales finas (líneas de nivel) como curvas
   limpias. Sin relieve 3D, sin desenfoque: nítido sobre negro.
   ============================================================= */
const DOT_NX = 84;
const DOT_NY = 50;
const NP = DOT_NX * DOT_NY;

const PRELUDE = /* glsl */ `
  #define PLW ${PLANE_W.toFixed(4)}
  #define PLH ${PLANE_H.toFixed(4)}
`;

const DOT_VERT = PRELUDE + /* glsl */ `
  uniform sampler2D uField, uPalette;
  uniform float uDpr, uBase, uRange;
  attribute vec2 aRef;       // uv del campo (0..1) = posición de la celda
  varying vec3 vCol;
  varying float vA;
  void main(){
    float phi = texture2D(uField, aRef).r;
    float a = abs(phi);
    vA = smoothstep(0.04, 0.22, a);   // φ≈0 ⇒ sin punto (negativo/negro)
    vCol = texture2D(uPalette, vec2(clamp(phi * 0.5 + 0.5, 0.0, 1.0), 0.5)).rgb;
    vec3 wp = vec3((aRef.x - 0.5) * PLW, 0.0, (aRef.y - 0.5) * PLH);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
    gl_PointSize = (uBase + a * uRange) * uDpr;
  }
`;

const DOT_FRAG = /* glsl */ `
  varying vec3 vCol;
  varying float vA;
  void main(){
    if (vA <= 0.001) discard;
    float d = length(gl_PointCoord - 0.5);
    float core = smoothstep(0.5, 0.4, d);     // círculo nítido
    float halo = exp(-d * d * 6.0) * 0.28;    // glow sutil (no desenfoque pesado)
    float a = (core + halo) * vA;
    gl_FragColor = vec4(vCol * a, a);
  }
`;

const CONTOUR_VERT = /* glsl */ `
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

const CONTOUR_FRAG = /* glsl */ `
  uniform sampler2D uField;
  uniform vec3 uColor;
  varying vec2 vUv;
  void main(){
    vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
    float phi = texture2D(uField, uv).r;
    float s = phi / 0.2;                       // equipotenciales cada 0.2
    float iso = 1.0 - clamp(abs(fract(s - 0.5) - 0.5) / max(fwidth(s), 1e-4), 0.0, 1.0);
    if (iso < 0.02) discard;
    gl_FragColor = vec4(uColor, iso * 0.22);   // líneas finas y tenues
  }
`;

export function createDotField(fieldTexture: THREE.Texture): {
  group: THREE.Group;
  setField: (t: THREE.Texture) => void;
  setDpr: (d: number) => void;
} {
  const lut = new THREE.DataTexture(
    buildPaletteLUT(256),
    256,
    1,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  lut.minFilter = THREE.LinearFilter;
  lut.magFilter = THREE.LinearFilter;
  lut.needsUpdate = true;

  // ---- Cuadrícula de puntos ----
  const ref = new Float32Array(NP * 2);
  for (let j = 0, k = 0; j < DOT_NY; j++) {
    for (let i = 0; i < DOT_NX; i++, k++) {
      ref[k * 2] = i / (DOT_NX - 1);
      ref[k * 2 + 1] = j / (DOT_NY - 1);
    }
  }
  const dotGeo = new THREE.BufferGeometry();
  dotGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(NP * 3), 3));
  dotGeo.setAttribute("aRef", new THREE.BufferAttribute(ref, 2));
  dotGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Math.max(PLANE_W, PLANE_H));

  const dotMat = new THREE.ShaderMaterial({
    uniforms: {
      uField: { value: fieldTexture },
      uPalette: { value: lut },
      uDpr: { value: 1 },
      uBase: { value: 1.5 },
      uRange: { value: 9.0 },
    },
    vertexShader: DOT_VERT,
    fragmentShader: DOT_FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const dots = new THREE.Points(dotGeo, dotMat);
  dots.frustumCulled = false;
  dots.renderOrder = 2;

  // ---- Equipotenciales (plano plano en XZ) ----
  const cGeo = new THREE.PlaneGeometry(PLANE_W, PLANE_H);
  cGeo.rotateX(-Math.PI / 2);
  const cMat = new THREE.ShaderMaterial({
    uniforms: {
      uField: { value: fieldTexture },
      uColor: { value: new THREE.Color(0x9fb4d0) },
    },
    vertexShader: CONTOUR_VERT,
    fragmentShader: CONTOUR_FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const contour = new THREE.Mesh(cGeo, cMat);
  contour.renderOrder = 1;

  const group = new THREE.Group();
  group.add(contour);
  group.add(dots);

  return {
    group,
    setField: (t: THREE.Texture) => {
      dotMat.uniforms.uField.value = t;
      cMat.uniforms.uField.value = t;
    },
    setDpr: (d: number) => {
      dotMat.uniforms.uDpr.value = d;
    },
  };
}
