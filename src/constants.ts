/* Dimensiones de la malla del campo y geometría del plano en mundo.
   Centralizadas para que solver, superficie, partículas e iso compartan
   exactamente la misma convención de índices y escalas. */
export const NX = 200;
export const NY = 120;
export const N = NX * NY;

export const PLANE_W = 13;
export const PLANE_H = 7.8;
export const HEIGHT_SCALE = 1.05; // φ → altura en Y

export const OMEGA = 1.88; // sobre-relajación (SOR)
