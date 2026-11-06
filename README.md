# Familia EMETRA · Control de asistencia

Página para celular donde hasta 15 encargados registran la asistencia de la nómina y cuántos familiares llega con cada persona. El administrador sube la nómina, la lista de confirmados y la de galardonados en Excel, ve el historial de todo lo que pasa y descarga el reporte final.

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

## Las tres listas

| Lista | Qué es | Columnas |
|---|---|---|
| **Nómina** | Todos los invitados. Es la lista base. | `Nombre` y `Área` (o `Nombres` + `Apellidos`, `Departamento`…) |
| **Confirmados** | Quienes se inscribieron en la invitación | Solo `Nombre`. El área se ignora. |
| **Galardonados** | Quienes reciben reconocimiento | Solo `Nombre` |

- Puedes subir cualquier lista varias veces: solo se agregan los nombres nuevos.
- Los nombres se comparan sin tildes, mayúsculas ni signos.
- **Cruce de confirmados:** si el nombre coincide exacto, o si todas sus palabras aparecen en un solo nombre de la nómina ("Ana López" → "Ana Lucía López Pérez"), se cruza solo. Si es dudoso, va a la pestaña **Por revisar**, donde eliges a la persona con un toque o lo marcas como "No está en la nómina".

## En la entrada (encargados)

- ✅ junto al nombre = confirmó · 🏅 en rojo = galardonado.
- Toca el nombre, ajusta los **familiares** con – / + y pulsa **Confirmar asistencia**.
- Si no confirmó, aparece un aviso, pero se le puede registrar igual.
- Para corregir los familiares o quitar la asistencia, toca el nombre otra vez. Solo puede hacerlo quien lo registró, o el administrador.

## Reglas de uso

| | Encargado | Administrador |
|---|---|---|
| Buscar y registrar asistencia con familiares | ✅ | — |
| Corregir familiares o quitar asistencia | Solo lo que **él mismo** registró | Todo |
| Subir y borrar listas, revisar el cruce | — | ✅ |
| Ver historial y descargar el Excel final | — | ✅ |
| Crear, editar y desactivar encargados (máx. 15) | — | ✅ |

- **Una sesión por PIN:** si un encargado ya entró en un celular, nadie puede entrar con ese PIN en otro.
- La sesión se cierra sola tras **30 minutos sin actividad** (se cambia en Ajustes). Si un celular se apaga, en **Encargados** pulsa **Liberar**.
- Tras **5 PIN incorrectos** en 10 minutos, ese nombre queda bloqueado 10 minutos.
- **Todo queda en el historial.**

## El Excel final

| Pestaña | Contenido |
|---|---|
| Resumen | Por área y total: nómina, confirmaron, asistieron, asistieron sin confirmar, confirmaron y no llegaron, familiares, **total de personas en el evento**, % de asistencia y galardonados |
| Asistentes | En orden de llegada: familiares, quién lo registró y la hora. Galardonados en rojo. |
| Nómina completa | Toda la nómina con su estado |
| Confirmaron y no llegaron | Para seguimiento |
| Confirmados (cruce) | Cómo se cruzó cada nombre de la inscripción con la nómina |
| Por encargado | Personas y familiares que registró cada encargado |
| Historial | Cada movimiento con fecha y hora |

## Borrar listas

En **Ajustes → Borrar listas** eliges qué borrar y confirmas escribiendo BORRAR. Descarga antes el Excel final. Los encargados y el historial se conservan.

---

## Preguntas frecuentes

**¿Cómo empiezo un evento nuevo desde cero?**
En **Ajustes → Borrar listas → Todo**. Si además quieres borrar el historial, ejecuta en Supabase → SQL Editor: `truncate historial;`

**¿Cómo actualizo la base de datos a una versión nueva?**
Ejecuta otra vez el archivo `supabase/esquema.sql` completo en el SQL Editor. No borra datos.

**Supabase pausó mi proyecto.**
Los proyectos gratuitos se pausan tras una semana sin uso. Entra a supabase.com y pulsa **Restore**. Los datos no se pierden.

**¿Cambio algo del diseño?**
Los colores están al inicio de `css/estilos.css` y el logo en `img/logo.png`.
