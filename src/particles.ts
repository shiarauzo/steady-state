import * as THREE from "three";
import { NX, NY, PLANE_W, PLANE_H, HEIGHT_SCALE } from "./constants";

/* =============================================================
   PARTÍCULAS EN GPU (GPGPU)
   -------------------------------------------------------------
   Las partículas fluyen por −∇φ. Todo vive en la GPU: su estado
   (posición normalizada + vida) se guarda en una textura ping-pong
   y se advecta en un shader que muestrea la textura del campo
   directamente — sin readback a CPU.

   - Cabezas: THREE.Points que leen el estado por vertex texture
     fetch y sitúan cada punto sobre el relieve.
   - Estelas: SIN buffer de historia. Como las partículas siguen
     streamlines, su trayectoria pasada está sobre la línea de
     campo; cada vértice de estela REINTEGRA hacia atrás (+∇φ) desde
     la cabeza, reconstruyendo la estela en el vertex shader.
   - Las líneas de campo terminan en las cargas: si una partícula
     alcanza una celda Dirichlet (uBC.g>0.5), renace.
   ============================================================= */
const PW = 48;
const PH = 24;
const NP = PW * PH; // 1152 partículas (menos densas, acentos sobre el oscuro)
const TRAIL_LEN = 10;
const SPEED = 14.0;
const TRAIL_DT = 0.02;

// Prelude GLSL compartido (constantes de malla/mundo + helpers de campo).
const COMMON = /* glsl */ `
  #define GX ${(NX - 1).toFixed(1)}
  #define GY ${(NY - 1).toFixed(1)}
  #define PW ${PLANE_W.toFixed(4)}
  #define PH ${PLANE_H.toFixed(4)}
  #define HS ${HEIGHT_SCALE.toFixed(4)}
  const vec2 FT = vec2(${(1 / NX).toFixed(8)}, ${(1 / NY).toFixed(8)});
  const vec2 GM = vec2(GX, GY);
  vec2 fuv(vec2 g){ return (g + 0.5) * FT; }
  vec2 fgrad(sampler2D F, vec2 g){
    vec2 uv = fuv(g);
    float l = texture2D(F, uv + vec2(-FT.x, 0.0)).r;
    float r = texture2D(F, uv + vec2( FT.x, 0.0)).r;
    float d = texture2D(F, uv + vec2(0.0, -FT.y)).r;
    float u = texture2D(F, uv + vec2(0.0,  FT.y)).r;
    return vec2((r - l) * 0.5, (u - d) * 0.5);
  }
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
`;

const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = vec4(position, 1.0); }
`;

const INIT_FRAG = COMMON + /* glsl */ `
  uniform float uSeed;
  varying vec2 vUv;
  void main(){
    float r1 = hash(vUv * 13.1 + uSeed);
    float r2 = hash(vUv * 71.7 + uSeed * 1.7);
    float r3 = hash(vUv * 43.3 + uSeed * 0.3);
    float r4 = hash(vUv * 91.1 + uSeed * 2.1);
    float maxLife = 1.2 + r3 * 2.4;
    vec2 g = vec2(1.0) + vec2(r1, r2) * (GM - 2.0);
    gl_FragColor = vec4(g / GM, r4 * maxLife, maxLife); // vida escalonada
  }
`;

const ADVECT_FRAG = COMMON + /* glsl */ `
  uniform sampler2D uState, uField, uBC;
  uniform float uDt, uTime;
  varying vec2 vUv;
  void main(){
    vec4 s = texture2D(uState, vUv);
    vec2 g = s.xy * GM;
    float life = s.z, maxLife = s.w;
    bool dead = life > maxLife;

    g -= fgrad(uField, g) * ${SPEED.toFixed(1)} * uDt; // flujo por −∇φ
    life += uDt;

    bool oob = g.x < 1.0 || g.x > GX - 1.0 || g.y < 1.0 || g.y > GY - 1.0;
    float fx = texture2D(uBC, fuv(clamp(g, vec2(1.0), GM - 1.0))).g;

    if (dead || oob || fx > 0.5) {          // muere por vida, borde o carga
      float r1 = hash(vUv * 13.1 + uTime);
      float r2 = hash(vUv * 71.7 + uTime * 1.7);
      float r3 = hash(vUv * 43.3 + uTime * 0.3);
      maxLife = 1.2 + r3 * 2.4;
      g = vec2(1.0) + vec2(r1, r2) * (GM - 2.0);
      life = 0.0;
    }
    gl_FragColor = vec4(g / GM, life, maxLife);
  }
`;

// Vista cenital plana: posición en XZ a y≈0, tamaño en píxeles (sin escorzo).
const HEADS_VERT = COMMON + /* glsl */ `
  uniform sampler2D uState, uField;
  uniform float uSize, uDpr;
  attribute vec2 aRef;
  varying float vA;
  void main(){
    vec4 s = texture2D(uState, aRef);
    vec2 g = s.xy * GM;
    float t = s.z / max(s.w, 1e-3);
    float fade = min(1.0, t * 6.0) * min(1.0, (1.0 - t) * 4.0);
    float gMag = min(1.0, length(fgrad(uField, g)) * 5.0);
    vA = (0.3 + 0.7 * gMag) * fade;
    gl_Position = projectionMatrix * modelViewMatrix * vec4((g.x/GX-0.5)*PW, 0.06, (g.y/GY-0.5)*PH, 1.0);
    gl_PointSize = uSize * vA * uDpr;
  }
`;

const TRAILS_VERT = COMMON + /* glsl */ `
  uniform sampler2D uState, uField;
  uniform float uSize, uDpr;
  attribute vec2 aRef;
  attribute float aT;
  varying float vA;
  void main(){
    vec4 s = texture2D(uState, aRef);
    vec2 g = s.xy * GM;
    float t = s.z / max(s.w, 1e-3);
    float fade = min(1.0, t * 6.0) * min(1.0, (1.0 - t) * 4.0);
    // reintegra hacia atrás (+∇φ) la línea de campo desde la cabeza
    for (int k = 0; k < ${TRAIL_LEN}; k++) {
      if (float(k) >= aT) break;
      g += fgrad(uField, g) * ${SPEED.toFixed(1)} * ${TRAIL_DT};
      g = clamp(g, vec2(1.0), GM - 1.0);
    }
    float decay = 1.0 - aT / float(${TRAIL_LEN});
    vA = fade * decay * 0.55;
    gl_Position = projectionMatrix * modelViewMatrix * vec4((g.x/GX-0.5)*PW, 0.04, (g.y/GY-0.5)*PH, 1.0);
    gl_PointSize = uSize * max(vA, 0.0) * uDpr;
  }
`;

// Punto nítido (núcleo + halo sutil), no desenfoque.
const dotFrag = (gain: number) => /* glsl */ `
  varying float vA;
  uniform vec3 uColor;
  void main(){
    if (vA <= 0.001) discard;
    float d = length(gl_PointCoord - 0.5);
    float core = smoothstep(0.5, 0.36, d);
    float halo = exp(-d * d * 7.0) * 0.3;
    float a = (core + halo) * vA * ${gain.toFixed(2)};
    gl_FragColor = vec4(uColor * a, a);
  }
`;

function makeState(): THREE.WebGLRenderTarget {
  // FloatType sería ideal para la precisión de posición, pero HalfFloat es
  // mucho más compatible; el campo se asienta lento y el jitter es invisible.
  return new THREE.WebGLRenderTarget(PW, PH, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

export function createParticles(
  renderer: THREE.WebGLRenderer,
  bcTexture: THREE.Texture,
): {
  points: THREE.Points;
  trails: THREE.Points;
  update: (dt: number, field: THREE.Texture) => void;
  reseed: () => void;
} {
  let sA = makeState();
  let sB = makeState();

  // Escena GPGPU (quad fullscreen) para los pases de init/advección.
  const gpScene = new THREE.Scene();
  const gpCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  gpScene.add(quad);

  const initMat = new THREE.ShaderMaterial({
    uniforms: { uSeed: { value: 0 } },
    vertexShader: QUAD_VERT,
    fragmentShader: INIT_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  const advectMat = new THREE.ShaderMaterial({
    uniforms: {
      uState: { value: null },
      uField: { value: null },
      uBC: { value: bcTexture },
      uDt: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: QUAD_VERT,
    fragmentShader: ADVECT_FRAG,
    depthTest: false,
    depthWrite: false,
  });

  function renderTo(target: THREE.WebGLRenderTarget, mat: THREE.Material): void {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(gpScene, gpCam);
    renderer.setRenderTarget(null);
  }

  // Geometrías de render (posición ficticia; la real se calcula en el vertex).
  const headsGeo = new THREE.BufferGeometry();
  const ref = new Float32Array(NP * 2);
  for (let p = 0; p < NP; p++) {
    ref[p * 2] = ((p % PW) + 0.5) / PW;
    ref[p * 2 + 1] = (Math.floor(p / PW) + 0.5) / PH;
  }
  headsGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(NP * 3), 3));
  headsGeo.setAttribute("aRef", new THREE.BufferAttribute(ref, 2));

  const M = NP * TRAIL_LEN;
  const tref = new Float32Array(M * 2);
  const tT = new Float32Array(M);
  for (let p = 0, i = 0; p < NP; p++) {
    const u = ((p % PW) + 0.5) / PW;
    const v = (Math.floor(p / PW) + 0.5) / PH;
    for (let t = 0; t < TRAIL_LEN; t++, i++) {
      tref[i * 2] = u;
      tref[i * 2 + 1] = v;
      tT[i] = t;
    }
  }
  const trailsGeo = new THREE.BufferGeometry();
  trailsGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(M * 3), 3));
  trailsGeo.setAttribute("aRef", new THREE.BufferAttribute(tref, 2));
  trailsGeo.setAttribute("aT", new THREE.BufferAttribute(tT, 1));

  const bigSphere = new THREE.Sphere(new THREE.Vector3(), Math.max(PLANE_W, PLANE_H) + 6);
  headsGeo.boundingSphere = bigSphere;
  trailsGeo.boundingSphere = bigSphere;

  const dpr = renderer.getPixelRatio();
  const neon = new THREE.Color(0xbfefff); // blanco-cian nítido
  const headsMat = new THREE.ShaderMaterial({
    uniforms: { uState: { value: null }, uField: { value: null }, uColor: { value: neon }, uSize: { value: 4.5 }, uDpr: { value: dpr } },
    vertexShader: HEADS_VERT,
    fragmentShader: dotFrag(1.0),
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const trailsMat = new THREE.ShaderMaterial({
    uniforms: { uState: { value: null }, uField: { value: null }, uColor: { value: neon }, uSize: { value: 3.0 }, uDpr: { value: dpr } },
    vertexShader: TRAILS_VERT,
    fragmentShader: dotFrag(0.55),
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(headsGeo, headsMat);
  const trails = new THREE.Points(trailsGeo, trailsMat);
  points.frustumCulled = false;
  trails.frustumCulled = false;

  let needsReseed = true;
  let time = 0;

  function update(dt: number, field: THREE.Texture): void {
    if (needsReseed) {
      initMat.uniforms.uSeed.value = Math.random() * 1000;
      renderTo(sA, initMat);
      needsReseed = false;
    }
    const d = Math.min(dt, 0.05);
    time += d;
    advectMat.uniforms.uState.value = sA.texture;
    advectMat.uniforms.uField.value = field;
    advectMat.uniforms.uDt.value = d;
    advectMat.uniforms.uTime.value = time;
    renderTo(sB, advectMat);
    [sA, sB] = [sB, sA];

    headsMat.uniforms.uState.value = sA.texture;
    headsMat.uniforms.uField.value = field;
    trailsMat.uniforms.uState.value = sA.texture;
    trailsMat.uniforms.uField.value = field;
  }

  function reseed(): void {
    needsReseed = true;
  }

  return { points, trails, update, reseed };
}
