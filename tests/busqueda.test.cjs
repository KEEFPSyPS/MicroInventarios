/* ===========================================================================
 * tests/busqueda.test.cjs — Pruebas de busqueda.js (node:test).
 * ---------------------------------------------------------------------------
 * Verifica el "súper buscador" del Historial: normalización (acentos/mayúsculas),
 * términos combinados con AND, cada formato de fecha, coincidencia por artículo,
 * términos numéricos (fecha O texto), sin resultados, texto vacío y caracteres
 * especiales. Es un módulo PURO: no toca el DOM ni Firebase.
 *
 * Es CJS (require + import() dinámico) porque busqueda.js es un módulo ES.
 * Corre con: node --test tests/busqueda.test.cjs   (o `npm test`).
 * ======================================================================== */
const { test } = require("node:test");
const assert = require("node:assert/strict");

/* Registros de ejemplo que reproducen el esquema real (cabecera + partidas). */
function registros() {
  return [
    {
      id: "a1",
      fecha: "2026-10-07",
      linea: "Volkswagen",
      folio: "A-9912",
      proveedor: "Refaccionaria del Norte",
      encargado: "Ana",
      verificador: "Beto",
      partidas: [
        {
          codigo: "VOL-123",
          desc: "Balata delantera",
          fact: "12",
          recib: "10",
          real: "10",
          realPV: "6",
          realBR: "4"
        },
        {
          codigo: "FOL-9",
          desc: "Filtro de aceite",
          fact: "5",
          recib: "5",
          real: "5",
          realPV: "5",
          realBR: "0"
        }
      ]
    },
    {
      id: "a2",
      fecha: "2026-09-12",
      linea: "Chevrolet",
      folio: "C-0042",
      proveedor: "Autopartes Poniente",
      encargado: "Carlos",
      verificador: "Diana",
      partidas: [
        {
          codigo: "CHE-BUJ",
          desc: "Bujía platino",
          fact: "24",
          recib: "24",
          real: "20",
          realPV: "20",
          realBR: "0"
        }
      ]
    },
    {
      id: "a3",
      fecha: "2026-12-01",
      linea: "",
      folio: "sin-linea",
      proveedor: "Proveedor Ñoño",
      encargado: "",
      verificador: "",
      partidas: [
        {
          codigo: "GEN-1",
          desc: "Espejo retrovisor (izquierdo)",
          fact: "1",
          recib: "1",
          real: "1",
          realPV: "1",
          realBR: "0"
        }
      ]
    }
  ];
}

let casos;

test("carga el módulo (import dinámico de un ESM desde CJS)", async () => {
  const mod = await import("../busqueda.js");
  assert.equal(typeof mod.buscarRegistros, "function");
  assert.equal(typeof mod.normalizarTexto, "function");
  assert.equal(typeof mod.interpretarFecha, "function");
  assert.equal(typeof mod.prepararRegistro, "function");
  casos = mod;
});

test("normalizarTexto ignora mayúsculas, acentos y espacios sobrantes", () => {
  const { normalizarTexto } = casos;
  assert.equal(normalizarTexto("  Volkswagen  "), "volkswagen");
  assert.equal(normalizarTexto("Refacción ÑOÑO"), "refaccion nono");
  assert.equal(normalizarTexto("Balata   delantera"), "balata delantera");
  assert.equal(normalizarTexto(null), "");
  assert.equal(normalizarTexto(undefined), "");
});

test("texto vacío devuelve TODOS los registros (sin marcar partidas)", () => {
  const { buscarRegistros } = casos;
  const r = buscarRegistros(registros(), "");
  assert.equal(r.length, 3);
  assert.deepEqual(
    r.map((x) => x.partidas),
    [[], [], []]
  );
  assert.equal(buscarRegistros(registros(), "   ").length, 3);
});

test("búsqueda por proveedor, sin acentos ni mayúsculas", () => {
  const { buscarRegistros } = casos;
  const r = buscarRegistros(registros(), "PROVEEDOR NONO");
  assert.equal(r.length, 1);
  assert.equal(r[0].registro.id, "a3");
});

test("búsqueda por folio y por línea/marca", () => {
  const { buscarRegistros } = casos;

  test("varios términos se combinan con AND (acotan, no amplían)", () => {
    const { buscarRegistros } = casos;
    /* "volkswagen" solo → a1. Añadir "12/09" (diciembre 9, no existe) → 0. */
    assert.equal(buscarRegistros(registros(), "volkswagen").length, 1);
    assert.equal(buscarRegistros(registros(), "volkswagen 12/09").length, 0);
    /* "volkswagen 07/10" sí casa (a1 es 2026-10-07). */
    assert.equal(buscarRegistros(registros(), "volkswagen 07/10")[0].registro.id, "a1");
    /* Dos términos que unen cabecera y artículo. */
    const r = buscarRegistros(registros(), "refaccionaria balata");
    assert.equal(r.length, 1);
    assert.equal(r[0].registro.id, "a1");
    assert.deepEqual(r[0].partidas, [0]);
  });

  test("cada formato de fecha contra la fecha real del registro", () => {
    const { buscarRegistros } = casos;
    const uno = (t) => {
      const r = buscarRegistros(registros(), t);
      return r.length === 1 ? r[0].registro.id : r.length;
    };
    assert.equal(uno("2026-10-07"), "a1"); // ISO
    assert.equal(uno("07/10/2026"), "a1"); // DD/MM/AAAA
    assert.equal(uno("07-10-2026"), "a1"); // separador -
    assert.equal(uno("7/10"), "a1"); // D/M sin año
    assert.equal(uno("octubre"), "a1"); // mes por nombre
    assert.equal(uno("oct 2026"), "a1"); // mes + año
    assert.equal(uno("10/2026"), "a1"); // mes/año
    assert.equal(uno("12/09/2026"), "a2"); // a2 es 2026-09-12
    assert.equal(uno("diciembre"), "a3"); // a3 es 2026-12-01
  });

  test("coincidencia parcial por artículo y qué partida coincidió", () => {
    const { buscarRegistros } = casos;
    /* Por código: "vol-12" es subcadena de "VOL-123" (partida 0 de a1). */
    const rc = buscarRegistros(registros(), "vol-12");
    assert.equal(rc.length, 1);
    assert.equal(rc[0].registro.id, "a1");
    assert.deepEqual(rc[0].partidas, [0]);
    /* Por descripción: "bujia" (sin acento) casa con "Bujía platino". */
    const rd = buscarRegistros(registros(), "bujia");
    assert.equal(rd[0].registro.id, "a2");
    assert.deepEqual(rd[0].partidas, [0]);
  });

  test("término numérico coincide como fecha O como texto de artículo", () => {
    const { buscarRegistros } = casos;
    /* "12" NO es fecha exacta por sí sola, pero aparece como cantidad (fact "12")
     en la partida 0 de a1. */
    const r = buscarRegistros(registros(), "12");
    const conArt = r.find((x) => x.registro.id === "a1");
    assert.ok(conArt, "a1 coincide por cantidad 12");
    assert.deepEqual(conArt.partidas, [0]);
    /* "24" solo aparece como cantidad en a2. */
    const r24 = buscarRegistros(registros(), "24");
    assert.equal(r24[0].registro.id, "a2");
    assert.deepEqual(r24[0].partidas, [0]);
    /* Un número que vale como fecha parcial (mes/día) Y como texto: el registro
     cumple si CUALQUIERA de las vías se satisface. */
    assert.ok(buscarRegistros(registros(), "7").length >= 1);
  });

  test("sin resultados devuelve lista vacía", () => {
    const { buscarRegistros } = casos;
    assert.equal(buscarRegistros(registros(), "zzz-no-existe").length, 0);
    assert.equal(buscarRegistros(registros(), "volkswagen chevrolet").length, 0);
  });

  test("caracteres especiales no rompen la búsqueda (/, ., paréntesis, <, &)", () => {
    const { buscarRegistros, normalizarTexto } = casos;
    /* El paréntesis de la descripción "Espejo retrovisor (izquierdo)". */
    assert.equal(buscarRegistros(registros(), "(izquierdo)")[0].registro.id, "a3");
    assert.equal(buscarRegistros(registros(), "izquierdo)")[0].registro.id, "a3");
    /* El guion y el punto no revientan ni como fecha ni como texto.
     El término exacto "a-9912" SÍ casa; con un punto de más ya no es subcadena,
     y ambos casos deben resolverse sin error (no son regex). */
    assert.equal(buscarRegistros(registros(), "a-9912").length, 1);
    assert.doesNotThrow(() => buscarRegistros(registros(), "a-9912."));
    assert.equal(buscarRegistros(registros(), "a-9912.").length, 0);
    assert.doesNotThrow(() => buscarRegistros(registros(), "a.9912"));
    /* "<" y "&" no deben romper (se tratan como texto literal). */
    assert.doesNotThrow(() => buscarRegistros(registros(), "<a>&"));
    assert.equal(buscarRegistros(registros(), "<a>&").length, 0);
    /* La normalización no altera esos símbolos. */
    assert.equal(normalizarTexto("<a>&"), "<a>&");
  });

  test("tolera registros mal formados (sin partidas / nulos)", () => {
    const { buscarRegistros } = casos;
    assert.doesNotThrow(() => buscarRegistros([null, {}, { fecha: "2026-10-07" }], "octubre"));
    assert.equal(buscarRegistros([null], "x").length, 0);
  });

  assert.equal(buscarRegistros(registros(), "a-9912")[0].registro.id, "a1");
  assert.equal(buscarRegistros(registros(), "chevrolet")[0].registro.id, "a2");
});
