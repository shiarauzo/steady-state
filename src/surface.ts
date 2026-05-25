import * as THREE from "three";
import { NX, NY, PLANE_W, PLANE_H, HEIGHT_SCALE } from "./constants";
import { buildPaletteLUT } from "./palette";

/* =============================================================
   HEIGHTFIELD EN GPU
   -------------------------------------------------------------
   Un plano teselado (NX-1 × NY-1) cuyos vértices se desplazan en
   el shader leyendo la textura del campo (vertex texture fetch):
        y = φ(uv) · HEIGHT_SCALE
   Las normales se calculan del gradiente discreto muestreando
   texels vecinos. El color sale de una LUT 1D horneada en OKLab
   (paleta perceptual), y las equipotenciales se dibujan en
   screen-space sobre el propio relieve con fract()+fwidth() — AA
   perfecto, densidad tipo mapa topográfico y sin z-fighting.
   Inyectamos todo en un MeshStandardMaterial (onBeforeCompile)
   para conservar el PBR y las luces de la escena.

   Convención de índices: el vértice (i,j) tiene uv.x=i/(NX-1),
   uv.y=1−j/(NY-1); reconstruimos (i,j) y muestreamos el texel
   centrado ((i+.5)/NX,(j+.5)/NY) para alinear con pintado,
   partículas y campo.
   ============================================================= */

const ISO_SPACING = 0.2; // separación de equipotenciales en φ
const ISO_COLOR = new THREE.Color(0xf0a95c);

export function createSurface(fieldTexture: THREE.Texture): {
  mesh: THREE.Mesh;
  setFieldTexture: (t: THREE.Texture) => void;
} {
  const geom = new THREE.PlaneGeometry(PLANE_W, PLANE_H, NX - 1, NY - 1);
  geom.rotateX(-Math.PI / 2); // plano en XZ, altura en Y
  geom.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(0, 0, 0),
    Math.max(PLANE_W, PLANE_H) + 4,
  );

  // LUT de la paleta (OKLab) como textura 1D, muestreada por valor de φ.
  const lut = new THREE.DataTexture(
    buildPaletteLUT(256),
    256,
    1,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  lut.minFilter = THREE.LinearFilter;
  lut.magFilter = THREE.LinearFilter;
  lut.wrapS = THREE.ClampToEdgeWrapping;
  lut.needsUpdate = true;

  const mat = new THREE.MeshStandardMaterial({
    metalness: 0.18,
    roughness: 0.62,
    flatShading: false,
    dithering: true, // rompe el banding de 8 bits en el degradado
  });

  const uniforms = {
    uField: { value: fieldTexture },
    uPalette: { value: lut },
    uTexel: { value: new THREE.Vector2(1 / NX, 1 / NY) },
    uGrid: { value: new THREE.Vector2(NX - 1, NY - 1) },
    uHeight: { value: HEIGHT_SCALE },
    uDxy: { value: new THREE.Vector2(PLANE_W / (NX - 1), PLANE_H / (NY - 1)) },
    uIsoSpacing: { value: ISO_SPACING },
    uIsoColor: { value: ISO_COLOR },
  };

  mat.onBeforeCompile = (shader) => {
    for (const key of Object.keys(uniforms) as (keyof typeof uniforms)[]) {
      shader.uniforms[key] = uniforms[key];
    }

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        uniform sampler2D uField;
        uniform vec2 uTexel;
        uniform vec2 uGrid;
        uniform vec2 uDxy;
        uniform float uHeight;
        varying float vPhi;
        `,
      )
      .replace(
        "#include <beginnormal_vertex>",
        /* glsl */ `
        vec2 _g = vec2(uv.x * uGrid.x, (1.0 - uv.y) * uGrid.y);
        vec2 _sUv = (_g + 0.5) * uTexel;
        float _h = texture2D(uField, _sUv).r;
        float _hl = texture2D(uField, _sUv + vec2(-uTexel.x, 0.0)).r;
        float _hr = texture2D(uField, _sUv + vec2( uTexel.x, 0.0)).r;
        float _hd = texture2D(uField, _sUv + vec2(0.0, -uTexel.y)).r;
        float _hu = texture2D(uField, _sUv + vec2(0.0,  uTexel.y)).r;
        float _dfx = (_hr - _hl) / (2.0 * uDxy.x);
        float _dfy = (_hu - _hd) / (2.0 * uDxy.y);
        vec3 objectNormal = normalize(vec3(-uHeight * _dfx, 1.0, -uHeight * _dfy));
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(tangent.xyz);
        #endif
        `,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `
        vec3 transformed = vec3(position);
        transformed.y = _h * uHeight;
        vPhi = _h;
        `,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        uniform sampler2D uPalette;
        uniform float uIsoSpacing;
        uniform vec3 uIsoColor;
        varying float vPhi;
        `,
      )
      // color por valor de φ desde la LUT OKLab (φ∈[-1,1] → [0,1])
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
        diffuseColor.rgb *= texture2D(uPalette, vec2(clamp(vPhi * 0.5 + 0.5, 0.0, 1.0), 0.5)).rgb;
        `,
      )
      // equipotenciales screen-space como emisivo (glow constante, sin z-fight)
      .replace(
        "#include <emissivemap_fragment>",
        /* glsl */ `#include <emissivemap_fragment>
        float _s = vPhi / uIsoSpacing;
        float _iso = 1.0 - clamp(abs(fract(_s - 0.5) - 0.5) / max(fwidth(_s), 1e-4), 0.0, 1.0);
        totalEmissiveRadiance += uIsoColor * _iso * 0.5;
        `,
      );
  };

  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;

  return {
    mesh,
    setFieldTexture: (t: THREE.Texture) => {
      uniforms.uField.value = t;
    },
  };
}
