const { initDB, getDb } = require('./initDB');
const { logger }        = require('../utils/logger');

function seed() {
  initDB();
  const db = getDb();

  // ── Servicios ─────────────────────────────────────────────────────────────
  const insertService = db.prepare(`
    INSERT OR IGNORE INTO services (name, duration_minutes, price, category, sort_order)
    VALUES (@name, @duration_minutes, @price, @category, @sort_order)
  `);

  const services = [
    { name: 'Semipermanente en manos',                  duration_minutes:  45, price: 17000, category: 'manos',          sort_order:  1 },
    { name: 'Retiro + semi en manos',                   duration_minutes:  60, price: 19000, category: 'manos',          sort_order:  2 },
    { name: 'Retiro semi',                              duration_minutes:  15, price:  3000, category: 'manos',          sort_order:  3 },
    { name: 'Retiro + estética en manos',               duration_minutes:  45, price: 15000, category: 'manos',          sort_order:  4 },
    { name: 'Estética en manos',                        duration_minutes:  30, price: 12000, category: 'manos',          sort_order:  5 },
    { name: 'Kapping gel',                              duration_minutes:  75, price: 20000, category: 'manos',          sort_order:  6 },
    { name: 'Service de kapping gel',                   duration_minutes:  90, price: 22000, category: 'manos',          sort_order:  7 },
    { name: 'Retiro kapping gel',                       duration_minutes:  30, price:  4000, category: 'manos',          sort_order:  8 },
    { name: 'Kapping polygel',                          duration_minutes:  90, price: 25000, category: 'manos',          sort_order:  9 },
    { name: 'Service de kapping polygel',               duration_minutes: 105, price: 27000, category: 'manos',          sort_order: 10 },
    { name: 'Retiro kapping polygel',                   duration_minutes:  45, price:  6000, category: 'manos',          sort_order: 11 },
    { name: 'Soft gel',                                 duration_minutes:  60, price: 25000, category: 'manos',          sort_order: 12 },
    { name: 'Service soft gel',                         duration_minutes:  90, price: 27000, category: 'manos',          sort_order: 13 },
    { name: 'Retiro soft gel',                          duration_minutes:  45, price:  5000, category: 'manos',          sort_order: 14 },
    { name: 'Retiro soft gel + soft gel',               duration_minutes: 120, price: 29000, category: 'manos',          sort_order: 15 },
    { name: 'Semipermanente en pies (ret + esmaltado)', duration_minutes:  30, price: 17000, category: 'pies',           sort_order:  1 },
    { name: 'Semipermanente en pies (con spa)',         duration_minutes:  60, price: 25000, category: 'pies',           sort_order:  2 },
    { name: 'Perfilado de cejas con hilo',              duration_minutes:  30, price: 15000, category: 'cejas_pestanas', sort_order:  1 },
    { name: 'Laminado de cejas',                        duration_minutes:  45, price: 14000, category: 'cejas_pestanas', sort_order:  2 },
    { name: 'Laminado de pestañas',                     duration_minutes:  60, price: 23000, category: 'cejas_pestanas', sort_order:  3 },
  ];

  const insertMany = db.transaction((rows) => {
    for (const row of rows) insertService.run(row);
  });
  insertMany(services);

  // Migración: asignar categorías y sort_order a servicios ya existentes
  const setCat = db.prepare(`UPDATE services SET category = ?, sort_order = ? WHERE LOWER(name) = LOWER(?)`);
  for (const s of services) setCat.run(s.category, s.sort_order, s.name);

  // ── Horario laboral ───────────────────────────────────────────────────────
  // Se guarda como JSON: { days: [1..6], open: "HH:MM", close: "HH:MM" }
  // days: 0=domingo, 1=lunes, ... 6=sábado
  const insertSetting = db.prepare(`
    INSERT OR IGNORE INTO settings (key, value) VALUES (@key, @value)
  `);

  insertSetting.run({
    key: 'working_hours',
    value: JSON.stringify({
      days: [1, 2, 3, 4, 5, 6],
      open: '09:00',
      close: '18:00',
    }),
  });

  // Refresh token de Google Calendar (se completa al autenticar)
  insertSetting.run({ key: 'google_refresh_token', value: '' });

  logger.info('Seed completado: servicios y horario laboral cargados.');
  db.close();
}

// Solo ejecutar automáticamente si se corre directamente (node src/db/seed.js)
if (require.main === module) {
  seed();
}

module.exports = { seed };
