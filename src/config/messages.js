// Todos los textos del bot. Editá acá para cambiar cualquier mensaje sin tocar la lógica.

const { formatContact } = require('../utils/formatContact');

const MESSAGES = {
  // ── Flujo de agendamiento ────────────────────────────────────────────────────

  // Saludo inicial — nameSuffix viene con coma y espacio si hay nombre: ", Martín"
  GREETING: (nameSuffix = '') =>
    `¡Hola${nameSuffix}! 👋 Soy la asistente de Nefertiti. ¿Qué querés hacer?

\`1\` Reservar turno
\`2\` Esperar y hablar con Celi

Respondé con el número de la opción.`,

  // Nombre del cliente
  ASK_NAME: `¿Cuál es tu nombre y apellido? 😊`,

  INVALID_NAME: `⚠️ Por favor escribí tu nombre y apellido para continuar.\n\n¿Cuál es tu nombre y apellido?`,

  // Elección de servicio
  ASK_SERVICE: `¿Qué servicio necesitás?`,

  // Elección de fecha (el listado de días se genera dinámicamente)
  ASK_DATE: `¿Qué día te viene bien?`,

  // Elección de horario — dateLabel ej: "Lunes 12/05"
  ASK_TIME: (dateLabel) => `¿A qué hora el *${dateLabel}*?`,

  // Resumen antes de confirmar
  TURN_SUMMARY: ({ service, duration, price, dateLabel, time }) =>
    `📋 *Resumen del turno*\n\n` +
    `💅 Servicio: ${service} (${duration} min)\n` +
    `📅 Fecha: ${dateLabel}\n` +
    `🕐 Hora: ${time}\n` +
    `💰 Precio: $${Number(price).toLocaleString('es-AR')}\n\n` +
    `¿Qué querés hacer?\n` +
    `\`1\` Confirmar ✅\n` +
    `\`2\` Cancelar ❌\n` +
    `\`3\` Editar ✏️`,

  // Opción inválida (se adjunta la pregunta del paso actual)
  INVALID_OPTION: `⚠️ Por favor elegí una opción válida 😊\n`,

  // El usuario eligió hablar con un humano
  HUMAN_REQUESTED:
    `Entendido 👍 Le avisamos al equipo y te contactan a la brevedad.\n\n` +
    `Cuando quieras retomar el bot escribí *hola*.`,

  // Sin disponibilidad
  NO_AVAILABILITY:
    `😔 No hay turnos disponibles en los próximos días. ` +
    `Escribí *hola* más adelante para verificar nuevos horarios.`,

  // ── Seña ────────────────────────────────────────────────────────────────────

  ASK_SEÑA: `💳 ¿Querés dejar una seña para asegurar el turno?\n\n\`1\` Sí, quiero dejar una seña\n\`2\` No, reservar sin seña`,

  SEÑA_INFO: (monto, cbu, alias) => {
    const tieneCBU   = cbu && cbu !== '???';
    const tieneAlias = alias && alias !== '???';
    const lines = [`Para dejar tu seña, transferí *$${monto}* a:\n`];
    if (tieneCBU)   lines.push(`🏦 CBU: \`${cbu}\``);
    if (tieneAlias) lines.push(`🏷️ Alias: \`${alias}\``);
    if (!tieneCBU && !tieneAlias)
      lines.push(`⚠️ Los datos de transferencia aún no están configurados. Consultá con nosotros.`);
    lines.push(`\nCuando hagas la transferencia mandame el comprobante 😊`);
    return lines.join('\n');
  },

  TURNO_CONFIRMADO: (dateLabel, time) =>
    `✅ ¡Turno confirmado! Te espero el *${dateLabel}* a las *${time}*. ¡Hasta pronto! 👋`,

  SEÑA_PENDIENTE:
    `✅ ¡Turno reservado! Cuando hagas la transferencia mandame el comprobante 📸\n\n` +
    `O escribí *no* si preferís omitirlo por ahora.`,

  SEÑA_REQUIRED: (monto, cbu, alias, apt = {}) => {
    const { serviceName, duration, price, dateLabel, time } = apt;
    const lines = ['✅ ¡Turno confirmado!'];
    if (dateLabel && time)   lines.push(`📅 ${dateLabel} a las ${time}`);
    if (serviceName)         lines.push(`💇 ${serviceName}${duration ? ` (${duration} min)` : ''}`);
    if (price !== undefined) lines.push(`💰 Total: $${Number(price).toLocaleString('es-AR')}`);
    lines.push(
      '',
      `¿Querés dejar una seña de *$${monto}* para asegurarlo?`,
      `Transferí a *${alias}* (CBU: \`${cbu}\`)`,
      `Cuando hagas la transferencia, mandame el comprobante 📸`,
      `O escribí *no* para omitir.`,
    );
    return lines.join('\n');
  },

  SEÑA_RECEIVED:
    `✅ ¡Comprobante recibido! En breve lo verificamos y confirmamos tu turno. ` +
    `Cualquier consulta escribís acá.`,

  // ── Recordatorio ────────────────────────────────────────────────────────────

  REMINDER_24H: (fecha, hora) =>
    `⏰ *Recordatorio*: tenés un turno mañana *${fecha}* a las *${hora}*.\n\n¿Podés asistir? Respondé *SI* o *NO*.`,

  // ── Confirmación ────────────────────────────────────────────────────────────

  TURN_CONFIRMED: (fecha, hora) =>
    `✅ ¡Turno confirmado!\n\n📅 Fecha: ${fecha}\n🕐 Hora: ${hora}\n\nTe recordaremos 24hs antes. ¡Hasta pronto!`,

  // ── Cancelación ─────────────────────────────────────────────────────────────

  ASK_CANCEL_CONFIRM: (fecha, hora) =>
    `¿Seguro querés cancelar el turno del *${fecha}* a las *${hora}*?\n\nRespondé *SI* para confirmar o *NO* para volver.`,

  CANCEL_CONFIRMED: `✅ Tu turno fue cancelado correctamente.`,

  CANCEL_ABORTED: `Okay, el turno no fue cancelado. ¿Necesitás algo más?`,

  // ── Varios ───────────────────────────────────────────────────────────────────

  NO_TURNS: `No tenés turnos agendados por el momento.`,

  TURN_NOT_FOUND: `No encontré ese turno. Escribí *mis turnos* para ver tus turnos activos.`,

  ERROR_GENERIC: `Ocurrió un error inesperado. Por favor intentá de nuevo o escribí *hola* para volver al inicio.`,

  UNKNOWN_COMMAND: `No entendí eso. 😅 Escribí *hola* para ver las opciones disponibles.`,

  // ── Notificaciones al admin ──────────────────────────────────────────────────

  ADMIN_NEW_TURN: (nombre, fecha, hora, telefono, servicio) =>
    `🔔 *Nuevo turno agendado*\n\n👤 Cliente: ${nombre}\n💅 Servicio: ${servicio || 'Sin especificar'}\n📅 Fecha: ${fecha}\n🕐 Hora: ${hora}`,

  ADMIN_CANCELLATION: (nombre, fecha, hora, telefono) =>
    `❌ *Turno cancelado*\n\n👤 Cliente: ${nombre}\n📞 Tel: ${telefono}\n📅 Fecha: ${fecha}\n🕐 Hora: ${hora}`,

  ADMIN_SEÑA_RECEIVED: (nombre, telefono, apt = {}) => {
    const { dateLabel, time, serviceName } = apt;
    let text = `🧾 *Comprobante recibido*\n\n👤 ${nombre || telefono}`;
    if (dateLabel && time) text += `\n📅 ${dateLabel} a las ${time}`;
    if (serviceName)       text += `\n💇 ${serviceName}`;
    text += `\n\nEscribí *ver comprobantes* para revisarlo.`;
    return text;
  },

  ADMIN_HUMAN_REQUESTED: (nombre, telefono) =>
    `📩 *${nombre || telefono}* quiere hablar con alguien del equipo cuando puedan.`,

  // ── Gestión de turnos (cliente) ──────────────────────────────────────────────

  MY_TURNS_HEADER: '📋 *Tus turnos:*',

  MY_TURNS_LINE: (i, dateLabel, time, service, seña) =>
    `\`${i}\` ${dateLabel} a las *${time}* — ${service} ${seña ? '✅' : '⏳'}`,

  MY_TURNS_FOOTER: '\n_✅ seña confirmada · ⏳ seña pendiente_\n\nEscribí *cancelar turno [número]* o *modificar turno [número]*',

  CLIENT_CANCEL_CONFIRM: (dateLabel, time, service) =>
    `¿Seguro que querés cancelar este turno?\n\n📅 ${dateLabel} a las *${time}*\n💇 ${service}\n\nRespondé *SI* para confirmar o *NO* para volver.`,

  CLIENT_CANCEL_OK: (dateLabel, time) =>
    `✅ Tu turno del *${dateLabel}* a las *${time}* fue cancelado. Escribí *hola* si querés agendar uno nuevo.`,

  CLIENT_CANCEL_ABORT: '👌 Cancelación abortada. Tu turno sigue vigente.',

  CLIENT_MOD_ASK_FIELD: (dateLabel, time) =>
    `¿Qué querés cambiar del turno del *${dateLabel}* a las *${time}*?\n\n\`1\` Cambiar fecha\n\`2\` Cambiar horario\n\`3\` Cancelar (volver)`,

  CLIENT_MOD_CONFIRM: ({ service, duration, price, dateLabel, time }) =>
    `📋 *Nuevo horario del turno*\n\n` +
    `💅 Servicio: ${service} (${duration} min)\n` +
    `📅 Fecha: ${dateLabel}\n` +
    `🕐 Hora: ${time}\n` +
    `💰 Precio: $${Number(price).toLocaleString('es-AR')}\n\n` +
    `¿Confirmás el cambio? Respondé *SI* o *NO*`,

  CLIENT_MOD_OK: (dateLabel, time) =>
    `✅ ¡Turno reprogramado! Te esperamos el *${dateLabel}* a las *${time}*. Escribí *hola* si necesitás algo más.`,

  CLIENT_MOD_ABORT: '👌 El turno quedó sin cambios.',

  // ── Historial del cliente ────────────────────────────────────────────────────

  CLIENT_HISTORY_HEADER: (nombre) =>
    `📖 *Historial de ${nombre || 'este cliente'}*`,

  CLIENT_HISTORY_EMPTY:
    `No tenés visitas anteriores registradas. ¡Esperamos verte pronto! 😊`,

  CLIENT_HISTORY_LINE: (apt) => {
    const d    = new Date(`${apt.appointment_date}T12:00:00`);
    const dd   = String(d.getDate()).padStart(2, '0');
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `• ${dd}/${mm}/${yyyy} — ${apt.service_name} — $${Number(apt.service_price).toLocaleString('es-AR')}`;
  },

  CLIENT_HISTORY_STATS: (stats, favorite) => {
    const lines = [];
    if (stats.total_gastado)
      lines.push(`💰 Total gastado: $${Number(stats.total_gastado).toLocaleString('es-AR')}`);
    if (favorite?.service_name)
      lines.push(`💅 Servicio favorito: ${favorite.service_name} (${favorite.veces}x)`);
    if (stats.primera_visita) {
      const d  = new Date(`${stats.primera_visita}T12:00:00`);
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      lines.push(`📅 Primera visita: ${dd}/${mm}/${d.getFullYear()}`);
    }
    return lines.join('\n');
  },

  GREETING_RETURNING: (nombre, servicio, tieneTurno = false) =>
    `¡Hola${nombre ? `, ${nombre.split(' ')[0]}` : ''}! ¡Qué bueno verte de nuevo! 😊` +
    (servicio ? `\nLa última vez te hiciste *${servicio}*. 💅\n` : '\n') +
    `\n\`1\` Reservar turno\n\`2\` Esperar y hablar con Celi\n` +
    (tieneTurno
      ? `\`3\` Mis turnos\n\`4\` Ver mi historial`
      : `\`3\` Ver mi historial`) +
    `\n\nRespondé con el número de la opción.`,

  ADMIN_CLIENT_CARD: (phone, nombre, stats, favorite, history, futuro) => {
    const lines = [
      `👤 *${nombre || 'Sin nombre'}*`,
      `📞 ${formatContact(phone)}`,
      ``,
    ];
    if (stats.turnos_pasados > 0) {
      lines.push(`📊 *Estadísticas*`);
      lines.push(`Visitas: ${stats.turnos_pasados}`);
      if (stats.total_gastado)
        lines.push(`Total gastado: $${Number(stats.total_gastado).toLocaleString('es-AR')}`);
      if (favorite?.service_name)
        lines.push(`Servicio favorito: ${favorite.service_name} (${favorite.veces}x)`);
      if (stats.ultima_visita) {
        const d = new Date(`${stats.ultima_visita}T12:00:00`);
        lines.push(`Última visita: ${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`);
      }
      lines.push(``);
    }
    if (futuro?.length) {
      lines.push(`📅 *Próximo turno*`);
      lines.push(`${futuro[0].appointment_date} ${futuro[0].appointment_time} — ${futuro[0].service_name}`);
      lines.push(``);
    }
    if (history.length) {
      lines.push(`🗓️ *Últimas visitas*`);
      history.slice(0, 5).forEach(a => {
        const d  = new Date(`${a.appointment_date}T12:00:00`);
        const dd = String(d.getDate()).padStart(2,'0');
        const mm = String(d.getMonth()+1).padStart(2,'0');
        lines.push(`${dd}/${mm}/${d.getFullYear()} ${a.appointment_time} — ${a.service_name} — $${Number(a.service_price).toLocaleString('es-AR')}${a.seña_paid ? ' ✅' : ''}`);
      });
    } else {
      lines.push(`_Sin visitas anteriores registradas._`);
    }
    return lines.join('\n');
  },

  // ── Resumen diario (admin) ───────────────────────────────────────────────────

  ADMIN_DAILY_SUMMARY: (dateLabel, appointments) => {
    if (!appointments.length)
      return `📋 *Resumen del día — ${dateLabel}*\n\nNo hay turnos agendados para hoy.`;
    const lines = appointments.map((a, i) =>
      `${i + 1}. *${a.appointment_time}* — ${formatContact(a.phone_number, a.client_name)} | ` +
      `${a.service_name} (${a.service_duration} min) ` +
      `$${Number(a.service_price).toLocaleString('es-AR')} ${a.seña_paid ? '✅' : '⏳'}`
    );
    return (
      `📋 *Resumen del día — ${dateLabel}*\n\n` +
      `Tenés *${appointments.length}* turno(s) hoy:\n\n` +
      lines.join('\n') +
      `\n\n_✅ seña confirmada · ⏳ sin seña_`
    );
  },
};

module.exports = MESSAGES;
