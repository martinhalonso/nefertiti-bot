'use strict';
const { app } = require('electron');
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

  if (app.isPackaged) {
    // App instalada: usar userData para .env y datos
    const userData = app.getPath('userData');
    const envPath  = path.join(userData, '.env');

    // Primera ejecución: mostrar ventana de configuración
    if (!fs.existsSync(envPath)) {
      await openSetup(userData);
    }

    initTray(userData);
  } else {
    // Desarrollo: usar .env y paths del proyecto normalmente
    initTray(null);
  }
});
