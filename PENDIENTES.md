# Pendientes — Bot Nefertiti

> Actualizado: Junio 2026

---

## 🔴 PRIORIDAD ALTA — Modelo de clientes ✅ Implementado

### Contexto
Actualmente los clientes no tienen identidad propia en el sistema. Un cliente
es solo un número de teléfono con un nombre asociado a cada turno. Esto genera
duplicados, inconsistencias y limita lo que el admin puede hacer.

### Cambio propuesto: tabla `clients`

Crear una tabla `clients` con un registro único por número de teléfono:
```sql
CREATE TABLE clients (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  phone        TEXT UNIQUE,          -- número normalizado, identidad real
  name         TEXT,                 -- nombre canónico (primer registro o el que actualice el admin)
  created_at   TEXT
)
```

Todos los turnos (incluso los manuales) se vinculan a un cliente por teléfono.

### Comportamiento esperado

**Desde el bot (cliente):**
- Cuando un número escribe por primera vez y completa el flujo, se crea el cliente con su teléfono y el nombre que ingresó
- Si el mismo número escribe otra vez con un nombre diferente ("Susy" en vez de "Susana"), el sistema lo reconoce por el teléfono y usa el nombre canónico guardado
- El saludo inicial usa el nombre de la DB si el número ya existe, en lugar del nombre de WhatsApp (que puede ser un emoji u otra cosa)
- Si el número no existe en la DB, usar el nombre de WhatsApp como ahora

**Desde el admin:**
- `agregar turno` → pide nombre del cliente → si existe en DB lo vincula automáticamente → si no existe, pide el teléfono para crear el cliente nuevo
- `ver cliente [nombre o número]` → busca por nombre O por teléfono indistintamente
- `cancelar turno [nombre o número]` → busca por nombre O por teléfono
- `pausar [nombre o número]` → acepta nombre o teléfono
- `activar [nombre o número]` → acepta nombre o teléfono
- En todos los mensajes al admin, mostrar siempre nombre + teléfono formateado

### Impacto técnico
- Nueva tabla `clients` en `initDB.js`
- Migración: poblar `clients` con datos existentes de `appointments`
- Modificar `adminHandler.js`: todos los comandos aceptan nombre o teléfono
- Modificar `clientHandler.js`: saludo usa nombre de DB si existe
- Modificar `queries.js`: nuevas queries para buscar/crear/actualizar clientes
- `phone_number = 'manual'` reemplazado por teléfono real cuando el admin lo provee

---

## Mejoras de UX para el admin

### Identificación de clientes — PRIORIDAD ALTA ✅ Implementado
En todos los mensajes al admin que muestren información de clientes,
identificarlos siempre con:
- **Nombre** si está disponible
- **Número de teléfono formateado** (`+54 9 11 XXXX-XXXX`) como fallback
- **Nunca** usar IDs internos ni números crudos sin formato

Casos a revisar y corregir:
- `ver pausados` — muestra ID largo en lugar de teléfono formateado
- Revisar todos los demás comandos admin que listen clientes y verificar
  que usen `formatContact(phone, name)` consistentemente

---

## Funcionalidades futuras

### Sincronización Calendar → DB ✅ Implementado
Si se borra un evento desde Google Calendar, el turno sigue existiendo
en la DB del bot (recordatorios, "mis turnos", etc.).
Evaluar detectar borrados en Calendar y cancelar automáticamente en DB.

---

## Modelo SaaS (Camino A — licencias)

Ver detalle completo en `ROADMAP-SAAS.md`.
Arrancar cuando haya demanda validada de clientes externos.

---

## Agente IA híbrido

Ver detalle completo en `docs/AGENTE-IA-DISEÑO.md`.
Requiere `ANTHROPIC_API_KEY` — obtener en console.anthropic.com.
Código listo en rama `feature/agente-ia`.
