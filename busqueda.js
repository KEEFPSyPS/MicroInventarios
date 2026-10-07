/* ===========================================================================
 * busqueda.js — "súper buscador" del Historial (módulo puro, sin dependencias).
 * ---------------------------------------------------------------------------
 * Encuentra auditorías por proveedor, folio, línea/marca, encargado, verificador,
 * FECHA (en varios formatos) y por datos de artículo (código/SKU, descripción,
 * cantidades...). No toca el DOM ni Firestore: solo recibe registros y texto y
 * devuelve qué coincide. La UI (app.js) se encarga de pintar y resaltar.
 *
 * Reglas de la búsqueda:
 *  - La normalización ignora mayúsculas, acentos y espacios sobrantes.
 *  - Varios términos separados por espacio se combinan con AND (deben coincidir
 *    todos), para que teclear más acote el resultado, no lo amplíe.
 *  - Un término puede ser una FECHA (2026-10-07, 07/10/2026, 7/10, "octubre",
 *    "oct 2026", ...) y entonces se compara contra la fecha real del registro.
 *  - Un término que no es fecha se busca como subcadena en los textos de
 *    cabecera y de artículo.
 *  - Un término NUMÉRICO (p. ej. "12") coincide si casa como fecha O como texto
 *    de artículo: basta que una de las dos se cumpla.
 *
 * Este archivo es un módulo ES sin imports: se sirve tal cual y lo importa
 * app.js. También lo importa el test (tests/busqueda.test.cjs) vía import().
 * ======================================================================== */

/* Meses en español (nombre completo y abreviatura de tres letras) indexados por
   número de mes (1..12). Se usan para interpretar términos como "octubre" o
   "oct 2026" contra la fecha ISO del registro. */
const MESES = {
  enero: 1,
  ene: 1,
  febrero: 2,
  feb: 2,
  marzo: 3,
  mar: 3,
  abril: 4,
  abr: 4,
  mayo: 5,
  may: 5,
  junio: 6,
  jun: 6,
  julio: 7,
  jul: 7,
  agosto: 8,
  ago: 8,
  septiembre: 9,
  setiembre: 9,
  sep: 9,
  set: 9,
  octubre: 10,
  oct: 10,
  noviembre: 11,
  nov: 11,
  diciembre: 12,
  dic: 12
};

/* Separa una fecha numérica por / - o . y valida que sean todos dígitos.
   Devuelve el array de partes (1..3) o null si no encaja. */
function partesFecha(t) {
  const partes = t.split(/[/\-.]/);
  if (partes.length < 2 || partes.length > 3) return null;
  if (!partes.every((p) => /^\d{1,4}$/.test(p))) return null;
  return partes;
}

/* Normaliza un texto para comparar: pasa a minúsculas, despoja de acentos
   (NFD + quita los diacríticos) y colapsa/recorta los espacios. Devuelve "" si
   recibe algo vacío o no textual. */
export function normalizarTexto(s) {
  if (s == null) return "";
  return String(s)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/* Convierte un número de mes (1..12) a texto de 2 dígitos ("01".."12"). */
const mesDos = (n) => String(n).padStart(2, "0");

/* Interpreta un TÉRMINO de búsqueda como una fecha y devuelve un predicado
   `(fechaISO) => boolean`, o null si el término no es una fecha reconocible.
   Formatos aceptados (con la fecha del registro en ISO "YYYY-MM-DD"):
     - 2026-10-07 / 2026/10/07  → año-mes-día exacto.
     - 07/10/2026 / 7/10/2026   → día/mes/año (formato hispano).
     - 07-10-2026               → se acepta / - y . como separador.
     - 7/10                     → día/mes, cualquier año.
     - 10/2026                  → mes/año (cualquier día).
     - "octubre" / "oct"        → ese mes, cualquier año.
     - "oct 2026" / "octubre 2026" → ese mes y año.
   Devuelve null cuando el término no fuese una fecha. */
export function interpretarFecha(termino) {
  const t = normalizarTexto(termino);
  if (!t) return null;

  /* --- Nombre de mes, con o sin año: "octubre", "oct 2026" --- */
  const partes = t.split(" ");
  if (partes.length <= 2 && MESES[partes[0]] !== undefined) {
    const mes = MESES[partes[0]];
    if (partes.length === 1) {
      return (fechaISO) => fechaISO.slice(5, 7) === mesDos(mes);
    }
    /* Con año solo si el segundo trozo es un año de 4 dígitos. */
    if (/^\d{4}$/.test(partes[1])) {
      const ymd = `${partes[1]}-${mesDos(mes)}`;
      return (fechaISO) => fechaISO.slice(0, 7) === ymd;
    }
    return null;
  }

  /* --- Fecha numérica: AAAA-MM-DD, DD/MM/AAAA, D/M, MM/AAAA --- */
  const p = partesFecha(t);
  if (!p) return null;

  /* Tres partes: la de 4 dígitos decide el orden (año-mes-día o día-mes-año). */
  if (p.length === 3) {
    const [x, y, z] = p;
    if (x.length === 4) {
      /* AAAA-MM-DD */
      if (+y < 1 || +y > 12) return null;
      const ymd = `${x}-${mesDos(+y)}-${z.padStart(2, "0")}`;
      return (fechaISO) => fechaISO === ymd;
    }
    if (z.length === 4) {
      /* DD/MM/AAAA */
      if (+y < 1 || +y > 12) return null;
      const ymd = `${z}-${mesDos(+y)}-${x.padStart(2, "0")}`;
      return (fechaISO) => fechaISO === ymd;
    }
    return null;
  }

  /* Dos partes: mes/año (alguna de 4 dígitos) o día/mes. */
  const [a, b] = p;
  if (a.length === 4 || b.length === 4) {
    /* MM/AAAA (o AAAA/MM) → mes y año */
    const anio = a.length === 4 ? a : b;
    const mes = +(a.length === 4 ? b : a);
    if (mes < 1 || mes > 12) return null;
    const ym = `${anio}-${mesDos(mes)}`;
    return (fechaISO) => fechaISO.slice(0, 7) === ym;
  }
  /* D/M: día y mes, sin año. Se admiten valores 0-padded ("07/10"). */
  const dia = +a,
    mes = +b;
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  const md = `-${mesDos(mes)}-${mesDos(dia)}`;
  return (fechaISO) => fechaISO.slice(4, 10) === md;
}

/* Precalcula, para un registro, los textos buscables YA normalizados. Se hace
   UNA vez por registro (no en cada pulsación) porque normalizar es lo caro.
   Devuelve:
     - `cabecera`: array de textos de cabecera (fecha, línea, folio, proveedor,
       encargado, verificador).
     - `fechaISO`: la fecha del registro tal cual (para comparar fechas).
     - `partidas`: array de {codigo, desc, extras[]} con los textos de cada
       partida (incluye las cantidades como texto). `extras` reúne el resto de
       campos numéricos de la partida para la búsqueda por coincidencia. */
export function prepararRegistro(a) {
  const r = a || {};
  const fechaISO = String(r.fecha || "");
  const cabecera = [
    fechaISO,
    normalizarTexto(r.linea),
    normalizarTexto(r.folio),
    normalizarTexto(r.proveedor),
    normalizarTexto(r.encargado),
    normalizarTexto(r.verificador)
  ];
  const partidas = (Array.isArray(r.partidas) ? r.partidas : []).map((p) => {
    p = p || {};
    return {
      codigo: normalizarTexto(p.codigo),
      desc: normalizarTexto(p.desc),
      extras: [
        normalizarTexto(p.fact),
        normalizarTexto(p.recib),
        normalizarTexto(p.real),
        normalizarTexto(p.realPV),
        normalizarTexto(p.realBR)
      ]
    };
  });
  return { cabecera, fechaISO, partidas };
}

/* Comparación de subcadena simple sobre texto ya normalizado. */
const contiene = (hecho, t) => hecho.includes(t);

/* Evalúa un término contra un registro preparado. Devuelve el conjunto de
   partidas que coinciden por artículo (array de índices), o `null` si el
   registro NO cumple el término. Un array vacío significa "cumple por cabecera
   o fecha, pero ninguna partida coincidió por artículo".
   El término puede cumplirse como fecha y/o como texto; para los términos
   numéricos basta con que UNA de las vías se cumpla. */
function evaluarTermino(prep, termino) {
  const fechaPred = interpretarFecha(termino);
  const porFecha = fechaPred ? fechaPred(prep.fechaISO) : false;

  /* ¿Coincide como texto en la cabecera? */
  const porCabecera = prep.cabecera.some((h) => h && contiene(h, termino));

  /* Partidas que coinciden por código, descripción o cantidades. */
  const partidasCmp = [];
  prep.partidas.forEach((p, i) => {
    if (
      contiene(p.codigo, termino) ||
      contiene(p.desc, termino) ||
      p.extras.some((e) => e && contiene(e, termino))
    ) {
      partidasCmp.push(i);
    }
  });

  const cumple = porFecha || porCabecera || partidasCmp.length > 0;
  return cumple ? partidasCmp : null;
}

/* Busca en una lista de registros. `texto` puede traer varios términos
   separados por espacios (AND). Devuelve un array de
     { registro, partidas: number[] }
   donde `partidas` son los índices de las partidas que coincidieron por
   artículo (array vacío si el registro coincidió solo por cabecera o fecha).
   Con texto vacío devuelve TODOS los registros, con `partidas` vacío. */
export function buscarRegistros(registros, texto) {
  const lista = Array.isArray(registros) ? registros : [];
  const q = normalizarTexto(texto);
  if (!q) return lista.map((registro) => ({ registro, partidas: [] }));

  const terminos = q.split(" ").filter(Boolean);
  const preparados = lista.map(prepararRegistro);

  const salida = [];
  preparados.forEach((prep, i) => {
    /* Se acumulan las partidas que coincidieron en CADA término. Si algún
       término no cumple, el registro se descarta (AND). */
    let cumpleTodos = true;
    const partidasSet = new Set();
    for (const t of terminos) {
      const res = evaluarTermino(prep, t);
      if (res === null) {
        cumpleTodos = false;
        break;
      }
      res.forEach((idx) => partidasSet.add(idx));
    }
    if (cumpleTodos) {
      salida.push({ registro: lista[i], partidas: [...partidasSet].sort((x, y) => x - y) });
    }
  });
  return salida;
}
