# Instrucciones: Instalador Electron con electron-builder

Leé este archivo completo antes de tocar nada.
Son 6 archivos a modificar y 2 archivos nuevos a crear.

---

## CONTEXTO

Se quiere empaquetar el bot como instalador `.exe` para Windows usando `electron-builder`.
El instalador incluye Electron, Node.js y todas las dependencias.
El usuario final solo ejecuta el instalador, sin necesidad de Node.js, npm ni Chrome.

El bot usa el Chrome del sistema (no el Chromium de Puppeteer) para reducir el tamaño.

### Comportamiento en la notebook nueva

1. El usuario instala el `.exe`
2. Al abrir la app por primera vez, aparece una ventana de configuración
3. Completa: número del admin, datos de seña, etc.
4. Guarda → el bot arranca automáticamente
5. Las próximas veces, abre directo sin configuración

### Separación de datos

En desarrollo (esta PC):
- DB: `data/bot.db`
- Uploads: `uploads/`
- Auth WhatsApp: `.wwebjs_auth/`
- Config: `.env`

En la app instalada (notebook):
- Todo va en `%APPDATA%\Bot Nefertiti\` (userData de Electron)
- DB: `%APPDATA%\Bot Nefertiti\bot.db`
- Uploads: `%APPDATA%\Bot Nefertiti\uploads\`
- Auth WhatsApp: `%APPDATA%\Bot Nefertiti\.wwebjs_auth\`
- Config: `%APPDATA%\Bot Nefertiti\.env`

El código detecta si está empaquetado (`process.env.USER_DATA_PATH`) y usa la ruta correcta.

---

## RESUMEN DE CAMBIOS

| Archivo | Tipo | Cambio |
|---|---|---|
| `package.json` | modificar | agregar electron-builder config + scripts |
| `tray-app.js` | modificar | verificar primera ejecución, pasar userData al bot |
| `tray/tray.js` | modificar | usar `utilityProcess.fork()` en lugar de `spawn('node')` |
| `src/db/initDB.js` | modificar | usar `USER_DATA_PATH` para ruta de DB |
| `src/handlers/whatsappHandler.js` | modificar | usar `USER_DATA_PATH` para uploads |
| `index.js` | modificar | .env desde userData, Chrome auto-detect, LocalAuth path |
| `tray/setup.html` | **crear** | formulario de configuración inicial |
| `tray/setup-window.js` | **crear** | lógica de la ventana de configuración |

---

## CAMBIO 1 — package.json

Reemplazar el contenido completo por:

```json
{
  "name": "bot-turnos-whatsapp",
  "version": "1.0.0",
  "description": "Bot de WhatsApp para agendamiento de turnos",
  "main": "tray-app.js",
  "scripts": {
    "start": "node index.js",
    "dev": "node --watch index.js",
    "db:init": "node src/db/seed.js",
    "tray": "electron tray-app.js",
    "build": "electron-builder build --win --x64",
    "postinstall": "electron-builder install-app-deps"
  },
  "build": {
    "appId": "com.nefertiti.bot",
    "productName": "Bot Nefertiti",
    "win": {
      "target": "nsis",
      "icon": "tray/assets/icon-on.png"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true,
      "shortcutName": "Bot Nefertiti"
    },
    "files": [
      "**/*",
      "!data/**",
      "!logs/**",
      "!uploads/**",
      "!.wwebjs_auth/**",
      "!.env",
      "!instrucciones-*.md",
      "!dist/**",
      "!node_modules/.cache/**"
    ],
    "asarUnpack": [
      "node_modules/better-sqlite3/**",
      "node_modules/node-gyp-build/**"
    ],
    "directories": {
      "output": "dist"
    }
  },
  "dependencies": {
    "better-sqlite3": "^12.9.0",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "googleapis": "^140.0.0",
    "node-cron": "^3.0.3",
    "qrcode-terminal": "^0.12.0",
    "whatsapp-web.js": "^1.23.0",
    "winston": "^3.19.0"
  },
  "devDependencies": {
    "electron": "^42.0.0",
    "electron-builder": "^25.1.8"
  }
}
```

---

## CAMBIO 2 — tray-app.js

Reemplazar el contenido completo por:

```js
'use strict';
const { app, ipcMain } = require('electron');
const path             = require('path');
const fs               = require('fs');
const { initTray }     = require('./tray/tray');
const { openSetup }    = require('./tray/setup-window');

// Evitar múltiples instancias de la app de bandeja
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Identificador para Windows
app.setAppUserModelId('com.nefertiti.bot');

app.whenReady().then(async () => {
  app.on('window-all-closed', () => { /* no cerrar la app */ });

  const userData = app.getPath('userData');
  const envPath  = path.join(userData, '.env');

  // Primera ejecución: mostrar ventana de configuración
  if (!fs.existsSync(envPath)) {
    await openSetup(userData);
  }

  initTray(userData);
});
```

---

## CAMBIO 3 — tray/tray.js

Reemplazar el contenido completo por:

```js
'use strict';
const { app, Tray, Menu, utilityProcess } = require('electron');
const path = require('path');

const ICON_ON  = path.join(__dirname, 'assets', 'icon-on.png');
const ICON_OFF = path.join(__dirname, 'assets', 'icon-off.png');

let tray       = null;
let botProcess = null;
let isRunning  = false;
let _userData  = null;

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

  const botScript = path.join(app.getAppPath(), 'index.js');
  const env = {
    ...process.env,
    NODE_ENV:       process.env.NODE_ENV || 'production',
    USER_DATA_PATH: _userData || '',
  };

  if (app.isPackaged) {
    // App empaquetada: usar utilityProcess (Node.js integrado en Electron)
    botProcess = utilityProcess.fork(botScript, [], { env });
  } else {
    // Desarrollo: spawn node normal
    const { spawn } = require('child_process');
    const ROOT = path.join(__dirname, '..');
    botProcess = spawn('node', ['index.js'], {
      cwd:      ROOT,
      detached: false,
      stdio:    'ignore',
      env,
    });
  }

  botProcess.on('exit', () => {
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
  try { botProcess.kill(); } catch (_) {}
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

function initTray(userData) {
  _userData = userData;
  tray = new Tray(ICON_OFF);
  tray.setToolTip('Bot Nefertiti — iniciando...');
  tray.setContextMenu(buildMenu());
  startBot();
}

module.exports = { initTray };
```

---

## CAMBIO 4 — src/db/initDB.js

Reemplazar estas líneas al principio del archivo:

Buscar:
```js
const DB_PATH = path.join(__dirname, '../../data/bot.db');
```

Reemplazar por:
```js
const DB_PATH = process.env.USER_DATA_PATH
  ? require('path').join(process.env.USER_DATA_PATH, 'bot.db')
  : require('path').join(__dirname, '../../data/bot.db');
```

Nota: el `require('path')` ya está importado arriba del archivo como `const path = require('path')`. Usarlo directamente:

```js
const DB_PATH = process.env.USER_DATA_PATH
  ? path.join(process.env.USER_DATA_PATH, 'bot.db')
  : path.join(__dirname, '../../data/bot.db');
```

---

## CAMBIO 5 — src/handlers/whatsappHandler.js

Buscar:
```js
const UPLOADS_DIR = path.join(__dirname, '../../uploads');
```

Reemplazar por:
```js
const UPLOADS_DIR = process.env.USER_DATA_PATH
  ? path.join(process.env.USER_DATA_PATH, 'uploads')
  : path.join(__dirname, '../../uploads');
```

---

## CAMBIO 6 — index.js

Reemplazar el contenido completo por:

```js
// Cargar .env desde userData si está disponible (app empaquetada),
// o desde la raíz del proyecto (desarrollo)
const path = require('path');
const fs   = require('fs');

const envPath = process.env.USER_DATA_PATH
  ? path.join(process.env.USER_DATA_PATH, '.env')
  : undefined;

require('dotenv').config(envPath ? { path: envPath } : {});

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode  = require('qrcode-terminal');
const express = require('express');

const whatsappHandler                            = require('./src/handlers/whatsappHandler');
const { startTimeoutCleaner, startDailySummary } = require('./src/handlers/clientHandler');
const { registerAuthRoutes, checkCalendarConfig } = require('./src/handlers/calendarHandler');
const { logger }                                 = require('./src/utils/logger');
const { getDb }                                  = require('./src/db/initDB');
const { getSetting }                             = require('./src/db/queries');

// ── Express (health check) ────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

let connectionState = 'disconnected';

app.get('/health', (_req, res) => {
  let dbOk = false;
  let db;
  try {
    db = getDb();
    db.prepare('SELECT 1').get();
    dbOk = true;
  } catch (_) {
  } finally {
    try { db?.close(); } catch (_) {}
  }

  const hasGoogleToken = !!(getSetting('google_refresh_token'));

  res.json({
    status:        dbOk && connectionState === 'connected' ? 'ok' : 'degraded',
    whatsapp:      connectionState,
    db:            dbOk ? 'ok' : 'error',
    googleCalendar: hasGoogleToken ? 'authorized' : 'not_authorized',
  });
});

registerAuthRoutes(app);

app.listen(PORT, () => {
  logger.info(`Servidor Express escuchando en puerto ${PORT}`);
});

// ── Detección automática de Chrome ────────────────────────────────────────────
function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : null,
    // Microsoft Edge como fallback
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);

  return candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
}

const chromePath = findChrome();
if (!chromePath) {
  logger.error('❌ No se encontró Chrome ni Edge instalado. El bot no puede iniciar.');
  process.exit(1);
}
logger.info(`Chrome detectado: ${chromePath}`);

// ── Ruta de autenticación WhatsApp ────────────────────────────────────────────
const authDataPath = process.env.USER_DATA_PATH || path.join(__dirname, '.');

// ── Cliente WhatsApp ──────────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: authDataPath }),
  puppeteer: {
    executablePath: chromePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

client.on('qr', (qr) => {
  logger.info('Escaneá el QR con WhatsApp → Dispositivos vinculados');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  connectionState = 'connected';
  const info = client.info;
  logger.info(`WhatsApp conectado como: ${info.pushname} (${info.wid.user})`);
  checkCalendarConfig();
  startTimeoutCleaner();
  startDailySummary();
});

client.on('authenticated', () => {
  logger.info('Sesión autenticada. Credenciales guardadas localmente.');
});

whatsappHandler.setup(client);

client.on('auth_failure', (msg) => {
  connectionState = 'disconnected';
  logger.error(`Error de autenticación: ${msg}. Reiniciá el proceso y volvé a escanear el QR.`);
});

client.on('disconnected', async (reason) => {
  connectionState = 'disconnected';
  logger.warn(`WhatsApp desconectado: ${reason}. Reintentando en 5 segundos...`);
  try { await client.destroy(); } catch (_) {}
  setTimeout(() => client.initialize(), 5000);
});

logger.info('Iniciando cliente WhatsApp...');
client.initialize();
```

---

## ARCHIVO NUEVO — tray/setup.html

Crear el archivo `tray/setup.html` con el siguiente contenido:

```html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Configuración — Bot Nefertiti</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f5f5f5;
      padding: 24px;
      color: #333;
    }
    h1 { font-size: 20px; margin-bottom: 6px; color: #1a1a1a; }
    .subtitle { font-size: 13px; color: #666; margin-bottom: 24px; }
    .group { margin-bottom: 16px; }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; }
    .hint { font-size: 11px; color: #888; margin-bottom: 4px; }
    input {
      width: 100%;
      padding: 8px 10px;
      border: 1px solid #ccc;
      border-radius: 6px;
      font-size: 14px;
      outline: none;
      transition: border 0.2s;
    }
    input:focus { border-color: #4CAF50; }
    .section-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      color: #999;
      letter-spacing: 0.5px;
      margin: 20px 0 12px;
    }
    button {
      width: 100%;
      padding: 11px;
      background: #4CAF50;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 8px;
    }
    button:hover { background: #43A047; }
    .error { color: #e53935; font-size: 12px; margin-top: 6px; display: none; }
  </style>
</head>
<body>
  <h1>⚙️ Configuración inicial</h1>
  <p class="subtitle">Completá estos datos para que el bot funcione correctamente.</p>

  <div class="section-title">WhatsApp</div>

  <div class="group">
    <label>Número del administrador</label>
    <div class="hint">Con código de país, sin + ni espacios. Ej: 5493416779186</div>
    <input type="text" id="admin_phone" placeholder="5493416779186">
  </div>

  <div class="section-title">Seña</div>

  <div class="group">
    <label>Monto de la seña ($)</label>
    <input type="number" id="sena_monto" placeholder="10000">
  </div>

  <div class="group">
    <label>CBU <span style="font-weight:400;color:#999">(opcional)</span></label>
    <input type="text" id="sena_cbu" placeholder="0000003100065268810015">
  </div>

  <div class="group">
    <label>Alias <span style="font-weight:400;color:#999">(opcional)</span></label>
    <input type="text" id="sena_alias" placeholder="nombre.apellido.xx">
  </div>

  <div class="error" id="error-msg">Por favor completá el número del administrador.</div>

  <button onclick="guardar()">Guardar y continuar</button>

  <script>
    const { ipcRenderer } = require('electron');

    function guardar() {
      const adminPhone = document.getElementById('admin_phone').value.trim();
      const senaMonto  = document.getElementById('sena_monto').value.trim() || '10000';
      const senaCbu    = document.getElementById('sena_cbu').value.trim();
      const senaAlias  = document.getElementById('sena_alias').value.trim();

      if (!adminPhone) {
        const err = document.getElementById('error-msg');
        err.style.display = 'block';
        return;
      }

      ipcRenderer.send('setup-save', {
        ADMIN_PHONE:  adminPhone,
        SENA_MONTO:   senaMonto,
        SENA_CBU:     senaCbu,
        SENA_ALIAS:   senaAlias,
        PORT:         '3000',
        NODE_ENV:     'production',
        TZ:           'America/Argentina/Buenos_Aires',
      });
    }
  </script>
</body>
</html>
```

---

## ARCHIVO NUEVO — tray/setup-window.js

Crear el archivo `tray/setup-window.js` con el siguiente contenido:

```js
'use strict';
const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs   = require('fs');

function openSetup(userData) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width:           480,
      height:          620,
      resizable:       false,
      title:           'Configuración — Bot Nefertiti',
      webPreferences: {
        nodeIntegration:  true,
        contextIsolation: false,
      },
    });

    win.loadFile(path.join(__dirname, 'setup.html'));
    win.setMenuBarVisibility(false);

    ipcMain.once('setup-save', (_event, config) => {
      // Construir el contenido del .env
      const lines = [
        `ADMIN_PHONE=${config.ADMIN_PHONE}`,
        `SENA_MONTO=${config.SENA_MONTO}`,
        `SENA_CBU=${config.SENA_CBU || ''}`,
        `SENA_ALIAS=${config.SENA_ALIAS || ''}`,
        `PORT=${config.PORT || 3000}`,
        `NODE_ENV=${config.NODE_ENV || 'production'}`,
        `TZ=${config.TZ || 'America/Argentina/Buenos_Aires'}`,
        '',
        '# Google Calendar OAuth2 (dejar vacío si no usás Calendar)',
        'GOOGLE_CLIENT_ID=',
        'GOOGLE_CLIENT_SECRET=',
        `GOOGLE_REDIRECT_URI=http://localhost:${config.PORT || 3000}/auth/google/callback`,
        'GOOGLE_CALENDAR_ID=primary',
      ];

      // Asegurarse de que la carpeta userData existe
      fs.mkdirSync(userData, { recursive: true });

      // Escribir el .env en userData
      fs.writeFileSync(path.join(userData, '.env'), lines.join('\n'), 'utf8');

      win.close();
      resolve();
    });

    win.on('closed', () => {
      // Si el usuario cierra sin guardar, resolver igual para no bloquear
      resolve();
    });
  });
}

module.exports = { openSetup };
```

---

## VERIFICACIÓN

### Verificar que el modo desarrollo sigue funcionando

Correr `npm run tray` — debe funcionar exactamente igual que antes.
No debe haber ningún cambio de comportamiento en desarrollo.

### Verificar que el build se puede generar

1. Instalar electron-builder: ya queda en devDependencies con `npm install`
2. Correr `npm run build`
3. Debe aparecer la carpeta `dist/` con el instalador `.exe` adentro
4. El build puede tardar 5–10 minutos la primera vez

### Si el build falla por better-sqlite3

Correr manualmente:
```
npx electron-rebuild -f -w better-sqlite3
```
Luego volver a correr `npm run build`.

---

## NOTAS IMPORTANTES

- El `.env` de la PC de desarrollo **no se toca ni modifica**. Sigue funcionando igual.
- La carpeta `dist/` que genera el build **no debe commitearse** (agregarla al `.gitignore` si usás git).
- La primera vez que se ejecuta en la notebook aparece el formulario de configuración. Las veces siguientes arranca directo.
- Si el usuario quiere cambiar la configuración después, puede editar manualmente el archivo en `%APPDATA%\Bot Nefertiti\.env`.
- La sesión de WhatsApp (QR) **no se transfiere** — hay que escanear el QR de nuevo en la notebook con el número del bot.
