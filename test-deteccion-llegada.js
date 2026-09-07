'use strict';
// Test para la detección de llegada al local
// Corre con: node test-deteccion-llegada.js

let passed = 0;
let failed = 0;

function assert(description, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description}`);
    console.error(`    Esperado: ${expected}  |  Recibido: ${actual}`);
    failed++;
  }
}

// ── Extraer las funciones a testear ──────────────────────────────────────────
// Se copia la lógica exacta del handler para testearla de forma aislada.

const ARRIVAL_PHRASES = [
  'estoy abajo', 'abajo', 'llegando', 'estoy llegando',
  'ya llegué',   'ya llegue', 'llegué', 'llegue',
  'ya estoy',    'estoy acá', 'estoy aca',
  'ya llegó',    'ya llego',
  'en la puerta', 'afuera', 'estoy afuera',
  'ya estoy acá', 'ya estoy aca',
  'toc toc', 'estoy aqui', 'estoy aquí',
];

function isArrivalMessage(lower) {
  return ARRIVAL_PHRASES.some(p => lower === p || lower.includes(p));
}

function toISO(date) {
  const yyyy = date.getFullYear();
  const mm   = String(date.getMonth() + 1).padStart(2, '0');
  const dd   = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Versión testeable de isInArrivalWindow: recibe los turnos y "ahora" como params
function isInArrivalWindowTest(apts, now) {
  const today   = toISO(now);
  const nowMins = now.getHours() * 60 + now.getMinutes();

  return apts.some(apt => {
    if (apt.appointment_date !== today) return false;
    const [h, m]  = apt.appointment_time.split(':').map(Number);
    const aptMins = h * 60 + m;
    return nowMins >= aptMins - 30 && nowMins <= aptMins + 30;
  });
}

// ── isArrivalMessage ──────────────────────────────────────────────────────────

console.log('\n── isArrivalMessage ────────────────────────────────────────────');

console.log('\nFrases exactas:');
assert('"estoy abajo"',   isArrivalMessage('estoy abajo'),   true);
assert('"llegué"',        isArrivalMessage('llegué'),         true);
assert('"llegue"',        isArrivalMessage('llegue'),         true);
assert('"ya llegué"',     isArrivalMessage('ya llegué'),      true);
assert('"ya llegue"',     isArrivalMessage('ya llegue'),      true);
assert('"toc toc"',       isArrivalMessage('toc toc'),        true);
assert('"afuera"',        isArrivalMessage('afuera'),         true);
assert('"estoy acá"',     isArrivalMessage('estoy acá'),      true);
assert('"estoy aca"',     isArrivalMessage('estoy aca'),      true);
assert('"abajo"',         isArrivalMessage('abajo'),          true);

console.log('\nFrases con texto adicional (includes):');
assert('"jefa ya llegué!"',       isArrivalMessage('jefa ya llegué!'),       true);
assert('"estoy llegando, celi"',  isArrivalMessage('estoy llegando, celi'),  true);
assert('"ya estoy afuera"',       isArrivalMessage('ya estoy afuera'),       true);

console.log('\nMensajes normales que NO son llegada:');
assert('"hola"',                        isArrivalMessage('hola'),                        false);
assert('"quiero reservar un turno"',    isArrivalMessage('quiero reservar un turno'),    false);
assert('"cancelar turno 1"',            isArrivalMessage('cancelar turno 1'),            false);
assert('"buenos días"',                 isArrivalMessage('buenos días'),                 false);
assert('"gracias"',                     isArrivalMessage('gracias'),                     false);

// ── isInArrivalWindow ─────────────────────────────────────────────────────────

console.log('\n── isInArrivalWindow ───────────────────────────────────────────');

const TODAY = toISO(new Date());
const MAÑANA = (() => {
  const d = new Date(); d.setDate(d.getDate() + 1); return toISO(d);
})();

// Turno a las 10:00 hoy
const aptHoy10 = [{ appointment_date: TODAY, appointment_time: '10:00' }];

console.log('\nTurno hoy 10:00 — ventana 09:30–10:30:');
assert('09:30 → dentro',  isInArrivalWindowTest(aptHoy10, timeToday(9,  30)), true);
assert('10:00 → dentro',  isInArrivalWindowTest(aptHoy10, timeToday(10, 0)),  true);
assert('10:30 → dentro',  isInArrivalWindowTest(aptHoy10, timeToday(10, 30)), true);
assert('09:29 → fuera',   isInArrivalWindowTest(aptHoy10, timeToday(9,  29)), false);
assert('10:31 → fuera',   isInArrivalWindowTest(aptHoy10, timeToday(10, 31)), false);
assert('08:00 → fuera',   isInArrivalWindowTest(aptHoy10, timeToday(8,  0)),  false);

console.log('\nSin turno hoy:');
assert('Sin turnos → false',             isInArrivalWindowTest([], new Date()),                              false);
assert('Turno mañana → false',           isInArrivalWindowTest([{ appointment_date: MAÑANA, appointment_time: '10:00' }], timeToday(10, 0)), false);

// ── Resultado final ───────────────────────────────────────────────────────────

console.log(`\n────────────────────────────────────────────────────`);
console.log(`  Resultado: ${passed} pasaron, ${failed} fallaron`);
if (failed > 0) process.exit(1);

// ── Helper ────────────────────────────────────────────────────────────────────

function timeToday(h, m) {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}
