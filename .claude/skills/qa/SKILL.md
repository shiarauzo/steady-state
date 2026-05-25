---
name: qa
description: QA de la visualización "Laplace — el campo que se asienta". Levanta el dev server de Vite, abre la página en un navegador headless y verifica que carga sin errores de consola, que el contexto WebGL es válido y no se pierde, y que el campo realmente se renderiza (el canvas no está en blanco). Úsalo tras tocar el solver GPU, los shaders, el render o el build, o cuando se pida "qa", "verifica la visualización", "revisa que renderiza" o "comprueba errores de consola/WebGL".
---

# QA — Laplace field

Verifica end-to-end que la visualización corre en un navegador real, no solo
que compila. El proyecto es Vite + TypeScript + Three.js con el solver de
Laplace en GPU (ping-pong), así que los fallos típicos son de runtime WebGL
(float render targets, vertex texture fetch, shaders) que `tsc`/`vite build`
no detectan.

## Procedimiento

1. **Build estático** (atrapa errores de tipos y de empaquetado):
   ```bash
   npm run build
   ```
   Si falla, reporta FAIL con la salida y detente.

2. **Dev server**. Comprueba si ya hay uno en el puerto 5173:
   ```bash
   curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/
   ```
   Si no responde `200`, arráncalo en segundo plano (`npm run dev`) y espera a
   que conteste antes de seguir.

3. **Navegador headless**. El check usa Puppeteer (Chromium headless).
   Asegúralo instalado (no es dependencia del proyecto; instálalo efímero si
   falta), luego ejecuta el script:
   ```bash
   npm ls puppeteer >/dev/null 2>&1 || npm i -D puppeteer
   node .claude/skills/qa/check.mjs
   ```

## Qué valida `check.mjs`

- **Errores de consola y excepciones de página** → cualquiera marca FAIL.
- **Contexto WebGL**: existe `canvas#c`, su tamaño es > 0, el contexto no está
  perdido (`isContextLost()` falso) y reporta el renderer GL.
- **Pérdida de contexto** durante ~2.5 s de animación (`webglcontextlost`).
- **El campo renderiza**: muestrea los píxeles del canvas y exige que haya
  contenido no trivial (no todo negro/transparente) — el relieve ámbar debe
  verse.
- Guarda una captura en `.claude/skills/qa/last-run.png` para inspección.

## Salida

El script termina con código `0` (PASS) o `1` (FAIL) e imprime un resumen
JSON: `consoleErrors`, `pageErrors`, `glRenderer`, `contextLost`,
`canvasSize`, `nonBlankRatio`. Reporta el veredicto con esos datos y, si hay
FAIL, los mensajes concretos.
