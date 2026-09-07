# Setup de primera configuración: wizard de 3 pasos

## Objetivo

Reemplazar el formulario de setup de una sola pantalla por un wizard de 3 pasos:

1. **Paso 1** — Configuración básica (ADMIN_PHONE, seña)
2. **Paso 2** — Google Calendar, opcional (CLIENT_ID, CLIENT_SECRET)
3. **Paso 3** — QR de WhatsApp (el bot arranca y muestra el QR en la misma ventana)

La ventana de setup NO se cierra después de guardar el `.env`. En cambio,
transiciona al paso 3, el bot arranca, el QR aparece ahí mismo, y cuando
el usuario lo escanea la ventana se cierra sola.

---

## Archivos a modificar

- `tray/setup.html` — wizard de 3 pasos
- `tray/setup-window.js` — lógica de la ventana y reenvío de mensajes QR
- `tray/tray.js` — recibe la ventana de setup para reenviarle el QR
- `tray-app.js` — pasa la ventana de setup a `initTray`

---

## Parte 1 — `tray/setup.html`

Reescribir completamente. Es un wizard con 3 secciones (`<div id="step-1">`, etc.),
solo una visible a la vez. El CSS debe ser coherente con el estilo actual (fondo #f5f5f5,
verde #4CAF50, fuente Segoe UI).

### Estructura general

```html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Configuración — Bot Nefertiti</title>
  <!-- estilos -->
</head>
<body>
  <!-- Indicador de pasos: "1 · 2 · 3" -->
  <div id="step-indicator">...</div>

  <!-- Paso 1: Configuración básica -->
  <div id="step-1">...</div>

  <!-- Paso 2: Google Calendar -->
  <div id="step-2" style="display:none">...</div>

  <!-- Paso 3: QR de WhatsApp -->
  <div id="step-3" style="display:none">...</div>

  <script>...</script>
</body>
</html>
```

### Paso 1 — Configuración básica

Campos:
- **Número del administrador** (requerido): `ADMIN_PHONE`
- **Monto de la seña ($)**: `SENA_MONTO`, default 10000
- **CBU** (opcional): `SENA_CBU`
- **Alias** (opcional): `SENA_ALIAS`

Botón: `Siguiente →`

Al hacer click valida que ADMIN_PHONE no esté vacío y transiciona al paso 2.

### Paso 2 — Google Calendar

Encabezado: `🗓 Google Calendar` + subtítulo `Opcional — podés omitir este paso`

Campos:
- **Client ID**: `GOOGLE_CLIENT_ID`, placeholder `xxxx.apps.googleusercontent.com`
- **Client Secret**: `GOOGLE_CLIENT_SECRET` (type="password"), placeholder `GOCSPX-...`

Texto informativo debajo de los campos:
```
ℹ️ Una vez configurado el bot, enviá "conectar calendar" por WhatsApp para completar
la autorización con Google.
```

Botones:
- `Omitir` (secundario, borde gris) — guarda sin credenciales de Calendar
- `Guardar y continuar` (primario, verde) — guarda con credenciales

Al hacer click en cualquiera de los dos:
1. Recolectar todos los datos de paso 1 y paso 2
2. Enviar IPC `setup-save` con todos los datos
3. Transicionar al paso 3

### Paso 3 — QR de WhatsApp

Encabezado: `📱 Vincular WhatsApp`
Subtítulo: `Abrí WhatsApp → Dispositivos vinculados → Vincular un dispositivo`

Contenido central:
- Un `<img id="qr-img">` de 240×240px dentro de un contenedor blanco con sombra
- Texto de estado debajo: "⏳ Iniciando bot..." que cambia a "Esperando escaneo…"
  cuando llega el primer QR, y a "✅ ¡Vinculado! Cerrando…" cuando se autentica

Escuchar eventos IPC:
```js
const { ipcRenderer } = require('electron');

ipcRenderer.on('show-qr-step', () => {
  // Transicionar al paso 3 (puede que ya estemos ahí)
  goToStep(3);
});

ipcRenderer.on('qr-update', (_e, dataUrl) => {
  document.getElementById('qr-img').src = dataUrl;
  document.getElementById('qr-status').textContent = 'Esperando escaneo…';
});

ipcRenderer.on('qr-authenticated', () => {
  document.getElementById('qr-status').innerHTML =
    '<strong style="color:#22c55e">✅ ¡Vinculado! Cerrando…</strong>';
});
```

### Indicador de pasos

Mostrar el paso actual: `● ○ ○` / `○ ● ○` / `○ ○ ●`
O simplemente texto: `Paso 1 de 3`, `Paso 2 de 3`, `Paso 3 de 3`

---

## Parte 2 — `tray/setup-window.js`

### Cambios principales

1. **No cerrar la ventana** cuando llega `setup-save`
2. **Escribir el `.env`** con todos los campos incluidos los de Calendar
3. **Enviar `show-qr-step`** al renderer para que transicione al paso 3
4. **Resolver la promise** devolviendo la ventana (no `undefined`)
5. **Exportar función para reenviar QR** a la ventana

```js
'use strict';
const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs   = require('fs');

let _setupWin = null;

function openSetup(userData) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width:          480,
      height:         620,
      resizable:      false,
      title:          'Configuración — Bot Nefertiti',
      webPreferences: {
        nodeIntegration:  true,
        contextIsolation: false,
      },
    });

    _setupWin = win;
    win.loadFile(path.join(__dirname, 'setup.html'));
    win.setMenuBarVisibility(false);

    ipcMain.once('setup-save', (_event, config) => {
      // Construir .env
      const lines = [
        `ADMIN_PHONE=${config.ADMIN_PHONE}`,
        `SENA_MONTO=${config.SENA_MONTO || '10000'}`,
        `SENA_CBU=${config.SENA_CBU || ''}`,
        `SENA_ALIAS=${config.SENA_ALIAS || ''}`,
        `PORT=3000`,
        `NODE_ENV=production`,
        `TZ=America/Argentina/Buenos_Aires`,
        '',
        '# Google Calendar OAuth2 (dejar vacío si no usás Calendar)',
        `GOOGLE_CLIENT_ID=${config.GOOGLE_CLIENT_ID || ''}`,
        `GOOGLE_CLIENT_SECRET=${config.GOOGLE_CLIENT_SECRET || ''}`,
        `GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback`,
        'GOOGLE_CALENDAR_ID=primary',
      ];

      fs.mkdirSync(userData, { recursive: true });
      fs.writeFileSync(path.join(userData, '.env'), lines.join('\n'), 'utf8');

      // NO cerrar la ventana — transicionar al paso 3
      win.webContents.send('show-qr-step');

      // Resolver con la ventana para que tray.js pueda enviarle el QR
      resolve(win);
    });

    win.on('closed', () => {
      _setupWin = null;
      resolve(null);
    });
  });
}

// Llamado desde tray.js cuando llega un QR del bot
function sendQrToSetup(dataUrl) {
  if (_setupWin && !_setupWin.isDestroyed()) {
    _setupWin.webContents.send('qr-update', dataUrl);
  }
}

// Llamado desde tray.js cuando el bot se autentica
function notifySetupAuthenticated() {
  if (_setupWin && !_setupWin.isDestroyed()) {
    _setupWin.webContents.send('qr-authenticated');
    setTimeout(() => {
      if (_setupWin && !_setupWin.isDestroyed()) {
        _setupWin.close();
        _setupWin = null;
      }
    }, 2500);
  }
}

function isSetupOpen() {
  return !!(_setupWin && !_setupWin.isDestroyed());
}

module.exports = { openSetup, sendQrToSetup, notifySetupAuthenticated, isSetupOpen };
```

---

## Parte 3 — `tray-app.js`

Actualmente `openSetup` se awaita y luego se llama `initTray`. Con el nuevo flujo,
`openSetup` resuelve ANTES de que se cierre la ventana (cuando el usuario hace click
en "Guardar y continuar"), así que el bot arranca mientras la ventana sigue abierta.

```js
app.whenReady().then(async () => {
  app.on('window-all-closed', () => {});

  if (app.isPackaged) {
    const userData = app.getPath('userData');
    const envPath  = path.join(userData, '.env');

    if (!fs.existsSync(envPath)) {
      // openSetup resuelve cuando el usuario guardó (paso 3 queda abierto)
      await openSetup(userData);
    }

    initTray(userData);
  } else {
    initTray(null);
  }
});
```

No hay cambio en la lógica, pero ahora cuando `initTray` arranca el bot,
la ventana de setup todavía está visible mostrando el paso 3 (QR).

---

## Parte 4 — `tray/tray.js`

Importar las funciones de `setup-window.js` para reenviar QR y autenticación
a la ventana de setup cuando está abierta (primer arranque), en lugar de abrir
la ventana QR separada.

```js
const { showQrWindow, notifyAuthenticated, closeQrWindow } = require('./qr-window');
const { sendQrToSetup, notifySetupAuthenticated, isSetupOpen } = require('./setup-window');
```

En el handler de mensajes del bot (dentro de `startBot`, bloque `app.isPackaged`):

```js
botProcess.on('message', (msg) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'qr') {
    // Primer arranque: enviar QR a la ventana de setup
    // Reinicios normales: abrir ventana QR separada
    qrcode.toDataURL(msg.data, { width: 240, margin: 1 }, (err, dataUrl) => {
      if (err) return;
      if (isSetupOpen()) {
        sendQrToSetup(dataUrl);
      } else {
        showQrWindow(msg.data);
      }
    });
  } else if (msg.type === 'authenticated') {
    if (isSetupOpen()) {
      notifySetupAuthenticated();
    } else {
      notifyAuthenticated();
    }
  }
});
```

Nota: `qrcode` ya está disponible como dependencia. Importarlo al inicio del archivo:
```js
const qrcode = require('qrcode');
```

Actualmente `qr-window.js` ya usa `qrcode` internamente para generar el dataUrl.
Para no duplicar la conversión, se puede llamar directamente a `showQrWindow(msg.data)`
en el caso normal y en el setup usar `sendQrToSetup` que recibe el dataUrl.

**Alternativa más simple**: en lugar de generar el dataUrl en `tray.js`,
modificar `sendQrToSetup` para que reciba el string QR crudo y genere el dataUrl
internamente (igual que hace `showQrWindow`):

```js
// En setup-window.js
const qrcode = require('qrcode');

function sendQrToSetup(qrString) {
  if (!_setupWin || _setupWin.isDestroyed()) return;
  qrcode.toDataURL(qrString, { width: 240, margin: 1 }, (err, dataUrl) => {
    if (err) return;
    _setupWin.webContents.send('qr-update', dataUrl);
  });
}
```

Y en `tray.js` el handler queda limpio:
```js
botProcess.on('message', (msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'qr') {
    if (isSetupOpen()) {
      sendQrToSetup(msg.data);       // setup abierto: QR en la ventana de setup
    } else {
      showQrWindow(msg.data);        // bot ya configurado: ventana QR separada
    }
  } else if (msg.type === 'authenticated') {
    if (isSetupOpen()) {
      notifySetupAuthenticated();    // cierra el setup
    } else {
      notifyAuthenticated();         // cierra la ventana QR normal
    }
  }
});
```

---

## Parte 5 — Comando admin `conectar calendar` en `adminHandler.js`

Agregar el comando para completar el OAuth de Calendar después del setup:

```js
if (lower === 'conectar calendar' || lower === 'conectar calendario') {
  return cmdConectarCalendar();
}
```

```js
async function cmdConectarCalendar() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    await send().sendMessage(ADMIN_PHONE,
      `❌ *Google Calendar no configurado.*\n\n` +
      `No se encontraron las credenciales. Reinstalá el bot y completá los campos de Google Calendar en el formulario de configuración.`
    );
    return;
  }
  await send().sendMessage(ADMIN_PHONE,
    `🔗 *Conectar Google Calendar*\n\n` +
    `Abrí este link en el navegador de la PC donde corre el bot:\n\n` +
    `http://localhost:3000/auth/google\n\n` +
    `Iniciá sesión con tu cuenta de Google y autorizá el acceso. ` +
    `Una vez hecho, los turnos se sincronizarán automáticamente.`
  );
}
```

Agregar en `HELP_TEXT` dentro de una sección *Configuración*:
```
• conectar calendar
```

---

## Parte 6 — `calendarHandler.js`

Agregar fallback para `GOOGLE_REDIRECT_URI`:

```js
function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback',
  );
}
```

---

## Verificación final

1. Desinstalar bot (si estaba instalado)
2. Instalar nueva versión
3. Aparece la ventana de setup con indicador de pasos
4. Paso 1: completar datos básicos → "Siguiente"
5. Paso 2: completar CLIENT_ID y CLIENT_SECRET → "Guardar y continuar"
   (o "Omitir" si no se quiere Calendar)
6. Paso 3: aparece el QR de WhatsApp en la misma ventana
7. Escanear el QR → ventana muestra "✅ ¡Vinculado! Cerrando…" y se cierra
8. Bot queda activo en la bandeja
9. (Si configuró Calendar) Admin envía "conectar calendar" → recibe el link → autoriza
10. Probar que los turnos se guardan en Calendar

## Reconstruir el instalador

Después de aplicar todos los cambios:
```
npx electron-rebuild -f -w better-sqlite3
npm run build
npm rebuild better-sqlite3
```
