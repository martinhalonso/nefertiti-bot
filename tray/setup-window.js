'use strict';
const { BrowserWindow, ipcMain } = require('electron');
const path   = require('path');
const fs     = require('fs');
const qrcode = require('qrcode');

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

    function onSetupSave(_event, config) {
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

      // NO cerrar la ventana — transicionar al paso 3 para mostrar el QR
      if (!win.isDestroyed()) {
        win.webContents.send('show-qr-step');
      }

      // Resolver con la ventana para que tray.js arranque el bot
      resolve(win);
    }

    ipcMain.once('setup-save', onSetupSave);

    win.on('closed', () => {
      // Limpiar listener huérfano si la ventana se cerró sin guardar
      ipcMain.removeListener('setup-save', onSetupSave);
      _setupWin = null;
      resolve(null);
    });
  });
}

// Recibe el string QR crudo y lo convierte a dataUrl antes de enviarlo al renderer
function sendQrToSetup(qrString) {
  if (!_setupWin || _setupWin.isDestroyed()) return;
  qrcode.toDataURL(qrString, { width: 240, margin: 1 }, (err, dataUrl) => {
    if (err) return;
    if (_setupWin && !_setupWin.isDestroyed()) {
      _setupWin.webContents.send('qr-update', dataUrl);
    }
  });
}

// ── Configuración (re-edición) ────────────────────────────────────────────────

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

    win.webContents.once('did-finish-load', () => {
      win.webContents.send('prefill', existing);
    });

    function onConfigSave(_event, config) {
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

      stopBotFn();
      setTimeout(() => startBotFn(), 1000);

      if (!win.isDestroyed()) {
        win.webContents.send('show-qr-step');
        resolve(win);
      }
    }

    ipcMain.once('setup-save', onConfigSave);

    win.on('closed', () => {
      // Limpiar listener huérfano si la ventana se cerró sin guardar
      ipcMain.removeListener('setup-save', onConfigSave);
      _setupWin = null;
      resolve(null);
    });
  });
}

// Notifica que el bot reconectó sin necesitar QR y cierra la ventana tras 2.5 s
function notifySetupReady() {
  if (!_setupWin || _setupWin.isDestroyed()) return;
  _setupWin.webContents.send('bot-ready');
  setTimeout(() => {
    if (_setupWin && !_setupWin.isDestroyed()) {
      _setupWin.close();
      _setupWin = null;
    }
  }, 2500);
}

// Muestra el mensaje de vinculación exitosa y cierra la ventana tras 2.5 s
function notifySetupAuthenticated() {
  if (!_setupWin || _setupWin.isDestroyed()) return;
  _setupWin.webContents.send('qr-authenticated');
  setTimeout(() => {
    if (_setupWin && !_setupWin.isDestroyed()) {
      _setupWin.close();
      _setupWin = null;
    }
  }, 2500);
}

function isSetupOpen() {
  return !!(_setupWin && !_setupWin.isDestroyed());
}

module.exports = { openSetup, openConfig, sendQrToSetup, notifySetupAuthenticated, notifySetupReady, isSetupOpen };
