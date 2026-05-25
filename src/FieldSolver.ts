import * as THREE from "three";
import { NX, NY, N, OMEGA } from "./constants";

/* =============================================================
   LAPLACE FIELD — RELAXATION SOLVER EN GPU
   -------------------------------------------------------------
   El campo escalar φ(x,y) obedece ∇²φ = 0 en el interior y
   condiciones Dirichlet en las celdas que el usuario pinta.
   En equilibrio cada φᵢⱼ = ¼·Σvecinos (laplaciano discreto nulo).

   En lugar de iterar Gauss–Seidel en el hilo principal (JS), el
   campo vive en una textura flotante y se relaja en la GPU con un
   esquema RED-BLACK GAUSS–SEIDEL + sobre-relajación (SOR):

        φᵢⱼ ← φᵢⱼ + ω · (¼·Σvecinos − φᵢⱼ),   ω ≈ 1.88

   Cada "sweep" son DOS pasadas ping-pong (rojas, luego negras): en
   la pasada roja se actualizan las celdas con (i+j) par leyendo a
   sus vecinas negras; en la negra, al revés leyendo las rojas ya
   actualizadas. Esto reproduce el orden secuencial de Gauss–Seidel
   manteniendo el paralelismo de la GPU.

   Condiciones de frontera Neumann (∂φ/∂n = 0) emergen del muestreo
   con ClampToEdgeWrapping: una celda de borde "ve" su propio valor
   como vecino exterior.
   ============================================================= */

const SOLVE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uField;   // φ actual (en .r)
uniform sampler2D uBC;      // .r = valor Dirichlet, .g = 1 si es fija
uniform vec2  uTexel;       // (1/NX, 1/NY)
uniform float uOmega;
uniform float uParity;      // 0.0 actualiza celdas (i+j) pares; 1.0 impares
varying vec2 vUv;

void main(){
  float phi = texture2D(uField, vUv).r;

  float fi = floor(vUv.x / uTexel.x);
  float fj = floor(vUv.y / uTexel.y);
  float parity = mod(fi + fj, 2.0);

  // Celdas de la otra paridad pasan sin cambios (mitad del tablero por pasada).
  if (parity != uParity) {
    gl_FragColor = vec4(phi, 0.0, 0.0, 1.0);
    return;
  }

  // Celdas Dirichlet: fijadas al valor pintado.
  vec2 bc = texture2D(uBC, vUv).rg;
  if (bc.g > 0.5) {
    gl_FragColor = vec4(bc.r, 0.0, 0.0, 1.0);
    return;
  }

  // Vecinas (clamp-to-edge ≈ Neumann en los bordes).
  float l = texture2D(uField, vUv + vec2(-uTexel.x, 0.0)).r;
  float r = texture2D(uField, vUv + vec2( uTexel.x, 0.0)).r;
  float d = texture2D(uField, vUv + vec2(0.0, -uTexel.y)).r;
  float u = texture2D(uField, vUv + vec2(0.0,  uTexel.y)).r;

  float avg = 0.25 * (l + r + d + u);
  float next = phi + uOmega * (avg - phi);
  gl_FragColor = vec4(next, 0.0, 0.0, 1.0);
}
`;

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`;

function makeTarget(): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(NX, NY, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

export class FieldSolver {
  private renderer: THREE.WebGLRenderer;
  private rtA = makeTarget();
  private rtB = makeTarget();
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: THREE.ShaderMaterial;

  // Espejo en CPU de las condiciones de contorno (para pintar) + textura.
  readonly phiFix = new Float32Array(N);
  readonly fixed = new Uint8Array(N);
  private bcData = new Float32Array(N * 4);
  private bcTex: THREE.DataTexture;

  // Lectura del campo a CPU (la usan partículas e iso).
  readonly phi = new Float32Array(N);
  private readBuf = new Float32Array(N * 4);

  iterPerFrame = 8;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;

    this.bcTex = new THREE.DataTexture(
      this.bcData,
      NX,
      NY,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    this.bcTex.minFilter = THREE.NearestFilter;
    this.bcTex.magFilter = THREE.NearestFilter;
    this.bcTex.needsUpdate = true;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uField: { value: null },
        uBC: { value: this.bcTex },
        uTexel: { value: new THREE.Vector2(1 / NX, 1 / NY) },
        uOmega: { value: OMEGA },
        uParity: { value: 0 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: SOLVE_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));

    this.clearTargets();
  }

  /** Textura del campo actual — la muestrea el shader de la superficie. */
  get fieldTexture(): THREE.Texture {
    return this.rtA.texture;
  }

  private clearTargets(): void {
    const prev = this.renderer.getRenderTarget();
    const prevClear = this.renderer.getClearColor(new THREE.Color());
    const prevAlpha = this.renderer.getClearAlpha();
    this.renderer.setClearColor(0x000000, 0);
    for (const rt of [this.rtA, this.rtB]) {
      this.renderer.setRenderTarget(rt);
      this.renderer.clear(true, false, false);
    }
    this.renderer.setRenderTarget(prev);
    this.renderer.setClearColor(prevClear, prevAlpha);
  }

  private pass(parity: number): void {
    // lee de rtA, escribe en rtB, luego intercambia
    this.material.uniforms.uField.value = this.rtA.texture;
    this.material.uniforms.uParity.value = parity;
    this.renderer.setRenderTarget(this.rtB);
    this.renderer.render(this.scene, this.camera);
    const t = this.rtA;
    this.rtA = this.rtB;
    this.rtB = t;
  }

  /** Avanza `iterPerFrame` sweeps de SOR. Deja el render target en null. */
  step(): void {
    for (let s = 0; s < this.iterPerFrame; s++) {
      this.pass(0); // celdas pares (rojas)
      this.pass(1); // celdas impares (negras)
    }
    this.renderer.setRenderTarget(null);
  }

  /** Descarga el campo desde la GPU a `this.phi` (RGBA → canal R). */
  readback(): void {
    this.renderer.readRenderTargetPixels(this.rtA, 0, 0, NX, NY, this.readBuf);
    const buf = this.readBuf;
    const phi = this.phi;
    for (let k = 0; k < N; k++) phi[k] = buf[k * 4];
  }

  /** Marca una celda como Dirichlet con el valor dado (espejo CPU + textura). */
  setFixed(k: number, value: number): void {
    this.phiFix[k] = value;
    this.fixed[k] = 1;
    this.bcData[k * 4] = value;
    this.bcData[k * 4 + 1] = 1.0;
    this.bcTex.needsUpdate = true;
  }

  /** Libera una celda Dirichlet: vuelve a ser interior y relaja (issue #11). */
  unfix(k: number): void {
    this.fixed[k] = 0;
    this.phiFix[k] = 0; // si luego se pinta aquí, blendFixed parte de 0, no de la tinta
    this.bcData[k * 4 + 1] = 0;
    this.bcTex.needsUpdate = true;
  }

  /** Mezcla suave (pincel gaussiano) sobre el valor Dirichlet existente. */
  blendFixed(k: number, value: number, w: number): void {
    const nv = this.phiFix[k] * (1 - w) + value * w;
    this.phiFix[k] = nv;
    this.fixed[k] = 1;
    this.bcData[k * 4] = nv;
    this.bcData[k * 4 + 1] = 1.0;
    this.bcTex.needsUpdate = true;
  }

  reset(): void {
    this.phi.fill(0);
    this.phiFix.fill(0);
    this.fixed.fill(0);
    this.bcData.fill(0);
    this.bcTex.needsUpdate = true;
    this.clearTargets();
  }
}
