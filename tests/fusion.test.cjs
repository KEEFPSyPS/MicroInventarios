/* ===========================================================================
 * tests/fusion.test.cjs — Pruebas de fusion.js (node:test).
 * ---------------------------------------------------------------------------
 * Verifica la política de fusión para el trabajo SIMULTÁNEO sobre un folio:
 *   · Migración de pid en documentos viejos (sin `pid`).
 *   · Partidas distintas editadas por dos usuarios → ambas sobreviven.
 *   · La misma partida editada por ambos → gana el más reciente, sin pisar con vacío.
 *   · Altas simultáneas → no se pierde ninguna.
 *   · Baja contra edición → gana la acción más reciente.
 *   · Estado viejo contra nuevo → el `paso` nunca retrocede.
 *   · Los sellos (`actualizadoPor`/`actualizadoEn`) y `rev` SIEMPRE son del
 *     cliente que guarda; JAMÁS se copian del documento remoto.
 *
 * Es CJS (require + import() dinámico) porque fusion.js es un módulo ES.
 * Corre con: node --test tests/fusion.test.cjs   (o `npm test`).
 * ======================================================================== */
const { test } = require("node:test");
const assert = require("node:assert/strict");

let fusion = null;
const cargar = async () => {
  if (!fusion) fusion = await import("../fusion.js");
  return fusion;
};

const sello = (por, en) => ({ por, en });

/* Partida base de los escenarios. */
const partida = (over) =>
  Object.assign(
    { pid: "p1", codigo: "A-1", desc: "Filtro", fact: "10", recib: "8", realPV: "4", realBR: "4", real: "8" },
    over
  );

/* Documento base (lo que hay en Firestore). */
const doc = (over) =>
  Object.assign(
    {
      id: "aud-1",
      uid: "u1",
      fecha: "2026-06-10",
      proveedor: "Proveedor SA",
      folio: "A-9912",
      email: "ana@ejemplo.mx",
      verificador: "Ana",
      paso: 3,
      creado: 1700000000000,
      actualizado: 1700000500000,
      actualizadoEn: 1700000500000,
      actualizadoPor: "ana@ejemplo.mx",
      rev: 1,
      partidas: [partida()]
    },
    over
  );

test("pidDe()/asignarPids() migran documentos viejos de forma determinista", async () => {
  const { pidDe, asignarPids } = await cargar();
  const vieja = { codigo: "A-1", desc: "Filtro", fact: "10", recib: "8" };
  /* Sin pid: se deriva del contenido. Mismo contenido → mismo pid (así dos
     clientes que abran el documento viejo lo emparejan en la fusión). */
  assert.equal(pidDe(vieja, 0), pidDe({ codigo: "A-1", desc: "Filtro", fact: "10", recib: "8" }, 0));
  assert.match(pidDe(vieja, 0), /^p[0-9a-z]+$/);
  assert.notEqual(pidDe(vieja, 0), pidDe({ codigo: "A-2", desc: "Filtro", fact: "10" }, 0),
    "contenido distinto → pid distinto");

  const conPids = asignarPids([vieja, vieja, { pid: "ya", codigo: "B" }]);
  assert.notEqual(conPids[0].pid, conPids[1].pid, "dos filas iguales no comparten pid (se desambigua)");
  assert.equal(conPids[2].pid, "ya", "un pid ya presente se respeta");
  assert.ok(!("pid" in vieja), "asignarPids() no muta la partida original");
});

test("partidas distintas editadas por dos usuarios: no se pierde ninguna", async () => {
  const { fusionar } = await cargar();
  /* En Firestore hay p1 y p2; el usuario local editó solo p2 (p1 le llegó igual). */
  const remoto = doc({
    paso: 3,
    partidas: [partida(), partida({ pid: "p2", codigo: "B-2", recib: "5" })]
  });
  const local = doc({
    paso: 4,
    actualizadoEn: 1700000900000,
    partidas: [partida(), partida({ pid: "p2", codigo: "B-2", recib: "7", real: "7" })]
  });
  const out = fusionar(remoto, local, sello("beto@ejemplo.mx", 1700000900000));
  assert.equal(out.partidas.length, 2, "las dos partidas sobreviven");
  const p2 = out.partidas.find((p) => p.pid === "p2");
  assert.equal(p2.recib, "7", "gana la edición local de la partida (más reciente)");
  assert.equal(out.paso, 4, "el paso sube al del cliente que guarda");
});

test("la misma partida: gana el más reciente y un vacío no pisa un dato capturado", async () => {
  const { fusionar } = await cargar();
  /* El remoto (más nuevo) trae `desc` vacío pero el local ya la tenía capturada. */
  const remoto = doc({
    actualizadoEn: 1700000900000,
    partidas: [partida({ desc: "", realPV: "4", realBR: "4", real: "8" })]
  });
  const local = doc({
    actualizadoEn: 1700000100000,
    partidas: [partida({ desc: "Filtro de aceite", realPV: "4", realBR: "4", real: "8" })]
  });
  const out = fusionar(remoto, local, sello("ana@ejemplo.mx", 1700000900000));
  assert.equal(out.partidas[0].desc, "Filtro de aceite",
    "un valor vacío del lado más nuevo NO borra el dato capturado");
});

test("la misma partida con conteos distintos: gana el guardado más reciente", async () => {
  const { fusionar } = await cargar();
  const remoto = doc({ actualizadoEn: 1700000100000, partidas: [partida({ realPV: "4", realBR: "4", real: "8" })] });
  const local = doc({ actualizadoEn: 1700000900000, partidas: [partida({ realPV: "6", realBR: "1", real: "7" })] });
  const out = fusionar(remoto, local, sello("beto@ejemplo.mx", 1700000900000));
  assert.equal(out.partidas[0].realPV, "6");
  assert.equal(out.partidas[0].realBR, "1");
  assert.equal(out.partidas[0].real, "7", "`real` se recalcula de PV+BR");
});

test("altas simultáneas: se conservan las de ambos lados", async () => {
  const { fusionar } = await cargar();
  const remoto = doc({ partidas: [partida(), partida({ pid: "pR", codigo: "R", desc: "Solo remoto" })] });
  const local = doc({
    actualizadoEn: 1700000900000,
    partidas: [partida(), partida({ pid: "pL", codigo: "L", desc: "Solo local" })]
  });
  const out = fusionar(remoto, local, sello("beto@ejemplo.mx", 1700000900000));
  const pids = out.partidas.map((p) => p.pid);
  assert.deepEqual(pids, ["p1", "pL", "pR"], "el orden local va primero y el alta remota se anexa");
});

test("baja contra edición: gana la acción más reciente", async () => {
  const { fusionar, marcarBorrada } = await cargar();
  /* Caso A: el borrado (remoto) es POSTERIOR → la partida no revive. */
  const bajas = marcarBorrada([], "p2", 1700000900000);
  const a = fusionar(
    doc({ borradas: bajas, partidas: [partida()] }),
    doc({ actualizadoEn: 1700000100000, partidas: [partida(), partida({ pid: "p2", codigo: "B-2" })] }),
    sello("ana@ejemplo.mx", 1700000900000)
  );
  assert.ok(!a.partidas.some((p) => p.pid === "p2"), "borrada sin edición posterior: no revive");

  /* Caso B: la edición (local) es POSTERIOR al borrado → la partida se restaura. */
  const b = fusionar(
    doc({ borradas: marcarBorrada([], "p2", 1700000100000), partidas: [partida()] }),
    doc({
      actualizadoEn: 1700000900000,
      partidas: [partida(), partida({ pid: "p2", codigo: "B-2", recib: "9", real: "9", _t: 1700000900000 })]
    }),
    sello("beto@ejemplo.mx", 1700000900000)
  );
  const restaurada = b.partidas.find((p) => p.pid === "p2");
  assert.ok(restaurada, "editada después del borrado: se restaura");
  assert.equal(restaurada.recib, "9");
});

test("estado viejo contra nuevo: el paso nunca retrocede", async () => {
  const { fusionar } = await cargar();
  /* El cliente local tiene una pantalla VIEJA (paso 2) y el remoto va en paso 5. */
  const out = fusionar(
    doc({ paso: 5, actualizadoEn: 1700000900000 }),
    doc({ paso: 2, actualizadoEn: 1700000100000 }),
    sello("ana@ejemplo.mx", 1700000900000)
  );
  assert.equal(out.paso, 5, "el paso se queda en el máximo de ambos");
});

test("el guardado NUNCA copia actualizadoEn ni rev del documento leído", async () => {
  const { fusionar } = await cargar();
  const remoto = doc({ rev: 7, actualizadoPor: "otro@ejemplo.mx", actualizadoEn: 111 });
  const out = fusionar(remoto, doc({ rev: 7 }), sello("beto@ejemplo.mx", 999));
  assert.equal(out.actualizadoPor, "beto@ejemplo.mx", "el sello de autor es el del token, no el leído");
  assert.equal(out.actualizadoEn, 999, "el sello de tiempo es el fresco, no el del documento leído");
  assert.notEqual(out.actualizadoEn, 111);
  assert.equal(out.rev, 8, "rev avanza una unidad sobre el máximo observado");
});

test("la fusión no muta las entradas y conserva campos válidos heredados", async () => {
  const { fusionar } = await cargar();
  const remoto = doc({ linea: "Volkswagen", encargado: "Luis" });
  const local = doc({ linea: "Chevrolet", encargado: "Luis", actualizadoEn: 1700000900000 });
  const respaldo = JSON.stringify(remoto);
  const out = fusionar(remoto, local, sello("beto@ejemplo.mx", 1700000900000));
  assert.equal(JSON.stringify(remoto), respaldo, "el documento remoto no se mutó");
  assert.equal(out.linea, "Volkswagen", "una línea válida de un documento viejo se conserva");
  assert.equal(out.encargado, "Luis");
  /* Un valor corrupto no se propaga a lo guardado. */
  const raro = fusionar(doc({ linea: "Kia" }), doc(), sello("ana@ejemplo.mx", 1));
  assert.ok(!("linea" in raro), "una línea inválida se descarta en lugar de escribirse");
});

test("firma() detecta cambios de contenido y de bajas", async () => {
  const { firma } = await cargar();
  const base = firma(doc());
  assert.equal(firma(doc()), base, "mismo contenido → misma firma");
  assert.notEqual(firma(doc({ paso: 4 })), base, "cambiar el paso cambia la firma");
  assert.notEqual(
    firma(doc({ partidas: [partida(), partida({ pid: "p2" })] })),
    base,
    "agregar una partida cambia la firma"
  );
  assert.notEqual(
    firma(doc({ borradas: [{ pid: "p2", t: 1 }] })),
    base,
    "registrar una baja cambia la firma"
  );
});

test("documentos sin partidas o con partidas nulas no rompen la fusión", async () => {
  const { fusionar } = await cargar();
  const out = fusionar(null, null, sello("ana@ejemplo.mx", 5));
  assert.equal(out.paso, 1);
  assert.deepEqual(out.partidas, []);
  assert.equal(out.rev, 1);
  const conNulas = fusionar(doc({ partidas: null }), doc({ partidas: [partida()] }), sello("ana@ejemplo.mx", 5));
  assert.equal(conNulas.partidas.length, 1);
});
