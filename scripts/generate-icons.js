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
      const NdotL   = nx*Lx + ny*Ly + nz*Lz;
      const diffuse = Math.max(0, NdotL);

      // Componente especular (Phong): reflejo brillante
      const Rx = 2*NdotL*nx - Lx;
      const Ry = 2*NdotL*ny - Ly;
      const Rz = 2*NdotL*nz - Lz;
      const specular = Math.pow(Math.max(0, Rz), 22);

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

// Esfera verde 32x32: bot activo (bandeja del sistema)
fs.writeFileSync(
  path.join(outDir, 'icon-on.png'),
  spherePNG(32, 76, 175, 80),    // verde #4CAF50
);

// Esfera gris 32x32: bot detenido (bandeja del sistema)
fs.writeFileSync(
  path.join(outDir, 'icon-off.png'),
  spherePNG(32, 120, 120, 120),  // gris  #787878
);

// Esfera verde 256x256: ícono del instalador Windows
fs.writeFileSync(
  path.join(outDir, 'icon-256.png'),
  spherePNG(256, 76, 175, 80),   // verde #4CAF50
);

console.log('✅ Íconos generados en tray/assets/');
