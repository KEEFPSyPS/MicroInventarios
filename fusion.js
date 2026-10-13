/* ===========================================================================
 * fusion.js — Fusión de folios para trabajo SIMULTÁNEO (módulo puro).
 * ---------------------------------------------------------------------------
 * Varios usuarios pueden capturar EL MISMO folio desde dispositivos distintos.
 * El problema original: app.js guardaba con setDoc(), que REEMPLAZA el documento
 * entero. Si dos personas editaban a la vez, la última en guardar borraba por
 * completo lo del otro (pérdida de datos silenciosa).
 *
 * Aquí vive la política de fusión, PURA y sin DOM ni Firestore: recibe el
 * documento REMOTO (lo que hay en Firestore) y el LOCAL (lo que se está
 * capturando) y devuelve el documento que debe quedar. app.js solo la aplica
 * dentro de una transacción (ver store.save()).
 *
 * Decisiones de diseño:
 *  · PARTIDAS POR `pid`: cada partida lleva un identificador estable `pid`. Así
 *    la fusión es PARTIDA A PARTIDA (no por índice): si un usuario borra la fila
 *    2, las demás no se desplazan ni se confunden entre sí. Las partidas viejas
 *    (sin pid) se migran al abrirlas (ver asignarPids()).
 *  · NADA SE PISA CON VACÍO: un valor capturado (no vacío) nunca se reemplaza por
 *    uno vacío. Evita que un cliente con una pantalla desactualizada borre el
 *    conteo que otro acaba de teclear.
 *  · EL PASO NO RETROCEDE: `paso` es el máximo de ambos. Si uno está en el Paso 4
 *    y otro en el Paso 2, el folio queda en 4.
 *  · ALTAS Y BAJAS SIMULTÁNEAS:
 *      - Alta en cualquiera de los dos → se conserva (nadie pierde una partida
 *        recién agregada).
 *      - Baja (borrado) → se registra en `borradas` (pid + marca de tiempo) para
 *        que la partida NO reviva si el otro cliente la sigue teniendo en pantalla.
 *        Gana la acción más RECIENTE: si la edición es posterior al borrado, la
 *        partida se restaura con lo editado.
 *  · REVISIÓN Y SELLOS: `rev` se incrementa (máximo + 1) para detectar carreras, y
 *    `actualizadoPor`/`actualizadoEn` los fija SIEMPRE el cliente que guarda
 *    (nunca se copian del documento remoto: un sello viejo en un guardado nuevo
 *    es un error y las reglas lo rechazarían).
 *
 * Es un módulo ES sin imports, igual que busqueda.js: lo carga app.js y lo prueba
 * tests/fusion.test.cjs.
 * ======================================================================== */

/* Campos de una partida en el orden canónico en que se comparan/escriben. */
export const CAMPOS_PARTIDA = ["codigo", "desc", "fact", "recib", "realPV", "realBR"];

/* Campos de la CABECERA del folio (datos de la factura) que también se fusionan
   campo a campo, porque dos usuarios pueden estar en pasos distintos del mismo
   folio (uno en Datos de la factura y otro en Partidas). */
export const CAMPOS_CABECERA = [
  "fecha",
  "proveedor",
  "folio",
  "email",
  "verificador"
];

/* ¿El valor está "vacío" a efectos de fusión? No pisa un dato capturado. */
function vacio(v) {
  return v == null || (typeof v === "string" && v.trim() === "");
}

/* Suma PV + BR para recalcular `real` de una partida (mismo criterio que
   sumarReal() en app.js: si NINGUNA división tiene captura, `real` queda ""). */
function recalcularReal(p) {
  const pv = p.realPV === "" || p.realPV == null ? null : Number(p.realPV);
  const br = p.realBR === "" || p.realBR == null ? null : Number(p.realBR);
  if (pv == null && br == null) return "";
  return String((pv || 0) + (br || 0));
}

/* Marca de tiempo (número) del último cambio de un sello, para desempatar.
   Acepta números (epoch ms), objetos Date y los sentinelas de Firestore (que
   traen toMillis()); cualquier otra cosa cuenta como 0 (el más antiguo). */
function marcaTiempo(v) {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v.toMillis === "function") {
    const t = v.toMillis();
    return Number.isFinite(t) ? t : 0;
  }
  if (typeof v.seconds === "number") return v.seconds * 1000;
  return 0;
}

/* Genera un `pid` estable a partir del índice y el contenido de una partida.
   Se usa SOLO para migrar documentos viejos que no traen pid: el resultado es
   determinista (mismo contenido → mismo pid), de modo que dos clientes que abran
   el mismo documento viejo derivan el MISMO pid y la fusión los empareja. */
export function pidDe(p, i) {
  if (p && typeof p.pid === "string" && p.pid) return p.pid;
  const semilla = [i, p && p.codigo, p && p.desc, p && p.fact, p && p.recib]
    .map((x) => String(x == null ? "" : x))
    .join("\u0001");
  let h = 2166136261;
  for (let k = 0; k < semilla.length; k++) {
    h ^= semilla.charCodeAt(k);
    h = Math.imul(h, 16777619);
  }
  return "p" + (h >>> 0).toString(36);
}

/* Garantiza que TODA partida tenga un `pid` único. Los documentos de partidas
   viejas no lo traen: al abrirlos en el cliente se les asigna (migración en el
   aire). Si dos pids colisionaran (contenido idéntico en dos filas), se
   desambigua con el índice. Devuelve una copia nueva (no muta la entrada). */
export function asignarPids(partidas) {
  const lista = Array.isArray(partidas) ? partidas : [];
  const usados = new Set();
  return lista.map((p, i) => {
    const copia = Object.assign({}, p);
    let pid = pidDe(copia, i);
    while (usados.has(pid)) pid = pid + "-" + i.toString(36);
    usados.add(pid);
    copia.pid = pid;
    return copia;
  });
}

/* Fusiona UNA partida editada por ambos lados. Reglas:
   · Se toman los campos del lado MÁS RECIENTE (según `_t`), pero un valor
     capturado del lado más viejo NUNCA se pierde si el más nuevo lo trae vacío.
   · `real` se recalcula de PV+BR (nunca se queda desincronizado). */
function fusionarPartida(remota, local, localEsMasNueva) {
  const nueva = localEsMasNueva ? local : remota;
  const vieja = localEsMasNueva ? remota : local;
  const out = { pid: nueva.pid };
  for (const c of CAMPOS_PARTIDA) {
    const v = vacio(nueva[c]) ? vieja[c] : nueva[c];
    out[c] = v == null ? "" : v;
  }
  out.real = recalcularReal(out);
  /* La marca de tiempo de la partida sobrevive para futuras fusiones. */
  const t = Math.max(marcaTiempo(remota && remota._t), marcaTiempo(local && local._t));
  if (t) out._t = t;
  return out;
}

/* Fusiona el documento COMPLETO. Devuelve un documento NUEVO que el cliente debe
   escribir. Parámetros:
     remoto : lo que hay en Firestore (o null si aún no existe).
     local  : lo que el usuario tiene en pantalla.
     sello  : { por, en } → quién y cuándo guarda (se fijan aquí, SIEMPRE). */
export function fusionar(remoto, local, sello) {
  const s = sello || {};
  const r = remoto || {};
  const l = local || {};
  const tRemoto = marcaTiempo(r.actualizadoEn) || marcaTiempo(r.actualizado);
  const tLocal = marcaTiempo(l.actualizadoEn) || marcaTiempo(l.actualizado);
  const localEsMasNueva = tLocal >= tRemoto;

  /* --- Bajas: se acumulan ambas listas, quedándose con la marca más reciente
     por pid. De aquí sale el conjunto de pids que deben respetarse como
     borrados. --- */
  const borradas = new Map();
  const acumular = (lista) => {
    (Array.isArray(lista) ? lista : []).forEach((b) => {
      const pid = b && (b.pid || (typeof b === "string" ? b : ""));
      if (!pid) return;
      const t = marcaTiempo(b && b.t);
      if (!borradas.has(pid) || t > borradas.get(pid).t) borradas.set(pid, { pid, t });
    });
  };
  acumular(r.borradas);
  acumular(l.borradas);

  /* --- Partidas: se indexan por pid para fusionarlas una a una. --- */
  const mapRemoto = new Map(asignarPids(r.partidas).map((p) => [p.pid, p]));
  const mapLocal = new Map(asignarPids(l.partidas).map((p) => [p.pid, p]));

  const pids = [];
  const vistos = new Set();
  /* Se respeta el ORDEN del lado local (lo que el usuario ve ahora mismo) y se
     agregan al final las partidas que solo existen en el remoto. */
  for (const p of mapLocal.values()) {
    if (!vistos.has(p.pid)) { pids.push(p.pid); vistos.add(p.pid); }
  }
  for (const p of mapRemoto.values()) {
    if (!vistos.has(p.pid)) { pids.push(p.pid); vistos.add(p.pid); }
  }

  const partidas = [];
  for (const pid of pids) {
    const pr = mapRemoto.get(pid);
    const pl = mapLocal.get(pid);
    const baja = borradas.get(pid);
    const tEdicion = Math.max(marcaTiempo(pr && pr._t), marcaTiempo(pl && pl._t));

    if (baja && tEdicion <= baja.t) continue;             /* borrada y sin edición posterior: no revive */
    if (baja && tEdicion > baja.t) borradas.delete(pid);  /* editada DESPUÉS del borrado: se restaura */
    if (pr && pl) partidas.push(fusionarPartida(pr, pl, localEsMasNueva));
    else partidas.push(Object.assign({}, pr || pl));
  }

  /* --- Cabecera: campo a campo (no pisa con vacío) y `paso` que NO retrocede. --- */
  const out = {};
  for (const c of CAMPOS_CABECERA) {
    const nueva = localEsMasNueva ? l[c] : r[c];
    const vieja = localEsMasNueva ? r[c] : l[c];
    out[c] = vacio(nueva) ? (vieja == null ? "" : vieja) : nueva;
  }
  out.id = r.id || l.id;
  out.uid = r.uid || l.uid;
  out.creado = marcaTiempo(r.creado) || l.creado;
  out.paso = Math.max(Number(r.paso) || 0, Number(l.paso) || 0, 1);

  /* --- Sellos y revisión: SIEMPRE del cliente que guarda. --- */
  out.rev = Math.max(Number(r.rev) || 0, Number(l.rev) || 0) + 1;
  out.actualizadoPor = s.por;
  out.actualizadoEn = s.en;
  out.actualizado = marcaTiempo(s.en);

  /* --- Campos opcionales heredados de documentos viejos: solo si siguen válidos. --- */
  const linea = r.linea != null ? r.linea : l.linea;
  if (linea === "Volkswagen" || linea === "Chevrolet") out.linea = linea;
  const encargado = vacio(l.encargado) ? r.encargado : l.encargado;
  if (typeof encargado === "string" && encargado.trim()) out.encargado = encargado;

  out.partidas = partidas;
  const listaBorradas = [...borradas.values()].sort((a, b) => (a.pid < b.pid ? -1 : 1));
  if (listaBorradas.length) out.borradas = listaBorradas;
  return out;
}

/* Marca una partida como borrada: devuelve la lista de bajas actualizada.
   `cuando` es el instante (ms) del borrado; si no se pasa, no se fecha (queda 0,
   de modo que cualquier edición posterior la restaura). */
export function marcarBorrada(borradas, pid, cuando) {
  const lista = (Array.isArray(borradas) ? borradas : []).filter((b) => b && b.pid !== pid);
  lista.push({ pid, t: marcaTiempo(cuando) });
  return lista;
}

/* Firma ligera del documento para detectar cambios (usada para decidir si hay
   algo que guardar). No pretende ser un hash criptográfico. */
export function firma(doc) {
  const d = doc || {};
  const ps = asignarPids(d.partidas)
    .map((p) => [p.pid, p.codigo, p.desc, p.fact, p.recib, p.realPV, p.realBR].join("\u0001"))
    .join("\u0002");
  return [
    d.id, d.folio, d.fecha, d.proveedor, d.email, d.verificador, d.paso,
    (d.borradas || []).map((b) => b.pid + ":" + b.t).join(","),
    ps
  ].join("\u0000");
}
