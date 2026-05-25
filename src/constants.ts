/* Dimensiones de la malla del campo y geometría del plano en mundo.
   Centralizadas para que solver, superficie, partículas e iso compartan
   exactamente la misma convención de índices y escalas. */
export const NX = 320; // malla más fina (mismo aspecto 5:3 que el plano)
export const NY = 192;
export const N = NX * NY;

export const PLANE_W = 13;
export const PLANE_H = 7.8;
export const HEIGHT_SCALE = 1.6; // φ → altura en Y; más alto = relieve más escultural

export const OMEGA = 1.88; // sobre-relajación (SOR)
