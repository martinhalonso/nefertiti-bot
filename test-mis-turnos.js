'use strict';
// Test rápido para el cambio "Mis turnos en menú solo si hay turnos activos"
// Corre con: node test-mis-turnos.js

const MESSAGES = require('./src/config/messages');

let passed = 0;
let failed = 0;

function assert(description, actual, check) {
  const ok = check(actual);
  if (ok) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description}`);
    console.error(`    Valor recibido:\n${actual}\n`);
    failed++;
  }
}

// ── 1. MESSAGES.GREETING_RETURNING ───────────────────────────────────────────

console.log('\n── GREETING_RETURNING ──────────────────────────────────────────');

{
  const msg = MESSAGES.GREETING_RETURNING('Martín López', 'Manicura', false);
  console.log('\nCliente con historial, SIN turnos futuros:');
  assert('Contiene "1" Reservar turno',      msg, m => m.includes('`1` Reservar turno'));
  assert('Contiene "2" Celi',                msg, m => m.includes('`2` Esperar y hablar con Celi'));
  assert('Contiene "3" Ver mi historial',    msg, m => m.includes('`3` Ver mi historial'));
  assert('NO contiene "Mis turnos"',         msg, m => !m.includes('Mis turnos'));
  assert('NO contiene opción "4"',           msg, m => !m.includes('`4`'));
}

{
  const msg = MESSAGES.GREETING_RETURNING('Martín López', 'Manicura', true);
  console.log('\nCliente con historial, CON turnos futuros:');
  assert('Contiene "1" Reservar turno',      msg, m => m.includes('`1` Reservar turno'));
  assert('Contiene "2" Celi',                msg, m => m.includes('`2` Esperar y hablar con Celi'));
  assert('Contiene "3" Mis turnos',          msg, m => m.includes('`3` Mis turnos'));
  assert('Contiene "4" Ver mi historial',    msg, m => m.includes('`4` Ver mi historial'));
  assert('NO contiene "3" Historial directo',msg, m => !m.includes('`3` Ver mi historial'));
}

{
  const msg = MESSAGES.GREETING_RETURNING('Martín López', 'Manicura'); // sin tercer arg
  console.log('\nSin tercer argumento (default false):');
  assert('Muestra 3 opciones (sin Mis turnos)', msg, m =>
    m.includes('`3` Ver mi historial') && !m.includes('`4`'));
}

// ── 2. Lógica de routing handleWaitingOption ─────────────────────────────────
// Se extrae la misma lógica del handler para testearla sin dependencias WA.

console.log('\n── Lógica routing handleWaitingOption ──────────────────────────');

function resolveAction(lower, tieneTurno) {
  const wantsSchedule = ['1', 'agendar', 'turno', 'sacar', 'reservar', 'quiero'].some(w => lower.includes(w));
  const wantsHuman    = ['2', 'esperar', 'hablar', 'persona', 'humano', 'alguien'].some(w => lower.includes(w));

  const wantsMisTurnos = tieneTurno &&
    ['3', 'mis turnos', 'mi turno', 'ver turno', 'ver mis turnos'].some(w => lower.includes(w));

  const wantsHistory =
    ['historial', 'mis visitas', 'ver historial'].some(w => lower.includes(w)) ||
    (!tieneTurno && lower === '3') ||
    (tieneTurno  && lower === '4');

  if (wantsSchedule)  return 'schedule';
  if (wantsHuman)     return 'human';
  if (wantsMisTurnos) return 'misTurnos';
  if (wantsHistory)   return 'historial';
  return 'invalid';
}

// Nota: "mis turnos", "ver mis turnos", etc. son interceptados globalmente en
// handleClientMessage ANTES de llegar a handleWaitingOption, por lo que no se
// testean aquí. Solo se testean las opciones numéricas del menú.

console.log('\nSIN turnos futuros (tieneTurno=false):');
assert('"1" → schedule',          resolveAction('1', false),         r => r === 'schedule');
assert('"2" → human',             resolveAction('2', false),         r => r === 'human');
assert('"3" → historial',         resolveAction('3', false),         r => r === 'historial');
assert('"4" → invalid',           resolveAction('4', false),         r => r === 'invalid');
assert('"historial" → historial', resolveAction('historial', false), r => r === 'historial');
assert('"5" → invalid',           resolveAction('5', false),         r => r === 'invalid');

console.log('\nCON turnos futuros (tieneTurno=true):');
assert('"1" → schedule',          resolveAction('1', true),          r => r === 'schedule');
assert('"2" → human',             resolveAction('2', true),          r => r === 'human');
assert('"3" → misTurnos',         resolveAction('3', true),          r => r === 'misTurnos');
assert('"4" → historial',         resolveAction('4', true),          r => r === 'historial');
assert('"historial" → historial', resolveAction('historial', true),  r => r === 'historial');
assert('"5" → invalid',           resolveAction('5', true),          r => r === 'invalid');

// ── Resultado final ───────────────────────────────────────────────────────────

console.log(`\n────────────────────────────────────────────────────`);
console.log(`  Resultado: ${passed} pasaron, ${failed} fallaron`);
if (failed > 0) process.exit(1);
