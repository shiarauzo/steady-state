import type { FieldSolver } from "./FieldSolver";
import { NX, NY } from "./constants";

/* =============================================================
   LA ECUACIÓN COMO CAMPO (issue #11)
   -------------------------------------------------------------
   Rasterizamos "∇²φ = 0" en un canvas 2D del tamaño de la malla y
   sembramos esos píxeles como condiciones Dirichlet positivas: el
   relieve nace con la forma de la propia ecuación. `release()`
   libera esas celdas para que el campo relaje y la fórmula se
   disuelva en sí misma — el título hecho literal.

   Orientación: fila 0 del canvas → j=0 (fondo de la escena, parte
   alta del cuadro); columna i → +x (derecha). La ecuación se lee
   recta y sin espejo sobre el relieve.
   ============================================================= */
const INK = 0.9; // φ de la tinta (ámbar→crema)
const ALPHA_MIN = 40; // umbral de tinta

export function seedEquation(solver: FieldSolver): () => void {
  const cv = document.createElement("canvas");
  cv.width = NX;
  cv.height = NY;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const txt = "∇²φ = 0";
  // ajustar el tamaño para llenar ~78% del ancho de la malla
  let size = Math.round(NY * 0.6);
  ctx.font = `600 ${size}px Georgia, "Times New Roman", serif`;
  size = Math.max(8, Math.floor((size * (NX * 0.78)) / ctx.measureText(txt).width));
  ctx.font = `600 ${size}px Georgia, "Times New Roman", serif`;
  ctx.fillText(txt, NX / 2, NY / 2 + 1);

  const data = ctx.getImageData(0, 0, NX, NY).data;
  const seeded: number[] = [];
  for (let j = 1; j < NY - 1; j++) {
    for (let i = 1; i < NX - 1; i++) {
      const k = j * NX + i;
      // no pisar los polos permanentes ya sembrados: tras disolverse la
      // ecuación, el campo se asienta sobre ellos en vez de quedar plano.
      if (solver.fixed[k]) continue;
      const a = data[(j * NX + i) * 4 + 3];
      if (a > ALPHA_MIN) {
        solver.setFixed(k, INK * (a / 255));
        seeded.push(k);
      }
    }
  }

  return () => {
    for (const k of seeded) solver.unfix(k);
  };
}
