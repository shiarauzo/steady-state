/* =============================================================
   PALETA CÁLIDA (gradiente) — interpolada en OKLab
   -------------------------------------------------------------
   φ ≤ −1 → azul noche · φ = 0 → marrón cálido · φ ≈ .5 → ámbar
   (#f0a95c) · φ ≥ 1 → crema.

   En vez de mezclar los stops en RGB (que pasa por grises sucios),
   los interpolamos en OKLab — espacio perceptual — y horneamos el
   resultado en una LUT 1D que el shader de la superficie muestrea.
   φ ∈ [−1, 1] se mapea a la coordenada [0, 1] de la LUT.
   Refs: Björn Ottosson, "A perceptual color space" (OKLab).
   ============================================================= */
interface Stop {
  t: number;
  c: [number, number, number];
}

const STOPS: Stop[] = [
  { t: -1.0, c: [0.012, 0.035, 0.14] }, // azul noche profundo
  { t: -0.5, c: [0.06, 0.07, 0.17] },
  { t: 0.0, c: [0.17, 0.105, 0.075] }, // marrón menos lechoso
  { t: 0.5, c: [0.96, 0.64, 0.32] }, // ámbar más saturado
  { t: 1.0, c: [1.0, 0.95, 0.84] }, // crema más luminosa
];

type Vec3 = [number, number, number];

function rgbToOklab([r, g, b]: Vec3): Vec3 {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

function oklabToRgb([L, A, B]: Vec3): Vec3 {
  const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = L - 0.0894841775 * A - 1.291485548 * B;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const STOPS_LAB = STOPS.map((s) => ({ t: s.t, lab: rgbToOklab(s.c) }));

/** Hornea la paleta en una LUT RGBA de N×1 (UnsignedByte), mezclando en OKLab. */
export function buildPaletteLUT(n = 256): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const t = -1 + (2 * i) / (n - 1);
    let lab: Vec3;
    if (t <= STOPS_LAB[0].t) lab = STOPS_LAB[0].lab;
    else if (t >= STOPS_LAB[STOPS_LAB.length - 1].t)
      lab = STOPS_LAB[STOPS_LAB.length - 1].lab;
    else {
      let seg = 0;
      while (t > STOPS_LAB[seg + 1].t) seg++;
      const a = STOPS_LAB[seg];
      const b = STOPS_LAB[seg + 1];
      const u = (t - a.t) / (b.t - a.t);
      lab = [
        a.lab[0] + (b.lab[0] - a.lab[0]) * u,
        a.lab[1] + (b.lab[1] - a.lab[1]) * u,
        a.lab[2] + (b.lab[2] - a.lab[2]) * u,
      ];
    }
    const rgb = oklabToRgb(lab);
    for (let k = 0; k < 3; k++) {
      out[i * 4 + k] = Math.max(0, Math.min(255, Math.round(rgb[k] * 255)));
    }
    out[i * 4 + 3] = 255;
  }
  return out;
}
