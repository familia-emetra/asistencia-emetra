# Familia EMETRA · Control de asistencia

Página para celular donde hasta 15 encargados marcan la asistencia de una lista de personas. El administrador sube las listas en Excel, ve el historial de todo lo que pasa y descarga los reportes.

- **Página:** GitHub Pages (gratis)
- **Base de datos:** Supabase (gratis)

---

## Instalación (una sola vez, unos 15 minutos)

### Paso 1 · Crear la base de datos en Supabase

1. Entra a <https://supabase.com> y crea una cuenta gratuita.
2. Pulsa **New project**. Ponle un nombre (por ejemplo `asistencia-emetra`), crea una contraseña de base de datos y elige la región más cercana (por ejemplo *East US*).
3. Cuando el proyecto esté listo, en el menú de la izquierda abre **SQL Editor** y luego **New query**.
4. Abre el archivo `supabase/esquema.sql` de este proyecto, copia **todo** su contenido, pégalo y pulsa **Run**.
   Debe aparecer *Success. No rows returned*.
5. Ve a **Project Settings → API** (en algunas cuentas se llama **Data API** y **API Keys**) y copia dos datos:
   - **Project URL**, que se ve así: `https://abcdefgh.supabase.co`
   - La llave pública: **anon public** (empieza con `eyJ…`) o **publishable** (empieza con `sb_publishable_…`)

> ⚠️ Nunca uses la llave **service_role** ni la **secret**. Esas no van en la página.

### Paso 2 · Conectar la página

Abre `js/config.js` y pega los dos datos:

```js
SUPABASE_URL: "https://abcdefgh.supabase.co",
SUPABASE_KEY: "eyJhbGciOi...",
```

La llave pública se puede publicar sin problema: la página no lee las tablas directamente, y todas las reglas las aplica la base de datos.

### Paso 3 · Subir a GitHub y publicar

1. En <https://github.com> crea un repositorio nuevo, por ejemplo `asistencia-emetra`. Puede ser público.
2. Pulsa **Add file → Upload files** y arrastra **todo el contenido** de esta carpeta: `index.html`, y las carpetas `css`, `js`, `img` y `supabase`. Luego pulsa **Commit changes**.
3. Ve a **Settings → Pages**. En *Branch* elige `main` y la carpeta `/ (root)`, y pulsa **Save**.
4. Espera 1 o 2 minutos. Tu página quedará en:
   `https://TU-USUARIO.github.io/asistencia-emetra/`

### Paso 4 · Primer ingreso del administrador

1. Abre la página y escribe **Administrador** como nombre, con el PIN **0000**.
2. Ve a **Ajustes** y **cambia el PIN de administrador de inmediato.**
3. En **Encargados**, crea las cuentas con nombre y apellido y un PIN de 4 dígitos.
4. En **Resumen**, sube la lista de personas y luego la de galardonados.

---

## Cómo debe ser el Excel

La página busca los encabezados en las primeras filas. Puede haber un título arriba.

| Columna | Nombres que reconoce |
|---|---|
| Nombre | `Nombre`, `Nombre completo`… o dos columnas `Nombres` y `Apellidos` (se unen) |
| Área | `Área`, `Departamento`, `Depto`, `Dependencia`, `Unidad`, `Sección`, `Dirección` |

- Si el archivo tiene **varias hojas** y no trae columna de área, se usa el nombre de cada hoja como área.
- Si no hay encabezados, se toma la columna A como nombre y la B como área.
- La lista de **galardonados** solo necesita la columna `Nombre`.
- Antes de subir, la página muestra cuántos nombres leyó y pide confirmación.

**Sin duplicados:** los nombres se comparan sin tildes, mayúsculas, signos ni espacios de más. Por ejemplo, "JOSÉ  Pérez." y "jose perez" son la misma persona. Puedes subir listas nuevas cuando quieras: solo se agregan las personas que faltan, y las demás conservan su asistencia.

---

## Reglas de uso

| | Encargado | Administrador |
|---|---|---|
| Buscar por área y nombre | ✅ | ✅ |
| Marcar asistencia | ✅ | — |
| Quitar asistencia | Solo la que **él mismo** marcó | Cualquiera |
| Subir listas | — | ✅ |
| Ver historial y descargar Excel | — | ✅ |
| Crear, editar y desactivar encargados (máx. 15) | — | ✅ |

- **Una sesión por PIN:** si un encargado ya entró en un celular, nadie puede entrar con ese PIN en otro.
- La sesión se cierra sola tras **30 minutos sin actividad**. Puedes cambiar ese tiempo en Ajustes.
- Si un celular se apaga o se pierde, en **Encargados** pulsa **Liberar**.
- Recargar la página no cierra la sesión.
- Tras **5 PIN incorrectos** en 10 minutos, ese nombre queda bloqueado 10 minutos.
- Los galardonados aparecen en **rojo** con 🏅.
- **Todo queda en el historial:** ingresos, intentos fallidos, marcas, quitadas, subidas de listas, cambios de encargados y descargas.

## El Excel que descargas

| Pestaña | Contenido |
|---|---|
| Asistentes | Quienes asistieron, en orden de llegada, con quién los registró y la hora. Galardonados en rojo. |
| Lista completa | Todas las personas, con su asistencia (Sí/No) |
| Resumen | Totales y porcentaje por área |
| Por encargado | Cuántas asistencias registró cada encargado |
| Historial | Cada movimiento realizado en la página |
| Galardonados sin lista | Solo aparece si algún galardonado no coincide con la lista (revisa la ortografía) |

---

## Preguntas frecuentes

**¿Cómo empiezo un evento nuevo desde cero?**
En Supabase, abre **SQL Editor** y ejecuta:

```sql
truncate asistencia, historial, sesiones;            -- borra asistencia e historial
-- truncate personas, galardonados cascade;          -- (opcional) borra también las listas
```

Descarga antes el Excel si quieres guardar el registro.

**Supabase pausó mi proyecto.**
Los proyectos gratuitos se pausan tras una semana sin uso. Entra a supabase.com y pulsa **Restore**. Los datos no se pierden.

**¿Cambio algo del diseño?**
Los colores están al inicio de `css/estilos.css` y el logo en `img/logo.png`.
