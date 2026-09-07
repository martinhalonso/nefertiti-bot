'use strict';
const { app, Tray, Menu, utilityProcess } = require('electron');
const path = require('path');
const { showQrWindow, notifyAuthenticated, closeQrWindow } = require('./qr-window');
const { sendQrToSetup, notifySetupAuthenticated, notifySetupReady, isSetupOpen, openConfig } = require('./setup-window');

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
      label: '⚙️  Configuración',
      click: openConfigMenu,
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
    NODE_ENV: process.env.NODE_ENV || 'production',
    ...(_userData ? { USER_DATA_PATH: _userData } : {}),
  };

  if (app.isPackaged) {
    // App empaquetada: usar utilityProcess (Node.js integrado en Electron)
    botProcess = utilityProcess.fork(botScript, [], { env });

    // Escuchar mensajes del bot (QR, autenticación, etc.)
    botProcess.on('message', (msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'qr') {
        if (isSetupOpen()) {
          sendQrToSetup(msg.data);    // primer arranque: QR en ventana de setup
        } else {
          showQrWindow(msg.data);     // bot ya configurado: ventana QR separada
        }
      } else if (msg.type === 'authenticated') {
        if (isSetupOpen()) {
          notifySetupAuthenticated(); // cierra el setup
        } else {
          notifyAuthenticated();      // cierra la ventana QR normal
        }
      } else if (msg.type === 'ready') {
        if (isSetupOpen()) {
          notifySetupReady();         // bot reconectó sin QR → cerrar wizard
        }
      }
    });
  } else {
    // Desarrollo: spawn node normal
    const { spawn } = require('child_process');
    const ROOT = path.join(__dirname, '..');
    botProcess = spawn('node', ['index.js'], {
      cwd:      ROOT,
      detached: false,
      stdio:    'inherit',
      env,
    });
  }

  botProcess.on('exit', () => {
    isRunning  = false;
    botProcess = null;
    closeQrWindow();
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

// ── Menú Configuración ────────────────────────────────────────────────────────

function openConfigMenu() {
  const userData = _userData || require('path').join(__dirname, '..');
  openConfig(userData, stopBot, startBot);
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
