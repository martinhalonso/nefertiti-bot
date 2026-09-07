# Opción "Configuración" en el menú de bandeja

## Objetivo

Agregar una opción **"Configuración"** en el menú contextual de la bandeja del sistema.
Al hacer click, abre el wizard de setup con los valores actuales del `.env` ya precargados.
El usuario edita lo que necesita, guarda, y el bot se reinicia automáticamente.

---

## Comportamiento esperado

1. Usuario hace click derecho en el ícono de bandeja → aparece "Configuración"
2. Se abre el wizard (mismo `setup.html`) con los campos precargados desde el `.env` actual
3. Usuario modifica lo que necesita (puede cambiar cualquier campo, incluyendo Calendar)
4. Hace click en "Guardar y continuar" → el `.env` se sobreescribe con los nuevos valores
5. El bot se detiene y se reinicia automáticamente
6. El wizard muestra el paso 3:
   - Si el bot reconecta sin necesitar QR → muestra "✅ Bot reconectado" y se cierra
   - Si el bot necesita QR (sesión perdida) → muestra el QR para escanear
7. La ventana se cierra sola al terminar

---

## Archivos a modificar

- `index.js` — emitir evento `ready` via `process.parentPort`
- `tray/setup-window.js` — agregar `openConfig()` y manejar evento `ready`
- `tray/tray.js` — agregar opción en el menú y manejar evento `ready` del bot
- `tray/setup.html` — precarga de valores existentes via IPC

---

## Parte 1 — `index.js`

Agregar emisión del evento `ready` cuando WhatsApp se conecta, para que el wizard
pueda cerrarse automáticamente si no se necesita QR:

```js
client.on('ready', () => {
  connectionState = 'connected';
  // ... código existente ...

  // Notificar al proceso principal que el bot está listo
  if (process.parentPort) {
    process.parentPort.postMessage({ type: 'ready' });
  }
});
```

---

## Parte 2 — `tray/setup-window.js`

### Agregar función `openConfig(userData, stopBotFn, startBotFn)`

Esta función es similar a `openSetup` pero:
1. Lee el `.env` actual y extrae los valores para precargarlos
2. Después de guardar, llama a `stopBotFn()` y `startBotFn()` para reiniciar el bot
3. Usa el mismo IPC `setup-save` que ya existe

```js
function readEnvValues(userData) {
  const envPath = path.join(userData, '.env');
  if (!fs.existsSync(envPath)) return {};

  const content = fs.readFileSync(envPath, 'utf8');
  const values  = {};
  for (const line of content.split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) values[m[1].trim()] = m[2].trim();
  }
  return values;
}

function openConfig(userData, stopBotFn, startBotFn) {
  return new Promise((resolve) => {
    const existing = readEnvValues(userData);

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

    // Enviar valores actuales al renderer una vez que cargue
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('prefill', existing);
    });

    ipcMain.once('setup-save', (_event, config) => {
      // Sobreescribir el .env con los nuevos valores
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
      fs.writeFileSync(path.join(userData, '.env'), lines.join('\n'), 'utf8');

      // Reiniciar el bot
      stopBotFn();
      setTimeout(() => startBotFn(), 1000);

      // Mostrar paso 3 (espera reconexión o QR)
      win.webContents.send('show-qr-step');
      resolve(win);
    });

    win.on('closed', () => {
      _setupWin = null;
      resolve(null);
    });
  });
}
```

### Agregar manejo del evento `ready` del bot

Cuando el bot se reconecta sin necesitar QR, cerrar la ventana de setup/config
con un mensaje de éxito:

```js
function notifySetupReady() {
  if (_setupWin && !_setupWin.isDestroyed()) {
    _setupWin.webContents.send('bot-ready');
    setTimeout(() => {
      if (_setupWin && !_setupWin.isDestroyed()) {
        _setupWin.close();
        _setupWin = null;
      }
    }, 2500);
  }
}
```

Exportar la nueva función:
```js
module.exports = {
  openSetup,
  openConfig,
  sendQrToSetup,
  notifySetupAuthenticated,
  notifySetupReady,
  isSetupOpen,
};
```

---

## Parte 3 — `tray/setup.html`

### Precargar valores en el paso 3

Agregar listener para el evento `prefill`:

```js
ipcRenderer.on('prefill', (_e, values) => {
  if (values.ADMIN_PHONE)       document.getElementById('admin_phone').value    = values.ADMIN_PHONE;
  if (values.SENA_MONTO)        document.getElementById('sena_monto').value     = values.SENA_MONTO;
  if (values.SENA_CBU)          document.getElementById('sena_cbu').value       = values.SENA_CBU;
  if (values.SENA_ALIAS)        document.getElementById('sena_alias').value     = values.SENA_ALIAS;
  if (values.GOOGLE_CLIENT_ID)  document.getElementById('google_client_id').value    = values.GOOGLE_CLIENT_ID;
  if (values.GOOGLE_CLIENT_SECRET) document.getElementById('google_client_secret').value = values.GOOGLE_CLIENT_SECRET;
});
```

### Manejar el evento `bot-ready` en el paso 3

En el paso 3 (QR), si el bot reconecta sin QR, mostrar mensaje de éxito:

```js
ipcRenderer.on('bot-ready', () => {
  document.getElementById('qr-status').innerHTML =
    '<strong style="color:#22c55e">✅ ¡Bot reconectado! Cerrando…</strong>';
  // Ocultar el contenedor del QR si está visible
  const qrContainer = document.getElementById('qr-container');
  if (qrContainer) qrContainer.style.display = 'none';
});
```

### Cambiar el título del paso 3 según el contexto

El paso 3 puede mostrar "Reiniciando bot..." como estado inicial en lugar de
"Iniciando bot..." cuando se llega desde edición de config. Esto se puede
manejar simplemente con el texto de estado inicial que ya cambia dinámicamente.

---

## Parte 4 — `tray/tray.js`

### Agregar opción "Configuración" en el menú

En `buildMenu()`, agregar la opción antes del separador final:

```js
{ type: 'separator' },
{
  label: '⚙️  Configuración',
  click: openConfigMenu,
},
{ type: 'separator' },
{
  label:   'Iniciar con Windows',
  // ...
```

### Importar `openConfig` y `notifySetupReady`

```js
const {
  showQrWindow, notifyAuthenticated, closeQrWindow
} = require('./qr-window');

const {
  sendQrToSetup, notifySetupAuthenticated, notifySetupReady, isSetupOpen, openConfig
} = require('./setup-window');
```

### Función `openConfigMenu`

```js
function openConfigMenu() {
  openConfig(_userData, stopBot, startBot);
}
```

### Manejar evento `ready` del bot en el handler de mensajes

```js
botProcess.on('message', (msg) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'qr') {
    if (isSetupOpen()) {
      sendQrToSetup(msg.data);
    } else {
      showQrWindow(msg.data);
    }
  } else if (msg.type === 'authenticated') {
    if (isSetupOpen()) {
      notifySetupAuthenticated();
    } else {
      notifyAuthenticated();
    }
  } else if (msg.type === 'ready') {
    if (isSetupOpen()) {
      notifySetupReady();   // cierra el wizard con mensaje de éxito
    }
  }
});
```

---

## Verificación

1. Con el bot corriendo, hacer click derecho en el ícono de bandeja
2. Verificar que aparece la opción "⚙️ Configuración"
3. Hacer click → se abre el wizard con los valores actuales precargados
4. Modificar algún campo (ej: SENA_MONTO) → "Guardar y continuar"
5. El bot se reinicia → el paso 3 muestra "Reiniciando bot..."
6. Si la sesión de WhatsApp sigue válida → muestra "✅ Bot reconectado" y se cierra
7. Verificar que el cambio quedó guardado en el `.env`
8. Probar también el caso donde se agregan credenciales de Calendar por primera vez
