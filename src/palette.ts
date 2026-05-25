/* =============================================================
   PALETA CÁLIDA (gradiente)
   -------------------------------------------------------------
   φ ≤ −1 → azul noche
   φ =  0 → marrón cálido tenue
   φ ≈ .5 → ámbar (#f0a95c)
   φ ≥  1 → crema
   Interpolación lineal a tramos entre 5 stops. La misma tabla se
   usa en CPU (sampleColor, para iso/depuración) y en GLSL (la
   función paletteGLSL se inyecta en el shader de la superficie),
   de modo que el color del relieve y el de las líneas coinciden.
   ============================================================= */
export interface Stop {
  t: number;
  c: [number, number, number];
}

export const STOPS: Stop[] = [
  { t: -1.0, c: [0.04, 0.082, 0.188] },
  { t: -0.5, c: [0.125, 0.11, 0.18] },
  { t: 0.0, c: [0.22, 0.14, 0.092] },
  { t: 0.5, c: [0.942, 0.66, 0.36] }, // f0a95c
  { t: 1.0, c: [0.957, 0.892, 0.76] }, // crema
];

export function sampleColor(t: number, out: [number, number, number]): void {
  const first = STOPS[0];
  const last = STOPS[STOPS.length - 1];
  if (t <= first.t) {
    out[0] = first.c[0];
    out[1] = first.c[1];
    out[2] = first.c[2];
    return;
  }
  if (t >= last.t) {
    out[0] = last.c[0];
    out[1] = last.c[1];
    out[2] = last.c[2];
    return;
  }
  for (let s = 0; s < STOPS.length - 1; s++) {
    const a = STOPS[s];
    const b = STOPS[s + 1];
    if (t >= a.t && t <= b.t) {
      const u = (t - a.t) / (b.t - a.t);
      out[0] = a.c[0] + (b.c[0] - a.c[0]) * u;
      out[1] = a.c[1] + (b.c[1] - a.c[1]) * u;
      out[2] = a.c[2] + (b.c[2] - a.c[2]) * u;
      return;
    }
  }
}

/* Versión GLSL de la misma paleta — generada a partir de STOPS para que no
   se desincronicen. Devuelve un cuerpo de función `vec3 palette(float t)`. */
export function paletteGLSL(): string {
  const lines: string[] = [];
  lines.push("vec3 palette(float t){");
  const f = (n: number) => n.toFixed(6);
  const first = STOPS[0];
  const last = STOPS[STOPS.length - 1];
  lines.push(
    `  if(t<=${f(first.t)}) return vec3(${f(first.c[0])},${f(first.c[1])},${f(first.c[2])});`,
  );
  for (let s = 0; s < STOPS.length - 1; s++) {
    const a = STOPS[s];
    const b = STOPS[s + 1];
    lines.push(`  if(t<=${f(b.t)}){`);
    // a.t puede ser negativo: parentizar evita que `t--1.0` se lea como `t-- 1.0`
    lines.push(`    float u=(t-(${f(a.t)}))/${f(b.t - a.t)};`);
    lines.push(
      `    return mix(vec3(${f(a.c[0])},${f(a.c[1])},${f(a.c[2])}),vec3(${f(b.c[0])},${f(b.c[1])},${f(b.c[2])}),u);`,
    );
    lines.push("  }");
  }
  lines.push(
    `  return vec3(${f(last.c[0])},${f(last.c[1])},${f(last.c[2])});`,
  );
  lines.push("}");
  return lines.join("\n");
}
