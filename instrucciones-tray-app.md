# Instrucciones: app de bandeja del sistema (system tray)

Leé este archivo completo antes de tocar nada.
Solo se crean archivos nuevos. No se modifica nada del bot existente
(src/, index.js, .env, messages.js, etc.).

---

## CONTEXTO

Se implementa una pequeña app Electron que vive en la bandeja del sistema de Windows
(área de notificaciones, junto al reloj). El usuario la opera con clic derecho:

```
🟢 Bot activo

  Detener bot

──────────────
☑ Iniciar con Windows

──────────────
  Salir
```

- El ícono es verde cuando el bot está corriendo, gris cuando está detenido.
- El bot arranca automáticamente al abrir la app de bandeja.
- "Iniciar con Windows" activa/desactiva el arranque automático con el sistema.
- "Salir" detiene el bot y cierra la app de bandeja.
- No aparece ninguna ventana ni ninguna entrada en la barra de tareas.

El bot se lanza con `node index.js` desde la raíz del proyecto.

---

## ARCHIVOS A CREAR

```
tray/
  assets/           ← íconos PNG (generados por el script)
  tray.js           ← lógica del ícono en la bandeja
scripts/
  generate-icons.js ← genera los íconos una sola vez
tray-app.js         ← punto de entrada de Electron (en la raíz)
```

No se toca ningún otro archivo. Solo se agrega Electron a package.json.

---

## PASO 1 — Instalar Electron

```bash
npm install --save-dev electron
```

---

## PASO 2 — Crear `scripts/generate-icons.js`

Este script genera los dos íconos PNG sin ninguna dependencia extra.
Usa iluminación tipo Phong para producir esferas 3D con reflejo y sombra.
Se ejecuta una sola vez durante el setup.

```js
'use strict';
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── PNG mínimo en Node.js puro ────────────────────────────────────────────────

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function makeChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const l = Buffer.alloc(4); l.writeUInt32BE(data.length, 0);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([l, t, data, c]);
}

/**
 * Genera un PNG de tamaño `size`x`size` con una esfera 3D usando iluminación Phong.
 * - Fondo transparente (RGBA).
 * - Luz desde arriba a la izquierda.
 * - Reflejo especular brillante en el punto de mayor iluminación.
 * - Borde suavizado con anti-aliasing de 1px.
 */
function spherePNG(size, baseR, baseG, baseB) {
  const cx     = (size - 1) / 2;
  const cy     = (size - 1) / 2;
  const radius = size / 2 - 1;

  // Dirección de la luz (viene desde arriba-izquierda, levemente hacia adelante)
  const lx = -0.5, ly = -0.7, lz = 0.5;
  const lLen = Math.sqrt(lx*lx + ly*ly + lz*lz);
  const Lx = lx/lLen, Ly = ly/lLen, Lz = lz/lLen;

  // Color base en escala 0-1
  const br = baseR / 255, bg = baseG / 255, bb = baseB / 255;

  // Buffer: 1 byte filtro + size*4 bytes RGBA por fila, todo a 0 (transparente por defecto)
  const raw = Buffer.alloc(size * (1 + size * 4), 0);

  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0; // filtro None

    for (let x = 0; x < size; x++) {
      const offset = y * (1 + size * 4) + 1 + x * 4;

      const dx   = x - cx;
      const dy   = y - cy;
      const dist = Math.sqrt(dx*dx + dy*dy);

      // Fuera del círculo: dejar transparente
      if (dist > radius + 0.5) continue;

      // Alpha suave en el borde (1px de anti-aliasing)
      const alpha = dist > radius - 0.5
        ? Math.round((radius + 0.5 - dist) * 255)
        : 255;

      // Normal de la superficie de la esfera en este punto
      const nx   = dx / radius;
      const ny   = dy / radius;
      const nzSq = 1 - nx*nx - ny*ny;
      const nz   = nzSq > 0 ? Math.sqrt(nzSq) : 0;

      // Componente difusa (Lambertiana)
      const NdotL  = nx*Lx + ny*Ly + nz*Lz;
      const diffuse = Math.max(0, NdotL);

      // Componente especular (Phong): reflejo brillante
      const Rx = 2*NdotL*nx - Lx;
      const Ry = 2*NdotL*ny - Ly;
      const Rz = 2*NdotL*nz - Lz;
      const specular = Math.pow(Math.max(0, Rz), 22); // shininess = 22

      // Luz ambiente constante para evitar zonas completamente negras
      const ambient = 0.22;

      let r = (ambient + 0.78 * diffuse) * br + specular * 0.88;
      let g = (ambient + 0.78 * diffuse) * bg + specular * 0.88;
      let b = (ambient + 0.78 * diffuse) * bb + specular * 0.88;

      raw[offset]   = Math.min(255, Math.round(r * 255));
      raw[offset+1] = Math.min(255, Math.round(g * 255));
      raw[offset+2] = Math.min(255, Math.round(b * 255));
      raw[offset+3] = alpha;
    }
  }

  // Armar el PNG con color type 6 (RGBA)
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8; // bit depth: 8
  ihdrData[9] = 6; // color type: RGBA
  const ihdr = makeChunk('IHDR', ihdrData);

  const idat = makeChunk('IDAT', zlib.deflateSync(raw));
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

// ── Generar íconos ────────────────────────────────────────────────────────────

const outDir = path.join(__dirname, '..', 'tray', 'assets');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// Esfera verde: bot activo
fs.writeFileSync(
  path.join(outDir, 'icon-on.png'),
  spherePNG(32, 76, 175, 80),    // verde #4CAF50
);

// Esfera gris: bot detenido
fs.writeFileSync(
  path.join(outDir, 'icon-off.png'),
  spherePNG(32, 120, 120, 120),  // gris  #787878
);

console.log('✅ Íconos generados en tray/assets/');
```

Ejecutar una sola vez:

```bash
node scripts/generate-icons.js
```

Resultado esperado:
```
✅ Íconos generados en tray/assets/
```

---

## PASO 3 — Crear `tray/tray.js`

```js
'use strict';
const { app, Tray, Menu } = require('electron');
const path                = require('path');
const { spawn }           = require('child_process');

const ROOT      = path.join(__dirname, '..');
const ICON_ON   = path.join(__dirname, 'assets', 'icon-on.png');
const ICON_OFF  = path.join(__dirname, 'assets', 'icon-off.png');

let tray       = null;
let botProcess = null;
let isRunning  = false;

// ── Menú contextual ───────────────────────────────────────────────────────────

function buildMenu() {
  const autoLaunch = app.getLoginItemSettings().openAtLogin;

  return Menu.buildFromTemplate([
    {
      label:   isRunning ? '🟢  Bot activo' : '⚫  Bot detenido',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: isRunning ? 'Detener bot' : 'Iniciar bot',
      click: isRunning ? stopBot : startBot,
    },
    { type: 'separator' },
    {
      label:   'Iniciar con Windows',
      type:    'checkbox',
      checked: autoLaunch,
      click:   toggleAutoLaunch,
    },
    { type: 'separator' },
    {
      label: 'Salir',
      click: () => {
        if (isRunning) stopBot();
        app.quit();
      },
    },
  ]);
}

function refreshTray() {
  if (!tray) return;
  tray.setImage(isRunning ? ICON_ON : ICON_OFF);
  tray.setToolTip(isRunning ? 'Bot Nefertiti — activo' : 'Bot Nefertiti — detenido');
  tray.setContextMenu(buildMenu());
}

// ── Control del proceso del bot ───────────────────────────────────────────────

function startBot() {
  if (isRunning) return;

  botProcess = spawn('node', ['index.js'], {
    cwd:      ROOT,
    detached: false,
    stdio:    'ignore',
    env:      { ...process.env, NODE_ENV: process.env.NODE_ENV || 'production' },
  });

  botProcess.on('exit', () => {
    // El bot se cerró solo (crash o cierre normal)
    isRunning  = false;
    botProcess = null;
    refreshTray();
  });

  botProcess.on('error', (err) => {
    console.error('Error al iniciar el bot:', err.message);
    isRunning  = false;
    botProcess = null;
    refreshTray();
  });

  isRunning = true;
  refreshTray();
}

function stopBot() {
  if (!botProcess) {
    isRunning = false;
    refreshTray();
    return;
  }
  try {
    botProcess.kill();
  } catch (_) {}
  botProcess = null;
  isRunning  = false;
  refreshTray();
}

// ── Arranque automático con Windows ──────────────────────────────────────────

function toggleAutoLaunch() {
  const current = app.getLoginItemSettings().openAtLogin;
  app.setLoginItemSettings({ openAtLogin: !current });
  refreshTray();
}

// ── Inicialización ────────────────────────────────────────────────────────────

function initTray() {
  tray = new Tray(ICON_OFF);
  tray.setToolTip('Bot Nefertiti — iniciando...');
  tray.setContextMenu(buildMenu());

  // Iniciar el bot automáticamente al abrir la app de bandeja
  startBot();
}

module.exports = { initTray };
```

---

## PASO 4 — Crear `tray-app.js` (en la raíz del proyecto)

```js
'use strict';
const { app } = require('electron');
const { initTray } = require('./tray/tray');

// Evitar múltiples instancias de la app de bandeja
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Identificador para Windows (notificaciones y barra de tareas)
app.setAppUserModelId('com.nefertiti.bot');

app.whenReady().then(() => {
  // Sin ventanas: no aparece nada en la barra de tareas
  app.on('window-all-closed', () => { /* no cerrar la app */ });
  initTray();
});
```

---

## PASO 5 — Actualizar `package.json`

Agregar el script `tray` dentro de la sección `"scripts"`:

```json
"tray": "electron tray-app.js"
```

Resultado esperado en scripts:

```json
"scripts": {
  "start": "node index.js",
  "tray":  "electron tray-app.js",
  ...
}
```

---

## VERIFICACIÓN

1. Asegurate de haber ejecutado `node scripts/generate-icons.js` al menos una vez.

2. Iniciar la app de bandeja:
   ```bash
   npm run tray
   ```

3. Verificar:
   - No aparece ninguna ventana ni entrada en la barra de tareas.
   - Aparece un ícono gris en la bandeja del sistema (junto al reloj).
   - Al cabo de unos segundos (mientras el bot conecta a WhatsApp) el ícono permanece gris
     hasta que el proceso corre correctamente.
   - Clic derecho sobre el ícono → aparece el menú con las opciones.
   - "Detener bot" → ícono pasa a gris, opción cambia a "Iniciar bot".
   - "Iniciar bot" → ícono vuelve a verde, opción cambia a "Detener bot".
   - "Iniciar con Windows" → al hacer clic, la tilde se activa o desactiva.
   - "Salir" → el ícono desaparece y el bot se detiene.

4. Verificar arranque automático:
   - Activar "Iniciar con Windows".
   - Cerrar sesión y volver a iniciar sesión en Windows (o reiniciar).
   - El ícono de la bandeja debe aparecer solo y el bot debe iniciarse automáticamente.

---

## NOTAS

- Si el bot se cae por un error, el ícono pasa a gris automáticamente.
  El usuario puede volver a iniciarlo desde el menú.
- El log del bot sigue escribiéndose en `logs/app.log` igual que antes.
- Para distribuirle el programa al usuario final sin que use la terminal,
  se puede crear un acceso directo (.lnk) en el escritorio que ejecute
  `npm run tray` o, mejor aún, empaquetar con `electron-builder` para
  generar un instalador .exe (ese sería el próximo paso si se necesita).
