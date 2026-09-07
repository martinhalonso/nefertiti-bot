# Cómo empaquetar el bot (Windows)

Corré estos comandos en una terminal (CMD o PowerShell), parado en la carpeta del proyecto:

```
cd "C:\Users\marti\OneDrive\Documentos\asistente para nefertiti"
```

## 1. Reconstruir el módulo nativo para Electron (antes del build)

```
npx electron-rebuild -f -w better-sqlite3
```

## 2. Generar el instalador

```
npm run build
```

El instalador queda en la carpeta `dist\`, con un nombre tipo:

```
dist\Bot Nefertiti Setup 1.1.0.exe
```

## 3. (Opcional) Volver a dejar el módulo listo para desarrollo

Solo si vas a correr el bot con `npm run dev` / `npm start` en esta PC:

```
npm rebuild better-sqlite3
```

---

## En la notebook (donde corre el bot)

1. Copiá el `.exe` de `dist\` a la notebook.
2. Instalalo **sobre** la versión existente (no hace falta desinstalar).
3. Abrí el bot una vez. En este primer arranque con la versión nueva:
   - Migra el token de Google Calendar a un archivo (queda a salvo de futuros reseteos).
   - Reimporta desde Google Calendar los turnos que falten en la base.
   - Crea el primer backup de `bot.db`.

> A partir de esta actualización, cada vez que abras el bot se hace backup de la
> agenda (se guardan los últimos 10) y, si alguna vez la base quedara vacía, se
> restaura sola desde el último backup o desde Google Calendar.

## Nota sobre la versión

Si querés que el instalador tenga un número nuevo (ej.: 1.2.0), cambiá el campo
`"version"` en `package.json` antes del paso 2. No es obligatorio para que funcione.
