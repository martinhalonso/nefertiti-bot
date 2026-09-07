'use strict';

// Utilitario de formateo de contactos para los mensajes que recibe el admin.
//
// El número interno de WhatsApp tiene formato 549XXXXXXXXXX (sin el @c.us):
//   549  → 54 (Argentina) + 9 (prefijo de celular)
//   resto → área (2-4 dígitos) + abonado, 10 dígitos en total.

// Códigos de país conocidos para separar "+[código] [número]" en contactos
// no argentinos. Ordenados de más largo a más corto para que el match sea
// correcto (un código de 1 dígito como "1" no debe ganarle a uno de 3).
const COUNTRY_CODES = [
  '598', '595', '593', '591', '507', '506', '502',
  '55', '56', '57', '58', '52', '51', '34',
  '1',
];

/**
 * Limpia cualquier formato visible (+, espacios, guiones, paréntesis) y deja
 * solo los dígitos. Sirve para normalizar lo que el admin copia de una
 * notificación y lo pega tal cual en un comando.
 * @param {string} input
 * @returns {string} Solo dígitos.
 */
function cleanPhone(input) {
  return String(input == null ? '' : input).replace(/\D/g, '');
}

/**
 * Devuelve true si el texto, una vez limpiado, parece un número de teléfono.
 * Se usa para distinguir "ver cliente <número>" de "ver cliente <nombre>".
 * @param {string} input
 * @returns {boolean}
 */
function looksLikePhone(input) {
  return /^\d{7,15}$/.test(cleanPhone(input));
}

/**
 * Formatea un contacto para mostrarlo al admin.
 * - Si hay nombre disponible, devuelve el nombre.
 * - Si el número es argentino (549...), lo formatea como +54 9 XXX XXXX-XXXX.
 * - Para otros países devuelve +[código] [número].
 * @param {string} phone  Número interno de WhatsApp (549XXXXXXXXXX, sin @c.us).
 * @param {string} [name] Nombre del cliente si está disponible en la DB.
 * @returns {string} El nombre si existe; si no, el número formateado legible.
 */
function formatContact(phone, name) {
  if (name && String(name).trim()) return String(name).trim();

  const digits = cleanPhone(phone);
  if (!digits) return phone ? String(phone) : 'Sin contacto';

  // Argentina: 549 + área + abonado (10 dígitos tras el 549).
  if (digits.startsWith('549')) {
    const local = digits.slice(3);
    const area  = local.slice(0, 3);
    const rest  = local.slice(3);
    // El abonado se parte con un guion antes de los últimos 4 dígitos.
    const abonado = rest.length > 4
      ? `${rest.slice(0, rest.length - 4)}-${rest.slice(-4)}`
      : rest;
    return `+54 9 ${area}${abonado ? ` ${abonado}` : ''}`.trim();
  }

  // Otros países: separar el código conocido del resto del número.
  const code = COUNTRY_CODES.find(c => digits.startsWith(c));
  if (code) return `+${code} ${digits.slice(code.length)}`;

  return `+${digits}`;
}

module.exports = { formatContact, cleanPhone, looksLikePhone };
