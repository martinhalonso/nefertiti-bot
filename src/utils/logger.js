'use strict';

const { createLogger, format, transports } = require('winston');
const path = require('path');
const fs   = require('fs');

const LOG_DIR = process.env.USER_DATA_PATH
  ? path.join(process.env.USER_DATA_PATH, 'logs')
  : path.join(__dirname, '../../logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// Anonimiza números de teléfono — muestra solo los últimos 4 dígitos
function anonPhone(phone) {
  const s = String(phone || '');
  return s.length < 4 ? '****' : `****${s.slice(-4)}`;
}

const isProd = process.env.NODE_ENV === 'production';

const fileFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.errors({ stack: true }),
  format.printf(({ timestamp, level, message, stack }) =>
    stack
      ? `${timestamp} [${level.toUpperCase()}] ${message}\n${stack}`
      : `${timestamp} [${level.toUpperCase()}] ${message}`,
  ),
);

const logger = createLogger({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  format: fileFormat,
  transports: [
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ level, message }) => `${level}: ${message}`),
      ),
    }),
    new transports.File({
      filename: path.join(LOG_DIR, 'app.log'),
      maxsize:  5 * 1024 * 1024, // 5 MB por archivo
      maxFiles: 3,
      tailable: true,
    }),
  ],
});

module.exports = { logger, anonPhone };
