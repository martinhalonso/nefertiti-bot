'use strict';
const { BrowserWindow, app } = require('electron');
const path = require('path');
const qrcode = require('qrcode');

let qrWin = null;

function showQrWindow(qrString) {
  // Generar PNG como data URL
  qrcode.toDataURL(qrString, { width: 240, margin: 1 }, (err, dataUrl) => {
    if (err) { console.error('Error generando QR:', err); return; }

    if (!qrWin || qrWin.isDestroyed()) {
      qrWin = new BrowserWindow({
        width:           320,
        height:          460,
        resizable:       false,
        maximizable:     false,
        title:           'Bot Nefertiti — Vincular WhatsApp',
        icon:            path.join(__dirname, 'assets', 'icon-256.png'),
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
        },
      });
      qrWin.setMenu(null);
      qrWin.loadFile(path.join(__dirname, 'qr.html'));
      qrWin.on('closed', () => { qrWin = null; });

      // Enviar el QR una vez que la ventana cargó
      qrWin.webContents.once('did-finish-load', () => {
        qrWin.webContents.send('qr-update', dataUrl);
      });
    } else {
      // Ventana ya abierta: actualizar QR
      qrWin.webContents.send('qr-update', dataUrl);
    }
  });
}

function notifyAuthenticated() {
  if (qrWin && !qrWin.isDestroyed()) {
    qrWin.webContents.send('qr-authenticated');
    setTimeout(() => {
      if (qrWin && !qrWin.isDestroyed()) qrWin.close();
    }, 2000);
  }
}

function closeQrWindow() {
  if (qrWin && !qrWin.isDestroyed()) {
    qrWin.close();
    qrWin = null;
  }
}

module.exports = { showQrWindow, notifyAuthenticated, closeQrWindow };
