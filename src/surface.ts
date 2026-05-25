import * as THREE from "three";
import { NX, NY, PLANE_W, PLANE_H, HEIGHT_SCALE } from "./constants";
import { paletteGLSL } from "./palette";

/* =============================================================
   HEIGHTFIELD EN GPU
   -------------------------------------------------------------
   Un plano teselado (NX-1 × NY-1) cuyos vértices se desplazan en
   el shader leyendo la textura del campo (vertex texture fetch):
        y = φ(uv) · HEIGHT_SCALE
   Las normales se calculan analíticamente del gradiente discreto
   muestreando texels vecinos, y el color sale de la misma paleta
   cálida que las equipotenciales. Inyectamos todo en un
   MeshStandardMaterial (onBeforeCompile) para conservar el PBR y
   las luces hemisférica/direccional de la escena.

   Convención de índices: el vértice de columna i, fila j tiene
        uv.x = i/(NX-1),  uv.y = 1 − j/(NY-1)
   (PlaneGeometry, tras rotateX(-90°), invierte la V). Reconstruimos
   (i,j) y muestreamos el texel centrado ((i+.5)/NX, (j+.5)/NY) para
   que el relieve coincida exactamente con lo que se pinta y con las
   partículas/iso, que indexan el array por k = j·NX + i.
   ============================================================= */
export function createSurface(fieldTexture: THREE.Texture): {
  mesh: THREE.Mesh;
  setFieldTexture: (t: THREE.Texture) => void;
} {
  const geom = new THREE.PlaneGeometry(PLANE_W, PLANE_H, NX - 1, NY - 1);
  geom.rotateX(-Math.PI / 2); // plano en XZ, altura en Y
  // bounding sphere amplia: los vértices se desplazan en el shader y el
  // frustum culling no debe descartar la malla cuando crece el relieve.
  geom.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(0, 0, 0),
    Math.max(PLANE_W, PLANE_H) + 4,
  );

  const mat = new THREE.MeshStandardMaterial({
    metalness: 0.18,
    roughness: 0.62,
    flatShading: false,
  });

  const uniforms = {
    uField: { value: fieldTexture },
    uTexel: { value: new THREE.Vector2(1 / NX, 1 / NY) },
    uGrid: { value: new THREE.Vector2(NX - 1, NY - 1) },
    uHeight: { value: HEIGHT_SCALE },
    uDxy: {
      value: new THREE.Vector2(PLANE_W / (NX - 1), PLANE_H / (NY - 1)),
    },
  };

  mat.onBeforeCompile = (shader) => {
    // compartir por referencia para poder actualizar uField cada frame
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
        varying vec3 vTint;
        ${paletteGLSL()}
        `,
      )
      // beginnormal_vertex corre primero: aquí calculamos uv centrada,
      // altura y normal analítica, y dejamos h/sUv para begin_vertex.
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
        vTint = palette(_h);
        `,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\n        varying vec3 vTint;",
      )
      .replace(
        "#include <color_fragment>",
        "#include <color_fragment>\n        diffuseColor.rgb *= vTint;",
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
